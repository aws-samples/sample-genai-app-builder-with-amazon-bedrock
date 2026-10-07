import type { APIGatewayProxyEvent, APIGatewayProxyResult, ScheduledEvent } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { ECSClient, ListTasksCommand } from '@aws-sdk/client-ecs';
import {
  createSession,
  getSession,
  updateSessionStatus,
  updateLastActivity,
  getActiveSessionByUser,
  getClaimedTaskArns,
  getIdleSessions,
  newSessionRecord,
  setTaskInfo,
  deleteClaimLock,
  isMember,
  hasOtherMembers,
  addMember,
  createInvite,
  getInvite,
  findInvite,
  claimInvite,
  markInviteRevoked,
  deleteInvite,
  removeMember,
  newInviteRecord,
  addProjectMember,
  removeProjectMember,
  getProjectOwner,
} from './sessions';
import { previewUrlFor } from './preview-url';
import {
  claimWarmTask,
  listAssignedTasks,
  stopTask,
  tagTaskForSession,
  type TaskInfo,
} from './ecs-manager';
import { signWsUrl, getSigningKey } from './ws-signed-url';
import { provisionSessionRouting, reconcileOrphanRouting, teardownSessionRouting } from './alb-routing';
import type { ApiResponse, Session } from './types';

const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN || 'preview.vibe.proserve.aws.dev';
const CLOUDFRONT_DOMAIN_PARAM = process.env.CLOUDFRONT_DOMAIN_PARAM || '';
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE || '';
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN || '';
const ECS_SERVICE_NAME = process.env.ECS_SERVICE_NAME || '';

const cwClient = new CloudWatchClient({});
const ecsClient = new ECSClient({});

// Cached CloudFront domain (resolved from SSM on first invocation)
let cachedCloudfrontDomain: string | null = null;

/**
 * Publish AvailableTaskCount metric for auto-scaling.
 * Available = total running ECS tasks - claimed sessions in DynamoDB.
 *
 * Published on every session create/delete and every 5-minute cleanup cron.
 * During idle periods (no creates/deletes), the metric may be up to 5 minutes
 * stale, which is acceptable since no scaling action is needed when idle.
 */
async function publishAvailabilityMetric(): Promise<void> {
  if (!METRIC_NAMESPACE) return;

  try {
    const [claimedArns, listResult] = await Promise.all([
      getClaimedTaskArns(),
      ecsClient.send(new ListTasksCommand({
        cluster: ECS_CLUSTER_ARN,
        serviceName: ECS_SERVICE_NAME,
        desiredStatus: 'RUNNING',
      })),
    ]);

    const totalTasks = listResult.taskArns?.length ?? 0;
    const claimedCount = claimedArns.size;
    const available = Math.max(0, totalTasks - claimedCount);

    await cwClient.send(new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [
        {
          MetricName: 'AvailableTaskCount',
          Value: available,
          Unit: 'Count',
          Timestamp: new Date(),
        },
        {
          MetricName: 'ActiveSessionCount',
          Value: claimedCount,
          Unit: 'Count',
          Timestamp: new Date(),
        },
      ],
    }));

    console.log(`[metrics] available=${available} active=${claimedCount} total=${totalTasks}`);
  } catch (err) {
    console.warn('[metrics] Failed to publish:', err);
  }
}

async function getCloudfrontDomain(): Promise<string> {
  if (cachedCloudfrontDomain) return cachedCloudfrontDomain;
  if (!CLOUDFRONT_DOMAIN_PARAM) return '';

  try {
    const ssm = new SSMClient({});
    const result = await ssm.send(new GetParameterCommand({ Name: CLOUDFRONT_DOMAIN_PARAM }));
    cachedCloudfrontDomain = result.Parameter?.Value || '';
    return cachedCloudfrontDomain;
  } catch (err) {
    console.error('Failed to read CloudFront domain from SSM:', err);
    return '';
  }
}

function getCorsOrigin(): string {
  // Restrict CORS to CloudFront distribution origin
  const cfDomain = cachedCloudfrontDomain;
  if (cfDomain) return `https://${cfDomain}`;
  return process.env.CORS_ORIGIN || '*';
}

function getCorsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': getCorsOrigin(),
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

/**
 * Extract the authenticated user's ID from the authorizer context.
 * Supports both Cognito authorizer (claims.sub) and custom Lambda authorizer (userId from context).
 */
function getAuthenticatedUserId(event: APIGatewayProxyEvent): string | null {
  const authorizer = (event.requestContext as any)?.authorizer;

  if (!authorizer) {
    console.warn('[auth] No authorizer context in request');
    return null;
  }

  // Nothing from the authorizer context is logged: it can carry token claims,
  // and identities are not needed to diagnose a missing one.
  if (authorizer.userId) {
    return authorizer.userId;
  }
  if (authorizer.principalId) {
    return authorizer.principalId;
  }

  if (authorizer.claims) {
    return authorizer.claims.sub || authorizer.claims['cognito:username'] || null;
  }

  console.warn('[auth] Could not extract userId from authorizer context');
  return null;
}

/**
 * Main API handler for session management.
 * Routes: POST /session, GET /session/{id}, DELETE /session/{id}, POST /session/{id}/heartbeat
 */
export async function handler(
  event: APIGatewayProxyEvent | ScheduledEvent,
): Promise<APIGatewayProxyResult | void> {
  // Handle EventBridge scheduled cleanup
  if ('source' in event && event.source === 'aws.events') {
    await handleCleanup();
    return;
  }

  // Ensure CloudFront domain is cached before constructing any response headers.
  // Without this, the first invocation falls back to CORS_ORIGIN or '*'.
  await getCloudfrontDomain();

  const apiEvent = event as APIGatewayProxyEvent;
  const { httpMethod, path, pathParameters } = apiEvent;

  try {
    // CORS preflight
    if (httpMethod === 'OPTIONS') {
      return response(200, { ok: true });
    }

    // All non-OPTIONS requests require authentication
    const authenticatedUserId = getAuthenticatedUserId(apiEvent);
    if (!authenticatedUserId) {
      return response(401, { error: 'Authentication required' });
    }

    // POST /session — create a new session
    if (httpMethod === 'POST' && path === '/session') {
      return await handleCreateSession(authenticatedUserId);
    }

    // POST /session/join — redeem an invite token for someone else's session.
    // Matched before the /session/{id} routes because the joiner does not know
    // the session id yet; the token identifies the session.
    if (httpMethod === 'POST' && path === '/session/join') {
      return await handleJoinSession(apiEvent, authenticatedUserId);
    }

    const sessionId = pathParameters?.id;

    if (!sessionId) {
      return response(400, { error: 'Missing session ID' });
    }

    // POST /session/{id}/invite — mint an invite link for collaborators
    if (httpMethod === 'POST' && path.endsWith('/invite')) {
      return await handleCreateInvite(apiEvent, sessionId, authenticatedUserId);
    }

    // DELETE /session/{id}/invite — revoke a link that has not been redeemed
    if (httpMethod === 'DELETE' && path.endsWith('/invite')) {
      return await handleRevokeInvite(apiEvent, sessionId, authenticatedUserId);
    }

    // POST /session/{id}/heartbeat — update last activity
    if (httpMethod === 'POST' && path.endsWith('/heartbeat')) {
      return await handleHeartbeat(sessionId, authenticatedUserId);
    }

    // GET /session/{id} — get session status
    if (httpMethod === 'GET') {
      return await handleGetSession(sessionId, authenticatedUserId);
    }

    // DELETE /session/{id} — stop session
    if (httpMethod === 'DELETE') {
      return await handleDeleteSession(sessionId, authenticatedUserId);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    console.error('Handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

/**
 * WebSocket URL for a session, signed for CloudFront.
 *
 * Routed through the custom domain (same-origin) for CSP compliance, falling
 * back to the CloudFront domain. The path carries the session id, which is what
 * the routing layer keys on to land every collaborator on the same container —
 * so an invited joiner is handed the same URL as the owner.
 *
 * The signature is what actually authorises the upgrade, and CloudFront is what
 * checks it. Only callers this Lambda has already checked (the owner, or a member
 * who redeemed an invite) reach this function. There is deliberately no
 * direct-to-load-balancer or direct-to-task form: those would bypass CloudFront,
 * and with it the only check on the upgrade.
 */
async function buildWsUrl(sessionId: string): Promise<string> {
  const customDomain = PREVIEW_DOMAIN.replace(/^preview\./, '');
  const cfDomain = await getCloudfrontDomain();
  const wsDomain = customDomain && customDomain !== 'localhost' ? customDomain : cfDomain;

  if (!wsDomain) {
    throw new Error('No CloudFront domain configured — cannot issue a WebSocket URL');
  }

  return signWsUrl(wsDomain, sessionId, await getSigningKey());
}

/** Concurrent creates can pick the same free task; only one wins its claim lock. */
const MAX_CLAIM_ATTEMPTS = 3;

/**
 * Claim an unused warm task for a session, holding its DynamoDB claim lock.
 *
 * Losing the lock race to another session moves on to the next unused task
 * rather than failing outright. Any other error is thrown.
 */
async function claimTaskForSession(sessionId: string): Promise<TaskInfo> {
  const tried = new Set<string>();

  for (let attempt = 1; ; attempt++) {
    const claimedArns = await getClaimedTaskArns();
    const taskInfo = await claimWarmTask(sessionId, claimedArns, tried);

    try {
      await setTaskInfo(sessionId, taskInfo.taskArn, taskInfo.privateIp);
      return taskInfo;
    } catch (err) {
      const lostRace = (err as { name?: string }).name === 'TransactionCanceledException';

      if (!lostRace || attempt >= MAX_CLAIM_ATTEMPTS) {
        throw err;
      }

      tried.add(taskInfo.taskArn);
    }
  }
}

async function handleCreateSession(userId: string): Promise<ApiResponse> {
  // The caller's existing session, if any, is retired below (task stopped,
  // routing torn down) unless someone else is sharing it.
  const existing = await getActiveSessionByUser(userId);

  // A session with a guest in it is not the caller's alone to throw away.
  //
  // Reloading a tab loses `window.__SANDBOX_SESSION_ID__`, so the browser has no
  // session to re-sign and asks to create one — a legitimate request that the
  // retirement below answered by stopping the session, releasing its claim lock
  // and tearing down its ALB routing. Every collaborator attached to that
  // container was ejected, and the owner lost their own work too.
  //
  // So resume instead: hand back the same session with a URL freshly signed for
  // this caller. Both sides keep the container and its files, and the reload
  // becomes a reconnect rather than a replacement.
  //
  // Deliberately conditional on there being someone else in the session, and not
  // applied to solo ones. Reloading is the only way a user can abandon a sandbox
  // that has become unusable — a wedged dev server, a corrupted workdir — and
  // resuming unconditionally would take that escape hatch away with no
  // replacement. Nobody else's work is at stake in the solo case, so the existing
  // fresh-start behaviour stays.
  //
  // PENDING sessions and ones that never claimed a container are excluded: there
  // is no container to hand back, so the returned URL would dial nothing.
  if (existing && existing.status === 'ACTIVE' && existing.taskArn && hasOtherMembers(existing, userId)) {
    console.log(`Resuming shared session ${existing.sessionId} for user ${userId} rather than retiring it`);

    // The reload itself is activity. Without this a reconnecting owner could still
    // lose the session to the idle reaper mid-reload.
    await updateLastActivity(existing.sessionId, existing.taskArn);

    return response(200, {
      sessionId: existing.sessionId,
      wsUrl: await buildWsUrl(existing.sessionId),
      previewDomain: `${existing.sessionId}.${PREVIEW_DOMAIN}`,
      previewUrl: previewUrlFor(existing.sessionId),
      resumed: true,
    });
  }

  if (existing) {
    // Its task is stopped, not kept warm: a container serves one session for its
    // lifetime and is replaced between tenants rather than cleaned up.
    console.log(`Retiring session ${existing.sessionId} for user ${userId} (stopping its task)`);
    await endSession(existing, 'Replaced by a new session');
  }

  // Create new session record
  const session = newSessionRecord(userId);
  await createSession(session);

  // Set once this session holds the task's claim lock, so a failure after that
  // point knows it has a task to release.
  let claimedTaskArn: string | null = null;

  try {
    const taskInfo = await claimTaskForSession(session.sessionId);
    claimedTaskArn = taskInfo.taskArn;

    // Assign the task before anything can connect to it. The sidecar accepts
    // only the session in this tag, so it must be in place before the URL is
    // signed; if tagging fails no URL is issued.
    await tagTaskForSession(taskInfo.taskArn, session.sessionId);

    // Route this session's traffic to the container just claimed. Fatal on
    // failure: there is no shared fallback route (it used to land sessions on
    // arbitrary containers), so a session without a rule cannot be served.
    const routing = await provisionSessionRouting(session.sessionId, taskInfo.privateIp);

    if (!routing) {
      throw new Error('Could not provision session routing');
    }

    const wsUrl = await buildWsUrl(session.sessionId);

    // Publish metric for auto-scaling (fire and forget)
    publishAvailabilityMetric().catch(() => {});

    return response(201, {
      sessionId: session.sessionId,
      wsUrl,
      previewDomain: `${session.sessionId}.${PREVIEW_DOMAIN}`,
      previewUrl: previewUrlFor(session.sessionId),
    });
  } catch (err) {
    console.error('Failed to claim warm task:', err);

    // Release everything the claim got as far as creating. If this session took
    // the task's claim lock, the task may already carry its tag, so it is
    // stopped rather than returned to the pool. If the race was lost, the task
    // belongs to someone else and is left alone.
    await endSession(
      { ...session, taskArn: claimedTaskArn ?? '' },
      'Session claim failed',
    );

    // Publish metric even on failure — auto-scaling needs to know we're at capacity
    publishAvailabilityMetric().catch(() => {});

    return response(503, {
      error: 'No sandbox containers available. Please try again.',
    });
  }
}

/**
 * Mint an invite link for a session. Only the owner can invite, so a
 * collaborator cannot widen access to someone else's sandbox.
 */
async function handleCreateInvite(
  apiEvent: APIGatewayProxyEvent,
  sessionId: string,
  authenticatedUserId: string,
): Promise<ApiResponse> {
  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  if (session.userId !== authenticatedUserId) {
    return response(403, { error: 'Only the session owner can invite' });
  }

  if (session.status !== 'ACTIVE') {
    return response(409, { error: `Session is ${session.status}` });
  }

  // The inviter passes the project they have open, so redeeming the invite can
  // grant its conversation too. Optional: a session without a project (nothing
  // built yet) still shares fine, just with no history to hand over.
  let requestedProjectId: unknown;
  try {
    requestedProjectId = (JSON.parse(apiEvent.body ?? '{}') as { projectId?: unknown }).projectId;
  } catch {
    // A malformed body only costs the chat handover, not the invite.
  }

  if (
    requestedProjectId !== undefined &&
    requestedProjectId !== null &&
    (typeof requestedProjectId !== 'string' || requestedProjectId.length === 0 || requestedProjectId.length > 256)
  ) {
    return response(400, { error: 'projectId must be a non-empty string' });
  }

  // The project is caller-supplied, so it is only carried if the caller owns it.
  // Otherwise anyone with a session could mint a link that, once redeemed, writes
  // a membership row into somebody else's project.
  let projectId: string | undefined;
  if (typeof requestedProjectId === 'string') {
    const ownerId = await getProjectOwner(requestedProjectId);

    if (ownerId !== null && ownerId !== authenticatedUserId) {
      return response(403, { error: 'Only the project owner can share it' });
    }

    // A project that does not exist (yet) is dropped rather than carried: if it
    // were carried, whoever later creates a project with that id would hand it to
    // the redeemer. The invite still shares the sandbox.
    projectId = ownerId === authenticatedUserId ? requestedProjectId : undefined;
  }

  const invite = newInviteRecord(sessionId, authenticatedUserId, projectId);
  await createInvite(invite);

  return response(201, { token: invite.token, expiresAt: invite.expiresAt });
}

/**
 * Revoke an invite link, and with it the access it granted.
 *
 * Owner-only, for the same reason minting one is: a collaborator does not get to
 * manage access to someone else's sandbox. Revoking a link someone has already
 * redeemed removes that person from the session and from the project the link
 * shared, so revocation means the access is gone, not only the link.
 *
 * The token arrives in the query string rather than the path so it is not
 * mistaken for a session id by the `/session/{id}` routes, and rather than in a
 * body because a DELETE body is not reliably forwarded.
 */
async function handleRevokeInvite(
  apiEvent: APIGatewayProxyEvent,
  sessionId: string,
  authenticatedUserId: string,
): Promise<ApiResponse> {
  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  if (session.userId !== authenticatedUserId) {
    return response(403, { error: 'Only the session owner can revoke an invite' });
  }

  const token = apiEvent.queryStringParameters?.token;

  if (!token) {
    return response(400, { error: 'Missing invite token' });
  }

  const invite = await findInvite(token);

  // Only an invite into *this* session is the caller's to revoke. One for a
  // different session is left untouched, and answered exactly like an unknown
  // token so the response confirms nothing about tokens that are not theirs.
  if (invite && invite.sessionId === sessionId && invite.invitedBy === authenticatedUserId) {
    // Order matters. Marking it revoked first makes any concurrent re-claim fail,
    // so the removals below cannot be undone by a join racing them; the record is
    // only deleted once the access it granted is gone, so a failure part-way can
    // be retried with the same token.
    await markInviteRevoked(invite);

    const redeemer = invite.redeemedBy;
    if (redeemer && redeemer !== session.userId) {
      await removeMember(sessionId, redeemer);

      if (invite.projectId) {
        await removeProjectMember(invite.projectId, redeemer);
      }
    }

    await deleteInvite(invite);
  }

  // Deliberately the same answer whether or not the token existed: an owner
  // revoking a link they already revoked has got what they asked for, and the
  // response must not confirm which tokens are live.
  return response(200, { ok: true });
}

/**
 * Redeem an invite token: records the caller as a member and hands back the
 * owner's connection details so their browser joins the SAME container.
 *
 * The caller must already be an authenticated user — an invite widens access for
 * a known identity, it does not create anonymous access.
 */
async function handleJoinSession(
  apiEvent: APIGatewayProxyEvent,
  authenticatedUserId: string,
): Promise<ApiResponse> {
  let token: unknown;
  try {
    token = (JSON.parse(apiEvent.body ?? '{}') as { token?: unknown }).token;
  } catch {
    return response(400, { error: 'Invalid request body' });
  }

  if (typeof token !== 'string' || token.length === 0 || token.length > 256) {
    return response(400, { error: 'Missing invite token' });
  }

  // Unknown, revoked and expired tokens are indistinguishable to the caller, so
  // a token cannot be probed for validity.
  const invite = await getInvite(token);
  if (!invite) {
    return response(403, { error: 'Invite is invalid or has expired' });
  }

  const session = await getSession(invite.sessionId);
  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  // Only the session's owner can hand out access to it. Invite creation already
  // enforces this; re-checking here means a record that somehow names a different
  // minter (or a session that changed hands) grants nothing.
  if (invite.invitedBy !== session.userId) {
    return response(403, { error: 'Invite is invalid or has expired' });
  }

  if (session.status !== 'ACTIVE') {
    return response(409, { error: `Session is ${session.status}` });
  }

  // Someone who is already in this session needs nothing from the link, so the
  // claim below is skipped for them entirely. That covers the owner, and it covers
  // a guest who is re-sent a link that a third person has since claimed.
  const alreadyIn = isMember(session, authenticatedUserId);

  // A link grants access to one person. Claimed before any membership is written
  // and after the session has been checked, so losing the race costs the loser
  // nothing and a link is never spent on a session that could not be joined.
  //
  // Re-claiming as the same user succeeds, which is what keeps a guest's own
  // reload working: their browser has only the token to reconnect with.
  if (!alreadyIn && !(await claimInvite(invite, authenticatedUserId))) {
    return response(403, { error: 'Invite is invalid or has already been used' });
  }

  if (!alreadyIn) {
    await addMember(session.sessionId, authenticatedUserId);
  }

  // The project is only honoured if the person who minted the invite owns it
  // now. Creation checks this too, but links minted before that check existed
  // can carry anyone's project id.
  const sharedProjectId =
    invite.projectId && (await getProjectOwner(invite.projectId)) === invite.invitedBy
      ? invite.projectId
      : undefined;

  // Grant the conversation as well as the container. Sharing only the sandbox
  // leaves the guest looking at files with no history behind them and an AI with
  // nothing to continue. Best-effort: failing here must not cost them the session
  // they were invited to.
  //
  // Only on the redemption that let them in. A member re-using the link must not
  // be re-granted a project the owner has since removed them from.
  if (sharedProjectId && !alreadyIn) {
    try {
      await addProjectMember(sharedProjectId, authenticatedUserId);
    } catch (err) {
      console.warn('[join] Could not grant project access:', (err as Error)?.name);
    }
  }

  return response(200, {
    sessionId: session.sessionId,
    wsUrl: await buildWsUrl(session.sessionId),
    previewDomain: `${session.sessionId}.${PREVIEW_DOMAIN}`,
    previewUrl: previewUrlFor(session.sessionId),
    projectId: sharedProjectId,
  });
}

async function handleGetSession(sessionId: string, authenticatedUserId: string): Promise<ApiResponse> {
  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  if (!isMember(session, authenticatedUserId)) {
    return response(403, { error: 'Forbidden' });
  }

  // Include a freshly-signed URL so a client whose URL expired during a long
  // reconnect backoff can get a valid one without creating a new session (which
  // would abandon the sandbox they are working in). Only reachable by a member.
  return response(200, {
    session,
    wsUrl: await buildWsUrl(session.sessionId),
    previewUrl: previewUrlFor(session.sessionId),
  });
}

async function handleHeartbeat(sessionId: string, authenticatedUserId: string): Promise<ApiResponse> {
  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  // Collaborators keep the session alive too — otherwise it could be reaped as
  // idle while an invited editor is still working in it.
  if (!isMember(session, authenticatedUserId)) {
    return response(403, { error: 'Forbidden' });
  }

  if (session.status !== 'ACTIVE') {
    return response(409, { error: `Session is ${session.status}` });
  }

  await updateLastActivity(sessionId, session.taskArn || undefined);

  return response(200, { ok: true });
}

/**
 * End a session: stop its task, release its claim lock, tear down its routing.
 *
 * Each step is isolated so one failing cannot skip the others — the routing
 * teardown in particular always runs, because a rule left behind leaks a slot on
 * a listener with a 100-rule quota. The session is only marked STOPPED once its
 * task is confirmed stopped; otherwise it stays STOPPING and the cleanup cron
 * (which reaps stuck STOPPING sessions) retries.
 */
async function endSession(session: Session, reason: string): Promise<void> {
  const { sessionId, taskArn } = session;
  let taskStopped = !taskArn;

  try {
    await updateSessionStatus(sessionId, 'STOPPING');
  } catch (err) {
    console.error(`[end] Could not mark ${sessionId} STOPPING:`, err);
  }

  if (taskArn) {
    try {
      await stopTask(taskArn, reason);
      taskStopped = true;
    } catch (err) {
      console.error(`[end] Could not stop task for ${sessionId}:`, err);
    }
  }

  await teardownSessionRouting(sessionId);

  if (!taskStopped) {
    return;
  }

  if (taskArn) {
    await deleteClaimLock(taskArn);
  }

  try {
    await updateSessionStatus(sessionId, 'STOPPED');
  } catch (err) {
    console.error(`[end] Could not mark ${sessionId} STOPPED:`, err);
  }
}

async function handleDeleteSession(sessionId: string, authenticatedUserId: string): Promise<ApiResponse> {
  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  // Deliberately owner-only, unlike read and heartbeat: an invited collaborator
  // must not be able to tear down the owner's sandbox and destroy their work.
  if (session.userId !== authenticatedUserId) {
    return response(403, { error: 'Forbidden' });
  }

  if (session.status === 'STOPPED') {
    return response(200, { ok: true, message: 'Already stopped' });
  }

  await endSession(session, 'User requested stop');

  publishAvailabilityMetric().catch(() => {});

  return response(200, { ok: true });
}

/**
 * Cleanup handler — runs on a 5-minute EventBridge cron.
 * Ends sessions idle for >30 minutes and ones stuck PENDING or STOPPING.
 * Also publishes availability metrics for auto-scaling.
 */
async function handleCleanup(): Promise<void> {
  console.log('Running session cleanup');

  const idleSessions = await getIdleSessions();
  console.log(`Found ${idleSessions.length} idle or stuck sessions`);

  for (const session of idleSessions) {
    try {
      console.log(
        `Ending ${session.status} session ${session.sessionId} (last activity: ${new Date(session.lastActivity).toISOString()})`,
      );
      await endSession(session, session.status === 'ACTIVE' ? 'Idle timeout' : `Stuck ${session.status}`);
    } catch (err) {
      console.error(`Failed to stop session ${session.sessionId}:`, err);
    }
  }

  // Sweep up what sessions that ended without a clean teardown left behind.
  const routing = await reconcileOrphanRouting(isSessionOrphaned);
  console.log(
    `[reconcile] session rules=${routing.sessionRuleCount} deleted rules=${routing.deletedRules} ` +
      `target groups=${routing.deletedTargetGroups}`,
  );
  await publishSessionRuleCount(routing.sessionRuleCount);
  await stopOrphanTasks();

  // Always publish metrics on cleanup — even if no sessions were stopped.
  // This ensures auto-scaling gets a signal every 5 minutes.
  await publishAvailabilityMetric();

  console.log('Cleanup complete');
}

/** How long a STOPPED session's leftovers are left alone, in case its teardown is still running. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/** Most orphan tasks stopped per cleanup run, so a bad answer cannot drain the pool at once. */
const MAX_ORPHAN_TASK_STOPS = 10;

/**
 * Whether a session's routing and task may be reclaimed: its record is gone, or
 * it has been STOPPED for longer than the grace period. A lookup failure answers
 * "no", so reconciliation never deletes on a guess.
 */
async function isSessionOrphaned(sessionId: string): Promise<boolean> {
  try {
    const session = await getSession(sessionId);

    if (!session) {
      return true;
    }

    if (session.status !== 'STOPPED') {
      return false;
    }

    return !session.statusChangedAt || session.statusChangedAt < Date.now() - ORPHAN_GRACE_MS;
  } catch (err) {
    console.warn(`[reconcile] Could not look up session ${sessionId}:`, err);
    return false;
  }
}

/** Stop running tasks still assigned to a session that has ended. Never throws. */
async function stopOrphanTasks(): Promise<void> {
  try {
    let stopped = 0;

    for (const { taskArn, sessionId } of await listAssignedTasks()) {
      if (stopped >= MAX_ORPHAN_TASK_STOPS) {
        break;
      }

      if (await isSessionOrphaned(sessionId)) {
        console.log(`[reconcile] Stopping task of ended session ${sessionId}`);
        await stopTask(taskArn, 'Session ended');
        stopped++;
      }
    }
  } catch (err) {
    console.warn('[reconcile] Orphan task sweep failed:', err);
  }
}

/** Alarmed on in the stack: the listener's rule quota is what ran out in prod. */
async function publishSessionRuleCount(count: number): Promise<void> {
  const namespace = process.env.METRIC_NAMESPACE;

  if (!namespace) {
    return;
  }

  try {
    await cwClient.send(new PutMetricDataCommand({
      Namespace: namespace,
      MetricData: [{ MetricName: 'SessionRuleCount', Value: count, Unit: 'Count', Timestamp: new Date() }],
    }));
  } catch (err) {
    console.warn('[metrics] Failed to publish SessionRuleCount:', err);
  }
}

function response(statusCode: number, body: any): ApiResponse {
  return {
    statusCode,
    headers: getCorsHeaders(),
    body: JSON.stringify(body),
  };
}

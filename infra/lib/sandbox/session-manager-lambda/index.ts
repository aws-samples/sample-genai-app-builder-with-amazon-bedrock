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
  claimInvite,
  deleteInvite,
  newInviteRecord,
  setBoundContainer,
  addProjectMember,
} from './sessions';
import { claimWarmTask, stopTask } from './ecs-manager';
import { signWsUrl, getSigningKey } from './ws-signed-url';
import {
  provisionSessionRouting,
  teardownSessionRouting,
  taskIpFromContainerId,
} from './alb-routing';
import type { ApiResponse } from './types';

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

  console.log('[auth] Authorizer context keys:', Object.keys(authorizer));

  if (authorizer.userId) {
    console.log('[auth] Resolved userId from custom authorizer:', authorizer.userId);
    return authorizer.userId;
  }
  if (authorizer.principalId) {
    console.log('[auth] Resolved userId from principalId:', authorizer.principalId);
    return authorizer.principalId;
  }

  if (authorizer.claims) {
    const userId = authorizer.claims.sub || authorizer.claims['cognito:username'] || null;
    console.log('[auth] Resolved userId from Cognito claims:', userId);
    return userId;
  }

  console.warn('[auth] Could not extract userId from authorizer context:', JSON.stringify(authorizer));
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

    // POST /session/{id}/bind — pin routing to the container that answered
    if (httpMethod === 'POST' && path.endsWith('/bind')) {
      return await handleBindContainer(apiEvent, sessionId, authenticatedUserId);
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

async function handleCreateSession(userId: string): Promise<ApiResponse> {
  // Retire existing session DB record but keep the ECS task running.
  // The task becomes unclaimed and immediately available for the new session.
  // The sidecar cleans the workdir when it sees the new sessionId on connect.
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
    await updateLastActivity(existing.sessionId);

    return response(200, {
      sessionId: existing.sessionId,
      wsUrl: await buildWsUrl(existing.sessionId),
      previewDomain: `${existing.sessionId}.${PREVIEW_DOMAIN}`,
      resumed: true,
    });
  }

  if (existing) {
    console.log(`Retiring session ${existing.sessionId} for user ${userId} (keeping ECS task for reuse)`);
    await updateSessionStatus(existing.sessionId, 'STOPPED');
    if (existing.taskArn) {
      await deleteClaimLock(existing.taskArn);
    }
    await teardownSessionRouting(existing.sessionId);
  }

  // Create new session record
  const session = newSessionRecord(userId);
  await createSession(session);

  // Claim a warm pool task — cross-reference DynamoDB to skip already-claimed containers
  try {
    const claimedArns = await getClaimedTaskArns();
    const taskInfo = await claimWarmTask(session.sessionId, claimedArns);
    await setTaskInfo(session.sessionId, taskInfo.taskArn, taskInfo.privateIp);

    // Pin this session's traffic to the container we just claimed, so every
    // collaborator who opens it reaches the same one. Deliberately not fatal: on
    // failure the session still works via the shared catch-all route.
    await provisionSessionRouting(session.sessionId, taskInfo.privateIp);

    const wsUrl = await buildWsUrl(session.sessionId);

    // Publish metric for auto-scaling (fire and forget)
    publishAvailabilityMetric().catch(() => {});

    return response(201, {
      sessionId: session.sessionId,
      wsUrl,
      previewDomain: `${session.sessionId}.${PREVIEW_DOMAIN}`,
    });
  } catch (err) {
    console.error('Failed to claim warm task:', err);
    await updateSessionStatus(session.sessionId, 'STOPPED');

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
  let projectId: string | undefined;
  try {
    projectId = (JSON.parse(apiEvent.body ?? '{}') as { projectId?: string }).projectId;
  } catch {
    // A malformed body only costs the chat handover, not the invite.
  }

  const invite = newInviteRecord(sessionId, authenticatedUserId, projectId);
  await createInvite(invite);

  // No expiry to report: the link lasts until it is redeemed or revoked.
  return response(201, { token: invite.token });
}

/**
 * Revoke an invite link. Owner-only, for the same reason minting one is: a
 * collaborator does not get to manage access to someone else's sandbox.
 *
 * This is the counterweight to invites no longer expiring. A link that was pasted
 * into the wrong channel used to become harmless after thirty minutes; now the
 * owner has to be able to make it harmless on demand, which is what this does.
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

  await deleteInvite(token);

  // Deliberately the same answer whether or not the token existed: an owner
  // revoking a link they already revoked has got what they asked for, and the
  // response must not confirm which of their tokens are live.
  return response(200, { ok: true });
}

/**
 * Pin this session's routing to the container that actually answered.
 *
 * Claiming a warm task only writes a DynamoDB record; nothing tells the container
 * it now owns the session, so the claim is a guess until a connection lands. The
 * sidecar reports its own hostname in `system:ready`, and the client reports it
 * back here, which makes the container the authority on the binding. Every later
 * collaborator then routes to the same box.
 *
 * Owner-only: a collaborator must not be able to repoint someone else's session.
 * Idempotent, so the common case of re-reporting the same container is cheap.
 */
async function handleBindContainer(
  apiEvent: APIGatewayProxyEvent,
  sessionId: string,
  authenticatedUserId: string,
): Promise<ApiResponse> {
  let containerId: string | undefined;
  try {
    containerId = (JSON.parse(apiEvent.body ?? '{}') as { containerId?: string }).containerId;
  } catch {
    return response(400, { error: 'Invalid request body' });
  }

  const privateIp = taskIpFromContainerId(containerId);

  if (!privateIp) {
    return response(400, { error: 'Unrecognised container id' });
  }

  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  if (session.userId !== authenticatedUserId) {
    return response(403, { error: 'Only the session owner can bind a container' });
  }

  if (session.privateIp === privateIp) {
    return response(200, { ok: true, rebound: false });
  }

  await setBoundContainer(sessionId, privateIp);
  const routing = await provisionSessionRouting(sessionId, privateIp);

  return response(200, { ok: true, rebound: true, routed: routing !== null });
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
  let token: string | undefined;
  try {
    token = (JSON.parse(apiEvent.body ?? '{}') as { token?: string }).token;
  } catch {
    return response(400, { error: 'Invalid request body' });
  }

  if (!token) {
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
  if (!alreadyIn && !(await claimInvite(token, authenticatedUserId))) {
    return response(403, { error: 'Invite is invalid or has already been used' });
  }

  if (!alreadyIn) {
    await addMember(session.sessionId, authenticatedUserId);
  }

  // Grant the conversation as well as the container. Sharing only the sandbox
  // leaves the guest looking at files with no history behind them and an AI with
  // nothing to continue. Best-effort: failing here must not cost them the session
  // they were invited to.
  if (invite.projectId) {
    try {
      await addProjectMember(invite.projectId, authenticatedUserId);
    } catch (err) {
      console.warn('[join] Could not grant project access:', err);
    }
  }

  return response(200, {
    sessionId: session.sessionId,
    wsUrl: await buildWsUrl(session.sessionId),
    previewDomain: `${session.sessionId}.${PREVIEW_DOMAIN}`,
    projectId: invite.projectId,
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

  await updateLastActivity(sessionId);

  return response(200, { ok: true });
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

  await updateSessionStatus(sessionId, 'STOPPING');

  if (session.taskArn) {
    await stopTask(session.taskArn, 'User requested stop');
    await deleteClaimLock(session.taskArn);
  }

  await teardownSessionRouting(sessionId);
  await updateSessionStatus(sessionId, 'STOPPED');

  publishAvailabilityMetric().catch(() => {});

  return response(200, { ok: true });
}

/**
 * Cleanup handler — runs on a 5-minute EventBridge cron.
 * Stops sessions that have been idle for >30 minutes.
 * Also publishes availability metrics for auto-scaling.
 */
async function handleCleanup(): Promise<void> {
  console.log('Running session cleanup');

  const idleSessions = await getIdleSessions();
  console.log(`Found ${idleSessions.length} idle sessions`);

  for (const session of idleSessions) {
    try {
      console.log(`Stopping idle session ${session.sessionId} (last activity: ${new Date(session.lastActivity).toISOString()})`);

      await updateSessionStatus(session.sessionId, 'STOPPING');

      if (session.taskArn) {
        await stopTask(session.taskArn, 'Idle timeout');
        await deleteClaimLock(session.taskArn);
      }

      await teardownSessionRouting(session.sessionId);
      await updateSessionStatus(session.sessionId, 'STOPPED');
    } catch (err) {
      console.error(`Failed to stop session ${session.sessionId}:`, err);
    }
  }

  // Always publish metrics on cleanup — even if no sessions were stopped.
  // This ensures auto-scaling gets a signal every 5 minutes.
  await publishAvailabilityMetric();

  console.log('Cleanup complete');
}

function response(statusCode: number, body: any): ApiResponse {
  return {
    statusCode,
    headers: getCorsHeaders(),
    body: JSON.stringify(body),
  };
}

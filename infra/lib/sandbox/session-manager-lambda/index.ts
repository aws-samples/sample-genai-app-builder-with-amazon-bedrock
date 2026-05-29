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
} from './sessions';
import { claimWarmTask, stopTask } from './ecs-manager';
import type { ApiResponse } from './types';

const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN || '';
const ALB_DNS_NAME = process.env.ALB_DNS_NAME || '';
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

    const sessionId = pathParameters?.id;

    if (!sessionId) {
      return response(400, { error: 'Missing session ID' });
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

async function handleCreateSession(userId: string): Promise<ApiResponse> {
  // Retire existing session DB record but keep the ECS task running.
  // The task becomes unclaimed and immediately available for the new session.
  // The sidecar cleans the workdir when it sees the new sessionId on connect.
  const existing = await getActiveSessionByUser(userId);

  if (existing) {
    console.log(`Retiring session ${existing.sessionId} for user ${userId} (keeping ECS task for reuse)`);
    await updateSessionStatus(existing.sessionId, 'STOPPED');
    if (existing.taskArn) {
      await deleteClaimLock(existing.taskArn);
    }
  }

  // Create new session record
  const session = newSessionRecord(userId);
  await createSession(session);

  // Claim a warm pool task — cross-reference DynamoDB to skip already-claimed containers
  try {
    const claimedArns = await getClaimedTaskArns();
    const taskInfo = await claimWarmTask(session.sessionId, claimedArns);
    await setTaskInfo(session.sessionId, taskInfo.taskArn, taskInfo.privateIp);

    // Route WebSocket through the custom domain (same-origin) for CSP compliance.
    // Falls back to CloudFront domain, then ALB.
    const customDomain = PREVIEW_DOMAIN.replace(/^preview\./, '');
    const cfDomain = await getCloudfrontDomain();
    const wsDomain = (customDomain && customDomain !== 'localhost')
      ? customDomain
      : cfDomain;
    const wsUrl = wsDomain
      ? `wss://${wsDomain}/ws/${session.sessionId}`
      : ALB_DNS_NAME
        ? `ws://${ALB_DNS_NAME}:443/ws/${session.sessionId}`
        : `ws://${taskInfo.privateIp}:8080`;

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

async function handleGetSession(sessionId: string, authenticatedUserId: string): Promise<ApiResponse> {
  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  if (session.userId !== authenticatedUserId) {
    return response(403, { error: 'Forbidden' });
  }

  return response(200, { session });
}

async function handleHeartbeat(sessionId: string, authenticatedUserId: string): Promise<ApiResponse> {
  const session = await getSession(sessionId);

  if (!session) {
    return response(404, { error: 'Session not found' });
  }

  if (session.userId !== authenticatedUserId) {
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

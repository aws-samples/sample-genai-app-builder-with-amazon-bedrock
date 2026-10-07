import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  addProjectMember,
  createProject,
  deleteProject,
  getProjectMessages,
  getProjectMeta,
  getProjectMetaByUrlId,
  isProjectMember,
  listProjectMembers,
  listProjectsByOwner,
  newProjectMeta,
  putProjectMessages,
  removeProjectMember,
  touchProject,
  updateProjectMeta,
  WriteThrottledError,
} from './projects';
import type {
  ApiResponse,
  CreateProjectRequest,
  ProjectMeta,
  SaveMessagesRequest,
  UpdateProjectRequest,
} from './types';

const CLOUDFRONT_DOMAIN_PARAM = process.env.CLOUDFRONT_DOMAIN_PARAM || '';

// Cached CloudFront domain (resolved from SSM on first invocation)
let cachedCloudfrontDomain: string | null = null;

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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
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
 * API handler for durable projects and their chat history.
 * Routes: GET/POST /projects, GET/PATCH/DELETE /projects/{id},
 *         POST /projects/{id}/messages
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // Ensure CloudFront domain is cached before constructing any response headers.
  // Without this, the first invocation falls back to CORS_ORIGIN or '*'.
  await getCloudfrontDomain();

  const { httpMethod, path, pathParameters } = event;

  try {
    // CORS preflight
    if (httpMethod === 'OPTIONS') {
      return response(200, { ok: true });
    }

    // Every route needs an identity: a project is someone's, and there is no
    // anonymous read.
    const authenticatedUserId = getAuthenticatedUserId(event);
    if (!authenticatedUserId) {
      return response(401, { error: 'Authentication required' });
    }

    if (httpMethod === 'GET' && path === '/projects') {
      return await handleListProjects(authenticatedUserId);
    }

    if (httpMethod === 'POST' && path === '/projects') {
      return await handleCreateProject(event, authenticatedUserId);
    }

    const requestedId = pathParameters?.id;

    if (!requestedId) {
      return response(400, { error: 'Missing project ID' });
    }

    if (httpMethod === 'POST' && path.endsWith('/messages')) {
      return await handleSaveMessages(event, requestedId, authenticatedUserId);
    }

    if (httpMethod === 'POST' && path.endsWith('/members')) {
      return await handleAddMember(event, requestedId, authenticatedUserId);
    }

    if (httpMethod === 'GET' && path.endsWith('/members')) {
      return await handleListMembers(requestedId, authenticatedUserId);
    }

    // Checked ahead of the project-level DELETE, which the path would otherwise
    // also match — removing a member must not fall through to deleting the
    // project.
    const memberId = pathParameters?.memberId;

    if (httpMethod === 'DELETE' && memberId) {
      return await handleRemoveMember(requestedId, memberId, authenticatedUserId);
    }

    if (httpMethod === 'GET') {
      return await handleGetProject(requestedId, authenticatedUserId);
    }

    if (httpMethod === 'PATCH') {
      return await handleUpdateProject(event, requestedId, authenticatedUserId);
    }

    if (httpMethod === 'DELETE') {
      return await handleDeleteProject(requestedId, authenticatedUserId);
    }

    return response(404, { error: 'Not found' });
  } catch (err) {
    // A write that ran out of capacity is not an internal error: the request was
    // valid and the same request will succeed shortly. Saying so — 429 with
    // Retry-After rather than 500 — is what lets the client wait instead of
    // retrying on the next keystroke and deepening the throttle.
    if (err instanceof WriteThrottledError) {
      console.warn('Write throttled, asking the client to retry:', err.cause);

      return response(
        429,
        { error: 'Too many writes for this project, retry shortly' },
        { 'Retry-After': String(err.retryAfterSeconds) },
      );
    }

    console.error('Handler error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

/**
 * Resolve the id in the path to a project.
 *
 * Chat URLs route on the human-readable `urlId`, so the same path segment can be
 * either that or the projectId; the direct read is tried first because it is the
 * cheaper of the two.
 */
async function resolveProject(requestedId: string): Promise<ProjectMeta | null> {
  return (await getProjectMeta(requestedId)) ?? (await getProjectMetaByUrlId(requestedId));
}

/**
 * Load a project and check the caller may act on it.
 *
 * Returns the failure response rather than throwing so each route stays a
 * straight line, and fails closed: an unresolvable project is a 404 and a
 * non-member is a 403, never an implicit pass.
 */
async function requireMember(
  requestedId: string,
  userId: string,
): Promise<{ meta: ProjectMeta } | { error: ApiResponse }> {
  const meta = await resolveProject(requestedId);

  if (!meta) {
    return { error: response(404, { error: 'Project not found' }) };
  }

  if (!(await isProjectMember(meta, userId))) {
    return { error: response(403, { error: 'Forbidden' }) };
  }

  return { meta };
}

async function handleListProjects(userId: string): Promise<ApiResponse> {
  const projects = await listProjectsByOwner(userId);

  // Metadata only. The sidebar renders titles, and shipping every conversation
  // in the list response would grow without bound.
  return response(200, { projects });
}

async function handleCreateProject(
  event: APIGatewayProxyEvent,
  userId: string,
): Promise<ApiResponse> {
  let body: CreateProjectRequest;
  try {
    body = JSON.parse(event.body ?? '{}') as CreateProjectRequest;
  } catch {
    return response(400, { error: 'Invalid request body' });
  }

  // The client may supply the id: projects that already exist in a browser's
  // local history have to keep the id their URLs and workbench state refer to.
  const projectId = typeof body.id === 'string' && body.id.length > 0 ? body.id : crypto.randomUUID();
  const meta = newProjectMeta(userId, projectId, body.urlId, body.description);

  try {
    await createProject(meta);
  } catch (err) {
    // The id is taken. Migration re-sends projects it may have sent before, so
    // this is a normal outcome — but it must not hand the partition to whoever
    // asks for the id second.
    if (isConditionalFailure(err)) {
      const existing = await getProjectMeta(projectId);

      if (existing && existing.ownerId === userId) {
        return response(200, { project: existing });
      }

      return response(409, { error: 'Project already exists' });
    }
    throw err;
  }

  return response(201, { project: meta });
}

async function handleGetProject(requestedId: string, userId: string): Promise<ApiResponse> {
  const resolved = await requireMember(requestedId, userId);

  if ('error' in resolved) {
    return resolved.error;
  }

  const messages = await getProjectMessages(resolved.meta.projectId);

  return response(200, { project: resolved.meta, messages });
}

/**
 * Save a conversation. Members can write, not just the owner — an invited
 * collaborator's messages belong in the same history, attributed to them.
 */
async function handleSaveMessages(
  event: APIGatewayProxyEvent,
  requestedId: string,
  userId: string,
): Promise<ApiResponse> {
  let body: SaveMessagesRequest;
  try {
    body = JSON.parse(event.body ?? '{}') as SaveMessagesRequest;
  } catch {
    return response(400, { error: 'Invalid request body' });
  }

  if (!Array.isArray(body.messages)) {
    return response(400, { error: 'messages must be an array' });
  }

  const resolved = await requireMember(requestedId, userId);

  if ('error' in resolved) {
    return resolved.error;
  }

  const { projectId } = resolved.meta;
  const expiresAt = await touchProject(projectId);
  await putProjectMessages(projectId, body.messages, userId, expiresAt);

  return response(200, { ok: true, count: body.messages.length });
}

/**
 * Rename a project. Owner-only, deliberately unlike message writes: a
 * collaborator contributes to the conversation but does not get to relabel
 * someone else's project.
 */
/**
 * Grant another user access to this project's conversation.
 *
 * Sharing a sandbox is only half of collaborating: without this the person invited
 * into a live session sees the shared files but is refused the conversation that
 * produced them, so the AI has no history to continue.
 *
 * Owner-only, so a collaborator cannot widen access further. Idempotent, so a
 * repeated invite is harmless.
 */
async function handleAddMember(
  event: APIGatewayProxyEvent,
  requestedId: string,
  userId: string,
): Promise<ApiResponse> {
  let body: { userId?: string };
  try {
    body = JSON.parse(event.body ?? '{}') as { userId?: string };
  } catch {
    return response(400, { error: 'Invalid request body' });
  }

  if (!body.userId) {
    return response(400, { error: 'userId is required' });
  }

  const meta = await resolveProject(requestedId);

  if (!meta) {
    return response(404, { error: 'Project not found' });
  }

  if (meta.ownerId !== userId) {
    return response(403, { error: 'Forbidden' });
  }

  await addProjectMember(meta.projectId, body.userId);

  return response(200, { ok: true });
}

/**
 * Who has access to this project.
 *
 * Any member may read it, not just the owner: someone working in a shared chat is
 * entitled to know who else can see what they write there. It is also what a
 * collaborator needs in order to find themselves and leave.
 */
async function handleListMembers(requestedId: string, userId: string): Promise<ApiResponse> {
  const resolved = await requireMember(requestedId, userId);

  if ('error' in resolved) {
    return resolved.error;
  }

  return response(200, { members: await listProjectMembers(resolved.meta.projectId) });
}

/**
 * Take someone out of a project.
 *
 * The counterweight to an invite link that no longer expires: access that lasts
 * indefinitely has to be revocable, or "permanent" would mean "irrevocable".
 *
 * Two callers are allowed, and only these two. The owner may remove anyone, since
 * the project and its history are theirs. A collaborator may remove themselves
 * via the literal id `me`, so leaving a shared chat does not require asking the
 * owner. A collaborator removing a *third* party is refused — that would let one
 * guest evict another.
 *
 * The owner's own row is never removable: `isProjectMember` short-circuits on
 * ownership, so deleting it would not revoke anything, it would only leave the
 * membership records disagreeing with the project about who owns it.
 */
async function handleRemoveMember(
  requestedId: string,
  memberId: string,
  userId: string,
): Promise<ApiResponse> {
  const meta = await resolveProject(requestedId);

  if (!meta) {
    return response(404, { error: 'Project not found' });
  }

  const targetUserId = memberId === 'me' ? userId : memberId;
  const isOwner = meta.ownerId === userId;

  if (!isOwner && targetUserId !== userId) {
    return response(403, { error: 'Forbidden' });
  }

  if (targetUserId === meta.ownerId) {
    return response(400, { error: 'The owner cannot be removed from their own project' });
  }

  // Only checked for a self-removal, and only after the ownership rules: an owner
  // clearing out a row for someone who is already gone is a no-op they asked for.
  if (!isOwner && !(await isProjectMember(meta, userId))) {
    return response(403, { error: 'Forbidden' });
  }

  await removeProjectMember(meta.projectId, targetUserId);

  return response(200, { ok: true });
}

async function handleUpdateProject(
  event: APIGatewayProxyEvent,
  requestedId: string,
  userId: string,
): Promise<ApiResponse> {
  let body: UpdateProjectRequest;
  try {
    body = JSON.parse(event.body ?? '{}') as UpdateProjectRequest;
  } catch {
    return response(400, { error: 'Invalid request body' });
  }

  const description = typeof body.description === 'string' && body.description.length > 0 ? body.description : undefined;
  const urlId = typeof body.urlId === 'string' && body.urlId.length > 0 ? body.urlId : undefined;

  if (!description && !urlId) {
    return response(400, { error: 'description or urlId is required' });
  }

  const meta = await resolveProject(requestedId);

  if (!meta) {
    return response(404, { error: 'Project not found' });
  }

  if (meta.ownerId !== userId) {
    return response(403, { error: 'Forbidden' });
  }

  // The slug is settled by whoever created the project and is what a URL routes
  // on, so it is written once and never reassigned — a later change would strand
  // every link already shared, including a collaborator's open tab.
  await updateProjectMeta(meta.projectId, { description, urlId: meta.urlId ? undefined : urlId });

  return response(200, { ok: true });
}

/**
 * Owner-only: an invited collaborator must not be able to destroy the owner's
 * project and every message in it.
 */
async function handleDeleteProject(requestedId: string, userId: string): Promise<ApiResponse> {
  const meta = await resolveProject(requestedId);

  if (!meta) {
    return response(404, { error: 'Project not found' });
  }

  if (meta.ownerId !== userId) {
    return response(403, { error: 'Forbidden' });
  }

  await deleteProject(meta.projectId);

  return response(200, { ok: true });
}

function isConditionalFailure(err: unknown): boolean {
  const name = (err as { name?: string })?.name;

  // A transaction reports the same failure under its own name, and the reason
  // codes are where the per-item detail lives.
  return (
    name === 'ConditionalCheckFailedException' ||
    (name === 'TransactionCanceledException' &&
      ((err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).some(
        (reason) => reason?.Code === 'ConditionalCheckFailed',
      ))
  );
}

function response(
  statusCode: number,
  body: any,
  extraHeaders: Record<string, string> = {},
): ApiResponse {
  return {
    statusCode,
    headers: { ...getCorsHeaders(), ...extraHeaders },
    body: JSON.stringify(body),
  };
}

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  QueryCommand,
  DeleteItemCommand,
  TransactWriteItemsCommand,
  BatchWriteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type {
  IncomingMessage,
  ProjectMember,
  ProjectMemberRole,
  ProjectMessage,
  ProjectMeta,
} from './types';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.PROJECTS_TABLE_NAME!;

/**
 * Projects expire 90 days after the last write, not after creation — the TTL is
 * refreshed on every save, so anything still being worked on never ages out.
 */
const PROJECT_TTL_SECONDS = 90 * 24 * 60 * 60;

const META_SK = 'META';
const MESSAGE_SK_PREFIX = 'MSG#';
const MEMBER_SK_PREFIX = 'MEMBER#';

// DynamoDB caps BatchWriteItem at 25 requests.
const BATCH_LIMIT = 25;

/**
 * DynamoDB's hard cap on one item, in bytes. A message over this cannot be stored
 * at all, so it is truncated to fit rather than failing the whole save.
 */
const MAX_ITEM_BYTES = 400 * 1024;

/**
 * Payload ceiling for one BatchWriteItem, in bytes.
 *
 * The request cap is 16MB, but the binding constraint is write capacity: every
 * 1KB written against one partition key costs a WCU and a single key tops out
 * near 1000 WCU/s. All of a project's messages share `projectId`, so an unchunked
 * save of a file-heavy conversation spends that entire budget in one call — which
 * is how production started returning `ThrottlingException:
 * TableWriteKeyRangeThroughputExceeded`. Chunking by bytes keeps each request
 * well inside the per-key budget and makes a throttled retry cheap instead of
 * re-sending hundreds of kilobytes.
 */
const MAX_BATCH_BYTES = 256 * 1024;

/** Attempts per write before the throttle is reported to the caller. */
const WRITE_MAX_ATTEMPTS = 6;

/**
 * Base for the exponential backoff between write attempts.
 *
 * The SDK's own default — three attempts inside ~250ms, which is what the prod
 * traces show — is far too tight for a partition-level throttle, which has to be
 * waited out rather than raced. Overridable so tests can exercise the sequencing
 * without the wall clock.
 */
const WRITE_RETRY_BASE_MS = Number(process.env.PROJECTS_WRITE_RETRY_BASE_MS ?? 50);

/** Thrown once retries are exhausted, so the handler can answer 429 rather than 500. */
export class WriteThrottledError extends Error {
  readonly retryAfterSeconds = 2;

  constructor(readonly cause: unknown) {
    super('DynamoDB write capacity exhausted for this project');
    this.name = 'WriteThrottledError';
  }
}

function isThrottle(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? '';

  return (
    name === 'ThrottlingException' ||
    name === 'ProvisionedThroughputExceededException' ||
    name === 'RequestLimitExceeded'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait before attempt `attempt` (1-based). Exponential with full jitter, so
 * several Lambdas throttled by the same project do not resynchronise on retry and
 * throttle each other again.
 */
function backoff(attempt: number): Promise<void> {
  const ceiling = WRITE_RETRY_BASE_MS * 2 ** (attempt - 1);

  return sleep(Math.random() * ceiling);
}

/**
 * Run a write, retrying throttles with backoff.
 *
 * Only throttles are retried: they are the one failure expected to succeed
 * unchanged a moment later. Anything else is a real error and is raised
 * immediately rather than delayed six times over.
 */
async function withThrottleRetry<T>(write: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (!isThrottle(err)) {
        throw err;
      }

      lastError = err;

      if (attempt < WRITE_MAX_ATTEMPTS) {
        await backoff(attempt);
      }
    }
  }

  throw new WriteThrottledError(lastError);
}

/**
 * Width of the zero-padded ordering component of a message sort key.
 *
 * Sort keys compare as strings, so the number has to be padded to compare
 * numerically ('10' < '9' otherwise). Fifteen digits leaves room above a
 * millisecond epoch, which is thirteen.
 */
const SK_ORDER_WIDTH = 15;

function ttlFrom(nowMs: number): number {
  return Math.floor(nowMs / 1000) + PROJECT_TTL_SECONDS;
}

/**
 * Sort key for a message: its own creation time, then its own id.
 *
 * Both components come from the message itself rather than from the request, so
 * saving the same conversation twice rewrites the same items instead of
 * appending duplicates — which is the normal case, since the client saves the
 * whole array on every turn. Keying on the message rather than on its position
 * in the array is also what lets two collaborators append at the same time
 * without one of them overwriting the other's message.
 */
function messageSk(order: number, messageId: string): string {
  return `${MESSAGE_SK_PREFIX}${String(order).padStart(SK_ORDER_WIDTH, '0')}#${messageId}`;
}

export function newProjectMeta(
  ownerId: string,
  projectId: string,
  urlId?: string,
  description?: string,
): ProjectMeta {
  const now = Date.now();

  return {
    projectId,
    ownerId,
    urlId,
    description,
    createdAt: now,
    updatedAt: now,
    expiresAt: ttlFrom(now),
  };
}

/**
 * Create a project and record its owner as a member in one transaction.
 *
 * Both items or neither: a META with no membership row would be a project its
 * own owner could not be authorised against by the member lookup.
 *
 * Fails with ConditionalCheckFailedException if the id is taken, which matters
 * because the client supplies the id when migrating a project that already
 * exists in its local history.
 *
 * The membership row deliberately carries no `expiresAt`. It used to inherit
 * META's, which is the table's TTL attribute — and `touchProject` only refreshes
 * META, so an owner's own membership row expired 90 days after the project was
 * created however much work had gone into it since. That was invisible only
 * because `isProjectMember` short-circuits on ownership.
 *
 * Refreshing the row alongside META would have fixed the owner and left every
 * invited collaborator's row wrong, since `addProjectMember` never wrote a TTL on
 * one. Dropping it makes membership permanent for everyone, which is what a shared
 * chat promises. Nothing is left behind: the project's own 90-day TTL still
 * applies to META and to the conversation, and a membership row for a project
 * whose META has aged out grants nothing, because every route resolves META first
 * and answers 404 without it.
 */
export async function createProject(meta: ProjectMeta): Promise<void> {
  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: TABLE_NAME,
            Item: marshall({ ...meta, sk: META_SK }, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(projectId)',
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: marshall(
              {
                projectId: meta.projectId,
                sk: `${MEMBER_SK_PREFIX}${meta.ownerId}`,
                userId: meta.ownerId,
                role: 'owner',
                addedAt: meta.createdAt,
              },
              { removeUndefinedValues: true },
            ),
          },
        },
      ],
    }),
  );
}

export async function getProjectMeta(projectId: string): Promise<ProjectMeta | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ projectId, sk: META_SK }),
    }),
  );

  if (!result.Item) {
    return null;
  }

  return unmarshall(result.Item) as ProjectMeta;
}

/**
 * Resolve a project by the id its URL carries.
 *
 * Chat URLs use the human-readable `urlId`, so a request path is not necessarily
 * a `projectId`; callers try the direct read first and fall back to this.
 */
export async function getProjectMetaByUrlId(urlId: string): Promise<ProjectMeta | null> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'byUrlId',
      KeyConditionExpression: 'urlId = :urlId',
      ExpressionAttributeValues: marshall({ ':urlId': urlId }),
      Limit: 1,
    }),
  );

  if (!result.Items || result.Items.length === 0) {
    return null;
  }

  return unmarshall(result.Items[0]) as ProjectMeta;
}

/** Projects owned by a user, most recently updated first. Metadata only. */
export async function listProjectsByOwner(ownerId: string): Promise<ProjectMeta[]> {
  const projects: ProjectMeta[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: 'byOwner',
        KeyConditionExpression: 'ownerId = :ownerId',
        ExpressionAttributeValues: marshall({ ':ownerId': ownerId }),
        ScanIndexForward: false,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      projects.push(unmarshall(item) as ProjectMeta);
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return projects;
}

/** The conversation in order, oldest first. */
export async function getProjectMessages(projectId: string): Promise<ProjectMessage[]> {
  const messages: ProjectMessage[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'projectId = :projectId AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: marshall({
          ':projectId': projectId,
          ':prefix': MESSAGE_SK_PREFIX,
        }),
        ScanIndexForward: true,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item) as Record<string, unknown>;
      messages.push({
        id: record.id as string,
        role: record.role as string,
        content: record.content as string,
        authorId: record.authorId as string,
        createdAt: record.createdAt as number,
      });
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return messages;
}

export async function getProjectMember(
  projectId: string,
  userId: string,
): Promise<ProjectMember | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ projectId, sk: `${MEMBER_SK_PREFIX}${userId}` }),
    }),
  );

  if (!result.Item) {
    return null;
  }

  const record = unmarshall(result.Item) as Record<string, unknown>;

  return {
    userId: record.userId as string,
    role: record.role as ProjectMemberRole,
    addedAt: record.addedAt as number,
  };
}

/**
 * Everyone with access to a project, owner first.
 *
 * Membership is permanent, so it has to be visible: an owner who cannot see who
 * is in a shared chat cannot make an informed decision about removing anyone.
 * Read from the project's own partition, so this costs one query however many
 * projects exist.
 */
export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const members: ProjectMember[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'projectId = :projectId AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: marshall({
          ':projectId': projectId,
          ':prefix': MEMBER_SK_PREFIX,
        }),
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item) as Record<string, unknown>;
      members.push({
        userId: record.userId as string,
        role: record.role as ProjectMemberRole,
        addedAt: record.addedAt as number,
      });
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  // The owner leads, then collaborators in the order they joined. Sort keys order
  // members by user id, which is meaningless to a reader.
  return members.sort((a, b) => {
    if (a.role !== b.role) {
      return a.role === 'owner' ? -1 : 1;
    }
    return (a.addedAt ?? 0) - (b.addedAt ?? 0);
  });
}

/**
 * Revoke a user's access to a project.
 *
 * The counterweight to permanent membership: an invite that never lapses is only
 * safe if the access it granted can be taken back. Deleting the row is enough —
 * {@link isProjectMember} reads it live on every request, so the next call from
 * that user is already refused with nothing to invalidate.
 */
export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await client.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ projectId, sk: `${MEMBER_SK_PREFIX}${userId}` }),
    }),
  );
}

/**
 * Whether a user may read and append to a project: its owner, or someone
 * recorded as a member.
 *
 * A project id appears in URLs and is shared around, so it is not a secret —
 * access is gated on the membership record rather than on knowing the id.
 */
export async function isProjectMember(meta: ProjectMeta, userId: string): Promise<boolean> {
  if (meta.ownerId === userId) {
    return true;
  }

  return (await getProjectMember(meta.projectId, userId)) !== null;
}

/**
 * Grant a user access to a project's conversation.
 *
 * Called when someone is invited into a live session: sharing the sandbox is only
 * half of collaborating, and without this the guest sees the shared files but a
 * conversation they are not allowed to read.
 *
 * Idempotent, so re-joining a session is harmless.
 */
export async function addProjectMember(
  projectId: string,
  userId: string,
  role: ProjectMemberRole = 'editor',
): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall({
        projectId,
        sk: `${MEMBER_SK_PREFIX}${userId}`,
        userId,
        role,
        addedAt: Date.now(),
      }),
    }),
  );
}

/**
 * Persist a conversation, attributing every message to the caller.
 *
 * Idempotent by key: the same array saved twice overwrites the same items. The
 * client sends the whole conversation on each turn, so this is the common case
 * rather than an edge one.
 */
export async function putProjectMessages(
  projectId: string,
  messages: IncomingMessage[],
  authorId: string,
  expiresAt: number,
): Promise<void> {
  // Ordering runs off the message timestamps, but a client is not obliged to
  // send them, and two messages in one turn can share a millisecond. Carrying
  // the previous key forward keeps the stored order equal to the array order
  // whatever the timestamps look like, without reintroducing a dependence on the
  // array position that would break concurrent appends.
  let previousOrder = 0;

  const requests = messages.map((message, index) => {
    const messageId = messageIdOf(message, index);
    const createdAt = createdAtOf(message);
    const order = Math.max(previousOrder + 1, createdAt ?? 0);
    previousOrder = order;

    const item = {
      projectId,
      sk: messageSk(order, messageId),
      id: messageId,
      role: typeof message.role === 'string' ? message.role : 'user',
      content: contentOf(message),
      authorId,
      createdAt: createdAt ?? order,
      expiresAt,
    };

    return {
      bytes: itemBytes(item),
      request: {
        PutRequest: { Item: marshall(fitItem(item), { removeUndefinedValues: true }) },
      },
    };
  });

  for (const batch of batchByBytes(requests)) {
    await writeBatch(batch);
  }
}

/**
 * Approximate stored size of an item.
 *
 * DynamoDB charges for attribute names plus values; the UTF-8 length of the plain
 * object is within a few bytes of that and needs no marshalling to compute, which
 * keeps the chunking decision independent of the SDK.
 */
function itemBytes(item: Record<string, unknown>): number {
  return Object.entries(item).reduce(
    (total, [name, value]) =>
      total + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(String(value), 'utf8'),
    0,
  );
}

/**
 * Bring an oversized message under the 400KB item cap.
 *
 * Truncation is chosen over the alternatives deliberately. Dropping the message
 * silently loses a turn the user can see in their own browser but never again
 * anywhere else, and would desynchronise a collaborator's history. Spilling the
 * body to S3 would put chat content — which routinely contains customer file
 * contents — into a second store with its own lifecycle and IAM surface, for a
 * case that is already pathological: a single 400KB chat message. Keeping the
 * item, its id and its ordering intact preserves the conversation's shape, and
 * the marker makes the loss legible instead of mysterious.
 */
function fitItem(item: Record<string, unknown>): Record<string, unknown> {
  const bytes = itemBytes(item);

  if (bytes <= MAX_ITEM_BYTES) {
    return item;
  }

  const content = String(item.content ?? '');
  const overflow = bytes - MAX_ITEM_BYTES;
  const marker = `\n\n[truncated: this message exceeded the ${MAX_ITEM_BYTES / 1024}KB per-message storage limit]`;
  const keep = Math.max(0, content.length - overflow - Buffer.byteLength(marker, 'utf8'));

  return { ...item, content: content.slice(0, keep) + marker };
}

/**
 * Group requests into batches inside both DynamoDB limits — the 25-item cap and
 * the byte ceiling. One item always gets its own batch even if it alone is over
 * the ceiling, since it cannot be split any further.
 */
function batchByBytes<T>(entries: { bytes: number; request: T }[]): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const entry of entries) {
    const wouldOverflow = current.length > 0 && currentBytes + entry.bytes > MAX_BATCH_BYTES;

    if (current.length === BATCH_LIMIT || wouldOverflow) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }

    current.push(entry.request);
    currentBytes += entry.bytes;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

/**
 * Send one batch until every item in it is stored.
 *
 * BatchWriteItem has two distinct failure modes and the original code handled
 * neither: it throws when the whole request is throttled, and it returns the
 * items it declined in `UnprocessedItems` when only some are. An unread
 * `UnprocessedItems` is a silent partial write — messages the API reported as
 * saved that were never stored.
 */
async function writeBatch(requests: unknown[]): Promise<void> {
  let pending = requests;

  for (let attempt = 1; attempt <= WRITE_MAX_ATTEMPTS; attempt++) {
    let result;

    try {
      result = await client.send(
        new BatchWriteItemCommand({ RequestItems: { [TABLE_NAME]: pending } as never }),
      );
    } catch (err) {
      if (!isThrottle(err)) {
        throw err;
      }

      if (attempt === WRITE_MAX_ATTEMPTS) {
        throw new WriteThrottledError(err);
      }

      await backoff(attempt);
      continue;
    }

    const unprocessed = result.UnprocessedItems?.[TABLE_NAME] ?? [];

    if (unprocessed.length === 0) {
      return;
    }

    pending = unprocessed;

    if (attempt < WRITE_MAX_ATTEMPTS) {
      await backoff(attempt);
    }
  }

  throw new WriteThrottledError(new Error(`${pending.length} message(s) left unprocessed`));
}

/**
 * A message must have a stable id for the re-save to be idempotent. The `ai`
 * SDK always supplies one; the positional fallback keeps a client that does not
 * from creating a fresh item on every save.
 */
function messageIdOf(message: IncomingMessage, index: number): string {
  return typeof message.id === 'string' && message.id.length > 0
    ? message.id
    : `idx-${String(index).padStart(6, '0')}`;
}

/** Undefined when the client sent no usable timestamp, so the caller can order around it. */
function createdAtOf(message: IncomingMessage): number | undefined {
  if (typeof message.createdAt === 'number') {
    return message.createdAt;
  }

  if (typeof message.createdAt === 'string') {
    const parsed = Date.parse(message.createdAt);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

/**
 * Chat content is a string in practice, but a structured part array reaches the
 * store unchanged rather than being dropped or crashing the write.
 */
function contentOf(message: IncomingMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }

  return message.content === undefined ? '' : JSON.stringify(message.content);
}

/** Bump last-activity, which also pushes the TTL out. */
export async function touchProject(projectId: string): Promise<number> {
  const now = Date.now();
  const expiresAt = ttlFrom(now);

  // The META item shares the partition key with every message in the project, so
  // this write competes for the same per-key capacity and throttles alongside them.
  await withThrottleRetry(() =>
    client.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ projectId, sk: META_SK }),
        UpdateExpression: 'SET updatedAt = :updatedAt, expiresAt = :expiresAt',
        ConditionExpression: 'attribute_exists(projectId)',
        ExpressionAttributeValues: marshall({ ':updatedAt': now, ':expiresAt': expiresAt }),
      }),
    ),
  );

  return expiresAt;
}

export async function updateProjectDescription(
  projectId: string,
  description: string,
): Promise<void> {
  await updateProjectMeta(projectId, { description });
}

/**
 * Patch a project's human-facing metadata.
 *
 * Both fields are optional because they are not known when a project is created:
 * the first save happens before the AI has produced an artifact, so the slug and
 * title only exist a turn later. A field left undefined is not touched.
 */
export async function updateProjectMeta(
  projectId: string,
  patch: { description?: string; urlId?: string },
): Promise<void> {
  const now = Date.now();
  const sets = ['updatedAt = :updatedAt', 'expiresAt = :expiresAt'];
  const values: Record<string, unknown> = { ':updatedAt': now, ':expiresAt': ttlFrom(now) };

  if (patch.description !== undefined) {
    sets.push('description = :description');
    values[':description'] = patch.description;
  }

  if (patch.urlId !== undefined) {
    sets.push('urlId = :urlId');
    values[':urlId'] = patch.urlId;
  }

  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ projectId, sk: META_SK }),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: 'attribute_exists(projectId)',
      ExpressionAttributeValues: marshall(values),
    }),
  );
}

/**
 * Delete every item in a project's partition — metadata, membership and the
 * whole conversation. Queried rather than assumed, since the message keys are
 * not derivable without reading them.
 */
export async function deleteProject(projectId: string): Promise<void> {
  const keys: Record<string, any>[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'projectId = :projectId',
        ExpressionAttributeValues: marshall({ ':projectId': projectId }),
        ProjectionExpression: 'projectId, sk',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      const record = unmarshall(item) as { projectId: string; sk: string };
      keys.push(marshall({ projectId: record.projectId, sk: record.sk }));
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  for (let i = 0; i < keys.length; i += BATCH_LIMIT) {
    await client.send(
      new BatchWriteItemCommand({
        RequestItems: {
          [TABLE_NAME]: keys.slice(i, i + BATCH_LIMIT).map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    );
  }
}

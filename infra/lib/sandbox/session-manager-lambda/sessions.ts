import {
  DynamoDBClient,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { createHash, randomBytes } from 'node:crypto';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { Invite, Session } from './types';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.SESSIONS_TABLE_NAME!;
// Redeeming an invite grants the inviter's project as well as their sandbox, which
// means writing one item into the projects table.
const PROJECTS_TABLE_NAME = process.env.PROJECTS_TABLE_NAME ?? '';
const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours, extended on every heartbeat
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
/** PENDING and STOPPING are transient; a session sat in one this long is stuck. */
const STUCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function createSession(session: Session): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(session, { removeUndefinedValues: true }),
      ConditionExpression: 'attribute_not_exists(sessionId)',
    }),
  );
}

export async function getSession(sessionId: string): Promise<Session | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId }),
    }),
  );

  if (!result.Item) {
    return null;
  }

  return unmarshall(result.Item) as Session;
}

/**
 * Set a session's status, stamping when it changed so orphan reconciliation can
 * tell a session that has just stopped from one that stopped long ago.
 */
export async function updateSessionStatus(
  sessionId: string,
  status: Session['status'],
): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId }),
      UpdateExpression: 'SET #status = :status, statusChangedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({ ':status': status, ':now': Date.now() }),
    }),
  );
}

/**
 * Record activity and push the session's TTL — and its task claim lock's — out
 * again.
 *
 * `expiresAt` used to be set once at creation, so DynamoDB deleted the record of
 * a session that was still in use two hours later. With the record gone the
 * reaper could never find it, and its ALB rule and task leaked for good.
 */
export async function updateLastActivity(sessionId: string, taskArn?: string): Promise<void> {
  const now = Date.now();
  const expiresAt = Math.floor(now / 1000) + SESSION_TTL_SECONDS;

  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId }),
      UpdateExpression: 'SET lastActivity = :lastActivity, expiresAt = :expiresAt',
      ExpressionAttributeValues: marshall({ ':lastActivity': now, ':expiresAt': expiresAt }),
    }),
  );

  if (!taskArn) {
    return;
  }

  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ sessionId: `TASK#${taskArn}` }),
        UpdateExpression: 'SET expiresAt = :expiresAt',
        // Extend only a lock this session holds; never create one.
        ConditionExpression: 'attribute_exists(sessionId) AND claimedBySession = :sessionId',
        ExpressionAttributeValues: marshall({ ':expiresAt': expiresAt, ':sessionId': sessionId }),
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      console.warn(`[sessions] Could not extend claim lock for ${taskArn}:`, err);
    }
  }
}

/**
 * Atomically claim an ECS task for a session using a DynamoDB transaction.
 * Two operations run in a single transaction:
 *  1. Update the session record with the taskArn (only if not already claimed)
 *  2. Write a claim lock item (PK = TASK#<taskArn>) that prevents any other
 *     session from claiming the same task concurrently.
 *
 * If another session races to claim the same task, the transaction fails with
 * TransactionCanceledException — the caller retries with the next available task.
 */
export async function setTaskInfo(
  sessionId: string,
  taskArn: string,
  privateIp: string,
): Promise<void> {
  const now = Date.now();

  await client.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        {
          Update: {
            TableName: TABLE_NAME,
            Key: marshall({ sessionId }),
            UpdateExpression: 'SET taskArn = :taskArn, privateIp = :privateIp, #status = :status',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({
              ':taskArn': taskArn,
              ':privateIp': privateIp,
              ':status': 'ACTIVE',
              ':empty': '',
            }),
            ConditionExpression: 'attribute_not_exists(taskArn) OR taskArn = :empty',
          },
        },
        {
          Put: {
            TableName: TABLE_NAME,
            Item: marshall({
              sessionId: `TASK#${taskArn}`,
              claimedBySession: sessionId,
              claimedAt: now,
              expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
            }, { removeUndefinedValues: true }),
            ConditionExpression: 'attribute_not_exists(sessionId)',
          },
        },
      ],
    }),
  );
}

/**
 * Delete the claim lock for an ECS task, allowing it to be reclaimed.
 * Called when a session is stopped, deleted, or replaced.
 */
export async function deleteClaimLock(taskArn: string): Promise<void> {
  try {
    await client.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ sessionId: `TASK#${taskArn}` }),
      }),
    );
  } catch (err) {
    console.warn(`[sessions] Failed to delete claim lock for ${taskArn}:`, err);
  }
}

export async function getActiveSessionByUser(userId: string): Promise<Session | null> {
  const result = await client.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: 'byUserId',
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: '#status IN (:pending, :active)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({
        ':userId': userId,
        ':pending': 'PENDING',
        ':active': 'ACTIVE',
      }),
    }),
  );

  if (!result.Items || result.Items.length === 0) {
    return null;
  }

  return unmarshall(result.Items[0]) as Session;
}

/**
 * Return the set of ECS task ARNs currently claimed by ACTIVE or PENDING sessions.
 * Used by claimWarmTask to skip already-assigned containers.
 */
export async function getClaimedTaskArns(): Promise<Set<string>> {
  const arns = new Set<string>();

  for (const status of ['ACTIVE', 'PENDING']) {
    let exclusiveStartKey: Record<string, any> | undefined;

    do {
      const result = await client.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: 'byStatus',
          KeyConditionExpression: '#status = :status',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: marshall({ ':status': status }),
          ProjectionExpression: 'taskArn',
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      for (const item of result.Items ?? []) {
        const record = unmarshall(item);
        if (record.taskArn) {
          arns.add(record.taskArn);
        }
      }

      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  return arns;
}

/**
 * Sessions the cleanup cron should end: ACTIVE ones idle past the timeout, and
 * PENDING or STOPPING ones stuck there (a claim or a teardown that crashed part
 * way). Only scanning ACTIVE left those holding ALB rules and tasks forever.
 */
export async function getIdleSessions(): Promise<Session[]> {
  const now = Date.now();
  const sessions: Session[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression:
          '(#status = :active AND lastActivity < :idleCutoff) OR ' +
          '(#status IN (:pending, :stopping) AND lastActivity < :stuckCutoff)',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':active': 'ACTIVE',
          ':pending': 'PENDING',
          ':stopping': 'STOPPING',
          ':idleCutoff': now - IDLE_TIMEOUT_MS,
          ':stuckCutoff': now - STUCK_TIMEOUT_MS,
        }),
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      sessions.push(...result.Items.map((item) => unmarshall(item) as Session));
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return sessions;
}

/**
 * Whether a user may act on a session: its owner, or someone the owner invited.
 *
 * The session id is not a secret — it appears in preview URLs, WebSocket paths
 * and load-balancer logs — so access is gated on this membership record rather
 * than on knowing the id.
 */
export function isMember(session: Session, userId: string): boolean {
  if (session.userId === userId) {
    return true;
  }

  // Tolerate a non-array `members` rather than throwing: a malformed or
  // unexpected attribute shape must fail closed (access denied), never crash the
  // request into a 500 that callers cannot distinguish from a real outage.
  const members = session.members;
  return Array.isArray(members) && members.includes(userId);
}

/**
 * Whether anyone other than `userId` has been invited into this session.
 *
 * The distinction matters because `POST /session` retires the caller's existing
 * session, and a session with a guest in it is no longer the caller's alone to
 * throw away. Same defensive handling of a malformed `members` as
 * {@link isMember}: an unexpected shape reports "no other members", which costs
 * only the resume rather than crashing the request.
 */
export function hasOtherMembers(session: Session, userId: string): boolean {
  const members = session.members;

  return Array.isArray(members) && members.some((member) => member !== userId);
}

/**
 * Add a collaborator to a session, idempotently.
 *
 * Appends server-side via `list_append` rather than read-modify-write, so two
 * people redeeming invites at the same time cannot overwrite each other's
 * membership. A DynamoDB list (not a string set) is used because `unmarshall`
 * turns a set into a JS `Set`, which would break the plain-array shape the rest
 * of the code expects.
 */
export async function addMember(sessionId: string, userId: string): Promise<void> {
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ sessionId }),
        UpdateExpression: 'SET members = list_append(if_not_exists(members, :empty), :member)',
        // Re-adding an existing member is a no-op rather than a duplicate entry.
        ConditionExpression: 'attribute_exists(sessionId) AND NOT contains(members, :userId)',
        ExpressionAttributeValues: marshall({
          ':empty': [],
          ':member': [userId],
          ':userId': userId,
        }),
      }),
    );
  } catch (err) {
    // The condition also fails when the user is already a member, which is a
    // success from the caller's point of view.
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const session = await getSession(sessionId);
      if (session && isMember(session, userId)) {
        return;
      }
    }
    throw err;
  }
}

/**
 * How long an unredeemed invite link stays valid.
 *
 * Long enough for a link pasted into chat to be picked up the next day, short
 * enough that a link forwarded to the wrong place stops working on its own. The
 * membership it grants is not bounded by this: once redeemed, access lives on the
 * session and project records and lasts until the owner revokes it.
 */
export const INVITE_TTL_SECONDS = 72 * 60 * 60; // 72 hours

/**
 * DynamoDB key for an invite.
 *
 * The token is a bearer secret, so the table only ever holds its SHA-256. Anyone
 * who can read the table (a backup, an export, an over-broad IAM role) learns
 * nothing that lets them redeem a link. Because lookups are by hash, there is no
 * application-side comparison of the secret, and so nothing to time.
 */
export function inviteKey(token: string): string {
  return `INVITE#${createHash('sha256').update(token).digest('hex')}`;
}

/** Key used for invites minted before tokens were hashed. Read-only fallback. */
function legacyInviteKey(token: string): string {
  return `INVITE#${token}`;
}

/** A fresh invite token: 256 bits of randomness, URL-safe. */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Persist an invite under the hash of its token, with a TTL.
 *
 * `expiresAt` is both the table's TTL attribute (so DynamoDB eventually reaps the
 * item) and the authoritative expiry checked on every read and in the claim's
 * condition (because TTL deletion can lag by up to 48 hours).
 */
export async function createInvite(invite: Invite): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(
        {
          sessionId: inviteKey(invite.token),
          inviteSessionId: invite.sessionId,
          invitedBy: invite.invitedBy,
          role: invite.role,
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt,
          inviteProjectId: invite.projectId,
        },
        { removeUndefinedValues: true },
      ),
      ConditionExpression: 'attribute_not_exists(sessionId)',
    }),
  );
}

/**
 * The effective expiry of an invite record, in epoch seconds.
 *
 * Links minted while invites were briefly permanent carry no `expiresAt`; they
 * get the same lifetime as a new link, measured from when they were made, so no
 * link stays redeemable indefinitely.
 */
function effectiveExpiry(record: Record<string, unknown>): number {
  if (typeof record.expiresAt === 'number') {
    return record.expiresAt;
  }

  const createdAtMs = typeof record.createdAt === 'number' ? record.createdAt : 0;

  return Math.floor(createdAtMs / 1000) + INVITE_TTL_SECONDS;
}

/**
 * Look up an invite by token, whatever its state.
 *
 * Revocation needs this: a link that has expired may still have let someone in,
 * and revoking it has to find them. Redemption uses {@link getInvite}, which also
 * rejects expired and revoked links.
 */
export async function findInvite(token: string): Promise<Invite | null> {
  for (const key of [inviteKey(token), legacyInviteKey(token)]) {
    const result = await client.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ sessionId: key }),
      }),
    );

    if (!result.Item) {
      continue;
    }

    const record = unmarshall(result.Item) as Record<string, unknown>;

    return {
      token,
      recordKey: key,
      sessionId: record.inviteSessionId as string,
      invitedBy: record.invitedBy as string,
      role: record.role as Invite['role'],
      createdAt: record.createdAt as number,
      expiresAt: effectiveExpiry(record),
      redeemedBy: record.redeemedBy as string | undefined,
      revokedAt: record.revokedAt as number | undefined,
      projectId: record.inviteProjectId as string | undefined,
    };
  }

  return null;
}

/**
 * Look up a redeemable invite by token. Returns null when unknown, revoked or
 * expired — indistinguishably, so a token cannot be probed for its state.
 */
export async function getInvite(token: string): Promise<Invite | null> {
  const invite = await findInvite(token);

  if (!invite || invite.revokedAt !== undefined) {
    return null;
  }

  if (invite.expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return invite;
}

/**
 * Claim an invite for `userId`, so a link grants access to one person.
 *
 * The condition is what makes it safe rather than merely sequential: two people
 * opening the same link at once both read no redeemer, and only the write settles
 * which of them wins. It also re-checks revocation and expiry at write time, so a
 * revoke that lands between the read and the claim still wins. (Legacy records
 * have no stored expiry; theirs was enforced on read by {@link getInvite}.)
 *
 * Returns false when the link belongs to someone else, or has been revoked or has
 * expired since it was read. Re-claiming as the same user succeeds.
 */
export async function claimInvite(invite: Invite, userId: string): Promise<boolean> {
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ sessionId: invite.recordKey ?? inviteKey(invite.token) }),
        UpdateExpression: 'SET redeemedBy = :userId, redeemedAt = :now',
        ConditionExpression:
          'attribute_exists(sessionId) AND attribute_not_exists(revokedAt)' +
          ' AND (attribute_not_exists(expiresAt) OR expiresAt > :nowSeconds)' +
          ' AND (attribute_not_exists(redeemedBy) OR redeemedBy = :userId)',
        ExpressionAttributeValues: marshall({
          ':userId': userId,
          ':now': Date.now(),
          ':nowSeconds': Math.floor(Date.now() / 1000),
        }),
      }),
    );

    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw err;
  }
}

/**
 * Mark an invite revoked, so it can no longer be claimed.
 *
 * Done before any membership is removed: a guest racing the revoke with a fresh
 * join then fails the claim's `attribute_not_exists(revokedAt)` condition instead
 * of re-adding themselves after the removal.
 */
export async function markInviteRevoked(invite: Invite): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId: invite.recordKey ?? inviteKey(invite.token) }),
      UpdateExpression: 'SET revokedAt = :now',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: marshall({ ':now': Date.now() }),
    }),
  );
}

/**
 * Delete an invite record outright, once any access it granted has been removed.
 */
export async function deleteInvite(invite: Invite): Promise<void> {
  await client.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId: invite.recordKey ?? inviteKey(invite.token) }),
    }),
  );
}

/**
 * Remove a collaborator from a session.
 *
 * `isMember` reads the session record on every request, and every signed URL is
 * issued only after that check, so once this lands the user can no longer obtain
 * a URL to connect with.
 *
 * Written as a conditional replace of the whole list, guarded on the list being
 * what was read, so a concurrent join is never silently overwritten; on a lost
 * race it re-reads and tries again.
 */
export async function removeMember(sessionId: string, userId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const session = await getSession(sessionId);
    const members = session && Array.isArray(session.members) ? session.members : [];

    if (!members.includes(userId)) {
      return;
    }

    try {
      await client.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall({ sessionId }),
          UpdateExpression: 'SET members = :next',
          ConditionExpression: 'members = :prev',
          ExpressionAttributeValues: marshall({
            ':next': members.filter((member) => member !== userId),
            ':prev': members,
          }),
        }),
      );

      return;
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        throw err;
      }
    }
  }

  throw new Error(`Could not remove a member from session ${sessionId}: membership kept changing`);
}

/**
 * Who owns a project, or null if it does not exist.
 *
 * An invite may only carry a project its minter owns, and this is the check. It
 * reads the projects table directly, the same way {@link addProjectMember} writes
 * it, because the session manager is not a caller of the projects API.
 */
export async function getProjectOwner(projectId: string): Promise<string | null> {
  if (!PROJECTS_TABLE_NAME) {
    return null;
  }

  const result = await client.send(
    new GetItemCommand({
      TableName: PROJECTS_TABLE_NAME,
      Key: marshall({ projectId, sk: 'META' }),
    }),
  );

  if (!result.Item) {
    return null;
  }

  const ownerId = (unmarshall(result.Item) as { ownerId?: unknown }).ownerId;

  return typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : null;
}

/**
 * Grant a user access to a project's conversation.
 *
 * Writes to the projects table rather than calling its API, because this runs while
 * redeeming an invite — the caller is the guest, and the projects API only lets an
 * owner add members. The caller must already have checked that the invite's minter
 * owns both the session and this project ({@link getProjectOwner}).
 *
 * Idempotent, so re-joining a session is harmless.
 */
export async function addProjectMember(projectId: string, userId: string): Promise<void> {
  if (!PROJECTS_TABLE_NAME) {
    return;
  }

  await client.send(
    new PutItemCommand({
      TableName: PROJECTS_TABLE_NAME,
      Item: marshall({
        projectId,
        sk: `MEMBER#${userId}`,
        userId,
        role: 'editor',
        addedAt: Date.now(),
      }),
    }),
  );
}

/** Take a user's access to a project's conversation away. Idempotent. */
export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  if (!PROJECTS_TABLE_NAME) {
    return;
  }

  await client.send(
    new DeleteItemCommand({
      TableName: PROJECTS_TABLE_NAME,
      Key: marshall({ projectId, sk: `MEMBER#${userId}` }),
    }),
  );
}

export function newInviteRecord(
  sessionId: string,
  invitedBy: string,
  projectId?: string,
): Invite {
  const now = Date.now();

  return {
    token: newInviteToken(),
    sessionId,
    invitedBy,
    role: 'editor',
    createdAt: now,
    expiresAt: Math.floor(now / 1000) + INVITE_TTL_SECONDS,
    projectId,
  };
}

export function newSessionRecord(userId: string): Session {
  const now = Date.now();

  return {
    sessionId: crypto.randomUUID(),
    userId,
    taskArn: '',
    privateIp: '',
    status: 'PENDING',
    createdAt: now,
    lastActivity: now,
    expiresAt: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
}

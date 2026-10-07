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
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { Invite, Session } from './types';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.SESSIONS_TABLE_NAME!;
// Redeeming an invite grants the inviter's project as well as their sandbox, which
// means writing one item into the projects table.
const PROJECTS_TABLE_NAME = process.env.PROJECTS_TABLE_NAME ?? '';
const SESSION_TTL_SECONDS = 2 * 60 * 60; // 2 hours
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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

export async function updateSessionStatus(
  sessionId: string,
  status: Session['status'],
): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId }),
      UpdateExpression: 'SET #status = :status',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: marshall({ ':status': status }),
    }),
  );
}

export async function updateLastActivity(sessionId: string): Promise<void> {
  const now = Date.now();

  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId }),
      UpdateExpression: 'SET lastActivity = :lastActivity',
      ExpressionAttributeValues: marshall({ ':lastActivity': now }),
    }),
  );
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
 * Record the container a session is actually being served by.
 *
 * Distinct from {@link setTaskInfo}, which records the *claim*: claiming reserves
 * a warm task in DynamoDB but never tells that container about it, so the box that
 * answers the first connection can be a different one. This overwrites the address
 * with the observed truth, and is deliberately unconditional — unlike the claim,
 * which must not be stolen.
 */
export async function setBoundContainer(sessionId: string, privateIp: string): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId }),
      UpdateExpression: 'SET privateIp = :privateIp',
      ConditionExpression: 'attribute_exists(sessionId)',
      ExpressionAttributeValues: marshall({ ':privateIp': privateIp }),
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

export async function getIdleSessions(): Promise<Session[]> {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  const sessions: Session[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: '#status = :active AND lastActivity < :cutoff',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: marshall({
          ':active': 'ACTIVE',
          ':cutoff': cutoff,
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
 * Persist an invite.
 *
 * Deliberately written with no `expiresAt`. That attribute is the sessions
 * table's TTL key, and DynamoDB only reaps items that carry it — so its absence,
 * rather than a distant future value, is what makes an invite permanent. An
 * invited collaborator is meant to be a member the way they are in a shared
 * document, so the link that grants that membership must not lapse underneath
 * them. What replaces the expiry is {@link claimInvite} (one redeemer per link)
 * and {@link deleteInvite} (the owner can revoke one).
 */
export async function createInvite(invite: Invite): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(
        {
          sessionId: `INVITE#${invite.token}`,
          inviteSessionId: invite.sessionId,
          invitedBy: invite.invitedBy,
          role: invite.role,
          createdAt: invite.createdAt,
          inviteProjectId: invite.projectId,
        },
        { removeUndefinedValues: true },
      ),
      ConditionExpression: 'attribute_not_exists(sessionId)',
    }),
  );
}

/**
 * Look up an invite by token. Returns null when unknown, revoked, or expired.
 *
 * Newly minted invites carry no expiry at all. The check below is kept for the
 * links minted before that changed: they still have an `expiresAt`, and DynamoDB
 * TTL deletion can lag by up to 48 hours, so an old link has to be re-checked
 * here rather than trusted to have been removed.
 */
export async function getInvite(token: string): Promise<Invite | null> {
  const result = await client.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId: `INVITE#${token}` }),
    }),
  );

  if (!result.Item) {
    return null;
  }

  const record = unmarshall(result.Item) as Record<string, unknown>;
  const invite: Invite = {
    token,
    sessionId: record.inviteSessionId as string,
    invitedBy: record.invitedBy as string,
    role: record.role as Invite['role'],
    createdAt: record.createdAt as number,
    expiresAt: record.expiresAt as number | undefined,
    redeemedBy: record.redeemedBy as string | undefined,
    projectId: record.inviteProjectId as string | undefined,
  };

  if (invite.expiresAt !== undefined && invite.expiresAt <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return invite;
}

/**
 * Claim an invite for `userId`, so a link grants access to one person.
 *
 * A permanent link that anyone could redeem would be a standing invitation to
 * whoever it was forwarded to, which is the risk the old 30-minute expiry was
 * covering. Recording the redeemer replaces that with a stronger property: the
 * link is spent once someone accepts it, whenever that happens.
 *
 * The condition is what makes it safe rather than merely sequential — two people
 * opening the same link at the same moment both read no redeemer, and only the
 * write settles which of them wins.
 *
 * Returns false when the link already belongs to someone else. Re-claiming it as
 * the same user succeeds, which is what lets that user's browser redeem the
 * token again after a reload.
 */
export async function claimInvite(token: string, userId: string): Promise<boolean> {
  try {
    await client.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshall({ sessionId: `INVITE#${token}` }),
        UpdateExpression: 'SET redeemedBy = :userId, redeemedAt = :now',
        ConditionExpression:
          'attribute_exists(sessionId) AND (attribute_not_exists(redeemedBy) OR redeemedBy = :userId)',
        ExpressionAttributeValues: marshall({ ':userId': userId, ':now': Date.now() }),
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
 * Grant a user access to a project's conversation.
 *
 * Writes to the projects table rather than calling its API, because this runs while
 * redeeming an invite — the caller is the guest, and the projects API only lets an
 * owner add members. The authorisation has already happened here: a valid,
 * unexpired invite from the project's owner is what earns the access.
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

/**
 * Revoke an invite so the link stops working.
 *
 * A hard delete is right in this direction: the item is only the grant of access,
 * not the access itself. Deleting an unredeemed invite simply makes the link
 * unknown, and deleting a redeemed one costs the guest nothing — their membership
 * lives on the session and project records by then, and is revoked there.
 */
export async function deleteInvite(token: string): Promise<void> {
  await client.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ sessionId: `INVITE#${token}` }),
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
    token: crypto.randomUUID(),
    sessionId,
    invitedBy,
    role: 'editor',
    createdAt: now,
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

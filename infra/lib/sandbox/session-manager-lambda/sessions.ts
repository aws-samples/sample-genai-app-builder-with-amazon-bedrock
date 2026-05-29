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
import type { Session } from './types';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.SESSIONS_TABLE_NAME!;
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

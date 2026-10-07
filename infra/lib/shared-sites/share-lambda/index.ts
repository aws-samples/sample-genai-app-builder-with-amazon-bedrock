import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { randomUUID } from 'crypto';
import { generateUploadUrls, deleteShareFiles } from './s3-uploader';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const TABLE = process.env.SHARES_TABLE_NAME!;
const CONFIGURED_DOMAIN = process.env.SHARED_SITES_DOMAIN || '';
const CF_DOMAIN_PARAM = process.env.CLOUDFRONT_DOMAIN_PARAM || '';

let cachedDomain: string | null = null;

async function getDomain(): Promise<string> {
  if (cachedDomain) return cachedDomain;
  if (CONFIGURED_DOMAIN) {
    cachedDomain = CONFIGURED_DOMAIN;
    return cachedDomain;
  }
  if (CF_DOMAIN_PARAM) {
    const result = await ssm.send(new GetParameterCommand({ Name: CF_DOMAIN_PARAM }));
    cachedDomain = `https://${result.Parameter?.Value}`;
    return cachedDomain;
  }
  return '';
}

function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
    body: JSON.stringify(body),
  };
}

/** How long a share id reserved by `create` waits for its `confirm`. */
const RESERVATION_TTL_SECONDS = 60 * 60;
/** How long a confirmed share stays published. */
const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_FILES = 2000;
const MAX_PATH_LENGTH = 1024;

/**
 * The caller's identity, or null when the authorizer supplied none.
 *
 * There is deliberately no fallback identity: a shared placeholder such as
 * 'unknown' would make every unauthenticated caller the owner of every share
 * filed under it.
 */
function getUserId(event: APIGatewayProxyEvent): string | null {
  const authorizer = event.requestContext?.authorizer as Record<string, any> | undefined | null;
  const userId = authorizer?.claims?.sub ?? authorizer?.userId ?? authorizer?.principalId;

  return typeof userId === 'string' && userId.length > 0 ? userId : null;
}

function isConditionalFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/**
 * Whether an uploaded file path stays inside its share's prefix.
 *
 * S3 keys are opaque, but the paths are served back through URLs, where `..`
 * and `\` are normalised; refusing them keeps one share's upload from ever
 * addressing another share's files.
 */
function isSafeSitePath(file: unknown): file is string {
  if (typeof file !== 'string' || file.length === 0 || file.length > MAX_PATH_LENGTH) {
    return false;
  }

  if (file.includes('\\') || file.includes('\0')) {
    return false;
  }

  return file
    .replace(/^\/+/, '')
    .split('/')
    .every((segment) => segment !== '..' && segment !== '.');
}

async function handleCreate(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');

  if (body.action === 'confirm') {
    return handleConfirm(event, userId);
  }

  const { files } = body as { title: string; files: unknown };

  if (!files || !Array.isArray(files) || files.length === 0) {
    return response(400, { error: 'Missing required field: files' });
  }

  if (files.length > MAX_FILES || !files.every(isSafeSitePath)) {
    return response(400, { error: 'Invalid file paths' });
  }

  const shareId = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Reserve the id for this caller before handing out any upload URL. `confirm`
  // only succeeds against a reservation the caller owns, which is what stops
  // anyone confirming — and so taking over — a share id that is not theirs.
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      shareId,
      userId,
      status: 'pending',
      createdAt: now,
      expiresAt: now + RESERVATION_TTL_SECONDS,
      s3Prefix: `shared/${shareId}/`,
    },
    ConditionExpression: 'attribute_not_exists(shareId)',
  }));

  const uploadUrls = await generateUploadUrls(shareId, files);

  return response(200, { shareId, uploadUrls: uploadUrls.map((u) => u.url), fileMap: uploadUrls });
}

async function handleConfirm(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');
  const { shareId, title } = body as { shareId: unknown; title: unknown };

  if (typeof shareId !== 'string' || shareId.length === 0) {
    return response(400, { error: 'Missing required field: shareId' });
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    // Conditional on the record existing and belonging to the caller, evaluated
    // by DynamoDB at write time, so neither a guessed id nor a race can overwrite
    // somebody else's share.
    await ddb.send(new PutCommand({
      TableName: TABLE,
      Item: {
        shareId,
        userId,
        status: 'active',
        title: typeof title === 'string' && title.length > 0 ? title.slice(0, 200) : 'Untitled',
        createdAt: now,
        expiresAt: now + SHARE_TTL_SECONDS,
        s3Prefix: `shared/${shareId}/`,
      },
      ConditionExpression: 'attribute_exists(shareId) AND userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    }));
  } catch (err) {
    if (isConditionalFailure(err)) {
      // Unknown and someone-else's are answered alike, so ids cannot be probed.
      return response(404, { error: 'Share not found' });
    }
    throw err;
  }

  const domain = await getDomain();
  return response(200, { url: `${domain}/shared/${shareId}/` });
}

async function handleList(userId: string): Promise<APIGatewayProxyResult> {
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'byUserId',
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }));

  const domain = await getDomain();
  // Reservations that were never confirmed are not published sites.
  const shares = (result.Items || []).filter((item) => item.status !== 'pending').map((item) => ({
    shareId: item.shareId,
    title: item.title,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    url: `${domain}/shared/${item.shareId}/`,
  }));

  return response(200, { shares });
}

async function handleDelete(event: APIGatewayProxyEvent, userId: string): Promise<APIGatewayProxyResult> {
  const shareId = event.pathParameters?.id;

  if (!shareId) {
    return response(400, { error: 'Missing share ID' });
  }

  const getResult = await ddb.send(new GetCommand({ TableName: TABLE, Key: { shareId } }));

  if (!getResult.Item) {
    return response(404, { error: 'Share not found' });
  }

  if (getResult.Item.userId !== userId) {
    return response(403, { error: 'Not authorized to delete this share' });
  }

  // The prefix is derived from the id rather than read from the record, so a
  // record can never point a delete at another share's files.
  await deleteShareFiles(`shared/${shareId}/`);

  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { shareId },
      ConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
    }));
  } catch (err) {
    if (isConditionalFailure(err)) {
      return response(404, { error: 'Share not found' });
    }
    throw err;
  }

  return response(200, { deleted: true });
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getUserId(event);

    if (!userId) {
      return response(401, { error: 'Authentication required' });
    }

    switch (event.httpMethod) {
      case 'POST':
        return await handleCreate(event, userId);
      case 'GET':
        return await handleList(userId);
      case 'DELETE':
        return await handleDelete(event, userId);
      default:
        return response(405, { error: `Method not allowed: ${event.httpMethod}` });
    }
  } catch (err) {
    console.error('Share Lambda error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

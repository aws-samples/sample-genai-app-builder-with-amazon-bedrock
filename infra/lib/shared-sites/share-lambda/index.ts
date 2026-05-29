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

function getUserId(event: APIGatewayProxyEvent): string {
  return event.requestContext?.authorizer?.claims?.sub
    ?? (event.requestContext?.authorizer as any)?.userId
    ?? 'unknown';
}

async function handleCreate(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = JSON.parse(event.body || '{}');

  if (body.action === 'confirm') {
    return handleConfirm(event);
  }

  const { title, files } = body as { title: string; files: string[] };

  if (!files || !Array.isArray(files) || files.length === 0) {
    return response(400, { error: 'Missing required field: files' });
  }

  const shareId = randomUUID();
  const uploadUrls = await generateUploadUrls(shareId, files);

  return response(200, { shareId, uploadUrls: uploadUrls.map((u) => u.url), fileMap: uploadUrls });
}

async function handleConfirm(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  const body = JSON.parse(event.body || '{}');
  const { shareId, title } = body as { shareId: string; title: string };

  if (!shareId) {
    return response(400, { error: 'Missing required field: shareId' });
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 30 * 24 * 60 * 60;

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      shareId,
      userId,
      title: title || 'Untitled',
      createdAt: now,
      expiresAt,
      s3Prefix: `shared/${shareId}/`,
    },
  }));

  const domain = await getDomain();
  return response(200, { url: `${domain}/shared/${shareId}/` });
}

async function handleList(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE,
    IndexName: 'byUserId',
    KeyConditionExpression: 'userId = :uid',
    ExpressionAttributeValues: { ':uid': userId },
  }));

  const domain = await getDomain();
  const shares = (result.Items || []).map((item) => ({
    shareId: item.shareId,
    title: item.title,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    url: `${domain}/shared/${item.shareId}/`,
  }));

  return response(200, { shares });
}

async function handleDelete(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
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

  await deleteShareFiles(getResult.Item.s3Prefix);
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { shareId } }));

  return response(200, { deleted: true });
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    switch (event.httpMethod) {
      case 'POST':
        return handleCreate(event);
      case 'GET':
        return handleList(event);
      case 'DELETE':
        return handleDelete(event);
      default:
        return response(405, { error: `Method not allowed: ${event.httpMethod}` });
    }
  } catch (err) {
    console.error('Share Lambda error:', err);
    return response(500, { error: 'Internal server error' });
  }
}

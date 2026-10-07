import type { APIGatewayProxyEvent } from 'aws-lambda';

const mockDdbSend = jest.fn();
const mockS3Send = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({ send: mockDdbSend })),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  PutCommand: jest.fn((input: any) => ({ input, _type: 'PutCommand' })),
  QueryCommand: jest.fn((input: any) => ({ input, _type: 'QueryCommand' })),
  DeleteCommand: jest.fn((input: any) => ({ input, _type: 'DeleteCommand' })),
  GetCommand: jest.fn((input: any) => ({ input, _type: 'GetCommand' })),
}));

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn(),
  DeleteObjectsCommand: jest.fn(),
  ListObjectsV2Command: jest.fn(),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.presigned.url/test'),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn(() => ({ send: jest.fn() })),
  GetParameterCommand: jest.fn(),
}));

process.env.SHARES_TABLE_NAME = 'test-shared-sites-v1';
process.env.SHARED_SITES_BUCKET = 'test-shared-sites-bucket';
process.env.SHARED_SITES_DOMAIN = 'https://vibe.proserve.aws.dev';

// Import after mocks are set up
import { handler } from '../../lib/shared-sites/share-lambda/index';
import { PutObjectCommand } from '@aws-sdk/client-s3';

function makeEvent(method: string, path: string, body?: Record<string, unknown>, userId = 'test-user'): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    pathParameters: path.includes('/share/') ? { id: path.split('/share/')[1] } : null,
    body: body ? JSON.stringify(body) : null,
    requestContext: {
      authorizer: { claims: { sub: userId, email: 'test@amazon.com' } },
    } as any,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    stageVariables: null,
    resource: '',
  } as APIGatewayProxyEvent;
}

describe('Share Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('POST /share creates share and returns pre-signed URLs', async () => {
    const event = makeEvent('POST', '/share', {
      title: 'My Website',
      files: ['index.html', 'assets/main.js', 'assets/style.css'],
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.shareId).toBeDefined();
    expect(body.uploadUrls).toHaveLength(3);
    expect(body.fileMap).toHaveLength(3);
  });

  test('POST /share fileMap tells the client what Content-Type to upload with', async () => {
    // The presigned URL alone is not enough: a browser PUT with a Uint8Array
    // body sends no Content-Type header, so S3 stores binary/octet-stream and
    // the shared page downloads instead of rendering. The client must echo the
    // type the Lambda signed, so it has to be in the response.
    const event = makeEvent('POST', '/share', {
      title: 'My Website',
      files: ['index.html', 'assets/main.js', 'assets/style.css'],
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(body.fileMap.map((f: { file: string; contentType: string }) => f.contentType)).toEqual([
      'text/html',
      'application/javascript',
      'text/css',
    ]);
  });

  test('POST /share rejects missing files', async () => {
    const event = makeEvent('POST', '/share', { title: 'test' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
  });

  test('strips the dist/ build prefix so the site serves from the share root', async () => {
    const event = makeEvent('POST', '/share', {
      title: 'My Website',
      files: ['dist/index.html', 'dist/assets/main.js'],
    });

    await handler(event);

    // the S3 key must not carry the dist/ prefix, or the published link 403s;
    // the client-facing fileMap still uses the original path for upload matching
    const keys = (PutObjectCommand as unknown as jest.Mock).mock.calls.map((c) => c[0].Key);
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/index\.html$/),
        expect.stringMatching(/\/assets\/main\.js$/),
      ]),
    );
    expect(keys.some((k: string) => k.includes('/dist/'))).toBe(false);
  });

  test('POST /share with action=confirm writes DynamoDB and returns URL', async () => {
    mockDdbSend.mockResolvedValueOnce({});

    const event = makeEvent('POST', '/share', {
      action: 'confirm',
      shareId: 'test-share-id',
      title: 'My Website',
    });

    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.url).toBe('https://vibe.proserve.aws.dev/shared/test-share-id/');
    expect(mockDdbSend).toHaveBeenCalled();
  });

  test('GET /share lists user shares', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Items: [
        { shareId: 'share-1', title: 'Site 1', createdAt: 1000, expiresAt: 2000 },
        { shareId: 'share-2', title: 'Site 2', createdAt: 3000, expiresAt: 4000 },
      ],
    });

    const event = makeEvent('GET', '/share');
    const result = await handler(event);
    const body = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(body.shares).toHaveLength(2);
    expect(body.shares[0].url).toContain('/shared/share-1/');
  });

  test('DELETE /share/{id} removes share when owner', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { shareId: 'share-1', userId: 'test-user', s3Prefix: 'shared/share-1/' } });
    mockS3Send.mockResolvedValueOnce({ Contents: [{ Key: 'shared/share-1/index.html' }] });
    mockS3Send.mockResolvedValueOnce({});
    mockDdbSend.mockResolvedValueOnce({});

    const event = makeEvent('DELETE', '/share/share-1');
    const result = await handler(event);
    expect(result.statusCode).toBe(200);
  });

  test('DELETE /share/{id} rejects non-owner', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { shareId: 'share-1', userId: 'other-user', s3Prefix: 'shared/share-1/' } });

    const event = makeEvent('DELETE', '/share/share-1');
    const result = await handler(event);
    expect(result.statusCode).toBe(403);
  });

  test('rejects unknown methods', async () => {
    const event = makeEvent('PATCH', '/share');
    const result = await handler(event);
    expect(result.statusCode).toBe(405);
  });
});

/**
 * Sev2 security review: a caller must not be able to claim, overwrite or delete
 * a shared site that belongs to someone else.
 */
describe('Share Lambda — Sev2 ownership', () => {
  const conditionalFailure = () => Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
  });

  /**
   * In-memory shares table that evaluates the ownership conditions the way
   * DynamoDB would, so a test fails if the write is unconditional.
   */
  function table(initial: Record<string, any> = {}) {
    const items: Record<string, any> = { ...initial };
    const writes: any[] = [];

    mockDdbSend.mockImplementation(async (cmd: any) => {
      const { input, _type } = cmd;
      const id = input.Key?.shareId ?? input.Item?.shareId;
      const existing = items[id];
      const values = input.ExpressionAttributeValues ?? {};
      const condition: string = input.ConditionExpression ?? '';

      const conditionHolds = () => {
        if (condition.includes('attribute_not_exists(shareId)') && existing) return false;
        if (condition.includes('attribute_exists(shareId)') && !existing) return false;
        if (condition.includes('userId = :uid') && existing?.userId !== values[':uid']) return false;
        return true;
      };

      if (_type === 'GetCommand') return { Item: existing };
      if (_type === 'QueryCommand') {
        return { Items: Object.values(items).filter((i: any) => i.userId === values[':uid']) };
      }

      if (_type === 'PutCommand' || _type === 'DeleteCommand') {
        if (!conditionHolds()) throw conditionalFailure();
        writes.push(cmd);
        if (_type === 'PutCommand') items[id] = input.Item;
        else delete items[id];
        return {};
      }
      return {};
    });

    return { items, writes };
  }

  const victimShare = {
    shareId: 'victim-share',
    userId: 'victim',
    title: 'Victim site',
    s3Prefix: 'shared/victim-share/',
    status: 'active',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('confirm cannot claim a share id that belongs to another user', async () => {
    const db = table({ 'victim-share': victimShare });

    const result = await handler(
      makeEvent('POST', '/share', { action: 'confirm', shareId: 'victim-share', title: 'pwned' }, 'attacker'),
    );

    expect([403, 404]).toContain(result.statusCode);
    expect(db.items['victim-share']).toEqual(victimShare);
  });

  test('confirm cannot claim a share id nobody reserved', async () => {
    const db = table();

    const result = await handler(
      makeEvent('POST', '/share', { action: 'confirm', shareId: 'made-up', title: 'x' }, 'attacker'),
    );

    expect([403, 404]).toContain(result.statusCode);
    expect(db.items['made-up']).toBeUndefined();
  });

  test('create reserves the new share id for the caller, conditionally', async () => {
    const db = table();

    const result = await handler(makeEvent('POST', '/share', { title: 't', files: ['index.html'] }, 'alice'));
    const { shareId } = JSON.parse(result.body);

    expect(result.statusCode).toBe(200);
    expect(db.items[shareId]?.userId).toBe('alice');
    const put = db.writes.find((w) => w._type === 'PutCommand');
    expect(put.input.ConditionExpression).toContain('attribute_not_exists(shareId)');
  });

  test('the owner can confirm the share they reserved', async () => {
    const db = table();

    const created = await handler(makeEvent('POST', '/share', { title: 't', files: ['index.html'] }, 'alice'));
    const { shareId } = JSON.parse(created.body);
    const confirmed = await handler(makeEvent('POST', '/share', { action: 'confirm', shareId, title: 'Mine' }, 'alice'));

    expect(confirmed.statusCode).toBe(200);
    expect(db.items[shareId]).toMatchObject({ userId: 'alice', title: 'Mine', status: 'active' });
  });

  test('another user cannot confirm a share reserved by someone else', async () => {
    const db = table();

    const created = await handler(makeEvent('POST', '/share', { title: 't', files: ['index.html'] }, 'alice'));
    const { shareId } = JSON.parse(created.body);
    const result = await handler(makeEvent('POST', '/share', { action: 'confirm', shareId, title: 'x' }, 'mallory'));

    expect([403, 404]).toContain(result.statusCode);
    expect(db.items[shareId].userId).toBe('alice');
  });

  test('delete by a non-owner changes nothing in DynamoDB or S3', async () => {
    const db = table({ 'victim-share': victimShare });

    const result = await handler(makeEvent('DELETE', '/share/victim-share', undefined, 'attacker'));

    expect(result.statusCode).toBe(403);
    expect(db.items['victim-share']).toEqual(victimShare);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  test('the record delete is itself conditional on ownership', async () => {
    const db = table({ 'mine': { ...victimShare, shareId: 'mine', userId: 'alice', s3Prefix: 'shared/mine/' } });
    mockS3Send.mockResolvedValueOnce({ Contents: [] });

    const result = await handler(makeEvent('DELETE', '/share/mine', undefined, 'alice'));

    expect(result.statusCode).toBe(200);
    const del = db.writes.find((w) => w._type === 'DeleteCommand');
    expect(del.input.ConditionExpression).toContain('userId = :uid');
  });

  test('a request with no authenticated identity is refused, not filed under a shared "unknown" user', async () => {
    const db = table({ 'unknown-share': { ...victimShare, shareId: 'unknown-share', userId: 'unknown' } });
    const event = makeEvent('DELETE', '/share/unknown-share');
    (event.requestContext as any).authorizer = {};

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(db.items['unknown-share']).toBeDefined();
  });

  test('upload paths cannot escape the share prefix', async () => {
    table();

    const result = await handler(
      makeEvent('POST', '/share', { title: 't', files: ['../victim-share/index.html'] }, 'attacker'),
    );

    expect(result.statusCode).toBe(400);
    expect(PutObjectCommand as unknown as jest.Mock).not.toHaveBeenCalled();
  });
});

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
process.env.SHARED_SITES_DOMAIN = 'https://app.example.com';

// Import after mocks are set up
import { handler } from '../../lib/shared-sites/share-lambda/index';

function makeEvent(method: string, path: string, body?: Record<string, unknown>, userId = 'test-user'): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    pathParameters: path.includes('/share/') ? { id: path.split('/share/')[1] } : null,
    body: body ? JSON.stringify(body) : null,
    requestContext: {
      authorizer: { claims: { sub: userId, email: 'test@example.com' } },
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

  test('POST /share rejects missing files', async () => {
    const event = makeEvent('POST', '/share', { title: 'test' });
    const result = await handler(event);
    expect(result.statusCode).toBe(400);
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
    expect(body.url).toBe('https://app.example.com/shared/test-share-id/');
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

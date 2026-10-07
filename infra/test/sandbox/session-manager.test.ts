import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
/**
 * Tests for the Session Manager Lambda handler.
 * Uses mocked AWS SDK clients.
 */

// Mock AWS SDK before imports
const mockDynamoSend = jest.fn();
const mockEcsSend = jest.fn();
const mockCwSend = jest.fn().mockResolvedValue({});

jest.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({
      send: mockDynamoSend,
    })),
    PutItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'PutItem' })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'GetItem' })),
    UpdateItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'UpdateItem' })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'Query' })),
    ScanCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'Scan' })),
    TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'TransactWriteItems' })),
    DeleteItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DeleteItem' })),
  };
});

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((obj) => {
    // Simple mock: wrap values for DynamoDB format
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') result[key] = { S: value };
      else if (typeof value === 'number') result[key] = { N: String(value) };
      else result[key] = { S: JSON.stringify(value) };
    }
    return result;
  }),
  unmarshall: jest.fn((item) => {
    // Simple mock: unwrap DynamoDB format
    const result: any = {};
    for (const [key, value] of Object.entries(item as any)) {
      const val = value as any;
      if (val.S) result[key] = val.S;
      else if (val.N) result[key] = Number(val.N);
      // Lists unwrap to plain arrays, as the real unmarshall does — the session
      // `members` attribute relies on this.
      else if (val.L) result[key] = val.L.map((entry: any) => entry.S ?? entry.N ?? entry);
      else result[key] = val;
    }
    return result;
  }),
}));

// The session manager fetches the CloudFront signing key from Secrets Manager
// and signs every wsUrl it returns.
const mockSigningKey = generateKeyPairSync('rsa', { modulusLength: 2048 });

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      SecretString: mockSigningKey.privateKey.export({ type: 'pkcs1', format: 'pem' }),
    }),
  })),
  GetSecretValueCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'GetSecretValue' })),
}));

jest.mock('@aws-sdk/client-ecs', () => {
  return {
    ECSClient: jest.fn().mockImplementation(() => ({
      send: mockEcsSend,
    })),
    ListTasksCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'ListTasks' })),
    DescribeTasksCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DescribeTasks' })),
    StopTaskCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'StopTask' })),
    UpdateServiceCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'UpdateService' })),
  };
});

jest.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: jest.fn().mockImplementation(() => ({
    send: mockCwSend,
  })),
  PutMetricDataCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'PutMetricData' })),
}), { virtual: true });

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Parameter: { Value: '' } }),
  })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'GetParameter' })),
}), { virtual: true });

// Set env vars before importing handler
process.env.SESSIONS_TABLE_NAME = 'test-sessions-table';
process.env.ECS_CLUSTER_ARN = 'arn:aws:ecs:us-west-2:123456789:cluster/test-cluster';
process.env.ECS_SERVICE_NAME = 'test-warm-pool';
process.env.PREVIEW_DOMAIN = 'preview.vibe.test.dev';
process.env.WS_SIGNING_KEY_SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:123:secret:test-signing-key';
process.env.WS_SIGNING_KEY_PAIR_ID = 'K2TESTKEYPAIR';
// Joining grants the inviter's project, which writes to the projects table.
process.env.PROJECTS_TABLE_NAME = 'test-projects';

import { handler } from '../../lib/sandbox/session-manager-lambda/index';

/**
 * Check a returned wsUrl the way CloudFront would: the custom policy is signed
 * with the trusted key, covers only this session's path and has not expired.
 */
function expectCloudFrontSigned(wsUrl: string, sessionId: string): void {
  const url = new URL(wsUrl.replace(/^wss:/, 'https:'));
  const decode = (value: string) =>
    Buffer.from(value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');

  expect(wsUrl.startsWith('wss://')).toBe(true);
  expect(url.pathname).toBe(`/ws/${sessionId}`);
  expect(url.searchParams.get('Key-Pair-Id')).toBe('K2TESTKEYPAIR');

  const policy = decode(url.searchParams.get('Policy')!);
  const signature = decode(url.searchParams.get('Signature')!);

  expect(cryptoVerify('RSA-SHA1', policy, mockSigningKey.publicKey, signature)).toBe(true);

  const statement = JSON.parse(policy.toString('utf-8')).Statement[0];
  expect(statement.Resource).toBe(`https://${url.host}/ws/${sessionId}*`);
  expect(statement.Condition.DateLessThan['AWS:EpochTime']).toBeGreaterThan(Date.now() / 1000);
}

// Helper to build API Gateway events
function apiEvent(
  method: string,
  path: string,
  body?: any,
  pathParams?: Record<string, string>,
  userId: string = 'user-123',
) {
  return {
    httpMethod: method,
    path,
    pathParameters: pathParams || null,
    body: body ? JSON.stringify(body) : null,
    headers: {},
    queryStringParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      authorizer: {
        claims: {
          sub: userId,
        },
      },
    } as any,
    resource: '',
  };
}

// Helper for unauthenticated events (no authorizer claims)
function unauthEvent(method: string, path: string, body?: any) {
  return {
    httpMethod: method,
    path,
    pathParameters: null,
    body: body ? JSON.stringify(body) : null,
    headers: {},
    queryStringParameters: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {} as any,
    resource: '',
  };
}

describe('Session Manager Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /session — create session', () => {
    it('should create a new session and return connection info', async () => {
      // Mock: no existing session for this user
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Query') {
          return { Items: [] };
        }
        if (cmd._type === 'PutItem') {
          return {};
        }
        if (cmd._type === 'UpdateItem') {
          return {};
        }
        if (cmd._type === 'TransactWriteItems') {
          return {};
        }
        if (cmd._type === 'DeleteItem') {
          return {};
        }
        return {};
      });

      // Mock: warm task available
      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'ListTasks') {
          return { taskArns: ['arn:aws:ecs:us-west-2:123:task/test-cluster/task-1'] };
        }
        if (cmd._type === 'DescribeTasks') {
          return {
            tasks: [
              {
                taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1',
                containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.50' }] }],
                overrides: { containerOverrides: [{ environment: [{ name: 'SESSION_ID', value: '' }] }] },
                attachments: [
                  {
                    type: 'ElasticNetworkInterface',
                    details: [{ name: 'privateIPv4Address', value: '10.10.1.50' }],
                  },
                ],
              },
            ],
          };
        }
        return {};
      });

      const event = apiEvent('POST', '/session', { userId: 'user-123' });
      const result = await handler(event);

      expect(result).toBeDefined();
      const body = JSON.parse((result as any).body);
      expect((result as any).statusCode).toBe(201);
      expect(body.sessionId).toBeDefined();
      expect(body.wsUrl).toContain('vibe.test.dev');
      expect(body.previewDomain).toContain('preview.vibe.test.dev');
    });

    it('should stop existing session before creating new one', async () => {
      let stopCalled = false;
      let updateCalls: string[] = [];

      // Mock: existing active session
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Query') {
          return {
            Items: [
              {
                sessionId: { S: 'old-session' },
                userId: { S: 'user-123' },
                taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/old-task' },
                privateIp: { S: '10.10.1.40' },
                status: { S: 'ACTIVE' },
                createdAt: { N: '1000' },
                lastActivity: { N: '2000' },
                expiresAt: { N: '9000' },
              },
            ],
          };
        }
        if (cmd._type === 'UpdateItem') {
          return {};
        }
        if (cmd._type === 'PutItem') {
          return {};
        }
        if (cmd._type === 'TransactWriteItems') {
          return {};
        }
        if (cmd._type === 'DeleteItem') {
          return {};
        }
        return {};
      });

      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'StopTask') {
          stopCalled = true;
          return {};
        }
        if (cmd._type === 'ListTasks') {
          return { taskArns: ['arn:aws:ecs:us-west-2:123:task/test-cluster/task-2'] };
        }
        if (cmd._type === 'DescribeTasks') {
          return {
            tasks: [
              {
                taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-2',
                containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.51' }] }],
                overrides: { containerOverrides: [{ environment: [{ name: 'SESSION_ID', value: '' }] }] },
                attachments: [
                  {
                    type: 'ElasticNetworkInterface',
                    details: [{ name: 'privateIPv4Address', value: '10.10.1.51' }],
                  },
                ],
              },
            ],
          };
        }
        return {};
      });

      const event = apiEvent('POST', '/session', { userId: 'user-123' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(201);
      // Task is NOT stopped on session replacement — it stays warm for reuse
      expect(stopCalled).toBe(false);
    });

    it('should skip already-claimed tasks and assign unclaimed one', async () => {
      // Mock: no existing session for this user, but one ACTIVE session from another user
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Query') {
          // byUserId query — no existing session for this user
          if (cmd.input?.IndexName === 'byUserId') {
            return { Items: [] };
          }
          // byStatus query — one ACTIVE session claiming task-1
          if (cmd.input?.IndexName === 'byStatus') {
            return {
              Items: [
                {
                  taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1' },
                },
              ],
            };
          }
        }
        if (cmd._type === 'PutItem') return {};
        if (cmd._type === 'UpdateItem') return {};
        if (cmd._type === 'TransactWriteItems') return {};
        if (cmd._type === 'DeleteItem') return {};
        return {};
      });

      // Mock: two running tasks — task-1 (claimed) and task-2 (available)
      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'ListTasks') {
          return {
            taskArns: [
              'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1',
              'arn:aws:ecs:us-west-2:123:task/test-cluster/task-2',
            ],
          };
        }
        if (cmd._type === 'DescribeTasks') {
          return {
            tasks: [
              {
                taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1',
                containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.50' }] }],
                overrides: { containerOverrides: [{ environment: [] }] },
                attachments: [
                  {
                    type: 'ElasticNetworkInterface',
                    details: [{ name: 'privateIPv4Address', value: '10.10.1.50' }],
                  },
                ],
              },
              {
                taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-2',
                containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.51' }] }],
                overrides: { containerOverrides: [{ environment: [] }] },
                attachments: [
                  {
                    type: 'ElasticNetworkInterface',
                    details: [{ name: 'privateIPv4Address', value: '10.10.1.51' }],
                  },
                ],
              },
            ],
          };
        }
        return {};
      });

      const event = apiEvent('POST', '/session', { userId: 'user-456' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(201);
      const body = JSON.parse((result as any).body);
      // Should have been assigned task-2 (the unclaimed one), not task-1
      expect(body.sessionId).toBeDefined();
    });

    it('should return 503 when no warm tasks available', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Query') return { Items: [] }; // No existing sessions
        if (cmd._type === 'PutItem') return {};
        if (cmd._type === 'UpdateItem') return {};
        return {};
      });

      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'ListTasks') return { taskArns: [] };
        return {};
      });

      const event = apiEvent('POST', '/session', { userId: 'user-123' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(503);
      const body = JSON.parse((result as any).body);
      expect(body.error).toContain('No sandbox containers available');
    });

    it('should return 401 when not authenticated', async () => {
      const event = unauthEvent('POST', '/session');
      const result = await handler(event);

      expect((result as any).statusCode).toBe(401);
    });

    /**
     * Reloading a tab loses the in-page session id, so the browser legitimately
     * asks to create a session — and retiring the caller's existing record on the
     * way used to strand every guest attached to it (TEST_REPORT defect 22).
     */
    describe('reloading an owner who is sharing their session', () => {
      /** An ACTIVE session of user-123's with a guest in it. */
      function sharedSession(overrides: Record<string, any> = {}) {
        const item: Record<string, any> = {
          sessionId: { S: 'shared-session' },
          userId: { S: 'user-123' },
          taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/shared-task' },
          privateIp: { S: '10.10.1.40' },
          status: { S: 'ACTIVE' },
          createdAt: { N: '1000' },
          lastActivity: { N: '2000' },
          expiresAt: { N: '9000' },
          members: { L: [{ S: 'user-guest' }] },
          ...overrides,
        };

        // An absent attribute is absent, not present-and-undefined: the item goes
        // through `unmarshall`, which reads `.S` off every value it is handed.
        for (const [key, value] of Object.entries(item)) {
          if (value === undefined) {
            delete item[key];
          }
        }

        return item;
      }

      /** Record every DynamoDB write so the test can assert nothing was retired. */
      function recordWrites(item: Record<string, any>) {
        const writes: any[] = [];

        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'Query') {
            return { Items: [item] };
          }

          writes.push(cmd);

          return {};
        });

        mockEcsSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'ListTasks') {
            return { taskArns: ['arn:aws:ecs:us-west-2:123:task/test-cluster/task-9'] };
          }
          if (cmd._type === 'DescribeTasks') {
            return {
              tasks: [
                {
                  taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-9',
                  containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.99' }] }],
                  overrides: { containerOverrides: [{ environment: [{ name: 'SESSION_ID', value: '' }] }] },
                  attachments: [
                    {
                      type: 'ElasticNetworkInterface',
                      details: [{ name: 'privateIPv4Address', value: '10.10.1.99' }],
                    },
                  ],
                },
              ],
            };
          }
          return {};
        });

        return writes;
      }

      it('hands the shared session back instead of retiring it', async () => {
        recordWrites(sharedSession());

        const result = await handler(apiEvent('POST', '/session', { userId: 'user-123' }));
        const body = JSON.parse((result as any).body);

        expect((result as any).statusCode).toBe(200);
        expect(body.sessionId).toBe('shared-session');
        expect(body.resumed).toBe(true);
        expect(body.previewDomain).toBe('shared-session.preview.vibe.test.dev');
      });

      it('never marks the shared session STOPPED, which is what ejected the guest', async () => {
        const writes = recordWrites(sharedSession());

        await handler(apiEvent('POST', '/session', { userId: 'user-123' }));

        const stopped = writes.filter(
          (cmd) => cmd._type === 'UpdateItem' && cmd.input?.ExpressionAttributeValues?.[':status']?.S === 'STOPPED',
        );

        expect(stopped).toHaveLength(0);
      });

      it('leaves the claim lock in place, so the guest keeps the container', async () => {
        const writes = recordWrites(sharedSession());

        await handler(apiEvent('POST', '/session', { userId: 'user-123' }));

        const releasedLocks = writes.filter(
          (cmd) => cmd._type === 'DeleteItem' && String(cmd.input?.Key?.sessionId?.S).startsWith('TASK#'),
        );

        expect(releasedLocks).toHaveLength(0);
      });

      it('signs a fresh URL for the session being resumed', async () => {
        recordWrites(sharedSession());

        const result = await handler(apiEvent('POST', '/session', { userId: 'user-123' }));
        const { wsUrl } = JSON.parse((result as any).body);

        expectCloudFrontSigned(wsUrl, 'shared-session');
      });

      it('keeps the session alive, so resuming counts as activity', async () => {
        const writes = recordWrites(sharedSession());

        await handler(apiEvent('POST', '/session', { userId: 'user-123' }));

        const touched = writes.filter(
          (cmd) => cmd._type === 'UpdateItem' && cmd.input?.ExpressionAttributeValues?.[':lastActivity'],
        );

        expect(touched).toHaveLength(1);
      });

      it('still retires a solo session, so reloading alone gets a clean sandbox', async () => {
        recordWrites(sharedSession({ members: undefined }));

        const result = await handler(apiEvent('POST', '/session', { userId: 'user-123' }));
        const body = JSON.parse((result as any).body);

        expect((result as any).statusCode).toBe(201);
        expect(body.sessionId).not.toBe('shared-session');
      });

      it('does not resume a session whose only member is the caller', async () => {
        recordWrites(sharedSession({ members: { L: [{ S: 'user-123' }] } }));

        const result = await handler(apiEvent('POST', '/session', { userId: 'user-123' }));

        expect((result as any).statusCode).toBe(201);
      });

      it('does not resume a shared session that never claimed a container', async () => {
        recordWrites(sharedSession({ taskArn: { S: '' }, status: { S: 'PENDING' } }));

        const result = await handler(apiEvent('POST', '/session', { userId: 'user-123' }));
        const body = JSON.parse((result as any).body);

        expect((result as any).statusCode).toBe(201);
        expect(body.sessionId).not.toBe('shared-session');
      });
    });
  });

  describe('GET /session/{id} — get session', () => {
    it('should return session details', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') {
          return {
            Item: {
              sessionId: { S: 'sess-1' },
              userId: { S: 'user-123' },
              status: { S: 'ACTIVE' },
              taskArn: { S: 'arn:...' },
              privateIp: { S: '10.10.1.50' },
              createdAt: { N: '1000' },
              lastActivity: { N: '2000' },
              expiresAt: { N: '9000' },
            },
          };
        }
        return {};
      });

      const event = apiEvent('GET', '/session/sess-1', null, { id: 'sess-1' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(200);
      const body = JSON.parse((result as any).body);
      expect(body.session.sessionId).toBe('sess-1');
      expect(body.session.status).toBe('ACTIVE');
    });

    it('should return 404 for unknown session', async () => {
      mockDynamoSend.mockImplementation(() => ({ Item: undefined }));

      const event = apiEvent('GET', '/session/unknown', null, { id: 'unknown' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(404);
    });
  });

  describe('DELETE /session/{id} — stop session', () => {
    it('should stop an active session', async () => {
      let taskStopped = false;

      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') {
          return {
            Item: {
              sessionId: { S: 'sess-1' },
              userId: { S: 'user-123' },
              status: { S: 'ACTIVE' },
              taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/task-1' },
              privateIp: { S: '10.10.1.50' },
              createdAt: { N: '1000' },
              lastActivity: { N: '2000' },
              expiresAt: { N: '9000' },
            },
          };
        }
        if (cmd._type === 'UpdateItem') return {};
        return {};
      });

      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'StopTask') {
          taskStopped = true;
          return {};
        }
        return {};
      });

      const event = apiEvent('DELETE', '/session/sess-1', null, { id: 'sess-1' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(200);
      expect(taskStopped).toBe(true);
    });
  });

  describe('POST /session/{id}/heartbeat — heartbeat', () => {
    it('should update last activity for active session', async () => {
      let lastActivityUpdated = false;

      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') {
          return {
            Item: {
              sessionId: { S: 'sess-1' },
              userId: { S: 'user-123' },
              status: { S: 'ACTIVE' },
              taskArn: { S: 'arn:...' },
              privateIp: { S: '10.10.1.50' },
              createdAt: { N: '1000' },
              lastActivity: { N: '2000' },
              expiresAt: { N: '9000' },
            },
          };
        }
        if (cmd._type === 'UpdateItem') {
          lastActivityUpdated = true;
          return {};
        }
        return {};
      });

      const event = apiEvent('POST', '/session/sess-1/heartbeat', null, { id: 'sess-1' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(200);
      expect(lastActivityUpdated).toBe(true);
    });

    it('should return 409 for non-active session', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') {
          return {
            Item: {
              sessionId: { S: 'sess-1' },
              userId: { S: 'user-123' },
              status: { S: 'STOPPED' },
              taskArn: { S: '' },
              privateIp: { S: '' },
              createdAt: { N: '1000' },
              lastActivity: { N: '2000' },
              expiresAt: { N: '9000' },
            },
          };
        }
        return {};
      });

      const event = apiEvent('POST', '/session/sess-1/heartbeat', null, { id: 'sess-1' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(409);
    });
  });

  describe('Authentication and ownership', () => {
    it('should return 401 for unauthenticated GET', async () => {
      const event = unauthEvent('GET', '/session/sess-1');
      (event as any).pathParameters = { id: 'sess-1' };
      const result = await handler(event);

      expect((result as any).statusCode).toBe(401);
    });

    it('should return 401 for unauthenticated DELETE', async () => {
      const event = unauthEvent('DELETE', '/session/sess-1');
      (event as any).pathParameters = { id: 'sess-1' };
      const result = await handler(event);

      expect((result as any).statusCode).toBe(401);
    });

    it('should return 401 for unauthenticated heartbeat', async () => {
      const event = unauthEvent('POST', '/session/sess-1/heartbeat');
      (event as any).pathParameters = { id: 'sess-1' };
      const result = await handler(event);

      expect((result as any).statusCode).toBe(401);
    });

    it('should return 403 when GET another user session', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') {
          return {
            Item: {
              sessionId: { S: 'sess-other' },
              userId: { S: 'user-other' },
              status: { S: 'ACTIVE' },
              taskArn: { S: 'arn:...' },
              privateIp: { S: '10.10.1.50' },
              createdAt: { N: '1000' },
              lastActivity: { N: '2000' },
              expiresAt: { N: '9000' },
            },
          };
        }
        return {};
      });

      const event = apiEvent('GET', '/session/sess-other', null, { id: 'sess-other' }, 'user-123');
      const result = await handler(event);

      expect((result as any).statusCode).toBe(403);
      const body = JSON.parse((result as any).body);
      expect(body.error).toBe('Forbidden');
    });

    it('should return 403 when DELETE another user session', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') {
          return {
            Item: {
              sessionId: { S: 'sess-other' },
              userId: { S: 'user-other' },
              status: { S: 'ACTIVE' },
              taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/task-1' },
              privateIp: { S: '10.10.1.50' },
              createdAt: { N: '1000' },
              lastActivity: { N: '2000' },
              expiresAt: { N: '9000' },
            },
          };
        }
        return {};
      });

      const event = apiEvent('DELETE', '/session/sess-other', null, { id: 'sess-other' }, 'user-123');
      const result = await handler(event);

      expect((result as any).statusCode).toBe(403);
    });

    it('should return 403 when heartbeat another user session', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') {
          return {
            Item: {
              sessionId: { S: 'sess-other' },
              userId: { S: 'user-other' },
              status: { S: 'ACTIVE' },
              taskArn: { S: 'arn:...' },
              privateIp: { S: '10.10.1.50' },
              createdAt: { N: '1000' },
              lastActivity: { N: '2000' },
              expiresAt: { N: '9000' },
            },
          };
        }
        return {};
      });

      const event = apiEvent('POST', '/session/sess-other/heartbeat', null, { id: 'sess-other' }, 'user-123');
      const result = await handler(event);

      expect((result as any).statusCode).toBe(403);
    });

    it('should use auth userId, not body userId, for session creation', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Query') return { Items: [] };
        if (cmd._type === 'PutItem') return {};
        if (cmd._type === 'UpdateItem') return {};
        if (cmd._type === 'TransactWriteItems') return {};
        if (cmd._type === 'DeleteItem') return {};
        return {};
      });

      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'ListTasks') {
          return { taskArns: ['arn:aws:ecs:us-west-2:123:task/test-cluster/task-1'] };
        }
        if (cmd._type === 'DescribeTasks') {
          return {
            tasks: [{
              taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1',
              containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.50' }] }],
              overrides: { containerOverrides: [{ environment: [{ name: 'SESSION_ID', value: '' }] }] },
              attachments: [{
                type: 'ElasticNetworkInterface',
                details: [{ name: 'privateIPv4Address', value: '10.10.1.50' }],
              }],
            }],
          };
        }
        return {};
      });

      // Body claims userId is 'user-attacker' but auth says 'user-real'
      const event = apiEvent('POST', '/session', { userId: 'user-attacker' }, undefined, 'user-real');
      const result = await handler(event);

      // Should succeed with auth user
      expect((result as any).statusCode).toBe(201);
    });
  });

  describe('Race condition — TransactionCanceledException', () => {
    it('should return 503 when task claim race is lost', async () => {
      let transactCalled = false;

      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Query') return { Items: [] };
        if (cmd._type === 'PutItem') return {};
        if (cmd._type === 'UpdateItem') return {};
        if (cmd._type === 'TransactWriteItems') {
          transactCalled = true;
          const err: any = new Error('Transaction cancelled');
          err.name = 'TransactionCanceledException';
          throw err;
        }
        return {};
      });

      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'ListTasks') {
          return { taskArns: ['arn:aws:ecs:us-west-2:123:task/test-cluster/task-1'] };
        }
        if (cmd._type === 'DescribeTasks') {
          return {
            tasks: [{
              taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1',
              containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.50' }] }],
              overrides: { containerOverrides: [{ environment: [{ name: 'SESSION_ID', value: '' }] }] },
              attachments: [{
                type: 'ElasticNetworkInterface',
                details: [{ name: 'privateIPv4Address', value: '10.10.1.50' }],
              }],
            }],
          };
        }
        return {};
      });

      const event = apiEvent('POST', '/session', { userId: 'user-123' });
      const result = await handler(event);

      expect(transactCalled).toBe(true);
      expect((result as any).statusCode).toBe(503);
      const body = JSON.parse((result as any).body);
      expect(body.error).toContain('No sandbox containers available');
    });
  });

  describe('EventBridge cleanup', () => {
    it('should stop idle sessions', async () => {
      const stoppedTasks: string[] = [];

      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Scan') {
          return {
            Items: [
              {
                sessionId: { S: 'idle-1' },
                userId: { S: 'user-123' },
                status: { S: 'ACTIVE' },
                taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/idle-task' },
                privateIp: { S: '10.10.1.50' },
                createdAt: { N: '1000' },
                lastActivity: { N: '1000' },
                expiresAt: { N: '9000' },
              },
            ],
          };
        }
        if (cmd._type === 'UpdateItem') return {};
        return {};
      });

      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'StopTask') {
          stoppedTasks.push(cmd.input?.task || 'unknown');
          return {};
        }
        return {};
      });

      // Simulate EventBridge scheduled event
      const event = {
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        detail: {},
      };

      await handler(event as any);

      expect(stoppedTasks.length).toBe(1);
    });
  });

  /**
   * Invite and join. A session id is not a secret (it appears in preview URLs
   * and load-balancer logs), so joining is gated on an authenticated identity
   * holding a valid, short-lived, revocable invite token — never on knowing the
   * id.
   */
  describe('Collaboration — invite and join', () => {
    const ownedSession = (overrides: Record<string, any> = {}) => ({
      sessionId: { S: 'sess-1' },
      userId: { S: 'user-123' },
      status: { S: 'ACTIVE' },
      taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/task-1' },
      privateIp: { S: '10.10.1.50' },
      createdAt: { N: '1000' },
      lastActivity: { N: '2000' },
      expiresAt: { N: '9000' },
      ...overrides,
    });

    const futureTtl = () => Math.floor(Date.now() / 1000) + 600;

    describe('POST /session/{id}/invite', () => {
      it('mints a token for the session owner', async () => {
        const puts: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') return { Item: ownedSession() };
          if (cmd._type === 'PutItem') puts.push(cmd.input);
          return {};
        });

        const event = apiEvent('POST', '/session/sess-1/invite', null, { id: 'sess-1' }, 'user-123');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(201);
        const body = JSON.parse((result as any).body);
        expect(typeof body.token).toBe('string');
        expect(body.token.length).toBeGreaterThan(0);

        // Persisted under its own key in the sessions table. It no longer carries
        // an expiry — see 'permanent invite links' below for why and for the
        // controls that replaced it.
        expect(puts.some((p) => String(p.Item?.sessionId?.S).startsWith('INVITE#'))).toBe(true);
      });

      it('refuses a non-owner, so a guest cannot widen access', async () => {
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') return { Item: ownedSession() };
          return {};
        });

        const event = apiEvent('POST', '/session/sess-1/invite', null, { id: 'sess-1' }, 'user-guest');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(403);
      });

      it('refuses to invite into a session that is not active', async () => {
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') return { Item: ownedSession({ status: { S: 'STOPPED' } }) };
          return {};
        });

        const event = apiEvent('POST', '/session/sess-1/invite', null, { id: 'sess-1' }, 'user-123');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(409);
      });
    });

    describe('POST /session/join', () => {
      it('adds the caller as a member and returns the owner session connection details', async () => {
        const updates: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            const key = cmd.input?.Key?.sessionId?.S ?? '';
            if (key.startsWith('INVITE#')) {
              return {
                Item: {
                  sessionId: { S: key },
                  inviteSessionId: { S: 'sess-1' },
                  invitedBy: { S: 'user-123' },
                  role: { S: 'editor' },
                  createdAt: { N: '1000' },
                  expiresAt: { N: String(futureTtl()) },
                },
              };
            }
            return { Item: ownedSession() };
          }
          if (cmd._type === 'UpdateItem') updates.push(cmd.input);
          return {};
        });

        const event = apiEvent('POST', '/session/join', { token: 'tok-1' }, undefined, 'user-guest');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(200);
        const body = JSON.parse((result as any).body);
        // The joiner must be pointed at the OWNER's session, so the routing
        // layer lands both browsers on the same container.
        expect(body.sessionId).toBe('sess-1');
        expect(body.wsUrl).toContain('/ws/sess-1');
        expect(updates.some((u) => String(u.UpdateExpression).includes('members'))).toBe(true);
      });

      it('grants the project the invite carried, so the guest gets the conversation too', async () => {
        // Sharing only the sandbox leaves the guest looking at files with no
        // history behind them and an AI with nothing to continue.
        const puts: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            const key = cmd.input?.Key?.sessionId?.S ?? '';
            if (key.startsWith('INVITE#')) {
              return {
                Item: {
                  sessionId: { S: key },
                  inviteSessionId: { S: 'sess-1' },
                  invitedBy: { S: 'user-123' },
                  role: { S: 'editor' },
                  createdAt: { N: '1000' },
                  expiresAt: { N: String(futureTtl()) },
                  inviteProjectId: { S: 'proj-42' },
                },
              };
            }
            return { Item: ownedSession() };
          }
          if (cmd._type === 'PutItem') puts.push(cmd.input);
          return {};
        });

        const result = await handler(
          apiEvent('POST', '/session/join', { token: 'tok-1' }, undefined, 'user-guest'),
        );

        expect((result as any).statusCode).toBe(200);
        expect(JSON.parse((result as any).body).projectId).toBe('proj-42');

        const memberWrite = puts.find((p) => String(p.Item?.sk?.S ?? '').startsWith('MEMBER#'));
        expect(memberWrite?.Item?.projectId?.S).toBe('proj-42');
        expect(memberWrite?.Item?.sk?.S).toBe('MEMBER#user-guest');
      });

      it('still joins when the invite carried no project', async () => {
        // A session with nothing built yet has no conversation to hand over; the
        // sandbox must still be shareable.
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            const key = cmd.input?.Key?.sessionId?.S ?? '';
            if (key.startsWith('INVITE#')) {
              return {
                Item: {
                  sessionId: { S: key },
                  inviteSessionId: { S: 'sess-1' },
                  invitedBy: { S: 'user-123' },
                  role: { S: 'editor' },
                  createdAt: { N: '1000' },
                  expiresAt: { N: String(futureTtl()) },
                },
              };
            }
            return { Item: ownedSession() };
          }
          return {};
        });

        const result = await handler(
          apiEvent('POST', '/session/join', { token: 'tok-1' }, undefined, 'user-guest'),
        );

        expect((result as any).statusCode).toBe(200);
        expect(JSON.parse((result as any).body).projectId).toBeUndefined();
      });

      it('rejects an unknown or revoked token', async () => {
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') return {}; // no item
          return {};
        });

        const event = apiEvent('POST', '/session/join', { token: 'nope' }, undefined, 'user-guest');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(403);
      });

      it('rejects an expired token even if TTL deletion has not caught up', async () => {
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            return {
              Item: {
                sessionId: { S: 'INVITE#old' },
                inviteSessionId: { S: 'sess-1' },
                invitedBy: { S: 'user-123' },
                role: { S: 'editor' },
                createdAt: { N: '1000' },
                expiresAt: { N: '1' }, // long past
              },
            };
          }
          return {};
        });

        const event = apiEvent('POST', '/session/join', { token: 'old' }, undefined, 'user-guest');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(403);
      });

      it('requires a token', async () => {
        const event = apiEvent('POST', '/session/join', {}, undefined, 'user-guest');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(400);
      });

      it('requires authentication', async () => {
        const event = unauthEvent('POST', '/session/join', { token: 'tok-1' });
        const result = await handler(event);

        expect((result as any).statusCode).toBe(401);
      });
    });

    /**
     * The sandbox socket runs shell commands and the session id is not a secret,
     * so every URL handed out must be a CloudFront signed URL — that signature,
     * not knowledge of the id, is what CloudFront admits.
     */
    describe('WebSocket signed URL', () => {
      it('signs the URL returned on session create', async () => {
        mockDynamoSend.mockImplementation((cmd: any) => (cmd._type === 'Query' ? { Items: [] } : {}));
        mockEcsSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'ListTasks') {
            return { taskArns: ['arn:aws:ecs:us-west-2:123:task/test-cluster/task-1'] };
          }
          if (cmd._type === 'DescribeTasks') {
            return {
              tasks: [
                {
                  taskArn: 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1',
                  containers: [{ networkInterfaces: [{ privateIpv4Address: '10.10.1.50' }] }],
                  overrides: { containerOverrides: [{ environment: [{ name: 'SESSION_ID', value: '' }] }] },
                  attachments: [
                    {
                      type: 'ElasticNetworkInterface',
                      details: [{ name: 'privateIPv4Address', value: '10.10.1.50' }],
                    },
                  ],
                },
              ],
            };
          }
          return {};
        });

        const result = await handler(apiEvent('POST', '/session'));
        const body = JSON.parse((result as any).body);

        expectCloudFrontSigned(body.wsUrl, body.sessionId);
        // Never a direct-to-load-balancer or direct-to-task URL: those bypass CloudFront.
        expect(body.wsUrl).not.toContain('10.10.1.50');
        expect(body.wsUrl).toContain('vibe.test.dev');
      });

      it('signs a URL for the joiner too, so an invited member can connect', async () => {
        const future = Math.floor(Date.now() / 1000) + 600;
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            const key = cmd.input?.Key?.sessionId?.S ?? '';
            if (key.startsWith('INVITE#')) {
              return {
                Item: {
                  sessionId: { S: key },
                  inviteSessionId: { S: 'sess-1' },
                  invitedBy: { S: 'user-123' },
                  role: { S: 'editor' },
                  createdAt: { N: '1000' },
                  expiresAt: { N: String(future) },
                },
              };
            }
            return { Item: ownedSession() };
          }
          return {};
        });

        const result = await handler(
          apiEvent('POST', '/session/join', { token: 'tok-1' }, undefined, 'user-guest'),
        );
        const body = JSON.parse((result as any).body);

        expect((result as any).statusCode).toBe(200);
        expectCloudFrontSigned(body.wsUrl, 'sess-1');
      });
    });

    describe('POST /session/{id}/bind', () => {
      it('records the container that answered so collaborators route to it', async () => {
        const updates: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            return { Item: ownedSession({ privateIp: { S: '10.10.9.9' } }) };
          }
          if (cmd._type === 'UpdateItem') updates.push(cmd.input);
          return {};
        });

        const event = apiEvent(
          'POST',
          '/session/sess-1/bind',
          { containerId: 'ip-10-10-2-155.us-west-2.compute.internal' },
          { id: 'sess-1' },
          'user-123',
        );
        const result = await handler(event);

        expect((result as any).statusCode).toBe(200);
        expect(JSON.parse((result as any).body).rebound).toBe(true);
        expect(updates.some((u) => String(u.UpdateExpression).includes('privateIp'))).toBe(true);
      });

      it('is a no-op when the session is already pinned to that container', async () => {
        const updates: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            return { Item: ownedSession({ privateIp: { S: '10.10.2.155' } }) };
          }
          if (cmd._type === 'UpdateItem') updates.push(cmd.input);
          return {};
        });

        const event = apiEvent(
          'POST',
          '/session/sess-1/bind',
          { containerId: 'ip-10-10-2-155.us-west-2.compute.internal' },
          { id: 'sess-1' },
          'user-123',
        );
        const result = await handler(event);

        expect((result as any).statusCode).toBe(200);
        expect(JSON.parse((result as any).body).rebound).toBe(false);
        expect(updates).toEqual([]);
      });

      it('refuses a non-owner, so a guest cannot repoint the session', async () => {
        mockDynamoSend.mockImplementation((cmd: any) =>
          cmd._type === 'GetItem' ? { Item: ownedSession() } : {},
        );

        const event = apiEvent(
          'POST',
          '/session/sess-1/bind',
          { containerId: 'ip-10-10-2-155.us-west-2.compute.internal' },
          { id: 'sess-1' },
          'user-guest',
        );
        const result = await handler(event);

        expect((result as any).statusCode).toBe(403);
      });

      it('rejects a container id it cannot turn into an address', async () => {
        mockDynamoSend.mockImplementation((cmd: any) =>
          cmd._type === 'GetItem' ? { Item: ownedSession() } : {},
        );

        const event = apiEvent(
          'POST',
          '/session/sess-1/bind',
          { containerId: 'not-a-task-hostname' },
          { id: 'sess-1' },
          'user-123',
        );
        const result = await handler(event);

        expect((result as any).statusCode).toBe(400);
      });
    });

    describe('member access to an existing session', () => {
      const sessionWithMember = {
        Item: ownedSession({ members: { L: [{ S: 'user-guest' }] } }),
      };

      it('lets an invited member read the session', async () => {
        mockDynamoSend.mockImplementation((cmd: any) =>
          cmd._type === 'GetItem' ? sessionWithMember : {},
        );

        const event = apiEvent('GET', '/session/sess-1', null, { id: 'sess-1' }, 'user-guest');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(200);
      });

      it('lets an invited member heartbeat, so the session is not reaped while they work', async () => {
        mockDynamoSend.mockImplementation((cmd: any) =>
          cmd._type === 'GetItem' ? sessionWithMember : {},
        );

        const event = apiEvent(
          'POST',
          '/session/sess-1/heartbeat',
          null,
          { id: 'sess-1' },
          'user-guest',
        );
        const result = await handler(event);

        expect((result as any).statusCode).toBe(200);
      });

      it('still refuses a member trying to delete the owner session', async () => {
        mockDynamoSend.mockImplementation((cmd: any) =>
          cmd._type === 'GetItem' ? sessionWithMember : {},
        );

        const event = apiEvent('DELETE', '/session/sess-1', null, { id: 'sess-1' }, 'user-guest');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(403);
      });

      it('still refuses a stranger who is neither owner nor member', async () => {
        mockDynamoSend.mockImplementation((cmd: any) =>
          cmd._type === 'GetItem' ? sessionWithMember : {},
        );

        const event = apiEvent('GET', '/session/sess-1', null, { id: 'sess-1' }, 'user-stranger');
        const result = await handler(event);

        expect((result as any).statusCode).toBe(403);
      });
    });

    /**
     * An invited collaborator is meant to be a permanent member, the way a shared
     * document works — so the link no longer expires.
     *
     * Permanence is only safe next to the two controls that replace the expiry: a
     * link can be redeemed by one person, and the owner can revoke one that has
     * not been redeemed yet. The tests below cover the three together because
     * removing the expiry on its own is what would make a leaked link dangerous.
     */
    describe('permanent invite links', () => {
      const inviteItem = (overrides: Record<string, any> = {}): Record<string, any> => ({
        sessionId: { S: 'INVITE#tok-1' },
        inviteSessionId: { S: 'sess-1' },
        invitedBy: { S: 'user-123' },
        role: { S: 'editor' },
        createdAt: { N: '1000' },
        ...overrides,
      });

      const conditionalFailure = () => {
        const err: any = new Error('The conditional request failed');
        err.name = 'ConditionalCheckFailedException';
        return err;
      };

      /**
       * Route the reads a join issues, and fake DynamoDB's evaluation of the
       * claim's condition: it fails only when the item already records a
       * different redeemer, which is the whole of what makes a link single-use.
       */
      function respondForJoin(
        options: {
          invite?: Record<string, any> | null;
          session?: Record<string, any>;
          onCommand?: (cmd: any) => void;
        } = {},
      ) {
        const { invite = inviteItem(), session = ownedSession(), onCommand } = options;

        return (cmd: any) => {
          onCommand?.(cmd);

          const key = String(cmd.input?.Key?.sessionId?.S ?? '');

          if (cmd._type === 'GetItem') {
            if (key.startsWith('INVITE#')) {
              return invite ? { Item: invite } : {};
            }
            return { Item: session };
          }

          if (cmd._type === 'UpdateItem' && key.startsWith('INVITE#')) {
            const claimedBy = invite?.redeemedBy?.S;
            const caller = cmd.input?.ExpressionAttributeValues?.[':userId']?.S;

            if (claimedBy && claimedBy !== caller) {
              throw conditionalFailure();
            }
          }

          return {};
        };
      }

      const joinAs = (userId: string) =>
        handler(apiEvent('POST', '/session/join', { token: 'tok-1' }, undefined, userId));

      it('mints a link with no expiry, so a shared chat does not lapse', async () => {
        const puts: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') return { Item: ownedSession() };
          if (cmd._type === 'PutItem') puts.push(cmd.input);
          return {};
        });

        const result = await handler(
          apiEvent('POST', '/session/sess-1/invite', null, { id: 'sess-1' }, 'user-123'),
        );

        expect((result as any).statusCode).toBe(201);
        expect(JSON.parse((result as any).body).expiresAt).toBeUndefined();

        // `expiresAt` is the sessions table's TTL attribute, so the link survives
        // by not carrying one at all. Stamping a distant future value instead
        // would still be an expiry, just a longer one.
        const invitePut = puts.find((p) => String(p.Item?.sessionId?.S).startsWith('INVITE#'));
        expect(invitePut).toBeDefined();
        expect(invitePut.Item.expiresAt).toBeUndefined();
      });

      it('redeems a link that carries no expiry', async () => {
        mockDynamoSend.mockImplementation(respondForJoin());

        const result = await joinAs('user-guest');

        expect((result as any).statusCode).toBe(200);
        expect(JSON.parse((result as any).body).sessionId).toBe('sess-1');
      });

      it('records the redeemer with a conditional write, so two joins cannot both win', async () => {
        const commands: any[] = [];
        mockDynamoSend.mockImplementation(respondForJoin({ onCommand: (cmd) => commands.push(cmd) }));

        await joinAs('user-guest');

        const claim = commands.find(
          (cmd) =>
            cmd._type === 'UpdateItem' &&
            String(cmd.input?.Key?.sessionId?.S).startsWith('INVITE#'),
        );

        expect(claim).toBeDefined();
        expect(claim.input.UpdateExpression).toContain('redeemedBy');
        expect(claim.input.ConditionExpression).toContain('redeemedBy');
        expect(claim.input.ExpressionAttributeValues[':userId'].S).toBe('user-guest');
      });

      it('refuses a stranger once the link has been redeemed', async () => {
        const commands: any[] = [];
        mockDynamoSend.mockImplementation(
          respondForJoin({
            invite: inviteItem({ redeemedBy: { S: 'user-guest' } }),
            session: ownedSession({ members: { L: [{ S: 'user-guest' }] } }),
            onCommand: (cmd) => commands.push(cmd),
          }),
        );

        const result = await joinAs('user-stranger');

        expect((result as any).statusCode).toBe(403);

        // Refused before any membership was granted, not merely reported as an error.
        expect(
          commands.some(
            (cmd) =>
              cmd._type === 'UpdateItem' && String(cmd.input?.UpdateExpression).includes('members'),
          ),
        ).toBe(false);
      });

      it('lets the guest who redeemed the link use it again, so their own reload works', async () => {
        // Reloading loses the in-memory session id, so the guest's browser
        // redeems the token it stashed. Single-use must mean one person, not one
        // request, or sharing would break on the first refresh.
        mockDynamoSend.mockImplementation(
          respondForJoin({
            invite: inviteItem({ redeemedBy: { S: 'user-guest' } }),
            session: ownedSession({ members: { L: [{ S: 'user-guest' }] } }),
          }),
        );

        const result = await joinAs('user-guest');

        expect((result as any).statusCode).toBe(200);
        expect(JSON.parse((result as any).body).sessionId).toBe('sess-1');
      });

      it('lets an existing member of the session through even when someone else claimed the link', async () => {
        // Access already granted is not re-litigated by a link they no longer
        // need: they are in the session, so the redemption is a no-op for them.
        mockDynamoSend.mockImplementation(
          respondForJoin({
            invite: inviteItem({ redeemedBy: { S: 'user-other' } }),
            session: ownedSession({ members: { L: [{ S: 'user-guest' }] } }),
          }),
        );

        const result = await joinAs('user-guest');

        expect((result as any).statusCode).toBe(200);
      });

      it('lets the owner redeem their own link, which grants nothing new', async () => {
        mockDynamoSend.mockImplementation(
          respondForJoin({ invite: inviteItem({ redeemedBy: { S: 'user-other' } }) }),
        );

        const result = await joinAs('user-123');

        expect((result as any).statusCode).toBe(200);
      });
    });

    describe('DELETE /session/{id}/invite — revoke a link', () => {
      const revokeEvent = (token: string | undefined, userId: string) => ({
        ...apiEvent('DELETE', '/session/sess-1/invite', null, { id: 'sess-1' }, userId),
        queryStringParameters: token ? { token } : null,
      });

      it('lets the owner revoke a link that has not been redeemed', async () => {
        const deletes: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') return { Item: ownedSession() };
          if (cmd._type === 'DeleteItem') deletes.push(cmd.input);
          return {};
        });

        const result = await handler(revokeEvent('tok-1', 'user-123') as any);

        expect((result as any).statusCode).toBe(200);
        expect(deletes.map((d) => d.Key?.sessionId?.S)).toContain('INVITE#tok-1');
      });

      it('refuses a non-owner, so a guest cannot revoke the owner link', async () => {
        const deletes: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            return { Item: ownedSession({ members: { L: [{ S: 'user-guest' }] } }) };
          }
          if (cmd._type === 'DeleteItem') deletes.push(cmd.input);
          return {};
        });

        const result = await handler(revokeEvent('tok-1', 'user-guest') as any);

        expect((result as any).statusCode).toBe(403);
        expect(deletes).toHaveLength(0);
      });

      it('requires a token', async () => {
        mockDynamoSend.mockImplementation((cmd: any) =>
          cmd._type === 'GetItem' ? { Item: ownedSession() } : {},
        );

        const result = await handler(revokeEvent(undefined, 'user-123') as any);

        expect((result as any).statusCode).toBe(400);
      });

      it('returns 404 for an unknown session', async () => {
        mockDynamoSend.mockImplementation(() => ({}));

        const result = await handler(revokeEvent('tok-1', 'user-123') as any);

        expect((result as any).statusCode).toBe(404);
      });
    });
  });
});

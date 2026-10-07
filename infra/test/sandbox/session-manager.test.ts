import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
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
    TagResourceCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'TagResource' })),
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

// Per-session ALB routing is covered in alb-routing.test.ts; here it is mocked so
// the lifecycle (provision on claim, teardown on every exit path) is observable.
const mockProvisionRouting = jest.fn();
const mockTeardownRouting = jest.fn();
const mockReconcileRouting = jest.fn();

jest.mock('../../lib/sandbox/session-manager-lambda/alb-routing', () => ({
  provisionSessionRouting: (...args: unknown[]) => mockProvisionRouting(...args),
  teardownSessionRouting: (...args: unknown[]) => mockTeardownRouting(...args),
  reconcileOrphanRouting: (...args: unknown[]) => mockReconcileRouting(...args),
}));

// Set env vars before importing handler
process.env.SESSIONS_TABLE_NAME = 'test-sessions-table';
process.env.ECS_CLUSTER_ARN = 'arn:aws:ecs:us-west-2:123456789:cluster/test-cluster';
process.env.ECS_SERVICE_NAME = 'test-warm-pool';
process.env.PREVIEW_DOMAIN = 'preview.vibe.test.dev';
process.env.PREVIEW_URL_TEMPLATE = 'https://{sessionId}.preview.vibe.test.dev/sandbox-preview/{sessionId}/';
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
    mockProvisionRouting.mockResolvedValue({ targetGroupArn: 'arn:tg/session', ruleArn: 'arn:rule/session' });
    mockTeardownRouting.mockResolvedValue(undefined);
    mockReconcileRouting.mockResolvedValue({ sessionRuleCount: 0, deletedRules: 0, deletedTargetGroups: 0 });
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
      // The preview runs generated code, so it is handed out on the untrusted
      // origin, never the app's.
      expect(body.previewUrl).toBe(
        `https://${body.sessionId}.preview.vibe.test.dev/sandbox-preview/${body.sessionId}/`,
      );
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
      // The replaced session's task is stopped, never handed to the next tenant.
      expect(stopCalled).toBe(true);
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
        expect(body.previewUrl).toBe('https://shared-session.preview.vibe.test.dev/sandbox-preview/shared-session/');
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
      // A reloading guest re-reads its preview location from here.
      expect(body.previewUrl).toBe('https://sess-1.preview.vibe.test.dev/sandbox-preview/sess-1/');
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

        // Persisted under its own key in the sessions table. Hashing and expiry
        // are covered under 'Sev2 — invite authorization' below.
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
            // The project is only granted if the inviter owns it.
            if (cmd.input?.TableName === 'test-projects') {
              return { Item: { projectId: { S: 'proj-42' }, sk: { S: 'META' }, ownerId: { S: 'user-123' } } };
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

    /**
     * Routing derives only from the server-assigned task. `/bind` let the owner
     * repoint their session at any address named in the request body, which an
     * attacker could aim at another tenant's container; it is gone.
     */
    describe('POST /session/{id}/bind (removed)', () => {
      it('cannot change routing or the stored assignment, whatever the body says', async () => {
        const writes: any[] = [];
        mockDynamoSend.mockImplementation((cmd: any) => {
          if (cmd._type === 'GetItem') {
            return { Item: ownedSession({ privateIp: { S: '10.10.1.50' } }) };
          }
          if (cmd._type !== 'Query' && cmd._type !== 'Scan') writes.push(cmd);
          return {};
        });

        const event = apiEvent(
          'POST',
          '/session/sess-1/bind',
          // An address belonging to another tenant's container.
          { containerId: 'ip-10-10-2-155.us-west-2.compute.internal', privateIp: '10.10.2.155' },
          { id: 'sess-1' },
          'user-123',
        );
        const result = await handler(event);

        expect((result as any).statusCode).toBe(404);
        expect(writes).toEqual([]);
        expect(mockProvisionRouting).not.toHaveBeenCalled();
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
     * An invited collaborator stays a member once in, the way a shared document
     * works, but the link that lets them in is single-use, time-limited and
     * revocable. Expiry and revocation are covered under 'Sev2 — invite
     * authorization' below; these cover single use.
     */
    describe('single-use invite links', () => {
      const inviteItem = (overrides: Record<string, any> = {}): Record<string, any> => ({
        sessionId: { S: 'INVITE#tok-1' },
        inviteSessionId: { S: 'sess-1' },
        invitedBy: { S: 'user-123' },
        role: { S: 'editor' },
        createdAt: { N: String(Date.now()) },
        expiresAt: { N: String(futureTtl()) },
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

      it('redeems a link that has not expired', async () => {
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
          if (cmd._type === 'GetItem') {
            const key = String(cmd.input?.Key?.sessionId?.S ?? '');
            if (key.startsWith('INVITE#')) {
              return {
                Item: {
                  sessionId: { S: key },
                  inviteSessionId: { S: 'sess-1' },
                  invitedBy: { S: 'user-123' },
                  role: { S: 'editor' },
                  createdAt: { N: String(Date.now()) },
                  expiresAt: { N: String(futureTtl()) },
                },
              };
            }
            return { Item: ownedSession() };
          }
          if (cmd._type === 'DeleteItem') deletes.push(cmd.input);
          return {};
        });

        const result = await handler(revokeEvent('tok-1', 'user-123') as any);

        expect((result as any).statusCode).toBe(200);
        // Stored, and so deleted, under the token's hash rather than the token.
        const hashedKey = `INVITE#${createHash('sha256').update('tok-1').digest('hex')}`;
        expect(deletes.map((d) => d.Key?.sessionId?.S)).toContain(hashedKey);
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

/**
 * Sev2 security review: invite authorization.
 *
 * An invite is a bearer secret that widens access, so everything it grants has
 * to be checked against the authenticated identity of the person who minted it,
 * it has to lapse on its own, and revoking it has to take the access back.
 */
describe('Sev2 — invite authorization', () => {
  const hashed = (token: string) => `INVITE#${createHash('sha256').update(token).digest('hex')}`;

  const OWNER = 'user-123';
  const GUEST = 'user-guest';
  const STRANGER = 'user-stranger';

  const session = (overrides: Record<string, any> = {}) => ({
    sessionId: { S: 'sess-1' },
    userId: { S: OWNER },
    status: { S: 'ACTIVE' },
    taskArn: { S: 'arn:aws:ecs:us-west-2:123:task/task-1' },
    privateIp: { S: '10.10.1.50' },
    createdAt: { N: '1000' },
    lastActivity: { N: '2000' },
    expiresAt: { N: '9000' },
    ...overrides,
  });

  const projectMeta = (projectId: string, ownerId: string) => ({
    projectId: { S: projectId },
    sk: { S: 'META' },
    ownerId: { S: ownerId },
  });

  const invite = (overrides: Record<string, any> = {}) => ({
    sessionId: { S: hashed('tok-1') },
    inviteSessionId: { S: 'sess-1' },
    invitedBy: { S: OWNER },
    role: { S: 'editor' },
    createdAt: { N: String(Date.now()) },
    expiresAt: { N: String(Math.floor(Date.now() / 1000) + 3600) },
    ...overrides,
  });

  interface World {
    sessions?: Record<string, any>;
    invites?: Record<string, any>;
    projects?: Record<string, any>;
  }

  /** A tiny in-memory stand-in for the two tables, recording every write. */
  function world(state: World) {
    const writes: any[] = [];
    const sessions = state.sessions ?? { 'sess-1': session() };
    const invites = state.invites ?? {};
    const projects = state.projects ?? {};

    mockDynamoSend.mockImplementation((cmd: any) => {
      const input = cmd.input ?? {};
      const table = input.TableName;
      const key = String(input.Key?.sessionId?.S ?? '');

      if (cmd._type === 'GetItem') {
        if (table === 'test-projects') {
          const item = projects[input.Key?.projectId?.S];
          return item && input.Key?.sk?.S === 'META' ? { Item: item } : {};
        }
        if (key.startsWith('INVITE#')) return invites[key] ? { Item: invites[key] } : {};
        return sessions[key] ? { Item: sessions[key] } : {};
      }

      if (cmd._type !== 'Query' && cmd._type !== 'Scan') writes.push(cmd);
      return {};
    });

    return writes;
  }

  const projectWrites = (writes: any[]) => writes.filter((w) => w.input?.TableName === 'test-projects');
  const memberGrants = (writes: any[]) =>
    writes.filter(
      (w) =>
        (w._type === 'UpdateItem' && String(w.input?.UpdateExpression).includes('list_append')) ||
        (w._type === 'PutItem' && String(w.input?.Item?.sk?.S ?? '').startsWith('MEMBER#')),
    );

  const mint = (body: any, userId = OWNER) =>
    handler(apiEvent('POST', '/session/sess-1/invite', body, { id: 'sess-1' }, userId));
  const join = (userId: string, token = 'tok-1') =>
    handler(apiEvent('POST', '/session/join', { token }, undefined, userId));
  const revoke = (token: string, userId = OWNER, sessionId = 'sess-1') =>
    handler({
      ...apiEvent('DELETE', `/session/${sessionId}/invite`, null, { id: sessionId }, userId),
      queryStringParameters: { token },
    } as any);

  beforeEach(() => jest.clearAllMocks());

  describe('foreign-project grants', () => {
    it('refuses to mint an invite carrying a project the caller does not own', async () => {
      const writes = world({ projects: { 'proj-victim': projectMeta('proj-victim', STRANGER) } });

      const result = await mint({ projectId: 'proj-victim' });

      expect((result as any).statusCode).toBe(403);
      expect(writes.filter((w) => w._type === 'PutItem')).toHaveLength(0);
    });

    it('mints an invite carrying a project the caller owns', async () => {
      const writes = world({ projects: { 'proj-mine': projectMeta('proj-mine', OWNER) } });

      const result = await mint({ projectId: 'proj-mine' });

      expect((result as any).statusCode).toBe(201);
      const put = writes.find((w) => w._type === 'PutItem');
      expect(put.input.Item.inviteProjectId.S).toBe('proj-mine');
    });

    it('drops a project that does not exist rather than letting the invite claim it later', async () => {
      const writes = world({});

      const result = await mint({ projectId: 'proj-not-yet-created' });

      expect((result as any).statusCode).toBe(201);
      const put = writes.find((w) => w._type === 'PutItem');
      // (The marshall mock keeps undefined keys, so look at the value.)
      expect(put.input.Item.inviteProjectId?.S).toBeUndefined();
    });

    it('rejects a non-string projectId', async () => {
      const writes = world({});

      const result = await mint({ projectId: { $ne: null } });

      expect((result as any).statusCode).toBe(400);
      expect(writes).toHaveLength(0);
    });

    it('does not grant a project on redeem unless the inviter still owns it', async () => {
      // An invite minted before ownership was checked can carry anyone's project.
      const writes = world({
        invites: { [hashed('tok-1')]: invite({ inviteProjectId: { S: 'proj-victim' } }) },
        projects: { 'proj-victim': projectMeta('proj-victim', STRANGER) },
      });

      const result = await join(GUEST);

      expect((result as any).statusCode).toBe(200);
      expect(JSON.parse((result as any).body).projectId).toBeUndefined();
      expect(projectWrites(writes)).toHaveLength(0);
    });

    it('refuses to redeem an invite minted by someone who does not own the session', async () => {
      const writes = world({
        invites: { [hashed('tok-1')]: invite({ invitedBy: { S: STRANGER } }) },
      });

      const result = await join(GUEST);

      expect((result as any).statusCode).toBe(403);
      expect(memberGrants(writes)).toHaveLength(0);
    });

    it('grants the inviter-owned project on a first redemption', async () => {
      const writes = world({
        invites: { [hashed('tok-1')]: invite({ inviteProjectId: { S: 'proj-mine' } }) },
        projects: { 'proj-mine': projectMeta('proj-mine', OWNER) },
      });

      const result = await join(GUEST);

      expect((result as any).statusCode).toBe(200);
      expect(JSON.parse((result as any).body).projectId).toBe('proj-mine');
      const grant = projectWrites(writes).find((w) => w._type === 'PutItem');
      expect(grant.input.Item.sk.S).toBe(`MEMBER#${GUEST}`);
    });

    it('does not re-grant a project to an existing member, so an owner removing them sticks', async () => {
      const writes = world({
        sessions: { 'sess-1': session({ members: { L: [{ S: GUEST }] } }) },
        invites: {
          [hashed('tok-1')]: invite({ inviteProjectId: { S: 'proj-mine' }, redeemedBy: { S: GUEST } }),
        },
        projects: { 'proj-mine': projectMeta('proj-mine', OWNER) },
      });

      const result = await join(GUEST);

      expect((result as any).statusCode).toBe(200);
      expect(projectWrites(writes)).toHaveLength(0);
    });
  });

  describe('expiry and storage', () => {
    it('stores the invite under a hash of the token, never the token itself', async () => {
      const writes = world({});

      const result = await mint({});
      const { token } = JSON.parse((result as any).body);
      const put = writes.find((w) => w._type === 'PutItem');

      expect(put.input.Item.sessionId.S).toBe(hashed(token));
      expect(JSON.stringify(put.input)).not.toContain(token);
    });

    it('mints a high-entropy token', async () => {
      world({});

      const { token } = JSON.parse(((await mint({})) as any).body);

      // 32 random bytes, base64url-encoded.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('gives every new invite a server-side expiry between 24 hours and 7 days', async () => {
      const writes = world({});

      const result = await mint({});
      const body = JSON.parse((result as any).body);
      const put = writes.find((w) => w._type === 'PutItem');
      const ttl = Number(put.input.Item.expiresAt.N) - Math.floor(Date.now() / 1000);

      expect(ttl).toBeGreaterThanOrEqual(24 * 3600 - 5);
      expect(ttl).toBeLessThanOrEqual(7 * 24 * 3600);
      expect(body.expiresAt).toBe(Number(put.input.Item.expiresAt.N));
    });

    it('refuses an expired invite even if TTL deletion has not caught up', async () => {
      const writes = world({
        invites: { [hashed('tok-1')]: invite({ expiresAt: { N: String(Math.floor(Date.now() / 1000) - 1) } }) },
      });

      expect(((await join(GUEST)) as any).statusCode).toBe(403);
      expect(memberGrants(writes)).toHaveLength(0);
    });

    it('expires a legacy invite that was stored without an expiry', async () => {
      const legacy: Record<string, any> = invite({
        sessionId: { S: 'INVITE#tok-1' },
        createdAt: { N: String(Date.now() - 8 * 24 * 3600 * 1000) },
      });
      delete legacy.expiresAt;
      const writes = world({ invites: { 'INVITE#tok-1': legacy } });

      const result = await join(GUEST);

      expect((result as any).statusCode).toBe(403);
      expect(memberGrants(writes)).toHaveLength(0);
    });

    it('still honours a recent legacy invite stored under the raw token', async () => {
      const legacy: Record<string, any> = invite({ sessionId: { S: 'INVITE#tok-1' } });
      delete legacy.expiresAt;
      const writes = world({ invites: { 'INVITE#tok-1': legacy } });

      const result = await join(GUEST);

      expect((result as any).statusCode).toBe(200);
      const claim = writes.find((w) => w._type === 'UpdateItem' && String(w.input.UpdateExpression).includes('redeemedBy'));
      expect(claim.input.Key.sessionId.S).toBe('INVITE#tok-1');
    });

    it('refuses an invite that has been revoked but not yet deleted', async () => {
      const writes = world({
        invites: { [hashed('tok-1')]: invite({ revokedAt: { N: String(Date.now()) } }) },
      });

      expect(((await join(GUEST)) as any).statusCode).toBe(403);
      expect(memberGrants(writes)).toHaveLength(0);
    });

    it('makes the claim conditional on the invite being unrevoked and unexpired, so a revoke cannot race a join', async () => {
      const writes = world({ invites: { [hashed('tok-1')]: invite() } });

      await join(GUEST);

      const claim = writes.find((w) => w._type === 'UpdateItem' && String(w.input.UpdateExpression).includes('redeemedBy'));
      expect(claim.input.Key.sessionId.S).toBe(hashed('tok-1'));
      expect(claim.input.ConditionExpression).toContain('attribute_not_exists(revokedAt)');
      expect(claim.input.ConditionExpression).toContain('expiresAt');
    });
  });

  describe('effective revocation', () => {
    it('removes the redeemer from the session and the project when a redeemed invite is revoked', async () => {
      const writes = world({
        sessions: { 'sess-1': session({ members: { L: [{ S: GUEST }, { S: 'user-other' }] } }) },
        invites: {
          [hashed('tok-1')]: invite({ inviteProjectId: { S: 'proj-mine' }, redeemedBy: { S: GUEST } }),
        },
        projects: { 'proj-mine': projectMeta('proj-mine', OWNER) },
      });

      const result = await revoke('tok-1');

      expect((result as any).statusCode).toBe(200);

      const markRevoked = writes.findIndex(
        (w) => w._type === 'UpdateItem' && String(w.input.UpdateExpression).includes('revokedAt'),
      );
      const memberUpdate = writes.find(
        (w) =>
          w._type === 'UpdateItem' &&
          w.input.Key.sessionId?.S === 'sess-1' &&
          String(w.input.UpdateExpression).includes('members'),
      );
      const projectRemoval = projectWrites(writes).find((w) => w._type === 'DeleteItem');
      const inviteDelete = writes.findIndex(
        (w) => w._type === 'DeleteItem' && w.input.Key.sessionId?.S === hashed('tok-1'),
      );

      expect(markRevoked).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(memberUpdate.input.ExpressionAttributeValues[':next'].S)).toEqual(['user-other']);
      expect(projectRemoval.input.Key.sk.S).toBe(`MEMBER#${GUEST}`);
      expect(inviteDelete).toBeGreaterThan(markRevoked);
    });

    it('does not touch an invite that belongs to a different session', async () => {
      const writes = world({
        sessions: {
          'sess-1': session(),
          'sess-2': session({ sessionId: { S: 'sess-2' }, userId: { S: STRANGER } }),
        },
        invites: {
          [hashed('tok-1')]: invite({
            inviteSessionId: { S: 'sess-2' },
            invitedBy: { S: STRANGER },
            redeemedBy: { S: GUEST },
          }),
        },
      });

      const result = await revoke('tok-1', OWNER, 'sess-1');

      expect((result as any).statusCode).toBe(200);
      expect(writes).toHaveLength(0);
    });

    it('refuses a non-owner revoke with no state change', async () => {
      const writes = world({
        sessions: { 'sess-1': session({ members: { L: [{ S: GUEST }] } }) },
        invites: { [hashed('tok-1')]: invite({ redeemedBy: { S: GUEST } }) },
      });

      const result = await revoke('tok-1', STRANGER);

      expect((result as any).statusCode).toBe(403);
      expect(writes).toHaveLength(0);
    });

    it('never logs the authorizer context, which can carry token material', async () => {
      const logged: string[] = [];
      const capture = (...args: unknown[]) => logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      const spies = [
        jest.spyOn(console, 'log').mockImplementation(capture),
        jest.spyOn(console, 'warn').mockImplementation(capture),
        jest.spyOn(console, 'error').mockImplementation(capture),
      ];

      try {
        const result = await handler({
          ...apiEvent('GET', '/session/sess-1', null, { id: 'sess-1' }),
          requestContext: { authorizer: { idToken: 'eyJ.secret-token-material.sig' } },
        } as any);

        expect((result as any).statusCode).toBe(401);
        expect(logged.join('\n')).not.toContain('secret-token-material');
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it('does not log invite tokens or signed URLs while minting, joining and revoking', async () => {
      const logged: string[] = [];
      const capture = (...args: unknown[]) => logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      const spies = [
        jest.spyOn(console, 'log').mockImplementation(capture),
        jest.spyOn(console, 'warn').mockImplementation(capture),
        jest.spyOn(console, 'error').mockImplementation(capture),
      ];

      try {
        world({ invites: { [hashed('tok-secret')]: invite({ sessionId: { S: hashed('tok-secret') } }) } });
        const minted = JSON.parse(((await mint({})) as any).body).token;
        const joined = JSON.parse(((await join(GUEST, 'tok-secret')) as any).body);
        await revoke('tok-secret');

        const all = logged.join('\n');
        expect(all).not.toContain(minted);
        expect(all).not.toContain('tok-secret');
        expect(all).not.toContain('Signature=');
        expect(joined.wsUrl).toContain('Signature=');
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });

    it('stops a removed member from obtaining a fresh signed URL', async () => {
      world({ sessions: { 'sess-1': session({ members: { L: [{ S: 'user-other' }] } }) } });

      const result = await handler(apiEvent('GET', '/session/sess-1', null, { id: 'sess-1' }, GUEST));

      expect((result as any).statusCode).toBe(403);
      expect(JSON.parse((result as any).body).wsUrl).toBeUndefined();
    });
  });
});


/**
 * Session lifetime bookkeeping (Sev2 SOC D550368291). Prod leaked ALB rules
 * until the listener hit its quota: records expired by TTL while still live, the
 * reaper only looked at ACTIVE sessions, and a failure part-way through stopping
 * a session skipped the routing teardown.
 */
describe('Session lifetime bookkeeping', () => {
  const TASK = 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1';

  const record = (overrides: Record<string, any> = {}) => ({
    sessionId: { S: 'sess-1' },
    userId: { S: 'user-123' },
    status: { S: 'ACTIVE' },
    taskArn: { S: TASK },
    privateIp: { S: '10.10.1.50' },
    createdAt: { N: '1000' },
    lastActivity: { N: '1000' },
    expiresAt: { N: '9000' },
    ...overrides,
  });

  const scheduled = { source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProvisionRouting.mockResolvedValue({ targetGroupArn: 'arn:tg/session', ruleArn: 'arn:rule/session' });
    mockTeardownRouting.mockResolvedValue(undefined);
    mockReconcileRouting.mockResolvedValue({ sessionRuleCount: 0, deletedRules: 0, deletedTargetGroups: 0 });
    mockEcsSend.mockImplementation(() => ({}));
  });

  describe('heartbeat', () => {
    it('extends the session TTL and the task claim lock TTL, not just lastActivity', async () => {
      const updates: any[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') return { Item: record() };
        if (cmd._type === 'UpdateItem') updates.push(cmd.input);
        return {};
      });

      const before = Math.floor(Date.now() / 1000);
      const result = await handler(apiEvent('POST', '/session/sess-1/heartbeat', null, { id: 'sess-1' }));
      expect((result as any).statusCode).toBe(200);

      const sessionUpdate = updates.find((u) => u.Key.sessionId.S === 'sess-1');
      expect(sessionUpdate.UpdateExpression).toContain('expiresAt');
      expect(Number(sessionUpdate.ExpressionAttributeValues[':expiresAt'].N)).toBeGreaterThan(before + 60 * 60);

      const lockUpdate = updates.find((u) => u.Key.sessionId.S === `TASK#${TASK}`);
      expect(lockUpdate).toBeDefined();
      expect(lockUpdate.UpdateExpression).toContain('expiresAt');
      // Never create a lock that is not there: only extend an existing one.
      expect(lockUpdate.ConditionExpression).toContain('attribute_exists');
    });
  });

  describe('cleanup cron', () => {
    it('reaps idle ACTIVE sessions and stuck PENDING and STOPPING ones', async () => {
      let scanInput: any;
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Scan') {
          scanInput = cmd.input;
          return {
            Items: [
              record({ sessionId: { S: 'idle-active' } }),
              record({ sessionId: { S: 'stuck-pending' }, status: { S: 'PENDING' }, taskArn: { S: '' } }),
              record({ sessionId: { S: 'stuck-stopping' }, status: { S: 'STOPPING' } }),
            ],
          };
        }
        return {};
      });

      await handler(scheduled);

      const values = JSON.stringify(scanInput.ExpressionAttributeValues);
      expect(values).toContain('PENDING');
      expect(values).toContain('STOPPING');
      expect(mockTeardownRouting.mock.calls.map((c) => c[0]).sort()).toEqual(
        ['idle-active', 'stuck-pending', 'stuck-stopping'].sort(),
      );
    });

    it('still tears down routing when stopping the task fails, and leaves the session for a retry', async () => {
      const statuses: string[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Scan') return { Items: [record({ sessionId: { S: 'idle-1' } })] };
        if (cmd._type === 'UpdateItem' && cmd.input.ExpressionAttributeValues?.[':status']) {
          statuses.push(cmd.input.ExpressionAttributeValues[':status'].S);
        }
        return {};
      });
      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'StopTask') throw new Error('Throttled');
        return {};
      });

      await handler(scheduled);

      expect(mockTeardownRouting).toHaveBeenCalledWith('idle-1');
      // Not marked STOPPED, so the next run (which now includes STOPPING) retries.
      expect(statuses).toContain('STOPPING');
      expect(statuses).not.toContain('STOPPED');
    });

    it('keeps going after one session fails', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Scan') {
          return { Items: [record({ sessionId: { S: 'bad' } }), record({ sessionId: { S: 'good' } })] };
        }
        if (cmd._type === 'UpdateItem' && cmd.input.Key?.sessionId?.S === 'bad') throw new Error('boom');
        return {};
      });

      await handler(scheduled);

      expect(mockTeardownRouting).toHaveBeenCalledWith('bad');
      expect(mockTeardownRouting).toHaveBeenCalledWith('good');
    });
  });

  describe('DELETE /session/{id}', () => {
    it('tears down routing even when stopping the task fails', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => (cmd._type === 'GetItem' ? { Item: record() } : {}));
      mockEcsSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'StopTask') throw new Error('Throttled');
        return {};
      });

      await handler(apiEvent('DELETE', '/session/sess-1', null, { id: 'sess-1' }));

      expect(mockTeardownRouting).toHaveBeenCalledWith('sess-1');
    });

    it('records when the session stopped, so reconciliation can age it', async () => {
      const updates: any[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') return { Item: record() };
        if (cmd._type === 'UpdateItem') updates.push(cmd.input);
        return {};
      });

      await handler(apiEvent('DELETE', '/session/sess-1', null, { id: 'sess-1' }));

      const stopped = updates.find((u) => u.ExpressionAttributeValues?.[':status']?.S === 'STOPPED');
      expect(stopped.UpdateExpression).toContain('statusChangedAt');
    });
  });
});

/**
 * One task, one session (Sev2 SOC D550368291). A task is tagged with its session
 * before the URL is signed, is never claimed again, and is stopped — not handed
 * on — when its session ends. A claim that fails part way leaves nothing behind.
 */
describe('Single-tenant task lifecycle', () => {
  const TASK_1 = 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-1';
  const TASK_2 = 'arn:aws:ecs:us-west-2:123:task/test-cluster/task-2';

  const task = (taskArn: string, ip: string, tags: Array<{ key: string; value: string }> = []) => ({
    taskArn,
    lastStatus: 'RUNNING',
    containers: [{ networkInterfaces: [{ privateIpv4Address: ip }] }],
    attachments: [{ type: 'ElasticNetworkInterface', details: [{ name: 'privateIPv4Address', value: ip }] }],
    tags,
  });

  let ecsCalls: any[];
  let dynamoCalls: any[];

  function mockPool(tasks: ReturnType<typeof task>[], overrides: Record<string, (cmd: any) => any> = {}) {
    mockEcsSend.mockImplementation((cmd: any) => {
      ecsCalls.push(cmd);
      if (overrides[cmd._type]) return overrides[cmd._type](cmd);
      if (cmd._type === 'ListTasks') return { taskArns: tasks.map((t) => t.taskArn) };
      if (cmd._type === 'DescribeTasks') return { tasks };
      return {};
    });
  }

  function mockTable(existing?: Record<string, any>, overrides: Record<string, (cmd: any) => any> = {}) {
    mockDynamoSend.mockImplementation((cmd: any) => {
      dynamoCalls.push(cmd);
      if (overrides[cmd._type]) return overrides[cmd._type](cmd);
      if (cmd._type === 'Query') {
        return cmd.input?.IndexName === 'byUserId' && existing ? { Items: [existing] } : { Items: [] };
      }
      return {};
    });
  }

  const statusWrites = () =>
    dynamoCalls
      .filter((c) => c._type === 'UpdateItem' && c.input.ExpressionAttributeValues?.[':status'])
      .map((c) => c.input.ExpressionAttributeValues[':status'].S);

  beforeEach(() => {
    jest.clearAllMocks();
    ecsCalls = [];
    dynamoCalls = [];
    mockProvisionRouting.mockResolvedValue({ targetGroupArn: 'arn:tg/session', ruleArn: 'arn:rule/session' });
    mockTeardownRouting.mockResolvedValue(undefined);
    mockReconcileRouting.mockResolvedValue({ sessionRuleCount: 0, deletedRules: 0, deletedTargetGroups: 0 });
  });

  it('tags the claimed task with its session', async () => {
    mockTable();
    mockPool([task(TASK_1, '10.10.1.50')]);

    const result = await handler(apiEvent('POST', '/session'));
    const body = JSON.parse((result as any).body);

    expect((result as any).statusCode).toBe(201);
    const tag = ecsCalls.find((c) => c._type === 'TagResource');
    expect(tag.input).toEqual({
      resourceArn: TASK_1,
      tags: [{ key: 'SandboxSession', value: body.sessionId }],
    });
  });

  it('reads task tags when choosing a task', async () => {
    mockTable();
    mockPool([task(TASK_1, '10.10.1.50')]);

    await handler(apiEvent('POST', '/session'));

    expect(ecsCalls.find((c) => c._type === 'DescribeTasks').input.include).toEqual(['TAGS']);
  });

  it('never signs a URL if tagging the task fails, and releases what it claimed', async () => {
    mockTable();
    mockPool([task(TASK_1, '10.10.1.50')], {
      TagResource: () => {
        throw new Error('AccessDenied');
      },
    });

    const result = await handler(apiEvent('POST', '/session'));
    const body = JSON.parse((result as any).body);

    expect((result as any).statusCode).toBe(503);
    expect(body.wsUrl).toBeUndefined();
    expect(ecsCalls.some((c) => c._type === 'StopTask' && c.input.task === TASK_1)).toBe(true);
    expect(mockTeardownRouting).toHaveBeenCalled();
  });

  it('never claims a task that was ever claimed before, even with no claim record left', async () => {
    mockTable();
    mockPool([
      task(TASK_1, '10.10.1.50', [{ key: 'SandboxSession', value: 'previous-tenant' }]),
      task(TASK_2, '10.10.1.51'),
    ]);

    const result = await handler(apiEvent('POST', '/session'));

    expect((result as any).statusCode).toBe(201);
    expect(ecsCalls.find((c) => c._type === 'TagResource').input.resourceArn).toBe(TASK_2);
    expect(mockProvisionRouting).toHaveBeenCalledWith(expect.any(String), '10.10.1.51');
  });

  it('returns 503 when every running task has been used', async () => {
    mockTable();
    mockPool([task(TASK_1, '10.10.1.50', [{ key: 'SandboxSession', value: 'previous-tenant' }])]);

    const result = await handler(apiEvent('POST', '/session'));

    expect((result as any).statusCode).toBe(503);
    expect(ecsCalls.some((c) => c._type === 'TagResource')).toBe(false);
  });

  it('fails closed when per-session routing cannot be created, tearing down the claim', async () => {
    mockTable();
    mockPool([task(TASK_1, '10.10.1.50')]);
    mockProvisionRouting.mockResolvedValue(null);

    const result = await handler(apiEvent('POST', '/session'));
    const body = JSON.parse((result as any).body);

    // No rule means no route to this container — and the shared route no longer
    // forwards anywhere — so handing out a URL would only fail, or worse.
    expect((result as any).statusCode).toBe(503);
    expect(body.wsUrl).toBeUndefined();
    expect(mockTeardownRouting).toHaveBeenCalled();
    expect(ecsCalls.some((c) => c._type === 'StopTask' && c.input.task === TASK_1)).toBe(true);
    expect(
      dynamoCalls.some((c) => c._type === 'DeleteItem' && c.input.Key.sessionId.S === `TASK#${TASK_1}`),
    ).toBe(true);
    expect(statusWrites()).toContain('STOPPED');
  });

  it('tears down routing when the claim race is lost', async () => {
    mockTable(undefined, {
      TransactWriteItems: () => {
        throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException' });
      },
    });
    mockPool([task(TASK_1, '10.10.1.50')]);

    const result = await handler(apiEvent('POST', '/session'));

    expect((result as any).statusCode).toBe(503);
    expect(mockTeardownRouting).toHaveBeenCalled();
    // Lost the race, so the task is someone else's: never stop it.
    expect(ecsCalls.some((c) => c._type === 'StopTask')).toBe(false);
  });

  it('tries the next task when the claim race on the first is lost', async () => {
    let transactions = 0;
    mockTable(undefined, {
      TransactWriteItems: () => {
        transactions++;
        if (transactions === 1) {
          throw Object.assign(new Error('Transaction cancelled'), { name: 'TransactionCanceledException' });
        }
        return {};
      },
    });
    mockPool([task(TASK_1, '10.10.1.50'), task(TASK_2, '10.10.1.51')]);

    const result = await handler(apiEvent('POST', '/session'));

    expect((result as any).statusCode).toBe(201);
    expect(ecsCalls.find((c) => c._type === 'TagResource').input.resourceArn).toBe(TASK_2);
  });

  it('stops the task of the session it replaces instead of keeping it for reuse', async () => {
    mockTable({
      sessionId: { S: 'old-session' },
      userId: { S: 'user-123' },
      taskArn: { S: TASK_1 },
      privateIp: { S: '10.10.1.50' },
      status: { S: 'ACTIVE' },
      createdAt: { N: '1000' },
      lastActivity: { N: '2000' },
      expiresAt: { N: '9000' },
    });
    mockPool([task(TASK_2, '10.10.1.51')]);

    const result = await handler(apiEvent('POST', '/session'));

    expect((result as any).statusCode).toBe(201);
    expect(ecsCalls.some((c) => c._type === 'StopTask' && c.input.task === TASK_1)).toBe(true);
    expect(mockTeardownRouting).toHaveBeenCalledWith('old-session');
  });
});

/**
 * Orphan reconciliation in the 5-minute cleanup: routing and tasks left behind by
 * sessions that ended without a clean teardown.
 */
describe('Cleanup reconciliation', () => {
  const scheduled = { source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} } as any;
  const MINUTE = 60 * 1000;

  const sessions: Record<string, Record<string, any>> = {
    live: { status: { S: 'ACTIVE' } },
    pending: { status: { S: 'PENDING' } },
    'just-stopped': { status: { S: 'STOPPED' }, statusChangedAt: { N: String(Date.now() - 2 * MINUTE) } },
    'long-stopped': { status: { S: 'STOPPED' }, statusChangedAt: { N: String(Date.now() - 30 * MINUTE) } },
    'legacy-stopped': { status: { S: 'STOPPED' } },
  };

  let ecsCalls: any[];

  beforeEach(() => {
    jest.clearAllMocks();
    ecsCalls = [];
    mockTeardownRouting.mockResolvedValue(undefined);
    mockReconcileRouting.mockResolvedValue({ sessionRuleCount: 42, deletedRules: 0, deletedTargetGroups: 0 });
    mockDynamoSend.mockImplementation((cmd: any) => {
      if (cmd._type === 'Scan') return { Items: [] };
      if (cmd._type === 'GetItem') {
        const id = cmd.input.Key.sessionId.S;
        const extra = sessions[id];
        return extra ? { Item: { sessionId: { S: id }, userId: { S: 'u' }, ...extra } } : {};
      }
      return {};
    });
    mockEcsSend.mockImplementation((cmd: any) => {
      ecsCalls.push(cmd);
      return {};
    });
  });

  it('asks routing reconciliation to delete only routing of missing or long-stopped sessions', async () => {
    await handler(scheduled);

    expect(mockReconcileRouting).toHaveBeenCalledTimes(1);
    const isOrphan = mockReconcileRouting.mock.calls[0][0] as (id: string) => Promise<boolean>;

    await expect(isOrphan('missing')).resolves.toBe(true);
    await expect(isOrphan('long-stopped')).resolves.toBe(true);
    await expect(isOrphan('legacy-stopped')).resolves.toBe(true);
    await expect(isOrphan('just-stopped')).resolves.toBe(false);
    await expect(isOrphan('live')).resolves.toBe(false);
    await expect(isOrphan('pending')).resolves.toBe(false);
  });

  it('treats a session lookup failure as not orphaned, so it never deletes on a guess', async () => {
    await handler(scheduled);
    const isOrphan = mockReconcileRouting.mock.calls[0][0] as (id: string) => Promise<boolean>;

    mockDynamoSend.mockImplementation(() => {
      throw new Error('Throttled');
    });

    await expect(isOrphan('anything')).resolves.toBe(false);
  });

  it('stops running tasks assigned to a session that is gone, and only those', async () => {
    const tagged = (arn: string, session?: string) => ({
      taskArn: arn,
      tags: session ? [{ key: 'SandboxSession', value: session }] : [],
    });
    mockEcsSend.mockImplementation((cmd: any) => {
      ecsCalls.push(cmd);
      if (cmd._type === 'ListTasks') return { taskArns: ['t-live', 't-gone', 't-warm'] };
      if (cmd._type === 'DescribeTasks') {
        return { tasks: [tagged('t-live', 'live'), tagged('t-gone', 'missing'), tagged('t-warm')] };
      }
      return {};
    });

    await handler(scheduled);

    const stopped = ecsCalls.filter((c) => c._type === 'StopTask').map((c) => c.input.task);
    expect(stopped).toEqual(['t-gone']);
  });

  it('publishes the per-session rule count so the quota can be alarmed on', async () => {
    // Read at call time, so it can be set for this test alone.
    process.env.METRIC_NAMESPACE = 'test/Sandbox';
    try {
      await handler(scheduled);
    } finally {
      delete process.env.METRIC_NAMESPACE;
    }

    const metrics = mockCwSend.mock.calls.flatMap((c: any[]) => c[0].input.MetricData ?? []);
    const ruleCount = metrics.find((m: any) => m.MetricName === 'SessionRuleCount');
    expect(ruleCount?.Value).toBe(42);
  });
});

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
      else result[key] = val;
    }
    return result;
  }),
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
process.env.ALB_DNS_NAME = 'test-alb.us-west-2.elb.amazonaws.com';

import { handler } from '../../lib/sandbox/session-manager-lambda/index';

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
});

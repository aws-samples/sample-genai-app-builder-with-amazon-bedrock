/**
 * Tests for the Projects Lambda handler — durable projects and chat history.
 * Uses mocked AWS SDK clients.
 */

// Mock AWS SDK before imports
const mockDynamoSend = jest.fn();

jest.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: jest.fn().mockImplementation(() => ({
      send: mockDynamoSend,
    })),
    PutItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'PutItem' })),
    GetItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'GetItem' })),
    UpdateItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'UpdateItem' })),
    QueryCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'Query' })),
    DeleteItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'DeleteItem' })),
    TransactWriteItemsCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'TransactWriteItems' })),
    BatchWriteItemCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'BatchWriteItem' })),
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
      else if (val.L) result[key] = val.L.map((entry: any) => entry.S ?? entry.N ?? entry);
      else result[key] = val;
    }
    return result;
  }),
}));

jest.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Parameter: { Value: '' } }),
  })),
  GetParameterCommand: jest.fn().mockImplementation((input) => ({ input, _type: 'GetParameter' })),
}), { virtual: true });

// Set env vars before importing handler
process.env.PROJECTS_TABLE_NAME = 'test-projects-table';

// Retries are exercised for their sequencing, not their wall-clock delay.
process.env.PROJECTS_WRITE_RETRY_BASE_MS = '0';

import { handler } from '../../lib/projects/projects-lambda/index';

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
function unauthEvent(method: string, path: string, body?: any, pathParams?: Record<string, string>) {
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
    requestContext: {} as any,
    resource: '',
  };
}

const metaItem = (overrides: Record<string, any> = {}) => ({
  projectId: { S: 'proj-1' },
  sk: { S: 'META' },
  ownerId: { S: 'user-123' },
  urlId: { S: 'my-app' },
  description: { S: 'My app' },
  createdAt: { N: '1000' },
  updatedAt: { N: '2000' },
  expiresAt: { N: '9000' },
  ...overrides,
});

const memberItem = (userId: string, role = 'editor') => ({
  projectId: { S: 'proj-1' },
  sk: { S: `MEMBER#${userId}` },
  userId: { S: userId },
  role: { S: role },
  addedAt: { N: '1500' },
  expiresAt: { N: '9000' },
});

/**
 * Route the two GetItem shapes the handler issues — the META read and the
 * membership read — off the sort key, so a test only has to say who is a member.
 */
function respondForProject(options: {
  meta?: Record<string, any> | null;
  members?: string[];
  onCommand?: (cmd: any) => void;
} = {}) {
  const { meta = metaItem(), members = [], onCommand } = options;

  return (cmd: any) => {
    onCommand?.(cmd);

    if (cmd._type === 'GetItem') {
      const sk = cmd.input?.Key?.sk?.S ?? '';

      if (sk === 'META') {
        return meta ? { Item: meta } : {};
      }

      const userId = sk.replace('MEMBER#', '');
      return members.includes(userId) ? { Item: memberItem(userId) } : {};
    }

    // byUrlId lookup, or the message/partition queries.
    if (cmd._type === 'Query') {
      if (cmd.input?.IndexName === 'byUrlId') {
        return meta ? { Items: [meta] } : { Items: [] };
      }
      return { Items: [] };
    }

    return {};
  };
}

describe('Projects Lambda', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /projects — create', () => {
    it('writes META and an owner MEMBER item in one transaction', async () => {
      const transacts: any[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'TransactWriteItems') transacts.push(cmd.input);
        return {};
      });

      const event = apiEvent('POST', '/projects', { urlId: 'my-app', description: 'My app' });
      const result = await handler(event);

      expect((result as any).statusCode).toBe(201);
      const body = JSON.parse((result as any).body);
      expect(body.project.projectId).toBeDefined();
      expect(body.project.ownerId).toBe('user-123');
      expect(body.project.urlId).toBe('my-app');

      expect(transacts).toHaveLength(1);
      const written = transacts[0].TransactItems.map((i: any) => i.Put.Item.sk.S);
      expect(written).toContain('META');
      expect(written).toContain('MEMBER#user-123');
    });

    /**
     * `expiresAt` is the projects table's TTL attribute, and `touchProject` only
     * ever refreshes META — so an owner's membership row used to age out 90 days
     * after the project was created however much work went into it. Membership is
     * permanent for everyone now, which is also what the invite links promise.
     */
    it('writes membership rows with no TTL, so nobody silently loses access', async () => {
      const transacts: any[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'TransactWriteItems') transacts.push(cmd.input);
        return {};
      });

      await handler(apiEvent('POST', '/projects', { id: 'proj-1' }, undefined, 'user-123'));

      const memberPut = transacts[0].TransactItems.map((i: any) => i.Put).find(
        (put: any) => put.Item.sk.S === 'MEMBER#user-123',
      );
      expect(memberPut.Item.expiresAt).toBeUndefined();

      // The project itself still ages out on the 90-day TTL it always had.
      const metaPut = transacts[0].TransactItems.map((i: any) => i.Put).find(
        (put: any) => put.Item.sk.S === 'META',
      );
      expect(Number(metaPut.Item.expiresAt.N)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('honours a client-supplied id, so a local project keeps the id its URL uses', async () => {
      const transacts: any[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'TransactWriteItems') transacts.push(cmd.input);
        return {};
      });

      const result = await handler(apiEvent('POST', '/projects', { id: 'local-42' }));

      expect((result as any).statusCode).toBe(201);
      expect(JSON.parse((result as any).body).project.projectId).toBe('local-42');
      expect(transacts[0].TransactItems[0].Put.Item.projectId.S).toBe('local-42');
    });

    it('attributes the project to the caller, not to a body-supplied owner', async () => {
      mockDynamoSend.mockImplementation(() => ({}));

      const event = apiEvent(
        'POST',
        '/projects',
        { id: 'proj-1', ownerId: 'user-attacker' } as any,
        undefined,
        'user-real',
      );
      const result = await handler(event);

      expect(JSON.parse((result as any).body).project.ownerId).toBe('user-real');
    });

    it('is idempotent when the owner re-creates a project migration already sent', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'TransactWriteItems') {
          const err: any = new Error('Transaction cancelled');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }];
          throw err;
        }
        if (cmd._type === 'GetItem') return { Item: metaItem() };
        return {};
      });

      const result = await handler(apiEvent('POST', '/projects', { id: 'proj-1' }, undefined, 'user-123'));

      expect((result as any).statusCode).toBe(200);
      expect(JSON.parse((result as any).body).project.projectId).toBe('proj-1');
    });

    it('refuses to hand an existing project to someone who is not its owner', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'TransactWriteItems') {
          const err: any = new Error('Transaction cancelled');
          err.name = 'TransactionCanceledException';
          err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }];
          throw err;
        }
        if (cmd._type === 'GetItem') return { Item: metaItem() };
        return {};
      });

      const result = await handler(
        apiEvent('POST', '/projects', { id: 'proj-1' }, undefined, 'user-squatter'),
      );

      expect((result as any).statusCode).toBe(409);
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(unauthEvent('POST', '/projects', { id: 'proj-1' }));

      expect((result as any).statusCode).toBe(401);
    });
  });

  describe('GET /projects — list', () => {
    it('returns only the caller own projects, metadata without messages', async () => {
      const queries: any[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'Query') {
          queries.push(cmd.input);
          return { Items: [metaItem(), metaItem({ projectId: { S: 'proj-2' }, urlId: { S: 'other' } })] };
        }
        return {};
      });

      const result = await handler(apiEvent('GET', '/projects', null, undefined, 'user-123'));

      expect((result as any).statusCode).toBe(200);
      const body = JSON.parse((result as any).body);
      expect(body.projects).toHaveLength(2);
      expect(body.projects[0].messages).toBeUndefined();

      // Scoped to the caller by the partition key of the byOwner index, so
      // another user's projects are not merely filtered out — they are never read.
      expect(queries[0].IndexName).toBe('byOwner');
      expect(queries[0].ExpressionAttributeValues[':ownerId'].S).toBe('user-123');
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(unauthEvent('GET', '/projects'));

      expect((result as any).statusCode).toBe(401);
    });
  });

  describe('GET /projects/{id} — read', () => {
    it('returns the project with its messages in ascending order', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') return { Item: metaItem() };
        if (cmd._type === 'Query') {
          return {
            Items: [
              {
                projectId: { S: 'proj-1' },
                sk: { S: 'MSG#000000000001000#m1' },
                id: { S: 'm1' },
                role: { S: 'user' },
                content: { S: 'first' },
                authorId: { S: 'user-123' },
                createdAt: { N: '1000' },
              },
              {
                projectId: { S: 'proj-1' },
                sk: { S: 'MSG#000000000002000#m2' },
                id: { S: 'm2' },
                role: { S: 'assistant' },
                content: { S: 'second' },
                authorId: { S: 'user-123' },
                createdAt: { N: '2000' },
              },
            ],
          };
        }
        return {};
      });

      const result = await handler(apiEvent('GET', '/projects/proj-1', null, { id: 'proj-1' }));

      expect((result as any).statusCode).toBe(200);
      const body = JSON.parse((result as any).body);
      expect(body.project.projectId).toBe('proj-1');
      expect(body.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);

      const messageQuery = mockDynamoSend.mock.calls
        .map(([cmd]) => cmd)
        .find((cmd: any) => cmd._type === 'Query' && !cmd.input?.IndexName);
      expect(messageQuery.input.ScanIndexForward).toBe(true);
    });

    it('resolves a urlId, since chat URLs route on that and not the project id', async () => {
      const queries: any[] = [];
      mockDynamoSend.mockImplementation((cmd: any) => {
        // No project under that key — the path segment is a urlId.
        if (cmd._type === 'GetItem') return {};
        if (cmd._type === 'Query') {
          queries.push(cmd.input);
          if (cmd.input?.IndexName === 'byUrlId') return { Items: [metaItem()] };
          return { Items: [] };
        }
        return {};
      });

      const result = await handler(apiEvent('GET', '/projects/my-app', null, { id: 'my-app' }));

      expect((result as any).statusCode).toBe(200);
      expect(JSON.parse((result as any).body).project.projectId).toBe('proj-1');
      expect(queries.some((q) => q.IndexName === 'byUrlId')).toBe(true);
    });

    it('lets an invited member read the conversation', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('GET', '/projects/proj-1', null, { id: 'proj-1' }, 'user-guest'),
      );

      expect((result as any).statusCode).toBe(200);
    });

    it('refuses a stranger who is neither owner nor member', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('GET', '/projects/proj-1', null, { id: 'proj-1' }, 'user-stranger'),
      );

      expect((result as any).statusCode).toBe(403);
      expect(JSON.parse((result as any).body).error).toBe('Forbidden');
    });

    it('returns 404 for an unknown project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ meta: null }));

      const result = await handler(apiEvent('GET', '/projects/nope', null, { id: 'nope' }));

      expect((result as any).statusCode).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(unauthEvent('GET', '/projects/proj-1', null, { id: 'proj-1' }));

      expect((result as any).statusCode).toBe(401);
    });
  });

  describe('POST /projects/{id}/messages — append', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'hello', createdAt: 1000 },
      { id: 'm2', role: 'assistant', content: 'hi', createdAt: 2000 },
    ];

    const capturedPuts = (calls: any[][]) =>
      calls
        .map(([cmd]) => cmd)
        .filter((cmd: any) => cmd._type === 'BatchWriteItem')
        .flatMap((cmd: any) => cmd.input.RequestItems['test-projects-table']);

    it('stores each message as its own item and refreshes project activity', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);
      expect(JSON.parse((result as any).body).count).toBe(2);

      const puts = capturedPuts(mockDynamoSend.mock.calls);
      expect(puts).toHaveLength(2);
      expect(puts.every((p: any) => p.PutRequest.Item.sk.S.startsWith('MSG#'))).toBe(true);

      // Messages carry a TTL of their own, so an abandoned project's history
      // expires with it rather than outliving the metadata.
      expect(puts.every((p: any) => p.PutRequest.Item.expiresAt)).toBe(true);

      const update = mockDynamoSend.mock.calls
        .map(([cmd]) => cmd)
        .find((cmd: any) => cmd._type === 'UpdateItem');
      expect(update.input.UpdateExpression).toContain('updatedAt');
      expect(update.input.UpdateExpression).toContain('expiresAt');
    });

    it('is idempotent when the client re-sends the same array', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      await handler(apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }));
      const firstKeys = capturedPuts(mockDynamoSend.mock.calls).map((p: any) => p.PutRequest.Item.sk.S);

      mockDynamoSend.mockClear();
      await handler(apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }));
      const secondKeys = capturedPuts(mockDynamoSend.mock.calls).map((p: any) => p.PutRequest.Item.sk.S);

      // Same keys means the re-save overwrites rather than appending duplicates —
      // the frontend saves the whole conversation on every turn.
      expect(secondKeys).toEqual(firstKeys);
    });

    it('keeps array order when messages share a timestamp', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const sameMs = [
        { id: 'a', role: 'user', content: 'one', createdAt: 5000 },
        { id: 'b', role: 'assistant', content: 'two', createdAt: 5000 },
      ];
      await handler(apiEvent('POST', '/projects/proj-1/messages', { messages: sameMs }, { id: 'proj-1' }));

      const keys = capturedPuts(mockDynamoSend.mock.calls).map((p: any) => p.PutRequest.Item.sk.S);
      expect(keys[0] < keys[1]).toBe(true);
    });

    it('attributes messages to the caller, so a collaborator contribution is traceable', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }, 'user-guest'),
      );

      expect((result as any).statusCode).toBe(200);
      const puts = capturedPuts(mockDynamoSend.mock.calls);
      expect(puts.every((p: any) => p.PutRequest.Item.authorId.S === 'user-guest')).toBe(true);
    });

    it('refuses a non-member', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }, 'user-stranger'),
      );

      expect((result as any).statusCode).toBe(403);
    });

    it('returns 404 for an unknown project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ meta: null }));

      const result = await handler(
        apiEvent('POST', '/projects/nope/messages', { messages }, { id: 'nope' }),
      );

      expect((result as any).statusCode).toBe(404);
    });

    it('rejects a body without a messages array', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages: 'nope' }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(
        unauthEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(401);
    });
  });

  /**
   * The production failure these cover: the client re-sends the whole conversation
   * on every message change, so a file-heavy project drove repeated full rewrites
   * at a single partition key and DynamoDB answered `ThrottlingException` /
   * `TableWriteKeyRangeThroughputExceeded`. The handler turned that into a 500,
   * which the client then retried immediately, making it worse.
   */
  describe('POST /projects/{id}/messages — write capacity', () => {
    const TABLE = 'test-projects-table';

    function throttled(): Error {
      const err = new Error(
        'Throughput exceeds the current capacity of your table or index.',
      ) as Error & { name: string; $metadata: unknown };
      err.name = 'ThrottlingException';
      err.$metadata = { httpStatusCode: 400 };

      return err;
    }

    const batchCalls = (calls: any[][]) =>
      calls.map(([cmd]) => cmd).filter((cmd: any) => cmd._type === 'BatchWriteItem');

    const messages = [
      { id: 'm1', role: 'user', content: 'hello', createdAt: 1000 },
      { id: 'm2', role: 'assistant', content: 'hi', createdAt: 2000 },
    ];

    /** A conversation the size of the one that broke production: 20 × 30KB of file content. */
    const bigConversation = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(30 * 1024),
      createdAt: 1000 + i,
    }));

    it('retries a throttled batch instead of failing the save', async () => {
      let attempts = 0;
      const base = respondForProject();
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'BatchWriteItem') {
          attempts++;

          if (attempts <= 2) {
            throw throttled();
          }

          return {};
        }

        return base(cmd);
      });

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);
      expect(attempts).toBe(3);
    });

    it('retries only the unprocessed remainder of a partially written batch', async () => {
      let attempts = 0;
      const base = respondForProject();
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'BatchWriteItem') {
          attempts++;

          if (attempts === 1) {
            // DynamoDB reports per-item throttling here rather than throwing.
            return { UnprocessedItems: { [TABLE]: [cmd.input.RequestItems[TABLE][1]] } };
          }

          return {};
        }

        return base(cmd);
      });

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);

      const calls = batchCalls(mockDynamoSend.mock.calls);
      expect(calls).toHaveLength(2);

      const retried = calls[1].input.RequestItems[TABLE];
      expect(retried).toHaveLength(1);
      expect(retried[0].PutRequest.Item.id.S).toBe('m2');
    });

    it('answers 429 with Retry-After once capacity is genuinely exhausted', async () => {
      const base = respondForProject();
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'BatchWriteItem') {
          throw throttled();
        }

        return base(cmd);
      });

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }),
      );

      // Not a 500: the request was valid and retrying later will work, which is
      // exactly what the client needs to be told so it can back off.
      expect((result as any).statusCode).toBe(429);
      expect((result as any).headers['Retry-After']).toBeDefined();
    });

    it('retries a throttled activity bump', async () => {
      let attempts = 0;
      const base = respondForProject();
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'UpdateItem') {
          attempts++;

          if (attempts === 1) {
            throw throttled();
          }

          return {};
        }

        return base(cmd);
      });

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);
      expect(attempts).toBe(2);
    });

    it('splits a batch by payload bytes, not only by item count', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages: bigConversation }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);

      const calls = batchCalls(mockDynamoSend.mock.calls);
      // 20 items fits the 25-item cap, so a count-only chunker would send one
      // 600KB request. Byte-aware chunking has to send more than one.
      expect(calls.length).toBeGreaterThan(1);

      for (const call of calls) {
        const requests = call.input.RequestItems[TABLE];
        expect(requests.length).toBeLessThanOrEqual(25);

        const bytes = requests.reduce(
          (total: number, request: any) =>
            total + Buffer.byteLength(JSON.stringify(request.PutRequest.Item), 'utf8'),
          0,
        );
        expect(bytes).toBeLessThanOrEqual(400 * 1024);
      }
    });

    it('truncates a single message over the 400KB item limit rather than dropping the turn', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const huge = [{ id: 'giant', role: 'assistant', content: 'y'.repeat(500 * 1024), createdAt: 1000 }];

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/messages', { messages: huge }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);

      const stored = batchCalls(mockDynamoSend.mock.calls).flatMap(
        (call: any) => call.input.RequestItems[TABLE],
      );
      expect(stored).toHaveLength(1);

      const item = stored[0].PutRequest.Item;
      // The message survives, under the limit, and says so.
      expect(item.id.S).toBe('giant');
      expect(Buffer.byteLength(item.content.S, 'utf8')).toBeLessThan(400 * 1024);
      expect(item.content.S).toContain('truncated');
    });
  });

  /**
   * Sharing a sandbox gives a collaborator the files; this gives them the
   * conversation behind those files, so the history and the AI context travel with
   * the invite instead of stopping at the container.
   */
  describe('POST /projects/{id}/members — share', () => {
    it('lets the owner grant another user access', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/members', { userId: 'user-guest' }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);
      const put = mockDynamoSend.mock.calls
        .map(([cmd]) => cmd)
        .find((cmd: any) => cmd._type === 'PutItem' && String(cmd.input.Item?.sk?.S).startsWith('MEMBER#'));
      expect(put.input.Item.sk.S).toBe('MEMBER#user-guest');
    });

    it('refuses a member, so a guest cannot widen access further', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/members', { userId: 'user-third' }, { id: 'proj-1' }, 'user-guest'),
      );

      expect((result as any).statusCode).toBe(403);
    });

    it('requires a userId', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(
        apiEvent('POST', '/projects/proj-1/members', {}, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(400);
    });

    it('returns 404 for an unknown project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ meta: null }));

      const result = await handler(
        apiEvent('POST', '/projects/nope/members', { userId: 'user-guest' }, { id: 'nope' }),
      );

      expect((result as any).statusCode).toBe(404);
    });
  });

  /**
   * Membership is permanent now that an invite link no longer expires, so the
   * owner needs to be able to see who is in a project and take someone out
   * again. Without both, "permanent" would mean "irrevocable and invisible".
   */
  describe('GET /projects/{id}/members — who is in this project', () => {
    /**
     * Route the META read, the membership read and the `begins_with(sk, 'MEMBER#')`
     * partition query off the shapes the handler issues.
     */
    function respondForMembers(
      options: {
        meta?: Record<string, any> | null;
        members?: string[];
        onCommand?: (cmd: any) => void;
      } = {},
    ) {
      const { meta = metaItem(), members = [], onCommand } = options;

      return (cmd: any) => {
        onCommand?.(cmd);

        if (cmd._type === 'GetItem') {
          const sk = String(cmd.input?.Key?.sk?.S ?? '');

          if (sk === 'META') {
            return meta ? { Item: meta } : {};
          }

          const userId = sk.replace('MEMBER#', '');
          return members.includes(userId) ? { Item: memberItem(userId) } : {};
        }

        if (cmd._type === 'Query') {
          if (cmd.input?.IndexName === 'byUrlId') {
            return meta ? { Items: [meta] } : { Items: [] };
          }

          const owner = String(meta?.ownerId?.S ?? 'user-123');
          return {
            Items: [
              memberItem(owner, 'owner'),
              ...members.map((userId) => memberItem(userId)),
            ],
          };
        }

        return {};
      };
    }

    it('lists the owner and every collaborator', async () => {
      const commands: any[] = [];
      mockDynamoSend.mockImplementation(
        respondForMembers({ members: ['user-guest'], onCommand: (cmd) => commands.push(cmd) }),
      );

      const result = await handler(
        apiEvent('GET', '/projects/proj-1/members', null, { id: 'proj-1' }, 'user-123'),
      );

      expect((result as any).statusCode).toBe(200);
      const { members } = JSON.parse((result as any).body);
      expect(members).toEqual([
        { userId: 'user-123', role: 'owner', addedAt: 1500 },
        { userId: 'user-guest', role: 'editor', addedAt: 1500 },
      ]);

      // Read from the project's own partition, so a shared project's membership
      // never requires scanning the table.
      const query = commands.find((cmd: any) => cmd._type === 'Query' && !cmd.input?.IndexName);
      expect(query.input.KeyConditionExpression).toContain('begins_with(sk');
      expect(query.input.ExpressionAttributeValues[':prefix'].S).toBe('MEMBER#');
    });

    it('lets a collaborator see who else is in the project', async () => {
      mockDynamoSend.mockImplementation(respondForMembers({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('GET', '/projects/proj-1/members', null, { id: 'proj-1' }, 'user-guest'),
      );

      expect((result as any).statusCode).toBe(200);
    });

    it('refuses a stranger', async () => {
      mockDynamoSend.mockImplementation(respondForMembers({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('GET', '/projects/proj-1/members', null, { id: 'proj-1' }, 'user-stranger'),
      );

      expect((result as any).statusCode).toBe(403);
    });

    it('returns 404 for an unknown project', async () => {
      mockDynamoSend.mockImplementation(respondForMembers({ meta: null }));

      const result = await handler(
        apiEvent('GET', '/projects/nope/members', null, { id: 'nope' }),
      );

      expect((result as any).statusCode).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(
        unauthEvent('GET', '/projects/proj-1/members', null, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(401);
    });
  });

  describe('DELETE /projects/{id}/members/{userId} — revoke access', () => {
    const removeEvent = (memberId: string, callerId: string) =>
      apiEvent(
        'DELETE',
        `/projects/proj-1/members/${memberId}`,
        null,
        { id: 'proj-1', memberId },
        callerId,
      );

    const deletedMemberKeys = () =>
      mockDynamoSend.mock.calls
        .map(([cmd]) => cmd)
        .filter((cmd: any) => cmd._type === 'DeleteItem')
        .map((cmd: any) => cmd.input.Key?.sk?.S);

    it('lets the owner take a collaborator out of the project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(removeEvent('user-guest', 'user-123'));

      expect((result as any).statusCode).toBe(200);
      expect(deletedMemberKeys()).toEqual(['MEMBER#user-guest']);
    });

    it('refuses a collaborator trying to remove someone else', async () => {
      mockDynamoSend.mockImplementation(
        respondForProject({ members: ['user-guest', 'user-third'] }),
      );

      const result = await handler(removeEvent('user-third', 'user-guest'));

      expect((result as any).statusCode).toBe(403);
      expect(deletedMemberKeys()).toHaveLength(0);
    });

    it('refuses to remove the owner, which would strand the project membership', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(removeEvent('user-123', 'user-123'));

      expect((result as any).statusCode).toBe(400);
      expect(deletedMemberKeys()).toHaveLength(0);
    });

    it('lets a collaborator leave a shared project themselves', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(removeEvent('me', 'user-guest'));

      expect((result as any).statusCode).toBe(200);
      expect(deletedMemberKeys()).toEqual(['MEMBER#user-guest']);
    });

    it('refuses the owner leaving their own project via me', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(removeEvent('me', 'user-123'));

      expect((result as any).statusCode).toBe(400);
    });

    it('returns 404 for an unknown project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ meta: null }));

      const result = await handler(
        apiEvent(
          'DELETE',
          '/projects/nope/members/user-guest',
          null,
          { id: 'nope', memberId: 'user-guest' },
          'user-123',
        ),
      );

      expect((result as any).statusCode).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(
        unauthEvent('DELETE', '/projects/proj-1/members/user-guest', null, {
          id: 'proj-1',
          memberId: 'user-guest',
        }),
      );

      expect((result as any).statusCode).toBe(401);
    });

    /**
     * Revocation needs no read-path change because authorisation is a live read
     * on every request rather than anything cached — so the request after a
     * removal is already denied.
     */
    it('denies the removed collaborator on their very next request', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const before = await handler(
        apiEvent('GET', '/projects/proj-1', null, { id: 'proj-1' }, 'user-guest'),
      );
      expect((before as any).statusCode).toBe(200);

      mockDynamoSend.mockImplementation(respondForProject({ members: [] }));

      const after = await handler(
        apiEvent('GET', '/projects/proj-1', null, { id: 'proj-1' }, 'user-guest'),
      );
      expect((after as any).statusCode).toBe(403);
    });
  });

  describe('PATCH /projects/{id} — rename', () => {
    it('lets the owner rename the project', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(
        apiEvent('PATCH', '/projects/proj-1', { description: 'Renamed' }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(200);
      const update = mockDynamoSend.mock.calls
        .map(([cmd]) => cmd)
        .find((cmd: any) => cmd._type === 'UpdateItem');
      expect(update.input.ExpressionAttributeValues[':description'].S).toBe('Renamed');
    });

    it('refuses a member, who may write messages but not relabel the project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('PATCH', '/projects/proj-1', { description: 'Mine now' }, { id: 'proj-1' }, 'user-guest'),
      );

      expect((result as any).statusCode).toBe(403);
    });

    it('returns 404 for an unknown project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ meta: null }));

      const result = await handler(
        apiEvent('PATCH', '/projects/nope', { description: 'x' }, { id: 'nope' }),
      );

      expect((result as any).statusCode).toBe(404);
    });

    it('requires a description', async () => {
      mockDynamoSend.mockImplementation(respondForProject());

      const result = await handler(apiEvent('PATCH', '/projects/proj-1', {}, { id: 'proj-1' }));

      expect((result as any).statusCode).toBe(400);
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(
        unauthEvent('PATCH', '/projects/proj-1', { description: 'x' }, { id: 'proj-1' }),
      );

      expect((result as any).statusCode).toBe(401);
    });
  });

  describe('DELETE /projects/{id}', () => {
    it('deletes every item in the project partition for the owner', async () => {
      mockDynamoSend.mockImplementation((cmd: any) => {
        if (cmd._type === 'GetItem') return { Item: metaItem() };
        if (cmd._type === 'Query') {
          return {
            Items: [
              { projectId: { S: 'proj-1' }, sk: { S: 'META' } },
              { projectId: { S: 'proj-1' }, sk: { S: 'MEMBER#user-123' } },
              { projectId: { S: 'proj-1' }, sk: { S: 'MSG#000000000001000#m1' } },
            ],
          };
        }
        return {};
      });

      const result = await handler(apiEvent('DELETE', '/projects/proj-1', null, { id: 'proj-1' }));

      expect((result as any).statusCode).toBe(200);
      const deletes = mockDynamoSend.mock.calls
        .map(([cmd]) => cmd)
        .filter((cmd: any) => cmd._type === 'BatchWriteItem')
        .flatMap((cmd: any) => cmd.input.RequestItems['test-projects-table']);
      expect(deletes.map((d: any) => d.DeleteRequest.Key.sk.S)).toEqual([
        'META',
        'MEMBER#user-123',
        'MSG#000000000001000#m1',
      ]);
    });

    it('refuses a member, so a collaborator cannot destroy the owner project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ members: ['user-guest'] }));

      const result = await handler(
        apiEvent('DELETE', '/projects/proj-1', null, { id: 'proj-1' }, 'user-guest'),
      );

      expect((result as any).statusCode).toBe(403);
      // Nothing was deleted before the check.
      expect(
        mockDynamoSend.mock.calls.some(([cmd]) => (cmd as any)._type === 'BatchWriteItem'),
      ).toBe(false);
    });

    it('returns 404 for an unknown project', async () => {
      mockDynamoSend.mockImplementation(respondForProject({ meta: null }));

      const result = await handler(apiEvent('DELETE', '/projects/nope', null, { id: 'nope' }));

      expect((result as any).statusCode).toBe(404);
    });

    it('returns 401 when not authenticated', async () => {
      const result = await handler(unauthEvent('DELETE', '/projects/proj-1', null, { id: 'proj-1' }));

      expect((result as any).statusCode).toBe(401);
    });
  });

  describe('routing', () => {
    it('rejects a project route with no id', async () => {
      const result = await handler(apiEvent('GET', '/projects/', null, null as any));

      expect((result as any).statusCode).toBe(400);
    });

    it('answers CORS preflight without requiring authentication', async () => {
      const result = await handler(unauthEvent('OPTIONS', '/projects'));

      expect((result as any).statusCode).toBe(200);
    });
  });
});

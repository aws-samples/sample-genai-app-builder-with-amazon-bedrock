import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The chat and prompt-enhancer routes invoke the model, so each must refuse a
 * request that does not carry an identity AWS has already verified: the
 * API Gateway REQUEST authorizer's context, or the SigV4 caller of an AWS_IAM
 * Function URL. Gateway configuration alone is not enough, because the Remix
 * Lambda is reachable through more than one entry path (the public SSR proxy
 * among them), so the handler checks again.
 */

const streamTextMock = vi.fn();

vi.mock('~/lib/.server/llm/stream-text', () => ({
  streamText: (...args: unknown[]) => streamTextMock(...args),
}));

vi.mock('~/lib/.server/analytics', () => ({
  emitMetric: vi.fn(),
}));

const { action: chatAction } = await import('~/routes/api.chat');
const { action: enhancerAction } = await import('~/routes/api.enhancer');

function fakeStream() {
  return {
    toAIStream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('ok'));
          controller.close();
        },
      }),
  };
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://example.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const chatBody = { messages: [{ role: 'user', content: 'hi' }], userId: 'forged-user' };
const enhancerBody = { message: 'make a site', userId: 'forged-user' };

const apiGatewayContext = {
  event: { requestContext: { authorizer: { principalId: 'sub-123', userId: 'sub-123', email: 'a@b.c' } } },
};

const functionUrlContext = {
  event: {
    requestContext: {
      authorizer: {
        iam: {
          userArn: 'arn:aws:sts::123456789012:assumed-role/auth-role/CognitoIdentityCredentials',
          userId: 'AROAEXAMPLE:CognitoIdentityCredentials',
          cognitoIdentity: { identityId: 'us-west-2:identity-1', identityPoolId: 'us-west-2:pool' },
        },
      },
    },
  },
};

type RouteAction = (args: any) => Promise<Response>;

const routes: Array<[string, RouteAction, string, unknown]> = [
  ['chat', chatAction as RouteAction, '/api/chat', chatBody],
  ['enhancer', enhancerAction as RouteAction, '/api/enhancer', enhancerBody],
];

const originalNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  streamTextMock.mockReset();
  streamTextMock.mockResolvedValue(fakeStream());
  process.env.NODE_ENV = 'production';
});

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe.each(routes)('%s route authentication', (_name, action, path, body) => {
  it('rejects a request with no load context (public SSR proxy, no authorizer)', async () => {
    const res = await action({ request: jsonRequest(path, body), context: {}, params: {} });

    expect(res.status).toBe(401);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('rejects an API Gateway event whose method had no authorizer', async () => {
    const context = { event: { requestContext: { authorizer: null } } };
    const res = await action({ request: jsonRequest(path, body), context, params: {} });

    expect(res.status).toBe(401);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('ignores an Authorization header and a userId the caller merely asserts', async () => {
    const request = jsonRequest(path, body, { Authorization: 'Bearer not-verified', 'x-user-id': 'forged-user' });
    const res = await action({ request, context: { event: { requestContext: {} } }, params: {} });

    expect(res.status).toBe(401);
    expect(streamTextMock).not.toHaveBeenCalled();
  });

  it('accepts an identity verified by the API Gateway authorizer', async () => {
    const res = await action({ request: jsonRequest(path, body), context: apiGatewayContext, params: {} });

    expect(res.status).toBe(200);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a SigV4 caller verified by an AWS_IAM Function URL', async () => {
    const res = await action({ request: jsonRequest(path, body), context: functionUrlContext, params: {} });

    expect(res.status).toBe(200);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });
});

describe('chat route identity', () => {
  it('attributes the request to the authorizer-verified user, not the body userId', async () => {
    await chatAction({ request: jsonRequest('/api/chat', chatBody), context: apiGatewayContext, params: {} } as any);

    const options = streamTextMock.mock.calls[0][1] as { userId?: string };
    expect(options.userId).toBe('sub-123');
  });
});

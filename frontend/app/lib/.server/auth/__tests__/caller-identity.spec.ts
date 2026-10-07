import { afterEach, describe, expect, it } from 'vitest';
import { getVerifiedCaller } from '../caller-identity';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('getVerifiedCaller', () => {
  it('reads the userId the API Gateway REQUEST authorizer put in its context', () => {
    const caller = getVerifiedCaller({
      event: { requestContext: { authorizer: { principalId: 'sub-1', userId: 'sub-1' } } },
    });

    expect(caller).toEqual({ userId: 'sub-1', via: 'api-gateway-authorizer' });
  });

  it('reads the Cognito identity of a SigV4 caller on an AWS_IAM Function URL', () => {
    const caller = getVerifiedCaller({
      event: {
        requestContext: {
          authorizer: {
            iam: {
              userArn: 'arn:aws:sts::1:assumed-role/r/CognitoIdentityCredentials',
              userId: 'AROA:CognitoIdentityCredentials',
              cognitoIdentity: { identityId: 'us-west-2:abc' },
            },
          },
        },
      },
    });

    expect(caller).toEqual({ userId: 'us-west-2:abc', via: 'function-url-iam' });
  });

  it('falls back to the IAM userId when the Function URL event has no Cognito identity', () => {
    const caller = getVerifiedCaller({
      event: {
        requestContext: {
          authorizer: { iam: { userArn: 'arn:aws:sts::1:assumed-role/r/s', userId: 'AROA:s', cognitoIdentity: null } },
        },
      },
    });

    expect(caller).toEqual({ userId: 'AROA:s', via: 'function-url-iam' });
  });

  it.each([
    ['undefined context', undefined],
    ['empty context', {}],
    ['the bare Lambda context the streaming handler used to pass', { awsRequestId: 'x', functionName: 'f' }],
    ['no authorizer', { event: { requestContext: {} } }],
    ['an empty authorizer', { event: { requestContext: { authorizer: {} } } }],
    ['an empty userId', { event: { requestContext: { authorizer: { userId: '' } } } }],
    ['a non-string userId', { event: { requestContext: { authorizer: { userId: 42 } } } }],
    ['principalId only (the Deny path sets "anonymous")', { event: { requestContext: { authorizer: { principalId: 'anonymous' } } } }],
    ['an IAM block with no caller ARN', { event: { requestContext: { authorizer: { iam: { userId: 'x' } } } } }],
  ])('returns null for %s', (_label, context) => {
    process.env.NODE_ENV = 'production';
    expect(getVerifiedCaller(context)).toBeNull();
  });

  it('allows a local identity only under the Remix dev server', () => {
    process.env.NODE_ENV = 'development';
    expect(getVerifiedCaller(undefined)).toEqual({ userId: 'local-dev', via: 'local-dev' });

    process.env.NODE_ENV = 'test';
    expect(getVerifiedCaller(undefined)).toBeNull();
  });
});

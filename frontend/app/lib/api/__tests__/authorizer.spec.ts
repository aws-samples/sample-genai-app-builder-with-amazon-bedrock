import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * The API Gateway authorizer is the only thing establishing who a caller is, so
 * these fixtures are really signed: a token passes only if it is signed by the
 * user pool's key and issued to this app client as an id-token.
 */

const POOL_ID = 'us-west-2_example';
const CLIENT_ID = 'test-client-id';
const ISSUER = `https://cognito-idp.us-west-2.amazonaws.com/${POOL_ID}`;

process.env.COGNITO_USER_POOL_ID = POOL_ID;
process.env.COGNITO_CLIENT_ID = CLIENT_ID;

const { handler, getVerifier } = await import('../../../../lambda-authorizer/index');

const KID = 'test-key';
const trusted = generateKeyPairSync('rsa', { modulusLength: 2048 });
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });

(getVerifier() as any).cacheJwks({
  keys: [{ ...(trusted.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: KID, alg: 'RS256', use: 'sig' }],
});

const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function token(overrides: Record<string, unknown> = {}, key: KeyObject = trusted.privateKey): string {
  const input = [
    b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID })),
    b64(
      JSON.stringify({
        sub: '11111111-2222-3333-4444-555555555555',
        email: 'user@example.com',
        iss: ISSUER,
        aud: CLIENT_ID,
        token_use: 'id',
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...overrides,
      }),
    ),
  ].join('.');

  return `${input}.${b64(createSign('RSA-SHA256').update(input).sign(key))}`;
}

const METHOD_ARN = 'arn:aws:execute-api:us-west-2:123456789012:abc123/api/POST/session';
const invoke = (headers: Record<string, string>) => handler({ type: 'REQUEST', methodArn: METHOD_ARN, headers } as any);
const effect = (r: any) => r.policyDocument.Statement[0].Effect;

describe('API Gateway authorizer', () => {
  it('allows a valid id-token and emits the sub as the identity', async () => {
    const result = await invoke({ Authorization: `Bearer ${token()}` });

    expect(effect(result)).toBe('Allow');
    expect(result.principalId).toBe('11111111-2222-3333-4444-555555555555');
    expect(result.context).toMatchObject({ userId: '11111111-2222-3333-4444-555555555555', email: 'user@example.com' });
    expect((result.policyDocument.Statement[0] as { Resource: string }).Resource).toBe('arn:aws:execute-api:us-west-2:123456789012:abc123/api/*');
  });

  it.each([
    ['no token', {}],
    ['a non-JWT', { Authorization: 'Bearer not-a-jwt' }],
    // The forgery the previous authorizer accepted: right issuer, anyone's sub.
    ['a token signed by an untrusted key', { Authorization: `Bearer ${token({ sub: 'victim' }, attacker.privateKey)}` }],
    ['an expired token', { Authorization: `Bearer ${token({ exp: 1_000_000_000 })}` }],
    ['a token for another app client', { Authorization: `Bearer ${token({ aud: 'other-client' })}` }],
    ['an access token', { Authorization: `Bearer ${token({ token_use: 'access' })}` }],
    ['a token from another user pool', { Authorization: `Bearer ${token({ iss: 'https://cognito-idp.us-west-2.amazonaws.com/us-west-2_other' })}` }],
  ])('denies %s', async (_label, headers) => {
    const result = await invoke(headers as Record<string, string>);

    expect(effect(result)).toBe('Deny');
    expect(result.principalId).toBe('anonymous');
    expect(result.context).toBeUndefined();
  });
});

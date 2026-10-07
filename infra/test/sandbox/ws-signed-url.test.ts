import { generateKeyPairSync, verify } from 'node:crypto';
import { signWsUrl, SIGNED_URL_TTL_SECONDS } from '../../lib/sandbox/session-manager-lambda/ws-signed-url';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = key.privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const NOW = 1_800_000_000;

/** CloudFront's URL-safe base64 variant. */
function decode(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
}

function parts(wsUrl: string) {
  const url = new URL(wsUrl.replace(/^wss:/, 'https:'));
  const policy = decode(url.searchParams.get('Policy')!);

  return {
    url,
    policy,
    signature: decode(url.searchParams.get('Signature')!),
    statement: JSON.parse(policy.toString('utf-8')).Statement[0],
  };
}

describe('signWsUrl', () => {
  const wsUrl = signWsUrl('vibe.example.dev', 'sess-1', PRIVATE_PEM, 'K2KEY', NOW);

  it('returns a wss:// URL for the session path, signed with the CloudFront key pair', () => {
    const { url, policy, signature } = parts(wsUrl);

    expect(wsUrl.startsWith('wss://vibe.example.dev/ws/sess-1?')).toBe(true);
    expect(url.searchParams.get('Key-Pair-Id')).toBe('K2KEY');
    expect(verify('RSA-SHA1', policy, key.publicKey, signature)).toBe(true);
  });

  it('scopes the policy to this one session', () => {
    expect(parts(wsUrl).statement.Resource).toBe('https://vibe.example.dev/ws/sess-1*');
  });

  it('expires after the TTL', () => {
    expect(parts(wsUrl).statement.Condition.DateLessThan['AWS:EpochTime']).toBe(NOW + SIGNED_URL_TTL_SECONDS);
  });

  it('cannot be re-pointed at another session without invalidating the signature', () => {
    const { policy, signature } = parts(wsUrl);
    const forged = Buffer.from(policy.toString('utf-8').replace('sess-1', 'sess-2'));

    expect(verify('RSA-SHA1', forged, key.publicKey, signature)).toBe(false);
  });

  it('refuses to sign without a key pair', () => {
    expect(() => signWsUrl('vibe.example.dev', 'sess-1', PRIVATE_PEM, '', NOW)).toThrow(/key pair/);
    expect(() => signWsUrl('vibe.example.dev', 'sess-1', '', 'K2KEY', NOW)).toThrow(/key pair/);
  });
});

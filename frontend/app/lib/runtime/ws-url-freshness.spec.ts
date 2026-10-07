import { describe, it, expect } from 'vitest';
import { isWsUrlFresh } from './container-runtime';

/**
 * Reopening a project reuses the endpoint cached earlier in the page's life, but
 * its signed URL is short-lived. Reusing an expired one produced a connection
 * CloudFront refuses, which surfaced as the workbench hanging on open — so a
 * stale URL has to be recognised and re-requested instead.
 */
function cloudFrontBase64(value: string): string {
  return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
}

function urlWithPolicy(policy: unknown): string {
  return `wss://example.test/ws/s?Policy=${cloudFrontBase64(JSON.stringify(policy))}&Signature=sig&Key-Pair-Id=K2`;
}

function urlWithExp(expSeconds: number): string {
  return urlWithPolicy({
    Statement: [
      { Resource: 'https://example.test/ws/s*', Condition: { DateLessThan: { 'AWS:EpochTime': expSeconds } } },
    ],
  });
}

const now = () => Math.floor(Date.now() / 1000);

describe('isWsUrlFresh', () => {
  it('accepts a URL with plenty of life left', () => {
    expect(isWsUrlFresh(urlWithExp(now() + 300))).toBe(true);
  });

  it('rejects an expired URL', () => {
    expect(isWsUrlFresh(urlWithExp(now() - 1))).toBe(false);
  });

  it('rejects a URL expiring within the safety margin', () => {
    // Not worth dialling: it can lapse mid-handshake.
    expect(isWsUrlFresh(urlWithExp(now() + 5))).toBe(false);
  });

  it('treats an unsigned URL as stale, so the caller re-requests', () => {
    expect(isWsUrlFresh('wss://example.test/ws/s')).toBe(false);
  });

  it('treats an unparseable policy as stale rather than throwing', () => {
    for (const bad of [
      'wss://example.test/ws/s?Policy=garbage',
      'wss://example.test/ws/s?Policy=',
      'not a url',
    ]) {
      expect(isWsUrlFresh(bad)).toBe(false);
    }
  });

  it('rejects a policy with no expiry', () => {
    expect(isWsUrlFresh(urlWithPolicy({ Statement: [{ Resource: 'x' }] }))).toBe(false);
  });

  it('reads a real signer-produced URL', async () => {
    // Pins the encoding against the AWS SDK's signer rather than our own fixture.
    const { generateKeyPairSync } = await import('node:crypto');
    const { getSignedUrl } = await import('@aws-sdk/cloudfront-signer');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const url = 'https://example.test/ws/s';
    const signed = getSignedUrl({
      url,
      keyPairId: 'K2',
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }) as string,
      policy: JSON.stringify({
        Statement: [{ Resource: `${url}*`, Condition: { DateLessThan: { 'AWS:EpochTime': now() + 120 } } }],
      }),
    }).replace(/^https:/, 'wss:');

    expect(isWsUrlFresh(signed)).toBe(true);
  });
});

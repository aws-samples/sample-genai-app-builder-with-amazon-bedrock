import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Request headers carry the caller's bearer token and the origin-verify secret.
 * Neither may reach CloudWatch, whatever the validation outcome.
 */

const EXPECTED_SECRET = 'origin-verify-secret-value-0123456789';
const BEARER = 'Bearer eyJhbGciOiJSUzI1NiJ9.secret-payload.signature';

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({ send: vi.fn(async () => ({ SecretString: EXPECTED_SECRET })) })),
  GetSecretValueCommand: vi.fn(),
}));

const { validateCloudFrontRequest } = await import('../security');

let logged: string[];

beforeEach(() => {
  process.env.CUSTOM_HEADER_SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:1:secret:x';
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation(capture);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(headers: Record<string, string>) {
  return new Request('https://example.test/api/chat', { method: 'POST', headers });
}

describe('validateCloudFrontRequest logging', () => {
  it('does not log the Authorization header when the origin header is missing', async () => {
    expect(await validateCloudFrontRequest(request({ Authorization: BEARER }))).toBe(false);

    expect(logged.join('\n')).not.toContain('secret-payload');
  });

  it('does not log any part of the expected or received secret on a mismatch', async () => {
    const wrong = 'wrong-secret-value-abcdefghijklmnop';
    expect(await validateCloudFrontRequest(request({ Authorization: BEARER, 'X-Custom-Header': wrong }))).toBe(false);

    const output = logged.join('\n');
    expect(output).not.toContain(EXPECTED_SECRET.slice(0, 8));
    expect(output).not.toContain(wrong.slice(0, 8));
    expect(output).not.toContain('secret-payload');
  });
});

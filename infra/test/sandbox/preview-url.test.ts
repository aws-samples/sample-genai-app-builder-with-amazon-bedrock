import { previewUrlFor } from '../../lib/sandbox/session-manager-lambda/preview-url';

describe('previewUrlFor', () => {
  test('puts the session in a per-session host and path', () => {
    expect(
      previewUrlFor('abc-123', 'https://{sessionId}.preview.vibe.test.dev/sandbox-preview/{sessionId}/'),
    ).toBe('https://abc-123.preview.vibe.test.dev/sandbox-preview/abc-123/');
  });

  test('works with a single untrusted host', () => {
    expect(previewUrlFor('abc', 'https://d111.cloudfront.net/sandbox-preview/{sessionId}/')).toBe(
      'https://d111.cloudfront.net/sandbox-preview/abc/',
    );
  });

  test('returns undefined when no untrusted origin is configured', () => {
    expect(previewUrlFor('abc', '')).toBeUndefined();
    expect(previewUrlFor('abc', undefined)).toBeUndefined();
  });

  test('refuses a session id that could change the host', () => {
    expect(
      previewUrlFor('evil.com/x', 'https://{sessionId}.preview.test/sandbox-preview/{sessionId}/'),
    ).toBeUndefined();
  });
});

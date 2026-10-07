/**
 * Where a session's live preview is loaded from.
 *
 * Always the untrusted-content origin (see lib/untrusted-content), never the app's:
 * the preview runs generated code. The template comes from the stack and carries
 * `{sessionId}` in the host (one origin per session) and/or the path.
 */

// A session id lands in a hostname, so it must be a single DNS label.
const SESSION_ID = /^[A-Za-z0-9-]{1,63}$/;

export function previewUrlFor(
  sessionId: string,
  template: string | undefined = process.env.PREVIEW_URL_TEMPLATE,
): string | undefined {
  if (!template || !SESSION_ID.test(sessionId)) return undefined;
  return template.split('{sessionId}').join(sessionId);
}

/**
 * Shared rules for running an artifact's shell actions.
 *
 * Extracted from `action-runner.ts` so the timeouts and the dev-server test are
 * one definition with tests on them, rather than regexes and magic numbers
 * repeated at each call site.
 */

/**
 * How long to let a single shell command run before giving up on its response.
 *
 * Deliberately well above the connection's 120s default. Every project does a
 * cold `npm install` — the sandbox image ships no warmed cache and an empty
 * `/opt/template` — so a chart-heavy React install can take minutes. At 120s the
 * request rejected, the action queue swallowed the rejection, and the dev server
 * then started against a half-populated `node_modules`: no port, no preview, and
 * nothing on screen to say why. The symptom was a build that worked for small
 * apps and failed for big ones, i.e. looked random.
 */
export const SHELL_REQUEST_TIMEOUT_MS = 420_000;

/**
 * How long to wait for a dev server to open its port before calling it failed.
 *
 * At least as long as a shell command may take, because `npm install && npm run
 * dev` reaches us as a single dev-server action and the port cannot appear until
 * the install has finished.
 */
export const DEV_SERVER_PORT_TIMEOUT_MS = 480_000;

/**
 * Whether a command starts a long-running dev server.
 *
 * These never exit, so they cannot be awaited like an ordinary command — the
 * caller races the port opening instead.
 */
export function isDevServerCommand(command: string): boolean {
  return /\b(npm run dev|npx vite|vite)\b/.test(command);
}

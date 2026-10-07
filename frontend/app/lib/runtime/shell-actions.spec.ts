import { describe, expect, it } from 'vitest';
import { DEV_SERVER_PORT_TIMEOUT_MS, SHELL_REQUEST_TIMEOUT_MS, isDevServerCommand } from './shell-actions';

describe('isDevServerCommand', () => {
  it.each([
    'npm run dev',
    'npm run dev -- --host 0.0.0.0',
    'npx vite',
    'vite',
    'npm install && npm run dev',
  ])('recognises %s', (command) => {
    expect(isDevServerCommand(command)).toBe(true);
  });

  it.each(['npm install', 'npm ci', 'ls -la', 'npm run build'])('does not match %s', (command) => {
    expect(isDevServerCommand(command)).toBe(false);
  });
});

describe('timeouts', () => {
  it('gives a shell command longer than the default request timeout', () => {
    // The default is 120s (connection.ts). A cold `npm install` for a chart-heavy
    // React app routinely exceeds that, and when the request rejected the queue
    // swallowed it and started the dev server against a half-populated
    // node_modules — so the build failed for a reason no one could see.
    expect(SHELL_REQUEST_TIMEOUT_MS).toBeGreaterThan(120_000);
  });

  it('waits for the dev server port at least as long as a shell command may take', () => {
    // `npm install && npm run dev` arrives as ONE dev-server action, so the port
    // wait has to cover the install too.
    expect(DEV_SERVER_PORT_TIMEOUT_MS).toBeGreaterThanOrEqual(SHELL_REQUEST_TIMEOUT_MS);
  });
});

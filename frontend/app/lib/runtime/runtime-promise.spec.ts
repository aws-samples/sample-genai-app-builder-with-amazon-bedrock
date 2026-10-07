import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A failed sandbox boot must not poison the page.
 *
 * Consumers (file store, terminal, previews, action runner) capture this promise
 * once and await it for the life of the page. Caching a rejection therefore left
 * every later file write and command failing against a connection that was never
 * established — the symptom being a project whose actions all fail at once and an
 * empty file tree, recoverable only by a manual reload. These tests pin the
 * retry-on-failure and share-on-success behaviour.
 */
const bootMock = vi.fn();

vi.mock('./container-runtime', () => ({
  bootContainerRuntime: () => bootMock(),
}));

describe('getRuntimePromise', () => {
  beforeEach(() => {
    vi.resetModules();
    bootMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('shares one connection between callers, so consumers do not boot several sandboxes', async () => {
    const connection = { id: 'conn-1' };
    bootMock.mockResolvedValue(connection);

    const { getRuntimePromise } = await import('./index');
    const [a, b] = await Promise.all([getRuntimePromise(), getRuntimePromise()]);

    expect(a).toBe(connection);
    expect(b).toBe(connection);
    expect(bootMock).toHaveBeenCalledTimes(1);
  });

  it('retries after a failure instead of caching the rejection forever', async () => {
    const connection = { id: 'conn-2' };
    bootMock.mockRejectedValueOnce(new Error('auth not ready')).mockResolvedValueOnce(connection);

    const { getRuntimePromise } = await import('./index');

    await expect(getRuntimePromise()).rejects.toThrow('auth not ready');
    // The next caller must get a fresh attempt, not the poisoned promise.
    await expect(getRuntimePromise()).resolves.toBe(connection);
    expect(bootMock).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying while boots keep failing', async () => {
    bootMock.mockRejectedValue(new Error('still down'));

    const { getRuntimePromise } = await import('./index');

    await expect(getRuntimePromise()).rejects.toThrow('still down');
    await expect(getRuntimePromise()).rejects.toThrow('still down');
    await expect(getRuntimePromise()).rejects.toThrow('still down');
    expect(bootMock).toHaveBeenCalledTimes(3);
  });

  it('does not re-boot once a connection is established', async () => {
    bootMock.mockResolvedValue({ id: 'conn-3' });

    const { getRuntimePromise } = await import('./index');

    await getRuntimePromise();
    await getRuntimePromise();

    expect(bootMock).toHaveBeenCalledTimes(1);
  });

  it('boots afresh after an explicit reset, for a reconnect affordance', async () => {
    bootMock.mockResolvedValueOnce({ id: 'first' }).mockResolvedValueOnce({ id: 'second' });

    const { getRuntimePromise, resetRuntimePromise } = await import('./index');

    await expect(getRuntimePromise()).resolves.toEqual({ id: 'first' });
    resetRuntimePromise();
    await expect(getRuntimePromise()).resolves.toEqual({ id: 'second' });
    expect(bootMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * getConnection is what every store awaits per operation. It shares one boot
 * across callers and retries only after a *rejected* boot. It must NOT re-boot a
 * connection that is merely mid-reconnect: RuntimeConnectionImpl reconnects
 * itself, and tearing it down to start a second connection to an already-pinned
 * session left the new boot waiting on a system:ready that never came — the hang
 * that stuck "Go live" on "Connecting live session…".
 */
describe('getConnection', () => {
  beforeEach(() => {
    vi.resetModules();
    bootMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('shares one connection across callers without re-booting', async () => {
    const connection = { id: 'live', isConnected: () => true };
    bootMock.mockResolvedValue(connection);

    const { getConnection } = await import('./index');

    await expect(getConnection()).resolves.toBe(connection);
    await expect(getConnection()).resolves.toBe(connection);
    expect(bootMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-boot a connection that momentarily reports disconnected', async () => {
    // a mid-reconnect connection reads isConnected() === false but recovers on
    // its own; getConnection must hand it back, not discard it and boot again
    const reconnecting = { id: 'reconnecting', isConnected: () => false };
    bootMock.mockResolvedValue(reconnecting);

    const { getConnection } = await import('./index');

    await expect(getConnection()).resolves.toBe(reconnecting);
    await expect(getConnection()).resolves.toBe(reconnecting);
    expect(bootMock).toHaveBeenCalledTimes(1);
  });

  it('re-attempts after a failed boot, so a lost race is not terminal', async () => {
    const good = { id: 'good', isConnected: () => true };
    bootMock.mockRejectedValueOnce(new Error('auth not ready')).mockResolvedValueOnce(good);

    const { getConnection } = await import('./index');

    await expect(getConnection()).rejects.toThrow('auth not ready');
    await expect(getConnection()).resolves.toBe(good);
    expect(bootMock).toHaveBeenCalledTimes(2);
  });
});

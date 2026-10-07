import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The session status drives whether a joining collaborator sees a "connecting to
 * shared session" overlay or a blank workbench. It has to reflect an invite link
 * on the very first render — before any async boot runs — so a guest never sees
 * an empty panel that looks broken.
 *
 * Runs in the default (node) environment with no DOM, so `window` is stubbed
 * per-case rather than relying on jsdom.
 */
describe('session-status', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow(search: string, joinedFlag?: boolean) {
    const win: Record<string, unknown> = { location: { search } };

    if (joinedFlag !== undefined) {
      win.__SANDBOX_JOINED_SESSION__ = joinedFlag;
    }

    vi.stubGlobal('window', win);
  }

  it('detects a shared-session join from the invite link before the runtime decides', async () => {
    stubWindow('?join=tok-123');

    const mod = await import('./session-status');
    expect(mod.isJoiningSharedSession()).toBe(true);

    // first render for a guest is already "connecting", not "idle"
    expect(mod.sessionStatus.get()).toBe('connecting');
  });

  it('is idle for a normal visit with no invite token', async () => {
    stubWindow('');

    const mod = await import('./session-status');
    expect(mod.isJoiningSharedSession()).toBe(false);
    expect(mod.sessionStatus.get()).toBe('idle');
  });

  it('prefers the runtime flag over the URL once the runtime has decided', async () => {
    stubWindow('?join=tok-123', false);

    const mod = await import('./session-status');
    expect(mod.isJoiningSharedSession()).toBe(false);
  });

  it('records a reason when it transitions to failed', async () => {
    stubWindow('?join=tok-123');

    const mod = await import('./session-status');
    mod.setSessionStatus('failed', 'invite expired');
    expect(mod.sessionStatus.get()).toBe('failed');
    expect(mod.sessionStatusDetail.get()).toBe('invite expired');
  });

  it('clears the detail on a non-failure transition', async () => {
    stubWindow('?join=tok-123');

    const mod = await import('./session-status');
    mod.setSessionStatus('failed', 'boom');
    mod.setSessionStatus('ready');
    expect(mod.sessionStatus.get()).toBe('ready');
    expect(mod.sessionStatusDetail.get()).toBeUndefined();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { mintInviteToken, type InviteFlowDeps } from './invite-flow';

/** A deferred promise, for holding a dependency open mid-test. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function deps(overrides: Partial<InviteFlowDeps> = {}): InviteFlowDeps {
  return {
    isCollabEnabled: () => false,
    enableCollab: vi.fn(async () => {}),
    getSessionId: () => 'session-1',
    ensureConnected: vi.fn(async () => {}),
    createInvite: vi.fn(async () => ({ token: 'tok-abc' })),
    ...overrides,
  };
}

describe('mintInviteToken', () => {
  it('returns the token', async () => {
    await expect(mintInviteToken(deps())).resolves.toBe('tok-abc');
  });

  it('does not wait for the live session before minting', async () => {
    // The regression: `invite()` awaited `enableCollab()`, which awaits the whole
    // sandbox boot — 30-70s on a cold project — while the invite endpoint itself
    // answers in ~250ms. The link must not be held hostage to presence attaching.
    const held = deferred();
    const enableCollab = vi.fn(() => held.promise);

    const token = await mintInviteToken(deps({ enableCollab }));

    expect(token).toBe('tok-abc');
    expect(enableCollab).toHaveBeenCalled();

    held.resolve();
  });

  it('still goes live, just not on the critical path', async () => {
    const enableCollab = vi.fn(async () => {});

    await mintInviteToken(deps({ enableCollab }));

    expect(enableCollab).toHaveBeenCalledTimes(1);
  });

  it('does not re-enable collaboration when it is already live', async () => {
    const enableCollab = vi.fn(async () => {});

    await mintInviteToken(deps({ isCollabEnabled: () => true, enableCollab }));

    expect(enableCollab).not.toHaveBeenCalled();
  });

  it('mints against the existing session without connecting again', async () => {
    const ensureConnected = vi.fn(async () => {});
    const createInvite = vi.fn(async () => ({ token: 'tok-abc' }));

    await mintInviteToken(deps({ ensureConnected, createInvite }));

    expect(ensureConnected).not.toHaveBeenCalled();
    expect(createInvite).toHaveBeenCalledWith('session-1');
  });

  it('waits for a session when there is not one yet', async () => {
    // Irreducible: an invite has to point at a session. What matters is that this
    // is the *only* thing awaited before the token.
    const order: string[] = [];
    let sessionId: string | undefined;

    const ensureConnected = vi.fn(async () => {
      order.push('connect');
      sessionId = 'session-2';
    });
    const createInvite = vi.fn(async (id: string | undefined) => {
      order.push(`invite:${id}`);
      return { token: 'tok-xyz' };
    });

    const token = await mintInviteToken(
      deps({ getSessionId: () => sessionId, ensureConnected, createInvite }),
    );

    expect(token).toBe('tok-xyz');
    expect(order).toEqual(['connect', 'invite:session-2']);
  });

  it('still produces a link when going live fails', async () => {
    // Presence is a nicety; the link is the point. A failure to attach must not
    // cost the user their invite.
    const onBackgroundError = vi.fn();
    const enableCollab = vi.fn(async () => {
      throw new Error('sandbox not connected');
    });

    await expect(mintInviteToken(deps({ enableCollab, onBackgroundError }))).resolves.toBe('tok-abc');

    await Promise.resolve();
    expect(onBackgroundError).toHaveBeenCalled();
  });

  it('surfaces a failure to mint, rather than returning a useless token', async () => {
    const createInvite = vi.fn(async () => {
      throw new Error('403');
    });

    await expect(mintInviteToken(deps({ createInvite }))).rejects.toThrow('403');
  });
});

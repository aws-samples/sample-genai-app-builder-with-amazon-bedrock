import type { Message } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  CHAT_LOCAL_ORIGIN,
  observeChatMessages,
  publishChatMessages,
  readChatMessages,
  syncChatMessages,
} from './chat-collab';

function msg(id: string, role: Message['role'], content: string): Message {
  return { id, role, content } as Message;
}

/** Wire two docs together the way the relay does, so updates cross both ways. */
function connect(a: Y.Doc, b: Y.Doc) {
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') {
      Y.applyUpdate(b, update, 'remote');
    }
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') {
      Y.applyUpdate(a, update, 'remote');
    }
  });
}

describe('chat-collab', () => {
  it('mirrors a message published on one doc to the other', () => {
    const guest = new Y.Doc();
    const owner = new Y.Doc();
    connect(guest, owner);

    publishChatMessages(guest, [msg('m1', 'user', 'turn it red')]);

    expect(readChatMessages(owner)).toEqual([{ id: 'm1', role: 'user', content: 'turn it red' }]);
  });

  it('preserves conversation order rather than map iteration order', () => {
    const doc = new Y.Doc();

    publishChatMessages(doc, [
      msg('zz', 'user', 'first'),
      msg('aa', 'assistant', 'second'),
      msg('mm', 'user', 'third'),
    ]);

    expect(readChatMessages(doc).map((m) => m.content)).toEqual(['first', 'second', 'third']);
  });

  it('notifies the peer when a remote message arrives', () => {
    const guest = new Y.Doc();
    const owner = new Y.Doc();
    connect(guest, owner);

    const onRemote = vi.fn();
    observeChatMessages(owner, onRemote);

    publishChatMessages(guest, [msg('m1', 'user', 'turn it red')]);

    expect(onRemote).toHaveBeenCalledTimes(1);
    expect(onRemote.mock.calls[0][0]).toEqual([{ id: 'm1', role: 'user', content: 'turn it red' }]);
  });

  it('does not notify the publisher about its own writes', () => {
    const doc = new Y.Doc();
    const onRemote = vi.fn();
    observeChatMessages(doc, onRemote);

    publishChatMessages(doc, [msg('m1', 'user', 'mine')]);

    expect(onRemote).not.toHaveBeenCalled();
  });

  it('streams a growing assistant reply, not just the finished message', () => {
    const owner = new Y.Doc();
    const guest = new Y.Doc();
    connect(owner, guest);

    const seen: string[] = [];
    observeChatMessages(guest, (messages) => {
      const assistant = messages.find((m) => m.role === 'assistant');

      if (assistant) {
        seen.push(assistant.content);
      }
    });

    for (const partial of ['Sure', 'Sure, mak', 'Sure, making it red']) {
      publishChatMessages(owner, [msg('m1', 'user', 'turn it red'), msg('m2', 'assistant', partial)]);
    }

    expect(seen).toEqual(['Sure', 'Sure, mak', 'Sure, making it red']);
  });

  it('re-publishing an unchanged conversation writes nothing, so peers cannot ping-pong', () => {
    const doc = new Y.Doc();
    const messages = [msg('m1', 'user', 'hello'), msg('m2', 'assistant', 'hi')];
    publishChatMessages(doc, messages);

    let updates = 0;
    doc.on('update', () => updates++);
    publishChatMessages(doc, messages);

    expect(updates).toBe(0);
  });

  it('converges when both peers publish concurrently', () => {
    const owner = new Y.Doc();
    const guest = new Y.Doc();

    // Published while disconnected, then the relay delivers both ways.
    publishChatMessages(owner, [msg('m1', 'user', 'from owner')]);
    publishChatMessages(guest, [msg('m2', 'user', 'from guest')]);

    Y.applyUpdate(owner, Y.encodeStateAsUpdate(guest), 'remote');
    Y.applyUpdate(guest, Y.encodeStateAsUpdate(owner), 'remote');

    expect(readChatMessages(owner)).toEqual(readChatMessages(guest));
    expect(readChatMessages(owner)).toHaveLength(2);
  });

  it('tags its own transactions so callers can tell local writes apart', () => {
    const doc = new Y.Doc();
    const origins: unknown[] = [];
    doc.on('afterTransaction', (tx: Y.Transaction) => origins.push(tx.origin));

    publishChatMessages(doc, [msg('m1', 'user', 'x')]);

    expect(origins).toContain(CHAT_LOCAL_ORIGIN);
  });

  it('ignores entries it cannot parse instead of throwing', () => {
    const doc = new Y.Doc();
    doc.getMap<string>('chat:messages').set('broken', 'not json');
    publishChatMessages(doc, [msg('m1', 'user', 'fine')]);

    expect(readChatMessages(doc)).toEqual([{ id: 'm1', role: 'user', content: 'fine' }]);
  });
});

/**
 * Observing alone loses every message that arrived first.
 *
 * `observeChatMessages` only ever fires on a *later* transaction, and a Yjs replica
 * receives the whole conversation in the SyncStep2 that answers its handshake. The
 * provider is published to React the moment it is constructed, so whether that
 * frame lands before or after the subscribing effect runs is a race — which is
 * exactly the reported "sometimes you don't see the chat from your invitee".
 *
 * Files do not have the problem, which is why the symptom looks so odd: the
 * CodeMirror binding renders whatever the `Y.Text` holds at bind time, so state
 * that landed early is already on screen. Nothing did the equivalent read for chat.
 *
 * The race is not hypothetical after a reload: a reloading peer starts from an
 * empty doc and receives the entire conversation in one frame, so losing that frame
 * loses everything.
 */
describe('syncChatMessages', () => {
  /** Stand-in for `useChat`'s `setMessages`, which takes an updater. */
  function messageState(initial: Message[] = []) {
    const state = { current: initial, applied: 0 };

    return {
      state,
      apply: (merge: (current: Message[]) => Message[]) => {
        state.current = merge(state.current);
        state.applied++;
      },
    };
  }

  it('adopts a conversation that arrived before it was attached', () => {
    const doc = new Y.Doc();
    const peer = new Y.Doc();

    // The peer's whole conversation lands in one update, as SyncStep2 does.
    publishChatMessages(peer, [msg('m1', 'user', 'turn it red'), msg('m2', 'assistant', 'done')]);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'remote');

    const { state, apply } = messageState();
    syncChatMessages(doc, apply);

    expect(state.current.map((m) => m.content)).toEqual(['turn it red', 'done']);
  });

  it('keeps delivering later peer messages after the initial adopt', () => {
    const guest = new Y.Doc();
    const owner = new Y.Doc();
    connect(guest, owner);

    publishChatMessages(guest, [msg('m1', 'user', 'first')]);

    const { state, apply } = messageState();
    syncChatMessages(owner, apply);

    publishChatMessages(guest, [msg('m1', 'user', 'first'), msg('m2', 'user', 'second')]);

    expect(state.current.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('leaves local state alone when the shared conversation is empty', () => {
    const doc = new Y.Doc();
    const { state, apply } = messageState([msg('local', 'user', 'mine')]);

    syncChatMessages(doc, apply);

    expect(state.applied).toBe(0);
    expect(state.current.map((m) => m.content)).toEqual(['mine']);
  });

  it('ignores a shorter shared view rather than truncating the local conversation', () => {
    // A peer still mid-sync has published less than we hold; adopting it would drop
    // messages that are only in our copy.
    const doc = new Y.Doc();
    publishChatMessages(doc, [msg('m1', 'user', 'one')]);

    const { state, apply } = messageState([msg('m1', 'user', 'one'), msg('m2', 'user', 'two')]);
    syncChatMessages(doc, apply);

    expect(state.current.map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('stops delivering once unsubscribed', () => {
    const guest = new Y.Doc();
    const owner = new Y.Doc();
    connect(guest, owner);

    const { state, apply } = messageState();
    syncChatMessages(owner, apply)();

    publishChatMessages(guest, [msg('m1', 'user', 'after')]);

    expect(state.current).toEqual([]);
  });

  it('does not echo the local peer its own writes', () => {
    const doc = new Y.Doc();
    const { state, apply } = messageState();
    syncChatMessages(doc, apply);

    publishChatMessages(doc, [msg('m1', 'user', 'mine')]);

    expect(state.applied).toBe(0);
  });
});

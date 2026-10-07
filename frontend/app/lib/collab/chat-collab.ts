import type { Message } from 'ai';
import * as Y from 'yjs';

/**
 * Live chat over the shared Yjs doc.
 *
 * Chat history is durable in DynamoDB, but durable is not live: it is read once
 * when a project mounts, so a message one collaborator sends only reaches the
 * other on a reload. That is the wrong model for a shared session — if we mirror
 * keystrokes character by character, a prompt should appear the same way.
 *
 * So the conversation rides the same `Y.Doc` the file texts do, as a root
 * `Y.Map` keyed by message id. A map (rather than a `Y.Array`) is what makes the
 * streaming case work: an assistant reply arrives token by token, and each
 * partial is a `set()` on ONE key that overwrites the last — last-write-wins per
 * message. A `Y.Array` would need an index to splice, and two peers splicing
 * concurrently reorder or duplicate. Keys cannot collide because the id comes
 * from the message itself.
 *
 * Conversation order is stored explicitly rather than inferred from map
 * iteration order, which Yjs does not guarantee is insertion order across peers.
 *
 * Persistence is unchanged and still authoritative: this is the live path only.
 */
const CHAT_MESSAGES = 'chat:messages';

/**
 * Transaction origin stamped on our own writes, so {@link observeChatMessages}
 * can ignore them. Without this a peer would react to its own publish and
 * publish again — an echo that never settles.
 */
export const CHAT_LOCAL_ORIGIN = 'chat-collab:local';

interface StoredMessage {
  role: Message['role'];
  content: string;
  /** Position in the conversation. Explicit — map order is not insertion order. */
  order: number;
}

function chatMap(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(CHAT_MESSAGES);
}

/** The shared conversation, oldest first. */
export function readChatMessages(doc: Y.Doc): Message[] {
  const entries: Array<{ id: string; stored: StoredMessage }> = [];

  for (const [id, raw] of chatMap(doc)) {
    try {
      entries.push({ id, stored: JSON.parse(raw) as StoredMessage });
    } catch {
      // A malformed entry is not worth losing the rest of the conversation over.
      continue;
    }
  }

  // Ties break on id so every peer derives the same order from the same state.
  entries.sort((a, b) => a.stored.order - b.stored.order || (a.id < b.id ? -1 : 1));

  return entries.map(({ id, stored }) => ({ id, role: stored.role, content: stored.content }) as Message);
}

/**
 * Publish the local conversation to the shared doc.
 *
 * Only changed messages are written, which makes this cheap to call on every
 * render and — more importantly — makes it a no-op once two peers agree. That is
 * what stops an echo: applying a peer's state then re-publishing it produces no
 * transaction, so it raises no event on either side.
 */
export function publishChatMessages(doc: Y.Doc, messages: Message[]): void {
  const map = chatMap(doc);

  doc.transact(() => {
    messages.forEach((message, order) => {
      const next = JSON.stringify({
        role: message.role,
        content: message.content ?? '',
        order,
      } satisfies StoredMessage);

      if (map.get(message.id) !== next) {
        map.set(message.id, next);
      }
    });
  }, CHAT_LOCAL_ORIGIN);
}

/**
 * Call `onRemote` with the full conversation whenever a *peer* changes it.
 * Returns an unsubscribe function.
 */
export function observeChatMessages(doc: Y.Doc, onRemote: (messages: Message[]) => void): () => void {
  const map = chatMap(doc);

  const handler = (_event: Y.YMapEvent<string>, transaction: Y.Transaction) => {
    if (transaction.origin === CHAT_LOCAL_ORIGIN) {
      return;
    }

    onRemote(readChatMessages(doc));
  };

  map.observe(handler);

  return () => map.unobserve(handler);
}

/**
 * Reconcile a local conversation with the shared one.
 *
 * The shared doc is the union of both sides, so it only ever grows: a shorter view
 * means the peer publishing it has not finished syncing, and adopting it would drop
 * messages only we hold. Keeping the local copy in that case is the safe direction —
 * the next transaction brings a complete view.
 */
export function mergeChatMessages(current: Message[], shared: Message[]): Message[] {
  return shared.length >= current.length ? shared : current;
}

/**
 * Adopt the shared conversation now, and again whenever a peer changes it.
 *
 * The `now` is the part {@link observeChatMessages} cannot do: an observer only ever
 * fires on a *later* transaction, and a Yjs replica receives the entire existing
 * conversation in the SyncStep2 that answers its handshake. The provider is
 * published to React as soon as it is constructed, so whether that frame lands
 * before or after the subscribing effect runs is a race — and losing it meant the
 * conversation never appeared at all, however long you waited. That is the
 * "sometimes you don't see the chat from your invitee, but you do see their file
 * edits" asymmetry: the CodeMirror binding renders whatever the `Y.Text` already
 * holds when it binds, so files never depended on catching a live event.
 *
 * A reloading peer makes it certain rather than likely: it starts from an empty doc
 * and receives everything in one frame.
 *
 * `apply` takes an updater rather than a value so the merge sees the caller's
 * current state at the moment it lands — `useChat`'s `setMessages` supports exactly
 * this, and reading state captured when the effect ran would resurrect stale
 * messages mid-stream.
 */
export function syncChatMessages(
  doc: Y.Doc,
  apply: (merge: (current: Message[]) => Message[]) => void,
): () => void {
  const adopt = (shared: Message[]) => apply((current) => mergeChatMessages(current, shared));

  // Skipped when there is nothing shared yet, so going live solo does not touch
  // local state at all.
  const existing = readChatMessages(doc);

  if (existing.length > 0) {
    adopt(existing);
  }

  return observeChatMessages(doc, adopt);
}

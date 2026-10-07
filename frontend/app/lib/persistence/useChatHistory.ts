import { useLoaderData, useNavigate } from '@remix-run/react';
import { useState, useEffect } from 'react';
import { atom } from 'nanostores';
import type { Message } from 'ai';
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { readInviteToken } from '~/lib/runtime/container-runtime';
import { getMessages, getNextId, getUrlId, openDatabase, setMessages } from './db';
import { migrateLocalChats } from './sync';

export interface ChatHistoryItem {
  id: string;
  urlId?: string;
  description?: string;
  messages: Message[];
  timestamp: string;
}

const persistenceEnabled = !import.meta.env.VITE_DISABLE_PERSISTENCE;

/**
 * Wait for the runtime to report the project an invite granted.
 *
 * Chat history loads as soon as the page mounts, but the grant only lands once the
 * invite has been redeemed against the API — so without waiting, a guest would
 * check for the shared conversation before it was theirs to read. Gives up rather
 * than blocking the page: the files are shared either way.
 */
async function waitForSharedProject(timeoutMs = 12000): Promise<string | null> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const shared = (window as any).__SHARED_PROJECT_ID__ as string | undefined;

    if (shared) {
      return shared;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return null;
}

/** Guard so the one-off migration does not run again on every mount. */
let migrationStarted = false;

/**
 * Upload pre-existing local history to the server, once per page load.
 *
 * Reads the local store directly rather than via getAll, which merges in the
 * server's list — that would be circular here.
 */
async function migrateOnce(database: IDBDatabase): Promise<void> {
  if (migrationStarted) {
    return;
  }

  migrationStarted = true;

  const local = await new Promise<ChatHistoryItem[]>((resolve) => {
    try {
      const request = database.transaction('chats', 'readonly').objectStore('chats').getAll();
      request.onsuccess = () => resolve(request.result as ChatHistoryItem[]);
      request.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });

  await migrateLocalChats(local);
}

// Initialize db as undefined and only open it on the client side
export let db: IDBDatabase | undefined = undefined;

export const chatId = atom<string | undefined>(undefined);
export const description = atom<string | undefined>(undefined);

export function useChatHistory() {
  // console.log('🔄 useChatHistory: Hook called');

  const navigate = useNavigate();
  const { id: mixedId } = useLoaderData<{ id?: string }>();

  const [initialMessages, setInitialMessages] = useState<Message[]>([]);
  const [ready, setReady] = useState<boolean>(false);
  const [urlId, setUrlId] = useState<string | undefined>();
  const [isHydrated, setIsHydrated] = useState(false);

  // console.log('🔄 useChatHistory: mixedId =', mixedId, 'persistenceEnabled =', persistenceEnabled);

  // Hydration check - only run navigation after hydration
  useEffect(() => {
    setIsHydrated(true);
  }, []);

  useEffect(() => {
    // console.log('🔄 useChatHistory: useEffect triggered', { mixedId, persistenceEnabled, db: !!db, isHydrated });

    // Don't do anything until hydration is complete
    if (!isHydrated) {
      // console.log('🔄 useChatHistory: Waiting for hydration...');
      return;
    }

    // Initialize database only on client side
    const initializeDatabase = async () => {
      // console.log('🔄 initializeDatabase: Starting...');

      if (persistenceEnabled && typeof window !== 'undefined' && !db) {
        // console.log('🔄 initializeDatabase: Opening database...');
        db = await openDatabase();
        // console.log('🔄 initializeDatabase: Database opened:', !!db);

        // Lift any history that predates server storage, once per load. Runs in
        // the background: it must not delay opening the project the user asked
        // for, and it is safe to repeat because uploading is idempotent.
        if (db) {
          void migrateOnce(db);
        }
      }

      if (!db) {
        // console.log('🔄 initializeDatabase: No database, setting ready to true');
        setReady(true);

        if (persistenceEnabled) {
          // console.log('❌ Chat persistence is unavailable');
          toast.error(`Chat persistence is unavailable`);
        }

        return;
      }

      if (mixedId) {
        // console.log('🔄 initializeDatabase: Loading messages for mixedId:', mixedId);
        try {
          const storedMessages = await getMessages(db, mixedId);
          // console.log('🔄 initializeDatabase: Stored messages loaded:', !!storedMessages, storedMessages?.messages?.length || 0);

          if (storedMessages && storedMessages.messages.length > 0) {
            // console.log('🔄 initializeDatabase: Setting initial messages and data');
            setInitialMessages(storedMessages.messages);
            setUrlId(storedMessages.urlId);
            description.set(storedMessages.description);
            chatId.set(storedMessages.id);
          } else if (readInviteToken()) {
            // Someone arriving on an invite link has no local history for this
            // chat. Redirecting would drop the invite token from the URL and
            // silently put them in a fresh solo sandbox instead of the session
            // they were invited to, so stay put and let the runtime redeem it.
            chatId.set(mixedId);

            // Redeeming the invite grants the inviter's project, so the
            // conversation behind the shared files can be loaded rather than
            // leaving the guest with an empty chat panel.
            const shared = await waitForSharedProject();

            if (shared) {
              const sharedChat = await getMessages(db, shared);

              if (sharedChat?.messages?.length) {
                setInitialMessages(sharedChat.messages);
                setUrlId(sharedChat.urlId);
                description.set(sharedChat.description);
                chatId.set(sharedChat.id);
              }
            }
          } else {
            // console.log('🔄 initializeDatabase: No messages found, navigating to root');
            // Use setTimeout to ensure navigation happens after current render cycle
            setTimeout(() => {
              navigate(`/`, { replace: true });
            }, 0);
          }
        } catch (error) {
          console.error('❌ Error loading chat history:', error);
          toast.error('Failed to load chat history');
        }
      } else {
        // console.log('🔄 initializeDatabase: No mixedId provided');
      }

      // console.log('🔄 initializeDatabase: Setting ready to true');
      setReady(true);
    };

    initializeDatabase();
  }, [mixedId, navigate, isHydrated]);

  return {
    ready: !mixedId || ready,
    initialMessages,
    storeMessageHistory: async (messages: Message[]) => {
      // console.log('💾 storeMessageHistory: Called with', messages.length, 'messages');

      if (!db || messages.length === 0 || !isHydrated) {
        // console.log('💾 storeMessageHistory: Skipping - no db, no messages, or not hydrated');
        return;
      }

      const { firstArtifact } = workbenchStore;

      // Held locally as well as in state: `setUrlId` only affects the NEXT render,
      // so reading the state variable below would save this turn with no slug at
      // all — which is how the server came to hold projects with no `urlId`, and
      // how a collaborator ended up on a different URL from the owner.
      let effectiveUrlId = urlId;

      if (!urlId && firstArtifact?.id) {
        // console.log('💾 storeMessageHistory: Creating new URL ID for artifact:', firstArtifact.id);
        effectiveUrlId = await getUrlId(db, firstArtifact.id);

        // console.log('💾 storeMessageHistory: Navigating to new URL:', newUrlId);
        // Use setTimeout to ensure navigation happens after current render cycle
        setTimeout(() => {
          navigateChat(effectiveUrlId as string, navigate);
        }, 0);
        setUrlId(effectiveUrlId);
      }

      if (!description.get() && firstArtifact?.title) {
        // console.log('💾 storeMessageHistory: Setting description:', firstArtifact.title);
        description.set(firstArtifact?.title);
      }

      if (initialMessages.length === 0 && !chatId.get()) {
        // console.log('💾 storeMessageHistory: Creating new chat ID');
        const nextId = await getNextId();

        chatId.set(nextId);

        if (!effectiveUrlId) {
          // console.log('💾 storeMessageHistory: Navigating to new chat ID:', nextId);
          // Use setTimeout to ensure navigation happens after current render cycle
          setTimeout(() => {
            navigateChat(nextId, navigate);
          }, 0);
        }
      }

      // console.log('💾 storeMessageHistory: Saving messages to database');
      await setMessages(db, chatId.get() as string, messages, effectiveUrlId, description.get());
      // console.log('💾 storeMessageHistory: Messages saved successfully');
    },
  };
}

function navigateChat(nextId: string, navigate: ReturnType<typeof useNavigate>) {
  // console.log('🧭 navigateChat: Navigating to /chat/' + nextId);
  // Use proper Remix navigation instead of manual history manipulation
  navigate(`/chat/${nextId}`, { replace: true });
}

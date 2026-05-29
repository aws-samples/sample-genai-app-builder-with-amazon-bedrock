import { useLoaderData, useNavigate } from '@remix-run/react';
import { useState, useEffect } from 'react';
import { atom } from 'nanostores';
import type { Message } from 'ai';
import { toast } from 'react-toastify';
import { workbenchStore } from '~/lib/stores/workbench';
import { getMessages, getNextId, getUrlId, openDatabase, setMessages } from './db';

export interface ChatHistoryItem {
  id: string;
  urlId?: string;
  description?: string;
  messages: Message[];
  timestamp: string;
}

const persistenceEnabled = !import.meta.env.VITE_DISABLE_PERSISTENCE;

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

      if (!urlId && firstArtifact?.id) {
        // console.log('💾 storeMessageHistory: Creating new URL ID for artifact:', firstArtifact.id);
        const newUrlId = await getUrlId(db, firstArtifact.id);

        // console.log('💾 storeMessageHistory: Navigating to new URL:', newUrlId);
        // Use setTimeout to ensure navigation happens after current render cycle
        setTimeout(() => {
          navigateChat(newUrlId, navigate);
        }, 0);
        setUrlId(newUrlId);
      }

      if (!description.get() && firstArtifact?.title) {
        // console.log('💾 storeMessageHistory: Setting description:', firstArtifact.title);
        description.set(firstArtifact?.title);
      }

      if (initialMessages.length === 0 && !chatId.get()) {
        // console.log('💾 storeMessageHistory: Creating new chat ID');
        const nextId = await getNextId(db);

        chatId.set(nextId);

        if (!urlId) {
          // console.log('💾 storeMessageHistory: Navigating to new chat ID:', nextId);
          // Use setTimeout to ensure navigation happens after current render cycle
          setTimeout(() => {
            navigateChat(nextId, navigate);
          }, 0);
        }
      }

      // console.log('💾 storeMessageHistory: Saving messages to database');
      await setMessages(db, chatId.get() as string, messages, urlId, description.get());
      // console.log('💾 storeMessageHistory: Messages saved successfully');
    },
  };
}

function navigateChat(nextId: string, navigate: ReturnType<typeof useNavigate>) {
  // console.log('🧭 navigateChat: Navigating to /chat/' + nextId);
  // Use proper Remix navigation instead of manual history manipulation
  navigate(`/chat/${nextId}`, { replace: true });
}

import { useStore } from '@nanostores/react';
import type { Message } from 'ai';
import { useChat } from 'ai/react';
import { useAnimate } from 'framer-motion';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { cssTransition, toast, ToastContainer } from 'react-toastify';
import { useMessageParser, usePromptEnhancer, useShortcuts, useSnapScroll } from '~/lib/hooks';
import { useChatHistory } from '~/lib/persistence';
import { chatId as chatIdStore } from '~/lib/persistence';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { templateSettingsStore } from '~/lib/stores/templateSettings';
import { fileModificationsToHTML } from '~/utils/diff';
import { cubicEasingFn } from '~/utils/easings';
import { createScopedLogger, renderLogger } from '~/utils/logger';
import type { FileAttachment, AttachmentMeta } from '~/types/attachment';
import { validateFile, classifyFile, formatAttachmentsForMessage, buildMultimodalContent, encodeAttachmentMeta } from '~/lib/attachments/attachment-utils';
import { processAttachment, generateThumbnail } from '~/lib/attachments/file-parser';
import {
  clearAttachedSkill as clearAttachedSkillInDb,
  getAttachedSkill,
  setAttachedSkill as setAttachedSkillInDb,
} from '~/lib/brand-templates/chat-attachment';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';
import { renderBrandTemplateBlock } from '~/lib/brand-templates/system-prompt';
import { BaseChat } from './BaseChat';
import { signedFetch } from '~/lib/api/signed-fetch';

const toastAnimation = cssTransition({
  enter: 'animated fadeInRight',
  exit: 'animated fadeOutRight',
});

const logger = createScopedLogger('Chat');

export function Chat() {
  renderLogger.trace('Chat');
  // console.log('🎬 Chat: Component rendered');

  const { ready, initialMessages, storeMessageHistory } = useChatHistory();
  // console.log('🎬 Chat: useChatHistory returned', { ready, messagesCount: initialMessages.length });

  return (
    <>
      {ready && <ChatImpl initialMessages={initialMessages} storeMessageHistory={storeMessageHistory} />}
      <ToastContainer
        closeButton={({ closeToast }) => {
          return (
            <button className="Toastify__close-button" onClick={closeToast}>
              <div className="i-ph:x text-lg" />
            </button>
          );
        }}
        icon={({ type }) => {
          /**
           * @todo Handle more types if we need them. This may require extra color palettes.
           */
          switch (type) {
            case 'success': {
              return <div className="i-ph:check-bold text-bolt-elements-icon-success text-2xl" />;
            }
            case 'error': {
              return <div className="i-ph:warning-circle-bold text-bolt-elements-icon-error text-2xl" />;
            }
          }

          return undefined;
        }}
        position="bottom-right"
        pauseOnFocusLoss
        transition={toastAnimation}
      />
    </>
  );
}

interface ChatProps {
  initialMessages: Message[];
  storeMessageHistory: (messages: Message[]) => Promise<void>;
}

export const ChatImpl = memo(({ initialMessages, storeMessageHistory }: ChatProps) => {
  // console.log('🎭 ChatImpl: Component rendered with', initialMessages.length, 'initial messages');

  useShortcuts();

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [chatStarted, setChatStarted] = useState(initialMessages.length > 0);
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [attachedSkillId, setAttachedSkillIdState] = useState<string | null>(null);
  // Mirror of attachedSkillId read by the chat-id rehydrate effect without
  // listing attachedSkillId as a dep. See the rehydrate effect for why.
  const attachedSkillIdRef = useRef<string | null>(null);
  useEffect(() => {
    attachedSkillIdRef.current = attachedSkillId;
  }, [attachedSkillId]);
  const { showChat } = useStore(chatStore);
  const currentChatId = useStore(chatIdStore);
  const enableTemplate = useStore(templateSettingsStore.enableTemplate);
  const [animationScope, animate] = useAnimate();

  // Sync the in-memory attachment with IndexedDB when the chat id changes.
  //
  // Subtle: we must not blindly overwrite state with `null` when the chat
  // id first materializes for a brand-new conversation. If the user picked
  // a skill BEFORE sending the first message, `attachedSkillId` is already
  // in React state but not yet in IDB (we can't key IDB without a chat id).
  // If we wipe state on first chat-id mount, the very first request would
  // go out without the attachment, and the persistence effect would then
  // store `null` to IDB so subsequent turns also lose it. That was the
  // "my selected skill isn't being applied" bug.
  //
  // Rule: when chat id changes, prefer the IDB record if present. If IDB
  // has no record but we have an in-memory id (deferred pick case),
  // persist it and keep the in-memory id. Only clear state when the chat
  // id itself is cleared.
  useEffect(() => {
    if (!currentChatId) {
      setAttachedSkillIdState(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const record = await getAttachedSkill(currentChatId);
      if (cancelled) return;
      if (record?.skillId) {
        setAttachedSkillIdState(record.skillId);
      } else if (attachedSkillIdRef.current) {
        await setAttachedSkillInDb(currentChatId, attachedSkillIdRef.current);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentChatId]);

  const attachSkill = useCallback(
    async (skillId: string) => {
      if (!currentChatId) {
        // No chat id yet — persist to a pending chat id once we have one.
        setAttachedSkillIdState(skillId);
        toast.success('Brand template will attach when you send the first message.');
        return;
      }
      await setAttachedSkillInDb(currentChatId, skillId);
      setAttachedSkillIdState(skillId);
    },
    [currentChatId],
  );

  const clearSkill = useCallback(async () => {
    if (currentChatId) {
      await clearAttachedSkillInDb(currentChatId);
    }
    setAttachedSkillIdState(null);
  }, [currentChatId]);

  // Use the useChat hook with our custom fetch function
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    stop,
    setMessages,
    setInput,
    append,
  } = useChat({
    api: '/api/chat',
    initialMessages,
    body: {
      enableTemplate,
      attachedSkillId: attachedSkillId ?? undefined,
    },
    fetch: signedFetch,
    onError: (error) => {
      console.error("Error during chat:", error);
      toast.error('There was an error processing your request');
    },
    onFinish: () => {
      console.log('Chat finished');
    },
  });

  const isProcessingAttachments = attachments.some((a) => a.status === 'processing' || a.status === 'pending');

  const { enhancingPrompt, promptEnhanced, enhancePrompt, resetEnhancer } = usePromptEnhancer();
  const { parsedMessages, parseMessages } = useMessageParser();

  const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;

  useEffect(() => {
    // console.log('🎭 ChatImpl: Setting chat started state:', initialMessages.length > 0);
    chatStore.setKey('started', initialMessages.length > 0);
  }, []);

  useEffect(() => {
    // console.log('🎭 ChatImpl: Messages changed, parsing...');
    parseMessages(messages, isLoading);

    if (messages.length > initialMessages.length) {
      // console.log('🎭 ChatImpl: Storing message history...');
      storeMessageHistory(messages).catch((error) => {
        console.error('❌ ChatImpl: Error storing messages:', error);
        toast.error(error.message);
      });
    }
  }, [messages, isLoading, parseMessages, initialMessages.length, storeMessageHistory]);

  const scrollTextArea = () => {
    const textarea = textareaRef.current;

    if (textarea) {
      textarea.scrollTop = textarea.scrollHeight;
    }
  };

  const abort = () => {
    stop();
    chatStore.setKey('aborted', true);
    workbenchStore.abortAllActions();
  };

  useEffect(() => {
    const textarea = textareaRef.current;

    if (textarea) {
      textarea.style.height = 'auto';

      const scrollHeight = textarea.scrollHeight;

      textarea.style.height = `${Math.min(scrollHeight, TEXTAREA_MAX_HEIGHT)}px`;
      textarea.style.overflowY = scrollHeight > TEXTAREA_MAX_HEIGHT ? 'auto' : 'hidden';
    }
  }, [input, textareaRef]);

  const addAttachments = useCallback((files: FileList, type: 'document' | 'image') => {
    const currentDocs = attachments.filter((a) => a.type === 'document').length;
    const currentImages = attachments.filter((a) => a.type === 'image').length;
    let docCount = currentDocs;
    let imageCount = currentImages;

    Array.from(files).forEach((file) => {
      const fileType = type === 'document' ? 'document' : 'image';
      const validation = validateFile(
        file,
        fileType === 'document' ? docCount : 0,
        fileType === 'image' ? imageCount : 0,
      );
      if (!validation.valid) {
        toast.error(validation.error);
        return;
      }
      if (fileType === 'document') docCount++;
      else imageCount++;

      const attachment: FileAttachment = {
        id: crypto.randomUUID(),
        type: fileType,
        file,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        status: 'pending',
      };
      setAttachments((prev) => [...prev, attachment]);
      processAttachment(attachment, (updates) => {
        setAttachments((prev) =>
          prev.map((a) => (a.id === attachment.id ? { ...a, ...updates } : a)),
        );
      });
    });
  }, [attachments]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const handleFilesDropped = useCallback((files: FileList) => {
    const currentDocs = attachments.filter((a) => a.type === 'document').length;
    const currentImages = attachments.filter((a) => a.type === 'image').length;
    let docCount = currentDocs;
    let imageCount = currentImages;

    Array.from(files).forEach((file) => {
      const fileType = classifyFile(file);
      if (!fileType) {
        toast.error(`Unsupported file type: ${file.name}`);
        return;
      }
      const validation = validateFile(
        file,
        fileType === 'document' ? docCount : 0,
        fileType === 'image' ? imageCount : 0,
      );
      if (!validation.valid) {
        toast.error(validation.error);
        return;
      }
      if (fileType === 'document') docCount++;
      else imageCount++;

      const attachment: FileAttachment = {
        id: crypto.randomUUID(),
        type: fileType,
        file,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        status: 'pending',
      };
      setAttachments((prev) => [...prev, attachment]);
      processAttachment(attachment, (updates) => {
        setAttachments((prev) =>
          prev.map((a) => (a.id === attachment.id ? { ...a, ...updates } : a)),
        );
      });
    });
  }, [attachments]);

  const runAnimation = async () => {
    if (chatStarted) {
      return;
    }

    await Promise.all([
      animate('#examples', { opacity: 0, display: 'none' }, { duration: 0.1 }),
      animate('#intro', { opacity: 0, flex: 1 }, { duration: 0.2, ease: cubicEasingFn }),
    ]);

    chatStore.setKey('started', true);

    setChatStarted(true);
  };

  const sendMessage = async (event: React.UIEvent, messageInput?: string) => {
    const _input = messageInput || input;

    if ((_input.length === 0 && attachments.length === 0) || isLoading) {
      return;
    }

    if (isProcessingAttachments) {
      return;
    }

    await workbenchStore.saveAllFiles();

    const fileModifications = workbenchStore.getFileModifcations();

    chatStore.setKey('aborted', false);

    await runAnimation();

    // Build message content with attachments
    const readyDocs = attachments.filter((a) => a.type === 'document' && a.status === 'ready');
    const readyImages = attachments.filter((a) => a.type === 'image' && a.status === 'ready');

    // Build attachment metadata for chat history display
    const attachmentMeta: AttachmentMeta[] = await Promise.all(
      attachments
        .filter((a) => a.status === 'ready')
        .map(async (a) => ({
          name: a.name,
          size: a.size,
          type: a.type,
          mimeType: a.mimeType,
          thumbnailDataUrl: a.type === 'image'
            ? await generateThumbnail(a.file).catch(() => undefined)
            : undefined,
        })),
    );

    // Build text content for display (what UserMessage renders)
    let textContent = '';

    if (attachmentMeta.length > 0) {
      textContent += encodeAttachmentMeta(attachmentMeta) + '\n';
    }

    const attachmentsXml = formatAttachmentsForMessage(readyDocs);
    if (attachmentsXml) {
      textContent += attachmentsXml + '\n\n';
    }

    // Embed image data as parseable markers for the backend
    for (const img of readyImages) {
      if (img.base64Data && img.base64MediaType) {
        textContent += `<image_attachment media_type="${img.base64MediaType}">${img.base64Data}</image_attachment>\n`;
      }
    }

    if (fileModifications !== undefined) {
      const diff = fileModificationsToHTML(fileModifications);
      textContent += diff + '\n\n';
    }

    textContent += _input;

    // Always send as string — backend extracts images from markers.
    //
    // Brand template attachment: render the block on the CLIENT and pass it
    // as `brandTemplateBlock` in the per-call body. The client already has
    // the skill record in memory (listSkills + getSkill are what drive the
    // chip's own render), so there's no point making the streaming Lambda
    // re-fetch from DDB just to do the same rendering server-side. This
    // sidesteps the whole "server-side DDB lookup" failure mode entirely —
    // if the chip shows the skill, the chat receives the skill.
    //
    // We still send `attachedSkillId` for server-side logging and for any
    // future need to scope behavior by skill, but it's advisory now, not
    // required for the skill to be applied.
    const currentSkillId = attachedSkillIdRef.current ?? attachedSkillId;
    let brandTemplateBlock: string | undefined;
    if (currentSkillId) {
      try {
        const skill = await getBrandTemplatesClient().getSkill(currentSkillId);
        brandTemplateBlock = renderBrandTemplateBlock(skill);
      } catch (err) {
        logger.warn(
          `[brand-template] failed to hydrate skill ${currentSkillId} on client; sending without it.`,
          err,
        );
      }
    }
    logger.info(
      `[brand-template] send — chatId=${currentChatId ?? '<none>'} attachedSkillId=${currentSkillId ?? '<null>'} blockChars=${brandTemplateBlock?.length ?? 0}`,
    );
    append(
      { role: 'user', content: textContent },
      {
        body: {
          enableTemplate,
          ...(currentSkillId ? { attachedSkillId: currentSkillId } : {}),
          ...(brandTemplateBlock ? { brandTemplateBlock } : {}),
        },
      },
    );

    if (fileModifications !== undefined) {
      workbenchStore.resetAllFileModifications();
    }

    // Clear attachments and release memory
    setAttachments([]);
    setInput('');
    resetEnhancer();
    textareaRef.current?.blur();
  };

  const [messageRef, scrollRef] = useSnapScroll();

  return (
    <BaseChat
      ref={animationScope}
      textareaRef={textareaRef}
      input={input}
      showChat={showChat}
      chatStarted={chatStarted}
      isStreaming={isLoading}
      enhancingPrompt={enhancingPrompt}
      promptEnhanced={promptEnhanced}
      sendMessage={sendMessage}
      messageRef={messageRef}
      scrollRef={scrollRef}
      handleInputChange={handleInputChange}
      handleStop={abort}
      attachments={attachments}
      isProcessingAttachments={isProcessingAttachments}
      attachedSkillId={attachedSkillId}
      onAddAttachments={addAttachments}
      onRemoveAttachment={removeAttachment}
      onFilesDropped={handleFilesDropped}
      onAttachSkill={(skillId) => void attachSkill(skillId)}
      onClearSkill={() => void clearSkill()}
      messages={messages.map((message, i) => {
        if (message.role === 'user') {
          return message;
        }

        return {
          ...message,
          content: parsedMessages[i] || '',
        };
      })}
      enhancePrompt={() => {
        enhancePrompt(input, (input) => {
          setInput(input);
          scrollTextArea();
        });
      }}
    />
  );
});

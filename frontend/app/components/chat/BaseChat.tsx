import type { Message } from 'ai';
import React, { type RefCallback } from 'react';
import { Link } from '@remix-run/react';
import { useStore } from '@nanostores/react';
import { ClientOnly } from '~/components/ui/ClientOnly';
import { Menu } from '~/components/sidebar/Menu.client';
import { Workbench } from '~/components/workbench/Workbench.client';
import { classNames } from '~/utils/classNames';
import { Messages } from './Messages.client';
import { PlatformMetrics } from './PlatformMetrics';
import { SendButton } from './SendButton.client';
import { AttachmentButton } from './AttachmentButton';
import { AttachmentChip } from './AttachmentChip';
import { FileDropZone } from './FileDropZone';
import { selectedModelId, AVAILABLE_MODELS } from '~/lib/stores/model';
import type { FileAttachment } from '~/types/attachment';

import styles from './BaseChat.module.scss';
import { AttachedTemplateChip } from './AttachedTemplateChip';

interface BaseChatProps {
  textareaRef?: React.RefObject<HTMLTextAreaElement> | undefined;
  messageRef?: RefCallback<HTMLDivElement> | undefined;
  scrollRef?: RefCallback<HTMLDivElement> | undefined;
  showChat?: boolean;
  chatStarted?: boolean;
  isStreaming?: boolean;
  messages?: Message[];
  enhancingPrompt?: boolean;
  promptEnhanced?: boolean;
  input?: string;
  attachments?: FileAttachment[];
  isProcessingAttachments?: boolean;
  attachedSkillId?: string | null;
  handleStop?: () => void;
  sendMessage?: (event: React.UIEvent, messageInput?: string) => void;
  handleInputChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  enhancePrompt?: () => void;
  onAddAttachments?: (files: FileList, type: 'document' | 'image') => void;
  onRemoveAttachment?: (id: string) => void;
  onFilesDropped?: (files: FileList) => void;
  onAttachSkill?: (skillId: string) => void;
  onClearSkill?: () => void;
}

const EXAMPLE_PROMPTS = [
  { text: 'Build a customer analytics dashboard with charts' },
  { text: 'Create a GenAI chatbot interface with streaming' },
  { text: 'Design a product recommendation engine UI' },
  { text: 'Build an internal employee directory app' },
  { text: 'Create a document Q&A interface powered by AI' },
];

const TEXTAREA_MIN_HEIGHT = 76;

export const BaseChat = React.forwardRef<HTMLDivElement, BaseChatProps>(
  (
    {
      textareaRef,
      messageRef,
      scrollRef,
      showChat = true,
      chatStarted = false,
      isStreaming = false,
      enhancingPrompt = false,
      promptEnhanced = false,
      messages,
      input = '',
      attachments = [],
      isProcessingAttachments = false,
      attachedSkillId = null,
      sendMessage,
      handleInputChange,
      enhancePrompt,
      handleStop,
      onAddAttachments,
      onRemoveAttachment,
      onFilesDropped,
      onAttachSkill,
      onClearSkill,
    },
    ref,
  ) => {
    const TEXTAREA_MAX_HEIGHT = chatStarted ? 400 : 200;
    const currentModelId = useStore(selectedModelId);
    const hasAttachments = attachments.length > 0;
    const showSendButton = input.length > 0 || isStreaming || hasAttachments;

    return (
      <div
        ref={ref}
        className={classNames(
          styles.BaseChat,
          'relative flex h-full w-full overflow-hidden bg-bolt-elements-background-depth-1',
        )}
        data-chat-visible={showChat}
      >
        <ClientOnly>{() => <Menu />}</ClientOnly>
        <div ref={scrollRef} className="flex overflow-y-auto w-full h-full">
          <div className={classNames(styles.Chat, 'flex flex-col flex-grow min-w-[var(--chat-min-width)] h-full')}>
            {!chatStarted && (
              <div id="intro" className="mt-20 max-w-chat mx-auto">
                <img src="/bedrock_vibe.png" alt="Vibe Logo" className="mx-auto mb-4 w-64" />
                <h1 className="text-5xl text-center font-bold text-bolt-elements-textPrimary mb-2">
                  Where ideas begin
                </h1>
                <p className="mb-4 text-center text-bolt-elements-textSecondary">
                  Bring ideas to life in seconds or get help on existing projects.
                </p>
                <div className="mb-6 flex justify-center">
                  <Link
                    to="/brand-templates"
                    className="inline-flex items-center gap-1.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-1 text-xs text-bolt-elements-textSecondary transition-colors hover:border-bolt-elements-focus hover:text-bolt-elements-textPrimary"
                  >
                    <span className="i-ph:paint-brush-broad text-sm" />
                    Manage brand templates
                  </Link>
                </div>
                <PlatformMetrics />
              </div>
            )}
            <div
              className={classNames('pt-6 px-6', {
                'h-full flex flex-col': chatStarted,
              })}
            >
              <ClientOnly>
                {() => {
                  return chatStarted ? (
                    <Messages
                      ref={messageRef}
                      className="flex flex-col w-full flex-1 max-w-chat px-4 pb-6 mx-auto z-1"
                      messages={messages}
                      isStreaming={isStreaming}
                    />
                  ) : null;
                }}
              </ClientOnly>
              <div
                className={classNames('relative w-full max-w-chat mx-auto z-prompt', {
                  'sticky bottom-0': chatStarted,
                })}
              >
                <FileDropZone
                  onFilesDropped={(files) => onFilesDropped?.(files)}
                  disabled={isStreaming}
                >
                  <div
                    className={classNames(
                      'shadow-sm border border-bolt-elements-borderColor bg-bolt-elements-prompt-background backdrop-filter backdrop-blur-[8px] rounded-lg',
                    )}
                  >
                    {hasAttachments && (
                      <div className="flex flex-wrap gap-2 px-4 pt-3">
                        {attachments.map((attachment) => (
                          <AttachmentChip
                            key={attachment.id}
                            attachment={attachment}
                            onRemove={onRemoveAttachment}
                          />
                        ))}
                      </div>
                    )}
                    {attachedSkillId && (
                      <div className="flex flex-wrap gap-2 px-4 pt-3">
                        <AttachedTemplateChip
                          skillId={attachedSkillId}
                          onClear={() => onClearSkill?.()}
                        />
                      </div>
                    )}
                    <div className="flex items-end">
                      <div className="pl-3 pb-3 pt-2">
                        <AttachmentButton
                          onFilesSelected={(files, type) => onAddAttachments?.(files, type)}
                          onSkillSelected={onAttachSkill ? (skillId) => onAttachSkill(skillId) : undefined}
                          disabled={isStreaming}
                        />
                      </div>
                      <textarea
                        ref={textareaRef}
                        className={`w-full pl-2 pt-4 pr-16 focus:outline-none resize-none text-md text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary bg-transparent`}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            if (event.shiftKey) {
                              return;
                            }
                            event.preventDefault();
                            if (!isProcessingAttachments) {
                              sendMessage?.(event);
                            }
                          }
                        }}
                        value={input}
                        onChange={(event) => {
                          handleInputChange?.(event);
                        }}
                        style={{
                          minHeight: TEXTAREA_MIN_HEIGHT,
                          maxHeight: TEXTAREA_MAX_HEIGHT,
                        }}
                        placeholder="What would you like to build today?"
                        translate="no"
                      />
                      <ClientOnly>
                        {() => (
                          <SendButton
                            show={showSendButton}
                            isStreaming={isStreaming}
                            disabled={isProcessingAttachments}
                            onClick={(event) => {
                              if (isStreaming) {
                                handleStop?.();
                                return;
                              }
                              sendMessage?.(event);
                            }}
                          />
                        )}
                      </ClientOnly>
                    </div>
                    <div className="flex justify-end text-sm p-4 pt-2">
                      <div className="flex gap-1 items-center">
                        <select
                          value={currentModelId}
                          onChange={(e) => selectedModelId.set(e.target.value)}
                          className="px-2 py-1 text-sm rounded border-0 bg-transparent text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary focus:outline-none cursor-pointer transition-all"
                          title="Select AI Model"
                        >
                          {AVAILABLE_MODELS.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {input.length > 3 ? (
                        <div className="text-xs text-bolt-elements-textTertiary">
                          Use <kbd className="kdb">Shift</kbd> + <kbd className="kdb">Return</kbd> for a new line
                        </div>
                      ) : null}
                    </div>
                  </div>
                </FileDropZone>
                <div className="bg-bolt-elements-background-depth-1 pb-6">{/* Ghost Element */}</div>
                <p className="text-xs text-center text-bolt-elements-textTertiary pb-2">
                  Note: Please do not upload or include any customer data in your prompts.
                </p>
              </div>
            </div>
            {!chatStarted && (
              <div id="examples" className="relative w-full max-w-xl mx-auto mt-8 flex justify-center">
                <div className="flex flex-col space-y-2 [mask-image:linear-gradient(to_bottom,black_0%,transparent_180%)] hover:[mask-image:none]">
                  {EXAMPLE_PROMPTS.map((examplePrompt, index) => {
                    return (
                      <button
                        key={index}
                        onClick={(event) => {
                          sendMessage?.(event, examplePrompt.text);
                        }}
                        className="group flex items-center w-full gap-2 justify-center bg-transparent text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary transition-theme"
                      >
                        {examplePrompt.text}
                        <div className="i-ph:arrow-bend-down-left" />
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          <ClientOnly>{() => <Workbench chatStarted={chatStarted} isStreaming={isStreaming} />}</ClientOnly>
        </div>
      </div>
    );
  },
);

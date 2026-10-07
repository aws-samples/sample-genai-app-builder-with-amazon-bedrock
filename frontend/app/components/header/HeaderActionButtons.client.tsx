import { useStore } from '@nanostores/react';
import { chatStore } from '~/lib/stores/chat';
import { workbenchStore } from '~/lib/stores/workbench';
import { classNames } from '~/utils/classNames';
import { TemplateToggle } from './TemplateToggle';

export interface HeaderActionButtonsProps {
  className?: string;
}

export function HeaderActionButtons({ className }: HeaderActionButtonsProps) {
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const { showChat, started } = useStore(chatStore);

  const canHideChat = showWorkbench || !showChat;

  return (
    <div className={classNames("flex items-center gap-4", className)}>
      {!started && <TemplateToggle />}
      
      <div className="flex border border-vibe-elements-borderColor rounded-md overflow-hidden">
        <Button
          active={showChat}
          disabled={!canHideChat}
          onClick={() => {
            if (canHideChat) {
              chatStore.setKey('showChat', !showChat);
            }
          }}
        >
          <div className="i-vibe:chat text-sm" />
        </Button>
        <div className="w-[1px] bg-vibe-elements-borderColor" />
        <Button
          active={showWorkbench}
          onClick={() => {
            if (showWorkbench && !showChat) {
              chatStore.setKey('showChat', true);
            }

            workbenchStore.showWorkbench.set(!showWorkbench);
          }}
        >
          <div className="i-ph:code-bold" />
        </Button>
      </div>
    </div>
  );
}

interface ButtonProps {
  active?: boolean;
  disabled?: boolean;
  children?: any;
  onClick?: VoidFunction;
}

function Button({ active = false, disabled = false, children, onClick }: ButtonProps) {
  return (
    <button
      className={classNames('flex items-center p-1.5', {
        'bg-vibe-elements-item-backgroundDefault hover:bg-vibe-elements-item-backgroundActive text-vibe-elements-textTertiary hover:text-vibe-elements-textPrimary':
          !active,
        'bg-vibe-elements-item-backgroundAccent text-vibe-elements-item-contentAccent': active && !disabled,
        'bg-vibe-elements-item-backgroundDefault text-alpha-gray-20 cursor-not-allowed':
          disabled,
      })}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

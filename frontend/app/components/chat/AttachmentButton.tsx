import { useRef, useState, useEffect, useCallback } from 'react';
import { DOCUMENT_ACCEPT, IMAGE_ACCEPT } from '~/types/attachment';
import { BrandTemplatePicker } from './BrandTemplatePicker';

interface AttachmentButtonProps {
  onFilesSelected: (files: FileList, type: 'document' | 'image') => void;
  onSkillSelected?: (skillId: string) => void;
  disabled?: boolean;
}

export function AttachmentButton({
  onFilesSelected,
  onSkillSelected,
  disabled = false,
}: AttachmentButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const handleClickOutside = useCallback((event: MouseEvent) => {
    if (
      popoverRef.current &&
      !popoverRef.current.contains(event.target as Node) &&
      buttonRef.current &&
      !buttonRef.current.contains(event.target as Node)
    ) {
      setIsOpen(false);
      setSkillPickerOpen(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen || skillPickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, skillPickerOpen, handleClickOutside]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>, type: 'document' | 'image') => {
    const files = event.target.files;
    if (files && files.length > 0) {
      onFilesSelected(files, type);
    }
    event.target.value = '';
    setIsOpen(false);
  };

  return (
    <div className="relative z-50">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        disabled={disabled}
        className="flex items-center justify-center w-8 h-8 rounded-full bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-4 transition-theme disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Add attachments"
        title="Add attachments"
      >
        <div className="i-ph:plus text-lg" />
      </button>

      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute bottom-full left-0 mb-2 bg-bolt-elements-background-depth-2 border border-bolt-elements-borderColor rounded-lg shadow-lg overflow-hidden z-50 min-w-[200px]"
        >
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-left gap-3 w-full px-4 py-3 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-theme"
          >
            <div className="i-ph:paperclip text-lg" />
            Upload files
          </button>
          <button
            onClick={() => imageInputRef.current?.click()}
            className="flex items-left gap-3 w-full px-4 py-3 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-theme"
          >
            <div className="i-ph:image text-lg" />
            Upload reference image
          </button>
          {onSkillSelected && (
            <button
              onClick={() => {
                setIsOpen(false);
                setSkillPickerOpen(true);
              }}
              className="flex items-left gap-3 w-full px-4 py-3 text-sm text-bolt-elements-textPrimary hover:bg-bolt-elements-background-depth-3 transition-theme border-t border-bolt-elements-borderColor"
            >
              <div className="i-ph:paint-brush-broad text-lg" />
              Attach brand template
            </button>
          )}
        </div>
      )}

      {onSkillSelected && (
        <BrandTemplatePicker
          open={skillPickerOpen}
          onSelect={(skillId) => onSkillSelected(skillId)}
          onClose={() => setSkillPickerOpen(false)}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => handleFileChange(e, 'document')}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => handleFileChange(e, 'image')}
      />
    </div>
  );
}

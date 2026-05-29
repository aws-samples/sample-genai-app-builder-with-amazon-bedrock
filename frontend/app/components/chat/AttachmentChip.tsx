import { formatFileSize } from '~/lib/attachments/attachment-utils';
import type { FileAttachment } from '~/types/attachment';

interface AttachmentChipProps {
  attachment: FileAttachment;
  onRemove?: (id: string) => void;
  readOnly?: boolean;
}

export function AttachmentChip({ attachment, onRemove, readOnly = false }: AttachmentChipProps) {
  const isProcessing = attachment.status === 'processing';
  const isError = attachment.status === 'error';
  const isImage = attachment.type === 'image';

  return (
    <div
      className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-theme ${
        isError
          ? 'bg-red-500/10 border border-red-500/30'
          : 'bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor'
      }`}
      title={isError ? attachment.error : attachment.name}
    >
      {isProcessing ? (
        <div className="i-svg-spinners:90-ring-with-bg text-bolt-elements-loader-progress text-base flex-shrink-0" />
      ) : isImage && attachment.base64Data ? (
        <img
          src={`data:${attachment.base64MediaType};base64,${attachment.base64Data}`}
          alt={attachment.name}
          className="w-8 h-8 rounded object-cover flex-shrink-0"
        />
      ) : (
        <div
          className={`text-base flex-shrink-0 ${
            isError
              ? 'i-ph:warning-circle text-red-500'
              : attachment.mimeType === 'application/pdf'
                ? 'i-ph:file-pdf text-red-400'
                : attachment.mimeType.includes('wordprocessingml')
                  ? 'i-ph:file-doc text-blue-400'
                  : 'i-ph:file-text text-bolt-elements-textSecondary'
          }`}
        />
      )}

      <div className="flex flex-col min-w-0">
        <span className="text-bolt-elements-textPrimary truncate max-w-[150px] text-xs">
          {attachment.name}
        </span>
        <span className="text-bolt-elements-textTertiary text-[10px]">
          {formatFileSize(attachment.size)}
        </span>
      </div>

      {!readOnly && onRemove && (
        <button
          onClick={() => onRemove(attachment.id)}
          className="flex-shrink-0 text-bolt-elements-textTertiary hover:text-bolt-elements-textPrimary transition-theme p-0.5"
          aria-label={`Remove ${attachment.name}`}
        >
          <div className="i-ph:x text-sm" />
        </button>
      )}
    </div>
  );
}

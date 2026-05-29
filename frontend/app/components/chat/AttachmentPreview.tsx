import { formatFileSize } from '~/lib/attachments/attachment-utils';
import type { AttachmentMeta } from '~/types/attachment';

interface AttachmentPreviewProps {
  attachments: AttachmentMeta[];
}

export function AttachmentPreview({ attachments }: AttachmentPreviewProps) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 mb-2">
      {attachments.map((attachment, index) => (
        <div
          key={index}
          className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-bolt-elements-background-depth-3 border border-bolt-elements-borderColor"
        >
          {attachment.type === 'image' && attachment.thumbnailDataUrl ? (
            <img
              src={attachment.thumbnailDataUrl}
              alt={attachment.name}
              className="w-10 h-10 rounded object-cover flex-shrink-0"
            />
          ) : (
            <div
              className={`text-base flex-shrink-0 ${
                attachment.mimeType === 'application/pdf'
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
        </div>
      ))}
    </div>
  );
}

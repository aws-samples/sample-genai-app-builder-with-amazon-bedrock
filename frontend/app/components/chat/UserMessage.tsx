import { modificationsRegex } from '~/utils/diff';
import { Markdown } from './Markdown';
import { AttachmentPreview } from './AttachmentPreview';
import { decodeAttachmentMeta, stripAttachmentMarkup } from '~/lib/attachments/attachment-utils';

interface UserMessageProps {
  content: string;
}

export function UserMessage({ content }: UserMessageProps) {
  const attachmentMeta = decodeAttachmentMeta(content);
  const displayContent = sanitizeUserMessage(content);

  return (
    <div className="overflow-hidden pt-[4px]">
      {attachmentMeta.length > 0 && <AttachmentPreview attachments={attachmentMeta} />}
      {displayContent && <Markdown limitedMarkdown>{displayContent}</Markdown>}
    </div>
  );
}

function sanitizeUserMessage(content: string) {
  return stripAttachmentMarkup(content)
    .replace(modificationsRegex, '')
    .trim();
}

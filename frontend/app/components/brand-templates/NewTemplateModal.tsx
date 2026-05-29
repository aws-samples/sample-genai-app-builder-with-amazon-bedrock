import { useRef, useState } from 'react';
import type { CreateSkillResponse } from '~/lib/brand-templates/client';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';
import { recordPendingJob } from '~/lib/brand-templates/pending-jobs';

interface NewTemplateModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (response: CreateSkillResponse) => void;
}

type Source = 'images' | 'url';

const MAX_FILES = 5;
const ACCEPT = '.png,.jpg,.jpeg,.webp';

export function NewTemplateModal({ open, onClose, onCreated }: NewTemplateModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [source, setSource] = useState<Source>('images');
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  function reset() {
    setName('');
    setDescription('');
    setTagsText('');
    setSource('images');
    setFiles([]);
    setUrl('');
    setError(null);
    setSubmitting(false);
  }

  function close() {
    reset();
    onClose();
  }

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    const merged = [...files, ...Array.from(incoming)].slice(0, MAX_FILES);
    setFiles(merged);
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  const tags = tagsText
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  async function submit() {
    setError(null);

    if (!name.trim()) {
      setError('Name is required.');
      return;
    }

    if (source === 'images') {
      if (files.length === 0) {
        setError('Add 1 to 5 images.');
        return;
      }
    } else {
      if (!url.trim().startsWith('https://')) {
        setError('URL must start with https://');
        return;
      }
    }

    setSubmitting(true);

    try {
      const client = getBrandTemplatesClient();
      const response =
        source === 'images'
          ? await client.createFromImages({
              name: name.trim(),
              description: description.trim() || undefined,
              tags: tags.length > 0 ? tags : undefined,
              files,
            })
          : await client.createFromUrl({
              name: name.trim(),
              description: description.trim() || undefined,
              tags: tags.length > 0 ? tags : undefined,
              url: url.trim(),
            });
      // Persist so PendingExtractionsWatcher can resume polling and toast
      // the user if they navigate away or refresh during the extraction.
      // Failure here doesn't block the UI flow — the in-route progress
      // page still works as a fallback.
      void recordPendingJob({
        jobId: response.jobId,
        skillId: response.skillId,
        name: name.trim(),
        startedAt: new Date().toISOString(),
      });
      onCreated(response);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create template.');
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1"
      >
        <header className="flex items-center justify-between border-b border-bolt-elements-borderColor px-6 py-4">
          <h2 className="text-base font-medium text-bolt-elements-textPrimary">
            New brand template
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded p-1 text-bolt-elements-textTertiary transition-colors hover:bg-bolt-elements-background-depth-3 hover:text-bolt-elements-textPrimary"
          >
            <div className="i-ph:x text-base" />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-6 py-5">
          <FormField label="Name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Linear-inspired"
              maxLength={80}
              className="w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:border-bolt-elements-focus focus:outline-none"
            />
          </FormField>

          <FormField label="Description">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short note about when to reach for this template."
              maxLength={500}
              rows={2}
              className="w-full resize-none rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:border-bolt-elements-focus focus:outline-none"
            />
          </FormField>

          <FormField label="Tags (comma-separated)">
            <input
              type="text"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="editorial, blue, minimal"
              className="w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:border-bolt-elements-focus focus:outline-none"
            />
          </FormField>

          <FormField label="Source">
            <div className="flex gap-2 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-1 text-sm">
              <SourceTab active={source === 'images'} onClick={() => setSource('images')}>
                Inspiration images
              </SourceTab>
              <SourceTab active={source === 'url'} onClick={() => setSource('url')}>
                Website URL
              </SourceTab>
            </div>
          </FormField>

          {source === 'images' ? (
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={files.length >= MAX_FILES}
                className="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-10 text-sm text-bolt-elements-textSecondary transition-colors hover:border-bolt-elements-focus hover:text-bolt-elements-textPrimary disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="i-ph:upload-simple text-xl" />
                <span>
                  {files.length === 0
                    ? 'Drop or click to add images'
                    : files.length >= MAX_FILES
                    ? 'Maximum 5 images'
                    : `Add more (${MAX_FILES - files.length} remaining)`}
                </span>
                <span className="text-xs text-bolt-elements-textTertiary">
                  PNG · JPG · WebP, up to 5 files
                </span>
              </button>
              {files.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {files.map((file, idx) => (
                    <li
                      key={`${file.name}-${idx}`}
                      className="flex items-center justify-between gap-2 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate text-bolt-elements-textPrimary">
                        {file.name}
                      </span>
                      <span className="shrink-0 text-bolt-elements-textTertiary">
                        {formatBytes(file.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFile(idx)}
                        className="shrink-0 rounded p-1 text-bolt-elements-textTertiary transition-colors hover:bg-bolt-elements-background-depth-3 hover:text-red-400"
                        aria-label={`Remove ${file.name}`}
                      >
                        <div className="i-ph:x text-xs" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <FormField label="URL">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://linear.app"
                className="w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary focus:border-bolt-elements-focus focus:outline-none"
              />
              <p className="mt-1 text-xs text-bolt-elements-textTertiary">
                We fetch the public page. No login-gated content.
              </p>
            </FormField>
          )}

          {error && (
            <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-bolt-elements-borderColor px-6 py-4">
          <button
            type="button"
            onClick={close}
            disabled={submitting}
            className="rounded-md bg-bolt-elements-button-secondary-background px-3 py-1.5 text-sm text-bolt-elements-button-secondary-text transition-colors hover:bg-bolt-elements-button-secondary-backgroundHover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-bolt-elements-button-primary-background px-3 py-1.5 text-sm font-medium text-bolt-elements-button-primary-text transition-colors hover:bg-bolt-elements-button-primary-backgroundHover disabled:opacity-50"
          >
            {submitting && (
              <div className="i-svg-spinners:90-ring-with-bg text-sm" />
            )}
            {submitting ? 'Extracting…' : 'Extract'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function FormField({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-bolt-elements-textSecondary">
        {label}
        {required && <span className="ml-0.5 text-red-400">*</span>}
      </span>
      {children}
    </label>
  );
}

function SourceTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded px-3 py-1.5 text-sm transition-colors ${
        active
          ? 'bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary'
          : 'text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary'
      }`}
    >
      {children}
    </button>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

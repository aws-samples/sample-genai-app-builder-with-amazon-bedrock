import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@remix-run/react';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';
import type { BrandTemplateSummary } from '~/types/brandTemplate';

interface BrandTemplatePickerProps {
  open: boolean;
  anchorClassName?: string;
  onSelect: (skillId: string) => void;
  onClose: () => void;
}

/**
 * Popover above the chat composer for picking a brand template to attach.
 *
 * Design choices:
 *  - No drop shadow. A 1px border + depth-2 background is enough contrast
 *    against the composer's depth-1 background.
 *  - Swatch band rendered inline — no PaletteSwatch override hacks.
 *  - Manage-skills footer stays pinned at the bottom rather than scrolling
 *    with the list, so the action is always one click away.
 */
export function BrandTemplatePicker({
  open,
  anchorClassName,
  onSelect,
  onClose,
}: BrandTemplatePickerProps) {
  const [skills, setSkills] = useState<BrandTemplateSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const list = await getBrandTemplatesClient().listSkills();
        setSkills(list.filter((s) => s.status === 'ready'));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load skills.');
      } finally {
        setLoading(false);
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    })();
  }, [open]);

  if (!open) return null;

  const filtered = (skills ?? []).filter((s) => {
    if (!query.trim()) return true;
    const q = query.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.styleDescriptorLabel ?? '').toLowerCase().includes(q) ||
      (s.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  });

  return (
    <div
      className={`absolute bottom-full left-0 mb-2 w-72 overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 ${anchorClassName ?? ''}`}
    >
      <div className="border-b border-bolt-elements-borderColor p-2">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search brand templates…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded border border-transparent bg-bolt-elements-background-depth-3 px-2 py-1.5 text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary transition-colors focus:border-bolt-elements-focus focus:outline-none"
        />
      </div>

      <div className="max-h-64 overflow-y-auto">
        {loading ? (
          <p className="px-4 py-3 text-sm text-bolt-elements-textSecondary">
            Loading…
          </p>
        ) : error ? (
          <p className="px-4 py-3 text-sm text-red-400">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="px-4 py-3 text-sm text-bolt-elements-textSecondary">
            {skills && skills.length === 0
              ? 'No brand templates yet.'
              : 'No matches.'}
          </p>
        ) : (
          <ul>
            {filtered.map((s) => (
              <li key={s.skillId}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(s.skillId);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-bolt-elements-background-depth-3"
                >
                  <SwatchBand colors={s.previewColors} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-bolt-elements-textPrimary">
                      {s.name}
                    </p>
                    <p className="truncate text-[10px] text-bolt-elements-textTertiary">
                      {s.styleDescriptorLabel || '—'}
                    </p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-bolt-elements-borderColor">
        <button
          type="button"
          onClick={() => {
            onClose();
            navigate('/brand-templates');
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-sm text-bolt-elements-textSecondary transition-colors hover:bg-bolt-elements-background-depth-3 hover:text-bolt-elements-textPrimary"
        >
          <div className="i-ph:gear text-sm" />
          Manage skills
        </button>
      </div>
    </div>
  );
}

function SwatchBand({ colors }: { colors: string[] }) {
  const shown = (colors || []).slice(0, 5);
  if (shown.length === 0) {
    return (
      <div className="h-6 w-12 shrink-0 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3" />
    );
  }
  return (
    <div className="flex h-6 w-12 shrink-0 overflow-hidden rounded border border-bolt-elements-borderColor">
      {shown.map((hex, idx) => (
        <div
          key={`${hex}-${idx}`}
          className="flex-1"
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
}

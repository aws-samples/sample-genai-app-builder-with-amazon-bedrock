import { Link } from '@remix-run/react';
import type { BrandTemplateSummary } from '~/types/brandTemplate';
import { PaletteSwatch } from './PaletteSwatch';

interface TemplateCardProps {
  skill: BrandTemplateSummary;
  onDelete?: (skillId: string) => void;
}

/**
 * Gallery card.
 *
 * Layout rules:
 *  - Single anchor for the whole card (Link wrapping the article), so the
 *    entire surface is clickable and keyboard-focusable. The previous
 *    implementation nested a <button> inside another <button>, which is
 *    invalid HTML and caused clicks to be swallowed in some browsers.
 *  - Delete control lives OUTSIDE the link, positioned absolutely, and uses
 *    a plain button (no shadow, no overlay). It's hidden until hover/focus
 *    so it doesn't fight the palette for attention.
 *  - Status chip sits inline with the name so it doesn't compete with the
 *    delete overlay for the top-right corner.
 *  - No drop shadow on the card. Border + background shift on hover carries
 *    the affordance. Keeps the gallery quiet and dense.
 */
export function TemplateCard({ skill, onDelete }: TemplateCardProps) {
  const statusChip = STATUS_CHIPS[skill.status];

  return (
    <article className="group relative flex flex-col overflow-hidden rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 transition-colors hover:border-bolt-elements-focus focus-within:border-bolt-elements-focus">
      <Link
        to={`/brand-templates/${skill.skillId}`}
        aria-label={`Open ${skill.name}`}
        className="flex flex-col gap-3 p-4 focus:outline-none"
      >
        <PaletteSwatch colors={skill.previewColors} size="sm" />

        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-medium text-bolt-elements-textPrimary">
              {skill.name}
            </h3>
            <p className="mt-0.5 truncate text-xs text-bolt-elements-textTertiary">
              {skill.styleDescriptorLabel || '—'}
            </p>
          </div>
          {statusChip && (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusChip.tone}`}
            >
              {statusChip.label}
            </span>
          )}
        </div>

        {(skill.tags?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1">
            {skill.tags!.slice(0, 4).map((tag) => (
              <span
                key={tag}
                className="rounded bg-bolt-elements-background-depth-3 px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </Link>

      {onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (confirm(`Delete "${skill.name}"?`)) {
              onDelete(skill.skillId);
            }
          }}
          aria-label="Delete template"
          title="Delete"
          className="absolute right-2 top-2 rounded p-1 text-bolt-elements-textTertiary opacity-0 transition-opacity hover:bg-bolt-elements-background-depth-3 hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
        >
          <div className="i-ph:trash text-sm" />
        </button>
      )}
    </article>
  );
}

const STATUS_CHIPS: Record<
  BrandTemplateSummary['status'],
  { label: string; tone: string }
> = {
  processing: { label: 'Extracting', tone: 'bg-yellow-500/15 text-yellow-400' },
  ready: { label: 'Ready', tone: 'bg-green-500/15 text-green-400' },
  failed: { label: 'Failed', tone: 'bg-red-500/15 text-red-400' },
};

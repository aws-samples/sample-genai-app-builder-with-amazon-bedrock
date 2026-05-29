import { useEffect, useState } from 'react';
import { Link } from '@remix-run/react';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';
import type { BrandTemplate, BrandTemplateSummary } from '~/types/brandTemplate';

interface AttachedTemplateChipProps {
  skillId: string;
  onClear: () => void;
}

/**
 * Pill + disclosure shown above the chat textarea when a brand template is
 * attached.
 *
 * Collapsed (default): a single-line pill with palette swatches + skill
 * name + style descriptor. Unobtrusive, stays out of the way while the
 * user types.
 *
 * Expanded (click the name): a compact card slides in below the pill
 * showing what the model will actually receive - palette hexes, type
 * families, shadow/border/radius intents, copy voice forbidden patterns.
 * This is the "what is this skill going to enforce on my output?" answer
 * users have been asking after every turn.
 *
 * Implementation uses native <details>/<summary> for keyboard accessibility
 * + no state plumbing. The summary receives the skill info; the panel is
 * fetched lazily when expanded so the list-skills call at mount stays
 * cheap.
 */
export function AttachedTemplateChip({ skillId, onClear }: AttachedTemplateChipProps) {
  const [summary, setSummary] = useState<BrandTemplateSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [fullSkill, setFullSkill] = useState<BrandTemplate | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // When the attached skill id changes (picker swap), reset every
  // derived piece of state so the chip can't render stale data from the
  // previous skill. Without this, the expanded panel would keep showing
  // the previous skill's palette / typography / intents because
  // `fullSkill` is only cleared on unmount.
  useEffect(() => {
    setSummary(null);
    setMissing(false);
    setExpanded(false);
    setFullSkill(null);
    setDetailError(null);
  }, [skillId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getBrandTemplatesClient().listSkills();
        const found = list.find((s) => s.skillId === skillId);
        if (cancelled) return;
        if (found) {
          setSummary(found);
        } else {
          setMissing(true);
        }
      } catch {
        if (!cancelled) setMissing(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  // Lazy-load the full skill on first expand only. Subsequent opens reuse
  // the cached copy so toggling stays snappy.
  useEffect(() => {
    if (!expanded || !summary || fullSkill) return;
    let cancelled = false;
    (async () => {
      try {
        const skill = await getBrandTemplatesClient().getSkill(skillId);
        if (!cancelled) setFullSkill(skill);
      } catch (err) {
        if (!cancelled) {
          setDetailError(err instanceof Error ? err.message : 'Failed to load skill details.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, skillId, summary, fullSkill]);

  if (missing) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-1 text-xs text-yellow-400">
        <div className="i-ph:warning-circle text-sm" />
        <span>Attached skill is no longer available</span>
        <ClearButton onClick={onClear} tone="warning" />
      </div>
    );
  }

  if (!summary) return null;

  const swatchColors = (summary.previewColors || []).slice(0, 5);

  return (
    <div className="flex max-w-full flex-col items-start gap-1">
      <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3 px-2.5 py-1 text-xs text-bolt-elements-textPrimary">
        {swatchColors.length > 0 && (
          <div className="flex h-3 w-10 shrink-0 overflow-hidden rounded-full border border-bolt-elements-borderColor">
            {swatchColors.map((hex, idx) => (
              <div
                key={`${hex}-${idx}`}
                className="flex-1"
                style={{ backgroundColor: hex }}
              />
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="inline-flex min-w-0 items-center gap-1.5 text-left transition-colors hover:text-bolt-elements-textPrimary"
          title={expanded ? 'Hide skill details' : 'Show skill details'}
        >
          <span className="min-w-0 truncate">{summary.name}</span>
          {summary.styleDescriptorLabel && (
            <span className="shrink-0 text-bolt-elements-textTertiary">
              · {summary.styleDescriptorLabel}
            </span>
          )}
          <div
            className={`i-ph:caret-down shrink-0 text-xs text-bolt-elements-textTertiary transition-transform ${
              expanded ? 'rotate-180' : ''
            }`}
          />
        </button>
        <ClearButton onClick={onClear} />
      </div>

      {expanded && (
        <SkillDisclosurePanel
          skill={fullSkill}
          error={detailError}
          skillId={skillId}
        />
      )}
    </div>
  );
}

/**
 * Expanded content. Kept visually restrained — this is a reference card the
 * user reads occasionally, not a primary UI surface. Links out to the full
 * detail page for anything more than palette/type/intent/voice.
 */
function SkillDisclosurePanel({
  skill,
  error,
  skillId,
}: {
  skill: BrandTemplate | null;
  error: string | null;
  skillId: string;
}) {
  if (error) {
    return (
      <div className="w-full max-w-md rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-400">
        {error}
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="w-full max-w-md rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 text-xs text-bolt-elements-textSecondary">
        Loading skill details…
      </div>
    );
  }

  const palette = skill.palette;
  // The five most-used palette tokens as labelled swatches. More detail than
  // the chip's anonymous strip, but still a glance, not a study.
  const paletteEntries: Array<{ hex: string; label: string }> = [
    { hex: palette.primary[0]?.hex, label: 'Primary' },
    { hex: palette.accent[0]?.hex, label: 'Accent' },
    { hex: palette.background[0]?.hex, label: 'Background' },
    { hex: palette.surface[0]?.hex, label: 'Surface' },
    { hex: palette.text[0]?.hex, label: 'Text' },
  ].filter((e) => e.hex);

  const fontFamilies = Object.entries(skill.typography.families)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`);

  const intents: Array<[string, string]> = [];
  if (skill.shadows.intent) intents.push(['Shadows', skill.shadows.intent]);
  if (skill.borders.intent) intents.push(['Borders', skill.borders.intent]);
  if (skill.borders.radiusIntent) intents.push(['Radius', skill.borders.radiusIntent]);

  const forbidden = skill.copyVoice.forbidden;

  return (
    <div className="w-full max-w-md rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-3 text-xs">
      <dl className="flex flex-col gap-2.5">
        <div>
          <dt className="mb-1 text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary">
            Palette
          </dt>
          <dd>
            <ul className="flex flex-wrap gap-2">
              {paletteEntries.map((e) => (
                <li key={e.label} className="flex items-center gap-1.5">
                  <span
                    className="h-4 w-4 shrink-0 rounded border border-bolt-elements-borderColor"
                    style={{ backgroundColor: e.hex }}
                    title={e.hex}
                  />
                  <span className="text-bolt-elements-textSecondary">{e.label}</span>
                  <code className="text-bolt-elements-textTertiary">{e.hex}</code>
                </li>
              ))}
            </ul>
          </dd>
        </div>

        {fontFamilies.length > 0 && (
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary">
              Typography
            </dt>
            <dd className="text-bolt-elements-textSecondary">
              {fontFamilies.join(' · ')}
            </dd>
          </div>
        )}

        {intents.length > 0 && (
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary">
              UI intent
            </dt>
            <dd>
              <ul className="flex flex-wrap gap-2">
                {intents.map(([label, value]) => (
                  <li
                    key={label}
                    className="rounded bg-bolt-elements-background-depth-3 px-2 py-0.5 text-bolt-elements-textPrimary"
                  >
                    <span className="text-bolt-elements-textTertiary">{label}:</span>{' '}
                    {value}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}

        {forbidden.length > 0 && (
          <div>
            <dt className="mb-1 text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary">
              Forbidden copy
            </dt>
            <dd className="text-bolt-elements-textSecondary">
              {forbidden.join(', ')}
            </dd>
          </div>
        )}
      </dl>

      <div className="mt-3 border-t border-bolt-elements-borderColor pt-2">
        <Link
          to={`/brand-templates/${skillId}`}
          className="inline-flex items-center gap-1 text-bolt-elements-textSecondary hover:text-bolt-elements-textPrimary"
        >
          <div className="i-ph:arrow-square-out text-sm" />
          Open full spec
        </Link>
      </div>
    </div>
  );
}

function ClearButton({
  onClick,
  tone = 'default',
}: {
  onClick: () => void;
  tone?: 'default' | 'warning';
}) {
  const base = 'ml-1 shrink-0 rounded p-0.5 transition-colors';
  const toneClasses =
    tone === 'warning'
      ? 'text-yellow-400 hover:bg-yellow-500/20'
      : 'text-bolt-elements-textTertiary hover:bg-bolt-elements-background-depth-2 hover:text-bolt-elements-textPrimary';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Clear attached skill"
      className={`${base} ${toneClasses}`}
    >
      <div className="i-ph:x text-xs" />
    </button>
  );
}

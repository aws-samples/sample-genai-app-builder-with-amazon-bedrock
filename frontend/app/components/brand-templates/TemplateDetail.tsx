import type { BrandTemplate } from '~/types/brandTemplate';
import { PaletteSwatch } from './PaletteSwatch';

interface TemplateDetailProps {
  skill: BrandTemplate;
}

/**
 * Detail-page token tables.
 *
 * Design choices:
 *  - Section headings use text-xs uppercase with a thin divider above,
 *    not boxed cards. Keeps the info dense and scannable.
 *  - Token tables sit directly on the page background — no nested card
 *    shadow, no redundant border around each group.
 *  - Typography table and palette grid each get their own section; every
 *    other group is a tight key/value list.
 */
export function TemplateDetail({ skill }: TemplateDetailProps) {
  const palette = skill.palette;
  const allColors = [
    ...palette.primary,
    ...palette.accent,
    ...palette.background,
    ...palette.surface,
    ...palette.text,
    ...palette.border,
    ...palette.states,
  ];

  return (
    <div className="flex flex-col gap-8">
      <PaletteSwatch
        colors={allColors.slice(0, 8).map((t) => t.hex)}
        size="md"
      />

      <Section title="Style">
        <KVList
          items={[
            ['Register', `${skill.register.kind} — ${skill.register.rationale}`],
            ['Style', `${skill.styleDescriptor.label}. ${skill.styleDescriptor.rationale}`],
            ['Adjectives', skill.styleDescriptor.adjectives.join(', ')],
            ['Color strategy', `${skill.colorStrategy.tier}. ${skill.colorStrategy.rationale}`],
            ['Theme', `${skill.theme.mode}. ${skill.theme.sceneSentence}`],
          ]}
        />
      </Section>

      <Section title="Palette">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <PaletteBucket label="Primary" tokens={palette.primary} />
          <PaletteBucket label="Accent" tokens={palette.accent} />
          <PaletteBucket label="Background" tokens={palette.background} />
          <PaletteBucket label="Surface" tokens={palette.surface} />
          <PaletteBucket label="Text" tokens={palette.text} />
          <PaletteBucket label="Border" tokens={palette.border} />
          <PaletteBucket label="States" tokens={palette.states} />
        </div>
      </Section>

      <Section title="Typography">
        <div className="flex flex-col gap-4">
          <KVList
            items={[
              [
                'Families',
                Object.entries(skill.typography.families)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(' · '),
              ],
              [
                'Body line length',
                `${skill.typography.principles.bodyLineLengthCh}ch`,
              ],
              ['Scale ratio', `${skill.typography.principles.scaleRatio}`],
              ['Hierarchy', skill.typography.principles.hierarchyStrategy],
            ]}
          />
          <div className="overflow-hidden rounded-md border border-bolt-elements-borderColor">
            <table className="w-full text-xs">
              <thead className="bg-bolt-elements-background-depth-2 text-bolt-elements-textSecondary">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Family</th>
                  <th className="px-3 py-2 text-left font-medium">Size</th>
                  <th className="px-3 py-2 text-left font-medium">Weight</th>
                  <th className="px-3 py-2 text-left font-medium">Line height</th>
                </tr>
              </thead>
              <tbody>
                {skill.typography.scale.map((entry) => (
                  <tr
                    key={entry.name}
                    className="border-t border-bolt-elements-borderColor"
                  >
                    <td className="px-3 py-2 font-medium text-bolt-elements-textPrimary">
                      {entry.name}
                    </td>
                    <td className="px-3 py-2 text-bolt-elements-textSecondary">
                      {entry.fontFamily}
                    </td>
                    <td className="px-3 py-2 text-bolt-elements-textSecondary">
                      {entry.fontSize}
                    </td>
                    <td className="px-3 py-2 text-bolt-elements-textSecondary">
                      {entry.fontWeight}
                    </td>
                    <td className="px-3 py-2 text-bolt-elements-textSecondary">
                      {entry.lineHeight}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section title="Information hierarchy">
        <ol className="flex flex-col gap-2">
          {skill.informationHierarchy.focalOrder.map((f) => (
            <li key={f.rank} className="flex items-start gap-3 text-sm">
              <span className="inline-flex h-6 w-6 flex-none items-center justify-center rounded-full bg-bolt-elements-background-depth-3 text-xs font-medium text-bolt-elements-textPrimary">
                {f.rank}
              </span>
              <span>
                <span className="font-medium text-bolt-elements-textPrimary">
                  {f.element}
                </span>
                <span className="ml-2 text-bolt-elements-textSecondary">
                  {f.role}
                </span>
              </span>
            </li>
          ))}
        </ol>
        {skill.informationHierarchy.principles.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {skill.informationHierarchy.principles.map((p) => (
              <li
                key={p}
                className="rounded bg-bolt-elements-background-depth-3 px-2 py-0.5 text-xs text-bolt-elements-textSecondary"
              >
                {p}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {skill.antiReferences && (
        <Section title="Anti-references">
          <KVList
            items={[
              [
                'First-order reflexes',
                skill.antiReferences.firstOrderReflexes?.join(' · ') ?? '—',
              ],
              [
                'Second-order reflexes',
                skill.antiReferences.secondOrderReflexes?.join(' · ') ?? '—',
              ],
              [
                'Bans observed',
                skill.antiReferences.bansObserved?.join(', ') ?? '—',
              ],
            ]}
          />
        </Section>
      )}

      <Section title="Copy voice">
        <KVList
          items={[
            ['Adjectives', skill.copyVoice.adjectives.join(', ')],
            ['Case', skill.copyVoice.case],
            ['Density', skill.copyVoice.density ?? '—'],
            ['Forbidden', skill.copyVoice.forbidden.join(', ')],
          ]}
        />
        {skill.copyVoice.examples && skill.copyVoice.examples.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {skill.copyVoice.examples.map((ex, idx) => (
              <li
                key={idx}
                className="flex items-baseline gap-3 rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm"
              >
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-bolt-elements-textTertiary">
                  {ex.kind}
                </span>
                <span className="text-bolt-elements-textPrimary">{ex.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
        <Section title="Borders & shadows">
          <KVList
            items={[
              // Intent comes first — it's the signal that most often gets
              // ignored when a skill is applied to a generated app.
              ['Shadow intent', skill.shadows.intent ?? '—'],
              ['Border intent', skill.borders.intent ?? '—'],
              ['Radius intent', skill.borders.radiusIntent ?? '—'],
              ['Radius', formatMap(skill.borders.radius)],
              ['Width', formatMap(skill.borders.width)],
              ['Border colors', skill.borders.color.join(', ')],
            ]}
          />
          <ul className="mt-3 flex flex-col gap-1 text-xs">
            {skill.shadows.elevation.map((s) => (
              <li key={s.name} className="flex items-center gap-3">
                <span className="w-12 font-medium text-bolt-elements-textPrimary">
                  {s.name}
                </span>
                <code className="text-bolt-elements-textSecondary">{s.value}</code>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Spacing & motion">
          <KVList
            items={[
              ['Base', skill.spacing.base],
              ['Scale', formatMap(skill.spacing.scale)],
            ]}
          />
          {skill.spacing.rhythmRules.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-xs text-bolt-elements-textSecondary">
              {skill.spacing.rhythmRules.map((rule) => (
                <li key={rule}>• {rule}</li>
              ))}
            </ul>
          )}
          <ul className="mt-3 flex flex-col gap-1 text-xs">
            {skill.motion.tokens.map((t) => (
              <li key={t.name} className="flex items-center gap-3">
                <span className="w-16 font-medium text-bolt-elements-textPrimary">
                  {t.name}
                </span>
                <code className="text-bolt-elements-textSecondary">
                  {t.duration} · {t.easing}
                </code>
              </li>
            ))}
          </ul>
          {skill.motion.disallowedPatterns.length > 0 && (
            <p className="mt-2 text-xs text-bolt-elements-textTertiary">
              Disallowed: {skill.motion.disallowedPatterns.join(', ')}
            </p>
          )}
        </Section>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-bolt-elements-borderColor pt-6 first:border-t-0 first:pt-0">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-bolt-elements-textTertiary">
        {title}
      </h2>
      {children}
    </section>
  );
}

function KVList({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-bolt-elements-textSecondary">{k}</dt>
          <dd className="text-bolt-elements-textPrimary">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function PaletteBucket({
  label,
  tokens,
}: {
  label: string;
  tokens: { hex: string; role: string; usage?: string }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs uppercase tracking-wide text-bolt-elements-textTertiary">
        {label}
      </span>
      <ul className="flex flex-col gap-1">
        {tokens.map((t, idx) => (
          <li key={`${t.hex}-${idx}`} className="flex items-center gap-2 text-xs">
            <span
              className="h-5 w-5 flex-none rounded border border-bolt-elements-borderColor"
              style={{ backgroundColor: t.hex }}
            />
            <code className="text-bolt-elements-textPrimary">{t.hex}</code>
            <span className="truncate text-bolt-elements-textSecondary">
              {t.role}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatMap(m: Record<string, string>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
}

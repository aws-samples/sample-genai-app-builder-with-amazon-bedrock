import type { BrandTemplate } from '~/types/brandTemplate';

/**
 * Render a <brand_template> XML block for injection into the chat system
 * prompt.
 *
 * The block has two parts:
 *   1. A directive-style narrative that names compliance rules, identity
 *      (register/theme/color strategy), and the must-not-emit lists.
 *   2. A paste-ready <css_variables> block that maps every palette,
 *      typography, radius, shadow, spacing, and motion token to a CSS
 *      variable name the model can use directly.
 *
 * The previous implementation also shipped a <full_spec> JSON excerpt next
 * to the CSS variables. That was redundant — the model already has every
 * actionable value in the variables + narrative, and duplicating it as
 * pretty-printed JSON roughly doubled the per-turn token cost. The full
 * record is still available on the detail page and in skill.json exports
 * for human audit; the system prompt no longer carries it.
 *
 * Deterministic output so snapshot tests are stable.
 */

const MAX_BLOCK_CHARS = 3600;

export function renderBrandTemplateBlock(skill: BrandTemplate | null | undefined): string {
  if (!skill) return '';

  const narrative = renderNarrative(skill);
  const cssVars = renderCssVariables(skill);

  const block = [
    `<brand_template name="${escapeAttr(skill.name)}" label="${escapeAttr(skill.styleDescriptor.label)}" id="${skill.skillId}">`,
    narrative,
    '',
    '<css_variables>',
    cssVars,
    '</css_variables>',
    '</brand_template>',
  ].join('\n');

  // Hard budget guard. Everything that could blow the budget comes from the
  // narrative (copy-voice + anti-references + rhythm rules); the caller
  // already truncates those by slice(...) in renderNarrative, so this is
  // belt-and-braces. If we ever do exceed the cap the skill block gets
  // truncated with an explicit marker so the model can tell it's incomplete
  // rather than silently dropping content mid-sentence.
  if (block.length > MAX_BLOCK_CHARS) {
    return block.slice(0, MAX_BLOCK_CHARS) + '\n<!-- truncated -->\n</brand_template>';
  }
  return block;
}

function renderNarrative(skill: BrandTemplate): string {
  const adjectives = skill.styleDescriptor.adjectives.join(', ');
  const registerKind = skill.register.kind;
  const themeMode = skill.theme.mode;
  const colorTier = skill.colorStrategy.tier;

  const habits = skill.motion.habits.slice(0, 3).join('. ');
  const rhythm = skill.spacing.rhythmRules.slice(0, 3).join('; ');

  const firstOrder = skill.antiReferences?.firstOrderReflexes?.[0];
  const secondOrder = skill.antiReferences?.secondOrderReflexes?.[0];
  const bans = skill.antiReferences?.bansObserved ?? [];

  // Directive language, not suggestion. "Honor" was soft; models will ignore
  // soft asks when other instructions pull them toward defaults. These rules
  // are worded as hard constraints with a small explicit escape hatch
  // (token absence) so the model understands when it is allowed to invent.
  //
  // Sandbox reality check: the runtime is vanilla Vite + React, no Tailwind
  // unless the user has already installed it. We instruct the model to land
  // the skill's tokens as CSS variables in index.css and reference them via
  // var(...) everywhere — not theme.extend, not a magic utility class.
  const lines = [
    `  ## DESIGN SKILL ACTIVE — MANDATORY`,
    ``,
    `  The user has attached a brand template. These tokens and principles`,
    `  override any default visual choices the model would otherwise make.`,
    `  This directive applies to ALL HTML, JSX, and CSS output in this`,
    `  conversation until the user removes or replaces the skill.`,
    ``,
    `  How to deliver these tokens in this sandbox:`,
    `  1. Paste the <css_variables> block below verbatim into src/index.css`,
    `     inside a :root { ... } selector. Import index.css from main.tsx.`,
    `  2. Use var(--color-primary), var(--font-sans), var(--space-3), etc.`,
    `     in every style declaration. Inline style objects like`,
    `     style={{ background: 'var(--color-surface)' }} are fine.`,
    `  3. Do NOT introduce colors, font families, shadows, radii, or spacing`,
    `     literals that are not in the skill. The only exception is when a`,
    `     token bucket is genuinely absent; in that case, derive a value`,
    `     consistent with the adjectives and the tokens that ARE present,`,
    `     and add it to :root so later code can reuse it.`,
    `  4. If (and only if) the user already has Tailwind installed, wire the`,
    `     same CSS variables into tailwind.config theme.extend so classes`,
    `     like bg-[var(--color-primary)] work. Don't install Tailwind just`,
    `     to apply the skill — CSS variables alone are sufficient.`,
    `  5. Treat the "Register" + "Color strategy" + "Theme" signals as style`,
    `     identity. Do not soften or "balance" them toward generic defaults.`,
    `  6. Follow the copy voice rules for ALL generated strings (headings,`,
    `     buttons, empty states, errors). Never emit forbidden patterns.`,
    ``,
    `  Skill identity:`,
    `  Register: ${registerKind} (design ${registerKind === 'brand' ? 'IS' : 'SERVES'} the product).`,
    `  Theme: ${themeMode}. Scene: ${skill.theme.sceneSentence}`,
    `  Color strategy: ${colorTier}. ${skill.colorStrategy.rationale}`,
    `  Adjectives: ${adjectives}.`,
    ``,
  ];

  if (firstOrder) {
    lines.push(`  Avoid (first-order reflex): ${firstOrder}.`);
  }
  if (secondOrder) {
    lines.push(`  Avoid (second-order reflex): ${secondOrder}.`);
  }
  if (bans.length > 0) {
    lines.push(`  Never use: ${bans.join(', ')}.`);
  }
  if (skill.copyVoice.forbidden.length > 0) {
    lines.push(`  Copy forbidden patterns: ${skill.copyVoice.forbidden.join(', ')}.`);
  }
  lines.push(`  Motion habits: ${habits}.`);
  lines.push(`  Spacing rhythm: ${rhythm}.`);

  // Typography scale by role — the CSS variables below carry font *families*
  // but not per-role size/weight. Without this list the model falls back to
  // default heading sizes, breaking the skill's visual hierarchy. Keep up to
  // 6 entries; anything beyond that is usually just extra variants of the
  // same scale.
  const scaleEntries = skill.typography.scale.slice(0, 6);
  if (scaleEntries.length > 0) {
    lines.push('');
    lines.push(`  Typography scale (use these exact sizes for their roles):`);
    for (const e of scaleEntries) {
      const letterSpacing = e.letterSpacing ? `, letter-spacing ${e.letterSpacing}` : '';
      lines.push(
        `    - ${e.name}: ${e.fontFamily} ${e.fontWeight} ${e.fontSize}/${e.lineHeight}${letterSpacing}`,
      );
    }
    const p = skill.typography.principles;
    lines.push(
      `    Body line length cap: ${p.bodyLineLengthCh}ch. Scale ratio: ${p.scaleRatio}. ${p.hierarchyStrategy}`,
    );
  }

  // Information hierarchy — who should the eye land on first. Without this,
  // the model gives every card equal weight and the design feels flat.
  const focal = skill.informationHierarchy.focalOrder.slice(0, 6);
  if (focal.length > 0) {
    lines.push('');
    lines.push(`  Information hierarchy (emphasize in this order):`);
    for (const f of focal) {
      lines.push(`    ${f.rank}. ${f.element} — ${f.role}`);
    }
  }

  // Copy voice density is a signal about how many words a button/heading
  // should have; models otherwise default to corporate-verbose.
  if (skill.copyVoice.density) {
    lines.push('');
    lines.push(
      `  Copy density: ${skill.copyVoice.density}. Case: ${skill.copyVoice.case}. Voice: ${skill.copyVoice.adjectives.join(', ')}.`,
    );
  }

  // UI-system intents — tell the model when to NOT use shadows/borders/
  // rounded corners. These are the signals that most often break on
  // generated output ('why did it add drop shadows to my flat design?'),
  // so we surface them as explicit do/don't sentences rather than as
  // structured data the model can skim past.
  const shadowIntent = skill.shadows.intent;
  if (shadowIntent) {
    lines.push('');
    lines.push(`  Shadow intent: ${shadowIntent}. ${SHADOW_INTENT_GUIDANCE[shadowIntent]}`);
  }
  const borderIntent = skill.borders.intent;
  if (borderIntent) {
    lines.push(`  Border intent: ${borderIntent}. ${BORDER_INTENT_GUIDANCE[borderIntent]}`);
  }
  const radiusIntent = skill.borders.radiusIntent;
  if (radiusIntent) {
    lines.push(`  Radius intent: ${radiusIntent}. ${RADIUS_INTENT_GUIDANCE[radiusIntent]}`);
  }

  return lines.join('\n');
}

// Short, imperative guidance per intent. Kept as prose directives rather
// than "this enum means X" descriptions so the model reads them as rules,
// not definitions.
const SHADOW_INTENT_GUIDANCE: Record<string, string> = {
  none:
    "Do NOT use drop shadows. Separation comes from borders, whitespace, and background contrast. Flat design.",
  subtle:
    "Shadows only on hover/focus, barely visible. Cards do not levitate at rest.",
  'elevation-only':
    'Shadows communicate Z-depth hierarchy (modal > popover > card > surface). Larger shadow = higher in the stack. No decorative shadows.',
  distinctive:
    "Shadows are a design element — match the skill's signature shadow style (soft, hard, coloured) deliberately.",
};

const BORDER_INTENT_GUIDANCE: Record<string, string> = {
  none:
    'Do NOT use borders on cards, surfaces, or dividers. Separation comes from background contrast and whitespace.',
  hairline:
    "1px borders are the primary separation tool. Use the skill's border color consistently for dividers, table rows, and surface edges.",
  filled:
    'Use filled surface backgrounds for separation, not borders. Borders only for inputs and internal chip outlines.',
  expressive:
    'Borders are a design element — thick, colored, or asymmetric. Make them visible.',
};

const RADIUS_INTENT_GUIDANCE: Record<string, string> = {
  sharp:
    'Use 0 radius everywhere. Right-angle design. Rounded corners look out of place.',
  subtle:
    'Use 2-4px radius. Softens edges without becoming a design element.',
  pronounced:
    'Use 8-16px radius on cards and primary containers. Rounded corners are a recognizable part of the language.',
  'pill-first':
    'Fully round buttons, chips, avatars, and tags (border-radius: 9999px). Pill shape is a recurring motif.',
};

function renderCssVariables(skill: BrandTemplate): string {
  const lines = [':root {'];

  const pal = skill.palette;
  pushColor(lines, '--color-primary', pal.primary);
  pushColor(lines, '--color-accent', pal.accent);
  pushColor(lines, '--color-bg', pal.background);
  pushColor(lines, '--color-surface', pal.surface);
  pushColor(lines, '--color-text', pal.text);
  pushColor(lines, '--color-border', pal.border);
  pushColor(lines, '--color-state-hover', pal.states);

  const fam = skill.typography.families;
  if (fam.sans) lines.push(`  --font-sans: ${fam.sans};`);
  if (fam.serif) lines.push(`  --font-serif: ${fam.serif};`);
  if (fam.mono) lines.push(`  --font-mono: ${fam.mono};`);
  if (fam.display) lines.push(`  --font-display: ${fam.display};`);

  for (const [k, v] of Object.entries(skill.borders.radius).slice(0, 6)) {
    lines.push(`  --radius-${k}: ${v};`);
  }
  for (const shadow of skill.shadows.elevation.slice(0, 5)) {
    lines.push(`  --shadow-${shadow.name}: ${shadow.value};`);
  }
  for (const [k, v] of Object.entries(skill.spacing.scale).slice(0, 8)) {
    lines.push(`  --space-${k}: ${v};`);
  }
  for (const token of skill.motion.tokens.slice(0, 4)) {
    lines.push(`  --motion-${token.name}: ${token.duration} ${token.easing};`);
  }

  lines.push('}');
  return lines.join('\n');
}

function pushColor(
  lines: string[],
  cssVar: string,
  tokens: Array<{ hex: string }> | undefined,
) {
  const hex = tokens?.[0]?.hex;
  if (hex) lines.push(`  ${cssVar}: ${hex};`);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

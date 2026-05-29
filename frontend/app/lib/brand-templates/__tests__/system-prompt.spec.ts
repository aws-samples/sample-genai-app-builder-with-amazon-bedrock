import { describe, expect, it } from 'vitest';
import type { BrandTemplate } from '~/types/brandTemplate';
import { renderBrandTemplateBlock } from '../system-prompt';

function fixture(overrides: Partial<BrandTemplate> = {}): BrandTemplate {
  return {
    schemaVersion: 2,
    userId: 'u-1',
    skillId: '11111111-1111-4111-8111-111111111111',
    extractionJobId: '22222222-2222-4222-8222-222222222222',
    name: 'Editorial mono',
    status: 'ready',
    createdAt: '2026-05-05T12:00:00Z',
    updatedAt: '2026-05-05T12:00:00Z',
    source: 'images',
    register: {
      kind: 'brand',
      rationale: 'Long-form editorial surface; design is the message.',
    },
    styleDescriptor: {
      label: 'editorial',
      rationale: 'High-contrast type, restrained color.',
      adjectives: ['editorial', 'minimal', 'confident'],
    },
    colorStrategy: {
      tier: 'restrained',
      accentCoveragePct: 6,
      rationale: 'Tinted neutrals carry the surface.',
    },
    theme: {
      mode: 'dark',
      sceneSentence: 'Designer reading essays at dusk on a laptop in a dim studio.',
      rationale: 'The dim scene forces dark to preserve mood.',
    },
    informationHierarchy: {
      focalOrder: [
        { rank: 1, element: 'Display headline', role: 'Anchors the viewer.' },
      ],
      principles: ['Scale contrast over color contrast'],
    },
    antiReferences: {
      firstOrderReflexes: ['AI tool → SaaS cream + purple gradient'],
      secondOrderReflexes: ['Editorial-typographic beige + serif'],
      bansObserved: ['gradient-text'],
    },
    copyVoice: {
      adjectives: ['confident', 'editorial'],
      case: 'sentence',
      density: 'sparse',
      forbidden: ['em-dashes', 'AI preamble phrases'],
    },
    palette: {
      primary: [{ hex: '#5e6ad2', role: 'primary' }],
      accent: [{ hex: '#f59e0b', role: 'accent' }],
      background: [{ hex: '#0b0e16', role: 'background' }],
      surface: [{ hex: '#1f2633', role: 'surface' }],
      text: [{ hex: '#e6e8ec', role: 'text' }],
      border: [{ hex: '#262b36', role: 'border' }],
      states: [{ hex: '#3b82f6', role: 'state-hover' }],
    },
    typography: {
      families: { sans: 'Inter', mono: 'JetBrains Mono' },
      scale: [
        { name: 'body', fontFamily: 'Inter', fontSize: '16px', fontWeight: 400, lineHeight: '1.5' },
      ],
      principles: {
        bodyLineLengthCh: 72,
        scaleRatio: 1.333,
        hierarchyStrategy: 'Weight + scale carry hierarchy.',
      },
    },
    borders: {
      radius: { sm: '4px', md: '6px', lg: '12px' },
      width: { thin: '1px', normal: '2px' },
      color: ['#262b36'],
      intent: 'hairline',
      radiusIntent: 'subtle',
    },
    shadows: {
      elevation: [{ name: 'sm', value: '0 1px 2px rgba(0,0,0,0.3)' }],
      intent: 'elevation-only',
    },
    spacing: {
      base: '4px',
      scale: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px' },
      rhythmRules: ['Cards use 24px padding; list rows use 8px'],
    },
    motion: {
      tokens: [
        { name: 'default', duration: '180ms', easing: 'cubic-bezier(0.4,0,0.2,1)' },
      ],
      habits: ['Fades over translations'],
      disallowedPatterns: ['bounce', 'elastic', 'layout-property-animation'],
    },
    ...overrides,
  };
}

describe('renderBrandTemplateBlock', () => {
  it('returns an empty string for null', () => {
    expect(renderBrandTemplateBlock(null)).toBe('');
    expect(renderBrandTemplateBlock(undefined)).toBe('');
  });

  it('wraps output in a named brand_template tag with id and label', () => {
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toMatch(/^<brand_template name="Editorial mono" label="editorial" id="11111111-1111-4111-8111-111111111111">/);
    expect(block.trim().endsWith('</brand_template>')).toBe(true);
  });

  it('emits a paste-ready CSS variables block with palette, radii, shadows, spacing, motion', () => {
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toContain('<css_variables>');
    expect(block).toContain('--color-primary: #5e6ad2;');
    expect(block).toContain('--color-bg: #0b0e16;');
    expect(block).toContain('--color-text: #e6e8ec;');
    expect(block).toContain('--font-sans: Inter;');
    expect(block).toContain('--radius-md: 6px;');
    expect(block).toContain('--shadow-sm: 0 1px 2px rgba(0,0,0,0.3);');
    expect(block).toContain('--space-md: 16px;');
    expect(block).toContain('--motion-default: 180ms cubic-bezier(0.4,0,0.2,1);');
  });

  it('surfaces register, scene, color strategy, and anti-reference reflexes in the narrative', () => {
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toContain('Register: brand');
    expect(block).toContain('Scene: Designer reading essays at dusk');
    expect(block).toContain('Color strategy: restrained');
    expect(block).toContain('Avoid (first-order reflex)');
    expect(block).toContain('Never use: gradient-text');
    expect(block).toContain('Copy forbidden patterns: em-dashes, AI preamble phrases');
  });

  it('tells the model how to actually deliver the tokens in a vanilla Vite sandbox', () => {
    // The sandbox is vanilla Vite + React with no Tailwind by default. The
    // narrative must explicitly name CSS variables in index.css / :root as
    // the delivery mechanism, not theme.extend alone. Regressing this would
    // send us back to the "attached but not honored" state the UX suffered
    // from before this directive landed.
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toContain('src/index.css');
    expect(block).toContain(':root');
    expect(block).toContain('var(--color-primary)');
  });

  it('does NOT include a full_spec JSON block (the narrative + css_variables carry everything the model needs)', () => {
    // Deliberately removed from the prompt to cut token cost in half.
    // The JSON was pretty-printed duplicate data of what the narrative
    // and CSS variables already say, and models don't parse JSON better
    // than prose for instruction-following. Full skill.json is still
    // available on the detail page and in user exports.
    const block = renderBrandTemplateBlock(fixture());
    expect(block).not.toContain('<full_spec>');
    expect(block).not.toContain('</full_spec>');
  });

  it('surfaces the typography scale by role so the model honors heading sizes', () => {
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toContain('Typography scale');
    expect(block).toContain('body: Inter 400 16px/1.5');
    expect(block).toContain('Body line length cap: 72ch');
  });

  it('surfaces the information-hierarchy focal order', () => {
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toContain('Information hierarchy');
    expect(block).toContain('1. Display headline — Anchors the viewer.');
  });

  it('surfaces copy density, case, and voice adjectives in the narrative', () => {
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toContain('Copy density: sparse. Case: sentence.');
    expect(block).toContain('Voice: confident, editorial');
  });

  it('surfaces shadow/border/radius intents as directive prose, not raw enum values', () => {
    // These intents are what most often get ignored in generated output
    // ("why did it add drop shadows to my flat design?"). Each intent
    // must appear with BOTH the enum and the imperative guidance so the
    // model reads them as rules, not definitions.
    const block = renderBrandTemplateBlock(fixture());
    expect(block).toContain('Shadow intent: elevation-only.');
    expect(block).toContain('Larger shadow = higher in the stack');
    expect(block).toContain('Border intent: hairline.');
    expect(block).toContain('1px borders are the primary separation tool');
    expect(block).toContain('Radius intent: subtle.');
    expect(block).toContain('2-4px radius');
  });

  it('omits intent lines when they are absent (back-compat with pre-v3 skills)', () => {
    // Older skills written before the intent fields shipped must still
    // render without blowing up; the narrative just skips those lines.
    const skill = fixture();
    delete (skill.borders as { intent?: string }).intent;
    delete (skill.borders as { radiusIntent?: string }).radiusIntent;
    delete (skill.shadows as { intent?: string }).intent;
    const block = renderBrandTemplateBlock(skill);
    expect(block).not.toContain('Shadow intent');
    expect(block).not.toContain('Border intent');
    expect(block).not.toContain('Radius intent');
  });

  it('escapes special characters in the skill name attribute', () => {
    const skill = fixture({ name: 'A&B "Special" <name>' });
    const block = renderBrandTemplateBlock(skill);
    expect(block).toContain('name="A&amp;B &quot;Special&quot; &lt;name&gt;"');
  });

  it('stays within a reasonable token budget', () => {
    // Previously 6000 when the JSON full_spec was shipped. Dropping the
    // JSON cuts the block to ~3000-3200 chars for a fully-populated skill
    // (including the shadow/border/radius intent directives added in the
    // extractor-latitude pass); we pick 3600 as the ceiling so small
    // narrative additions don't silently blow the budget.
    const block = renderBrandTemplateBlock(fixture());
    expect(block.length).toBeLessThan(3600);
  });
});

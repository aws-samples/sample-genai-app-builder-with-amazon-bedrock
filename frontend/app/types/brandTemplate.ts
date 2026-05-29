/**
 * Brand Template types — mirrors `infra/lambda/brand-templates/brand_template.schema.json` (v2).
 *
 * A BrandTemplate captures *decisions + tokens*: register, color strategy, theme
 * scene, information hierarchy, anti-references, copy voice, and the usual
 * token families. Consumed by the LLM at codegen time as structured design
 * context; never re-rendered into React directly.
 *
 * Conceptually inspired by Anthropic's frontend-design "impeccable" framework
 * (Apache 2.0). See NOTICE.md for attribution.
 *
 * Keep this file in sync with `frontend/app/types/brandTemplate.schema.json`.
 */

export type SkillStatus = 'processing' | 'ready' | 'failed';
export type SkillSource = 'images' | 'url' | 'declared';
export type Register = 'brand' | 'product';
export type ColorStrategyTier = 'restrained' | 'committed' | 'full-palette' | 'drenched';
export type ThemeMode = 'light' | 'dark';
export type CopyCase = 'sentence' | 'title' | 'mixed' | 'all-caps' | 'lowercase';
export type CopyDensity = 'sparse' | 'balanced' | 'dense';

export type DisallowedMotionPattern =
  | 'bounce'
  | 'elastic'
  | 'layout-property-animation'
  | 'linear-easing'
  | 'springs'
  | 'flashing-above-3hz';

export type ObservedBan =
  | 'side-stripe-border'
  | 'gradient-text'
  | 'decorative-glassmorphism'
  | 'hero-metric-template'
  | 'identical-card-grids'
  | 'modal-as-first-thought'
  | 'em-dashes';

export type CopyExampleKind =
  | 'headline'
  | 'subhead'
  | 'body'
  | 'cta'
  | 'empty-state'
  | 'error';

export interface ColorToken {
  hex: string;
  role: string;
  usage?: string;
}

export interface ColorPalette {
  primary: ColorToken[];
  accent: ColorToken[];
  background: ColorToken[];
  surface: ColorToken[];
  text: ColorToken[];
  border: ColorToken[];
  states: ColorToken[];
}

export interface TypographyScaleEntry {
  name: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: number;
  lineHeight: string;
  letterSpacing?: string;
}

export interface TypographyFamilies {
  sans?: string;
  serif?: string;
  mono?: string;
  display?: string;
}

export interface TypographyPrinciples {
  /** Cap body line length, typically 65–75ch. */
  bodyLineLengthCh: number;
  /** Ratio between scale steps, ≥ 1.25. */
  scaleRatio: number;
  hierarchyStrategy: string;
  notes?: string;
}

export interface Typography {
  scale: TypographyScaleEntry[];
  families: TypographyFamilies;
  principles: TypographyPrinciples;
}

export type BorderIntent = 'none' | 'hairline' | 'filled' | 'expressive';
export type RadiusIntent = 'sharp' | 'subtle' | 'pronounced' | 'pill-first';
export type ShadowIntent = 'none' | 'subtle' | 'elevation-only' | 'distinctive';

export interface Borders {
  radius: Record<string, string>;
  width: Record<string, string>;
  color: string[];
  /** How this design uses borders as a separation / styling device. */
  intent?: BorderIntent;
  /** Attitude toward corner rounding. */
  radiusIntent?: RadiusIntent;
}

export interface ShadowToken {
  name: string;
  value: string;
  description?: string;
}

export interface Shadows {
  elevation: ShadowToken[];
  signature?: ShadowToken[];
  /** Overall attitude toward shadows — 'none' for flat designs. */
  intent?: ShadowIntent;
}

export interface Spacing {
  base: string;
  scale: Record<string, string>;
  rhythmNotes?: string;
  rhythmRules: string[];
}

export interface MotionToken {
  name: string;
  duration: string;
  easing: string;
  usage?: string;
}

export interface Motion {
  tokens: MotionToken[];
  habits: string[];
  disallowedPatterns: DisallowedMotionPattern[];
}

export interface Exemplar {
  kind: 'do' | 'dont';
  summary: string;
  rationale: string;
}

export interface StyleDescriptor {
  label: string;
  rationale: string;
  adjectives: string[];
}

export interface RegisterDescriptor {
  kind: Register;
  rationale: string;
}

export interface ColorStrategy {
  tier: ColorStrategyTier;
  /** Informational only. Restrained tier enforces <=10% on its own. */
  accentCoveragePct?: number;
  rationale: string;
}

export interface ThemeDescriptor {
  mode: ThemeMode;
  /** Concrete scene sentence — who uses this, where, under what light. */
  sceneSentence: string;
  rationale: string;
}

export interface FocalElement {
  rank: number;
  element: string;
  role: string;
}

export interface InformationHierarchy {
  focalOrder: FocalElement[];
  principles: string[];
}

export interface AntiReferences {
  firstOrderReflexes?: string[];
  secondOrderReflexes?: string[];
  bansObserved?: ObservedBan[];
}

export interface CopyExample {
  kind: CopyExampleKind;
  text: string;
}

export interface CopyVoice {
  adjectives: string[];
  case: CopyCase;
  density?: CopyDensity;
  forbidden: string[];
  examples?: CopyExample[];
}

export interface ExtractionProgress {
  stage?: string;
  message?: string;
  percent?: number;
}

export interface ExtractionError {
  code: string;
  message: string;
  /** Non-sensitive class name or short detail string from the Lambda. */
  detail?: string;
  /** Lambda request_id so the user can paste it into a support request. */
  requestId?: string;
  /** ISO timestamp when the extraction was marked failed. */
  failedAt?: string;
}

export interface BrandTemplate {
  schemaVersion: 2;

  // Identity
  userId: string;
  skillId: string;
  extractionJobId: string;

  // User-facing metadata
  name: string;
  description?: string;
  tags?: string[];
  status: SkillStatus;
  createdAt: string;
  updatedAt: string;

  // Provenance
  source: SkillSource;
  sourceImages?: string[];
  sourceUrl?: string;
  sourceResolvedUrl?: string;
  sourceScreenshotKey?: string;

  // Principles (the "why")
  register: RegisterDescriptor;
  styleDescriptor: StyleDescriptor;
  colorStrategy: ColorStrategy;
  theme: ThemeDescriptor;
  informationHierarchy: InformationHierarchy;
  antiReferences?: AntiReferences;
  copyVoice: CopyVoice;

  // Tokens (the "what")
  palette: ColorPalette;
  typography: Typography;
  borders: Borders;
  shadows: Shadows;
  spacing: Spacing;
  motion: Motion;
  exemplars?: Exemplar[];

  // Transient state
  progress?: ExtractionProgress;
  error?: ExtractionError;
}

export interface BrandTemplateSummary {
  skillId: string;
  name: string;
  description?: string;
  tags?: string[];
  status: SkillStatus;
  styleDescriptorLabel: string;
  createdAt: string;
  previewColors: string[];
}

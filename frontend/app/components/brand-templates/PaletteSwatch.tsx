import { classNames } from '~/utils/classNames';

interface PaletteSwatchProps {
  colors: string[];
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Horizontal strip of up to five swatches.
 *
 * Sizes:
 *   sm (48px) — gallery cards. Big enough to read the palette identity at a
 *     glance without dominating a 260px card.
 *   md (72px) — detail page. Gives each band enough height to read the
 *     relative chroma/lightness differences between buckets.
 *
 * No shadow or inner border — a single rounded outer border on the strip
 * itself keeps the palette as the content, not a framed asset.
 */
export function PaletteSwatch({ colors, size = 'sm', className }: PaletteSwatchProps) {
  const shown = (colors || []).slice(0, 5);

  const heightClass = size === 'sm' ? 'h-12' : 'h-16';

  if (shown.length === 0) {
    return (
      <div
        className={classNames(
          'w-full rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-3',
          heightClass,
          className,
        )}
      />
    );
  }

  return (
    <div
      className={classNames(
        'flex w-full overflow-hidden rounded-md border border-bolt-elements-borderColor',
        heightClass,
        className,
      )}
    >
      {shown.map((hex, idx) => (
        <div
          key={`${hex}-${idx}`}
          className="flex-1"
          style={{ backgroundColor: hex }}
          title={hex}
        />
      ))}
    </div>
  );
}

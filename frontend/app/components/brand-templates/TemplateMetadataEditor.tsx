import { useState } from 'react';
import type { BrandTemplate } from '~/types/brandTemplate';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';

interface TemplateMetadataEditorProps {
  skill: BrandTemplate;
  onUpdated: (updated: BrandTemplate) => void;
}

/**
 * Compact metadata-only editor (name, description, tags).
 *
 * Design choices:
 *  - No "METADATA" all-caps tracking label. The section identity is clear
 *    from the fields themselves, so the shout-heading was noise.
 *  - Consistent 12px gap between rows, 16px inset padding. Matches the card
 *    rhythm on the surrounding detail page.
 *  - Save button disabled until dirty AND at the bottom-right, not floating.
 */
export function TemplateMetadataEditor({ skill, onUpdated }: TemplateMetadataEditorProps) {
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description ?? '');
  const [tagsText, setTagsText] = useState((skill.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name !== skill.name ||
    description !== (skill.description ?? '') ||
    tagsText !== (skill.tags ?? []).join(', ');

  async function save() {
    setError(null);
    setSaving(true);

    const tags = tagsText
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    try {
      const client = getBrandTemplatesClient();
      const updated = await client.patchSkill(skill.skillId, {
        name: name.trim(),
        description: description.trim() || undefined,
        tags: tags.length > 0 ? tags : [],
      });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save metadata.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-4">
      <EditField label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          className="w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-sm text-bolt-elements-textPrimary transition-colors focus:border-bolt-elements-focus focus:outline-none"
        />
      </EditField>

      <EditField label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={2}
          className="w-full resize-none rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-sm text-bolt-elements-textPrimary transition-colors focus:border-bolt-elements-focus focus:outline-none"
        />
      </EditField>

      <EditField label="Tags">
        <input
          type="text"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          placeholder="editorial, blue, minimal"
          className="w-full rounded border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-3 py-1.5 text-sm text-bolt-elements-textPrimary placeholder:text-bolt-elements-textTertiary transition-colors focus:border-bolt-elements-focus focus:outline-none"
        />
      </EditField>

      <div className="flex items-center justify-between gap-2">
        {error ? (
          <p className="text-xs text-red-400">{error}</p>
        ) : (
          <span className="text-xs text-bolt-elements-textTertiary">
            {dirty ? 'Unsaved changes' : 'Up to date'}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="rounded-md bg-bolt-elements-button-primary-background px-3 py-1.5 text-xs font-medium text-bolt-elements-button-primary-text transition-colors hover:bg-bolt-elements-button-primary-backgroundHover disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </section>
  );
}

function EditField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-bolt-elements-textSecondary">
        {label}
      </span>
      {children}
    </label>
  );
}

import type { BrandTemplateSummary } from '~/types/brandTemplate';
import { TemplateCard } from './TemplateCard';

interface TemplateGalleryProps {
  skills: BrandTemplateSummary[];
  onCreate: () => void;
  onDelete: (skillId: string) => void;
}

export function TemplateGallery({ skills, onCreate, onDelete }: TemplateGalleryProps) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-bolt-elements-textPrimary">
            Brand templates
          </h1>
          <p className="mt-1 max-w-xl text-sm text-bolt-elements-textSecondary">
            Your library of design systems. Attach one to any chat so the app you
            generate honors the register, color strategy, typography, and motion
            habits captured here — not the category-reflex defaults the model
            would otherwise fall back to.
          </p>
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-2 self-start rounded-md bg-bolt-elements-button-primary-background px-3 py-2 text-sm font-medium text-bolt-elements-button-primary-text transition-colors hover:bg-bolt-elements-button-primary-backgroundHover"
        >
          <div className="i-ph:plus text-base" />
          New template
        </button>
      </header>

      {skills.length === 0 ? (
        <EmptyState onCreate={onCreate} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {skills.map((skill) => (
            <TemplateCard key={skill.skillId} skill={skill} onDelete={onDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-6 py-16 text-center">
      <div className="i-ph:paint-brush-broad text-3xl text-bolt-elements-textTertiary" />
      <h2 className="text-base font-medium text-bolt-elements-textPrimary">
        No brand templates yet
      </h2>
      <p className="max-w-sm text-sm text-bolt-elements-textSecondary">
        Upload inspiration images or paste a public website URL to extract a
        structured brand template you can reuse across chats.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="mt-2 inline-flex items-center gap-2 rounded-md bg-bolt-elements-button-primary-background px-3 py-2 text-sm font-medium text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover"
      >
        Create your first template
      </button>
    </div>
  );
}

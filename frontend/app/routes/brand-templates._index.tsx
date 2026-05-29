import { useEffect, useState } from 'react';
import type { MetaFunction } from '@remix-run/node';
import { useNavigate } from '@remix-run/react';
import AppConfigured from '~/components/auth/AppConfigured';
import GlobalHeader from '~/components/header/GlobalHeader';
import { ClientOnly } from '~/components/ui/ClientOnly';
import { TemplateGallery } from '~/components/brand-templates/TemplateGallery';
import { NewTemplateModal } from '~/components/brand-templates/NewTemplateModal';
import { ExtractionProgress } from '~/components/brand-templates/ExtractionProgress';
import type { BrandTemplateSummary } from '~/types/brandTemplate';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';

export const meta: MetaFunction = () => [
  { title: 'Brand templates — Vibe' },
  {
    name: 'description',
    content:
      'Your library of reusable design specifications extracted from inspiration.',
  },
];

function BrandTemplatesIndex() {
  const [skills, setSkills] = useState<BrandTemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const navigate = useNavigate();

  async function refresh() {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await getBrandTemplatesClient().listSkills();
      setSkills(list);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load skills.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleDelete(skillId: string) {
    try {
      await getBrandTemplatesClient().deleteSkill(skillId);
      setSkills((prev) => prev.filter((s) => s.skillId !== skillId));
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete template.');
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-bolt-elements-background-depth-1">
      <GlobalHeader />
      <main className="flex-1 pt-16">
        {pendingJobId ? (
          <div className="flex min-h-[60vh] items-center justify-center px-6 py-10">
            <ExtractionProgress
              jobId={pendingJobId}
              onReady={(templateId) => {
                setPendingJobId(null);
                navigate(`/brand-templates/${templateId}`);
              }}
            />
          </div>
        ) : loading ? (
          <div className="flex min-h-[60vh] items-center justify-center text-sm text-bolt-elements-textSecondary">
            Loading skills…
          </div>
        ) : loadError ? (
          <div className="mx-auto mt-12 max-w-lg rounded-lg border border-red-500/40 bg-red-500/10 p-6 text-sm text-red-400">
            {loadError}
          </div>
        ) : (
          <TemplateGallery
            skills={skills}
            onCreate={() => setModalOpen(true)}
            onDelete={(id) => void handleDelete(id)}
          />
        )}
      </main>
      <NewTemplateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={(response) => {
          setModalOpen(false);
          setPendingJobId(response.jobId);
        }}
      />
    </div>
  );
}

export default function BrandTemplatesIndexRoute() {
  return (
    <AppConfigured>
      <ClientOnly fallback={<div className="pt-24 text-center text-sm">Loading…</div>}>
        {() => <BrandTemplatesIndex />}
      </ClientOnly>
    </AppConfigured>
  );
}

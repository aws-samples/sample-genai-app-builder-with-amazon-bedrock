import { useEffect, useState } from 'react';
import type { MetaFunction } from '@remix-run/node';
import { Link, useNavigate, useParams } from '@remix-run/react';
import AppConfigured from '~/components/auth/AppConfigured';
import GlobalHeader from '~/components/header/GlobalHeader';
import { ClientOnly } from '~/components/ui/ClientOnly';
import { TemplateDetail } from '~/components/brand-templates/TemplateDetail';
import { TemplateMetadataEditor } from '~/components/brand-templates/TemplateMetadataEditor';
import { ExtractionProgress } from '~/components/brand-templates/ExtractionProgress';
import type { BrandTemplate } from '~/types/brandTemplate';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';

export const meta: MetaFunction = () => [
  { title: 'Brand template — Vibe' },
];

function DesignTemplateDetail() {
  // Route file is brand-templates.$templateId.tsx, so Remix surfaces the URL
  // param as `templateId`. The DDB record's primary key is still `skillId`
  // (kept on purpose — see the rename commit), so we map URL→DDB here.
  const { templateId: skillId } = useParams<{ templateId: string }>();
  const navigate = useNavigate();
  const [skill, setSkill] = useState<BrandTemplate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!skillId) {
      // No URL param → don't sit on "Loading…" forever; surface a clear error.
      setLoading(false);
      setError('Missing template id in URL.');
      return;
    }
    (async () => {
      try {
        const record = await getBrandTemplatesClient().getSkill(skillId);
        setSkill(record);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load template.');
      } finally {
        setLoading(false);
      }
    })();
  }, [skillId]);

  async function download() {
    if (!skill) return;
    try {
      const blob = await getBrandTemplatesClient().exportSkill(skill.skillId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `brand-template-${skill.skillId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to export template.');
    }
  }

  async function remove() {
    if (!skill) return;
    if (!confirm(`Delete "${skill.name}"? This can't be undone.`)) return;
    try {
      await getBrandTemplatesClient().deleteSkill(skill.skillId);
      navigate('/brand-templates');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete template.');
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-bolt-elements-background-depth-1">
      <GlobalHeader />
      <main className="flex-1 pt-16">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
          <nav className="flex items-center justify-between gap-2 text-sm">
            <Link
              to="/brand-templates"
              className="inline-flex items-center gap-1.5 text-bolt-elements-textSecondary transition-colors hover:text-bolt-elements-textPrimary"
            >
              <div className="i-ph:arrow-left text-sm" />
              Back to skills
            </Link>
            {skill && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={download}
                  className="rounded-md bg-bolt-elements-button-secondary-background px-3 py-1.5 text-xs font-medium text-bolt-elements-button-secondary-text transition-colors hover:bg-bolt-elements-button-secondary-backgroundHover"
                >
                  Download JSON
                </button>
                <button
                  type="button"
                  onClick={remove}
                  className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/20"
                >
                  Delete
                </button>
              </div>
            )}
          </nav>

          {loading ? (
            <p className="text-sm text-bolt-elements-textSecondary">Loading…</p>
          ) : error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-400">
              {error}
            </div>
          ) : skill ? (
            skill.status === 'processing' ? (
              // Extraction is still running. Reuse the gallery's progress
              // component so polling + "ready" redirect behavior is identical
              // whether the user lands here by URL or by the new-skill flow.
              //
              // Guard on extractionJobId: older records written before
              // dynamodb_client started populating this field at create-time
              // would fail the poll with /status/undefined -> 404. Fall back
              // to a soft waiting view instead of crashing.
              skill.extractionJobId ? (
                <ExtractionProgress
                  jobId={skill.extractionJobId}
                  onReady={async () => {
                    try {
                      const updated = await getBrandTemplatesClient().getSkill(skill.skillId);
                      setSkill(updated);
                    } catch (err) {
                      setError(err instanceof Error ? err.message : 'Failed to reload template.');
                    }
                  }}
                />
              ) : (
                <div className="flex flex-col gap-3 rounded-lg border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 p-4 text-sm">
                  <div className="font-medium text-bolt-elements-textPrimary">
                    Extraction in progress
                  </div>
                  <div className="text-bolt-elements-textSecondary">
                    This template is still being processed. Refresh in a minute.
                  </div>
                  <Link
                    to="/brand-templates"
                    className="self-start rounded-md bg-bolt-elements-button-secondary-background px-3 py-1.5 text-xs text-bolt-elements-button-secondary-text hover:bg-bolt-elements-button-secondary-backgroundHover"
                  >
                    Back to templates
                  </Link>
                </div>
              )
            ) : skill.status === 'failed' ? (
              // Full diagnostic block: the generic message stays, but we
              // surface the error code, detail (exception class name from the
              // Lambda — non-sensitive), and the CloudWatch requestId so a
              // user can paste it into support and we can grep directly.
              // Also: always render a back link and retry CTA here — the
              // earlier design left the user stuck with no obvious exit.
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
                  <div className="font-medium text-red-400">Extraction failed</div>
                  <div className="text-bolt-elements-textSecondary">
                    {skill.error?.message ??
                      'Something went wrong while extracting this template.'}
                  </div>
                  {(skill.error?.code || skill.error?.detail || skill.error?.requestId) && (
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs">
                      {skill.error?.code && (
                        <>
                          <dt className="text-bolt-elements-textTertiary">Code</dt>
                          <dd className="font-mono text-bolt-elements-textPrimary">
                            {skill.error.code}
                          </dd>
                        </>
                      )}
                      {skill.error?.detail && (
                        <>
                          <dt className="text-bolt-elements-textTertiary">Detail</dt>
                          <dd className="font-mono text-bolt-elements-textPrimary">
                            {skill.error.detail}
                          </dd>
                        </>
                      )}
                      {skill.error?.requestId && (
                        <>
                          <dt className="text-bolt-elements-textTertiary">Request ID</dt>
                          <dd className="flex items-center gap-2 font-mono text-bolt-elements-textPrimary">
                            <span className="select-all break-all">
                              {skill.error.requestId}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                navigator.clipboard?.writeText(skill.error!.requestId!)
                              }
                              className="rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-bolt-elements-textSecondary hover:bg-red-500/10"
                              title="Copy request ID"
                            >
                              copy
                            </button>
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    to="/brand-templates"
                    className="rounded-md bg-bolt-elements-button-secondary-background px-3 py-1.5 text-xs text-bolt-elements-button-secondary-text hover:bg-bolt-elements-button-secondary-backgroundHover"
                  >
                    Back to templates
                  </Link>
                  <Link
                    to="/brand-templates?new=1"
                    className="rounded-md bg-bolt-elements-button-primary-background px-3 py-1.5 text-xs text-bolt-elements-button-primary-text hover:bg-bolt-elements-button-primary-backgroundHover"
                  >
                    Try again
                  </Link>
                  <button
                    type="button"
                    onClick={remove}
                    className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/20"
                  >
                    Delete this skill
                  </button>
                </div>
              </div>
            ) : (
              // status === 'ready' — all tokens present, safe to render details.
              <div className="flex flex-col gap-8">
                <header className="flex flex-col gap-2">
                  <h1 className="text-2xl font-semibold text-bolt-elements-textPrimary">
                    {skill.name}
                  </h1>
                  <p className="text-sm text-bolt-elements-textSecondary">
                    {skill.styleDescriptor.label} ·{' '}
                    {skill.styleDescriptor.adjectives.join(' · ')}
                  </p>
                </header>

                <TemplateMetadataEditor skill={skill} onUpdated={setSkill} />
                <TemplateDetail skill={skill} />
              </div>
            )
          ) : null}
        </div>
      </main>
    </div>
  );
}

export default function DesignTemplateDetailRoute() {
  return (
    <AppConfigured>
      <ClientOnly fallback={<div className="pt-24 text-center text-sm">Loading…</div>}>
        {() => <DesignTemplateDetail />}
      </ClientOnly>
    </AppConfigured>
  );
}

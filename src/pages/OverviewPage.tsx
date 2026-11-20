import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowRight,
  AudioLines,
  FileSearch,
  FileText,
  Film,
  FlaskConical,
  FolderPlus,
  GitFork,
  Image as ImageIcon,
  RefreshCw,
} from 'lucide-react';
import { api, formatBytes, formatTimestamp, type OverviewData } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { EmptyWorkspaceState, PageHeader, SkeletonRows } from '../components/ForensicPrimitives';
import type { MediaType, NavPage } from '../types/forensics';

const MEDIA_MODULE_ROUTE: Record<MediaType, NavPage> = {
  image: 'image-forensics',
  video: 'video-forensics',
  audio: 'audio-forensics',
  text: 'text-analysis',
};

const MEDIA_ICON: Record<MediaType, React.ComponentType<{ className?: string; strokeWidth?: number }>> = {
  image: ImageIcon,
  video: Film,
  audio: AudioLines,
  text: FileSearch,
};

const STATUS_COLOR: Record<string, string> = {
  COMPLETED: 'text-[#52A378]',
  PROCESSING: 'text-[#D9A441]',
  PENDING: 'text-[#92949B]',
  FAILED: 'text-[#C95F5F]',
};

export const OverviewPage: React.FC = () => {
  const {
    setPage,
    setActiveId,
    activeDetail,
    refreshInvestigations,
    refreshActiveDetail,
    showNotice,
  } = useInvestigation();
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [creatingDemo, setCreatingDemo] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getOverview();
      setData(res);
    } catch (e: any) {
      showNotice('error', e?.message || 'Failed to load database overview.');
    } finally {
      setLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const handleLoadDemo = async () => {
    setCreatingDemo(true);
    try {
      const res = await api.createDemoCase();
      await refreshInvestigations(res.investigation_id);
      await load();
      showNotice(
        'success',
        `Demonstration case ${res.investigation_id} generated from real synthetic media files (${res.evidence_count} items analyzed).`
      );
      setPage('cross-modal');
    } catch (e: any) {
      showNotice('error', e?.message || 'Failed to generate demonstration case.');
    } finally {
      setCreatingDemo(false);
    }
  };

  const openCase = async (id: string) => {
    setActiveId(id);
    await refreshActiveDetail();
    setPage('cross-modal');
  };

  const counts = data?.counts;

  // Active Investigation Workspace breakdown
  const activeInv = activeDetail?.investigation || null;
  const activeEvidence = activeDetail?.evidence || [];
  const activeFindings = activeDetail?.findings || [];
  const activeRelationships = activeDetail?.relationships || [];
  const activeReviewedCount = activeFindings.filter((f) => f.review_status !== 'PENDING').length;
  const activeContradictions = activeRelationships.filter(
    (r) => r.relationship_type === 'CONTRADICTS'
  ).length;

  return (
    <div className="space-y-8">
      <PageHeader
        kicker="Ingest · Analyze · Correlate · Review · Report"
        title="Investigation Overview"
        description="Detect inconsistencies, connect multimodal evidence, and explain what matters. Every figure below is queried directly from persisted SQLite investigation records."
        actions={
          <>
            <button
              type="button"
              onClick={handleLoadDemo}
              disabled={creatingDemo}
              className="whitespace-nowrap px-3.5 py-2 rounded text-xs font-medium border border-[#2B2D32] bg-[#1B1D21] text-[#D8DAE0] hover:border-[#D9A441] hover:text-[#F4F3EF] active:scale-[0.985] transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <FlaskConical className="w-3.5 h-3.5 text-[#D9A441]" strokeWidth={1.75} />
              <span>{creatingDemo ? 'Generating Media...' : 'Run Demonstration Case'}</span>
            </button>
            <button
              type="button"
              onClick={() => setPage('new-investigation')}
              className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-1.5"
            >
              <FolderPlus className="w-3.5 h-3.5" strokeWidth={2} />
              <span>New Investigation</span>
            </button>
          </>
        }
      />

      {/* Live Vault Statistics Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y lg:divide-y-0 lg:divide-x divide-[#2B2D32]">
        <div className="p-5 space-y-1.5">
          <div className="text-xs text-[#92949B]">Investigations</div>
          <div className="text-2xl font-mono font-semibold text-[#F4F3EF] tabular-nums">
            {loading ? '—' : counts?.investigations ?? 0}
          </div>
          <div className="text-xs text-[#6C6F77] font-mono">Persisted cases</div>
        </div>

        <div className="p-5 space-y-1.5">
          <div className="text-xs text-[#92949B]">Evidence Files</div>
          <div className="text-2xl font-mono font-semibold text-[#F4F3EF] tabular-nums">
            {loading ? '—' : counts?.evidence_total ?? 0}
          </div>
          <div className="text-xs text-[#6C6F77] font-mono tabular-nums">
            {counts
              ? `${counts.evidence_image} img · ${counts.evidence_video} vid · ${counts.evidence_audio} aud · ${counts.evidence_text} txt`
              : '—'}
          </div>
        </div>

        <div className="p-5 space-y-1.5">
          <div className="text-xs text-[#92949B]">Processed Files</div>
          <div className="text-2xl font-mono font-semibold text-[#52A378] tabular-nums">
            {loading ? '—' : counts?.processing_completed ?? 0}
            <span className="text-sm text-[#6C6F77] font-normal">
              /{counts?.evidence_total ?? 0}
            </span>
          </div>
          <div className="text-xs text-[#6C6F77] font-mono tabular-nums">
            {counts
              ? `${counts.processing_pending} pending · ${counts.processing_failed} failed`
              : '—'}
          </div>
        </div>

        <div className="p-5 space-y-1.5">
          <div className="text-xs text-[#92949B]">Human Reviews</div>
          <div className="text-2xl font-mono font-semibold text-[#F4F3EF] tabular-nums">
            {loading ? '—' : counts?.findings_reviewed ?? 0}
            <span className="text-sm text-[#6C6F77] font-normal">
              /{counts?.findings_total ?? 0}
            </span>
          </div>
          <div className="text-xs text-[#6C6F77] font-mono">Analyst verified</div>
        </div>

        <div className="p-5 space-y-1.5 col-span-2 lg:col-span-1">
          <div className="text-xs text-[#92949B]">Cross-Modal Links</div>
          <div className="text-2xl font-mono font-semibold text-[#D9A441] tabular-nums">
            {loading ? '—' : counts?.relationships_total ?? 0}
          </div>
          <div className="text-xs text-[#C95F5F] font-mono tabular-nums">
            {counts ? `${counts.contradictions_total} potential conflicts` : '—'}
          </div>
        </div>
      </div>

      {/* Active Investigation Workspace Summary (when a case is loaded) */}
      {activeInv && (
        <section className="rounded-md border border-[#2B2D32] bg-[#1B1D21] overflow-hidden">
          <div className="px-5 py-4 border-b border-[#2B2D32] flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 space-y-0.5">
              <div className="text-xs font-mono text-[#92949B] flex flex-wrap items-center gap-x-2">
                <span className="text-[#D9A441]">Active Investigation Workspace</span>
                <span className="text-[#40434B]">·</span>
                <span>{activeInv.id}</span>
                <span className="text-[#40434B]">·</span>
                <span>{activeInv.status}</span>
                {activeInv.case_type === 'DEMONSTRATION' && (
                  <>
                    <span className="text-[#40434B]">·</span>
                    <span className="text-[#D9A441]">Demonstration</span>
                  </>
                )}
              </div>
              <h2 className="text-base font-semibold text-[#F4F3EF] truncate">{activeInv.title}</h2>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums text-[#92949B]">
              <span>
                Files: <strong className="text-[#F4F3EF] font-medium">{activeEvidence.length}</strong>
              </span>
              <span>
                Reviewed:{' '}
                <strong className="text-[#52A378] font-medium">
                  {activeReviewedCount}/{activeFindings.length}
                </strong>
              </span>
              <span>
                Links:{' '}
                <strong className="text-[#D9A441] font-medium">{activeRelationships.length}</strong>
              </span>
              {activeContradictions > 0 && (
                <span className="text-[#C95F5F]">{activeContradictions} conflicts</span>
              )}
              <button
                type="button"
                onClick={() => setPage('cross-modal')}
                className="font-sans font-medium text-[#D9A441] hover:underline inline-flex items-center gap-1"
              >
                Open Graph
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {activeEvidence.length === 0 ? (
            <div className="px-5 py-5 text-xs text-[#92949B] flex items-center justify-between gap-4">
              <span>No evidence files uploaded to this investigation yet.</span>
              <button
                type="button"
                onClick={() => setPage('new-investigation')}
                className="text-[#D9A441] hover:underline font-medium whitespace-nowrap"
              >
                Upload Evidence
              </button>
            </div>
          ) : (
            <div className="divide-y divide-[#2B2D32]">
              {activeEvidence.slice(0, 5).map((ev) => {
                const Icon = MEDIA_ICON[ev.media_type];
                const evFindings = activeFindings.filter((f) => f.evidence_id === ev.id);
                const evReviewed = evFindings.filter((f) => f.review_status !== 'PENDING').length;
                return (
                  <div
                    key={ev.id}
                    className="px-5 py-3 flex flex-wrap items-center justify-between gap-4 hover:bg-[#202328] transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <Icon className="w-4 h-4 text-[#92949B] shrink-0" strokeWidth={1.75} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[#F4F3EF] truncate">
                          {ev.original_filename}
                        </div>
                        <div className="text-[11px] font-mono text-[#92949B] tabular-nums">
                          {ev.id} · {ev.media_type.toUpperCase()} · {formatBytes(ev.file_size)}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-5 text-xs font-mono tabular-nums shrink-0">
                      <span className={STATUS_COLOR[ev.processing_status] || 'text-[#92949B]'}>
                        {ev.processing_status}
                      </span>
                      <span className="text-[#92949B]">
                        {evReviewed}/{evFindings.length} reviewed
                      </span>
                      <button
                        type="button"
                        onClick={() => setPage(MEDIA_MODULE_ROUTE[ev.media_type])}
                        className="font-sans font-medium text-[#D9A441] hover:underline inline-flex items-center gap-1"
                      >
                        Inspect
                        <ArrowRight className="w-3 h-3" strokeWidth={1.75} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Left: Recent Investigations & Automated Findings */}
        <div className="xl:col-span-7 space-y-7">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-[15px] font-semibold text-[#F4F3EF]">Recent Investigations</h2>
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={load}
                  className="text-xs text-[#92949B] hover:text-[#F4F3EF] flex items-center gap-1.5 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" strokeWidth={1.75} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => setPage('history')}
                  className="text-xs font-medium text-[#D9A441] hover:underline flex items-center gap-1"
                >
                  All Cases
                  <ArrowRight className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
              </div>
            </div>

            {loading ? (
              <SkeletonRows rows={3} />
            ) : !data || data.recent_investigations.length === 0 ? (
              <EmptyWorkspaceState
                icon={FolderPlus}
                title="No investigations in the vault yet"
                description="TruthLens X never populates an empty workspace with fictional data. Create a new investigation to upload real evidence, or run the labeled Demonstration Case to synthesize test media via FFmpeg and Sharp."
                actionLabel="Create Investigation"
                onAction={() => setPage('new-investigation')}
                secondaryAction={
                  <button
                    type="button"
                    onClick={handleLoadDemo}
                    disabled={creatingDemo}
                    className="px-3.5 py-2 rounded text-xs font-medium border border-[#2B2D32] bg-[#151619] text-[#D8DAE0] hover:border-[#D9A441] transition-colors"
                  >
                    {creatingDemo ? 'Synthesizing...' : 'Run Demonstration Case'}
                  </button>
                }
              />
            ) : (
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#2B2D32] text-xs font-mono text-[#92949B]">
                      <th className="py-3 px-4 font-medium">Case ID / Title</th>
                      <th className="py-3 px-3 font-medium text-right">Files</th>
                      <th className="py-3 px-3 font-medium text-right">Reviewed</th>
                      <th className="py-3 px-3 font-medium text-right">Links</th>
                      <th className="py-3 px-4 font-medium">Status</th>
                      <th className="py-3 px-4 font-medium text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2B2D32] text-sm">
                    {data.recent_investigations.map((inv) => (
                      <tr key={inv.id} className="hover:bg-[#202328] transition-colors">
                        <td className="py-3 px-4">
                          <div className="font-mono text-[11px] text-[#92949B]">
                            {inv.id}
                            {inv.case_type === 'DEMONSTRATION' && (
                              <span className="text-[#D9A441] ml-2">· Demonstration</span>
                            )}
                          </div>
                          <div className="font-medium text-[#F4F3EF] truncate max-w-[260px]">
                            {inv.title}
                          </div>
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-xs text-[#D4D6DC] tabular-nums">
                          {inv.evidence_count ?? 0}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-xs text-[#D4D6DC] tabular-nums">
                          {inv.reviewed_count ?? 0}/{inv.finding_count ?? 0}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-xs text-[#D9A441] tabular-nums">
                          {inv.relationship_count ?? 0}
                        </td>
                        <td className="py-3 px-4 font-mono text-xs text-[#B8BAC0]">{inv.status}</td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => openCase(inv.id)}
                            className="whitespace-nowrap text-xs font-medium text-[#D9A441] hover:underline inline-flex items-center gap-1"
                          >
                            Open
                            <ArrowRight className="w-3 h-3" strokeWidth={1.75} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Recent Findings Feed */}
          <div className="space-y-3">
            <h2 className="text-[15px] font-semibold text-[#F4F3EF]">Recent Automated Findings</h2>
            {loading ? (
              <SkeletonRows rows={3} />
            ) : !data || data.recent_findings.length === 0 ? (
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] px-5 py-6 text-sm text-[#92949B]">
                No forensic observations generated yet. Upload and analyze evidence to populate
                traceable findings.
              </div>
            ) : (
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
                {data.recent_findings.map((f) => (
                  <div
                    key={f.id}
                    className="px-4 py-3.5 hover:bg-[#202328] transition-colors flex items-start justify-between gap-4"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="text-[11px] font-mono text-[#92949B] flex flex-wrap items-center gap-x-2">
                        <span>{f.id}</span>
                        <span className="text-[#40434B]">·</span>
                        <span className="text-[#C9CBD1]">{f.module.replace(/_/g, ' ')}</span>
                        <span className="text-[#40434B]">·</span>
                        <span
                          className={
                            f.evidence_strength === 'STRONG'
                              ? 'text-[#52A378]'
                              : f.evidence_strength === 'MODERATE'
                                ? 'text-[#D9A441]'
                                : 'text-[#92949B]'
                          }
                        >
                          {f.evidence_strength}
                        </span>
                        <span className="text-[#40434B]">·</span>
                        <span>{f.review_status}</span>
                      </div>
                      <div className="text-sm font-medium text-[#F4F3EF]">{f.title}</div>
                      <div className="text-xs text-[#92949B] truncate">
                        {f.investigation_title} — Ref: {f.evidence_reference}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => openCase(f.investigation_id)}
                      className="shrink-0 text-xs font-medium text-[#D9A441] hover:underline whitespace-nowrap"
                    >
                      Inspect
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: Quick Module Navigation & Recent Processing Activity */}
        <div className="xl:col-span-5 space-y-7">
          <div className="space-y-3">
            <h2 className="text-[15px] font-semibold text-[#F4F3EF]">Forensic Modules</h2>
            <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
              {[
                {
                  page: 'image-forensics' as const,
                  icon: ImageIcon,
                  title: 'Image Forensics',
                  desc: 'EXIF/XMP/GPS extraction, JPEG Error Level Analysis, spatial noise profiling',
                },
                {
                  page: 'video-forensics' as const,
                  icon: Film,
                  title: 'Video Forensics',
                  desc: '8-layer AI authenticity engine, FFmpeg frame gallery, scene cuts, lip-sync & flow',
                },
                {
                  page: 'audio-forensics' as const,
                  icon: AudioLines,
                  title: 'Audio Forensics',
                  desc: 'PCM waveform, FFmpeg log spectrogram, silence & energy-step detection',
                },
                {
                  page: 'text-analysis' as const,
                  icon: FileSearch,
                  title: 'Text Analysis',
                  desc: 'Date, location, and entity extraction with side-by-side similarity diff',
                },
                {
                  page: 'cross-modal' as const,
                  icon: GitFork,
                  title: 'Cross-Modal Analysis',
                  desc: 'Interactive contradiction graph linking media findings, metadata, and claims',
                },
                {
                  page: 'reports' as const,
                  icon: FileText,
                  title: 'Forensic Reports',
                  desc: '17-section PDF dossier compiled strictly from database evidence and reviews',
                },
              ].map((m) => {
                const Icon = m.icon;
                return (
                  <button
                    key={m.page}
                    type="button"
                    onClick={() => setPage(m.page)}
                    className="w-full text-left px-4 py-3.5 hover:bg-[#202328] transition-colors flex items-center justify-between gap-3 group"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <Icon
                        className="w-4 h-4 text-[#6C6F77] group-hover:text-[#D9A441] mt-0.5 shrink-0 transition-colors"
                        strokeWidth={1.75}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[#F4F3EF] group-hover:text-[#D9A441] transition-colors">
                          {m.title}
                        </div>
                        <div className="text-xs text-[#92949B] mt-0.5 leading-snug">{m.desc}</div>
                      </div>
                    </div>
                    <ArrowRight
                      className="w-4 h-4 text-[#6C6F77] group-hover:text-[#D9A441] group-hover:translate-x-0.5 shrink-0 transition-all"
                      strokeWidth={1.75}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-[15px] font-semibold text-[#F4F3EF]">Processing Activity</h2>
              <button
                type="button"
                onClick={() => setPage('timeline')}
                className="text-xs font-medium text-[#D9A441] hover:underline"
              >
                Full Timeline
              </button>
            </div>
            {loading ? (
              <SkeletonRows rows={3} />
            ) : !data || data.recent_activity.length === 0 ? (
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] px-4 py-6 text-sm text-[#92949B]">
                No provenance or processing events logged yet.
              </div>
            ) : (
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
                {data.recent_activity.map((evt) => (
                  <div key={evt.id} className="px-4 py-3 space-y-1">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                      <span className="text-[#D9A441]">{evt.event_type}</span>
                      <span className="text-[#6C6F77] tabular-nums">
                        {formatTimestamp(evt.timestamp)}
                      </span>
                    </div>
                    <p className="text-xs text-[#D4D6DC] leading-relaxed">{evt.description}</p>
                    <div className="text-[11px] text-[#6C6F77] truncate">
                      {evt.investigation_title}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

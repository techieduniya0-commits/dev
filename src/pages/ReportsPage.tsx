import React, { useCallback, useEffect, useState } from 'react';
import { Download, FileCheck2, FileText, Loader2 } from 'lucide-react';
import { api, formatBytes, formatTimestamp } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import {
  CopyHashButton,
  EmptyWorkspaceState,
  PageHeader,
  SkeletonRows,
} from '../components/ForensicPrimitives';
import type { ReportRecord } from '../types/forensics';

export const ReportsPage: React.FC = () => {
  const { activeDetail, activeId, setPage, showNotice } = useInvestigation();
  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [generating, setGenerating] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadReports = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await api.listReports();
      setReports(rows);
    } catch (e: any) {
      showNotice('error', e?.message || 'Failed to load report archive.');
    } finally {
      setLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleGenerate = async () => {
    if (!activeId) return;
    setGenerating(true);
    try {
      const rpt = await api.generateReport(activeId);
      await loadReports();
      showNotice('success', `Generated forensic PDF report ${rpt.filename}.`);
    } catch (e: any) {
      showNotice('error', e?.message || 'PDF generation failed.');
    } finally {
      setGenerating(false);
    }
  };

  const inv = activeDetail?.investigation;
  const evidence = activeDetail?.evidence || [];
  const findings = activeDetail?.findings || [];
  const relationships = activeDetail?.relationships || [];
  const reviewedFindings = findings.filter((f) => f.review_status !== 'PENDING');
  const acceptedCount = findings.filter((f) => f.review_status === 'ACCEPTED').length;
  const rejectedCount = findings.filter((f) => f.review_status === 'REJECTED').length;
  const inconclusiveCount = findings.filter((f) => f.review_status === 'INCONCLUSIVE').length;

  return (
    <div className="space-y-8">
      <PageHeader
        kicker="Forensic Dossier Export"
        title="Forensic PDF Reports"
        description="Compile a 17-section downloadable PDF dossier strictly from persisted SQLite evidence, SHA-256 hashes, findings, cross-modal links, and analyst reviews."
        actions={
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || !activeId}
            className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-2 disabled:opacity-40"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} />
            ) : (
              <FileCheck2 className="w-4 h-4" strokeWidth={1.75} />
            )}
            <span>{generating ? 'Compiling PDF...' : 'Generate PDF Report'}</span>
          </button>
        }
      />

      {/* Live Structured Report Preview for Active Investigation */}
      {inv ? (
        <section className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-6 space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[#2B2D32]">
            <div className="space-y-1">
              <div className="text-xs font-mono text-[#D9A441]">
                Live Report Preview · {inv.id}
                {inv.case_type === 'DEMONSTRATION' ? ' · Demonstration Case' : ''}
              </div>
              <h2 className="text-lg font-semibold text-[#F4F3EF]">{inv.title}</h2>
              <p className="text-xs text-[#92949B] max-w-3xl leading-relaxed">
                {inv.description || 'No narrative description recorded.'}
              </p>
            </div>
            <div className="text-xs font-mono text-[#92949B] text-right tabular-nums space-y-0.5">
              <div>Status: {inv.status}</div>
              <div>Updated: {formatTimestamp(inv.updated_at)}</div>
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 rounded border border-[#2B2D32] bg-[#131417] divide-y lg:divide-y-0 lg:divide-x divide-[#2B2D32] text-xs font-mono">
            <div className="p-4">
              <div className="text-[#92949B] font-sans">Evidence Inventory</div>
              <div className="text-lg font-semibold text-[#F4F3EF] mt-1 tabular-nums">
                {evidence.length} file(s)
              </div>
            </div>
            <div className="p-4">
              <div className="text-[#92949B] font-sans">Recorded Findings</div>
              <div className="text-lg font-semibold text-[#F4F3EF] mt-1 tabular-nums">
                {findings.length} total
              </div>
            </div>
            <div className="p-4">
              <div className="text-[#92949B] font-sans">Human Review Decisions</div>
              <div className="text-lg font-semibold text-[#52A378] mt-1 tabular-nums">
                {reviewedFindings.length}/{findings.length}
              </div>
              <div className="text-[11px] text-[#6C6F77] mt-0.5 tabular-nums">
                {acceptedCount} acc · {rejectedCount} rej · {inconclusiveCount} inc
              </div>
            </div>
            <div className="p-4">
              <div className="text-[#92949B] font-sans">Cross-Modal Links</div>
              <div className="text-lg font-semibold text-[#D9A441] mt-1 tabular-nums">
                {relationships.length} links
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
            <div className="space-y-2.5">
              <div className="font-medium text-[#D8DAE0]">Included 17-Section Dossier Structure</div>
              <ol className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[#C9CBD1] font-mono">
                <li>01. Cover Page</li>
                <li>02. Investigation Details</li>
                <li>03. Executive Summary</li>
                <li>04. Evidence Inventory</li>
                <li>05. SHA-256 Hashes</li>
                <li>06. Image Findings</li>
                <li>07. Video Findings & AI Rating</li>
                <li>08. Audio Findings</li>
                <li>09. Text Analysis</li>
                <li>10. Cross-Modal Links</li>
                <li>11. Provenance Timeline</li>
                <li>12. Human Review Log</li>
                <li>13. Analysis Methods</li>
                <li>14. Evidence Strength</li>
                <li>15. Alternative Explanations</li>
                <li>16. Limitations & Calibration</li>
                <li>17. Final Case Status</li>
              </ol>
            </div>

            <div className="space-y-2.5">
              <div className="font-medium text-[#D8DAE0]">Evidence SHA-256 Provenance Preview</div>
              {evidence.length === 0 ? (
                <div className="text-[#92949B]">No evidence files attached yet.</div>
              ) : (
                <div className="rounded bg-[#131417] border border-[#2B2D32] p-3.5 space-y-2.5 max-h-48 overflow-y-auto font-mono">
                  {evidence.map((ev) => (
                    <div key={ev.id} className="space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[#F4F3EF] truncate">
                          {ev.original_filename} ({formatBytes(ev.file_size)})
                        </span>
                        <CopyHashButton value={ev.sha256_hash} />
                      </div>
                      <div className="text-[11px] text-[#92949B] break-all">{ev.sha256_hash}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      ) : (
        <EmptyWorkspaceState
          icon={FileText}
          title="No active investigation selected"
          description="Select or create an investigation to preview its structured dossier and export a PDF report."
          actionLabel="New Investigation"
          onAction={() => setPage('new-investigation')}
        />
      )}

      {/* Generated PDF Archive */}
      <section className="space-y-3">
        <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
          Generated Forensic Reports ({reports.length})
        </h2>

        {loading ? (
          <SkeletonRows rows={3} />
        ) : (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#2B2D32] font-mono text-[#92949B]">
                  <th className="py-3 px-4 font-medium">Report ID / Filename</th>
                  <th className="py-3 px-3 font-medium">Investigation</th>
                  <th className="py-3 px-3 font-medium">Summary</th>
                  <th className="py-3 px-3 font-medium">Generated (UTC)</th>
                  <th className="py-3 px-4 font-medium text-right">Download</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#2B2D32]">
                {reports.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 px-4 text-[#92949B]">
                      No PDF reports generated yet. Click "Generate PDF Report" above to compile
                      your first downloadable forensic dossier.
                    </td>
                  </tr>
                ) : (
                  reports.map((rpt) => (
                    <tr key={rpt.id} className="hover:bg-[#202328] transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-mono text-[#D9A441]">{rpt.id}</div>
                        <div className="text-sm text-[#F4F3EF] flex items-center gap-1.5 mt-0.5">
                          <FileText
                            className="w-3.5 h-3.5 text-[#92949B] shrink-0"
                            strokeWidth={1.75}
                          />
                          <span className="truncate max-w-xs">{rpt.filename}</span>
                        </div>
                      </td>
                      <td className="py-3.5 px-3 text-[#D4D6DC]">
                        <div className="font-mono text-[11px] text-[#92949B]">
                          {rpt.investigation_id}
                        </div>
                        <div className="truncate max-w-[220px]">
                          {rpt.investigation_title || rpt.investigation_id}
                        </div>
                      </td>
                      <td className="py-3.5 px-3 font-mono text-[#92949B] tabular-nums">
                        {rpt.summary?.evidence_count ?? 0} files ·{' '}
                        {rpt.summary?.finding_count ?? 0} findings ·{' '}
                        {rpt.summary?.relationship_count ?? 0} links
                      </td>
                      <td className="py-3.5 px-3 font-mono text-[#92949B] whitespace-nowrap tabular-nums">
                        {formatTimestamp(rpt.generated_at)}
                      </td>
                      <td className="py-3.5 px-4 text-right">
                        <a
                          href={`/api/reports/${rpt.id}/download`}
                          className="whitespace-nowrap px-3 py-1.5 rounded font-medium border border-[#2B2D32] bg-[#151619] text-[#F4F3EF] hover:border-[#D9A441] hover:text-[#D9A441] inline-flex items-center gap-1.5 transition-colors"
                        >
                          <Download className="w-3.5 h-3.5" strokeWidth={1.75} />
                          Download PDF
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

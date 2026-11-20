import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeftRight, FileSearch, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import type { TextRecordRole } from '../types/forensics';
import { FindingReviewList } from '../components/FindingReviewPanel';
import { EmptyWorkspaceState, PageHeader } from '../components/ForensicPrimitives';

export const TextAnalysisPage: React.FC = () => {
  const { activeDetail, activeId, setPage, refreshActiveDetail, showNotice } = useInvestigation();

  const textRecords = activeDetail?.text_records || [];
  const [sourceAId, setSourceAId] = useState<string>('');
  const [sourceBId, setSourceBId] = useState<string>('');
  const [comparison, setComparison] = useState<any | null>(null);
  const [comparing, setComparing] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [newRole, setNewRole] = useState<TextRecordRole>('CLAIM');
  const [newLabel, setNewLabel] = useState('');
  const [newContent, setNewContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (textRecords.length >= 2) {
      if (!sourceAId || !textRecords.some((t) => t.id === sourceAId)) {
        setSourceAId(textRecords[0].id);
      }
      if (!sourceBId || !textRecords.some((t) => t.id === sourceBId)) {
        setSourceBId(textRecords[1].id);
      }
    } else if (textRecords.length === 1) {
      setSourceAId(textRecords[0].id);
      setSourceBId('');
    } else {
      setSourceAId('');
      setSourceBId('');
    }
  }, [textRecords, sourceAId, sourceBId]);

  const recordA = textRecords.find((t) => t.id === sourceAId) || null;
  const recordB = textRecords.find((t) => t.id === sourceBId) || null;

  const runComparison = async () => {
    if (!recordA || !recordB) return;
    setComparing(true);
    try {
      const res = await api.compareTexts({
        label_a: `${recordA.role}: ${recordA.label}`,
        text_a: recordA.content,
        label_b: `${recordB.role}: ${recordB.label}`,
        text_b: recordB.content,
      });
      setComparison(res);
    } catch (e: any) {
      showNotice('error', e?.message || 'Comparison failed.');
    } finally {
      setComparing(false);
    }
  };

  useEffect(() => {
    if (recordA && recordB && recordA.id !== recordB.id) {
      runComparison();
    } else {
      setComparison(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceAId, sourceBId]);

  const handleAddRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId || !newLabel.trim() || !newContent.trim()) return;
    setSaving(true);
    try {
      await api.addTextRecord(activeId, {
        role: newRole,
        label: newLabel.trim(),
        content: newContent.trim(),
      });
      await api.correlateInvestigation(activeId);
      await refreshActiveDetail();
      setNewLabel('');
      setNewContent('');
      setShowAdd(false);
      showNotice('success', 'Text record added and cross-modal correlation updated.');
    } catch (err: any) {
      showNotice('error', err?.message || 'Failed to add text record.');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRecord = async (id: string) => {
    if (!activeId) return;
    try {
      await api.deleteTextRecord(id);
      await api.correlateInvestigation(activeId);
      await refreshActiveDetail();
      showNotice('info', 'Removed text record.');
    } catch (e: any) {
      showNotice('error', e?.message || 'Failed to delete text record.');
    }
  };

  const findings = (activeDetail?.findings || []).filter(
    (f) => f.module === 'TEXT_ANALYSIS' || f.module === 'CROSS_MODAL_ENGINE'
  );

  if (!activeId || !activeDetail) {
    return (
      <EmptyWorkspaceState
        icon={FileSearch}
        title="Text & Context Analysis"
        description="Select or create an investigation first to compare captions, transcripts, claims, and text documents."
        actionLabel="New Investigation"
        onAction={() => setPage('new-investigation')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={`Textual Corroboration · ${activeDetail.investigation.id}`}
        title="Text & Context Analysis"
        description="Side-by-side comparison of captions, transcripts, claims, and documents with date, location, number, and entity conflict detection."
        actions={
          <button
            type="button"
            onClick={() => setShowAdd((s) => !s)}
            className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" strokeWidth={2} />
            Add Caption / Claim / Transcript
          </button>
        }
      />

      {/* Add Text Record Form */}
      <AnimatePresence>
        {showAdd && (
          <motion.form
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.16 }}
            onSubmit={handleAddRecord}
            className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-4"
          >
            <div className="text-sm font-semibold text-[#F4F3EF]">Record New Textual Source</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-[#92949B] mb-1">Source Type</label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as TextRecordRole)}
                  className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-xs text-[#F4F3EF]"
                >
                  <option value="CAPTION">Social / Media Caption</option>
                  <option value="TRANSCRIPT">Audio / Video Transcript</option>
                  <option value="CLAIM">Investigator Claim</option>
                  <option value="DOCUMENT">Text Document</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="block text-xs text-[#92949B] mb-1">Label *</label>
                <input
                  type="text"
                  required
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="e.g., Witness Statement #2 or Wire Report"
                  className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-xs text-[#F4F3EF] focus:outline-none focus:border-[#D9A441]"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-[#92949B] mb-1">Text Content *</label>
              <textarea
                rows={4}
                required
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                placeholder="Enter text including claimed dates, times, locations, entities, or numbers..."
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441]"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="px-3.5 py-1.5 rounded text-xs border border-[#2B2D32] text-[#92949B] hover:text-[#F4F3EF]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-1.5 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save & Run Correlation'}
              </button>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Recorded Text Sources List */}
      <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] overflow-hidden">
        <div className="px-4 py-3 border-b border-[#2B2D32] text-xs font-medium text-[#D8DAE0] flex items-center justify-between">
          <span>Investigation Text Sources</span>
          <span className="font-mono text-[#92949B] tabular-nums">{textRecords.length}</span>
        </div>
        {textRecords.length === 0 ? (
          <div className="p-6 text-sm text-[#92949B]">
            No text records yet. Upload a .txt/.srt/.md file or click "Add Caption / Claim /
            Transcript" above to begin side-by-side comparison.
          </div>
        ) : (
          <div className="divide-y divide-[#2B2D32]">
            {textRecords.map((tr) => (
              <div
                key={tr.id}
                className="px-4 py-3.5 flex items-start justify-between gap-4 hover:bg-[#202328] transition-colors"
              >
                <div className="min-w-0 space-y-1">
                  <div className="text-xs font-mono text-[#92949B]">
                    <span className="text-[#D9A441]">{tr.role}</span> · {tr.id} ·{' '}
                    <span className="text-[#F4F3EF] font-sans font-medium">{tr.label}</span>
                  </div>
                  <p className="text-xs text-[#C9CBD1] line-clamp-2 leading-relaxed">
                    {tr.content}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteRecord(tr.id)}
                  className="text-[#C95F5F] hover:text-[#E69494] p-1 shrink-0 transition-colors"
                  title="Remove text record"
                >
                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Side-by-Side Comparison Workspace */}
      {textRecords.length >= 2 && (
        <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#2B2D32]">
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="w-4 h-4 text-[#D9A441]" strokeWidth={1.75} />
              <h2 className="text-sm font-semibold text-[#F4F3EF]">
                Side-by-Side Forensic Text Comparison
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <select
                value={sourceAId}
                onChange={(e) => setSourceAId(e.target.value)}
                className="rounded bg-[#131417] border border-[#2B2D32] px-3 py-1.5 text-xs text-[#F4F3EF]"
              >
                {textRecords.map((t) => (
                  <option key={t.id} value={t.id}>
                    A: [{t.role}] {t.label}
                  </option>
                ))}
              </select>
              <span className="text-xs font-mono text-[#6C6F77]">vs</span>
              <select
                value={sourceBId}
                onChange={(e) => setSourceBId(e.target.value)}
                className="rounded bg-[#131417] border border-[#2B2D32] px-3 py-1.5 text-xs text-[#F4F3EF]"
              >
                {textRecords.map((t) => (
                  <option key={t.id} value={t.id}>
                    B: [{t.role}] {t.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={runComparison}
                disabled={comparing || !recordA || !recordB || recordA.id === recordB.id}
                className="whitespace-nowrap px-3.5 py-1.5 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] disabled:opacity-40"
              >
                {comparing ? 'Comparing...' : 'Compare'}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded bg-[#131417] border border-[#2B2D32] p-4 space-y-2">
              <div className="text-xs font-mono text-[#D9A441]">
                Source A · {recordA?.role} — {recordA?.label}
              </div>
              <p className="text-sm text-[#E2E3E6] leading-relaxed whitespace-pre-wrap">
                {recordA?.content}
              </p>
            </div>
            <div className="rounded bg-[#131417] border border-[#2B2D32] p-4 space-y-2">
              <div className="text-xs font-mono text-[#6491C7]">
                Source B · {recordB?.role} — {recordB?.label}
              </div>
              <p className="text-sm text-[#E2E3E6] leading-relaxed whitespace-pre-wrap">
                {recordB?.content}
              </p>
            </div>
          </div>

          {comparison && (
            <div className="space-y-5">
              <div className="grid grid-cols-2 md:grid-cols-4 rounded border border-[#2B2D32] bg-[#131417] divide-y md:divide-y-0 md:divide-x divide-[#2B2D32] text-xs font-mono">
                <div className="p-3.5">
                  <div className="text-[#92949B] font-sans">TF Cosine Similarity</div>
                  <div className="text-lg font-semibold text-[#F4F3EF] mt-1 tabular-nums">
                    {(comparison.cosine_similarity * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="text-[#92949B] font-sans">Jaccard Keyword Overlap</div>
                  <div className="text-lg font-semibold text-[#F4F3EF] mt-1 tabular-nums">
                    {(comparison.jaccard_similarity * 100).toFixed(1)}%
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="text-[#92949B] font-sans">Date Divergences</div>
                  <div
                    className={`text-base font-semibold mt-1 font-sans ${
                      comparison.conflicting_dates.a.length && comparison.conflicting_dates.b.length
                        ? 'text-[#C95F5F]'
                        : 'text-[#52A378]'
                    }`}
                  >
                    {comparison.conflicting_dates.a.length && comparison.conflicting_dates.b.length
                      ? 'Conflict Flagged'
                      : 'Aligned / None'}
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="text-[#92949B] font-sans">Location Divergences</div>
                  <div
                    className={`text-base font-semibold mt-1 font-sans ${
                      comparison.conflicting_locations.a.length &&
                      comparison.conflicting_locations.b.length
                        ? 'text-[#C95F5F]'
                        : 'text-[#52A378]'
                    }`}
                  >
                    {comparison.conflicting_locations.a.length &&
                    comparison.conflicting_locations.b.length
                      ? 'Conflict Flagged'
                      : 'Aligned / None'}
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto rounded border border-[#2B2D32]">
                <table className="w-full text-left border-collapse text-xs font-mono">
                  <thead>
                    <tr className="border-b border-[#2B2D32] bg-[#131417] text-[#92949B] font-sans">
                      <th className="py-2.5 px-3 font-medium">Signal Category</th>
                      <th className="py-2.5 px-3 font-medium">Matching</th>
                      <th className="py-2.5 px-3 font-medium">Only in Source A</th>
                      <th className="py-2.5 px-3 font-medium">Only in Source B</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#2B2D32]">
                    <tr>
                      <td className="py-2.5 px-3 text-[#C9CBD1] font-sans">Dates</td>
                      <td className="py-2.5 px-3 text-[#52A378]">
                        {comparison.matching_dates.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#D9A441]">
                        {comparison.conflicting_dates.a.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#C95F5F]">
                        {comparison.conflicting_dates.b.join(', ') || '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-[#C9CBD1] font-sans">Times</td>
                      <td className="py-2.5 px-3 text-[#52A378]">
                        {comparison.matching_times.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#D9A441]">
                        {comparison.conflicting_times.a.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#C95F5F]">
                        {comparison.conflicting_times.b.join(', ') || '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-[#C9CBD1] font-sans">Locations</td>
                      <td className="py-2.5 px-3 text-[#52A378]">
                        {comparison.matching_locations.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#D9A441]">
                        {comparison.conflicting_locations.a.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#C95F5F]">
                        {comparison.conflicting_locations.b.join(', ') || '—'}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-[#C9CBD1] font-sans">Numerical Claims</td>
                      <td className="py-2.5 px-3 text-[#52A378]">
                        {comparison.matching_numbers.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#D9A441]">
                        {comparison.conflicting_numbers.a.join(', ') || '—'}
                      </td>
                      <td className="py-2.5 px-3 text-[#C95F5F]">
                        {comparison.conflicting_numbers.b.join(', ') || '—'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="space-y-2.5">
                <div className="text-xs font-medium text-[#92949B]">Comparison Observations</div>
                <div className="rounded border border-[#2B2D32] divide-y divide-[#2B2D32] overflow-hidden">
                  {comparison.observations.map((obs: any, idx: number) => (
                    <div key={idx} className="p-3.5 bg-[#131417] space-y-1">
                      <div className="text-xs font-mono">
                        <span
                          className={
                            obs.type === 'POTENTIAL_CONTRADICTION'
                              ? 'text-[#C95F5F]'
                              : obs.type === 'MATCH'
                                ? 'text-[#52A378]'
                                : 'text-[#D9A441]'
                          }
                        >
                          {obs.type.replace(/_/g, ' ')}
                        </span>
                        <span className="text-[#40434B] mx-2">·</span>
                        <span className="text-[#F4F3EF] font-sans font-medium">{obs.summary}</span>
                      </div>
                      <p className="text-xs text-[#C9CBD1] leading-relaxed">{obs.detail}</p>
                      <p className="text-xs text-[#92949B]">
                        Alternative explanation: {obs.alternative_explanation}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-[#92949B]">{comparison.disclaimer}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Findings & Human Review */}
      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
          Text & Cross-Modal Observations ({findings.length})
        </h2>
        <FindingReviewList
          findings={findings}
          onReviewed={refreshActiveDetail}
          emptyMessage="Upload text files or add textual sources to generate text analysis findings."
        />
      </div>
    </div>
  );
};

import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, FolderPlus, Search, Trash2 } from 'lucide-react';
import { api, formatTimestamp } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { PageHeader } from '../components/ForensicPrimitives';
import type { InvestigationStatus } from '../types/forensics';

export const HistoryPage: React.FC = () => {
  const {
    investigations,
    activeId,
    setActiveId,
    setPage,
    refreshInvestigations,
    refreshActiveDetail,
    showNotice,
  } = useInvestigation();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | InvestigationStatus>('ALL');
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'title'>('updated');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return investigations
      .filter((inv) => {
        const matchesStatus = statusFilter === 'ALL' || inv.status === statusFilter;
        const matchesSearch =
          !q ||
          inv.title.toLowerCase().includes(q) ||
          inv.id.toLowerCase().includes(q) ||
          inv.description.toLowerCase().includes(q);
        return matchesStatus && matchesSearch;
      })
      .sort((a, b) => {
        if (sortBy === 'title') return a.title.localeCompare(b.title);
        if (sortBy === 'created') return b.created_at.localeCompare(a.created_at);
        return b.updated_at.localeCompare(a.updated_at);
      });
  }, [investigations, search, statusFilter, sortBy]);

  const handleStatusChange = async (id: string, status: InvestigationStatus) => {
    try {
      await api.updateInvestigation(id, { status });
      await refreshInvestigations();
      if (id === activeId) await refreshActiveDetail();
      showNotice('success', `Investigation ${id} status updated to ${status}.`);
    } catch (e: any) {
      showNotice('error', e?.message || 'Status update failed.');
    }
  };

  const handleDelete = async (id: string) => {
    setDeleting(true);
    try {
      await api.deleteInvestigation(id);
      setConfirmDeleteId(null);
      await refreshInvestigations(id === activeId ? null : activeId);
      showNotice('info', `Investigation ${id} and its stored files were permanently removed.`);
    } catch (e: any) {
      showNotice('error', e?.message || 'Failed to delete investigation.');
    } finally {
      setDeleting(false);
    }
  };

  const openInvestigation = async (id: string) => {
    setActiveId(id);
    await refreshActiveDetail();
    setPage('cross-modal');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        kicker="Case Archive"
        title="Investigation History"
        description="Browse, filter, update workflow status, open, or purge stored investigations from local SQLite storage."
        actions={
          <button
            type="button"
            onClick={() => setPage('new-investigation')}
            className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-1.5"
          >
            <FolderPlus className="w-3.5 h-3.5" strokeWidth={2} />
            New Investigation
          </button>
        }
      />

      {/* Search, Filter & Sort Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#2B2D32] bg-[#1B1D21] px-4 py-3">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <Search
            className="w-3.5 h-3.5 text-[#6C6F77] absolute left-3 top-1/2 -translate-y-1/2"
            strokeWidth={1.75}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by Case ID, title, or description..."
            className="w-full rounded bg-[#131417] border border-[#2B2D32] pl-8 pr-3 py-1.5 text-xs text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-0.5 rounded bg-[#131417] p-0.5 border border-[#2B2D32]">
            {(['ALL', 'OPEN', 'IN_PROGRESS', 'REVIEWED', 'CLOSED'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`whitespace-nowrap px-2.5 py-1 rounded-sm text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? 'bg-[#262930] text-[#F4F3EF]'
                    : 'text-[#92949B] hover:text-[#F4F3EF]'
                }`}
              >
                {s === 'ALL' ? 'All' : s.replace(/_/g, ' ')}
              </button>
            ))}
          </div>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="rounded bg-[#131417] border border-[#2B2D32] px-3 py-1.5 text-xs font-mono text-[#F4F3EF]"
          >
            <option value="updated">Sort: Last Updated</option>
            <option value="created">Sort: Created Date</option>
            <option value="title">Sort: Title A-Z</option>
          </select>
        </div>
      </div>

      {/* Cases Table */}
      <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-[#2B2D32] text-xs font-mono text-[#92949B]">
              <th className="py-3 px-4 font-medium">Case ID / Title</th>
              <th className="py-3 px-3 font-medium text-right">Evidence</th>
              <th className="py-3 px-3 font-medium text-right">Reviewed</th>
              <th className="py-3 px-3 font-medium text-right">Links</th>
              <th className="py-3 px-3 font-medium">Updated</th>
              <th className="py-3 px-3 font-medium">Status</th>
              <th className="py-3 px-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2B2D32] text-sm">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 px-4 text-[#92949B]">
                  No investigations match your current filter.
                </td>
              </tr>
            ) : (
              filtered.map((inv) => (
                <tr key={inv.id} className="hover:bg-[#202328] transition-colors">
                  <td className="py-3.5 px-4">
                    <div className="text-[11px] font-mono text-[#92949B]">
                      {inv.id}
                      {inv.case_type === 'DEMONSTRATION' && (
                        <span className="text-[#D9A441] ml-2">· Demonstration</span>
                      )}
                      {inv.id === activeId && (
                        <span className="text-[#52A378] ml-2">· Active</span>
                      )}
                    </div>
                    <div className="font-medium text-[#F4F3EF]">{inv.title}</div>
                    {inv.description && (
                      <div className="text-xs text-[#92949B] truncate max-w-md mt-0.5">
                        {inv.description}
                      </div>
                    )}
                  </td>
                  <td className="py-3.5 px-3 text-right font-mono text-xs text-[#D4D6DC] tabular-nums">
                    {inv.evidence_count ?? 0}
                  </td>
                  <td className="py-3.5 px-3 text-right font-mono text-xs text-[#D4D6DC] tabular-nums">
                    {inv.reviewed_count ?? 0}/{inv.finding_count ?? 0}
                  </td>
                  <td className="py-3.5 px-3 text-right font-mono text-xs text-[#D9A441] tabular-nums">
                    {inv.relationship_count ?? 0}
                  </td>
                  <td className="py-3.5 px-3 font-mono text-xs text-[#92949B] whitespace-nowrap tabular-nums">
                    {formatTimestamp(inv.updated_at)}
                  </td>
                  <td className="py-3.5 px-3">
                    <select
                      value={inv.status}
                      onChange={(e) =>
                        handleStatusChange(inv.id, e.target.value as InvestigationStatus)
                      }
                      className="rounded bg-[#131417] border border-[#2B2D32] px-2 py-1 text-xs font-mono text-[#F4F3EF]"
                    >
                      <option value="OPEN">OPEN</option>
                      <option value="IN_PROGRESS">IN_PROGRESS</option>
                      <option value="REVIEWED">REVIEWED</option>
                      <option value="CLOSED">CLOSED</option>
                    </select>
                  </td>
                  <td className="py-3.5 px-4 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => openInvestigation(inv.id)}
                        className="text-xs font-medium text-[#D9A441] hover:underline inline-flex items-center gap-1"
                      >
                        Open
                        <ArrowRight className="w-3 h-3" strokeWidth={1.75} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(inv.id)}
                        className="text-[#C95F5F] hover:text-[#E69494] p-1 transition-colors"
                        title="Delete investigation"
                      >
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {confirmDeleteId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
            onClick={() => !deleting && setConfirmDeleteId(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              onClick={(e) => e.stopPropagation()}
              className="rounded-md bg-[#1B1D21] border border-[#32353C] max-w-md w-full p-6 space-y-4 shadow-2xl"
            >
              <h3 className="text-base font-semibold text-[#F4F3EF]">
                Delete Investigation {confirmDeleteId}?
              </h3>
              <p className="text-sm text-[#92949B] leading-relaxed">
                This permanently removes the investigation record, all uploaded original evidence
                files, derived artifacts, findings, cross-modal relationships, and generated PDF
                reports from local storage.
              </p>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => setConfirmDeleteId(null)}
                  className="px-4 py-2 rounded text-xs font-medium border border-[#2B2D32] text-[#D4D6DC] hover:text-[#F4F3EF]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={deleting}
                  onClick={() => handleDelete(confirmDeleteId)}
                  className="px-4 py-2 rounded text-xs font-semibold bg-[#B84548] text-[#F4F3EF] hover:bg-[#C95154] disabled:opacity-50 transition-colors"
                >
                  {deleting ? 'Deleting...' : 'Delete Permanently'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

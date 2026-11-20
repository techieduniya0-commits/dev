import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Cpu,
  FileText,
  Fingerprint,
  GitFork,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { api, formatBytes, formatTimestamp } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import {
  CopyHashButton,
  EmptyWorkspaceState,
  PageHeader,
  SkeletonRows,
} from '../components/ForensicPrimitives';
import type { AuditEvent, IntegrityCheckResult } from '../types/forensics';

function getEventIcon(eventType: string) {
  const t = eventType.toUpperCase();
  if (t.includes('UPLOAD')) return Upload;
  if (t.includes('HASH') || t.includes('INTEGRITY')) return Fingerprint;
  if (t.includes('REVIEW')) return CheckCircle2;
  if (t.includes('CORRELAT')) return GitFork;
  if (t.includes('REPORT')) return FileText;
  if (t.includes('ANALY')) return Cpu;
  return Activity;
}

function getEventColor(eventType: string): string {
  const t = eventType.toUpperCase();
  if (t.includes('FAILED') || t.includes('MISMATCH') || t.includes('DELETED')) {
    return 'text-[#C95F5F]';
  }
  if (t.includes('VERIFIED') || t.includes('REVIEWED') || t.includes('COMPLETED')) {
    return 'text-[#52A378]';
  }
  if (t.includes('CORRELAT') || t.includes('REPORT')) {
    return 'text-[#6491C7]';
  }
  return 'text-[#D9A441]';
}

export const TimelinePage: React.FC = () => {
  const { activeDetail, activeId, setPage, showNotice } = useInvestigation();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [eventFilter, setEventFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, IntegrityCheckResult>>({});

  const loadTimeline = useCallback(async () => {
    if (!activeId) return;
    setLoading(true);
    try {
      const rows = await api.getTimeline(activeId);
      setEvents(rows);
    } catch (e: any) {
      showNotice('error', e?.message || 'Failed to load audit timeline.');
    } finally {
      setLoading(false);
    }
  }, [activeId, showNotice]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  const handleVerifyHash = async (evidenceId: string) => {
    setVerifyingId(evidenceId);
    try {
      const res = await api.verifyEvidenceIntegrity(evidenceId);
      setChecks((prev) => ({ ...prev, [evidenceId]: res }));
      await loadTimeline();
      showNotice(
        res.matches ? 'success' : 'error',
        res.matches
          ? `SHA-256 byte-integrity verified for ${res.original_filename}.`
          : `SHA-256 mismatch detected for ${res.original_filename}!`
      );
    } catch (e: any) {
      showNotice('error', e?.message || 'Integrity verification failed.');
    } finally {
      setVerifyingId(null);
    }
  };

  if (!activeId || !activeDetail) {
    return (
      <EmptyWorkspaceState
        icon={Activity}
        title="Evidence Provenance Timeline"
        description="Select or create an investigation first to inspect its persisted chronological audit trail and SHA-256 integrity records."
        actionLabel="New Investigation"
        onAction={() => setPage('new-investigation')}
      />
    );
  }

  const eventTypes = ['ALL', ...Array.from(new Set(events.map((e) => e.event_type)))];
  const filteredEvents = events.filter((e) => {
    const matchesType = eventFilter === 'ALL' || e.event_type === eventFilter;
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      e.description.toLowerCase().includes(q) ||
      e.event_type.toLowerCase().includes(q) ||
      (e.evidence_id || '').toLowerCase().includes(q);
    return matchesType && matchesSearch;
  });

  return (
    <div className="space-y-8">
      <PageHeader
        kicker={`Provenance & Audit Log · ${activeDetail.investigation.id}`}
        title="Evidence Timeline"
        description="Chronological record of every upload, SHA-256 hash computation, forensic run, correlation pass, analyst review, and report generation."
        actions={
          <button
            type="button"
            onClick={loadTimeline}
            disabled={loading}
            className="whitespace-nowrap px-3.5 py-2 rounded text-xs font-medium border border-[#2B2D32] bg-[#1B1D21] text-[#F4F3EF] hover:border-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.75} />
            Refresh Log
          </button>
        }
      />

      {/* Cryptographic SHA-256 Integrity Verification Ledger */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
            Cryptographic SHA-256 Integrity Verification ({activeDetail.evidence.length} files)
          </h2>
          <span className="text-xs text-[#92949B]">
            Matching hashes confirm stored byte identity only — not original scene authenticity.
          </span>
        </div>

        {activeDetail.evidence.length === 0 ? (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] px-5 py-6 text-sm text-[#92949B]">
            No evidence files ingested into this investigation yet.
          </div>
        ) : (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
            {activeDetail.evidence.map((ev) => {
              const check = checks[ev.id];
              return (
                <div key={ev.id} className="p-4 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-[#F4F3EF] flex flex-wrap items-center gap-x-2">
                        <span>{ev.original_filename}</span>
                        <span className="font-mono text-xs text-[#92949B] tabular-nums">
                          {ev.id} · {ev.media_type.toUpperCase()} · {formatBytes(ev.file_size)}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#92949B] mt-1">
                        <span className="break-all">SHA-256: {ev.sha256_hash}</span>
                        <CopyHashButton value={ev.sha256_hash} />
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleVerifyHash(ev.id)}
                      disabled={verifyingId === ev.id}
                      className="whitespace-nowrap px-3.5 py-1.5 rounded text-xs font-medium border border-[#2B2D32] bg-[#151619] text-[#F4F3EF] hover:border-[#D9A441] hover:text-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.75} />
                      {verifyingId === ev.id ? 'Hashing Disk File...' : 'Re-Verify Hash'}
                    </button>
                  </div>

                  {check && (
                    <div
                      className={`p-3 rounded border text-xs font-mono space-y-1 ${
                        check.matches
                          ? 'border-[#2A4738] bg-[#15221B] text-[#7BC79E]'
                          : 'border-[#4D2C2F] bg-[#241819] text-[#E69494]'
                      }`}
                    >
                      <div className="flex items-center gap-2 font-sans font-semibold">
                        {check.matches ? (
                          <ShieldCheck className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                        ) : (
                          <ShieldAlert className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                        )}
                        <span>
                          {check.matches
                            ? 'Match Verified — Current disk bytes match ingestion hash'
                            : 'Integrity Mismatch — File changed or missing on disk'}
                        </span>
                      </div>
                      <div className="text-[#D4D6DC] break-all">
                        Rechecked SHA-256: {check.current_hash || 'FILE MISSING'}
                      </div>
                      <div className="text-[#92949B] tabular-nums">
                        Verified at: {formatTimestamp(check.verified_at)}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Vertical Chronological Forensic Event Stream */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
            Chronological Event Stream ({filteredEvents.length})
          </h2>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search
                className="w-3.5 h-3.5 text-[#6C6F77] absolute left-3 top-1/2 -translate-y-1/2"
                strokeWidth={1.75}
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search timeline..."
                className="rounded bg-[#1B1D21] border border-[#2B2D32] pl-8 pr-3 py-1.5 text-xs text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441]"
              />
            </div>

            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              className="rounded bg-[#1B1D21] border border-[#2B2D32] px-3 py-1.5 text-xs font-mono text-[#F4F3EF]"
            >
              {eventTypes.map((et) => (
                <option key={et} value={et}>
                  {et === 'ALL' ? 'All Event Types' : et}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading ? (
          <SkeletonRows rows={5} />
        ) : filteredEvents.length === 0 ? (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] px-5 py-8 text-sm text-[#92949B]">
            No audit events match the current filter.
          </div>
        ) : (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5">
            <ol className="relative border-l border-[#2B2D32] ml-3 space-y-5">
              {filteredEvents.map((evt) => {
                const Icon = getEventIcon(evt.event_type);
                const colorClass = getEventColor(evt.event_type);
                return (
                  <li key={evt.id} className="pl-6 relative">
                    <span className="absolute -left-[13px] top-0.5 w-6 h-6 rounded bg-[#151619] border border-[#2B2D32] flex items-center justify-center">
                      <Icon className={`w-3.5 h-3.5 ${colorClass}`} strokeWidth={1.75} />
                    </span>

                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs font-mono">
                        <span className={`font-medium ${colorClass}`}>
                          {evt.event_type.replace(/_/g, ' ')}
                        </span>
                        <span className="text-[#40434B]">·</span>
                        <span className="text-[#92949B] tabular-nums">
                          {formatTimestamp(evt.timestamp)}
                        </span>
                        <span className="text-[#40434B]">·</span>
                        <span className="text-[#B8BAC0]">{evt.evidence_id || 'CASE'}</span>
                      </div>
                      <p className="text-sm text-[#E2E3E6] leading-relaxed">{evt.description}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </section>
    </div>
  );
};

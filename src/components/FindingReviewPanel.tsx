import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown, HelpCircle, MessageSquare, RotateCcw, X } from 'lucide-react';
import type { Finding, ReviewStatus } from '../types/forensics';
import { api, formatTimestamp } from '../api/client';

interface FindingReviewListProps {
  findings: Finding[];
  onReviewed: () => void;
  emptyMessage?: string;
  highlightedFindingId?: string | null;
}

const STRENGTH_COLOR: Record<string, string> = {
  STRONG: 'text-[#52A378]',
  MODERATE: 'text-[#D9A441]',
  LOW: 'text-[#92949B]',
};

const REVIEW_COLOR: Record<string, string> = {
  PENDING: 'text-[#92949B]',
  ACCEPTED: 'text-[#52A378]',
  REJECTED: 'text-[#C95F5F]',
  INCONCLUSIVE: 'text-[#D9A441]',
  FURTHER_REVIEW: 'text-[#6491C7]',
};

const CATEGORY_LABEL: Record<string, string> = {
  DETERMINISTIC: 'Deterministic Observation',
  STATISTICAL_HEURISTIC: 'Statistical / Heuristic',
  MODEL_BASED: 'Model-Based Output',
  HUMAN_REVIEWED: 'Human Conclusion',
};

export const FindingReviewList: React.FC<FindingReviewListProps> = ({
  findings,
  onReviewed,
  emptyMessage = 'No forensic observations recorded yet for this view.',
  highlightedFindingId = null,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleDecision = async (finding: Finding, decision: ReviewStatus) => {
    setSavingId(finding.id);
    setErrorMsg(null);
    try {
      const notes =
        draftNotes[finding.id] !== undefined
          ? draftNotes[finding.id]
          : finding.latest_review?.reviewer_notes || '';
      await api.reviewFinding(finding.id, decision, notes);
      onReviewed();
    } catch (e: any) {
      setErrorMsg(e?.message || 'Failed to record review decision.');
    } finally {
      setSavingId(null);
    }
  };

  if (findings.length === 0) {
    return (
      <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] px-5 py-8 text-sm text-[#92949B]">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
      {errorMsg && (
        <div className="px-5 py-3 text-xs text-[#E69494] bg-[#241819] border-b border-[#4D2C2F]">
          {errorMsg}
        </div>
      )}

      {findings.map((f) => {
        const isHighlighted = highlightedFindingId === f.id;
        const isOpen = expandedId === f.id || isHighlighted;
        const currentNote =
          draftNotes[f.id] !== undefined
            ? draftNotes[f.id]
            : f.latest_review?.reviewer_notes || '';

        return (
          <div
            key={f.id}
            id={`finding-${f.id}`}
            className={`px-5 py-4 transition-colors ${
              isHighlighted ? 'bg-[#221F18]' : 'hover:bg-[#202328]'
            }`}
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-mono">
                  <span className="text-[#92949B]">{f.id}</span>
                  {f.analysis_layer && (
                    <>
                      <span className="text-[#40434B]">·</span>
                      <span className="text-[#D9A441]">{f.analysis_layer.replace(/_/g, ' ')}</span>
                    </>
                  )}
                  <span className="text-[#40434B]">·</span>
                  <span className="text-[#C9CBD1]">
                    {CATEGORY_LABEL[f.analysis_category] || f.analysis_category}
                  </span>
                  <span className="text-[#40434B]">·</span>
                  <span className={STRENGTH_COLOR[f.evidence_strength] || 'text-[#92949B]'}>
                    Strength: {f.evidence_strength}
                  </span>
                  {f.uncertainty && f.uncertainty !== 'NONE' && (
                    <>
                      <span className="text-[#40434B]">·</span>
                      <span className="text-[#D9A441]">{f.uncertainty.replace(/_/g, ' ')}</span>
                    </>
                  )}
                  <span className="text-[#40434B]">·</span>
                  <span className={REVIEW_COLOR[f.review_status] || 'text-[#92949B]'}>
                    Review: {f.review_status.replace(/_/g, ' ')}
                  </span>
                </div>

                <h4 className="text-[15px] font-medium text-[#F4F3EF] leading-snug">{f.title}</h4>

                <p className="text-sm text-[#B8BAC0] leading-relaxed">{f.description}</p>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-[#6C6F77] font-mono">
                  <span>Ref: {f.evidence_reference}</span>
                  <span className="text-[#3E4149]">/</span>
                  <span>Region: {f.timestamp_or_region}</span>
                  {f.frame_reference && (
                    <>
                      <span className="text-[#3E4149]">/</span>
                      <span>Frame: {f.frame_reference}</span>
                    </>
                  )}
                  {f.model_confidence && (
                    <>
                      <span className="text-[#3E4149]">/</span>
                      <span>
                        Model ({f.calibration_status || 'UNCALIBRATED'}): {f.model_confidence}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={() => setExpandedId(isOpen ? null : f.id)}
                className="shrink-0 whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium border border-[#2B2D32] bg-[#151619] text-[#E2E3E6] hover:border-[#D9A441] hover:text-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5"
              >
                <MessageSquare className="w-3.5 h-3.5" strokeWidth={1.75} />
                <span>{isOpen ? 'Close' : 'Review'}</span>
                <ChevronDown
                  className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`}
                  strokeWidth={1.75}
                />
              </button>
            </div>

            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                  className="mt-4 pt-4 border-t border-[#2B2D32] grid grid-cols-1 lg:grid-cols-2 gap-6"
                >
                  {/* Automated Context & Alternative Explanations */}
                  <div className="space-y-3 text-xs">
                    <div>
                      <div className="text-[#92949B] font-medium mb-1">
                        Alternative Explanations
                      </div>
                      <p className="text-[#D4D6DC] leading-relaxed">
                        {f.alternative_explanation || 'None documented.'}
                      </p>
                    </div>
                    <div>
                      <div className="text-[#92949B] font-medium mb-1">
                        Methodological Limitations
                      </div>
                      <p className="text-[#B8BAC0] leading-relaxed">
                        {f.limitations || 'Standard module constraints apply.'}
                      </p>
                    </div>
                    {f.latest_review && (
                      <div className="pt-2.5 border-t border-[#2B2D32]">
                        <div className="text-[#92949B] font-medium mb-1">
                          Recorded Human Conclusion ({formatTimestamp(f.latest_review.reviewed_at)})
                        </div>
                        <p className="text-[#F4F3EF]">
                          Decision:{' '}
                          <span
                            className={`font-mono ${REVIEW_COLOR[f.latest_review.reviewer_decision]}`}
                          >
                            {f.latest_review.reviewer_decision}
                          </span>
                        </p>
                        {f.latest_review.reviewer_notes && (
                          <p className="text-[#B8BAC0] mt-1">{f.latest_review.reviewer_notes}</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Human Review Action Panel */}
                  <div className="space-y-3">
                    <div>
                      <label
                        htmlFor={`note-${f.id}`}
                        className="block text-xs font-medium text-[#92949B] mb-1.5"
                      >
                        Investigator Review Notes (stored separately from automated findings)
                      </label>
                      <textarea
                        id={`note-${f.id}`}
                        rows={3}
                        value={currentNote}
                        onChange={(e) =>
                          setDraftNotes((prev) => ({ ...prev, [f.id]: e.target.value }))
                        }
                        placeholder="Document contextual verification, source corroboration, or rationale..."
                        className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-xs text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441] transition-colors"
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={savingId === f.id}
                        onClick={() => handleDecision(f, 'ACCEPTED')}
                        className="whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium border border-[#2A4738] bg-[#15221B] text-[#7BC79E] hover:bg-[#1B2C23] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Check className="w-3.5 h-3.5" strokeWidth={1.75} />
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={savingId === f.id}
                        onClick={() => handleDecision(f, 'REJECTED')}
                        className="whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium border border-[#4D2C2F] bg-[#241819] text-[#E69494] hover:bg-[#301E20] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <X className="w-3.5 h-3.5" strokeWidth={1.75} />
                        Reject
                      </button>
                      <button
                        type="button"
                        disabled={savingId === f.id}
                        onClick={() => handleDecision(f, 'INCONCLUSIVE')}
                        className="whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium border border-[#4F3E1E] bg-[#231D12] text-[#D9A441] hover:bg-[#2E2516] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <HelpCircle className="w-3.5 h-3.5" strokeWidth={1.75} />
                        Inconclusive
                      </button>
                      <button
                        type="button"
                        disabled={savingId === f.id}
                        onClick={() => handleDecision(f, 'FURTHER_REVIEW')}
                        className="whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium border border-[#2A3D54] bg-[#161F2A] text-[#7BAEE8] hover:bg-[#1C2836] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" strokeWidth={1.75} />
                        Request Review
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
};

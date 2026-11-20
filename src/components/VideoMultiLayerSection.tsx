import React, { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  Layers,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import type {
  Finding,
  FinalVideoAssessment,
  LayerProcessingStatus,
  VideoLayerResult,
  VideoTimelineMarker,
} from '../types/forensics';

interface LiveLayerState {
  layer_number: number;
  layer_id: string;
  layer_name: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'UNAVAILABLE' | 'FAILED' | 'REQUIRES_REVIEW';
}

interface VideoMultiLayerSectionProps {
  durationSec: number;
  layers: VideoLayerResult[];
  timelineMarkers: VideoTimelineMarker[];
  finalAssessment: FinalVideoAssessment | null;
  findings: Finding[];
  liveProgress: LiveLayerState[] | null;
  isProcessing: boolean;
  onSeekTimestamp: (sec: number, frameIdx?: number | null, findingId?: string | null) => void;
  onSelectOverlay?: (url: string, caption: string) => void;
}

const LAYER_STATUS_COLOR: Record<string, string> = {
  COMPLETED: 'text-[#52A378]',
  PROCESSING: 'text-[#D9A441]',
  PENDING: 'text-[#6C6F77]',
  UNAVAILABLE: 'text-[#6C6F77]',
  FAILED: 'text-[#C95F5F]',
  REQUIRES_REVIEW: 'text-[#D9A441]',
};

const MARKER_COLOR: Record<VideoTimelineMarker['marker_type'], string> = {
  FACIAL: '#D9A441',
  LIP_SYNC: '#C95F5F',
  TEMPORAL: '#D9822B',
  MOTION: '#6491C7',
  MODEL: '#A68BD4',
  METADATA: '#52A378',
};

const MARKER_LABEL: Record<VideoTimelineMarker['marker_type'], string> = {
  FACIAL: 'Facial',
  LIP_SYNC: 'Lip-Sync',
  TEMPORAL: 'Temporal',
  MOTION: 'Motion',
  MODEL: 'Model',
  METADATA: 'Metadata',
};

const OUTCOME_STYLE: Record<string, { color: string; icon: 'check' | 'alert' | 'question' }> = {
  'NO SIGNIFICANT INDICATORS DETECTED': { color: 'text-[#52A378]', icon: 'check' },
  'POTENTIAL CONVENTIONAL EDITING INDICATORS': { color: 'text-[#6491C7]', icon: 'question' },
  'POTENTIAL AI-MANIPULATION INDICATORS': { color: 'text-[#C95F5F]', icon: 'alert' },
  'POTENTIAL AI-GENERATED CONTENT INDICATORS': { color: 'text-[#C95F5F]', icon: 'alert' },
  'MULTIPLE INCONSISTENCIES REQUIRE REVIEW': { color: 'text-[#D9A441]', icon: 'alert' },
  INCONCLUSIVE: { color: 'text-[#D9A441]', icon: 'question' },
};

export const VideoMultiLayerSection: React.FC<VideoMultiLayerSectionProps> = ({
  durationSec,
  layers,
  timelineMarkers,
  finalAssessment,
  findings,
  liveProgress,
  isProcessing,
  onSeekTimestamp,
  onSelectOverlay,
}) => {
  const [expandedLayer, setExpandedLayer] = useState<string | null>(null);
  const [markerFilter, setMarkerFilter] = useState<'ALL' | VideoTimelineMarker['marker_type']>('ALL');
  const [selectedMarker, setSelectedMarker] = useState<VideoTimelineMarker | null>(null);

  const findingById = new Map(findings.map((f) => [f.id, f]));

  const filteredMarkers = timelineMarkers.filter(
    (m) => markerFilter === 'ALL' || m.marker_type === markerFilter
  );

  const getLayerHumanReviewSummary = (layer: VideoLayerResult): string => {
    const linked = layer.finding_ids
      .map((id) => findingById.get(id))
      .filter((f): f is Finding => Boolean(f));
    if (linked.length === 0) return 'No findings';
    const reviewed = linked.filter((f) => f.review_status !== 'PENDING');
    if (reviewed.length === 0) return 'Pending review';
    return reviewed.map((f) => f.review_status.replace(/_/g, ' ')).join(', ');
  };

  const outcomeMeta = finalAssessment
    ? OUTCOME_STYLE[finalAssessment.outcome] || { color: 'text-[#D9A441]', icon: 'question' }
    : null;

  const completedLiveCount = liveProgress
    ? liveProgress.filter((l) => l.status !== 'PENDING' && l.status !== 'PROCESSING').length
    : 0;

  return (
    <div className="space-y-6">
      {/* Live Asynchronous Multi-Layer Progress Panel (only shown during actual backend run) */}
      <AnimatePresence>
        {isProcessing && liveProgress && liveProgress.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.16 }}
            className="rounded-md border border-[#4F3E1E] bg-[#1E1A13] p-4 space-y-3"
          >
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-[#D9A441] inline-flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                Executing 8-layer video authenticity pipeline
              </span>
              <span className="font-mono text-[#92949B] tabular-nums">
                {completedLiveCount}/8 layers finished
              </span>
            </div>
            <div className="h-1 rounded-sm bg-[#111214] overflow-hidden">
              <motion.div
                className="h-full bg-[#D9A441]"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: Math.max(0.08, completedLiveCount / 8) }}
                transition={{ duration: 0.25 }}
                style={{ transformOrigin: 'left center' }}
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-mono">
              {liveProgress.map((lp) => (
                <div
                  key={lp.layer_id}
                  className="px-3 py-2 rounded bg-[#131417] border border-[#2B2D32] flex items-center justify-between gap-2"
                >
                  <span className="text-[#D4D6DC] truncate">Layer {lp.layer_number}</span>
                  <span className={LAYER_STATUS_COLOR[lp.status] || 'text-[#92949B]'}>
                    {lp.status.replace(/_/g, ' ')}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Final Authenticity Assessment */}
      {finalAssessment && outcomeMeta && (
        <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[#2B2D32]">
            <div className="space-y-1.5 min-w-0 flex-1">
              <div className="text-xs text-[#92949B]">
                Final Authenticity Assessment · Evidence-based synthesis
              </div>
              <div className={`text-base font-semibold flex items-center gap-2 ${outcomeMeta.color}`}>
                {outcomeMeta.icon === 'check' && <ShieldCheck className="w-5 h-5 shrink-0" strokeWidth={1.75} />}
                {outcomeMeta.icon === 'alert' && <ShieldAlert className="w-5 h-5 shrink-0" strokeWidth={1.75} />}
                {outcomeMeta.icon === 'question' && (
                  <ShieldQuestion className="w-5 h-5 shrink-0" strokeWidth={1.75} />
                )}
                <span>{finalAssessment.outcome}</span>
              </div>
              <p className="text-sm text-[#D4D6DC] max-w-3xl leading-relaxed">
                {finalAssessment.summary}
              </p>
            </div>
            <div className="text-xs font-mono text-[#92949B] text-right tabular-nums space-y-0.5 shrink-0">
              <div>Supporting: {finalAssessment.supporting_findings.length}</div>
              <div>Uncertain: {finalAssessment.uncertain_findings.length}</div>
              <div>Unavailable layers: {finalAssessment.unavailable_layers.length}</div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
            <div className="rounded bg-[#131417] border border-[#2B2D32] p-3.5 space-y-2">
              <div className="font-medium text-[#D9A441]">
                Supporting Observations ({finalAssessment.supporting_findings.length})
              </div>
              {finalAssessment.supporting_findings.length === 0 ? (
                <div className="text-[#92949B]">
                  No elevated manipulation or editing indicators triggered.
                </div>
              ) : (
                <ul className="space-y-1.5 text-[#D4D6DC]">
                  {finalAssessment.supporting_findings.map((sf) => {
                    const fObj = findingById.get(sf.finding_id);
                    return (
                      <li key={sf.finding_id} className="leading-snug">
                        <button
                          type="button"
                          onClick={() =>
                            onSeekTimestamp(fObj?.start_timestamp ?? 0, null, sf.finding_id)
                          }
                          className="text-left hover:text-[#D9A441] transition-colors"
                        >
                          <span className="font-mono text-[#92949B]">{sf.finding_id}</span> ·{' '}
                          {sf.title}{' '}
                          <span className="font-mono text-[#6C6F77]">({sf.strength})</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="rounded bg-[#131417] border border-[#2B2D32] p-3.5 space-y-2">
              <div className="font-medium text-[#6491C7]">
                Uncertain / Context-Limited ({finalAssessment.uncertain_findings.length})
              </div>
              {finalAssessment.uncertain_findings.length === 0 ? (
                <div className="text-[#92949B]">None recorded.</div>
              ) : (
                <ul className="space-y-1.5 text-[#C9CBD1]">
                  {finalAssessment.uncertain_findings.slice(0, 5).map((uf) => (
                    <li key={uf.finding_id} className="leading-snug">
                      <span className="font-mono text-[#92949B]">{uf.reason}</span> · {uf.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded bg-[#131417] border border-[#2B2D32] p-3.5 space-y-2">
              <div className="font-medium text-[#92949B]">
                Unavailable Layers ({finalAssessment.unavailable_layers.length})
              </div>
              {finalAssessment.unavailable_layers.length === 0 ? (
                <div className="text-[#52A378]">All 8 layers executed.</div>
              ) : (
                <ul className="space-y-1.5 text-[#92949B]">
                  {finalAssessment.unavailable_layers.map((u, idx) => (
                    <li key={idx}>{u}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="text-xs text-[#92949B] pt-1 leading-relaxed">
            {finalAssessment.methodology_notice}
          </div>
        </div>
      )}

      {/* Interactive Forensic Analysis Timeline */}
      <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[#F4F3EF]">
              Forensic Segment Timeline ({filteredMarkers.length} marker
              {filteredMarkers.length === 1 ? '' : 's'})
            </h2>
            <p className="text-xs text-[#92949B] mt-0.5">
              Click any marker to seek the video player and highlight its corresponding finding.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-0.5 rounded bg-[#131417] p-0.5 border border-[#2B2D32]">
            {(['ALL', 'FACIAL', 'LIP_SYNC', 'TEMPORAL', 'MOTION', 'MODEL', 'METADATA'] as const).map(
              (t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setMarkerFilter(t)}
                  className={`whitespace-nowrap px-2.5 py-1 rounded-sm text-[11px] font-medium transition-colors ${
                    markerFilter === t
                      ? 'bg-[#262930] text-[#F4F3EF]'
                      : 'text-[#92949B] hover:text-[#F4F3EF]'
                  }`}
                >
                  {t === 'ALL' ? 'All' : MARKER_LABEL[t]}
                </button>
              )
            )}
          </div>
        </div>

        {/* Visual Timeline Track */}
        <div className="space-y-2">
          <div className="relative h-12 rounded bg-[#111214] border border-[#2B2D32] px-3.5 flex items-center">
            <div className="w-full h-1 bg-[#2B2D32] rounded-full relative">
              {filteredMarkers.map((m) => {
                const pct =
                  durationSec > 0
                    ? Math.min(98, Math.max(1, (m.timestamp_sec / durationSec) * 100))
                    : 2;
                const color = MARKER_COLOR[m.marker_type] || '#D9A441';
                const isSel = selectedMarker?.id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    title={`${m.timestamp_formatted} — ${m.title}`}
                    onClick={() => {
                      setSelectedMarker(m);
                      onSeekTimestamp(m.timestamp_sec, m.frame_index ?? null, m.finding_id ?? null);
                    }}
                    style={{
                      left: `${pct}%`,
                      backgroundColor: color,
                      transform: isSel
                        ? 'translate(-50%, -50%) scale(1.3)'
                        : 'translate(-50%, -50%)',
                    }}
                    className="absolute top-1/2 w-2.5 h-6 rounded-[2px] cursor-pointer transition-transform border border-[#111214] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#F4F3EF]"
                  />
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 text-[11px] font-mono text-[#6C6F77] tabular-nums">
            <span>00:00.00</span>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {(['FACIAL', 'LIP_SYNC', 'TEMPORAL', 'MOTION', 'MODEL', 'METADATA'] as const).map(
                (t) => (
                  <span key={t} className="inline-flex items-center gap-1.5 font-sans text-[#92949B]">
                    <span
                      className="w-2 h-2 rounded-[1px] inline-block"
                      style={{ backgroundColor: MARKER_COLOR[t] }}
                    />
                    <span>{MARKER_LABEL[t]}</span>
                  </span>
                )
              )}
            </div>
            <span>{durationSec > 0 ? `${durationSec.toFixed(2)}s` : '—'}</span>
          </div>
        </div>

        {/* Selected Marker Detail Box */}
        <AnimatePresence mode="wait">
          {selectedMarker ? (
            <motion.div
              key={selectedMarker.id}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              className="rounded bg-[#131417] border border-[#32353C] p-3.5 flex flex-wrap items-start justify-between gap-4 text-xs"
            >
              <div className="space-y-1 min-w-0 flex-1">
                <div className="font-mono flex flex-wrap items-center gap-x-2">
                  <span style={{ color: MARKER_COLOR[selectedMarker.marker_type] }}>
                    {MARKER_LABEL[selectedMarker.marker_type]}
                  </span>
                  <span className="text-[#40434B]">·</span>
                  <span className="text-[#F4F3EF] tabular-nums">
                    {selectedMarker.timestamp_formatted}
                  </span>
                  <span className="text-[#40434B]">·</span>
                  <span className="text-[#92949B]">{selectedMarker.layer_id}</span>
                  {selectedMarker.finding_id && (
                    <>
                      <span className="text-[#40434B]">·</span>
                      <span className="text-[#D9A441]">{selectedMarker.finding_id}</span>
                    </>
                  )}
                </div>
                <div className="text-sm font-medium text-[#F4F3EF]">{selectedMarker.title}</div>
                <p className="text-[#B8BAC0] leading-relaxed">{selectedMarker.detail}</p>
              </div>
              <button
                type="button"
                onClick={() =>
                  onSeekTimestamp(
                    selectedMarker.timestamp_sec,
                    selectedMarker.frame_index ?? null,
                    selectedMarker.finding_id ?? null
                  )
                }
                className="whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium border border-[#2B2D32] bg-[#1B1D21] text-[#D9A441] hover:border-[#D9A441] active:scale-[0.985] transition-all"
              >
                Jump to Segment
              </button>
            </motion.div>
          ) : filteredMarkers.length === 0 ? (
            <div className="text-xs text-[#92949B]">
              No timestamped markers recorded for this filter.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {filteredMarkers.slice(0, 10).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setSelectedMarker(m);
                    onSeekTimestamp(m.timestamp_sec, m.frame_index ?? null, m.finding_id ?? null);
                  }}
                  className="whitespace-nowrap px-2.5 py-1.5 rounded text-xs font-mono bg-[#131417] border border-[#2B2D32] hover:border-[#D9A441] transition-colors flex items-center gap-2"
                >
                  <span
                    className="w-1.5 h-3 rounded-[1px] inline-block"
                    style={{ backgroundColor: MARKER_COLOR[m.marker_type] }}
                  />
                  <span className="text-[#F4F3EF] tabular-nums">{m.timestamp_formatted}</span>
                  <span className="font-sans text-[#92949B] truncate max-w-[180px]">{m.title}</span>
                </button>
              ))}
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Multi-Layer Authenticity Analysis (8 Forensic Layers) */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-[#D9A441]" strokeWidth={1.75} />
            <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
              Multi-Layer Authenticity Analysis (8 Forensic Layers)
            </h2>
          </div>
          <span className="text-xs text-[#92949B]">
            Each layer reports its actual execution status
          </span>
        </div>

        {layers.length === 0 ? (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-6 text-sm text-[#92949B]">
            Multi-layer authenticity analysis has not been executed for this video yet. Run the
            8-layer analysis above to execute all available forensic modules.
          </div>
        ) : (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
            {layers.map((layer) => {
              const isOpen = expandedLayer === layer.layer_id;
              const statusColor =
                LAYER_STATUS_COLOR[layer.status as LayerProcessingStatus] || 'text-[#92949B]';
              const reviewSummary = getLayerHumanReviewSummary(layer);

              return (
                <div key={layer.layer_id}>
                  <button
                    type="button"
                    onClick={() => setExpandedLayer(isOpen ? null : layer.layer_id)}
                    className="w-full text-left px-5 py-4 hover:bg-[#202328] transition-colors flex flex-wrap items-start justify-between gap-4"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-mono">
                        <span className="text-[#92949B]">L{layer.layer_number}</span>
                        <span className="text-[#40434B]">·</span>
                        <span className={`font-medium ${statusColor}`}>
                          {layer.status.replace(/_/g, ' ')}
                        </span>
                        <span className="text-[#40434B]">·</span>
                        <span className="text-[#C9CBD1]">Strength: {layer.evidence_strength}</span>
                        {layer.model_confidence && (
                          <>
                            <span className="text-[#40434B]">·</span>
                            <span className="text-[#D9A441]">
                              Model: {layer.model_confidence} ({layer.calibration_status})
                            </span>
                          </>
                        )}
                        <span className="text-[#40434B]">·</span>
                        <span className="text-[#92949B]">Review: {reviewSummary}</span>
                      </div>

                      <div className="text-sm font-semibold text-[#F4F3EF]">{layer.layer_name}</div>
                      <div className="text-xs text-[#B8BAC0] leading-relaxed">
                        {layer.actual_result}
                      </div>
                    </div>

                    <div className="flex items-center gap-2.5 shrink-0 text-xs text-[#92949B] pt-1">
                      {layer.overlay_url && (
                        <span className="text-[#D9A441] inline-flex items-center gap-1 font-mono text-[11px]">
                          <Eye className="w-3.5 h-3.5" strokeWidth={1.75} />
                          Overlay
                        </span>
                      )}
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4 text-[#92949B]" strokeWidth={1.75} />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-[#92949B]" strokeWidth={1.75} />
                      )}
                    </div>
                  </button>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="px-5 pb-5 pt-4 bg-[#151619] border-t border-[#2B2D32] grid grid-cols-1 lg:grid-cols-12 gap-5 text-xs"
                      >
                        <div
                          className={`${
                            layer.overlay_url ? 'lg:col-span-7' : 'lg:col-span-12'
                          } space-y-3.5`}
                        >
                          <div>
                            <div className="text-[#92949B] font-medium mb-1">
                              Method & Explanation
                            </div>
                            <p className="text-[#D4D6DC] leading-relaxed">{layer.explanation}</p>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <div className="text-[#92949B] font-medium mb-1">Limitations</div>
                              <p className="text-[#B8BAC0] leading-relaxed">{layer.limitations}</p>
                            </div>
                            <div>
                              <div className="text-[#92949B] font-medium mb-1">
                                Alternative Explanations
                              </div>
                              <p className="text-[#B8BAC0] leading-relaxed">
                                {layer.alternative_explanation}
                              </p>
                            </div>
                          </div>

                          {layer.relevant_timestamps.length > 0 && (
                            <div className="space-y-1.5">
                              <div className="text-[#92949B] font-medium">
                                Relevant Timestamps (click to seek)
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {layer.relevant_timestamps.map((ts, idx) => (
                                  <button
                                    key={idx}
                                    type="button"
                                    onClick={() =>
                                      onSeekTimestamp(
                                        ts.start_sec,
                                        null,
                                        layer.finding_ids[0] || null
                                      )
                                    }
                                    className="whitespace-nowrap px-2.5 py-1 rounded font-mono bg-[#1B1D21] border border-[#2B2D32] text-[#D9A441] hover:border-[#D9A441] inline-flex items-center gap-1 transition-colors"
                                  >
                                    <Clock className="w-3 h-3" strokeWidth={1.75} />
                                    {ts.label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-2.5 border-t border-[#2B2D32] font-mono text-[11px] text-[#6C6F77]">
                            <span>Refs: {layer.evidence_references.join(' / ')}</span>
                            {layer.finding_ids.length > 0 && (
                              <>
                                <span>·</span>
                                <span>Findings: {layer.finding_ids.join(', ')}</span>
                              </>
                            )}
                          </div>
                        </div>

                        {layer.overlay_url && (
                          <div className="lg:col-span-5 space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <span className="text-[#92949B] font-medium">
                                Visual Forensic Output
                              </span>
                              {onSelectOverlay && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    onSelectOverlay(
                                      layer.overlay_url!,
                                      layer.overlay_caption || layer.layer_name
                                    )
                                  }
                                  className="text-[#D9A441] hover:underline font-medium"
                                >
                                  Inspect Larger
                                </button>
                              )}
                            </div>
                            <div className="rounded bg-[#111214] border border-[#2B2D32] p-2">
                              <img
                                src={layer.overlay_url}
                                alt={layer.overlay_caption || layer.layer_name}
                                referrerPolicy="no-referrer"
                                className="w-full max-h-[220px] object-contain block"
                              />
                            </div>
                            {layer.overlay_caption && (
                              <p className="text-[11px] text-[#92949B] leading-relaxed">
                                {layer.overlay_caption}
                              </p>
                            )}
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

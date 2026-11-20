import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ChevronLeft,
  ChevronRight,
  Clock,
  Download,
  Eye,
  Film,
  Loader2,
  Play,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react';
import { api, formatBytes } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { FindingReviewList } from '../components/FindingReviewPanel';
import { VideoMultiLayerSection } from '../components/VideoMultiLayerSection';
import { AiPotentialMeter, computeModalityAiRating } from '../components/AiPotentialMeter';
import {
  CopyHashButton,
  EmptyWorkspaceState,
  PageHeader,
} from '../components/ForensicPrimitives';
import type {
  FinalVideoAssessment,
  VideoLayerResult,
  VideoTimelineMarker,
} from '../types/forensics';

export const VideoForensicsPage: React.FC = () => {
  const { activeDetail, activeId, setPage, refreshActiveDetail, showNotice } = useInvestigation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFrameIdx, setSelectedFrameIdx] = useState<number | null>(null);
  const [showFaceBox, setShowFaceBox] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [liveProgress, setLiveProgress] = useState<
    Array<{
      layer_number: number;
      layer_id: string;
      layer_name: string;
      status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'UNAVAILABLE' | 'FAILED' | 'REQUIRES_REVIEW';
    }> | null
  >(null);
  const [highlightedFindingId, setHighlightedFindingId] = useState<string | null>(null);
  const [layerFindingFilter, setLayerFindingFilter] = useState<string>('ALL');
  const [modalOverlay, setModalOverlay] = useState<{ url: string; caption: string } | null>(null);
  const [videoTime, setVideoTime] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const videoItems = (activeDetail?.evidence || []).filter((e) => e.media_type === 'video');

  useEffect(() => {
    if (videoItems.length === 0) {
      setSelectedId(null);
    } else if (!selectedId || !videoItems.some((v) => v.id === selectedId)) {
      setSelectedId(videoItems[0].id);
      setSelectedFrameIdx(null);
      setHighlightedFindingId(null);
    }
  }, [videoItems, selectedId]);

  const selected = videoItems.find((v) => v.id === selectedId) || null;
  const result = selected?.analysis?.result || null;

  const frames: Array<{
    index: number;
    timestamp_sec: number;
    timestamp_formatted: string;
    url: string;
    is_scene_change: boolean;
    face_detected?: boolean;
    face_bbox_norm?: { x: number; y: number; w: number; h: number } | null;
    mean_luma?: number;
    sharpness_laplacian?: number;
  }> = result?.frames || [];

  const sceneChanges: Array<{ timestamp_sec: number; timestamp_formatted: string }> =
    result?.scene_changes || [];

  const audioPeaks: number[] = result?.audio_waveform_peaks || [];
  const durationSec: number = result?.duration_sec || 0;

  const multiLayer = result?.multi_layer_analysis || null;
  const layers: VideoLayerResult[] = multiLayer?.layers || [];
  const timelineMarkers: VideoTimelineMarker[] = multiLayer?.timeline_markers || [];
  const finalAssessment: FinalVideoAssessment | null = multiLayer?.final_assessment || null;

  const inspectedFrame =
    selectedFrameIdx !== null ? frames.find((f) => f.index === selectedFrameIdx) || null : null;

  const allVideoFindings = (activeDetail?.findings || []).filter(
    (f) => f.evidence_id === selected?.id && f.module === 'VIDEO_FORENSICS'
  );

  const availableFindingLayers = [
    'ALL',
    ...Array.from(new Set(allVideoFindings.map((f) => f.analysis_layer || 'CORE').filter(Boolean))),
  ];

  const displayedFindings = allVideoFindings.filter((f) => {
    if (layerFindingFilter === 'ALL') return true;
    return (f.analysis_layer || 'CORE') === layerFindingFilter;
  });

  // Draw extracted audio track waveform synced with video playback time
  useEffect(() => {
    const canvas = waveCanvasRef.current;
    if (!canvas || audioPeaks.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#111214';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#2B2D32';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    const barW = w / audioPeaks.length;
    for (let i = 0; i < audioPeaks.length; i++) {
      const amp = Math.max(0.03, audioPeaks[i]);
      const bh = amp * (h * 0.82);
      const x = i * barW;
      const y = (h - bh) / 2;
      const played = durationSec > 0 && (i / audioPeaks.length) * durationSec <= videoTime;
      ctx.fillStyle = played ? '#D9A441' : '#4A4D56';
      ctx.fillRect(x, y, Math.max(1.4, barW - 1), bh);
    }

    if (durationSec > 0 && videoTime > 0) {
      const px = Math.min(w, (videoTime / durationSec) * w);
      ctx.strokeStyle = '#F4F3EF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }, [audioPeaks, durationSec, videoTime]);

  // Genuine async polling while 8-layer video analysis runs on backend
  useEffect(() => {
    if (!analyzing || !selected) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const st = await api.getVideoAnalysisStatus(selected.id);
        if (cancelled) return;
        if (st.layers && st.layers.length > 0) {
          setLiveProgress(st.layers);
        }
        if (st.overall_status === 'COMPLETED') {
          setAnalyzing(false);
          await refreshActiveDetail();
          showNotice(
            'success',
            `8-layer video authenticity analysis completed for ${selected.original_filename}.`
          );
        } else if (st.overall_status === 'FAILED') {
          setAnalyzing(false);
          await refreshActiveDetail();
          showNotice('error', st.error || 'Video analysis failed.');
        }
      } catch {
        // retry on next tick
      }
    };

    const timer = setInterval(poll, 700);
    poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [analyzing, selected, refreshActiveDetail, showNotice]);

  const seekVideoTo = (sec: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = Math.max(0, sec);
      videoRef.current.pause();
      setVideoTime(Math.max(0, sec));
    }
  };

  const handleTimelineSeek = (
    sec: number,
    frameIdx?: number | null,
    findingId?: string | null
  ) => {
    seekVideoTo(sec);
    if (frameIdx !== undefined && frameIdx !== null && frames.some((f) => f.index === frameIdx)) {
      setSelectedFrameIdx(frameIdx);
    } else if (frames.length > 0) {
      let nearest = frames[0];
      let bestDist = Math.abs(frames[0].timestamp_sec - sec);
      for (const f of frames) {
        const d = Math.abs(f.timestamp_sec - sec);
        if (d < bestDist) {
          bestDist = d;
          nearest = f;
        }
      }
      setSelectedFrameIdx(nearest.index);
    }
    if (findingId) {
      setLayerFindingFilter('ALL');
      setHighlightedFindingId(findingId);
    }
  };

  const handleRunMultiLayerAnalysis = async () => {
    if (!selected) return;
    setAnalyzing(true);
    setLiveProgress(null);
    try {
      await api.startAsyncVideoAnalysis(selected.id);
    } catch (e: any) {
      setAnalyzing(false);
      showNotice('error', e?.message || 'Failed to start multi-layer video analysis.');
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    try {
      await api.deleteEvidence(selected.id);
      await refreshActiveDetail();
      showNotice('info', `Deleted ${selected.original_filename}.`);
    } catch (e: any) {
      showNotice('error', e?.message || 'Delete failed.');
    }
  };

  const stepFrame = (delta: number) => {
    if (frames.length === 0) return;
    const currentPos =
      selectedFrameIdx !== null
        ? frames.findIndex((f) => f.index === selectedFrameIdx)
        : 0;
    const nextPos = Math.max(0, Math.min(frames.length - 1, currentPos + delta));
    const target = frames[nextPos];
    setSelectedFrameIdx(target.index);
    seekVideoTo(target.timestamp_sec);
  };

  if (!activeId || !activeDetail) {
    return (
      <EmptyWorkspaceState
        icon={Film}
        title="Video Forensics"
        description="Select or create an investigation first to inspect video streams, extracted frames, and multi-layer authenticity findings."
        actionLabel="New Investigation"
        onAction={() => setPage('new-investigation')}
      />
    );
  }

  const videoRating =
    finalAssessment?.ai_potential_rating || computeModalityAiRating(allVideoFindings);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={`Multi-Layer Video Authenticity Engine · ${activeDetail.investigation.id}`}
        title="Video Forensics"
        description="Codec & container profiling, frame-by-frame inspection, scene detection, and 8-layer AI vs. real authenticity analysis."
        actions={
          <button
            type="button"
            onClick={() => setPage('new-investigation')}
            className="whitespace-nowrap px-3.5 py-2 rounded text-xs font-medium border border-[#2B2D32] bg-[#1B1D21] text-[#F4F3EF] hover:border-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
            Upload Video Evidence
          </button>
        }
      />

      {videoItems.length === 0 ? (
        <EmptyWorkspaceState
          icon={Film}
          title="No video evidence uploaded to this investigation"
          description="Upload MP4, MOV, WebM, or MKV files to execute FFmpeg frame extraction, scene change detection, and the 8-layer authenticity pipeline."
          actionLabel="Add Video Files"
          onAction={() => setPage('new-investigation')}
        />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left selector */}
          <div className="xl:col-span-3 space-y-2.5">
            <div className="text-xs font-medium text-[#92949B] flex items-center justify-between">
              <span>Video Evidence</span>
              <span className="font-mono text-[11px] tabular-nums">{videoItems.length}</span>
            </div>
            <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
              {videoItems.map((item) => {
                const isSel = item.id === selected?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(item.id);
                      setSelectedFrameIdx(null);
                      setHighlightedFindingId(null);
                    }}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      isSel
                        ? 'bg-[#24272D] text-[#F4F3EF]'
                        : 'hover:bg-[#202328] text-[#B8BAC0]'
                    }`}
                  >
                    <div className="text-[11px] font-mono text-[#D9A441]">{item.id}</div>
                    <div className="text-sm font-medium truncate mt-0.5">
                      {item.original_filename}
                    </div>
                    <div className="text-[11px] font-mono text-[#92949B] mt-1 tabular-nums">
                      {formatBytes(item.file_size)} · {item.processing_status}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {selected && (
            <div className="xl:col-span-9 space-y-6">
              {/* Top Evidence Bar */}
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-4 flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 space-y-1 flex-1">
                  <div className="text-sm font-semibold text-[#F4F3EF] truncate">
                    {selected.original_filename}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-[#92949B]">
                    <span className="break-all">SHA-256: {selected.sha256_hash}</span>
                    <CopyHashButton value={selected.sha256_hash} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={handleRunMultiLayerAnalysis}
                    disabled={analyzing}
                    className="whitespace-nowrap px-3.5 py-1.5 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {analyzing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                    ) : (
                      <Play className="w-3.5 h-3.5" strokeWidth={2} />
                    )}
                    <span>{analyzing ? 'Running 8 Layers...' : 'Run 8-Layer Analysis'}</span>
                  </button>
                  <a
                    href={`/api/evidence/${selected.id}/download?download=1`}
                    className="whitespace-nowrap px-3 py-1.5 rounded text-xs font-medium border border-[#2B2D32] bg-[#151619] text-[#D8DAE0] hover:text-[#F4F3EF] hover:border-[#393C44] transition-colors flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" strokeWidth={1.75} />
                    Original
                  </a>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="px-2.5 py-1.5 rounded text-xs border border-[#4D2C2F] text-[#C95F5F] hover:bg-[#241819] transition-colors"
                    title="Delete video evidence"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              {/* Simple Result: Immediate 0-100 AI Potential Rating */}
              {videoRating && <AiPotentialMeter rating={videoRating} subjectLabel="8-Layer Video" />}

              {/* Video Player, Synced Audio Waveform & Stream Metadata */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 rounded-md border border-[#2B2D32] bg-[#1B1D21] flex flex-col overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#2B2D32] flex items-center justify-between text-xs">
                    <span className="font-medium text-[#D8DAE0]">Video Player</span>
                    {durationSec > 0 && (
                      <span className="font-mono tabular-nums text-[#92949B]">
                        {videoTime.toFixed(2)}s / {durationSec.toFixed(2)}s
                      </span>
                    )}
                  </div>
                  <div className="bg-[#0D0E10] p-3">
                    <video
                      ref={videoRef}
                      key={selected.id}
                      controls
                      preload="metadata"
                      poster={result?.thumbnail_url || undefined}
                      src={`/api/evidence/${selected.id}/download`}
                      onTimeUpdate={(e) => setVideoTime(e.currentTarget.currentTime)}
                      className="w-full max-h-[340px] rounded-sm bg-black"
                    />
                  </div>

                  {/* Embedded Audio Track Waveform Visualization */}
                  {audioPeaks.length > 0 && (
                    <div className="px-4 py-3 border-t border-[#2B2D32] space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="inline-flex items-center gap-1.5 text-[#D8DAE0] font-medium">
                          <Volume2 className="w-3.5 h-3.5 text-[#D9A441]" strokeWidth={1.75} />
                          Audio Track Waveform
                        </span>
                        <span className="font-mono text-[11px] text-[#92949B]">
                          {result?.audio_codec || 'PCM'} · Click to seek
                        </span>
                      </div>
                      <canvas
                        ref={waveCanvasRef}
                        width={640}
                        height={64}
                        onClick={(e) => {
                          if (!durationSec || !waveCanvasRef.current) return;
                          const rect = waveCanvasRef.current.getBoundingClientRect();
                          const ratio = (e.clientX - rect.left) / rect.width;
                          seekVideoTo(ratio * durationSec);
                        }}
                        className="w-full h-16 rounded border border-[#2B2D32] cursor-crosshair block"
                      />
                    </div>
                  )}

                  {/* Scene Transitions Strip */}
                  <div className="px-4 py-3 border-t border-[#2B2D32] space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-[#D8DAE0]">
                        Scene Transitions ({sceneChanges.length})
                      </span>
                      <span className="text-[#6C6F77]">Click marker to seek</span>
                    </div>
                    {sceneChanges.length === 0 ? (
                      <div className="text-xs text-[#92949B]">
                        No abrupt visual scene transitions exceeded threshold.
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {sceneChanges.map((sc, idx) => (
                          <button
                            key={`${sc.timestamp_sec}-${idx}`}
                            type="button"
                            onClick={() => handleTimelineSeek(sc.timestamp_sec)}
                            className="whitespace-nowrap px-2.5 py-1 rounded text-xs font-mono border border-[#4F3E1E] bg-[#231D12] text-[#D9A441] hover:bg-[#2E2516] transition-colors flex items-center gap-1"
                          >
                            <Clock className="w-3 h-3" strokeWidth={1.75} />
                            {sc.timestamp_formatted}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Container & Stream Metadata Panel */}
                <div className="lg:col-span-5 rounded-md border border-[#2B2D32] bg-[#1B1D21] overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#2B2D32] text-xs font-medium text-[#D8DAE0]">
                    Container, Stream & Provenance Metadata
                  </div>
                  <div className="p-4 space-y-3 text-xs font-mono">
                    <div className="grid grid-cols-2 gap-y-2.5 gap-x-4">
                      <span className="text-[#92949B] font-sans">Container</span>
                      <span className="text-[#F4F3EF]">{result?.format_name || '—'}</span>

                      <span className="text-[#92949B] font-sans">Resolution</span>
                      <span className="text-[#F4F3EF] tabular-nums">
                        {result?.width ? `${result.width} × ${result.height}` : '—'}
                      </span>

                      <span className="text-[#92949B] font-sans">Frame Rate</span>
                      <span className="text-[#F4F3EF] tabular-nums">
                        {result?.fps ? `${result.fps} fps` : '—'}
                      </span>

                      <span className="text-[#92949B] font-sans">Video Codec</span>
                      <span className="text-[#F4F3EF]">{result?.video_codec || '—'}</span>

                      <span className="text-[#92949B] font-sans">Audio Stream</span>
                      <span className="text-[#F4F3EF]">
                        {result?.has_audio ? result.audio_codec || 'Present' : 'No audio'}
                      </span>

                      <span className="text-[#92949B] font-sans">Bitrate</span>
                      <span className="text-[#F4F3EF] tabular-nums">
                        {result?.bitrate_kbps ? `${result.bitrate_kbps} kbps` : '—'}
                      </span>

                      <span className="text-[#92949B] font-sans">Creation Time</span>
                      <span className="text-[#D9A441]">
                        {result?.creation_time || 'Not embedded'}
                      </span>

                      <span className="text-[#92949B] font-sans">Encoder Tag</span>
                      <span className="text-[#D4D6DC] truncate">{result?.encoder || 'None'}</span>

                      {layers[6]?.metrics?.provenance_status && (
                        <>
                          <span className="text-[#92949B] font-sans">C2PA / Provenance</span>
                          <span className="text-[#6491C7]">
                            {String(layers[6].metrics.provenance_status).replace(/_/g, ' ')}
                          </span>
                        </>
                      )}
                    </div>

                    {result?.extracted_audio_url && (
                      <div className="pt-3 border-t border-[#2B2D32] space-y-2">
                        <div className="text-[#92949B] font-sans">
                          Extracted Audio Track (16 kHz PCM WAV)
                        </div>
                        <audio controls src={result.extracted_audio_url} className="w-full h-9" />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Multi-Layer Authenticity Analysis + Timeline + Final Assessment */}
              <VideoMultiLayerSection
                durationSec={durationSec}
                layers={layers}
                timelineMarkers={timelineMarkers}
                finalAssessment={finalAssessment}
                findings={allVideoFindings}
                liveProgress={liveProgress}
                isProcessing={analyzing}
                onSeekTimestamp={handleTimelineSeek}
                onSelectOverlay={(url, caption) => setModalOverlay({ url, caption })}
              />

              {/* Extracted Frame Gallery + Frame-by-Frame Navigation */}
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Film className="w-4 h-4 text-[#D9A441]" strokeWidth={1.75} />
                    <h2 className="text-sm font-semibold text-[#F4F3EF]">
                      Extracted Frame Gallery & Frame-by-Frame Inspection ({frames.length} frames)
                    </h2>
                  </div>

                  {frames.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => stepFrame(-1)}
                        className="whitespace-nowrap px-2.5 py-1 rounded text-xs font-mono border border-[#2B2D32] bg-[#151619] text-[#D8DAE0] hover:border-[#D9A441] active:scale-[0.985] transition-all inline-flex items-center gap-1"
                      >
                        <ChevronLeft className="w-3.5 h-3.5" strokeWidth={1.75} />
                        Prev
                      </button>
                      <button
                        type="button"
                        onClick={() => stepFrame(1)}
                        className="whitespace-nowrap px-2.5 py-1 rounded text-xs font-mono border border-[#2B2D32] bg-[#151619] text-[#D8DAE0] hover:border-[#D9A441] active:scale-[0.985] transition-all inline-flex items-center gap-1"
                      >
                        Next
                        <ChevronRight className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </button>
                      <label className="inline-flex items-center gap-1.5 text-xs text-[#92949B] ml-2 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={showFaceBox}
                          onChange={(e) => setShowFaceBox(e.target.checked)}
                          className="accent-[#D9A441]"
                        />
                        Face ROI Overlay
                      </label>
                    </div>
                  )}
                </div>

                {frames.length === 0 ? (
                  <div className="text-sm text-[#92949B] py-4">
                    No frames extracted yet. Run the 8-layer analysis to extract interval frames via
                    FFmpeg.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                    {frames.map((frame) => {
                      const isActive = selectedFrameIdx === frame.index;
                      const frameHasMarker = timelineMarkers.some(
                        (m) => m.frame_index === frame.index && m.severity !== 'INFO'
                      );
                      return (
                        <button
                          key={frame.index}
                          type="button"
                          onClick={() => {
                            setSelectedFrameIdx(frame.index);
                            seekVideoTo(frame.timestamp_sec);
                          }}
                          className={`text-left rounded border transition-colors bg-[#131417] overflow-hidden ${
                            isActive
                              ? 'border-[#D9A441]'
                              : frameHasMarker
                                ? 'border-[#6A3538] hover:border-[#C95F5F]'
                                : 'border-[#2B2D32] hover:border-[#494D57]'
                          }`}
                        >
                          <div className="relative">
                            <img
                              src={frame.url}
                              alt={`Frame at ${frame.timestamp_formatted}`}
                              referrerPolicy="no-referrer"
                              className="w-full aspect-video object-cover block"
                            />
                            {showFaceBox && frame.face_bbox_norm && (
                              <div
                                style={{
                                  left: `${frame.face_bbox_norm.x * 100}%`,
                                  top: `${frame.face_bbox_norm.y * 100}%`,
                                  width: `${frame.face_bbox_norm.w * 100}%`,
                                  height: `${frame.face_bbox_norm.h * 100}%`,
                                }}
                                className="absolute border border-[#D9A441] pointer-events-none"
                              />
                            )}
                          </div>
                          <div className="px-2 py-1.5 flex items-center justify-between font-mono text-[11px]">
                            <span className="text-[#F4F3EF] tabular-nums">
                              {frame.timestamp_formatted}
                            </span>
                            <span className="flex items-center gap-1.5">
                              {frame.face_detected && (
                                <span className="text-[#52A378]">FACE</span>
                              )}
                              {frame.is_scene_change && (
                                <span className="text-[#D9A441]">CUT</span>
                              )}
                              {frameHasMarker && <span className="text-[#C95F5F]">FLAG</span>}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {inspectedFrame && (
                  <div className="pt-4 border-t border-[#2B2D32] grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                    <div className="md:col-span-8 rounded bg-[#111214] border border-[#2B2D32] p-2">
                      <div className="relative inline-block w-full">
                        <img
                          src={inspectedFrame.url}
                          alt={`Inspected frame ${inspectedFrame.index}`}
                          referrerPolicy="no-referrer"
                          className="w-full max-h-[380px] object-contain block"
                        />
                        {showFaceBox && inspectedFrame.face_bbox_norm && (
                          <div
                            style={{
                              left: `${inspectedFrame.face_bbox_norm.x * 100}%`,
                              top: `${inspectedFrame.face_bbox_norm.y * 100}%`,
                              width: `${inspectedFrame.face_bbox_norm.w * 100}%`,
                              height: `${inspectedFrame.face_bbox_norm.h * 100}%`,
                            }}
                            className="absolute border-2 border-[#D9A441] pointer-events-none"
                          />
                        )}
                      </div>
                    </div>
                    <div className="md:col-span-4 space-y-2.5 text-xs font-mono">
                      <div className="text-[#D9A441] font-sans font-medium">
                        Selected Frame Inspection
                      </div>
                      <div className="text-[#F4F3EF]">Frame Index: #{inspectedFrame.index + 1}</div>
                      <div className="text-[#F4F3EF] tabular-nums">
                        Timestamp: {inspectedFrame.timestamp_formatted} (
                        {inspectedFrame.timestamp_sec}s)
                      </div>
                      <div className="text-[#92949B]">
                        Face ROI Localized: {inspectedFrame.face_detected ? 'Yes' : 'No'}
                      </div>
                      {inspectedFrame.mean_luma !== undefined && (
                        <div className="text-[#92949B] tabular-nums">
                          Mean Luma: {inspectedFrame.mean_luma} · Sharpness:{' '}
                          {inspectedFrame.sharpness_laplacian}
                        </div>
                      )}
                      <div className="text-[#92949B]">
                        Scene Transition:{' '}
                        {inspectedFrame.is_scene_change ? 'Near detected scene cut' : 'Continuous'}
                      </div>

                      {layers.some((l) => l.overlay_url) && (
                        <div className="pt-2.5 border-t border-[#2B2D32] space-y-1.5">
                          <div className="text-[#92949B] font-sans">Generated Layer Overlays</div>
                          <div className="flex flex-wrap gap-1.5">
                            {layers
                              .filter((l) => l.overlay_url)
                              .map((l) => (
                                <button
                                  key={l.layer_id}
                                  type="button"
                                  onClick={() =>
                                    setModalOverlay({
                                      url: l.overlay_url!,
                                      caption: l.overlay_caption || l.layer_name,
                                    })
                                  }
                                  className="px-2 py-1 rounded border border-[#2B2D32] bg-[#151619] text-[#D9A441] hover:border-[#D9A441] inline-flex items-center gap-1 transition-colors"
                                >
                                  <Eye className="w-3 h-3" strokeWidth={1.75} />
                                  L{l.layer_number}
                                </button>
                              ))}
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => setSelectedFrameIdx(null)}
                        className="mt-2 px-3 py-1.5 rounded border border-[#2B2D32] text-[#D8DAE0] hover:text-[#F4F3EF] font-sans"
                      >
                        Close Preview
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Structured Forensic Findings & Human Review */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
                    Structured Video Findings & Human Review ({displayedFindings.length})
                  </h2>

                  {availableFindingLayers.length > 2 && (
                    <select
                      value={layerFindingFilter}
                      onChange={(e) => {
                        setLayerFindingFilter(e.target.value);
                        setHighlightedFindingId(null);
                      }}
                      className="rounded bg-[#1B1D21] border border-[#2B2D32] px-3 py-1.5 text-xs font-mono text-[#F4F3EF]"
                    >
                      {availableFindingLayers.map((l) => (
                        <option key={l} value={l}>
                          {l === 'ALL' ? 'All Analysis Layers' : l.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                <FindingReviewList
                  findings={displayedFindings}
                  onReviewed={refreshActiveDetail}
                  highlightedFindingId={highlightedFindingId}
                  emptyMessage="Run 8-Layer Analysis to generate structured multi-layer forensic findings."
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Visual Overlay Inspection Modal */}
      <AnimatePresence>
        {modalOverlay && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14 }}
            className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
            onClick={() => setModalOverlay(null)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
              className="rounded-md bg-[#1B1D21] border border-[#32353C] max-w-4xl w-full p-5 space-y-3 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between gap-4">
                <div className="text-xs font-medium text-[#D9A441]">
                  Forensic Visual Overlay Inspection
                </div>
                <button
                  type="button"
                  onClick={() => setModalOverlay(null)}
                  className="text-[#92949B] hover:text-[#F4F3EF] p-1 rounded hover:bg-[#24272D]"
                >
                  <X className="w-4 h-4" strokeWidth={1.75} />
                </button>
              </div>
              <div className="rounded bg-[#111214] border border-[#2B2D32] p-2">
                <img
                  src={modalOverlay.url}
                  alt={modalOverlay.caption}
                  referrerPolicy="no-referrer"
                  className="w-full max-h-[70vh] object-contain block"
                />
              </div>
              <p className="text-xs text-[#B8BAC0] leading-relaxed">{modalOverlay.caption}</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

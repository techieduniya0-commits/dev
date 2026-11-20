import React, { useEffect, useRef, useState } from 'react';
import { AudioLines, Download, FilePlus, Loader2, Play, Trash2, Upload, Volume2 } from 'lucide-react';
import { api, formatBytes } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { FindingReviewList } from '../components/FindingReviewPanel';
import { AiPotentialMeter, computeModalityAiRating } from '../components/AiPotentialMeter';
import {
  CopyHashButton,
  EmptyWorkspaceState,
  PageHeader,
} from '../components/ForensicPrimitives';

export const AudioForensicsPage: React.FC = () => {
  const { activeDetail, activeId, setPage, refreshActiveDetail, showNotice } = useInvestigation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [transcriptDraft, setTranscriptDraft] = useState('');
  const [savingTranscript, setSavingTranscript] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const audioItems = (activeDetail?.evidence || []).filter((e) => e.media_type === 'audio');

  useEffect(() => {
    if (audioItems.length === 0) {
      setSelectedId(null);
    } else if (!selectedId || !audioItems.some((a) => a.id === selectedId)) {
      setSelectedId(audioItems[0].id);
    }
  }, [audioItems, selectedId]);

  const selected = audioItems.find((a) => a.id === selectedId) || null;
  const result = selected?.analysis?.result || null;
  const peaks: number[] = result?.waveform_peaks || [];
  const duration: number = result?.duration_sec || 0;
  const silences: Array<{
    start_sec: number;
    end_sec: number;
    duration_sec: number;
    range_label: string;
  }> = result?.silence_regions || [];
  const discontinuities: Array<{
    timestamp_sec: number;
    timestamp_formatted: string;
    type: string;
    delta_db: number;
    description: string;
  }> = result?.discontinuities || [];

  const linkedTranscripts = (activeDetail?.text_records || []).filter(
    (t) => t.evidence_id === selected?.id && t.role === 'TRANSCRIPT'
  );

  const findings = (activeDetail?.findings || []).filter(
    (f) => f.evidence_id === selected?.id && f.module === 'AUDIO_FORENSICS'
  );

  // Draw real PCM waveform with silence regions, discontinuity markers & playhead
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#111214';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#2B2D32';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (duration > 0) {
      ctx.fillStyle = 'rgba(100, 145, 199, 0.14)';
      for (const s of silences) {
        const x1 = (s.start_sec / duration) * w;
        const x2 = (s.end_sec / duration) * w;
        ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
      }
    }

    if (peaks.length > 0) {
      const barW = w / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const amp = Math.max(0.02, peaks[i]);
        const barH = amp * (h * 0.84);
        const x = i * barW;
        const y = (h - barH) / 2;
        const played = duration > 0 && (i / peaks.length) * duration <= currentTime;
        ctx.fillStyle = played ? '#D9A441' : '#535761';
        ctx.fillRect(x, y, Math.max(1.5, barW - 1.2), barH);
      }
    }

    if (duration > 0) {
      for (const d of discontinuities) {
        const x = (d.timestamp_sec / duration) * w;
        ctx.strokeStyle = '#C95F5F';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    if (duration > 0 && currentTime > 0) {
      const px = Math.min(w, (currentTime / duration) * w);
      ctx.strokeStyle = '#F4F3EF';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
    }
  }, [peaks, silences, discontinuities, duration, currentTime]);

  const seekAudioTo = (sec: number) => {
    if (audioRef.current) {
      audioRef.current.currentTime = Math.max(0, sec);
      setCurrentTime(Math.max(0, sec));
    }
  };

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!duration || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekAudioTo(ratio * duration);
  };

  const handleReanalyze = async () => {
    if (!selected) return;
    setAnalyzing(true);
    try {
      await api.analyzeEvidence(selected.id);
      await refreshActiveDetail();
      showNotice('success', `Audio forensics completed for ${selected.original_filename}.`);
    } catch (e: any) {
      showNotice('error', e?.message || 'Audio analysis failed.');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSaveTranscript = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeId || !selected || !transcriptDraft.trim()) return;
    setSavingTranscript(true);
    try {
      const lines = transcriptDraft.trim().split('\n').filter(Boolean);
      const segments: Array<{ start: number; end: number; text: string }> = [];
      for (const line of lines) {
        const m = line.match(/^\[?(\d{1,2}):(\d{2})(?:\.(\d+))?\]?\s*(.+)$/);
        if (m) {
          const startSec = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          segments.push({ start: startSec, end: startSec + 3, text: m[4].trim() });
        }
      }

      await api.addTextRecord(activeId, {
        role: 'TRANSCRIPT',
        label: `Manual Transcript (${selected.original_filename})`,
        content: transcriptDraft.trim(),
        evidence_id: selected.id,
        segments,
      });
      await api.correlateInvestigation(activeId);
      await refreshActiveDetail();
      setTranscriptDraft('');
      showNotice(
        'success',
        'Manual transcript persisted to database and correlated with other investigation evidence.'
      );
    } catch (err: any) {
      showNotice('error', err?.message || 'Failed to save transcript.');
    } finally {
      setSavingTranscript(false);
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

  if (!activeId || !activeDetail) {
    return (
      <EmptyWorkspaceState
        icon={AudioLines}
        title="Audio Forensics"
        description="Select or create an investigation first to inspect audio waveforms, spectrograms, and acoustic continuity."
        actionLabel="New Investigation"
        onAction={() => setPage('new-investigation')}
      />
    );
  }

  const audioRating = computeModalityAiRating(findings);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={`Acoustic Analysis · ${activeDetail.investigation.id}`}
        title="Audio Forensics"
        description="Interactive PCM waveform, FFmpeg log-intensity spectrogram, silence region detection, and energy discontinuity heuristics."
        actions={
          <button
            type="button"
            onClick={() => setPage('new-investigation')}
            className="whitespace-nowrap px-3.5 py-2 rounded text-xs font-medium border border-[#2B2D32] bg-[#1B1D21] text-[#F4F3EF] hover:border-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
            Upload Audio Evidence
          </button>
        }
      />

      {audioItems.length === 0 ? (
        <EmptyWorkspaceState
          icon={AudioLines}
          title="No audio files uploaded to this investigation"
          description="Upload WAV, MP3, FLAC, M4A, or OGG recordings for real PCM waveform, spectrogram, silence, and energy-step analysis."
          actionLabel="Add Audio Files"
          onAction={() => setPage('new-investigation')}
        />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left selector */}
          <div className="xl:col-span-3 space-y-2.5">
            <div className="text-xs font-medium text-[#92949B] flex items-center justify-between">
              <span>Audio Evidence</span>
              <span className="font-mono text-[11px] tabular-nums">{audioItems.length}</span>
            </div>
            <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
              {audioItems.map((item) => {
                const isSel = item.id === selected?.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      isSel ? 'bg-[#24272D] text-[#F4F3EF]' : 'hover:bg-[#202328] text-[#B8BAC0]'
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
                    onClick={handleReanalyze}
                    disabled={analyzing}
                    className="whitespace-nowrap px-3.5 py-1.5 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {analyzing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                    ) : (
                      <Play className="w-3.5 h-3.5" strokeWidth={2} />
                    )}
                    <span>{analyzing ? 'Processing Audio...' : 'Run Analysis'}</span>
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
                    title="Delete audio evidence"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              {/* Simple Result: 0-100 AI Potential Rating */}
              {audioRating && <AiPotentialMeter rating={audioRating} subjectLabel="Audio Forensics" />}

              {/* Audio Player + Interactive Waveform + Metadata */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 rounded-md border border-[#2B2D32] bg-[#1B1D21] p-4 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-[#F4F3EF] font-medium flex items-center gap-1.5">
                      <Volume2 className="w-3.5 h-3.5 text-[#D9A441]" strokeWidth={1.75} />
                      Interactive PCM Waveform
                    </span>
                    <span className="text-[#92949B] font-mono text-[11px]">
                      Blue: Silence · Red: Energy jumps · Click to seek
                    </span>
                  </div>

                  <canvas
                    ref={canvasRef}
                    width={820}
                    height={140}
                    onClick={handleCanvasClick}
                    className="w-full h-[140px] rounded border border-[#2B2D32] cursor-crosshair block"
                  />

                  <audio
                    ref={audioRef}
                    key={selected.id}
                    controls
                    src={`/api/evidence/${selected.id}/download`}
                    onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    className="w-full h-10"
                  />

                  {result?.spectrogram_url && (
                    <div className="pt-3 border-t border-[#2B2D32] space-y-2">
                      <div className="text-xs font-medium text-[#D8DAE0]">
                        Log-Scale Intensity Spectrogram (FFmpeg)
                      </div>
                      <img
                        src={result.spectrogram_url}
                        alt={`Spectrogram for ${selected.original_filename}`}
                        referrerPolicy="no-referrer"
                        className="w-full rounded border border-[#2B2D32] bg-[#111214] block"
                      />
                    </div>
                  )}
                </div>

                {/* Audio Metadata + Detected Events */}
                <div className="lg:col-span-4 rounded-md border border-[#2B2D32] bg-[#1B1D21] p-4 space-y-4 text-xs">
                  <div className="font-medium text-[#D8DAE0] pb-2 border-b border-[#2B2D32]">
                    Stream Parameters
                  </div>
                  <div className="grid grid-cols-2 gap-y-2 gap-x-3 font-mono tabular-nums">
                    <span className="text-[#92949B] font-sans">Duration</span>
                    <span className="text-[#F4F3EF]">{duration ? `${duration}s` : '—'}</span>
                    <span className="text-[#92949B] font-sans">Sample Rate</span>
                    <span className="text-[#F4F3EF]">
                      {result?.sample_rate ? `${result.sample_rate} Hz` : '—'}
                    </span>
                    <span className="text-[#92949B] font-sans">Channels</span>
                    <span className="text-[#F4F3EF]">{result?.channels ?? '—'}</span>
                    <span className="text-[#92949B] font-sans">Codec</span>
                    <span className="text-[#F4F3EF]">{result?.codec || '—'}</span>
                    <span className="text-[#92949B] font-sans">Mean RMS</span>
                    <span className="text-[#F4F3EF]">
                      {result?.rms_mean_db !== undefined ? `${result.rms_mean_db} dBFS` : '—'}
                    </span>
                    <span className="text-[#92949B] font-sans">Peak Level</span>
                    <span className="text-[#F4F3EF]">
                      {result?.peak_db !== undefined ? `${result.peak_db} dBFS` : '—'}
                    </span>
                  </div>

                  {/* Silence intervals */}
                  <div className="pt-3 border-t border-[#2B2D32] space-y-2">
                    <div className="font-medium text-[#6491C7]">
                      Silence Regions ({silences.length})
                    </div>
                    {silences.length === 0 ? (
                      <div className="text-[#92949B]">None detected below threshold.</div>
                    ) : (
                      <div className="space-y-1.5 max-h-32 overflow-y-auto font-mono">
                        {silences.map((s, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => seekAudioTo(s.start_sec)}
                            className="w-full text-left px-2.5 py-1.5 rounded bg-[#131417] border border-[#2B2D32] hover:border-[#6491C7] transition-colors flex justify-between tabular-nums"
                          >
                            <span className="text-[#D4D6DC]">{s.range_label}</span>
                            <span className="text-[#92949B]">{s.duration_sec}s</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Discontinuity heuristics */}
                  <div className="pt-3 border-t border-[#2B2D32] space-y-2">
                    <div className="font-medium text-[#C95F5F]">
                      Energy Transitions ({discontinuities.length})
                    </div>
                    {discontinuities.length === 0 ? (
                      <div className="text-[#92949B]">No abrupt energy jumps or clipping flagged.</div>
                    ) : (
                      <div className="space-y-1.5 max-h-36 overflow-y-auto font-mono">
                        {discontinuities.map((d, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => seekAudioTo(d.timestamp_sec)}
                            className="w-full text-left px-2.5 py-1.5 rounded bg-[#131417] border border-[#2B2D32] hover:border-[#C95F5F] transition-colors"
                          >
                            <div className="flex justify-between tabular-nums">
                              <span className="text-[#D9A441]">{d.timestamp_formatted}</span>
                              <span className="text-[#C95F5F]">
                                {d.type === 'ENERGY_JUMP' ? `${d.delta_db} dB` : 'CLIP'}
                              </span>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Transcript Panel */}
              <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-[#F4F3EF]">
                    Speech Transcript & Timestamped Segments
                  </h2>
                  <span className="text-xs font-mono text-[#D9A441]">
                    ASR: faster-whisper not installed · Manual mode
                  </span>
                </div>

                <p className="text-xs text-[#92949B] leading-relaxed">
                  {result?.transcription_note ||
                    'Local faster-whisper ASR binaries are unavailable in this runtime. TruthLens X never fabricates transcripts. Supply a verified transcript below (optionally prefix lines with [MM:SS] timestamps) to enable clickable segment playback and cross-modal correlation.'}
                </p>

                {linkedTranscripts.length > 0 && (
                  <div className="space-y-3 pt-2 border-t border-[#2B2D32]">
                    {linkedTranscripts.map((tr) => (
                      <div
                        key={tr.id}
                        className="rounded bg-[#131417] border border-[#2B2D32] p-4 space-y-3"
                      >
                        <div className="flex items-center justify-between text-xs font-mono">
                          <span className="text-[#F4F3EF]">{tr.label}</span>
                          <span className="text-[#92949B]">{tr.id}</span>
                        </div>
                        {tr.segments && tr.segments.length > 0 ? (
                          <div className="space-y-1.5">
                            {tr.segments.map((seg, i) => (
                              <button
                                key={i}
                                type="button"
                                onClick={() => seekAudioTo(seg.start)}
                                className="w-full text-left px-3 py-2 rounded bg-[#1B1D21] border border-[#2B2D32] hover:border-[#D9A441] transition-colors flex items-start gap-3 text-xs"
                              >
                                <span className="font-mono text-[#D9A441] shrink-0 tabular-nums">
                                  {seg.start.toFixed(1)}s
                                </span>
                                <span className="text-[#D4D6DC]">{seg.text}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-[#D4D6DC] whitespace-pre-wrap leading-relaxed">
                            {tr.content}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <form onSubmit={handleSaveTranscript} className="space-y-2.5 pt-2 border-t border-[#2B2D32]">
                  <label className="block text-xs font-medium text-[#92949B]">
                    Record Verified Transcript (optional [MM:SS] prefix per line)
                  </label>
                  <textarea
                    rows={3}
                    value={transcriptDraft}
                    onChange={(e) => setTranscriptDraft(e.target.value)}
                    placeholder="[00:00] Speaker confirms gate inspection at Port Terminal 4 in Chicago on 2026-10-12..."
                    className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-xs text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441]"
                  />
                  <button
                    type="submit"
                    disabled={savingTranscript || !transcriptDraft.trim()}
                    className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all disabled:opacity-50 inline-flex items-center gap-1.5"
                  >
                    <FilePlus className="w-3.5 h-3.5" strokeWidth={2} />
                    {savingTranscript ? 'Saving & Correlating...' : 'Save Transcript & Correlate'}
                  </button>
                </form>
              </div>

              {/* Findings & Human Review */}
              <div className="space-y-3">
                <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
                  Audio Observations & Human Review ({findings.length})
                </h2>
                <FindingReviewList
                  findings={findings}
                  onReviewed={refreshActiveDetail}
                  emptyMessage="Run Analysis to extract audio forensics observations."
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

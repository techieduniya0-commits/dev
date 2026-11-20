import React, { useEffect, useState } from 'react';
import { Download, Eye, Image as ImageIcon, Layers, Loader2, Play, Trash2, Upload } from 'lucide-react';
import { api, formatBytes, formatTimestamp } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { FindingReviewList } from '../components/FindingReviewPanel';
import { AiPotentialMeter, computeModalityAiRating } from '../components/AiPotentialMeter';
import {
  CopyHashButton,
  EmptyWorkspaceState,
  PageHeader,
} from '../components/ForensicPrimitives';

export const ImageForensicsPage: React.FC = () => {
  const { activeDetail, activeId, setPage, refreshActiveDetail, showNotice } = useInvestigation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'original' | 'ela' | 'blend'>('original');
  const [elaOpacity, setElaOpacity] = useState(65);
  const [analyzing, setAnalyzing] = useState(false);

  const imageItems = (activeDetail?.evidence || []).filter((e) => e.media_type === 'image');

  useEffect(() => {
    if (imageItems.length === 0) {
      setSelectedId(null);
    } else if (!selectedId || !imageItems.some((i) => i.id === selectedId)) {
      setSelectedId(imageItems[0].id);
    }
  }, [imageItems, selectedId]);

  const selected = imageItems.find((i) => i.id === selectedId) || null;
  const result = selected?.analysis?.result || null;
  const findings = (activeDetail?.findings || []).filter(
    (f) => f.evidence_id === selected?.id && f.module === 'IMAGE_FORENSICS'
  );

  const handleReanalyze = async () => {
    if (!selected) return;
    setAnalyzing(true);
    try {
      await api.analyzeEvidence(selected.id);
      await refreshActiveDetail();
      showNotice('success', `Image forensics completed for ${selected.original_filename}.`);
    } catch (e: any) {
      showNotice('error', e?.message || 'Image analysis failed.');
    } finally {
      setAnalyzing(false);
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
        icon={ImageIcon}
        title="Image Forensics"
        description="Select or create an investigation first to inspect photographic evidence, EXIF metadata, and Error Level Analysis."
        actionLabel="New Investigation"
        onAction={() => setPage('new-investigation')}
      />
    );
  }

  const imgRating = computeModalityAiRating(findings);

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={`Image Inspection · ${activeDetail.investigation.id}`}
        title="Image Forensics"
        description="Raster container inspection, EXIF/XMP/GPS extraction, JPEG Error Level Analysis (ELA), and spatial noise profiling."
        actions={
          <button
            type="button"
            onClick={() => setPage('new-investigation')}
            className="whitespace-nowrap px-3.5 py-2 rounded text-xs font-medium border border-[#2B2D32] bg-[#1B1D21] text-[#F4F3EF] hover:border-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5"
          >
            <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
            Upload Image Evidence
          </button>
        }
      />

      {imageItems.length === 0 ? (
        <EmptyWorkspaceState
          icon={ImageIcon}
          title="No image evidence uploaded to this investigation"
          description="Upload JPEG, PNG, WebP, or TIFF files to run Sharp and exifr metadata extraction and Error Level Analysis."
          actionLabel="Add Image Files"
          onAction={() => setPage('new-investigation')}
        />
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
          {/* Left selector list */}
          <div className="xl:col-span-3 space-y-2.5">
            <div className="text-xs font-medium text-[#92949B] flex items-center justify-between">
              <span>Image Evidence</span>
              <span className="font-mono text-[11px] tabular-nums">{imageItems.length}</span>
            </div>
            <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
              {imageItems.map((item) => {
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

          {/* Main inspection canvas */}
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
                    <span>{analyzing ? 'Analyzing...' : 'Run Analysis'}</span>
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
                    title="Delete evidence file"
                  >
                    <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              </div>

              {/* Simple Result: 0-100 AI Potential Rating */}
              {imgRating && <AiPotentialMeter rating={imgRating} subjectLabel="Image Forensics" />}

              {/* Image Viewport + ELA Controls */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-7 rounded-md border border-[#2B2D32] bg-[#1B1D21] flex flex-col overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#2B2D32] flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-0.5 rounded bg-[#131417] p-0.5 border border-[#2B2D32]">
                      <button
                        type="button"
                        onClick={() => setViewMode('original')}
                        className={`px-2.5 py-1 rounded-sm text-xs font-medium whitespace-nowrap transition-colors inline-flex items-center gap-1.5 ${
                          viewMode === 'original'
                            ? 'bg-[#262930] text-[#F4F3EF]'
                            : 'text-[#92949B] hover:text-[#F4F3EF]'
                        }`}
                      >
                        <Eye className="w-3.5 h-3.5" strokeWidth={1.75} />
                        Original
                      </button>
                      <button
                        type="button"
                        disabled={!result?.ela_url}
                        onClick={() => setViewMode('ela')}
                        className={`px-2.5 py-1 rounded-sm text-xs font-medium whitespace-nowrap disabled:opacity-40 transition-colors inline-flex items-center gap-1.5 ${
                          viewMode === 'ela'
                            ? 'bg-[#262930] text-[#D9A441]'
                            : 'text-[#92949B] hover:text-[#F4F3EF]'
                        }`}
                      >
                        <Layers className="w-3.5 h-3.5" strokeWidth={1.75} />
                        ELA Map
                      </button>
                      <button
                        type="button"
                        disabled={!result?.ela_url}
                        onClick={() => setViewMode('blend')}
                        className={`px-2.5 py-1 rounded-sm text-xs font-medium whitespace-nowrap disabled:opacity-40 transition-colors ${
                          viewMode === 'blend'
                            ? 'bg-[#262930] text-[#D9A441]'
                            : 'text-[#92949B] hover:text-[#F4F3EF]'
                        }`}
                      >
                        Overlay Blend
                      </button>
                    </div>

                    {viewMode === 'blend' && (
                      <div className="flex items-center gap-2 text-xs font-mono text-[#92949B] tabular-nums">
                        <span>ELA {elaOpacity}%</span>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={elaOpacity}
                          onChange={(e) => setElaOpacity(Number(e.target.value))}
                          className="w-24 accent-[#D9A441]"
                        />
                      </div>
                    )}
                  </div>

                  <div className="relative bg-[#0D0E10] min-h-[320px] flex items-center justify-center p-4 overflow-hidden">
                    <div className="relative max-w-full max-h-[420px]">
                      <img
                        src={result?.preview_url || `/api/evidence/${selected.id}/download`}
                        alt={selected.original_filename}
                        referrerPolicy="no-referrer"
                        className={`max-h-[400px] w-auto object-contain block transition-opacity duration-150 ${
                          viewMode === 'ela' ? 'opacity-0' : 'opacity-100'
                        }`}
                      />
                      {result?.ela_url && (viewMode === 'ela' || viewMode === 'blend') && (
                        <img
                          src={result.ela_url}
                          alt={`Error Level Analysis map for ${selected.original_filename}`}
                          referrerPolicy="no-referrer"
                          style={{
                            opacity: viewMode === 'ela' ? 1 : elaOpacity / 100,
                          }}
                          className="absolute inset-0 w-full h-full object-contain"
                        />
                      )}
                    </div>
                  </div>

                  <div className="px-4 py-2.5 border-t border-[#2B2D32] text-xs text-[#92949B] leading-relaxed">
                    Error Level Analysis highlights JPEG recompression differences. Prior save
                    history, PNG exports, and high-contrast edges also influence ELA intensity.
                  </div>
                </div>

                {/* Technical & EXIF Metadata Table */}
                <div className="lg:col-span-5 rounded-md border border-[#2B2D32] bg-[#1B1D21] flex flex-col overflow-hidden">
                  <div className="px-4 py-3 border-b border-[#2B2D32] text-xs font-medium text-[#D8DAE0]">
                    Technical Metadata & EXIF Headers
                  </div>
                  <div className="p-4 space-y-4 text-xs overflow-y-auto max-h-[460px]">
                    <div className="grid grid-cols-2 gap-y-2.5 gap-x-4 font-mono">
                      <span className="text-[#92949B] font-sans">Format</span>
                      <span className="text-[#F4F3EF]">
                        {result?.format ? String(result.format).toUpperCase() : selected.mime_type}
                      </span>

                      <span className="text-[#92949B] font-sans">Dimensions</span>
                      <span className="text-[#F4F3EF] tabular-nums">
                        {result?.width ? `${result.width} × ${result.height} px` : 'Pending'}
                      </span>

                      <span className="text-[#92949B] font-sans">Color Space</span>
                      <span className="text-[#F4F3EF]">{result?.space || '—'}</span>

                      <span className="text-[#92949B] font-sans">File Size</span>
                      <span className="text-[#F4F3EF] tabular-nums">
                        {formatBytes(selected.file_size)}
                      </span>

                      <span className="text-[#92949B] font-sans">Camera Device</span>
                      <span className="text-[#F4F3EF]">
                        {[result?.camera_make, result?.camera_model].filter(Boolean).join(' ') ||
                          'Not embedded'}
                      </span>

                      <span className="text-[#92949B] font-sans">Software Tag</span>
                      <span className={result?.software ? 'text-[#D9A441]' : 'text-[#92949B]'}>
                        {result?.software || 'None detected'}
                      </span>

                      <span className="text-[#92949B] font-sans">Capture Date</span>
                      <span className="text-[#F4F3EF]">
                        {result?.capture_date || 'Not embedded'}
                      </span>

                      <span className="text-[#92949B] font-sans">Modify Date</span>
                      <span className="text-[#F4F3EF]">
                        {result?.modify_date || 'Not embedded'}
                      </span>

                      <span className="text-[#92949B] font-sans">GPS Coords</span>
                      <span className="text-[#F4F3EF]">
                        {result?.gps
                          ? `${result.gps.latitude}, ${result.gps.longitude}`
                          : 'None'}
                      </span>

                      <span className="text-[#92949B] font-sans">Uploaded</span>
                      <span className="text-[#92949B] tabular-nums">
                        {formatTimestamp(selected.uploaded_at)}
                      </span>
                    </div>

                    {result?.ela_metrics && (
                      <div className="pt-3 border-t border-[#2B2D32] space-y-2">
                        <div className="text-[#92949B] font-medium">
                          ELA & Noise Residual Metrics (Q{result.ela_metrics.quality_level})
                        </div>
                        <div className="grid grid-cols-2 gap-y-1.5 font-mono tabular-nums">
                          <span className="text-[#92949B] font-sans">Mean ELA Diff</span>
                          <span className="text-[#F4F3EF]">
                            {result.ela_metrics.mean_difference}
                          </span>
                          <span className="text-[#92949B] font-sans">Std Deviation</span>
                          <span className="text-[#F4F3EF]">{result.ela_metrics.std_deviation}</span>
                          <span className="text-[#92949B] font-sans">High Residual Ratio</span>
                          <span className="text-[#F4F3EF]">
                            {(result.ela_metrics.high_variance_ratio * 100).toFixed(2)}%
                          </span>
                          <span className="text-[#92949B] font-sans">Laplacian Noise Std</span>
                          <span className="text-[#F4F3EF]">
                            {result.noise_metrics?.global_laplacian_std ?? '—'}
                          </span>
                        </div>
                      </div>
                    )}

                    {result?.exif && Object.keys(result.exif).length > 0 && (
                      <div className="pt-3 border-t border-[#2B2D32] space-y-2">
                        <div className="text-[#92949B] font-medium">
                          Raw EXIF / XMP Tags ({Object.keys(result.exif).length})
                        </div>
                        <div className="rounded bg-[#131417] border border-[#2B2D32] p-2.5 max-h-40 overflow-y-auto font-mono text-[11px] space-y-1">
                          {Object.entries(result.exif).map(([k, v]) => (
                            <div key={k} className="flex justify-between gap-2">
                              <span className="text-[#92949B] shrink-0">{k}</span>
                              <span className="text-[#D4D6DC] truncate text-right">
                                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Findings & Human Review */}
              <div className="space-y-3">
                <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
                  Image Integrity Findings & Human Review ({findings.length})
                </h2>
                <FindingReviewList
                  findings={findings}
                  onReviewed={refreshActiveDetail}
                  emptyMessage="Run Analysis to generate structured forensic observations for this image."
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

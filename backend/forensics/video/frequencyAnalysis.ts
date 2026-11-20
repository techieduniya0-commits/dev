import path from 'path';
import sharp from 'sharp';
import { insertFinding } from '../../db.ts';
import type {
  DecodedFrame,
  VideoAnalysisContext,
  VideoLayerFindingRef,
  VideoLayerOutput,
  VideoTimelineMarkerInternal,
} from './types.ts';

/**
 * Pure-TypeScript 2D Discrete Cosine Transform (2D-DCT Type II) on an N x N grayscale patch
 * using separable 1D transforms (O(N^3) with N=48 -> ~110k ops, ~1.5ms per patch on CPU).
 */
function compute2dDct(patch: Float32Array, n: number): Float32Array {
  const cosTable = new Float32Array(n * n);
  const scale0 = Math.sqrt(1 / n);
  const scaleK = Math.sqrt(2 / n);

  for (let k = 0; k < n; k++) {
    const alpha = k === 0 ? scale0 : scaleK;
    for (let i = 0; i < n; i++) {
      cosTable[k * n + i] = alpha * Math.cos(((2 * i + 1) * k * Math.PI) / (2 * n));
    }
  }

  // 1D DCT on rows
  const tmp = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const rowOff = y * n;
    for (let u = 0; u < n; u++) {
      const cosOff = u * n;
      let sum = 0;
      for (let x = 0; x < n; x++) {
        sum += patch[rowOff + x] * cosTable[cosOff + x];
      }
      tmp[rowOff + u] = sum;
    }
  }

  // 1D DCT on columns
  const out = new Float32Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let v = 0; v < n; v++) {
      const cosOff = v * n;
      let sum = 0;
      for (let y = 0; y < n; y++) {
        sum += tmp[y * n + u] * cosTable[cosOff + y];
      }
      out[v * n + u] = sum;
    }
  }
  return out;
}

function extractCropPatch(
  frame: DecodedFrame,
  cx: number,
  cy: number,
  cropSize: number,
  n: number
): Float32Array {
  const patch = new Float32Array(n * n);
  const half = cropSize / 2;
  const x0 = Math.max(0, Math.min(frame.width - cropSize, Math.floor(cx - half)));
  const y0 = Math.max(0, Math.min(frame.height - cropSize, Math.floor(cy - half)));

  for (let py = 0; py < n; py++) {
    const sy = Math.min(frame.height - 1, Math.floor(y0 + (py / n) * cropSize));
    for (let px = 0; px < n; px++) {
      const sx = Math.min(frame.width - 1, Math.floor(x0 + (px / n) * cropSize));
      patch[py * n + px] = frame.gray[sy * frame.width + sx] - 128;
    }
  }
  return patch;
}

function analyzeSpectrumBands(dct: Float32Array, n: number) {
  let low = 0;
  let mid = 0;
  let high = 0;
  let maxHighCoeff = 0;
  let highCount = 0;
  const maxR = Math.hypot(n - 1, n - 1);

  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      if (u === 0 && v === 0) continue; // skip DC
      const mag = Math.abs(dct[v * n + u]);
      const r = Math.hypot(u, v) / maxR;
      if (r < 0.25) low += mag;
      else if (r < 0.6) mid += mag;
      else {
        high += mag;
        highCount++;
        if (mag > maxHighCoeff) maxHighCoeff = mag;
      }
    }
  }

  const total = Math.max(1e-6, low + mid + high);
  const meanHigh = high / Math.max(1, highCount);
  const periodicPeakIndex = maxHighCoeff / Math.max(0.01, meanHigh);

  return {
    low_pct: Number(((low / total) * 100).toFixed(1)),
    mid_pct: Number(((mid / total) * 100).toFixed(1)),
    high_pct: Number(((high / total) * 100).toFixed(1)),
    periodic_peak_index: Number(periodicPeakIndex.toFixed(2)),
  };
}

export async function runFrequencyAnalysisLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_5_FREQUENCY_DOMAIN';
  const layerName = 'Layer 5 — Frequency-Domain (2D-DCT) Analysis';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  if (ctx.frames.length === 0) {
    return {
      layer_number: 5,
      layer_id: layerId,
      layer_name: layerName,
      status: 'FAILED',
      processing_status: 'FAILED',
      summary: 'No frames available for 2D-DCT spectral analysis.',
      actual_result: '0 frames available.',
      evidence_strength: 'NONE',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation: 'Frequency analysis transforms spatial luminance crops into 2D-DCT frequency spectra.',
      limitations: 'Requires decoded video frames.',
      alternative_explanation: 'Corrupt or empty video.',
      metrics: {},
      finding_ids: [],
      finding_refs: [],
      timeline_markers: [],
    };
  }

  const N = 48;
  // Select up to 5 representative frames evenly spaced across the video
  const sampleIndices: number[] = [];
  const step = Math.max(1, Math.floor(ctx.frames.length / Math.min(5, ctx.frames.length)));
  for (let i = 0; i < ctx.frames.length && sampleIndices.length < 5; i += step) {
    sampleIndices.push(i);
  }

  let sumLow = 0;
  let sumMid = 0;
  let sumHigh = 0;
  let maxPeakIdx = 0;
  let peakFrameIdx = sampleIndices[0];
  let bestDct: Float32Array | null = null;
  let faceHighSum = 0;
  let bgHighSum = 0;
  let facePairCnt = 0;

  for (const idx of sampleIndices) {
    const f = ctx.frames[idx];
    const face = ctx.face_detections[idx];
    const cropSize = Math.min(f.width, f.height, 96);

    const cx = face ? face.bbox.x + face.bbox.w / 2 : f.width / 2;
    const cy = face ? face.bbox.y + face.bbox.h / 2 : f.height / 2;

    const roiPatch = extractCropPatch(f, cx, cy, cropSize, N);
    const roiDct = compute2dDct(roiPatch, N);
    const bands = analyzeSpectrumBands(roiDct, N);

    sumLow += bands.low_pct;
    sumMid += bands.mid_pct;
    sumHigh += bands.high_pct;

    if (bands.periodic_peak_index > maxPeakIdx) {
      maxPeakIdx = bands.periodic_peak_index;
      peakFrameIdx = idx;
      bestDct = roiDct;
    }

    if (face) {
      // Compare against top-left background patch
      const bgPatch = extractCropPatch(f, cropSize / 2, cropSize / 2, cropSize, N);
      const bgDct = compute2dDct(bgPatch, N);
      const bgBands = analyzeSpectrumBands(bgDct, N);
      faceHighSum += bands.high_pct;
      bgHighSum += bgBands.high_pct;
      facePairCnt++;
    }
  }

  const cnt = sampleIndices.length;
  const avgLow = Number((sumLow / cnt).toFixed(1));
  const avgMid = Number((sumMid / cnt).toFixed(1));
  const avgHigh = Number((sumHigh / cnt).toFixed(1));
  const faceBgHighRatio =
    facePairCnt > 0 ? Number((faceHighSum / Math.max(0.5, bgHighSum)).toFixed(2)) : null;

  // Render real 2D-DCT log-magnitude spatial frequency visualization PNG
  let overlayUrl: string | null = null;
  if (bestDct) {
    try {
      const specBuf = Buffer.alloc(N * N * 3);
      let maxLog = 0.001;
      const logVals = new Float32Array(N * N);
      for (let i = 0; i < N * N; i++) {
        const v = Math.log1p(Math.abs(bestDct[i]));
        logVals[i] = v;
        if (i > 0 && v > maxLog) maxLog = v;
      }
      for (let i = 0; i < N * N; i++) {
        const norm = Math.min(1, logVals[i] / maxLog);
        specBuf[i * 3] = Math.round(norm * 235);
        specBuf[i * 3 + 1] = Math.round(Math.pow(norm, 1.3) * 170);
        specBuf[i * 3 + 2] = Math.round(Math.pow(norm, 2.0) * 75 + (1 - norm) * 20);
      }

      const outPath = path.join(ctx.deriv_dir, 'layer5_frequency_spectrum.png');
      await sharp(specBuf, { raw: { width: N, height: N, channels: 3 } })
        .resize(384, 384, { kernel: 'nearest' })
        .png()
        .toFile(outPath);
      overlayUrl = `/derivatives/${ctx.evidence_id}/layer5_frequency_spectrum.png`;
    } catch {
      overlayUrl = null;
    }
  }

  const peakFrame = ctx.frames[peakFrameIdx];
  const isHeavilyCompressed =
    ctx.bitrate_kbps !== null && ctx.bitrate_kbps > 0 && ctx.bitrate_kbps < 280;
  const anomalousFreq =
    maxPeakIdx > 9.5 ||
    (faceBgHighRatio !== null && (faceBgHighRatio < 0.55 || faceBgHighRatio > 1.85));

  const title = anomalousFreq
    ? isHeavilyCompressed
      ? `Spectral periodicity consistent with heavy video compression (${ctx.bitrate_kbps} kbps, peak index ${maxPeakIdx.toFixed(1)})`
      : `Elevated spectral periodicity or ROI frequency disparity observed (peak index ${maxPeakIdx.toFixed(1)})`
    : `Spatial frequency distribution within typical video compression profile (L:${avgLow}% / M:${avgMid}% / H:${avgHigh}%)`;

  const fid = insertFinding({
    investigation_id: ctx.investigation_id,
    evidence_id: ctx.evidence_id,
    module: 'VIDEO_FORENSICS',
    analysis_layer: layerId,
    finding_type: anomalousFreq
      ? isHeavilyCompressed
        ? 'FREQUENCY_COMPRESSION_QUANTIZATION'
        : 'FREQUENCY_PERIODIC_ARTIFACT'
      : 'FREQUENCY_BASELINE_PROFILE',
    title,
    description: `2D-DCT spectral analysis across ${cnt} sampled frames measured energy distribution: Low ${avgLow}%, Mid ${avgMid}%, High ${avgHigh}%. Peak high-frequency periodic spike index: ${maxPeakIdx.toFixed(2)} at Frame #${peakFrame.index + 1} (${peakFrame.timestamp_formatted}).${faceBgHighRatio !== null ? ` Face-to-background high-frequency energy ratio: ${faceBgHighRatio}x.` : ''}${isHeavilyCompressed ? ` Stream bitrate is low (${ctx.bitrate_kbps} kbps), which strongly induces 8×8 macroblock DCT quantization spikes.` : ''}`,
    actual_observation: `Low ${avgLow}% / Mid ${avgMid}% / High ${avgHigh}%; peak periodic index ${maxPeakIdx.toFixed(2)}; bitrate=${ctx.bitrate_kbps ?? 'unknown'} kbps.`,
    evidence_reference: ref,
    timestamp_or_region: `Frame #${peakFrame.index + 1} (${peakFrame.timestamp_formatted})`,
    start_timestamp: peakFrame.timestamp_sec,
    end_timestamp: peakFrame.timestamp_sec,
    frame_reference: `Frame #${peakFrame.index + 1}`,
    analysis_category: 'STATISTICAL_HEURISTIC',
    evidence_strength: 'LOW',
    uncertainty: anomalousFreq ? 'REQUIRES_HUMAN_REVIEW' : 'AMBIGUOUS',
    limitations:
      'Frequency-domain artifacts NEVER uniquely identify AI-generated media. H.264/HEVC 8×8 DCT quantization, low-bitrate re-encoding, video scaling, screen-capture grids, striped fabrics, and synthetic test patterns produce strong periodic DCT peaks.',
    alternative_explanation:
      'Standard video codec macroblock quantization, low-bitrate platform re-compression, bicubic/Lanczos resizing, moiré patterns, or sharp geometric textures.',
  });

  const markers: VideoTimelineMarkerInternal[] = anomalousFreq
    ? [
        {
          id: `MK-L5-${peakFrame.index}`,
          timestamp_sec: peakFrame.timestamp_sec,
          timestamp_formatted: peakFrame.timestamp_formatted,
          marker_type: 'TEMPORAL',
          layer_id: layerId,
          finding_id: fid,
          frame_index: peakFrame.index,
          title: isHeavilyCompressed
            ? 'Low-bitrate DCT compression periodicity'
            : 'High-frequency spectral peak observed',
          detail: `2D-DCT periodic index ${maxPeakIdx.toFixed(2)} (Low ${avgLow}% / Mid ${avgMid}% / High ${avgHigh}%).`,
          severity: 'REVIEW',
        },
      ]
    : [];

  return {
    layer_number: 5,
    layer_id: layerId,
    layer_name: layerName,
    status: anomalousFreq ? 'REQUIRES_REVIEW' : 'COMPLETED',
    processing_status: 'COMPLETED',
    summary: anomalousFreq
      ? isHeavilyCompressed
        ? `Periodic DCT peak (${maxPeakIdx.toFixed(1)}x) consistent with low-bitrate (${ctx.bitrate_kbps} kbps) compression artifacts.`
        : `Periodic high-frequency peak (${maxPeakIdx.toFixed(1)}x) observed — verify against compression or geometric textures.`
      : `2D-DCT spectral roll-off consistent with standard encoded video (High band ${avgHigh}%).`,
    actual_result: `Low ${avgLow}% · Mid ${avgMid}% · High ${avgHigh}% · Peak index ${maxPeakIdx.toFixed(2)}${faceBgHighRatio !== null ? ` · Face/BG ${faceBgHighRatio}x` : ''}`,
    evidence_strength: 'LOW',
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps: [
      {
        start_sec: peakFrame.timestamp_sec,
        label: `Spectrum Frame #${peakFrame.index + 1} (${peakFrame.timestamp_formatted})`,
      },
    ],
    evidence_references: [ref, `Frame #${peakFrame.index + 1}`],
    explanation:
      'Transforms 48×48 luminance ROI crops via 2D Discrete Cosine Transform (DCT) to quantify spatial frequency roll-off, periodic checkerboard spikes, and face-vs-background frequency disparity.',
    limitations:
      'Frequency artifacts are non-unique indicators: lossy H.264/VP9 compression, video downscaling, and sharp regular textures create similar high-frequency signatures.',
    alternative_explanation:
      'Standard codec quantization grids, low-bitrate re-encoding, resolution scaling, screen recordings, or patterned surfaces.',
    overlay_url: overlayUrl,
    overlay_caption: `2D-DCT Log-Magnitude Spatial Frequency Map — Frame #${peakFrame.index + 1} (${peakFrame.timestamp_formatted}) (top-left: DC/low frequencies, bottom-right: high frequencies)`,
    metrics: {
      frames_analyzed: cnt,
      low_band_pct: avgLow,
      mid_band_pct: avgMid,
      high_band_pct: avgHigh,
      periodic_peak_index: Number(maxPeakIdx.toFixed(2)),
      face_to_bg_high_ratio: faceBgHighRatio,
      heavily_compressed_stream: isHeavilyCompressed,
    },
    finding_ids: [fid],
    finding_refs: [
      {
        finding_id: fid,
        layer_id: layerId,
        layer_name: layerName,
        title,
        strength: 'LOW',
        uncertainty: anomalousFreq ? 'REQUIRES_HUMAN_REVIEW' : 'AMBIGUOUS',
        finding_type: anomalousFreq
          ? isHeavilyCompressed
            ? 'FREQUENCY_COMPRESSION_QUANTIZATION'
            : 'FREQUENCY_PERIODIC_ARTIFACT'
          : 'FREQUENCY_BASELINE_PROFILE',
        is_anomalous: anomalousFreq,
        category_tag: anomalousFreq
          ? isHeavilyCompressed
            ? 'CONVENTIONAL_EDIT'
            : 'AI_GEN'
          : 'BASELINE',
      },
    ],
    timeline_markers: markers,
  };
}

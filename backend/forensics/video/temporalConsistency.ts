import path from 'path';
import sharp from 'sharp';
import { insertFinding } from '../../db.ts';
import type {
  VideoAnalysisContext,
  VideoLayerFindingRef,
  VideoLayerOutput,
  VideoTimelineMarkerInternal,
} from './types.ts';

export async function runTemporalConsistencyLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_4_TEMPORAL_CONSISTENCY';
  const layerName = 'Layer 4 — Frame-to-Frame Temporal Consistency';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  if (ctx.frames.length < 2) {
    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'TEMPORAL_INSUFFICIENT_FRAMES',
      title: 'Fewer than 2 decoded frames — temporal consistency skipped',
      description: 'At least 2 frames are required to compute inter-frame pixel and texture deltas.',
      actual_observation: `${ctx.frames.length} frame(s) available.`,
      evidence_reference: ref,
      timestamp_or_region: 'Full Video',
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'INSUFFICIENT_DATA',
      limitations: 'Single-frame or corrupted clip cannot undergo temporal comparison.',
      alternative_explanation: 'Very short clip or single still frame encoded as video.',
    });

    return {
      layer_number: 4,
      layer_id: layerId,
      layer_name: layerName,
      status: 'REQUIRES_REVIEW',
      processing_status: 'COMPLETED',
      summary: 'Fewer than 2 frames available for temporal comparison.',
      actual_result: `${ctx.frames.length} frame decoded.`,
      evidence_strength: 'LOW',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation: 'Temporal consistency compares consecutive decoded frames for localized flicker, texture jumps, and visual discontinuities.',
      limitations: 'Requires >= 2 frames.',
      alternative_explanation: 'Clip too short.',
      metrics: { pairs_analyzed: 0 },
      finding_ids: [fid],
      finding_refs: [
        {
          finding_id: fid,
          layer_id: layerId,
          layer_name: layerName,
          title: 'Fewer than 2 decoded frames — temporal consistency skipped',
          strength: 'LOW',
          uncertainty: 'INSUFFICIENT_DATA',
          finding_type: 'TEMPORAL_INSUFFICIENT_FRAMES',
          is_anomalous: false,
          category_tag: 'UNCERTAIN',
        },
      ],
      timeline_markers: [],
    };
  }

  const intervals: Array<{
    from_idx: number;
    to_idx: number;
    timestamp_sec: number;
    timestamp_formatted: string;
    global_mae: number;
    texture_flicker_ratio: number;
    localized_spike_ratio: number;
    is_scene_cut: boolean;
    flagged: boolean;
  }> = [];

  for (let i = 1; i < ctx.frames.length; i++) {
    const prev = ctx.frames[i - 1];
    const curr = ctx.frames[i];
    const w = Math.min(prev.width, curr.width);
    const h = Math.min(prev.height, curr.height);

    let sumDiff = 0;
    const tileCols = 4;
    const tileRows = 4;
    const tileSums = new Float64Array(tileCols * tileRows);
    const tileCounts = new Uint32Array(tileCols * tileRows);

    for (let y = 0; y < h; y++) {
      const ty = Math.min(tileRows - 1, Math.floor((y / h) * tileRows));
      for (let x = 0; x < w; x++) {
        const tx = Math.min(tileCols - 1, Math.floor((x / w) * tileCols));
        const d = Math.abs(curr.gray[y * curr.width + x] - prev.gray[y * prev.width + x]);
        sumDiff += d;
        const tidx = ty * tileCols + tx;
        tileSums[tidx] += d;
        tileCounts[tidx]++;
      }
    }

    const globalMae = sumDiff / Math.max(1, w * h);
    const tileMeans = Array.from({ length: 16 }, (_, t) =>
      tileCounts[t] > 0 ? tileSums[t] / tileCounts[t] : 0
    );
    const maxTile = Math.max(...tileMeans);
    const localizedSpikeRatio = maxTile / Math.max(1.2, globalMae);

    // Texture sharpness pulse between consecutive frames (flicker indicator)
    const sharpDelta =
      Math.abs(curr.sharpness_laplacian - prev.sharpness_laplacian) /
      Math.max(1.5, (curr.sharpness_laplacian + prev.sharpness_laplacian) / 2);

    const isCut = curr.is_scene_change || globalMae > 42;
    const flagged = !isCut && (sharpDelta > 0.42 || (localizedSpikeRatio > 3.1 && maxTile > 14));

    intervals.push({
      from_idx: i - 1,
      to_idx: i,
      timestamp_sec: curr.timestamp_sec,
      timestamp_formatted: curr.timestamp_formatted,
      global_mae: Number(globalMae.toFixed(2)),
      texture_flicker_ratio: Number(sharpDelta.toFixed(3)),
      localized_spike_ratio: Number(localizedSpikeRatio.toFixed(2)),
      is_scene_cut: isCut,
      flagged,
    });
  }

  const flaggedIntervals = intervals.filter((iv) => iv.flagged);
  const cutIntervals = intervals.filter((iv) => iv.is_scene_cut);

  // Pick peak non-cut temporal difference pair to render real Temporal Difference Heatmap PNG
  const nonCutSorted = intervals
    .filter((iv) => !iv.is_scene_cut)
    .sort((a, b) => b.localized_spike_ratio * b.global_mae - a.localized_spike_ratio * a.global_mae);
  const peakPair = nonCutSorted[0] || intervals[0];

  let overlayUrl: string | null = null;
  if (peakPair) {
    try {
      const fA = ctx.frames[peakPair.from_idx];
      const fB = ctx.frames[peakPair.to_idx];
      const w = fB.width;
      const h = fB.height;
      const heat = Buffer.alloc(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        const diff = Math.abs(fB.gray[i] - fA.gray[i]);
        const amp = Math.min(255, Math.round(diff * 4.5));
        const base = Math.round(fB.gray[i] * 0.28);
        heat[i * 3] = Math.min(255, base + Math.round(amp * 0.95));
        heat[i * 3 + 1] = Math.min(255, base + Math.round(amp * 0.48));
        heat[i * 3 + 2] = Math.min(255, base + Math.round(amp * 0.14));
      }
      const outPath = path.join(ctx.deriv_dir, 'layer4_temporal_diff.png');
      await sharp(heat, { raw: { width: w, height: h, channels: 3 } })
        .resize(640, 360, { fit: 'fill' })
        .png()
        .toFile(outPath);
      overlayUrl = `/derivatives/${ctx.evidence_id}/layer4_temporal_diff.png`;
    } catch {
      overlayUrl = null;
    }
  }

  const findingIds: string[] = [];
  const findingRefs: VideoLayerFindingRef[] = [];
  const markers: VideoTimelineMarkerInternal[] = [];

  if (flaggedIntervals.length > 0) {
    const tsList = flaggedIntervals.slice(0, 6).map((f) => f.timestamp_formatted).join(', ');
    const title = `${flaggedIntervals.length} intra-scene temporal flicker / localized discontinuity interval(s) detected`;
    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'TEMPORAL_FLICKER_DISCONTINUITY',
      title,
      description: `Analyzed ${intervals.length} consecutive frame pairs (${cutIntervals.length} scene cuts excluded). Flagged ${flaggedIntervals.length} intra-scene interval(s) with localized block variance spikes or sharpness flicker at: ${tsList}. Peak localized ratio ${peakPair.localized_spike_ratio}x at ${peakPair.timestamp_formatted}.`,
      actual_observation: `${flaggedIntervals.length} flagged intra-scene pairs; peak localized diff ratio ${peakPair.localized_spike_ratio}x; texture flicker ${peakPair.texture_flicker_ratio}.`,
      evidence_reference: ref,
      timestamp_or_region: tsList,
      start_timestamp: flaggedIntervals[0].timestamp_sec,
      end_timestamp: flaggedIntervals[flaggedIntervals.length - 1].timestamp_sec,
      frame_reference: `Frame #${peakPair.from_idx + 1} -> #${peakPair.to_idx + 1}`,
      analysis_category: 'STATISTICAL_HEURISTIC',
      evidence_strength: 'MODERATE',
      uncertainty: 'REQUIRES_HUMAN_REVIEW',
      limitations:
        'Rapid foreground movement (waving hand, passing vehicle, camera autofocus hunt, I-frame/P-frame bitrate pulsing) creates localized frame-to-frame spikes without synthetic editing.',
      alternative_explanation:
        'Fast localized subject motion, camera autofocus breathing, flickering artificial lighting (50/60Hz), or GOP keyframe compression refresh.',
    });

    findingIds.push(fid);
    findingRefs.push({
      finding_id: fid,
      layer_id: layerId,
      layer_name: layerName,
      title,
      strength: 'MODERATE',
      uncertainty: 'REQUIRES_HUMAN_REVIEW',
      finding_type: 'TEMPORAL_FLICKER_DISCONTINUITY',
      is_anomalous: true,
      category_tag: 'AI_GEN',
    });

    for (const iv of flaggedIntervals.slice(0, 6)) {
      markers.push({
        id: `MK-L4-${iv.to_idx}`,
        timestamp_sec: iv.timestamp_sec,
        timestamp_formatted: iv.timestamp_formatted,
        marker_type: 'TEMPORAL',
        layer_id: layerId,
        finding_id: fid,
        frame_index: iv.to_idx,
        title: 'Intra-scene temporal flicker / local discontinuity',
        detail: `MAE ${iv.global_mae}, texture delta ${iv.texture_flicker_ratio}, localized block spike ${iv.localized_spike_ratio}x.`,
        severity: 'ELEVATED',
      });
    }
  } else {
    const title = `No abnormal intra-scene temporal flicker detected across ${intervals.length} frame pairs`;
    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'TEMPORAL_CONSISTENCY_BASELINE',
      title,
      description: `Inter-frame comparison across ${intervals.length} sampled frame transitions (${cutIntervals.length} editorial scene cut(s) separated) showed steady texture sharpness and spatial difference profiles.`,
      actual_observation: `0 intra-scene flicker spikes; ${cutIntervals.length} editorial scene cut(s).`,
      evidence_reference: ref,
      timestamp_or_region: `00:00.00 - ${ctx.frames[ctx.frames.length - 1].timestamp_formatted}`,
      start_timestamp: 0,
      end_timestamp: ctx.duration_sec,
      frame_reference: `${ctx.frames.length} sampled frames`,
      analysis_category: 'STATISTICAL_HEURISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'NONE',
      limitations:
        'Interval sampling may miss brief single-frame glitches between sampled timestamps; smooth generative video can also exhibit low pixel-delta flicker.',
      alternative_explanation: 'Consistent temporal progression between sampled frames.',
    });

    findingIds.push(fid);
    findingRefs.push({
      finding_id: fid,
      layer_id: layerId,
      layer_name: layerName,
      title,
      strength: 'LOW',
      uncertainty: 'NONE',
      finding_type: 'TEMPORAL_CONSISTENCY_BASELINE',
      is_anomalous: false,
      category_tag: 'BASELINE',
    });
  }

  // Also add editorial cut timeline markers as INFO (never claiming scene cut == manipulation)
  for (const cut of cutIntervals.slice(0, 6)) {
    markers.push({
      id: `MK-L4-CUT-${cut.to_idx}`,
      timestamp_sec: cut.timestamp_sec,
      timestamp_formatted: cut.timestamp_formatted,
      marker_type: 'TEMPORAL',
      layer_id: layerId,
      finding_id: findingIds[0] || null,
      frame_index: cut.to_idx,
      title: 'Visual scene cut (editorial transition)',
      detail: `Global pixel MAE ${cut.global_mae} — normal scene transition separated from intra-scene flicker.`,
      severity: 'INFO',
    });
  }

  return {
    layer_number: 4,
    layer_id: layerId,
    layer_name: layerName,
    status: flaggedIntervals.length > 0 ? 'REQUIRES_REVIEW' : 'COMPLETED',
    processing_status: 'COMPLETED',
    summary:
      flaggedIntervals.length > 0
        ? `${flaggedIntervals.length} localized temporal flicker/discontinuity interval(s) flagged (${cutIntervals.length} normal scene cuts excluded).`
        : `Smooth frame-to-frame temporal continuity across ${intervals.length} transitions (${cutIntervals.length} scene cuts separated).`,
    actual_result: `Transitions: ${intervals.length} · Intra-scene flags: ${flaggedIntervals.length} · Scene cuts: ${cutIntervals.length}`,
    evidence_strength: flaggedIntervals.length > 0 ? 'MODERATE' : 'LOW',
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps: flaggedIntervals.slice(0, 6).map((f) => ({
      start_sec: f.timestamp_sec,
      label: `${f.timestamp_formatted} (spike ${f.localized_spike_ratio}x)`,
    })),
    evidence_references: [ref, `Frame #${peakPair.from_idx + 1} -> #${peakPair.to_idx + 1}`],
    explanation:
      'Compares consecutive sampled frames for localized spatial warps, texture-sharpness pulsing, and background/foreground discontinuities while separating standard editorial scene cuts.',
    limitations:
      'Fast subject movement, lens autofocus, lighting flicker, and codec GOP keyframe refreshes can trigger localized differences.',
    alternative_explanation:
      'Fast hand/object motion, artificial LED flicker, autofocus adjustment, or keyframe compression.',
    overlay_url: overlayUrl,
    overlay_caption: `Temporal Difference Heatmap: Frame #${peakPair.from_idx + 1} -> #${peakPair.to_idx + 1} (${peakPair.timestamp_formatted}) — brighter amber marks highest inter-frame pixel change`,
    metrics: {
      pairs_analyzed: intervals.length,
      flagged_intervals: flaggedIntervals.length,
      scene_cuts_excluded: cutIntervals.length,
      peak_localized_spike_ratio: peakPair.localized_spike_ratio,
      peak_texture_flicker: peakPair.texture_flicker_ratio,
      series: intervals.map((iv) => ({
        t: iv.timestamp_sec,
        mae: iv.global_mae,
        flicker: iv.texture_flicker_ratio,
        spike: iv.localized_spike_ratio,
        flagged: iv.flagged,
      })),
    },
    finding_ids: findingIds,
    finding_refs: findingRefs,
    timeline_markers: markers,
  };
}

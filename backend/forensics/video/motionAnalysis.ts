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
 * Real Block-Matching Optical Flow (8x8 blocks, search radius +/- 4 px)
 * computing motion vectors (dx, dy) across consecutive decoded grayscale frames.
 */
function estimateBlockOpticalFlow(prev: DecodedFrame, curr: DecodedFrame) {
  const w = Math.min(prev.width, curr.width);
  const h = Math.min(prev.height, curr.height);
  const block = 12;
  const search = 4;
  const cols = Math.floor((w - search * 2) / block);
  const rows = Math.floor((h - search * 2) / block);

  const vectors: Array<{ bx: number; by: number; dx: number; dy: number; mag: number; sad: number }> = [];
  let sumDx = 0;
  let sumDy = 0;
  let sumMag = 0;

  for (let by = 0; by < rows; by++) {
    const y0 = search + by * block;
    for (let bx = 0; bx < cols; bx++) {
      const x0 = search + bx * block;

      // Measure block texture contrast first (skip flat/uniform aperture-problem regions)
      let zeroSad = 0;
      let blockMin = 255;
      let blockMax = 0;
      for (let py = 0; py < block; py += 2) {
        const pRow = (y0 + py) * prev.width;
        const cRow = (y0 + py) * curr.width;
        for (let px = 0; px < block; px += 2) {
          const pv = prev.gray[pRow + x0 + px];
          if (pv < blockMin) blockMin = pv;
          if (pv > blockMax) blockMax = pv;
          zeroSad += Math.abs(pv - curr.gray[cRow + x0 + px]);
        }
      }

      // If block is nearly flat or unchanged at (0,0), assign zero motion
      if (blockMax - blockMin < 8 || zeroSad < 24) {
        vectors.push({ bx, by, dx: 0, dy: 0, mag: 0, sad: zeroSad });
        continue;
      }

      let bestDx = 0;
      let bestDy = 0;
      let bestSad = zeroSad;

      for (let dy = -search; dy <= search; dy += 2) {
        for (let dx = -search; dx <= search; dx += 2) {
          if (dx === 0 && dy === 0) continue;
          let sad = 0;
          for (let py = 0; py < block; py += 2) {
            const pRow = (y0 + py) * prev.width;
            const cRow = (y0 + py + dy) * curr.width;
            for (let px = 0; px < block; px += 2) {
              sad += Math.abs(prev.gray[pRow + x0 + px] - curr.gray[cRow + x0 + px + dx]);
            }
          }
          // Require clear SAD improvement over zero-motion to prevent noise-driven vectors
          if (sad + 32 < bestSad) {
            bestSad = sad;
            bestDx = dx;
            bestDy = dy;
          }
        }
      }

      const mag = Math.hypot(bestDx, bestDy);
      vectors.push({ bx, by, dx: bestDx, dy: bestDy, mag, sad: bestSad });
      sumDx += bestDx;
      sumDy += bestDy;
      sumMag += mag;
    }
  }

  const n = Math.max(1, vectors.length);
  const meanDx = sumDx / n;
  const meanDy = sumDy / n;
  const meanMag = sumMag / n;

  // Compute directional divergence from global camera flow
  let divSum = 0;
  for (const v of vectors) {
    divSum += Math.hypot(v.dx - meanDx, v.dy - meanDy);
  }
  const flowDivergence = divSum / n;

  // Illumination/shadow shift check: mean luminance change across top vs bottom halves
  let topDelta = 0;
  let botDelta = 0;
  const halfH = Math.floor(h / 2);
  for (let y = 0; y < halfH; y++) {
    for (let x = 0; x < w; x++) {
      topDelta += curr.gray[y * curr.width + x] - prev.gray[y * prev.width + x];
    }
  }
  for (let y = halfH; y < h; y++) {
    for (let x = 0; x < w; x++) {
      botDelta += curr.gray[y * curr.width + x] - prev.gray[y * prev.width + x];
    }
  }
  const lightingAsymmetry = Math.abs(topDelta / Math.max(1, halfH * w) - botDelta / Math.max(1, (h - halfH) * w));

  return {
    cols,
    rows,
    vectors,
    mean_dx: Number(meanDx.toFixed(2)),
    mean_dy: Number(meanDy.toFixed(2)),
    mean_mag: Number(meanMag.toFixed(2)),
    flow_divergence: Number(flowDivergence.toFixed(2)),
    lighting_asymmetry: Number(lightingAsymmetry.toFixed(2)),
  };
}

export async function runMotionAnalysisLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_6_MOTION_PHYSICS';
  const layerName = 'Layer 6 — Motion & Physical Consistency (Optical Flow)';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  if (ctx.frames.length < 2) {
    return {
      layer_number: 6,
      layer_id: layerId,
      layer_name: layerName,
      status: 'REQUIRES_REVIEW',
      processing_status: 'COMPLETED',
      summary: 'Insufficient frames for optical flow motion estimation.',
      actual_result: `${ctx.frames.length} frame decoded.`,
      evidence_strength: 'LOW',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation: 'Optical flow compares block motion vectors across consecutive frames.',
      limitations: 'Requires >= 2 frames.',
      alternative_explanation: 'Clip too short.',
      metrics: {},
      finding_ids: [],
      finding_refs: [],
      timeline_markers: [],
    };
  }

  const pairResults: Array<{
    from_idx: number;
    to_idx: number;
    ts: number;
    ts_fmt: string;
    flow: ReturnType<typeof estimateBlockOpticalFlow>;
    is_cut: boolean;
    flagged: boolean;
  }> = [];

  for (let i = 1; i < ctx.frames.length; i++) {
    const prev = ctx.frames[i - 1];
    const curr = ctx.frames[i];
    const flow = estimateBlockOpticalFlow(prev, curr);
    const isCut = curr.is_scene_change;
    const flagged = !isCut && (flow.flow_divergence > 2.35 || flow.lighting_asymmetry > 18);

    pairResults.push({
      from_idx: i - 1,
      to_idx: i,
      ts: curr.timestamp_sec,
      ts_fmt: curr.timestamp_formatted,
      flow,
      is_cut: isCut,
      flagged,
    });
  }

  const nonCut = pairResults.filter((p) => !p.is_cut);
  const flagged = pairResults.filter((p) => p.flagged);
  const peak =
    [...nonCut].sort((a, b) => b.flow.flow_divergence - a.flow.flow_divergence)[0] || pairResults[0];

  // Render real Optical Flow Vector & Divergence Visualization PNG on peak frame
  let overlayUrl: string | null = null;
  if (peak) {
    try {
      const f = ctx.frames[peak.to_idx];
      const meta = await sharp(f.file_path).metadata();
      const outW = meta.width || 640;
      const outH = meta.height || 360;
      const cellW = outW / Math.max(1, peak.flow.cols);
      const cellH = outH / Math.max(1, peak.flow.rows);

      const lines: string[] = [];
      for (const v of peak.flow.vectors) {
        if (v.mag < 0.8) continue;
        const x1 = Math.round((v.bx + 0.5) * cellW);
        const y1 = Math.round((v.by + 0.5) * cellH);
        const x2 = Math.round(x1 + v.dx * 4.5);
        const y2 = Math.round(y1 + v.dy * 4.5);
        const color = v.mag > 3.2 ? '#D15B5B' : '#E5A93B';
        lines.push(
          `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5" opacity="0.85"/>` +
            `<circle cx="${x2}" cy="${y2}" r="1.8" fill="${color}"/>`
        );
      }

      const svg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">
        ${lines.join('')}
        <rect x="10" y="10" width="340" height="24" fill="rgba(11,12,14,0.82)"/>
        <text x="18" y="26" fill="#E5A93B" font-family="monospace" font-size="11">L6 OPTICAL FLOW @ ${peak.ts_fmt} | DIV ${peak.flow.flow_divergence}px</text>
      </svg>`;

      const outPath = path.join(ctx.deriv_dir, 'layer6_optical_flow.png');
      await sharp(f.file_path)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toFile(outPath);
      overlayUrl = `/derivatives/${ctx.evidence_id}/layer6_optical_flow.png`;
    } catch {
      overlayUrl = null;
    }
  }

  const avgDiv =
    nonCut.length > 0
      ? Number((nonCut.reduce((s, p) => s + p.flow.flow_divergence, 0) / nonCut.length).toFixed(2))
      : 0;

  const hasMotionAnomaly = flagged.length > 0;
  const title = hasMotionAnomaly
    ? `${flagged.length} optical-flow divergence or illumination asymmetry interval(s) flagged`
    : `Optical flow field coherent across ${nonCut.length} intra-scene frame transition(s)`;

  const fid = insertFinding({
    investigation_id: ctx.investigation_id,
    evidence_id: ctx.evidence_id,
    module: 'VIDEO_FORENSICS',
    analysis_layer: layerId,
    finding_type: hasMotionAnomaly ? 'OPTICAL_FLOW_DIVERGENCE' : 'OPTICAL_FLOW_BASELINE',
    title,
    description: `Block-matching optical flow evaluated ${nonCut.length} intra-scene transitions. Mean vector divergence: ${avgDiv} px/block; peak divergence: ${peak.flow.flow_divergence} px at ${peak.ts_fmt}; peak illumination asymmetry: ${peak.flow.lighting_asymmetry}.`,
    actual_observation: `${flagged.length} flagged intervals; mean flow divergence ${avgDiv} px; peak lighting asymmetry ${peak.flow.lighting_asymmetry}.`,
    evidence_reference: ref,
    timestamp_or_region: hasMotionAnomaly
      ? flagged.slice(0, 5).map((p) => p.ts_fmt).join(', ')
      : `00:00.00 - ${ctx.frames[ctx.frames.length - 1].timestamp_formatted}`,
    start_timestamp: peak.ts,
    end_timestamp: peak.ts,
    frame_reference: `Frame #${peak.from_idx + 1} -> #${peak.to_idx + 1}`,
    analysis_category: 'STATISTICAL_HEURISTIC',
    evidence_strength: 'LOW',
    uncertainty: hasMotionAnomaly ? 'REQUIRES_HUMAN_REVIEW' : 'NONE',
    limitations:
      'Coarse interval block-matching optical flow cannot reliably separate complex multi-object motion, parallax, water/foliage movement, or handheld shake from synthetic motion morphing.',
    alternative_explanation:
      'Normal independent movement of multiple subjects, camera zoom/parallax, passing shadows, or rapid handheld camera movement.',
  });

  const markers: VideoTimelineMarkerInternal[] = flagged.slice(0, 6).map((p) => ({
    id: `MK-L6-${p.to_idx}`,
    timestamp_sec: p.ts,
    timestamp_formatted: p.ts_fmt,
    marker_type: 'MOTION',
    layer_id: layerId,
    finding_id: fid,
    frame_index: p.to_idx,
    title: 'Optical-flow motion / lighting divergence',
    detail: `Flow divergence ${p.flow.flow_divergence} px, lighting asymmetry ${p.flow.lighting_asymmetry}.`,
    severity: 'REVIEW',
  }));

  return {
    layer_number: 6,
    layer_id: layerId,
    layer_name: layerName,
    status: hasMotionAnomaly ? 'REQUIRES_REVIEW' : 'COMPLETED',
    processing_status: 'COMPLETED',
    summary: hasMotionAnomaly
      ? `${flagged.length} motion-vector divergence or shadow/lighting shift interval(s) require review.`
      : `Coherent motion vectors across ${nonCut.length} intra-scene transitions (mean divergence ${avgDiv} px).`,
    actual_result: `Transitions: ${nonCut.length} · Mean divergence: ${avgDiv} px · Peak: ${peak.flow.flow_divergence} px @ ${peak.ts_fmt}`,
    evidence_strength: 'LOW',
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps: flagged.slice(0, 5).map((p) => ({
      start_sec: p.ts,
      label: `${p.ts_fmt} (div ${p.flow.flow_divergence}px)`,
    })),
    evidence_references: [ref, `Frame #${peak.from_idx + 1} -> #${peak.to_idx + 1}`],
    explanation:
      'Estimates block-matching optical flow vectors and regional luminance balance across consecutive frames to surface sudden motion warps or shadow/illumination shifts.',
    limitations:
      'Normal multi-object movement, camera pans/zooms, lighting flashes, and compression artifacts produce elevated optical flow divergence.',
    alternative_explanation:
      'Natural multi-subject motion, camera parallax, passing clouds/headlights, or rolling-shutter motion.',
    overlay_url: overlayUrl,
    overlay_caption: `Optical Flow Vector Overlay — Frame #${peak.from_idx + 1} -> #${peak.to_idx + 1} (${peak.ts_fmt})`,
    metrics: {
      transitions_analyzed: nonCut.length,
      mean_divergence_px: avgDiv,
      peak_divergence_px: peak.flow.flow_divergence,
      peak_lighting_asymmetry: peak.flow.lighting_asymmetry,
      flagged_intervals: flagged.length,
    },
    finding_ids: [fid],
    finding_refs: [
      {
        finding_id: fid,
        layer_id: layerId,
        layer_name: layerName,
        title,
        strength: 'LOW',
        uncertainty: hasMotionAnomaly ? 'REQUIRES_HUMAN_REVIEW' : 'NONE',
        finding_type: hasMotionAnomaly ? 'OPTICAL_FLOW_DIVERGENCE' : 'OPTICAL_FLOW_BASELINE',
        is_anomalous: hasMotionAnomaly,
        category_tag: hasMotionAnomaly ? 'AI_GEN' : 'BASELINE',
      },
    ],
    timeline_markers: markers,
  };
}

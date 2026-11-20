import path from 'path';
import sharp from 'sharp';
import { insertFinding } from '../../db.ts';
import type {
  VideoAnalysisContext,
  VideoLayerFindingRef,
  VideoLayerOutput,
  VideoTimelineMarkerInternal,
} from './types.ts';

export async function runFacialMotionLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_2_FACIAL_MOTION';
  const layerName = 'Layer 2 — Facial Movement & Landmark Consistency';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  const validIndices: number[] = [];
  for (let i = 0; i < ctx.frames.length; i++) {
    if (ctx.face_detections[i]) validIndices.push(i);
  }

  if (validIndices.length < 2) {
    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'INSUFFICIENT_FACE_TRACK',
      title: 'Insufficient consecutive facial detections for motion tracking',
      description: `Only ${validIndices.length} sampled frame(s) contained a localized face region. Cross-frame eye, mouth, and head landmark trajectory analysis requires at least 2 tracked frames.`,
      actual_observation: `${validIndices.length}/${ctx.frames.length} frames tracked.`,
      evidence_reference: ref,
      timestamp_or_region: 'Full Video',
      frame_reference: `${validIndices.length}/${ctx.frames.length} frames`,
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'INSUFFICIENT_DATA',
      limitations:
        'Rapid camera motion, occlusions, low light, or scenes without visible faces prevent continuous facial landmark tracking.',
      alternative_explanation: 'Scene contains no sustained frontal facial subject.',
    });

    return {
      layer_number: 2,
      layer_id: layerId,
      layer_name: layerName,
      status: 'REQUIRES_REVIEW',
      processing_status: 'COMPLETED',
      summary: 'Insufficient tracked face frames to compute landmark trajectories.',
      actual_result: `Tracked faces in ${validIndices.length} of ${ctx.frames.length} frames.`,
      evidence_strength: 'LOW',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation:
        'Facial movement tracking measures eye-line roll, mouth aperture shifts, and landmark jitter across consecutive frames.',
      limitations: 'Requires >= 2 frames with localized faces.',
      alternative_explanation: 'No persistent frontal face appears in the video.',
      overlay_url: null,
      overlay_caption: null,
      metrics: { tracked_frames: validIndices.length, anomalies: 0, lighting_blur_drops: 0 },
      finding_ids: [fid],
      finding_refs: [
        {
          finding_id: fid,
          layer_id: layerId,
          layer_name: layerName,
          title: 'Insufficient consecutive facial detections for motion tracking',
          strength: 'LOW',
          uncertainty: 'INSUFFICIENT_DATA',
          finding_type: 'INSUFFICIENT_FACE_TRACK',
          is_anomalous: false,
          category_tag: 'UNCERTAIN',
        },
      ],
      timeline_markers: [],
    };
  }

  // Analyze consecutive tracked pairs (excluding known scene cuts)
  let totalHeadJitter = 0;
  let totalMouthDelta = 0;
  let totalEyeShift = 0;
  let pairCount = 0;
  let lowQualityTrackingDrops = 0;
  const jitterSpikes: Array<{
    frameIdx: number;
    ts: number;
    tsFmt: string;
    shiftPct: number;
    rollDelta: number;
    causedByBlurOrLight: boolean;
  }> = [];

  for (let k = 1; k < validIndices.length; k++) {
    const prevIdx = validIndices[k - 1];
    const currIdx = validIndices[k];
    if (currIdx - prevIdx > 2) continue; // skip wide gaps

    const fPrev = ctx.frames[prevIdx];
    const fCurr = ctx.frames[currIdx];
    if (fCurr.is_scene_change) continue;

    const dPrev = ctx.face_detections[prevIdx]!;
    const dCurr = ctx.face_detections[currIdx]!;

    const cxPrev = dPrev.bbox.x + dPrev.bbox.w / 2;
    const cyPrev = dPrev.bbox.y + dPrev.bbox.h / 2;
    const cxCurr = dCurr.bbox.x + dCurr.bbox.w / 2;
    const cyCurr = dCurr.bbox.y + dCurr.bbox.h / 2;

    const headDisp = Math.hypot(cxCurr - cxPrev, cyCurr - cyPrev) / Math.max(1, fCurr.width);
    const rollDelta = Math.abs(dCurr.roll_deg - dPrev.roll_deg);
    const mouthDelta = Math.abs(dCurr.mouth.openness - dPrev.mouth.openness);
    const eyeDarkDelta =
      Math.abs(dCurr.left_eye.darkness - dPrev.left_eye.darkness) +
      Math.abs(dCurr.right_eye.darkness - dPrev.right_eye.darkness);

    totalHeadJitter += headDisp;
    totalMouthDelta += mouthDelta;
    totalEyeShift += eyeDarkDelta;
    pairCount++;

    const poorLightOrBlur = fCurr.mean_luma < 45 || fCurr.sharpness_laplacian < 3.5;
    if (headDisp > 0.16 || rollDelta > 16) {
      if (poorLightOrBlur) lowQualityTrackingDrops++;
      jitterSpikes.push({
        frameIdx: currIdx,
        ts: fCurr.timestamp_sec,
        tsFmt: fCurr.timestamp_formatted,
        shiftPct: Number((headDisp * 100).toFixed(1)),
        rollDelta: Number(rollDelta.toFixed(1)),
        causedByBlurOrLight: poorLightOrBlur,
      });
    }
  }

  const avgHeadDisp = pairCount > 0 ? totalHeadDisp(totalHeadJitter, pairCount) : 0;
  const avgMouthDelta = pairCount > 0 ? Number((totalMouthDelta / pairCount).toFixed(3)) : 0;
  const avgEyeShift = pairCount > 0 ? Number((totalEyeShift / pairCount).toFixed(3)) : 0;

  const nonBlurSpikes = jitterSpikes.filter((s) => !s.causedByBlurOrLight);
  const peakIdx = nonBlurSpikes.length > 0 ? nonBlurSpikes[0].frameIdx : validIndices[0];
  const peakFrame = ctx.frames[peakIdx];
  const peakFace = ctx.face_detections[peakIdx]!;

  // Render annotated facial landmark overlay PNG on the representative/anomalous frame
  let overlayUrl: string | null = null;
  try {
    const meta = await sharp(peakFrame.file_path).metadata();
    const outW = meta.width || 640;
    const outH = meta.height || 360;
    const sx = outW / peakFrame.width;
    const sy = outH / peakFrame.height;

    const pts = [
      { label: 'L-EYE', x: Math.round(peakFace.left_eye.x * sx), y: Math.round(peakFace.left_eye.y * sy), color: '#4C9A73' },
      { label: 'R-EYE', x: Math.round(peakFace.right_eye.x * sx), y: Math.round(peakFace.right_eye.y * sy), color: '#4C9A73' },
      { label: 'NOSE', x: Math.round(peakFace.nose.x * sx), y: Math.round(peakFace.nose.y * sy), color: '#5B8EC9' },
      { label: 'MOUTH', x: Math.round(peakFace.mouth.x * sx), y: Math.round(peakFace.mouth.y * sy), color: '#E5A93B' },
    ];

    const svg = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${pts[0].x}" y1="${pts[0].y}" x2="${pts[1].x}" y2="${pts[1].y}" stroke="#4C9A73" stroke-width="1.5"/>
      <line x1="${pts[0].x}" y1="${pts[0].y}" x2="${pts[2].x}" y2="${pts[2].y}" stroke="#5B8EC9" stroke-width="1" stroke-dasharray="3 3"/>
      <line x1="${pts[1].x}" y1="${pts[1].y}" x2="${pts[2].x}" y2="${pts[2].y}" stroke="#5B8EC9" stroke-width="1" stroke-dasharray="3 3"/>
      <line x1="${pts[2].x}" y1="${pts[2].y}" x2="${pts[3].x}" y2="${pts[3].y}" stroke="#E5A93B" stroke-width="1.2"/>
      ${pts
        .map(
          (p) =>
            `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="#0B0C0E" stroke="${p.color}" stroke-width="2"/>
             <text x="${p.x + 7}" y="${p.y + 3}" fill="${p.color}" font-family="monospace" font-size="10">${p.label}</text>`
        )
        .join('')}
      <rect x="10" y="10" width="320" height="24" fill="rgba(11,12,14,0.82)"/>
      <text x="18" y="26" fill="#F2F0EB" font-family="monospace" font-size="11">L2 LANDMARKS @ ${peakFrame.timestamp_formatted} | ROLL ${peakFace.roll_deg}deg</text>
    </svg>`;

    const outPath = path.join(ctx.deriv_dir, 'layer2_landmarks_overlay.png');
    await sharp(peakFrame.file_path)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toFile(outPath);
    overlayUrl = `/derivatives/${ctx.evidence_id}/layer2_landmarks_overlay.png`;
  } catch {
    overlayUrl = null;
  }

  const hasInstability = nonBlurSpikes.length > 0;
  const findingIds: string[] = [];
  const findingRefs: VideoLayerFindingRef[] = [];
  const markers: VideoTimelineMarkerInternal[] = [];

  const title = hasInstability
    ? `${nonBlurSpikes.length} facial landmark trajectory jump(s) detected in clear frames`
    : `Facial landmark tracking stable across ${validIndices.length} tracked frames`;

  const fid = insertFinding({
    investigation_id: ctx.investigation_id,
    evidence_id: ctx.evidence_id,
    module: 'VIDEO_FORENSICS',
    analysis_layer: layerId,
    finding_type: hasInstability ? 'FACIAL_LANDMARK_INSTABILITY' : 'FACIAL_MOTION_STABLE',
    title,
    description: `Tracked eye, nose, mouth, and head roll anchors across ${pairCount} frame transitions. Mean head displacement: ${(avgHeadDisp * 100).toFixed(1)}% frame width; mean mouth aperture delta: ${avgMouthDelta}; eye luminance activity: ${avgEyeShift}. ${nonBlurSpikes.length} clear-frame spike(s) and ${lowQualityTrackingDrops} blur/low-light tracking drop(s) observed.`,
    actual_observation: `${nonBlurSpikes.length} non-blur trajectory spikes; ${lowQualityTrackingDrops} blur/lighting tracking drops; avg mouth delta ${avgMouthDelta}.`,
    evidence_reference: ref,
    timestamp_or_region:
      nonBlurSpikes.length > 0
        ? nonBlurSpikes.map((s) => s.tsFmt).join(', ')
        : `Tracked ${validIndices.length} frames`,
    start_timestamp: peakFrame.timestamp_sec,
    end_timestamp: peakFrame.timestamp_sec,
    frame_reference: `Frame #${peakFrame.index + 1} (${peakFrame.timestamp_formatted})`,
    analysis_category: 'STATISTICAL_HEURISTIC',
    evidence_strength: hasInstability ? 'MODERATE' : 'LOW',
    uncertainty: hasInstability ? 'REQUIRES_HUMAN_REVIEW' : 'NONE',
    limitations:
      'Interval-sampled frames (rather than 30fps dense tracking) can exaggerate fast head turns, occlusions by hands/hair, or sudden camera pans.',
    alternative_explanation:
      'Rapid head turn, subject leaving/entering frame, temporary hand occlusion, or handheld camera shake.',
  });

  findingIds.push(fid);
  findingRefs.push({
    finding_id: fid,
    layer_id: layerId,
    layer_name: layerName,
    title,
    strength: hasInstability ? 'MODERATE' : 'LOW',
    uncertainty: hasInstability ? 'REQUIRES_HUMAN_REVIEW' : 'NONE',
    finding_type: hasInstability ? 'FACIAL_LANDMARK_INSTABILITY' : 'FACIAL_MOTION_STABLE',
    is_anomalous: hasInstability,
    category_tag: hasInstability ? 'AI_MANIP' : 'BASELINE',
  });

  for (const sp of nonBlurSpikes.slice(0, 6)) {
    markers.push({
      id: `MK-L2-${sp.frameIdx}`,
      timestamp_sec: sp.ts,
      timestamp_formatted: sp.tsFmt,
      marker_type: 'FACIAL',
      layer_id: layerId,
      finding_id: fid,
      frame_index: sp.frameIdx,
      title: 'Facial landmark trajectory jump',
      detail: `Head center shifted ${sp.shiftPct}% with ${sp.rollDelta}° eye-line roll shift.`,
      severity: 'REVIEW',
    });
  }

  return {
    layer_number: 2,
    layer_id: layerId,
    layer_name: layerName,
    status: hasInstability ? 'REQUIRES_REVIEW' : 'COMPLETED',
    processing_status: 'COMPLETED',
    summary: hasInstability
      ? `${nonBlurSpikes.length} sudden landmark displacement(s) flagged (excluding ${lowQualityTrackingDrops} low-light/blur drops).`
      : `Consistent facial movement trajectory across ${validIndices.length} tracked frames.`,
    actual_result: `Tracked: ${validIndices.length} frames · Clear-frame spikes: ${nonBlurSpikes.length} · Blur/lighting drops: ${lowQualityTrackingDrops} · Mouth activity: ${avgMouthDelta}`,
    evidence_strength: hasInstability ? 'MODERATE' : 'LOW',
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps: nonBlurSpikes.slice(0, 6).map((s) => ({
      start_sec: s.ts,
      label: `${s.tsFmt} (shift ${s.shiftPct}%)`,
    })),
    evidence_references: [ref, `Frame #${peakFrame.index + 1}`],
    explanation:
      'Monitors eye, nose, mouth, and head-roll anchor continuity across consecutive sampled frames while filtering out frames affected by low luminance or motion blur.',
    limitations:
      'Coarse temporal sampling and classical landmark localization are sensitive to occlusions, profile turns, and multi-person scenes.',
    alternative_explanation:
      'Natural fast head movements, camera cuts between angles, or brief foreground occlusion.',
    overlay_url: overlayUrl,
    overlay_caption: `Frame #${peakFrame.index + 1} (${peakFrame.timestamp_formatted}) — Anatomical eye-line, nose bridge, and mouth anchor tracking overlay`,
    metrics: {
      tracked_frames: validIndices.length,
      transitions_analyzed: pairCount,
      avg_head_displacement_pct: Number((avgHeadDisp * 100).toFixed(2)),
      avg_mouth_aperture_delta: avgMouthDelta,
      avg_eye_activity: avgEyeShift,
      clear_frame_spikes: nonBlurSpikes.length,
      blur_or_lighting_drops: lowQualityTrackingDrops,
    },
    finding_ids: findingIds,
    finding_refs: findingRefs,
    timeline_markers: markers,
  };
}

function totalHeadDisp(sum: number, count: number): number {
  return count > 0 ? sum / count : 0;
}

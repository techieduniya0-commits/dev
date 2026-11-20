import path from 'path';
import sharp from 'sharp';
import { insertFinding } from '../../db.ts';
import type {
  DecodedFrame,
  FaceLandmarks,
  VideoAnalysisContext,
  VideoLayerFindingRef,
  VideoLayerOutput,
  VideoTimelineMarkerInternal,
} from './types.ts';

/**
 * Real pixel-level face/skin-region localization using YCbCr chrominance segmentation
 * combined with anatomical aspect-ratio filtering and upper-third eye-band / lower-third
 * mouth-crease luminance structure verification.
 */
export function detectFaceInFrame(frame: DecodedFrame): FaceLandmarks | null {
  const { width: w, height: h, rgb, gray } = frame;
  if (w < 40 || h < 40) return null;

  const skinMask = new Uint8Array(w * h);
  let totalSkin = 0;

  for (let i = 0; i < w * h; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];

    // Standard ITU-R BT.601 YCbCr skin-tone cluster
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

    if (y > 42 && y < 240 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 175 && r > g && r > b) {
      skinMask[i] = 1;
      totalSkin++;
    }
  }

  // Must have between 1.5% and 65% skin pixels to represent a plausible portrait/face region
  const globalSkinRatio = totalSkin / (w * h);
  if (globalSkinRatio < 0.015 || globalSkinRatio > 0.65) {
    return null;
  }

  // 2D connected component flood-fill (4-connected) to find all coherent skin face clusters
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const candidateBoxes: Array<{ x0: number; y0: number; x1: number; y1: number; area: number }> = [];

  for (let y = 2; y < h - 2; y += 2) {
    for (let x = 2; x < w - 2; x += 2) {
      const start = y * w + x;
      if (!skinMask[start] || visited[start]) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let count = 0;

      while (head < tail) {
        const idx = queue[head++];
        const cx = idx % w;
        const cy = (idx - cx) / w;
        count++;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        if (cx > 0 && skinMask[idx - 1] && !visited[idx - 1]) {
          visited[idx - 1] = 1;
          queue[tail++] = idx - 1;
        }
        if (cx < w - 1 && skinMask[idx + 1] && !visited[idx + 1]) {
          visited[idx + 1] = 1;
          queue[tail++] = idx + 1;
        }
        if (cy > 0 && skinMask[idx - w] && !visited[idx - w]) {
          visited[idx - w] = 1;
          queue[tail++] = idx - w;
        }
        if (cy < h - 1 && skinMask[idx + w] && !visited[idx + w]) {
          visited[idx + w] = 1;
          queue[tail++] = idx + w;
        }
      }

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspect = bw / Math.max(1, bh);
      const fillRatio = count / Math.max(1, bw * bh);

      // Plausible facial geometry constraints
      if (
        bw >= Math.max(16, w * 0.08) &&
        bh >= Math.max(18, h * 0.13) &&
        aspect >= 0.45 &&
        aspect <= 1.65 &&
        fillRatio >= 0.28
      ) {
        candidateBoxes.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, area: count });
      }
    }
  }

  if (candidateBoxes.length === 0) return null;
  candidateBoxes.sort((a, b) => b.area - a.area);
  const bestBox = candidateBoxes[0];
  const secondaryBoxes = candidateBoxes.slice(1, 5).map((b) => ({
    x: b.x0,
    y: b.y0,
    w: b.x1 - b.x0 + 1,
    h: b.y1 - b.y0 + 1,
  }));

  const bx = bestBox.x0;
  const by = bestBox.y0;
  const bw = bestBox.x1 - bestBox.x0 + 1;
  const bh = bestBox.y1 - bestBox.y0 + 1;
  const skinRatio = bestBox.area / Math.max(1, bw * bh);

  // Locate anatomical landmark anchors using local luminance minima inside expected facial bands
  const findDarkestAnchor = (rx0: number, ry0: number, rx1: number, ry1: number) => {
    const xStart = Math.max(0, Math.floor(bx + bw * rx0));
    const xEnd = Math.min(w - 1, Math.ceil(bx + bw * rx1));
    const yStart = Math.max(0, Math.floor(by + bh * ry0));
    const yEnd = Math.min(h - 1, Math.ceil(by + bh * ry1));

    let minVal = 255;
    let meanVal = 0;
    let cnt = 0;
    let bestX = Math.round((xStart + xEnd) / 2);
    let bestY = Math.round((yStart + yEnd) / 2);

    for (let yy = yStart; yy <= yEnd; yy++) {
      for (let xx = xStart; xx <= xEnd; xx++) {
        const g = gray[yy * w + xx];
        meanVal += g;
        cnt++;
        if (g < minVal) {
          minVal = g;
          bestX = xx;
          bestY = yy;
        }
      }
    }
    const avg = cnt > 0 ? meanVal / cnt : 128;
    const darkness = Math.max(0, (avg - minVal) / Math.max(1, avg));
    return { x: bestX, y: bestY, darkness };
  };

  const leftEye = findDarkestAnchor(0.16, 0.22, 0.45, 0.46);
  const rightEye = findDarkestAnchor(0.55, 0.22, 0.84, 0.46);
  const mouthAnchor = findDarkestAnchor(0.28, 0.64, 0.72, 0.88);

  // Measure mouth vertical aperture from horizontal luminance depression band
  const mx0 = Math.max(0, Math.floor(bx + bw * 0.28));
  const mx1 = Math.min(w - 1, Math.ceil(bx + bw * 0.72));
  const my0 = Math.max(0, Math.floor(by + bh * 0.64));
  const my1 = Math.min(h - 1, Math.ceil(by + bh * 0.88));
  let mouthDarkRows = 0;
  let mouthBandMean = 0;
  let mouthPixels = 0;
  for (let yy = my0; yy <= my1; yy++) {
    for (let xx = mx0; xx <= mx1; xx++) {
      mouthBandMean += gray[yy * w + xx];
      mouthPixels++;
    }
  }
  const mAvg = mouthPixels > 0 ? mouthBandMean / mouthPixels : 128;
  for (let yy = my0; yy <= my1; yy++) {
    let rowMean = 0;
    let rc = 0;
    for (let xx = mx0; xx <= mx1; xx++) {
      rowMean += gray[yy * w + xx];
      rc++;
    }
    if (rc > 0 && rowMean / rc < mAvg * 0.84) {
      mouthDarkRows++;
    }
  }

  const eyeContrast = (leftEye.darkness + rightEye.darkness) / 2;
  // Require at least mild structural contrast so flat orange walls aren't mistaken for faces
  if (eyeContrast < 0.08 && mouthAnchor.darkness < 0.08) {
    return null;
  }

  const dx = Math.max(1, rightEye.x - leftEye.x);
  const dy = rightEye.y - leftEye.y;
  const rollDeg = Number(((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(2));
  const mouthOpenness = Number((mouthDarkRows / Math.max(1, my1 - my0 + 1)).toFixed(3));

  return {
    bbox: { x: bx, y: by, w: bw, h: bh },
    left_eye: leftEye,
    right_eye: rightEye,
    nose: { x: Math.round(bx + bw * 0.5), y: Math.round(by + bh * 0.54) },
    mouth: {
      x: mouthAnchor.x,
      y: mouthAnchor.y,
      w: Math.max(4, mx1 - mx0),
      h: Math.max(3, my1 - my0),
      openness: mouthOpenness,
    },
    roll_deg: rollDeg,
    skin_ratio: Number(skinRatio.toFixed(3)),
    confidence: Number(Math.min(0.95, 0.4 + skinRatio * 0.35 + eyeContrast * 0.4).toFixed(2)),
    faces_count: 1 + secondaryBoxes.length,
    secondary_boxes: secondaryBoxes,
  };
}

function regionLaplacianMean(
  gray: Float32Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): number {
  let sum = 0;
  let cnt = 0;
  const xs = Math.max(1, x0);
  const ys = Math.max(1, y0);
  const xe = Math.min(w - 2, x1);
  const ye = Math.min(h - 2, y1);
  for (let y = ys; y <= ye; y++) {
    for (let x = xs; x <= xe; x++) {
      const lap = Math.abs(
        4 * gray[y * w + x] -
          gray[(y - 1) * w + x] -
          gray[(y + 1) * w + x] -
          gray[y * w + (x - 1)] -
          gray[y * w + (x + 1)]
      );
      sum += lap;
      cnt++;
    }
  }
  return cnt > 0 ? sum / cnt : 0;
}

export async function runFacialTextureLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_1_FACIAL_TEXTURE';
  const layerName = 'Layer 1 — Facial Texture & Blending Analysis';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  const detectedPairs: Array<{ frame: DecodedFrame; face: FaceLandmarks }> = [];
  for (let i = 0; i < ctx.frames.length; i++) {
    const face = ctx.face_detections[i];
    if (face) detectedPairs.push({ frame: ctx.frames[i], face });
  }

  if (detectedPairs.length === 0) {
    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'NO_FACE_REGION_DETECTED',
      title: 'No human facial region localized across sampled frames',
      description: `Chrominance and facial-structure localization scanned ${ctx.frames.length} sampled frames and found no candidate human face meeting size and anatomical contrast criteria. Facial texture and blending analysis could not be evaluated.`,
      actual_observation: `0/${ctx.frames.length} sampled frames contained a localized face candidate.`,
      evidence_reference: ref,
      timestamp_or_region: 'Full Video',
      frame_reference: `0/${ctx.frames.length} frames`,
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'INSUFFICIENT_DATA',
      limitations:
        'YCbCr skin-cluster + anatomical contrast localization may miss heavily occluded, extreme-profile, monochrome, heavily color-graded, or very small distant faces.',
      alternative_explanation:
        'Video does not feature close-up human faces (e.g., scenery, objects, synthetic test bars, or wide-angle crowd footage).',
    });

    return {
      layer_number: 1,
      layer_id: layerId,
      layer_name: layerName,
      status: 'REQUIRES_REVIEW',
      processing_status: 'COMPLETED',
      summary: 'No candidate human face localized in sampled frames.',
      actual_result: `0 of ${ctx.frames.length} frames yielded a detectable face region.`,
      evidence_strength: 'LOW',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation:
        'Facial texture and blending inspection requires a visible, sufficiently sized facial region. None met localization criteria across the sampled frames.',
      limitations:
        'Classical chrominance + anatomical contrast localization can miss dark lighting, non-frontal angles, or monochrome footage.',
      alternative_explanation:
        'Video contains no human subjects or faces are too small/occluded for texture analysis.',
      overlay_url: null,
      overlay_caption: null,
      metrics: {
        frames_scanned: ctx.frames.length,
        faces_detected_frames: 0,
      },
      finding_ids: [fid],
      finding_refs: [
        {
          finding_id: fid,
          layer_id: layerId,
          layer_name: layerName,
          title: 'No human facial region localized across sampled frames',
          strength: 'LOW',
          uncertainty: 'INSUFFICIENT_DATA',
          finding_type: 'NO_FACE_REGION_DETECTED',
          is_anomalous: false,
          category_tag: 'UNCERTAIN',
        },
      ],
      timeline_markers: [],
    };
  }

  // Analyze interior skin texture vs boundary halo vs background region
  const perFrameStats: Array<{
    frame: DecodedFrame;
    face: FaceLandmarks;
    interior_lap: number;
    boundary_lap: number;
    bg_lap: number;
    smoothness_ratio: number;
    boundary_spike: number;
  }> = [];

  for (const { frame, face } of detectedPairs) {
    const { x, y, w: bw, h: bh } = face.bbox;
    const padX = Math.max(4, Math.round(bw * 0.16));
    const padY = Math.max(4, Math.round(bh * 0.16));

    const interiorLap = regionLaplacianMean(
      frame.gray,
      frame.width,
      frame.height,
      x + padX,
      y + padY,
      x + bw - padX,
      y + bh - padY
    );

    const outerLap = regionLaplacianMean(
      frame.gray,
      frame.width,
      frame.height,
      Math.max(1, x - 6),
      Math.max(1, y - 6),
      Math.min(frame.width - 2, x + bw + 6),
      Math.min(frame.height - 2, y + bh + 6)
    );

    const bgLap = regionLaplacianMean(
      frame.gray,
      frame.width,
      frame.height,
      1,
      1,
      frame.width - 2,
      frame.height - 2
    );

    const smoothnessRatio = interiorLap / Math.max(0.5, bgLap);
    const boundarySpike = outerLap / Math.max(0.5, interiorLap);

    perFrameStats.push({
      frame,
      face,
      interior_lap: Number(interiorLap.toFixed(2)),
      boundary_lap: Number(outerLap.toFixed(2)),
      bg_lap: Number(bgLap.toFixed(2)),
      smoothness_ratio: Number(smoothnessRatio.toFixed(3)),
      boundary_spike: Number(boundarySpike.toFixed(3)),
    });
  }

  const avgSmoothness =
    perFrameStats.reduce((s, p) => s + p.smoothness_ratio, 0) / perFrameStats.length;
  const avgBoundarySpike =
    perFrameStats.reduce((s, p) => s + p.boundary_spike, 0) / perFrameStats.length;

  // Pick peak boundary-spike frame for visual overlay inspection
  const peak = [...perFrameStats].sort((a, b) => b.boundary_spike - a.boundary_spike)[0];

  // Generate real visual inspection overlay PNG with face bounding box, halo ring, and landmark crosshairs
  let overlayUrl: string | null = null;
  try {
    const srcMeta = await sharp(peak.frame.file_path).metadata();
    const outW = srcMeta.width || 640;
    const outH = srcMeta.height || 360;
    const sx = outW / peak.frame.width;
    const sy = outH / peak.frame.height;

    const bx = Math.round(peak.face.bbox.x * sx);
    const by = Math.round(peak.face.bbox.y * sy);
    const bw = Math.round(peak.face.bbox.w * sx);
    const bh = Math.round(peak.face.bbox.h * sy);

    const lx = Math.round(peak.face.left_eye.x * sx);
    const ly = Math.round(peak.face.left_eye.y * sy);
    const rx = Math.round(peak.face.right_eye.x * sx);
    const ry = Math.round(peak.face.right_eye.y * sy);
    const nx = Math.round(peak.face.nose.x * sx);
    const ny = Math.round(peak.face.nose.y * sy);
    const mx = Math.round(peak.face.mouth.x * sx);
    const my = Math.round(peak.face.mouth.y * sy);

    const secRects = (peak.face.secondary_boxes || [])
      .map(
        (sb) =>
          `<rect x="${Math.round(sb.x * sx)}" y="${Math.round(sb.y * sy)}" width="${Math.round(sb.w * sx)}" height="${Math.round(sb.h * sy)}" fill="rgba(91,142,201,0.08)" stroke="#5B8EC9" stroke-width="1.5" stroke-dasharray="4 3"/>`
      )
      .join('');

    const svgOverlay = `<svg width="${outW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">
      ${secRects}
      <rect x="${Math.max(2, bx - 10)}" y="${Math.max(2, by - 10)}" width="${bw + 20}" height="${bh + 20}" fill="none" stroke="#D15B5B" stroke-width="1.5" stroke-dasharray="5 4"/>
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="rgba(229,169,59,0.08)" stroke="#E5A93B" stroke-width="2"/>
      <circle cx="${lx}" cy="${ly}" r="5" fill="none" stroke="#4C9A73" stroke-width="1.8"/>
      <circle cx="${rx}" cy="${ry}" r="5" fill="none" stroke="#4C9A73" stroke-width="1.8"/>
      <line x1="${lx}" y1="${ly}" x2="${rx}" y2="${ry}" stroke="#4C9A73" stroke-width="1" stroke-dasharray="3 2"/>
      <circle cx="${nx}" cy="${ny}" r="3" fill="#5B8EC9"/>
      <rect x="${Math.round(bx + bw * 0.28)}" y="${Math.round(by + bh * 0.64)}" width="${Math.round(bw * 0.44)}" height="${Math.round(bh * 0.24)}" fill="none" stroke="#5B8EC9" stroke-width="1.5"/>
      <circle cx="${mx}" cy="${my}" r="3.5" fill="#E5A93B"/>
      <rect x="10" y="10" width="320" height="24" fill="rgba(11,12,14,0.82)"/>
      <text x="18" y="26" fill="#E5A93B" font-family="monospace" font-size="11">L1 FACE ROI (${peak.face.faces_count || 1} subj) @ ${peak.frame.timestamp_formatted} | RATIO ${peak.boundary_spike.toFixed(2)}x</text>
    </svg>`;

    const overlayPath = path.join(ctx.deriv_dir, 'layer1_face_overlay.png');
    await sharp(peak.frame.file_path)
      .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
      .png()
      .toFile(overlayPath);

    overlayUrl = `/derivatives/${ctx.evidence_id}/layer1_face_overlay.png`;
  } catch {
    overlayUrl = null;
  }

  const elevatedBlending = avgBoundarySpike > 1.75 || avgSmoothness < 0.42;
  const findingIds: string[] = [];
  const findingRefs: VideoLayerFindingRef[] = [];
  const markers: VideoTimelineMarkerInternal[] = [];

  const title = elevatedBlending
    ? `Facial boundary/texture contrast disparity observed (${avgBoundarySpike.toFixed(2)}x boundary ratio)`
    : `Facial interior-to-boundary texture ratio within typical baseline (${avgBoundarySpike.toFixed(2)}x)`;

  const fid = insertFinding({
    investigation_id: ctx.investigation_id,
    evidence_id: ctx.evidence_id,
    module: 'VIDEO_FORENSICS',
    analysis_layer: layerId,
    finding_type: elevatedBlending ? 'FACIAL_BLENDING_DISPARITY' : 'FACIAL_TEXTURE_BASELINE',
    title,
    description: `Localized facial regions across ${detectedPairs.length}/${ctx.frames.length} frames. Mean interior Laplacian sharpness: ${(perFrameStats.reduce((s, p) => s + p.interior_lap, 0) / perFrameStats.length).toFixed(2)}; interior-to-background ratio: ${avgSmoothness.toFixed(2)}; boundary halo gradient ratio: ${avgBoundarySpike.toFixed(2)}x (peak at ${peak.frame.timestamp_formatted}).`,
    actual_observation: `Boundary-to-interior ratio ${avgBoundarySpike.toFixed(2)}x, interior-to-background sharpness ratio ${avgSmoothness.toFixed(2)} across ${detectedPairs.length} frames.`,
    evidence_reference: ref,
    timestamp_or_region: `Peak Frame #${peak.frame.index + 1} (${peak.frame.timestamp_formatted})`,
    start_timestamp: peak.frame.timestamp_sec,
    end_timestamp: peak.frame.timestamp_sec,
    frame_reference: `Frame #${peak.frame.index + 1} (${peak.frame.timestamp_formatted})`,
    analysis_category: 'STATISTICAL_HEURISTIC',
    evidence_strength: elevatedBlending ? 'MODERATE' : 'LOW',
    uncertainty: elevatedBlending ? 'REQUIRES_HUMAN_REVIEW' : 'AMBIGUOUS',
    limitations:
      'Texture and boundary Laplacian comparisons are heuristic computer-vision measurements; ordinary studio lighting, beauty filters, shallow depth of field, and H.264 skin-smoothing quantization produce similar ratios.',
    alternative_explanation:
      'Camera autofocus bokeh separating sharp face from soft background, smartphone beauty/denoise filters, rim lighting, or strong video compression.',
  });

  findingIds.push(fid);
  findingRefs.push({
    finding_id: fid,
    layer_id: layerId,
    layer_name: layerName,
    title,
    strength: elevatedBlending ? 'MODERATE' : 'LOW',
    uncertainty: elevatedBlending ? 'REQUIRES_HUMAN_REVIEW' : 'AMBIGUOUS',
    finding_type: elevatedBlending ? 'FACIAL_BLENDING_DISPARITY' : 'FACIAL_TEXTURE_BASELINE',
    is_anomalous: elevatedBlending,
    category_tag: elevatedBlending ? 'AI_MANIP' : 'BASELINE',
  });

  if (elevatedBlending) {
    markers.push({
      id: `MK-L1-${peak.frame.index}`,
      timestamp_sec: peak.frame.timestamp_sec,
      timestamp_formatted: peak.frame.timestamp_formatted,
      marker_type: 'FACIAL',
      layer_id: layerId,
      finding_id: fid,
      frame_index: peak.frame.index,
      title: 'Facial boundary/texture disparity',
      detail: `Boundary ratio ${peak.boundary_spike.toFixed(2)}x, smoothness ratio ${peak.smoothness_ratio.toFixed(2)}.`,
      severity: 'REVIEW',
    });
  }

  return {
    layer_number: 1,
    layer_id: layerId,
    layer_name: layerName,
    status: elevatedBlending ? 'REQUIRES_REVIEW' : 'COMPLETED',
    processing_status: 'COMPLETED',
    summary: elevatedBlending
      ? `Elevated facial boundary-to-interior contrast (${avgBoundarySpike.toFixed(2)}x) flagged for visual inspection.`
      : `Localized face across ${detectedPairs.length} frames with uniform texture profile.`,
    actual_result: `Faces tracked: ${detectedPairs.length}/${ctx.frames.length} frames · Mean boundary ratio: ${avgBoundarySpike.toFixed(2)}x · Smoothness ratio: ${avgSmoothness.toFixed(2)}`,
    evidence_strength: elevatedBlending ? 'MODERATE' : 'LOW',
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps: [
      {
        start_sec: peak.frame.timestamp_sec,
        label: `Peak Frame #${peak.frame.index + 1} (${peak.frame.timestamp_formatted})`,
      },
    ],
    evidence_references: [ref, `Frame #${peak.frame.index + 1}`],
    explanation:
      'Compares high-frequency Laplacian texture inside the localized facial interior against the outer facial boundary halo and surrounding scene background to surface potential face-swap seams or over-smoothed skin regions.',
    limitations:
      'Ordinary lighting gradients, camera bokeh, beauty filters, and codec quantization produce boundary/texture ratios that overlap with manipulation artifacts. Never treat texture variance as standalone proof of AI.',
    alternative_explanation:
      'Shallow depth-of-field lens optics, harsh rim lighting, makeup, or mobile camera skin-smoothing pipelines.',
    overlay_url: overlayUrl,
    overlay_caption: `Frame #${peak.frame.index + 1} (${peak.frame.timestamp_formatted}) — Yellow: localized face ROI · Dashed red: blending boundary halo · Green: eye anchors · Blue: mouth ROI`,
    metrics: {
      frames_scanned: ctx.frames.length,
      faces_detected_frames: detectedPairs.length,
      max_faces_per_frame: Math.max(...detectedPairs.map((p) => p.face.faces_count || 1)),
      avg_smoothness_ratio: Number(avgSmoothness.toFixed(3)),
      avg_boundary_ratio: Number(avgBoundarySpike.toFixed(3)),
      peak_frame_index: peak.frame.index,
      peak_timestamp_sec: peak.frame.timestamp_sec,
    },
    finding_ids: findingIds,
    finding_refs: findingRefs,
    timeline_markers: markers,
  };
}

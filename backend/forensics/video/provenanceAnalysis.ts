import fs from 'fs';
import { insertFinding } from '../../db.ts';
import type {
  VideoAnalysisContext,
  VideoLayerFindingRef,
  VideoLayerOutput,
  VideoTimelineMarkerInternal,
} from './types.ts';

const AI_VIDEO_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'Runway', regex: /\brunway(?:\s*ml|\s*gen-[1234])?\b/i },
  { label: 'OpenAI Sora', regex: /\b(?:openai\s+)?sora\b/i },
  { label: 'Google Veo', regex: /\b(?:google\s+)?veo(?:\s*[23]|-?[23]|\s+ai)\b/i },
  { label: 'Kling AI', regex: /\bkling(?:\s*ai|\s*1\.\d)?\b/i },
  { label: 'Pika', regex: /\bpika(?:\s*labs|\s*art|\s*1\.\d|\s*2\.\d)?\b/i },
  { label: 'Luma Dream Machine', regex: /\b(?:luma\s+dream\s+machine|dream\s+machine|lumalabs)\b/i },
  { label: 'HeyGen', regex: /\bheygen\b/i },
  { label: 'Synthesia', regex: /\bsynthesia\b/i },
  { label: 'D-ID', regex: /\bd-id\b/i },
  { label: 'Hailuo / MiniMax', regex: /\bhailuo\b/i },
  { label: 'Midjourney', regex: /\bmidjourney\b/i },
  { label: 'Stable Video Diffusion', regex: /\bstable\s+video(?:\s+diffusion)?\b/i },
  { label: 'ComfyUI', regex: /\bcomfyui\b/i },
  { label: 'DeepFaceLab', regex: /\bdeepfacelab\b/i },
  { label: 'FaceSwap / Roop', regex: /\b(?:faceswap|roop|insightface)\b/i },
];

const NLE_EDITING_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: 'Adobe Premiere', regex: /\badobe\s+premiere\b/i },
  { label: 'After Effects', regex: /\bafter\s+effects\b/i },
  { label: 'DaVinci Resolve', regex: /\bdavinci\s+resolve\b/i },
  { label: 'Final Cut Pro', regex: /\bfinal\s+cut\b/i },
  { label: 'CapCut', regex: /\bcapcut\b/i },
  { label: 'iMovie', regex: /\bimovie\b/i },
  { label: 'HandBrake', regex: /\bhandbrake\b/i },
  { label: 'FFmpeg / Lavf', regex: /\b(?:lavf\d*|ffmpeg)\b/i },
  { label: 'OBS Studio', regex: /\bobs\s+studio\b/i },
  { label: 'Camtasia', regex: /\bcamtasia\b/i },
  { label: 'Kdenlive', regex: /\bkdenlive\b/i },
  { label: 'Shotcut', regex: /\bshotcut\b/i },
];

/**
 * Safely scans container headers & tails (read-only) for C2PA / Content Credentials JUMBF
 * signatures, XMP XML packets, and long printable metadata strings (excluding compressed media data).
 */
function scanContainerProvenanceBytes(filePath: string): {
  c2pa_box_found: boolean;
  xmp_packet_found: boolean;
  ai_markers_found: string[];
  nle_markers_found: string[];
} {
  const stat = fs.statSync(filePath);
  const chunkSize = Math.min(stat.size, 131072);
  const fd = fs.openSync(filePath, 'r');
  let combinedRaw = '';
  try {
    const head = Buffer.alloc(chunkSize);
    fs.readSync(fd, head, 0, chunkSize, 0);
    combinedRaw += head.toString('latin1');

    if (stat.size > chunkSize) {
      const tailSize = Math.min(stat.size - chunkSize, 131072);
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
      combinedRaw += '\n' + tail.toString('latin1');
    }
  } finally {
    fs.closeSync(fd);
  }

  const lower = combinedRaw.toLowerCase();
  const c2paBoxFound =
    lower.includes('c2pa.assertions') ||
    lower.includes('c2pa.actions') ||
    lower.includes('d8fec3d6-1b0e-483c-9297-582887cbec48') ||
    (lower.includes('jumb') && lower.includes('c2pa'));
  const xmpFound = lower.includes('<x:xmpmeta') || lower.includes('xmlns:xmp');

  // Extract only contiguous printable ASCII metadata runs (>= 10 chars) to avoid binary bitstream false positives
  const printableRuns = (combinedRaw.match(/[A-Za-z0-9_.:/\- ,()'"<>+=]{10,}/g) || []).join(' | ');

  const aiMarkers = AI_VIDEO_PATTERNS.filter((p) => p.regex.test(printableRuns)).map((p) => p.label);
  const nleMarkers = NLE_EDITING_PATTERNS.filter((p) => p.regex.test(printableRuns)).map((p) => p.label);

  return {
    c2pa_box_found: c2paBoxFound,
    xmp_packet_found: xmpFound,
    ai_markers_found: aiMarkers,
    nle_markers_found: nleMarkers,
  };
}

export async function runProvenanceAnalysisLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_7_PROVENANCE_METADATA';
  const layerName = 'Layer 7 — Metadata, Provenance & Watermark Inspection';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  const formatTags = ctx.probe_raw?.format?.tags || {};
  const streamTags = (ctx.probe_raw?.streams || []).reduce(
    (acc: Record<string, any>, s: any) => ({ ...acc, ...(s.tags || {}) }),
    {}
  );
  const allTags: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...formatTags, ...streamTags })) {
    if (v !== undefined && v !== null) allTags[k] = String(v);
  }

  const tagBlob = Object.entries(allTags)
    .map(([k, v]) => `${k}: ${v}`)
    .join(' | ');
  const byteScan = scanContainerProvenanceBytes(ctx.original_path);

  const aiMatches = Array.from(
    new Set([
      ...byteScan.ai_markers_found,
      ...AI_VIDEO_PATTERNS.filter((p) => p.regex.test(tagBlob)).map((p) => p.label),
    ])
  );
  const nleMatches = Array.from(
    new Set([
      ...byteScan.nle_markers_found,
      ...NLE_EDITING_PATTERNS.filter((p) => p.regex.test(tagBlob)).map((p) => p.label),
    ])
  );

  // Check container support for C2PA inspection
  const containerLower = ctx.format_name.toLowerCase();
  const c2paSupportedContainer =
    containerLower.includes('mp4') ||
    containerLower.includes('mov') ||
    containerLower.includes('m4v') ||
    containerLower.includes('avi');

  let provenanceStatus:
    | 'PRESENT_AND_VERIFIABLE'
    | 'PRESENT_BUT_UNVERIFIABLE'
    | 'MISSING'
    | 'UNSUPPORTED';

  let provenanceDetail = '';
  if (!c2paSupportedContainer) {
    provenanceStatus = 'UNSUPPORTED';
    provenanceDetail = `Container format "${ctx.format_name}" does not support standard ISO-BMFF/C2PA Content Credentials JUMBF inspection in this parser.`;
  } else if (byteScan.c2pa_box_found) {
    // Cryptographic X.509 signature validation requires c2patool which is not installed on host
    provenanceStatus = 'PRESENT_BUT_UNVERIFIABLE';
    provenanceDetail =
      'C2PA / Content Credentials JUMBF markers were detected inside container bytes, but cryptographic X.509 trust-chain verification requires c2patool (not installed in this container).';
  } else {
    provenanceStatus = 'MISSING';
    provenanceDetail =
      'No C2PA Content Credentials or cryptographic provenance manifest found in container headers. Missing provenance metadata is common across consumer cameras and social platforms and is NOT proof of manipulation.';
  }

  // Static corner overlay / watermark persistence check across frames
  let staticCornerScore = 0;
  if (ctx.frames.length >= 3) {
    const first = ctx.frames[0];
    const last = ctx.frames[ctx.frames.length - 1];
    const cw = Math.floor(first.width * 0.22);
    const ch = Math.floor(first.height * 0.14);
    const corners = [
      { x0: 0, y0: 0 },
      { x0: first.width - cw, y0: 0 },
      { x0: 0, y0: first.height - ch },
      { x0: first.width - cw, y0: first.height - ch },
    ];
    let bestStaticHighContrast = 0;
    for (const c of corners) {
      let diffSum = 0;
      let contrastSum = 0;
      let n = 0;
      for (let y = c.y0; y < c.y0 + ch - 1; y++) {
        for (let x = c.x0; x < c.x0 + cw - 1; x++) {
          const i = y * first.width + x;
          diffSum += Math.abs(first.gray[i] - last.gray[i]);
          contrastSum += Math.abs(first.gray[i] - first.gray[i + 1]);
          n++;
        }
      }
      const meanDiff = diffSum / Math.max(1, n);
      const meanContrast = contrastSum / Math.max(1, n);
      if (meanDiff < 2.2 && meanContrast > 14) {
        bestStaticHighContrast = Math.max(bestStaticHighContrast, meanContrast);
      }
    }
    staticCornerScore = Number(bestStaticHighContrast.toFixed(1));
  }

  const findingIds: string[] = [];
  const findingRefs: VideoLayerFindingRef[] = [];
  const markers: VideoTimelineMarkerInternal[] = [];

  // Primary Provenance Finding
  const hasAiSig = aiMatches.length > 0;
  const hasNleSig = nleMatches.length > 0;

  let title = `Content Credentials / Provenance: ${provenanceStatus.replace(/_/g, ' ')}`;
  if (hasAiSig) {
    title = `Known AI video generator metadata signature detected: ${aiMatches.join(', ')}`;
  } else if (hasNleSig) {
    title = `Video transcoding / editing software signature detected: ${nleMatches.join(', ')}`;
  }

  const strength: 'LOW' | 'MODERATE' | 'STRONG' = hasAiSig
    ? 'STRONG'
    : hasNleSig || byteScan.c2pa_box_found
      ? 'MODERATE'
      : 'LOW';

  const fid = insertFinding({
    investigation_id: ctx.investigation_id,
    evidence_id: ctx.evidence_id,
    module: 'VIDEO_FORENSICS',
    analysis_layer: layerId,
    finding_type: hasAiSig
      ? 'AI_GENERATOR_SIGNATURE'
      : hasNleSig
        ? 'EDITING_ENCODER_SIGNATURE'
        : 'PROVENANCE_STATUS_RECORDED',
    title,
    description: `${provenanceDetail} Codec: ${ctx.video_codec}; Encoder: ${ctx.encoder || 'none'}; Creation timestamp: ${ctx.creation_time || 'none'}; XMP packet: ${byteScan.xmp_packet_found ? 'present' : 'absent'}; Editing/transcoding signatures: [${nleMatches.join(', ') || 'none'}]; AI tool signatures: [${aiMatches.join(', ') || 'none'}].${staticCornerScore > 0 ? ` Static high-contrast corner overlay persistence detected (contrast ${staticCornerScore}) — may indicate channel logo, camera timestamp, or platform watermark.` : ''}`,
    actual_observation: `Provenance=${provenanceStatus}; AI signatures=[${aiMatches.join(', ') || 'none'}]; Editor/encoder=[${nleMatches.join(', ') || 'none'}].`,
    evidence_reference: ref,
    timestamp_or_region: ctx.creation_time ? `Container ${ctx.creation_time}` : 'Container Header',
    start_timestamp: 0,
    end_timestamp: 0,
    frame_reference: 'Container Metadata',
    analysis_category: 'DETERMINISTIC',
    evidence_strength: strength,
    uncertainty: hasAiSig || hasNleSig ? 'REQUIRES_HUMAN_REVIEW' : 'AMBIGUOUS',
    limitations:
      'Container metadata can be stripped, re-encoded, or modified by messaging apps and social platforms. Absence of C2PA credentials or camera tags NEVER proves manipulation. Cryptographic C2PA validation requires c2patool.',
    alternative_explanation:
      hasNleSig
        ? 'Benign re-encoding, trimming, compression, or export via standard video software (FFmpeg, Premiere, Resolve, CapCut) without deceptive manipulation.'
        : 'Most consumer smartphones and social platforms do not embed C2PA Content Credentials by default.',
  });

  findingIds.push(fid);
  findingRefs.push({
    finding_id: fid,
    layer_id: layerId,
    layer_name: layerName,
    title,
    strength,
    uncertainty: hasAiSig || hasNleSig ? 'REQUIRES_HUMAN_REVIEW' : 'AMBIGUOUS',
    finding_type: hasAiSig
      ? 'AI_GENERATOR_SIGNATURE'
      : hasNleSig
        ? 'EDITING_ENCODER_SIGNATURE'
        : 'PROVENANCE_STATUS_RECORDED',
    is_anomalous: hasAiSig || hasNleSig,
    category_tag: hasAiSig ? 'AI_GEN' : hasNleSig ? 'CONVENTIONAL_EDIT' : 'BASELINE',
  });

  if (hasAiSig || hasNleSig) {
    markers.push({
      id: 'MK-L7-META',
      timestamp_sec: 0,
      timestamp_formatted: '00:00.00',
      marker_type: 'METADATA',
      layer_id: layerId,
      finding_id: fid,
      frame_index: 0,
      title: hasAiSig
        ? `AI signature in metadata (${aiMatches[0]})`
        : `Editing/transcoding encoder (${nleMatches[0]})`,
      detail: `Provenance status: ${provenanceStatus}. Encoder: ${ctx.encoder || 'none'}.`,
      severity: hasAiSig ? 'ELEVATED' : 'REVIEW',
    });
  }

  return {
    layer_number: 7,
    layer_id: layerId,
    layer_name: layerName,
    status: hasAiSig || hasNleSig ? 'REQUIRES_REVIEW' : 'COMPLETED',
    processing_status: 'COMPLETED',
    summary: hasAiSig
      ? `AI generator signature (${aiMatches.join(', ')}) found in container metadata.`
      : hasNleSig
        ? `Editing/transcoding software (${nleMatches.join(', ')}) detected; C2PA provenance: ${provenanceStatus.replace(/_/g, ' ')}.`
        : `Provenance status: ${provenanceStatus.replace(/_/g, ' ')}. No AI generator tags found.`,
    actual_result: `Provenance: ${provenanceStatus} · Codec: ${ctx.video_codec} · Encoder: ${ctx.encoder || 'None'} · XMP: ${byteScan.xmp_packet_found ? 'Present' : 'Absent'}`,
    evidence_strength: strength,
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps: ctx.creation_time
      ? [{ start_sec: 0, label: `Container creation_time: ${ctx.creation_time}` }]
      : [],
    evidence_references: [ref, 'Container Header & Tail Scan'],
    explanation:
      'Inspects FFprobe stream/format tags and scans container headers/tails for ISO-BMFF C2PA Content Credentials, XMP packets, editing-software encoders, AI generator markers, and persistent corner watermarks.',
    limitations:
      'Missing C2PA or creation metadata is normal for most consumer cameras and social media re-uploads and does not prove fabrication. Cryptographic C2PA validation requires c2patool.',
    alternative_explanation:
      'Routine platform re-compression, trimming, or standard camera recording without C2PA hardware signing.',
    metrics: {
      provenance_status: provenanceStatus,
      codec: ctx.video_codec,
      encoder: ctx.encoder,
      creation_time: ctx.creation_time,
      c2pa_box_found: byteScan.c2pa_box_found,
      xmp_packet_found: byteScan.xmp_packet_found,
      ai_signatures: aiMatches,
      editing_signatures: nleMatches,
      static_corner_overlay_score: staticCornerScore,
      all_tags: allTags,
    },
    finding_ids: findingIds,
    finding_refs: findingRefs,
    timeline_markers: markers,
  };
}

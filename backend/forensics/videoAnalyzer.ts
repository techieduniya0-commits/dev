import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import {
  checkBinaryCapabilities,
  getDerivativesDir,
  runSafeCommand,
  runSafeCommandBinary,
} from '../storage.ts';
import { getSettings, insertFinding, logAuditEvent } from '../db.ts';
import {
  formatTs,
  type DecodedFrame,
  type VideoAnalysisContext,
  type VideoLayerOutput,
  type VideoTimelineMarkerInternal,
} from './video/types.ts';
import { detectFaceInFrame, runFacialTextureLayer } from './video/facialTexture.ts';
import { runFacialMotionLayer } from './video/facialMotion.ts';
import { runLipSyncLayer } from './video/lipSync.ts';
import { runTemporalConsistencyLayer } from './video/temporalConsistency.ts';
import { runFrequencyAnalysisLayer } from './video/frequencyAnalysis.ts';
import { runMotionAnalysisLayer } from './video/motionAnalysis.ts';
import { runProvenanceAnalysisLayer } from './video/provenanceAnalysis.ts';
import { runDeepfakeClassifierLayer } from './video/deepfakeClassifier.ts';
import {
  buildFinalVideoAssessment,
  type FinalVideoAssessmentOutput,
} from './video/finalAssessment.ts';

export interface VideoFrameSample {
  index: number;
  timestamp_sec: number;
  timestamp_formatted: string;
  url: string;
  is_scene_change: boolean;
  face_detected?: boolean;
  face_bbox_norm?: { x: number; y: number; w: number; h: number } | null;
  mean_luma?: number;
  sharpness_laplacian?: number;
}

export interface VideoAnalysisOutput {
  evidence_id: string;
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  video_codec: string;
  audio_codec: string | null;
  has_audio: boolean;
  bitrate_kbps: number | null;
  format_name: string;
  creation_time: string | null;
  encoder: string | null;
  thumbnail_url: string | null;
  extracted_audio_url: string | null;
  audio_waveform_peaks: number[];
  frames: VideoFrameSample[];
  scene_changes: Array<{ timestamp_sec: number; timestamp_formatted: string }>;
  multi_layer_analysis: {
    version: string;
    layers: Array<Omit<VideoLayerOutput, 'finding_refs' | 'timeline_markers'>>;
    timeline_markers: VideoTimelineMarkerInternal[];
    final_assessment: FinalVideoAssessmentOutput;
  };
  analysis_methods: string[];
  limitations: string[];
}

export interface LiveLayerProgress {
  evidence_id: string;
  overall_status: 'IDLE' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  started_at: string;
  updated_at: string;
  error: string | null;
  layers: Array<{
    layer_number: number;
    layer_id: string;
    layer_name: string;
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'UNAVAILABLE' | 'FAILED' | 'REQUIRES_REVIEW';
  }>;
}

const liveVideoJobs = new Map<string, LiveLayerProgress>();

export function getVideoJobStatus(evidenceId: string): LiveLayerProgress | null {
  return liveVideoJobs.get(evidenceId) || null;
}

function initJobTracker(evidenceId: string): LiveLayerProgress {
  const now = new Date().toISOString();
  const state: LiveLayerProgress = {
    evidence_id: evidenceId,
    overall_status: 'PROCESSING',
    started_at: now,
    updated_at: now,
    error: null,
    layers: [
      { layer_number: 1, layer_id: 'LAYER_1_FACIAL_TEXTURE', layer_name: 'Layer 1 — Facial Texture & Blending Analysis', status: 'PENDING' },
      { layer_number: 2, layer_id: 'LAYER_2_FACIAL_MOTION', layer_name: 'Layer 2 — Facial Movement & Landmark Consistency', status: 'PENDING' },
      { layer_number: 3, layer_id: 'LAYER_3_LIP_SYNC', layer_name: 'Layer 3 — Audio-Video Lip Synchronization', status: 'PENDING' },
      { layer_number: 4, layer_id: 'LAYER_4_TEMPORAL_CONSISTENCY', layer_name: 'Layer 4 — Frame-to-Frame Temporal Consistency', status: 'PENDING' },
      { layer_number: 5, layer_id: 'LAYER_5_FREQUENCY_DOMAIN', layer_name: 'Layer 5 — Frequency-Domain (2D-DCT) Analysis', status: 'PENDING' },
      { layer_number: 6, layer_id: 'LAYER_6_MOTION_PHYSICS', layer_name: 'Layer 6 — Motion & Physical Consistency (Optical Flow)', status: 'PENDING' },
      { layer_number: 7, layer_id: 'LAYER_7_PROVENANCE_METADATA', layer_name: 'Layer 7 — Metadata, Provenance & Watermark Inspection', status: 'PENDING' },
      { layer_number: 8, layer_id: 'LAYER_8_DEEPFAKE_MODEL', layer_name: 'Layer 8 — Pretrained Deepfake Detection Model', status: 'PENDING' },
    ],
  };
  liveVideoJobs.set(evidenceId, state);
  return state;
}

function updateLayerTracker(
  evidenceId: string,
  layerNumber: number,
  status: LiveLayerProgress['layers'][number]['status']
) {
  const job = liveVideoJobs.get(evidenceId);
  if (!job) return;
  const entry = job.layers.find((l) => l.layer_number === layerNumber);
  if (entry) entry.status = status;
  job.updated_at = new Date().toISOString();
}

export function formatSec(sec: number): string {
  return formatTs(sec);
}

function parseFrameRate(rateStr: string | undefined): number {
  if (!rateStr) return 0;
  if (rateStr.includes('/')) {
    const [num, den] = rateStr.split('/').map(Number);
    if (den && !Number.isNaN(num) && !Number.isNaN(den)) {
      return Number((num / den).toFixed(3));
    }
  }
  const n = Number(rateStr);
  return Number.isNaN(n) ? 0 : Number(n.toFixed(3));
}

async function decodeFramePixels(
  filePath: string,
  index: number,
  ts: number,
  url: string,
  isSceneChange: boolean
): Promise<DecodedFrame> {
  const raw = await sharp(filePath)
    .resize({ width: 240, height: 135, fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = raw.info.width;
  const h = raw.info.height;
  const rgb = new Uint8Array(raw.data.buffer, raw.data.byteOffset, raw.data.byteLength);
  const gray = new Float32Array(w * h);

  let lumaSum = 0;
  for (let i = 0; i < w * h; i++) {
    const g = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    gray[i] = g;
    lumaSum += g;
  }

  let lapSum = 0;
  let lapCnt = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      lapSum += Math.abs(
        4 * gray[y * w + x] -
          gray[(y - 1) * w + x] -
          gray[(y + 1) * w + x] -
          gray[y * w + (x - 1)] -
          gray[y * w + (x + 1)]
      );
      lapCnt++;
    }
  }

  return {
    index,
    timestamp_sec: ts,
    timestamp_formatted: formatTs(ts),
    file_path: filePath,
    url,
    width: w,
    height: h,
    rgb,
    gray,
    mean_luma: Number((lumaSum / Math.max(1, w * h)).toFixed(1)),
    sharpness_laplacian: Number((lapSum / Math.max(1, lapCnt)).toFixed(2)),
    is_scene_change: isSceneChange,
  };
}

async function extractAudioWaveformPeaks(wavPath: string): Promise<number[]> {
  try {
    const pcmRes = await runSafeCommandBinary(
      'ffmpeg',
      ['-i', wavPath, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '8000', '-t', '240', 'pipe:1'],
      20000
    );
    const buf = pcmRes.stdout;
    const sampleCount = Math.floor(buf.length / 2);
    if (sampleCount <= 0) return [];
    const bins = 160;
    const step = Math.max(1, Math.floor(sampleCount / bins));
    const peaks = new Array<number>(bins).fill(0);
    for (let b = 0; b < bins; b++) {
      const start = b * step;
      const end = Math.min(sampleCount, start + step);
      let maxVal = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(buf.readInt16LE(i * 2)) / 32768;
        if (v > maxVal) maxVal = v;
      }
      peaks[b] = Number(maxVal.toFixed(4));
    }
    return peaks;
  } catch {
    return [];
  }
}

export async function analyzeVideoEvidence(params: {
  investigation_id: string;
  evidence_id: string;
  original_path: string;
  original_filename: string;
  file_size: number;
}): Promise<VideoAnalysisOutput> {
  const job = initJobTracker(params.evidence_id);

  try {
    const caps = await checkBinaryCapabilities();
    if (!caps.ffmpeg || !caps.ffprobe) {
      throw new Error('FFmpeg/FFprobe binaries are not available on this host.');
    }

    const settings = getSettings();
    const sampleCount = Math.min(
      16,
      Math.max(6, parseInt(settings.video_sample_frames || '10', 10) || 10)
    );
    const sceneThreshold = Math.min(
      0.8,
      Math.max(0.1, parseFloat(settings.scene_threshold || '0.30') || 0.3)
    );
    const derivDir = getDerivativesDir(params.evidence_id);

    // 1. Probe container & streams via ffprobe (existing preserved capability)
    const probeRes = await runSafeCommand(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', params.original_path],
      20000
    );

    const probe = JSON.parse(probeRes.stdout || '{}');
    const streams: any[] = Array.isArray(probe.streams) ? probe.streams : [];
    const format = probe.format || {};
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    if (!videoStream) {
      throw new Error('Uploaded video file contains no decodable video stream.');
    }

    const durationSec =
      Number(parseFloat(format.duration || videoStream.duration || '0').toFixed(3)) || 0;
    const width = Number(videoStream.width || 0);
    const height = Number(videoStream.height || 0);
    const avgFps = parseFrameRate(videoStream.avg_frame_rate);
    const rFps = parseFrameRate(videoStream.r_frame_rate);
    const fps = avgFps || rFps || 0;
    const videoCodec = String(videoStream.codec_name || 'unknown');
    const audioCodec = audioStream ? String(audioStream.codec_name || 'unknown') : null;
    const hasAudio = Boolean(audioStream);
    const bitrateKbps = format.bit_rate ? Math.round(Number(format.bit_rate) / 1000) : null;
    const formatName = String(format.format_name || 'unknown');
    const tags = { ...(format.tags || {}), ...(videoStream.tags || {}) };
    const creationTime = tags.creation_time ? String(tags.creation_time) : null;
    const encoder = tags.encoder ? String(tags.encoder) : null;

    logAuditEvent({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      event_type: 'METADATA_EXTRACTED',
      description: `Probed video stream: ${width}x${height} @ ${fps} fps, ${durationSec}s, codec ${videoCodec}.`,
      details: { width, height, fps, durationSec, videoCodec, audioCodec, creationTime, encoder },
    });

    // 2. Generate poster thumbnail (preserved)
    let thumbnailUrl: string | null = null;
    const thumbPath = path.join(derivDir, 'thumb.jpg');
    try {
      const seekSec = durationSec > 1 ? Math.min(1.0, durationSec * 0.2) : 0;
      await runSafeCommand(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(seekSec.toFixed(2)),
          '-i',
          params.original_path,
          '-frames:v',
          '1',
          '-vf',
          'scale=640:-2',
          '-q:v',
          '4',
          thumbPath,
        ],
        20000
      );
      if (fs.existsSync(thumbPath)) {
        thumbnailUrl = `/derivatives/${params.evidence_id}/thumb.jpg`;
      }
    } catch {
      thumbnailUrl = null;
    }

    // 3. Detect scene changes via FFmpeg select + showinfo filter (preserved)
    const sceneChanges: Array<{ timestamp_sec: number; timestamp_formatted: string }> = [];
    try {
      const sceneRes = await runSafeCommand(
        'ffmpeg',
        [
          '-i',
          params.original_path,
          '-vf',
          `select='gt(scene,${sceneThreshold})',showinfo`,
          '-f',
          'null',
          '-',
        ],
        35000
      );
      const regex = /pts_time:([0-9.]+)/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(sceneRes.stderr)) !== null) {
        const ts = Number(parseFloat(match[1]).toFixed(3));
        if (!Number.isNaN(ts)) {
          sceneChanges.push({
            timestamp_sec: ts,
            timestamp_formatted: formatTs(ts),
          });
        }
      }
    } catch {
      // non-fatal
    }

    // 4. Sample frames at deterministic intervals and decode pixel arrays for CV layers
    const decodedFrames: DecodedFrame[] = [];
    const effectiveDuration = Math.max(durationSec, 0.5);
    const actualCount = durationSec < 1.5 ? Math.min(4, sampleCount) : sampleCount;
    const timestamps: number[] = [];

    for (let i = 0; i < actualCount; i++) {
      const t =
        actualCount === 1
          ? 0
          : Number(
              ((i / Math.max(1, actualCount - 1)) * Math.max(0.05, effectiveDuration - 0.1)).toFixed(
                3
              )
            );
      timestamps.push(t);
    }

    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i];
      const fname = `frame_${String(i).padStart(3, '0')}.jpg`;
      const outPath = path.join(derivDir, fname);
      try {
        await runSafeCommand(
          'ffmpeg',
          [
            '-y',
            '-ss',
            String(ts),
            '-i',
            params.original_path,
            '-frames:v',
            '1',
            '-vf',
            'scale=640:-2',
            '-q:v',
            '4',
            outPath,
          ],
          15000
        );
        if (fs.existsSync(outPath)) {
          const nearCut = sceneChanges.some((sc) => Math.abs(sc.timestamp_sec - ts) <= 0.6);
          const url = `/derivatives/${params.evidence_id}/${fname}`;
          const decoded = await decodeFramePixels(outPath, i, ts, url, nearCut);
          decodedFrames.push(decoded);
        }
      } catch {
        // skip unreadable frame
      }
    }

    // 5. Extract audio track + waveform peaks if audio stream exists (preserved + enhanced)
    let extractedAudioUrl: string | null = null;
    let extractedAudioPath: string | null = null;
    let audioWaveformPeaks: number[] = [];

    if (hasAudio) {
      const wavPath = path.join(derivDir, 'extracted_audio.wav');
      try {
        await runSafeCommand(
          'ffmpeg',
          [
            '-y',
            '-i',
            params.original_path,
            '-vn',
            '-acodec',
            'pcm_s16le',
            '-ar',
            '16000',
            '-ac',
            '1',
            wavPath,
          ],
          25000
        );
        if (fs.existsSync(wavPath)) {
          extractedAudioPath = wavPath;
          extractedAudioUrl = `/derivatives/${params.evidence_id}/extracted_audio.wav`;
          audioWaveformPeaks = await extractAudioWaveformPeaks(wavPath);
        }
      } catch {
        extractedAudioUrl = null;
        extractedAudioPath = null;
      }
    }

    // 6. Preserve Existing Core Video Findings (Stream Profile, Scene Cuts, VFR)
    const ref = `${params.original_filename} (${params.evidence_id})`;

    insertFinding({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: 'CORE_STREAM_METADATA',
      finding_type: 'VIDEO_STREAM_PROFILE',
      title: `Decoded ${videoCodec.toUpperCase()} video (${width}x${height}, ${fps} fps, ${durationSec.toFixed(2)}s)`,
      description: `Container "${formatName}" decoded with ${width}×${height} video stream (${videoCodec}, ${fps} fps${bitrateKbps ? `, ~${bitrateKbps} kbps` : ''}). ${hasAudio ? `Audio stream present (${audioCodec}).` : 'No audio track present.'}${creationTime ? ` Container creation_time: ${creationTime}.` : ''}${encoder ? ` Encoder tag: ${encoder}.` : ''}`,
      actual_observation: `${width}x${height} ${videoCodec} @ ${fps}fps, duration ${durationSec.toFixed(2)}s, audio=${hasAudio ? audioCodec : 'none'}.`,
      evidence_reference: ref,
      timestamp_or_region: `00:00.00 - ${formatTs(durationSec)}`,
      start_timestamp: 0,
      end_timestamp: durationSec,
      frame_reference: `${decodedFrames.length} sampled frames`,
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'STRONG',
      uncertainty: 'NONE',
      limitations:
        'Stream probing verifies technical encoding parameters; container metadata can be rewritten during transcoding.',
      alternative_explanation: 'Standard camera recording or media container export profile.',
    });

    if (sceneChanges.length > 0) {
      const cutList = sceneChanges
        .slice(0, 8)
        .map((c) => c.timestamp_formatted)
        .join(', ');
      insertFinding({
        investigation_id: params.investigation_id,
        evidence_id: params.evidence_id,
        module: 'VIDEO_FORENSICS',
        analysis_layer: 'CORE_SCENE_DETECTION',
        finding_type: 'SCENE_TRANSITIONS_DETECTED',
        title: `${sceneChanges.length} visual scene transition(s) detected (threshold ${sceneThreshold})`,
        description: `FFmpeg frame-difference scene detector flagged ${sceneChanges.length} transition point(s) at: ${cutList}${sceneChanges.length > 8 ? ` (+${sceneChanges.length - 8} more)` : ''}. Extracted ${decodedFrames.length} reference frames for visual inspection.`,
        actual_observation: `${sceneChanges.length} scene cuts detected at ${cutList}.`,
        evidence_reference: ref,
        timestamp_or_region: cutList,
        start_timestamp: sceneChanges[0].timestamp_sec,
        end_timestamp: sceneChanges[sceneChanges.length - 1].timestamp_sec,
        frame_reference: `${decodedFrames.length} sampled frames`,
        analysis_category: 'STATISTICAL_HEURISTIC',
        evidence_strength: 'LOW',
        uncertainty: 'REQUIRES_HUMAN_REVIEW',
        limitations:
          'Scene transitions measure inter-frame pixel delta only. Normal camera cuts, flashes, rapid motion, or edited compilation clips produce scene changes and are NOT proof of deceptive manipulation.',
        alternative_explanation:
          'Standard video editing cuts, camera movement, lighting changes, or multi-angle footage.',
      });
    }

    if (avgFps > 0 && rFps > 0 && Math.abs(avgFps - rFps) > 1.5) {
      insertFinding({
        investigation_id: params.investigation_id,
        evidence_id: params.evidence_id,
        module: 'VIDEO_FORENSICS',
        analysis_layer: 'CORE_STREAM_METADATA',
        finding_type: 'FRAME_RATE_VARIANCE',
        title: `Variable frame rate cadence observed (avg ${avgFps} fps vs nominal ${rFps} fps)`,
        description: `Stream average frame rate (${avgFps} fps) diverges from container nominal rate (${rFps} fps), indicating variable frame timing or re-muxing.`,
        actual_observation: `avg_frame_rate=${avgFps}, r_frame_rate=${rFps}.`,
        evidence_reference: ref,
        timestamp_or_region: 'Video Stream Timing',
        analysis_category: 'DETERMINISTIC',
        evidence_strength: 'LOW',
        uncertainty: 'REQUIRES_HUMAN_REVIEW',
        limitations:
          'Frame-rate timing differences alone do not establish deliberate frame removal or splicing.',
        alternative_explanation:
          'Smartphones, screen recorders, and web conferencing tools commonly record Variable Frame Rate (VFR) video natively.',
      });
    }

    // 7. Run Real Facial Localization once across sampled frames for Layers 1, 2, 3, and 5
    const faceDetections = decodedFrames.map((f) => detectFaceInFrame(f));

    const ctx: VideoAnalysisContext = {
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      original_path: params.original_path,
      original_filename: params.original_filename,
      file_size: params.file_size,
      deriv_dir: derivDir,
      duration_sec: durationSec,
      width,
      height,
      fps,
      video_codec: videoCodec,
      audio_codec: audioCodec,
      has_audio: hasAudio,
      bitrate_kbps: bitrateKbps,
      format_name: formatName,
      creation_time: creationTime,
      encoder,
      probe_raw: probe,
      extracted_audio_path: extractedAudioPath,
      frames: decodedFrames,
      scene_changes: sceneChanges,
      face_detections: faceDetections,
    };

    // 8. Execute all 8 Multi-Layer Authenticity Analysis modules with live status tracking
    const layerRunners: Array<{
      num: number;
      id: string;
      name: string;
      fn: () => Promise<VideoLayerOutput>;
    }> = [
      { num: 1, id: 'LAYER_1_FACIAL_TEXTURE', name: 'Layer 1 — Facial Texture & Blending Analysis', fn: () => runFacialTextureLayer(ctx) },
      { num: 2, id: 'LAYER_2_FACIAL_MOTION', name: 'Layer 2 — Facial Movement & Landmark Consistency', fn: () => runFacialMotionLayer(ctx) },
      { num: 3, id: 'LAYER_3_LIP_SYNC', name: 'Layer 3 — Audio-Video Lip Synchronization', fn: () => runLipSyncLayer(ctx) },
      { num: 4, id: 'LAYER_4_TEMPORAL_CONSISTENCY', name: 'Layer 4 — Frame-to-Frame Temporal Consistency', fn: () => runTemporalConsistencyLayer(ctx) },
      { num: 5, id: 'LAYER_5_FREQUENCY_DOMAIN', name: 'Layer 5 — Frequency-Domain (2D-DCT) Analysis', fn: () => runFrequencyAnalysisLayer(ctx) },
      { num: 6, id: 'LAYER_6_MOTION_PHYSICS', name: 'Layer 6 — Motion & Physical Consistency (Optical Flow)', fn: () => runMotionAnalysisLayer(ctx) },
      { num: 7, id: 'LAYER_7_PROVENANCE_METADATA', name: 'Layer 7 — Metadata, Provenance & Watermark Inspection', fn: () => runProvenanceAnalysisLayer(ctx) },
      { num: 8, id: 'LAYER_8_DEEPFAKE_MODEL', name: 'Layer 8 — Pretrained Deepfake Detection Model', fn: () => runDeepfakeClassifierLayer(ctx) },
    ];

    const layerOutputs: VideoLayerOutput[] = [];

    for (const runner of layerRunners) {
      updateLayerTracker(params.evidence_id, runner.num, 'PROCESSING');
      try {
        const out = await runner.fn();
        layerOutputs.push(out);
        updateLayerTracker(params.evidence_id, runner.num, out.status);
      } catch (err: any) {
        const errMsg = err?.message || 'Unexpected processing error in layer.';
        const failedLayer: VideoLayerOutput = {
          layer_number: runner.num,
          layer_id: runner.id,
          layer_name: runner.name,
          status: 'FAILED',
          processing_status: 'FAILED',
          summary: `Layer failed during execution: ${errMsg}`,
          actual_result: errMsg,
          evidence_strength: 'NONE',
          model_confidence: null,
          calibration_status: 'NOT_APPLICABLE',
          relevant_timestamps: [],
          evidence_references: [ref],
          explanation: 'Encountered a runtime processing error while executing this forensic layer.',
          limitations: 'Failed layers are excluded from positive indicator attribution.',
          alternative_explanation: 'Corrupted media stream or unsupported codec feature.',
          metrics: { error: errMsg },
          finding_ids: [],
          finding_refs: [],
          timeline_markers: [],
        };
        layerOutputs.push(failedLayer);
        updateLayerTracker(params.evidence_id, runner.num, 'FAILED');
      }
    }

    // 9. Aggregate timeline markers sorted chronologically & build Final Authenticity Assessment
    const timelineMarkers: VideoTimelineMarkerInternal[] = layerOutputs
      .flatMap((l) => l.timeline_markers)
      .sort((a, b) => a.timestamp_sec - b.timestamp_sec);

    const finalAssessment = buildFinalVideoAssessment(layerOutputs, sceneChanges.length);

    logAuditEvent({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      event_type: 'MULTI_LAYER_VIDEO_ASSESSED',
      description: `Completed 8-layer video authenticity analysis on ${params.original_filename}. Outcome: ${finalAssessment.outcome}.`,
      details: {
        outcome: finalAssessment.outcome,
        supporting_count: finalAssessment.supporting_findings.length,
        unavailable_layers: finalAssessment.unavailable_layers,
        timeline_markers: timelineMarkers.length,
      },
    });

    job.overall_status = 'COMPLETED';
    job.updated_at = new Date().toISOString();

    const frameSamples: VideoFrameSample[] = decodedFrames.map((f, idx) => {
      const face = faceDetections[idx];
      return {
        index: f.index,
        timestamp_sec: f.timestamp_sec,
        timestamp_formatted: f.timestamp_formatted,
        url: f.url,
        is_scene_change: f.is_scene_change,
        face_detected: Boolean(face),
        face_bbox_norm: face
          ? {
              x: Number((face.bbox.x / f.width).toFixed(4)),
              y: Number((face.bbox.y / f.height).toFixed(4)),
              w: Number((face.bbox.w / f.width).toFixed(4)),
              h: Number((face.bbox.h / f.height).toFixed(4)),
            }
          : null,
        mean_luma: f.mean_luma,
        sharpness_laplacian: f.sharpness_laplacian,
      };
    });

    return {
      evidence_id: params.evidence_id,
      duration_sec: durationSec,
      width,
      height,
      fps,
      video_codec: videoCodec,
      audio_codec: audioCodec,
      has_audio: hasAudio,
      bitrate_kbps: bitrateKbps,
      format_name: formatName,
      creation_time: creationTime,
      encoder,
      thumbnail_url: thumbnailUrl,
      extracted_audio_url: extractedAudioUrl,
      audio_waveform_peaks: audioWaveformPeaks,
      frames: frameSamples,
      scene_changes: sceneChanges,
      multi_layer_analysis: {
        version: '2.0',
        layers: layerOutputs.map(({ finding_refs: _fr, timeline_markers: _tm, ...publicLayer }) => publicLayer),
        timeline_markers: timelineMarkers,
        final_assessment: finalAssessment,
      },
      analysis_methods: [
        'FFprobe container, codec, frame-rate, and tag inspection',
        `FFmpeg scene-change filter (select gt(scene,${sceneThreshold})) & interval frame extraction`,
        'Layer 1: YCbCr + anatomical face ROI localization & interior/boundary Laplacian texture analysis',
        'Layer 2: Cross-frame eye/nose/mouth landmark trajectory & blur/lighting stability tracking',
        'Layer 3: FFmpeg 300–3400Hz speech-band RMS VAD correlated with tracked mouth-region activity',
        'Layer 4: Consecutive inter-frame MAE, sharpness flicker, and 4x4 blockwise temporal difference heatmap',
        'Layer 5: 48x48 2D-DCT spatial frequency band energy & periodic peak spectrum mapping',
        'Layer 6: 8x8 block-matching optical flow vector divergence & illumination asymmetry estimation',
        'Layer 7: ISO-BMFF container byte scan for C2PA/XMP, AI generator & NLE encoder provenance signatures',
        'Layer 8: Local pretrained ONNX deepfake model registry check (honestly reported UNAVAILABLE when unbundled)',
      ],
      limitations: [
        'Absence of detected anomalies NEVER proves a video is authentic or unedited.',
        'Heuristic CV layers (texture, motion, DCT frequency, mouth activity) are affected by compression, lighting, camera blur, and normal editing.',
        'Layer 8 (Pretrained Deepfake Neural Model) is unavailable in this container because verified local model weights are not bundled; no simulated probabilities are emitted.',
      ],
    };
  } catch (err: any) {
    job.overall_status = 'FAILED';
    job.error = err?.message || 'Video analysis failed';
    job.updated_at = new Date().toISOString();
    throw err;
  }
}

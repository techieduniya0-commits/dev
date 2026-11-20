import { runSafeCommandBinary } from '../../storage.ts';
import { insertFinding } from '../../db.ts';
import {
  formatTs,
  type VideoAnalysisContext,
  type VideoLayerFindingRef,
  type VideoLayerOutput,
  type VideoTimelineMarkerInternal,
} from './types.ts';

function pearsonCorr(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA <= 1e-9 || denB <= 1e-9) return 0;
  return num / Math.sqrt(denA * denB);
}

export async function runLipSyncLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_3_LIP_SYNC';
  const layerName = 'Layer 3 — Audio-Video Lip Synchronization';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  if (!ctx.has_audio || !ctx.extracted_audio_path) {
    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'LIP_SYNC_NO_AUDIO',
      title: 'No audio track present — lip synchronization cannot be evaluated',
      description: `Video container ${ctx.original_filename} contains no decodable audio stream. Audiovisual speech-to-mouth alignment was skipped.`,
      actual_observation: '0 audio streams present in container.',
      evidence_reference: ref,
      timestamp_or_region: 'Audio Track Absent',
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'INSUFFICIENT_DATA',
      limitations: 'Audio-video synchronization requires both a speech audio track and a visible speaking face.',
      alternative_explanation: 'Video was recorded muted, stripped of sound, or comes from a silent surveillance camera.',
    });

    return {
      layer_number: 3,
      layer_id: layerId,
      layer_name: layerName,
      status: 'UNAVAILABLE',
      processing_status: 'UNAVAILABLE',
      summary: 'No audio track present in uploaded video.',
      actual_result: 'Audio stream absent — lip-sync check not applicable.',
      evidence_strength: 'NONE',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation: 'Lip-sync inspection compares speech-band acoustic energy against tracked mouth-region visual movement.',
      limitations: 'Cannot run without an audio track.',
      alternative_explanation: 'Silent video clip or audio intentionally removed.',
      metrics: { has_audio: false, speech_segments: 0 },
      finding_ids: [fid],
      finding_refs: [
        {
          finding_id: fid,
          layer_id: layerId,
          layer_name: layerName,
          title: 'No audio track present — lip synchronization cannot be evaluated',
          strength: 'LOW',
          uncertainty: 'INSUFFICIENT_DATA',
          finding_type: 'LIP_SYNC_NO_AUDIO',
          is_anomalous: false,
          category_tag: 'UNCERTAIN',
        },
      ],
      timeline_markers: [],
    };
  }

  // Decode speech-band audio (300Hz–3400Hz bandpass via FFmpeg) into 8kHz mono s16le PCM
  const sampleRate = 8000;
  let speechPcm: Buffer;
  try {
    const res = await runSafeCommandBinary(
      'ffmpeg',
      [
        '-i',
        ctx.extracted_audio_path,
        '-af',
        'highpass=f=300,lowpass=f=3400',
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-t',
        '240',
        'pipe:1',
      ],
      25000
    );
    speechPcm = res.stdout;
  } catch (err: any) {
    return {
      layer_number: 3,
      layer_id: layerId,
      layer_name: layerName,
      status: 'FAILED',
      processing_status: 'FAILED',
      summary: 'Failed to decode speech-band audio signal.',
      actual_result: err?.message || 'FFmpeg bandpass decode error',
      evidence_strength: 'NONE',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation: 'Audio bandpass decoding failed before audiovisual alignment could run.',
      limitations: 'Unsupported or corrupted audio codec.',
      alternative_explanation: 'Corrupt container audio stream.',
      metrics: { has_audio: true, error: err?.message || 'decode error' },
      finding_ids: [],
      finding_refs: [],
      timeline_markers: [],
    };
  }

  const totalSamples = Math.floor(speechPcm.length / 2);

  // Measure speech-band RMS energy around every video analysis frame timestamp (window +/- 0.18s)
  const audioEnergyAtFrame = (tsSec: number): { rms: number; db: number } => {
    const center = Math.floor(tsSec * sampleRate);
    const halfWin = Math.floor(0.18 * sampleRate);
    const start = Math.max(0, center - halfWin);
    const end = Math.min(totalSamples, center + halfWin);
    if (end <= start) return { rms: 0, db: -90 };
    let sq = 0;
    for (let i = start; i < end; i++) {
      const s = speechPcm.readInt16LE(i * 2) / 32768;
      sq += s * s;
    }
    const rms = Math.sqrt(sq / (end - start));
    const db = 20 * Math.log10(Math.max(1e-5, rms));
    return { rms, db: Number(db.toFixed(1)) };
  };

  // Build speech activity segments across 0.25s steps
  const speechSegments: Array<{ start_sec: number; end_sec: number; label: string; peak_db: number }> = [];
  const stepSec = 0.25;
  let segStart: number | null = null;
  let segPeak = -90;

  for (let t = 0; t <= ctx.duration_sec; t += stepSec) {
    const { db } = audioEnergyAtFrame(t);
    const active = db > -34;
    if (active) {
      if (segStart === null) {
        segStart = t;
        segPeak = db;
      } else if (db > segPeak) {
        segPeak = db;
      }
    } else if (segStart !== null) {
      speechSegments.push({
        start_sec: Number(segStart.toFixed(2)),
        end_sec: Number(t.toFixed(2)),
        label: `${formatTs(segStart)} - ${formatTs(t)}`,
        peak_db: segPeak,
      });
      segStart = null;
    }
  }
  if (segStart !== null) {
    speechSegments.push({
      start_sec: Number(segStart.toFixed(2)),
      end_sec: Number(ctx.duration_sec.toFixed(2)),
      label: `${formatTs(segStart)} - ${formatTs(ctx.duration_sec)}`,
      peak_db: segPeak,
    });
  }

  // Estimate syllabic modulation vs continuous background music/noise across 0.12s sub-windows
  const subWinSamples = Math.max(1, Math.floor(0.12 * sampleRate));
  const subRmsVals: number[] = [];
  for (let pos = 0; pos + subWinSamples <= totalSamples; pos += subWinSamples) {
    let sq = 0;
    for (let j = pos; j < pos + subWinSamples; j++) {
      const s = speechPcm.readInt16LE(j * 2) / 32768;
      sq += s * s;
    }
    const r = Math.sqrt(sq / subWinSamples);
    if (r > 0.015) subRmsVals.push(r);
  }
  const activeMean =
    subRmsVals.length > 0 ? subRmsVals.reduce((a, b) => a + b, 0) / subRmsVals.length : 0;
  const activeStd =
    subRmsVals.length > 2
      ? Math.sqrt(
          subRmsVals.reduce((a, b) => a + (b - activeMean) * (b - activeMean), 0) / subRmsVals.length
        )
      : 0;
  const syllabicModulationRatio = activeMean > 1e-4 ? Number((activeStd / activeMean).toFixed(3)) : 0;
  const activeDutyCycle =
    totalSamples > 0 ? Number(((subRmsVals.length * subWinSamples) / totalSamples).toFixed(2)) : 0;
  const likelyContinuousMusicOrTone = activeDutyCycle > 0.85 && syllabicModulationRatio < 0.18;

  const maxFacesDetected = Math.max(
    0,
    ...ctx.face_detections.map((fd) => (fd ? fd.faces_count || 1 : 0))
  );
  const multiPersonScene = maxFacesDetected > 1;

  // Pair speech energy with tracked mouth-region visual activity
  const speechSeries: number[] = [];
  const mouthSeries: number[] = [];
  const mismatchIntervals: Array<{
    timestamp_sec: number;
    timestamp_formatted: string;
    frame_index: number;
    speech_db: number;
    mouth_activity: number;
    reason: string;
  }> = [];

  let trackedFaceAudioPairs = 0;

  for (let i = 1; i < ctx.frames.length; i++) {
    const fPrev = ctx.frames[i - 1];
    const fCurr = ctx.frames[i];
    const facePrev = ctx.face_detections[i - 1];
    const faceCurr = ctx.face_detections[i];
    if (!facePrev || !faceCurr || fCurr.is_scene_change) continue;

    // Compute mouth-region pixel delta between consecutive frames
    const mx0 = Math.max(0, Math.floor(faceCurr.bbox.x + faceCurr.bbox.w * 0.28));
    const mx1 = Math.min(fCurr.width - 1, Math.ceil(faceCurr.bbox.x + faceCurr.bbox.w * 0.72));
    const my0 = Math.max(0, Math.floor(faceCurr.bbox.y + faceCurr.bbox.h * 0.64));
    const my1 = Math.min(fCurr.height - 1, Math.ceil(faceCurr.bbox.y + faceCurr.bbox.h * 0.88));

    let diffSum = 0;
    let cnt = 0;
    for (let y = my0; y <= my1; y++) {
      for (let x = mx0; x <= mx1; x++) {
        diffSum += Math.abs(fCurr.gray[y * fCurr.width + x] - fPrev.gray[y * fPrev.width + x]);
        cnt++;
      }
    }
    const mouthPixelMotion = cnt > 0 ? diffSum / (cnt * 255) : 0;
    const apertureDelta = Math.abs(faceCurr.mouth.openness - facePrev.mouth.openness);
    const mouthActivity = Number((mouthPixelMotion * 0.65 + apertureDelta * 0.35).toFixed(4));

    const audio = audioEnergyAtFrame(fCurr.timestamp_sec);
    speechSeries.push(audio.rms);
    mouthSeries.push(mouthActivity);
    trackedFaceAudioPairs++;

    if (audio.db > -24 && mouthActivity < 0.015) {
      mismatchIntervals.push({
        timestamp_sec: fCurr.timestamp_sec,
        timestamp_formatted: fCurr.timestamp_formatted,
        frame_index: i,
        speech_db: audio.db,
        mouth_activity: mouthActivity,
        reason: `Strong speech-band energy (${audio.db} dBFS) while localized mouth region remained nearly static (${mouthActivity}).`,
      });
    } else if (audio.db < -42 && mouthActivity > 0.14) {
      mismatchIntervals.push({
        timestamp_sec: fCurr.timestamp_sec,
        timestamp_formatted: fCurr.timestamp_formatted,
        frame_index: i,
        speech_db: audio.db,
        mouth_activity: mouthActivity,
        reason: `Elevated mouth-region motion (${mouthActivity}) during quiet audio interval (${audio.db} dBFS).`,
      });
    }
  }

  // Case A: Audio exists, but no face tracked OR no speech activity detected
  if (speechSegments.length === 0 || trackedFaceAudioPairs < 2) {
    const reason =
      speechSegments.length === 0
        ? 'No active speech-band audio segments above -34 dBFS were detected.'
        : `Detected ${speechSegments.length} active speech-band segment(s), but fewer than 2 frames had a continuously tracked frontal face for mouth-movement alignment.`;

    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'LIP_SYNC_INSUFFICIENT_SIGNAL',
      title:
        speechSegments.length === 0
          ? 'No active speech-band audio detected for lip-sync alignment'
          : `Audio speech activity detected (${speechSegments.length} segment(s)) without tracked on-screen face`,
      description: `${reason} Speech-band timestamps extracted from 300–3400 Hz filtered PCM.`,
      actual_observation: `${speechSegments.length} speech-band segments; ${trackedFaceAudioPairs} face-audio comparison pairs.`,
      evidence_reference: ref,
      timestamp_or_region:
        speechSegments.length > 0
          ? speechSegments.slice(0, 4).map((s) => s.label).join(', ')
          : 'No Speech Detected',
      start_timestamp: speechSegments[0]?.start_sec ?? null,
      end_timestamp: speechSegments[0]?.end_sec ?? null,
      analysis_category: 'STATISTICAL_HEURISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'INSUFFICIENT_DATA',
      limitations:
        'Lip-sync correlation requires both audible speech and an unobstructed, front-facing speaker. Voiceovers, off-screen narration, background music, and silent footage cannot be lip-sync verified.',
      alternative_explanation:
        'Off-camera speaker, voiceover narration, background music/tones, or silent footage.',
    });

    return {
      layer_number: 3,
      layer_id: layerId,
      layer_name: layerName,
      status: 'REQUIRES_REVIEW',
      processing_status: 'COMPLETED',
      summary: reason,
      actual_result: `Speech segments: ${speechSegments.length} · Face-audio pairs: ${trackedFaceAudioPairs}`,
      evidence_strength: 'LOW',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: speechSegments.slice(0, 6).map((s) => ({
        start_sec: s.start_sec,
        end_sec: s.end_sec,
        label: `Audio active ${s.label} (${s.peak_db} dBFS)`,
      })),
      evidence_references: [ref],
      explanation:
        'Extracted 300–3400 Hz speech-band acoustic envelope and attempted to align with tracked mouth-region visual activity.',
      limitations:
        'This method measures mouth-region motion vs speech-band energy only—it does NOT perform phoneme-level audiovisual speech recognition (SyncNet/AV-HuBERT). Background music or off-screen speakers affect speech-band energy.',
      alternative_explanation: 'Off-screen narration, voiceover, music, or no speaking subject visible.',
      metrics: {
        has_audio: true,
        speech_segments: speechSegments.length,
        speech_intervals: speechSegments.slice(0, 8),
        tracked_face_audio_pairs: trackedFaceAudioPairs,
        mismatch_intervals: [],
      },
      finding_ids: [fid],
      finding_refs: [
        {
          finding_id: fid,
          layer_id: layerId,
          layer_name: layerName,
          title: 'Lip-sync alignment could not be completed due to missing face or speech signal',
          strength: 'LOW',
          uncertainty: 'INSUFFICIENT_DATA',
          finding_type: 'LIP_SYNC_INSUFFICIENT_SIGNAL',
          is_anomalous: false,
          category_tag: 'UNCERTAIN',
        },
      ],
      timeline_markers: [],
    };
  }

  // Case B: Compute real lag-0 Pearson correlation between speech-band RMS and mouth activity
  const corrLag0 = Number(pearsonCorr(speechSeries, mouthSeries).toFixed(3));
  const rawMismatch = mismatchIntervals.length > 0 || (trackedFaceAudioPairs >= 5 && corrLag0 < -0.15);
  // Suppress false AI-manipulation escalation when audio is continuous music/tone or multiple speakers share the frame
  const hasMismatch = rawMismatch && !likelyContinuousMusicOrTone && !multiPersonScene;

  const caveatNote = likelyContinuousMusicOrTone
    ? ' Continuous low-modulation audio (typical of background music or constant tone) was detected across the track, limiting speech-vs-mouth attribution.'
    : multiPersonScene
      ? ` Multiple people (${maxFacesDetected} face candidates) were detected in frame; audio speech may belong to a secondary speaker.`
      : '';

  const title = likelyContinuousMusicOrTone && rawMismatch
    ? `Continuous background music/audio detected — lip-sync correlation inconclusive (${mismatchIntervals.length} unaligned intervals)`
    : multiPersonScene && rawMismatch
      ? `Multi-person scene (${maxFacesDetected} faces) — primary mouth alignment inconclusive (r=${corrLag0})`
      : hasMismatch
        ? `Potential audio-mouth alignment mismatch observed (${mismatchIntervals.length} interval(s), r=${corrLag0})`
        : `Audio speech-band activity and mouth motion broadly aligned (r=${corrLag0})`;

  const fid = insertFinding({
    investigation_id: ctx.investigation_id,
    evidence_id: ctx.evidence_id,
    module: 'VIDEO_FORENSICS',
    analysis_layer: layerId,
    finding_type:
      likelyContinuousMusicOrTone && rawMismatch
        ? 'LIP_SYNC_BACKGROUND_MUSIC_CONFOUND'
        : multiPersonScene && rawMismatch
          ? 'LIP_SYNC_MULTI_SPEAKER_AMBIGUITY'
          : hasMismatch
            ? 'LIP_SYNC_MISMATCH_CANDIDATE'
            : 'LIP_SYNC_CORRELATION_BASELINE',
    title,
    description: `Compared 300–3400 Hz speech-band RMS energy across ${speechSegments.length} active segment(s) against tracked mouth-region visual activity over ${trackedFaceAudioPairs} frame pairs (Pearson r = ${corrLag0}; syllabic modulation ratio = ${syllabicModulationRatio}; duty cycle = ${activeDutyCycle}). Identified ${mismatchIntervals.length} raw mismatch interval(s).${caveatNote}`,
    actual_observation: `Pearson r=${corrLag0}; ${mismatchIntervals.length} raw mismatch intervals; modulation=${syllabicModulationRatio}; max_faces=${maxFacesDetected}.`,
    evidence_reference: ref,
    timestamp_or_region:
      mismatchIntervals.length > 0
        ? mismatchIntervals.slice(0, 4).map((m) => m.timestamp_formatted).join(', ')
        : `00:00.00 - ${formatTs(ctx.duration_sec)}`,
    start_timestamp: mismatchIntervals[0]?.timestamp_sec ?? speechSegments[0]?.start_sec ?? 0,
    end_timestamp: mismatchIntervals[0]?.timestamp_sec ?? speechSegments[0]?.end_sec ?? ctx.duration_sec,
    frame_reference:
      mismatchIntervals[0] !== undefined
        ? `Frame #${mismatchIntervals[0].frame_index + 1}`
        : `${trackedFaceAudioPairs} tracked frames`,
    analysis_category: 'STATISTICAL_HEURISTIC',
    evidence_strength: hasMismatch ? 'MODERATE' : 'LOW',
    uncertainty:
      likelyContinuousMusicOrTone || multiPersonScene ? 'AMBIGUOUS' : 'REQUIRES_HUMAN_REVIEW',
    limitations:
      'Uses coarse mouth-region visual energy vs 300–3400 Hz speech-band RMS energy, NOT phoneme-level neural lip-sync recognition. Off-camera voices, overlapping music, multiple speakers, dubbing, and container A/V drift can trigger mismatches.',
    alternative_explanation:
      'Background music or non-speech audio in the 300–3400 Hz band, secondary on-screen or off-screen speaker, translated dubbing, or container A/V muxing offset.',
  });

  const markers: VideoTimelineMarkerInternal[] = mismatchIntervals.slice(0, 6).map((m) => ({
    id: `MK-L3-${m.frame_index}`,
    timestamp_sec: m.timestamp_sec,
    timestamp_formatted: m.timestamp_formatted,
    marker_type: 'LIP_SYNC',
    layer_id: layerId,
    finding_id: fid,
    frame_index: m.frame_index,
    title: 'Potential lip-sync mismatch interval',
    detail: m.reason,
    severity: 'ELEVATED',
  }));

  return {
    layer_number: 3,
    layer_id: layerId,
    layer_name: layerName,
    status: rawMismatch ? 'REQUIRES_REVIEW' : 'COMPLETED',
    processing_status: 'COMPLETED',
    summary: likelyContinuousMusicOrTone && rawMismatch
      ? `Continuous background music/tone detected (modulation ${syllabicModulationRatio}) — lip-sync attribution inconclusive.`
      : multiPersonScene && rawMismatch
        ? `Multiple faces (${maxFacesDetected}) detected — manual speaker-to-audio review required.`
        : hasMismatch
          ? `${mismatchIntervals.length} speech-to-mouth mismatch interval(s) flagged for analyst playback review.`
          : `Speech-band energy and mouth movement show no major coarse desynchronization (r=${corrLag0}).`,
    actual_result: `Speech segments: ${speechSegments.length} · Correlation r: ${corrLag0} · Modulation: ${syllabicModulationRatio} · Mismatches: ${mismatchIntervals.length}`,
    evidence_strength: hasMismatch ? 'MODERATE' : 'LOW',
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps:
      mismatchIntervals.length > 0
        ? mismatchIntervals.slice(0, 6).map((m) => ({
            start_sec: m.timestamp_sec,
            label: `${m.timestamp_formatted} (${m.speech_db} dBFS / mouth ${m.mouth_activity})`,
          }))
        : speechSegments.slice(0, 5).map((s) => ({
            start_sec: s.start_sec,
            end_sec: s.end_sec,
            label: `Speech ${s.label}`,
          })),
    evidence_references: [ref],
    explanation:
      'Compares 300–3400 Hz speech-band acoustic RMS energy against tracked mouth-region visual activity at aligned timestamps, while checking syllabic envelope modulation to separate background music and noting multi-person scenes. Does NOT claim phoneme-level accuracy.',
    limitations:
      'Mouth-opening/motion correlation cannot verify exact phonemes and can be confounded by background music, multiple speakers, off-screen narration, or container A/V offset.',
    alternative_explanation:
      'Background music/non-speech audio, multi-speaker scene, container A/V desync from re-encoding, or off-screen narrator.',
    metrics: {
      has_audio: true,
      speech_segments: speechSegments.length,
      speech_intervals: speechSegments.slice(0, 8),
      tracked_face_audio_pairs: trackedFaceAudioPairs,
      pearson_correlation: corrLag0,
      syllabic_modulation_ratio: syllabicModulationRatio,
      active_duty_cycle: activeDutyCycle,
      likely_continuous_music: likelyContinuousMusicOrTone,
      multi_person_scene: multiPersonScene,
      mismatch_intervals: mismatchIntervals.slice(0, 8),
    },
    finding_ids: [fid],
    finding_refs: [
      {
        finding_id: fid,
        layer_id: layerId,
        layer_name: layerName,
        title,
        strength: hasMismatch ? 'MODERATE' : 'LOW',
        uncertainty:
          likelyContinuousMusicOrTone || multiPersonScene ? 'AMBIGUOUS' : 'REQUIRES_HUMAN_REVIEW',
        finding_type:
          likelyContinuousMusicOrTone && rawMismatch
            ? 'LIP_SYNC_BACKGROUND_MUSIC_CONFOUND'
            : multiPersonScene && rawMismatch
              ? 'LIP_SYNC_MULTI_SPEAKER_AMBIGUITY'
              : hasMismatch
                ? 'LIP_SYNC_MISMATCH_CANDIDATE'
                : 'LIP_SYNC_CORRELATION_BASELINE',
        is_anomalous: hasMismatch,
        category_tag: hasMismatch
          ? 'AI_MANIP'
          : likelyContinuousMusicOrTone || multiPersonScene
            ? 'UNCERTAIN'
            : 'BASELINE',
      },
    ],
    timeline_markers: markers,
  };
}

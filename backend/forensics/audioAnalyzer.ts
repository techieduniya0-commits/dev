import fs from 'fs';
import path from 'path';
import {
  checkBinaryCapabilities,
  getDerivativesDir,
  runSafeCommand,
  runSafeCommandBinary,
} from '../storage.ts';
import { getSettings, insertFinding, logAuditEvent } from '../db.ts';
import { formatSec } from './videoAnalyzer.ts';

export interface SilenceRegion {
  start_sec: number;
  end_sec: number;
  duration_sec: number;
  range_label: string;
}

export interface DiscontinuityEvent {
  timestamp_sec: number;
  timestamp_formatted: string;
  type: 'ENERGY_JUMP' | 'CLIPPING_BURST';
  delta_db: number;
  description: string;
}

export interface AudioAnalysisOutput {
  evidence_id: string;
  duration_sec: number;
  sample_rate: number;
  channels: number;
  codec: string;
  bitrate_kbps: number | null;
  waveform_peaks: number[]; // 200 normalized 0..1 peak values
  spectrogram_url: string | null;
  silence_regions: SilenceRegion[];
  discontinuities: DiscontinuityEvent[];
  rms_mean_db: number;
  peak_db: number;
  transcription_status: 'UNAVAILABLE_DEPENDENCY' | 'MANUAL_PROVIDED';
  transcription_note: string;
  analysis_methods: string[];
  limitations: string[];
}

export async function analyzeAudioEvidence(params: {
  investigation_id: string;
  evidence_id: string;
  original_path: string;
  original_filename: string;
  file_size: number;
}): Promise<AudioAnalysisOutput> {
  const caps = await checkBinaryCapabilities();
  if (!caps.ffmpeg || !caps.ffprobe) {
    throw new Error('FFmpeg/FFprobe binaries are not available on this host.');
  }

  const settings = getSettings();
  const silenceDb = parseFloat(settings.silence_noise_db || '-35') || -35;
  const silenceMinDur = Math.max(0.1, parseFloat(settings.silence_min_duration || '0.4') || 0.4);
  const derivDir = getDerivativesDir(params.evidence_id);

  // 1. Probe audio metadata via ffprobe
  const probeRes = await runSafeCommand(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', params.original_path],
    20000
  );
  const probe = JSON.parse(probeRes.stdout || '{}');
  const streams: any[] = Array.isArray(probe.streams) ? probe.streams : [];
  const format = probe.format || {};
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  if (!audioStream) {
    throw new Error('Uploaded file contains no decodable audio stream.');
  }

  const durationSec = Number(parseFloat(format.duration || audioStream.duration || '0').toFixed(3)) || 0;
  const sampleRate = parseInt(audioStream.sample_rate || '0', 10) || 0;
  const channels = parseInt(audioStream.channels || '1', 10) || 1;
  const codec = String(audioStream.codec_name || 'unknown');
  const bitrateKbps = format.bit_rate
    ? Math.round(Number(format.bit_rate) / 1000)
    : audioStream.bit_rate
      ? Math.round(Number(audioStream.bit_rate) / 1000)
      : null;

  logAuditEvent({
    investigation_id: params.investigation_id,
    evidence_id: params.evidence_id,
    event_type: 'METADATA_EXTRACTED',
    description: `Probed audio stream: ${sampleRate} Hz, ${channels}ch, ${durationSec}s, codec ${codec}.`,
    details: { sampleRate, channels, durationSec, codec, bitrateKbps },
  });

  // 2. Generate real Spectrogram PNG via FFmpeg showspectrumpic
  let spectrogramUrl: string | null = null;
  const specPath = path.join(derivDir, 'spectrogram.png');
  try {
    await runSafeCommand(
      'ffmpeg',
      [
        '-y',
        '-i',
        params.original_path,
        '-lavfi',
        'showspectrumpic=s=1000x300:legend=1:color=intensity:scale=log',
        specPath,
      ],
      25000
    );
    if (fs.existsSync(specPath)) {
      spectrogramUrl = `/derivatives/${params.evidence_id}/spectrogram.png`;
    }
  } catch {
    spectrogramUrl = null;
  }

  // 3. Detect silence regions via FFmpeg silencedetect filter
  const silenceRegions: SilenceRegion[] = [];
  try {
    const silRes = await runSafeCommand(
      'ffmpeg',
      [
        '-i',
        params.original_path,
        '-af',
        `silencedetect=noise=${silenceDb}dB:d=${silenceMinDur}`,
        '-f',
        'null',
        '-',
      ],
      25000
    );
    const lines = silRes.stderr.split('\n');
    let currentStart: number | null = null;
    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) {
        currentStart = parseFloat(startMatch[1]);
      }
      const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
      if (endMatch) {
        const endSec = parseFloat(endMatch[1]);
        const durSec = parseFloat(endMatch[2]);
        const startSec = currentStart !== null ? currentStart : Math.max(0, endSec - durSec);
        silenceRegions.push({
          start_sec: Number(startSec.toFixed(3)),
          end_sec: Number(endSec.toFixed(3)),
          duration_sec: Number(durSec.toFixed(3)),
          range_label: `${formatSec(startSec)} - ${formatSec(endSec)}`,
        });
        currentStart = null;
      }
    }
  } catch {
    // non-fatal
  }

  // 4. Decode real raw mono 8kHz s16le PCM to compute waveform peaks & energy-jump discontinuities
  const targetRate = 8000;
  let waveformPeaks: number[] = [];
  const discontinuities: DiscontinuityEvent[] = [];
  let rmsMeanDb = -60;
  let peakDb = -60;

  try {
    const pcmRes = await runSafeCommandBinary(
      'ffmpeg',
      [
        '-i',
        params.original_path,
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        String(targetRate),
        '-t',
        '300',
        'pipe:1',
      ],
      25000
    );

    const buf = pcmRes.stdout;
    const sampleCount = Math.floor(buf.length / 2);

    if (sampleCount > 0) {
      const bins = 200;
      const samplesPerBin = Math.max(1, Math.floor(sampleCount / bins));
      waveformPeaks = new Array(bins).fill(0);

      let globalSqSum = 0;
      let globalPeak = 0;

      for (let b = 0; b < bins; b++) {
        const start = b * samplesPerBin;
        const end = Math.min(sampleCount, start + samplesPerBin);
        let binPeak = 0;
        for (let i = start; i < end; i++) {
          const val = Math.abs(buf.readInt16LE(i * 2)) / 32768;
          if (val > binPeak) binPeak = val;
          if (val > globalPeak) globalPeak = val;
          globalSqSum += val * val;
        }
        waveformPeaks[b] = Number(binPeak.toFixed(4));
      }

      const globalRms = Math.sqrt(globalSqSum / sampleCount);
      rmsMeanDb = Number((20 * Math.log10(Math.max(1e-5, globalRms))).toFixed(1));
      peakDb = Number((20 * Math.log10(Math.max(1e-5, globalPeak))).toFixed(1));

      // Compute 250ms short-time energy windows to detect abrupt energy discontinuities & digital clipping
      const winSize = Math.floor(targetRate * 0.25); // 2000 samples = 0.25s
      const winCount = Math.floor(sampleCount / winSize);
      const winDb: number[] = [];

      for (let w = 0; w < winCount; w++) {
        let sq = 0;
        let clipped = 0;
        for (let i = 0; i < winSize; i++) {
          const sample = Math.abs(buf.readInt16LE((w * winSize + i) * 2)) / 32768;
          sq += sample * sample;
          if (sample >= 0.985) clipped++;
        }
        const rms = Math.sqrt(sq / winSize);
        const db = 20 * Math.log10(Math.max(1e-5, rms));
        winDb.push(db);

        const ts = Number((w * 0.25).toFixed(2));
        if (clipped >= 20 && discontinuities.length < 15) {
          discontinuities.push({
            timestamp_sec: ts,
            timestamp_formatted: formatSec(ts),
            type: 'CLIPPING_BURST',
            delta_db: Number(db.toFixed(1)),
            description: `Digital full-scale clipping burst (${clipped} clipped samples in 250ms window).`,
          });
        }
      }

      for (let w = 1; w < winDb.length; w++) {
        const delta = winDb[w] - winDb[w - 1];
        // Flag abrupt jump of >= 20 dB when transitioning into or out of audible signal
        if (Math.abs(delta) >= 20 && Math.max(winDb[w], winDb[w - 1]) > -32) {
          const ts = Number((w * 0.25).toFixed(2));
          if (discontinuities.length < 20) {
            discontinuities.push({
              timestamp_sec: ts,
              timestamp_formatted: formatSec(ts),
              type: 'ENERGY_JUMP',
              delta_db: Number(delta.toFixed(1)),
              description: `Abrupt ${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB RMS level transition across adjacent 250ms windows.`,
            });
          }
        }
      }
    }
  } catch {
    waveformPeaks = [];
  }

  // 5. Generate Honest Forensic Findings
  const ref = `${params.original_filename} (${params.evidence_id})`;

  insertFinding({
    investigation_id: params.investigation_id,
    evidence_id: params.evidence_id,
    module: 'AUDIO_FORENSICS',
    finding_type: 'AUDIO_STREAM_PROFILE',
    title: `Decoded ${codec.toUpperCase()} audio (${sampleRate} Hz, ${channels}ch, ${durationSec.toFixed(2)}s)`,
    description: `Audio stream properties verified via FFprobe: ${sampleRate} Hz sample rate, ${channels} channel(s), codec "${codec}", duration ${durationSec.toFixed(2)}s${bitrateKbps ? `, ~${bitrateKbps} kbps` : ''}. Measured mean level ${rmsMeanDb} dBFS, peak ${peakDb} dBFS.`,
    evidence_reference: ref,
    timestamp_or_region: `00:00.00 - ${formatSec(durationSec)}`,
    analysis_category: 'DETERMINISTIC',
    evidence_strength: 'STRONG',
    uncertainty: 'NONE',
    limitations: 'Container and PCM amplitude metrics verify technical stream parameters only.',
    alternative_explanation: 'Standard audio recording parameters.',
  });

  if (silenceRegions.length > 0) {
    const totalSilence = silenceRegions.reduce((acc, s) => acc + s.duration_sec, 0);
    const list = silenceRegions
      .slice(0, 6)
      .map((s) => s.range_label)
      .join(', ');
    insertFinding({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      module: 'AUDIO_FORENSICS',
      finding_type: 'SILENCE_REGIONS',
      title: `${silenceRegions.length} silence region(s) detected (total ${totalSilence.toFixed(2)}s below ${silenceDb} dB)`,
      description: `FFmpeg silencedetect identified ${silenceRegions.length} low-energy segment(s) lasting >= ${silenceMinDur}s at: ${list}${silenceRegions.length > 6 ? ` (+${silenceRegions.length - 6} more)` : ''}.`,
      evidence_reference: ref,
      timestamp_or_region: list,
      analysis_category: 'STATISTICAL_HEURISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'REQUIRES_HUMAN_REVIEW',
      limitations:
        'Silence detection uses a fixed dB threshold and cannot distinguish natural speaker pauses or noise gates from deliberate audio muting or splicing.',
      alternative_explanation:
        'Natural pauses in speech, microphone mute toggle, VOIP comfort-noise suppression, or studio noise-gate filters.',
    });
  }

  if (discontinuities.length > 0) {
    const tsList = discontinuities
      .slice(0, 6)
      .map((d) => `${d.timestamp_formatted} (${d.type === 'ENERGY_JUMP' ? `${d.delta_db}dB` : 'clip'})`)
      .join(', ');
    insertFinding({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      module: 'AUDIO_FORENSICS',
      finding_type: 'AUDIO_DISCONTINUITY_HEURISTIC',
      title: `${discontinuities.length} abrupt energy/clipping transition(s) flagged for review`,
      description: `Short-time 250ms PCM energy heuristic flagged ${discontinuities.length} abrupt level jump or clipping event(s): ${tsList}.`,
      evidence_reference: ref,
      timestamp_or_region: tsList,
      analysis_category: 'STATISTICAL_HEURISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'REQUIRES_HUMAN_REVIEW',
      limitations:
        'Energy-step heuristics detect sudden loudness shifts, not voice cloning or neural synthesis. Acoustic environments, percussion, microphone bumps, and lossy codecs frequently trigger energy jumps.',
      alternative_explanation:
        'Sudden loud speech onset, microphone handling noise, background impact sound, or dynamic range compression.',
    });
  }

  const transcriptionNote =
    'Local faster-whisper / OpenAI Whisper ASR binaries are not installed in this container. TruthLens X never fabricates transcripts; investigators can enter or import a verified transcript manually below for text comparison and cross-modal correlation.';

  insertFinding({
    investigation_id: params.investigation_id,
    evidence_id: params.evidence_id,
    module: 'AUDIO_FORENSICS',
    finding_type: 'TRANSCRIPTION_DEPENDENCY_UNAVAILABLE',
    title: 'Automated speech-to-text model unavailable — manual transcript input enabled',
    description: transcriptionNote,
    evidence_reference: ref,
    timestamp_or_region: 'Full Audio Track',
    analysis_category: 'DETERMINISTIC',
    evidence_strength: 'LOW',
    uncertainty: 'PROCESSING_LIMITATION',
    limitations: 'Without a local Whisper model runtime, automated ASR is skipped rather than simulated.',
    alternative_explanation: 'Provide a manual timestamped transcript in the Audio Forensics panel to enable cross-modal text correlation.',
  });

  return {
    evidence_id: params.evidence_id,
    duration_sec: durationSec,
    sample_rate: sampleRate,
    channels,
    codec,
    bitrate_kbps: bitrateKbps,
    waveform_peaks: waveformPeaks,
    spectrogram_url: spectrogramUrl,
    silence_regions: silenceRegions,
    discontinuities,
    rms_mean_db: rmsMeanDb,
    peak_db: peakDb,
    transcription_status: 'UNAVAILABLE_DEPENDENCY',
    transcription_note: transcriptionNote,
    analysis_methods: [
      'FFprobe audio container & stream parameter inspection',
      'FFmpeg log-scale intensity spectrogram rendering (showspectrumpic)',
      `FFmpeg silence region detection (noise <= ${silenceDb} dB, min ${silenceMinDur}s)`,
      'Raw 8kHz s16le PCM waveform peak & 250ms RMS energy-jump heuristic',
    ],
    limitations: [
      'Local faster-whisper ASR model is not installed; transcripts are never fabricated.',
      'Background noise, compression codecs, music, and microphone handling strongly influence silence and energy-jump heuristics.',
      'No neural voice-cloning detector is claimed in this build.',
    ],
  };
}

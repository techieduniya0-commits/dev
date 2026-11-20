import React from 'react';
import { motion } from 'motion/react';
import type { AiPotentialRating, Finding } from '../types/forensics';

interface AiPotentialMeterProps {
  rating: AiPotentialRating;
  subjectLabel?: string;
}

const BAND_CONFIG: Record<
  AiPotentialRating['band'],
  { text: string; bar: string; shortTag: string }
> = {
  LOW: {
    text: 'text-[#52A378]',
    bar: '#52A378',
    shortTag: 'Low AI Potential',
  },
  MODERATE: {
    text: 'text-[#D9A441]',
    bar: '#D9A441',
    shortTag: 'Moderate / Uncertain',
  },
  HIGH: {
    text: 'text-[#D9822B]',
    bar: '#D9822B',
    shortTag: 'High AI Potential',
  },
  VERY_HIGH: {
    text: 'text-[#C95F5F]',
    bar: '#C95F5F',
    shortTag: 'Very High AI Potential',
  },
};

/**
 * Clean, simple 0-100 AI Potential Rating display (closer to 100 = stronger AI indicators).
 * Displays exact deterministic contributing factors and transparent calibration caveat.
 */
export const AiPotentialMeter: React.FC<AiPotentialMeterProps> = ({ rating, subjectLabel }) => {
  const cfg = BAND_CONFIG[rating.band] || BAND_CONFIG.MODERATE;
  const clamped = Math.max(0, Math.min(100, Math.round(rating.score)));

  return (
    <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs text-[#92949B] flex flex-wrap items-center gap-x-2">
            <span>AI Potential Rating</span>
            <span aria-hidden="true" className="text-[#4B4E57]">·</span>
            <span className="font-mono text-[11px]">0 Low Signals → 100 Likely AI</span>
            {subjectLabel && (
              <>
                <span aria-hidden="true" className="text-[#4B4E57]">·</span>
                <span className="font-mono text-[11px]">{subjectLabel}</span>
              </>
            )}
          </div>
          <div className={`text-[15px] font-semibold ${cfg.text}`}>{rating.simple_verdict}</div>
        </div>

        <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
          <span className={`text-3xl font-semibold tracking-tight leading-none ${cfg.text}`}>
            {clamped}
          </span>
          <span className="text-sm text-[#92949B]">/ 100</span>
        </div>
      </div>

      {/* 0 to 100 Forensic Gauge Bar */}
      <div className="space-y-1.5">
        <div className="relative h-2.5 rounded-sm bg-[#111214] border border-[#2B2D32] overflow-hidden">
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: clamped / 100 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            style={{ backgroundColor: cfg.bar, transformOrigin: 'left center' }}
            className="h-full w-full"
          />
          {/* Subtle 25 / 50 / 75 reference ticks */}
          <div className="absolute inset-y-0 left-1/4 w-px bg-[#111214]/80 pointer-events-none" />
          <div className="absolute inset-y-0 left-1/2 w-px bg-[#111214]/80 pointer-events-none" />
          <div className="absolute inset-y-0 left-3/4 w-px bg-[#111214]/80 pointer-events-none" />
        </div>
        <div className="flex items-center justify-between text-[11px] font-mono text-[#6C6F77] tabular-nums">
          <span>0 · Low signals</span>
          <span>50 · Mixed / Review</span>
          <span>100 · Likely AI</span>
        </div>
      </div>

      {/* Transparent Contributing Factors */}
      {rating.factors.length > 0 && (
        <div className="pt-3 border-t border-[#2B2D32] flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
          {rating.factors.map((f, idx) => (
            <div key={idx} className="inline-flex items-center gap-1.5 text-[#D0D2D7]">
              <span className="font-mono text-[#D9A441] tabular-nums">+{f.points}</span>
              <span>{f.label}</span>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-[#92949B] leading-relaxed">{rating.scale_note}</div>
    </div>
  );
};

/**
 * Computes a consistent deterministic 0-100 AI Potential Rating for Image or Audio findings
 * directly from real backend forensic observations (zero randomness).
 */
export function computeModalityAiRating(findings: Finding[]): AiPotentialRating | null {
  if (!findings || findings.length === 0) return null;

  let raw = 5;
  const factors: Array<{ label: string; points: number }> = [];

  for (const f of findings) {
    const type = (f.finding_type || '').toUpperCase();
    const titleLower = (f.title || '').toLowerCase();
    const descLower = (f.description || '').toLowerCase();

    if (
      type.includes('AI_') ||
      /\b(midjourney|dall-e|stable diffusion|firefly|elevenlabs|suno|udio|runway|sora|comfyui|generative)\b/i.test(
        `${titleLower} ${descLower}`
      )
    ) {
      raw += 78;
      factors.push({ label: f.title.slice(0, 62), points: 78 });
      continue;
    }

    if (type === 'ELA_LOCALIZED_ANOMALY' || type === 'ELA_HIGH_VARIANCE') {
      raw += 26;
      factors.push({ label: 'Elevated Error Level Analysis (ELA) regional variance', points: 26 });
    } else if (type === 'NOISE_INCONSISTENCY' || type === 'SPATIAL_NOISE_DISPARITY') {
      raw += 20;
      factors.push({ label: 'Spatial noise / texture inconsistency across quadrants', points: 20 });
    } else if (type === 'EDITING_SOFTWARE_TAG' || type === 'METADATA_SOFTWARE_DETECTED') {
      raw += 14;
      factors.push({ label: 'Editing or processing software tag in metadata', points: 14 });
    } else if (
      type === 'SPECTRAL_DISCONTINUITY' ||
      type === 'AUDIO_SPLICE_CANDIDATE' ||
      type === 'AMPLITUDE_DISCONTINUITY'
    ) {
      raw += 24;
      factors.push({ label: 'Audio amplitude / spectral discontinuity detected', points: 24 });
    } else if (type === 'UNNATURAL_SILENCE_FLOOR' || type === 'SYNTHETIC_SILENCE') {
      raw += 18;
      factors.push({ label: 'Abrupt digital silence floor drop detected', points: 18 });
    } else if (f.uncertainty === 'REQUIRES_HUMAN_REVIEW' && f.evidence_strength === 'MODERATE') {
      raw += 15;
      factors.push({ label: f.title.slice(0, 60), points: 15 });
    } else if (f.uncertainty === 'REQUIRES_HUMAN_REVIEW' && f.evidence_strength === 'STRONG') {
      raw += 28;
      factors.push({ label: f.title.slice(0, 60), points: 28 });
    }
  }

  if (factors.length === 0) {
    factors.push({ label: 'Baseline residual (no elevated AI or manipulation indicators)', points: 5 });
  }

  const score = Math.max(4, Math.min(98, Math.round(raw)));
  let band: AiPotentialRating['band'];
  let simple_verdict: string;

  if (score >= 80) {
    band = 'VERY_HIGH';
    simple_verdict = 'Likely AI-Generated / Strongly Synthetic Indicators';
  } else if (score >= 55) {
    band = 'HIGH';
    simple_verdict = 'High AI / Manipulation Potential';
  } else if (score >= 25) {
    band = 'MODERATE';
    simple_verdict = 'Moderate / Mixed Signals — Human Review Needed';
  } else {
    band = 'LOW';
    simple_verdict = 'Low AI Potential (Minimal Synthetic Signals)';
  }

  return {
    score,
    band,
    simple_verdict,
    scale_note:
      '0–100 Heuristic AI Potential Index (uncalibrated): scores near 100 indicate stronger AI/synthetic indicators; scores near 0 indicate fewer detected signals. Confirm with human analyst review.',
    factors,
  };
}

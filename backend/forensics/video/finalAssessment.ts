import { nowIso } from '../../db.ts';
import type { VideoLayerOutput } from './types.ts';

export type FinalAssessmentOutcome =
  | 'NO SIGNIFICANT INDICATORS DETECTED'
  | 'POTENTIAL AI-GENERATED CONTENT INDICATORS'
  | 'POTENTIAL AI-MANIPULATION INDICATORS'
  | 'POTENTIAL CONVENTIONAL EDITING INDICATORS'
  | 'MULTIPLE INCONSISTENCIES REQUIRE REVIEW'
  | 'INCONCLUSIVE';

export interface AiPotentialRatingOutput {
  score: number; // 0-100 deterministic heuristic index (near 100 = strong AI potential)
  band: 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH';
  simple_verdict: string;
  scale_note: string;
  factors: Array<{ label: string; points: number }>;
}

export interface FinalVideoAssessmentOutput {
  outcome: FinalAssessmentOutcome;
  summary: string;
  ai_potential_rating: AiPotentialRatingOutput;
  supporting_findings: Array<{
    finding_id: string;
    layer_name: string;
    title: string;
    strength: string;
  }>;
  uncertain_findings: Array<{
    finding_id: string;
    layer_name: string;
    title: string;
    reason: string;
  }>;
  unavailable_layers: string[];
  methodology_notice: string;
  evaluated_at: string;
}

/**
 * Computes a transparent, deterministic 0-100 AI Potential Rating directly from observed
 * forensic layer findings (closer to 100 = stronger AI/synthetic indicators; closer to 0 = fewer).
 */
function computeVideoAiPotentialRating(
  layers: VideoLayerOutput[],
  sceneCutCount: number
): AiPotentialRatingOutput {
  const factors: Array<{ label: string; points: number }> = [];
  let rawScore = 4; // Non-zero baseline so absence of indicators is never falsely shown as 0% "proven real"
  let editPoints = 0;
  let uncertaintyPoints = 0;

  for (const layer of layers) {
    if (layer.processing_status === 'UNAVAILABLE' || layer.processing_status === 'FAILED') {
      continue;
    }

    for (const ref of layer.finding_refs) {
      if (ref.uncertainty === 'INSUFFICIENT_DATA' || ref.uncertainty === 'PROCESSING_LIMITATION') {
        uncertaintyPoints = Math.min(14, uncertaintyPoints + 4);
        continue;
      }

      if (!ref.is_anomalous) continue;

      switch (ref.finding_type) {
        case 'AI_GENERATOR_SIGNATURE':
          rawScore += 82;
          factors.push({ label: 'AI generator signature in container metadata', points: 82 });
          break;
        case 'LIP_SYNC_MISMATCH_CANDIDATE':
          rawScore += 28;
          factors.push({ label: 'Audio-video lip-sync mismatch intervals', points: 28 });
          break;
        case 'FACIAL_BLENDING_DISPARITY':
          rawScore += 26;
          factors.push({ label: 'Facial boundary / skin texture disparity', points: 26 });
          break;
        case 'FACIAL_MOVEMENT_ANOMALY':
          rawScore += 22;
          factors.push({ label: 'Facial landmark trajectory instability', points: 22 });
          break;
        case 'TEMPORAL_FLICKER_DISCONTINUITY':
          rawScore += 18;
          factors.push({ label: 'Intra-scene temporal flicker / discontinuity', points: 18 });
          break;
        case 'FREQUENCY_PERIODIC_ARTIFACT':
          rawScore += 14;
          factors.push({ label: '2D-DCT high-frequency periodic peak', points: 14 });
          break;
        case 'OPTICAL_FLOW_DIVERGENCE':
          rawScore += 12;
          factors.push({ label: 'Optical-flow motion or lighting divergence', points: 12 });
          break;
        case 'EDITING_ENCODER_SIGNATURE':
          editPoints += 8;
          factors.push({ label: 'Editing / transcoding software encoder tag', points: 8 });
          break;
        case 'FREQUENCY_COMPRESSION_QUANTIZATION':
          editPoints += 6;
          factors.push({ label: 'Low-bitrate compression DCT periodicity', points: 6 });
          break;
        default: {
          const pts = ref.strength === 'STRONG' ? 20 : ref.strength === 'MODERATE' ? 12 : 6;
          rawScore += pts;
          factors.push({ label: ref.title.slice(0, 60), points: pts });
          break;
        }
      }
    }
  }

  if (sceneCutCount > 0) {
    editPoints += 4;
    factors.push({ label: `${sceneCutCount} editorial scene cut(s) detected`, points: 4 });
  }

  // Cap conventional editing / compression contribution so ordinary editing never falsely scores as high AI
  rawScore += Math.min(16, editPoints);

  // If no strong AI anomalies occurred, add a modest uncertainty floor for missing face/speech signals
  if (rawScore < 20 && uncertaintyPoints > 0) {
    rawScore += uncertaintyPoints;
    factors.push({ label: 'Limited face/speech visibility (incomplete coverage)', points: uncertaintyPoints });
  }

  if (factors.length === 0) {
    factors.push({ label: 'Baseline residual (no elevated AI anomalies observed)', points: 4 });
  }

  const score = Math.max(4, Math.min(98, Math.round(rawScore)));

  let band: AiPotentialRatingOutput['band'];
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
      '0–100 Heuristic AI Potential Index (uncalibrated): scores near 100 indicate strong AI/synthetic indicators; scores near 0 indicate few detected AI signals. Not a certified probability — confirm with human review.',
    factors,
  };
}

/**
 * Synthesizes an evidence-based Final Authenticity Assessment from real completed layers.
 * Includes both a structured categorical outcome and a transparent 0-100 heuristic AI Potential Rating.
 */
export function buildFinalVideoAssessment(
  layers: VideoLayerOutput[],
  sceneCutCount: number
): FinalVideoAssessmentOutput {
  const supporting: FinalVideoAssessmentOutput['supporting_findings'] = [];
  const uncertain: FinalVideoAssessmentOutput['uncertain_findings'] = [];
  const unavailableLayers: string[] = [];

  let aiGenSignals = 0;
  let aiGenStrong = false;
  let aiManipSignals = 0;
  let conventionalEditSignals = 0;
  let insufficientDataLayers = 0;
  let completedAnalyticalLayers = 0;

  for (const layer of layers) {
    if (layer.processing_status === 'UNAVAILABLE' || layer.processing_status === 'FAILED') {
      unavailableLayers.push(`${layer.layer_name} (${layer.processing_status})`);
      continue;
    }

    completedAnalyticalLayers++;

    for (const ref of layer.finding_refs) {
      if (ref.uncertainty === 'INSUFFICIENT_DATA' || ref.uncertainty === 'PROCESSING_LIMITATION') {
        insufficientDataLayers++;
        uncertain.push({
          finding_id: ref.finding_id,
          layer_name: layer.layer_name,
          title: ref.title,
          reason: ref.uncertainty.replace(/_/g, ' '),
        });
        continue;
      }

      if (ref.is_anomalous) {
        supporting.push({
          finding_id: ref.finding_id,
          layer_name: layer.layer_name,
          title: ref.title,
          strength: ref.strength,
        });

        if (ref.category_tag === 'AI_GEN') {
          aiGenSignals++;
          if (ref.finding_type === 'AI_GENERATOR_SIGNATURE') aiGenStrong = true;
        } else if (ref.category_tag === 'AI_MANIP') {
          aiManipSignals++;
        } else if (ref.category_tag === 'CONVENTIONAL_EDIT') {
          conventionalEditSignals++;
        }
      } else if (ref.uncertainty === 'AMBIGUOUS' || ref.uncertainty === 'REQUIRES_HUMAN_REVIEW') {
        uncertain.push({
          finding_id: ref.finding_id,
          layer_name: layer.layer_name,
          title: ref.title,
          reason: ref.uncertainty.replace(/_/g, ' '),
        });
      }
    }
  }

  if (sceneCutCount > 0) {
    conventionalEditSignals++;
  }

  const distinctAnomalyCategories =
    (aiGenSignals > 0 ? 1 : 0) +
    (aiManipSignals > 0 ? 1 : 0) +
    (conventionalEditSignals > 0 ? 1 : 0);

  let outcome: FinalAssessmentOutcome;
  let summary: string;

  if (completedAnalyticalLayers < 3) {
    outcome = 'INCONCLUSIVE';
    summary =
      'Too few forensic analysis layers completed successfully to support an evidence-based assessment.';
  } else if (aiGenStrong && aiManipSignals === 0) {
    outcome = 'POTENTIAL AI-GENERATED CONTENT INDICATORS';
    summary =
      'Container metadata or provenance inspection identified a known AI video-generation signature alongside automated frame checks. Human verification is required.';
  } else if (distinctAnomalyCategories >= 2 && supporting.length >= 2) {
    outcome = 'MULTIPLE INCONSISTENCIES REQUIRE REVIEW';
    summary = `Multiple layers surfaced indicators spanning distinct categories (${supporting.length} anomalous observation(s)). Because compression, editing, and synthetic manipulation can overlap, direct human frame-by-frame review is required.`;
  } else if (aiManipSignals >= 1) {
    outcome = 'POTENTIAL AI-MANIPULATION INDICATORS';
    summary = `Facial texture, landmark stability, or lip-sync alignment layers flagged ${aiManipSignals} indicator(s) warranting investigator inspection of the referenced frames and timestamps.`;
  } else if (aiGenSignals >= 2) {
    outcome = 'POTENTIAL AI-GENERATED CONTENT INDICATORS';
    summary = `Temporal, frequency, or motion-physics layers observed ${aiGenSignals} heuristic indicator(s) consistent with synthetic rendering or heavy post-processing. Confirm against source provenance.`;
  } else if (conventionalEditSignals >= 1 && aiManipSignals === 0 && aiGenSignals === 0) {
    outcome = 'POTENTIAL CONVENTIONAL EDITING INDICATORS';
    summary =
      'Observed editing/transcoding software signatures or scene transitions without facial manipulation or strong synthetic-generation indicators. Consistent with standard video editing or re-encoding.';
  } else if (insufficientDataLayers >= 3 && supporting.length === 0) {
    outcome = 'INCONCLUSIVE';
    summary =
      'Multiple modality-dependent layers (e.g., facial localization or speech lip-sync) lacked sufficient visible facial or speech signal to evaluate, leaving the overall authenticity determination inconclusive.';
  } else if (supporting.length === 0) {
    outcome = 'NO SIGNIFICANT INDICATORS DETECTED';
    summary =
      'Completed forensic layers did not surface elevated manipulation or editing anomalies across sampled frames. Absence of detected indicators does NOT prove the video is authentic or unedited.';
  } else {
    outcome = 'INCONCLUSIVE';
    summary =
      'Low-strength heuristic observations were noted without corroborating multi-layer evidence; human contextual verification is required.';
  }

  const aiPotentialRating = computeVideoAiPotentialRating(layers, sceneCutCount);

  return {
    outcome,
    summary,
    ai_potential_rating: aiPotentialRating,
    supporting_findings: supporting,
    uncertain_findings: uncertain,
    unavailable_layers: unavailableLayers,
    methodology_notice:
      'This assessment combines deterministic metadata checks and computer-vision heuristics into both a categorical summary and a transparent 0–100 uncalibrated AI Potential Index. A low score NEVER automatically certifies a video as genuine.',
    evaluated_at: nowIso(),
  };
}

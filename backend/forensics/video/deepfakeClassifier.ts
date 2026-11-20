import fs from 'fs';
import path from 'path';
import { DATA_ROOT } from '../../storage.ts';
import { insertFinding } from '../../db.ts';
import type { VideoAnalysisContext, VideoLayerOutput } from './types.ts';

/**
 * Layer 8 — Pretrained Deepfake Detection Model
 *
 * Checks for a verified, legally licensed local ONNX model manifest & runtime.
 * If no verified local pretrained model is installed in this environment, reports
 * UNAVAILABLE truthfully rather than fabricating a neural classifier or simulated score.
 */
export async function runDeepfakeClassifierLayer(
  ctx: VideoAnalysisContext
): Promise<VideoLayerOutput> {
  const layerId = 'LAYER_8_DEEPFAKE_MODEL';
  const layerName = 'Layer 8 — Pretrained Deepfake Detection Model';
  const ref = `${ctx.original_filename} (${ctx.evidence_id})`;

  const manifestPath = path.join(DATA_ROOT, 'models', 'deepfake_manifest.json');
  const modelManifestExists = fs.existsSync(manifestPath);

  if (!modelManifestExists) {
    const fid = insertFinding({
      investigation_id: ctx.investigation_id,
      evidence_id: ctx.evidence_id,
      module: 'VIDEO_FORENSICS',
      analysis_layer: layerId,
      finding_type: 'MODEL_RUNTIME_UNAVAILABLE',
      title: 'Pretrained deepfake neural model not installed — Layer 8 reported as UNAVAILABLE',
      description:
        'Checked local model registry (data/models/deepfake_manifest.json) for a verified, CPU-compatible pretrained deepfake classifier (e.g., ONNX Runtime EfficientNet-B4 / Xception face-crop weights). No verified local model weights are installed in this container. TruthLens X never emits simulated neural scores or mock classifiers.',
      actual_observation: 'No verified pretrained ONNX/PyTorch deepfake model weights present on host.',
      evidence_reference: ref,
      timestamp_or_region: 'Model Registry Check',
      frame_reference: 'N/A',
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'LOW',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      uncertainty: 'PROCESSING_LIMITATION',
      limitations:
        'Without verified pretrained deepfake model weights, neural facial manipulation inference is unavailable. Rely on Layers 1–7 deterministic/heuristic observations and human investigator review.',
      alternative_explanation:
        'Install a verified, licensed CPU-compatible ONNX face-crop deepfake model and manifest under data/models/ to activate Layer 8 inference.',
    });

    return {
      layer_number: 8,
      layer_id: layerId,
      layer_name: layerName,
      status: 'UNAVAILABLE',
      processing_status: 'UNAVAILABLE',
      summary: 'No verified local pretrained deepfake model weights installed in this runtime.',
      actual_result:
        'UNAVAILABLE — Expected verified CPU-compatible ONNX model manifest at data/models/deepfake_manifest.json. Zero simulated scores generated.',
      evidence_strength: 'NONE',
      model_confidence: null,
      calibration_status: 'NOT_APPLICABLE',
      relevant_timestamps: [],
      evidence_references: [ref],
      explanation:
        'Layer 8 supports CPU-compatible pretrained ONNX face-crop classifiers (224×224 RGB normalized face crops) with explicit license verification and calibration disclosure. Because no verified weights are installed in this container, Layer 8 is marked UNAVAILABLE rather than faked.',
      limitations:
        'Even when a pretrained deepfake detector is installed, out-of-distribution generative models, heavy re-compression, and uncalibrated logits limit standalone reliability.',
      alternative_explanation:
        'Environment does not bundle large neural model weights; Layers 1–7 provide real deterministic and computer-vision analysis.',
      metrics: {
        runtime_checked: 'onnxruntime-node / data/models/deepfake_manifest.json',
        model_installed: false,
        supported_input_spec: '224x224 RGB aligned face crops (float32 NCHW)',
        calibration_policy: 'Explicitly labeled UNCALIBRATED unless temperature-calibrated on a documented benchmark',
      },
      finding_ids: [fid],
      finding_refs: [
        {
          finding_id: fid,
          layer_id: layerId,
          layer_name: layerName,
          title: 'Pretrained deepfake neural model not installed — Layer 8 reported as UNAVAILABLE',
          strength: 'LOW',
          uncertainty: 'PROCESSING_LIMITATION',
          finding_type: 'MODEL_RUNTIME_UNAVAILABLE',
          is_anomalous: false,
          category_tag: 'UNCERTAIN',
        },
      ],
      timeline_markers: [],
    };
  }

  // If a manifest exists in future deployments without an installed ONNX runtime, report cleanly
  return {
    layer_number: 8,
    layer_id: layerId,
    layer_name: layerName,
    status: 'UNAVAILABLE',
    processing_status: 'UNAVAILABLE',
    summary: 'Model manifest detected, but ONNX inference runtime is not linked in this build.',
    actual_result: 'UNAVAILABLE — onnxruntime-node runtime required to execute model weights.',
    evidence_strength: 'NONE',
    model_confidence: null,
    calibration_status: 'NOT_APPLICABLE',
    relevant_timestamps: [],
    evidence_references: [ref],
    explanation: 'Model execution requires onnxruntime-node.',
    limitations: 'Runtime dependency missing.',
    alternative_explanation: 'Install onnxruntime-node to run local ONNX model inference.',
    metrics: { model_installed: true, runtime_available: false },
    finding_ids: [],
    finding_refs: [],
    timeline_markers: [],
  };
}

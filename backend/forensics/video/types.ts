export interface DecodedFrame {
  index: number;
  timestamp_sec: number;
  timestamp_formatted: string;
  file_path: string;
  url: string;
  width: number; // analysis raster width (e.g. 240)
  height: number; // analysis raster height (e.g. 135)
  rgb: Uint8Array; // width * height * 3
  gray: Float32Array; // width * height (0..255)
  mean_luma: number;
  sharpness_laplacian: number;
  is_scene_change: boolean;
}

export interface FaceLandmarks {
  bbox: { x: number; y: number; w: number; h: number };
  left_eye: { x: number; y: number; darkness: number };
  right_eye: { x: number; y: number; darkness: number };
  nose: { x: number; y: number };
  mouth: { x: number; y: number; w: number; h: number; openness: number };
  roll_deg: number;
  skin_ratio: number;
  confidence: number;
  faces_count?: number;
  secondary_boxes?: Array<{ x: number; y: number; w: number; h: number }>;
}

export interface VideoLayerFindingRef {
  finding_id: string;
  layer_id: string;
  layer_name: string;
  title: string;
  strength: 'LOW' | 'MODERATE' | 'STRONG';
  uncertainty: string;
  finding_type: string;
  is_anomalous: boolean;
  category_tag: 'AI_GEN' | 'AI_MANIP' | 'CONVENTIONAL_EDIT' | 'UNCERTAIN' | 'BASELINE';
}

export interface VideoTimelineMarkerInternal {
  id: string;
  timestamp_sec: number;
  end_timestamp_sec?: number;
  timestamp_formatted: string;
  marker_type: 'FACIAL' | 'LIP_SYNC' | 'TEMPORAL' | 'MOTION' | 'MODEL' | 'METADATA';
  layer_id: string;
  finding_id?: string | null;
  frame_index?: number | null;
  title: string;
  detail: string;
  severity: 'INFO' | 'REVIEW' | 'ELEVATED';
}

export interface VideoLayerOutput {
  layer_number: number;
  layer_id: string;
  layer_name: string;
  status: 'COMPLETED' | 'PROCESSING' | 'UNAVAILABLE' | 'FAILED' | 'REQUIRES_REVIEW';
  processing_status: 'COMPLETED' | 'PROCESSING' | 'UNAVAILABLE' | 'FAILED';
  summary: string;
  actual_result: string;
  evidence_strength: 'LOW' | 'MODERATE' | 'STRONG' | 'NONE';
  model_confidence: string | null;
  calibration_status: 'NOT_APPLICABLE' | 'CALIBRATED' | 'UNCALIBRATED';
  relevant_timestamps: Array<{ start_sec: number; end_sec?: number; label: string }>;
  evidence_references: string[];
  explanation: string;
  limitations: string;
  alternative_explanation: string;
  overlay_url?: string | null;
  overlay_caption?: string | null;
  metrics: Record<string, any>;
  finding_ids: string[];
  finding_refs: VideoLayerFindingRef[];
  timeline_markers: VideoTimelineMarkerInternal[];
}

export interface VideoAnalysisContext {
  investigation_id: string;
  evidence_id: string;
  original_path: string;
  original_filename: string;
  file_size: number;
  deriv_dir: string;
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
  probe_raw: any;
  extracted_audio_path: string | null;
  frames: DecodedFrame[];
  scene_changes: Array<{ timestamp_sec: number; timestamp_formatted: string }>;
  face_detections: Array<FaceLandmarks | null>;
}

export function formatTs(sec: number): string {
  const s = Math.max(0, sec);
  const mins = Math.floor(s / 60);
  const rem = s - mins * 60;
  return `${String(mins).padStart(2, '0')}:${rem.toFixed(2).padStart(5, '0')}`;
}

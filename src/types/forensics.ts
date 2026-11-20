export type MediaType = 'image' | 'video' | 'audio' | 'text';

export type InvestigationStatus = 'OPEN' | 'IN_PROGRESS' | 'REVIEWED' | 'CLOSED';

export type ProcessingStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type AnalysisCategory =
  | 'DETERMINISTIC'
  | 'STATISTICAL_HEURISTIC'
  | 'MODEL_BASED'
  | 'HUMAN_REVIEWED';

export type EvidenceStrength = 'LOW' | 'MODERATE' | 'STRONG';

export type UncertaintyTag =
  | 'NONE'
  | 'INSUFFICIENT_DATA'
  | 'PROCESSING_LIMITATION'
  | 'AMBIGUOUS'
  | 'REQUIRES_HUMAN_REVIEW';

export type ReviewStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'INCONCLUSIVE'
  | 'FURTHER_REVIEW';

export type RelationshipType =
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'RELATED'
  | 'REQUIRES_REVIEW';

export type TextRecordRole = 'CAPTION' | 'TRANSCRIPT' | 'CLAIM' | 'DOCUMENT';

export interface Investigation {
  id: string;
  title: string;
  description: string;
  case_type: 'REAL' | 'DEMONSTRATION';
  status: InvestigationStatus;
  created_at: string;
  updated_at: string;
  evidence_count?: number;
  finding_count?: number;
  relationship_count?: number;
  reviewed_count?: number;
}

export interface EvidenceItem {
  id: string;
  investigation_id: string;
  original_filename: string;
  stored_filename: string;
  media_type: MediaType;
  file_size: number;
  mime_type: string;
  sha256_hash: string;
  description: string;
  uploaded_at: string;
  processing_status: ProcessingStatus;
  analysis?: AnalysisRecord | null;
}

export interface AnalysisRecord {
  id: string;
  evidence_id: string;
  analysis_type: string;
  status: ProcessingStatus;
  started_at: string;
  completed_at: string | null;
  result: Record<string, any>;
}

export interface ReviewRecord {
  id: string;
  finding_id: string;
  reviewer_decision: ReviewStatus;
  reviewer_notes: string;
  reviewed_at: string;
}

export type LayerProcessingStatus =
  | 'COMPLETED'
  | 'PROCESSING'
  | 'UNAVAILABLE'
  | 'FAILED'
  | 'REQUIRES_REVIEW';

export type ProvenanceStatus =
  | 'PRESENT_AND_VERIFIABLE'
  | 'PRESENT_BUT_UNVERIFIABLE'
  | 'MISSING'
  | 'UNSUPPORTED';

export type FinalAssessmentOutcome =
  | 'NO SIGNIFICANT INDICATORS DETECTED'
  | 'POTENTIAL AI-GENERATED CONTENT INDICATORS'
  | 'POTENTIAL AI-MANIPULATION INDICATORS'
  | 'POTENTIAL CONVENTIONAL EDITING INDICATORS'
  | 'MULTIPLE INCONSISTENCIES REQUIRE REVIEW'
  | 'INCONCLUSIVE';

export interface VideoTimelineMarker {
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

export interface VideoLayerResult {
  layer_number: number;
  layer_id: string;
  layer_name: string;
  status: LayerProcessingStatus;
  processing_status: 'COMPLETED' | 'PROCESSING' | 'UNAVAILABLE' | 'FAILED';
  summary: string;
  actual_result: string;
  evidence_strength: EvidenceStrength | 'NONE';
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
}

export interface AiPotentialRating {
  score: number;
  band: 'LOW' | 'MODERATE' | 'HIGH' | 'VERY_HIGH';
  simple_verdict: string;
  scale_note: string;
  factors: Array<{ label: string; points: number }>;
}

export interface FinalVideoAssessment {
  outcome: FinalAssessmentOutcome;
  summary: string;
  ai_potential_rating?: AiPotentialRating;
  supporting_findings: Array<{ finding_id: string; layer_name: string; title: string; strength: string }>;
  uncertain_findings: Array<{ finding_id: string; layer_name: string; title: string; reason: string }>;
  unavailable_layers: string[];
  methodology_notice: string;
  evaluated_at: string;
}

export interface Finding {
  id: string;
  investigation_id: string;
  evidence_id: string | null;
  module: string;
  finding_type: string;
  title: string;
  description: string;
  evidence_reference: string;
  timestamp_or_region: string;
  analysis_category: AnalysisCategory;
  evidence_strength: EvidenceStrength;
  model_confidence: string | null;
  uncertainty: UncertaintyTag;
  limitations: string;
  alternative_explanation: string;
  review_status: ReviewStatus;
  created_at: string;
  latest_review?: ReviewRecord | null;
  analysis_layer?: string;
  actual_observation?: string;
  start_timestamp?: number | null;
  end_timestamp?: number | null;
  frame_reference?: string;
  calibration_status?: string;
}

export interface Relationship {
  id: string;
  investigation_id: string;
  source_finding_id: string | null;
  target_finding_id: string | null;
  source_evidence_id: string | null;
  target_evidence_id: string | null;
  source_label: string;
  target_label: string;
  relationship_type: RelationshipType;
  signal_type: string;
  explanation: string;
  supporting_references: string[];
  created_at: string;
}

export interface AuditEvent {
  id: string;
  investigation_id: string;
  evidence_id: string | null;
  event_type: string;
  description: string;
  timestamp: string;
  details: Record<string, any>;
}

export interface TextRecord {
  id: string;
  investigation_id: string;
  evidence_id: string | null;
  role: TextRecordRole;
  label: string;
  content: string;
  segments: Array<{ start: number; end: number; text: string }>;
  created_at: string;
}

export interface ReportRecord {
  id: string;
  investigation_id: string;
  investigation_title?: string;
  filename: string;
  generated_at: string;
  summary: Record<string, any>;
}

export interface IntegrityCheckResult {
  evidence_id: string;
  original_filename: string;
  recorded_hash: string;
  current_hash: string | null;
  matches: boolean;
  file_exists: boolean;
  verified_at: string;
  note: string;
}

export interface HealthInfo {
  status: string;
  database: string;
  ffmpeg_available: boolean;
  ffprobe_available: boolean;
  whisper_available: boolean;
  sharp_available: boolean;
  exifr_available: boolean;
  pdfkit_available: boolean;
  max_upload_mb: number;
  storage_stats: {
    investigations: number;
    evidence_files: number;
    findings: number;
    relationships: number;
    reports: number;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  error: string | null;
}

export type NavPage =
  | 'overview'
  | 'new-investigation'
  | 'image-forensics'
  | 'video-forensics'
  | 'audio-forensics'
  | 'text-analysis'
  | 'cross-modal'
  | 'timeline'
  | 'history'
  | 'reports'
  | 'settings';

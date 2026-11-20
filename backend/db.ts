import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { DB_PATH, ensureStorageDirs } from './storage.ts';

ensureStorageDirs();

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS investigations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      case_type TEXT NOT NULL DEFAULT 'REAL',
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      sha256_hash TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT NOT NULL,
      processing_status TEXT NOT NULL DEFAULT 'PENDING',
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id TEXT PRIMARY KEY,
      evidence_id TEXT NOT NULL,
      analysis_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      result_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS findings (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      evidence_id TEXT,
      module TEXT NOT NULL,
      finding_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence_reference TEXT NOT NULL DEFAULT '',
      timestamp_or_region TEXT NOT NULL DEFAULT 'N/A',
      analysis_category TEXT NOT NULL DEFAULT 'DETERMINISTIC',
      evidence_strength TEXT NOT NULL DEFAULT 'LOW',
      model_confidence TEXT,
      uncertainty TEXT NOT NULL DEFAULT 'NONE',
      limitations TEXT NOT NULL DEFAULT '',
      alternative_explanation TEXT NOT NULL DEFAULT '',
      review_status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE,
      FOREIGN KEY (evidence_id) REFERENCES evidence(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      source_finding_id TEXT,
      target_finding_id TEXT,
      source_evidence_id TEXT,
      target_evidence_id TEXT,
      source_label TEXT NOT NULL DEFAULT '',
      target_label TEXT NOT NULL DEFAULT '',
      relationship_type TEXT NOT NULL,
      signal_type TEXT NOT NULL DEFAULT 'GENERAL',
      explanation TEXT NOT NULL,
      supporting_references_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      reviewer_decision TEXT NOT NULL,
      reviewer_notes TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT NOT NULL,
      FOREIGN KEY (finding_id) REFERENCES findings(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      evidence_id TEXT,
      event_type TEXT NOT NULL,
      description TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS text_records (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      evidence_id TEXT,
      role TEXT NOT NULL,
      label TEXT NOT NULL,
      content TEXT NOT NULL,
      segments_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      FOREIGN KEY (investigation_id) REFERENCES investigations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_inv ON evidence(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_findings_inv ON findings(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_findings_ev ON findings(evidence_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_inv ON relationships(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_audit_inv ON audit_events(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_text_inv ON text_records(investigation_id);
  `);

  const defaults: Array<[string, string]> = [
    ['ela_quality', '90'],
    ['scene_threshold', '0.30'],
    ['silence_noise_db', '-35'],
    ['silence_min_duration', '0.4'],
    ['video_sample_frames', '10'],
    ['analyst_name', 'Lead Forensic Analyst'],
    ['organization_name', 'TruthLens X Digital Forensics Lab'],
  ];

  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)'
  );
  for (const [k, v] of defaults) {
    insertSetting.run(k, v);
  }

  // Non-breaking schema extension for Multi-Layer Video Forensics findings
  const existingCols = (
    db.prepare('PRAGMA table_info(findings)').all() as Array<{ name: string }>
  ).map((c) => c.name);

  const extraFindingCols: Array<[string, string]> = [
    ['analysis_layer', "TEXT NOT NULL DEFAULT ''"],
    ['actual_observation', "TEXT NOT NULL DEFAULT ''"],
    ['start_timestamp', 'REAL'],
    ['end_timestamp', 'REAL'],
    ['frame_reference', "TEXT NOT NULL DEFAULT ''"],
    ['calibration_status', "TEXT NOT NULL DEFAULT 'NOT_APPLICABLE'"],
  ];

  for (const [colName, colDef] of extraFindingCols) {
    if (!existingCols.includes(colName)) {
      db.exec(`ALTER TABLE findings ADD COLUMN ${colName} ${colDef}`);
    }
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as Array<{
    key: string;
    value: string;
  }>;
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

export function updateSettings(updates: Record<string, string>): Record<string, string> {
  const stmt = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const tx = db.transaction((entries: Array<[string, string]>) => {
    for (const [k, v] of entries) {
      stmt.run(k, String(v));
    }
  });
  tx(Object.entries(updates));
  return getSettings();
}

export function logAuditEvent(params: {
  investigation_id: string;
  evidence_id?: string | null;
  event_type: string;
  description: string;
  details?: Record<string, any>;
}): string {
  const id = `EVT-${uuidv4().slice(0, 8).toUpperCase()}`;
  db.prepare(
    `INSERT INTO audit_events (id, investigation_id, evidence_id, event_type, description, timestamp, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    params.investigation_id,
    params.evidence_id ?? null,
    params.event_type,
    params.description,
    nowIso(),
    JSON.stringify(params.details ?? {})
  );
  return id;
}

export interface NewFindingInput {
  investigation_id: string;
  evidence_id?: string | null;
  module: string;
  finding_type: string;
  title: string;
  description: string;
  evidence_reference: string;
  timestamp_or_region?: string;
  analysis_category: 'DETERMINISTIC' | 'STATISTICAL_HEURISTIC' | 'MODEL_BASED' | 'HUMAN_REVIEWED';
  evidence_strength: 'LOW' | 'MODERATE' | 'STRONG';
  model_confidence?: string | null;
  uncertainty?: 'NONE' | 'INSUFFICIENT_DATA' | 'PROCESSING_LIMITATION' | 'AMBIGUOUS' | 'REQUIRES_HUMAN_REVIEW';
  limitations: string;
  alternative_explanation: string;
  analysis_layer?: string;
  actual_observation?: string;
  start_timestamp?: number | null;
  end_timestamp?: number | null;
  frame_reference?: string;
  calibration_status?: 'NOT_APPLICABLE' | 'CALIBRATED' | 'UNCALIBRATED';
}

export function insertFinding(input: NewFindingInput): string {
  const id = `FND-${uuidv4().slice(0, 8).toUpperCase()}`;
  db.prepare(
    `INSERT INTO findings (
      id, investigation_id, evidence_id, module, finding_type, title, description,
      evidence_reference, timestamp_or_region, analysis_category, evidence_strength,
      model_confidence, uncertainty, limitations, alternative_explanation, review_status, created_at,
      analysis_layer, actual_observation, start_timestamp, end_timestamp, frame_reference, calibration_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.investigation_id,
    input.evidence_id ?? null,
    input.module,
    input.finding_type,
    input.title,
    input.description,
    input.evidence_reference,
    input.timestamp_or_region ?? 'N/A',
    input.analysis_category,
    input.evidence_strength,
    input.model_confidence ?? null,
    input.uncertainty ?? 'NONE',
    input.limitations,
    input.alternative_explanation,
    nowIso(),
    input.analysis_layer ?? '',
    input.actual_observation ?? input.description,
    input.start_timestamp ?? null,
    input.end_timestamp ?? null,
    input.frame_reference ?? '',
    input.calibration_status ?? 'NOT_APPLICABLE'
  );

  logAuditEvent({
    investigation_id: input.investigation_id,
    evidence_id: input.evidence_id ?? null,
    event_type: 'FINDING_CREATED',
    description: `[${input.analysis_layer || input.module}] ${input.title}`,
    details: {
      finding_id: id,
      finding_type: input.finding_type,
      layer: input.analysis_layer || null,
      category: input.analysis_category,
      strength: input.evidence_strength,
    },
  });

  return id;
}

export function touchInvestigation(investigationId: string): void {
  db.prepare('UPDATE investigations SET updated_at = ? WHERE id = ?').run(nowIso(), investigationId);
}

initializeDatabase();

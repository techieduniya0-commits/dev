import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import {
  db,
  getSettings,
  logAuditEvent,
  nowIso,
  touchInvestigation,
  updateSettings,
} from './db.ts';
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  ORIGINALS_DIR,
  TMP_DIR,
  checkBinaryCapabilities,
  computeSha256,
  deleteEvidenceFiles,
  deleteInvestigationFiles,
  detectMediaType,
  ensureStorageDirs,
  getOriginalPath,
  isExtensionAllowed,
  sanitizeFilename,
} from './storage.ts';
import { analyzeImageEvidence } from './forensics/imageAnalyzer.ts';
import { analyzeVideoEvidence, getVideoJobStatus } from './forensics/videoAnalyzer.ts';
import { analyzeAudioEvidence } from './forensics/audioAnalyzer.ts';
import { analyzeTextEvidence, compareTexts } from './forensics/textAnalyzer.ts';
import { runCrossModalCorrelation } from './forensics/correlationEngine.ts';
import { generateForensicReport } from './forensics/reportGenerator.ts';
import { createDemonstrationCase } from './forensics/demoGenerator.ts';

ensureStorageDirs();

export const apiRouter = express.Router();

const upload = multer({
  dest: TMP_DIR,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 12,
  },
  fileFilter: (_req, file, cb) => {
    if (!isExtensionAllowed(file.originalname, file.mimetype)) {
      cb(
        new Error(
          `Unsupported file type: "${file.originalname}" (${file.mimetype}). Supported: images, videos, audio, and text documents.`
        )
      );
      return;
    }
    cb(null, true);
  },
});

function ok(res: express.Response, data: any, status = 200) {
  return res.status(status).json({ success: true, data, error: null });
}

function fail(res: express.Response, message: string, status = 400) {
  return res.status(status).json({ success: false, data: null, error: message });
}

function hydrateFindings(rows: any[]) {
  const reviewStmt = db.prepare(
    'SELECT * FROM reviews WHERE finding_id = ? ORDER BY reviewed_at DESC LIMIT 1'
  );
  return rows.map((row) => ({
    ...row,
    latest_review: reviewStmt.get(row.id) || null,
  }));
}

function hydrateEvidenceList(rows: any[]) {
  const analysisStmt = db.prepare(
    'SELECT * FROM analyses WHERE evidence_id = ? ORDER BY started_at DESC LIMIT 1'
  );
  return rows.map((ev) => {
    const an = analysisStmt.get(ev.id) as any;
    return {
      ...ev,
      analysis: an
        ? {
            id: an.id,
            evidence_id: an.evidence_id,
            analysis_type: an.analysis_type,
            status: an.status,
            started_at: an.started_at,
            completed_at: an.completed_at,
            result: (() => {
              try {
                return JSON.parse(an.result_json || '{}');
              } catch {
                return {};
              }
            })(),
          }
        : null,
    };
  });
}

async function runSingleEvidenceAnalysis(ev: any): Promise<any> {
  const origPath = getOriginalPath(ev.investigation_id, ev.stored_filename);
  if (!fs.existsSync(origPath)) {
    throw new Error('Original evidence file is missing from storage.');
  }

  db.prepare("UPDATE evidence SET processing_status = 'PROCESSING' WHERE id = ?").run(ev.id);
  // Clear prior automated findings for this specific evidence so re-analysis stays idempotent
  db.prepare('DELETE FROM findings WHERE evidence_id = ?').run(ev.id);

  const startedAt = nowIso();
  logAuditEvent({
    investigation_id: ev.investigation_id,
    evidence_id: ev.id,
    event_type: 'ANALYSIS_STARTED',
    description: `Started ${ev.media_type.toUpperCase()} forensic analysis on ${ev.original_filename}.`,
  });

  try {
    let result: any;
    let analysisType = `${ev.media_type.toUpperCase()}_FORENSICS`;

    if (ev.media_type === 'image') {
      result = await analyzeImageEvidence({
        investigation_id: ev.investigation_id,
        evidence_id: ev.id,
        original_path: origPath,
        original_filename: ev.original_filename,
        file_size: ev.file_size,
        sha256_hash: ev.sha256_hash,
      });
    } else if (ev.media_type === 'video') {
      result = await analyzeVideoEvidence({
        investigation_id: ev.investigation_id,
        evidence_id: ev.id,
        original_path: origPath,
        original_filename: ev.original_filename,
        file_size: ev.file_size,
      });
    } else if (ev.media_type === 'audio') {
      result = await analyzeAudioEvidence({
        investigation_id: ev.investigation_id,
        evidence_id: ev.id,
        original_path: origPath,
        original_filename: ev.original_filename,
        file_size: ev.file_size,
      });
    } else if (ev.media_type === 'text') {
      analysisType = 'TEXT_ANALYSIS';
      const content = fs.readFileSync(origPath, 'utf8').slice(0, 200000);
      result = await analyzeTextEvidence({
        investigation_id: ev.investigation_id,
        evidence_id: ev.id,
        original_filename: ev.original_filename,
        content,
      });

      // Ensure a TextRecord exists for uploaded text documents so side-by-side comparison works immediately
      const existingTr = db
        .prepare('SELECT id FROM text_records WHERE evidence_id = ?')
        .get(ev.id);
      if (!existingTr) {
        db.prepare(
          `INSERT INTO text_records (id, investigation_id, evidence_id, role, label, content, segments_json, created_at)
           VALUES (?, ?, ?, 'DOCUMENT', ?, ?, '[]', ?)`
        ).run(
          `TXT-${uuidv4().slice(0, 8).toUpperCase()}`,
          ev.investigation_id,
          ev.id,
          ev.original_filename,
          content,
          nowIso()
        );
      }
    } else {
      throw new Error(`Unsupported media type: ${ev.media_type}`);
    }

    const completedAt = nowIso();
    const anId = `ANL-${uuidv4().slice(0, 8).toUpperCase()}`;
    db.prepare(
      `INSERT INTO analyses (id, evidence_id, analysis_type, status, started_at, completed_at, result_json)
       VALUES (?, ?, ?, 'COMPLETED', ?, ?, ?)`
    ).run(anId, ev.id, analysisType, startedAt, completedAt, JSON.stringify(result));

    db.prepare("UPDATE evidence SET processing_status = 'COMPLETED' WHERE id = ?").run(ev.id);
    db.prepare(
      "UPDATE investigations SET status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END, updated_at = ? WHERE id = ?"
    ).run(completedAt, ev.investigation_id);

    logAuditEvent({
      investigation_id: ev.investigation_id,
      evidence_id: ev.id,
      event_type: 'ANALYSIS_COMPLETED',
      description: `Completed ${analysisType} for ${ev.original_filename}.`,
      details: { analysis_id: anId },
    });

    return {
      analysis_id: anId,
      evidence_id: ev.id,
      analysis_type: analysisType,
      status: 'COMPLETED',
      result,
    };
  } catch (err: any) {
    const failedAt = nowIso();
    const errMsg = err?.message || 'Forensic processing failed.';
    db.prepare("UPDATE evidence SET processing_status = 'FAILED' WHERE id = ?").run(ev.id);
    db.prepare(
      `INSERT INTO analyses (id, evidence_id, analysis_type, status, started_at, completed_at, result_json)
       VALUES (?, ?, ?, 'FAILED', ?, ?, ?)`
    ).run(
      `ANL-${uuidv4().slice(0, 8).toUpperCase()}`,
      ev.id,
      `${ev.media_type.toUpperCase()}_FORENSICS`,
      startedAt,
      failedAt,
      JSON.stringify({ error: errMsg })
    );

    logAuditEvent({
      investigation_id: ev.investigation_id,
      evidence_id: ev.id,
      event_type: 'ANALYSIS_FAILED',
      description: `Analysis failed on ${ev.original_filename}: ${errMsg}`,
      details: { error: errMsg },
    });

    throw err;
  }
}

// ============================================================================
// SYSTEM & OVERVIEW
// ============================================================================

apiRouter.get('/health', async (_req, res) => {
  try {
    const caps = await checkBinaryCapabilities();
    const invCount = (db.prepare('SELECT COUNT(*) as c FROM investigations').get() as any).c;
    const evCount = (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as any).c;
    const fndCount = (db.prepare('SELECT COUNT(*) as c FROM findings').get() as any).c;
    const relCount = (db.prepare('SELECT COUNT(*) as c FROM relationships').get() as any).c;
    const rptCount = (db.prepare('SELECT COUNT(*) as c FROM reports').get() as any).c;

    return ok(res, {
      status: 'HEALTHY',
      database: 'SQLite (WAL persistent)',
      ffmpeg_available: caps.ffmpeg,
      ffprobe_available: caps.ffprobe,
      whisper_available: caps.whisper,
      sharp_available: true,
      exifr_available: true,
      pdfkit_available: true,
      max_upload_mb: MAX_UPLOAD_MB,
      storage_stats: {
        investigations: invCount,
        evidence_files: evCount,
        findings: fndCount,
        relationships: relCount,
        reports: rptCount,
      },
    });
  } catch (err: any) {
    return fail(res, err?.message || 'Health check failed', 500);
  }
});

apiRouter.get('/overview', (_req, res) => {
  try {
    const counts = {
      investigations: (db.prepare('SELECT COUNT(*) as c FROM investigations').get() as any).c,
      evidence_total: (db.prepare('SELECT COUNT(*) as c FROM evidence').get() as any).c,
      evidence_image: (db.prepare("SELECT COUNT(*) as c FROM evidence WHERE media_type = 'image'").get() as any).c,
      evidence_video: (db.prepare("SELECT COUNT(*) as c FROM evidence WHERE media_type = 'video'").get() as any).c,
      evidence_audio: (db.prepare("SELECT COUNT(*) as c FROM evidence WHERE media_type = 'audio'").get() as any).c,
      evidence_text: (db.prepare("SELECT COUNT(*) as c FROM evidence WHERE media_type = 'text'").get() as any).c,
      findings_total: (db.prepare('SELECT COUNT(*) as c FROM findings').get() as any).c,
      findings_reviewed: (db.prepare("SELECT COUNT(*) as c FROM findings WHERE review_status != 'PENDING'").get() as any).c,
      relationships_total: (db.prepare('SELECT COUNT(*) as c FROM relationships').get() as any).c,
      contradictions_total: (db.prepare("SELECT COUNT(*) as c FROM relationships WHERE relationship_type = 'CONTRADICTS'").get() as any).c,
      reports_total: (db.prepare('SELECT COUNT(*) as c FROM reports').get() as any).c,
      processing_pending: (db.prepare("SELECT COUNT(*) as c FROM evidence WHERE processing_status = 'PENDING'").get() as any).c,
      processing_completed: (db.prepare("SELECT COUNT(*) as c FROM evidence WHERE processing_status = 'COMPLETED'").get() as any).c,
      processing_failed: (db.prepare("SELECT COUNT(*) as c FROM evidence WHERE processing_status = 'FAILED'").get() as any).c,
    };

    const recentInvestigations = db
      .prepare(
        `SELECT i.*,
          (SELECT COUNT(*) FROM evidence e WHERE e.investigation_id = i.id) as evidence_count,
          (SELECT COUNT(*) FROM findings f WHERE f.investigation_id = i.id) as finding_count,
          (SELECT COUNT(*) FROM relationships r WHERE r.investigation_id = i.id) as relationship_count,
          (SELECT COUNT(*) FROM findings f WHERE f.investigation_id = i.id AND f.review_status != 'PENDING') as reviewed_count
         FROM investigations i
         ORDER BY i.updated_at DESC
         LIMIT 6`
      )
      .all();

    const recentFindings = hydrateFindings(
      db
        .prepare(
          `SELECT f.*, i.title as investigation_title
           FROM findings f
           JOIN investigations i ON i.id = f.investigation_id
           ORDER BY f.created_at DESC
           LIMIT 8`
        )
        .all()
    );

    const recentActivity = db
      .prepare(
        `SELECT a.*, i.title as investigation_title
         FROM audit_events a
         JOIN investigations i ON i.id = a.investigation_id
         ORDER BY a.timestamp DESC
         LIMIT 10`
      )
      .all()
      .map((row: any) => ({
        ...row,
        details: (() => {
          try {
            return JSON.parse(row.details_json || '{}');
          } catch {
            return {};
          }
        })(),
      }));

    return ok(res, {
      counts,
      recent_investigations: recentInvestigations,
      recent_findings: recentFindings,
      recent_activity: recentActivity,
    });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to load overview', 500);
  }
});

apiRouter.get('/settings', (_req, res) => {
  return ok(res, getSettings());
});

apiRouter.put('/settings', (req, res) => {
  try {
    const body = req.body || {};
    const allowed = [
      'ela_quality',
      'scene_threshold',
      'silence_noise_db',
      'silence_min_duration',
      'video_sample_frames',
      'analyst_name',
      'organization_name',
    ];
    const filtered: Record<string, string> = {};
    for (const k of allowed) {
      if (body[k] !== undefined && body[k] !== null) {
        filtered[k] = String(body[k]).trim().slice(0, 120);
      }
    }
    return ok(res, updateSettings(filtered));
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to update settings', 400);
  }
});

apiRouter.post('/demo/create', async (_req, res) => {
  try {
    const result = await createDemonstrationCase();
    return ok(res, result, 201);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to generate demonstration case', 500);
  }
});

// ============================================================================
// INVESTIGATIONS
// ============================================================================

apiRouter.post('/investigations', (req, res) => {
  try {
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    if (!title || title.length < 2) {
      return fail(res, 'Investigation title must be at least 2 characters.', 400);
    }
    const id = `INV-${uuidv4().slice(0, 8).toUpperCase()}`;
    const ts = nowIso();
    db.prepare(
      `INSERT INTO investigations (id, title, description, case_type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'REAL', 'OPEN', ?, ?)`
    ).run(id, title.slice(0, 180), description.slice(0, 2000), ts, ts);

    logAuditEvent({
      investigation_id: id,
      event_type: 'INVESTIGATION_CREATED',
      description: `Created investigation "${title}".`,
    });

    const created = db.prepare('SELECT * FROM investigations WHERE id = ?').get(id);
    return ok(res, created, 201);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to create investigation', 500);
  }
});

apiRouter.get('/investigations', (_req, res) => {
  try {
    const rows = db
      .prepare(
        `SELECT i.*,
          (SELECT COUNT(*) FROM evidence e WHERE e.investigation_id = i.id) as evidence_count,
          (SELECT COUNT(*) FROM findings f WHERE f.investigation_id = i.id) as finding_count,
          (SELECT COUNT(*) FROM relationships r WHERE r.investigation_id = i.id) as relationship_count,
          (SELECT COUNT(*) FROM findings f WHERE f.investigation_id = i.id AND f.review_status != 'PENDING') as reviewed_count
         FROM investigations i
         ORDER BY i.updated_at DESC`
      )
      .all();
    return ok(res, rows);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to list investigations', 500);
  }
});

apiRouter.get('/investigations/:id', (req, res) => {
  try {
    const inv = db
      .prepare(
        `SELECT i.*,
          (SELECT COUNT(*) FROM evidence e WHERE e.investigation_id = i.id) as evidence_count,
          (SELECT COUNT(*) FROM findings f WHERE f.investigation_id = i.id) as finding_count,
          (SELECT COUNT(*) FROM relationships r WHERE r.investigation_id = i.id) as relationship_count,
          (SELECT COUNT(*) FROM findings f WHERE f.investigation_id = i.id AND f.review_status != 'PENDING') as reviewed_count
         FROM investigations i
         WHERE i.id = ?`
      )
      .get(req.params.id);

    if (!inv) return fail(res, 'Investigation not found.', 404);

    const evidence = hydrateEvidenceList(
      db
        .prepare('SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at DESC')
        .all(req.params.id)
    );
    const findings = hydrateFindings(
      db
        .prepare('SELECT * FROM findings WHERE investigation_id = ? ORDER BY created_at DESC')
        .all(req.params.id)
    );
    const relationships = db
      .prepare('SELECT * FROM relationships WHERE investigation_id = ? ORDER BY created_at DESC')
      .all(req.params.id)
      .map((r: any) => ({
        ...r,
        supporting_references: (() => {
          try {
            return JSON.parse(r.supporting_references_json || '[]');
          } catch {
            return [];
          }
        })(),
      }));
    const textRecords = db
      .prepare('SELECT * FROM text_records WHERE investigation_id = ? ORDER BY created_at DESC')
      .all(req.params.id)
      .map((t: any) => ({
        ...t,
        segments: (() => {
          try {
            return JSON.parse(t.segments_json || '[]');
          } catch {
            return [];
          }
        })(),
      }));

    return ok(res, {
      investigation: inv,
      evidence,
      findings,
      relationships,
      text_records: textRecords,
    });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to fetch investigation', 500);
  }
});

apiRouter.patch('/investigations/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id) as any;
    if (!existing) return fail(res, 'Investigation not found.', 404);

    const allowedStatuses = ['OPEN', 'IN_PROGRESS', 'REVIEWED', 'CLOSED'];
    const nextStatus =
      req.body?.status && allowedStatuses.includes(req.body.status)
        ? req.body.status
        : existing.status;
    const nextTitle = req.body?.title ? String(req.body.title).trim().slice(0, 180) : existing.title;
    const nextDesc =
      req.body?.description !== undefined
        ? String(req.body.description).trim().slice(0, 2000)
        : existing.description;

    db.prepare(
      'UPDATE investigations SET title = ?, description = ?, status = ?, updated_at = ? WHERE id = ?'
    ).run(nextTitle, nextDesc, nextStatus, nowIso(), req.params.id);

    if (nextStatus !== existing.status) {
      logAuditEvent({
        investigation_id: req.params.id,
        event_type: 'STATUS_UPDATED',
        description: `Investigation status changed from ${existing.status} to ${nextStatus}.`,
      });
    }

    return ok(res, db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id));
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to update investigation', 500);
  }
});

apiRouter.delete('/investigations/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id);
    if (!existing) return fail(res, 'Investigation not found.', 404);

    const evIds = (
      db.prepare('SELECT id FROM evidence WHERE investigation_id = ?').all(req.params.id) as Array<{
        id: string;
      }>
    ).map((r) => r.id);

    const reportRows = db
      .prepare('SELECT file_path FROM reports WHERE investigation_id = ?')
      .all(req.params.id) as Array<{ file_path: string }>;
    for (const r of reportRows) {
      if (r.file_path && fs.existsSync(r.file_path)) {
        fs.unlinkSync(r.file_path);
      }
    }

    db.prepare('DELETE FROM investigations WHERE id = ?').run(req.params.id);
    deleteInvestigationFiles(req.params.id, evIds);

    return ok(res, { deleted_id: req.params.id });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to delete investigation', 500);
  }
});

// ============================================================================
// EVIDENCE INGESTION & MANAGEMENT
// ============================================================================

apiRouter.post('/investigations/:id/evidence', (req, res) => {
  const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id);
  if (!inv) return fail(res, 'Investigation not found.', 404);

  upload.array('files', 12)(req, res, async (err: any) => {
    if (err) {
      return fail(res, err.message || 'File upload failed.', 400);
    }

    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      return fail(res, 'No files received in multipart upload ("files" field required).', 400);
    }

    let descriptions: string[] = [];
    if (req.body?.descriptions) {
      try {
        const parsed = JSON.parse(req.body.descriptions);
        if (Array.isArray(parsed)) descriptions = parsed.map(String);
      } catch {
        descriptions = [String(req.body.descriptions)];
      }
    } else if (req.body?.description) {
      descriptions = [String(req.body.description)];
    }

    const invDir = path.join(ORIGINALS_DIR, req.params.id.replace(/[^a-zA-Z0-9_-]/g, ''));
    if (!fs.existsSync(invDir)) {
      fs.mkdirSync(invDir, { recursive: true });
    }

    const inserted: any[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const safeOriginal = sanitizeFilename(f.originalname);
        const mediaType = detectMediaType(safeOriginal, f.mimetype);
        if (!mediaType) {
          if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
          continue;
        }

        const ext = path.extname(safeOriginal).toLowerCase() || '.bin';
        const storedFilename = `${uuidv4()}${ext}`;
        const destPath = path.join(invDir, storedFilename);

        // Move from temp into immutable originals directory
        fs.copyFileSync(f.path, destPath);
        fs.unlinkSync(f.path);

        const hash = await computeSha256(destPath);
        const evId = `EVD-${uuidv4().slice(0, 8).toUpperCase()}`;
        const ts = nowIso();
        const desc = (descriptions[i] || '').trim().slice(0, 1000);

        db.prepare(
          `INSERT INTO evidence (
            id, investigation_id, original_filename, stored_filename, media_type,
            file_size, mime_type, sha256_hash, description, uploaded_at, processing_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
        ).run(
          evId,
          req.params.id,
          safeOriginal,
          storedFilename,
          mediaType,
          f.size,
          f.mimetype || 'application/octet-stream',
          hash,
          desc,
          ts
        );

        logAuditEvent({
          investigation_id: req.params.id,
          evidence_id: evId,
          event_type: 'EVIDENCE_UPLOADED',
          description: `Uploaded ${safeOriginal} (${mediaType}, ${(f.size / 1024).toFixed(1)} KB).`,
          details: { original_filename: safeOriginal, media_type: mediaType, file_size: f.size },
        });

        logAuditEvent({
          investigation_id: req.params.id,
          evidence_id: evId,
          event_type: 'HASH_GENERATED',
          description: `Computed immutable ingestion SHA-256: ${hash}`,
          details: { sha256_hash: hash },
        });

        inserted.push(db.prepare('SELECT * FROM evidence WHERE id = ?').get(evId));
      }

      touchInvestigation(req.params.id);
      return ok(res, inserted, 201);
    } catch (e: any) {
      return fail(res, e?.message || 'Failed to store uploaded evidence.', 500);
    }
  });
});

apiRouter.get('/investigations/:id/evidence', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at DESC')
      .all(req.params.id);
    return ok(res, hydrateEvidenceList(rows));
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to fetch evidence list', 500);
  }
});

apiRouter.get('/evidence/:id', (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id);
    if (!ev) return fail(res, 'Evidence item not found.', 404);
    const [hydrated] = hydrateEvidenceList([ev]);
    const findings = hydrateFindings(
      db.prepare('SELECT * FROM findings WHERE evidence_id = ? ORDER BY created_at DESC').all(req.params.id)
    );
    return ok(res, { ...hydrated, findings });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to fetch evidence item', 500);
  }
});

apiRouter.delete('/evidence/:id', (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id) as any;
    if (!ev) return fail(res, 'Evidence item not found.', 404);

    db.prepare('DELETE FROM evidence WHERE id = ?').run(ev.id);
    deleteEvidenceFiles(ev.investigation_id, ev.id, ev.stored_filename);

    logAuditEvent({
      investigation_id: ev.investigation_id,
      event_type: 'EVIDENCE_DELETED',
      description: `Deleted evidence file ${ev.original_filename} (${ev.id}) and its derived artifacts.`,
    });
    touchInvestigation(ev.investigation_id);

    return ok(res, { deleted_id: ev.id });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to delete evidence', 500);
  }
});

apiRouter.get('/evidence/:id/download', (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id) as any;
    if (!ev) return fail(res, 'Evidence item not found.', 404);

    const filePath = getOriginalPath(ev.investigation_id, ev.stored_filename);
    if (!fs.existsSync(filePath)) return fail(res, 'Stored evidence file not found on disk.', 404);

    const stat = fs.statSync(filePath);
    const range = req.headers.range;
    const isAttachment = req.query.download === '1';

    if (isAttachment) {
      res.setHeader('Content-Disposition', `attachment; filename="${ev.original_filename}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${ev.original_filename}"`);
    }
    res.setHeader('Content-Type', ev.mime_type || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunkSize,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to stream evidence', 500);
  }
});

apiRouter.post('/evidence/:id/verify', async (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id) as any;
    if (!ev) return fail(res, 'Evidence item not found.', 404);

    const filePath = getOriginalPath(ev.investigation_id, ev.stored_filename);
    const verifiedAt = nowIso();
    const exists = fs.existsSync(filePath);

    let currentHash: string | null = null;
    let matches = false;

    if (exists) {
      currentHash = await computeSha256(filePath);
      matches = currentHash === ev.sha256_hash;
    }

    logAuditEvent({
      investigation_id: ev.investigation_id,
      evidence_id: ev.id,
      event_type: 'INTEGRITY_VERIFIED',
      description: matches
        ? `SHA-256 byte-integrity verified for ${ev.original_filename} (matches ingestion record).`
        : `SHA-256 verification MISMATCH or missing file for ${ev.original_filename}.`,
      details: {
        recorded_hash: ev.sha256_hash,
        current_hash: currentHash,
        matches,
        file_exists: exists,
      },
    });

    return ok(res, {
      evidence_id: ev.id,
      original_filename: ev.original_filename,
      recorded_hash: ev.sha256_hash,
      current_hash: currentHash,
      matches,
      file_exists: exists,
      verified_at: verifiedAt,
      note: 'A matching SHA-256 hash confirms byte-for-byte identity with the file stored at ingestion. It does not prove original scene authenticity or constitute legal chain-of-custody certification.',
    });
  } catch (err: any) {
    return fail(res, err?.message || 'Integrity check failed', 500);
  }
});

// ============================================================================
// FORENSIC ANALYSIS
// ============================================================================

apiRouter.post('/evidence/:id/analyze', async (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id) as any;
    if (!ev) return fail(res, 'Evidence item not found.', 404);

    const analysisResult = await runSingleEvidenceAnalysis(ev);
    return ok(res, analysisResult);
  } catch (err: any) {
    return fail(res, err?.message || 'Evidence analysis failed', 500);
  }
});

// Genuine asynchronous multi-layer video analysis launcher with real per-layer progress tracking
apiRouter.post('/evidence/:id/analyze-video-async', (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id) as any;
    if (!ev) return fail(res, 'Evidence item not found.', 404);
    if (ev.media_type !== 'video') {
      return fail(res, 'Multi-layer video analysis is only supported for video evidence.', 400);
    }

    const existing = getVideoJobStatus(ev.id);
    if (existing && existing.overall_status === 'PROCESSING') {
      return ok(res, existing, 202);
    }

    // Launch real async processing in the background without blocking HTTP response
    setImmediate(() => {
      runSingleEvidenceAnalysis(ev).catch(() => {
        // Error state already persisted in analyses & job tracker
      });
    });

    return ok(
      res,
      {
        evidence_id: ev.id,
        overall_status: 'PROCESSING',
        message: 'Multi-layer video analysis started.',
      },
      202
    );
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to launch video analysis', 500);
  }
});

apiRouter.get('/evidence/:id/video-status', (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id) as any;
    if (!ev) return fail(res, 'Evidence item not found.', 404);

    const live = getVideoJobStatus(ev.id);
    if (live) {
      return ok(res, live);
    }

    return ok(res, {
      evidence_id: ev.id,
      overall_status: ev.processing_status === 'COMPLETED' ? 'COMPLETED' : ev.processing_status === 'FAILED' ? 'FAILED' : 'IDLE',
      layers: [],
      error: null,
    });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to read video status', 500);
  }
});

apiRouter.post('/investigations/:id/analyze', async (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id);
    if (!inv) return fail(res, 'Investigation not found.', 404);

    const evidenceRows = db
      .prepare('SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at ASC')
      .all(req.params.id) as any[];

    const results: Array<{ evidence_id: string; filename: string; status: string; error?: string }> = [];
    for (const ev of evidenceRows) {
      try {
        await runSingleEvidenceAnalysis(ev);
        results.push({ evidence_id: ev.id, filename: ev.original_filename, status: 'COMPLETED' });
      } catch (e: any) {
        results.push({
          evidence_id: ev.id,
          filename: ev.original_filename,
          status: 'FAILED',
          error: e?.message || 'Processing error',
        });
      }
    }

    // Automatically run cross-modal correlation after analyzing all evidence
    const correlation = runCrossModalCorrelation(req.params.id);

    return ok(res, {
      investigation_id: req.params.id,
      processed: results,
      relationships_created: correlation.relationships_created,
    });
  } catch (err: any) {
    return fail(res, err?.message || 'Investigation analysis failed', 500);
  }
});

apiRouter.get('/evidence/:id/results', (req, res) => {
  try {
    const ev = db.prepare('SELECT * FROM evidence WHERE id = ?').get(req.params.id);
    if (!ev) return fail(res, 'Evidence item not found.', 404);

    const analyses = db
      .prepare('SELECT * FROM analyses WHERE evidence_id = ? ORDER BY started_at DESC')
      .all(req.params.id)
      .map((a: any) => ({
        ...a,
        result: (() => {
          try {
            return JSON.parse(a.result_json || '{}');
          } catch {
            return {};
          }
        })(),
      }));

    const findings = hydrateFindings(
      db.prepare('SELECT * FROM findings WHERE evidence_id = ? ORDER BY created_at DESC').all(req.params.id)
    );

    return ok(res, { evidence: ev, analyses, findings });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to fetch results', 500);
  }
});

apiRouter.get('/investigations/:id/findings', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM findings WHERE investigation_id = ? ORDER BY created_at DESC')
      .all(req.params.id);
    return ok(res, hydrateFindings(rows));
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to fetch findings', 500);
  }
});

// ============================================================================
// TEXT RECORDS & COMPARISON
// ============================================================================

apiRouter.get('/investigations/:id/text-records', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM text_records WHERE investigation_id = ? ORDER BY created_at DESC')
      .all(req.params.id)
      .map((t: any) => ({
        ...t,
        segments: (() => {
          try {
            return JSON.parse(t.segments_json || '[]');
          } catch {
            return [];
          }
        })(),
      }));
    return ok(res, rows);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to list text records', 500);
  }
});

apiRouter.post('/investigations/:id/text-records', (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id);
    if (!inv) return fail(res, 'Investigation not found.', 404);

    const role = String(req.body?.role || 'CLAIM').toUpperCase();
    const allowedRoles = ['CAPTION', 'TRANSCRIPT', 'CLAIM', 'DOCUMENT'];
    if (!allowedRoles.includes(role)) {
      return fail(res, `Invalid role. Must be one of: ${allowedRoles.join(', ')}`, 400);
    }

    const label = String(req.body?.label || '').trim();
    const content = String(req.body?.content || '').trim();
    const evidenceId = req.body?.evidence_id ? String(req.body.evidence_id) : null;
    const segments = Array.isArray(req.body?.segments) ? req.body.segments : [];

    if (!label || !content) {
      return fail(res, 'Both label and content are required.', 400);
    }

    const id = `TXT-${uuidv4().slice(0, 8).toUpperCase()}`;
    const ts = nowIso();
    db.prepare(
      `INSERT INTO text_records (id, investigation_id, evidence_id, role, label, content, segments_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, req.params.id, evidenceId, role, label.slice(0, 160), content.slice(0, 100000), JSON.stringify(segments), ts);

    logAuditEvent({
      investigation_id: req.params.id,
      evidence_id: evidenceId,
      event_type: 'TEXT_RECORD_ADDED',
      description: `Recorded [${role}] "${label}" (${content.split(/\s+/).length} words).`,
      details: { text_record_id: id, role },
    });

    touchInvestigation(req.params.id);

    return ok(
      res,
      {
        id,
        investigation_id: req.params.id,
        evidence_id: evidenceId,
        role,
        label,
        content,
        segments,
        created_at: ts,
      },
      201
    );
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to save text record', 500);
  }
});

apiRouter.delete('/text-records/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM text_records WHERE id = ?').get(req.params.id) as any;
    if (!row) return fail(res, 'Text record not found.', 404);
    db.prepare('DELETE FROM text_records WHERE id = ?').run(req.params.id);
    logAuditEvent({
      investigation_id: row.investigation_id,
      event_type: 'TEXT_RECORD_DELETED',
      description: `Removed text record "${row.label}" (${row.id}).`,
    });
    return ok(res, { deleted_id: req.params.id });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to delete text record', 500);
  }
});

apiRouter.post('/text/compare', (req, res) => {
  try {
    const labelA = String(req.body?.label_a || 'Source A').trim();
    const textA = String(req.body?.text_a || '').trim();
    const labelB = String(req.body?.label_b || 'Source B').trim();
    const textB = String(req.body?.text_b || '').trim();

    if (!textA || !textB) {
      return fail(res, 'Both text_a and text_b must be provided for comparison.', 400);
    }

    const result = compareTexts(labelA, textA, labelB, textB);
    return ok(res, result);
  } catch (err: any) {
    return fail(res, err?.message || 'Text comparison failed', 500);
  }
});

// ============================================================================
// CORRELATION ENGINE
// ============================================================================

apiRouter.post('/investigations/:id/correlate', (req, res) => {
  try {
    const inv = db.prepare('SELECT * FROM investigations WHERE id = ?').get(req.params.id);
    if (!inv) return fail(res, 'Investigation not found.', 404);

    const out = runCrossModalCorrelation(req.params.id);
    return ok(res, out);
  } catch (err: any) {
    return fail(res, err?.message || 'Cross-modal correlation failed', 500);
  }
});

apiRouter.get('/investigations/:id/relationships', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM relationships WHERE investigation_id = ? ORDER BY created_at DESC')
      .all(req.params.id)
      .map((r: any) => ({
        ...r,
        supporting_references: (() => {
          try {
            return JSON.parse(r.supporting_references_json || '[]');
          } catch {
            return [];
          }
        })(),
      }));
    return ok(res, rows);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to fetch relationships', 500);
  }
});

// ============================================================================
// PROVENANCE TIMELINE
// ============================================================================

apiRouter.get('/investigations/:id/timeline', (req, res) => {
  try {
    const rows = db
      .prepare('SELECT * FROM audit_events WHERE investigation_id = ? ORDER BY timestamp DESC')
      .all(req.params.id)
      .map((row: any) => ({
        ...row,
        details: (() => {
          try {
            return JSON.parse(row.details_json || '{}');
          } catch {
            return {};
          }
        })(),
      }));
    return ok(res, rows);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to fetch audit timeline', 500);
  }
});

// ============================================================================
// HUMAN REVIEW SYSTEM
// ============================================================================

apiRouter.post('/findings/:id/review', (req, res) => {
  try {
    const finding = db.prepare('SELECT * FROM findings WHERE id = ?').get(req.params.id) as any;
    if (!finding) return fail(res, 'Finding not found.', 404);

    const decision = String(req.body?.reviewer_decision || '').toUpperCase();
    const allowed = ['ACCEPTED', 'REJECTED', 'INCONCLUSIVE', 'FURTHER_REVIEW'];
    if (!allowed.includes(decision)) {
      return fail(res, `Invalid reviewer_decision. Must be one of: ${allowed.join(', ')}`, 400);
    }

    const notes = String(req.body?.reviewer_notes || '').trim().slice(0, 2000);
    const reviewId = `REV-${uuidv4().slice(0, 8).toUpperCase()}`;
    const reviewedAt = nowIso();

    db.prepare(
      `INSERT INTO reviews (id, finding_id, reviewer_decision, reviewer_notes, reviewed_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(reviewId, finding.id, decision, notes, reviewedAt);

    db.prepare('UPDATE findings SET review_status = ? WHERE id = ?').run(decision, finding.id);

    logAuditEvent({
      investigation_id: finding.investigation_id,
      evidence_id: finding.evidence_id,
      event_type: 'ANALYST_REVIEWED',
      description: `Analyst marked finding ${finding.id} as ${decision}${notes ? `: "${notes.slice(0, 100)}"` : ''}.`,
      details: { finding_id: finding.id, decision, review_id: reviewId },
    });

    touchInvestigation(finding.investigation_id);

    return ok(res, {
      review: {
        id: reviewId,
        finding_id: finding.id,
        reviewer_decision: decision,
        reviewer_notes: notes,
        reviewed_at: reviewedAt,
      },
      finding_id: finding.id,
      review_status: decision,
    });
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to save human review decision', 500);
  }
});

// ============================================================================
// FORENSIC REPORTING
// ============================================================================

apiRouter.post('/investigations/:id/report', async (req, res) => {
  try {
    const report = await generateForensicReport(req.params.id);
    return ok(res, report, 201);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to generate PDF report', 500);
  }
});

apiRouter.get('/reports', (req, res) => {
  try {
    const invId = req.query.investigation_id ? String(req.query.investigation_id) : null;
    const rows = invId
      ? db
          .prepare(
            `SELECT r.*, i.title as investigation_title
             FROM reports r
             JOIN investigations i ON i.id = r.investigation_id
             WHERE r.investigation_id = ?
             ORDER BY r.generated_at DESC`
          )
          .all(invId)
      : db
          .prepare(
            `SELECT r.*, i.title as investigation_title
             FROM reports r
             JOIN investigations i ON i.id = r.investigation_id
             ORDER BY r.generated_at DESC`
          )
          .all();

    return ok(
      res,
      rows.map((r: any) => ({
        id: r.id,
        investigation_id: r.investigation_id,
        investigation_title: r.investigation_title,
        filename: r.filename,
        generated_at: r.generated_at,
        summary: (() => {
          try {
            return JSON.parse(r.summary_json || '{}');
          } catch {
            return {};
          }
        })(),
      }))
    );
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to list reports', 500);
  }
});

apiRouter.get('/reports/:id/download', (req, res) => {
  try {
    const rpt = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id) as any;
    if (!rpt) return fail(res, 'Report not found.', 404);

    if (!fs.existsSync(rpt.file_path)) {
      return fail(res, 'Report PDF file is missing on disk.', 404);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${rpt.filename}"`);
    fs.createReadStream(rpt.file_path).pipe(res);
  } catch (err: any) {
    return fail(res, err?.message || 'Failed to download PDF report', 500);
  }
});

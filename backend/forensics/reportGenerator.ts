import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';
import { db, getSettings, logAuditEvent, nowIso } from '../db.ts';
import { REPORTS_DIR, ensureStorageDirs } from '../storage.ts';

export async function generateForensicReport(investigationId: string): Promise<{
  id: string;
  investigation_id: string;
  filename: string;
  generated_at: string;
  summary: Record<string, any>;
}> {
  ensureStorageDirs();

  const investigation = db
    .prepare('SELECT * FROM investigations WHERE id = ?')
    .get(investigationId) as any;

  if (!investigation) {
    throw new Error('Investigation not found.');
  }

  const evidenceRows = db
    .prepare('SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at ASC')
    .all(investigationId) as any[];

  const findingRows = db
    .prepare('SELECT * FROM findings WHERE investigation_id = ? ORDER BY module ASC, created_at ASC')
    .all(investigationId) as any[];

  const relationshipRows = db
    .prepare('SELECT * FROM relationships WHERE investigation_id = ? ORDER BY created_at ASC')
    .all(investigationId) as any[];

  const auditRows = db
    .prepare('SELECT * FROM audit_events WHERE investigation_id = ? ORDER BY timestamp ASC')
    .all(investigationId) as any[];

  const textRows = db
    .prepare('SELECT * FROM text_records WHERE investigation_id = ? ORDER BY created_at ASC')
    .all(investigationId) as any[];

  const reviewsByFinding = new Map<string, any>();
  for (const f of findingRows) {
    const rev = db
      .prepare('SELECT * FROM reviews WHERE finding_id = ? ORDER BY reviewed_at DESC LIMIT 1')
      .get(f.id) as any;
    if (rev) reviewsByFinding.set(f.id, rev);
  }

  const settings = getSettings();
  const reportId = `RPT-${uuidv4().slice(0, 8).toUpperCase()}`;
  const safeSlug = investigation.title
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40);
  const filename = `TruthLensX_${safeSlug || investigationId}_${reportId}.pdf`;
  const filePath = path.join(REPORTS_DIR, filename);
  const generatedAt = nowIso();

  const reviewedCount = findingRows.filter((f) => f.review_status !== 'PENDING').length;
  const contradictionCount = relationshipRows.filter(
    (r) => r.relationship_type === 'CONTRADICTS'
  ).length;

  const summary = {
    evidence_count: evidenceRows.length,
    finding_count: findingRows.length,
    reviewed_count: reviewedCount,
    relationship_count: relationshipRows.length,
    contradiction_count: contradictionCount,
    audit_event_count: auditRows.length,
    case_type: investigation.case_type,
  };

  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 54, bottom: 54, left: 50, right: 50 },
      info: {
        Title: `TruthLens X Forensic Report — ${investigation.title}`,
        Author: settings.analyst_name || 'TruthLens X Forensic Analyst',
        Subject: `Investigation ${investigation.id}`,
      },
    });

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const DARK = '#111318';
    const MUTED = '#4B5563';
    const ACCENT = '#B47B1B';
    const BORDER = '#D1D5DB';

    const sectionTitle = (num: string, title: string) => {
      if (doc.y > 700) doc.addPage();
      doc.moveDown(0.7);
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(ACCENT)
        .text(`${num}. ${title.toUpperCase()}`, { continued: false });
      doc
        .moveTo(50, doc.y + 2)
        .lineTo(545, doc.y + 2)
        .strokeColor(BORDER)
        .lineWidth(0.75)
        .stroke();
      doc.moveDown(0.5);
      doc.fillColor(DARK).font('Helvetica').fontSize(9.5);
    };

    const bodyLine = (label: string, value: string) => {
      doc.font('Helvetica-Bold').fillColor(DARK).text(`${label}: `, { continued: true });
      doc.font('Helvetica').fillColor('#1F2937').text(value);
    };

    // =========================================================================
    // 1. COVER PAGE
    // =========================================================================
    doc.rect(0, 0, 595, 165).fill('#0F1116');
    doc
      .font('Helvetica-Bold')
      .fontSize(24)
      .fillColor('#F2F0EB')
      .text('TRUTHLENS X', 50, 48);
    doc
      .font('Helvetica')
      .fontSize(10.5)
      .fillColor('#E5A93B')
      .text('MULTIMODAL DIGITAL FORENSICS & EXPLAINABLE ANALYSIS REPORT', 50, 80);
    doc
      .font('Helvetica')
      .fontSize(9.5)
      .fillColor('#9CA3AF')
      .text('Detect inconsistencies. Connect evidence. Explain what matters.', 50, 100);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor('#D1D5DB')
      .text(`Report ID: ${reportId}   |   Generated UTC: ${generatedAt}`, 50, 128);

    doc.y = 205;
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(18).text(investigation.title);
    doc.moveDown(0.4);
    if (investigation.case_type === 'DEMONSTRATION') {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .fillColor('#B91C1C')
        .text('NOTICE: CLEARLY LABELED DEMONSTRATION / TEST CASE (SYNTHETIC MEDIA FILES)');
      doc.moveDown(0.4);
    }
    doc
      .font('Helvetica')
      .fontSize(10.5)
      .fillColor(MUTED)
      .text(investigation.description || 'No narrative description recorded.');

    doc.moveDown(1.4);
    doc.fontSize(9.5).fillColor(DARK);
    bodyLine('Investigation ID', investigation.id);
    bodyLine('Investigation Status', investigation.status);
    bodyLine('Case Classification', investigation.case_type);
    bodyLine('Created At (UTC)', investigation.created_at);
    bodyLine('Last Updated (UTC)', investigation.updated_at);
    bodyLine('Prepared By', `${settings.analyst_name || 'Lead Analyst'} (${settings.organization_name || 'TruthLens X Lab'})`);

    doc.moveDown(1.5);
    doc
      .rect(50, doc.y, 495, 92)
      .fillAndStroke('#F9FAFB', BORDER);
    const boxY = doc.y + 12;
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor(DARK)
      .text('METHODOLOGICAL INTEGRITY NOTICE', 64, boxY);
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(
        'This report presents deterministic metadata observations, statistical/heuristic indicators, and documented human analyst reviews strictly derived from files ingested into this investigation. TruthLens X does not emit universal authenticity percentages, does not fabricate unobserved findings, and does not constitute legal chain-of-custody certification.',
        64,
        boxY + 16,
        { width: 467 }
      );

    doc.addPage();

    // =========================================================================
    // 2. INVESTIGATION DETAILS
    // =========================================================================
    sectionTitle('2', 'Investigation Details');
    bodyLine('Case Identifier', investigation.id);
    bodyLine('Case Title', investigation.title);
    bodyLine('Workflow Status', investigation.status);
    bodyLine('Description', investigation.description || 'None provided');
    bodyLine('Evidence Files Ingested', String(evidenceRows.length));
    bodyLine('Textual Claims / Captions / Transcripts', String(textRows.length));

    // =========================================================================
    // 3. EXECUTIVE SUMMARY
    // =========================================================================
    sectionTitle('3', 'Executive Summary');
    doc.text(
      `This investigation contains ${evidenceRows.length} ingested digital evidence file(s) and ${textRows.length} linked textual record(s). Automated forensic modules generated ${findingRows.length} structured observation(s), of which ${reviewedCount} have received documented human review. The Cross-Modal Correlation Engine identified ${relationshipRows.length} traceable inter-evidence relationship(s), including ${contradictionCount} potential contradiction(s) flagged for analyst inspection.`
    );

    // =========================================================================
    // 4. EVIDENCE INVENTORY
    // =========================================================================
    sectionTitle('4', 'Evidence Inventory');
    if (evidenceRows.length === 0) {
      doc.fillColor(MUTED).text('No evidence files have been uploaded to this investigation.');
    } else {
      for (const ev of evidenceRows) {
        if (doc.y > 720) doc.addPage();
        doc
          .font('Helvetica-Bold')
          .fillColor(DARK)
          .text(`${ev.id} — ${ev.original_filename} [${ev.media_type.toUpperCase()}]`);
        doc
          .font('Helvetica')
          .fillColor(MUTED)
          .text(
            `MIME: ${ev.mime_type} | Size: ${(ev.file_size / 1024).toFixed(1)} KB | Status: ${ev.processing_status} | Uploaded: ${ev.uploaded_at}`
          );
        if (ev.description) {
          doc.fillColor('#1F2937').text(`Analyst Description: ${ev.description}`);
        }
        doc.moveDown(0.35);
      }
    }

    // =========================================================================
    // 5. SHA-256 HASHES
    // =========================================================================
    sectionTitle('5', 'Cryptographic SHA-256 Hashes');
    doc
      .font('Helvetica')
      .fillColor(MUTED)
      .text(
        'Note: Matching SHA-256 hashes verify byte-level file identity between ingestion and subsequent checks; they do not prove the truthfulness or authenticity of the original media content.'
      );
    doc.moveDown(0.4);
    if (evidenceRows.length === 0) {
      doc.text('No hashes recorded.');
    } else {
      for (const ev of evidenceRows) {
        if (doc.y > 730) doc.addPage();
        doc.font('Helvetica-Bold').fillColor(DARK).text(`${ev.original_filename} (${ev.id})`);
        doc.font('Courier').fontSize(8.5).fillColor('#1F2937').text(`SHA-256: ${ev.sha256_hash}`);
        doc.font('Helvetica').fontSize(9.5).moveDown(0.25);
      }
    }

    // Helper for module finding sections 6-9
    const renderModuleFindings = (num: string, heading: string, moduleName: string) => {
      sectionTitle(num, heading);
      const list = findingRows.filter((f) => f.module === moduleName);
      if (list.length === 0) {
        doc
          .fillColor(MUTED)
          .text(`No findings recorded for ${heading}. Either no files of this modality were uploaded or analysis has not yet been executed.`);
        return;
      }
      for (const f of list) {
        if (doc.y > 680) doc.addPage();
        doc.font('Helvetica-Bold').fillColor(DARK).text(`${f.id}: ${f.title}`);
        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(
            `Category: ${f.analysis_category} | Strength: ${f.evidence_strength} | Uncertainty: ${f.uncertainty} | Review: ${f.review_status} | Ref: ${f.evidence_reference} (${f.timestamp_or_region})`
          );
        doc.fontSize(9.5).fillColor('#1F2937').text(`Observation: ${f.description}`);
        if (f.alternative_explanation) {
          doc.fillColor(MUTED).text(`Alternative Explanation: ${f.alternative_explanation}`);
        }
        doc.moveDown(0.4);
      }
    };

    // =========================================================================
    // 6-9. MODALITY FINDINGS
    // =========================================================================
    renderModuleFindings('6', 'Image Forensics Findings', 'IMAGE_FORENSICS');
    renderModuleFindings('7', 'Video Forensics Findings', 'VIDEO_FORENSICS');

    // Include Multi-Layer Video Authenticity Summary for analyzed videos
    const videoEvidence = evidenceRows.filter((e) => e.media_type === 'video');
    for (const ve of videoEvidence) {
      const an = db
        .prepare('SELECT result_json FROM analyses WHERE evidence_id = ? ORDER BY started_at DESC LIMIT 1')
        .get(ve.id) as any;
      if (!an) continue;
      try {
        const parsed = JSON.parse(an.result_json || '{}');
        const mla = parsed.multi_layer_analysis;
        if (mla?.final_assessment) {
          if (doc.y > 660) doc.addPage();
          doc.moveDown(0.3);
          doc
            .font('Helvetica-Bold')
            .fontSize(9.5)
            .fillColor(DARK)
            .text(`Multi-Layer Video Authenticity Summary — ${ve.original_filename} (${ve.id})`);
          doc
            .font('Helvetica-Bold')
            .fontSize(9)
            .fillColor(ACCENT)
            .text(
              `Assessment Outcome: ${mla.final_assessment.outcome}${
                mla.final_assessment.ai_potential_rating
                  ? `   |   AI Potential Rating: ${mla.final_assessment.ai_potential_rating.score}/100 (${mla.final_assessment.ai_potential_rating.simple_verdict})`
                  : ''
              }`
            );
          doc
            .font('Helvetica')
            .fontSize(8.5)
            .fillColor('#1F2937')
            .text(mla.final_assessment.summary);
          doc.moveDown(0.2);
          for (const layer of mla.layers || []) {
            if (doc.y > 730) doc.addPage();
            doc
              .font('Helvetica')
              .fontSize(8.2)
              .fillColor(MUTED)
              .text(
                `• ${layer.layer_name} [${layer.status} | Strength: ${layer.evidence_strength}]: ${layer.actual_result}`
              );
          }
          doc.fontSize(9.5).moveDown(0.3);
        }
      } catch {
        // skip malformed json
      }
    }

    renderModuleFindings('8', 'Audio Forensics Findings', 'AUDIO_FORENSICS');
    renderModuleFindings('9', 'Text Analysis Findings', 'TEXT_ANALYSIS');

    if (textRows.length > 0) {
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fillColor(DARK).text('Recorded Captions, Transcripts & Claims:');
      doc.font('Helvetica').fontSize(9);
      for (const tr of textRows) {
        if (doc.y > 710) doc.addPage();
        doc.font('Helvetica-Bold').fillColor(DARK).text(`[${tr.role}] ${tr.label} (${tr.id})`);
        doc.font('Helvetica').fillColor('#1F2937').text(tr.content.slice(0, 600));
        doc.moveDown(0.3);
      }
      doc.fontSize(9.5);
    }

    // =========================================================================
    // 10. CROSS-MODAL RELATIONSHIPS
    // =========================================================================
    sectionTitle('10', 'Cross-Modal Relationships');
    if (relationshipRows.length === 0) {
      doc
        .fillColor(MUTED)
        .text('No cross-modal relationships recorded. Upload multiple evidence/text items and run Correlation to evaluate cross-modal signals.');
    } else {
      for (const rel of relationshipRows) {
        if (doc.y > 700) doc.addPage();
        doc
          .font('Helvetica-Bold')
          .fillColor(DARK)
          .text(`[${rel.relationship_type}] ${rel.source_label}  ->  ${rel.target_label} (${rel.signal_type})`);
        doc.font('Helvetica').fillColor('#1F2937').text(rel.explanation);
        try {
          const refs = JSON.parse(rel.supporting_references_json || '[]');
          if (refs.length) {
            doc.fontSize(8.5).fillColor(MUTED).text(`References: ${refs.join(' ; ')}`);
            doc.fontSize(9.5);
          }
        } catch {
          // ignore
        }
        doc.moveDown(0.35);
      }
    }

    // =========================================================================
    // 11. EVIDENCE TIMELINE
    // =========================================================================
    sectionTitle('11', 'Evidence Provenance & Audit Timeline');
    if (auditRows.length === 0) {
      doc.fillColor(MUTED).text('No audit events recorded.');
    } else {
      for (const evt of auditRows.slice(0, 80)) {
        if (doc.y > 730) doc.addPage();
        doc
          .font('Courier')
          .fontSize(8)
          .fillColor(MUTED)
          .text(`${evt.timestamp}  [${evt.event_type}]`, { continued: false });
        doc
          .font('Helvetica')
          .fontSize(9)
          .fillColor('#1F2937')
          .text(`  ${evt.description}`);
      }
      doc.fontSize(9.5);
    }

    // =========================================================================
    // 12. HUMAN REVIEW DECISIONS
    // =========================================================================
    sectionTitle('12', 'Human Review Decisions');
    const reviewedFindings = findingRows.filter((f) => reviewsByFinding.has(f.id));
    if (reviewedFindings.length === 0) {
      doc
        .fillColor(MUTED)
        .text('No automated findings have been formally reviewed by a human investigator yet. All findings remain pending analyst verification.');
    } else {
      for (const f of reviewedFindings) {
        if (doc.y > 700) doc.addPage();
        const rev = reviewsByFinding.get(f.id);
        doc
          .font('Helvetica-Bold')
          .fillColor(DARK)
          .text(`${f.id} — ${f.title} | Decision: ${rev.reviewer_decision}`);
        doc
          .font('Helvetica')
          .fillColor(MUTED)
          .text(`Reviewed At: ${rev.reviewed_at}`);
        doc
          .fillColor('#1F2937')
          .text(`Investigator Notes: ${rev.reviewer_notes || 'No notes provided.'}`);
        doc.moveDown(0.35);
      }
    }

    // =========================================================================
    // 13. ANALYSIS METHODS
    // =========================================================================
    sectionTitle('13', 'Analysis Methods Employed');
    const methods = [
      'Cryptographic Ingestion Hashing: SHA-256 byte-level hashing on original immutable files.',
      'Image Forensics: Sharp raster validation, exifr TIFF/EXIF/XMP/IPTC/GPS extraction, JPEG Error Level Analysis (ELA) residual mapping, 3x3 Laplacian spatial noise profiling.',
      'Video Forensics: FFprobe stream/codec/framerate probing, FFmpeg scene-change detection (select gt(scene)), interval frame extraction with preserved PTS timestamps, PCM audio extraction.',
      'Audio Forensics: FFprobe stream metadata, FFmpeg log-scale intensity spectrogram rendering, silencedetect interval scanning, raw 8kHz PCM waveform and 250ms RMS energy-jump discontinuity heuristics.',
      'Text & Cross-Modal Analysis: Normalized regex date/time/number/location/entity extraction, Jaccard and TF cosine similarity, cross-modal temporal/geospatial/provenance conflict checks.',
    ];
    for (const m of methods) {
      doc.text(`• ${m}`);
    }

    // =========================================================================
    // 14. EVIDENCE-STRENGTH INDICATORS
    // =========================================================================
    sectionTitle('14', 'Evidence-Strength Classification Framework');
    doc.text(
      '• STRONG: Deterministic technical properties directly verifiable from file bytes or container headers (e.g., SHA-256 hash, pixel dimensions, codec stream metadata).'
    );
    doc.text(
      '• MODERATE: Corroborated metadata indicators or explicit cross-modal date/location/software discrepancies requiring contextual validation.'
    );
    doc.text(
      '• LOW: Statistical heuristics (ELA residuals, scene cuts, audio silence/energy steps) or ambiguous indicators (missing EXIF) that are easily produced by benign workflows.'
    );

    // =========================================================================
    // 15. ALTERNATIVE EXPLANATIONS
    // =========================================================================
    sectionTitle('15', 'Key Alternative Explanations');
    const uniqueAlts = Array.from(
      new Set(findingRows.map((f) => f.alternative_explanation).filter(Boolean))
    ).slice(0, 10);
    if (uniqueAlts.length === 0) {
      doc.fillColor(MUTED).text('No automated findings requiring alternative explanations recorded.');
    } else {
      for (const alt of uniqueAlts) {
        doc.text(`• ${alt}`);
      }
    }

    // =========================================================================
    // 16. LIMITATIONS
    // =========================================================================
    sectionTitle('16', 'Limitations & Processing Disclosures');
    doc.text(
      '• Forensic indicators are not standalone proof of fabrication or authenticity. Benign re-encoding, social media compression, clock offsets, and routine editing trigger technical indicators.'
    );
    doc.text(
      '• Automated speech-to-text (faster-whisper) is not installed in this local container environment; manual transcript ingestion is used instead of fabricating speech recognition outputs.'
    );
    doc.text(
      '• No unverified neural deepfake probability percentage is emitted; all observations are separated into Deterministic, Statistical Heuristic, and Human-Reviewed categories.'
    );

    // =========================================================================
    // 17. FINAL INVESTIGATION STATUS
    // =========================================================================
    sectionTitle('17', 'Final Investigation Status');
    bodyLine('Current Investigation Status', investigation.status);
    bodyLine('Findings Reviewed', `${reviewedCount} of ${findingRows.length}`);
    bodyLine(
      'Chain-of-Custody Disclaimer',
      'TruthLens X records internal SHA-256 hashes and event logs for technical provenance tracking; this report does not constitute formal legal chain-of-custody certification.'
    );

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  db.prepare(
    `INSERT INTO reports (id, investigation_id, filename, file_path, generated_at, summary_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(reportId, investigationId, filename, filePath, generatedAt, JSON.stringify(summary));

  logAuditEvent({
    investigation_id: investigationId,
    event_type: 'REPORT_GENERATED',
    description: `Generated forensic PDF report ${filename} (${reportId}).`,
    details: { report_id: reportId, filename, ...summary },
  });

  return {
    id: reportId,
    investigation_id: investigationId,
    filename,
    generated_at: generatedAt,
    summary,
  };
}

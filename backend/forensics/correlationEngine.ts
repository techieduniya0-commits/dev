import { v4 as uuidv4 } from 'uuid';
import { db, insertFinding, logAuditEvent, nowIso, touchInvestigation } from '../db.ts';
import { compareTexts, extractTextSignals } from './textAnalyzer.ts';

interface CorrelatableUnit {
  unit_id: string;
  evidence_id: string | null;
  finding_id: string | null;
  label: string;
  media_type: string;
  dates: string[];
  iso_dates: string[]; // normalized YYYY-MM-DD
  times: string[];
  locations: string[];
  numbers: string[];
  entities: string[];
  keywords: string[];
  raw_text: string;
  software: string | null;
  has_ela_anomaly: boolean;
}

function normalizeDateToIso(raw: string): string | null {
  const s = raw.trim();
  const isoMatch = s.match(/(\d{4})[-:](\d{2})[-:](\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

export function runCrossModalCorrelation(investigationId: string): {
  relationships_created: number;
  relationships: any[];
} {
  // Clear prior auto-generated relationships for this investigation so re-runs stay clean & deterministic
  db.prepare('DELETE FROM relationships WHERE investigation_id = ?').run(investigationId);
  db.prepare(
    "DELETE FROM findings WHERE investigation_id = ? AND module = 'CROSS_MODAL_ENGINE'"
  ).run(investigationId);

  const evidenceRows = db
    .prepare('SELECT * FROM evidence WHERE investigation_id = ? ORDER BY uploaded_at ASC')
    .all(investigationId) as any[];

  const findingRows = db
    .prepare('SELECT * FROM findings WHERE investigation_id = ? ORDER BY created_at ASC')
    .all(investigationId) as any[];

  const textRows = db
    .prepare('SELECT * FROM text_records WHERE investigation_id = ? ORDER BY created_at ASC')
    .all(investigationId) as any[];

  const analysesByEvidence = new Map<string, any>();
  for (const ev of evidenceRows) {
    const row = db
      .prepare('SELECT * FROM analyses WHERE evidence_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(ev.id) as any;
    if (row) {
      try {
        analysesByEvidence.set(ev.id, JSON.parse(row.result_json || '{}'));
      } catch {
        analysesByEvidence.set(ev.id, {});
      }
    }
  }

  const units: CorrelatableUnit[] = [];

  // Build correlatable signal units from uploaded evidence + analyses + descriptions
  const textRecordEvidenceIds = new Set(
    textRows.filter((tr) => tr.evidence_id).map((tr) => tr.evidence_id)
  );

  for (const ev of evidenceRows) {
    // If a text file already has a dedicated TextRecord, avoid duplicate nodes/edges for the same text
    if (ev.media_type === 'text' && textRecordEvidenceIds.has(ev.id)) {
      continue;
    }
    const analysis = analysesByEvidence.get(ev.id) || {};
    const evFindings = findingRows.filter((f) => f.evidence_id === ev.id);
    const primaryFinding = evFindings[0] || null;

    const textParts: string[] = [];
    if (ev.description) textParts.push(ev.description);
    if (ev.media_type === 'text' && analysis.normalized_text) {
      textParts.push(analysis.normalized_text);
    }

    const sig = extractTextSignals(textParts.join(' '));
    const dates = [...sig.dates];
    const isoDates = new Set<string>();
    for (const d of dates) {
      const iso = normalizeDateToIso(d);
      if (iso) isoDates.add(iso);
    }

    // Add EXIF or video container timestamps
    if (analysis.capture_date) {
      dates.push(String(analysis.capture_date));
      const iso = normalizeDateToIso(String(analysis.capture_date));
      if (iso) isoDates.add(iso);
    }
    if (analysis.creation_time) {
      dates.push(String(analysis.creation_time));
      const iso = normalizeDateToIso(String(analysis.creation_time));
      if (iso) isoDates.add(iso);
    }

    const hasElaAnomaly = evFindings.some((f) => f.finding_type === 'ELA_REGIONAL_VARIANCE');

    units.push({
      unit_id: ev.id,
      evidence_id: ev.id,
      finding_id: primaryFinding ? primaryFinding.id : null,
      label: ev.original_filename,
      media_type: ev.media_type,
      dates: Array.from(new Set(dates)),
      iso_dates: Array.from(isoDates),
      times: sig.times,
      locations: sig.locations,
      numbers: sig.numbers,
      entities: sig.entities,
      keywords: sig.keywords,
      raw_text: textParts.join(' '),
      software: analysis.software || analysis.encoder || null,
      has_ela_anomaly: hasElaAnomaly,
    });
  }

  // Also include investigator-supplied TextRecords (Captions, Transcripts, Claims)
  for (const tr of textRows) {
    const sig = extractTextSignals(tr.content);
    const isoDates = new Set<string>();
    for (const d of sig.dates) {
      const iso = normalizeDateToIso(d);
      if (iso) isoDates.add(iso);
    }
    const linkedFinding = tr.evidence_id
      ? findingRows.find((f) => f.evidence_id === tr.evidence_id)
      : null;

    units.push({
      unit_id: tr.id,
      evidence_id: tr.evidence_id || null,
      finding_id: linkedFinding ? linkedFinding.id : null,
      label: `${tr.role}: ${tr.label}`,
      media_type: 'text',
      dates: sig.dates,
      iso_dates: Array.from(isoDates),
      times: sig.times,
      locations: sig.locations,
      numbers: sig.numbers,
      entities: sig.entities,
      keywords: sig.keywords,
      raw_text: tr.content,
      software: null,
      has_ela_anomaly: false,
    });
  }

  const createdRelationships: any[] = [];
  const seenPairs = new Set<string>();

  const addRelationship = (params: {
    source: CorrelatableUnit;
    target: CorrelatableUnit;
    relationship_type: 'SUPPORTS' | 'CONTRADICTS' | 'RELATED' | 'REQUIRES_REVIEW';
    signal_type: string;
    explanation: string;
    supporting_references: string[];
  }) => {
    const pairKey = [params.source.unit_id, params.target.unit_id, params.signal_type]
      .sort()
      .join('::');
    if (seenPairs.has(pairKey)) return;
    seenPairs.add(pairKey);

    const id = `REL-${uuidv4().slice(0, 8).toUpperCase()}`;
    const ts = nowIso();
    db.prepare(
      `INSERT INTO relationships (
        id, investigation_id, source_finding_id, target_finding_id,
        source_evidence_id, target_evidence_id, source_label, target_label,
        relationship_type, signal_type, explanation, supporting_references_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      investigationId,
      params.source.finding_id,
      params.target.finding_id,
      params.source.evidence_id,
      params.target.evidence_id,
      params.source.label,
      params.target.label,
      params.relationship_type,
      params.signal_type,
      params.explanation,
      JSON.stringify(params.supporting_references),
      ts
    );

    createdRelationships.push({
      id,
      investigation_id: investigationId,
      source_finding_id: params.source.finding_id,
      target_finding_id: params.target.finding_id,
      source_evidence_id: params.source.evidence_id,
      target_evidence_id: params.target.evidence_id,
      source_label: params.source.label,
      target_label: params.target.label,
      relationship_type: params.relationship_type,
      signal_type: params.signal_type,
      explanation: params.explanation,
      supporting_references: params.supporting_references,
      created_at: ts,
    });
  };

  // Compare every unique pair of units across modalities & records
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i];
      const b = units[j];
      if (a.unit_id === b.unit_id) continue;

      const refs = [
        `${a.label} (${a.unit_id})`,
        `${b.label} (${b.unit_id})`,
      ];

      // 1. Temporal / Date Correlation (EXIF/container vs Text/Caption/Transcript)
      if (a.iso_dates.length > 0 && b.iso_dates.length > 0) {
        const sharedDates = a.iso_dates.filter((d) => b.iso_dates.includes(d));
        if (sharedDates.length > 0) {
          addRelationship({
            source: a,
            target: b,
            relationship_type: 'SUPPORTS',
            signal_type: 'TEMPORAL_ALIGNMENT',
            explanation: `Calendar date alignment verified: both "${a.label}" and "${b.label}" reference ${sharedDates.join(', ')}.`,
            supporting_references: refs,
          });
        } else {
          addRelationship({
            source: a,
            target: b,
            relationship_type: 'CONTRADICTS',
            signal_type: 'TEMPORAL_CONFLICT',
            explanation: `Date mismatch across modalities: "${a.label}" records [${a.iso_dates.join(', ')}] while "${b.label}" records [${b.iso_dates.join(', ')}]. Requires review for timezone offset, archival reuse, or inaccurate captioning.`,
            supporting_references: refs,
          });

          insertFinding({
            investigation_id: investigationId,
            evidence_id: a.evidence_id || b.evidence_id,
            module: 'CROSS_MODAL_ENGINE',
            finding_type: 'CROSS_MODAL_DATE_MISMATCH',
            title: `Date conflict between ${a.label} and ${b.label}`,
            description: `Cross-modal comparison detected conflicting dates: "${a.label}" (${a.iso_dates.join(', ')}) vs "${b.label}" (${b.iso_dates.join(', ')}).`,
            evidence_reference: refs.join(' <-> '),
            timestamp_or_region: `${a.iso_dates[0]} vs ${b.iso_dates[0]}`,
            analysis_category: 'DETERMINISTIC',
            evidence_strength: 'MODERATE',
            uncertainty: 'REQUIRES_HUMAN_REVIEW',
            limitations:
              'Container or EXIF timestamps may reflect device clock drift, re-export dates, or UTC conversion rather than incident time.',
            alternative_explanation:
              'File re-saving on a different date, uncalibrated camera clock, or caption citing upload date instead of capture date.',
          });
        }
      }

      // 2. Location Comparison
      if (a.locations.length > 0 && b.locations.length > 0) {
        const bLocLower = new Set(b.locations.map((l) => l.toLowerCase()));
        const matchedLocs = a.locations.filter((l) => bLocLower.has(l.toLowerCase()));

        if (matchedLocs.length > 0) {
          addRelationship({
            source: a,
            target: b,
            relationship_type: 'SUPPORTS',
            signal_type: 'LOCATION_MATCH',
            explanation: `Shared location reference detected across "${a.label}" and "${b.label}": ${matchedLocs.join(', ')}.`,
            supporting_references: refs,
          });
        } else {
          // Check whether they share topic context (or belong to same evidence/event)
          const sharedKw = a.keywords.filter((k) => b.keywords.includes(k));
          const sameEvidence = a.evidence_id && a.evidence_id === b.evidence_id;
          if (sharedKw.length >= 1 || sameEvidence || (a.media_type === 'text' && b.media_type === 'text')) {
            addRelationship({
              source: a,
              target: b,
              relationship_type: 'CONTRADICTS',
              signal_type: 'LOCATION_MISMATCH',
              explanation: `Potential location contradiction: "${a.label}" references [${a.locations.join(', ')}] while "${b.label}" references [${b.locations.join(', ')}]${sharedKw.length ? ` within shared context (${sharedKw.slice(0, 4).join(', ')})` : ''}.`,
              supporting_references: refs,
            });

            insertFinding({
              investigation_id: investigationId,
              evidence_id: a.evidence_id || b.evidence_id,
              module: 'CROSS_MODAL_ENGINE',
              finding_type: 'CROSS_MODAL_LOCATION_MISMATCH',
              title: `Divergent locations cited: ${a.locations[0]} vs ${b.locations[0]}`,
              description: `"${a.label}" cites location [${a.locations.join(', ')}] whereas "${b.label}" cites [${b.locations.join(', ')}].`,
              evidence_reference: refs.join(' <-> '),
              timestamp_or_region: 'Cross-Modal Location Signal',
              analysis_category: 'STATISTICAL_HEURISTIC',
              evidence_strength: 'MODERATE',
              uncertainty: 'REQUIRES_HUMAN_REVIEW',
              limitations:
                'Text extraction cannot automatically verify geographic hierarchy (e.g., whether a named terminal sits inside a named city).',
              alternative_explanation:
                'One reference may name a specific landmark/district while the other names the broader municipality or nearby area.',
            });
          }
        }
      }

      // 3. Numerical Claim Comparison (when both contain text claims)
      if (a.numbers.length > 0 && b.numbers.length > 0 && a.raw_text && b.raw_text) {
        const cmp = compareTexts(a.label, a.raw_text, b.label, b.raw_text);
        if (cmp.conflicting_numbers.a.length > 0 && cmp.conflicting_numbers.b.length > 0) {
          addRelationship({
            source: a,
            target: b,
            relationship_type: 'REQUIRES_REVIEW',
            signal_type: 'NUMERICAL_DIVERGENCE',
            explanation: `Divergent numerical claims require verification: "${a.label}" states [${cmp.conflicting_numbers.a.slice(0, 3).join(', ')}] while "${b.label}" states [${cmp.conflicting_numbers.b.slice(0, 3).join(', ')}].`,
            supporting_references: refs,
          });
        }
      }

      // 4. Editing Software / Visual Anomaly vs Claim of Unedited Original
      const checkUneditedClaim = (mediaUnit: CorrelatableUnit, textUnit: CorrelatableUnit) => {
        if (
          (mediaUnit.software || mediaUnit.has_ela_anomaly) &&
          /\b(raw|unedited|original|straight from camera|untouched|authentic)\b/i.test(textUnit.raw_text)
        ) {
          addRelationship({
            source: mediaUnit,
            target: textUnit,
            relationship_type: 'REQUIRES_REVIEW',
            signal_type: 'PROVENANCE_CLAIM_CONFLICT',
            explanation: `"${textUnit.label}" claims unedited/original provenance, while "${mediaUnit.label}" exhibits ${mediaUnit.software ? `post-processing software metadata ("${mediaUnit.software}")` : 'elevated ELA compression variance'}.`,
            supporting_references: refs,
          });
        }
      };
      checkUneditedClaim(a, b);
      checkUneditedClaim(b, a);

      // 5. Shared Entities or High Topic Similarity -> RELATED
      const sharedEntities = a.entities.filter((e) =>
        b.entities.some((be) => be.toLowerCase() === e.toLowerCase())
      );
      const sharedKw = a.keywords.filter((k) => b.keywords.includes(k));
      if (sharedEntities.length > 0 || sharedKw.length >= 3) {
        addRelationship({
          source: a,
          target: b,
          relationship_type: 'RELATED',
          signal_type: 'ENTITY_TOPIC_OVERLAP',
          explanation: `Shared subject matter linking "${a.label}" and "${b.label}" via ${sharedEntities.length ? `entities [${sharedEntities.slice(0, 4).join(', ')}]` : `keywords [${sharedKw.slice(0, 5).join(', ')}]`}.`,
          supporting_references: refs,
        });
      }

      // 6. Media-to-Linked-Text Structural Relationship (e.g. Audio file <-> Its Transcript)
      if (a.evidence_id && b.evidence_id && a.evidence_id === b.evidence_id) {
        addRelationship({
          source: a,
          target: b,
          relationship_type: 'RELATED',
          signal_type: 'LINKED_MODALITY',
          explanation: `"${b.label}" is directly attached as a textual record for evidence item "${a.label}".`,
          supporting_references: refs,
        });
      }
    }
  }

  logAuditEvent({
    investigation_id: investigationId,
    event_type: 'RELATIONSHIP_GENERATED',
    description: `Cross-modal correlation completed across ${units.length} evidence/text units; generated ${createdRelationships.length} traceable relationship(s).`,
    details: {
      units_analyzed: units.length,
      relationships_created: createdRelationships.length,
    },
  });

  touchInvestigation(investigationId);

  return {
    relationships_created: createdRelationships.length,
    relationships: createdRelationships,
  };
}

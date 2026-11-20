import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { db, logAuditEvent, nowIso } from '../db.ts';
import {
  ORIGINALS_DIR,
  computeSha256,
  ensureStorageDirs,
  runSafeCommand,
} from '../storage.ts';
import { analyzeImageEvidence } from './imageAnalyzer.ts';
import { analyzeVideoEvidence } from './videoAnalyzer.ts';
import { analyzeAudioEvidence } from './audioAnalyzer.ts';
import { analyzeTextEvidence } from './textAnalyzer.ts';
import { runCrossModalCorrelation } from './correlationEngine.ts';

/**
 * Generates a clearly labeled DEMONSTRATION CASE containing REAL generated media files
 * (JPEG with embedded EXIF, MP4 video with visual scene cuts, WAV audio with silence + energy step,
 * and text caption/transcript documents) and executes the exact same real forensic pipeline on them.
 */
export async function createDemonstrationCase(): Promise<{
  investigation_id: string;
  evidence_count: number;
}> {
  ensureStorageDirs();

  const invId = `INV-${uuidv4().slice(0, 8).toUpperCase()}`;
  const ts = nowIso();
  const invDir = path.join(ORIGINALS_DIR, invId);
  fs.mkdirSync(invDir, { recursive: true });

  db.prepare(
    `INSERT INTO investigations (id, title, description, case_type, status, created_at, updated_at)
     VALUES (?, ?, ?, 'DEMONSTRATION', 'IN_PROGRESS', ?, ?)`
  ).run(
    invId,
    '[DEMONSTRATION] Harbor Terminal Incident — Cross-Modal Verification Test',
    'Clearly labeled demonstration case built from freshly synthesized JPEG, MP4, WAV, and text evidence files processed through the live TruthLens X forensic pipeline to demonstrate EXIF software/date extraction, ELA residual analysis, FFmpeg frame/scene detection, audio spectrogram/silence/energy-jump analysis, and cross-modal location/date correlation.',
    ts,
    ts
  );

  logAuditEvent({
    investigation_id: invId,
    event_type: 'INVESTIGATION_CREATED',
    description: 'Created clearly labeled DEMONSTRATION test case with real generated media files.',
    details: { case_type: 'DEMONSTRATION' },
  });

  const registerEvidence = async (params: {
    original_filename: string;
    stored_filename: string;
    media_type: 'image' | 'video' | 'audio' | 'text';
    mime_type: string;
    description: string;
    file_path: string;
  }) => {
    const evId = `EVD-${uuidv4().slice(0, 8).toUpperCase()}`;
    const stat = fs.statSync(params.file_path);
    const hash = await computeSha256(params.file_path);
    const upTs = nowIso();

    db.prepare(
      `INSERT INTO evidence (
        id, investigation_id, original_filename, stored_filename, media_type,
        file_size, mime_type, sha256_hash, description, uploaded_at, processing_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSING')`
    ).run(
      evId,
      invId,
      params.original_filename,
      params.stored_filename,
      params.media_type,
      stat.size,
      params.mime_type,
      hash,
      params.description,
      upTs
    );

    logAuditEvent({
      investigation_id: invId,
      evidence_id: evId,
      event_type: 'EVIDENCE_UPLOADED',
      description: `Ingested demonstration file ${params.original_filename} (${(stat.size / 1024).toFixed(1)} KB).`,
      details: { sha256_hash: hash },
    });

    logAuditEvent({
      investigation_id: invId,
      evidence_id: evId,
      event_type: 'HASH_GENERATED',
      description: `Computed SHA-256: ${hash}`,
      details: { sha256_hash: hash },
    });

    return { evId, size: stat.size, hash };
  };

  // 1. Generate a REAL JPEG image with embedded EXIF metadata (Camera + Photoshop Software + 2026-10-12 capture date)
  const imgStored = `${uuidv4()}.jpg`;
  const imgPath = path.join(invDir, imgStored);
  const svgScene = `
    <svg width="960" height="600" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#1a2433"/>
          <stop offset="100%" stop-color="#3c4c63"/>
        </linearGradient>
      </defs>
      <rect width="960" height="360" fill="url(#sky)"/>
      <rect y="360" width="960" height="240" fill="#1b1f26"/>
      <rect x="70" y="210" width="210" height="150" fill="#2c3440"/>
      <rect x="320" y="160" width="180" height="200" fill="#232b36"/>
      <rect x="560" y="230" width="290" height="130" fill="#323b47"/>
      <rect x="580" y="255" width="90" height="45" fill="#e5a93b"/>
      <rect x="695" y="255" width="130" height="45" fill="#d97706"/>
      <line x1="0" y1="360" x2="960" y2="360" stroke="#64748b" stroke-width="3"/>
      <text x="64" y="540" fill="#d4d8df" font-family="monospace" font-size="20">HARBOR SECTOR B - CAM 04 // SYNTHETIC TEST FRAME</text>
    </svg>
  `;
  await sharp(Buffer.from(svgScene))
    .jpeg({ quality: 92 })
    .withMetadata({
      exif: {
        IFD0: {
          Make: 'Canon',
          Model: 'EOS R6 Mark II',
          Software: 'Adobe Photoshop 25.4 (Macintosh)',
          ModifyDate: '2026:10:15 19:42:10',
        },
        IFD2: {
          DateTimeOriginal: '2026:10:12 08:15:22',
          CreateDate: '2026:10:12 08:15:22',
        },
      },
    })
    .toFile(imgPath);

  const imgEv = await registerEvidence({
    original_filename: 'harbor_gate_photo.jpg',
    stored_filename: imgStored,
    media_type: 'image',
    mime_type: 'image/jpeg',
    description: 'Still photograph circulated alongside social claim stating the incident happened in Boston on 2026-11-14.',
    file_path: imgPath,
  });

  const imgAnalysisStart = nowIso();
  const imgResult = await analyzeImageEvidence({
    investigation_id: invId,
    evidence_id: imgEv.evId,
    original_path: imgPath,
    original_filename: 'harbor_gate_photo.jpg',
    file_size: imgEv.size,
    sha256_hash: imgEv.hash,
  });
  db.prepare(
    `INSERT INTO analyses (id, evidence_id, analysis_type, status, started_at, completed_at, result_json)
     VALUES (?, ?, 'IMAGE_FORENSICS', 'COMPLETED', ?, ?, ?)`
  ).run(`ANL-${uuidv4().slice(0, 8).toUpperCase()}`, imgEv.evId, imgAnalysisStart, nowIso(), JSON.stringify(imgResult));
  db.prepare("UPDATE evidence SET processing_status = 'COMPLETED' WHERE id = ?").run(imgEv.evId);

  // 2. Generate a REAL MP4 video with 2 distinct scene cuts + tone audio via FFmpeg
  const vidStored = `${uuidv4()}.mp4`;
  const vidPath = path.join(invDir, vidStored);
  await runSafeCommand(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=2.5',
      '-f', 'lavfi', '-i', 'smptebars=size=640x360:rate=24:duration=2.5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5.0',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata', 'creation_time=2026-10-12T08:20:00Z',
      '-metadata', 'encoder=Lavf60.16.100',
      vidPath,
    ],
    30000
  );

  const vidEv = await registerEvidence({
    original_filename: 'dock_camera_clip.mp4',
    stored_filename: vidStored,
    media_type: 'video',
    mime_type: 'video/mp4',
    description: 'Synthetic test video clip with container creation_time 2026-10-12 and an intentional mid-clip visual scene cut at 2.5s.',
    file_path: vidPath,
  });

  const vidAnalysisStart = nowIso();
  const vidResult = await analyzeVideoEvidence({
    investigation_id: invId,
    evidence_id: vidEv.evId,
    original_path: vidPath,
    original_filename: 'dock_camera_clip.mp4',
    file_size: vidEv.size,
  });
  db.prepare(
    `INSERT INTO analyses (id, evidence_id, analysis_type, status, started_at, completed_at, result_json)
     VALUES (?, ?, 'VIDEO_FORENSICS', 'COMPLETED', ?, ?, ?)`
  ).run(`ANL-${uuidv4().slice(0, 8).toUpperCase()}`, vidEv.evId, vidAnalysisStart, nowIso(), JSON.stringify(vidResult));
  db.prepare("UPDATE evidence SET processing_status = 'COMPLETED' WHERE id = ?").run(vidEv.evId);

  // 3. Generate a REAL WAV audio file with active tone -> 1.2s silence -> loud tone step
  const audStored = `${uuidv4()}.wav`;
  const audPath = path.join(invDir, audStored);
  await runSafeCommand(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=320:duration=2.0,volume=0.15',
      '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono,atrim=duration=1.2',
      '-f', 'lavfi', '-i', 'sine=frequency=680:duration=2.0,volume=0.85',
      '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]',
      '-map', '[a]',
      '-ar', '16000', '-ac', '1',
      audPath,
    ],
    25000
  );

  const audEv = await registerEvidence({
    original_filename: 'dispatch_voice_recording.wav',
    stored_filename: audStored,
    media_type: 'audio',
    mime_type: 'audio/wav',
    description: 'Synthetic audio evidence with an intentional 1.2s silence region and abrupt RMS amplitude jump at 3.2s.',
    file_path: audPath,
  });

  const audAnalysisStart = nowIso();
  const audResult = await analyzeAudioEvidence({
    investigation_id: invId,
    evidence_id: audEv.evId,
    original_path: audPath,
    original_filename: 'dispatch_voice_recording.wav',
    file_size: audEv.size,
  });
  db.prepare(
    `INSERT INTO analyses (id, evidence_id, analysis_type, status, started_at, completed_at, result_json)
     VALUES (?, ?, 'AUDIO_FORENSICS', 'COMPLETED', ?, ?, ?)`
  ).run(`ANL-${uuidv4().slice(0, 8).toUpperCase()}`, audEv.evId, audAnalysisStart, nowIso(), JSON.stringify(audResult));
  db.prepare("UPDATE evidence SET processing_status = 'COMPLETED' WHERE id = ?").run(audEv.evId);

  // 4. Generate a REAL text evidence file (Social Caption) & a Manual Audio Transcript record
  const captionText =
    'BREAKING: Raw unedited footage straight from camera showing 450 vehicles blocked at Downtown Plaza in Boston on 2026-11-14 at 14:30 UTC during the harbor inspection.';
  const txtStored = `${uuidv4()}.txt`;
  const txtPath = path.join(invDir, txtStored);
  fs.writeFileSync(txtPath, captionText, 'utf8');

  const txtEv = await registerEvidence({
    original_filename: 'social_media_caption.txt',
    stored_filename: txtStored,
    media_type: 'text',
    mime_type: 'text/plain',
    description: 'Circulated social post caption claiming the footage is raw/unedited and captured in Boston on 2026-11-14.',
    file_path: txtPath,
  });

  const txtStart = nowIso();
  const txtResult = await analyzeTextEvidence({
    investigation_id: invId,
    evidence_id: txtEv.evId,
    original_filename: 'social_media_caption.txt',
    content: captionText,
  });
  db.prepare(
    `INSERT INTO analyses (id, evidence_id, analysis_type, status, started_at, completed_at, result_json)
     VALUES (?, ?, 'TEXT_ANALYSIS', 'COMPLETED', ?, ?, ?)`
  ).run(`ANL-${uuidv4().slice(0, 8).toUpperCase()}`, txtEv.evId, txtStart, nowIso(), JSON.stringify(txtResult));
  db.prepare("UPDATE evidence SET processing_status = 'COMPLETED' WHERE id = ?").run(txtEv.evId);

  // Save matching TextRecord for the social caption & a manual transcript for the audio file
  db.prepare(
    `INSERT INTO text_records (id, investigation_id, evidence_id, role, label, content, segments_json, created_at)
     VALUES (?, ?, ?, 'CAPTION', ?, ?, '[]', ?)`
  ).run(
    `TXT-${uuidv4().slice(0, 8).toUpperCase()}`,
    invId,
    txtEv.evId,
    'Circulated Social Caption',
    captionText,
    nowIso()
  );

  const manualTranscript =
    'Dispatch log from Port Terminal 4 in Chicago on 2026-10-12 at 08:20 UTC. Gate control reports 120 vehicles cleared through harbor inspection without incident.';
  const transcriptSegments = [
    { start: 0.0, end: 2.0, text: 'Dispatch log from Port Terminal 4 in Chicago on 2026-10-12 at 08:20 UTC.' },
    { start: 3.2, end: 5.2, text: 'Gate control reports 120 vehicles cleared through harbor inspection without incident.' },
  ];
  db.prepare(
    `INSERT INTO text_records (id, investigation_id, evidence_id, role, label, content, segments_json, created_at)
     VALUES (?, ?, ?, 'TRANSCRIPT', ?, ?, ?, ?)`
  ).run(
    `TXT-${uuidv4().slice(0, 8).toUpperCase()}`,
    invId,
    audEv.evId,
    'Investigator Manual Transcript (dispatch_voice_recording.wav)',
    manualTranscript,
    JSON.stringify(transcriptSegments),
    nowIso()
  );

  // 5. Run real Cross-Modal Correlation Engine
  runCrossModalCorrelation(invId);

  return {
    investigation_id: invId,
    evidence_count: 4,
  };
}

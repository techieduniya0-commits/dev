import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DATA_ROOT = path.resolve(process.cwd(), 'data');
export const ORIGINALS_DIR = path.join(DATA_ROOT, 'originals');
export const DERIVATIVES_DIR = path.join(DATA_ROOT, 'derivatives');
export const REPORTS_DIR = path.join(DATA_ROOT, 'reports');
export const TMP_DIR = path.join(DATA_ROOT, 'tmp');
export const DB_PATH = path.join(DATA_ROOT, 'truthlens.db');

export const MAX_UPLOAD_MB = 100;
export const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

export type DetectedMediaType = 'image' | 'video' | 'audio' | 'text';

const ALLOWED_EXTENSIONS: Record<string, DetectedMediaType> = {
  // Images
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image',
  '.webp': 'image',
  '.gif': 'image',
  '.bmp': 'image',
  '.tif': 'image',
  '.tiff': 'image',
  // Videos
  '.mp4': 'video',
  '.mov': 'video',
  '.webm': 'video',
  '.mkv': 'video',
  '.avi': 'video',
  '.m4v': 'video',
  // Audio
  '.wav': 'audio',
  '.mp3': 'audio',
  '.ogg': 'audio',
  '.flac': 'audio',
  '.m4a': 'audio',
  '.aac': 'audio',
  // Text
  '.txt': 'text',
  '.md': 'text',
  '.csv': 'text',
  '.json': 'text',
  '.srt': 'text',
  '.vtt': 'text',
  '.log': 'text',
};

export function ensureStorageDirs(): void {
  for (const dir of [DATA_ROOT, ORIGINALS_DIR, DERIVATIVES_DIR, REPORTS_DIR, TMP_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}

export function sanitizeFilename(original: string): string {
  const base = path.basename(original || 'evidence.bin');
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_');
  return cleaned.slice(0, 140) || 'evidence.bin';
}

export function detectMediaType(filename: string, mimeType: string): DetectedMediaType | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext && ALLOWED_EXTENSIONS[ext]) {
    return ALLOWED_EXTENSIONS[ext];
  }
  const lowerMime = (mimeType || '').toLowerCase();
  if (lowerMime.startsWith('image/')) return 'image';
  if (lowerMime.startsWith('video/')) return 'video';
  if (lowerMime.startsWith('audio/')) return 'audio';
  if (lowerMime.startsWith('text/') || lowerMime === 'application/json') return 'text';
  return null;
}

export function isExtensionAllowed(filename: string, mimeType: string): boolean {
  return detectMediaType(filename, mimeType) !== null;
}

export function getOriginalPath(investigationId: string, storedFilename: string): string {
  const safeInv = investigationId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeFile = path.basename(storedFilename);
  return path.join(ORIGINALS_DIR, safeInv, safeFile);
}

export function getDerivativesDir(evidenceId: string): string {
  const safeId = evidenceId.replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(DERIVATIVES_DIR, safeId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export async function computeSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function runSafeCommand(
  binary: string,
  args: string[],
  timeoutMs = 30000
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export async function runSafeCommandBinary(
  binary: string,
  args: string[],
  timeoutMs = 30000
): Promise<{ stdout: Buffer; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    maxBuffer: 40 * 1024 * 1024,
    encoding: 'buffer',
  });
  return {
    stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
    stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr),
  };
}

let cachedCapabilities: {
  ffmpeg: boolean;
  ffprobe: boolean;
  whisper: boolean;
} | null = null;

export async function checkBinaryCapabilities(): Promise<{
  ffmpeg: boolean;
  ffprobe: boolean;
  whisper: boolean;
}> {
  if (cachedCapabilities) return cachedCapabilities;

  const checkBin = async (cmd: string, args: string[]): Promise<boolean> => {
    try {
      await execFileAsync(cmd, args, { timeout: 4000 });
      return true;
    } catch {
      return false;
    }
  };

  const [ffmpeg, ffprobe, whisper] = await Promise.all([
    checkBin('ffmpeg', ['-version']),
    checkBin('ffprobe', ['-version']),
    checkBin('whisper', ['--help']),
  ]);

  cachedCapabilities = { ffmpeg, ffprobe, whisper };
  return cachedCapabilities;
}

export function deleteEvidenceFiles(investigationId: string, evidenceId: string, storedFilename: string): void {
  const orig = getOriginalPath(investigationId, storedFilename);
  if (fs.existsSync(orig)) {
    fs.unlinkSync(orig);
  }
  const derivDir = path.join(DERIVATIVES_DIR, evidenceId.replace(/[^a-zA-Z0-9_-]/g, ''));
  if (fs.existsSync(derivDir)) {
    fs.rmSync(derivDir, { recursive: true, force: true });
  }
}

export function deleteInvestigationFiles(investigationId: string, evidenceIds: string[]): void {
  const safeInv = investigationId.replace(/[^a-zA-Z0-9_-]/g, '');
  const invDir = path.join(ORIGINALS_DIR, safeInv);
  if (fs.existsSync(invDir)) {
    fs.rmSync(invDir, { recursive: true, force: true });
  }
  for (const eid of evidenceIds) {
    const derivDir = path.join(DERIVATIVES_DIR, eid.replace(/[^a-zA-Z0-9_-]/g, ''));
    if (fs.existsSync(derivDir)) {
      fs.rmSync(derivDir, { recursive: true, force: true });
    }
  }
}

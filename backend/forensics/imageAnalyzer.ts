import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import exifr from 'exifr';
import { getDerivativesDir } from '../storage.ts';
import { getSettings, insertFinding, logAuditEvent } from '../db.ts';

export interface ImageAnalysisOutput {
  evidence_id: string;
  format: string;
  width: number;
  height: number;
  channels: number;
  space: string;
  density: number | null;
  has_alpha: boolean;
  file_size: number;
  preview_url: string;
  ela_url: string | null;
  exif: Record<string, any>;
  exif_present: boolean;
  camera_make: string | null;
  camera_model: string | null;
  software: string | null;
  capture_date: string | null;
  modify_date: string | null;
  gps: { latitude: number; longitude: number } | null;
  ela_metrics: {
    quality_level: number;
    mean_difference: number;
    max_difference: number;
    std_deviation: number;
    high_variance_ratio: number;
    tile_max_mean: number;
    tile_min_mean: number;
  } | null;
  noise_metrics: {
    global_laplacian_std: number;
    tile_variance_ratio: number;
  } | null;
  analysis_methods: string[];
  limitations: string[];
}

const KNOWN_EDITING_TOOLS = [
  'photoshop',
  'gimp',
  'lightroom',
  'snapseed',
  'canva',
  'illustrator',
  'affinity',
  'pixelmator',
  'paint.net',
  'midjourney',
  'stable diffusion',
  'dall-e',
  'firefly',
  'premiere',
  'after effects',
  'ffmpeg',
  'imagemagick',
];

function serializeExifValue(val: any): any {
  if (val instanceof Date) return val.toISOString();
  if (val instanceof Uint8Array || Buffer.isBuffer(val)) return `[Binary ${val.length} bytes]`;
  if (Array.isArray(val)) return val.slice(0, 16).map(serializeExifValue);
  if (val && typeof val === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val).slice(0, 40)) {
      out[k] = serializeExifValue(v);
    }
    return out;
  }
  return val;
}

export async function analyzeImageEvidence(params: {
  investigation_id: string;
  evidence_id: string;
  original_path: string;
  original_filename: string;
  file_size: number;
  sha256_hash: string;
}): Promise<ImageAnalysisOutput> {
  const settings = getSettings();
  const elaQuality = Math.min(98, Math.max(70, parseInt(settings.ela_quality || '90', 10) || 90));
  const derivDir = getDerivativesDir(params.evidence_id);

  // 1. Validate & extract basic raster metadata with Sharp
  const img = sharp(params.original_path, { failOn: 'none' });
  const meta = await img.metadata();

  if (!meta.width || !meta.height) {
    throw new Error('File could not be decoded as a valid raster image.');
  }

  // 2. Generate safe preview image (never modifying original)
  const previewPath = path.join(derivDir, 'preview.jpg');
  await sharp(params.original_path, { failOn: 'none' })
    .rotate()
    .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toFile(previewPath);

  const previewUrl = `/derivatives/${params.evidence_id}/preview.jpg`;

  // 3. Extract EXIF / XMP / IPTC / GPS metadata with exifr
  let rawExif: Record<string, any> = {};
  try {
    const parsed = await exifr.parse(params.original_path, {
      tiff: true,
      exif: true,
      gps: true,
      xmp: true,
      iptc: true,
      icc: false,
    });
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed)) {
        if (v !== undefined && v !== null) {
          rawExif[k] = serializeExifValue(v);
        }
      }
    }
  } catch {
    rawExif = {};
  }

  const exifKeys = Object.keys(rawExif);
  const exifPresent = exifKeys.length > 0;
  const cameraMake = rawExif.Make ? String(rawExif.Make).trim() : null;
  const cameraModel = rawExif.Model ? String(rawExif.Model).trim() : null;
  const software = rawExif.Software
    ? String(rawExif.Software).trim()
    : rawExif.CreatorTool
      ? String(rawExif.CreatorTool).trim()
      : null;

  const captureDate =
    rawExif.DateTimeOriginal || rawExif.CreateDate || rawExif.DateTimeDigitized || null;
  const modifyDate = rawExif.ModifyDate || rawExif.MetadataDate || null;

  const gps =
    typeof rawExif.latitude === 'number' && typeof rawExif.longitude === 'number'
      ? {
          latitude: Number(rawExif.latitude.toFixed(6)),
          longitude: Number(rawExif.longitude.toFixed(6)),
        }
      : null;

  logAuditEvent({
    investigation_id: params.investigation_id,
    evidence_id: params.evidence_id,
    event_type: 'METADATA_EXTRACTED',
    description: `Extracted image dimensions (${meta.width}x${meta.height} ${meta.format}) and ${exifKeys.length} metadata fields.`,
    details: {
      width: meta.width,
      height: meta.height,
      format: meta.format,
      exif_count: exifKeys.length,
    },
  });

  // 4. Error Level Analysis (ELA) — real JPEG recompression pixel-difference visualization
  let elaUrl: string | null = null;
  let elaMetrics: ImageAnalysisOutput['ela_metrics'] = null;
  let noiseMetrics: ImageAnalysisOutput['noise_metrics'] = null;

  try {
    const workWidth = Math.min(meta.width, 640);
    const baseSharp = sharp(params.original_path, { failOn: 'none' })
      .rotate()
      .resize({ width: workWidth, withoutEnlargement: true })
      .removeAlpha();

    const origRaw = await baseSharp.clone().raw().toBuffer({ resolveWithObject: true });
    const recompressedJpeg = await baseSharp.clone().jpeg({ quality: elaQuality }).toBuffer();
    const recompRaw = await sharp(recompressedJpeg).raw().toBuffer({ resolveWithObject: true });

    const w = origRaw.info.width;
    const h = origRaw.info.height;
    const ch = origRaw.info.channels;
    const pixelCount = w * h;
    const diffBuf = Buffer.alloc(pixelCount * 3);

    let sumDiff = 0;
    let sumSqDiff = 0;
    let maxDiff = 0;
    let highDiffPixels = 0;

    // 4x4 spatial tile means for local inconsistency check
    const tileCols = 4;
    const tileRows = 4;
    const tileSums = new Float64Array(tileCols * tileRows);
    const tileCounts = new Uint32Array(tileCols * tileRows);

    for (let y = 0; y < h; y++) {
      const ty = Math.min(tileRows - 1, Math.floor((y / h) * tileRows));
      for (let x = 0; x < w; x++) {
        const tx = Math.min(tileCols - 1, Math.floor((x / w) * tileCols));
        const srcIdx = (y * w + x) * ch;
        const dstIdx = (y * w + x) * 3;

        const dr = Math.abs(origRaw.data[srcIdx] - recompRaw.data[srcIdx]);
        const dg = Math.abs(
          origRaw.data[srcIdx + Math.min(1, ch - 1)] - recompRaw.data[srcIdx + Math.min(1, ch - 1)]
        );
        const db = Math.abs(
          origRaw.data[srcIdx + Math.min(2, ch - 1)] - recompRaw.data[srcIdx + Math.min(2, ch - 1)]
        );

        const avgD = (dr + dg + db) / 3;
        sumDiff += avgD;
        sumSqDiff += avgD * avgD;
        if (avgD > maxDiff) maxDiff = avgD;
        if (avgD > 12) highDiffPixels++;

        const tileIdx = ty * tileCols + tx;
        tileSums[tileIdx] += avgD;
        tileCounts[tileIdx]++;

        // Amplify difference by 14x and map to restrained forensic amber/crimson heatmap
        const amp = Math.min(255, Math.round(avgD * 14));
        diffBuf[dstIdx] = Math.min(255, Math.round(amp * 1.15));
        diffBuf[dstIdx + 1] = Math.min(255, Math.round(amp * 0.65));
        diffBuf[dstIdx + 2] = Math.min(255, Math.round(amp * 0.25));
      }
    }

    const elaPath = path.join(derivDir, 'ela.png');
    await sharp(diffBuf, { raw: { width: w, height: h, channels: 3 } })
      .png()
      .toFile(elaPath);
    elaUrl = `/derivatives/${params.evidence_id}/ela.png`;

    const meanDiff = sumDiff / pixelCount;
    const variance = Math.max(0, sumSqDiff / pixelCount - meanDiff * meanDiff);
    const stdDev = Math.sqrt(variance);
    const tileMeans = Array.from({ length: tileCols * tileRows }, (_, i) =>
      tileCounts[i] > 0 ? tileSums[i] / tileCounts[i] : 0
    );
    const tileMaxMean = Math.max(...tileMeans);
    const tileMinMean = Math.min(...tileMeans);

    elaMetrics = {
      quality_level: elaQuality,
      mean_difference: Number(meanDiff.toFixed(3)),
      max_difference: Number(maxDiff.toFixed(2)),
      std_deviation: Number(stdDev.toFixed(3)),
      high_variance_ratio: Number((highDiffPixels / pixelCount).toFixed(4)),
      tile_max_mean: Number(tileMaxMean.toFixed(3)),
      tile_min_mean: Number(tileMinMean.toFixed(3)),
    };

    // 5. Noise residual inspection (3x3 grayscale Laplacian std across 4x4 tiles)
    const gray = new Float32Array(w * h);
    for (let i = 0; i < pixelCount; i++) {
      const idx = i * ch;
      gray[i] =
        0.299 * origRaw.data[idx] +
        0.587 * origRaw.data[idx + Math.min(1, ch - 1)] +
        0.114 * origRaw.data[idx + Math.min(2, ch - 1)];
    }

    let lapSum = 0;
    let lapSq = 0;
    let lapCount = 0;
    const tileLapSum = new Float64Array(16);
    const tileLapCount = new Uint32Array(16);

    for (let y = 1; y < h - 1; y++) {
      const ty = Math.min(3, Math.floor((y / h) * 4));
      for (let x = 1; x < w - 1; x++) {
        const tx = Math.min(3, Math.floor((x / w) * 4));
        const lap = Math.abs(
          4 * gray[y * w + x] -
            gray[(y - 1) * w + x] -
            gray[(y + 1) * w + x] -
            gray[y * w + (x - 1)] -
            gray[y * w + (x + 1)]
        );
        lapSum += lap;
        lapSq += lap * lap;
        lapCount++;
        tileLapSum[ty * 4 + tx] += lap;
        tileLapCount[ty * 4 + tx]++;
      }
    }

    const lapMean = lapCount > 0 ? lapSum / lapCount : 0;
    const lapStd = Math.sqrt(Math.max(0, lapSq / Math.max(1, lapCount) - lapMean * lapMean));
    const tileLapMeans = Array.from({ length: 16 }, (_, i) =>
      tileLapCount[i] > 0 ? tileLapSum[i] / tileLapCount[i] : 0
    ).filter((v) => v > 0.01);
    const maxTileLap = tileLapMeans.length ? Math.max(...tileLapMeans) : 0;
    const minTileLap = tileLapMeans.length ? Math.min(...tileLapMeans) : 0.01;

    noiseMetrics = {
      global_laplacian_std: Number(lapStd.toFixed(3)),
      tile_variance_ratio: Number((maxTileLap / Math.max(0.1, minTileLap)).toFixed(2)),
    };
  } catch {
    elaUrl = null;
    elaMetrics = null;
    noiseMetrics = null;
  }

  // 6. Generate Structured, Honest Forensic Findings
  const ref = `${params.original_filename} (${params.evidence_id})`;

  // Deterministic finding: Container & dimensions summary
  insertFinding({
    investigation_id: params.investigation_id,
    evidence_id: params.evidence_id,
    module: 'IMAGE_FORENSICS',
    finding_type: 'IMAGE_PROFILE',
    title: `Decoded ${String(meta.format || 'unknown').toUpperCase()} image (${meta.width}x${meta.height} px)`,
    description: `Validated raster image ${params.original_filename}: ${meta.width}×${meta.height} pixels, ${meta.channels || 3} channels, color space "${meta.space || 'unknown'}", size ${(params.file_size / 1024).toFixed(1)} KB. SHA-256 recorded at ingestion.`,
    evidence_reference: ref,
    timestamp_or_region: `Full Frame (${meta.width}x${meta.height})`,
    analysis_category: 'DETERMINISTIC',
    evidence_strength: 'STRONG',
    uncertainty: 'NONE',
    limitations: 'Container inspection verifies file format and pixel dimensions; it cannot determine scene authenticity.',
    alternative_explanation: 'Standard decoded raster file properties.',
  });

  // Deterministic finding: EXIF presence / absence
  if (!exifPresent) {
    insertFinding({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      module: 'IMAGE_FORENSICS',
      finding_type: 'MISSING_EXIF',
      title: 'No EXIF, XMP, or camera metadata headers present',
      description: `Metadata parser inspected TIFF, EXIF, XMP, IPTC, and GPS segments in ${params.original_filename} and found no embedded camera metadata headers.`,
      evidence_reference: ref,
      timestamp_or_region: 'File Header',
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'LOW',
      uncertainty: 'AMBIGUOUS',
      limitations: 'Absence of EXIF metadata alone is NEVER proof of manipulation or synthetic generation.',
      alternative_explanation:
        'Social media platforms, messaging apps (WhatsApp, Telegram, X), screenshots, PNG exports, and privacy-stripping tools routinely strip EXIF headers from authentic photographs.',
    });
  } else {
    const details: string[] = [];
    if (cameraMake || cameraModel) details.push(`Device: ${[cameraMake, cameraModel].filter(Boolean).join(' ')}`);
    if (captureDate) details.push(`Capture Date: ${captureDate}`);
    if (modifyDate) details.push(`Modify Date: ${modifyDate}`);
    if (software) details.push(`Software: ${software}`);
    if (gps) details.push(`GPS: ${gps.latitude}, ${gps.longitude}`);

    insertFinding({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      module: 'IMAGE_FORENSICS',
      finding_type: 'EXIF_METADATA_PRESENT',
      title: `Embedded metadata headers found (${exifKeys.length} fields)`,
      description: `Extracted ${exifKeys.length} metadata fields from ${params.original_filename}. ${details.join(' | ') || 'Basic TIFF/EXIF structural tags recorded.'}`,
      evidence_reference: ref,
      timestamp_or_region: captureDate ? String(captureDate) : 'File Header',
      analysis_category: 'DETERMINISTIC',
      evidence_strength: 'MODERATE',
      uncertainty: 'REQUIRES_HUMAN_REVIEW',
      limitations: 'EXIF tags can be intentionally altered, spoofed, or inherited from container templates.',
      alternative_explanation: 'Standard camera or export pipeline metadata recorded by capture hardware or software.',
    });
  }

  // Deterministic finding: Editing software tag detection
  if (software) {
    const lowerSw = software.toLowerCase();
    const matchedTool = KNOWN_EDITING_TOOLS.find((t) => lowerSw.includes(t));
    if (matchedTool) {
      insertFinding({
        investigation_id: params.investigation_id,
        evidence_id: params.evidence_id,
        module: 'IMAGE_FORENSICS',
        finding_type: 'EDITING_SOFTWARE_TAG',
        title: `Post-processing software signature detected: "${software}"`,
        description: `The embedded Software/CreatorTool header explicitly identifies "${software}", indicating the file was saved or exported through image editing or processing software.`,
        evidence_reference: ref,
        timestamp_or_region: 'EXIF Software Tag',
        analysis_category: 'DETERMINISTIC',
        evidence_strength: 'MODERATE',
        uncertainty: 'REQUIRES_HUMAN_REVIEW',
        limitations: 'A software tag confirms processing history but does not specify whether edits were benign (cropping, color balance) or deceptive.',
        alternative_explanation:
          'Photographers and journalists routinely export authentic photographs through Lightroom, Photoshop, GIMP, or resizing utilities for publication.',
      });
    }
  }

  // Deterministic finding: Capture vs Modify timestamp delta
  if (captureDate && modifyDate) {
    const tCap = Date.parse(String(captureDate));
    const tMod = Date.parse(String(modifyDate));
    if (!Number.isNaN(tCap) && !Number.isNaN(tMod)) {
      const diffSec = Math.abs(tMod - tCap) / 1000;
      if (diffSec > 3600) {
        const diffHours = (diffSec / 3600).toFixed(1);
        insertFinding({
          investigation_id: params.investigation_id,
          evidence_id: params.evidence_id,
          module: 'IMAGE_FORENSICS',
          finding_type: 'METADATA_TIMESTAMP_GAP',
          title: `EXIF capture and modification timestamps differ by ${diffHours} hours`,
          description: `DateTimeOriginal (${captureDate}) differs from ModifyDate (${modifyDate}) by approximately ${diffHours} hours.`,
          evidence_reference: ref,
          timestamp_or_region: `${captureDate} -> ${modifyDate}`,
          analysis_category: 'DETERMINISTIC',
          evidence_strength: 'MODERATE',
          uncertainty: 'REQUIRES_HUMAN_REVIEW',
          limitations: 'Timestamp discrepancies reflect clock offsets, timezone conversions, or file re-saving; they do not specify pixel alterations.',
          alternative_explanation:
            'File rotation, metadata tagging, cloud backup sync, or benign cropping performed later on a computer can update ModifyDate.',
        });
      }
    }
  }

  // Statistical/Heuristic finding: Error Level Analysis (ELA)
  if (elaMetrics) {
    const tileRatio = elaMetrics.tile_max_mean / Math.max(0.25, elaMetrics.tile_min_mean);
    const elevated = elaMetrics.high_variance_ratio > 0.08 || (tileRatio > 3.2 && elaMetrics.tile_max_mean > 4.0);
    insertFinding({
      investigation_id: params.investigation_id,
      evidence_id: params.evidence_id,
      module: 'IMAGE_FORENSICS',
      finding_type: elevated ? 'ELA_REGIONAL_VARIANCE' : 'ELA_BASELINE_PROFILE',
      title: elevated
        ? `Elevated regional Error Level Analysis (ELA) variance observed (ratio ${tileRatio.toFixed(1)}x)`
        : `Uniform Error Level Analysis (ELA) residual distribution (mean ${elaMetrics.mean_difference})`,
      description: elevated
        ? `JPEG recompression at quality ${elaMetrics.quality_level} yielded a mean residual of ${elaMetrics.mean_difference} (std ${elaMetrics.std_deviation}) with ${(elaMetrics.high_variance_ratio * 100).toFixed(1)}% elevated pixels and spatial tile variance ratio ${tileRatio.toFixed(2)}x.`
        : `JPEG recompression at quality ${elaMetrics.quality_level} produced a mean pixel difference of ${elaMetrics.mean_difference} (std ${elaMetrics.std_deviation}), with no extreme regional compression disparity detected.`,
      evidence_reference: ref,
      timestamp_or_region: 'Full Image ELA Map',
      analysis_category: 'STATISTICAL_HEURISTIC',
      evidence_strength: elevated ? 'LOW' : 'LOW',
      uncertainty: elevated ? 'REQUIRES_HUMAN_REVIEW' : 'AMBIGUOUS',
      limitations:
        'Error Level Analysis is sensitive to prior JPEG compression history, PNG/lossless source formats, sharp high-contrast edges, and resizing. ELA alone cannot confirm or rule out tampering.',
      alternative_explanation:
        'High-contrast textures (text, foliage, metallic edges), lossless PNG saves, or multi-generation platform re-encoding naturally produce bright ELA regions without manipulation.',
    });
  }

  return {
    evidence_id: params.evidence_id,
    format: String(meta.format || 'unknown'),
    width: meta.width,
    height: meta.height,
    channels: meta.channels || 3,
    space: String(meta.space || 'unknown'),
    density: meta.density ?? null,
    has_alpha: Boolean(meta.hasAlpha),
    file_size: params.file_size,
    preview_url: previewUrl,
    ela_url: elaUrl,
    exif: rawExif,
    exif_present: exifPresent,
    camera_make: cameraMake,
    camera_model: cameraModel,
    software,
    capture_date: captureDate ? String(captureDate) : null,
    modify_date: modifyDate ? String(modifyDate) : null,
    gps,
    ela_metrics: elaMetrics,
    noise_metrics: noiseMetrics,
    analysis_methods: [
      'Cryptographic SHA-256 ingestion hashing',
      'Sharp raster container & pixel geometry decoding',
      'exifr TIFF/EXIF/XMP/IPTC/GPS metadata extraction',
      `Error Level Analysis (JPEG Q${elaQuality} pixel residual mapping)`,
      '3x3 Laplacian spatial noise variance profiling',
    ],
    limitations: [
      'Missing EXIF headers do not imply forgery or synthetic origin.',
      'ELA highlights compression residuals, not semantic authenticity; lossless PNGs and sharp edges produce high residuals.',
      'No neural deepfake classifier is claimed for this module; observations are strictly deterministic metadata checks and statistical pixel heuristics.',
    ],
  };
}

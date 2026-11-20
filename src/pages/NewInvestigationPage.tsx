import React, { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { FileUp, Loader2, Play, Trash2, Upload } from 'lucide-react';
import { api, formatBytes } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { PageHeader } from '../components/ForensicPrimitives';
import type { TextRecordRole } from '../types/forensics';

interface QueuedFile {
  id: string;
  file: File;
  description: string;
}

export const NewInvestigationPage: React.FC = () => {
  const {
    investigations,
    activeId,
    setActiveId,
    setPage,
    refreshInvestigations,
    refreshActiveDetail,
    showNotice,
  } = useInvestigation();

  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [targetInvestigationId, setTargetInvestigationId] = useState<string>(activeId || '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [queued, setQueued] = useState<QueuedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [includeClaim, setIncludeClaim] = useState(false);
  const [claimRole, setClaimRole] = useState<TextRecordRole>('CAPTION');
  const [claimLabel, setClaimLabel] = useState('Circulated Social Caption');
  const [claimContent, setClaimContent] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [stageText, setStageText] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (fileList: FileList | null) => {
    if (!fileList) return;
    const next: QueuedFile[] = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      next.push({
        id: `${f.name}-${f.size}-${Date.now()}-${i}`,
        file: f,
        description: '',
      });
    }
    setQueued((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) => {
    setQueued((prev) => prev.filter((item) => item.id !== id));
  };

  const updateFileDesc = (id: string, val: string) => {
    setQueued((prev) => prev.map((item) => (item.id === id ? { ...item, description: val } : item)));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    if (mode === 'new' && title.trim().length < 2) {
      setErrorMsg('Please enter an investigation title (at least 2 characters).');
      return;
    }
    if (mode === 'existing' && !targetInvestigationId) {
      setErrorMsg('Please select an existing investigation.');
      return;
    }

    setSubmitting(true);
    setUploadPct(0);

    try {
      let invId = targetInvestigationId;

      if (mode === 'new') {
        setStageText('Creating investigation record in SQLite...');
        const created = await api.createInvestigation(title.trim(), description.trim());
        invId = created.id;
      }

      if (queued.length > 0) {
        setStageText(`Uploading ${queued.length} evidence file(s) and computing SHA-256 hashes...`);
        await api.uploadEvidenceWithProgress(
          invId,
          queued.map((q) => q.file),
          queued.map((q) => q.description),
          (pct) => setUploadPct(pct)
        );
      }

      if (includeClaim && claimContent.trim()) {
        setStageText('Persisting investigator caption / claim text record...');
        await api.addTextRecord(invId, {
          role: claimRole,
          label: claimLabel.trim() || `${claimRole} Record`,
          content: claimContent.trim(),
        });
      }

      if (queued.length > 0 || (includeClaim && claimContent.trim())) {
        setStageText('Executing forensic analysis modules and cross-modal correlation...');
        await api.analyzeInvestigation(invId);
      }

      await refreshInvestigations(invId);
      setActiveId(invId);
      await refreshActiveDetail();

      showNotice(
        'success',
        `Investigation ${invId} ingested and analyzed (${queued.length} file(s) processed).`
      );

      const firstType = queued[0]?.file.type || '';
      if (firstType.startsWith('image/')) setPage('image-forensics');
      else if (firstType.startsWith('video/')) setPage('video-forensics');
      else if (firstType.startsWith('audio/')) setPage('audio-forensics');
      else if (queued.length > 1 || includeClaim) setPage('cross-modal');
      else setPage('timeline');
    } catch (err: any) {
      setErrorMsg(err?.message || 'Ingestion or forensic processing failed.');
    } finally {
      setSubmitting(false);
      setStageText('');
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        kicker="Evidence Ingestion"
        title="New Investigation & Evidence Intake"
        description="Uploaded originals are stored immutably with immediate SHA-256 hashing. Analysis derivatives are generated separately."
        actions={
          <div className="flex items-center p-0.5 rounded bg-[#151619] border border-[#2B2D32]">
            <button
              type="button"
              onClick={() => setMode('new')}
              className={`whitespace-nowrap px-3 py-1.5 rounded-sm text-xs font-medium transition-colors ${
                mode === 'new'
                  ? 'bg-[#262930] text-[#F4F3EF]'
                  : 'text-[#92949B] hover:text-[#F4F3EF]'
              }`}
            >
              New Investigation
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('existing');
                if (!targetInvestigationId && investigations.length > 0) {
                  setTargetInvestigationId(activeId || investigations[0].id);
                }
              }}
              className={`whitespace-nowrap px-3 py-1.5 rounded-sm text-xs font-medium transition-colors ${
                mode === 'existing'
                  ? 'bg-[#262930] text-[#F4F3EF]'
                  : 'text-[#92949B] hover:text-[#F4F3EF]'
              }`}
            >
              Add to Existing Case
            </button>
          </div>
        }
      />

      {errorMsg && (
        <div className="rounded-md border border-[#4D2C2F] bg-[#241819] px-4 py-3 text-sm text-[#E69494]">
          {errorMsg}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Step 1: Case Details */}
        <section className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-6 space-y-4">
          <h2 className="text-sm font-semibold text-[#F4F3EF]">1. Investigation Record</h2>

          {mode === 'new' ? (
            <>
              <div>
                <label className="block text-xs font-medium text-[#92949B] mb-1.5">
                  Investigation Title *
                </label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g., Port Terminal Video & Caption Verification — Case 2026-041"
                  className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3.5 py-2.5 text-sm text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441] transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-[#92949B] mb-1.5">
                  Case Summary & Context
                </label>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Describe source provenance, claims under review, and investigative scope..."
                  className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3.5 py-2.5 text-sm text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441] transition-colors"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs font-medium text-[#92949B] mb-1.5">
                Target Investigation
              </label>
              <select
                value={targetInvestigationId}
                onChange={(e) => setTargetInvestigationId(e.target.value)}
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3.5 py-2.5 text-sm text-[#F4F3EF] focus:outline-none focus:border-[#D9A441]"
              >
                <option value="">Select an investigation</option>
                {investigations.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.id} — {inv.title}
                  </option>
                ))}
              </select>
            </div>
          )}
        </section>

        {/* Step 2: Multimodal Evidence Dropzone */}
        <section className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[#F4F3EF]">2. Multimodal Evidence Files</h2>
              <p className="text-xs text-[#92949B] mt-0.5 font-mono">
                Images · Video · Audio · Text (.jpg, .png, .mp4, .mov, .wav, .mp3, .txt, .srt) · Max
                100 MB
              </p>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="whitespace-nowrap px-3.5 py-2 rounded text-xs font-medium border border-[#2B2D32] bg-[#151619] text-[#F4F3EF] hover:border-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5"
            >
              <Upload className="w-3.5 h-3.5" strokeWidth={1.75} />
              Browse Files
            </button>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.mp4,.mov,.webm,.mkv,.avi,.m4v,.wav,.mp3,.ogg,.flac,.m4a,.aac,.txt,.md,.csv,.json,.srt,.vtt,.log"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
          />

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDragging(false);
              addFiles(e.dataTransfer.files);
            }}
            onClick={() => fileInputRef.current?.click()}
            className={`rounded border border-dashed px-6 py-9 text-center cursor-pointer transition-all ${
              isDragging
                ? 'border-[#D9A441] bg-[#211D14]'
                : 'border-[#393C44] bg-[#131417] hover:border-[#D9A441]/70'
            }`}
          >
            <FileUp
              className={`w-6 h-6 mx-auto mb-2.5 transition-transform ${
                isDragging ? 'text-[#D9A441] -translate-y-0.5' : 'text-[#92949B]'
              }`}
              strokeWidth={1.75}
            />
            <div className="text-sm font-medium text-[#F4F3EF]">
              {isDragging
                ? 'Release to queue files for SHA-256 intake'
                : 'Drop evidence files here or click to browse'}
            </div>
            <div className="text-xs text-[#92949B] mt-1">
              Files are never executed; original bytes are hashed upon receipt.
            </div>
          </div>

          {queued.length > 0 && (
            <div className="rounded border border-[#2B2D32] divide-y divide-[#2B2D32] overflow-hidden">
              {queued.map((item) => (
                <div key={item.id} className="p-3.5 bg-[#151619] space-y-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#F4F3EF] truncate">
                        {item.file.name}
                      </div>
                      <div className="text-xs font-mono text-[#92949B] tabular-nums">
                        {item.file.type || 'application/octet-stream'} · {formatBytes(item.file.size)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(item.id)}
                      className="text-xs text-[#C95F5F] hover:text-[#E69494] flex items-center gap-1 shrink-0 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
                      Remove
                    </button>
                  </div>
                  <input
                    type="text"
                    value={item.description}
                    onChange={(e) => updateFileDesc(item.id, e.target.value)}
                    placeholder="Optional evidence context (e.g., source URL, claimed capture date or location)..."
                    className="w-full rounded bg-[#111214] border border-[#2B2D32] px-3 py-1.5 text-xs text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441]"
                  />
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Step 3: Optional Initial Caption / Claim Text */}
        <section className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-[#F4F3EF]">
                3. Optional Supplied Caption, Transcript, or Claim
              </h2>
              <p className="text-xs text-[#92949B] mt-0.5">
                Include an accompanying claim so Cross-Modal Analysis can compare it against media
                timestamps and metadata.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-[#D4D6DC] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeClaim}
                onChange={(e) => setIncludeClaim(e.target.checked)}
                className="accent-[#D9A441]"
              />
              Attach Text Record
            </label>
          </div>

          {includeClaim && (
            <div className="space-y-3 pt-3 border-t border-[#2B2D32]">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-[#92949B] mb-1">Role</label>
                  <select
                    value={claimRole}
                    onChange={(e) => setClaimRole(e.target.value as TextRecordRole)}
                    className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-xs text-[#F4F3EF]"
                  >
                    <option value="CAPTION">Caption</option>
                    <option value="TRANSCRIPT">Transcript</option>
                    <option value="CLAIM">Investigator Claim</option>
                    <option value="DOCUMENT">Document Excerpt</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs text-[#92949B] mb-1">Source Label</label>
                  <input
                    type="text"
                    value={claimLabel}
                    onChange={(e) => setClaimLabel(e.target.value)}
                    placeholder="e.g., X Post Caption by @reporter"
                    className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-xs text-[#F4F3EF]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs text-[#92949B] mb-1">Text Content</label>
                <textarea
                  rows={3}
                  value={claimContent}
                  onChange={(e) => setClaimContent(e.target.value)}
                  placeholder="Paste the caption, transcript, or claim text including dates, times, locations, or figures..."
                  className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none focus:border-[#D9A441]"
                />
              </div>
            </div>
          )}
        </section>

        {/* Real Upload & Analysis Progress */}
        {submitting && (
          <div className="rounded-md border border-[#4F3E1E] bg-[#1E1A13] p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-3 text-xs font-mono">
              <span className="text-[#D9A441] inline-flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
                {stageText}
              </span>
              {uploadPct > 0 && <span className="text-[#F4F3EF] tabular-nums">{uploadPct}%</span>}
            </div>
            <div className="w-full h-1.5 rounded-sm bg-[#111214] overflow-hidden">
              <motion.div
                className="h-full bg-[#D9A441]"
                initial={{ scaleX: 0.1 }}
                animate={{ scaleX: Math.max(0.15, uploadPct / 100) }}
                transition={{ duration: 0.2 }}
                style={{ transformOrigin: 'left center' }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={submitting}
            onClick={() => setPage('overview')}
            className="px-4 py-2 rounded text-xs font-medium border border-[#2B2D32] text-[#92949B] hover:text-[#F4F3EF] transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="whitespace-nowrap px-5 py-2.5 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-2 disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" strokeWidth={2} />
            <span>
              {submitting
                ? 'Processing Evidence...'
                : queued.length > 0
                  ? `Ingest ${queued.length} File(s) & Run Analysis`
                  : 'Create Investigation'}
            </span>
          </button>
        </div>
      </form>
    </div>
  );
};

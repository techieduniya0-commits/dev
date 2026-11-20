import React, { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import { api } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { PageHeader, SkeletonRows } from '../components/ForensicPrimitives';

export const SettingsPage: React.FC = () => {
  const { health, showNotice } = useInvestigation();
  const [form, setForm] = useState<Record<string, string>>({
    analyst_name: '',
    organization_name: '',
    ela_quality: '90',
    scene_threshold: '0.30',
    video_sample_frames: '10',
    silence_noise_db: '-35',
    silence_min_duration: '0.4',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setForm((prev) => ({ ...prev, ...s })))
      .catch((e) => showNotice('error', e?.message || 'Failed to load settings.'))
      .finally(() => setLoading(false));
  }, [showNotice]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api.updateSettings(form);
      setForm(updated);
      showNotice('success', 'Forensic parameters saved to persistent SQLite configuration.');
    } catch (err: any) {
      showNotice('error', err?.message || 'Failed to save settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl space-y-8">
      <PageHeader
        kicker="System Configuration"
        title="Forensic Parameters & Runtime Capabilities"
        description="Configure persisted thresholds for image ELA, video frame/scene extraction, audio silence scanning, and PDF report attribution."
      />

      {/* Processing Parameters Form */}
      {loading ? (
        <SkeletonRows rows={3} />
      ) : (
        <form
          onSubmit={handleSave}
          className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-6 space-y-6"
        >
          <h2 className="text-sm font-semibold text-[#F4F3EF]">Analysis & Report Settings</h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs text-[#92949B] mb-1.5">Lead Analyst Name (PDF)</label>
              <input
                type="text"
                value={form.analyst_name || ''}
                onChange={(e) => setForm({ ...form, analyst_name: e.target.value })}
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm text-[#F4F3EF] focus:outline-none focus:border-[#D9A441]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#92949B] mb-1.5">Organization / Lab Name</label>
              <input
                type="text"
                value={form.organization_name || ''}
                onChange={(e) => setForm({ ...form, organization_name: e.target.value })}
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm text-[#F4F3EF] focus:outline-none focus:border-[#D9A441]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#92949B] mb-1.5">
                Image ELA Recompression Quality (70–98)
              </label>
              <input
                type="number"
                min={70}
                max={98}
                value={form.ela_quality || '90'}
                onChange={(e) => setForm({ ...form, ela_quality: e.target.value })}
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm font-mono text-[#F4F3EF] tabular-nums focus:outline-none focus:border-[#D9A441]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#92949B] mb-1.5">
                Video Scene-Change Threshold (0.10–0.80)
              </label>
              <input
                type="number"
                step="0.05"
                min={0.1}
                max={0.8}
                value={form.scene_threshold || '0.30'}
                onChange={(e) => setForm({ ...form, scene_threshold: e.target.value })}
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm font-mono text-[#F4F3EF] tabular-nums focus:outline-none focus:border-[#D9A441]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#92949B] mb-1.5">
                Video Sampled Frame Count (4–16)
              </label>
              <input
                type="number"
                min={4}
                max={16}
                value={form.video_sample_frames || '10'}
                onChange={(e) => setForm({ ...form, video_sample_frames: e.target.value })}
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm font-mono text-[#F4F3EF] tabular-nums focus:outline-none focus:border-[#D9A441]"
              />
            </div>

            <div>
              <label className="block text-xs text-[#92949B] mb-1.5">
                Audio Silence Threshold (dB, e.g., -35)
              </label>
              <input
                type="number"
                min={-60}
                max={-15}
                value={form.silence_noise_db || '-35'}
                onChange={(e) => setForm({ ...form, silence_noise_db: e.target.value })}
                className="w-full rounded bg-[#131417] border border-[#2B2D32] px-3 py-2 text-sm font-mono text-[#F4F3EF] tabular-nums focus:outline-none focus:border-[#D9A441]"
              />
            </div>
          </div>

          <div className="flex justify-end pt-3 border-t border-[#2B2D32]">
            <button
              type="submit"
              disabled={saving || loading}
              className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" strokeWidth={2} />
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </form>
      )}

      {/* Verified Host Forensic Capabilities */}
      <section className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-6 space-y-4">
        <h2 className="text-sm font-semibold text-[#F4F3EF]">
          Verified Host Forensic Capabilities
        </h2>
        <div className="divide-y divide-[#2B2D32] text-xs font-mono">
          {[
            ['Database Engine', health?.database || 'SQLite', true],
            [
              'Image Decoder & ELA (Sharp)',
              health?.sharp_available ? 'AVAILABLE' : 'UNAVAILABLE',
              Boolean(health?.sharp_available),
            ],
            [
              'EXIF / XMP / GPS Parser (exifr)',
              health?.exifr_available ? 'AVAILABLE' : 'UNAVAILABLE',
              Boolean(health?.exifr_available),
            ],
            [
              'FFmpeg Media Processor',
              health?.ffmpeg_available ? 'AVAILABLE' : 'UNAVAILABLE',
              Boolean(health?.ffmpeg_available),
            ],
            [
              'FFprobe Stream Analyzer',
              health?.ffprobe_available ? 'AVAILABLE' : 'UNAVAILABLE',
              Boolean(health?.ffprobe_available),
            ],
            [
              'PDF Report Engine (PDFKit)',
              health?.pdfkit_available ? 'AVAILABLE' : 'UNAVAILABLE',
              Boolean(health?.pdfkit_available),
            ],
            [
              'Local Speech-to-Text (faster-whisper)',
              health?.whisper_available
                ? 'AVAILABLE'
                : 'NOT INSTALLED (Manual transcript input active)',
              Boolean(health?.whisper_available),
            ],
            ['Max Upload Size Limit', `${health?.max_upload_mb ?? 100} MB per file`, true],
          ].map(([label, value, okState]) => (
            <div key={String(label)} className="py-2.5 flex items-center justify-between gap-4">
              <span className="text-[#92949B] font-sans">{label}</span>
              <span className={okState ? 'text-[#52A378]' : 'text-[#D9A441]'}>{value}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};

import type {
  ApiResponse,
  AuditEvent,
  EvidenceItem,
  Finding,
  HealthInfo,
  IntegrityCheckResult,
  Investigation,
  Relationship,
  ReportRecord,
  ReviewStatus,
  TextRecord,
  TextRecordRole,
} from '../types/forensics';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: {
      ...(options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options?.headers || {}),
    },
    ...options,
  });

  let payload: ApiResponse<T>;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: Server returned non-JSON response.`);
  }

  if (!res.ok || !payload.success) {
    throw new Error(payload.error || `Request failed with status ${res.status}`);
  }
  return payload.data;
}

export interface OverviewData {
  counts: {
    investigations: number;
    evidence_total: number;
    evidence_image: number;
    evidence_video: number;
    evidence_audio: number;
    evidence_text: number;
    findings_total: number;
    findings_reviewed: number;
    relationships_total: number;
    contradictions_total: number;
    reports_total: number;
    processing_pending: number;
    processing_completed: number;
    processing_failed: number;
  };
  recent_investigations: Investigation[];
  recent_findings: Array<Finding & { investigation_title: string }>;
  recent_activity: Array<AuditEvent & { investigation_title: string }>;
}

export interface InvestigationDetail {
  investigation: Investigation;
  evidence: EvidenceItem[];
  findings: Finding[];
  relationships: Relationship[];
  text_records: TextRecord[];
}

export const api = {
  getHealth: () => request<HealthInfo>('/api/health'),
  getOverview: () => request<OverviewData>('/api/overview'),
  getSettings: () => request<Record<string, string>>('/api/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<Record<string, string>>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  createDemoCase: () =>
    request<{ investigation_id: string; evidence_count: number }>('/api/demo/create', {
      method: 'POST',
    }),

  listInvestigations: () => request<Investigation[]>('/api/investigations'),
  createInvestigation: (title: string, description: string) =>
    request<Investigation>('/api/investigations', {
      method: 'POST',
      body: JSON.stringify({ title, description }),
    }),
  getInvestigation: (id: string) => request<InvestigationDetail>(`/api/investigations/${id}`),
  updateInvestigation: (
    id: string,
    payload: Partial<{ title: string; description: string; status: string }>
  ) =>
    request<Investigation>(`/api/investigations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteInvestigation: (id: string) =>
    request<{ deleted_id: string }>(`/api/investigations/${id}`, {
      method: 'DELETE',
    }),

  uploadEvidenceWithProgress: (
    investigationId: string,
    files: File[],
    descriptions: string[],
    onProgress?: (pct: number) => void
  ): Promise<EvidenceItem[]> => {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      files.forEach((file) => formData.append('files', file));
      formData.append('descriptions', JSON.stringify(descriptions));

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/investigations/${investigationId}/evidence`);
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable && onProgress) {
          onProgress(Math.round((evt.loaded / evt.total) * 100));
        }
      };
      xhr.onload = () => {
        try {
          const parsed = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && parsed.success) {
            resolve(parsed.data);
          } else {
            reject(new Error(parsed.error || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('Network error during file upload.'));
      xhr.send(formData);
    });
  },

  deleteEvidence: (evidenceId: string) =>
    request<{ deleted_id: string }>(`/api/evidence/${evidenceId}`, {
      method: 'DELETE',
    }),

  verifyEvidenceIntegrity: (evidenceId: string) =>
    request<IntegrityCheckResult>(`/api/evidence/${evidenceId}/verify`, {
      method: 'POST',
    }),

  analyzeEvidence: (evidenceId: string) =>
    request<any>(`/api/evidence/${evidenceId}/analyze`, {
      method: 'POST',
    }),

  startAsyncVideoAnalysis: (evidenceId: string) =>
    request<any>(`/api/evidence/${evidenceId}/analyze-video-async`, {
      method: 'POST',
    }),

  getVideoAnalysisStatus: (evidenceId: string) =>
    request<{
      evidence_id: string;
      overall_status: 'IDLE' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
      error: string | null;
      layers: Array<{
        layer_number: number;
        layer_id: string;
        layer_name: string;
        status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'UNAVAILABLE' | 'FAILED' | 'REQUIRES_REVIEW';
      }>;
    }>(`/api/evidence/${evidenceId}/video-status`),

  analyzeInvestigation: (investigationId: string) =>
    request<{
      investigation_id: string;
      processed: Array<{ evidence_id: string; filename: string; status: string; error?: string }>;
      relationships_created: number;
    }>(`/api/investigations/${investigationId}/analyze`, {
      method: 'POST',
    }),

  correlateInvestigation: (investigationId: string) =>
    request<{ relationships_created: number; relationships: Relationship[] }>(
      `/api/investigations/${investigationId}/correlate`,
      { method: 'POST' }
    ),

  getTimeline: (investigationId: string) =>
    request<AuditEvent[]>(`/api/investigations/${investigationId}/timeline`),

  reviewFinding: (findingId: string, decision: ReviewStatus, notes: string) =>
    request<{ review: any; finding_id: string; review_status: ReviewStatus }>(
      `/api/findings/${findingId}/review`,
      {
        method: 'POST',
        body: JSON.stringify({
          reviewer_decision: decision,
          reviewer_notes: notes,
        }),
      }
    ),

  addTextRecord: (
    investigationId: string,
    payload: {
      role: TextRecordRole;
      label: string;
      content: string;
      evidence_id?: string | null;
      segments?: Array<{ start: number; end: number; text: string }>;
    }
  ) =>
    request<TextRecord>(`/api/investigations/${investigationId}/text-records`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  deleteTextRecord: (textRecordId: string) =>
    request<{ deleted_id: string }>(`/api/text-records/${textRecordId}`, {
      method: 'DELETE',
    }),

  compareTexts: (payload: {
    label_a: string;
    text_a: string;
    label_b: string;
    text_b: string;
  }) =>
    request<any>('/api/text/compare', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  generateReport: (investigationId: string) =>
    request<ReportRecord>(`/api/investigations/${investigationId}/report`, {
      method: 'POST',
    }),

  listReports: (investigationId?: string) =>
    request<ReportRecord[]>(
      investigationId
        ? `/api/reports?investigation_id=${encodeURIComponent(investigationId)}`
        : '/api/reports'
    ),
};

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

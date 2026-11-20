import React, { useMemo, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import { ArrowRight, GitCompare, GitFork, Loader2, Play } from 'lucide-react';
import { api } from '../api/client';
import { useInvestigation } from '../context/InvestigationContext';
import { EmptyWorkspaceState, PageHeader } from '../components/ForensicPrimitives';
import type { NavPage, RelationshipType } from '../types/forensics';

const EDGE_COLORS: Record<RelationshipType, string> = {
  SUPPORTS: '#52A378',
  CONTRADICTS: '#C95F5F',
  REQUIRES_REVIEW: '#D9A441',
  RELATED: '#6491C7',
};

const NODE_ACCENT: Record<string, string> = {
  image: '#D9A441',
  video: '#6491C7',
  audio: '#52A378',
  text: '#B8BAC0',
  finding: '#C95F5F',
};

const MEDIA_ROUTE: Record<string, NavPage> = {
  image: 'image-forensics',
  video: 'video-forensics',
  audio: 'audio-forensics',
  text: 'text-analysis',
};

export const CrossModalPage: React.FC = () => {
  const { activeDetail, activeId, setPage, refreshActiveDetail, showNotice } = useInvestigation();
  const [relFilter, setRelFilter] = useState<'ALL' | RelationshipType>('ALL');
  const [mediaFilter, setMediaFilter] = useState<'ALL' | 'image' | 'video' | 'audio' | 'text'>('ALL');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const evidence = activeDetail?.evidence || [];
  const textRecords = activeDetail?.text_records || [];
  const relationships = activeDetail?.relationships || [];
  const findings = activeDetail?.findings || [];

  const handleRunCorrelation = async () => {
    if (!activeId) return;
    setRunning(true);
    try {
      const res = await api.correlateInvestigation(activeId);
      await refreshActiveDetail();
      showNotice(
        'success',
        `Correlation engine completed: ${res.relationships_created} traceable relationship(s) generated.`
      );
    } catch (e: any) {
      showNotice('error', e?.message || 'Correlation failed.');
    } finally {
      setRunning(false);
    }
  };

  // Build React Flow nodes & edges strictly from persisted backend data
  const { nodes, edges, nodeMetaMap } = useMemo(() => {
    const metaMap = new Map<
      string,
      {
        id: string;
        kind: 'EVIDENCE' | 'TEXT_RECORD';
        media_type: string;
        title: string;
        subtitle: string;
        details: string;
      }
    >();

    const filteredEvidence = evidence.filter(
      (e) => mediaFilter === 'ALL' || e.media_type === mediaFilter
    );
    const filteredText = textRecords.filter(
      () => mediaFilter === 'ALL' || mediaFilter === 'text'
    );

    const rawNodes: Array<{
      id: string;
      kind: 'EVIDENCE' | 'TEXT_RECORD';
      media_type: string;
      title: string;
      subtitle: string;
      details: string;
    }> = [];

    for (const ev of filteredEvidence) {
      const evFindingsCount = findings.filter((f) => f.evidence_id === ev.id).length;
      const item = {
        id: ev.id,
        kind: 'EVIDENCE' as const,
        media_type: ev.media_type,
        title: ev.original_filename,
        subtitle: `${ev.media_type.toUpperCase()} · ${ev.id} · ${evFindingsCount} findings`,
        details: ev.description || `SHA-256: ${ev.sha256_hash.slice(0, 32)}...`,
      };
      rawNodes.push(item);
      metaMap.set(ev.id, item);
    }

    for (const tr of filteredText) {
      const item = {
        id: tr.id,
        kind: 'TEXT_RECORD' as const,
        media_type: 'text',
        title: `${tr.role}: ${tr.label}`,
        subtitle: `TEXT RECORD · ${tr.id}`,
        details: tr.content,
      };
      rawNodes.push(item);
      metaMap.set(tr.id, item);
    }

    const resolveNodeId = (evId: string | null, label: string): string | null => {
      const matchingTr = filteredText.find((t) => `${t.role}: ${t.label}` === label);
      if (matchingTr) return matchingTr.id;
      if (evId && metaMap.has(evId)) return evId;
      const matchingEv = filteredEvidence.find((e) => e.original_filename === label);
      if (matchingEv) return matchingEv.id;
      return null;
    };

    const filteredRels = relationships.filter(
      (r) => relFilter === 'ALL' || r.relationship_type === relFilter
    );

    const rfEdges: Edge[] = [];
    const connectedIds = new Set<string>();

    for (const rel of filteredRels) {
      const src = resolveNodeId(rel.source_evidence_id, rel.source_label);
      const tgt = resolveNodeId(rel.target_evidence_id, rel.target_label);
      if (!src || !tgt || src === tgt) continue;

      const isEdgeSelected = selectedEdgeId === rel.id;
      const isConnectedToSelectedNode =
        selectedNodeId !== null && (src === selectedNodeId || tgt === selectedNodeId);
      if (isConnectedToSelectedNode) {
        connectedIds.add(src);
        connectedIds.add(tgt);
      }

      const color = EDGE_COLORS[rel.relationship_type] || '#6491C7';
      const dimmed =
        selectedNodeId !== null && !isConnectedToSelectedNode && selectedEdgeId === null;

      rfEdges.push({
        id: rel.id,
        source: src,
        target: tgt,
        label: rel.relationship_type.replace(/_/g, ' '),
        animated: rel.relationship_type === 'CONTRADICTS',
        style: {
          stroke: color,
          strokeWidth: isEdgeSelected || isConnectedToSelectedNode ? 2.5 : 1.6,
          opacity: dimmed ? 0.18 : 1,
        },
        labelStyle: {
          fill: color,
          fontSize: 10,
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 500,
        },
        labelBgStyle: {
          fill: '#151619',
          fillOpacity: 0.94,
          stroke: '#2B2D32',
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color,
        },
      });
    }

    const rfNodes: Node[] = rawNodes.map((item, idx) => {
      const cols = Math.max(2, Math.ceil(Math.sqrt(rawNodes.length)));
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const isSelected = selectedNodeId === item.id;
      const isHighlighted = selectedNodeId === null || isSelected || connectedIds.has(item.id);
      const accent = NODE_ACCENT[item.media_type] || '#92949B';

      return {
        id: item.id,
        position: { x: 64 + col * 316, y: 54 + row * 192 },
        data: {
          label: (
            <div className="text-left space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span
                  className="text-[10px] font-mono tracking-tight truncate"
                  style={{ color: accent }}
                >
                  {item.subtitle}
                </span>
              </div>
              <div className="text-xs font-semibold text-[#F4F3EF] leading-snug break-words">
                {item.title}
              </div>
            </div>
          ),
        },
        style: {
          width: 248,
          background: isSelected ? '#23262C' : '#1B1D21',
          border: `1px solid ${isSelected ? '#D9A441' : '#2B2D32'}`,
          borderRadius: 6,
          padding: '11px 13px',
          opacity: isHighlighted ? 1 : 0.28,
          boxShadow: 'none',
          transition: 'opacity 150ms ease, border-color 150ms ease, background-color 150ms ease',
        },
      };
    });

    return { nodes: rfNodes, edges: rfEdges, nodeMetaMap: metaMap };
  }, [evidence, textRecords, relationships, findings, relFilter, mediaFilter, selectedNodeId, selectedEdgeId]);

  const selectedNodeMeta = selectedNodeId ? nodeMetaMap.get(selectedNodeId) || null : null;
  const selectedRel = selectedEdgeId
    ? relationships.find((r) => r.id === selectedEdgeId) || null
    : null;

  const relCounts = useMemo(
    () => ({
      CONTRADICTS: relationships.filter((r) => r.relationship_type === 'CONTRADICTS').length,
      REQUIRES_REVIEW: relationships.filter((r) => r.relationship_type === 'REQUIRES_REVIEW').length,
      SUPPORTS: relationships.filter((r) => r.relationship_type === 'SUPPORTS').length,
      RELATED: relationships.filter((r) => r.relationship_type === 'RELATED').length,
    }),
    [relationships]
  );

  if (!activeId || !activeDetail) {
    return (
      <EmptyWorkspaceState
        icon={GitFork}
        title="Cross-Modal Analysis"
        description="Select or create an investigation first to inspect cross-modal evidence relationships and contradiction links."
        actionLabel="New Investigation"
        onAction={() => setPage('new-investigation')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={`Cross-Modal Correlation Engine · ${activeDetail.investigation.id}${
          activeDetail.investigation.case_type === 'DEMONSTRATION' ? ' · Demonstration Case' : ''
        }`}
        title="Cross-Modal Contradiction Graph"
        description="Every node and edge is derived from persisted timestamps, locations, entities, numerical statements, and forensic metadata."
        actions={
          <button
            type="button"
            onClick={handleRunCorrelation}
            disabled={running}
            className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Play className="w-3.5 h-3.5" strokeWidth={2} />
            )}
            <span>{running ? 'Correlating Signals...' : 'Run Correlation Engine'}</span>
          </button>
        }
      />

      {/* Relationship Summary & Filter Toolbar */}
      <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] px-4 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-[#92949B] mr-2">Relationship</span>
          <div className="flex flex-wrap items-center gap-0.5 rounded bg-[#131417] p-0.5 border border-[#2B2D32]">
            {(['ALL', 'CONTRADICTS', 'REQUIRES_REVIEW', 'SUPPORTS', 'RELATED'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRelFilter(r)}
                className={`whitespace-nowrap px-2.5 py-1 rounded-sm text-xs font-medium transition-colors ${
                  relFilter === r
                    ? 'bg-[#262930] text-[#F4F3EF]'
                    : 'text-[#92949B] hover:text-[#F4F3EF]'
                }`}
              >
                {r === 'ALL'
                  ? `All (${relationships.length})`
                  : `${r.replace(/_/g, ' ')} (${relCounts[r]})`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-[#92949B] mr-2">Modality</span>
          <div className="flex flex-wrap items-center gap-0.5 rounded bg-[#131417] p-0.5 border border-[#2B2D32]">
            {(['ALL', 'image', 'video', 'audio', 'text'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMediaFilter(m)}
                className={`whitespace-nowrap px-2.5 py-1 rounded-sm text-xs font-medium capitalize transition-colors ${
                  mediaFilter === m
                    ? 'bg-[#262930] text-[#D9A441]'
                    : 'text-[#92949B] hover:text-[#F4F3EF]'
                }`}
              >
                {m === 'ALL' ? 'All' : m}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Graph Canvas + Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-8 rounded-md border border-[#2B2D32] bg-[#131417] h-[540px] relative overflow-hidden">
          {nodes.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center p-8 text-center space-y-3">
              <GitCompare className="w-6 h-6 text-[#6C6F77]" strokeWidth={1.75} />
              <div className="text-sm font-medium text-[#F4F3EF]">
                No evidence nodes match the current filter
              </div>
              <p className="text-xs text-[#92949B] max-w-md leading-relaxed">
                Upload at least two pieces of evidence (or an image/video plus a caption or claim)
                and run the Correlation Engine to map cross-modal links.
              </p>
            </div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              fitView
              onNodeClick={(_evt, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
              onEdgeClick={(_evt, edge) => {
                setSelectedEdgeId(edge.id);
                setSelectedNodeId(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
            >
              <Background color="#25272D" gap={22} size={1} />
              <Controls />
              <MiniMap nodeColor={() => '#2E313A'} maskColor="rgba(17, 18, 20, 0.72)" />
            </ReactFlow>
          )}
        </div>

        {/* Selected Node / Edge Details Panel */}
        <div className="xl:col-span-4 rounded-md border border-[#2B2D32] bg-[#1B1D21] p-5 space-y-4 overflow-y-auto max-h-[540px]">
          <div className="text-xs font-medium text-[#D8DAE0] pb-2.5 border-b border-[#2B2D32] flex items-center justify-between">
            <span>Evidence & Relationship Inspector</span>
            {(selectedNodeId || selectedEdgeId) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedNodeId(null);
                  setSelectedEdgeId(null);
                }}
                className="text-[11px] text-[#92949B] hover:text-[#F4F3EF]"
              >
                Clear
              </button>
            )}
          </div>

          {selectedRel ? (
            <div className="space-y-3.5">
              <div
                className="text-xs font-mono font-medium"
                style={{ color: EDGE_COLORS[selectedRel.relationship_type] }}
              >
                {selectedRel.relationship_type.replace(/_/g, ' ')} · {selectedRel.signal_type}
              </div>
              <div className="text-sm font-semibold text-[#F4F3EF] leading-snug">
                {selectedRel.source_label} → {selectedRel.target_label}
              </div>
              <p className="text-xs text-[#D4D6DC] leading-relaxed">{selectedRel.explanation}</p>
              <div className="pt-3 border-t border-[#2B2D32] space-y-1.5">
                <div className="text-xs font-medium text-[#92949B]">Supporting References</div>
                {selectedRel.supporting_references.map((ref, idx) => (
                  <div key={idx} className="text-xs font-mono text-[#B8BAC0]">
                    · {ref}
                  </div>
                ))}
              </div>
            </div>
          ) : selectedNodeMeta ? (
            <div className="space-y-3.5">
              <div className="text-xs font-mono text-[#D9A441]">{selectedNodeMeta.subtitle}</div>
              <div className="text-sm font-semibold text-[#F4F3EF]">{selectedNodeMeta.title}</div>
              <p className="text-xs text-[#C9CBD1] leading-relaxed whitespace-pre-wrap">
                {selectedNodeMeta.details}
              </p>

              {MEDIA_ROUTE[selectedNodeMeta.media_type] && (
                <button
                  type="button"
                  onClick={() => setPage(MEDIA_ROUTE[selectedNodeMeta.media_type])}
                  className="text-xs font-medium text-[#D9A441] hover:underline inline-flex items-center gap-1"
                >
                  Open in {selectedNodeMeta.media_type} module
                  <ArrowRight className="w-3 h-3" strokeWidth={1.75} />
                </button>
              )}

              <div className="pt-3 border-t border-[#2B2D32] space-y-2">
                <div className="text-xs font-medium text-[#92949B]">Connected Relationships</div>
                {relationships
                  .filter(
                    (r) =>
                      r.source_evidence_id === selectedNodeMeta.id ||
                      r.target_evidence_id === selectedNodeMeta.id ||
                      r.source_label === selectedNodeMeta.title ||
                      r.target_label === selectedNodeMeta.title
                  )
                  .map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setSelectedEdgeId(r.id);
                        setSelectedNodeId(null);
                      }}
                      className="w-full text-left p-2.5 rounded bg-[#131417] border border-[#2B2D32] hover:border-[#D9A441] transition-colors space-y-1"
                    >
                      <div
                        className="text-[11px] font-mono"
                        style={{ color: EDGE_COLORS[r.relationship_type] }}
                      >
                        {r.relationship_type.replace(/_/g, ' ')} · {r.signal_type}
                      </div>
                      <div className="text-xs text-[#D4D6DC] line-clamp-2">{r.explanation}</div>
                    </button>
                  ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4 text-xs text-[#92949B]">
              <p className="leading-relaxed">
                Click any node to isolate its connected evidence links, or click any edge to inspect
                the exact forensic signal and supporting references behind that relationship.
              </p>
              <div className="pt-3 border-t border-[#2B2D32] space-y-2 font-mono">
                <div className="text-[#C95F5F]">CONTRADICTS · Conflicting dates or locations</div>
                <div className="text-[#D9A441]">
                  REQUIRES REVIEW · Divergent numbers or provenance conflicts
                </div>
                <div className="text-[#52A378]">SUPPORTS · Aligned timestamps or locations</div>
                <div className="text-[#6491C7]">RELATED · Shared entities or linked modality</div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Traceable Relationships Ledger */}
      <div className="space-y-3">
        <h2 className="text-[15px] font-semibold text-[#F4F3EF]">
          Traceable Cross-Modal Relationships ({relationships.length})
        </h2>
        {relationships.length === 0 ? (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] px-5 py-6 text-sm text-[#92949B]">
            No cross-modal relationships recorded yet. Add multiple evidence files or textual claims
            and click "Run Correlation Engine".
          </div>
        ) : (
          <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32] overflow-hidden">
            {relationships.map((rel) => {
              const isSel = selectedEdgeId === rel.id;
              return (
                <div
                  key={rel.id}
                  onClick={() => {
                    setSelectedEdgeId(rel.id);
                    setSelectedNodeId(null);
                  }}
                  className={`px-5 py-4 cursor-pointer space-y-1.5 transition-colors ${
                    isSel ? 'bg-[#23262C]' : 'hover:bg-[#202328]'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-x-2.5 text-xs font-mono">
                    <span style={{ color: EDGE_COLORS[rel.relationship_type] }}>
                      {rel.relationship_type.replace(/_/g, ' ')}
                    </span>
                    <span className="text-[#40434B]">·</span>
                    <span className="text-[#92949B]">{rel.signal_type}</span>
                    <span className="text-[#40434B]">·</span>
                    <span className="text-[#F4F3EF] font-sans font-medium">
                      {rel.source_label} → {rel.target_label}
                    </span>
                  </div>
                  <p className="text-sm text-[#C9CBD1] leading-relaxed">{rel.explanation}</p>
                  <div className="text-[11px] font-mono text-[#6C6F77]">
                    Refs: {rel.supporting_references.join(' ; ')}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

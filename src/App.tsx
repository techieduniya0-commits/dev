import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import {
  Activity,
  Archive,
  AudioLines,
  FileSearch,
  FileText,
  Film,
  FolderPlus,
  GitFork,
  Image as ImageIcon,
  LayoutDashboard,
  Loader2,
  Menu,
  Play,
  Search,
  Settings,
  X,
} from 'lucide-react';
import { InvestigationProvider, useInvestigation } from './context/InvestigationContext';
import { TruthLensLogo } from './components/TruthLensLogo';
import { QuickJumpModal, ToastViewport } from './components/ForensicPrimitives';
import type { NavPage } from './types/forensics';
import { api } from './api/client';
import { OverviewPage } from './pages/OverviewPage';
import { NewInvestigationPage } from './pages/NewInvestigationPage';
import { ImageForensicsPage } from './pages/ImageForensicsPage';
import { VideoForensicsPage } from './pages/VideoForensicsPage';
import { AudioForensicsPage } from './pages/AudioForensicsPage';
import { TextAnalysisPage } from './pages/TextAnalysisPage';
import { CrossModalPage } from './pages/CrossModalPage';
import { TimelinePage } from './pages/TimelinePage';
import { HistoryPage } from './pages/HistoryPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';

interface NavGroup {
  heading: string;
  items: Array<{
    id: NavPage;
    label: string;
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  }>;
}

const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Workspace',
    items: [
      { id: 'overview', label: 'Overview', icon: LayoutDashboard },
      { id: 'new-investigation', label: 'New Investigation', icon: FolderPlus },
      { id: 'history', label: 'Investigation History', icon: Archive },
    ],
  },
  {
    heading: 'Forensic Modules',
    items: [
      { id: 'image-forensics', label: 'Image Forensics', icon: ImageIcon },
      { id: 'video-forensics', label: 'Video Forensics', icon: Film },
      { id: 'audio-forensics', label: 'Audio Forensics', icon: AudioLines },
      { id: 'text-analysis', label: 'Text Analysis', icon: FileSearch },
    ],
  },
  {
    heading: 'Intelligence & Output',
    items: [
      { id: 'cross-modal', label: 'Cross-Modal Analysis', icon: GitFork },
      { id: 'timeline', label: 'Evidence Timeline', icon: Activity },
      { id: 'reports', label: 'Reports', icon: FileText },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

const WorkspaceShell: React.FC = () => {
  const {
    page,
    setPage,
    investigations,
    activeId,
    setActiveId,
    activeDetail,
    notice,
    clearNotice,
    refreshActiveDetail,
    refreshInvestigations,
    showNotice,
  } = useInvestigation();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [quickJumpOpen, setQuickJumpOpen] = useState(false);
  const [runningAll, setRunningAll] = useState(false);

  // Global Cmd/Ctrl+K shortcut for quick navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setQuickJumpOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleRunFullAnalysis = async () => {
    if (!activeId) return;
    setRunningAll(true);
    try {
      const res = await api.analyzeInvestigation(activeId);
      await refreshActiveDetail();
      await refreshInvestigations(activeId);
      showNotice(
        'success',
        `Analyzed ${res.processed.length} evidence file(s) and generated ${res.relationships_created} cross-modal link(s).`
      );
    } catch (e: any) {
      showNotice('error', e?.message || 'Batch analysis failed.');
    } finally {
      setRunningAll(false);
    }
  };

  // Real counts from currently loaded investigation for subtle sidebar awareness
  const navCounts = useMemo<Partial<Record<NavPage, number>>>(() => {
    if (!activeDetail) return {};
    const ev = activeDetail.evidence || [];
    return {
      'image-forensics': ev.filter((e) => e.media_type === 'image').length,
      'video-forensics': ev.filter((e) => e.media_type === 'video').length,
      'audio-forensics': ev.filter((e) => e.media_type === 'audio').length,
      'text-analysis': (activeDetail.text_records || []).length,
      'cross-modal': (activeDetail.relationships || []).length,
    };
  }, [activeDetail]);

  const flatNavItems = useMemo(
    () =>
      NAV_GROUPS.flatMap((g) =>
        g.items.map((item) => ({
          ...item,
          group: g.heading,
        }))
      ),
    []
  );

  const activeNavLabel = flatNavItems.find((i) => i.id === page)?.label || 'Overview';

  const renderPage = () => {
    switch (page) {
      case 'overview':
        return <OverviewPage />;
      case 'new-investigation':
        return <NewInvestigationPage />;
      case 'image-forensics':
        return <ImageForensicsPage />;
      case 'video-forensics':
        return <VideoForensicsPage />;
      case 'audio-forensics':
        return <AudioForensicsPage />;
      case 'text-analysis':
        return <TextAnalysisPage />;
      case 'cross-modal':
        return <CrossModalPage />;
      case 'timeline':
        return <TimelinePage />;
      case 'history':
        return <HistoryPage />;
      case 'reports':
        return <ReportsPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <OverviewPage />;
    }
  };

  return (
    <div className="min-h-screen bg-[#111214] text-[#F4F3EF] flex">
      {/* Desktop Left Sidebar */}
      <aside className="hidden lg:flex lg:flex-col lg:w-[248px] shrink-0 border-r border-[#2B2D32] bg-[#151619] sticky top-0 h-screen">
        <div className="h-14 px-5 border-b border-[#2B2D32] flex items-center">
          <button
            type="button"
            onClick={() => setPage('overview')}
            className="focus-visible:outline-none rounded"
          >
            <TruthLensLogo />
          </button>
        </div>

        <nav aria-label="Primary navigation" className="flex-1 overflow-y-auto px-3 py-5 space-y-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.heading} className="space-y-0.5">
              <div className="px-2.5 pb-1.5 text-[11px] font-medium text-[#6C6F77]">
                {group.heading}
              </div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = page === item.id;
                const count = navCounts[item.id];
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setPage(item.id)}
                    className={`relative w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded text-[13px] font-medium transition-colors whitespace-nowrap ${
                      active ? 'text-[#F4F3EF]' : 'text-[#92949B] hover:text-[#F4F3EF] hover:bg-[#1B1D21]/60'
                    }`}
                  >
                    {active && (
                      <motion.span
                        layoutId="sidebar-active-surface"
                        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                        className="absolute inset-0 rounded bg-[#1B1D21] border border-[#2B2D32] pointer-events-none"
                      />
                    )}
                    <span className="relative z-10 flex items-center gap-2.5 min-w-0">
                      <Icon
                        className={`w-4 h-4 shrink-0 transition-colors ${
                          active ? 'text-[#D9A441]' : 'text-[#6C6F77]'
                        }`}
                        strokeWidth={1.75}
                      />
                      <span className="truncate">{item.label}</span>
                    </span>
                    {count !== undefined && count > 0 && (
                      <span
                        className={`relative z-10 text-[11px] font-mono tabular-nums shrink-0 ${
                          active ? 'text-[#D9A441]' : 'text-[#6C6F77]'
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Active Investigation Footer Context */}
        <div className="px-4 py-3.5 border-t border-[#2B2D32] text-xs space-y-0.5">
          <div className="text-[11px] text-[#6C6F77]">Active Case</div>
          <div className="font-mono text-[11px] text-[#D0D2D7] truncate">
            {activeDetail ? activeDetail.investigation.id : 'None selected'}
          </div>
          {activeDetail && (
            <div className="text-[11px] text-[#92949B] truncate">
              {activeDetail.investigation.title}
            </div>
          )}
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      <AnimatePresence>
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden flex">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 bg-black/70"
              onClick={() => setMobileMenuOpen(false)}
            />
            <motion.aside
              initial={{ x: -268 }}
              animate={{ x: 0 }}
              exit={{ x: -268 }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 w-[264px] max-w-[85vw] bg-[#151619] border-r border-[#2B2D32] flex flex-col h-full"
            >
              <div className="h-14 px-4 border-b border-[#2B2D32] flex items-center justify-between">
                <TruthLensLogo compact />
                <button
                  type="button"
                  onClick={() => setMobileMenuOpen(false)}
                  aria-label="Close navigation"
                  className="p-1.5 rounded text-[#92949B] hover:text-[#F4F3EF] hover:bg-[#1B1D21]"
                >
                  <X className="w-5 h-5" strokeWidth={1.75} />
                </button>
              </div>
              <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
                {NAV_GROUPS.map((group) => (
                  <div key={group.heading} className="space-y-0.5">
                    <div className="px-2.5 pb-1 text-[11px] font-medium text-[#6C6F77]">
                      {group.heading}
                    </div>
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const active = page === item.id;
                      const count = navCounts[item.id];
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setPage(item.id);
                            setMobileMenuOpen(false);
                          }}
                          className={`w-full flex items-center justify-between gap-2.5 px-2.5 py-2.5 rounded text-sm font-medium transition-colors ${
                            active
                              ? 'bg-[#1B1D21] border border-[#2B2D32] text-[#F4F3EF]'
                              : 'text-[#92949B] hover:text-[#F4F3EF]'
                          }`}
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <Icon
                              className={`w-4 h-4 shrink-0 ${
                                active ? 'text-[#D9A441]' : 'text-[#6C6F77]'
                              }`}
                              strokeWidth={1.75}
                            />
                            <span className="truncate">{item.label}</span>
                          </span>
                          {count !== undefined && count > 0 && (
                            <span className="text-[11px] font-mono text-[#92949B] tabular-nums">
                              {count}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </nav>
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar */}
        <header className="h-14 sticky top-0 z-30 border-b border-[#2B2D32] bg-[#111214]/95 px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded text-[#92949B] hover:text-[#F4F3EF] hover:bg-[#1B1D21]"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" strokeWidth={1.75} />
            </button>

            <div className="flex items-center gap-2 text-xs min-w-0">
              <span className="hidden sm:inline font-medium text-[#92949B] whitespace-nowrap">
                TruthLens X
              </span>
              <span className="hidden sm:inline text-[#3F424A]">/</span>
              <span className="text-[#F4F3EF] font-medium whitespace-nowrap">{activeNavLabel}</span>
              {activeDetail && (
                <>
                  <span className="hidden md:inline text-[#3F424A]">·</span>
                  <span className="hidden md:inline text-[#92949B] truncate max-w-[260px]">
                    {activeDetail.investigation.title}
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {/* Functional Quick Navigation / Case Search Trigger */}
            <button
              type="button"
              onClick={() => setQuickJumpOpen(true)}
              className="whitespace-nowrap px-2.5 py-1.5 rounded text-xs border border-[#2B2D32] bg-[#151619] text-[#92949B] hover:text-[#F4F3EF] hover:border-[#393C44] transition-colors flex items-center gap-2"
              aria-label="Quick navigation"
            >
              <Search className="w-3.5 h-3.5" strokeWidth={1.75} />
              <span className="hidden sm:inline">Jump</span>
              <kbd className="hidden md:inline font-mono text-[10px] text-[#6C6F77] pl-1">⌘K</kbd>
            </button>

            {/* Active Investigation Selector */}
            {investigations.length > 0 && (
              <select
                aria-label="Active Investigation"
                value={activeId || ''}
                onChange={(e) => setActiveId(e.target.value || null)}
                className="rounded bg-[#151619] border border-[#2B2D32] px-2.5 py-1.5 text-xs font-mono text-[#E2E3E6] max-w-[170px] sm:max-w-[250px] truncate hover:border-[#393C44] focus:outline-none focus:border-[#D9A441] transition-colors"
              >
                {investigations.map((inv) => (
                  <option key={inv.id} value={inv.id} className="bg-[#1B1D21] text-[#F4F3EF]">
                    {inv.id} — {inv.title}
                  </option>
                ))}
              </select>
            )}

            {activeId && (
              <button
                type="button"
                onClick={handleRunFullAnalysis}
                disabled={runningAll}
                className="whitespace-nowrap px-3.5 py-1.5 rounded text-xs font-medium border border-[#2B2D32] bg-[#1B1D21] text-[#F4F3EF] hover:border-[#D9A441] hover:text-[#D9A441] active:scale-[0.985] transition-all flex items-center gap-1.5 disabled:opacity-50"
              >
                {runningAll ? (
                  <Loader2 className="w-3.5 h-3.5 text-[#D9A441] animate-spin" strokeWidth={1.75} />
                ) : (
                  <Play className="w-3 h-3 text-[#D9A441]" strokeWidth={2} />
                )}
                <span>{runningAll ? 'Analyzing...' : 'Analyze All'}</span>
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport with Smooth Subtle Page Transition */}
        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1440px] w-full mx-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            >
              {renderPage()}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* Floating Forensic Toast Notifications */}
      <ToastViewport notice={notice} onDismiss={clearNotice} />

      {/* Quick Navigation & Case Switcher Modal */}
      <QuickJumpModal
        open={quickJumpOpen}
        onClose={() => setQuickJumpOpen(false)}
        navItems={flatNavItems}
        investigations={investigations}
        activeId={activeId}
        onSelectPage={(p) => setPage(p)}
        onSelectInvestigation={(id) => {
          setActiveId(id);
          refreshActiveDetail();
        }}
      />
    </div>
  );
};

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <InvestigationProvider>
        <WorkspaceShell />
      </InvestigationProvider>
    </MotionConfig>
  );
}

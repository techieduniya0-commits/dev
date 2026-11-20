import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  FolderOpen,
  Info,
  Search,
  X,
} from 'lucide-react';
import type { Investigation, NavPage } from '../types/forensics';

/* ============================================================================
 * Page Header — restrained architectural header with quiet metadata kicker
 * ============================================================================ */
interface PageHeaderProps {
  kicker?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  kicker,
  title,
  description,
  actions,
}) => {
  return (
    <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5 pb-6 border-b border-[#2B2D32]">
      <div className="space-y-1.5 max-w-2xl min-w-0">
        {kicker && (
          <div className="text-xs font-mono text-[#92949B] tracking-normal">{kicker}</div>
        )}
        <h1 className="text-2xl lg:text-[26px] font-semibold tracking-tight text-[#F4F3EF] leading-tight">
          {title}
        </h1>
        {description && (
          <p className="text-sm text-[#92949B] leading-relaxed">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5 shrink-0">{actions}</div>}
    </div>
  );
};

/* ============================================================================
 * Empty Workspace State — honest guidance + primary CTA
 * ============================================================================ */
interface EmptyWorkspaceStateProps {
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryAction?: React.ReactNode;
}

export const EmptyWorkspaceState: React.FC<EmptyWorkspaceStateProps> = ({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryAction,
}) => {
  return (
    <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] p-8 sm:p-10 space-y-4">
      <div className="flex items-start gap-4">
        {Icon && (
          <div className="w-9 h-9 rounded border border-[#2B2D32] bg-[#151619] flex items-center justify-center shrink-0 text-[#92949B]">
            <Icon className="w-4 h-4" strokeWidth={1.75} />
          </div>
        )}
        <div className="space-y-2 max-w-xl">
          <h2 className="text-[15px] font-semibold text-[#F4F3EF]">{title}</h2>
          <p className="text-sm text-[#92949B] leading-relaxed">{description}</p>
          {(actionLabel || secondaryAction) && (
            <div className="flex flex-wrap items-center gap-2.5 pt-2">
              {actionLabel && onAction && (
                <button
                  type="button"
                  onClick={onAction}
                  className="whitespace-nowrap px-4 py-2 rounded text-xs font-semibold bg-[#D9A441] text-[#111214] hover:bg-[#E5B354] active:scale-[0.985] transition-all inline-flex items-center gap-1.5"
                >
                  {actionLabel}
                </button>
              )}
              {secondaryAction}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ============================================================================
 * Copyable SHA-256 / Reference Button
 * ============================================================================ */
interface CopyHashButtonProps {
  value: string;
  label?: string;
}

export const CopyHashButton: React.FC<CopyHashButtonProps> = ({ value, label = 'Copy hash' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard API may be restricted in certain iframe policies
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={label}
      className="inline-flex items-center gap-1 text-[11px] font-mono text-[#92949B] hover:text-[#F4F3EF] transition-colors shrink-0"
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 text-[#52A378]" strokeWidth={2} />
          <span className="text-[#52A378]">Copied</span>
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" strokeWidth={1.75} />
          <span>Copy</span>
        </>
      )}
    </button>
  );
};

/* ============================================================================
 * Subtle Loading Skeleton Block
 * ============================================================================ */
export const SkeletonRows: React.FC<{ rows?: number }> = ({ rows = 4 }) => (
  <div className="rounded-md border border-[#2B2D32] bg-[#1B1D21] divide-y divide-[#2B2D32]">
    {Array.from({ length: rows }).map((_, i) => (
      <div key={i} className="px-5 py-4 flex items-center justify-between gap-4 animate-pulse">
        <div className="space-y-2 flex-1">
          <div className="h-3 w-28 bg-[#25272C] rounded" />
          <div className="h-3.5 w-64 max-w-full bg-[#25272C] rounded" />
        </div>
        <div className="h-3 w-16 bg-[#25272C] rounded" />
      </div>
    ))}
  </div>
);

/* ============================================================================
 * Animated Forensic Toast Notification
 * ============================================================================ */
interface ToastViewportProps {
  notice: { type: 'info' | 'success' | 'error'; text: string } | null;
  onDismiss: () => void;
}

export const ToastViewport: React.FC<ToastViewportProps> = ({ notice, onDismiss }) => {
  return (
    <div
      aria-live="polite"
      className="fixed bottom-5 right-5 z-50 max-w-md w-[calc(100vw-2.5rem)] pointer-events-none"
    >
      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.text}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={`pointer-events-auto rounded-md border px-4 py-3 flex items-start gap-3 shadow-lg shadow-black/40 ${
              notice.type === 'error'
                ? 'bg-[#221718] border-[#522E31] text-[#E69494]'
                : notice.type === 'success'
                  ? 'bg-[#16211B] border-[#2C4A3A] text-[#7BC79E]'
                  : 'bg-[#1B1D21] border-[#33363E] text-[#D8DAE0]'
            }`}
          >
            {notice.type === 'error' ? (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#C95F5F]" strokeWidth={1.75} />
            ) : notice.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-[#52A378]" strokeWidth={1.75} />
            ) : (
              <Info className="w-4 h-4 shrink-0 mt-0.5 text-[#D9A441]" strokeWidth={1.75} />
            )}
            <p className="text-xs leading-relaxed flex-1 text-[#F4F3EF]">{notice.text}</p>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss notification"
              className="text-[#92949B] hover:text-[#F4F3EF] transition-colors p-0.5 shrink-0"
            >
              <X className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/* ============================================================================
 * Quick Navigation & Case Switcher Modal (Cmd/Ctrl+K)
 * ============================================================================ */
interface QuickJumpModalProps {
  open: boolean;
  onClose: () => void;
  navItems: Array<{
    id: NavPage;
    label: string;
    group: string;
    icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  }>;
  investigations: Investigation[];
  activeId: string | null;
  onSelectPage: (page: NavPage) => void;
  onSelectInvestigation: (id: string) => void;
}

export const QuickJumpModal: React.FC<QuickJumpModalProps> = ({
  open,
  onClose,
  navItems,
  investigations,
  activeId,
  onSelectPage,
  onSelectInvestigation,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const q = query.trim().toLowerCase();

  const matchedNav = useMemo(
    () =>
      navItems.filter(
        (item) =>
          !q || item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q)
      ),
    [navItems, q]
  );

  const matchedCases = useMemo(
    () =>
      investigations
        .filter(
          (inv) =>
            !q ||
            inv.title.toLowerCase().includes(q) ||
            inv.id.toLowerCase().includes(q) ||
            inv.description.toLowerCase().includes(q)
        )
        .slice(0, 6),
    [investigations, q]
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          onClick={onClose}
          className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center pt-[12vh] px-4"
        >
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.985 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-md border border-[#32353C] bg-[#1B1D21] overflow-hidden shadow-2xl shadow-black/60"
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[#2B2D32]">
              <Search className="w-4 h-4 text-[#92949B] shrink-0" strokeWidth={1.75} />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Jump to forensic module or switch investigation..."
                className="flex-1 bg-transparent text-sm text-[#F4F3EF] placeholder:text-[#6C6F77] focus:outline-none"
              />
              <button
                type="button"
                onClick={onClose}
                className="text-[11px] font-mono text-[#6C6F77] hover:text-[#F4F3EF] px-1.5 py-0.5 border border-[#2B2D32] rounded"
              >
                ESC
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto divide-y divide-[#2B2D32]">
              {matchedCases.length > 0 && (
                <div className="p-2">
                  <div className="px-2.5 py-1.5 text-[11px] font-medium text-[#6C6F77]">
                    Investigations
                  </div>
                  {matchedCases.map((inv) => {
                    const isCurrent = inv.id === activeId;
                    return (
                      <button
                        key={inv.id}
                        type="button"
                        onClick={() => {
                          onSelectInvestigation(inv.id);
                          onClose();
                        }}
                        className="w-full text-left px-2.5 py-2 rounded hover:bg-[#24272D] transition-colors flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <FolderOpen
                            className={`w-4 h-4 shrink-0 ${
                              isCurrent ? 'text-[#D9A441]' : 'text-[#92949B]'
                            }`}
                            strokeWidth={1.75}
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-[#F4F3EF] truncate">
                              {inv.title}
                            </div>
                            <div className="text-[11px] font-mono text-[#92949B] tabular-nums">
                              {inv.id} · {inv.evidence_count ?? 0} files · {inv.status}
                            </div>
                          </div>
                        </div>
                        {isCurrent && (
                          <span className="text-[11px] font-mono text-[#D9A441] shrink-0">
                            Active
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="p-2">
                <div className="px-2.5 py-1.5 text-[11px] font-medium text-[#6C6F77]">
                  Modules & Views
                </div>
                {matchedNav.length === 0 ? (
                  <div className="px-2.5 py-4 text-xs text-[#92949B]">
                    No matching modules or investigations.
                  </div>
                ) : (
                  matchedNav.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          onSelectPage(item.id);
                          onClose();
                        }}
                        className="w-full text-left px-2.5 py-2 rounded hover:bg-[#24272D] transition-colors flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Icon className="w-4 h-4 text-[#92949B] shrink-0" strokeWidth={1.75} />
                          <span className="text-xs font-medium text-[#F4F3EF]">{item.label}</span>
                        </div>
                        <span className="text-[11px] text-[#6C6F77] inline-flex items-center gap-1">
                          {item.group}
                          <ArrowRight className="w-3 h-3" strokeWidth={1.75} />
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

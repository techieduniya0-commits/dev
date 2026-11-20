import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, type InvestigationDetail } from '../api/client';
import type { HealthInfo, Investigation, NavPage } from '../types/forensics';

interface InvestigationContextValue {
  page: NavPage;
  setPage: (p: NavPage) => void;
  investigations: Investigation[];
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  activeDetail: InvestigationDetail | null;
  health: HealthInfo | null;
  loadingList: boolean;
  loadingDetail: boolean;
  notice: { type: 'info' | 'success' | 'error'; text: string } | null;
  showNotice: (type: 'info' | 'success' | 'error', text: string) => void;
  clearNotice: () => void;
  refreshInvestigations: (selectId?: string | null) => Promise<void>;
  refreshActiveDetail: () => Promise<void>;
}

const InvestigationContext = createContext<InvestigationContextValue | null>(null);

export const InvestigationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [page, setPage] = useState<NavPage>('overview');
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeDetail, setActiveDetail] = useState<InvestigationDetail | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [notice, setNotice] = useState<{ type: 'info' | 'success' | 'error'; text: string } | null>(null);

  const showNotice = useCallback((type: 'info' | 'success' | 'error', text: string) => {
    setNotice({ type, text });
  }, []);

  const clearNotice = useCallback(() => setNotice(null), []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.getHealth();
      setHealth(h);
    } catch {
      // handled gracefully
    }
  }, []);

  const refreshInvestigations = useCallback(
    async (selectId?: string | null) => {
      setLoadingList(true);
      try {
        const list = await api.listInvestigations();
        setInvestigations(list);
        setActiveId((prev) => {
          if (selectId !== undefined) return selectId;
          if (prev && list.some((i) => i.id === prev)) return prev;
          return list.length > 0 ? list[0].id : null;
        });
      } catch (e: any) {
        showNotice('error', e?.message || 'Failed to load investigations.');
      } finally {
        setLoadingList(false);
      }
      refreshHealth();
    },
    [refreshHealth, showNotice]
  );

  const refreshActiveDetail = useCallback(async () => {
    if (!activeId) {
      setActiveDetail(null);
      return;
    }
    setLoadingDetail(true);
    try {
      const detail = await api.getInvestigation(activeId);
      setActiveDetail(detail);
    } catch (e: any) {
      setActiveDetail(null);
      showNotice('error', e?.message || 'Failed to load investigation workspace.');
    } finally {
      setLoadingDetail(false);
    }
  }, [activeId, showNotice]);

  useEffect(() => {
    refreshInvestigations();
  }, [refreshInvestigations]);

  useEffect(() => {
    refreshActiveDetail();
  }, [refreshActiveDetail]);

  return (
    <InvestigationContext.Provider
      value={{
        page,
        setPage,
        investigations,
        activeId,
        setActiveId,
        activeDetail,
        health,
        loadingList,
        loadingDetail,
        notice,
        showNotice,
        clearNotice,
        refreshInvestigations,
        refreshActiveDetail,
      }}
    >
      {children}
    </InvestigationContext.Provider>
  );
};

export function useInvestigation(): InvestigationContextValue {
  const ctx = useContext(InvestigationContext);
  if (!ctx) throw new Error('useInvestigation must be used inside InvestigationProvider');
  return ctx;
}

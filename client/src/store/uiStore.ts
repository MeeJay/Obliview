import { create } from 'zustand';

export type DashboardLayout = 'list' | 'cards';

interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarFloating: boolean;
  addAgentModalOpen: boolean;
  dashboardLayout: DashboardLayout;

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  toggleSidebarFloating: () => void;
  openAddAgentModal: () => void;
  closeAddAgentModal: () => void;
  setDashboardLayout: (layout: DashboardLayout) => void;
}

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 600;
const STORAGE_KEY_WIDTH    = 'ov-sidebar-width';
const STORAGE_KEY_FLOATING = 'ov-sidebar-floating';
const STORAGE_KEY_DASH_LAYOUT = 'ov-dashboard-layout';

function loadSavedDashLayout(): DashboardLayout {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_DASH_LAYOUT);
    if (saved === 'cards' || saved === 'list') return saved;
  } catch { /* ignore */ }
  return 'list';
}

function loadSavedWidth(): number {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_WIDTH);
    if (saved) {
      const w = parseInt(saved, 10);
      if (!isNaN(w) && w >= MIN_SIDEBAR_WIDTH && w <= MAX_SIDEBAR_WIDTH) return w;
    }
  } catch {
    // localStorage unavailable
  }
  return 280;
}

function loadSavedFloating(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY_FLOATING) === 'true';
  } catch {
    return false;
  }
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  sidebarWidth: loadSavedWidth(),
  sidebarFloating: loadSavedFloating(),
  addAgentModalOpen: false,
  dashboardLayout: loadSavedDashLayout(),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  openAddAgentModal: () => set({ addAgentModalOpen: true }),
  closeAddAgentModal: () => set({ addAgentModalOpen: false }),
  setDashboardLayout: (layout) => {
    try { localStorage.setItem(STORAGE_KEY_DASH_LAYOUT, layout); } catch { /* ignore */ }
    set({ dashboardLayout: layout });
  },
  toggleSidebarFloating: () => set((s) => {
    const next = !s.sidebarFloating;
    try { localStorage.setItem(STORAGE_KEY_FLOATING, String(next)); } catch { /* ignore */ }
    return { sidebarFloating: next };
  }),
  setSidebarWidth: (width) => {
    const clamped = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
    try {
      localStorage.setItem(STORAGE_KEY_WIDTH, String(clamped));
    } catch {
      // localStorage unavailable
    }
    set({ sidebarWidth: clamped });
  },
}));

import { create } from 'zustand';

export type AlertSeverity = 'down' | 'up' | 'warning' | 'info';

export interface LiveAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  navigateTo?: string;
  createdAt: number;
  read: boolean;
}

interface LiveAlertsState {
  alerts: LiveAlert[];
  unreadCount: number;
  enabled: boolean;
  position: 'top-center' | 'bottom-right';
  setEnabled: (v: boolean) => void;
  setPosition: (p: 'top-center' | 'bottom-right') => void;
  /**
   * Add an alert. Pass a stable `id` to deduplicate: if an alert with the same id
   * is already in the list, it is skipped (the violation is already known to the user).
   * Omit `id` for one-off events (monitor up/down) — a random UUID is assigned.
   */
  addAlert: (alert: Omit<LiveAlert, 'id' | 'createdAt' | 'read'> & { id?: string }) => void;
  markAlertRead: (id: string) => void;
  markAllRead: () => void;
  removeAlert: (id: string) => void;
  clearAll: () => void;
}

export const useLiveAlertsStore = create<LiveAlertsState>((set) => ({
  alerts: [],
  unreadCount: 0,
  enabled: true,
  position: 'bottom-right',
  setEnabled: (v) => set({ enabled: v }),
  setPosition: (p) => set({ position: p }),
  addAlert: (alert) =>
    set((s) => {
      const id = alert.id ?? crypto.randomUUID();
      // Stable id already in list → same violation still active, skip silently
      if (alert.id && s.alerts.some((a) => a.id === id)) return s;
      return {
        alerts: [
          { ...alert, id, read: false, createdAt: Date.now() },
          ...s.alerts,
        ].slice(0, 50),
        unreadCount: s.unreadCount + 1,
      };
    }),
  markAlertRead: (id) =>
    set((s) => {
      const alerts = s.alerts.map((a) => a.id === id ? { ...a, read: true } : a);
      return { alerts, unreadCount: alerts.filter((a) => !a.read).length };
    }),
  markAllRead: () =>
    set((s) => ({
      alerts: s.alerts.map((a) => ({ ...a, read: true })),
      unreadCount: 0,
    })),
  removeAlert: (id) => set((s) => {
    const alerts = s.alerts.filter((a) => a.id !== id);
    return { alerts, unreadCount: alerts.filter((a) => !a.read).length };
  }),
  clearAll: () => set({ alerts: [], unreadCount: 0 }),
}));

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Settings,
  Bell,
  Users,
  FolderTree,
  Plus,
  LogOut,
  Cpu,
  PackageOpen,
  ShieldCheck,
  ChevronDown,
  CalendarClock,
  Building2,
  ChevronsLeft,
  ChevronsRight,
  Pin,
  PinOff,
  Search,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { anonymizeUsername } from '@/utils/anonymize';
import { useAuthStore } from '@/store/authStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useTenantStore } from '@/store/tenantStore';
import { useUiStore } from '@/store/uiStore';
import { GroupTree } from '@/components/groups/GroupTree';
import { DevicesProvider } from '@/components/groups/DevicesContext';
import { UserAvatar } from '@/components/common/UserAvatar';
import { agentApi } from '@/api/agent.api';
import { getSocket } from '@/socket/socketClient';
import type { AgentDevice, MonitorStatus } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';

// ── localStorage helpers ─────────────────────────────────────────────────────

function usePersisted<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null ? (JSON.parse(stored) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue(prev => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
      localStorage.setItem(key, JSON.stringify(next));
      return next;
    });
  }, [key]);
  return [value, set];
}

// ── Nav items ────────────────────────────────────────────────────────────────

interface NavItem {
  label: string;
  path: string;
  icon: React.ReactNode;
  adminOnly?: boolean;
}

// ── Main Sidebar ──────────────────────────────────────────────────────────────

export function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const { isAdmin, canCreate, user } = useAuthStore();

  const topNavItems: NavItem[] = [
    { label: t('nav.dashboard'), path: '/', icon: <LayoutDashboard size={16} /> },
  ];

  const adminNavItems: NavItem[] = [
    { label: t('nav.groups'),        path: '/groups',               icon: <FolderTree size={16} />,    adminOnly: true },
    { label: t('nav.notifications'), path: '/notifications',        icon: <Bell size={16} />,          adminOnly: true },
    { label: t('nav.users'),         path: '/admin/users',          icon: <Users size={16} />,         adminOnly: true },
    { label: t('nav.agents'),        path: '/admin/agents',         icon: <Cpu size={16} />,           adminOnly: true },
    { label: t('nav.remediations'),  path: '/admin/remediations',   icon: <ShieldCheck size={16} />,   adminOnly: true },
    { label: t('nav.maintenance'),   path: '/admin/maintenance',    icon: <CalendarClock size={16} />, adminOnly: true },
    { label: t('nav.importExport'),  path: '/admin/import-export',  icon: <PackageOpen size={16} />,   adminOnly: true },
    { label: t('tenant.pageTitle'),  path: '/admin/tenants',        icon: <Building2 size={16} />,     adminOnly: true },
    { label: t('nav.settings'),      path: '/settings',             icon: <Settings size={16} />,      adminOnly: true },
  ];
  const {
    openAddAgentModal,
    sidebarFloating,
    sidebarCollapsed,
    toggleSidebarFloating,
    toggleSidebarCollapsed,
  } = useUiStore();
  const { fetchMonitors, monitors } = useMonitorStore();
  const { currentTenantId } = useTenantStore();

  const [approvedDevices, setApprovedDevices] = useState<AgentDevice[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Map<number, MonitorStatus | 'suspended' | undefined>>(new Map());
  const [search, setSearch] = useState('');

  const [adminMenuOpen, setAdminMenuOpen] = usePersisted<boolean>('sidebar:admin-open', true);

  const admin = isAdmin();

  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors, currentTenantId]);

  // Debounce loadDevices so a burst of AGENT_DEVICE_UPDATED events (typical
  // during bulk approve/delete: server emits one per device in a tight loop)
  // collapses into a single refetch instead of N back-to-back full-tenant
  // scans per admin session. Ultracode review round 2 flagged this as a
  // stampede vector — 50-device bulk approve × every open admin sidebar
  // multiplied server load and hammered the API.
  const loadDevicesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadDevices = useCallback(() => {
    if (!admin) return;
    if (loadDevicesDebounceRef.current) return;
    loadDevicesDebounceRef.current = setTimeout(() => {
      loadDevicesDebounceRef.current = null;
      Promise.all([
        agentApi.listDevices('approved'),
        agentApi.listDevices('suspended'),
      ])
        .then(([approved, suspended]) => setApprovedDevices([...approved, ...suspended]))
        .catch(() => {});
    }, 400);
  }, [admin]);

  useEffect(() => {
    loadDevices();
    const id = setInterval(loadDevices, 30000);
    return () => clearInterval(id);
  }, [loadDevices, currentTenantId]);

  useEffect(() => {
    if (!admin) return;
    const socket = getSocket();
    if (!socket) return;

    const onDeviceUpdated = (data: {
      deviceId: number;
      name: string | null;
      hostname: string;
      status: AgentDevice['status'];
      groupId: number | null;
    }) => {
      setApprovedDevices(prev => {
        const isTracked = prev.some(d => d.id === data.deviceId);
        if (!isTracked) {
          loadDevices();
          return prev;
        }
        if (data.status !== 'approved' && data.status !== 'suspended') {
          return prev.filter(d => d.id !== data.deviceId);
        }
        return prev.map(d =>
          d.id === data.deviceId
            ? { ...d, name: data.name, hostname: data.hostname, status: data.status, groupId: data.groupId }
            : d,
        );
      });
    };

    const onStatusChanged = (data: { deviceId: number; status: string }) => {
      // Guard against the AgentMonitorWorker firing AGENT_STATUS_CHANGED on
      // every check cycle regardless of whether the status actually changed.
      // Without this, every push tick allocates a fresh Map and re-renders
      // the whole sidebar tree even when nothing moved.
      setDeviceStatuses(prev => {
        if (prev.get(data.deviceId) === (data.status as MonitorStatus | 'suspended')) return prev;
        return new Map(prev).set(data.deviceId, data.status as MonitorStatus | 'suspended');
      });
    };

    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    return () => {
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    };
  }, [admin, loadDevices]);

  // Pre-index monitors by agentDeviceId so the resolver below is O(devices)
  // rather than O(devices × monitors). Rebuilt only when the monitor set or
  // its status distribution changes — device-status socket frames don't
  // invalidate this since they touch `deviceStatuses`, not `monitors`.
  const monitorsByAgentDeviceId = useMemo(() => {
    const map = new Map<number, MonitorStatus>();
    for (const m of monitors.values()) {
      if (m.agentDeviceId != null) map.set(m.agentDeviceId, m.status);
    }
    return map;
  }, [monitors]);

  // Resolve a status for each device by merging the live socket status with
  // its underlying agent monitor's last known status (fallback when no live
  // frame has arrived yet). Memoized so it stays identity-stable when nothing
  // changed — <DevicesProvider> below then avoids re-triggering context
  // consumers on every unrelated sidebar re-render.
  const resolvedDeviceStatuses = useMemo(() => {
    const map = new Map<number, MonitorStatus | 'suspended' | undefined>();
    for (const dev of approvedDevices) {
      const live = deviceStatuses.get(dev.id);
      if (live) { map.set(dev.id, live); continue; }
      const fromMonitor = monitorsByAgentDeviceId.get(dev.id);
      if (fromMonitor) map.set(dev.id, fromMonitor);
    }
    return map;
  }, [approvedDevices, deviceStatuses, monitorsByAgentDeviceId]);

  // ── Collapsed (icon-only, 64 px) render ────────────────────────────────────

  if (sidebarCollapsed) {
    const allItems = [
      ...topNavItems,
      ...(admin ? adminNavItems : []),
    ];
    return (
      <aside className="flex h-full w-full flex-col bg-bg-secondary">
        {/* Header — toggle expand */}
        <div className="flex flex-col items-center gap-2 px-2 pt-3.5">
          <button
            onClick={toggleSidebarCollapsed}
            title={t('nav.expandSidebar', { defaultValue: 'Expand' })}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ChevronsRight size={16} />
          </button>
          {canCreate() && (
            <button
              onClick={openAddAgentModal}
              title={t('common.agent')}
              className="flex h-[38px] w-[38px] items-center justify-center rounded-[7px] bg-accent/10 text-accent-hover transition-colors hover:bg-accent/20"
            >
              <Plus size={14} />
            </button>
          )}
        </div>

        {/* Nav icons only */}
        <nav className="flex flex-1 flex-col items-center gap-1 px-2 pt-3 overflow-y-auto">
          {allItems.map(item => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                title={item.label}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                  isActive
                    ? 'bg-accent/10 text-accent-hover'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                {item.icon}
              </Link>
            );
          })}
        </nav>

        {/* Footer — avatar + logout */}
        <div className="flex flex-col items-center gap-2 border-t border-border px-2 py-3">
          <Link
            to="/profile"
            className="flex h-9 w-9 items-center justify-center rounded-full transition-opacity hover:opacity-80"
            title={user?.displayName ?? user?.username ?? ''}
          >
            <UserAvatar avatar={user?.avatar} username={user?.username ?? '?'} size={24} />
          </Link>
          <button
            onClick={() => useAuthStore.getState().logout()}
            title={t('nav.signOut')}
            className="flex h-9 w-9 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
    );
  }

  // ── Expanded (full content, 260 px / variable) render ──────────────────────

  return (
    <aside className="flex h-full w-full flex-col bg-bg-secondary">
      {/* Header — toggle row + Add agent + search */}
      <div className="flex flex-col gap-[9px] px-3 pb-2.5 pt-3.5">
        <div className="flex items-center justify-end gap-1">
          {/* Collapse toggle — left of the row, hidden when floating per §4.2.1. */}
          {!sidebarFloating && (
            <button
              onClick={toggleSidebarCollapsed}
              title={t('nav.collapseSidebar', { defaultValue: 'Collapse' })}
              className="flex h-[30px] w-[30px] items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <ChevronsLeft size={16} />
            </button>
          )}
          {/* Pin/Float toggle — right of the row. */}
          <button
            onClick={toggleSidebarFloating}
            title={sidebarFloating ? t('nav.pinSidebar') : t('nav.floatSidebar')}
            className={cn(
              'flex h-[30px] w-[30px] items-center justify-center rounded-md transition-colors',
              sidebarFloating
                ? 'text-accent-hover hover:bg-accent/10'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
          >
            {sidebarFloating ? <Pin size={15} /> : <PinOff size={15} />}
          </button>
        </div>

        {canCreate() && (
          <div className="flex gap-2">
            <Link
              to="/monitor/new"
              className="flex h-[38px] flex-1 items-center justify-center gap-2 rounded-[7px] bg-accent/10 text-[13px] font-medium text-accent-hover transition-colors hover:bg-accent/20"
            >
              <Plus size={14} />
              <span>{t('common.monitor')}</span>
            </Link>
            <button
              onClick={openAddAgentModal}
              className="flex h-[38px] flex-1 items-center justify-center gap-2 rounded-[7px] bg-accent/10 text-[13px] font-medium text-accent-hover transition-colors hover:bg-accent/20"
            >
              <Plus size={14} />
              <span>{t('common.agent')}</span>
            </button>
          </div>
        )}

        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder={t('common.search')}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-[38px] w-full rounded-[7px] bg-bg-tertiary pl-8 pr-3 text-[13px] text-text-primary placeholder:text-text-muted focus:bg-bg-hover focus:outline-none"
          />
        </div>
      </div>

      {/* Body — single unified tree: groups are hybrid, monitors and devices
          live side-by-side under each group with distinct leaf icons. */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <DevicesProvider devices={approvedDevices} statuses={resolvedDeviceStatuses} enabled={admin}>
          <GroupTree searchQuery={search} />
        </DevicesProvider>
      </div>

      {/* Top nav */}
      <nav className="px-2 pt-2">
        {topNavItems.map(item => {
          const isActive = location.pathname === item.path;
          return (
            <Link
              key={item.path}
              to={item.path}
              className={cn(
                'mb-0.5 flex h-[38px] items-center gap-3 rounded-[7px] px-3 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-accent/10 text-accent-hover'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
              )}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Admin section */}
      {admin && (
        <>
          <button
            onClick={() => setAdminMenuOpen(v => !v)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-text-muted transition-colors hover:text-text-secondary"
          >
            <div className="h-px flex-1 bg-border" />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em]">
              {t('nav.administration', { defaultValue: 'ADMINISTRATION' })}
            </span>
            <ChevronDown size={11} className={cn('transition-transform duration-200', !adminMenuOpen && '-rotate-90')} />
            <div className="h-px flex-1 bg-border" />
          </button>

          {adminMenuOpen && (
            <nav className="px-2 pb-2 pt-0">
              {adminNavItems.filter(item => !item.adminOnly || isAdmin()).map(item => {
                const isActive = location.pathname === item.path;
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={cn(
                      'mb-0.5 flex h-[38px] items-center gap-3 rounded-[7px] px-3 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-accent/10 text-accent-hover'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          )}
        </>
      )}

      {/* Footer — user row + logout */}
      <div className="border-t border-border p-2.5">
        <Link
          to="/profile"
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors',
            location.pathname === '/profile'
              ? 'bg-accent/10'
              : 'hover:bg-bg-hover',
          )}
        >
          <UserAvatar avatar={user?.avatar} username={user?.username ?? '?'} size={20} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-primary">
              {anonymizeUsername(user?.displayName || (user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username))}
            </div>
            <div className="truncate font-mono text-[10px] text-text-muted">
              {(user?.username?.startsWith('og_') ? user.username.slice(3) : user?.username) ?? ''} · {user?.role ?? ''}
            </div>
          </div>
        </Link>
        <button
          onClick={() => useAuthStore.getState().logout()}
          className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          <LogOut size={14} />
          <span>{t('nav.signOut')}</span>
        </button>
      </div>
    </aside>
  );
}

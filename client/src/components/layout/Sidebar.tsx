import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  LayoutDashboard,
  Settings,
  Bell,
  Users,
  FolderTree,
  Plus,
  LogOut,
  Cpu,
  Server,
  ArrowLeftRight,
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
import { anonymize, anonymizeUsername } from '@/utils/anonymize';
import { useAuthStore } from '@/store/authStore';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { useTenantStore } from '@/store/tenantStore';
import { useUiStore } from '@/store/uiStore';
import { GroupTree } from '@/components/groups/GroupTree';
import { UserAvatar } from '@/components/common/UserAvatar';
import { agentApi } from '@/api/agent.api';
import { getSocket } from '@/socket/socketClient';
import type { AgentDevice, MonitorStatus } from '@obliview/shared';
import { SOCKET_EVENTS } from '@obliview/shared';
import toast from 'react-hot-toast';

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

// ── Status badge (dot + label) ────────────────────────────────────────────────

function AgentStatusBadge({ status }: { status: MonitorStatus | 'suspended' | undefined }) {
  const cfg: Record<string, { dot: string; text: string; label: string }> = {
    up:          { dot: 'bg-green-500',               text: 'text-green-400',  label: 'UP'       },
    down:        { dot: 'bg-red-500',                 text: 'text-red-400',    label: 'DOWN'     },
    alert:       { dot: 'bg-orange-500',              text: 'text-orange-400', label: 'ALERT'    },
    inactive:    { dot: 'bg-gray-400',                text: 'text-gray-400',   label: 'OFFLINE'  },
    suspended:   { dot: 'bg-gray-500',                text: 'text-gray-500',   label: 'PAUSED'   },
    paused:      { dot: 'bg-gray-500',                text: 'text-gray-500',   label: 'PAUSED'   },
    pending:     { dot: 'bg-yellow-500',              text: 'text-yellow-400', label: 'PENDING'  },
    ssl_warning: { dot: 'bg-yellow-400',              text: 'text-yellow-400', label: 'WARN'     },
    ssl_expired: { dot: 'bg-red-500',                 text: 'text-red-400',    label: 'EXPIRED'  },
    updating:    { dot: 'bg-blue-500 animate-pulse',  text: 'text-blue-400',   label: 'UPDATE'   },
  };
  const s = cfg[status ?? ''] ?? { dot: 'bg-gray-400', text: 'text-gray-400', label: '···' };
  return (
    <span className="flex items-center gap-1 shrink-0">
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.dot}`} />
      <span className={`text-[9px] font-semibold leading-none ${s.text}`}>{s.label}</span>
    </span>
  );
}

// ── Draggable Agent Device Item ───────────────────────────────────────────────

function DraggableDeviceItem({
  device,
  monitorStatus,
  indent = false,
}: {
  device: AgentDevice;
  monitorStatus: MonitorStatus | undefined;
  indent?: boolean;
}) {
  const location = useLocation();
  const isActive = location.pathname === `/agents/${device.id}`;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `agent-device-${device.id}`,
    data: { type: 'agent-device', device },
  });

  const displayName = anonymize(device.name ?? device.hostname);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0.4 : 1, paddingLeft: indent ? '24px' : undefined }}
    >
      <Link
        to={`/agents/${device.id}`}
        className={cn(
          'flex items-center gap-2 rounded-md py-1 px-2 text-sm transition-colors',
          isActive
            ? 'bg-accent/10 text-accent-hover'
            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
        )}
        onClick={e => { if (isDragging) e.preventDefault(); }}
      >
        <AgentStatusBadge status={device.status === 'suspended' ? 'suspended' : monitorStatus} />
        <span className="truncate flex-1 text-xs">{displayName}</span>
      </Link>
    </div>
  );
}

// ── Droppable Group Header ─────────────────────────────────────────────────────

function DroppableGroupHeader({
  groupId,
  children,
}: {
  groupId: number | null;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: groupId === null ? 'drop-agent-ungrouped' : `drop-agent-group-${groupId}`,
    data: { type: 'agent-group', groupId },
  });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-md transition-colors',
        isOver && 'ring-1 ring-accent bg-accent/10',
      )}
    >
      {children}
    </div>
  );
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
  const { user, isAdmin, canCreate } = useAuthStore();

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
  const { tree } = useGroupStore();
  const { currentTenantId } = useTenantStore();

  const [approvedDevices, setApprovedDevices] = useState<AgentDevice[]>([]);
  const [deviceStatuses, setDeviceStatuses] = useState<Map<number, string>>(new Map());
  const [search, setSearch] = useState('');

  // Layout preferences
  const [sidebarLayout, setSidebarLayout] = usePersisted<'stacked' | 'side-by-side'>('sidebar-layout', 'stacked');
  const [showMonitors, setShowMonitors] = usePersisted<boolean>('sidebar-show-monitors', true);
  const [showAgents, setShowAgents] = usePersisted<boolean>('sidebar-show-agents', true);
  const [splitPercent, setSplitPercent] = usePersisted<number>('sidebar-split-percent', 50);
  const [adminMenuOpen, setAdminMenuOpen] = usePersisted<boolean>('sidebar:admin-open', true);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const agentGroups = tree.filter(n => n.kind === 'agent');
  const admin = isAdmin();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  useEffect(() => {
    fetchMonitors();
  }, [fetchMonitors, currentTenantId]);

  const loadDevices = useCallback(() => {
    if (!admin) return;
    Promise.all([
      agentApi.listDevices('approved'),
      agentApi.listDevices('suspended'),
    ])
      .then(([approved, suspended]) => setApprovedDevices([...approved, ...suspended]))
      .catch(() => {});
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
      setDeviceStatuses(prev => new Map(prev).set(data.deviceId, data.status));
    };

    socket.on(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
    socket.on(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    return () => {
      socket.off(SOCKET_EVENTS.AGENT_DEVICE_UPDATED, onDeviceUpdated);
      socket.off(SOCKET_EVENTS.AGENT_STATUS_CHANGED, onStatusChanged);
    };
  }, [admin, loadDevices]);

  const getMonitorStatus = useCallback(
    (deviceId: number): MonitorStatus | undefined => {
      const live = deviceStatuses.get(deviceId);
      if (live) return live as MonitorStatus;
      for (const m of monitors.values()) {
        if (m.agentDeviceId === deviceId) return m.status;
      }
      return undefined;
    },
    [deviceStatuses, monitors],
  );

  const handleAgentDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const dragData = active.data.current;
      const dropData = over.data.current;

      if (dragData?.type !== 'agent-device' || dropData?.type !== 'agent-group') return;

      const device = dragData.device as AgentDevice;
      const targetGroupId = dropData.groupId as number | null;

      if (device.groupId === targetGroupId) return;

      try {
        await agentApi.updateDevice(device.id, { groupId: targetGroupId });
        loadDevices();
        toast.success(t('groupTree.agentMoved'));
      } catch {
        toast.error(t('groupTree.failedMoveAgent'));
      }
    },
    [loadDevices, t],
  );

  const handleSplitMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const handleMouseMove = (ev: MouseEvent) => {
      if (!splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const pct = Math.round(((ev.clientX - rect.left) / rect.width) * 100);
      setSplitPercent(Math.max(20, Math.min(80, pct)));
    };
    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [setSplitPercent]);

  const renderAgentContent = (hideHeader = false) => !admin ? null : (
    <DndContext sensors={sensors} onDragEnd={handleAgentDragEnd}>
      <div className={hideHeader ? '' : 'mt-3'}>
        {!hideHeader && (
          <div className="px-3.5 pb-1.5 pt-3.5 text-[10px] font-mono uppercase tracking-[0.14em] text-text-muted">
            {t('groups.agentGroup')}
          </div>
        )}

        {agentGroups.map(group => {
          const isGroupActive = location.pathname === `/group/${group.id}`;
          const groupDevices = approvedDevices.filter(d => d.groupId === group.id);
          return (
            <DroppableGroupHeader key={group.id} groupId={group.id}>
              <Link
                to={`/group/${group.id}`}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors',
                  isGroupActive
                    ? 'bg-accent/10 text-accent-hover'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                <Server size={14} className="shrink-0 text-text-muted" />
                <span className="truncate flex-1">{anonymize(group.name)}</span>
                {groupDevices.length > 0 && (
                  <span className="font-mono text-[10px] text-text-muted">{groupDevices.length}</span>
                )}
              </Link>
              {groupDevices.map(device => (
                <DraggableDeviceItem
                  key={device.id}
                  device={device}
                  monitorStatus={getMonitorStatus(device.id)}
                  indent
                />
              ))}
            </DroppableGroupHeader>
          );
        })}

        {approvedDevices.filter(d => d.groupId === null).length > 0 && (
          <DroppableGroupHeader groupId={null}>
            {approvedDevices.filter(d => d.groupId === null).map(device => (
              <DraggableDeviceItem
                key={device.id}
                device={device}
                monitorStatus={getMonitorStatus(device.id)}
              />
            ))}
          </DroppableGroupHeader>
        )}
      </div>
    </DndContext>
  );

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

      {/* Filter chips + layout toggle */}
      {admin && agentGroups.length > 0 && sidebarLayout === 'stacked' && (
        <div className="flex items-center justify-between gap-2 px-3 pb-1.5">
          <div className="flex gap-1">
            <button
              onClick={() => setShowMonitors(v => !v)}
              className={cn(
                'rounded-full px-2 py-0.5 text-xs transition-colors',
                showMonitors
                  ? 'bg-accent/20 text-accent-hover'
                  : 'bg-bg-hover text-text-muted hover:text-text-secondary',
              )}
            >
              {t('importExport.monitors')}
            </button>
            <button
              onClick={() => setShowAgents(v => !v)}
              className={cn(
                'rounded-full px-2 py-0.5 text-xs transition-colors',
                showAgents
                  ? 'bg-accent/20 text-accent-hover'
                  : 'bg-bg-hover text-text-muted hover:text-text-secondary',
              )}
            >
              {t('nav.agents')}
            </button>
          </div>
          <button
            onClick={() => setSidebarLayout('side-by-side')}
            title="Switch to side-by-side"
            className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <ArrowLeftRight size={13} />
          </button>
        </div>
      )}

      {/* Section header — "APPAREILS" */}
      {admin && (
        <div className="px-3.5 pb-1.5 pt-2.5 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
          {t('groups.agentGroup', { defaultValue: 'APPAREILS' })}
        </div>
      )}

      {/* Body */}
      {sidebarLayout === 'side-by-side' && admin && agentGroups.length > 0 ? (
        <div ref={splitContainerRef} className="flex min-h-0 flex-1 flex-row overflow-hidden">
          <div className="flex min-w-0 flex-col overflow-hidden" style={{ width: `${splitPercent}%` }}>
            <div className="shrink-0 px-3 pb-1.5 pt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">
              {t('importExport.monitors')}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2">
              <GroupTree searchQuery={search} />
            </div>
          </div>

          <div
            onMouseDown={handleSplitMouseDown}
            className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent/40 active:bg-accent/60"
          />

          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between px-3 pb-1.5 pt-1">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-muted">{t('nav.agents')}</span>
              <button
                onClick={() => setSidebarLayout('stacked')}
                title="Switch to stacked"
                className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
              >
                <ArrowLeftRight size={12} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2">
              {renderAgentContent(true)}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {showMonitors && <GroupTree searchQuery={search} />}
          {showAgents && renderAgentContent(false)}
        </div>
      )}

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

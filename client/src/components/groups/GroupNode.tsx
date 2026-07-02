import { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import type { GroupTreeNode, Monitor } from '@obliview/shared';
import { cn } from '@/utils/cn';
import { anonymize } from '@/utils/anonymize';
import { useMonitorStore } from '@/store/monitorStore';
import { useGroupStore } from '@/store/groupStore';
import { DraggableMonitor } from './GroupTree';
import { DraggableDevice } from './DraggableDevice';
import { useGroupDevices } from './DevicesContext';

/** Collect all group IDs in a subtree (including self) */
function collectGroupIds(node: GroupTreeNode): number[] {
  const ids = [node.id];
  for (const child of node.children) {
    ids.push(...collectGroupIds(child));
  }
  return ids;
}

interface GroupNodeProps {
  node: GroupTreeNode;
  depth?: number;
  selectedGroupId?: number | null;
  onSelectGroup?: (groupId: number | null) => void;
  dndEnabled?: boolean;
  searchQuery?: string;
}

export function GroupNode({ node, depth = 0, selectedGroupId, onSelectGroup, dndEnabled = false, searchQuery = '' }: GroupNodeProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { getMonitorsByGroup, getMonitorSummary, getRecentHeartbeats } = useMonitorStore();
  const { getGroupStats, isGroupExpanded, toggleGroupExpanded } = useGroupStore();
  const expanded = isGroupExpanded(node.id);

  const allMonitors = getMonitorsByGroup(node.id);
  const { list: groupDevices, enabled: devicesEnabled, statuses: deviceStatuses } = useGroupDevices(node.id);

  // When a search is active, filter monitors and child groups to matching ones only
  const isSearching = searchQuery.length > 0;

  const hasMatchingInSubtree = (n: GroupTreeNode): boolean => {
    if (getMonitorsByGroup(n.id).some(m => m.name.toLowerCase().includes(searchQuery.toLowerCase()))) return true;
    return n.children.some(hasMatchingInSubtree);
  };

  const monitors = isSearching
    ? allMonitors.filter(m => m.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : allMonitors;

  const visibleChildren = isSearching
    ? node.children.filter(hasMatchingInSubtree)
    : node.children;

  const visibleDevices = isSearching
    ? groupDevices.filter((d) => (d.name ?? d.hostname).toLowerCase().includes(searchQuery.toLowerCase()))
    : groupDevices;

  // Force-expand when searching so matched monitors are visible
  const effectiveExpanded = isSearching ? true : expanded;

  const hasContent = node.children.length > 0 || allMonitors.length > 0 || groupDevices.length > 0;
  const isSelected = selectedGroupId === node.id;
  const stats = getGroupStats(node.id);

  // Check if this group (incl. descendants) contains ONLY value_watcher monitors.
  // Memoized: `node` identity is stable across renders (comes from the group
  // store's tree, only rebuilt on tree refresh), so recomputing subtree ids +
  // subtree monitor list on every socket-frame re-render was pure overhead —
  // the sidebar walked O(subtree × total-monitors) per push. Now: one walk
  // when the tree changes, cheap check otherwise.
  const allGroupIds = useMemo(() => collectGroupIds(node), [node]);
  const allMonitorsInTree = useMemo<Monitor[]>(
    () => allGroupIds.flatMap((gid) => getMonitorsByGroup(gid)),
    [allGroupIds, getMonitorsByGroup],
  );
  const isValueWatcherOnly = allMonitorsInTree.length > 0
    && allMonitorsInTree.every((m) => m.type === 'value_watcher');

  // If value_watcher only, compute total from latest heartbeat values.
  // Kept outside the useMemo above because it depends on socket-frame data
  // (getRecentHeartbeats) — recomputing here on every render is intentional.
  let valueTotal: number | null = null;
  if (isValueWatcherOnly) {
    let sum = 0;
    let hasAny = false;
    for (const m of allMonitorsInTree) {
      const hbs = getRecentHeartbeats(m.id);
      const latest = hbs.length > 0 ? hbs[hbs.length - 1] : null;
      if (latest?.value != null) {
        const n = Number(latest.value);
        if (!isNaN(n)) {
          sum += n;
          hasAny = true;
        }
      }
    }
    if (hasAny) valueTotal = sum;
  }

  const PROBLEM_STATUSES = new Set(['down', 'alert', 'ssl_expired', 'ssl_warning']);
  const upCount = monitors.filter((m) => m.status === 'up').length;
  const downCount = monitors.filter((m) => PROBLEM_STATUSES.has(m.status)).length;
  const totalCount = monitors.length;

  // Make this group a drop target
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-group-${node.id}`,
    data: { groupId: node.id },
    disabled: !dndEnabled,
  });

  return (
    <div
      ref={dndEnabled ? setNodeRef : undefined}
      className={cn(
        'transition-colors rounded-md',
        isOver && 'bg-accent/10 ring-1 ring-accent/30',
      )}
    >
      {/* Group header — split click zones */}
      {(() => {
        const isActive = location.pathname === `/group/${node.id}`;
        return (
          <div
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md text-sm transition-colors',
              isActive
                ? 'bg-bg-active text-text-primary'
                : isSelected
                  ? 'bg-bg-active text-text-primary'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
          >
            {/* Left zone: chevron + folder icon — toggles expand/collapse */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (hasContent) toggleGroupExpanded(node.id);
                onSelectGroup?.(isSelected ? null : node.id);
              }}
              className="flex items-center gap-1 shrink-0 py-1.5 pr-0.5"
            >
              {hasContent ? (
                <ChevronRight
                  size={14}
                  className={cn('shrink-0 transition-transform', effectiveExpanded && 'rotate-90')}
                />
              ) : (
                <span className="w-3.5 shrink-0" />
              )}

              {effectiveExpanded && hasContent ? (
                <FolderOpen size={14} className="shrink-0 text-accent" />
              ) : (
                <Folder size={14} className="shrink-0 text-accent" />
              )}
            </button>

            {/* Right zone: name + badges — navigates to group detail page */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/group/${node.id}`);
              }}
              className="flex items-center gap-1.5 flex-1 min-w-0 py-1.5 pr-2"
            >
              <span className="truncate flex-1 text-left">{anonymize(node.name)}</span>

              {/* Value total for value_watcher-only groups, otherwise uptime % */}
              {isValueWatcherOnly && valueTotal !== null ? (
                <span className="shrink-0 inline-flex items-center rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                  {valueTotal.toLocaleString()}
                </span>
              ) : (
                stats && stats.total > 0 && (
                  <span
                    className={cn(
                      'shrink-0 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                      stats.uptimePct >= 99
                        ? 'bg-status-up-bg text-status-up'
                        : stats.uptimePct >= 95
                          ? 'bg-yellow-500/10 text-yellow-500'
                          : 'bg-status-down-bg text-status-down',
                    )}
                  >
                    {stats.uptimePct}%
                  </span>
                )
              )}

              {totalCount > 0 && (
                <span className="shrink-0 text-xs text-text-muted">
                  {downCount > 0 ? (
                    <span className="text-status-down">{downCount}</span>
                  ) : (
                    <span className="text-status-up">{upCount}</span>
                  )}
                  /{totalCount}
                </span>
              )}
            </button>
          </div>
        );
      })()}

      {/* Children and monitors */}
      {effectiveExpanded && (
        <div>
          {/* Child groups */}
          {visibleChildren.map((child) => (
            <GroupNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedGroupId={selectedGroupId}
              onSelectGroup={onSelectGroup}
              dndEnabled={dndEnabled}
              searchQuery={searchQuery}
            />
          ))}

          {/* Monitors in this group */}
          {monitors.map((monitor) => (
            <DraggableMonitor
              key={monitor.id}
              monitor={monitor}
              depth={depth + 1}
              dndEnabled={dndEnabled}
              navigate={navigate}
              location={location}
              getMonitorSummary={getMonitorSummary}
            />
          ))}

          {/* Agent devices in this group (when the tree is rendered inside a
              <DevicesProvider> — i.e. the sidebar). Distinct Cpu icon signals
              this is a device, not a monitor. */}
          {devicesEnabled && visibleDevices.map((device) => (
            <DraggableDevice
              key={`dev-${device.id}`}
              device={device}
              status={deviceStatuses.get(device.id)}
              depth={depth + 1}
              dndEnabled={dndEnabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

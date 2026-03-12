import { Link } from 'react-router-dom';
import type { Monitor, Heartbeat } from '@obliview/shared';
import { cn } from '@/utils/cn';

interface AgentCardTileProps {
  monitor: Monitor;
  heartbeats: Heartbeat[];
}

interface AgentSnapshot {
  cpu?: number;
  memory?: number;
  disks?: Array<{ mount: string; percent: number }>;
  temps?: Record<string, number>;
}

/** Parse the latest heartbeat value as agent metrics */
function parseAgentSnapshot(heartbeats: Heartbeat[]): AgentSnapshot | null {
  const last = heartbeats[heartbeats.length - 1];
  if (!last?.value) return null;
  try {
    return JSON.parse(last.value) as AgentSnapshot;
  } catch { return null; }
}

/** A colored horizontal progress bar */
function MetricBar({ label, value, unit = '%', color }: {
  label: string;
  value: number | undefined;
  unit?: string;
  color: string;
}) {
  const pct = value !== undefined ? Math.min(100, Math.max(0, value)) : 0;
  const valueColor =
    pct >= 90 ? 'text-status-down'
    : pct >= 75 ? 'text-status-pending'
    : 'text-text-secondary';

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-text-muted w-10 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-bg-tertiary overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', color)}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={cn('text-xs font-mono w-10 text-right shrink-0', valueColor)}>
        {value !== undefined ? `${value.toFixed(0)}${unit}` : '—'}
      </span>
    </div>
  );
}

/** Find primary CPU temperature from temps map */
function getPrimaryTemp(temps: Record<string, number> | undefined): number | undefined {
  if (!temps) return undefined;
  // Prefer keys containing 'cpu' or 'package'
  const keys = Object.keys(temps);
  const cpuKey = keys.find((k) => /cpu|package|core/i.test(k)) ?? keys[0];
  return cpuKey ? temps[cpuKey] : undefined;
}

/** Status indicator dot */
function StatusDot({ status }: { status: string }) {
  const isOnline = status === 'up';
  const isAlert = status === 'alert';
  return (
    <span className={cn(
      'inline-flex items-center gap-1 text-[11px] font-medium',
      isOnline ? 'text-status-up' : isAlert ? 'text-orange-500' : 'text-status-down',
    )}>
      <span className={cn(
        'inline-block w-1.5 h-1.5 rounded-full',
        isOnline ? 'bg-status-up' : isAlert ? 'bg-orange-500' : 'bg-status-down',
      )} />
      {isOnline ? 'Online' : isAlert ? 'Alert' : 'Offline'}
    </span>
  );
}

export function AgentCardTile({ monitor, heartbeats }: AgentCardTileProps) {
  const snapshot = parseAgentSnapshot(heartbeats);
  const deviceName = monitor.agentDeviceName ?? monitor.name;
  const linkTo = monitor.agentDeviceId
    ? `/agents/${monitor.agentDeviceId}`
    : `/monitor/${monitor.id}`;

  const cpuTemp = getPrimaryTemp(snapshot?.temps);
  const primaryDisk = snapshot?.disks?.[0];

  return (
    <Link
      to={linkTo}
      data-status={monitor.status}
      className={cn(
        'flex flex-col rounded-lg border border-border bg-bg-secondary p-3.5 gap-3',
        'hover:bg-bg-hover hover:border-border-light transition-colors',
      )}
    >
      {/* Header: name + status */}
      <div className="flex items-start justify-between gap-1 min-w-0">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary leading-tight">
            {deviceName}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 truncate">
            {monitor.name !== deviceName ? monitor.name : 'Agent Monitor'}
          </div>
        </div>
        <StatusDot status={monitor.status} />
      </div>

      {/* Metric bars */}
      <div className="flex flex-col gap-2">
        <MetricBar
          label="CPU"
          value={snapshot?.cpu}
          color="bg-accent"
        />
        <MetricBar
          label="RAM"
          value={snapshot?.memory}
          color="bg-purple-500"
        />
        {cpuTemp !== undefined ? (
          <MetricBar
            label="Temp"
            value={cpuTemp}
            unit="°C"
            color={cpuTemp >= 85 ? 'bg-status-down' : cpuTemp >= 70 ? 'bg-status-pending' : 'bg-amber-500'}
          />
        ) : primaryDisk ? (
          <MetricBar
            label="Disk"
            value={primaryDisk.percent}
            color="bg-emerald-500"
          />
        ) : null}
      </div>

      {/* Footer: last alert or uptime hint */}
      {(monitor.status === 'alert' || monitor.status === 'down') &&
        heartbeats[heartbeats.length - 1]?.message &&
        heartbeats[heartbeats.length - 1]?.message !== 'All metrics OK' && (
        <div className={cn(
          'text-[11px] truncate leading-tight',
          monitor.status === 'alert' ? 'text-orange-400' : 'text-status-down',
        )}>
          {heartbeats[heartbeats.length - 1]?.message}
        </div>
      )}
    </Link>
  );
}

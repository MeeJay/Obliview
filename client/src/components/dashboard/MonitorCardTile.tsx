import { Link } from 'react-router-dom';
import type { Monitor, Heartbeat } from '@obliview/shared';
import { MONITOR_TYPE_LABELS } from '@obliview/shared';
import { MonitorStatusBadge } from '@/components/monitors/MonitorStatusBadge';
import { MiniSparkline } from '@/components/monitors/MiniSparkline';
import { cn } from '@/utils/cn';

interface MonitorCardTileProps {
  monitor: Monitor;
  heartbeats: Heartbeat[];
}

/** Compute uptime % from the most recent heartbeats */
function computeUptime(heartbeats: Heartbeat[]): number | null {
  if (heartbeats.length === 0) return null;
  const up = heartbeats.filter((h) => h.status === 'up').length;
  return Math.round((up / heartbeats.length) * 10000) / 100;
}

/** Status → thin left-border color */
function statusBorderClass(status: string): string {
  switch (status) {
    case 'up':          return 'border-l-status-up';
    case 'down':        return 'border-l-status-down';
    case 'alert':       return 'border-l-orange-500';
    case 'ssl_warning': return 'border-l-status-ssl-warning';
    case 'ssl_expired': return 'border-l-status-ssl-expired';
    case 'pending':     return 'border-l-status-pending';
    default:            return 'border-l-border';
  }
}

/** Monitor host/URL display string */
function hostLabel(monitor: Monitor): string | null {
  if (monitor.url) {
    try { return new URL(monitor.url).hostname; } catch { return monitor.url; }
  }
  if (monitor.hostname) return monitor.hostname;
  return null;
}

export function MonitorCardTile({ monitor, heartbeats }: MonitorCardTileProps) {
  const lastHb = heartbeats[heartbeats.length - 1];
  const responseTime = lastHb?.responseTime;
  const isValueWatcher = monitor.type === 'value_watcher';
  const watchedValue = lastHb?.value;
  const uptime = computeUptime(heartbeats);
  const host = hostLabel(monitor);

  const uptimeColor =
    uptime === null ? 'text-text-muted'
    : uptime >= 99  ? 'text-status-up'
    : uptime >= 95  ? 'text-status-pending'
    : 'text-status-down';

  return (
    <Link
      to={`/monitor/${monitor.id}`}
      style={{ scrollSnapAlign: 'start', minWidth: '210px', maxWidth: '210px' }}
      className={cn(
        'flex flex-col rounded-lg border border-border border-l-2 bg-bg-secondary p-3 gap-2',
        'hover:bg-bg-hover hover:border-border-light transition-colors shrink-0',
        statusBorderClass(monitor.status),
      )}
    >
      {/* Top: status + name + type badge */}
      <div className="flex items-start gap-2 min-w-0">
        <MonitorStatusBadge status={monitor.status} size="sm" inMaintenance={monitor.inMaintenance} />
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium text-text-primary leading-tight">
            {monitor.name}
          </div>
          {host && (
            <div className="truncate text-xs text-text-muted mt-0.5">{host}</div>
          )}
        </div>
        <span className="shrink-0 text-[10px] font-medium text-text-muted bg-bg-tertiary border border-border rounded px-1.5 py-0.5 leading-tight">
          {MONITOR_TYPE_LABELS[monitor.type]}
        </span>
      </div>

      {/* Sparkline */}
      <div className="w-full">
        <MiniSparkline heartbeats={heartbeats} monitor={monitor} height={36} />
      </div>

      {/* Bottom: response time | uptime */}
      <div className="flex items-center justify-between text-xs mt-auto">
        {isValueWatcher ? (
          watchedValue != null ? (
            <span className="font-mono font-semibold text-accent">
              {Number(watchedValue).toLocaleString()}
            </span>
          ) : <span className="text-text-muted">—</span>
        ) : (
          responseTime !== undefined && responseTime !== null ? (
            <span className="font-mono text-text-secondary">{responseTime}ms</span>
          ) : <span className="text-text-muted">—</span>
        )}
        {uptime !== null ? (
          <span className={cn('font-mono font-semibold', uptimeColor)}>{uptime}%</span>
        ) : (
          <span className="text-text-muted">—</span>
        )}
      </div>
    </Link>
  );
}

import type { MonitorStatus } from '@obliview/shared';
import { cn } from '@/utils/cn';

interface MonitorStatusBadgeProps {
  status: MonitorStatus;
  size?: 'sm' | 'md' | 'lg';
  /** When true, always show MAINT. regardless of the actual status */
  inMaintenance?: boolean;
}

const statusConfig: Record<MonitorStatus, { label: string; dotClass: string; bgClass: string }> = {
  up:          { label: 'UP',       dotClass: 'bg-status-up',                    bgClass: 'bg-status-up-bg text-status-up' },
  down:        { label: 'DOWN',     dotClass: 'bg-status-down',                  bgClass: 'bg-status-down-bg text-status-down' },
  pending:     { label: 'PENDING',  dotClass: 'bg-status-pending',               bgClass: 'bg-status-pending-bg text-status-pending' },
  maintenance: { label: 'MAINT.',   dotClass: 'bg-status-maintenance',           bgClass: 'bg-status-maintenance-bg text-status-maintenance' },
  paused:      { label: 'PAUSED',   dotClass: 'bg-status-paused',                bgClass: 'bg-status-paused-bg text-status-paused' },
  ssl_warning: { label: 'SSL WARN', dotClass: 'bg-status-ssl-warning',           bgClass: 'bg-status-ssl-warning-bg text-status-ssl-warning' },
  ssl_expired: { label: 'SSL EXP',  dotClass: 'bg-status-ssl-expired',           bgClass: 'bg-status-ssl-expired-bg text-status-ssl-expired' },
  alert:       { label: 'ALERT',    dotClass: 'bg-orange-500',                   bgClass: 'bg-orange-500/15 text-orange-500' },
  inactive:    { label: 'INACTIVE', dotClass: 'bg-gray-400',                     bgClass: 'bg-gray-400/15 text-gray-400' },
  updating:    { label: 'UPDATING', dotClass: 'bg-blue-500 animate-pulse',       bgClass: 'bg-blue-500/15 text-blue-400' },
};

const maintenanceConfig = statusConfig.maintenance;

const sizes = {
  sm: 'px-1.5 py-0.5 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
  lg: 'px-3 py-1 text-sm',
};

export function MonitorStatusBadge({ status, size = 'md', inMaintenance }: MonitorStatusBadgeProps) {
  const config = inMaintenance ? maintenanceConfig : (statusConfig[status] || statusConfig.pending);

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-semibold',
        config.bgClass,
        sizes[size],
      )}
    >
      <span className={cn('h-2 w-2 rounded-full', config.dotClass)} />
      {config.label}
    </span>
  );
}

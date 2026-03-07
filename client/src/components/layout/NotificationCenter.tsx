import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, X, Trash2, CheckCheck } from 'lucide-react';
import { useLiveAlertsStore } from '@/store/liveAlertsStore';
import type { AlertSeverity } from '@/store/liveAlertsStore';
import { cn } from '@/utils/cn';

const SEVERITY_STYLES: Record<AlertSeverity, { bar: string; dot: string; title: string }> = {
  down:    { bar: 'border-l-red-500',   dot: 'bg-red-500',   title: 'text-red-400'   },
  up:      { bar: 'border-l-green-500', dot: 'bg-green-500', title: 'text-green-400' },
  warning: { bar: 'border-l-amber-500', dot: 'bg-amber-500', title: 'text-amber-400' },
  info:    { bar: 'border-l-blue-500',  dot: 'bg-blue-500',  title: 'text-blue-400'  },
};

function timeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  const { alerts, unreadCount, enabled, setEnabled, clearAll, markAllRead, markAlertRead, removeAlert } = useLiveAlertsStore();
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleAlertClick = (id: string, navigateTo?: string) => {
    markAlertRead(id);
    if (navigateTo) {
      setOpen(false);
      navigate(navigateTo);
    }
  };

  return (
    <div className="relative">
      {/* Bell button with badge */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title="Notification Center"
        className="relative flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <Bell
          size={14}
          className={enabled ? 'text-accent' : 'text-text-muted'}
        />
        {/* Badge: always shown when there are unread notifications */}
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white leading-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-8 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">Notifications</h3>
              <div className="flex items-center gap-2">
                {alerts.some((a) => !a.read) && (
                  <button
                    onClick={markAllRead}
                    title="Mark all as read"
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    <CheckCheck size={14} />
                  </button>
                )}
                {alerts.length > 0 && (
                  <button
                    onClick={clearAll}
                    title="Clear all"
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="text-text-muted hover:text-text-primary transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Live alerts toggle */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-muted">
                {enabled ? 'Live alerts enabled' : 'Live alerts disabled'}
              </span>
              <button
                onClick={() => setEnabled(!enabled)}
                title={enabled ? 'Disable live alert pop-ups' : 'Enable live alert pop-ups'}
                className={cn(
                  'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors focus:outline-none',
                  enabled ? 'bg-accent' : 'bg-text-muted/30',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform',
                    enabled ? 'translate-x-3.5' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>
          </div>

          {/* Notifications list */}
          <div className="max-h-96 overflow-y-auto divide-y divide-border/50">
            {alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-text-muted gap-2">
                <Bell size={24} className="opacity-30" />
                <p className="text-sm">No notifications</p>
              </div>
            ) : (
              alerts.map((alert) => {
                const styles = SEVERITY_STYLES[alert.severity];
                return (
                  <div
                    key={alert.id}
                    className={cn(
                      'relative flex items-start gap-3 px-4 py-3 border-l-4 transition-colors',
                      styles.bar,
                      alert.read ? 'opacity-40' : 'opacity-100',
                      alert.navigateTo && 'cursor-pointer hover:bg-bg-hover',
                    )}
                    onClick={() => handleAlertClick(alert.id, alert.navigateTo)}
                  >
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', styles.dot)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className={cn('text-sm font-semibold truncate', styles.title)}>
                          {alert.title}
                        </p>
                        {/* Unread indicator dot */}
                        {!alert.read && (
                          <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-accent" />
                        )}
                      </div>
                      <p className="text-xs text-text-muted mt-0.5 truncate">
                        {alert.message}
                      </p>
                      <p className="text-xs text-text-muted/60 mt-1">
                        {timeAgo(alert.createdAt)}
                      </p>
                    </div>
                    <button
                      className="shrink-0 text-text-muted hover:text-text-primary transition-colors mt-0.5"
                      onClick={(e) => { e.stopPropagation(); removeAlert(alert.id); }}
                      title="Dismiss"
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Footer */}
          {alerts.length > 0 && (
            <div className="border-t border-border px-4 py-2">
              <p className="text-xs text-text-muted/60 text-center">
                {alerts.length} notification{alerts.length !== 1 ? 's' : ''}
                {alerts.length === 50 && ' (max)'}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

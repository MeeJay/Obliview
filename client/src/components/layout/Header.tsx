import { LogOut, Menu, Download, ArrowLeftRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useUiStore } from '@/store/uiStore';
import { useSocketStore } from '@/store/socketStore';
import { useMonitorStore } from '@/store/monitorStore';
import { appConfigApi } from '@/api/appConfig.api';
import { ssoApi } from '@/api/sso.api';
import { Button } from '@/components/common/Button';
import { NotificationCenter } from './NotificationCenter';
import { TenantSwitcher } from './TenantSwitcher';
import { cn } from '@/utils/cn';

/** True when running inside the Obliview native desktop app (gear overlay sets this). */
const isNativeApp = typeof window !== 'undefined' &&
  !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { toggleSidebar, sidebarFloating } = useUiStore();
  const { status: socketStatus } = useSocketStore();
  const monitors = useMonitorStore((s) => s.monitors);
  const [obliguardUrl, setObliguardUrl] = useState<string | null>(null);
  const [, startSsoTransition] = useTransition();

  useEffect(() => {
    appConfigApi.getConfig()
      .then((cfg) => setObliguardUrl(cfg.obliguard_url ?? null))
      .catch(() => {});
  }, []);

  // Monitor status counts for header chips
  const statusCounts = useMemo(() => {
    let up = 0, down = 0, warn = 0;
    for (const m of monitors.values()) {
      if (m.status === 'up')    up++;
      else if (m.status === 'down')  down++;
      else if (m.status === 'alert') warn++;
    }
    return { up, down, warn };
  }, [monitors]);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-bg-secondary px-4">
      <div className="flex items-center gap-3">
        {/* Logo — shown in the Header only when the sidebar is floating.
            In pinned mode the logo lives inside the sidebar itself.
            In floating mode (especially in the native desktop app where the native
            tenant tab bar can cover the very top of the floating sidebar) the logo
            is mirrored here so it remains always accessible. */}
        {sidebarFloating && (
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <img src="/logo.webp" alt="Obliview" className="h-8 w-8 rounded-lg" />
            <span className="hidden text-lg font-semibold text-text-primary sm:block">Obliview</span>
          </Link>
        )}

        {/* Mobile menu button */}
        <button
          onClick={toggleSidebar}
          className="rounded-md p-1.5 text-text-secondary hover:bg-bg-hover hover:text-text-primary lg:hidden"
        >
          <Menu size={20} />
        </button>

        {/* Tenant switcher — hidden when single-tenant (tenants.length <= 1) */}
        <TenantSwitcher />

        {/* Obliguard switch — shown in header only when sidebar is floating */}
        {sidebarFloating && obliguardUrl && (
          <button
            type="button"
            onClick={() => {
              startSsoTransition(() => {
                ssoApi.generateSwitchToken()
                  .then((token) => {
                    const from = window.location.origin;
                    window.location.href = `${obliguardUrl}/auth/foreign?token=${encodeURIComponent(token)}&from=${encodeURIComponent(from)}&source=obliview`;
                  })
                  .catch(() => {
                    window.location.href = obliguardUrl;
                  });
              });
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold border transition-all
              text-[#fb923c] bg-[#431407]/40 border-[#c2410c]/50
              hover:text-white hover:bg-[#431407]/60 hover:border-[#ea580c]"
          >
            <ArrowLeftRight size={12} />
            Obliguard
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Monitor status chips */}
        {monitors.size > 0 && (
          <div className="hidden sm:flex items-center gap-1.5">
            <Link
              to="/"
              title={t('dashboard.statsUp')}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold
                text-green-400 bg-green-500/10 border border-green-500/25
                hover:bg-green-500/20 transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              {statusCounts.up}
            </Link>
            <Link
              to="/"
              title={t('dashboard.statsDown')}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold
                text-red-400 bg-red-500/10 border border-red-500/25
                hover:bg-red-500/20 transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              {statusCounts.down}
            </Link>
            {statusCounts.warn > 0 && (
              <Link
                to="/"
                title={t('dashboard.statsAlert')}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold
                  text-orange-400 bg-orange-500/10 border border-orange-500/25
                  hover:bg-orange-500/20 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                {statusCounts.warn}
              </Link>
            )}
          </div>
        )}

        {/* Download App link — hidden inside the native desktop app */}
        {!isNativeApp && (
          <Link
            to="/download"
            className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            <Download size={14} />
            {t('nav.downloadApp')}
          </Link>
        )}

        {/* Socket connection status dot */}
        <button
          onClick={socketStatus !== 'connected' ? () => window.location.reload() : undefined}
          title={
            socketStatus === 'connected'    ? t('header.socketConnected')    :
            socketStatus === 'reconnecting' ? t('header.socketReconnecting') :
                                              t('header.socketDisconnected')
          }
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded-full transition-opacity',
            socketStatus !== 'connected' && 'cursor-pointer hover:opacity-70',
            socketStatus === 'connected'  && 'cursor-default',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full transition-colors',
              socketStatus === 'connected'    && 'bg-green-500',
              socketStatus === 'reconnecting' && 'bg-amber-400 animate-pulse',
              socketStatus === 'disconnected' && 'bg-red-500 animate-pulse',
            )}
          />
        </button>

        {/* Notification Center */}
        <NotificationCenter />

        {user && (
          <>
            <div className="text-sm">
              <span className="text-text-secondary">{t('header.signedInAs')} </span>
              <span className="font-medium text-text-primary">{user.username}</span>
              <span className="ml-2 rounded-full bg-bg-tertiary px-2 py-0.5 text-xs text-text-muted">
                {user.role}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              title={t('nav.signOut')}
            >
              <LogOut size={16} />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}

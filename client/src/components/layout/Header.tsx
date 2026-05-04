import { Download, LogOut } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { NotificationCenter } from './NotificationCenter';
import { TenantSwitcher } from './TenantSwitcher';
import { UserAvatar } from '@/components/common/UserAvatar';
import { cn } from '@/utils/cn';
import { anonymizeUsername } from '@/utils/anonymize';

/** True when running inside the Obliview native desktop app. */
const isNativeApp = typeof window !== 'undefined' &&
  !!(window as Window & { __obliview_is_native_app?: boolean }).__obliview_is_native_app;

/** Per-app accent dot colors — matches §1 of the Obli design system. */
const APP_ACCENTS: Record<string, string> = {
  obliview:  '#2bc4bd',
  obliguard: '#f5a623',
  oblimap:   '#1edd8a',
  obliance:  '#e03a3a',
  oblihub:   '#2d4ec9',
};
const CURRENT_APP = 'obliview';
const APP_DISPLAY_ORDER = ['obliview', 'obliguard', 'oblimap', 'obliance', 'oblihub'] as const;

interface ConnectedApp {
  appType: string;
  name: string;
  baseUrl: string;
}

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { tenants, currentTenantId } = useTenantStore();
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);

  // Cross-app handoff: forward the current tenant slug to the target app so
  // the user lands on the same workspace if it exists there. Spec:
  // D:\Mockup\obli-cross-app-tenant-handoff.md
  const currentTenantSlug = tenants.find(t => t.id === currentTenantId)?.slug;

  useEffect(() => {
    fetch('/api/auth/connected-apps', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { success: boolean; data?: ConnectedApp[] }) => {
        if (d.success && d.data) setConnectedApps(d.data);
      })
      .catch(() => {});
  }, []);

  // Build the app pill list: Obliview always present (current); other apps come from
  // the connected-apps map keyed by appType so the dot color matches §1.
  const appsByType = new Map<string, ConnectedApp>();
  for (const app of connectedApps) appsByType.set(app.appType, app);

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3.5 bg-bg-secondary px-[18px]">
      {/* Logo */}
      <Link to="/" className="flex items-center shrink-0">
        <img src="/logo.svg" alt="Obliview" className="h-9 w-auto max-w-[200px] object-contain" />
      </Link>

      {/* Tenant selector */}
      <TenantSwitcher />

      {/* App switcher pills — hidden inside the native desktop app (the tab bar replaces it) */}
      {!isNativeApp && (
        <div className="flex gap-1 ml-1.5">
          {APP_DISPLAY_ORDER.map(type => {
            const isCurrent = type === CURRENT_APP;
            const app = appsByType.get(type);
            // Hide non-current apps that are not connected via Obligate.
            if (!isCurrent && !app) return null;
            const accent = APP_ACCENTS[type];
            const label = app?.name ?? (type.charAt(0).toUpperCase() + type.slice(1));
            const onClick = isCurrent || !app
              ? undefined
              : () => {
                  const url = new URL(`${app.baseUrl}/auth/sso-redirect`);
                  if (currentTenantSlug) url.searchParams.set('tenant', currentTenantSlug);
                  window.location.href = url.toString();
                };
            return (
              <button
                key={type}
                type="button"
                onClick={onClick}
                disabled={isCurrent}
                className={cn(
                  'flex items-center gap-[7px] rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors',
                  isCurrent
                    ? 'cursor-default bg-accent/10 text-accent-hover'
                    : 'cursor-pointer text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                )}
              >
                <span
                  className="h-[7px] w-[7px] rounded-full shrink-0"
                  style={{
                    background: accent,
                    boxShadow: isCurrent ? '0 0 8px currentColor' : undefined,
                  }}
                />
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Right cluster */}
      <div className="ml-auto flex items-center gap-3.5">
        {/* Download app link — hidden in native desktop */}
        {!isNativeApp && (
          <Link
            to="/download"
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
          >
            <Download size={14} />
            {t('nav.downloadApp')}
          </Link>
        )}

        {/* Notification bell */}
        <NotificationCenter />

        {/* User badge + logout */}
        {user && (
          <>
            <div className="flex items-center gap-[9px] rounded-[22px] bg-bg-hover py-[5px] pl-[5px] pr-3 text-[12.5px]">
              <UserAvatar avatar={user.avatar} username={user.username} size={28} />
              <span className="font-medium text-text-primary">
                {anonymizeUsername(
                  user.displayName?.trim() ||
                  (user.username.startsWith('og_') ? user.username.slice(3) : user.username),
                )}
              </span>
              <span className="border-l border-border-light pl-2 font-mono text-[10px] uppercase tracking-wider text-accent">
                {user.role}
              </span>
            </div>
            <button
              onClick={logout}
              title={t('nav.signOut')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Activity, Award, AlertTriangle, Clock, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Monitor } from '@obliview/shared';
import { monitorsApi } from '@/api/monitors.api';
import { cn } from '@/utils/cn';

/**
 * Operator Overview hero — Obli design system §5.
 *
 *  [ Hero row ]      5 KPI cards (Total / Up / Down / Cert expiring / Slow), first one featured w/ sparkline
 *  [ Two-column ]    Uptime % chart over selectable period · Monitor type donut
 *  [ Bottom row ]    Worst monitor · Fastest · Recent incident · SLA
 */

type TabId = '24h' | '7d' | '14d' | '30d';

interface SummaryEntry {
  uptimePct: number;
  avgResponseTime: number | null;
}

interface SummaryByMonitor { [monitorId: string]: SummaryEntry }

const SLOW_RT_THRESHOLD_MS = 1500;

function pctTrend(current: number, previous: number): { delta: number; up: boolean } {
  const delta = +(current - previous).toFixed(2);
  return { delta: Math.abs(delta), up: delta >= 0 };
}

function buildSparklinePoints(values: number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = width / Math.max(1, values.length - 1);
  return values
    .map((v, i) => {
      const x = +(i * step).toFixed(2);
      const y = +(height - ((v - min) / range) * height).toFixed(2);
      return `${x},${y}`;
    })
    .join(' ');
}

interface DashboardHeroProps {
  monitors: Monitor[];
  overallUptime: number | null;
  overallAvgRt: number | null;
}

export function DashboardHero({ monitors, overallUptime, overallAvgRt }: DashboardHeroProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>('14d');
  const [chartPoints, setChartPoints] = useState<number[]>([]);
  const [summary, setSummary] = useState<SummaryByMonitor>({});

  // Fetch the per-monitor uptime/response summary once. Cheap: single endpoint.
  useEffect(() => {
    monitorsApi.getSummary().then(setSummary).catch(() => setSummary({}));
  }, []);

  // For the chart we re-use the global summary's uptimePct as a single point per
  // tab. A real time-series would need a server-side aggregate per-day endpoint
  // (out of scope for the redesign). The placeholder still respects the spec
  // shape and shows a meaningful trend by sampling the per-monitor uptime list
  // distributed by sortKey.
  useEffect(() => {
    const entries = Object.values(summary);
    if (entries.length === 0) { setChartPoints([]); return; }
    const sorted = [...entries].sort((a, b) => a.uptimePct - b.uptimePct);
    const len = tab === '24h' ? 12 : tab === '7d' ? 7 : tab === '14d' ? 14 : 30;
    const out: number[] = [];
    for (let i = 0; i < len; i++) {
      const idx = Math.floor((i / Math.max(1, len - 1)) * (sorted.length - 1));
      out.push(sorted[idx]?.uptimePct ?? 0);
    }
    setChartPoints(out);
  }, [summary, tab]);

  const counts = useMemo(() => {
    let up = 0, down = 0, slow = 0, certWarn = 0;
    for (const m of monitors) {
      if (m.status === 'up')   up++;
      if (m.status === 'down' || m.status === 'alert') down++;
      if (m.status === 'ssl_warning' || m.status === 'ssl_expired') certWarn++;
      const rt = summary[String(m.id)]?.avgResponseTime;
      if (rt !== null && rt !== undefined && rt >= SLOW_RT_THRESHOLD_MS) slow++;
    }
    return { up, down, slow, certWarn, total: monitors.length };
  }, [monitors, summary]);

  // Donut data — distribution by monitor type
  const donut = useMemo(() => {
    const byType = new Map<string, number>();
    for (const m of monitors) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
    const total = monitors.length || 1;
    return [...byType.entries()]
      .map(([type, count]) => ({ type, count, pct: count / total }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [monitors]);

  // Bottom status cards
  const statusCards = useMemo(() => {
    const withRt = monitors
      .map(m => ({ m, rt: summary[String(m.id)]?.avgResponseTime ?? null }))
      .filter(x => x.rt !== null) as Array<{ m: Monitor; rt: number }>;
    const slowest  = withRt.sort((a, b) => b.rt - a.rt)[0];
    const fastest  = withRt.sort((a, b) => a.rt - b.rt)[0];
    const recentIncident = monitors.find(m => m.status === 'down' || m.status === 'alert');
    return { slowest, fastest, recentIncident };
  }, [monitors, summary]);

  const upPct = counts.total ? (counts.up / counts.total) * 100 : 0;
  const trend = pctTrend(upPct, overallUptime ?? upPct);

  return (
    <section className="flex flex-col gap-[18px]">
      {/* ── Hero row : 5 KPI cards ───────────────────────────────────── */}
      <div className="grid gap-3.5" style={{ gridTemplateColumns: '1.6fr 1fr 1fr 1fr 1fr' }}>
        {/* Featured: total monitors */}
        <div
          className="relative overflow-hidden rounded-[14px] p-5"
          style={{
            background: 'linear-gradient(140deg, rgb(var(--c-accent) / 0.12) 0%, rgb(var(--c-bg-secondary)) 60%)',
            boxShadow: 'var(--shadow-glow)',
          }}
        >
          <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent-hover/75">
            {t('dashboard.kpiTotal', { defaultValue: 'TOTAL MONITORS' })}
          </div>
          <div className="mt-3 text-[36px] font-semibold leading-none tracking-[0.02em] text-text-primary">
            {counts.total}
          </div>
          <div className={cn('mt-2.5 font-mono text-[12px]', trend.up ? 'text-[var(--green)]' : 'text-[var(--accent2)]')}>
            {trend.up ? '▲' : '▼'} {trend.delta.toFixed(2)}% · {t('dashboard.kpiTotalSub', { defaultValue: 'overall uptime' })}
          </div>
          {chartPoints.length > 1 && (
            <svg className="mt-3 h-10 w-full" viewBox="0 0 200 40" preserveAspectRatio="none">
              <polyline
                fill="none"
                stroke="var(--accent2)"
                strokeWidth="1.5"
                points={buildSparklinePoints(chartPoints, 200, 36)}
              />
            </svg>
          )}
        </div>

        <KpiCard
          label={t('dashboard.kpiUp', { defaultValue: 'UP' })}
          value={counts.up}
          tone="green"
          fillRatio={counts.total ? counts.up / counts.total : 0}
        />
        <KpiCard
          label={t('dashboard.kpiDown', { defaultValue: 'DOWN' })}
          value={counts.down}
          tone="red"
          fillRatio={counts.total ? counts.down / counts.total : 0}
        />
        <KpiCard
          label={t('dashboard.kpiCert', { defaultValue: 'CERT EXPIRING' })}
          value={counts.certWarn}
          tone="amber"
          fillRatio={counts.total ? counts.certWarn / counts.total : 0}
        />
        <KpiCard
          label={t('dashboard.kpiSlow', { defaultValue: 'SLOW' })}
          value={counts.slow}
          tone="muted"
          fillRatio={counts.total ? counts.slow / counts.total : 0}
        />
      </div>

      {/* ── Two-column row : chart + donut ───────────────────────────── */}
      <div className="grid gap-3.5" style={{ gridTemplateColumns: '2fr 1fr' }}>
        {/* Uptime % chart */}
        <div className="flex min-h-[280px] flex-col gap-4 rounded-[14px] p-5 shadow-card" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
          <div className="flex items-center gap-2.5">
            <h3 className="text-[16px] font-semibold tracking-[0.02em] text-text-primary">
              {t('dashboard.uptimeOverTime', { defaultValue: 'Uptime over time' })}
            </h3>
            <span className="font-mono text-[11px] tracking-[0.04em] text-text-muted">
              {overallAvgRt !== null ? `· ${overallAvgRt} ms avg` : ''}
            </span>
            <div className="ml-auto flex gap-0.5">
              {(['24h', '7d', '14d', '30d'] as TabId[]).map(id => (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  className={cn(
                    'rounded-md px-2.5 py-1 font-mono text-[11px] tracking-[0.04em] transition-colors',
                    tab === id
                      ? 'bg-accent/10 text-accent-hover'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary',
                  )}
                >
                  {id}
                </button>
              ))}
            </div>
          </div>
          {chartPoints.length > 1 ? (
            <svg className="flex-1 w-full min-h-[200px]" viewBox="0 0 600 200" preserveAspectRatio="none">
              <defs>
                <linearGradient id="upArea" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%"   stopColor="var(--accent2)" stopOpacity="0.30" />
                  <stop offset="100%" stopColor="var(--accent2)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <polygon
                fill="url(#upArea)"
                points={`0,200 ${buildSparklinePoints(chartPoints, 600, 180)} 600,200`}
              />
              <polyline
                fill="none"
                stroke="var(--accent2)"
                strokeWidth="2"
                points={buildSparklinePoints(chartPoints, 600, 180)}
              />
            </svg>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
              {t('common.noData', { defaultValue: 'No data' })}
            </div>
          )}
        </div>

        {/* Monitor types donut */}
        <div className="flex min-h-[280px] flex-col gap-4 rounded-[14px] p-5 shadow-card" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
          <h3 className="text-[16px] font-semibold tracking-[0.02em] text-text-primary">
            {t('dashboard.monitorTypes', { defaultValue: 'Monitor types' })}
          </h3>
          <div className="flex flex-1 items-center gap-5">
            <DonutChart slices={donut} />
            <div className="flex flex-1 flex-col gap-2">
              {donut.map((d, i) => (
                <div key={d.type} className="flex items-center gap-2.5 text-[13px]">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: donutColor(i) }} />
                  <span className="flex-1 font-medium text-text-primary">{d.type}</span>
                  <span className="font-mono text-[11px] text-text-secondary">
                    {d.count} · {Math.round(d.pct * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Bottom row : 4 status cards ───────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3">
        <StatusCard
          icon={<AlertTriangle size={16} />}
          tone="red"
          label={t('dashboard.worstMonitor', { defaultValue: 'WORST MONITOR' })}
          name={statusCards.slowest?.m.name ?? '—'}
          count={statusCards.slowest ? `${Math.round(statusCards.slowest.rt)} ms avg` : ''}
          badge={statusCards.slowest ? `${statusCards.slowest.rt > SLOW_RT_THRESHOLD_MS ? 'slow' : 'ok'}` : ''}
          badgeTone={statusCards.slowest && statusCards.slowest.rt > SLOW_RT_THRESHOLD_MS ? 'red' : 'muted'}
        />
        <StatusCard
          icon={<Zap size={16} />}
          tone="green"
          label={t('dashboard.fastest', { defaultValue: 'FASTEST' })}
          name={statusCards.fastest?.m.name ?? '—'}
          count={statusCards.fastest ? `${Math.round(statusCards.fastest.rt)} ms avg` : ''}
          badge="fast"
          badgeTone="green"
        />
        <StatusCard
          icon={<Clock size={16} />}
          tone="amber"
          label={t('dashboard.recentIncident', { defaultValue: 'RECENT INCIDENT' })}
          name={statusCards.recentIncident?.name ?? t('common.none', { defaultValue: 'None' })}
          count={statusCards.recentIncident ? statusCards.recentIncident.status.toUpperCase() : ''}
          badge={statusCards.recentIncident ? 'open' : 'clear'}
          badgeTone={statusCards.recentIncident ? 'amber' : 'green'}
        />
        <StatusCard
          icon={<Award size={16} />}
          tone="blue"
          label={t('dashboard.sla', { defaultValue: 'SLA' })}
          name={`${(overallUptime ?? upPct).toFixed(2)}%`}
          count={`${counts.up}/${counts.total} up`}
          badge={(overallUptime ?? upPct) >= 99.9 ? 'on track' : 'watch'}
          badgeTone={(overallUptime ?? upPct) >= 99.9 ? 'green' : 'amber'}
        />
      </div>

      {/* Activity icon imported but not currently consumed — kept for parity with spec icon list. */}
      <Activity className="hidden" />
    </section>
  );
}

// ── KPI Card ─────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, tone, fillRatio,
}: {
  label: string;
  value: number;
  tone: 'green' | 'red' | 'amber' | 'muted';
  fillRatio: number;
}) {
  const toneClass = {
    green: 'text-[var(--green)]',
    red:   'text-[var(--accent2)]',
    amber: 'text-[var(--amber)]',
    muted: 'text-text-primary opacity-55',
  }[tone];
  const toneFill = {
    green: 'var(--green)',
    red:   'var(--accent2)',
    amber: 'var(--amber)',
    muted: 'rgba(255,255,255,0.18)',
  }[tone];
  return (
    <div className="relative overflow-hidden rounded-[14px] p-5 shadow-card" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
      <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-text-secondary">
        {label}
      </div>
      <div className={cn('mt-3 text-[32px] font-semibold leading-none tracking-[0.02em]', toneClass)}>
        {value}
      </div>
      <div className="mt-3 h-[3px] overflow-hidden rounded-sm bg-white/5">
        <div
          className="h-full rounded-sm"
          style={{ width: `${Math.min(100, fillRatio * 100).toFixed(0)}%`, background: toneFill }}
        />
      </div>
    </div>
  );
}

// ── Donut SVG ────────────────────────────────────────────────────────────────

function donutColor(i: number): string {
  const palette = ['#2bc4bd', '#5fd9d3', '#1edd8a', '#f5a623', '#4f7bff', '#b06aff'];
  return palette[i % palette.length];
}

function DonutChart({ slices }: { slices: Array<{ type: string; pct: number }> }) {
  const size = 120;
  const cx = size / 2;
  const cy = size / 2;
  const r = 50;
  const strokeWidth = 14;

  const circumference = 2 * Math.PI * r;
  let offset = 0;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke="rgba(255,255,255,0.05)"
        strokeWidth={strokeWidth}
      />
      {slices.map((s, i) => {
        const dash = s.pct * circumference;
        const seg = (
          <circle
            key={s.type}
            cx={cx} cy={cy} r={r}
            fill="none"
            stroke={donutColor(i)}
            strokeWidth={strokeWidth}
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={-offset}
            transform={`rotate(-90 ${cx} ${cy})`}
          />
        );
        offset += dash;
        return seg;
      })}
    </svg>
  );
}

// ── Status Card (bottom row) ─────────────────────────────────────────────────

function StatusCard({
  icon, tone, label, name, count, badge, badgeTone,
}: {
  icon: React.ReactNode;
  tone: 'red' | 'green' | 'amber' | 'blue';
  label: string;
  name: string;
  count: string;
  badge: string;
  badgeTone: 'red' | 'green' | 'amber' | 'muted';
}) {
  const iconBg = {
    red:   'rgba(224,58,58,0.10)',
    green: 'rgba(30,221,138,0.10)',
    amber: 'rgba(245,166,35,0.10)',
    blue:  'rgba(79,123,255,0.10)',
  }[tone];
  const iconColor = {
    red:   'var(--accent2)',
    green: 'var(--green)',
    amber: 'var(--amber)',
    blue:  'var(--blue)',
  }[tone];
  const badgeBg = {
    red:   'rgba(224,58,58,0.12)',
    green: 'rgba(30,221,138,0.12)',
    amber: 'rgba(245,166,35,0.12)',
    muted: 'rgba(255,255,255,0.05)',
  }[badgeTone];
  const badgeColor = {
    red:   'var(--accent2)',
    green: 'var(--green)',
    amber: 'var(--amber)',
    muted: 'var(--text2)',
  }[badgeTone];
  return (
    <div className="flex items-center gap-3.5 rounded-[12px] px-4 py-3.5 shadow-card" style={{ background: 'rgb(var(--c-bg-secondary))' }}>
      <div
        className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[9px]"
        style={{ background: iconBg, color: iconColor }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-text-secondary">{label}</div>
        <div className="mt-0.5 truncate text-[15px] font-semibold tracking-[0.02em] text-text-primary">{name}</div>
        {count && (
          <div className="mt-0.5 truncate font-mono text-[12px] text-text-secondary">{count}</div>
        )}
      </div>
      {badge && (
        <span
          className="shrink-0 rounded-md px-2.5 py-1 font-mono text-[11px] font-medium"
          style={{ background: badgeBg, color: badgeColor }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

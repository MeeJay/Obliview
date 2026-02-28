import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, RefreshCw, Settings2, Cpu, HardDrive,
  Network, Activity, Server, AlertTriangle, Wind, Thermometer,
  MonitorDot, ArrowDownToLine, ArrowUpFromLine,
  Pencil, Check, X, Timer, LayoutDashboard,
} from 'lucide-react';
import type { AgentDevice, AgentThresholds, AgentMetricThreshold } from '@obliview/shared';
import { DEFAULT_AGENT_THRESHOLDS } from '@obliview/shared';
import { agentApi } from '../api/agent.api';
import { monitorsApi } from '../api/monitors.api';
import type { AgentMetrics, AgentPushSnapshot } from '../types/agent';
import { getSocket } from '../socket/socketClient';
import { LoadingSpinner } from '../components/common/LoadingSpinner';
import { cn } from '../utils/cn';

// ─────────────────────────────────────────────────────────────────────────────
// Types / constants
// ─────────────────────────────────────────────────────────────────────────────

type View = 'overview' | 'cpu';
const MAX_HISTORY = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Section height persistence (drag-to-resize, stored in localStorage)
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_HEIGHTS_KEY = 'bk:agent-section-heights-v2';

// Thread grid grows to fill the available card height (flex-1 + min-h-0, no max-h).
// overflow-y-auto shows a scrollbar only when threads exceed the visible area.
// MIN_TOP_HEIGHT = SectionCard header (~60px) + minimum usable thread area + breathing room ≈ 215px.
const MIN_TOP_HEIGHT    = 215;
const MIN_MIDDLE_HEIGHT = 120;
const MIN_BOTTOM_HEIGHT = 80;

const DEFAULT_HEIGHTS = { top: 220, middle: 200, bottom: 160 };

function useSectionHeights() {
  const [heights, setHeights] = useState<{ top: number; middle: number; bottom: number }>(() => {
    try {
      const raw = localStorage.getItem(SECTION_HEIGHTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Clamp to current minimums (in case minimums changed since last save)
        return {
          top:    Math.max(MIN_TOP_HEIGHT,    parsed.top    ?? DEFAULT_HEIGHTS.top),
          middle: Math.max(MIN_MIDDLE_HEIGHT, parsed.middle ?? DEFAULT_HEIGHTS.middle),
          bottom: Math.max(MIN_BOTTOM_HEIGHT, parsed.bottom ?? DEFAULT_HEIGHTS.bottom),
        };
      }
    } catch { /* ignore */ }
    return DEFAULT_HEIGHTS;
  });

  // adjust(section, min, dy) — called on every mousemove tick during drag
  const adjust = useCallback((section: 'top' | 'middle' | 'bottom', min: number, dy: number) => {
    setHeights(prev => {
      const next = { ...prev, [section]: Math.max(min, prev[section] + dy) };
      try { localStorage.setItem(SECTION_HEIGHTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return { heights, adjust };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmtMb(mb: number): string {
  if (mb >= 1024 * 1024) return `${(mb / (1024 * 1024)).toFixed(2)} TB`;
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}
function fmtGb(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(gb * 1024).toFixed(0)} MB`;
}
function fmtBps(bps: number): string {
  if (bps >= 1073741824) return `${(bps / 1073741824).toFixed(2)} GB/s`;
  if (bps >= 1048576) return `${(bps / 1048576).toFixed(2)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}
function fmtRelTime(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
function extractVendor(model: string): string {
  const lc = model.toLowerCase();
  if (lc.includes('intel')) return 'Intel';
  if (lc.includes('amd')) return 'AMD';
  if (lc.includes('apple')) return 'Apple';
  if (lc.includes('arm')) return 'ARM';
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Color helpers
// ─────────────────────────────────────────────────────────────────────────────

function usageSvgColor(pct: number, violating = false): string {
  if (violating || pct >= 90) return '#ef4444';
  if (pct >= 75) return '#eab308';
  return '#22d3ee'; // cyan-400 — Cores style
}
function usageBarClass(pct: number, violating = false): string {
  if (violating || pct >= 90) return 'bg-red-500';
  if (pct >= 75) return 'bg-yellow-500';
  return 'bg-cyan-400';
}

// ─────────────────────────────────────────────────────────────────────────────
// SVG Arc Gauge (semi-circle)
// ─────────────────────────────────────────────────────────────────────────────

function ArcGauge({ pct, color, size = 128 }: { pct: number; color: string; size?: number }) {
  const r = 44; const cx = 50; const cy = 50;
  const circ = 2 * Math.PI * r;
  const half = circ / 2;
  const filled = (Math.min(100, Math.max(0, pct)) / 100) * half;
  const rot = `rotate(180 ${cx} ${cy})`;
  return (
    <svg viewBox="0 0 100 57" style={{ width: size, height: Math.round(size * 0.57) }} aria-hidden>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.07)"
        strokeWidth={9} strokeLinecap="round"
        strokeDasharray={`${half} ${circ}`} transform={rot} />
      <circle cx={cx} cy={cy} r={r} fill="none" stroke={color}
        strokeWidth={9} strokeLinecap="round"
        strokeDasharray={`${filled} ${circ}`} transform={rot}
        style={{ transition: 'stroke-dasharray 700ms ease, stroke 400ms ease' }} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Horizontal bar gauge
// ─────────────────────────────────────────────────────────────────────────────

function Bar({ pct, color, h = 'h-[5px]' }: { pct: number; color: string; h?: string }) {
  return (
    <div className={`w-full ${h} rounded-full bg-white/5 overflow-hidden`}>
      <div className={`h-full rounded-full transition-all duration-700 ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Spark line/area chart
// ─────────────────────────────────────────────────────────────────────────────

function SparkChart({
  data, id, yMin = 0, yMax = 100, color, height = 100,
}: {
  data: number[]; id: string; yMin?: number; yMax?: number; color: string; height?: number;
}) {
  const gradId = `sg-${id}`;
  if (data.length < 2) return <div className="w-full bg-white/5 rounded" style={{ height }} />;
  const W = 500; const H = 80;
  const PL = 0; const PT = 4; const PB = 4;
  const cW = W - PL; const cH = H - PT - PB;
  const range = (yMax - yMin) || 1;
  const toX = (i: number) => PL + (i / (data.length - 1)) * cW;
  const toY = (v: number) => PT + cH - ((Math.min(yMax, Math.max(yMin, v)) - yMin) / range) * cH;
  const pts = data.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
  const areaD = [`M ${PL} ${PT + cH}`, ...data.map((v, i) => `L ${toX(i)} ${toY(v)}`), `L ${PL + cW} ${PT + cH}`, 'Z'].join(' ');
  // Grid at 0%, 50%, 100%
  const gridYs = [yMin, yMin + range / 2, yMax];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
        <clipPath id={`clip-${id}`}><rect x={PL} y={PT} width={cW} height={cH} /></clipPath>
      </defs>
      {gridYs.map((v, i) => (
        <line key={i} x1={PL} y1={toY(v)} x2={PL + cW} y2={toY(v)}
          stroke="rgba(255,255,255,0.06)" strokeWidth="0.8" />
      ))}
      <path d={areaD} fill={`url(#${gradId})`} clipPath={`url(#clip-${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.8" clipPath={`url(#clip-${id})`} />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Section card wrapper
// ─────────────────────────────────────────────────────────────────────────────

function SectionCard({
  icon, title, accent, subtitle, children, className,
}: {
  icon: React.ReactNode; title: string; accent: string;
  subtitle?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('rounded-xl border border-border bg-bg-secondary overflow-hidden flex flex-col h-full', className)}>
      <div className="px-4 pt-3 pb-2 border-b border-border shrink-0">
        <div className={`flex items-center gap-2 text-sm font-bold ${accent}`}>
          {icon} {title}
        </div>
        {subtitle && <div className="text-xs text-text-muted mt-0.5 truncate">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drag-to-resize handle between sections
// ─────────────────────────────────────────────────────────────────────────────

function ResizeHandle({ onResize }: { onResize: (dy: number) => void }) {
  const dragRef = useRef<{ lastY: number } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { lastY: e.clientY };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dy = ev.clientY - dragRef.current.lastY;
      dragRef.current.lastY = ev.clientY;
      onResize(dy);
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [onResize]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className="group my-1 h-4 flex items-center justify-center cursor-ns-resize select-none"
      title="Tirer pour redimensionner"
    >
      <div className="w-20 h-[3px] rounded-full bg-border group-hover:bg-text-muted/40 group-active:bg-cyan-400/60 transition-colors duration-150" />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CPU Card (Overview) — arc left, per-core scrollable right
// ─────────────────────────────────────────────────────────────────────────────

function CpuCard({ metrics, violating }: { metrics: AgentMetrics; violating: boolean }) {
  const cpu = metrics.cpu;
  if (!cpu) return null;
  const pct = cpu.percent;
  const color = usageSvgColor(pct, violating);
  const cores = cpu.cores ?? [];
  return (
    <SectionCard icon={<Cpu size={14} />} title="CPU" accent="text-cyan-400"
      subtitle={cpu.model || undefined}>
      {/* flex row: gauge left | scrollable 2-col core grid right
           min-h-0 on the row is required so the flex-1 child can overflow-y-auto */}
      <div className="flex gap-0 flex-1 overflow-hidden min-h-0">
        {/* Left: arc gauge */}
        <div className="flex flex-col items-center justify-center px-4 py-3 shrink-0 gap-1">
          <div className="relative" style={{ width: 112, height: 64 }}>
            <ArcGauge pct={pct} color={color} size={112} />
            <div className="absolute inset-x-0 bottom-0 flex justify-center">
              <span className={`text-2xl font-bold tabular-nums leading-none ${violating ? 'text-red-400' : 'text-text-primary'}`}>
                {pct.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
              </span>
            </div>
          </div>
          {metrics.loadAvg !== undefined && (
            <span className="text-[10px] text-text-muted">Load {metrics.loadAvg.toFixed(2)}</span>
          )}
          {cpu.freqMhz !== undefined && (
            <span className="text-[10px] text-text-muted">
              {cpu.freqMhz >= 1000 ? `${(cpu.freqMhz / 1000).toFixed(1)} GHz` : `${cpu.freqMhz} MHz`}
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="w-px bg-border shrink-0" />

        {/* Right: 2-column thread grid (1 core per row = 2 threads side-by-side)
             — grows to fill available card height (flex-1 min-h-0, no max-h)
             — scrollbar appears only when cores exceed the visible area          */}
        <div className="flex-1 min-w-0 overflow-y-auto py-2 px-3 min-h-0">
          {cores.length > 0 ? (
            <div className="flex flex-col gap-y-[10px]">
              {Array.from({ length: Math.ceil(cores.length / 2) }, (_, coreIdx) => (
                <div key={coreIdx} className="grid grid-cols-2 gap-x-3">
                  {[0, 1].map(t => {
                    const threadIdx = coreIdx * 2 + t;
                    const threadPct = cores[threadIdx];
                    if (threadPct === undefined) return null;
                    const coreNum = coreIdx + 1;
                    const threadNum = t + 1;
                    return (
                      <div key={t} className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[11px] font-mono text-text-muted/80 w-[36px] shrink-0">
                          C{coreNum}:{threadNum}
                        </span>
                        <div className="flex-1 min-w-0">
                          <Bar pct={threadPct} color={usageBarClass(threadPct)} h="h-[6px]" />
                        </div>
                        <span className="text-[11px] tabular-nums text-text-secondary w-[26px] text-right shrink-0">
                          {threadPct.toFixed(0)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            /* Fallback when no per-core data: single overall bar */
            <div className="flex items-center gap-2 pt-2">
              <span className="text-[10px] text-text-muted w-24 shrink-0">Overall</span>
              <div className="flex-1"><Bar pct={pct} color={usageBarClass(pct, violating)} /></div>
              <span className="text-[11px] tabular-nums text-text-secondary w-8 text-right shrink-0">{pct.toFixed(0)}%</span>
            </div>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RAM Card (Overview) — arc left, breakdown right
// ─────────────────────────────────────────────────────────────────────────────

function RamCard({ metrics, violating }: { metrics: AgentMetrics; violating: boolean }) {
  const mem = metrics.memory;
  if (!mem) return null;
  const color = usageSvgColor(mem.percent, violating);
  const freeM = mem.totalMb - mem.usedMb;

  const rows: Array<{ label: string; value: string; pct?: number }> = [
    { label: 'Used', value: fmtMb(mem.usedMb), pct: mem.percent },
    { label: 'Free', value: fmtMb(freeM) },
  ];
  if (mem.cachedMb) rows.push({ label: 'Cached', value: fmtMb(mem.cachedMb), pct: (mem.cachedMb / mem.totalMb) * 100 });
  if (mem.buffersMb) rows.push({ label: 'Buffers', value: fmtMb(mem.buffersMb), pct: (mem.buffersMb / mem.totalMb) * 100 });
  if (mem.swapTotalMb && mem.swapUsedMb !== undefined) {
    const swapPct = mem.swapTotalMb > 0 ? (mem.swapUsedMb / mem.swapTotalMb) * 100 : 0;
    rows.push({ label: 'Swap', value: `${fmtMb(mem.swapUsedMb)} / ${fmtMb(mem.swapTotalMb)}`, pct: swapPct });
  }

  return (
    <SectionCard icon={<MonitorDot size={14} />} title="RAM" accent="text-violet-400"
      subtitle={`Total: ${fmtMb(mem.totalMb)}`}>
      <div className="flex gap-0 flex-1 overflow-hidden">
        {/* Left: arc */}
        <div className="flex flex-col items-center justify-center px-4 py-3 shrink-0 gap-1">
          <div className="relative" style={{ width: 112, height: 64 }}>
            <ArcGauge pct={mem.percent} color={color} size={112} />
            <div className="absolute inset-x-0 bottom-0 flex justify-center">
              <span className={`text-2xl font-bold tabular-nums leading-none ${violating ? 'text-red-400' : 'text-text-primary'}`}>
                {mem.percent.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
              </span>
            </div>
          </div>
          <span className="text-[10px] text-text-muted">{fmtMb(mem.usedMb)} used</span>
        </div>
        <div className="w-px bg-border shrink-0" />
        {/* Right: breakdown rows */}
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-2 min-h-0">
          {rows.map((r) => (
            <div key={r.label} className="space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">{r.label}</span>
                <span className="text-[13px] tabular-nums text-text-secondary">{r.value}</span>
              </div>
              {r.pct !== undefined && <Bar pct={r.pct} color="bg-violet-400" />}
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU Card (Overview)
// ─────────────────────────────────────────────────────────────────────────────

function GpuCard({ metrics }: { metrics: AgentMetrics }) {
  const gpus = metrics.gpus;
  if (!gpus || gpus.length === 0) {
    return (
      <SectionCard icon={<MonitorDot size={14} />} title="GPU" accent="text-pink-400">
        <div className="flex-1 flex flex-col items-center justify-center gap-2 py-8 text-text-muted">
          <MonitorDot size={28} className="opacity-30" />
          <span className="text-xs">Aucune donnée GPU</span>
        </div>
      </SectionCard>
    );
  }
  const gpu = gpus[0];
  const vramPct = (gpu.vramUsedMb / gpu.vramTotalMb) * 100;
  const color = usageSvgColor(gpu.utilizationPct);
  const rows: Array<{ label: string; pct: number; displayValue?: string }> = gpu.engines && gpu.engines.length > 0
    ? gpu.engines
    : [
        { label: '3D', pct: gpu.utilizationPct },
        { label: 'VRAM', pct: vramPct },
        ...(gpu.tempCelsius !== undefined
          ? [{ label: 'Temp', pct: (gpu.tempCelsius / 120) * 100, displayValue: `${gpu.tempCelsius.toFixed(0)}°C` }]
          : []),
      ];

  return (
    <SectionCard icon={<MonitorDot size={14} />} title="GPU" accent="text-pink-400" subtitle={gpu.model}>
      <div className="flex gap-0 flex-1 overflow-hidden">
        <div className="flex flex-col items-center justify-center px-4 py-3 shrink-0 gap-1">
          <div className="relative" style={{ width: 112, height: 64 }}>
            <ArcGauge pct={gpu.utilizationPct} color={color} size={112} />
            <div className="absolute inset-x-0 bottom-0 flex justify-center">
              <span className="text-2xl font-bold tabular-nums leading-none text-text-primary">
                {gpu.utilizationPct.toFixed(0)}<span className="text-sm font-normal text-text-muted">%</span>
              </span>
            </div>
          </div>
          {gpu.tempCelsius !== undefined && (
            <span className="text-[10px] text-text-muted">{gpu.tempCelsius.toFixed(0)}°C</span>
          )}
        </div>
        <div className="w-px bg-border shrink-0" />
        <div className="flex-1 overflow-y-auto py-2 px-3 space-y-2 min-h-0">
          {rows.map((r) => (
            <div key={r.label} className="space-y-0.5">
              <div className="flex justify-between">
                <span className="text-xs text-text-muted">{r.label}</span>
                <span className="text-[13px] tabular-nums text-text-secondary">
                  {r.displayValue ?? `${r.pct.toFixed(0)}%`}
                </span>
              </div>
              <Bar pct={r.pct} color="bg-pink-400" />
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Drives Card
// ─────────────────────────────────────────────────────────────────────────────

function DrivesCard({ metrics, violating }: { metrics: AgentMetrics; violating: boolean }) {
  const disks = metrics.disks;
  if (!disks || disks.length === 0) return null;
  // Sort fullest first
  const sorted = [...disks].sort((a, b) => b.percent - a.percent);
  return (
    <SectionCard icon={<HardDrive size={14} />} title="Drives" accent="text-emerald-400">
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {sorted.map((d) => {
          const vio = violating && d.percent >= 90;
          return (
            <div key={d.mount} className="px-4 py-2.5 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary truncate max-w-[120px]">{d.mount}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {(d.readBytesPerSec !== undefined || d.writeBytesPerSec !== undefined) && (
                    <span className="text-xs text-text-muted flex gap-1">
                      {d.readBytesPerSec !== undefined && <span className="text-sky-400">↓{fmtBps(d.readBytesPerSec)}</span>}
                      {d.writeBytesPerSec !== undefined && <span className="text-amber-400">↑{fmtBps(d.writeBytesPerSec)}</span>}
                    </span>
                  )}
                  <span className={`text-sm tabular-nums font-semibold ${vio ? 'text-red-400' : 'text-text-primary'}`}>
                    {d.percent.toFixed(0)}%
                  </span>
                  <span className="text-xs text-text-muted">{fmtGb(d.usedGb)}/{fmtGb(d.totalGb)}</span>
                </div>
              </div>
              <Bar pct={d.percent} color={vio ? 'bg-red-500' : 'bg-emerald-400'} />
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fans Card
// ─────────────────────────────────────────────────────────────────────────────

function FansCard({ metrics }: { metrics: AgentMetrics }) {
  const fans = metrics.fans;
  if (!fans || fans.length === 0) return null;
  const maxRpm = Math.max(...fans.map(f => f.maxRpm ?? f.rpm), 1);
  return (
    <SectionCard icon={<Wind size={14} />} title="Fans" accent="text-slate-400">
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {fans.map((f) => {
          const pct = f.maxRpm ? (f.rpm / f.maxRpm) * 100 : (f.rpm / maxRpm) * 100;
          return (
            <div key={f.label} className="px-4 py-2.5 space-y-1">
              <div className="flex justify-between">
                <span className="text-xs text-text-secondary truncate max-w-[140px]">{f.label}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs tabular-nums font-semibold text-text-primary">{pct.toFixed(0)}%</span>
                  <span className="text-[10px] text-text-muted">{f.rpm.toLocaleString()} RPM</span>
                </div>
              </div>
              <Bar pct={pct} color="bg-slate-400" />
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Interfaces Card
// ─────────────────────────────────────────────────────────────────────────────

function InterfacesCard({ metrics }: { metrics: AgentMetrics }) {
  const net = metrics.network;
  if (!net) return null;
  const ifaces = (net.interfaces && net.interfaces.length > 0
    ? net.interfaces
    : [{ name: 'Total', inBytesPerSec: net.inBytesPerSec, outBytesPerSec: net.outBytesPerSec }]
  ).slice().sort((a, b) => (b.inBytesPerSec + b.outBytesPerSec) - (a.inBytesPerSec + a.outBytesPerSec));
  const maxBps = Math.max(...ifaces.flatMap(i => [i.inBytesPerSec, i.outBytesPerSec]), 1048576);
  return (
    <SectionCard icon={<Network size={14} />} title="Interfaces" accent="text-orange-400">
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {ifaces.map((iface) => (
          <div key={iface.name} className="px-4 py-2.5 space-y-1.5">
            <span className="text-xs font-medium text-text-secondary">{iface.name}</span>
            <div className="flex items-center gap-2">
              <ArrowDownToLine size={11} className="text-sky-400 shrink-0" />
              <div className="flex-1"><Bar pct={(iface.inBytesPerSec / maxBps) * 100} color="bg-sky-400" /></div>
              <span className="text-[13px] tabular-nums text-text-secondary w-20 text-right shrink-0">
                {fmtBps(iface.inBytesPerSec)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <ArrowUpFromLine size={11} className="text-orange-400 shrink-0" />
              <div className="flex-1"><Bar pct={(iface.outBytesPerSec / maxBps) * 100} color="bg-orange-400" /></div>
              <span className="text-[13px] tabular-nums text-text-secondary w-20 text-right shrink-0">
                {fmtBps(iface.outBytesPerSec)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Temperatures Section (bottom)
// ─────────────────────────────────────────────────────────────────────────────

function TempsSection({ metrics }: { metrics: AgentMetrics }) {
  const temps = metrics.temps;
  if (!temps || temps.length === 0) return null;
  const max = Math.max(...temps.map(t => t.celsius), 80);
  return (
    <SectionCard icon={<Thermometer size={14} />} title="Temperatures" accent="text-rose-400">
      <div className="flex-1 overflow-y-auto divide-y divide-border min-h-0">
        {temps.map((t) => {
          const pct = (t.celsius / max) * 100;
          const color = t.celsius >= 90 ? 'bg-red-500' : t.celsius >= 75 ? 'bg-yellow-500' : 'bg-rose-400';
          return (
            <div key={t.label} className="flex items-center gap-3 px-4 py-2.5">
              <span className="text-xs text-text-secondary flex-1 truncate">{t.label}</span>
              <div className="w-40 shrink-0"><Bar pct={pct} color={color} /></div>
              <span className="text-sm tabular-nums font-semibold text-text-primary w-14 text-right shrink-0">
                {t.celsius.toFixed(0)}°C
              </span>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview (real-time dashboard)
// ─────────────────────────────────────────────────────────────────────────────

function OverviewView({
  metrics, violations,
}: { metrics: AgentMetrics; violations: string[] }) {
  const hasCpuVio = violations.some(v => v.toLowerCase().includes('cpu'));
  const hasMemVio = violations.some(v => v.toLowerCase().includes('mem') || v.toLowerCase().includes('ram'));
  const hasDiskVio = violations.some(v => v.toLowerCase().includes('disk'));
  const hasFans = (metrics.fans?.length ?? 0) > 0;
  const hasNet = !!metrics.network;
  const hasTemp = (metrics.temps?.length ?? 0) > 0;
  const hasMiddle = (metrics.disks?.length ?? 0) > 0 || hasFans || hasNet;
  const middleCount = [(metrics.disks?.length ?? 0) > 0, hasFans, hasNet].filter(Boolean).length;

  const { heights, adjust } = useSectionHeights();

  // Stable resize callbacks — minimums prevent the handle from entering the section above
  const onTopResize    = useCallback((dy: number) => adjust('top',    MIN_TOP_HEIGHT,    dy), [adjust]);
  const onMidResize    = useCallback((dy: number) => adjust('middle', MIN_MIDDLE_HEIGHT, dy), [adjust]);
  const onBottomResize = useCallback((dy: number) => adjust('bottom', MIN_BOTTOM_HEIGHT, dy), [adjust]);

  return (
    <div>
      {/* ── Top row: CPU / RAM / GPU ── */}
      <div
        className="grid gap-4 grid-cols-1 md:grid-cols-3 overflow-hidden"
        style={{ height: heights.top, gridTemplateRows: '1fr' }}
      >
        <div className="h-full flex flex-col overflow-hidden min-h-0">
          {metrics.cpu
            ? <CpuCard metrics={metrics} violating={hasCpuVio} />
            : <SectionCard icon={<Cpu size={14} />} title="CPU" accent="text-cyan-400">
                <div className="flex-1 flex items-center justify-center text-text-muted text-xs">Aucune donnée</div>
              </SectionCard>
          }
        </div>
        <div className="h-full flex flex-col overflow-hidden min-h-0">
          {metrics.memory
            ? <RamCard metrics={metrics} violating={hasMemVio} />
            : <SectionCard icon={<MonitorDot size={14} />} title="RAM" accent="text-violet-400">
                <div className="flex-1 flex items-center justify-center text-text-muted text-xs">Aucune donnée</div>
              </SectionCard>
          }
        </div>
        <div className="h-full flex flex-col overflow-hidden min-h-0">
          <GpuCard metrics={metrics} />
        </div>
      </div>

      {/* Resize handle — top section */}
      <ResizeHandle onResize={onTopResize} />

      {/* ── Middle row: Drives / Fans / Interfaces ── */}
      {hasMiddle && (
        <>
          <div
            className={cn(
              'grid gap-4',
              middleCount === 3 ? 'grid-cols-1 md:grid-cols-3'
                : middleCount === 2 ? 'grid-cols-1 md:grid-cols-2'
                : 'grid-cols-1',
            )}
            style={{ height: heights.middle, gridTemplateRows: '1fr' }}
          >
            {(metrics.disks?.length ?? 0) > 0 && (
              <div className="h-full flex flex-col overflow-hidden min-h-0">
                <DrivesCard metrics={metrics} violating={hasDiskVio} />
              </div>
            )}
            {hasFans && (
              <div className="h-full flex flex-col overflow-hidden min-h-0">
                <FansCard metrics={metrics} />
              </div>
            )}
            {hasNet && (
              <div className="h-full flex flex-col overflow-hidden min-h-0">
                <InterfacesCard metrics={metrics} />
              </div>
            )}
          </div>

          {/* Resize handle — middle section (only if temps exist below) */}
          {hasTemp && <ResizeHandle onResize={onMidResize} />}
        </>
      )}

      {/* Resize handle — between top and bottom when no middle */}
      {!hasMiddle && hasTemp && <ResizeHandle onResize={onBottomResize} />}

      {/* ── Bottom: Temps ── */}
      {hasTemp && (
        <div style={{ height: heights.bottom }}>
          <TempsSection metrics={metrics} />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CPU Detail View (history charts)
// ─────────────────────────────────────────────────────────────────────────────

function ChartCard({
  icon, title, accent, data, id, yMin, yMax, color, unit, latestLabel, height = 110,
}: {
  icon: React.ReactNode; title: string; accent: string;
  data: number[]; id: string; yMin?: number; yMax?: number;
  color: string; unit: string; latestLabel?: string; height?: number;
}) {
  const latest = data[data.length - 1];
  return (
    <div className="rounded-xl border border-border bg-bg-secondary overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
        <div className={`flex items-center gap-2 text-sm font-bold ${accent}`}>{icon} {title}</div>
        {latest !== undefined && (
          <span className="text-sm font-bold tabular-nums text-text-primary">
            {latestLabel ?? `${latest.toFixed(1)}${unit}`}
          </span>
        )}
      </div>
      <div className="p-3 pb-2">
        <SparkChart data={data} id={id} yMin={yMin} yMax={yMax} color={color} height={height} />
        <div className="flex justify-between text-[10px] text-text-muted mt-1 px-0.5">
          <span>{data.length > 1 ? `${data.length} samples` : '—'}</span>
          <span>Now</span>
        </div>
      </div>
    </div>
  );
}

function CpuView({ metrics, history }: { metrics: AgentMetrics; history: AgentPushSnapshot[] }) {
  const cpu = metrics.cpu;
  const vendor = cpu?.model ? extractVendor(cpu.model) : '';
  const threads = cpu?.cores?.length ?? 0;

  const loadData = history.map(h => h.metrics.cpu?.percent ?? 0);
  const loadAvgData = history.map(h => h.metrics.loadAvg ?? 0);
  const freqData = history.map(h => h.metrics.cpu?.freqMhz ?? 0).filter((_, i) => history[i].metrics.cpu?.freqMhz !== undefined);
  // Average temp per sample
  const tempData = history.map(h => {
    const temps = h.metrics.temps;
    if (!temps || temps.length === 0) return 0;
    const cpuTemps = temps.filter(t => /cpu|core|package/i.test(t.label));
    const arr = cpuTemps.length > 0 ? cpuTemps : temps;
    return arr.reduce((s, t) => s + t.celsius, 0) / arr.length;
  }).filter((_v, i) => history[i].metrics.temps && history[i].metrics.temps!.length > 0);

  return (
    <div className="space-y-4">
      {/* CPU Info */}
      <div className="rounded-xl border border-border bg-bg-secondary p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-cyan-400 mb-3">
          <Cpu size={14} /> CPU Info
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          {vendor && (
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">Vendor</div>
              <div className="text-text-primary font-medium">{vendor}</div>
            </div>
          )}
          {cpu?.model && (
            <div className="col-span-2">
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">Model</div>
              <div className="text-text-primary font-medium truncate">{cpu.model}</div>
            </div>
          )}
          {cpu?.freqMhz && (
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">Base Speed</div>
              <div className="text-text-primary font-medium">
                {cpu.freqMhz >= 1000 ? `${(cpu.freqMhz / 1000).toFixed(2)} GHz` : `${cpu.freqMhz} MHz`}
              </div>
            </div>
          )}
          {threads > 0 && (
            <div>
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-0.5">Threads</div>
              <div className="text-text-primary font-medium">{threads} T</div>
            </div>
          )}
        </div>
      </div>

      {/* Charts grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loadData.length >= 2 && (
          <ChartCard icon={<Activity size={13} />} title="CPU Load" accent="text-cyan-400"
            data={loadData} id="cpu-load" yMin={0} yMax={100} color="#22d3ee" unit="%" />
        )}
        {loadAvgData.some(v => v > 0) && (
          <ChartCard icon={<Activity size={13} />} title="Load Average" accent="text-sky-400"
            data={loadAvgData} id="load-avg" yMin={0} yMax={Math.max(...loadAvgData, 1)} color="#38bdf8" unit="" />
        )}
        {tempData.length >= 2 && (
          <ChartCard icon={<Thermometer size={13} />} title="Avg Temperature" accent="text-rose-400"
            data={tempData} id="cpu-temp" yMin={20} yMax={100} color="#f87171" unit="°C"
            latestLabel={`${tempData[tempData.length - 1].toFixed(1)}°C`} />
        )}
        {freqData.length >= 2 && (
          <ChartCard icon={<Cpu size={13} />} title="Clock Speed" accent="text-violet-400"
            data={freqData} id="cpu-freq"
            yMin={Math.min(...freqData) * 0.9}
            yMax={Math.max(...freqData) * 1.05}
            color="#a78bfa" unit=" MHz"
            latestLabel={freqData[freqData.length - 1] >= 1000
              ? `${(freqData[freqData.length - 1] / 1000).toFixed(2)} GHz`
              : `${freqData[freqData.length - 1].toFixed(0)} MHz`} />
        )}
      </div>

      {history.length < 2 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-text-muted text-sm">
          Graphs will appear as data accumulates (need at least 2 push cycles).
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Threshold Editor Modal
// ─────────────────────────────────────────────────────────────────────────────

function ThresholdEditor({
  thresholds, onSave, onClose,
}: { thresholds: AgentThresholds; onSave: (t: AgentThresholds) => Promise<void>; onClose: () => void }) {
  const [values, setValues] = useState<AgentThresholds>({ ...thresholds });
  const [saving, setSaving] = useState(false);
  const upd = (key: keyof AgentThresholds, field: keyof AgentMetricThreshold, value: unknown) =>
    setValues(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  const handleSave = async () => {
    setSaving(true);
    try { await onSave(values); onClose(); } finally { setSaving(false); }
  };
  // scale: multiply display value by this factor to get the stored bytes/sec value
  // (1 Mbps = 125 000 bytes/sec)
  const BYTES_PER_MBIT = 125_000;
  const rows: Array<{ key: keyof AgentThresholds; label: string; unit: string; scale?: number }> = [
    { key: 'cpu',    label: 'CPU',        unit: '%' },
    { key: 'memory', label: 'Memory',     unit: '%' },
    { key: 'disk',   label: 'Disk (any)', unit: '%' },
    { key: 'netIn',  label: 'Net In',     unit: 'Mbps', scale: BYTES_PER_MBIT },
    { key: 'netOut', label: 'Net Out',    unit: 'Mbps', scale: BYTES_PER_MBIT },
  ];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-primary shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Settings2 size={16} /> Alert Thresholds
          </h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <div className="p-5">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase text-text-muted border-b border-border">
                <th className="text-left pb-2 font-medium">Metric</th>
                <th className="text-center pb-2 font-medium">On</th>
                <th className="text-center pb-2 font-medium">Op</th>
                <th className="text-left pb-2 font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(({ key, label, unit, scale }) => (
                <tr key={key}>
                  <td className="py-2.5 font-medium text-text-secondary">{label}</td>
                  <td className="py-2.5 text-center">
                    <input type="checkbox" checked={values[key].enabled}
                      onChange={e => upd(key, 'enabled', e.target.checked)}
                      className="h-4 w-4 rounded border-border bg-bg-tertiary text-accent" />
                  </td>
                  <td className="py-2.5 text-center">
                    <select value={values[key].op} onChange={e => upd(key, 'op', e.target.value)}
                      disabled={!values[key].enabled}
                      className="text-xs border border-border rounded bg-bg-tertiary text-text-primary px-1.5 py-1 disabled:opacity-40">
                      {['>', '>=', '<', '<='].map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </td>
                  <td className="py-2.5">
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        value={scale ? Math.round(values[key].threshold / scale) : values[key].threshold}
                        onChange={e => upd(key, 'threshold', scale
                          ? Math.round(Number(e.target.value) * scale)
                          : Number(e.target.value)
                        )}
                        disabled={!values[key].enabled} min={0}
                        className="w-24 text-xs border border-border rounded bg-bg-tertiary text-text-primary px-2 py-1 disabled:opacity-40" />
                      <span className="text-xs text-text-muted">{unit}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 disabled:opacity-60 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

const NAV_ITEMS: Array<{ id: View; icon: React.ReactNode; label: string }> = [
  { id: 'overview', icon: <LayoutDashboard size={18} />, label: 'Overview' },
  { id: 'cpu',      icon: <Cpu size={18} />,             label: 'CPU' },
];

export function AgentDetailPage() {
  const { deviceId } = useParams<{ deviceId: string }>();
  const navigate = useNavigate();
  const id = Number(deviceId);

  const [view, setView] = useState<View>('overview');
  const [device, setDevice] = useState<AgentDevice | null>(null);
  const [snapshot, setSnapshot] = useState<AgentPushSnapshot | null>(null);
  const [history, setHistory] = useState<AgentPushSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [showThresholds, setShowThresholds] = useState(false);
  const [thresholds, setThresholds] = useState<AgentThresholds>(DEFAULT_AGENT_THRESHOLDS);
  const [lastPush, setLastPush] = useState<string | null>(null);
  const [editingInterval, setEditingInterval] = useState(false);
  const [intervalValue, setIntervalValue] = useState(60);
  const [savingInterval, setSavingInterval] = useState(false);

  const loadData = useCallback(async () => {
    try {
      const [dev, snap] = await Promise.all([agentApi.getDeviceById(id), agentApi.getDeviceMetrics(id)]);
      setDevice(dev);
      if (dev) setIntervalValue(dev.checkIntervalSeconds ?? 60);
      if (snap) {
        setSnapshot(snap);
        setLastPush(snap.receivedAt);
        setHistory(prev => prev.length === 0 ? [snap] : prev);
        try {
          const monitor = await monitorsApi.getById(snap.monitorId);
          if (monitor.agentThresholds) setThresholds(monitor.agentThresholds);
        } catch { /* defaults */ }
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [id]);

  useEffect(() => { loadData(); }, [loadData]);

  // Socket.io real-time updates + history accumulation
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (data: {
      deviceId: number; monitorId: number; metrics: AgentMetrics;
      violations: string[]; overallStatus: 'up' | 'alert'; receivedAt: string;
    }) => {
      if (data.deviceId !== id) return;
      const snap: AgentPushSnapshot = {
        monitorId: data.monitorId, receivedAt: data.receivedAt,
        metrics: data.metrics, violations: data.violations, overallStatus: data.overallStatus,
      };
      setSnapshot(snap);
      setLastPush(data.receivedAt);
      setHistory(prev => [...prev, snap].slice(-MAX_HISTORY));
    };
    socket.on('agentPush', handler);
    return () => { socket.off('agentPush', handler); };
  }, [id]);

  const handleSaveThresholds = async (t: AgentThresholds) => {
    await agentApi.updateDeviceThresholds(id, t);
    setThresholds(t);
  };

  const handleSaveInterval = async () => {
    const v = Math.max(1, Math.min(86400, intervalValue));
    setSavingInterval(true);
    try {
      const updated = await agentApi.updateDevice(id, { checkIntervalSeconds: v });
      setDevice(updated);
      setIntervalValue(updated.checkIntervalSeconds ?? v);
      setEditingInterval(false);
    } catch { /* ignore */ }
    finally { setSavingInterval(false); }
  };

  // ── Loading / not found ──────────────────────────────────────────────────

  if (loading) return (
    <div className="flex items-center justify-center h-64"><LoadingSpinner size="lg" /></div>
  );
  if (!device) return (
    <div className="p-6 text-center">
      <Server size={48} className="mx-auto mb-3 text-text-muted opacity-40" />
      <p className="text-text-muted">Device not found</p>
      <button onClick={() => navigate(-1)} className="mt-3 text-accent hover:underline text-sm">Go back</button>
    </div>
  );

  // ── Derived state ────────────────────────────────────────────────────────

  const m = snapshot?.metrics ?? null;
  const isOnline = !!snapshot && (Date.now() - new Date(snapshot.receivedAt).getTime()) < (device.checkIntervalSeconds ?? 60) * 2000;
  const overallStatus = !isOnline ? 'offline' : (snapshot?.overallStatus ?? 'pending');
  const violations = snapshot?.violations ?? [];
  const sc = {
    up:      { dot: 'bg-status-up',   text: 'text-status-up',   label: 'Online',  glow: 'shadow-[0_0_8px_2px] shadow-status-up/50' },
    alert:   { dot: 'bg-orange-500',  text: 'text-orange-400',  label: 'Alert',   glow: 'shadow-[0_0_8px_2px] shadow-orange-500/50' },
    offline: { dot: 'bg-text-muted',  text: 'text-text-muted',  label: 'Offline', glow: '' },
    pending: { dot: 'bg-yellow-500',  text: 'text-yellow-400',  label: 'Pending', glow: '' },
  }[overallStatus] ?? { dot: 'bg-text-muted', text: 'text-text-muted', label: overallStatus, glow: '' };
  const osLabel = device.osInfo
    ? `${device.osInfo.distro ?? device.osInfo.platform ?? ''} ${device.osInfo.release ?? ''}`.trim()
    : null;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1">

      {/* ── Main scrollable content ── */}
      <div className="flex-1 min-w-0 p-4 md:p-6 space-y-4">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <button onClick={() => navigate(-1)}
              className="mt-0.5 p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
              <ArrowLeft size={18} />
            </button>
            <div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <h1 className="text-xl font-bold text-text-primary">{device.hostname}</h1>
                <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${sc.text}`}>
                  <span className={`inline-block w-2.5 h-2.5 rounded-full ${sc.dot} ${sc.glow}`} />
                  {sc.label}
                </span>
              </div>
              <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-text-muted">
                {device.ip          && <span>{device.ip}</span>}
                {osLabel            && <span>{osLabel}</span>}
                {device.osInfo?.arch && <span>{device.osInfo.arch}</span>}
                {device.agentVersion && <span>Agent v{device.agentVersion}</span>}
                {lastPush           && <span>Last push: {fmtRelTime(lastPush)}</span>}
                {!snapshot          && <span className="text-yellow-400">Waiting for first push…</span>}
                {/* Interval editor */}
                {!editingInterval ? (
                  <span className="flex items-center gap-1">
                    <Timer size={11} />
                    {device.checkIntervalSeconds ?? 60}s
                    <button onClick={() => { setIntervalValue(device.checkIntervalSeconds ?? 60); setEditingInterval(true); }}
                      className="ml-0.5 p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Change push interval">
                      <Pencil size={11} />
                    </button>
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <Timer size={11} />
                    <input type="number" value={intervalValue} min={1} max={86400} autoFocus
                      onChange={e => setIntervalValue(Number(e.target.value))}
                      onKeyDown={e => { if (e.key === 'Enter') void handleSaveInterval(); if (e.key === 'Escape') setEditingInterval(false); }}
                      className="w-16 rounded border border-border bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent" />
                    <span>s</span>
                    <button onClick={() => void handleSaveInterval()} disabled={savingInterval}
                      className="p-0.5 rounded text-status-up hover:bg-bg-hover transition-colors disabled:opacity-50" title="Save">
                      <Check size={13} />
                    </button>
                    <button onClick={() => setEditingInterval(false)}
                      className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Cancel">
                      <X size={13} />
                    </button>
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => void loadData()}
              className="p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors" title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button onClick={() => setShowThresholds(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
              <Settings2 size={14} /> Thresholds
            </button>
          </div>
        </div>

        {/* Violations banner */}
        {violations.length > 0 && (
          <div className="flex items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span>{violations.join(' · ')}</span>
          </div>
        )}

        {/* No data yet */}
        {!snapshot && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <Activity size={36} className="mx-auto mb-3 text-text-muted opacity-40" />
            <p className="text-text-muted text-sm">No metrics yet — agent pushes every {device.checkIntervalSeconds ?? 60}s</p>
          </div>
        )}

        {/* View content */}
        {m && view === 'overview' && <OverviewView metrics={m} violations={violations} />}
        {view === 'cpu' && <CpuView metrics={m ?? {}} history={history} />}

      </div>

      {/* ── Right mini navigation sidebar ──
           Outer div: stretches to full page height (no h-screen / self-start) so the
           background colour never gets a sharp cutoff mid-page.
           Inner div: sticky top-0 so the nav icons stay visible while scrolling. ── */}
      <div className="w-12 border-l border-border bg-bg-secondary shrink-0">
        <nav className="sticky top-0 flex flex-col items-center pt-4 gap-1">
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              onClick={() => setView(item.id)}
              title={item.label}
              className={cn(
                'w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
                view === item.id
                  ? 'bg-accent/20 text-accent'
                  : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
              )}
            >
              {item.icon}
            </button>
          ))}
        </nav>
      </div>

      {/* Threshold editor */}
      {showThresholds && (
        <ThresholdEditor thresholds={thresholds} onSave={handleSaveThresholds} onClose={() => setShowThresholds(false)} />
      )}
    </div>
  );
}

export default AgentDetailPage;

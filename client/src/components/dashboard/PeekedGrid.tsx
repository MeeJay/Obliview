import { useRef, useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';

interface PeekedGridProps {
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Text displayed top-right (e.g. "12 total") */
  count?: string;
  children: ReactNode;
  /** Fixed column width in px. Cards will be sized to this. Default: 290 */
  cardWidth?: number;
  /** Number of grid rows. Default: 2 */
  rows?: number;
  /** Gap between cells in px. Default: 12 */
  gap?: number;
  className?: string;
}

export function PeekedGrid({
  title,
  icon,
  badge,
  count,
  children,
  cardWidth = 290,
  rows = 2,
  gap = 12,
  className,
}: PeekedGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft]   = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateArrows = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateArrows();
    el.addEventListener('scroll', updateArrows, { passive: true });
    const ro = new ResizeObserver(updateArrows);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateArrows);
      ro.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  const scrollByPage = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    // Move by as many full columns as fit in the viewport, minus one for context
    const colWidth = cardWidth + gap;
    const cols = Math.max(1, Math.floor(el.clientWidth / colWidth) - 1);
    el.scrollBy({ left: dir * colWidth * cols, behavior: 'smooth' });
  };

  return (
    <div className={cn('mb-6', className)}>
      {/* Section header */}
      <div className="flex items-center gap-2 mb-3 pb-1 border-b border-border">
        {icon}
        <span className="text-sm font-semibold text-text-secondary uppercase tracking-wider">
          {title}
        </span>
        {badge}
        {count && (
          <span className="text-xs text-text-muted ml-auto">{count}</span>
        )}
      </div>

      {/* Peek wrapper — overflow is visible, arrows are overlay */}
      <div className="relative">

        {/* ── Left fade + arrow ────────────────────────────────────────── */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-20',
            'bg-gradient-to-r from-bg-primary via-bg-primary/60 to-transparent',
            'transition-opacity duration-200',
            canLeft ? 'opacity-100' : 'opacity-0',
          )}
        />
        <button
          onClick={() => scrollByPage(-1)}
          aria-label="Scroll left"
          className={cn(
            'absolute left-2 top-1/2 -translate-y-1/2 z-20',
            'flex h-9 w-9 items-center justify-center rounded-full',
            'bg-bg-tertiary border border-border shadow-lg',
            'transition-all duration-200',
            canLeft
              ? 'opacity-100 hover:bg-bg-active text-text-primary cursor-pointer'
              : 'opacity-0 pointer-events-none',
          )}
        >
          <ChevronLeft size={18} />
        </button>

        {/* ── Scrollable multi-row grid ────────────────────────────────── */}
        <div
          ref={scrollRef}
          className="overflow-x-auto"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' } as React.CSSProperties}
        >
          {/* Webkit scrollbar hidden via global .scrollbar-none in index.css */}
          <div
            className="scrollbar-none"
            style={{
              display: 'grid',
              gridAutoFlow: 'column',
              gridTemplateRows: `repeat(${rows}, auto)`,
              gridAutoColumns: `${cardWidth}px`,
              gap: `${gap}px`,
              paddingBottom: '4px',
            }}
          >
            {children}
          </div>
        </div>

        {/* ── Right fade + arrow ───────────────────────────────────────── */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute right-0 top-0 bottom-0 z-10 w-20',
            'bg-gradient-to-l from-bg-primary via-bg-primary/60 to-transparent',
            'transition-opacity duration-200',
            canRight ? 'opacity-100' : 'opacity-0',
          )}
        />
        <button
          onClick={() => scrollByPage(1)}
          aria-label="Scroll right"
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 z-20',
            'flex h-9 w-9 items-center justify-center rounded-full',
            'bg-bg-tertiary border border-border shadow-lg',
            'transition-all duration-200',
            canRight
              ? 'opacity-100 hover:bg-bg-active text-text-primary cursor-pointer'
              : 'opacity-0 pointer-events-none',
          )}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}

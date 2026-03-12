import { useRef, useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/utils/cn';

interface HorizontalCarouselProps {
  title: string;
  icon?: ReactNode;
  badge?: ReactNode;
  /** Total item count displayed top-right */
  count?: string;
  children: ReactNode;
  className?: string;
}

export function HorizontalCarousel({
  title,
  icon,
  badge,
  count,
  children,
  className,
}: HorizontalCarouselProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
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

  const scrollBy = (dir: 1 | -1) => {
    const el = scrollRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: 'smooth' });
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
        <div className="flex items-center gap-1 ml-auto">
          {count && (
            <span className="text-xs text-text-muted mr-2">{count}</span>
          )}
          <button
            onClick={() => scrollBy(-1)}
            disabled={!canLeft}
            className={cn(
              'p-1 rounded transition-colors',
              canLeft
                ? 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                : 'text-text-muted opacity-30 cursor-default',
            )}
            aria-label="Scroll left"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => scrollBy(1)}
            disabled={!canRight}
            className={cn(
              'p-1 rounded transition-colors',
              canRight
                ? 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                : 'text-text-muted opacity-30 cursor-default',
            )}
            aria-label="Scroll right"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Scrollable track */}
      <div
        ref={scrollRef}
        className="flex gap-3 overflow-x-auto pb-1"
        style={{ scrollbarWidth: 'thin', scrollSnapType: 'x proximity' }}
      >
        {children}
      </div>
    </div>
  );
}

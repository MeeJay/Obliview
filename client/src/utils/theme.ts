import type { AppTheme } from '@obliview/shared';

export { type AppTheme };

const STORAGE_KEY = 'ov-theme';

/** Canonical list of themes this app knows how to render. Kept in sync with
 *  the [data-theme="..."] blocks in index.css and the AppTheme type union. */
const KNOWN_THEMES = new Set<AppTheme>([
  'obli-operator',
  'obli-daylight',
  'modern',
  'neon',
]);

const FALLBACK_THEME: AppTheme = 'obli-operator';

/**
 * Apply a theme by setting data-theme on <html> and persisting it.
 * Accepts `string` (not just `AppTheme`) so an unknown value coming from a
 * future Obligate release doesn't brick the app — unknown IDs collapse to
 * the fallback silently.
 */
export function applyTheme(theme: string): void {
  const safe = (KNOWN_THEMES.has(theme as AppTheme) ? theme : FALLBACK_THEME) as AppTheme;
  document.documentElement.dataset.theme = safe;
  try {
    localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // localStorage unavailable
  }
}

/** Load the theme from localStorage (used before session check to avoid flash). */
export function loadSavedTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && KNOWN_THEMES.has(saved as AppTheme)) return saved as AppTheme;
  } catch {
    // ignore
  }
  return FALLBACK_THEME;
}

/** Called once on app boot in main.tsx to prevent flash of wrong theme. */
export function initTheme(): void {
  applyTheme(loadSavedTheme());
}

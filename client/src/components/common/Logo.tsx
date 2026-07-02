import { useEffect, useState } from 'react';

/**
 * Renders the Obliview logo, swapping between the standard (white/teal, dark
 * themes) and the black variant (Obli Daylight) based on the active theme.
 *
 * The theme is applied to <html data-theme="..."> by utils/theme.ts. We watch
 * that attribute so the logo stays in sync when the user swaps themes without
 * a full reload (theme picker in /profile).
 */

const DARK_LOGO = '/logo.svg';
const LIGHT_LOGO = '/logo-black.svg';

function readTheme(): string | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement.dataset.theme ?? null;
}

function isLightTheme(theme: string | null): boolean {
  return theme === 'obli-daylight';
}

export function Logo({ className, alt = 'Obliview' }: { className?: string; alt?: string }) {
  const [theme, setTheme] = useState<string | null>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(root.dataset.theme ?? null);
    });
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return <img src={isLightTheme(theme) ? LIGHT_LOGO : DARK_LOGO} alt={alt} className={className} />;
}

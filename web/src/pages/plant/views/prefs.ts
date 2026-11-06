import { useCallback, useState, useSyncExternalStore } from 'react';
import { useMediaQuery } from '@mantine/hooks';

/**
 * Per-viewer conveniences of the plant views (#230), kept in this browser: whether the flow animation is off, and
 * whether a view shows its picture or its table. Storage can be missing (private windows, blocked site data): then
 * the defaults apply and nothing breaks.
 */

/** How often the views read again: live status (monitors, datasets) may change, the documentation rarely does. */
export const LIVE_REFRESH_MS = 60_000;

const ANIMATION_KEY = 'sm.plantViews.animationOff';
const listeners = new Set<() => void>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage blocked: the default
  }
}
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: the choice lasts until the page is reloaded
  }
}

let animationOff = read(ANIMATION_KEY) === '1';

/**
 * Whether the views animate: never with `prefers-reduced-motion: reduce` (static arrows instead), and not when the
 * viewer turned the animation off.
 */
export function useMotion(): { animate: boolean; reduced: boolean; off: boolean; setOff: (off: boolean) => void } {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)') ?? false;
  const off = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => animationOff,
  );
  const setOff = useCallback((v: boolean) => {
    animationOff = v;
    write(ANIMATION_KEY, v ? '1' : '0');
    listeners.forEach((l) => l());
  }, []);
  return { animate: !reduced && !off, reduced, off, setOff };
}

export type ViewMode = 'picture' | 'table';

/** Picture or table, remembered per view; phones start with the table (the picture stays one tap away). */
export function useViewMode(id: string): [ViewMode, (m: ViewMode) => void] {
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const key = `sm.plantViews.mode.${id}`;
  const [stored, setStored] = useState<ViewMode | null>(() => {
    const v = read(key);
    return v === 'picture' || v === 'table' ? v : null;
  });
  const set = useCallback(
    (m: ViewMode) => {
      setStored(m);
      write(key, m);
    },
    [key],
  );
  return [stored ?? (narrow ? 'table' : 'picture'), set];
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProcessDefinition } from '@sm/shared';

type Def = ProcessDefinition;

const LIMIT = 100;
const COALESCE_MS = 500;

/**
 * Undo/redo history of definition snapshots. Changes with the same
 * `coalesceKey` within 500 ms (e.g. typing in a field) form one entry.
 */
export function useDefHistory(def: Def | null, setDef: (d: Def) => void) {
  const past = useRef<Def[]>([]);
  const future = useRef<Def[]>([]);
  const last = useRef<{ key?: string; t: number }>({ t: 0 });
  const current = useRef(def);
  current.current = def;
  const [, rerender] = useState(0);
  /** Increments on undo/redo so forms with local state can remount. */
  const [seq, setSeq] = useState(0);

  const change = useCallback(
    (next: Def, coalesceKey?: string) => {
      const cur = current.current;
      if (cur && next !== cur && JSON.stringify(next) !== JSON.stringify(cur)) {
        const now = Date.now();
        const coalesce = !!coalesceKey && last.current.key === coalesceKey && now - last.current.t < COALESCE_MS;
        if (!coalesce) {
          past.current.push(cur);
          if (past.current.length > LIMIT) past.current.shift();
        }
        future.current = [];
        last.current = { key: coalesceKey, t: now };
        rerender((x) => x + 1);
      }
      current.current = next;
      setDef(next);
    },
    [setDef],
  );

  const step = useCallback(
    (from: React.MutableRefObject<Def[]>, to: React.MutableRefObject<Def[]>) => {
      const target = from.current.pop();
      const cur = current.current;
      if (!target || !cur) return false;
      to.current.push(cur);
      last.current = { t: 0 };
      current.current = target;
      setDef(target);
      setSeq((s) => s + 1);
      return true;
    },
    [setDef],
  );
  const undo = useCallback(() => step(past, future), [step]);
  const redo = useCallback(() => step(future, past), [step]);

  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    last.current = { t: 0 };
    rerender((x) => x + 1);
  }, []);

  return { change, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0, seq };
}

/** True when keyboard focus is in a text field – then the browser's own undo / copy applies. */
export function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.isContentEditable) return true;
  const field = el.closest('input, textarea, select') as HTMLInputElement | null;
  if (!field) return false;
  if (field.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(field.type);
  return true;
}

/** Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y outside text fields. */
export function useUndoKeys(enabled: boolean, undo: () => void, redo: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      if (isTextTarget(e.target)) return;
      e.preventDefault();
      if (k === 'y' || e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [enabled, undo, redo]);
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl+';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Group, Paper, Text } from '@mantine/core';
import { IconDeviceFloppy, IconPointFilled } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/**
 * One way to save in every settings area: the cards of an area register what they changed, and one bar at the
 * bottom of the screen says "Unsaved changes" and saves (or resets) all of them. A card outside a
 * `SaveBarProvider` keeps its own button (the hook returns false).
 */
export interface SaveSection {
  dirty: boolean;
  /** false: the changes cannot be saved yet (a field is invalid) */
  valid?: boolean;
  save: () => Promise<unknown> | unknown;
  reset: () => void;
  /** Save after the other sections (its save refreshes data the others are drafted from) */
  saveLast?: boolean;
}

interface Registered {
  dirty: boolean;
  valid: boolean;
  last: boolean;
}
interface Ctx {
  set: (id: string, s: Registered | null) => void;
  actions: React.RefObject<Map<string, Pick<SaveSection, 'save' | 'reset'>>>;
  sections: Record<string, Registered>;
}

const SaveBarContext = createContext<Ctx | null>(null);

export function SaveBarProvider({ children }: { children: ReactNode }) {
  const [sections, setSections] = useState<Record<string, Registered>>({});
  const actions = useRef(new Map<string, Pick<SaveSection, 'save' | 'reset'>>());
  const set = useCallback((id: string, s: Registered | null) => {
    setSections((prev) => {
      if (!s) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      const cur = prev[id];
      return cur && cur.dirty === s.dirty && cur.valid === s.valid && cur.last === s.last ? prev : { ...prev, [id]: s };
    });
  }, []);
  const value = useMemo(() => ({ set, actions, sections }), [set, sections]);
  return <SaveBarContext.Provider value={value}>{children}</SaveBarContext.Provider>;
}

/** Register a card's draft with the area's save bar. Returns whether the bar saves it (otherwise show an own button). */
export function useSaveSection(id: string, section: SaveSection): boolean {
  const ctx = useContext(SaveBarContext);
  const latest = useRef(section);
  latest.current = section;
  const dirty = section.dirty;
  const valid = section.valid !== false;
  const last = !!section.saveLast;
  const set = ctx?.set;
  const actions = ctx?.actions;
  useEffect(() => {
    if (!set || !actions) return;
    actions.current.set(id, { save: () => latest.current.save(), reset: () => latest.current.reset() });
    set(id, { dirty, valid, last });
  }, [set, actions, id, dirty, valid, last]);
  useEffect(
    () => () => {
      actions?.current.delete(id);
      set?.(id, null);
    },
    [set, actions, id],
  );
  return !!ctx;
}

/** The bar itself, after the area's cards: with unsaved changes it sticks to the bottom of the window. */
export function SaveBar() {
  const { t } = useTranslation('common');
  const ctx = useContext(SaveBarContext);
  const [busy, setBusy] = useState(false);
  if (!ctx) return null;
  const entries = Object.entries(ctx.sections);
  if (!entries.length) return null;
  const dirty = entries.filter(([, s]) => s.dirty).sort(([, a], [, b]) => Number(a.last) - Number(b.last));
  const invalid = dirty.some(([, s]) => !s.valid);
  const saveAll = async () => {
    setBusy(true);
    try {
      // one after the other: every card reports its own result
      for (const [id] of dirty) await ctx.actions.current.get(id)?.save();
    } finally {
      setBusy(false);
    }
  };
  const resetAll = () => dirty.forEach(([id]) => ctx.actions.current.get(id)?.reset());
  return (
    <Paper
      withBorder
      shadow={dirty.length ? 'md' : undefined}
      p="sm"
      data-testid="settings-save-bar"
      role="region"
      aria-label={t('saveBar.label')}
      // stays in view while there is something to save, otherwise it ends the area
      style={dirty.length ? { position: 'sticky', bottom: 'var(--mantine-spacing-xs)', zIndex: 5 } : undefined}
    >
      <Group justify="space-between" gap="xs" wrap="wrap">
        <Text size="sm" c={dirty.length ? undefined : 'dimmed'} aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {dirty.length > 0 && <IconPointFilled size={14} color="var(--mantine-color-orange-6)" aria-hidden />}
          {dirty.length ? (invalid ? t('saveBar.invalid') : t('saveBar.unsaved')) : t('saveBar.saved')}
        </Text>
        <Group gap="xs">
          <Button variant="default" disabled={!dirty.length || busy} onClick={resetAll}>
            {t('saveBar.reset')}
          </Button>
          <Button leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty.length || invalid} loading={busy} onClick={saveAll}>
            {t('save')}
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}

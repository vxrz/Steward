import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Badge, Box, Button, Collapse, Group, Paper, Text, Title, UnstyledButton, type TitleOrder } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useLocation } from 'react-router-dom';
import { IconChevronDown } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { readPref, writePref } from './prefs';

/*
 * Folded sections (docs/reviews/UX-REVIEW.md, "v0.12.0: collapsible content"): secondary content folds, the main content stays open.
 * A section opens by itself for an error, the target of a link (#id) and while the page is printed; a choice the
 * user makes lasts for the page view, or – for sections that recur on many records – is remembered per user.
 */

// ---------- printing: everything opens ----------

let printing = false;
const printListeners = new Set<() => void>();
let printMedia: MediaQueryList | null = null;

function setPrinting(on: boolean) {
  if (printing === on) return;
  printing = on;
  // rendered before the browser lays out the printed pages
  flushSync(() => printListeners.forEach((l) => l()));
}
const onBeforePrint = () => setPrinting(true);
const onAfterPrint = () => setPrinting(false);
const onPrintMedia = (e: MediaQueryListEvent) => setPrinting(e.matches);

function subscribePrinting(listener: () => void) {
  printListeners.add(listener);
  if (printListeners.size === 1 && typeof window !== 'undefined') {
    window.addEventListener('beforeprint', onBeforePrint);
    window.addEventListener('afterprint', onAfterPrint);
    printMedia = window.matchMedia?.('print') ?? null;
    printMedia?.addEventListener?.('change', onPrintMedia);
    if (printMedia?.matches) printing = true;
  }
  return () => {
    printListeners.delete(listener);
    if (printListeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
      printMedia?.removeEventListener?.('change', onPrintMedia);
      printMedia = null;
    }
  };
}

/** True while the page is printed (or saved as PDF): folded sections and shortened lists show everything. */
export function usePrinting(): boolean {
  return useSyncExternalStore(
    subscribePrinting,
    () => printing,
    () => false,
  );
}

// ---------- a group of sections: Expand all / Collapse all ----------

interface GroupMember {
  /** `persist` false: Expand all / Collapse all change the view, not the remembered choices */
  setOpen: (open: boolean, persist?: boolean) => void;
}
interface GroupApi {
  register: (id: string, member: GroupMember) => () => void;
  count: number;
  setAll: (open: boolean) => void;
  /** Sections without their own `remember` remember the user's choice under `section.<scope>.<id>` */
  rememberScope?: string;
}
const GroupContext = createContext<GroupApi | null>(null);

/**
 * Sections of one page (or one tree): registers them and offers "Expand all" / "Collapse all" once there are
 * `min` or more (long pages, rule 6). `controls="none"`: the buttons are placed with <SectionGroupControls />.
 * `rememberScope` (the kind of page, never a record id): the user's choice per section is remembered for every
 * page of that kind. Shared panels (`onlyInGroup`) fold only inside a group; elsewhere (tabs) they stay open.
 */
export function SectionGroup({
  children,
  min = 5,
  controls = 'top',
  rememberScope,
}: {
  children: ReactNode;
  min?: number;
  controls?: 'top' | 'none';
  rememberScope?: string;
}) {
  const members = useRef(new Map<string, GroupMember>());
  const [count, setCount] = useState(0);
  const register = useCallback((id: string, member: GroupMember) => {
    members.current.set(id, member);
    setCount(members.current.size);
    return () => {
      if (members.current.get(id) === member) members.current.delete(id);
      setCount(members.current.size);
    };
  }, []);
  const setAll = useCallback((open: boolean) => {
    for (const m of members.current.values()) m.setOpen(open, false);
  }, []);
  const api = useMemo(() => ({ register, count, setAll, rememberScope }), [register, count, setAll, rememberScope]);
  return (
    <GroupContext.Provider value={api}>
      {controls === 'top' && count >= min && <SectionGroupControls mb="xs" />}
      {children}
    </GroupContext.Provider>
  );
}

/** The "Expand all" / "Collapse all" buttons of the surrounding <SectionGroup>. */
export function SectionGroupControls({ mb, min = 1 }: { mb?: string; min?: number }) {
  const { t } = useTranslation('common');
  const group = useContext(GroupContext);
  if (!group || group.count < min) return null;
  return (
    <Group gap={4} justify="flex-end" mb={mb} className="sm-no-print" data-testid="section-controls">
      <Button size="compact-sm" variant="subtle" color="gray" onClick={() => group.setAll(true)} data-testid="sections-expand-all">
        {t('sections.expandAll')}
      </Button>
      <Button size="compact-sm" variant="subtle" color="gray" onClick={() => group.setAll(false)} data-testid="sections-collapse-all">
        {t('sections.collapseAll')}
      </Button>
    </Group>
  );
}

/** Joins the surrounding <SectionGroup> (if any; not with an empty id), so "Expand all" / "Collapse all" reach this part. */
export function useSectionGroupMember(id: string, setOpen: (open: boolean, persist?: boolean) => void) {
  const group = useContext(GroupContext);
  const register = group?.register;
  const ref = useRef(setOpen);
  useEffect(() => {
    ref.current = setOpen;
  });
  useEffect(() => (id && register ? register(id, { setOpen: (o, persist) => ref.current(o, persist) }) : undefined), [register, id]);
}

// ---------- the state of one folded part ----------

/** Whether `now` (comma-separated ids) holds an id that `seen` (the ids when the part was folded) did not. */
function hasNew(seen: string | null, now: string | undefined): boolean {
  if (!now) return false;
  const before = new Set((seen ?? '').split(','));
  return now.split(',').some((id) => id && !before.has(id));
}

export interface CollapsibleOptions {
  /** The element id: a link to `#<id>` opens the part */
  id: string;
  /** Open while the user has not chosen; a function is asked on every render (items added, errors gone) */
  defaultOpen: boolean | (() => boolean);
  /** Opens the part whenever it becomes true (an error, a search hit, the path to the selected node) */
  forceOpen?: boolean;
  /**
   * Pref name under which the user's choice is remembered (sections that recur on many records only); default
   * inside a <SectionGroup rememberScope>: `section.<scope>.<id>`; false: never
   */
  remember?: string | false;
  /** With `remember`: where an older version kept the choice ("1" open, "0" folded) */
  rememberLegacyKey?: string;
  /**
   * With `remember`: what needs attention now, comma-separated ids (e.g. of failed checks); a folded part opens again
   * when an id appears that was not there when it was folded (fewer items keep it folded)
   */
  alertKey?: string;
  /** Takes part in the surrounding <SectionGroup> (default true) */
  inGroup?: boolean;
}

/**
 * Open or folded: the user's choice (this page view, or remembered), else forced open (error, #id, print), else the
 * default. Returns `open`, `setOpen` and `toggle`; also used by rows and toggles that are not a whole section.
 */
export function useCollapsible({ id, defaultOpen, forceOpen = false, remember: rememberOpt, rememberLegacyKey, alertKey, inGroup = true }: CollapsibleOptions) {
  const scope = useContext(GroupContext)?.rememberScope;
  const remember = rememberOpt === false ? undefined : (rememberOpt ?? (inGroup && scope ? `section.${scope}.${id}` : undefined));
  const { hash } = useLocation();
  const isPrinting = usePrinting();
  const hashHit = hash === `#${id}`;
  const forced = forceOpen || hashHit;
  const [choice, setChoice] = useState<boolean | null>(() => {
    if (forced || !remember) return null;
    const stored = readPref(remember, rememberLegacyKey);
    if (stored === '1') return true;
    if (stored !== '0') return null;
    // folded earlier: stays folded unless something new needs attention
    return hasNew(readPref(`${remember}.seen`), alertKey) ? null : false;
  });
  // remembered as folded: opens again once what needs attention differs from what was there when it was folded
  const [prevAlert, setPrevAlert] = useState(alertKey);
  if (alertKey !== prevAlert) {
    setPrevAlert(alertKey);
    if (remember && choice === false && hasNew(readPref(`${remember}.seen`), alertKey)) setChoice(null);
  }
  // forced open again whenever the reason appears (a new error, another link to it)
  const [wasForced, setWasForced] = useState(forced);
  if (forced !== wasForced) {
    setWasForced(forced);
    if (forced) setChoice(null);
  }
  const base = typeof defaultOpen === 'function' ? defaultOpen() : defaultOpen;
  const open = isPrinting || (choice ?? (forced || base));
  const setOpen = useCallback(
    (o: boolean, persist = true) => {
      setChoice(o);
      if (remember && persist) {
        writePref(remember, o ? '1' : '0');
        if (alertKey !== undefined) writePref(`${remember}.seen`, o ? null : alertKey);
      }
    },
    [remember, alertKey],
  );
  useSectionGroupMember(inGroup ? id : '', setOpen);
  // the target of a link: in view once it is open (the browser could not scroll to it before the data came)
  useEffect(() => {
    if (!hashHit) return;
    const el = document.getElementById(id);
    el?.scrollIntoView?.({ block: 'start' });
  }, [hashHit, id]);
  return { open, setOpen, toggle: () => setOpen(!open), printing: isPrinting };
}

// ---------- the section ----------

export interface CollapsibleSectionProps extends Omit<CollapsibleOptions, 'defaultOpen'> {
  title: ReactNode;
  /** Heading level: 2 for a section of the page, 3 for a part of a section */
  order?: 2 | 3 | 4;
  /** Visual size of the heading (default: h4 for level 2, h5 below) */
  size?: TitleOrder | `h${TitleOrder}`;
  /** Number of items, shown beside the title */
  count?: number | string;
  /** What else the folded header tells (status badges, "42 points · 3 groups"); shown beside the toggle */
  summary?: ReactNode;
  /** An error opens the section and colours the count; a warning only colours it */
  tone?: 'error' | 'warning';
  /** Default: open (true) */
  defaultOpen?: boolean | (() => boolean);
  /** Folded by default on phones (below 48em): sections with secondary lists (rule 8) */
  collapseOnPhone?: boolean;
  /** Buttons (Add, menus): beside the heading, outside the toggle */
  actions?: ReactNode;
  /** A help line under the header, shown while open */
  description?: ReactNode;
  icon?: ReactNode;
  /** `card`: in a bordered box (dashboard cards, interface cards) */
  variant?: 'plain' | 'card';
  /** Base of the test ids (default `section-<id>`): `<base>`, `<base>-toggle`, `<base>-body` */
  testId?: string;
  /** A panel shared with tabbed pages: folds only inside a <SectionGroup>, elsewhere a plain heading and its content */
  onlyInGroup?: boolean;
  children: ReactNode;
}

/**
 * A section with a real heading whose button folds it (aria-expanded, aria-controls), count and status in the header,
 * actions outside the toggle. Test ids: `section-<id>`, `section-<id>-toggle`, `section-<id>-body`.
 */
export function CollapsibleSection({
  id,
  title,
  order = 2,
  size,
  count,
  summary,
  tone,
  defaultOpen = true,
  collapseOnPhone,
  forceOpen,
  remember,
  rememberLegacyKey,
  alertKey,
  inGroup,
  actions,
  description,
  icon,
  variant = 'plain',
  testId = `section-${id}`,
  onlyInGroup,
  children,
}: CollapsibleSectionProps) {
  const narrow = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false });
  const group = useContext(GroupContext);
  const isStatic = !!onlyInGroup && !group;
  const state = useCollapsible({
    id,
    defaultOpen: () => (collapseOnPhone && narrow ? false : typeof defaultOpen === 'function' ? defaultOpen() : defaultOpen),
    forceOpen: forceOpen || tone === 'error',
    remember: isStatic ? false : remember,
    rememberLegacyKey,
    alertKey,
    inGroup: !isStatic && inGroup,
  });
  const open = isStatic || state.open;
  const { toggle, printing: isPrinting } = state;
  const bodyId = `${id}-body`;
  const countColor = tone === 'error' ? 'red' : tone === 'warning' ? 'orange' : 'gray';
  const label = (
    <>
      {icon}
      <span id={`${id}-title`}>{title}</span>
      {count !== undefined && (
        <Badge component="span" size="sm" variant={tone ? 'light' : 'default'} color={countColor} radius="sm" className="sm-section-count">
          {count}
        </Badge>
      )}
    </>
  );
  const header = (
    <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
      <Group gap={6} wrap="wrap" align="center" style={{ minWidth: 0, flex: 1, rowGap: 2 }}>
        <Title order={order} size={size ?? (order === 2 ? 'h4' : 'h5')} style={{ minWidth: 0 }}>
          {isStatic ? (
            <span className="sm-section-label">{label}</span>
          ) : (
            <UnstyledButton onClick={toggle} aria-expanded={open} aria-controls={bodyId} className="sm-section-toggle" data-testid={`${testId}-toggle`}>
              <IconChevronDown size={16} aria-hidden className="sm-section-chevron" data-open={open} />
              {label}
            </UnstyledButton>
          )}
        </Title>
        {summary}
      </Group>
      {actions && (
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          {actions}
        </Group>
      )}
    </Group>
  );
  const content = (
    <Box pt="xs">
      {description && (
        <Text size="xs" c="dimmed" mb="xs">
          {description}
        </Text>
      )}
      {children}
    </Box>
  );
  const body = isStatic ? (
    <div id={bodyId} data-testid={`${testId}-body`}>
      {content}
    </div>
  ) : (
    // display:none while folded: dialogs opened from inside (portals) still show
    <Collapse expanded={open} id={bodyId} data-testid={`${testId}-body`} transitionDuration={isPrinting ? 0 : 150} keepMountedMode="display-none">
      {content}
    </Collapse>
  );
  const props = {
    component: 'section' as const,
    id,
    'aria-labelledby': `${id}-title`,
    'data-testid': testId,
    'data-open': open,
    className: 'sm-section',
  };
  return variant === 'card' ? (
    <Paper withBorder p="md" {...props}>
      {header}
      {body}
    </Paper>
  ) : (
    <Box {...props}>
      {header}
      {body}
    </Box>
  );
}

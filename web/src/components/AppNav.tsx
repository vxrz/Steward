import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionIcon, Badge, Box, Collapse, Divider, Group, Indicator, NavLink, ScrollArea, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import {
  IconActivity,
  IconApps,
  IconArrowsDiff,
  IconBrandGit,
  IconBroadcast,
  IconBuildingFactory2,
  IconCalendarCheck,
  IconCalendarTime,
  IconChartBar,
  IconChecklist,
  IconChevronDown,
  IconFileCertificate,
  IconFileImport,
  IconGauge,
  IconHeartRateMonitor,
  IconInbox,
  IconKey,
  IconLayoutDashboard,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPackageExport,
  IconPin,
  IconPinFilled,
  IconPlayerPlay,
  IconReportAnalytics,
  IconRobot,
  IconServer,
  IconServer2,
  IconSettings,
  IconShieldCheck,
  IconSitemap,
  IconStack2,
  IconTicket,
  IconTool,
  IconEngine,
  IconUserSearch,
  IconUserShield,
  IconUsers,
  IconWebhook,
  type Icon,
} from '@tabler/icons-react';
import type { Capabilities } from '@sm/shared';
import { useOwnLabel } from './plant/labels';

export type NavKey =
  | 'dashboard'
  | 'dashboards'
  | 'tasks'
  | 'mcpRequests'
  | 'runs'
  | 'processes'
  | 'schedules'
  | 'triggers'
  | 'gitUpdates'
  | 'monitors'
  | 'platforms'
  | 'records'
  | 'services'
  | 'applications'
  | 'systems'
  | 'maintenance'
  | 'statusPages'
  | 'duties'
  | 'scorecard'
  | 'credentials'
  | 'tickets'
  | 'reports'
  | 'controls'
  | 'accessChanges'
  | 'reconciliation'
  | 'personReviews'
  | 'evidencePacks'
  | 'audit'
  | 'users'
  | 'settings'
  | 'systemStatus'
  | 'plantSites'
  | 'plantAssets'
  | 'plantImport';
/** The areas of the sidebar (v0.4.0): Home has no heading; Plant only while its module is on (#218). */
export type NavGroupKey = 'home' | 'operate' | 'automate' | 'catalogue' | 'plant' | 'compliance' | 'admin';

interface NavItemDef {
  to: string;
  key: NavKey;
  icon: Icon;
  cap?: keyof Capabilities;
  /** Shown only when this holds: pages of no use to the user's roles are left out (the address still works) */
  when?: (caps: Capabilities) => boolean;
  /** Further addresses that belong to the entry (pages reached through its tabs) */
  also?: string[];
}

// The server leaves these out for API clients and older sessions: then the entry shows.
const automation = (c: Capabilities) => c.viewAutomation !== false;
const credentialsRegister = (c: Capabilities) => c.viewCredentials !== false;
// the plant registry module (#218): only while it is on
const plant = (c: Capabilities) => c.plant === true;

/**
 * Processes, Schedules, Triggers and Git sync: one sidebar entry ("Processes"), the others are tabs of it
 * (components/page/SectionTabs.tsx). The addresses stay as they were.
 */
export const AUTOMATE_TABS: NavItemDef[] = [
  { to: '/processes', key: 'processes', icon: IconSitemap },
  { to: '/schedules', key: 'schedules', icon: IconCalendarTime, when: automation },
  { to: '/triggers', key: 'triggers', icon: IconWebhook, when: automation },
  { to: '/git-updates', key: 'gitUpdates', icon: IconBrandGit, cap: 'createProcesses' },
];

/**
 * The sidebar in six areas, ordered by how often a service team needs them: Home, day-to-day operation,
 * automation, the catalogue around the services, compliance and finally administration.
 */
export const NAV_GROUPS: { key: NavGroupKey; items: NavItemDef[] }[] = [
  { key: 'home', items: [{ to: '/', key: 'dashboard', icon: IconLayoutDashboard }] },
  {
    key: 'operate',
    items: [
      { to: '/runs', key: 'runs', icon: IconPlayerPlay },
      { to: '/monitors', key: 'monitors', icon: IconHeartRateMonitor },
      { to: '/dashboards', key: 'dashboards', icon: IconChartBar },
      { to: '/status-pages', key: 'statusPages', icon: IconBroadcast },
      { to: '/reports', key: 'reports', icon: IconReportAnalytics },
      { to: '/tasks', key: 'tasks', icon: IconInbox },
      { to: '/mcp-requests', key: 'mcpRequests', icon: IconRobot },
    ],
  },
  {
    key: 'automate',
    items: [{ to: '/processes', key: 'processes', icon: IconSitemap, also: ['/schedules', '/triggers', '/git-updates'] }],
  },
  {
    key: 'catalogue',
    items: [
      { to: '/services', key: 'services', icon: IconStack2 },
      { to: '/applications', key: 'applications', icon: IconApps },
      { to: '/systems', key: 'systems', icon: IconServer2 },
      { to: '/platforms', key: 'platforms', icon: IconServer },
      { to: '/credentials', key: 'credentials', icon: IconKey, when: credentialsRegister },
      { to: '/records', key: 'records', icon: IconFileCertificate },
      { to: '/tickets', key: 'tickets', icon: IconTicket },
      { to: '/duties', key: 'duties', icon: IconCalendarCheck },
      { to: '/scorecard', key: 'scorecard', icon: IconGauge },
      { to: '/maintenance', key: 'maintenance', icon: IconTool },
    ],
  },
  {
    key: 'plant',
    items: [
      { to: '/plant/sites', key: 'plantSites', icon: IconBuildingFactory2, when: plant },
      { to: '/plant/assets', key: 'plantAssets', icon: IconEngine, when: plant },
      { to: '/plant/import', key: 'plantImport', icon: IconFileImport, when: (c) => plant(c) && c.plantManage === true },
    ],
  },
  {
    key: 'compliance',
    items: [
      { to: '/compliance/controls', key: 'controls', icon: IconChecklist },
      { to: '/compliance/access-changes', key: 'accessChanges', icon: IconUserShield },
      { to: '/compliance/reconciliation', key: 'reconciliation', icon: IconArrowsDiff },
      { to: '/compliance/person-reviews', key: 'personReviews', icon: IconUserSearch },
      { to: '/compliance/evidence-packs', key: 'evidencePacks', icon: IconPackageExport, cap: 'exportEvidence' },
    ],
  },
  {
    key: 'admin',
    items: [
      { to: '/users', key: 'users', icon: IconUsers, cap: 'manageUsers' },
      { to: '/audit', key: 'audit', icon: IconShieldCheck, cap: 'viewAudit' },
      { to: '/settings', key: 'settings', icon: IconSettings, cap: 'manageSettings' },
      { to: '/settings/status', key: 'systemStatus', icon: IconActivity, cap: 'viewAudit' },
    ],
  },
];

/** Where each page of the sidebar (and each tab page of an entry) lives: breadcrumbs link by key. */
export const NAV_PATHS = Object.fromEntries([...NAV_GROUPS.flatMap((g) => g.items), ...AUTOMATE_TABS].map((i) => [i.key, i.to])) as Record<NavKey, string>;

export interface NavEntry {
  to: string;
  key: NavKey;
  icon: Icon;
  label: string;
  /** Area heading (empty for Home) */
  group: string;
  also?: string[];
}

const visible = (caps: Capabilities) => (n: NavItemDef) => (!n.cap || caps[n.cap]) && (!n.when || n.when(caps));

/** The areas and pages the user may see, with translated labels. */
export function useNavGroups(caps: Capabilities): { key: NavGroupKey; label: string; items: NavEntry[] }[] {
  const { t } = useTranslation('nav');
  // the plant registry's own display names (Settings → Modules): "Machines" instead of "Assets"
  const own = useOwnLabel(caps.plant === true);
  // Memoised: the command palette rebuilds its actions when this changes.
  return useMemo(
    () =>
      NAV_GROUPS.map((g) => {
        const label = g.key === 'home' ? '' : t(`groups.${g.key}`);
        const itemLabel = (key: NavKey) =>
          key === 'plantSites'
            ? own('site', true, t('items.plantSites'))
            : key === 'plantAssets'
              ? own('asset', true, t('items.plantAssets'))
              : t(`items.${key}`);
        return {
          key: g.key,
          label,
          items: g.items.filter(visible(caps)).map((n) => ({ to: n.to, key: n.key, icon: n.icon, label: itemLabel(n.key), group: label, also: n.also })),
        };
      }).filter((g) => g.items.length > 0),
    [t, caps, own],
  );
}

/** The tabs of the Automate area the user may see (Processes, Schedules, Triggers, Git sync). */
export function useAutomateTabs(caps: Capabilities): NavEntry[] {
  const { t } = useTranslation('nav');
  return useMemo(
    () => AUTOMATE_TABS.filter(visible(caps)).map((n) => ({ to: n.to, key: n.key, icon: n.icon, label: t(`items.${n.key}`), group: t('groups.automate') })),
    [t, caps],
  );
}

const matches = (to: string, pathname: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));

/** The entry of the current page: the longest matching address wins (System status over Settings). */
export function activeNavEntry<T extends { to: string; also?: string[] }>(entries: T[], pathname: string): T | undefined {
  let best: T | undefined;
  let len = -1;
  for (const e of entries) {
    for (const to of [e.to, ...(e.also ?? [])]) {
      if (matches(to, pathname) && to.length > len) {
        best = e;
        len = to.length;
      }
    }
  }
  return best;
}

/** Kept for callers that test one address. */
export const isNavActive = matches;

// ---------- remembered per user in this browser ----------

const read = <T,>(key: string, fallback: T, ok: (v: unknown) => boolean): T => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    return ok(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked: the choice lasts for this page view */
  }
};

const pinsKey = (userId: string) => `sm.nav.pins.${userId}`;
const groupsKey = (userId: string) => `sm.nav.groups.${userId}`;

/** The pinned sidebar entries (their addresses) of a user, in the order they were pinned. */
export function usePins(userId: string): [string[], (to: string) => void] {
  const [pins, setPins] = useState<string[]>(() => read(pinsKey(userId), [], (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')));
  const toggle = (to: string) => {
    const next = pins.includes(to) ? pins.filter((p) => p !== to) : [...pins, to];
    setPins(next);
    write(pinsKey(userId), next);
  };
  return [pins, toggle];
}

type GroupState = Partial<Record<NavGroupKey, boolean>>;

/**
 * Sidebar content: Home, the pinned entries, the areas with collapsible headings and the open-task badge,
 * and – on wide screens – a narrow icon-only mode (`rail`). An area opens when it holds the current page;
 * the user's own choice to open or close an area is remembered until they navigate into it again.
 */
export function AppNav({
  caps,
  userId,
  pathname,
  openTasks,
  rail,
  onToggleRail,
  onNavigate,
}: {
  caps: Capabilities;
  userId: string;
  pathname: string;
  openTasks: number;
  rail: boolean;
  onToggleRail?: () => void;
  onNavigate: () => void;
}) {
  const { t } = useTranslation('nav');
  const groups = useNavGroups(caps);
  const all = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const active = activeNavEntry(all, pathname);
  const activeGroup = groups.find((g) => g.items.includes(active!))?.key;
  const [pins, togglePin] = usePins(userId);
  const pinned = pins.map((to) => all.find((n) => n.to === to)).filter((n): n is NavEntry => !!n);
  const [state, setState] = useState<GroupState>(() => read(groupsKey(userId), {}, (v) => !!v && typeof v === 'object' && !Array.isArray(v)));
  const save = (next: GroupState) => {
    setState(next);
    write(groupsKey(userId), next);
  };
  // the area of the page opens whenever the user gets there (also after they folded it on an earlier visit)
  useEffect(() => {
    if (!activeGroup) return;
    setState((s) => {
      if (s[activeGroup] !== false) return s;
      const next = { ...s };
      delete next[activeGroup];
      write(groupsKey(userId), next);
      return next;
    });
  }, [activeGroup, userId]);
  const isOpen = (key: NavGroupKey) => state[key] ?? key === activeGroup;
  const toggle = (key: NavGroupKey) => save({ ...state, [key]: !isOpen(key) });

  const link = (n: NavEntry, where: 'pinned' | 'group') => {
    const badge = n.key === 'tasks' && openTasks > 0 ? openTasks : 0;
    const isActive = n === active;
    if (rail) {
      return (
        <Tooltip key={`${where}:${n.to}`} label={badge ? `${n.label} (${badge})` : n.label} position="right" withArrow>
          <NavLink
            component={Link}
            to={n.to}
            aria-label={n.label}
            active={isActive}
            aria-current={isActive ? 'page' : undefined}
            onClick={onNavigate}
            leftSection={
              <Indicator disabled={!badge} size={8} color="accent" offset={2}>
                <n.icon size={20} stroke={1.6} />
              </Indicator>
            }
            // only the icon: no label area beside it, so the icon sits in the middle of the rail
            styles={{ section: { marginInlineEnd: 0 }, body: { display: 'none' }, root: { justifyContent: 'center', paddingInline: 0 } }}
            style={{ borderRadius: 'var(--mantine-radius-default)' }}
          />
        </Tooltip>
      );
    }
    const isPinned = pins.includes(n.to);
    const pinLabel = isPinned ? t('unpin', { page: n.label }) : t('pin', { page: n.label });
    return (
      <Box key={`${where}:${n.to}`} className="nav-entry" data-pinned={isPinned || undefined} pos="relative">
        <NavLink
          component={Link}
          to={n.to}
          label={n.label}
          leftSection={<n.icon size={18} stroke={1.6} />}
          active={isActive}
          aria-current={isActive ? 'page' : undefined}
          rightSection={
            badge ? (
              <Badge size="sm" color="accent" circle mr={26}>
                {badge}
              </Badge>
            ) : undefined
          }
          onClick={onNavigate}
          py={6}
          pr={34}
          style={{ borderRadius: 'var(--mantine-radius-default)' }}
        />
        <Tooltip label={pinLabel} position="right" withArrow openDelay={400}>
          <ActionIcon
            className="nav-pin"
            variant="subtle"
            color="gray"
            size="sm"
            aria-label={pinLabel}
            aria-pressed={isPinned}
            onClick={() => togglePin(n.to)}
            style={{ position: 'absolute', insetInlineEnd: 6, top: '50%', transform: 'translateY(-50%)' }}
          >
            {isPinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
          </ActionIcon>
        </Tooltip>
      </Box>
    );
  };

  const heading = (id: string, label: string, open: boolean, onToggle: () => void) => (
    <UnstyledButton
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={id}
      w="100%"
      px="sm"
      py={3}
      // 28 px high: a comfortable target (WCAG 2.2, 2.5.8)
      mih={28}
      style={{ borderRadius: 'var(--mantine-radius-default)' }}
      className="nav-group-toggle"
    >
      <Group justify="space-between" wrap="nowrap">
        <Text id={`${id}-label`} size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: 0.4 }}>
          {label}
        </Text>
        <IconChevronDown
          size={14}
          color="var(--mantine-color-dimmed)"
          aria-hidden
          style={{ transform: open ? undefined : 'rotate(-90deg)', transition: 'transform 150ms ease' }}
        />
      </Group>
    </UnstyledButton>
  );

  const home = groups.find((g) => g.key === 'home');
  const areas = groups.filter((g) => g.key !== 'home');

  return (
    <>
      <ScrollArea style={{ flex: 1 }} type="scroll">
        {home && <Box>{home.items.map((n) => link(n, 'group'))}</Box>}
        {pinned.length > 0 &&
          (rail ? (
            <Box role="group" aria-label={t('pinned')} data-testid="nav-pinned">
              <Divider my={6} />
              {pinned.map((n) => link(n, 'pinned'))}
            </Box>
          ) : (
            <Box role="group" aria-labelledby="nav-group-pinned-label" mt={6} data-testid="nav-pinned">
              <Text id="nav-group-pinned-label" size="xs" fw={700} tt="uppercase" c="dimmed" px="sm" py={5} style={{ letterSpacing: 0.4 }}>
                {t('pinned')}
              </Text>
              {pinned.map((n) => link(n, 'pinned'))}
            </Box>
          ))}
        {areas.map((g) => {
          if (rail) {
            return (
              <Box key={g.key} role="group" aria-label={g.label}>
                <Divider my={6} />
                {g.items.map((n) => link(n, 'group'))}
              </Box>
            );
          }
          const open = isOpen(g.key);
          const id = `nav-group-${g.key}`;
          const key = g.key;
          return (
            <Box key={g.key} role="group" aria-labelledby={`${id}-label`} mt={6} data-group={g.key}>
              {heading(id, g.label, open, () => toggle(key))}
              <Collapse expanded={open} id={id}>
                {g.items.map((n) => link(n, 'group'))}
              </Collapse>
            </Box>
          );
        })}
      </ScrollArea>
      {onToggleRail && (
        <Box
          visibleFrom="sm"
          pt={4}
          style={{ borderTop: '1px solid var(--mantine-color-default-border)', display: 'flex', justifyContent: rail ? 'center' : 'flex-start' }}
        >
          <Tooltip label={rail ? t('expandSidebar') : t('collapseSidebar')} position="right" withArrow>
            <ActionIcon variant="subtle" color="gray" onClick={onToggleRail} aria-label={rail ? t('expandSidebar') : t('collapseSidebar')} size="md">
              {rail ? <IconLayoutSidebarLeftExpand size={18} /> : <IconLayoutSidebarLeftCollapse size={18} />}
            </ActionIcon>
          </Tooltip>
        </Box>
      )}
    </>
  );
}

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionIcon, Badge, Box, Collapse, Divider, Group, Indicator, NavLink, ScrollArea, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import {
  IconArrowsDiff,
  IconCalendarTime,
  IconChecklist,
  IconChartBar,
  IconChevronDown,
  IconFileCertificate,
  IconHeartRateMonitor,
  IconInbox,
  IconKey,
  IconLayoutDashboard,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconPackageExport,
  IconPlayerPlay,
  IconReportAnalytics,
  IconServer,
  IconSettings,
  IconShieldCheck,
  IconSitemap,
  IconStack2,
  IconUserShield,
  IconUsers,
  IconWebhook,
  type Icon,
} from '@tabler/icons-react';
import type { Capabilities } from '@sm/shared';

export type NavKey =
  | 'dashboard'
  | 'dashboards'
  | 'tasks'
  | 'runs'
  | 'processes'
  | 'schedules'
  | 'triggers'
  | 'monitors'
  | 'platforms'
  | 'records'
  | 'services'
  | 'credentials'
  | 'reports'
  | 'controls'
  | 'accessChanges'
  | 'reconciliation'
  | 'evidencePacks'
  | 'audit'
  | 'users'
  | 'settings';
export type NavGroupKey = 'operate' | 'automate' | 'service' | 'compliance' | 'admin';

interface NavItemDef {
  to: string;
  key: NavKey;
  icon: Icon;
  cap?: keyof Capabilities;
}

/**
 * The sidebar in sections, ordered by how often a service team needs them: the start page and the
 * own tasks first, then day-to-day operation, automation, the service management registers and
 * finally administration. A section without a key has no heading.
 */
export const NAV_GROUPS: { key: NavGroupKey | null; items: NavItemDef[] }[] = [
  {
    key: null,
    items: [
      { to: '/', key: 'dashboard', icon: IconLayoutDashboard },
      { to: '/tasks', key: 'tasks', icon: IconInbox },
    ],
  },
  {
    key: 'operate',
    items: [
      { to: '/runs', key: 'runs', icon: IconPlayerPlay },
      { to: '/monitors', key: 'monitors', icon: IconHeartRateMonitor },
      { to: '/dashboards', key: 'dashboards', icon: IconChartBar },
    ],
  },
  {
    key: 'automate',
    items: [
      { to: '/processes', key: 'processes', icon: IconSitemap },
      { to: '/schedules', key: 'schedules', icon: IconCalendarTime },
      { to: '/triggers', key: 'triggers', icon: IconWebhook },
    ],
  },
  {
    key: 'service',
    items: [
      { to: '/services', key: 'services', icon: IconStack2 },
      { to: '/platforms', key: 'platforms', icon: IconServer },
      { to: '/credentials', key: 'credentials', icon: IconKey },
      { to: '/records', key: 'records', icon: IconFileCertificate },
      { to: '/reports', key: 'reports', icon: IconReportAnalytics },
    ],
  },
  {
    key: 'compliance',
    items: [
      { to: '/compliance/controls', key: 'controls', icon: IconChecklist },
      { to: '/compliance/access-changes', key: 'accessChanges', icon: IconUserShield },
      { to: '/compliance/reconciliation', key: 'reconciliation', icon: IconArrowsDiff },
      { to: '/compliance/evidence-packs', key: 'evidencePacks', icon: IconPackageExport, cap: 'exportEvidence' },
    ],
  },
  {
    key: 'admin',
    items: [
      { to: '/audit', key: 'audit', icon: IconShieldCheck, cap: 'viewAudit' },
      { to: '/users', key: 'users', icon: IconUsers, cap: 'manageUsers' },
      { to: '/settings', key: 'settings', icon: IconSettings },
    ],
  },
];

export interface NavEntry {
  to: string;
  key: NavKey;
  icon: Icon;
  label: string;
  /** Section heading (empty for the top section) */
  group: string;
}

/** The sections and pages the user may see, with translated labels. */
export function useNavGroups(caps: Capabilities): { key: NavGroupKey | null; label: string; items: NavEntry[] }[] {
  const { t } = useTranslation('nav');
  // Memoised: the command palette rebuilds its actions when this changes.
  return useMemo(
    () =>
      NAV_GROUPS.map((g) => {
        const label = g.key ? t(`groups.${g.key}`) : '';
        return {
          key: g.key,
          label,
          items: g.items.filter((n) => !n.cap || caps[n.cap]).map((n) => ({ to: n.to, key: n.key, icon: n.icon, label: t(`items.${n.key}`), group: label })),
        };
      }).filter((g) => g.items.length > 0),
    [t, caps],
  );
}

const COLLAPSED_KEY = 'sm.nav.collapsedGroups';
function readCollapsed(): NavGroupKey[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as NavGroupKey[]) : [];
  } catch {
    return [];
  }
}

export const isNavActive = (to: string, pathname: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));

/**
 * Sidebar content: sections with collapsible headings (remembered per browser), the open-task badge,
 * and – on wide screens – a narrow icon-only mode (`rail`).
 */
export function AppNav({
  caps,
  pathname,
  openTasks,
  rail,
  onToggleRail,
  onNavigate,
}: {
  caps: Capabilities;
  pathname: string;
  openTasks: number;
  rail: boolean;
  onToggleRail?: () => void;
  onNavigate: () => void;
}) {
  const { t } = useTranslation('nav');
  const groups = useNavGroups(caps);
  const [collapsed, setCollapsed] = useState<NavGroupKey[]>(readCollapsed);
  const toggle = (key: NavGroupKey) => {
    const next = collapsed.includes(key) ? collapsed.filter((k) => k !== key) : [...collapsed, key];
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: the choice lasts for this page view */
    }
  };

  const link = (n: NavEntry) => {
    const badge = n.key === 'tasks' && openTasks > 0 ? openTasks : 0;
    const active = isNavActive(n.to, pathname);
    if (rail) {
      return (
        <Tooltip key={n.to} label={badge ? `${n.label} (${badge})` : n.label} position="right" withArrow>
          <NavLink
            component={Link}
            to={n.to}
            aria-label={n.label}
            active={active}
            onClick={onNavigate}
            leftSection={
              <Indicator disabled={!badge} size={8} color="accent" offset={2}>
                <n.icon size={20} stroke={1.6} />
              </Indicator>
            }
            styles={{ section: { marginInlineEnd: 0 }, root: { justifyContent: 'center' } }}
            style={{ borderRadius: 'var(--mantine-radius-default)' }}
          />
        </Tooltip>
      );
    }
    return (
      <NavLink
        key={n.to}
        component={Link}
        to={n.to}
        label={n.label}
        leftSection={<n.icon size={18} stroke={1.6} />}
        active={active}
        rightSection={
          badge ? (
            <Badge size="sm" color="accent" circle>
              {badge}
            </Badge>
          ) : undefined
        }
        onClick={onNavigate}
        py={6}
        style={{ borderRadius: 'var(--mantine-radius-default)' }}
      />
    );
  };

  return (
    <>
      <ScrollArea style={{ flex: 1 }} type="scroll">
        {groups.map((g, gi) => {
          if (!g.key) return <Box key="top">{g.items.map(link)}</Box>;
          if (rail) {
            return (
              <Box key={g.key} role="group" aria-label={g.label}>
                <Divider my={6} />
                {g.items.map(link)}
              </Box>
            );
          }
          // A collapsed section still shows when it holds the current page.
          const open = !collapsed.includes(g.key) || g.items.some((n) => isNavActive(n.to, pathname));
          const id = `nav-group-${g.key}`;
          const key = g.key;
          return (
            <Box key={g.key} role="group" aria-labelledby={`${id}-label`} mt={gi === 0 ? 0 : 6}>
              <UnstyledButton
                onClick={() => toggle(key)}
                aria-expanded={open}
                aria-controls={id}
                w="100%"
                px="sm"
                py={3}
                style={{ borderRadius: 'var(--mantine-radius-default)' }}
                className="nav-group-toggle"
              >
                <Group justify="space-between" wrap="nowrap">
                  <Text id={`${id}-label`} size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: 0.4 }}>
                    {g.label}
                  </Text>
                  <IconChevronDown
                    size={14}
                    color="var(--mantine-color-dimmed)"
                    aria-hidden
                    style={{ transform: open ? undefined : 'rotate(-90deg)', transition: 'transform 150ms ease' }}
                  />
                </Group>
              </UnstyledButton>
              <Collapse in={open} id={id}>
                {g.items.map(link)}
              </Collapse>
            </Box>
          );
        })}
      </ScrollArea>
      {onToggleRail && (
        <Box visibleFrom="sm" pt={4} style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}>
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

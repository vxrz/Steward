import { lazy, Suspense, useMemo, useState } from 'react';
import { ActionIcon, Group, Kbd, Text, Tooltip, UnstyledButton, useMantineColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Spotlight, spotlight, type SpotlightActionData, type SpotlightActionGroupData, type SpotlightFilterFunction } from '@mantine/spotlight';
import '@mantine/spotlight/styles.css';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconActivity,
  IconSettings,
  IconArrowRight,
  IconCalendarPlus,
  IconChartBar,
  IconFileCertificate,
  IconHeartRateMonitor,
  IconInfoCircle,
  IconKey,
  IconLayoutGrid,
  IconLink,
  IconListDetails,
  IconStack2,
  IconMoon,
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconServer,
  IconSitemap,
  IconSun,
  IconTicket,
  IconUser,
  type Icon,
} from '@tabler/icons-react';
import type {
  Credential,
  Dashboard,
  MonitorSummary,
  Platform,
  ProcessDetail,
  ProcessSummary,
  RecordSummary,
  RunSummary,
  ServiceSummary,
  TicketList,
} from '@sm/shared';
import { get, notifyError, post } from '../api';
import { useMe } from '../auth';
import { fmtRelative } from '../format';
import { StatusBadge } from './common';
import { isMac } from './HelpMenu';

/** Settings the palette finds (#136): [area, translation key of its title]. */
const SETTING_ENTRIES: [string, string][] = [
  ['general', 'settings:language.title'],
  ['general', 'settings:browser.title'],
  ['security', 'settings:signIn.title'],
  ['security', 'settings:outbound.title'],
  ['security', 'settings:publicApi.title'],
  ['security', 'mcp:settings.title'],
  ['security', 'settings:vault.title'],
  ['security', 'settings:tokens.title'],
  ['integrations', 'tickets:settings.title'],
  ['integrations', 'gitSync:sources.title'],
  ['integrations', 'settings:migration.title'],
  ['integrations', 'settings:endOfLife.title'],
  ['notifications', 'settings:notify.title'],
  ['notifications', 'settings:look.title'],
  ['notifications', 'settings:dailySummary.title'],
  ['notifications', 'credentials:settings.title'],
  ['appearance', 'system:theme.title'],
  ['appearance', 'reports:branding.title'],
  ['catalogue', 'settings:compliance.title'],
  ['catalogue', 'applications:scale.title'],
  ['catalogue', 'scorecard:rules.title'],
  ['catalogue', 'applications:environments.title'],
  ['maintenance', 'settings:retention.title'],
  ['maintenance', 'settings:backups.title'],
];

const RunDialog = lazy(() => import('./RunDialog').then((m) => ({ default: m.RunDialog })));

export interface PalettePage {
  to: string;
  label: string;
  icon: Icon;
  /** Sidebar section, shown under the label */
  group?: string;
}

const PER_GROUP = 8;

/** First sentence, at most ~90 characters. */
const short = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  const first = text.split(/(?<=[.!?])\s/)[0]!;
  return first.length > 90 ? first.slice(0, 88).trimEnd() + '…' : first;
};

/** Every word of the query must appear in label, description or keywords. Empty query: only the groups not in `searchOnly` (pages, actions, recent runs). */
const makeFilter =
  (searchOnly: Set<string>): SpotlightFilterFunction =>
  (query, actions) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const groups = actions as SpotlightActionGroupData[];
    if (!words.length) return groups.filter((g) => !searchOnly.has(g.group));
    return groups
      .map((g) => ({
        ...g,
        actions: g.actions
          .filter((a) => {
            const hay = [a.label, g.group, ...(Array.isArray(a.keywords) ? a.keywords : [a.keywords])].join(' ').toLowerCase();
            return words.every((w) => hay.includes(w));
          })
          .slice(0, PER_GROUP),
      }))
      .filter((g) => g.actions.length > 0);
  };

/**
 * Ctrl/Cmd+K command palette: pages (with their sidebar section), quick "create" actions, recent runs and –
 * when searching – processes, dashboards, platforms, monitors, services, records and credentials.
 */
export function CommandPalette({ pages }: { pages: PalettePage[] }) {
  const { t } = useTranslation(['nav', 'common', 'settings']);
  const navigate = useNavigate();
  const { caps, isAdmin, hasRole } = useMe();
  const canEditServices = isAdmin || hasRole('designer');
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [active, setActive] = useState(false);
  const [runProcessId, setRunProcessId] = useState<string | null>(null);

  // Loaded the first time the palette opens, then kept fresh while it is open.
  const opts = { enabled: active, staleTime: 30_000 };
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes'), ...opts });
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: () => get<Dashboard[]>('/dashboards'), ...opts });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms'), ...opts });
  const runs = useQuery({ queryKey: ['runs', 'palette'], queryFn: () => get<RunSummary[]>('/runs?limit=10'), ...opts });
  const monitors = useQuery({ queryKey: ['monitors', 'palette'], queryFn: () => get<MonitorSummary[]>('/monitors'), ...opts });
  const services = useQuery({ queryKey: ['services', 'palette'], queryFn: () => get<ServiceSummary[]>('/services'), ...opts });
  const records = useQuery({ queryKey: ['records', 'palette'], queryFn: () => get<RecordSummary[]>('/records'), ...opts });
  const credentials = useQuery({
    queryKey: ['credentials', 'palette'],
    queryFn: () => get<{ items: Credential[]; canCreate: boolean }>('/credentials'),
    ...opts,
  });
  const tickets = useQuery({ queryKey: ['ticket-references', 'palette'], queryFn: () => get<TicketList>('/ticket-references?state=open'), ...opts });

  const actions = useMemo<SpotlightActionGroupData[]>(() => {
    const icon = (I: Icon) => <I size={18} stroke={1.6} />;
    const go = (to: string) => () => navigate(to);
    const extraPages: PalettePage[] = [
      { to: '/monitors/wall', label: t('palette.pages.monitorWall'), icon: IconLayoutGrid, group: t('groups.operate') },
      { to: '/records/types', label: t('palette.pages.recordTypes'), icon: IconListDetails, group: t('groups.service') },
      { to: '/records/link-types', label: t('palette.pages.linkTypes'), icon: IconLink, group: t('groups.service') },
      ...(caps.viewAudit ? [{ to: '/settings/status', label: t('palette.pages.systemStatus'), icon: IconActivity, group: t('groups.admin') }] : []),
      { to: '/profile', label: t('items.profile'), icon: IconUser },
      { to: '/about', label: t('palette.pages.about'), icon: IconInfoCircle },
    ];
    // individual settings (#136): administrators find them by name and land in their area
    // keys from several namespaces, listed below
    const tx = t as unknown as (key: string) => string;
    const settingActions: SpotlightActionData[] = caps.manageSettings
      ? SETTING_ENTRIES.map(([area, key]) => ({
          id: `setting:${area}:${key}`,
          label: tx(key),
          description: `${tx('settings:title')} · ${tx(`settings:areas.${area}.title`)}`,
          leftSection: icon(IconSettings),
          keywords: ['settings', tx('settings:title'), tx(`settings:areas.${area}.title`)],
          onClick: go(`/settings/${area}`),
        }))
      : [];
    const pageActions: SpotlightActionData[] = [...pages, ...extraPages].map((p) => ({
      id: `page:${p.to}`,
      label: p.label,
      description: p.group || undefined,
      leftSection: icon(p.icon),
      keywords: ['page', 'go', 'open', t('palette.keywords.page')],
      onClick: go(p.to),
    }));
    const quick: SpotlightActionData[] = [];
    if (caps.createProcesses) {
      quick.push({
        id: 'new-process',
        label: t('palette.newProcess'),
        description: t('palette.newProcessHint'),
        leftSection: icon(IconPlus),
        keywords: ['create', 'add', t('palette.keywords.create')],
        onClick: async () => {
          try {
            const p = await post<ProcessDetail>('/processes', {
              definition: {
                name: t('palette.newProcess'),
                description: '',
                connections: [],
                inputs: [],
                nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }],
                wires: [],
              },
            });
            navigate(`/processes/${p.id}`);
          } catch (e) {
            notifyError(e);
          }
        },
      });
    }
    // "New …" opens the page with its create dialog (?new=1); pages the user cannot create on ignore it.
    const create = (id: string, label: string, to: string, I: Icon) =>
      quick.push({ id, label, leftSection: icon(I), keywords: ['create', 'add', 'new', t('palette.keywords.create')], onClick: go(to) });
    if (caps.createMonitors) create('new-monitor', t('palette.create.monitor'), '/monitors/new', IconHeartRateMonitor);
    create('new-record', t('palette.create.record'), '/records?new=1', IconFileCertificate);
    if (credentials.data?.canCreate) create('new-credential', t('palette.create.credential'), '/credentials?new=1', IconKey);
    if (tickets.data?.canCreate) create('new-ticket', t('palette.create.ticket'), '/tickets?new=1', IconTicket);
    if (canEditServices) create('new-service', t('palette.create.service'), '/services?new=1', IconStack2);
    create('new-schedule', t('palette.create.schedule'), '/schedules?new=1', IconCalendarPlus);
    quick.push({
      id: 'toggle-theme',
      label: colorScheme === 'dark' ? t('palette.lightMode') : t('palette.darkMode'),
      description: t('palette.colorSchemeHint'),
      leftSection: icon(colorScheme === 'dark' ? IconSun : IconMoon),
      keywords: ['theme', 'dark', 'light', 'color', t('palette.keywords.theme')],
      onClick: () => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark'),
    });
    const procs = processes.data ?? [];
    return [
      { group: t('palette.groups.actions'), actions: quick },
      { group: t('palette.groups.pages'), actions: pageActions },
      { group: t('palette.groups.settings'), actions: settingActions },
      {
        group: t('palette.groups.recentRuns'),
        actions: (runs.data ?? []).slice(0, 6).map((r) => ({
          id: `run:${r.id}`,
          label: r.processName,
          description: t(r.dryRun ? 'palette.dryRunBy' : 'palette.runBy', { actor: r.actor, when: fmtRelative(r.startedAt) }),
          leftSection: icon(IconPlayerPlay),
          rightSection: <StatusBadge status={r.status} size="xs" />,
          keywords: ['run', r.status, r.id],
          onClick: go(`/runs/${r.id}`),
        })),
      },
      {
        group: t('palette.groups.processes'),
        actions: procs.map((p) => ({
          id: `process:${p.id}`,
          label: p.name,
          description: short(p.description),
          leftSection: icon(IconSitemap),
          keywords: ['process', ...p.tags],
          onClick: go(`/processes/${p.id}`),
        })),
      },
      {
        group: t('palette.groups.startRun'),
        actions: procs
          .filter((p) => p.permissions.includes('run'))
          .map((p) => ({
            id: `run-process:${p.id}`,
            label: t('palette.startRunOf', { name: p.name }),
            leftSection: icon(IconArrowRight),
            keywords: ['run', 'start', 'execute', ...p.tags],
            onClick: () => setRunProcessId(p.id),
          })),
      },
      {
        group: t('palette.groups.dashboards'),
        actions: (dashboards.data ?? []).map((d) => ({
          id: `dashboard:${d.id}`,
          label: d.name,
          description: short(d.description),
          leftSection: icon(IconChartBar),
          keywords: ['dashboard'],
          onClick: go(`/dashboards/${d.id}`),
        })),
      },
      {
        group: t('palette.groups.monitors'),
        actions: (monitors.data ?? [])
          .filter((m) => !m.isTemplate)
          .map((m) => ({
            id: `monitor:${m.id}`,
            label: m.name,
            description: short(m.description) ?? m.key,
            leftSection: icon(IconHeartRateMonitor),
            keywords: ['monitor', m.key, ...m.tags],
            onClick: go(`/monitors/${m.id}`),
          })),
      },
      {
        group: t('palette.groups.services'),
        actions: (services.data ?? []).map((sv) => ({
          id: `service:${sv.id}`,
          label: sv.name,
          leftSection: icon(IconStack2),
          keywords: ['service', ...sv.tags],
          onClick: go(`/services/${sv.id}`),
        })),
      },
      {
        group: t('palette.groups.records'),
        actions: (records.data ?? []).map((r) => ({
          id: `record:${r.id}`,
          label: `${r.number} ${r.title}`,
          description: r.typeName,
          leftSection: icon(IconFileCertificate),
          keywords: ['record', r.number, r.typeKey, r.status, ...r.tags],
          onClick: go(`/records/${r.id}`),
        })),
      },
      {
        group: t('palette.groups.credentials'),
        actions: (credentials.data?.items ?? []).map((c) => ({
          id: `credential:${c.id}`,
          label: c.name,
          description: c.platformName ?? undefined,
          leftSection: icon(IconKey),
          keywords: ['credential', c.type],
          onClick: go(`/credentials?open=${encodeURIComponent(c.id)}`),
        })),
      },
      {
        group: t('palette.groups.tickets'),
        actions: (tickets.data?.items ?? []).map((x) => ({
          id: `ticket:${x.id}`,
          label: `${x.externalNumber} ${x.title}`,
          description: x.vendor || undefined,
          leftSection: icon(IconTicket),
          keywords: ['ticket', 'incident', x.externalNumber, x.vendor, x.source],
          onClick: go(`/tickets/${x.id}`),
        })),
      },
      {
        group: t('palette.groups.platforms'),
        actions: (platforms.data ?? []).map((p) => ({
          id: `platform:${p.id}`,
          label: p.name,
          description: [p.kind, p.environment].filter(Boolean).join(' · '),
          leftSection: icon(IconServer),
          keywords: ['platform', p.kind, p.environment, p.baseUrl],
          onClick: go(`/platforms/${p.id}`),
        })),
      },
    ];
  }, [
    t,
    pages,
    caps.manageSettings,
    caps.createProcesses,
    caps.createMonitors,
    caps.viewAudit,
    canEditServices,
    colorScheme,
    setColorScheme,
    navigate,
    processes.data,
    runs.data,
    dashboards.data,
    platforms.data,
    monitors.data,
    services.data,
    records.data,
    credentials.data,
    tickets.data,
  ]);
  const filter = useMemo(
    () =>
      makeFilter(
        new Set(
          (['processes', 'startRun', 'dashboards', 'platforms', 'monitors', 'services', 'records', 'credentials', 'tickets'] as const).map((g) =>
            t(`palette.groups.${g}`),
          ),
        ),
      ),
    [t],
  );

  const loading = [processes, dashboards, platforms, runs, monitors, services, records, credentials].some((q) => q.isFetching);

  return (
    <>
      <Spotlight
        actions={actions}
        filter={filter}
        shortcut={['mod + K']}
        onSpotlightOpen={() => setActive(true)}
        nothingFound={loading ? t('common:loading') : t('palette.nothingFound')}
        highlightQuery
        scrollable
        maxHeight={isMobile ? 'calc(100dvh - 80px)' : 460}
        fullScreen={isMobile}
        searchProps={{ leftSection: <IconSearch size={18} stroke={1.6} />, placeholder: t('palette.placeholder'), 'aria-label': t('palette.search') }}
      />
      {runProcessId && (
        <Suspense fallback={null}>
          <RunDialog processId={runProcessId} opened={!!runProcessId} onClose={() => setRunProcessId(null)} />
        </Suspense>
      )}
    </>
  );
}

/** Header button that opens the palette (full search field on wide screens, icon on phones). */
export function CommandPaletteButton() {
  const { t } = useTranslation('nav');
  const shortcut = isMac ? '⌘ K' : 'Ctrl K';
  return (
    <>
      <Tooltip label={t('palette.searchWithShortcut', { shortcut })}>
        <ActionIcon variant="subtle" onClick={() => spotlight.open()} aria-label={t('palette.search')} hiddenFrom="sm">
          <IconSearch size={18} />
        </ActionIcon>
      </Tooltip>
      <UnstyledButton
        onClick={() => spotlight.open()}
        visibleFrom="sm"
        aria-label={t('palette.searchWithShortcut', { shortcut })}
        px="sm"
        h={32}
        w={240}
        style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8, background: 'var(--mantine-color-default)' }}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={6} wrap="nowrap">
            <IconSearch size={14} color="var(--mantine-color-dimmed)" />
            <Text size="sm" c="dimmed">
              {t('palette.searchButton')}
            </Text>
          </Group>
          <Kbd size="xs">{shortcut}</Kbd>
        </Group>
      </UnstyledButton>
    </>
  );
}

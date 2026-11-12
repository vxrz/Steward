import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ActionIcon, Group, Kbd, Text, Tooltip, UnstyledButton, useMantineColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Spotlight, spotlight, type SpotlightActionData, type SpotlightActionGroupData, type SpotlightFilterFunction } from '@mantine/spotlight';
import '@mantine/spotlight/styles.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconAlertTriangle,
  IconApps,
  IconHistory,
  IconKeyboard,
  IconPlugConnected,
  IconServer2,
  IconUserSearch,
  IconSettings,
  IconArrowRight,
  IconCalendarCheck,
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
  IconBuildingFactory2,
  IconEngine,
  IconCpu,
  IconGauge,
  IconContract,
  IconTruckDelivery,
} from '@tabler/icons-react';
import type {
  ApplicationSummary,
  Credential,
  Dashboard,
  MonitorSummary,
  Platform,
  ProcessDetail,
  ProcessSummary,
  RecordSummary,
  RunSummary,
  ServiceSummary,
  Subject,
  SystemSummary,
  TicketList,
  ModuleId,
} from '@sm/shared';
import { moduleOn } from '../modules';
import { get, notifyError, notifyOk, post } from '../api';
import { useMe } from '../auth';
import { fmtRelative } from '../format';
import { StatusBadge } from './common';
import { isMac, openShortcutSheet } from './HelpMenu';
import { dashboardKeys, monitorKeys, platformKeys, processKeys, runKeys } from '../queryKeys';
import { readRecent, rememberRecent, type RecentItem, type RecentKind } from './page/recent';

/** Icons of the recent entries by kind. */
/** Recent entries of a module's kinds (ADR 0016): left out while it is switched off. */
const RECENT_MODULES: Partial<Record<RecentKind, ModuleId>> = {
  statusPage: 'statusPages',
  personReview: 'compliance',
  contract: 'dataContracts',
  site: 'plant',
  asset: 'plant',
  profile: 'plant',
  kpi: 'plant',
};

const RECENT_ICONS: Record<RecentKind, Icon> = {
  run: IconPlayerPlay,
  process: IconSitemap,
  monitor: IconHeartRateMonitor,
  dashboard: IconChartBar,
  platform: IconServer,
  service: IconStack2,
  application: IconApps,
  system: IconServer2,
  record: IconFileCertificate,
  ticket: IconTicket,
  duty: IconCalendarCheck,
  personReview: IconUserSearch,
  statusPage: IconLayoutGrid,
  credential: IconKey,
  site: IconBuildingFactory2,
  asset: IconEngine,
  profile: IconCpu,
  kpi: IconGauge,
  contract: IconContract,
  supplier: IconTruckDelivery,
};

interface TestResult {
  ok: boolean;
  status: number;
  durationMs: number;
  message: string;
}

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
  ['assurance', 'settings:areas.assurance.title'],
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
  ['data', 'settings:retention.title'],
  ['data', 'settings:backups.title'],
  ['data', 'settings:exports.title'],
];

/** Settings of a module (ADR 0016): not offered while it is switched off. */
const SETTING_MODULES: Record<string, ModuleId> = {
  'settings:endOfLife.title': 'versionWatch',
  'settings:compliance.title': 'compliance',
  'scorecard:rules.title': 'scorecard',
};

/** Namespaces of the setting titles: loaded when the palette first opens (they are not part of the first download). */
const SETTING_NAMESPACES = [...new Set(SETTING_ENTRIES.map(([, key]) => key.split(':')[0]!))];

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
 * Ctrl/Cmd+K command palette: pages (with their sidebar section), quick actions, the entries opened last, recent
 * runs and – when searching – processes, dashboards, platforms (and their connection test), monitors, services,
 * applications, systems, records, credentials, ticket references and "new person review for …". Every list
 * holds only what the user may see; actions only show to those who may take them.
 */
export function CommandPalette({ pages }: { pages: PalettePage[] }) {
  const { t, i18n } = useTranslation(['nav', 'common', 'settings']);
  const navigate = useNavigate();
  const { caps, isAdmin, hasRole } = useMe();
  const canEditServices = isAdmin || hasRole('designer');
  // person reviews are started by designers and administrators (as on the page)
  const canReview = isAdmin || hasRole('designer');
  const qc = useQueryClient();
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const isMobile = useMediaQuery('(max-width: 48em)');
  const [active, setActive] = useState(false);
  // the setting titles come from several namespaces: offered once they are loaded, never as raw keys
  const [settingsReady, setSettingsReady] = useState(false);
  useEffect(() => {
    if (!active || !caps.manageSettings || settingsReady) return;
    let live = true;
    void i18n.loadNamespaces(SETTING_NAMESPACES).then(() => live && setSettingsReady(true));
    return () => {
      live = false;
    };
  }, [active, caps.manageSettings, settingsReady, i18n]);
  const [runProcessId, setRunProcessId] = useState<string | null>(null);

  // Loaded the first time the palette opens, then kept fresh while it is open.
  const opts = { enabled: active, staleTime: 30_000 };
  const processes = useQuery({ queryKey: processKeys.all, queryFn: () => get<ProcessSummary[]>('/processes'), ...opts });
  const dashboards = useQuery({ queryKey: dashboardKeys.all, queryFn: () => get<Dashboard[]>('/dashboards'), ...opts });
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms'), ...opts });
  const runs = useQuery({ queryKey: runKeys.palette, queryFn: () => get<RunSummary[]>('/runs?limit=10'), ...opts });
  const monitors = useQuery({ queryKey: monitorKeys.palette, queryFn: () => get<MonitorSummary[]>('/monitors'), ...opts });
  const services = useQuery({ queryKey: ['services', 'palette'], queryFn: () => get<ServiceSummary[]>('/services'), ...opts });
  const records = useQuery({ queryKey: ['records', 'palette'], queryFn: () => get<RecordSummary[]>('/records'), ...opts });
  const credentials = useQuery({
    queryKey: ['credentials', 'palette'],
    queryFn: () => get<{ items: Credential[]; canCreate: boolean }>('/credentials'),
    ...opts,
  });
  const tickets = useQuery({ queryKey: ['ticket-references', 'palette'], queryFn: () => get<TicketList>('/ticket-references?state=open'), ...opts });
  const applications = useQuery({ queryKey: ['applications', 'palette'], queryFn: () => get<ApplicationSummary[]>('/applications'), ...opts });
  const systems = useQuery({ queryKey: ['systems', 'palette'], queryFn: () => get<SystemSummary[]>('/systems'), ...opts });
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => get<Subject[]>('/subjects'), ...opts, enabled: active && canReview });

  const actions = useMemo<SpotlightActionGroupData[]>(() => {
    const icon = (I: Icon) => <I size={18} stroke={1.6} />;
    const go = (to: string) => () => navigate(to);
    // an entry opened from the palette counts as opened (the "Recent" group)
    const open = (to: string, label: string, kind: RecentKind) => () => {
      rememberRecent({ to, label, kind });
      navigate(to);
    };
    const testConnection = async (p: Platform) => {
      try {
        const r = await post<TestResult>(`/platforms/${p.id}/test`);
        if (r.ok) notifyOk(t('palette.testOk', { message: r.message, ms: r.durationMs }), t('palette.testOkTitle', { name: p.name }));
        else notifyError(new Error(r.message), t('palette.testFailedTitle', { name: p.name }));
      } catch (e) {
        notifyError(e, t('palette.testFailedTitle', { name: p.name }));
      } finally {
        void qc.invalidateQueries({ queryKey: platformKeys.all });
        void qc.invalidateQueries({ queryKey: ['platform', p.id] });
      }
    };
    const extraPages: PalettePage[] = [
      { to: '/monitors/wall', label: t('palette.pages.monitorWall'), icon: IconLayoutGrid, group: t('groups.operate') },
      { to: '/records/types', label: t('palette.pages.recordTypes'), icon: IconListDetails, group: t('groups.catalogue') },
      { to: '/records/link-types', label: t('palette.pages.linkTypes'), icon: IconLink, group: t('groups.catalogue') },
      { to: '/profile', label: t('items.profile'), icon: IconUser },
      { to: '/about', label: t('palette.pages.about'), icon: IconInfoCircle },
    ];
    // individual settings (#136): administrators find them by name and land in their area
    // keys from several namespaces, listed below
    const tx = t as unknown as (key: string) => string;
    const settingActions: SpotlightActionData[] =
      caps.manageSettings && settingsReady
        ? SETTING_ENTRIES.filter(([, key]) => !SETTING_MODULES[key] || moduleOn(caps, SETTING_MODULES[key])).map(([area, key]) => ({
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
      id: 'failing-checks',
      label: t('palette.failingChecks'),
      description: t('palette.failingChecksHint'),
      leftSection: icon(IconAlertTriangle),
      keywords: ['failed', 'failing', 'checks', 'findings', t('palette.keywords.checks')],
      onClick: go('/runs?checks=failed&within=7d'),
    });
    quick.push({
      id: 'shortcuts',
      label: t('help.shortcuts'),
      description: t('palette.shortcutsHint'),
      leftSection: icon(IconKeyboard),
      rightSection: <Kbd size="xs">?</Kbd>,
      keywords: ['keyboard', 'shortcuts', 'keys', 'help', '?', t('palette.keywords.shortcuts')],
      onClick: () => openShortcutSheet(),
    });
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
      {
        group: t('palette.groups.recent'),
        actions: recent
          .filter((r) => !RECENT_MODULES[r.kind] || moduleOn(caps, RECENT_MODULES[r.kind]!))
          .map((r) => {
            const I = RECENT_ICONS[r.kind] ?? IconHistory;
            return {
              id: `recent:${r.to}`,
              label: r.label,
              description: t(`palette.kinds.${r.kind}`),
              leftSection: icon(I),
              keywords: ['recent', 'last', t('palette.keywords.recent')],
              onClick: open(r.to, r.label, r.kind),
            };
          }),
      },
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
          onClick: open(`/runs/${r.id}`, r.processName, 'run'),
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
          onClick: open(`/processes/${p.id}`, p.name, 'process'),
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
          onClick: open(`/dashboards/${d.id}`, d.name, 'dashboard'),
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
            onClick: open(`/monitors/${m.id}`, m.name, 'monitor'),
          })),
      },
      {
        group: t('palette.groups.services'),
        actions: (services.data ?? []).map((sv) => ({
          id: `service:${sv.id}`,
          label: sv.name,
          leftSection: icon(IconStack2),
          keywords: ['service', ...sv.tags],
          onClick: open(`/services/${sv.id}`, sv.name, 'service'),
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
          onClick: open(`/records/${r.id}`, `${r.number} ${r.title}`, 'record'),
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
          onClick: open(`/credentials?open=${encodeURIComponent(c.id)}`, c.name, 'credential'),
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
          onClick: open(`/tickets/${x.id}`, `${x.externalNumber} ${x.title}`, 'ticket'),
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
          onClick: open(`/platforms/${p.id}`, p.name, 'platform'),
        })),
      },
      {
        group: t('palette.groups.applications'),
        actions: (applications.data ?? []).map((a) => ({
          id: `application:${a.id}`,
          label: a.name,
          description: a.vendor || undefined,
          leftSection: icon(IconApps),
          keywords: ['application', 'app', a.vendor, ...a.tags],
          onClick: open(`/applications/${a.id}`, a.name, 'application'),
        })),
      },
      {
        group: t('palette.groups.systems'),
        actions: (systems.data ?? []).map((x) => ({
          id: `system:${x.id}`,
          label: x.name,
          description: x.vendor || undefined,
          leftSection: icon(IconServer2),
          keywords: ['system', x.kind, x.vendor, ...x.environments],
          onClick: open(`/systems/${x.id}`, x.name, 'system'),
        })),
      },
      {
        group: t('palette.groups.testConnection'),
        actions: (platforms.data ?? [])
          .filter((p) => p.permissions.includes('use'))
          .map((p) => ({
            id: `test-platform:${p.id}`,
            label: t('palette.testConnectionTo', { name: p.name }),
            description: [p.kind, p.environment].filter(Boolean).join(' · '),
            leftSection: icon(IconPlugConnected),
            keywords: ['test', 'connection', 'check', 'platform', p.kind, p.environment, t('palette.keywords.test')],
            onClick: () => void testConnection(p),
          })),
      },
      {
        group: t('palette.groups.personReviews'),
        actions:
          canReview && moduleOn(caps, 'compliance')
            ? (subjects.data ?? [])
                .filter((x) => x.kind === 'user')
                .map((x) => {
                  const username = x.value.slice('user:'.length);
                  return {
                    id: `person-review:${username}`,
                    label: t('palette.newPersonReviewFor', { name: x.label }),
                    leftSection: icon(IconUserSearch),
                    keywords: ['person', 'review', 'access', 'new', username, t('palette.keywords.review')],
                    onClick: go(`/compliance/person-reviews?new=1&user=${encodeURIComponent(username)}`),
                  };
                })
            : [],
      },
    ];
  }, [
    t,
    pages,
    caps,
    settingsReady,
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
    applications.data,
    systems.data,
    subjects.data,
    canReview,
    recent,
    qc,
  ]);
  const filter = useMemo(
    () =>
      makeFilter(
        new Set(
          (
            [
              'processes',
              'startRun',
              'dashboards',
              'platforms',
              'monitors',
              'services',
              'applications',
              'systems',
              'records',
              'credentials',
              'tickets',
              'testConnection',
              'personReviews',
            ] as const
          ).map((g) => t(`palette.groups.${g}`)),
        ),
      ),
    [t],
  );

  const loading = [processes, dashboards, platforms, runs, monitors, services, records, credentials, applications, systems].some((q) => q.isFetching);

  return (
    <>
      <Spotlight
        actions={actions}
        filter={filter}
        shortcut={['mod + K']}
        onSpotlightOpen={() => {
          setActive(true);
          setRecent(readRecent());
        }}
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

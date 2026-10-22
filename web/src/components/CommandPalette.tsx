import { lazy, Suspense, useMemo, useState } from 'react';
import { ActionIcon, Group, Kbd, Text, Tooltip, UnstyledButton, useMantineColorScheme } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Spotlight, spotlight, type SpotlightActionData, type SpotlightActionGroupData, type SpotlightFilterFunction } from '@mantine/spotlight';
import '@mantine/spotlight/styles.css';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  IconArrowRight,
  IconChartBar,
  IconMoon,
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconServer,
  IconSitemap,
  IconSun,
  IconUser,
  type Icon,
} from '@tabler/icons-react';
import type { Dashboard, Platform, ProcessDetail, ProcessSummary, RunSummary } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { useMe } from '../auth';
import { fmtRelative } from '../format';
import { StatusBadge } from './common';

const RunDialog = lazy(() => import('./RunDialog').then((m) => ({ default: m.RunDialog })));

export interface PalettePage {
  to: string;
  label: string;
  icon: Icon;
}

const PER_GROUP = 8;

/** First sentence, at most ~90 characters. */
const short = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  const first = text.split(/(?<=[.!?])\s/)[0]!;
  return first.length > 90 ? first.slice(0, 88).trimEnd() + '…' : first;
};
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Every word of the query must appear in label, description or keywords. Empty query: only pages/actions/recent runs. */
const filter: SpotlightFilterFunction = (query, actions) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = actions as SpotlightActionGroupData[];
  if (!words.length) return groups.filter((g) => g.group !== 'Processes' && g.group !== 'Start a run' && g.group !== 'Dashboards' && g.group !== 'Platforms');
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

/** Ctrl/Cmd+K command palette: pages, processes, dashboards, platforms, recent runs and quick actions. */
export function CommandPalette({ pages }: { pages: PalettePage[] }) {
  const navigate = useNavigate();
  const { caps } = useMe();
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

  const actions = useMemo<SpotlightActionGroupData[]>(() => {
    const icon = (I: Icon) => <I size={18} stroke={1.6} />;
    const go = (to: string) => () => navigate(to);
    const pageActions: SpotlightActionData[] = [...pages, { to: '/profile', label: 'Profile & API tokens', icon: IconUser }].map((p) => ({
      id: `page:${p.to}`,
      label: p.label,
      leftSection: icon(p.icon),
      keywords: ['page', 'go', 'open'],
      onClick: go(p.to),
    }));
    const quick: SpotlightActionData[] = [];
    if (caps.createProcesses) {
      quick.push({
        id: 'new-process',
        label: 'New process',
        description: 'Create an empty process and open the editor',
        leftSection: icon(IconPlus),
        keywords: ['create', 'add'],
        onClick: async () => {
          try {
            const p = await post<ProcessDetail>('/processes', {
              definition: { name: 'New process', description: '', connections: [], inputs: [], nodes: [{ id: 'start', type: 'start', name: 'Start', x: 0, y: 0 }], wires: [] },
            });
            navigate(`/processes/${p.id}`);
          } catch (e) {
            notifyError(e);
          }
        },
      });
    }
    quick.push({
      id: 'toggle-theme',
      label: colorScheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
      description: 'Change the color scheme',
      leftSection: icon(colorScheme === 'dark' ? IconSun : IconMoon),
      keywords: ['theme', 'dark', 'light', 'color'],
      onClick: () => setColorScheme(colorScheme === 'dark' ? 'light' : 'dark'),
    });
    const procs = processes.data ?? [];
    return [
      { group: 'Actions', actions: quick },
      { group: 'Pages', actions: pageActions },
      {
        group: 'Recent runs',
        actions: (runs.data ?? []).slice(0, 6).map((r) => ({
          id: `run:${r.id}`,
          label: r.processName,
          description: `${r.dryRun ? 'Dry run' : 'Run'} by ${r.actor} · ${fmtRelative(r.startedAt)}`,
          leftSection: icon(IconPlayerPlay),
          rightSection: <StatusBadge status={r.status} size="xs" />,
          keywords: ['run', r.status, r.id],
          onClick: go(`/runs/${r.id}`),
        })),
      },
      {
        group: 'Processes',
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
        group: 'Start a run',
        actions: procs
          .filter((p) => p.permissions.includes('run'))
          .map((p) => ({
            id: `run-process:${p.id}`,
            label: `Start run of ${p.name}`,
            leftSection: icon(IconArrowRight),
            keywords: ['run', 'start', 'execute', ...p.tags],
            onClick: () => setRunProcessId(p.id),
          })),
      },
      {
        group: 'Dashboards',
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
        group: 'Platforms',
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
  }, [pages, caps.createProcesses, colorScheme, setColorScheme, navigate, processes.data, runs.data, dashboards.data, platforms.data]);

  const loading = processes.isFetching || dashboards.isFetching || platforms.isFetching || runs.isFetching;

  return (
    <>
      <Spotlight
        actions={actions}
        filter={filter}
        shortcut={['mod + K']}
        onSpotlightOpen={() => setActive(true)}
        nothingFound={loading ? 'Loading…' : 'Nothing found'}
        highlightQuery
        scrollable
        maxHeight={isMobile ? 'calc(100dvh - 80px)' : 460}
        fullScreen={isMobile}
        searchProps={{ leftSection: <IconSearch size={18} stroke={1.6} />, placeholder: 'Search pages, processes, dashboards, platforms…', 'aria-label': 'Search' }}
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
  const shortcut = isMac ? '⌘ K' : 'Ctrl K';
  return (
    <>
      <Tooltip label={`Search (${shortcut})`}>
        <ActionIcon variant="subtle" onClick={() => spotlight.open()} aria-label="Search" hiddenFrom="sm">
          <IconSearch size={18} />
        </ActionIcon>
      </Tooltip>
      <UnstyledButton
        onClick={() => spotlight.open()}
        visibleFrom="sm"
        aria-label={`Search (${shortcut})`}
        px="sm"
        h={32}
        w={240}
        style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8, background: 'var(--mantine-color-default)' }}
      >
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={6} wrap="nowrap">
            <IconSearch size={14} color="var(--mantine-color-dimmed)" />
            <Text size="sm" c="dimmed">
              Search…
            </Text>
          </Group>
          <Kbd size="xs">{shortcut}</Kbd>
        </Group>
      </UnstyledButton>
    </>
  );
}

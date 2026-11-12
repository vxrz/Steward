import { useEffect, useState } from 'react';
import { ActionIcon, Alert, Box, Group, SimpleGrid, Switch, Text, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconArrowLeft, IconMaximize, IconPower } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { MonitorStatus, MonitorSummary } from '@sm/shared';
import { get } from '../api';
import { MONITOR_COLORS, causeText, fmtUptime, monitorStatusLabel } from '../components/monitors/status';
import { settlingCheckIds, stateProblemText } from '../components/monitors/StatePanel';
import { fmtDate, fmtRelative } from '../format';
import { QueryState } from '../components/common';
import { monitorKeys } from '../queryKeys';

const ORDER: Record<MonitorStatus, number> = { down: 0, degraded: 1, unknown: 2, blocked: 3, maintenance: 4, off: 5, up: 6 };
const HIDE_OFF = 'sm.wall.hideOff';
const readHideOff = (): boolean => {
  try {
    return localStorage.getItem(HIDE_OFF) === '1';
  } catch {
    return false;
  }
};

/** Three refreshes missed: the statuses on the wall are not current any more. */
const STALE_AFTER_MS = 35000;

/** Status grid for a wall display: problems first, refreshed every 10 seconds. */
export function MonitorWallPage() {
  const { t } = useTranslation('monitors');
  const q = useQuery({ queryKey: monitorKeys.all, queryFn: () => get<MonitorSummary[]>('/monitors'), refetchInterval: 10000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);
  // the control room may hide what is off as planned (ADR 0021); remembered in this browser
  const [hideOff, setHideOff] = useState(readHideOff);
  const toggleHideOff = (v: boolean) => {
    setHideOff(v);
    try {
      localStorage.setItem(HIDE_OFF, v ? '1' : '0');
    } catch {
      // storage refused: the switch works for this visit
    }
  };
  const list = [...(q.data ?? [])]
    .filter((m) => m.enabled && !(hideOff && m.status === 'off'))
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
  const problems = list.filter((m) => m.status === 'down' || m.status === 'degraded').length;
  // a wall that cannot refresh must not look healthy: no headline before the first answer, and a banner once the
  // statuses are older than three refreshes (the server or the network is gone, or the session ended)
  const loaded = q.data !== undefined;
  const outdated = loaded && now - q.dataUpdatedAt > STALE_AFTER_MS;
  return (
    <Box>
      <Group justify="space-between" mb="md" wrap="wrap">
        <Group gap="xs">
          <ActionIcon component={Link} to="/monitors" variant="subtle" aria-label={t('wall.back')}>
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Title order={1} size="h2">
            {t('wall.title')}
          </Title>
        </Group>
        <Group gap="md">
          <Switch size="sm" label={t('wall.hideOff')} checked={hideOff} onChange={(e) => toggleHideOff(e.currentTarget.checked)} />
          {loaded && (
            <Text size="lg" fw={700} c={outdated ? 'dimmed' : problems ? 'red' : 'green'} aria-live="polite" data-testid="status-wall-headline">
              {problems ? t('wall.problems', { count: problems, total: list.length }) : t('wall.allHealthy', { count: list.length })}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t('wall.updated', { when: fmtRelative(new Date(q.dataUpdatedAt || now).toISOString()) })}
          </Text>
          <Tooltip label={t('wall.fullScreen')}>
            <ActionIcon
              variant="subtle"
              aria-label={t('wall.fullScreen')}
              onClick={() => document.documentElement.requestFullscreen?.().catch(() => undefined /* full screen refused: the wall stays as it is */)}
            >
              <IconMaximize size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      {!loaded && <QueryState query={q} />}
      {outdated && (
        <Alert color="orange" icon={<IconAlertTriangle size={18} />} mb="md" title={t('wall.outdatedTitle')} role="alert" data-testid="status-wall-outdated">
          {t('wall.outdated', { when: fmtDate(new Date(q.dataUpdatedAt).toISOString()) })}
        </Alert>
      )}
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 4 }} spacing="sm" style={outdated ? { opacity: 0.6 } : undefined}>
        {list.map((m) => (
          <Box
            key={m.id}
            component={Link}
            to={`/monitors/${m.id}`}
            data-testid={`wall-${m.key}`}
            data-status={m.status}
            p="md"
            style={{
              display: 'block',
              textDecoration: 'none',
              color: 'inherit',
              borderRadius: 10,
              background: `var(--mantine-color-${MONITOR_COLORS[m.status]}-light)`,
              borderLeft: `10px solid var(--mantine-color-${MONITOR_COLORS[m.status]}-filled)`,
              minHeight: 120,
            }}
          >
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Text fw={700} size="lg" lineClamp={2}>
                {m.name}
              </Text>
              <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                {m.status === 'off' && <IconPower size={16} aria-hidden />}
                <Text fw={800} size="sm" tt="uppercase">
                  {m.status === 'off' && m.state?.name ? m.state.name : monitorStatusLabel(m.status)}
                </Text>
              </Group>
            </Group>
            <Text size="sm" mt={6} lineClamp={2}>
              {m.maintenance
                ? m.maintenance.reason
                : m.status === 'off' && m.state
                  ? m.state.settlingUntil
                    ? t('wall.offSettling', {
                        state: m.state.name ?? monitorStatusLabel('off'),
                        minutes: Math.max(1, Math.ceil((Date.parse(m.state.settlingUntil) - now) / 60000)),
                      })
                    : t('wall.offAgree', { state: m.state.name ?? monitorStatusLabel('off') })
                  : m.state?.settlingUntil && settlingCheckIds(m.state).length
                    ? t('wall.settling', {
                        state: m.state.name ?? monitorStatusLabel(m.status),
                        minutes: Math.max(1, Math.ceil((Date.parse(m.state.settlingUntil) - now) / 60000)),
                        count: settlingCheckIds(m.state).length,
                      })
                    : m.rootCauses.length
                      ? m.rootCauses.map((c) => causeText(c, m.id)).join(', ')
                      : (stateProblemText(t, m.state) ?? t('wall.checks', { count: m.checkCount }))}
            </Text>
            <Text size="xs" mt={6}>
              {t('wall.uptimeSince', { uptime: fmtUptime(m.uptime.h24), since: fmtRelative(m.since) })}
              {m.acknowledged ? ` · ${t('wall.acknowledgedBy', { user: m.acknowledged.by })}` : ''}
            </Text>
          </Box>
        ))}
      </SimpleGrid>
    </Box>
  );
}

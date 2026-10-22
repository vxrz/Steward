import { useEffect, useState } from 'react';
import { ActionIcon, Box, Group, SimpleGrid, Text, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconArrowLeft, IconMaximize } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { MonitorStatus, MonitorSummary } from '@sm/shared';
import { get } from '../api';
import { MONITOR_COLORS, causeText, fmtUptime, monitorStatusLabel } from '../components/monitors/status';
import { fmtRelative } from '../format';

const ORDER: Record<MonitorStatus, number> = { down: 0, degraded: 1, unknown: 2, blocked: 3, maintenance: 4, up: 5 };

/** Status grid for a wall display: problems first, refreshed every 10 seconds. */
export function MonitorWallPage() {
  const { t } = useTranslation('monitors');
  const q = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors'), refetchInterval: 10000 });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);
  const list = [...(q.data ?? [])].filter((m) => m.enabled).sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
  const problems = list.filter((m) => m.status === 'down' || m.status === 'degraded').length;
  return (
    <Box>
      <Group justify="space-between" mb="md" wrap="wrap">
        <Group gap="xs">
          <ActionIcon component={Link} to="/monitors" variant="subtle" aria-label={t('wall.back')}>
            <IconArrowLeft size={18} />
          </ActionIcon>
          <Title order={2}>{t('wall.title')}</Title>
        </Group>
        <Group gap="md">
          <Text size="lg" fw={700} c={problems ? 'red' : 'green'} aria-live="polite">
            {problems ? t('wall.problems', { count: problems, total: list.length }) : t('wall.allHealthy', { count: list.length })}
          </Text>
          <Text size="xs" c="dimmed">
            {t('wall.updated', { when: fmtRelative(new Date(q.dataUpdatedAt || now).toISOString()) })}
          </Text>
          <Tooltip label={t('wall.fullScreen')}>
            <ActionIcon
              variant="subtle"
              aria-label={t('wall.fullScreen')}
              onClick={() => document.documentElement.requestFullscreen?.().catch(() => undefined)}
            >
              <IconMaximize size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 4 }} spacing="sm">
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
              <Text fw={800} size="sm" tt="uppercase" style={{ flexShrink: 0 }}>
                {monitorStatusLabel(m.status)}
              </Text>
            </Group>
            <Text size="sm" mt={6} lineClamp={2}>
              {m.maintenance
                ? m.maintenance.reason
                : m.rootCauses.length
                  ? m.rootCauses.map((c) => causeText(c, m.id)).join(', ')
                  : t('wall.checks', { count: m.checkCount })}
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

import { Alert, Anchor, Badge, Button, Card, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconAlertTriangle, IconInbox, IconRocket } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { DashboardData } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../api';
import { PageHeader, severityLabel } from '../components/common';
import { RunTable } from '../components/RunTable';
import { CredentialsDueCard } from '../components/credentials/CredentialsDueCard';
import { fmtDate, fmtNumber, fmtRelative } from '../format';
import { useMe } from '../auth';
import { useState } from 'react';

export function DashboardPage({ demo }: { demo: boolean }) {
  const { t } = useTranslation('dashboard');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => get<DashboardData>('/dashboard'), refetchInterval: 5000 });
  const { isAdmin } = useMe();
  const [demoAccounts, setDemoAccounts] = useState<{ users: string[]; password: string } | null>(null);
  const data = d.data;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {demoAccounts && (
        <Alert color="yellow" title={t('demoAccounts.title')} mb="md" withCloseButton onClose={() => setDemoAccounts(null)}>
          <Text size="sm">
            <Trans
              t={t}
              i18nKey="demoAccounts.text"
              values={{ users: demoAccounts.users.join(', '), password: demoAccounts.password }}
              components={{ b: <b />, code: <code /> }}
            />
          </Text>
        </Alert>
      )}
      {data && data.counts.platforms === 0 && (
        <Alert icon={<IconRocket />} title={t('getStarted.title')} mb="md">
          <Stack gap="xs">
            <Text size="sm">
              <Trans t={t} i18nKey="getStarted.step1" components={{ a: <Anchor component={Link} to="/platforms" /> }} />
              <br />
              <Trans t={t} i18nKey="getStarted.step2" components={{ a: <Anchor component={Link} to="/processes" /> }} />
              <br />
              <Trans t={t} i18nKey="getStarted.step3" components={{ a: <Anchor component={Link} to="/schedules" /> }} />
            </Text>
            {demo && isAdmin && (
              <Group>
                <Button
                  size="xs"
                  onClick={async () => {
                    try {
                      const r = await post<{ platforms: number; processes: number; users: string[]; password: string }>('/demo/setup');
                      notifyOk(t('getStarted.demoLoaded', { platforms: r.platforms, processes: r.processes }));
                      setDemoAccounts({ users: r.users, password: r.password });
                      qc.invalidateQueries();
                    } catch (e) {
                      notifyError(e);
                    }
                  }}
                >
                  {t('getStarted.loadDemo')}
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}
      {data && (
        <Stack>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="xs">
            <Count label={t('counts.openTasks')} value={data.openTasks.length} color={data.openTasks.length ? 'violet' : undefined} onClick={() => navigate('/tasks')} />
            <Count label={t('counts.runs24h')} value={data.counts.runs24h} onClick={() => navigate('/runs')} />
            <Count label={t('counts.failed24h')} value={data.counts.failed24h} color={data.counts.failed24h ? 'red' : undefined} onClick={() => navigate('/runs')} />
            <Count label={t('counts.schedules')} value={data.counts.schedules} onClick={() => navigate('/schedules')} />
            <Count label={t('counts.platforms')} value={data.counts.platforms} onClick={() => navigate('/platforms')} />
          </SimpleGrid>

          {data.openTasks.length > 0 && (
            <Card withBorder>
              <Group mb="xs" gap="xs" wrap="nowrap">
                <IconInbox size={18} />
                <Title order={5}>{t('waiting')}</Title>
              </Group>
              <Stack gap={6}>
                {data.openTasks.map((task) => (
                  <Group key={task.id} justify="space-between" gap={4} wrap="wrap">
                    <Anchor component={Link} to={`/runs/${task.runId}`} size="sm" style={{ minWidth: 0 }}>
                      {task.title}
                    </Anchor>
                    <Text size="xs" c="dimmed" className="nowrap">
                      {task.processName} · {fmtRelative(task.createdAt)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Card>
          )}

          {data.failedChecks.length > 0 && (
            <Card withBorder>
              <Group mb="xs" gap="xs" wrap="nowrap">
                <IconAlertTriangle size={18} color="var(--mantine-color-orange-6)" />
                <Title order={5}>{t('failedChecks')}</Title>
              </Group>
              <Stack gap={6}>
                {data.failedChecks.map((c, i) => (
                  <Group key={i} justify="space-between" gap={4} wrap="wrap" align="flex-start">
                    <div style={{ minWidth: 0 }}>
                      <Group gap={6}>
                        <Badge size="xs" color={c.severity === 'error' ? 'red' : c.severity === 'warning' ? 'orange' : 'gray'}>
                          {severityLabel(c.severity)}
                        </Badge>
                        <Anchor component={Link} to={`/runs/${c.runId}`} size="sm">
                          {c.name}
                        </Anchor>
                      </Group>
                      <Text size="xs" c="dimmed">
                        {c.message}
                      </Text>
                    </div>
                    <Text size="xs" c="dimmed" className="nowrap">
                      {c.processName} · {fmtRelative(c.ts)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Card>
          )}

          <CredentialsDueCard />

          <SimpleGrid cols={{ base: 1, lg: 3 }}>
            <Card withBorder style={{ gridColumn: 'span 2' }}>
              <Title order={5} mb="xs">
                {t('recentRuns')}
              </Title>
              <RunTable runs={data.recentRuns} compact />
            </Card>
            <Card withBorder>
              <Title order={5} mb="xs">
                {t('upcoming')}
              </Title>
              {data.upcoming.length === 0 && (
                <Text size="sm" c="dimmed">
                  <Trans t={t} i18nKey="nothingScheduled" components={{ a: <Anchor component={Link} to="/schedules" /> }} />
                </Text>
              )}
              <Stack gap={8}>
                {data.upcoming.map((s) => (
                  <Paper key={s.id} withBorder p={8}>
                    <Text size="sm" fw={500}>
                      {s.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t(s.dryRun ? 'upcomingLineDryRun' : 'upcomingLine', { process: s.processName, date: fmtDate(s.nextRunAt), relative: fmtRelative(s.nextRunAt) })}
                    </Text>
                  </Paper>
                ))}
              </Stack>
            </Card>
          </SimpleGrid>
        </Stack>
      )}
    </>
  );
}

function Count({ label, value, color, onClick }: { label: string; value: number; color?: string; onClick?: () => void }) {
  return (
    <Paper withBorder p="sm" className="clickable" onClick={onClick}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} fz={26} c={color}>
        {fmtNumber(value)}
      </Text>
    </Paper>
  );
}

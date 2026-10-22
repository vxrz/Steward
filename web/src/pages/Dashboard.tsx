import { Alert, Anchor, Badge, Button, Card, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconAlertTriangle, IconInbox, IconRocket } from '@tabler/icons-react';
import type { DashboardData } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../api';
import { PageHeader } from '../components/common';
import { RunTable } from '../components/RunTable';
import { fmtDate, fmtRelative } from '../format';
import { useMe } from '../auth';
import { useState } from 'react';

export function DashboardPage({ demo }: { demo: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const d = useQuery({ queryKey: ['dashboard'], queryFn: () => get<DashboardData>('/dashboard'), refetchInterval: 5000 });
  const { isAdmin } = useMe();
  const [demoAccounts, setDemoAccounts] = useState<{ users: string[]; password: string } | null>(null);
  const data = d.data;
  return (
    <>
      <PageHeader title="Dashboard" description="What needs your attention, what is running and what is planned." />
      {demoAccounts && (
        <Alert color="yellow" title="Demo accounts created" mb="md" withCloseButton onClose={() => setDemoAccounts(null)}>
          <Text size="sm">
            Sign in as <b>{demoAccounts.users.join(', ')}</b> with the password <code>{demoAccounts.password}</code> to see the roles in action
            (dana = designer, olivia = operator, adam = approver, audrey = auditor, vera = viewer; olivia and adam form the team “Service Desk”).
          </Text>
        </Alert>
      )}
      {data && data.counts.platforms === 0 && (
        <Alert icon={<IconRocket />} title="Get started" mb="md">
          <Stack gap="xs">
            <Text size="sm">
              1. Add a <Anchor component={Link} to="/platforms">platform</Anchor> (Insights Hub tenant, Industrial Edge Management, any REST API) with its credentials and API spec.
              <br />
              2. Create a <Anchor component={Link} to="/processes">process</Anchor> from a template or from scratch.
              <br />
              3. Run it (start with a dry run) or <Anchor component={Link} to="/schedules">schedule</Anchor> it.
            </Text>
            {demo && isAdmin && (
              <Group>
                <Button
                  size="xs"
                  onClick={async () => {
                    try {
                      const r = await post<{ platforms: number; processes: number; users: string[]; password: string }>('/demo/setup');
                      notifyOk(`Loaded ${r.platforms} demo platforms and ${r.processes} processes`);
                      setDemoAccounts({ users: r.users, password: r.password });
                      qc.invalidateQueries();
                    } catch (e) {
                      notifyError(e);
                    }
                  }}
                >
                  Load demo platforms & processes
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}
      {data && (
        <Stack>
          <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="xs">
            <Count label="Open tasks" value={data.openTasks.length} color={data.openTasks.length ? 'violet' : undefined} onClick={() => navigate('/tasks')} />
            <Count label="Runs (24 h)" value={data.counts.runs24h} onClick={() => navigate('/runs')} />
            <Count label="Failed (24 h)" value={data.counts.failed24h} color={data.counts.failed24h ? 'red' : undefined} onClick={() => navigate('/runs')} />
            <Count label="Active schedules" value={data.counts.schedules} onClick={() => navigate('/schedules')} />
            <Count label="Platforms" value={data.counts.platforms} onClick={() => navigate('/platforms')} />
          </SimpleGrid>

          {data.openTasks.length > 0 && (
            <Card withBorder>
              <Group mb="xs" gap="xs">
                <IconInbox size={18} />
                <Title order={5}>Waiting for your decision</Title>
              </Group>
              <Stack gap={6}>
                {data.openTasks.map((t) => (
                  <Group key={t.id} justify="space-between" wrap="nowrap">
                    <Anchor component={Link} to={`/runs/${t.runId}`} size="sm" style={{ minWidth: 0 }}>
                      {t.title}
                    </Anchor>
                    <Text size="xs" c="dimmed" className="nowrap">
                      {t.processName} · {fmtRelative(t.createdAt)}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </Card>
          )}

          {data.failedChecks.length > 0 && (
            <Card withBorder>
              <Group mb="xs" gap="xs">
                <IconAlertTriangle size={18} color="var(--mantine-color-orange-6)" />
                <Title order={5}>Failed checks (last 7 days)</Title>
              </Group>
              <Stack gap={6}>
                {data.failedChecks.map((c, i) => (
                  <Group key={i} justify="space-between" wrap="nowrap" align="flex-start">
                    <div style={{ minWidth: 0 }}>
                      <Group gap={6}>
                        <Badge size="xs" color={c.severity === 'error' ? 'red' : c.severity === 'warning' ? 'orange' : 'gray'}>
                          {c.severity}
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

          <SimpleGrid cols={{ base: 1, lg: 3 }}>
            <Card withBorder style={{ gridColumn: 'span 2' }}>
              <Title order={5} mb="xs">
                Recent runs
              </Title>
              <RunTable runs={data.recentRuns} compact />
            </Card>
            <Card withBorder>
              <Title order={5} mb="xs">
                Upcoming
              </Title>
              {data.upcoming.length === 0 && (
                <Text size="sm" c="dimmed">
                  Nothing scheduled. <Anchor component={Link} to="/schedules">Plan a process</Anchor>.
                </Text>
              )}
              <Stack gap={8}>
                {data.upcoming.map((s) => (
                  <Paper key={s.id} withBorder p={8}>
                    <Text size="sm" fw={500}>
                      {s.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {s.processName} · {fmtDate(s.nextRunAt)} ({fmtRelative(s.nextRunAt)}){s.dryRun ? ' · dry run' : ''}
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
        {value}
      </Text>
    </Paper>
  );
}

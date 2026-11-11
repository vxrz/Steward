import { Alert, Anchor, Button, Card, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { IconInbox, IconLayoutDashboard, IconRocket } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { DashboardData } from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../api';
import { PageHeader } from '../components/common';
import { RunTable } from '../components/RunTable';
import { CredentialsDueCard } from '../components/credentials/CredentialsDueCard';
import { FailedChecksCard } from '../components/dashboard/FailedChecksCard';
import { AttentionTiles, type TileKey } from '../components/dashboard/AttentionTiles';
import { GettingStarted } from '../components/dashboard/GettingStarted';
import { ComplianceCard, DashboardsCard, useStartFocus, type StartFocus } from '../components/dashboard/StartFocus';
import { fmtDate, fmtRelative } from '../format';
import { useMe } from '../auth';
import { useState } from 'react';
import { dashboardKeys } from '../queryKeys';
import { IfModule } from '../components/modules/ModuleOff';
import { CollapsibleSection } from '../components/page/CollapsibleSection';
import { AdvisoriesCard } from '../components/plant/advisories/AssetAdvisories';

/** The tiles of each start page focus, most relevant first (operations: all of them). */
const FOCUS_TILES: Record<StartFocus, readonly TileKey[] | undefined> = {
  operations: undefined,
  compliance: ['findings', 'reviews', 'run-findings', 'duties', 'credentials', 'scorecard', 'tasks'],
  viewer: ['tasks', 'monitors', 'scorecard', 'vendor-tickets'],
};

export function DashboardPage({ demo }: { demo: boolean }) {
  const { t } = useTranslation('dashboard');
  const qc = useQueryClient();
  const d = useQuery({ queryKey: dashboardKeys.details, queryFn: () => get<DashboardData>('/dashboard'), refetchInterval: 5000 });
  const { isAdmin } = useMe();
  // operations (admins, designers, operators), compliance (auditors) or viewer – and "show everything"
  const { focus, full, setFull } = useStartFocus();
  const view: StartFocus = full ? 'operations' : focus;
  const ops = view === 'operations';
  // ?checklist=1: the Help menu's "Getting-started checklist"
  const [params] = useSearchParams();
  const showChecklist = params.get('checklist') === '1';
  const [demoAccounts, setDemoAccounts] = useState<{ users: string[]; password: string } | null>(null);
  const data = d.data;
  const loadDemoButton = isAdmin && (
    <Group mb="sm">
      <Button
        size="xs"
        onClick={async () => {
          try {
            const r = await post<{ platforms: number; processes: number; users: string[]; password: string }>('/demo/setup', { services: true });
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
  );
  return (
    <>
      <PageHeader title={t('title')} description={t(`focus.description.${view}`)} />
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
      {data?.setup && (
        <GettingStarted setup={data.setup} forceShow={showChecklist} demoAction={data.counts.platforms === 0 && demo ? loadDemoButton : undefined} />
      )}
      {data && !data.setup && data.counts.platforms === 0 && (
        <Alert icon={<IconRocket />} title={t('getStarted.title')} mb="md">
          <Text size="sm">
            <Trans t={t} i18nKey="getStarted.step1" components={{ a: <Anchor inherit component={Link} to="/platforms" /> }} />
            <br />
            <Trans t={t} i18nKey="getStarted.step2" components={{ a: <Anchor inherit component={Link} to="/processes" /> }} />
            <br />
            <Trans t={t} i18nKey="getStarted.step3" components={{ a: <Anchor inherit component={Link} to="/schedules" /> }} />
          </Text>
        </Alert>
      )}
      {data && (
        <Stack>
          <AttentionTiles a={data.attention} processes={data.counts.processes} only={FOCUS_TILES[view]} hideNotSetUp={view === 'viewer'} />

          {view === 'viewer' && <DashboardsCard />}
          {view === 'compliance' && (
            <IfModule module="compliance">
              <ComplianceCard />
            </IfModule>
          )}

          {data.openTasks.length > 0 && (
            // folds like the failed checks (remembered per user); a new decision opens it again
            <CollapsibleSection
              id="waiting-tasks"
              variant="card"
              size="h5"
              title={t('waiting')}
              icon={<IconInbox size={18} aria-hidden style={{ flex: 'none' }} />}
              count={data.openTasks.length}
              tone="warning"
              remember="section.dashboard.waiting-tasks"
              alertKey={data.openTasks
                .map((task) => task.id)
                .sort()
                .join(',')}
            >
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
            </CollapsibleSection>
          )}

          {view !== 'viewer' && <FailedChecksCard checks={data.failedChecks} />}

          {/* 0.14: open security advisories affecting the reader's plant sites */}
          <IfModule module="plant">
            <AdvisoriesCard />
          </IfModule>

          {ops && <CredentialsDueCard />}

          {ops && (
            <SimpleGrid cols={{ base: 1, lg: 3 }}>
              <Card withBorder style={{ gridColumn: 'span 2' }}>
                <Title order={2} size="h5" mb="xs">
                  {t('recentRuns')}
                </Title>
                <RunTable runs={data.recentRuns} compact />
              </Card>
              <Card withBorder>
                <Title order={2} size="h5" mb="xs">
                  {t('upcoming')}
                </Title>
                {data.upcoming.length === 0 && (
                  <Text size="sm" c="dimmed">
                    <Trans t={t} i18nKey="nothingScheduled" components={{ a: <Anchor inherit component={Link} to="/schedules" /> }} />
                  </Text>
                )}
                <Stack gap={8}>
                  {data.upcoming.map((s) => (
                    <Paper key={s.id} withBorder p={8}>
                      <Text size="sm" fw={500}>
                        {s.name}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {t(s.dryRun ? 'upcomingLineDryRun' : 'upcomingLine', {
                          process: s.processName,
                          date: fmtDate(s.nextRunAt),
                          relative: fmtRelative(s.nextRunAt),
                        })}
                      </Text>
                    </Paper>
                  ))}
                </Stack>
              </Card>
            </SimpleGrid>
          )}

          {focus !== 'operations' && (
            // the full operations start page stays one click away
            <Group justify="center">
              <Button
                variant="subtle"
                size="xs"
                leftSection={<IconLayoutDashboard size={14} />}
                onClick={() => setFull(!full)}
                data-testid="start-focus-toggle"
              >
                {full ? t('focus.showMine', { focus: t(`focus.name.${focus}`) }) : t('focus.showAll')}
              </Button>
            </Group>
          )}
        </Stack>
      )}
    </>
  );
}

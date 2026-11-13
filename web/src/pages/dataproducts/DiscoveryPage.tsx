import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconPencil, IconPlayerPlay, IconRadar, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataDiscoveryRun, DataDiscoveryRunStatus, DataDiscoverySource } from '@sm/shared';
import { del, notifyError, notifyOk, post } from '../../api';
import { DetailState, QueryState, useCreateParam } from '../../components/common';
import { DataTable } from '../../components/DataTable';
import { ListPage } from '../../components/page/ListPage';
import { DetailPage } from '../../components/page/DetailPage';
import { confirmDanger } from '../../components/confirm';
import { SourceForm } from '../../components/dataproducts/CatalogueForms';
import { codeText } from '../../i18n/errors';
import { fmtDate, fmtDuration, fmtNumber, fmtRelative } from '../../format';
import { dpKeys, useInvalidateDataProducts, useRuns, useSource, useSources } from './api';
import { CardTable, Fact, Section } from './parts';
import { useCanManageModule } from './rights';

const enc = encodeURIComponent;
const to = (s: { id: string }) => `/data-products/discovery/${enc(s.id)}`;
const STATUS_COLOR: Record<DataDiscoveryRunStatus, string> = { running: 'blue', succeeded: 'green', failed: 'red', truncated: 'orange' };

export function RunStatusBadge({ status, size = 'sm' }: { status: DataDiscoveryRunStatus | null; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProducts');
  if (!status)
    return (
      <Badge size={size} variant="outline" color="gray" tt="none">
        {t('discovery.never')}
      </Badge>
    );
  return (
    <Badge size={size} variant="light" color={STATUS_COLOR[status]} tt="none" data-status={status}>
      {t(`discovery.statuses.${status}`)}
    </Badge>
  );
}

/** Why a run failed or what it could not read: the translated text of its code, else the server's English words. */
export function useRunError(): (r: DataDiscoveryRun) => string | null {
  return (r) => (r.errorCode ? (codeText(r.errorCode, r.errorParams ?? undefined, r.error ?? undefined) ?? r.error) : r.error);
}

/** "12 added · 3 changed · …" of a run (only the counts that are not zero). */
function useCounts(): (r: DataDiscoveryRun) => string {
  const { t } = useTranslation('dataProducts');
  return (r) =>
    (['added', 'changed', 'renamed', 'missing', 'removed', 'unchanged'] as const)
      .filter((k) => r[k] > 0)
      .map((k) => t(`discovery.counts.${k}`, { count: fmtNumber(r[k]) }))
      .join(' · ') || t('discovery.counts.nothing');
}

/** Read now: the run goes on in the background (202); the page looks again while it runs. */
function useReadNow(): (s: DataDiscoverySource) => Promise<void> {
  const { t } = useTranslation('dataProducts');
  const invalidate = useInvalidateDataProducts();
  return async (s) => {
    try {
      await post(`/data-products/discovery-sources/${enc(s.id)}/run`);
      notifyOk(t('discovery.started', { name: s.name }));
      invalidate();
    } catch (e) {
      notifyError(e, t('discovery.notStarted'));
    }
  };
}

/**
 * Discovery (ADR 0036 part 5): the sources that read elements from Snowflake, Kafka and database snapshots – metadata
 * only, with the platform's identity and the use right of the person who saved them, re-checked before every run –
 * their last run with its counts, and _Read now_.
 */
export function DataDiscoveryPage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const navigate = useNavigate();
  const q = useSources();
  const canManage = useCanManageModule();
  const invalidate = useInvalidateDataProducts();
  const readNow = useReadNow();
  const counts = useCounts();
  const runError = useRunError();
  const [creating, setCreating] = useState(false);
  useCreateParam(canManage, () => setCreating(true));
  const rows = q.data ?? [];
  const none = q.isSuccess && rows.length === 0;
  const last = (s: DataDiscoverySource) => (
    <Stack gap={2}>
      <Group gap={6} wrap="nowrap">
        <RunStatusBadge status={s.running ? 'running' : s.lastStatus} size="xs" />
        {s.lastRunAt && (
          <Text size="xs" c="dimmed" title={fmtDate(s.lastRunAt)}>
            {fmtRelative(s.lastRunAt)}
          </Text>
        )}
      </Group>
      {s.lastRun && (
        <Text size="xs" c="dimmed">
          {counts(s.lastRun)}
        </Text>
      )}
      {s.lastRun && runError(s.lastRun) && (
        <Text size="xs" c={s.lastRun.status === 'failed' ? 'red' : 'orange'} style={{ overflowWrap: 'anywhere' }}>
          {runError(s.lastRun)}
        </Text>
      )}
    </Stack>
  );
  const readButton = (s: DataDiscoverySource) =>
    s.permissions?.includes('manage') && (
      <Button
        size="compact-xs"
        variant="default"
        leftSection={<IconPlayerPlay size={12} />}
        disabled={s.running}
        onClick={(e) => {
          e.stopPropagation();
          void readNow(s);
        }}
        data-testid="source-read-now"
      >
        {t('discovery.readNow')}
      </Button>
    );
  return (
    <ListPage
      testId="data-discovery"
      title={t('discovery.title')}
      description={t('discovery.description')}
      primaryAction={
        canManage && (
          <Button size="xs" leftSection={<IconRadar size={14} />} onClick={() => setCreating(true)} data-testid="source-new">
            {t('discovery.new')}
          </Button>
        )
      }
      empty={{
        show: none,
        icon: IconRadar,
        title: t('discovery.emptyTitle'),
        text: t('discovery.emptyText'),
        whoCanAct: canManage ? undefined : t('discovery.whoCanAct'),
        action: canManage && (
          <Button leftSection={<IconRadar size={16} />} onClick={() => setCreating(true)}>
            {t('discovery.new')}
          </Button>
        ),
      }}
    >
      <QueryState query={q} />
      {rows.length > 0 && (
        <DataTable
          testId="source-table"
          ariaLabel={t('discovery.title')}
          rows={rows}
          rowKey={(s) => s.id}
          rowHref={to}
          card={(s) => (
            <Paper withBorder p="sm" component="article" aria-labelledby={`source-${s.id}`}>
              <Stack gap={6}>
                <Group justify="space-between" wrap="nowrap">
                  <Anchor id={`source-${s.id}`} component={Link} to={to(s)} fw={600}>
                    {s.name}
                  </Anchor>
                  {readButton(s)}
                </Group>
                <Text size="xs" c="dimmed">
                  {[s.platformName, s.scope.join(', ')].filter(Boolean).join(' · ')}
                </Text>
                {last(s)}
              </Stack>
            </Paper>
          )}
          columns={[
            {
              key: 'name',
              header: t('form.name'),
              sortValue: (s) => s.name,
              cell: (s) => (
                <Stack gap={0}>
                  <Anchor component={Link} to={to(s)} size="sm" fw={500} onClick={(e) => e.stopPropagation()}>
                    {s.name}
                  </Anchor>
                  {!s.enabled && (
                    <Text size="xs" c="dimmed">
                      {t('discovery.paused')}
                    </Text>
                  )}
                </Stack>
              ),
            },
            { key: 'platform', header: t('discovery.platform'), sortValue: (s) => s.platformName ?? '', cell: (s) => s.platformName ?? '–' },
            {
              key: 'scope',
              header: t('discovery.scope'),
              cell: (s) => (
                <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {s.scope.join(', ') || t('discovery.allScope')}
                </Text>
              ),
            },
            { key: 'last', header: t('discovery.lastRun'), sortValue: (s) => s.lastRunAt ?? '', cell: last },
            {
              key: 'next',
              header: t('discovery.nextRun'),
              sortValue: (s) => s.nextRunAt ?? '',
              nowrap: true,
              cell: (s) => (s.enabled && s.nextRunAt ? fmtRelative(s.nextRunAt) : '–'),
            },
            { key: 'read', header: t('discovery.readNow'), cell: readButton },
          ]}
        />
      )}
      {creating && (
        <SourceForm
          onClose={() => setCreating(false)}
          onSaved={(s) => {
            invalidate();
            setCreating(false);
            navigate(to(s));
          }}
        />
      )}
    </ListPage>
  );
}

/** A discovery source with its settings and the newest runs (counts, duration and why one failed). */
export function DataDiscoverySourcePage() {
  const { t } = useTranslation(['dataProducts', 'common']);
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidate = useInvalidateDataProducts();
  const q = useSource(id);
  const runs = useRuns(id, !!q.data?.running);
  const readNow = useReadNow();
  const counts = useCounts();
  const runError = useRunError();
  const [editing, setEditing] = useState(false);
  const s = q.data;
  if (!s) return <DetailState query={q} back={{ to: '/data-products/discovery', label: t('discovery.title') }} />;
  const canManage = !!s.permissions?.includes('manage');
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('discovery.deleteConfirm', { name: s.name }) }))) return;
    try {
      await del(`/data-products/discovery-sources/${enc(s.id)}`);
      invalidate();
      navigate('/data-products/discovery');
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <DetailPage
      back={{ to: '/data-products/discovery', label: t('discovery.title') }}
      title={s.name}
      status={<RunStatusBadge status={s.running ? 'running' : s.lastStatus} />}
      description={[s.platformName, t('discovery.runsAsLine', { user: s.runAs })].filter(Boolean).join(' · ')}
      actions={
        canManage && (
          <>
            <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)}>
              {t('common:edit')}
            </Button>
            <Button size="xs" leftSection={<IconPlayerPlay size={14} />} disabled={s.running} onClick={() => void readNow(s)} data-testid="source-read-now">
              {t('discovery.readNow')}
            </Button>
          </>
        )
      }
      menu={{ items: canManage ? [{ label: t('common:delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'source-delete' }] : [] }}
    >
      <Stack gap="md">
        {s.failingSince && (
          <Alert color="red" variant="light" data-testid="source-failing">
            {t('discovery.failingSince', { date: fmtDate(s.failingSince) })}
          </Alert>
        )}
        <Section title={t('discovery.settings')}>
          <SimpleGrid cols={{ base: 1, xs: 2, md: 3 }} spacing="sm">
            <Fact label={t('discovery.platform')}>
              <Anchor component={Link} to={`/platforms/${enc(s.platformId)}`} size="sm">
                {s.platformName ?? s.platformId}
              </Anchor>
            </Fact>
            <Fact label={t('discovery.scope')}>
              <span className="mono">{s.scope.join(', ') || t('discovery.allScope')}</span>
            </Fact>
            {s.mode && <Fact label={t('discovery.mode')}>{t(`discovery.modes.${s.mode}`)}</Fact>}
            <Fact label={t('discovery.include')}>
              <span className="mono">{s.includePrefixes.join(', ') || '–'}</span>
            </Fact>
            <Fact label={t('discovery.exclude')}>
              <span className="mono">{s.excludePrefixes.join(', ') || '–'}</span>
            </Fact>
            <Fact label={t('discovery.rules')}>
              {s.environmentRules.length
                ? s.environmentRules
                    .map((r) => t('discovery.ruleText', { match: t(`discovery.ruleMatches.${r.match}`), value: r.value, environment: r.environment }))
                    .join('; ')
                : t('discovery.noRules')}
            </Fact>
            <Fact label={t('discovery.interval')}>
              {t(`discovery.intervals.${s.intervalMinutes as 1440}`, { defaultValue: t('discovery.everyMinutes', { count: s.intervalMinutes }) })}
            </Fact>
            <Fact label={t('discovery.nextRun')}>{s.enabled ? (s.nextRunAt ? fmtDate(s.nextRunAt) : '–') : t('discovery.paused')}</Fact>
            <Fact label={t('discovery.runsAs')}>{s.runAs}</Fact>
          </SimpleGrid>
        </Section>
        <Section title={t('discovery.runs')} testId="source-runs">
          {runs.data && !runs.data.length && (
            <Text size="sm" c="dimmed">
              {t('discovery.noRuns')}
            </Text>
          )}
          {runs.data && runs.data.length > 0 && (
            <CardTable
              ariaLabel={t('discovery.runs')}
              rows={runs.data}
              rowKey={(r) => r.id}
              rowTestId={() => 'source-run'}
              columns={[
                { key: 'started', header: t('discovery.startedAt'), nowrap: true, cell: (r) => fmtDate(r.startedAt) },
                { key: 'status', header: t('discovery.status'), cell: (r) => <RunStatusBadge status={r.status} size="xs" /> },
                { key: 'duration', header: t('discovery.duration'), nowrap: true, cell: (r) => (r.finishedAt ? fmtDuration(r.durationMs) : '–') },
                {
                  key: 'what',
                  header: t('discovery.what'),
                  cell: (r) => (
                    <>
                      <Text size="sm">{counts(r)}</Text>
                      {runError(r) && (
                        <Text size="xs" c={r.status === 'failed' ? 'red' : 'orange'} data-testid="run-error">
                          {runError(r)}
                        </Text>
                      )}
                      {r.truncated && (
                        <Text size="xs" c="orange">
                          {t('discovery.truncated')}
                        </Text>
                      )}
                    </>
                  ),
                },
                { key: 'by', header: t('discovery.by'), cell: (r) => r.actor },
              ]}
            />
          )}
          <Group mt="sm">
            <Anchor component={Link} to={`/data-elements?platform=${enc(s.platformId)}`} size="sm">
              {t('discovery.toElements')}
            </Anchor>
          </Group>
        </Section>
      </Stack>
      {editing && (
        <SourceForm
          source={s}
          onClose={() => setEditing(false)}
          onSaved={(x) => {
            qc.setQueryData(dpKeys.source(s.id), x);
            invalidate();
            setEditing(false);
          }}
        />
      )}
    </DetailPage>
  );
}

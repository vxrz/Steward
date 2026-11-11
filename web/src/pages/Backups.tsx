import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Code,
  Group,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconCloudUpload, IconKey, IconShieldCheck } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { BackupRun, BackupSettings, BackupStatus, Platform, StoredBackup } from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { PageHeader, QueryState, TONE } from '../components/common';
import { CronPreview } from '../components/CronPreview';
import { fmtBytes, fmtDate, fmtRelative, runDuration } from '../format';
import { platformKeys } from '../queryKeys';
import { DataTable, type DataColumn } from '../components/DataTable';
import { BackupContentsCard } from '../components/backup/BackupContentsCard';

const MIN_PASSPHRASE = 16;

/** Sort order of the result column: failed first. */
const RUN_STATUS_ORDER: BackupRun['status'][] = ['failed', 'running', 'succeeded'];

const statusColor = (s: BackupRun['status']) => (s === 'succeeded' ? TONE.ok : s === 'failed' ? TONE.bad : 'blue');

function RunLine({ run }: { run: BackupRun | null }) {
  const { t } = useTranslation('settings');
  if (!run) return <Text c="dimmed">{t('backups.never')}</Text>;
  return (
    <Group gap="xs" wrap="wrap">
      <Badge color={statusColor(run.status)} variant="light">
        {t(`backups.status.${run.status}`)}
      </Badge>
      <Text size="sm" title={fmtDate(run.startedAt)}>
        {fmtRelative(run.startedAt)}
      </Text>
      {run.message && run.status === 'failed' && (
        <Text size="sm" c={TONE.bad} style={{ overflowWrap: 'anywhere' }}>
          {run.message}
        </Text>
      )}
    </Group>
  );
}

/** Settings → Backups (#117): encrypted backups to S3, the backup passphrase, retention and the restore test. */
export function BackupsPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['backups'],
    queryFn: () => get<BackupStatus>('/backups'),
    enabled: isAdmin,
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms'), enabled: isAdmin });
  const [draft, setDraft] = useState<BackupSettings | null>(null);
  const [pass, setPass] = useState({ a: '', b: '' });
  const [stored, setStored] = useState<StoredBackup[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (status.data && !draft) setDraft(status.data.settings);
  }, [status.data, draft]);

  if (!isAdmin) return <PageHeader back="settings" title={t('backups.title')} description={t('backups.readOnly')} />;
  const s = status.data;
  const s3 = (platforms.data ?? []).filter((p) => p.config.auth?.type === 'aws_sigv4' && p.config.auth.aws?.service === 's3');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['backups'] });

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) notifyOk(ok);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const keptAsOf = (b: StoredBackup) => (
    <Group gap={4}>
      {b.keptAs.length ? (
        b.keptAs.map((k) => (
          <Badge key={k} size="sm" variant="light">
            {t(`backups.kept.${k}`, { defaultValue: k })}
          </Badge>
        ))
      ) : (
        <Text size="xs" c="dimmed">
          {t('backups.kept.none')}
        </Text>
      )}
    </Group>
  );
  const storedColumns: DataColumn<StoredBackup>[] = [
    {
      key: 'object',
      header: t('backups.object'),
      sortValue: (b) => b.key,
      tdProps: () => ({ style: { overflowWrap: 'anywhere' } }),
      cell: (b) => <Code>{b.key}</Code>,
    },
    { key: 'created', header: t('backups.created'), sortValue: (b) => b.createdAt, nowrap: true, cell: (b) => fmtDate(b.createdAt) },
    { key: 'size', header: t('backups.size'), sortValue: (b) => b.size, nowrap: true, cell: (b) => fmtBytes(b.size) },
    { key: 'keptAs', header: t('backups.keptAs'), sortValue: (b) => b.keptAs.length, cell: keptAsOf },
  ];
  const stepsOf = (r: BackupRun) => (
    <Stack gap={2}>
      {r.steps.map((st, i) => (
        <Text key={i} size="xs" c={st.ok ? undefined : TONE.bad} style={{ overflowWrap: 'anywhere' }}>
          {st.ok ? '✓' : '✗'} {st.name}: {st.message}
        </Text>
      ))}
      {!r.steps.length && r.message && (
        <Text size="xs" c={TONE.bad}>
          {r.message}
        </Text>
      )}
      {r.sha256 && (
        <Text size="xs" c="dimmed">
          SHA-256 {r.sha256}
        </Text>
      )}
    </Stack>
  );
  const runColumns: DataColumn<BackupRun>[] = [
    {
      key: 'kind',
      header: t('backups.kind'),
      sortValue: (r) => t(`backups.kinds.${r.kind}`),
      cell: (r) => (
        <>
          {t(`backups.kinds.${r.kind}`)}
          <Text size="xs" c="dimmed">
            {r.trigger === 'manual' ? t('backups.by', { who: r.triggeredBy }) : t('backups.scheduled')}
          </Text>
        </>
      ),
    },
    { key: 'started', header: t('backups.started'), sortValue: (r) => r.startedAt, nowrap: true, cell: (r) => fmtDate(r.startedAt) },
    {
      key: 'duration',
      header: t('backups.duration'),
      sortValue: (r) => (r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null),
      nowrap: true,
      cell: (r) => (r.finishedAt ? runDuration(r.startedAt, r.finishedAt) : '–'),
    },
    {
      key: 'result',
      header: t('backups.result'),
      sortValue: (r) => RUN_STATUS_ORDER.indexOf(r.status),
      cell: (r) => (
        <>
          <Badge color={statusColor(r.status)} variant="light">
            {t(`backups.status.${r.status}`)}
          </Badge>
          {r.objectKey && (
            <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {r.objectKey}
              {r.bytes !== null && ` · ${fmtBytes(r.bytes)}`}
            </Text>
          )}
        </>
      ),
    },
  ];
  const passError =
    pass.a && pass.a.length < MIN_PASSPHRASE
      ? t('backups.key.tooShort', { min: MIN_PASSPHRASE })
      : pass.b && pass.a !== pass.b
        ? t('backups.key.mismatch')
        : null;

  return (
    <>
      <PageHeader back="settings" title={t('backups.title')} description={t('backups.intro')} />
      <QueryState query={status} />
      {s && draft && (
        <Stack>
          {(!s.key || !s.settings.platformId) && (
            <Alert color={TONE.attention} title={t('backups.setupTitle')}>
              {t('backups.setup')}
            </Alert>
          )}
          {s.targetChanged && (
            <Alert color={TONE.attention} icon={<IconAlertTriangle size={18} />} title={t('backups.targetChangedTitle')} data-testid="backup-target-changed">
              <Stack gap="xs" align="flex-start">
                <Text size="sm">{t('backups.targetChanged')}</Text>
                <Button
                  size="xs"
                  variant="default"
                  loading={busy === 'confirm'}
                  onClick={() => void act('confirm', () => post('/backups/confirm-target'), t('backups.targetConfirmed'))}
                >
                  {t('backups.confirmTarget')}
                </Button>
              </Stack>
            </Alert>
          )}
          <Card withBorder>
            <Group gap="xs" mb="sm" wrap="nowrap">
              <IconCloudUpload size={18} aria-hidden />
              <Title order={5}>{t('backups.overview')}</Title>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <div>
                <Text size="xs" c="dimmed">
                  {t('backups.lastBackup')}
                </Text>
                <RunLine run={s.lastBackup} />
              </div>
              <div>
                <Text size="xs" c="dimmed">
                  {t('backups.lastSuccess')}
                </Text>
                {s.lastSuccess ? (
                  <Text size="sm" title={s.lastSuccess.objectKey ?? undefined}>
                    {fmtDate(s.lastSuccess.startedAt)} · {fmtBytes(s.lastSuccess.bytes)}
                  </Text>
                ) : (
                  <Text c="dimmed">{t('backups.never')}</Text>
                )}
              </div>
              <div>
                <Text size="xs" c="dimmed">
                  {t('backups.lastRestoreTest')}
                </Text>
                <RunLine run={s.lastRestoreTest} />
              </div>
              <div>
                <Text size="xs" c="dimmed">
                  {t('backups.next')}
                </Text>
                <Text size="sm">
                  {s.nextBackupAt ? t('backups.nextBackup', { at: fmtDate(s.nextBackupAt) }) : t('backups.notScheduled')}
                  {s.nextRestoreTestAt && ` · ${t('backups.nextTest', { at: fmtDate(s.nextRestoreTestAt) })}`}
                </Text>
              </div>
            </SimpleGrid>
            <Group mt="md" gap="xs">
              <Button
                size="xs"
                loading={busy === 'run' || s.running === 'backup'}
                disabled={!!s.running || !s.key || !s.settings.platformId}
                onClick={() => void act('run', () => post('/backups/run'), t('backups.started'))}
              >
                {t('backups.runNow')}
              </Button>
              <Button
                size="xs"
                variant="light"
                leftSection={<IconShieldCheck size={14} />}
                loading={busy === 'test' || s.running === 'restore_test'}
                disabled={!!s.running || !s.key || !s.settings.platformId}
                onClick={() => void act('test', () => post('/backups/restore-test'), t('backups.testStarted'))}
              >
                {t('backups.testNow')}
              </Button>
            </Group>
          </Card>

          <Card withBorder>
            <Group gap="xs" mb="xs" wrap="nowrap">
              <IconKey size={18} aria-hidden />
              <Title order={5}>{t('backups.key.title')}</Title>
            </Group>
            <Text size="sm" mb="sm">
              {t('backups.key.intro')}
            </Text>
            {s.key && (
              <Text size="sm" mb="sm">
                <Trans
                  t={t}
                  i18nKey="backups.key.current"
                  values={{ keyId: s.key.keyId, by: s.key.setBy, at: fmtDate(s.key.setAt) }}
                  components={{ c: <Code /> }}
                />
              </Text>
            )}
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              <PasswordInput
                label={t('backups.key.passphrase')}
                value={pass.a}
                onChange={(e) => setPass({ ...pass, a: e.currentTarget.value })}
                autoComplete="new-password"
              />
              <PasswordInput
                label={t('backups.key.repeat')}
                value={pass.b}
                onChange={(e) => setPass({ ...pass, b: e.currentTarget.value })}
                autoComplete="new-password"
                error={passError}
              />
            </SimpleGrid>
            {s.key && (
              <Text size="xs" c="dimmed" mt="xs">
                {t('backups.key.changeHint')}
              </Text>
            )}
            <Group mt="sm">
              <Button
                size="xs"
                disabled={!pass.a || pass.a !== pass.b || pass.a.length < MIN_PASSPHRASE}
                loading={busy === 'key'}
                onClick={() =>
                  void act(
                    'key',
                    async () => {
                      await put('/backups/passphrase', { passphrase: pass.a });
                      setPass({ a: '', b: '' });
                    },
                    t('backups.key.saved'),
                  )
                }
              >
                {s.key ? t('backups.key.change') : t('backups.key.set')}
              </Button>
            </Group>
          </Card>

          <Card withBorder>
            <Title order={5} mb="sm">
              {t('backups.settingsTitle')}
            </Title>
            <Stack gap="sm">
              <Switch label={t('backups.enabled')} checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} />
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <Select
                  label={t('backups.storage')}
                  description={t('backups.storageHint')}
                  data={s3.map((p) => ({ value: p.id, label: p.name }))}
                  value={draft.platformId}
                  onChange={(v) => setDraft({ ...draft, platformId: v })}
                  clearable
                  nothingFoundMessage={t('backups.noStorage')}
                />
                <TextInput
                  label={t('backups.prefix')}
                  description={t('backups.prefixHint')}
                  value={draft.prefix}
                  onChange={(e) => setDraft({ ...draft, prefix: e.currentTarget.value })}
                />
                <TextInput
                  label={t('backups.cron')}
                  description={t('backups.cronHint')}
                  value={draft.cron}
                  onChange={(e) => setDraft({ ...draft, cron: e.currentTarget.value })}
                />
                <TextInput label={t('backups.timezone')} value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.currentTarget.value })} />
              </SimpleGrid>
              <CronPreview cron={draft.cron} timezone={draft.timezone} onUse={(c) => setDraft({ ...draft, cron: c })} />
              <Text size="sm" fw={500}>
                {t('backups.retention')}
              </Text>
              <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
                <NumberInput
                  label={t('backups.daily')}
                  min={1}
                  max={366}
                  value={draft.retention.daily}
                  onChange={(v) => setDraft({ ...draft, retention: { ...draft.retention, daily: Number(v) || 1 } })}
                />
                <NumberInput
                  label={t('backups.weekly')}
                  min={0}
                  max={260}
                  value={draft.retention.weekly}
                  onChange={(v) => setDraft({ ...draft, retention: { ...draft.retention, weekly: Number(v) || 0 } })}
                />
                <NumberInput
                  label={t('backups.monthly')}
                  min={0}
                  max={120}
                  value={draft.retention.monthly}
                  onChange={(v) => setDraft({ ...draft, retention: { ...draft.retention, monthly: Number(v) || 0 } })}
                />
              </SimpleGrid>
              <Text size="xs" c="dimmed">
                {t('backups.retentionHint')}
              </Text>
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                <Switch
                  label={t('backups.restoreTest')}
                  description={t('backups.restoreTestHint')}
                  checked={draft.restoreTest.enabled}
                  onChange={(e) => setDraft({ ...draft, restoreTest: { ...draft.restoreTest, enabled: e.currentTarget.checked } })}
                />
                <TextInput
                  label={t('backups.restoreTestCron')}
                  value={draft.restoreTest.cron}
                  disabled={!draft.restoreTest.enabled}
                  onChange={(e) => setDraft({ ...draft, restoreTest: { ...draft.restoreTest, cron: e.currentTarget.value } })}
                />
              </SimpleGrid>
              {draft.restoreTest.enabled && (
                <CronPreview
                  cron={draft.restoreTest.cron}
                  timezone={draft.timezone}
                  onUse={(c) => setDraft({ ...draft, restoreTest: { ...draft.restoreTest, cron: c } })}
                />
              )}
              <Group>
                <Button
                  size="xs"
                  loading={busy === 'save'}
                  onClick={() =>
                    void act(
                      'save',
                      // the contents have their own card: what is stored stays
                      async () => setDraft((await put<BackupStatus>('/backups/settings', { ...draft, exclude: s.settings.exclude })).settings),
                      t('backups.saved'),
                    )
                  }
                >
                  {t('common:save')}
                </Button>
              </Group>
            </Stack>
          </Card>

          <BackupContentsCard status={s} />

          <Card withBorder>
            <Group justify="space-between" mb="sm">
              <Title order={5}>{t('backups.stored')}</Title>
              <Button
                size="xs"
                variant="light"
                disabled={!s.settings.platformId}
                loading={busy === 'list'}
                onClick={() => void act('list', async () => setStored(await get<StoredBackup[]>('/backups/stored')))}
              >
                {t('backups.list')}
              </Button>
            </Group>
            {stored && !stored.length && <Text c="dimmed">{t('backups.noneStored')}</Text>}
            {stored && stored.length > 0 && (
              <DataTable
                rows={stored}
                columns={storedColumns}
                rowKey={(b) => b.key}
                ariaLabel={t('backups.stored')}
                testId="backup-stored"
                rememberSort="backups-stored"
                defaultSort={{ key: 'created', dir: 'desc' }}
                card={(b) => (
                  <Paper withBorder p="sm">
                    <Code style={{ overflowWrap: 'anywhere' }}>{b.key}</Code>
                    <Text size="xs" mt={4}>
                      {fmtDate(b.createdAt)} · {fmtBytes(b.size)}
                    </Text>
                    <Box mt={4}>{keptAsOf(b)}</Box>
                  </Paper>
                )}
              />
            )}
          </Card>

          <Card withBorder>
            <Title order={5} mb="sm">
              {t('backups.runs')}
            </Title>
            {!s.runs.length ? (
              <Text c="dimmed">{t('backups.noRuns')}</Text>
            ) : (
              <DataTable
                rows={s.runs}
                columns={runColumns}
                rowKey={(r) => r.id}
                ariaLabel={t('backups.runs')}
                testId="backup-runs"
                rememberSort="backups-runs"
                defaultSort={{ key: 'started', dir: 'desc' }}
                onRowClick={(r) => setExpanded(expanded === r.id ? null : r.id)}
                rowDetail={(r) => expanded === r.id && stepsOf(r)}
                card={(r) => (
                  <Paper withBorder p="sm" className="clickable" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <div>
                        <Text size="sm" fw={500}>
                          {t(`backups.kinds.${r.kind}`)}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {fmtDate(r.startedAt)}
                          {r.finishedAt && ` · ${runDuration(r.startedAt, r.finishedAt)}`}
                        </Text>
                      </div>
                      <Badge color={statusColor(r.status)} variant="light" style={{ flexShrink: 0 }}>
                        {t(`backups.status.${r.status}`)}
                      </Badge>
                    </Group>
                    {expanded === r.id && <Box mt="xs">{stepsOf(r)}</Box>}
                  </Paper>
                )}
              />
            )}
          </Card>
        </Stack>
      )}
    </>
  );
}

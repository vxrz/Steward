import { Fragment, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCloudUpload, IconKey, IconShieldCheck } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { BackupRun, BackupSettings, BackupStatus, Platform, StoredBackup } from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { PageHeader, QueryState, TONE } from '../components/common';
import { fmtBytes, fmtDate, fmtRelative, runDuration } from '../format';

const MIN_PASSPHRASE = 16;

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
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms'), enabled: isAdmin });
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
              <Group>
                <Button
                  size="xs"
                  loading={busy === 'save'}
                  onClick={() => void act('save', async () => setDraft((await put<BackupStatus>('/backups/settings', draft)).settings), t('backups.saved'))}
                >
                  {t('common:save')}
                </Button>
              </Group>
            </Stack>
          </Card>

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
              <Table.ScrollContainer minWidth={520}>
                <Table striped>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('backups.object')}</Table.Th>
                      <Table.Th>{t('backups.created')}</Table.Th>
                      <Table.Th>{t('backups.size')}</Table.Th>
                      <Table.Th>{t('backups.keptAs')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {stored.map((b) => (
                      <Table.Tr key={b.key}>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>
                          <Code>{b.key}</Code>
                        </Table.Td>
                        <Table.Td>{fmtDate(b.createdAt)}</Table.Td>
                        <Table.Td>{fmtBytes(b.size)}</Table.Td>
                        <Table.Td>
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
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Card>

          <Card withBorder>
            <Title order={5} mb="sm">
              {t('backups.runs')}
            </Title>
            {!s.runs.length ? (
              <Text c="dimmed">{t('backups.noRuns')}</Text>
            ) : (
              <Table.ScrollContainer minWidth={560}>
                <Table highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('backups.kind')}</Table.Th>
                      <Table.Th>{t('backups.started')}</Table.Th>
                      <Table.Th>{t('backups.duration')}</Table.Th>
                      <Table.Th>{t('backups.result')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {s.runs.map((r) => (
                      <Fragment key={r.id}>
                        <Table.Tr style={{ cursor: 'pointer' }} onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
                          <Table.Td>
                            {t(`backups.kinds.${r.kind}`)}
                            <Text size="xs" c="dimmed">
                              {r.trigger === 'manual' ? t('backups.by', { who: r.triggeredBy }) : t('backups.scheduled')}
                            </Text>
                          </Table.Td>
                          <Table.Td>{fmtDate(r.startedAt)}</Table.Td>
                          <Table.Td>{r.finishedAt ? runDuration(r.startedAt, r.finishedAt) : '–'}</Table.Td>
                          <Table.Td>
                            <Badge color={statusColor(r.status)} variant="light">
                              {t(`backups.status.${r.status}`)}
                            </Badge>
                            {r.objectKey && (
                              <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                                {r.objectKey}
                                {r.bytes !== null && ` · ${fmtBytes(r.bytes)}`}
                              </Text>
                            )}
                          </Table.Td>
                        </Table.Tr>
                        {expanded === r.id && (
                          <Table.Tr>
                            <Table.Td colSpan={4}>
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
                            </Table.Td>
                          </Table.Tr>
                        )}
                      </Fragment>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            )}
          </Card>
        </Stack>
      )}
    </>
  );
}

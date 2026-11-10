import { useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconFileExport, IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  bucketFolderProblem,
  DEFAULT_EXPORT_JOB,
  exportNameProblem,
  EXPORT_FISCAL_YEARS,
  EXPORT_LIMITS,
  type ExportJob,
  type ExportJobInput,
  type ExportPartChoice,
  type ExportPartId,
  type ExportPartInfo,
  type ExportRun,
  type ExportsStatus,
  type Platform,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE, useFieldErrors } from '../components/common';
import { CronPreview } from '../components/CronPreview';
import { confirmDanger } from '../components/confirm';
import { DataTable, type DataColumn } from '../components/DataTable';
import { fmtBytes, fmtDate, fmtRelative, runDuration } from '../format';
import { platformKeys } from '../queryKeys';

const statusColor = (s: ExportRun['status']) => (s === 'succeeded' ? TONE.ok : s === 'failed' ? TONE.bad : TONE.active);
const RUN_STATUS_ORDER: ExportRun['status'][] = ['failed', 'running', 'succeeded'];

/** The choice of a part with its default format and options. */
const defaultChoice = (p: ExportPartInfo): ExportPartChoice => ({
  id: p.id,
  format: p.formats[0]!,
  ...(p.options.includes('fiscalYear') ? { fiscalYear: 'current' as const } : {}),
  ...(p.options.includes('days') ? { days: 7 } : {}),
});

function ExportForm({ job, status, onClose }: { job: ExportJob | null; status: ExportsStatus; onClose: () => void }) {
  const { t } = useTranslation(['settings', 'common']);
  const phone = useMediaQuery('(max-width: 48em)');
  const qc = useQueryClient();
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const s3 = (platforms.data ?? []).filter((p) => p.config.auth?.type === 'aws_sigv4' && p.config.auth.aws?.service === 's3');
  const [draft, setDraft] = useState<ExportJobInput>(() =>
    job
      ? {
          name: job.name,
          enabled: job.enabled,
          platformId: job.platformId,
          prefix: job.prefix,
          cron: job.cron,
          timezone: job.timezone,
          parts: job.parts,
          encrypt: job.encrypt,
          keepRuns: job.keepRuns,
        }
      : { ...DEFAULT_EXPORT_JOB, platformId: status.backupPlatformId },
  );
  const [busy, setBusy] = useState(false);
  // the rules the server checks (shared): said at the field, not as a message after saving
  const fields = useFieldErrors({
    name: exportNameProblem(draft.name) && t('exports.nameInvalid', { max: EXPORT_LIMITS.nameMax }),
    prefix: bucketFolderProblem(draft.prefix) && t('exports.prefixInvalid'),
  });
  const partLabel = (id: ExportPartId) => t(`exports.partNames.${id}.label`);
  const choice = (id: string) => draft.parts.find((p) => p.id === id);
  const setChoice = (c: ExportPartChoice) => setDraft({ ...draft, parts: draft.parts.map((p) => (p.id === c.id ? c : p)) });
  const toggle = (p: ExportPartInfo, on: boolean) =>
    setDraft({
      ...draft,
      // in the order of the registry
      parts: on
        ? status.parts.filter((x) => x.id === p.id || draft.parts.some((c) => c.id === x.id)).map((x) => choice(x.id) ?? defaultChoice(x))
        : draft.parts.filter((c) => c.id !== p.id),
    });

  const save = async () => {
    if (!fields.validate()) return;
    setBusy(true);
    try {
      if (job) await put(`/exports/${job.id}`, draft);
      else await post('/exports', draft);
      notifyOk(t('exports.saved'));
      await qc.invalidateQueries({ queryKey: ['exports'] });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={job ? t('exports.editTitle') : t('exports.newTitle')} size="xl" fullScreen={phone}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('exports.name')}
              description={t('exports.nameHint')}
              required
              maxLength={EXPORT_LIMITS.nameMax}
              error={fields.error('name')}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
            />
            <Select
              label={t('exports.storage')}
              description={t('exports.storageHint')}
              data={s3.map((p) => ({ value: p.id, label: p.name }))}
              value={draft.platformId}
              onChange={(v) => setDraft({ ...draft, platformId: v })}
              rightSection={platforms.isLoading ? <Loader size="xs" /> : undefined}
              required
            />
            <TextInput
              label={t('exports.prefix')}
              description={t('exports.prefixHint')}
              error={fields.error('prefix')}
              value={draft.prefix}
              onChange={(e) => setDraft({ ...draft, prefix: e.currentTarget.value })}
            />
            <NumberInput
              label={t('exports.keepRuns')}
              description={t('exports.keepRunsHint')}
              min={1}
              max={EXPORT_LIMITS.keepRunsMax}
              value={draft.keepRuns}
              onChange={(v) => setDraft({ ...draft, keepRuns: Number(v) || 1 })}
            />
          </SimpleGrid>
          {platforms.isSuccess && !s3.length && (
            <Alert color={TONE.attention} icon={<IconInfoCircle size={18} />}>
              <Stack gap="xs" align="flex-start">
                <Text size="sm">{t('exports.noStorage')}</Text>
                <Button size="xs" variant="default" component={Link} to="/platforms">
                  {t('exports.openPlatforms')}
                </Button>
              </Stack>
            </Alert>
          )}
          <Switch label={t('exports.enabled')} checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.currentTarget.checked })} />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('exports.cron')}
              description={t('exports.cronHint')}
              value={draft.cron}
              onChange={(e) => setDraft({ ...draft, cron: e.currentTarget.value })}
            />
            <TextInput label={t('exports.timezone')} value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.currentTarget.value })} />
          </SimpleGrid>
          <CronPreview cron={draft.cron} timezone={draft.timezone} onUse={(c) => setDraft({ ...draft, cron: c })} />

          <Text size="sm" fw={500} id="export-parts-label">
            {t('exports.parts')}
          </Text>
          <Stack gap="xs" role="group" aria-labelledby="export-parts-label">
            {status.parts.map((p) => {
              const c = choice(p.id);
              return (
                <Paper key={p.id} withBorder p="xs">
                  <Checkbox
                    checked={!!c}
                    label={partLabel(p.id)}
                    description={t(`exports.partNames.${p.id}.description`)}
                    onChange={(e) => toggle(p, e.currentTarget.checked)}
                    data-testid={`export-part-${p.id}`}
                  />
                  {!p.available && (
                    <Text size="xs" c={TONE.attention} mt={4} pl={32}>
                      {t('exports.moduleOff')}
                    </Text>
                  )}
                  {c && (p.formats.length > 1 || p.options.length > 0) && (
                    <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs" mt="xs" pl={{ base: 0, xs: 32 }}>
                      {p.formats.length > 1 && (
                        <Select
                          size="xs"
                          label={t('exports.format', { part: partLabel(p.id) })}
                          data={p.formats.map((f) => ({ value: f, label: f.toUpperCase() }))}
                          value={c.format}
                          allowDeselect={false}
                          onChange={(v) => v && setChoice({ ...c, format: v as ExportPartChoice['format'] })}
                        />
                      )}
                      {p.options.includes('fiscalYear') && (
                        <Select
                          size="xs"
                          label={t('exports.fiscalYear')}
                          data={EXPORT_FISCAL_YEARS.map((y) => ({ value: y, label: t(`exports.fiscalYears.${y}`) }))}
                          value={c.fiscalYear ?? 'current'}
                          allowDeselect={false}
                          onChange={(v) => v && setChoice({ ...c, fiscalYear: v as ExportPartChoice['fiscalYear'] })}
                        />
                      )}
                      {p.options.includes('days') && (
                        <NumberInput
                          size="xs"
                          label={t('exports.days')}
                          min={1}
                          max={EXPORT_LIMITS.auditDaysMax}
                          value={c.days ?? 7}
                          onChange={(v) => setChoice({ ...c, days: Math.max(1, Number(v) || 1) })}
                        />
                      )}
                    </SimpleGrid>
                  )}
                </Paper>
              );
            })}
          </Stack>
          {!draft.parts.length && (
            <Text size="xs" c="dimmed">
              {t('exports.partsHint')}
            </Text>
          )}
          <Switch
            label={t('exports.encrypt')}
            description={status.encryptionAvailable ? t('exports.encryptHint') : t('exports.encryptNoKey')}
            checked={draft.encrypt}
            disabled={!status.encryptionAvailable && !draft.encrypt}
            onChange={(e) => setDraft({ ...draft, encrypt: e.currentTarget.checked })}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!draft.name.trim() || !draft.platformId || !draft.parts.length}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

function RunHistory({ job }: { job: ExportJob }) {
  const { t } = useTranslation('settings');
  const runs = useQuery({
    queryKey: ['exports', job.id, 'runs'],
    queryFn: () => get<ExportRun[]>(`/exports/${job.id}/runs`),
    refetchInterval: job.running ? 2000 : false,
  });
  const [expanded, setExpanded] = useState<string | null>(null);
  const filesOf = (r: ExportRun) => (
    <Stack gap={2}>
      {r.folder && (
        <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
          <Code>{r.folder}</Code>
        </Text>
      )}
      {r.files.map((f) => (
        <Text key={f.key} size="xs" style={{ overflowWrap: 'anywhere' }}>
          {f.name} · {fmtBytes(f.bytes)} · SHA-256 {f.sha256.slice(0, 16)}…
        </Text>
      ))}
      {r.message && (
        <Text size="xs" c={r.status === 'failed' ? TONE.bad : TONE.attention} style={{ overflowWrap: 'anywhere' }}>
          {r.message}
        </Text>
      )}
      {r.pruned && (
        <Text size="xs" c="dimmed">
          {t('exports.pruned')}
        </Text>
      )}
    </Stack>
  );
  const columns: DataColumn<ExportRun>[] = [
    {
      key: 'started',
      header: t('exports.started'),
      sortValue: (r) => r.startedAt,
      nowrap: true,
      cell: (r) => (
        <>
          {fmtDate(r.startedAt)}
          <Text size="xs" c="dimmed">
            {r.trigger === 'manual' ? t('exports.by', { who: r.triggeredBy }) : t('exports.scheduled')}
            {r.finishedAt && ` · ${runDuration(r.startedAt, r.finishedAt)}`}
          </Text>
        </>
      ),
    },
    {
      key: 'result',
      header: t('exports.result'),
      sortValue: (r) => RUN_STATUS_ORDER.indexOf(r.status),
      cell: (r) => (
        <Badge color={statusColor(r.status)} variant="light">
          {t(`exports.status.${r.status}`)}
        </Badge>
      ),
    },
    { key: 'files', header: t('exports.files'), sortValue: (r) => r.files.length, cell: (r) => r.files.length },
    { key: 'size', header: t('exports.size'), sortValue: (r) => r.bytes, nowrap: true, cell: (r) => fmtBytes(r.bytes) },
  ];
  return (
    <Box mt="sm">
      <QueryState query={runs} />
      {runs.data && !runs.data.length && <Text c="dimmed">{t('exports.noRuns')}</Text>}
      {runs.data && runs.data.length > 0 && (
        <DataTable
          rows={runs.data}
          columns={columns}
          rowKey={(r) => r.id}
          ariaLabel={t('exports.history', { name: job.name })}
          testId="export-runs"
          rememberSort="export-runs"
          defaultSort={{ key: 'started', dir: 'desc' }}
          onRowClick={(r) => setExpanded(expanded === r.id ? null : r.id)}
          rowDetail={(r) => expanded === r.id && filesOf(r)}
          card={(r) => (
            <Paper withBorder p="sm" className="clickable" onClick={() => setExpanded(expanded === r.id ? null : r.id)}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div>
                  <Text size="sm">{fmtDate(r.startedAt)}</Text>
                  <Text size="xs" c="dimmed">
                    {t('exports.files')}: {r.files.length} · {fmtBytes(r.bytes)}
                  </Text>
                </div>
                <Badge color={statusColor(r.status)} variant="light" style={{ flexShrink: 0 }}>
                  {t(`exports.status.${r.status}`)}
                </Badge>
              </Group>
              {expanded === r.id && <Box mt="xs">{filesOf(r)}</Box>}
            </Paper>
          )}
        />
      )}
    </Box>
  );
}

function ExportCard({ job, status, onEdit }: { job: ExportJob; status: ExportsStatus; onEdit: () => void }) {
  const { t } = useTranslation(['settings', 'common']);
  const qc = useQueryClient();
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['exports'] });
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      notifyOk(ok);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const unavailable = new Set(status.parts.filter((p) => !p.available).map((p) => p.id));
  return (
    <Card withBorder data-testid="export-card">
      <Group justify="space-between" wrap="wrap" align="flex-start" gap="xs">
        <div style={{ minWidth: 0 }}>
          <Title order={5} style={{ overflowWrap: 'anywhere' }}>
            {job.name}
          </Title>
          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
            <Code>
              {job.prefix}
              {job.name}/
            </Code>{' '}
            · {job.encrypt ? t('exports.encrypted') : t('exports.readable')}
          </Text>
        </div>
        <Group gap="xs">
          <Button
            size="xs"
            loading={busy === 'run' || job.running}
            disabled={job.running}
            onClick={() => void act('run', () => post(`/exports/${job.id}/run`), t('exports.runStarted'))}
          >
            {t('exports.runNow')}
          </Button>
          <Button size="xs" variant="default" onClick={onEdit}>
            {t('exports.edit')}
          </Button>
          <Button
            size="xs"
            variant="subtle"
            color="red"
            loading={busy === 'remove'}
            onClick={() =>
              void confirmDanger({ action: 'remove', message: t('exports.removeConfirm', { name: job.name }) }).then(async (ok) => {
                if (ok) await act('remove', () => del(`/exports/${job.id}`), t('exports.removed'));
              })
            }
          >
            {t('exports.remove')}
          </Button>
        </Group>
      </Group>
      {job.targetChanged && (
        <Alert
          color={TONE.attention}
          icon={<IconAlertTriangle size={18} />}
          title={t('exports.targetChangedTitle')}
          mt="sm"
          data-testid="export-target-changed"
        >
          <Stack gap="xs" align="flex-start">
            <Text size="sm">{t('exports.targetChanged')}</Text>
            <Button
              size="xs"
              variant="default"
              loading={busy === 'confirm'}
              onClick={() => void act('confirm', () => post(`/exports/${job.id}/confirm-target`), t('exports.targetConfirmed'))}
            >
              {t('exports.confirmTarget')}
            </Button>
          </Stack>
        </Alert>
      )}
      <Group gap={4} mt="xs" wrap="wrap">
        {job.parts.map((p) => (
          <Badge
            key={p.id}
            variant="light"
            color={unavailable.has(p.id) ? TONE.attention : TONE.neutral}
            title={unavailable.has(p.id) ? t('exports.moduleOff') : undefined}
          >
            {t(`exports.partNames.${p.id}.label`)} · {p.format.toUpperCase()}
          </Badge>
        ))}
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" mt="sm">
        <div>
          <Text size="xs" c="dimmed">
            {t('exports.lastRun')}
          </Text>
          {job.lastRun ? (
            <Group gap="xs" wrap="wrap">
              <Badge color={statusColor(job.lastRun.status)} variant="light" data-testid="export-last-status">
                {t(`exports.status.${job.lastRun.status}`)}
              </Badge>
              <Text size="sm" title={fmtDate(job.lastRun.startedAt)}>
                {fmtRelative(job.lastRun.startedAt)}
              </Text>
              {job.lastRun.message && (
                <Text size="xs" c={job.lastRun.status === 'failed' ? TONE.bad : TONE.attention} style={{ overflowWrap: 'anywhere' }}>
                  {job.lastRun.message}
                </Text>
              )}
            </Group>
          ) : (
            <Text size="sm" c="dimmed">
              {t('exports.never')}
            </Text>
          )}
        </div>
        <div>
          <Text size="xs" c="dimmed">
            {t('exports.nextRun')}
          </Text>
          <Text size="sm">{job.nextRunAt ? fmtDate(job.nextRunAt) : t('exports.notScheduled')}</Text>
        </div>
      </SimpleGrid>
      <Button size="xs" variant="subtle" mt="xs" px={0} onClick={() => setHistory(!history)} aria-expanded={history}>
        {t('exports.showHistory')}
      </Button>
      {history && <RunHistory job={job} />}
    </Card>
  );
}

/** Settings → Exports (0.16.0, docs/EXPORTS.md): scheduled exports of readable files to S3. */
export function ExportsPage() {
  const { t } = useTranslation(['settings', 'common']);
  const { isAdmin } = useMe();
  const status = useQuery({
    queryKey: ['exports'],
    queryFn: () => get<ExportsStatus>('/exports'),
    enabled: isAdmin,
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.running) ? 2000 : false),
  });
  const [editing, setEditing] = useState<ExportJob | 'new' | null>(null);
  if (!isAdmin) return <PageHeader back="settings" title={t('exports.title')} description={t('exports.readOnly')} />;
  const s = status.data;
  return (
    <>
      <PageHeader
        back="settings"
        title={t('exports.title')}
        description={t('exports.intro')}
        actions={
          s && (
            <Button leftSection={<IconFileExport size={16} />} onClick={() => setEditing('new')}>
              {t('exports.new')}
            </Button>
          )
        }
      />
      <QueryState query={status} />
      {s && (
        <Stack>
          <Alert color="blue" icon={<IconInfoCircle size={18} />}>
            {t('exports.notForRestore')}
          </Alert>
          {!s.jobs.length && (
            <EmptyState icon={IconFileExport} title={t('exports.none')} whoCanAct={t('exports.whoCanAct')}>
              {t('exports.noneText')}
            </EmptyState>
          )}
          {s.jobs.map((j) => (
            <ExportCard key={j.id} job={j} status={s} onEdit={() => setEditing(j)} />
          ))}
        </Stack>
      )}
      {s && editing && <ExportForm job={editing === 'new' ? null : editing} status={s} onClose={() => setEditing(null)} />}
    </>
  );
}

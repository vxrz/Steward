import { useEffect, useState } from 'react';
import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Chip,
  Divider,
  Group,
  Modal,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  VisuallyHidden,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconCalendarTime, IconEdit, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { DEFAULT_SCHEDULE_NOTIFY, type ProcessDetail, type ProcessSummary, type Schedule } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { QueryState, StatusBadge, useCreateParam, useFieldErrors } from '../components/common';
import { AutomateTabs } from '../components/page/LinkTabs';
import { InputsForm, defaultInputs } from '../components/InputsForm';
import { BindingsForm, loadBindings } from '../components/RunDialog';
import { fmtDate, fmtRelative } from '../format';
import i18n from '../i18n';
import { errorText } from '../i18n/errors';
import { confirmDanger } from '../components/confirm';
import { RunModeField } from '../components/RunModeField';
import { NotifyPolicyFields, PauseBadge, PauseControl } from '../components/notify/NotifyPolicy';
import { CronWarnings, useCronPreview } from '../components/CronPreview';
import { ListPage } from '../components/page/ListPage';
import { useListParams } from '../components/page/params';
import { DataTable, ListFooter, type DataColumn } from '../components/DataTable';
import { processKeys, scheduleKeys } from '../queryKeys';
import { DuplicateActionIcon, useDuplicate } from '../components/duplicate/DuplicateButton';

const PRESETS = [
  { key: 'every15', cron: '*/15 * * * *' },
  { key: 'hourly', cron: '0 * * * *' },
  { key: 'daily', cron: '0 7 * * *' },
  { key: 'weekdays', cron: '0 7 * * 1-5' },
  { key: 'mondays', cron: '0 6 * * 1' },
  { key: 'monthly', cron: '0 6 1 * *' },
  { key: 'quarterly', cron: '0 6 1 1,4,7,10 *' },
] as const;

type Draft = Omit<Schedule, 'id' | 'createdAt' | 'processName' | 'lastRunAt' | 'lastRunId' | 'lastRunStatus' | 'nextRunAt' | 'missed'> & { id?: string };

const emptyDraft = (): Draft => ({
  name: '',
  processId: '',
  cron: '0 7 * * 1-5',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  inputs: {},
  bindings: {},
  dryRun: false,
  enabled: true,
  allowOverlap: false,
  catchUp: 'none',
  notify: { ...DEFAULT_SCHEDULE_NOTIFY },
});

const MISSED_SHOWN_DAYS = 7;

/** Fires missed while Steward was not running (found at its last start), for a week after they were found. */
function MissedBadge({ missed }: { missed?: Schedule['missed'] }) {
  const { t } = useTranslation('schedules');
  if (!missed || Date.now() - Date.parse(missed.detectedAt) > MISSED_SHOWN_DAYS * 86400000) return null;
  const times = missed.times.map((x) => fmtDate(x)).join(', ') + (missed.count > missed.times.length ? ` … (${missed.count})` : '');
  return (
    <Tooltip
      multiline
      maw={360}
      label={`${t('missed.tooltip', { times, when: fmtDate(missed.detectedAt) })} ${missed.catchUp ? t('missed.caughtUp') : t('missed.notCaughtUp')}`}
    >
      <Badge size="xs" color="orange" variant="light" data-testid="schedule-missed">
        {t('missed.badge', { count: missed.count })}
      </Badge>
    </Tooltip>
  );
}

export function SchedulesPage() {
  const { t } = useTranslation(['schedules', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const schedules = useQuery({ queryKey: scheduleKeys.all, queryFn: () => get<Schedule[]>('/schedules'), refetchInterval: 10000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const duplicate = useDuplicate();
  // ?new=1 opens a new schedule; &processId=… preselects the process (the template gallery's next steps)
  useCreateParam(true, () => setDraft({ ...emptyDraft(), processId: new URLSearchParams(window.location.search).get('processId') ?? '' }));

  // ?edit=<id> (links in messages, #139) opens the schedule
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const id = params.get('edit');
    const found = id && schedules.data?.find((x) => x.id === id);
    if (found && found.canEdit) {
      setDraft({ ...found });
      params.delete('edit');
      setParams(params, { replace: true });
    }
  }, [params, schedules.data, setParams]);

  const save = async (s: Draft) => {
    // the pause has its own actions
    const { id, ...rest } = s;
    const body = { ...rest, ...(rest.notify ? { notify: { ...rest.notify, pause: undefined } } : {}) };
    try {
      if (id) await put(`/schedules/${id}`, body);
      else await post('/schedules', body);
      qc.invalidateQueries({ queryKey: scheduleKeys.all });
      return true;
    } catch (e) {
      notifyError(e, t('notSaved'));
      return false;
    }
  };

  // the filters live in the address (?q=, ?state=, ?owner=), so a filtered list can be shared
  const q = params.get('q') ?? '';
  const state = params.get('state');
  const owner = params.get('owner');
  const { set: setFilter } = useListParams();
  const needle = q.trim().toLowerCase();
  const list = (schedules.data ?? []).filter(
    (s) =>
      (!needle || [s.name, s.processName ?? '', s.owner ?? '', s.cron].some((x) => x.toLowerCase().includes(needle))) &&
      (!state || (state === 'active') === s.enabled) &&
      (!owner || s.owner === owner),
  );
  const owners = [...new Set([...(schedules.data ?? []).map((s) => s.owner ?? ''), owner ?? ''])].filter(Boolean).sort();

  const enabledSwitch = (s: Schedule) => (
    <Switch size="xs" checked={s.enabled} disabled={!s.canEdit} onChange={(e) => save({ ...s, enabled: e.currentTarget.checked })} aria-label={t('enabled')} />
  );
  const nameOf = (s: Schedule) => (
    <>
      <Group gap={6}>
        <Text size="sm" fw={500}>
          {s.name}
        </Text>
        <PauseBadge pause={s.notify?.pause} />
        <MissedBadge missed={s.missed} />
      </Group>
      <Text size="xs" c="dimmed">
        <Link to={`/processes/${s.processId}`}>{s.processName}</Link>
        {s.owner && ` · ${t('table.runsAs', { owner: s.owner })}`}
        {s.dryRun && (
          <Badge ml={4} size="xs" color="yellow" variant="light">
            {t('common:status.dryrun')}
          </Badge>
        )}
      </Text>
    </>
  );
  const lastRunOf = (s: Schedule) =>
    s.lastRunId ? (
      <Anchor size="sm" component={Link} to={`/runs/${s.lastRunId}`} underline="never" c="var(--mantine-color-text)">
        <Group gap={4} wrap="nowrap">
          {s.lastRunStatus && <StatusBadge status={s.lastRunStatus} size="xs" />}
          <Text size="xs">{fmtRelative(s.lastRunAt)}</Text>
        </Group>
      </Anchor>
    ) : (
      '–'
    );
  const actionsOf = (s: Schedule) => (
    <Group gap={2} wrap="nowrap" justify="flex-end">
      <Tooltip label={t('table.runNow')}>
        <ActionIcon
          variant="subtle"
          onClick={async () => {
            try {
              const r = await post<{ id: string }>(`/schedules/${s.id}/run`);
              navigate(`/runs/${r.id}`);
            } catch (e) {
              notifyError(e);
            }
          }}
          aria-label={t('table.runNow')}
        >
          <IconPlayerPlay size={16} />
        </ActionIcon>
      </Tooltip>
      <DuplicateActionIcon name={s.name} onClick={() => duplicate.open('schedule', s.id)} />
      {s.canEdit && (
        <PauseControl
          pause={s.notify?.pause}
          onPause={async (p) => {
            try {
              await post(`/schedules/${s.id}/pause`, { until: p.until, reason: p.reason, inApp: p.inApp });
              await qc.invalidateQueries({ queryKey: scheduleKeys.all });
            } catch (e) {
              notifyError(e);
            }
          }}
          onResume={async () => {
            try {
              await post(`/schedules/${s.id}/resume`, {});
              await qc.invalidateQueries({ queryKey: scheduleKeys.all });
            } catch (e) {
              notifyError(e);
            }
          }}
        />
      )}
      {s.canEdit && (
        <ActionIcon variant="subtle" onClick={() => setDraft({ ...s })} aria-label={t('common:edit')}>
          <IconEdit size={16} />
        </ActionIcon>
      )}
      {s.canEdit && (
        <ActionIcon
          variant="subtle"
          color="red"
          aria-label={t('common:delete')}
          onClick={async () => {
            if (!(await confirmDanger({ action: 'delete', message: t('deleteConfirm', { name: s.name }) }))) return;
            await del(`/schedules/${s.id}`).catch(notifyError);
            qc.invalidateQueries({ queryKey: scheduleKeys.all });
          }}
        >
          <IconTrash size={16} />
        </ActionIcon>
      )}
    </Group>
  );
  const columns: DataColumn<Schedule>[] = [
    { key: 'active', header: t('table.active'), sortValue: (s) => (s.enabled ? 1 : 0), cell: enabledSwitch },
    { key: 'name', header: t('table.name'), sortValue: (s) => s.name, cell: nameOf },
    {
      key: 'when',
      header: t('table.when'),
      cell: (s) => (
        <>
          <span className="mono">{s.cron}</span>
          <Text size="xs" c="dimmed">
            {presetLabel(s.cron)} {s.timezone}
          </Text>
        </>
      ),
    },
    {
      key: 'next',
      header: t('table.next'),
      sortValue: (s) => (s.enabled ? s.nextRunAt : null),
      nowrap: true,
      cell: (s) => (s.enabled && s.nextRunAt ? `${fmtDate(s.nextRunAt)} (${fmtRelative(s.nextRunAt)})` : '–'),
    },
    { key: 'last', header: t('table.last'), sortValue: (s) => s.lastRunAt, cell: lastRunOf },
    { key: 'actions', header: <VisuallyHidden>{t('table.actions')}</VisuallyHidden>, label: t('table.actions'), cell: actionsOf },
  ];

  return (
    <ListPage
      tabs={<AutomateTabs active="/schedules" />}
      title={t('title')}
      description={t('description')}
      view="schedules"
      primaryAction={
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft(emptyDraft())}>
          {t('new')}
        </Button>
      }
      search={{ value: q, onChange: (v) => setFilter('q', v), placeholder: t('filters.search') }}
      activeFilters={[state, owner].filter(Boolean).length}
      filters={
        schedules.data?.length ? (
          <Group gap="sm" mb="md" align="flex-end" wrap="wrap" data-testid="schedule-filters">
            <Select
              size="xs"
              label={t('filters.state')}
              data={[
                { value: 'active', label: t('filters.active') },
                { value: 'inactive', label: t('filters.inactive') },
              ]}
              value={state}
              onChange={(v) => setFilter('state', v)}
              clearable
              w={{ base: '100%', xs: 180 }}
            />
            <Select
              size="xs"
              label={t('filters.owner')}
              data={owners}
              value={owner}
              onChange={(v) => setFilter('owner', v)}
              clearable
              searchable
              w={{ base: '100%', xs: 200 }}
            />
          </Group>
        ) : undefined
      }
      empty={{
        show: schedules.data?.length === 0,
        icon: IconCalendarTime,
        title: t('emptyState.title'),
        text: t('emptyState.text'),
        whoCanAct: t('common:whoCanAct.schedules'),
        action: (
          <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft(emptyDraft())}>
            {t('emptyState.action')}
          </Button>
        ),
      }}
    >
      <QueryState query={schedules} />
      {!!schedules.data?.length && list.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('filters.noMatch')}
        </Text>
      )}
      {list.length > 0 && (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(s) => s.id}
          ariaLabel={t('title')}
          testId="schedule-list"
          rememberSort="schedules"
          defaultSort={{ key: 'name', dir: 'asc' }}
          footer={<ListFooter shown={list.length} total={schedules.data?.length} />}
          card={(s) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>{nameOf(s)}</div>
                {enabledSwitch(s)}
              </Group>
              <Text size="xs" mt={4}>
                <span className="mono">{s.cron}</span> {presetLabel(s.cron)} {s.timezone}
              </Text>
              <Text size="xs" c="dimmed">
                {t('table.next')}: {s.enabled && s.nextRunAt ? fmtRelative(s.nextRunAt) : '–'}
              </Text>
              <Group justify="space-between" wrap="nowrap" mt={4}>
                {lastRunOf(s)}
                {actionsOf(s)}
              </Group>
            </Paper>
          )}
        />
      )}
      {draft && (
        <ScheduleModal
          draft={draft}
          onClose={() => setDraft(null)}
          onSave={async (d) => {
            if (await save(d)) {
              notifyOk(t('saved'));
              setDraft(null);
            }
          }}
        />
      )}
      {duplicate.dialog}
    </ListPage>
  );
}

function presetLabel(cron: string): string {
  const p = PRESETS.find((x) => x.cron === cron);
  return p ? i18n.t(`schedules:presets.${p.key}`) : '';
}

function ScheduleModal({ draft, onClose, onSave }: { draft: Draft; onClose: () => void; onSave: (d: Draft) => void }) {
  const { t } = useTranslation(['schedules', 'common']);
  const [d, setD] = useState<Draft>(draft);
  const processes = useQuery({ queryKey: processKeys.all, queryFn: () => get<ProcessSummary[]>('/processes') });
  const proc = useQuery({
    queryKey: processKeys.detail(d.processId),
    queryFn: () => get<ProcessDetail>(`/processes/${d.processId}`),
    enabled: !!d.processId,
  });
  const preview = useCronPreview(d.cron, d.timezone);

  useEffect(() => {
    if (proc.data && !draft.id && d.processId === proc.data.id && Object.keys(d.inputs).length === 0) {
      setD((x) => ({
        ...x,
        inputs: defaultInputs(proc.data.definition.inputs),
        bindings: loadBindings(proc.data.id),
        name: x.name || proc.data.name,
      }));
    }
  }, [proc.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = useFieldErrors({
    process: !d.processId && t('common:validation.required'),
    name: !d.name.trim() && t('common:validation.required'),
    cron: !d.cron.trim() && t('common:validation.required'),
  });
  return (
    <Modal opened onClose={onClose} title={draft.id ? t('edit') : t('new')} size="lg">
      <Stack>
        <Select
          label={t('form.process')}
          required
          searchable
          data={(processes.data ?? []).filter((p) => p.permissions.includes('run')).map((p) => ({ value: p.id, label: p.name }))}
          value={d.processId || null}
          onChange={(p) => setD({ ...d, processId: p ?? '', inputs: {}, bindings: {} })}
          error={v.error('process')}
        />
        <TextInput label={t('form.name')} required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} error={v.error('name')} />
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('form.when')}
          </Text>
          <Chip.Group>
            <Group gap={6} mb={6}>
              {PRESETS.map((p) => (
                <Chip key={p.cron} size="xs" checked={d.cron === p.cron} onChange={() => setD({ ...d, cron: p.cron })}>
                  {t(`presets.${p.key}`)}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Group grow align="flex-start">
            <TextInput
              label={t('form.cron')}
              description={t('form.cronHint')}
              classNames={{ input: 'mono' }}
              value={d.cron}
              onChange={(e) => setD({ ...d, cron: e.currentTarget.value })}
              error={v.error('cron') ?? (preview.error ? errorText(preview.error) : undefined)}
            />
            <TextInput label={t('form.timezone')} value={d.timezone ?? ''} onChange={(e) => setD({ ...d, timezone: e.currentTarget.value })} />
          </Group>
          {preview.data && (
            <Text size="xs" c="dimmed" mt={4}>
              {t('form.next', {
                dates: preview.data.next
                  .slice(0, 3)
                  .map((n) => fmtDate(n))
                  .join(' · '),
              })}
            </Text>
          )}
          <CronWarnings warnings={preview.data?.warnings} onUse={(c) => setD({ ...d, cron: c })} />
        </div>
        {proc.data && (
          <>
            <Divider label={t('form.connectionsInputs')} labelPosition="left" />
            <BindingsForm process={proc.data} value={d.bindings} onChange={(b) => setD({ ...d, bindings: b })} />
            <InputsForm defs={proc.data.definition.inputs} value={d.inputs} onChange={(i) => setD({ ...d, inputs: i })} />
          </>
        )}
        <Divider />
        <Text size="xs" c="dimmed">
          {draft.owner ? <Trans t={t} i18nKey="form.rightsOwner" values={{ owner: draft.owner }} components={{ b: <b /> }} /> : t('form.rightsYou')}
        </Text>
        <Switch label={t('enabled')} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <RunModeField modes={['dry', 'real']} value={d.dryRun ? 'dry' : 'real'} onChange={(m) => setD({ ...d, dryRun: m === 'dry' })} />
        <Switch
          label={t('form.overlap')}
          description={t('form.overlapHint')}
          checked={d.allowOverlap}
          onChange={(e) => setD({ ...d, allowOverlap: e.currentTarget.checked })}
        />
        <Switch
          label={t('form.catchUp')}
          description={t('form.catchUpHint')}
          checked={d.catchUp === 'once'}
          onChange={(e) => setD({ ...d, catchUp: e.currentTarget.checked ? 'once' : 'none' })}
        />
        <NotifyPolicyFields value={d.notify ?? DEFAULT_SCHEDULE_NOTIFY} onChange={(notify) => setD({ ...d, notify })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => v.validate() && onSave(d)}>{t('common:save')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

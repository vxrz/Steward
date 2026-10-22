import { useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Chip, Divider, Group, Modal, Select, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconEdit, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { ProcessDetail, ProcessSummary, Schedule } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { PageHeader, StatusBadge } from '../components/common';
import { InputsForm, defaultInputs } from '../components/InputsForm';
import { BindingsForm, loadBindings } from '../components/RunDialog';
import { fmtDate, fmtRelative } from '../format';
import i18n from '../i18n';

const PRESETS = [
  { key: 'every15', cron: '*/15 * * * *' },
  { key: 'hourly', cron: '0 * * * *' },
  { key: 'daily', cron: '0 7 * * *' },
  { key: 'weekdays', cron: '0 7 * * 1-5' },
  { key: 'mondays', cron: '0 6 * * 1' },
  { key: 'monthly', cron: '0 6 1 * *' },
  { key: 'quarterly', cron: '0 6 1 1,4,7,10 *' },
] as const;

type Draft = Omit<Schedule, 'id' | 'createdAt' | 'processName' | 'lastRunAt' | 'lastRunId' | 'lastRunStatus' | 'nextRunAt'> & { id?: string };

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
});

export function SchedulesPage() {
  const { t } = useTranslation(['schedules', 'common']);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => get<Schedule[]>('/schedules'), refetchInterval: 10000 });
  const [draft, setDraft] = useState<Draft | null>(null);

  const save = async (s: Draft) => {
    const { id, ...body } = s;
    try {
      if (id) await put(`/schedules/${id}`, body);
      else await post('/schedules', body);
      qc.invalidateQueries({ queryKey: ['schedules'] });
      return true;
    } catch (e) {
      notifyError(e, t('notSaved'));
      return false;
    }
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft(emptyDraft())}>
            {t('new')}
          </Button>
        }
      />
      {schedules.data?.length === 0 && <Text c="dimmed" size="sm">{t('empty')}</Text>}
      {!!schedules.data?.length && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('table.active')}</Table.Th>
                <Table.Th>{t('table.name')}</Table.Th>
                <Table.Th>{t('table.when')}</Table.Th>
                <Table.Th>{t('table.next')}</Table.Th>
                <Table.Th>{t('table.last')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {schedules.data.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>
                    <Switch
                      size="xs"
                      checked={s.enabled}
                      disabled={!s.canEdit}
                      onChange={(e) => save({ ...s, enabled: e.currentTarget.checked })}
                      aria-label={t('enabled')}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {s.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      <Link to={`/processes/${s.processId}`}>{s.processName}</Link>
                      {s.owner && ` · ${t('table.runsAs', { owner: s.owner })}`}
                      {s.dryRun && (
                        <Badge ml={4} size="xs" color="yellow" variant="light">
                          {t('common:status.dryrun')}
                        </Badge>
                      )}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <span className="mono">{s.cron}</span>
                    <Text size="xs" c="dimmed">
                      {presetLabel(s.cron)} {s.timezone}
                    </Text>
                  </Table.Td>
                  <Table.Td className="nowrap">{s.enabled && s.nextRunAt ? `${fmtDate(s.nextRunAt)} (${fmtRelative(s.nextRunAt)})` : '–'}</Table.Td>
                  <Table.Td>
                    {s.lastRunId ? (
                      <Group gap={4} className="clickable" onClick={() => navigate(`/runs/${s.lastRunId}`)} wrap="nowrap">
                        {s.lastRunStatus && <StatusBadge status={s.lastRunStatus} size="xs" />}
                        <Text size="xs">{fmtRelative(s.lastRunAt)}</Text>
                      </Group>
                    ) : (
                      '–'
                    )}
                  </Table.Td>
                  <Table.Td>
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
                          if (!confirm(t('deleteConfirm', { name: s.name }))) return;
                          await del(`/schedules/${s.id}`).catch(notifyError);
                          qc.invalidateQueries({ queryKey: ['schedules'] });
                        }}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
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
    </>
  );
}

function presetLabel(cron: string): string {
  const p = PRESETS.find((x) => x.cron === cron);
  return p ? i18n.t(`schedules:presets.${p.key}`) : '';
}

function ScheduleModal({ draft, onClose, onSave }: { draft: Draft; onClose: () => void; onSave: (d: Draft) => void }) {
  const { t } = useTranslation(['schedules', 'common']);
  const [d, setD] = useState<Draft>(draft);
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const proc = useQuery({
    queryKey: ['process', d.processId],
    queryFn: () => get<ProcessDetail>(`/processes/${d.processId}`),
    enabled: !!d.processId,
  });
  const [cron] = useDebouncedValue(d.cron, 400);
  const preview = useQuery({
    queryKey: ['cron', cron, d.timezone],
    queryFn: () => post<{ next: string[] }>('/cron/preview', { cron, timezone: d.timezone || undefined }),
    enabled: !!cron,
    retry: false,
  });

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

  return (
    <Modal opened onClose={onClose} title={draft.id ? t('edit') : t('new')} size="lg">
      <Stack>
        <Select
          label={t('form.process')}
          required
          searchable
          data={(processes.data ?? []).filter((p) => p.permissions.includes('run')).map((p) => ({ value: p.id, label: p.name }))}
          value={d.processId || null}
          onChange={(v) => setD({ ...d, processId: v ?? '', inputs: {}, bindings: {} })}
        />
        <TextInput label={t('form.name')} required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} />
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
              error={preview.error ? (preview.error as Error).message : undefined}
            />
            <TextInput label={t('form.timezone')} value={d.timezone ?? ''} onChange={(e) => setD({ ...d, timezone: e.currentTarget.value })} />
          </Group>
          {preview.data && (
            <Text size="xs" c="dimmed" mt={4}>
              {t('form.next', { dates: preview.data.next.slice(0, 3).map((n) => fmtDate(n)).join(' · ') })}
            </Text>
          )}
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
          {draft.owner ? (
            <Trans t={t} i18nKey="form.rightsOwner" values={{ owner: draft.owner }} components={{ b: <b /> }} />
          ) : (
            t('form.rightsYou')
          )}
        </Text>
        <Switch label={t('enabled')} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <Switch label={t('form.dryRun')} checked={d.dryRun} onChange={(e) => setD({ ...d, dryRun: e.currentTarget.checked })} />
        <Switch
          label={t('form.overlap')}
          description={t('form.overlapHint')}
          checked={d.allowOverlap}
          onChange={(e) => setD({ ...d, allowOverlap: e.currentTarget.checked })}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => onSave(d)} disabled={!d.processId || !d.name || !d.cron}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import { ActionIcon, Badge, Button, Chip, Divider, Group, Modal, Select, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconEdit, IconPlayerPlay, IconPlus, IconTrash } from '@tabler/icons-react';
import type { ProcessDetail, ProcessSummary, Schedule } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { PageHeader, StatusBadge } from '../components/common';
import { InputsForm, defaultInputs } from '../components/InputsForm';
import { BindingsForm, loadBindings } from '../components/RunDialog';
import { fmtDate, fmtRelative } from '../format';

const PRESETS = [
  { label: 'Every 15 min', cron: '*/15 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily 07:00', cron: '0 7 * * *' },
  { label: 'Weekdays 07:00', cron: '0 7 * * 1-5' },
  { label: 'Mondays 06:00', cron: '0 6 * * 1' },
  { label: '1st of month 06:00', cron: '0 6 1 * *' },
  { label: 'Quarterly', cron: '0 6 1 1,4,7,10 *' },
];

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
      notifyError(e, 'Schedule not saved');
      return false;
    }
  };

  return (
    <>
      <PageHeader
        title="Schedules"
        description="Plan processes to run automatically (e.g. weekly health checks, quarterly access reviews). Scheduled runs that need a decision wait in My tasks."
        actions={
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft(emptyDraft())}>
            New schedule
          </Button>
        }
      />
      {schedules.data?.length === 0 && <Text c="dimmed" size="sm">No schedules yet.</Text>}
      {!!schedules.data?.length && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Active</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>When</Table.Th>
                <Table.Th>Next run</Table.Th>
                <Table.Th>Last run</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {schedules.data.map((s) => (
                <Table.Tr key={s.id}>
                  <Table.Td>
                    <Switch size="xs" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.currentTarget.checked })} aria-label="Enabled" />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {s.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      <Link to={`/processes/${s.processId}`}>{s.processName}</Link>
                      {s.dryRun && (
                        <Badge ml={4} size="xs" color="yellow" variant="light">
                          dry run
                        </Badge>
                      )}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <span className="mono">{s.cron}</span>
                    <Text size="xs" c="dimmed">
                      {PRESETS.find((p) => p.cron === s.cron)?.label ?? ''} {s.timezone}
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
                      <Tooltip label="Run now">
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
                          aria-label="Run now"
                        >
                          <IconPlayerPlay size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <ActionIcon variant="subtle" onClick={() => setDraft({ ...s })} aria-label="Edit">
                        <IconEdit size={16} />
                      </ActionIcon>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        aria-label="Delete"
                        onClick={async () => {
                          if (!confirm(`Delete schedule "${s.name}"?`)) return;
                          await del(`/schedules/${s.id}`).catch(notifyError);
                          qc.invalidateQueries({ queryKey: ['schedules'] });
                        }}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
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
              notifyOk('Schedule saved');
              setDraft(null);
            }
          }}
        />
      )}
    </>
  );
}

function ScheduleModal({ draft, onClose, onSave }: { draft: Draft; onClose: () => void; onSave: (d: Draft) => void }) {
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
    <Modal opened onClose={onClose} title={draft.id ? 'Edit schedule' : 'New schedule'} size="lg">
      <Stack>
        <Select
          label="Process"
          required
          searchable
          data={(processes.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          value={d.processId || null}
          onChange={(v) => setD({ ...d, processId: v ?? '', inputs: {}, bindings: {} })}
        />
        <TextInput label="Name" required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} />
        <div>
          <Text size="sm" fw={500} mb={4}>
            When
          </Text>
          <Chip.Group>
            <Group gap={6} mb={6}>
              {PRESETS.map((p) => (
                <Chip key={p.cron} size="xs" checked={d.cron === p.cron} onChange={() => setD({ ...d, cron: p.cron })}>
                  {p.label}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Group grow align="flex-start">
            <TextInput
              label="Cron expression"
              description="minute hour day-of-month month day-of-week"
              classNames={{ input: 'mono' }}
              value={d.cron}
              onChange={(e) => setD({ ...d, cron: e.currentTarget.value })}
              error={preview.error ? (preview.error as Error).message : undefined}
            />
            <TextInput label="Time zone" value={d.timezone ?? ''} onChange={(e) => setD({ ...d, timezone: e.currentTarget.value })} />
          </Group>
          {preview.data && (
            <Text size="xs" c="dimmed" mt={4}>
              Next: {preview.data.next.slice(0, 3).map((n) => fmtDate(n)).join(' · ')}
            </Text>
          )}
        </div>
        {proc.data && (
          <>
            <Divider label="Connections & inputs" labelPosition="left" />
            <BindingsForm process={proc.data} value={d.bindings} onChange={(b) => setD({ ...d, bindings: b })} />
            <InputsForm defs={proc.data.definition.inputs} value={d.inputs} onChange={(i) => setD({ ...d, inputs: i })} />
          </>
        )}
        <Divider />
        <Switch label="Enabled" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <Switch label="Dry run (simulate changes)" checked={d.dryRun} onChange={(e) => setD({ ...d, dryRun: e.currentTarget.checked })} />
        <Switch
          label="Allow overlapping runs"
          description="Off: a new run is skipped while the previous one is still running or waiting for a decision."
          checked={d.allowOverlap}
          onChange={(e) => setD({ ...d, allowOverlap: e.currentTarget.checked })}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(d)} disabled={!d.processId || !d.name || !d.cron}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

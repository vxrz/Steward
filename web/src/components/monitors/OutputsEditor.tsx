import { ActionIcon, Badge, Button, Group, Menu, MultiSelect, NumberInput, Paper, SegmentedControl, Select, Stack, Switch, TagsInput, Text, TextInput } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { MONITOR_STATUSES, type CheckDef, type OutputDef, type OutputType, type Platform, type ProcessSummary } from '@sm/shared';
import { Hint, KeyValueEditor } from '../common';
import { MONITOR_LABELS } from './status';

const TYPE_LABEL: Record<OutputType, string> = {
  notification: 'Notification (in-app, e-mail, Teams)',
  webhook: 'Webhook (JSON)',
  gatus: 'Gatus external endpoint',
  zabbix: 'Zabbix',
  process: 'Start a process (runbook)',
};

const TYPE_HELP: Record<OutputType, string> = {
  notification: 'The owner and the subscribers are notified about root causes only; dependent failures are folded into one alert.',
  webhook: 'POSTs { source, monitor, events[] } with status, status code, root causes and the latest message.',
  gatus: 'Pushes success/error to POST /api/v1/endpoints/<key>/external with the platform credential "externalToken".',
  zabbix: 'sender: trapper protocol to port 10051 (items of type Zabbix trapper); api: history.push (Zabbix 7.0+, API token). Values: 0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance.',
  process: 'Starts the runbook as the monitor owner; inputs are JSONata over { monitor, check, event }.',
};

function newOutput(type: OutputType, id: string): OutputDef {
  const base = { id, enabled: true, on: 'change' as const };
  switch (type) {
    case 'notification':
      return { ...base, type, subscribers: [] } as OutputDef;
    case 'webhook':
      return { ...base, type, url: 'https://' } as OutputDef;
    case 'gatus':
      return { ...base, type, platform: '', endpointKey: 'steward_${monitor.key}', include: 'monitor' } as OutputDef;
    case 'zabbix':
      return { ...base, type, platform: '', via: 'sender', value: 'code', on: 'every', minIntervalSeconds: 60 } as OutputDef;
    case 'process':
      return { ...base, type, processId: '', bindings: {}, inputs: {}, dryRun: false } as OutputDef;
  }
}

const num = (v: string | number) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface OutputsEditorProps {
  outputs: OutputDef[];
  onChange: (o: OutputDef[]) => void;
  checks: CheckDef[];
  platforms: Platform[];
  processes: ProcessSummary[];
  disabled?: boolean;
}

export function OutputsEditor({ outputs, onChange, checks, platforms, processes, disabled }: OutputsEditorProps) {
  const update = (i: number, p: Partial<OutputDef>) => onChange(outputs.map((o, j) => (j === i ? ({ ...o, ...p } as OutputDef) : o)));
  const add = (type: OutputType) => {
    let n = outputs.length + 1;
    while (outputs.some((o) => o.id === `${type}-${n}`)) n++;
    onChange([...outputs, newOutput(type, `${type}-${n}`)]);
  };
  const platformData = (kind?: string) => platforms.filter((p) => !kind || p.kind === kind).map((p) => ({ value: p.id, label: p.name }));
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        Outputs send status changes (and optionally every evaluation) to people and other monitoring systems. Placeholders in keys and paths: ${'{monitor.key}'},
        ${'{monitor.name}'}, ${'{check.id}'}, ${'{check.key}'}, ${'{check.name}'}.
      </Text>
      {outputs.length === 0 && <Text size="sm">No outputs yet – the status is still available in the API, Prometheus metrics and dashboards.</Text>}
      {outputs.map((o, i) => (
        <Paper key={i} withBorder p="sm" data-testid={`output-${o.id}`}>
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs">
                <Badge variant="light">{TYPE_LABEL[o.type]}</Badge>
                <Text size="xs" c="dimmed" className="mono">
                  {o.id}
                </Text>
              </Group>
              <Group gap={4}>
                <Switch size="xs" label="Enabled" disabled={disabled} checked={o.enabled} onChange={(e) => update(i, { enabled: e.currentTarget.checked })} />
                <ActionIcon variant="subtle" color="red" disabled={disabled} aria-label="Remove output" onClick={() => onChange(outputs.filter((_, j) => j !== i))}>
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            </Group>
            <Hint>{TYPE_HELP[o.type]}</Hint>
            {o.type === 'notification' && (
              <>
                <TagsInput
                  label="Subscribers"
                  description="user:<name>, team:<name> or role:<role>; the owner is always notified"
                  disabled={disabled}
                  value={o.subscribers}
                  onChange={(v) => update(i, { subscribers: v })}
                />
                <NumberInput
                  label="Hold dependent alerts (s)"
                  description="Wait this long so a parent failing a little later still explains the failure (default 0)"
                  min={0}
                  max={3600}
                  disabled={disabled}
                  value={o.holdSeconds ?? ''}
                  onChange={(v) => update(i, { holdSeconds: num(v) })}
                />
              </>
            )}
            {o.type === 'webhook' && (
              <>
                <TextInput label="URL" description="Without credentials; for authenticated targets choose a platform instead" disabled={disabled} value={o.url ?? ''} onChange={(e) => update(i, { url: e.currentTarget.value || undefined })} />
                <Group grow>
                  <Select label="or platform" clearable disabled={disabled} data={platformData()} value={o.platform ?? null} onChange={(v) => update(i, { platform: v ?? undefined })} />
                  <TextInput label="Path" disabled={disabled} value={o.path ?? ''} onChange={(e) => update(i, { path: e.currentTarget.value || undefined })} />
                </Group>
              </>
            )}
            {o.type === 'gatus' && (
              <Group grow align="flex-start">
                <Select label="Gatus platform" required disabled={disabled} data={platformData('gatus')} value={o.platform || null} onChange={(v) => update(i, { platform: v ?? '' })} />
                <TextInput label="External endpoint key" required disabled={disabled} value={o.endpointKey} onChange={(e) => update(i, { endpointKey: e.currentTarget.value })} classNames={{ input: 'mono' }} />
                <TextInput label="Token credential" placeholder="externalToken" disabled={disabled} value={o.tokenSecret ?? ''} onChange={(e) => update(i, { tokenSecret: e.currentTarget.value || undefined })} />
              </Group>
            )}
            {o.type === 'zabbix' && (
              <>
                <Group grow align="flex-start">
                  <Select label="Zabbix platform" required disabled={disabled} data={platformData('zabbix')} value={o.platform || null} onChange={(v) => update(i, { platform: v ?? '' })} />
                  <Select
                    label="Protocol"
                    disabled={disabled}
                    value={o.via}
                    onChange={(v) => update(i, { via: (v ?? 'sender') as 'sender' })}
                    data={[
                      { value: 'sender', label: 'Sender / trapper (TCP 10051)' },
                      { value: 'api', label: 'API history.push (7.0+)' },
                    ]}
                  />
                  <Select
                    label="Value"
                    disabled={disabled}
                    value={o.value}
                    onChange={(v) => update(i, { value: (v ?? 'code') as 'code' })}
                    data={[
                      { value: 'code', label: 'Numeric code' },
                      { value: 'text', label: 'Status text' },
                    ]}
                  />
                </Group>
                <Group grow align="flex-start">
                  <TextInput label="Zabbix host" placeholder="platform variable host" disabled={disabled} value={o.host ?? ''} onChange={(e) => update(i, { host: e.currentTarget.value || undefined })} />
                  <TextInput label="Item key (monitor)" placeholder="steward.monitor.status[${monitor.key}]" disabled={disabled} value={o.itemKeyMonitor ?? ''} onChange={(e) => update(i, { itemKeyMonitor: e.currentTarget.value || undefined })} classNames={{ input: 'mono' }} />
                  <TextInput label="Item key (check)" placeholder="steward.check.status[${monitor.key},${check.id}]" disabled={disabled} value={o.itemKeyCheck ?? ''} onChange={(e) => update(i, { itemKeyCheck: e.currentTarget.value || undefined })} classNames={{ input: 'mono' }} />
                </Group>
              </>
            )}
            {o.type === 'process' && (
              <>
                <Select
                  label="Process"
                  required
                  searchable
                  disabled={disabled}
                  data={processes.filter((p) => p.permissions.includes('run')).map((p) => ({ value: p.id, label: p.name }))}
                  value={o.processId || null}
                  onChange={(v) => update(i, { processId: v ?? '' })}
                />
                <Text size="sm" fw={500}>
                  Inputs (JSONata)
                </Text>
                <KeyValueEditor value={o.inputs} onChange={(v) => update(i, { inputs: (v ?? {}) as Record<string, string> })} keyLabel="Input" valuePlaceholder="monitor.name" />
                <Text size="sm" fw={500}>
                  Connections (slot → platform id)
                </Text>
                <KeyValueEditor value={o.bindings} onChange={(v) => update(i, { bindings: (v ?? {}) as Record<string, string> })} keyLabel="Slot" />
                <Switch label="Dry run" disabled={disabled} checked={o.dryRun} onChange={(e) => update(i, { dryRun: e.currentTarget.checked })} />
              </>
            )}
            <Group grow align="flex-start">
              <div>
                <Text size="sm" fw={500} mb={4}>
                  Send
                </Text>
                <SegmentedControl
                  size="xs"
                  disabled={disabled}
                  value={o.on}
                  onChange={(v) => update(i, { on: v as 'change' })}
                  data={[
                    { value: 'change', label: 'On change' },
                    { value: 'every', label: 'Every evaluation' },
                  ]}
                />
              </div>
              {o.on === 'every' && (
                <NumberInput label="At most every (s)" min={10} disabled={disabled} value={o.minIntervalSeconds ?? ''} onChange={(v) => update(i, { minIntervalSeconds: num(v) })} />
              )}
              <Select
                label="Subjects"
                disabled={disabled}
                value={o.include ?? (o.type === 'notification' || o.type === 'process' ? 'monitor' : 'all')}
                onChange={(v) => update(i, { include: (v ?? undefined) as 'all' })}
                data={[
                  { value: 'monitor', label: 'The monitor status' },
                  { value: 'checks', label: 'Each check' },
                  { value: 'all', label: 'Monitor and checks' },
                ]}
              />
            </Group>
            <Group grow align="flex-start">
              <MultiSelect
                label="Only these statuses"
                placeholder={o.type === 'process' ? 'down' : 'all'}
                disabled={disabled}
                data={MONITOR_STATUSES.map((s) => ({ value: s, label: MONITOR_LABELS[s] }))}
                value={o.statuses ?? []}
                onChange={(v) => update(i, { statuses: v.length ? (v as OutputDef['statuses']) : undefined })}
              />
              <MultiSelect
                label="Only these checks"
                placeholder="all"
                disabled={disabled}
                data={checks.map((c) => ({ value: c.id, label: c.name }))}
                value={o.checks ?? []}
                onChange={(v) => update(i, { checks: v.length ? v : undefined })}
              />
            </Group>
          </Stack>
        </Paper>
      ))}
      <Menu>
        <Menu.Target>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} disabled={disabled} w="fit-content">
            Add output
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {(Object.keys(TYPE_LABEL) as OutputType[]).map((t) => (
            <Menu.Item key={t} onClick={() => add(t)}>
              {TYPE_LABEL[t]}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}

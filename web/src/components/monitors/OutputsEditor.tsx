import {
  Divider,
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  MultiSelect,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
} from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { DEFAULT_TRIGGER_NOTIFY, MONITOR_STATUSES, type CheckDef, type OutputDef, type OutputType, type Platform, type ProcessSummary } from '@sm/shared';
import { NotifyPolicyFields } from '../notify/NotifyPolicy';
import { useTranslation } from 'react-i18next';
import { Hint, KeyValueEditor } from '../common';
import i18n from '../../i18n';
import { monitorStatusLabel } from './status';

/** English defaults of monitors:outputs.types.<type>.label / .help */
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
  zabbix:
    'sender: trapper protocol to port 10051 (items of type Zabbix trapper); api: history.push (Zabbix 7.0+, API token). Values: 0 up, 1 degraded, 2 down, 3 unknown, 4 blocked, 5 maintenance.',
  process: 'Starts the runbook as the monitor owner; inputs are JSONata over { monitor, check, event }.',
};

const typeLabel = (t: OutputType): string => i18n.t(`monitors:outputs.types.${t}.label` as 'common:add', { defaultValue: TYPE_LABEL[t] }) as string;
const typeHelp = (t: OutputType): string => i18n.t(`monitors:outputs.types.${t}.help` as 'common:add', { defaultValue: TYPE_HELP[t] }) as string;

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
  const { t } = useTranslation(['monitors', 'common']);
  const platformData = (kind?: string) => platforms.filter((p) => !kind || p.kind === kind).map((p) => ({ value: p.id, label: p.name }));
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t('outputs.intro', { placeholders: '${monitor.key}, ${monitor.name}, ${check.id}, ${check.key}, ${check.name}' })}
      </Text>
      {outputs.length === 0 && <Text size="sm">{t('outputs.none')}</Text>}
      {outputs.map((o, i) => (
        <Paper key={i} withBorder p="sm" data-testid={`output-${o.id}`}>
          <Stack gap="xs">
            <Group justify="space-between" wrap="wrap" gap="xs">
              <Group gap="xs">
                <Badge variant="light" style={{ minWidth: 'max-content' }}>
                  {typeLabel(o.type)}
                </Badge>
                <Text size="xs" c="dimmed" className="mono">
                  {o.id}
                </Text>
              </Group>
              <Group gap={4}>
                <Switch
                  size="xs"
                  label={t('form.enabled')}
                  disabled={disabled}
                  checked={o.enabled}
                  onChange={(e) => update(i, { enabled: e.currentTarget.checked })}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  disabled={disabled}
                  aria-label={t('outputs.remove', { id: o.id })}
                  onClick={() => onChange(outputs.filter((_, j) => j !== i))}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Group>
            </Group>
            <Hint>{typeHelp(o.type)}</Hint>
            {o.type === 'notification' && (
              <>
                <TagsInput
                  label={t('outputs.subscribers')}
                  description={t('outputs.subscribersHint', { examples: 'user:<name>, team:<name>, role:<role>' })}
                  disabled={disabled}
                  value={o.subscribers}
                  onChange={(v) => update(i, { subscribers: v })}
                />
                <NumberInput
                  label={t('outputs.hold')}
                  description={t('outputs.holdHint')}
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
                <TextInput
                  label={t('secrets.url')}
                  description={t('outputs.urlHint')}
                  disabled={disabled}
                  value={o.url ?? ''}
                  onChange={(e) => update(i, { url: e.currentTarget.value || undefined })}
                />
                <Group grow>
                  <Select
                    label={t('outputs.orPlatform')}
                    clearable
                    disabled={disabled}
                    data={platformData()}
                    value={o.platform ?? null}
                    onChange={(v) => update(i, { platform: v ?? undefined })}
                  />
                  <TextInput
                    label={t('form.path')}
                    disabled={disabled}
                    value={o.path ?? ''}
                    onChange={(e) => update(i, { path: e.currentTarget.value || undefined })}
                  />
                </Group>
                <Select
                  label={t('outputs.format')}
                  description={t('outputs.formatHint')}
                  allowDeselect={false}
                  disabled={disabled}
                  data={[
                    { value: 'json', label: t('outputs.formats.json') },
                    { value: 'teams', label: t('outputs.formats.teams') },
                  ]}
                  value={o.format ?? 'json'}
                  onChange={(v) => update(i, { format: v === 'teams' ? 'teams' : undefined })}
                />
              </>
            )}
            {o.type === 'gatus' && (
              <Group grow align="flex-start">
                <Select
                  label={t('outputs.gatusPlatform')}
                  required
                  disabled={disabled}
                  data={platformData('gatus')}
                  value={o.platform || null}
                  onChange={(v) => update(i, { platform: v ?? '' })}
                />
                <TextInput
                  label={t('outputs.externalKey')}
                  required
                  disabled={disabled}
                  value={o.endpointKey}
                  onChange={(e) => update(i, { endpointKey: e.currentTarget.value })}
                  classNames={{ input: 'mono' }}
                />
                <TextInput
                  label={t('outputs.tokenCredential')}
                  placeholder="externalToken"
                  disabled={disabled}
                  value={o.tokenSecret ?? ''}
                  onChange={(e) => update(i, { tokenSecret: e.currentTarget.value || undefined })}
                />
              </Group>
            )}
            {o.type === 'zabbix' && (
              <>
                <Group grow align="flex-start">
                  <Select
                    label={t('outputs.zabbixPlatform')}
                    required
                    disabled={disabled}
                    data={platformData('zabbix')}
                    value={o.platform || null}
                    onChange={(v) => update(i, { platform: v ?? '' })}
                  />
                  <Select
                    label={t('outputs.protocol')}
                    disabled={disabled}
                    value={o.via}
                    onChange={(v) => update(i, { via: (v ?? 'sender') as 'sender' })}
                    data={[
                      { value: 'sender', label: t('outputs.viaSender') },
                      { value: 'api', label: t('outputs.viaApi') },
                    ]}
                  />
                  <Select
                    label={t('outputs.value')}
                    disabled={disabled}
                    value={o.value}
                    onChange={(v) => update(i, { value: (v ?? 'code') as 'code' })}
                    data={[
                      { value: 'code', label: t('outputs.valueCode') },
                      { value: 'text', label: t('outputs.valueText') },
                    ]}
                  />
                </Group>
                <Group grow align="flex-start">
                  <TextInput
                    label={t('outputs.zabbixHost')}
                    placeholder={t('outputs.zabbixHostPlaceholder')}
                    disabled={disabled}
                    value={o.host ?? ''}
                    onChange={(e) => update(i, { host: e.currentTarget.value || undefined })}
                  />
                  <TextInput
                    label={t('outputs.itemKeyMonitor')}
                    placeholder="steward.monitor.status[${monitor.key}]"
                    disabled={disabled}
                    value={o.itemKeyMonitor ?? ''}
                    onChange={(e) => update(i, { itemKeyMonitor: e.currentTarget.value || undefined })}
                    classNames={{ input: 'mono' }}
                  />
                  <TextInput
                    label={t('outputs.itemKeyCheck')}
                    placeholder="steward.check.status[${monitor.key},${check.id}]"
                    disabled={disabled}
                    value={o.itemKeyCheck ?? ''}
                    onChange={(e) => update(i, { itemKeyCheck: e.currentTarget.value || undefined })}
                    classNames={{ input: 'mono' }}
                  />
                </Group>
              </>
            )}
            {o.type === 'process' && (
              <>
                <Select
                  label={t('outputs.process')}
                  required
                  searchable
                  disabled={disabled}
                  data={processes.filter((p) => p.permissions.includes('run')).map((p) => ({ value: p.id, label: p.name }))}
                  value={o.processId || null}
                  onChange={(v) => update(i, { processId: v ?? '' })}
                />
                <Text size="sm" fw={500}>
                  {t('outputs.inputs')}
                </Text>
                <KeyValueEditor
                  value={o.inputs}
                  onChange={(v) => update(i, { inputs: (v ?? {}) as Record<string, string> })}
                  keyLabel={t('outputs.input')}
                  valuePlaceholder="monitor.name"
                />
                <Text size="sm" fw={500}>
                  {t('outputs.connections')}
                </Text>
                <KeyValueEditor
                  value={o.bindings}
                  onChange={(v) => update(i, { bindings: (v ?? {}) as Record<string, string> })}
                  keyLabel={t('outputs.slot')}
                />
                <Switch label={t('outputs.dryRun')} disabled={disabled} checked={o.dryRun} onChange={(e) => update(i, { dryRun: e.currentTarget.checked })} />
                {/* the messages of the runs it starts (#139); kept in the definition, the pause too */}
                <Divider label={t('outputs.runMessages')} labelPosition="left" />
                <fieldset disabled={disabled} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
                  <NotifyPolicyFields value={o.notify ?? { ...DEFAULT_TRIGGER_NOTIFY }} onChange={(notify) => update(i, { notify })} withPause />
                </fieldset>
              </>
            )}
            <Group grow align="flex-start">
              <div>
                <Text size="sm" fw={500} mb={4}>
                  {t('outputs.send')}
                </Text>
                <SegmentedControl
                  size="xs"
                  disabled={disabled}
                  value={o.on}
                  onChange={(v) => update(i, { on: v as 'change' })}
                  data={[
                    { value: 'change', label: t('outputs.onChange') },
                    { value: 'every', label: t('outputs.onEvery') },
                  ]}
                />
              </div>
              {o.on === 'every' && (
                <NumberInput
                  label={t('outputs.atMostEvery')}
                  min={10}
                  disabled={disabled}
                  value={o.minIntervalSeconds ?? ''}
                  onChange={(v) => update(i, { minIntervalSeconds: num(v) })}
                />
              )}
              <Select
                label={t('outputs.subjects')}
                disabled={disabled}
                value={o.include ?? (o.type === 'notification' || o.type === 'process' ? 'monitor' : 'all')}
                onChange={(v) => update(i, { include: (v ?? undefined) as 'all' })}
                data={[
                  { value: 'monitor', label: t('outputs.includeMonitor') },
                  { value: 'checks', label: t('outputs.includeChecks') },
                  { value: 'all', label: t('outputs.includeAll') },
                ]}
              />
            </Group>
            <Group grow align="flex-start">
              <MultiSelect
                label={t('outputs.onlyStatuses')}
                placeholder={o.type === 'process' ? monitorStatusLabel('down') : t('outputs.all')}
                disabled={disabled}
                data={MONITOR_STATUSES.map((s) => ({ value: s, label: monitorStatusLabel(s) }))}
                value={o.statuses ?? []}
                onChange={(v) => update(i, { statuses: v.length ? (v as OutputDef['statuses']) : undefined })}
              />
              <MultiSelect
                label={t('outputs.onlyChecks')}
                placeholder={t('outputs.all')}
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
            {t('outputs.add')}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          {(Object.keys(TYPE_LABEL) as OutputType[]).map((type) => (
            <Menu.Item key={type} onClick={() => add(type)}>
              {typeLabel(type)}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Stack>
  );
}

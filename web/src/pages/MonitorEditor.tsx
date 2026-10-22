import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Grid, Group, NumberInput, Paper, SegmentedControl, Select, Stack, Switch, Tabs, TagsInput, Text, TextInput, Textarea, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import YAML from 'yaml';
import { IconDeviceFloppy, IconTrash } from '@tabler/icons-react';
import { CHECK_TYPES, CHECK_TYPE_INFO, type CheckDef, type CheckType, type MonitorDefinition, type MonitorDetail, type MonitorSaveResult, type MonitorSummary, type Platform, type ProcessSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { PageHeader } from '../components/common';
import { MonitorGraph, NODE_H } from '../components/monitors/MonitorGraph';
import { CheckForm } from '../components/monitors/CheckForm';
import { OutputsEditor } from '../components/monitors/OutputsEditor';
import { CHECK_ICONS, newCheck } from '../components/monitors/checkMeta';
import { SecretsModal } from '../components/monitors/dialogs';

const EMPTY: MonitorDefinition = {
  name: '',
  description: '',
  tags: [],
  intervalSeconds: 60,
  timeoutSeconds: 10,
  failuresBeforeDown: 2,
  successesBeforeUp: 1,
  aggregate: { rule: 'worst' },
  checks: [],
  links: [],
  outputs: [{ id: 'notify', type: 'notification', enabled: true, on: 'change', subscribers: [] }],
};

export function MonitorEditorPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({ queryKey: ['monitor', id], queryFn: () => get<MonitorDetail>(`/monitors/${id}`), enabled: !isNew });
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors') });
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const [def, setDef] = useState<MonitorDefinition | null>(isNew ? EMPTY : null);
  const [key, setKey] = useState('');
  const [isTemplate, setIsTemplate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [link, setLink] = useState<number | null>(null);
  const [yaml, setYaml] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>('graph');
  const [saving, setSaving] = useState(false);
  const [secrets, setSecrets] = useState<MonitorSaveResult | null>(null);
  const savedIds = useMemo(() => new Set((existing.data?.definition.checks ?? []).map((c) => c.id)), [existing.data]);

  useEffect(() => {
    if (existing.data && !def) {
      setDef(existing.data.definition);
      setKey(existing.data.key);
      setIsTemplate(existing.data.isTemplate);
      if (existing.data.isTemplate) setTab('yaml');
    }
  }, [existing.data, def]);
  useEffect(() => {
    if (def && tab === 'yaml') {
      setYaml(YAML.stringify(def, { lineWidth: 0 }));
      setYamlError(null);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!def) return null;
  const sel = def.checks.find((c) => c.id === selected) ?? null;
  const setCheck = (c: CheckDef) => {
    const old = sel!.id;
    const links = c.id !== old ? def.links.map((l) => ({ ...l, from: l.from === old ? c.id : l.from, to: l.to === old ? c.id : l.to })) : def.links;
    setDef({ ...def, checks: def.checks.map((x) => (x.id === old ? c : x)), links });
    if (c.id !== old) setSelected(c.id);
  };
  const addCheck = (type: CheckType) => {
    let n = 1;
    while (def.checks.some((c) => c.id === `${type}-${n}`)) n++;
    const c = newCheck(type, `${type}-${n}`);
    const maxY = Math.max(-NODE_H - 70, ...def.checks.map((x) => x.y ?? 0));
    c.x = 0;
    c.y = maxY + NODE_H + 70;
    setDef({ ...def, checks: [...def.checks, c] });
    setSelected(c.id);
    setLink(null);
  };
  const removeCheck = (cid: string) => {
    setDef({ ...def, checks: def.checks.filter((c) => c.id !== cid), links: def.links.filter((l) => l.from !== cid && l.to !== cid) });
    setSelected(null);
  };
  const applyYaml = (): MonitorDefinition | null => {
    try {
      const parsed = YAML.parse(yaml) as MonitorDefinition & { kind?: string; key?: string };
      const { kind: _k, key: k, ...rest } = parsed;
      if (k && isNew) setKey(k);
      const next = { ...EMPTY, ...rest } as MonitorDefinition;
      setDef(next);
      setYamlError(null);
      return next;
    } catch (e) {
      setYamlError((e as Error).message);
      return null;
    }
  };

  const save = async () => {
    const d = tab === 'yaml' ? applyYaml() : def;
    if (!d) return;
    setSaving(true);
    try {
      const body = { key: key.trim() || undefined, definition: d, ...(isNew ? { isTemplate } : { version: existing.data!.version }) };
      const r = isNew ? await post<MonitorSaveResult>('/monitors', body) : await put<MonitorSaveResult>(`/monitors/${id}`, body);
      qc.invalidateQueries({ queryKey: ['monitors'] });
      qc.invalidateQueries({ queryKey: ['monitor', r.monitor.id] });
      if (r.secrets.length) setSecrets(r);
      else navigate(`/monitors/${r.monitor.id}`);
    } catch (e) {
      notifyError(e, 'Monitor not saved');
    } finally {
      setSaving(false);
    }
  };

  const l = link !== null ? def.links[link] : null;
  return (
    <>
      <PageHeader
        title={isNew ? 'New monitor' : `Edit ${existing.data?.name ?? ''}`}
        description="Add checks from the palette and connect them: drag from the lower handle of a check to the check that depends on it."
        actions={
          <>
            <Button size="xs" variant="default" onClick={() => navigate(isNew ? '/monitors' : `/monitors/${id}`)}>
              Cancel
            </Button>
            <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={saving} onClick={save} disabled={!def.name.trim()}>
              Save
            </Button>
          </>
        }
      />
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="sm">
          {!isTemplate && <Tabs.Tab value="graph">Checks and links</Tabs.Tab>}
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
          {!isTemplate && <Tabs.Tab value="outputs">Outputs</Tabs.Tab>}
          <Tabs.Tab value="yaml">YAML</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="graph">
          <Grid>
            <Grid.Col span={{ base: 12, md: 8 }}>
              <Group gap={6} mb="xs" aria-label="Check palette">
                {CHECK_TYPES.map((t) => {
                  const Icon = CHECK_ICONS[t];
                  return (
                    <Tooltip key={t} label={CHECK_TYPE_INFO[t].help} multiline w={260} withArrow>
                      <Button size="compact-xs" variant="light" leftSection={<Icon size={14} />} onClick={() => addCheck(t)}>
                        {CHECK_TYPE_INFO[t].label}
                      </Button>
                    </Tooltip>
                  );
                })}
              </Group>
              <MonitorGraph
                def={def}
                selected={selected}
                onSelect={(c) => (setSelected(c), setLink(null))}
                onChange={setDef}
                onLinkClick={(i) => (setLink(i), setSelected(null))}
                height={560}
              />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Paper withBorder p="sm">
                {sel && (
                  <Stack gap="xs">
                    <Group justify="space-between">
                      <Title order={4}>Check</Title>
                      <Button size="compact-xs" color="red" variant="subtle" leftSection={<IconTrash size={12} />} onClick={() => removeCheck(sel.id)}>
                        Remove
                      </Button>
                    </Group>
                    <CheckForm
                      check={sel}
                      onChange={setCheck}
                      platforms={platforms.data ?? []}
                      monitors={monitors.data ?? []}
                      monitorKey={key || 'monitor'}
                      isNew={!savedIds.has(sel.id)}
                    />
                  </Stack>
                )}
                {l && (
                  <Stack gap="xs">
                    <Title order={4}>Link</Title>
                    <Text size="sm">
                      {def.checks.find((c) => c.id === l.from)?.name} → {def.checks.find((c) => c.id === l.to)?.name}
                    </Text>
                    <SegmentedControl
                      value={l.mode}
                      onChange={(v) => setDef({ ...def, links: def.links.map((x, i) => (i === link ? { ...x, mode: v as 'soft' | 'hard' } : x)) })}
                      data={[
                        { value: 'soft', label: 'Soft' },
                        { value: 'hard', label: 'Hard' },
                      ]}
                    />
                    <Text size="xs" c="dimmed">
                      Soft: both checks run; when both fail, the dependent check is reported as "likely caused by" the other and no separate alert is sent. Hard: the dependent check is not evaluated
                      (blocked) while this one is down.
                    </Text>
                    <Button size="xs" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => (setDef({ ...def, links: def.links.filter((_, i) => i !== link) }), setLink(null))}>
                      Remove link
                    </Button>
                  </Stack>
                )}
                {!sel && !l && (
                  <Text size="sm" c="dimmed">
                    Select a check to edit it, or click a link to change it. {def.checks.length === 0 && 'Start with a check from the palette.'}
                  </Text>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          <Stack maw={760}>
            <TextInput label="Name" required value={def.name} onChange={(e) => setDef({ ...def, name: e.currentTarget.value })} />
            <TextInput
              label="Key"
              description="Stable identifier for integrations (Zabbix item keys, LLD, Prometheus, heartbeat keys); default from the name"
              value={key}
              onChange={(e) => setKey(e.currentTarget.value.toLowerCase())}
              classNames={{ input: 'mono' }}
            />
            <Textarea label="Description" autosize minRows={2} value={def.description} onChange={(e) => setDef({ ...def, description: e.currentTarget.value })} />
            <TagsInput label="Tags" value={def.tags} onChange={(v) => setDef({ ...def, tags: v })} />
            <Group grow align="flex-start">
              <NumberInput label="Interval (s)" min={5} value={def.intervalSeconds} onChange={(v) => setDef({ ...def, intervalSeconds: Number(v) || 60 })} />
              <NumberInput label="Timeout (s)" min={1} max={300} value={def.timeoutSeconds} onChange={(v) => setDef({ ...def, timeoutSeconds: Number(v) || 10 })} />
            </Group>
            <Group grow align="flex-start">
              <NumberInput label="Failures before down" description="Consecutive failing results" min={1} max={20} value={def.failuresBeforeDown} onChange={(v) => setDef({ ...def, failuresBeforeDown: Number(v) || 1 })} />
              <NumberInput label="Successes before up" min={1} max={20} value={def.successesBeforeUp} onChange={(v) => setDef({ ...def, successesBeforeUp: Number(v) || 1 })} />
            </Group>
            <Group grow align="flex-start">
              <Select
                label="Monitor status"
                value={def.aggregate.rule}
                onChange={(v) => setDef({ ...def, aggregate: { ...def.aggregate, rule: (v ?? 'worst') as 'worst' } })}
                data={[
                  { value: 'worst', label: 'Worst check' },
                  { value: 'critical', label: 'Worst critical check (others only degrade)' },
                  { value: 'quorum', label: 'Quorum: k of n critical checks up' },
                ]}
              />
              {def.aggregate.rule === 'quorum' && (
                <NumberInput label="k (checks that must be up)" min={1} value={def.aggregate.quorum ?? ''} onChange={(v) => setDef({ ...def, aggregate: { ...def.aggregate, quorum: Number(v) || undefined } })} />
              )}
            </Group>
            {isNew && (
              <Switch
                label="This is a template (parameters as {{ params.name }}, edited as YAML)"
                checked={isTemplate}
                onChange={(e) => {
                  setIsTemplate(e.currentTarget.checked);
                  if (e.currentTarget.checked) setDef({ ...def, parameters: def.parameters ?? [{ name: 'host', label: 'Host', type: 'string', required: true }] });
                }}
              />
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="outputs">
          <OutputsEditor outputs={def.outputs} onChange={(o) => setDef({ ...def, outputs: o })} checks={def.checks} platforms={platforms.data ?? []} processes={processes.data ?? []} />
        </Tabs.Panel>
        <Tabs.Panel value="yaml">
          <Stack>
            {isTemplate && (
              <Alert color="blue">
                Templates are edited as YAML: {'{{ params.<name> }}'} placeholders may stand anywhere, also where numbers are expected. They are replaced when monitors are created from the template.
              </Alert>
            )}
            <Textarea autosize minRows={18} maxRows={40} value={yaml} onChange={(e) => setYaml(e.currentTarget.value)} classNames={{ input: 'mono' }} aria-label="YAML source" error={yamlError} />
            <Group>
              <Button size="xs" variant="light" onClick={() => applyYaml()}>
                Apply
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>
      </Tabs>
      {secrets && <SecretsModal result={secrets} onClose={() => (setSecrets(null), navigate(`/monitors/${secrets.monitor.id}`))} />}
    </>
  );
}

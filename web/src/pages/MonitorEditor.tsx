import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Grid, Group, NumberInput, Paper, SegmentedControl, Select, Stack, Switch, Tabs, TagsInput, Text, TextInput, Textarea, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import YAML from 'yaml';
import { IconDeviceFloppy, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CHECK_TYPES, type CheckDef, type CheckType, type MonitorDefinition, type MonitorDetail, type MonitorSaveResult, type MonitorSummary, type Platform, type ProcessSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { PageHeader } from '../components/common';
import { MonitorGraph, NODE_H } from '../components/monitors/MonitorGraph';
import { CheckForm } from '../components/monitors/CheckForm';
import { OutputsEditor } from '../components/monitors/OutputsEditor';
import { CHECK_ICONS, newCheck } from '../components/monitors/checkMeta';
import { SecretsModal } from '../components/monitors/dialogs';
import { checkTypeHelp, checkTypeLabel } from '../components/monitors/status';

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
  const { t } = useTranslation(['monitors', 'common']);
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
  // Outputs (notifications, runbooks, external systems) need the manage right; new monitors belong to the creator.
  const canManage = isNew || !!existing.data?.permissions.includes('manage');
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
      notifyError(e, t('editor.notSaved'));
    } finally {
      setSaving(false);
    }
  };

  const l = link !== null ? def.links[link] : null;
  return (
    <>
      <PageHeader
        title={isNew ? t('new') : t('editor.editTitle', { name: existing.data?.name ?? '' })}
        description={t('editor.description')}
        actions={
          <>
            <Button size="xs" variant="default" onClick={() => navigate(isNew ? '/monitors' : `/monitors/${id}`)}>
              {t('common:cancel')}
            </Button>
            <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} loading={saving} onClick={save} disabled={!def.name.trim()}>
              {t('common:save')}
            </Button>
          </>
        }
      />
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="sm">
          {!isTemplate && <Tabs.Tab value="graph">{t('editor.tabs.graph')}</Tabs.Tab>}
          <Tabs.Tab value="settings">{t('editor.tabs.settings')}</Tabs.Tab>
          {!isTemplate && <Tabs.Tab value="outputs">{t('outputs.title')}</Tabs.Tab>}
          <Tabs.Tab value="yaml">YAML</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="graph">
          <Grid>
            <Grid.Col span={{ base: 12, md: 8 }}>
              <Group gap={6} mb="xs" aria-label={t('editor.palette')}>
                {CHECK_TYPES.map((type) => {
                  const Icon = CHECK_ICONS[type];
                  return (
                    <Tooltip key={type} label={checkTypeHelp(type)} multiline w={260} withArrow>
                      <Button size="compact-xs" variant="light" leftSection={<Icon size={14} />} onClick={() => addCheck(type)}>
                        {checkTypeLabel(type)}
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
                      <Title order={4}>{t('detail.check')}</Title>
                      <Button size="compact-xs" color="red" variant="subtle" leftSection={<IconTrash size={12} />} onClick={() => removeCheck(sel.id)}>
                        {t('detail.remove')}
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
                    <Title order={4}>{t('editor.link')}</Title>
                    <Text size="sm">
                      {def.checks.find((c) => c.id === l.from)?.name} → {def.checks.find((c) => c.id === l.to)?.name}
                    </Text>
                    <SegmentedControl
                      value={l.mode}
                      onChange={(v) => setDef({ ...def, links: def.links.map((x, i) => (i === link ? { ...x, mode: v as 'soft' | 'hard' } : x)) })}
                      data={[
                        { value: 'soft', label: t('editor.soft') },
                        { value: 'hard', label: t('editor.hard') },
                      ]}
                    />
                    <Text size="xs" c="dimmed">
                      {t('editor.linkHint')}
                    </Text>
                    <Button size="xs" color="red" variant="light" leftSection={<IconTrash size={14} />} onClick={() => (setDef({ ...def, links: def.links.filter((_, i) => i !== link) }), setLink(null))}>
                      {t('editor.removeLink')}
                    </Button>
                  </Stack>
                )}
                {!sel && !l && (
                  <Text size="sm" c="dimmed">
                    {t('editor.selectHint')} {def.checks.length === 0 && t('editor.startHint')}
                  </Text>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>
        <Tabs.Panel value="settings">
          <Stack maw={760}>
            <TextInput label={t('form.name')} required value={def.name} onChange={(e) => setDef({ ...def, name: e.currentTarget.value })} />
            <TextInput
              label={t('editor.key')}
              description={t('editor.keyHint')}
              value={key}
              onChange={(e) => setKey(e.currentTarget.value.toLowerCase())}
              classNames={{ input: 'mono' }}
            />
            <Textarea label={t('form.description')} autosize minRows={2} value={def.description} onChange={(e) => setDef({ ...def, description: e.currentTarget.value })} />
            <TagsInput label={t('editor.tags')} value={def.tags} onChange={(v) => setDef({ ...def, tags: v })} />
            <Group grow align="flex-start">
              <NumberInput label={t('form.interval')} min={5} value={def.intervalSeconds} onChange={(v) => setDef({ ...def, intervalSeconds: Number(v) || 60 })} />
              <NumberInput label={t('form.timeout')} min={1} max={300} value={def.timeoutSeconds} onChange={(v) => setDef({ ...def, timeoutSeconds: Number(v) || 10 })} />
            </Group>
            <Group grow align="flex-start">
              <NumberInput label={t('form.failuresBeforeDown')} description={t('editor.failuresHint')} min={1} max={20} value={def.failuresBeforeDown} onChange={(v) => setDef({ ...def, failuresBeforeDown: Number(v) || 1 })} />
              <NumberInput label={t('form.successesBeforeUp')} min={1} max={20} value={def.successesBeforeUp} onChange={(v) => setDef({ ...def, successesBeforeUp: Number(v) || 1 })} />
            </Group>
            <Group grow align="flex-start">
              <Select
                label={t('editor.aggregate')}
                value={def.aggregate.rule}
                onChange={(v) => setDef({ ...def, aggregate: { ...def.aggregate, rule: (v ?? 'worst') as 'worst' } })}
                data={[
                  { value: 'worst', label: t('editor.rules.worst') },
                  { value: 'critical', label: t('editor.rules.critical') },
                  { value: 'quorum', label: t('editor.rules.quorum') },
                ]}
              />
              {def.aggregate.rule === 'quorum' && (
                <NumberInput label={t('editor.quorum')} min={1} value={def.aggregate.quorum ?? ''} onChange={(v) => setDef({ ...def, aggregate: { ...def.aggregate, quorum: Number(v) || undefined } })} />
              )}
            </Group>
            {isNew && (
              <Switch
                label={t('editor.isTemplate', { example: '{{ params.name }}' })}
                checked={isTemplate}
                onChange={(e) => {
                  setIsTemplate(e.currentTarget.checked);
                  if (e.currentTarget.checked) setDef({ ...def, parameters: def.parameters ?? [{ name: 'host', label: t('form.host'), type: 'string', required: true }] });
                }}
              />
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="outputs">
          {!canManage && (
            <Alert color="gray" mb="sm">
              {t('outputs.manageOnly')}
            </Alert>
          )}
          <OutputsEditor
            outputs={def.outputs}
            onChange={(o) => setDef({ ...def, outputs: o })}
            checks={def.checks}
            platforms={platforms.data ?? []}
            processes={processes.data ?? []}
            disabled={!canManage}
          />
        </Tabs.Panel>
        <Tabs.Panel value="yaml">
          <Stack>
            {isTemplate && (
              <Alert color="blue">
                {t('editor.templateYaml', { example: '{{ params.<name> }}' })}
              </Alert>
            )}
            <Textarea autosize minRows={18} maxRows={40} value={yaml} onChange={(e) => setYaml(e.currentTarget.value)} classNames={{ input: 'mono' }} aria-label={t('editor.yamlSource')} error={yamlError} />
            <Group>
              <Button size="xs" variant="light" onClick={() => applyYaml()}>
                {t('editor.apply')}
              </Button>
            </Group>
          </Stack>
        </Tabs.Panel>
      </Tabs>
      {secrets && <SecretsModal result={secrets} onClose={() => (setSecrets(null), navigate(`/monitors/${secrets.monitor.id}`))} />}
    </>
  );
}

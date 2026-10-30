import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Grid,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import YAML from 'yaml';
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconCopy,
  IconDeviceFloppy,
  IconLayoutDistributeHorizontal,
  IconPlayerPlay,
  IconTrash,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';
import {
  CHECK_TYPES,
  issueLabel,
  type CheckDef,
  type CheckType,
  type MonitorDefinition,
  type MonitorDetail,
  type MonitorStatus,
  type MonitorSaveResult,
  type MonitorSummary,
  type Platform,
  type ProcessSummary,
} from '@sm/shared';
import { TagInput } from '../components/tags';
import { ApiError, get, notifyError, post, put } from '../api';
import { PageHeader } from '../components/common';
import { MonitorGraph, NODE_H, NODE_W, autoLayout } from '../components/monitors/MonitorGraph';
import { CheckForm } from '../components/monitors/CheckForm';
import { OutputsEditor } from '../components/monitors/OutputsEditor';
import { CHECK_ICONS, newCheck } from '../components/monitors/checkMeta';
import { SecretsModal } from '../components/monitors/dialogs';
import { MonitorStatusBadge, checkTypeHelp, checkTypeLabel } from '../components/monitors/status';
import { editorIssues, issuesByCheck, serverIssues, type EditorIssue } from '../components/monitors/validate';
import { isTextTarget, modKey, useDefHistory, useUndoKeys } from '../components/editor/useDefHistory';

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

/** The editor's state: the definition and a stable key per card (same order as `def.checks`), see #141. */
interface Draft {
  def: MonitorDefinition;
  keys: string[];
}
let keySeq = 0;
const newKey = () => `card-${++keySeq}`;
const draftOf = (def: MonitorDefinition): Draft => ({ def, keys: def.checks.map(newKey) });
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
/** Checks that make a call and can be tried before saving */
const TRYABLE = new Set<CheckType>(['ping', 'tcp', 'http', 'platform', 'freshness', 'gatus', 'checkmk']);
interface Preview {
  status: MonitorStatus;
  message: string;
  durationMs: number | null;
}

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
  const [draft, setDraft] = useState<Draft | null>(isNew ? draftOf(EMPTY) : null);
  const history = useDefHistory<Draft>(draft, setDraft);
  const def = draft?.def ?? null;
  const keys = useMemo(() => draft?.keys ?? [], [draft]);
  const [key, setKey] = useState('');
  const [isTemplate, setIsTemplate] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [link, setLink] = useState<number | null>(null);
  const [yaml, setYaml] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  // ?tab=outputs: the link in messages of runs a monitor output started (#139)
  const [tab, setTab] = useState<string | null>(new URLSearchParams(window.location.search).get('tab') ?? 'graph');
  const [saving, setSaving] = useState(false);
  const [secrets, setSecrets] = useState<MonitorSaveResult | null>(null);
  // problems are shown on a field once it was changed, and everywhere after the first save attempt
  const [attempted, setAttempted] = useState(false);
  const touched = useRef(new Map<string, Set<string>>());
  const [fromServer, setFromServer] = useState<{ def: MonitorDefinition; issues: EditorIssue[] } | null>(null);
  const [previews, setPreviews] = useState<Map<string, Preview | 'busy'>>(new Map());
  const savedIds = useMemo(() => new Set((existing.data?.definition.checks ?? []).map((c) => c.id)), [existing.data]);

  useEffect(() => {
    if (existing.data && !draft) {
      setDraft(draftOf(existing.data.definition));
      setKey(existing.data.key);
      setIsTemplate(existing.data.isTemplate);
      if (existing.data.isTemplate) setTab('yaml');
    }
  }, [existing.data, draft]);
  useEffect(() => {
    if (def && tab === 'yaml') {
      setYaml(YAML.stringify(def, { lineWidth: 0 }));
      setYamlError(null);
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const local = useMemo(() => (def && !isTemplate ? editorIssues(def) : []), [def, isTemplate]);
  // the server's answer counts until the definition changes
  const issues = fromServer && fromServer.def === def ? fromServer.issues : local;
  const byCheck = useMemo(() => issuesByCheck(issues), [issues]);
  const problemKeys = useMemo(() => new Set(attempted ? [...byCheck.keys()].map((i) => keys[i]!).filter(Boolean) : []), [attempted, byCheck, keys]);

  const change = useCallback((next: Draft, coalesce?: string) => history.change(next, coalesce), [history]);
  // typing in a field counts as one step of the undo history
  const setDef = (d: MonitorDefinition, coalesce = 'edit') => draft && change({ def: d, keys: draft.keys }, coalesce);
  const removeCard = (k: string) => {
    if (!draft) return;
    const i = draft.keys.indexOf(k);
    if (i < 0) return;
    const cid = draft.def.checks[i]!.id;
    const still = draft.def.checks.some((c, j) => j !== i && c.id === cid);
    change({
      def: {
        ...draft.def,
        checks: draft.def.checks.filter((_, j) => j !== i),
        // links name ids: they stay while another card has the same id
        links: still ? draft.def.links : draft.def.links.filter((l) => l.from !== cid && l.to !== cid),
      },
      keys: draft.keys.filter((_, j) => j !== i),
    });
    setSelected(null);
  };
  // Delete removes the selected card or link (outside text fields)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.key !== 'Delete' && e.key !== 'Backspace') || isTextTarget(e.target) || tab !== 'graph' || e.defaultPrevented) return;
      if (selected) {
        e.preventDefault();
        removeCard(selected);
      } else if (link !== null && draft) {
        e.preventDefault();
        change({ def: { ...draft.def, links: draft.def.links.filter((_, i) => i !== link) }, keys: draft.keys });
        setLink(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  useUndoKeys(!!draft && tab === 'graph', history.undo, history.redo);

  if (!def || !draft) return null;
  // Outputs (notifications, runbooks, external systems) need the manage right; new monitors belong to the creator.
  const canManage = isNew || !!existing.data?.permissions.includes('manage');
  const selIndex = selected ? keys.indexOf(selected) : -1;
  const sel = selIndex >= 0 ? def.checks[selIndex]! : null;
  const setCheck = (c: CheckDef) => {
    if (!sel || !selected) return;
    const old = sel.id;
    // remember which fields were changed: their problems are shown right away
    const fields = touched.current.get(selected) ?? new Set<string>();
    for (const k of new Set([...Object.keys(sel), ...Object.keys(c)]))
      if (JSON.stringify((sel as Record<string, unknown>)[k]) !== JSON.stringify((c as Record<string, unknown>)[k])) fields.add(k);
    touched.current.set(selected, fields);
    // links follow a renamed id, unless another card has (or gets) that id
    const unique = (id: string, except: number) => !def.checks.some((x, j) => j !== except && x.id === id);
    const links =
      c.id !== old && unique(old, selIndex) && unique(c.id, selIndex)
        ? def.links.map((l) => ({ ...l, from: l.from === old ? c.id : l.from, to: l.to === old ? c.id : l.to }))
        : def.links;
    setDef({ ...def, checks: def.checks.map((x, j) => (j === selIndex ? c : x)), links }, `card:${selected}`);
  };
  const uniqueId = (base: string) => {
    let n = 1;
    let id = base;
    while (def.checks.some((c) => c.id === id)) id = `${base}-${++n}`;
    return id;
  };
  const addCard = (c: CheckDef, linkFrom?: CheckDef) => {
    const k = newKey();
    change({
      def: { ...def, checks: [...def.checks, c], links: linkFrom ? [...def.links, { from: linkFrom.id, to: c.id, mode: 'soft' }] : def.links },
      keys: [...keys, k],
    });
    setSelected(k);
    setLink(null);
  };
  const addCheck = (type: CheckType) => {
    let n = 1;
    while (def.checks.some((c) => c.id === `${type}-${n}`)) n++;
    const c = newCheck(type, `${type}-${n}`);
    if (sel) {
      // below the selected card, depending on it (remove the link when it does not)
      c.x = sel.x ?? 0;
      c.y = (sel.y ?? 0) + NODE_H + 70;
      addCard(c, sel);
      return;
    }
    const maxY = Math.max(-NODE_H - 70, ...def.checks.map((x) => x.y ?? 0));
    c.x = 0;
    c.y = maxY + NODE_H + 70;
    addCard(c);
  };
  const duplicateCheck = () => {
    if (!sel) return;
    const copy = { ...structuredClone(sel), id: uniqueId(`${sel.id}-copy`), name: t('editor.copyName', { name: sel.name }) } as CheckDef;
    // the gateway key and the heartbeat secret belong to the original
    delete (copy as { key?: string }).key;
    copy.x = (sel.x ?? 0) + NODE_W + 40;
    copy.y = sel.y ?? 0;
    addCard(copy);
  };
  const tidy = () => {
    const pos = autoLayout({ ...def, checks: def.checks.map(({ x: _x, y: _y, ...c }) => c as CheckDef) });
    change({ def: { ...def, checks: def.checks.map((c) => ({ ...c, ...(pos.get(c.id) ?? {}) })) }, keys });
  };
  const tryCheck = async () => {
    if (!sel || !selected) return;
    const k = selected;
    setPreviews((p) => new Map(p).set(k, 'busy'));
    try {
      const r = await post<Preview>('/monitors/check-preview', { monitorId: isNew ? undefined : id, check: sel, timeoutSeconds: def.timeoutSeconds });
      setPreviews((p) => new Map(p).set(k, r));
    } catch (e) {
      setPreviews((p) => {
        const n = new Map(p);
        n.delete(k);
        return n;
      });
      notifyError(e);
    }
  };
  /** The problems of a card to show on its form: changed fields, all after a save attempt; empty fields say "required". */
  const errorsOf = (i: number): Map<string, string> => {
    const all = byCheck.get(i);
    if (!all) return new Map();
    const c = def.checks[i] as Record<string, unknown> | undefined;
    const seen = touched.current.get(keys[i]!) ?? new Set<string>();
    const out = new Map<string, string>();
    for (const [f, m] of all) {
      if (!attempted && !seen.has(f) && !(f === 'id' && /duplicate/.test(m))) continue;
      out.set(f, f && c && isEmpty(c[f]) ? t('editor.required') : m);
    }
    return out;
  };
  /** "Check "Name" (id) – Asset id": the card and the field's label as on the form */
  const labelOf = (issue: EditorIssue) => {
    if (issue.index === null || !issue.field) return issue.label;
    const card = issueLabel(def, `checks.${issue.index}`);
    const k = issue.field === 'id' ? 'form.checkId' : `form.${issue.field}`;
    return `${card} – ${i18n.exists(`monitors:${k}`) ? t(k as 'form.name') : issue.field}`;
  };
  const goTo = (issue: EditorIssue) => {
    if (issue.index === null) {
      setTab(issue.path.startsWith('outputs') ? 'outputs' : 'settings');
      return;
    }
    setTab('graph');
    setLink(null);
    setSelected(keys[issue.index] ?? null);
    if (issue.field) window.setTimeout(() => document.querySelector<HTMLElement>(`[data-testid="check-form"] [data-field="${issue.field}"]`)?.focus(), 80);
  };
  const applyYaml = (): MonitorDefinition | null => {
    try {
      const parsed = YAML.parse(yaml) as MonitorDefinition & { kind?: string; key?: string };
      const { kind: _k, key: k, ...rest } = parsed;
      if (k && isNew) setKey(k);
      const next = { ...EMPTY, ...rest } as MonitorDefinition;
      change(draftOf(next));
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
    setAttempted(true);
    const found = isTemplate ? [] : editorIssues(d);
    if (found.length) return; // the summary above the tabs names them
    setSaving(true);
    try {
      const body = { key: key.trim() || undefined, definition: d, ...(isNew ? { isTemplate } : { version: existing.data!.version }) };
      const r = isNew ? await post<MonitorSaveResult>('/monitors', body) : await put<MonitorSaveResult>(`/monitors/${id}`, body);
      qc.invalidateQueries({ queryKey: ['monitors'] });
      qc.invalidateQueries({ queryKey: ['monitor', r.monitor.id] });
      if (r.secrets.length) setSecrets(r);
      else navigate(`/monitors/${r.monitor.id}`);
    } catch (e) {
      // problems the server found are shown like the editor's own
      if (e instanceof ApiError && e.code === 'MONITOR_INVALID' && e.issues?.length) setFromServer({ def: d, issues: serverIssues(d, e.issues) });
      else notifyError(e, t('editor.notSaved'));
    } finally {
      setSaving(false);
    }
  };

  const l = link !== null ? def.links[link] : null;
  return (
    <>
      <PageHeader
        back={isNew || !existing.data ? 'monitors' : ['monitors', { to: `/monitors/${existing.data.id}`, label: existing.data.name }]}
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
      {attempted && issues.length > 0 && (
        <Alert color="red" mb="sm" title={t('editor.problemsTitle', { count: issues.length })} data-testid="monitor-problems">
          <Stack gap={2}>
            {issues.slice(0, 20).map((i) => (
              <Anchor key={i.path} component="button" type="button" size="sm" ta="left" onClick={() => goTo(i)}>
                {labelOf(i)}:{' '}
                {i.index !== null && i.field && isEmpty((def.checks[i.index] as Record<string, unknown> | undefined)?.[i.field])
                  ? t('editor.required')
                  : i.message}
              </Anchor>
            ))}
          </Stack>
        </Alert>
      )}
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
              <Group gap={6} mb={6} justify="flex-end">
                <Tooltip label={`${t('editor.undo')} (${modKey}Z)`}>
                  <ActionIcon variant="default" size="sm" onClick={history.undo} disabled={!history.canUndo} aria-label={t('editor.undo')}>
                    <IconArrowBackUp size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={`${t('editor.redo')} (${modKey}⇧Z)`}>
                  <ActionIcon variant="default" size="sm" onClick={history.redo} disabled={!history.canRedo} aria-label={t('editor.redo')}>
                    <IconArrowForwardUp size={14} />
                  </ActionIcon>
                </Tooltip>
                <Button
                  size="compact-xs"
                  variant="default"
                  leftSection={<IconLayoutDistributeHorizontal size={14} />}
                  onClick={tidy}
                  disabled={!def.checks.length}
                >
                  {t('editor.autoLayout')}
                </Button>
              </Group>
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
                nodeKeys={keys}
                problems={problemKeys}
                selected={selected}
                onSelect={(c) => (setSelected(c), setLink(null))}
                onChange={(d) => setDef(d)}
                onLinkClick={(i) => (setLink(i), setSelected(null))}
                height={560}
              />
              {def.checks.length > 1 && def.links.length === 0 && (
                <Text size="xs" c="dimmed" mt={4} data-testid="link-hint">
                  {t('editor.linkHowTo')}
                </Text>
              )}
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Paper withBorder p="sm">
                {sel && selected && (
                  <Stack gap="xs" data-testid="check-form">
                    <Group justify="space-between" gap={4}>
                      <Title order={4}>{t('detail.check')}</Title>
                      <Group gap={4}>
                        {TRYABLE.has(sel.type) && (
                          <Button
                            size="compact-xs"
                            variant="default"
                            leftSection={<IconPlayerPlay size={12} />}
                            loading={previews.get(selected) === 'busy'}
                            onClick={() => void tryCheck()}
                          >
                            {t('detail.checkNow')}
                          </Button>
                        )}
                        <Button size="compact-xs" variant="subtle" leftSection={<IconCopy size={12} />} onClick={duplicateCheck}>
                          {t('editor.duplicate')}
                        </Button>
                        <Button size="compact-xs" color="red" variant="subtle" leftSection={<IconTrash size={12} />} onClick={() => removeCard(selected)}>
                          {t('detail.remove')}
                        </Button>
                      </Group>
                    </Group>
                    {(() => {
                      const p = previews.get(selected);
                      if (!p || p === 'busy') return null;
                      return (
                        <Paper withBorder p={6} data-testid="check-preview">
                          <Group gap={6} wrap="nowrap" align="flex-start">
                            <MonitorStatusBadge status={p.status} size="sm" />
                            <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
                              {p.message}
                              {p.durationMs !== null ? ` · ${p.durationMs} ms` : ''}
                            </Text>
                          </Group>
                          <Text size="xs" c="dimmed">
                            {t('editor.previewNote')}
                          </Text>
                        </Paper>
                      );
                    })()}
                    <CheckForm
                      key={`${selected}:${history.seq}`}
                      check={sel}
                      onChange={setCheck}
                      platforms={platforms.data ?? []}
                      monitors={monitors.data ?? []}
                      monitorKey={key || 'monitor'}
                      isNew={!savedIds.has(sel.id)}
                      errors={errorsOf(selIndex)}
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
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      leftSection={<IconTrash size={14} />}
                      onClick={() => (setDef({ ...def, links: def.links.filter((_, i) => i !== link) }), setLink(null))}
                    >
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
            <Textarea
              label={t('form.description')}
              autosize
              minRows={2}
              value={def.description}
              onChange={(e) => setDef({ ...def, description: e.currentTarget.value })}
            />
            <TagInput label={t('editor.tags')} value={def.tags} onChange={(v) => setDef({ ...def, tags: v })} />
            <Group grow align="flex-start">
              <NumberInput
                label={t('form.interval')}
                min={5}
                value={def.intervalSeconds}
                onChange={(v) => setDef({ ...def, intervalSeconds: Number(v) || 60 })}
              />
              <NumberInput
                label={t('form.timeout')}
                min={1}
                max={300}
                value={def.timeoutSeconds}
                onChange={(v) => setDef({ ...def, timeoutSeconds: Number(v) || 10 })}
              />
            </Group>
            <Group grow align="flex-start">
              <NumberInput
                label={t('form.failuresBeforeDown')}
                description={t('editor.failuresHint')}
                min={1}
                max={20}
                value={def.failuresBeforeDown}
                onChange={(v) => setDef({ ...def, failuresBeforeDown: Number(v) || 1 })}
              />
              <NumberInput
                label={t('form.successesBeforeUp')}
                min={1}
                max={20}
                value={def.successesBeforeUp}
                onChange={(v) => setDef({ ...def, successesBeforeUp: Number(v) || 1 })}
              />
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
                <NumberInput
                  label={t('editor.quorum')}
                  min={1}
                  value={def.aggregate.quorum ?? ''}
                  onChange={(v) => setDef({ ...def, aggregate: { ...def.aggregate, quorum: Number(v) || undefined } })}
                />
              )}
            </Group>
            {isNew && (
              <Switch
                label={t('editor.isTemplate', { example: '{{ params.name }}' })}
                checked={isTemplate}
                onChange={(e) => {
                  setIsTemplate(e.currentTarget.checked);
                  if (e.currentTarget.checked)
                    setDef({ ...def, parameters: def.parameters ?? [{ name: 'host', label: t('form.host'), type: 'string', required: true }] });
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
            {isTemplate && <Alert color="blue">{t('editor.templateYaml', { example: '{{ params.<name> }}' })}</Alert>}
            <Textarea
              autosize
              minRows={18}
              maxRows={40}
              value={yaml}
              onChange={(e) => setYaml(e.currentTarget.value)}
              classNames={{ input: 'mono' }}
              aria-label={t('editor.yamlSource')}
              error={yamlError}
            />
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

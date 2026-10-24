import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Anchor, Badge, Box, Button, Center, Collapse, Group, Loader, Modal, Stack, Switch, Tabs, Text, Textarea, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconDeviceFloppy, IconDownload, IconInfoCircle, IconPlayerPlay } from '@tabler/icons-react';
import { validateProcess, type ProcessDefinition, type ProcessDetail, type ValidationIssue } from '@sm/shared';
import { ApiError, get, notifyError, notifyOk, put, apiUrl } from '../api';
import { PageHeader } from '../components/common';
import { GitOriginBadge } from '../components/gitsync/GitOriginBadge';
import { RunDialog } from '../components/RunDialog';
import { AccessEditor } from '../components/AccessEditor';
import { SourcePanel, VersionsPanel } from '../components/editor/DefinitionTabs';
import { SettingsTab } from '../components/editor/SettingsTab';
import { FlowEditor } from '../components/flow/FlowEditor';
import { useLastRun } from '../components/flow/useLastRun';
import { ExprProvider } from '../components/editor/ExprContext';
import { useDefHistory, useUndoKeys } from '../components/editor/useDefHistory';
import { fmtRelative } from '../format';
import { issueText } from '../i18n/meta';
import { statusLabel } from '../components/common';

/** Drop undefined values so dirty-checking and saving see the same thing. */
const normalize = (d: ProcessDefinition): ProcessDefinition => JSON.parse(JSON.stringify(d));

/** Editor tabs. To add one (e.g. "Access"), insert a Tabs.Tab and Tabs.Panel at the ACCESS_TAB markers below. */
export type EditorTab = 'flow' | 'settings' | 'source' | 'versions' | (string & {});

const byNode = (list: ValidationIssue[]) => {
  const m = new Map<string, string>();
  for (const i of list) if (i.nodeId && !m.has(i.nodeId)) m.set(i.nodeId, issueText(i));
  return m;
};

export function ProcessEditorPage() {
  const { t, i18n } = useTranslation(['editor', 'common']);
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const proc = useQuery({ queryKey: ['process', id], queryFn: () => get<ProcessDetail>(`/processes/${id}`), enabled: !!id });
  const [def, setDef] = useState<ProcessDefinition | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState('');
  const [tab, setTab] = useState<string | null>('flow');
  const [saveOpen, setSaveOpen] = useState(false);
  const [runWarn, setRunWarn] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  const [showRun, setShowRun] = useState(false);
  const lastRun = useLastRun(id ?? '', showRun && !!id);
  const history = useDefHistory(def, setDef);
  const editable = !!proc.data?.permissions.includes('edit');
  useUndoKeys(editable && !!def, history.undo, history.redo);

  // initialise working copy once per process
  useEffect(() => {
    if (proc.data && proc.data.id !== loadedId) {
      const d = normalize(structuredClone(proc.data.definition));
      setLoadedId(proc.data.id);
      setDef(d);
      setBaseline(JSON.stringify(d));
      history.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proc.data?.id]);

  const dirty = !!def && JSON.stringify(normalize(def)) !== baseline;

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const validation = useMemo(() => (def ? validateProcess(def) : { ok: true, issues: [] as ValidationIssue[], warnings: [] as ValidationIssue[] }), [def]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const issuesByNode = useMemo(() => byNode(validation.issues), [validation.issues, i18n.language]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const warningsByNode = useMemo(() => byNode(validation.warnings), [validation.warnings, i18n.language]);

  if (proc.isLoading || (!proc.error && (!def || loadedId !== proc.data?.id))) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (proc.error || !proc.data || !def) {
    return <Alert color="red">{t('page.loadFailed', { error: (proc.error as Error)?.message ?? '' })}</Alert>;
  }

  const p = proc.data;
  const canEdit = !!p?.permissions.includes('edit');
  const onRun = () => (dirty ? setRunWarn(true) : setRunOpen(true));
  const problems = [
    ...validation.issues.map((i) => ({ ...i, severity: 'error' as const })),
    ...validation.warnings.map((w) => ({ ...w, severity: 'warning' as const })),
  ];

  const runToolbar = (
    <Group
      gap={6}
      wrap="nowrap"
      px={6}
      py={2}
      style={{ background: 'var(--mantine-color-body)', borderRadius: 6, border: '1px solid var(--mantine-color-default-border)' }}
    >
      <Switch size="xs" label={t('flow.lastRun')} checked={showRun} onChange={(e) => setShowRun(e.currentTarget.checked)} />
      {showRun && lastRun.run && (
        <Anchor component={Link} to={`/runs/${lastRun.run.id}`} size="xs">
          {statusLabel(lastRun.run.status)} · {fmtRelative(lastRun.run.startedAt)}
        </Anchor>
      )}
      {showRun && lastRun.none && (
        <Text size="xs" c="dimmed">
          {t('page.noRuns')}
        </Text>
      )}
    </Group>
  );

  return (
    <Box>
      <PageHeader
        back="processes"
        title={
          <Group gap="xs" wrap="wrap">
            <span>{def.name || p.name}</span>
            <Badge variant="light">v{p.currentVersion}</Badge>
            <GitOriginBadge kind="process" id={p.id} />
            {dirty && (
              <Badge color="orange" variant="light">
                {t('page.unsaved')}
              </Badge>
            )}
          </Group>
        }
        description={<span className="mono">{p.id}</span>}
        actions={
          <>
            {problems.length > 0 && (
              <UnstyledButton onClick={() => setShowIssues((s) => !s)}>
                <Group gap={4}>
                  {validation.issues.length > 0 && (
                    <Badge color="red" leftSection={<IconAlertTriangle size={12} />}>
                      {t('issues.count', { count: validation.issues.length })}
                    </Badge>
                  )}
                  {validation.warnings.length > 0 && (
                    <Badge color="orange" variant="light" leftSection={<IconInfoCircle size={12} />}>
                      {t('issues.warnings', { count: validation.warnings.length })}
                    </Badge>
                  )}
                </Group>
              </UnstyledButton>
            )}
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`/processes/${p.id}/export`)}
              leftSection={<IconDownload size={14} />}
              visibleFrom="xs"
            >
              {t('page.exportYaml')}
            </Button>
            {p.permissions.includes('run') && (
              <Button size="xs" variant="light" leftSection={<IconPlayerPlay size={14} />} onClick={onRun}>
                {t('page.run')}
              </Button>
            )}
            {canEdit ? (
              <Button size="xs" leftSection={<IconDeviceFloppy size={14} />} disabled={!dirty} onClick={() => setSaveOpen(true)}>
                {t('common:save')}
              </Button>
            ) : (
              <Badge variant="light" color="gray" size="lg">
                {t('page.readOnly')}
              </Badge>
            )}
          </>
        }
      />

      {problems.length > 0 && (
        <Alert
          color={validation.issues.length ? 'red' : 'orange'}
          variant="light"
          mb="sm"
          p="xs"
          title={
            <UnstyledButton onClick={() => setShowIssues((s) => !s)}>
              <Group gap={4}>
                {showIssues ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                <Text size="sm" fw={600}>
                  {validation.issues.length
                    ? t('issues.refused', { count: validation.issues.length })
                    : t('issues.warnings', { count: validation.warnings.length })}
                  {validation.issues.length > 0 && validation.warnings.length > 0 ? `, ${t('issues.warnings', { count: validation.warnings.length })}` : ''}
                </Text>
              </Group>
            </UnstyledButton>
          }
        >
          <Collapse in={showIssues}>
            <Stack gap={2}>
              {problems.slice(0, 30).map((i, k) => (
                <UnstyledButton
                  key={k}
                  disabled={!i.nodeId}
                  onClick={() => {
                    if (!i.nodeId) return;
                    setTab('flow');
                    setFocus((f) => ({ id: i.nodeId!, seq: (f?.seq ?? 0) + 1 }));
                  }}
                >
                  <Text size="xs" c={i.severity === 'error' ? 'red' : 'orange'} td={i.nodeId ? 'underline' : undefined}>
                    {i.nodeId ? `${i.nodeId}: ` : i.path ? `${i.path}: ` : ''}
                    {issueText(i)}
                  </Text>
                </UnstyledButton>
              ))}
            </Stack>
          </Collapse>
        </Alert>
      )}

      <ExprProvider processId={p.id} def={def}>
        <Tabs value={tab} onChange={setTab} keepMounted={false}>
          <Tabs.List mb="sm">
            <Tabs.Tab value="flow">{t('page.tabs.flow')}</Tabs.Tab>
            <Tabs.Tab value="settings">{t('page.tabs.settings')}</Tabs.Tab>
            <Tabs.Tab value="source">{t('page.tabs.source')}</Tabs.Tab>
            <Tabs.Tab value="versions">{t('page.tabs.versions')}</Tabs.Tab>
            <Tabs.Tab value="access">{t('page.tabs.access')}</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="flow">
            <FlowEditor
              def={def}
              onChange={history.change}
              processId={p.id}
              onUndo={history.undo}
              onRedo={history.redo}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              historySeq={history.seq}
              issuesByNode={issuesByNode}
              warningsByNode={warningsByNode}
              runStatus={showRun ? lastRun.statusByNode : undefined}
              focus={focus}
              toolbar={runToolbar}
              height="calc(100vh - 230px)"
              readOnly={!canEdit}
            />
          </Tabs.Panel>
          <Tabs.Panel value="settings">
            <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <SettingsTab key={history.seq} def={def} onChange={(d) => history.change(d, 'settings')} />
            </fieldset>
          </Tabs.Panel>
          <Tabs.Panel value="source">
            <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <SourcePanel key={history.seq} def={def} onChange={(d) => history.change(normalize(d))} />
            </fieldset>
          </Tabs.Panel>
          <Tabs.Panel value="versions">
            <VersionsPanel
              processId={p.id}
              currentVersion={p.currentVersion}
              workingCopy={dirty ? def : undefined}
              onRestore={(d, v) => {
                if (!canEdit) return notifyError(new Error(t('page.viewOnly')));
                history.change(normalize(d));
                setTab('flow');
                notifyOk(t('page.restored', { version: v }));
              }}
            />
          </Tabs.Panel>
          <Tabs.Panel value="access" pt="md">
            <AccessEditor
              kind="process"
              acl={p.acl}
              owner={p.owner}
              readOnly={!p.permissions.includes('manage')}
              onSave={async (acl, owner) => {
                try {
                  const saved = await put<ProcessDetail>(`/processes/${p.id}/access`, { acl, owner });
                  qc.setQueryData(['process', id], (old: ProcessDetail | undefined) =>
                    old ? { ...old, acl: saved.acl, owner: saved.owner, permissions: saved.permissions } : saved,
                  );
                  qc.invalidateQueries({ queryKey: ['processes'] });
                  notifyOk(t('page.accessSaved'));
                } catch (e) {
                  notifyError(e, t('page.accessNotSaved'));
                }
              }}
            />
          </Tabs.Panel>
        </Tabs>
      </ExprProvider>

      <SaveModal
        opened={saveOpen}
        onClose={() => setSaveOpen(false)}
        processId={p.id}
        def={def}
        onSaved={(saved) => {
          qc.setQueryData(['process', id], saved);
          qc.invalidateQueries({ queryKey: ['processes'] });
          qc.invalidateQueries({ queryKey: ['process-versions', p.id] });
          const d = normalize(structuredClone(saved.definition));
          setDef(d);
          setBaseline(JSON.stringify(d));
          setSaveOpen(false);
        }}
      />

      <Modal opened={runWarn} onClose={() => setRunWarn(false)} title={t('page.unsavedTitle')}>
        <Stack>
          <Text size="sm">{t('page.unsavedText', { version: p.currentVersion })}</Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setRunWarn(false);
                setRunOpen(true);
              }}
            >
              {t('page.runVersion', { version: p.currentVersion })}
            </Button>
            <Button
              onClick={() => {
                setRunWarn(false);
                setSaveOpen(true);
              }}
            >
              {t('page.saveFirst')}
            </Button>
          </Group>
        </Stack>
      </Modal>

      <RunDialog processId={p.id} opened={runOpen} onClose={() => setRunOpen(false)} />
    </Box>
  );
}

function SaveModal({
  opened,
  onClose,
  processId,
  def,
  onSaved,
}: {
  opened: boolean;
  onClose: () => void;
  processId: string;
  def: ProcessDefinition;
  onSaved: (p: ProcessDetail) => void;
}) {
  const { t } = useTranslation(['editor', 'common']);
  const [comment, setComment] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (opened) {
      setComment('');
      setIssues(null);
    }
  }, [opened]);
  const save = async () => {
    setBusy(true);
    try {
      const saved = await put<ProcessDetail>(`/processes/${processId}`, { definition: normalize(def), comment: comment.trim() || undefined });
      notifyOk(t('save.saved', { version: saved.currentVersion }));
      onSaved(saved);
    } catch (e) {
      if (e instanceof ApiError && e.issues?.length) setIssues(e.issues);
      else notifyError(e, t('save.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title={t('save.title')}>
      <Stack>
        <Textarea
          label={t('save.comment')}
          description={t('save.commentHint')}
          autosize
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          data-autofocus
        />
        {issues && (
          <Alert color="red" title={t('save.validationFailed')}>
            <Stack gap={2}>
              {issues.slice(0, 15).map((i, k) => (
                <Text size="xs" key={k} className="mono">
                  {i.path ? `${i.path}: ` : ''}
                  {issueText(i)}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} leftSection={<IconDeviceFloppy size={16} />}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

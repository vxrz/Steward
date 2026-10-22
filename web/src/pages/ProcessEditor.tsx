import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Anchor, Badge, Box, Button, Center, Collapse, Group, Loader, Modal, Stack, Switch, Tabs, Text, Textarea, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconDeviceFloppy, IconDownload, IconInfoCircle, IconPlayerPlay } from '@tabler/icons-react';
import { validateProcess, type ProcessDefinition, type ProcessDetail, type ValidationIssue } from '@sm/shared';
import { ApiError, get, notifyError, notifyOk, put } from '../api';
import { PageHeader } from '../components/common';
import { RunDialog } from '../components/RunDialog';
import { AccessEditor } from '../components/AccessEditor';
import { SourcePanel, VersionsPanel } from '../components/editor/DefinitionTabs';
import { SettingsTab } from '../components/editor/SettingsTab';
import { FlowEditor } from '../components/flow/FlowEditor';
import { useLastRun } from '../components/flow/useLastRun';
import { fmtRelative } from '../format';

/** Drop undefined values so dirty-checking and saving see the same thing. */
const normalize = (d: ProcessDefinition): ProcessDefinition => JSON.parse(JSON.stringify(d));

/** Editor tabs. To add one (e.g. "Access"), insert a Tabs.Tab and Tabs.Panel at the ACCESS_TAB markers below. */
export type EditorTab = 'flow' | 'settings' | 'source' | 'versions' | (string & {});

const byNode = (list: ValidationIssue[]) => {
  const m = new Map<string, string>();
  for (const i of list) if (i.nodeId && !m.has(i.nodeId)) m.set(i.nodeId, i.message);
  return m;
};

export function ProcessEditorPage() {
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

  // initialise working copy once per process
  useEffect(() => {
    if (proc.data && proc.data.id !== loadedId) {
      const d = normalize(structuredClone(proc.data.definition));
      setLoadedId(proc.data.id);
      setDef(d);
      setBaseline(JSON.stringify(d));
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

  const validation = useMemo(
    () => (def ? validateProcess(def) : { ok: true, issues: [] as ValidationIssue[], warnings: [] as ValidationIssue[] }),
    [def],
  );
  const issuesByNode = useMemo(() => byNode(validation.issues), [validation.issues]);
  const warningsByNode = useMemo(() => byNode(validation.warnings), [validation.warnings]);

  if (proc.isLoading || (!proc.error && (!def || loadedId !== proc.data?.id))) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }
  if (proc.error || !proc.data || !def) {
    return <Alert color="red">Could not load process: {(proc.error as Error)?.message}</Alert>;
  }

  const p = proc.data;
  const canEdit = !!p?.permissions.includes('edit');
  const onRun = () => (dirty ? setRunWarn(true) : setRunOpen(true));
  const problems = [...validation.issues.map((i) => ({ ...i, severity: 'error' as const })), ...validation.warnings.map((w) => ({ ...w, severity: 'warning' as const }))];

  const runToolbar = (
    <Group gap={6} wrap="nowrap" px={6} py={2} style={{ background: 'var(--mantine-color-body)', borderRadius: 6, border: '1px solid var(--mantine-color-default-border)' }}>
      <Switch size="xs" label="Last run" checked={showRun} onChange={(e) => setShowRun(e.currentTarget.checked)} />
      {showRun && lastRun.run && (
        <Anchor component={Link} to={`/runs/${lastRun.run.id}`} size="xs">
          {lastRun.run.status} · {fmtRelative(lastRun.run.startedAt)}
        </Anchor>
      )}
      {showRun && lastRun.none && (
        <Text size="xs" c="dimmed">
          no runs yet
        </Text>
      )}
    </Group>
  );

  return (
    <Box>
      <PageHeader
        title={
          <Group gap="xs" wrap="wrap">
            <span>{def.name || p.name}</span>
            <Badge variant="light">v{p.currentVersion}</Badge>
            {dirty && (
              <Badge color="orange" variant="light">
                unsaved changes
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
                      {validation.issues.length} issue(s)
                    </Badge>
                  )}
                  {validation.warnings.length > 0 && (
                    <Badge color="orange" variant="light" leftSection={<IconInfoCircle size={12} />}>
                      {validation.warnings.length} warning(s)
                    </Badge>
                  )}
                </Group>
              </UnstyledButton>
            )}
            <Button size="sm" variant="default" component="a" href={`/api/processes/${p.id}/export`} leftSection={<IconDownload size={16} />} visibleFrom="xs">
              Export YAML
            </Button>
            {p.permissions.includes('run') && (
              <Button size="sm" variant="light" leftSection={<IconPlayerPlay size={16} />} onClick={onRun}>
                Run
              </Button>
            )}
            {canEdit ? (
              <Button size="sm" leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty} onClick={() => setSaveOpen(true)}>
                Save
              </Button>
            ) : (
              <Badge variant="light" color="gray" size="lg">
                read-only
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
                  {validation.issues.length ? `${validation.issues.length} issue(s) – saving will be refused` : `${validation.warnings.length} warning(s)`}
                  {validation.issues.length > 0 && validation.warnings.length > 0 ? `, ${validation.warnings.length} warning(s)` : ''}
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
                    {i.message}
                  </Text>
                </UnstyledButton>
              ))}
            </Stack>
          </Collapse>
        </Alert>
      )}

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="sm">
          <Tabs.Tab value="flow">Flow</Tabs.Tab>
          <Tabs.Tab value="settings">Settings</Tabs.Tab>
          <Tabs.Tab value="source">Source</Tabs.Tab>
          <Tabs.Tab value="versions">Versions</Tabs.Tab>
          <Tabs.Tab value="access">Access</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="flow">
          <FlowEditor
            def={def}
            onChange={setDef}
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
            <SettingsTab def={def} onChange={setDef} />
          </fieldset>
        </Tabs.Panel>
        <Tabs.Panel value="source">
          <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            <SourcePanel def={def} onChange={(d) => setDef(normalize(d))} />
          </fieldset>
        </Tabs.Panel>
        <Tabs.Panel value="versions">
          <VersionsPanel
            processId={p.id}
            currentVersion={p.currentVersion}
            onRestore={(d, v) => {
              if (!canEdit) return notifyError(new Error('You may view but not change this process'));
              setDef(normalize(d));
              setTab('flow');
              notifyOk(`Version v${v} loaded as working copy – save to make it the current version.`);
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
                qc.setQueryData(['process', id], (old: ProcessDetail | undefined) => (old ? { ...old, acl: saved.acl, owner: saved.owner, permissions: saved.permissions } : saved));
                qc.invalidateQueries({ queryKey: ['processes'] });
                notifyOk('Access saved');
              } catch (e) {
                notifyError(e, 'Access not saved');
              }
            }}
          />
        </Tabs.Panel>
      </Tabs>

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

      <Modal opened={runWarn} onClose={() => setRunWarn(false)} title="Unsaved changes">
        <Stack>
          <Text size="sm">Runs always use a saved version. Your current changes are not saved yet – the run would use v{p.currentVersion}.</Text>
          <Group justify="flex-end">
            <Button
              variant="default"
              onClick={() => {
                setRunWarn(false);
                setRunOpen(true);
              }}
            >
              Run v{p.currentVersion}
            </Button>
            <Button
              onClick={() => {
                setRunWarn(false);
                setSaveOpen(true);
              }}
            >
              Save first
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
      notifyOk(`Saved as version v${saved.currentVersion}`);
      onSaved(saved);
    } catch (e) {
      if (e instanceof ApiError && e.issues?.length) setIssues(e.issues);
      else notifyError(e, 'Not saved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={onClose} title="Save new version">
      <Stack>
        <Textarea
          label="Change comment (optional)"
          description="Recorded with the version and in the audit log"
          autosize
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          data-autofocus
        />
        {issues && (
          <Alert color="red" title="Validation failed">
            <Stack gap={2}>
              {issues.slice(0, 15).map((i, k) => (
                <Text size="xs" key={k} className="mono">
                  {i.path ? `${i.path}: ` : ''}
                  {i.message}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} leftSection={<IconDeviceFloppy size={16} />}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

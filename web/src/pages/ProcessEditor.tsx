import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Badge, Box, Button, Center, Grid, Group, Loader, Modal, Paper, Stack, Tabs, Text, Textarea, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle, IconDeviceFloppy, IconDownload, IconPlayerPlay } from '@tabler/icons-react';
import { validateProcess, type ProcessDefinition, type ProcessDetail, type Step, type ValidationIssue } from '@sm/shared';
import { ApiError, get, notifyError, notifyOk, put } from '../api';
import { PageHeader } from '../components/common';
import { RunDialog } from '../components/RunDialog';
import { StepList, type TreeActions } from '../components/editor/StepTree';
import { ExpressionHelp, StepForm } from '../components/editor/StepForm';
import { ConnectionsPanel, ConstantsPanel, GeneralPanel, InputsPanel, SourcePanel, VersionsPanel } from '../components/editor/DefinitionTabs';
import {
  ROOT,
  allIds,
  createStep,
  duplicateStep,
  getStep,
  insertStep,
  locKey,
  moveStep,
  removeStep,
  replaceStep,
  type Loc,
} from '../components/editor/paths';

/** Drop undefined values so dirty-checking and saving see the same thing. */
const normalize = (d: ProcessDefinition): ProcessDefinition => JSON.parse(JSON.stringify(d));

export function ProcessEditorPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const proc = useQuery({ queryKey: ['process', id], queryFn: () => get<ProcessDetail>(`/processes/${id}`), enabled: !!id });
  const [def, setDef] = useState<ProcessDefinition | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [baseline, setBaseline] = useState('');
  const [selected, setSelected] = useState<Loc | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<string | null>('steps');
  const [saveOpen, setSaveOpen] = useState(false);
  const [runWarn, setRunWarn] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  // initialise working copy once per process
  useEffect(() => {
    if (proc.data && proc.data.id !== loadedId) {
      const d = normalize(structuredClone(proc.data.definition));
      setLoadedId(proc.data.id);
      setDef(d);
      setBaseline(JSON.stringify(d));
      setSelected(null);
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

  const validation = useMemo(() => (def ? validateProcess(def) : { ok: true, issues: [] as ValidationIssue[] }), [def]);

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
  const steps = def.steps ?? [];
  const setSteps = (s: Step[]) => setDef({ ...def, steps: s });
  const selectedStep = selected ? getStep(steps, selected) : undefined;
  const ids = allIds(steps);
  const otherIds = new Set([...ids].filter((x) => x !== selectedStep?.id));

  const actions: TreeActions = {
    selected: locKey(selected),
    onSelect: (loc) => {
      setSelected(loc);
      // on narrow screens the form is below the tree – bring it into view
      if (window.innerWidth < 992) setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    },
    onAdd: (ref, index, type) => {
      const [s, loc] = insertStep(steps, ref, index, createStep(type, ids));
      setSteps(s);
      setSelected(loc);
    },
    onMove: (loc, d) => {
      const [s, nloc] = moveStep(steps, loc, d);
      setSteps(s);
      if (locKey(loc) === locKey(selected)) setSelected(nloc);
    },
    onDuplicate: (loc) => {
      const [s, nloc] = duplicateStep(steps, loc);
      setSteps(s);
      setSelected(nloc);
    },
    onRemove: (loc) => {
      setSteps(removeStep(steps, loc));
      setSelected(null);
    },
  };

  const onRun = () => (dirty ? setRunWarn(true) : setRunOpen(true));

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
            {validation.issues.length > 0 && (
              <Tooltip label="See issues below">
                <Badge color="red" leftSection={<IconAlertTriangle size={12} />}>
                  {validation.issues.length} issue(s)
                </Badge>
              </Tooltip>
            )}
            <Button
              size="sm"
              variant="default"
              component="a"
              href={`/api/processes/${p.id}/export`}
              leftSection={<IconDownload size={16} />}
              visibleFrom="xs"
            >
              Export YAML
            </Button>
            <Button size="sm" variant="light" leftSection={<IconPlayerPlay size={16} />} onClick={onRun}>
              Run
            </Button>
            <Button size="sm" leftSection={<IconDeviceFloppy size={16} />} disabled={!dirty} onClick={() => setSaveOpen(true)}>
              Save
            </Button>
          </>
        }
      />

      {validation.issues.length > 0 && (
        <Alert color="red" variant="light" mb="md" title="The process has validation issues (saving will be refused)">
          <Stack gap={2}>
            {validation.issues.slice(0, 10).map((i, k) => (
              <Text size="xs" key={k} className="mono">
                {i.path ? `${i.path}: ` : ''}
                {i.message}
              </Text>
            ))}
            {validation.issues.length > 10 && <Text size="xs">… and {validation.issues.length - 10} more</Text>}
          </Stack>
        </Alert>
      )}

      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="steps">Steps</Tabs.Tab>
          <Tabs.Tab value="general">General</Tabs.Tab>
          <Tabs.Tab value="inputs">Inputs ({def.inputs?.length ?? 0})</Tabs.Tab>
          <Tabs.Tab value="connections">Connections ({def.connections?.length ?? 0})</Tabs.Tab>
          <Tabs.Tab value="constants">Constants</Tabs.Tab>
          <Tabs.Tab value="source">Source</Tabs.Tab>
          <Tabs.Tab value="versions">Versions</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="steps">
          <Grid gutter="md">
            <Grid.Col span={{ base: 12, md: 5 }}>
              <Paper withBorder p="sm">
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb="xs">
                  Steps
                </Text>
                <StepList steps={steps} refBlock={ROOT} actions={actions} />
              </Paper>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 7 }}>
              <Stack gap="sm">
                <ExpressionHelp />
                <Paper withBorder p="md" ref={formRef} style={{ scrollMarginTop: 64 }}>
                  {selectedStep && selected ? (
                    <StepForm
                      key={locKey(selected) + ':' + selectedStep.type}
                      step={selectedStep}
                      otherIds={otherIds}
                      connections={def.connections ?? []}
                      onChange={(s) => setSteps(replaceStep(steps, selected, s))}
                    />
                  ) : (
                    <Text size="sm" c="dimmed">
                      Select a step to edit it, or add a new one. Steps run top to bottom; loops and conditions contain nested steps.
                    </Text>
                  )}
                </Paper>
              </Stack>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>
        <Tabs.Panel value="general">
          <GeneralPanel def={def} onChange={setDef} />
        </Tabs.Panel>
        <Tabs.Panel value="inputs">
          <InputsPanel def={def} onChange={setDef} />
        </Tabs.Panel>
        <Tabs.Panel value="connections">
          <ConnectionsPanel def={def} onChange={setDef} />
        </Tabs.Panel>
        <Tabs.Panel value="constants">
          <ConstantsPanel def={def} onChange={setDef} />
        </Tabs.Panel>
        <Tabs.Panel value="source">
          <SourcePanel
            def={def}
            onChange={(d) => {
              setDef(normalize(d));
              setSelected(null);
            }}
          />
        </Tabs.Panel>
        <Tabs.Panel value="versions">
          <VersionsPanel
            processId={p.id}
            currentVersion={p.currentVersion}
            onRestore={(d, v) => {
              setDef(normalize(d));
              setSelected(null);
              setTab('steps');
              notifyOk(`Version v${v} loaded as working copy – save to make it the current version.`);
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

import { useState } from 'react';
import { ActionIcon, Autocomplete, Button, Group, Paper, Select, SimpleGrid, Stack, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_PRODUCT_LIMITS as L,
  DATA_RUNNER_KINDS,
  DATA_RUNNER_TOOLS,
  DATA_RUNNER_TOOL_LABEL_KEYS,
  DATA_STEP_KINDS,
  DATA_TRANSFORM_KINDS,
  type ApplicationSummary,
  type DataRunnerKind,
  type DataStep,
  type DataStepInput,
  type DataStepKind,
  type DataTransformKind,
  type DataTransformNote,
  type Platform,
  type SystemSummary,
} from '@sm/shared';
import { get, post, put } from '../../api';
import { FormModal } from '../FormModal';
import { useFieldErrors } from '../common';
import { ElementPicker, type PickedElement } from './ElementPicker';
import { FormButtons, useBusy } from './form';
import { TechnologyInput } from './GenericParts';
import { useEnvironmentList } from '../catalogue/environments';

const enc = encodeURIComponent;

/**
 * A step of a product's pipeline (ADR 0036 part 9): inputs → a runner → outputs, its kind, schedule and ordered
 * transformation notes. Documentation only – Steward runs nothing. A step is documented where its result lives: who
 * may change the products of its output elements changes it; inputs the editor may not see stay and are counted.
 */
export function StepForm({
  productId,
  step,
  names,
  onClose,
  onSaved,
}: {
  productId: string;
  step?: DataStep;
  /** Names of elements known to the page (members, the pipeline) */
  names: Map<string, PickedElement>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews', 'common']);
  const s = step;
  const r = s?.runner ?? null;
  const [name, setName] = useState(s?.name ?? '');
  const [kind, setKind] = useState<DataStepKind>(s?.kind ?? 'transform');
  const [runnerKind, setRunnerKind] = useState<DataRunnerKind | null>(r?.kind ?? null);
  const [runnerId, setRunnerId] = useState<string | null>(r && 'id' in r ? r.id : null);
  const [runnerElement, setRunnerElement] = useState<PickedElement[]>(r?.kind === 'element' ? [names.get(r.id) ?? { id: r.id, label: r.id }] : []);
  const [connectorPlatform, setConnectorPlatform] = useState<string | null>(r?.kind === 'connector' ? r.platformId : null);
  const [connectorName, setConnectorName] = useState(r?.kind === 'connector' ? r.name : '');
  const [tool, setTool] = useState(r?.kind === 'tool' ? r.tool : '');
  const [toolText, setToolText] = useState(r?.kind === 'tool' ? r.text : '');
  // 0.25.0 (ADR 0037): the runner's technology – what a bridge is (Debezium, Node-RED, Apache Camel …)
  const [technology, setTechnology] = useState(r?.technology ?? '');
  // 0.25.0 (ADR 0037): the system (and environment) an application or connector runs on – "… @ ied-line-01.example"
  const [runsOn, setRunsOn] = useState<string | null>(s?.runsOn?.id ?? null);
  const [runsOnEnv, setRunsOnEnv] = useState(s?.runsOn?.environment ?? '');
  const runsOnShown = runnerKind === 'application' || runnerKind === 'connector';
  const envList = useEnvironmentList();
  const systems = useQuery({
    queryKey: ['dataProducts', 'systems'],
    queryFn: () => get<SystemSummary[]>('/systems'),
    enabled: runsOnShown,
  });
  const [schedule, setSchedule] = useState(s?.schedule ?? '');
  const [description, setDescription] = useState(s?.description ?? '');
  const [notes, setNotes] = useState<DataTransformNote[]>(s?.notes ?? []);
  const label = (id: string) => names.get(id) ?? { id, label: id };
  const [inputs, setInputs] = useState<PickedElement[]>((s?.inputs ?? []).map(label));
  const [outputs, setOutputs] = useState<PickedElement[]>((s?.outputs ?? []).map(label));
  const [busy, run] = useBusy();
  const apps = useQuery({
    queryKey: ['dataProducts', 'applications'],
    queryFn: () => get<ApplicationSummary[]>('/applications'),
    enabled: runnerKind === 'application',
  });
  const platforms = useQuery({
    queryKey: ['dataProducts', 'platforms'],
    queryFn: () => get<Platform[]>('/platforms'),
    enabled: runnerKind === 'platform' || runnerKind === 'connector',
  });
  const processes = useQuery({
    queryKey: ['dataProducts', 'processes'],
    queryFn: () => get<{ id: string; name: string }[]>('/processes'),
    enabled: runnerKind === 'process',
  });
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    outputs: !outputs.length && t('steps.outputsRequired'),
    runner:
      ((runnerKind === 'application' || runnerKind === 'platform' || runnerKind === 'process') && !runnerId) ||
      (runnerKind === 'element' && !runnerElement.length) ||
      (runnerKind === 'connector' && (!connectorPlatform || !connectorName.trim()))
        ? t('steps.runnerRequired')
        : false,
  });
  const on = runsOn ? { runsOn: { systemId: runsOn, environment: runsOnEnv.trim() } } : {};
  const runner = (): DataStepInput['runner'] => {
    const tech = technology.trim() ? { technology: technology.trim() } : {};
    switch (runnerKind) {
      case 'application':
        return { kind: runnerKind, id: runnerId!, ...on, ...tech };
      case 'platform':
      case 'process':
        return { kind: runnerKind, id: runnerId!, ...tech };
      case 'element':
        return { kind: 'element', id: runnerElement[0]!.id, ...tech };
      case 'connector':
        return { kind: 'connector', platformId: connectorPlatform!, name: connectorName.trim(), ...on, ...tech };
      case 'tool':
        return { kind: 'tool', tool: tool.trim(), text: toolText.trim(), ...tech };
      default:
        return null;
    }
  };
  const save = () =>
    run(async () => {
      const body: DataStepInput = {
        name: name.trim(),
        kind,
        runner: runner(),
        schedule: schedule.trim(),
        description,
        notes: notes.filter((n) => n.text.trim()).map((n) => ({ kind: n.kind, text: n.text.trim() })),
        inputs: inputs.map((e) => e.id),
        outputs: outputs.map((e) => e.id),
      };
      if (s) await put(`/data-products/${enc(productId)}/steps/${enc(s.id)}`, body);
      else await post(`/data-products/${enc(productId)}/steps`, body);
      onSaved();
    }, t('form.notSaved'));
  const runnerOptions =
    runnerKind === 'application'
      ? (apps.data ?? []).map((a) => ({ value: a.id, label: a.name }))
      : runnerKind === 'platform'
        ? (platforms.data ?? []).map((p) => ({ value: p.id, label: p.name }))
        : (processes.data ?? []).map((p) => ({ value: p.id, label: p.name }));
  return (
    <FormModal onClose={onClose} size="lg" title={s ? t('steps.editTitle', { name: s.name }) : t('steps.newTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('steps.help')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('steps.name')}
              required
              maxLength={L.name}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              error={v.error('name')}
              data-autofocus
              data-testid="step-name"
            />
            <Select
              label={t('steps.kind')}
              data={DATA_STEP_KINDS.map((k) => ({ value: k, label: t(`dataProductViews:stepKinds.${k}`) }))}
              value={kind}
              onChange={(k) => k && setKind(k as DataStepKind)}
              allowDeselect={false}
            />
          </SimpleGrid>
          <ElementPicker
            label={t('steps.inputs')}
            description={t('steps.inputsHint')}
            value={inputs}
            onChange={setInputs}
            max={L.stepEnds}
            testId="step-inputs"
          />
          {s && s.hiddenInputs > 0 && (
            <Text size="xs" c="dimmed">
              {t('steps.hiddenInputs', { count: s.hiddenInputs })}
            </Text>
          )}
          <ElementPicker
            label={t('steps.outputs')}
            description={t('steps.outputsHint')}
            value={outputs}
            onChange={setOutputs}
            max={L.stepEnds}
            error={v.error('outputs')}
            testId="step-outputs"
          />
          <Paper withBorder p="sm">
            <Stack gap="xs">
              <SimpleGrid cols={{ base: 1, sm: 2 }}>
                <Select
                  label={t('steps.runner')}
                  description={s?.runnerHidden && !runnerKind ? t('steps.runnerHidden') : t('steps.runnerHint')}
                  data={DATA_RUNNER_KINDS.map((k) => ({ value: k, label: t(`steps.runnerKinds.${k}`) }))}
                  value={runnerKind}
                  onChange={(k) => {
                    setRunnerKind(k as DataRunnerKind | null);
                    setRunnerId(null);
                  }}
                  clearable
                  placeholder={t('steps.noRunner')}
                />
                {(runnerKind === 'application' || runnerKind === 'platform' || runnerKind === 'process') && (
                  <Select
                    label={t(`steps.runnerKinds.${runnerKind}`)}
                    data={runnerOptions}
                    value={runnerId}
                    onChange={setRunnerId}
                    searchable
                    error={v.error('runner')}
                  />
                )}
                {runnerKind === 'connector' && (
                  <Select
                    label={t('steps.connectorPlatform')}
                    data={(platforms.data ?? [])
                      .filter((p) => ['kafka-connect', 'confluent-cloud', 'kafka'].includes(p.kind))
                      .map((p) => ({ value: p.id, label: p.name }))}
                    value={connectorPlatform}
                    onChange={setConnectorPlatform}
                    searchable
                    error={v.error('runner')}
                  />
                )}
                {runnerKind === 'tool' && (
                  <Autocomplete
                    label={t('steps.tool')}
                    data={[...DATA_RUNNER_TOOLS]}
                    // the stored value is the tool's English name; a few are said in the person's language
                    renderOption={({ option }) => {
                      const key = DATA_RUNNER_TOOL_LABEL_KEYS[option.value as keyof typeof DATA_RUNNER_TOOL_LABEL_KEYS];
                      return key ? t(`steps.runnerTools.${key as 'nodeRed'}`) : option.value;
                    }}
                    value={tool}
                    onChange={setTool}
                    maxLength={L.short}
                  />
                )}
              </SimpleGrid>
              {runnerKind === 'element' && (
                <ElementPicker
                  label={t('steps.runnerElement')}
                  description={t('steps.runnerElementHint')}
                  value={runnerElement}
                  onChange={(e) => setRunnerElement(e.slice(-1))}
                  max={1}
                  error={v.error('runner')}
                />
              )}
              {runnerKind === 'connector' && (
                <TextInput
                  label={t('steps.connectorName')}
                  maxLength={L.short}
                  value={connectorName}
                  onChange={(e) => setConnectorName(e.currentTarget.value)}
                />
              )}
              {runnerKind === 'tool' && (
                <TextInput label={t('steps.toolText')} maxLength={L.text} value={toolText} onChange={(e) => setToolText(e.currentTarget.value)} />
              )}
              {runsOnShown && (
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select
                    label={t('steps.runsOn')}
                    description={s?.runsOnHidden && !runsOn ? t('steps.runsOnHidden') : t('steps.runsOnHint')}
                    data={(systems.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
                    value={runsOn}
                    onChange={setRunsOn}
                    searchable
                    clearable
                    data-testid="step-runs-on"
                  />
                  <Autocomplete
                    label={t('steps.runsOnEnvironment')}
                    data={envList.map((x) => x.name)}
                    value={runsOnEnv}
                    onChange={setRunsOnEnv}
                    maxLength={L.short}
                    disabled={!runsOn}
                  />
                </SimpleGrid>
              )}
              {runnerKind && (
                <TechnologyInput
                  label={t('generic.runnerTechnology')}
                  description={kind === 'bridge' ? t('generic.runnerTechnologyBridgeHint') : t('generic.runnerTechnologyHint')}
                  value={technology}
                  onChange={setTechnology}
                  role="bridge"
                  testId="step-technology"
                />
              )}
            </Stack>
          </Paper>
          <TextInput
            label={t('steps.schedule')}
            description={t('steps.scheduleHint')}
            maxLength={L.short}
            value={schedule}
            onChange={(e) => setSchedule(e.currentTarget.value)}
          />
          <Textarea
            label={t('form.description')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={L.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Stack gap={6}>
            <Text size="sm" fw={500}>
              {t('steps.notes')}
            </Text>
            {notes.map((n, i) => (
              <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
                <Select
                  size="xs"
                  aria-label={t('steps.noteKind')}
                  data={DATA_TRANSFORM_KINDS.map((k) => ({ value: k, label: t(`steps.transformKinds.${k}`) }))}
                  value={n.kind}
                  onChange={(k) => k && setNotes(notes.map((x, j) => (j === i ? { ...x, kind: k as DataTransformKind } : x)))}
                  allowDeselect={false}
                  w={140}
                />
                <TextInput
                  size="xs"
                  aria-label={t('steps.noteText')}
                  value={n.text}
                  maxLength={L.text}
                  onChange={(e) => {
                    const text = e.currentTarget.value;
                    setNotes(notes.map((x, j) => (j === i ? { ...x, text } : x)));
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <Tooltip label={t('steps.noteRemove')}>
                  <ActionIcon variant="subtle" color="red" aria-label={t('steps.noteRemove')} onClick={() => setNotes(notes.filter((_, j) => j !== i))} mt={2}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ))}
            {notes.length < L.transformNotes && (
              <Group>
                <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setNotes([...notes, { kind: 'rename', text: '' }])}>
                  {t('steps.noteAdd')}
                </Button>
              </Group>
            )}
          </Stack>
          <FormButtons busy={busy} testId="step-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

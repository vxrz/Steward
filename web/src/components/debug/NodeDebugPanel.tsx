import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Collapse,
  Group,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconBug, IconPlayerPlay } from '@tabler/icons-react';
import {
  debugAnswerRefusal,
  defaultDebugAnswers,
  type DebugAnswers,
  type DebugNodeRequest,
  type DebugNodeResult,
  type FlowNode,
  type ProcessDetail,
  type RunSummary,
} from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { JsonView, StatusBadge, statusLabel } from '../common';
import { fmtDuration, fmtRelative } from '../../format';
import { BindingsForm, loadBindings } from '../RunDialog';
import { runKeys } from '../../queryKeys';

type VarsFrom = 'run' | 'sample' | 'inputs';

/** Parses a JSON object typed by the person; null with the error when it is not one. */
function parseObject(text: string): { value: Record<string, unknown> | null; error: boolean } {
  if (!text.trim()) return { value: {}, error: false };
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? { value: v as Record<string, unknown>, error: false } : { value: null, error: true };
  } catch {
    return { value: null, error: true };
  }
}

const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/**
 * "Run this node" (ADR 0010): one node with variables from an earlier run, sample data or run inputs; offline,
 * with recorded answers or as a live read. The editor's unsaved node runs as it is (the run's definition hash covers it).
 */
export function NodeDebugPanel({ process, node, saved, canRun }: { process: ProcessDetail; node: FlowNode; saved?: FlowNode; canRun: boolean }) {
  const { t } = useTranslation('debug');
  const [varsFrom, setVarsFrom] = useState<VarsFrom>('sample');
  const [runId, setRunId] = useState<string | null>(null);
  const [sample, setSample] = useState('{\n  \n}');
  const [inputs, setInputs] = useState('{}');
  const [answers, setAnswers] = useState<DebugAnswers>(() => defaultDebugAnswers(node));
  const [bindings, setBindings] = useState<Record<string, string>>(() => loadBindings(process.id));
  const [paste, setPaste] = useState(false);
  const [pasteStatus, setPasteStatus] = useState<number | string>(200);
  const [pasteBody, setPasteBody] = useState('{}');
  const [approved, setApproved] = useState('approve');
  const [selected, setSelected] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DebugNodeResult | null>(null);

  // a different node: start over with its own defaults
  useEffect(() => {
    setAnswers(defaultDebugAnswers(node));
    setResult(null);
    setPaste(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id]);

  const runs = useQuery({
    queryKey: [...runKeys.latest(process.id), 'debug-source'],
    queryFn: () => get<RunSummary[]>(`/runs?processId=${encodeURIComponent(process.id)}&limit=20`),
    enabled: varsFrom === 'run',
  });
  const draft = !!saved && JSON.stringify(saved) !== JSON.stringify(node);
  const isNew = !saved;
  const slots = useMemo(() => {
    const c = (node as { connection?: string }).connection;
    return [...new Set([c, ...(node.type === 'subprocess' ? Object.values(node.connections ?? {}) : [])].filter((x): x is string => !!x))];
  }, [node]);
  const slotProcess = useMemo(
    () => ({ ...process, definition: { ...process.definition, connections: process.definition.connections.filter((c) => slots.includes(c.slot)) } }),
    [process, slots],
  );
  const reasonOf = (a: DebugAnswers): string | null => {
    if (a !== 'offline' && !canRun) return t('node.reason.needsRun');
    const r = debugAnswerRefusal(node, a, paste);
    return r ? t(`node.reason.${r}`) : null;
  };
  const reason = reasonOf(answers);
  const sampleParsed = parseObject(sample);
  const inputsParsed = parseObject(inputs);
  const bodyParsed = useMemo(() => {
    try {
      return { value: pasteBody.trim() ? (JSON.parse(pasteBody) as unknown) : null, error: false };
    } catch {
      return { value: null, error: true };
    }
  }, [pasteBody]);

  const run = async () => {
    const vars: DebugNodeRequest['vars'] =
      varsFrom === 'run'
        ? { from: 'run', runId: runId! }
        : varsFrom === 'sample'
          ? { from: 'sample', vars: sampleParsed.value!, inputs: inputsParsed.value! }
          : { from: 'inputs', inputs: inputsParsed.value! };
    const body: DebugNodeRequest = {
      nodeId: node.id,
      ...(draft ? { node } : {}),
      vars,
      answers,
      ...(answers !== 'offline' ? { bindings: Object.fromEntries(slots.map((s) => [s, bindings[s] ?? ''])) } : {}),
      ...(paste ? { answer: { status: Number(pasteStatus) || 200, body: bodyParsed.value } } : {}),
      ...(node.type === 'userTask'
        ? node.mode === 'manual'
          ? { manual: { checked: (node.checklist ?? []).map((_, i) => i), comment } }
          : {
              decision: {
                approved: approved === 'approve',
                selectedKeys: selected
                  .split(',')
                  .map((x) => x.trim())
                  .filter(Boolean),
                comment,
              },
            }
        : {}),
    };
    setBusy(true);
    try {
      setResult(await post<DebugNodeResult>(`/processes/${process.id}/debug/node`, body));
    } catch (e) {
      notifyError(e, t('node.failed'));
    } finally {
      setBusy(false);
    }
  };

  const invalid =
    !!reason ||
    isNew ||
    (varsFrom === 'run' && !runId) ||
    (varsFrom === 'sample' && sampleParsed.error) ||
    (varsFrom !== 'run' && inputsParsed.error) ||
    (paste && bodyParsed.error) ||
    (answers !== 'offline' && slots.some((s) => !bindings[s]));

  return (
    <Stack gap="sm" data-testid="node-debug">
      <Text size="xs" c="dimmed">
        {t('node.intro')}
      </Text>
      {isNew && (
        <Alert color="gray" variant="light" p="xs">
          <Text size="xs">{t('node.newNode')}</Text>
        </Alert>
      )}
      {draft && (
        <Badge color="orange" variant="light" size="sm" style={{ alignSelf: 'flex-start' }}>
          {t('node.unsaved')}
        </Badge>
      )}

      <Stack gap={4}>
        <Text size="xs" fw={600} id="debug-vars-label">
          {t('node.vars')}
        </Text>
        <SegmentedControl
          size="xs"
          fullWidth
          aria-labelledby="debug-vars-label"
          value={varsFrom}
          onChange={(v) => setVarsFrom(v as VarsFrom)}
          data={[
            { value: 'run', label: t('node.from.run') },
            { value: 'sample', label: t('node.from.sample') },
            { value: 'inputs', label: t('node.from.inputs') },
          ]}
        />
        {varsFrom === 'run' && (
          <Select
            size="xs"
            label={t('node.pickRun')}
            placeholder={runs.data?.length === 0 ? t('node.noRuns') : t('node.pickRunPlaceholder')}
            data={(runs.data ?? []).map((r) => ({ value: r.id, label: `${fmtRelative(r.startedAt)} · ${statusLabel(r.status)} · ${r.id}` }))}
            value={runId}
            onChange={setRunId}
            searchable
          />
        )}
        {varsFrom === 'sample' && (
          <Textarea
            size="xs"
            label={t('node.sampleVars')}
            description={t('node.sampleHint')}
            autosize
            minRows={3}
            maxRows={12}
            value={sample}
            onChange={(e) => setSample(e.currentTarget.value)}
            error={sampleParsed.error ? t('node.notJson') : undefined}
            classNames={{ input: 'mono' }}
            spellCheck={false}
          />
        )}
        {varsFrom !== 'run' && (
          <Textarea
            size="xs"
            label={t('node.inputs')}
            autosize
            minRows={1}
            maxRows={8}
            value={inputs}
            onChange={(e) => setInputs(e.currentTarget.value)}
            error={inputsParsed.error ? t('node.notJson') : undefined}
            classNames={{ input: 'mono' }}
            spellCheck={false}
          />
        )}
      </Stack>

      <Stack gap={4}>
        <Text size="xs" fw={600} id="debug-answers-label">
          {t('node.answers')}
        </Text>
        <SegmentedControl
          size="xs"
          fullWidth
          aria-labelledby="debug-answers-label"
          value={answers}
          onChange={(v) => setAnswers(v as DebugAnswers)}
          data={(['offline', 'recorded', 'live'] as const).map((a) => ({ value: a, label: t(`node.answer.${a}`), disabled: !!reasonOf(a) && a !== answers }))}
        />
        <Text size="xs" c={reason ? 'orange.8' : 'dimmed'} data-testid="debug-answers-reason">
          {reason ?? t(`node.answerHint.${answers}`)}
        </Text>
      </Stack>

      {answers !== 'offline' && slots.length > 0 && <BindingsForm process={slotProcess} value={bindings} onChange={setBindings} />}

      {node.type === 'http' && (
        <Stack gap={4}>
          <Switch size="xs" label={t('node.paste')} checked={paste} onChange={(e) => setPaste(e.currentTarget.checked)} />
          <Collapse expanded={paste}>
            <Stack gap={4}>
              <NumberInput size="xs" label={t('node.pasteStatus')} min={100} max={599} value={pasteStatus} onChange={setPasteStatus} w={140} />
              <Textarea
                size="xs"
                label={t('node.pasteBody')}
                description={t('node.pasteHint')}
                autosize
                minRows={2}
                maxRows={10}
                value={pasteBody}
                onChange={(e) => setPasteBody(e.currentTarget.value)}
                error={bodyParsed.error ? t('node.notJson') : undefined}
                classNames={{ input: 'mono' }}
                spellCheck={false}
              />
            </Stack>
          </Collapse>
        </Stack>
      )}

      {node.type === 'userTask' && (
        <Stack gap={4}>
          <Text size="xs" fw={600}>
            {t('node.simulated')}
          </Text>
          {node.mode === 'approve' && (
            <SegmentedControl
              size="xs"
              aria-label={t('node.simulated')}
              value={approved}
              onChange={setApproved}
              data={[
                { value: 'approve', label: t('decision.approve') },
                { value: 'reject', label: t('decision.reject') },
              ]}
            />
          )}
          {node.mode === 'select' && (
            <TextInput size="xs" label={t('node.selectedKeys')} value={selected} onChange={(e) => setSelected(e.currentTarget.value)} />
          )}
          <TextInput size="xs" label={t('decision.comment')} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
          <Text size="xs" c="dimmed">
            {t('node.simulatedHint')}
          </Text>
        </Stack>
      )}

      <Button size="xs" leftSection={<IconPlayerPlay size={14} />} onClick={run} loading={busy} disabled={invalid} data-testid="debug-run-node">
        {t('node.run')}
      </Button>

      {result && <NodeResult result={result} />}
    </Stack>
  );
}

function NodeResult({ result }: { result: DebugNodeResult }) {
  const { t } = useTranslation('debug');
  const s = result.step;
  const simulated = !!(s?.output as { simulated?: boolean } | undefined)?.simulated;
  return (
    <Paper withBorder p="xs" data-testid="debug-node-result">
      <Group gap={6} wrap="wrap">
        <StatusBadge status={s?.status ?? result.status} size="xs" />
        <Badge size="xs" variant="light" color="grape" leftSection={<IconBug size={10} />}>
          {t(`node.answer.${result.answers}`)}
        </Badge>
        {simulated && (
          <Badge size="xs" variant="light" color="violet">
            {t('simulated')}
          </Badge>
        )}
        {s?.durationMs !== undefined && (
          <Text size="xs" c="dimmed">
            {fmtDuration(s.durationMs)}
          </Text>
        )}
        <Anchor component={Link} to={`/runs/${result.runId}`} size="xs" ml="auto">
          {t('node.openRun')}
        </Anchor>
      </Group>
      <Stack gap={6} mt={6}>
        {s?.summary && (
          <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
            {s.summary}
          </Text>
        )}
        {(s?.error || (result.status === 'failed' && result.error)) && (
          <Alert color="red" p={6}>
            <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
              {s?.error ?? result.error}
            </Text>
          </Alert>
        )}
        {result.masked.length > 0 && (
          <Text size="xs" c="orange.8">
            {t('node.masked', { names: result.masked.join(', ') })}
          </Text>
        )}
        {present(result.written) && (
          <>
            <Text size="xs" fw={600}>
              {t('node.written')}
            </Text>
            <JsonView value={result.written} maxHeight={220} />
          </>
        )}
        {present(s?.input) && (
          <>
            <Text size="xs" fw={600}>
              {t('node.request')}
            </Text>
            <JsonView value={s!.input} maxHeight={200} />
          </>
        )}
        {present(s?.output) && !present(result.written) && (
          <>
            <Text size="xs" fw={600}>
              {t('node.output')}
            </Text>
            <JsonView value={s!.output} maxHeight={220} />
          </>
        )}
      </Stack>
    </Paper>
  );
}

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Divider,
  Drawer,
  Group,
  MultiSelect,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconBug, IconPlayerPlay, IconPlayerSkipForward, IconPlayerStop, IconPlayerTrackNext, IconStepInto } from '@tabler/icons-react';
import type { DebugPause, DebugRunRequest, DebugRunState, DebugSignal, ProcessDetail } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { JsonView, StatusBadge } from '../common';
import { BindingsForm, bindingsKey, loadBindings } from '../RunDialog';
import { InputsForm, defaultInputs } from '../InputsForm';
import { runKeys } from '../../queryKeys';

const FINISHED = ['succeeded', 'failed', 'cancelled'];

/** The time left of a pause, ticking every second. */
function useRemaining(until: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [until]);
  if (!until) return '';
  const s = Math.max(0, Math.floor((Date.parse(until) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The debug run's state, polled while it runs (as the run page polls). */
export function useDebugRun(runId: string | null) {
  return useQuery({
    queryKey: runKeys.debug(runId),
    queryFn: () => get<DebugRunState>(`/runs/${runId}/debug`),
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data && FINISHED.includes(q.state.data.status) ? false : 1000),
  });
}

/**
 * Step through a run (ADR 0010): a debug run that pauses before the chosen nodes. Continue, Step, Skip this node and
 * Stop; a decision or manual step is answered here, simulated. Desktop: a panel at the side; phone: a bottom sheet.
 */
export function DebugRunPanel({
  process,
  opened,
  onClose,
  runId,
  onRunId,
}: {
  process: ProcessDetail;
  opened: boolean;
  onClose: () => void;
  runId: string | null;
  onRunId: (id: string | null) => void;
}) {
  const { t } = useTranslation('debug');
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const qc = useQueryClient();
  const state = useDebugRun(runId);
  const [busy, setBusy] = useState(false);
  const send = async (s: DebugSignal) => {
    if (!runId) return;
    setBusy(true);
    try {
      qc.setQueryData(runKeys.debug(runId), await post<DebugRunState>(`/runs/${runId}/debug`, s));
    } catch (e) {
      notifyError(e, t('panel.signalFailed'));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: runKeys.debug(runId) });
    }
  };
  const d = state.data;
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position={phone ? 'bottom' : 'right'}
      size={phone ? '85%' : 'md'}
      title={
        <Group gap={6}>
          <IconBug size={18} />
          <Text fw={600}>{t('panel.title')}</Text>
        </Group>
      }
      // on a desktop the panel sits beside the canvas: the flow stays usable while it is open
      lockScroll={phone}
      withOverlay={phone}
      trapFocus={phone}
      closeOnClickOutside={phone}
      closeButtonProps={{ 'aria-label': t('panel.close') }}
      data-testid="debug-panel"
    >
      {!runId || !d ? (
        <StartForm process={process} onStarted={(s) => (qc.setQueryData(runKeys.debug(s.runId), s), onRunId(s.runId))} />
      ) : (
        <RunView process={process} state={d} busy={busy} send={send} onNew={() => onRunId(null)} />
      )}
    </Drawer>
  );
}

function StartForm({ process, onStarted }: { process: ProcessDetail; onStarted: (s: DebugRunState) => void }) {
  const { t } = useTranslation(['debug', 'common']);
  const [inputs, setInputs] = useState<Record<string, unknown>>(() => defaultInputs(process.definition.inputs));
  const [bindings, setBindings] = useState<Record<string, string>>(() => loadBindings(process.id));
  const [mode, setMode] = useState<'test' | 'dry'>('test');
  const [each, setEach] = useState(true);
  const [breakpoints, setBreakpoints] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const nodes = useMemo(() => nodeOptions(process), [process]);
  const missing = process.definition.connections.some((c) => !bindings[c.slot]);
  const start = async () => {
    setBusy(true);
    try {
      localStorage.setItem(bindingsKey(process.id), JSON.stringify(bindings));
      const body: DebugRunRequest = { inputs, bindings, mode, pauseBeforeEach: each, breakpoints };
      onStarted(await post<DebugRunState>(`/processes/${process.id}/debug/runs`, body));
    } catch (e) {
      notifyError(e, t('panel.notStarted'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t('panel.intro', { version: process.currentVersion })}
      </Text>
      <BindingsForm process={process} value={bindings} onChange={setBindings} />
      {process.definition.inputs.length > 0 && <Divider label={t('panel.inputs')} labelPosition="left" />}
      <InputsForm defs={process.definition.inputs} value={inputs} onChange={setInputs} />
      <Divider />
      <Stack gap={4}>
        <Text size="sm" fw={500} id="debug-mode-label">
          {t('panel.mode')}
        </Text>
        <SegmentedControl
          aria-labelledby="debug-mode-label"
          value={mode}
          onChange={(v) => setMode(v as 'test' | 'dry')}
          data={[
            { value: 'test', label: t('panel.modes.test') },
            { value: 'dry', label: t('panel.modes.dry') },
          ]}
        />
        <Text size="xs" c="dimmed">
          {t(`panel.modeHint.${mode}`)}
        </Text>
      </Stack>
      <Switch label={t('panel.pauseBeforeEach')} checked={each} onChange={(e) => setEach(e.currentTarget.checked)} />
      <MultiSelect
        label={t('panel.breakpoints')}
        description={t('panel.breakpointsHint')}
        data={nodes}
        value={breakpoints}
        onChange={setBreakpoints}
        searchable
        clearable
      />
      <Button leftSection={<IconPlayerPlay size={16} />} onClick={start} loading={busy} disabled={missing} data-testid="debug-start">
        {t('panel.start')}
      </Button>
    </Stack>
  );
}

const nodeOptions = (process: ProcessDetail) =>
  process.definition.nodes.filter((n) => n.type !== 'start' && n.type !== 'note').map((n) => ({ value: n.id, label: n.name ? `${n.name} (${n.id})` : n.id }));

function RunView({
  process,
  state: d,
  busy,
  send,
  onNew,
}: {
  process: ProcessDetail;
  state: DebugRunState;
  busy: boolean;
  send: (s: DebugSignal) => Promise<void>;
  onNew: () => void;
}) {
  const { t } = useTranslation('debug');
  const p = d.paused;
  const done = FINISHED.includes(d.status);
  const remaining = useRemaining(p?.expiresAt);
  const nodes = useMemo(() => nodeOptions(process), [process]);
  const can = d.canSignal && !busy;
  return (
    <Stack gap="sm" data-testid="debug-run-view">
      <Group gap={6} wrap="wrap">
        <StatusBadge status={d.status} />
        <Badge variant="light" color={d.mode === 'test' ? 'yellow' : 'orange'}>
          {t(`panel.modes.${d.mode === 'test' ? 'test' : 'dry'}`)}
        </Badge>
        <Anchor component={Link} to={`/runs/${d.runId}`} size="sm" ml="auto">
          {t('panel.openRun')}
        </Anchor>
      </Group>
      {d.debug?.recordedFrom && (
        <Alert color="violet" variant="light" p="xs" data-testid="debug-recorded-from">
          <Text size="xs">{t('panel.recordedFrom', { key: d.debug.recordedFrom })}</Text>
        </Alert>
      )}
      {!d.canSignal && !done && (
        <Text size="xs" c="dimmed">
          {t('panel.notYours')}
        </Text>
      )}

      {p && <Pause key={`${p.stepKey}:${p.reason}`} pause={p} remaining={remaining} can={can} send={send} />}
      {!p && !done && (
        <Text size="sm" c="dimmed">
          {t('panel.running')}
        </Text>
      )}
      {done && (
        <Alert
          color={d.status === 'succeeded' ? 'green' : d.status === 'failed' ? 'red' : 'gray'}
          p="xs"
          title={t(`panel.finished.${d.status as 'succeeded' | 'failed' | 'cancelled'}`)}
        >
          {d.error && d.status === 'failed' && (
            <Text size="xs" style={{ overflowWrap: 'anywhere' }}>
              {d.error}
            </Text>
          )}
          <Button size="xs" variant="default" mt="xs" onClick={onNew} data-testid="debug-new">
            {t('panel.again')}
          </Button>
        </Alert>
      )}

      {!done && d.canSignal && (
        <MultiSelect
          size="xs"
          label={t('panel.breakpoints')}
          data={nodes}
          value={d.debug?.breakpoints ?? []}
          onChange={(v) => void send({ type: 'debug.breakpoints', breakpoints: v })}
          searchable
          clearable
          disabled={busy}
        />
      )}

      <Divider label={t('panel.steps')} labelPosition="left" />
      <Stack gap={2}>
        {d.steps.length === 0 && (
          <Text size="xs" c="dimmed">
            {t('panel.noSteps')}
          </Text>
        )}
        {d.steps.slice(-12).map((s) => (
          <Group key={s.id} gap={6} wrap="nowrap">
            <StatusBadge status={s.status} size="xs" />
            {!!(s.output as { simulated?: boolean } | undefined)?.simulated && (
              <Badge size="xs" color="violet" variant="light">
                {t('simulated')}
              </Badge>
            )}
            <Text size="xs" fw={500} truncate style={{ minWidth: 0 }}>
              {s.name}
            </Text>
            <Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 0 }}>
              {s.error ?? s.summary}
            </Text>
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}

function Pause({ pause: p, remaining, can, send }: { pause: DebugPause; remaining: string; can: boolean; send: (s: DebugSignal) => Promise<void> }) {
  const { t } = useTranslation('debug');
  const [approved, setApproved] = useState('approve');
  const [keys, setKeys] = useState<string[]>(() => (p.task?.items ?? []).filter((i) => i.preselected).map((i) => i.key));
  const [checked, setChecked] = useState<number[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [comment, setComment] = useState('');
  const decision = p.reason === 'decision' && p.task;
  return (
    <Paper withBorder p="sm" data-testid="debug-pause">
      <Group gap={6} justify="space-between" wrap="nowrap">
        <Text size="sm" fw={600} style={{ minWidth: 0 }} truncate>
          {decision ? t('panel.waitsFor', { name: p.nodeName }) : t('panel.pausedBefore', { name: p.nodeName })}
        </Text>
        <Badge variant="light" color="gray" style={{ flexShrink: 0 }} title={t('panel.remainingHint')}>
          {t('panel.remaining', { time: remaining })}
        </Badge>
      </Group>
      <Text size="xs" c="dimmed" className="mono">
        {p.stepKey} · {p.nodeType}
      </Text>
      {decision ? (
        <Stack gap={6} mt="xs">
          <Text size="sm">{p.task!.title}</Text>
          {p.task!.instructions && (
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
              {p.task!.instructions}
            </Text>
          )}
          {p.task!.mode === 'approve' && (
            <SegmentedControl
              size="xs"
              aria-label={t('panel.decision')}
              value={approved}
              onChange={setApproved}
              data={[
                { value: 'approve', label: t('decision.approve') },
                { value: 'reject', label: t('decision.reject') },
              ]}
            />
          )}
          {p.task!.mode === 'select' && (
            <Checkbox.Group value={keys} onChange={setKeys} label={t('panel.select')}>
              <Stack gap={2} mt={4}>
                {p.task!.items.slice(0, 200).map((i) => (
                  <Checkbox key={i.key} value={i.key} label={i.cells.join(' · ')} size="xs" />
                ))}
              </Stack>
            </Checkbox.Group>
          )}
          {p.task!.mode === 'manual' && (
            <Stack gap={4}>
              {(p.task!.checklist ?? []).map((c, i) => (
                <Checkbox
                  key={i}
                  size="xs"
                  label={c}
                  checked={checked.includes(i)}
                  onChange={(e) => setChecked((x) => (e.currentTarget.checked ? [...x, i] : x.filter((y) => y !== i)))}
                />
              ))}
              {(p.task!.fields ?? []).map((f) => (
                <TextInput
                  key={f.id}
                  size="xs"
                  label={f.label}
                  value={fields[f.id] ?? ''}
                  onChange={(e) => setFields({ ...fields, [f.id]: e.currentTarget.value })}
                />
              ))}
            </Stack>
          )}
          <TextInput size="xs" label={t('decision.comment')} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
          <Text size="xs" c="dimmed">
            {t('panel.simulatedHint')}
          </Text>
          <Group gap="xs" wrap="wrap">
            <Button
              size="xs"
              disabled={!can}
              data-testid="debug-answer"
              onClick={() =>
                void send(
                  p.task!.mode === 'manual'
                    ? { type: 'debug.answer', manual: { checked, fields, comment } }
                    : { type: 'debug.answer', decision: { approved: p.task!.mode === 'select' || approved === 'approve', selectedKeys: keys, comment } },
                )
              }
            >
              {t('panel.answer')}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlayerSkipForward size={14} />}
              disabled={!can}
              onClick={() => void send({ type: 'debug.skip' })}
            >
              {t('panel.skip')}
            </Button>
            <Button
              size="xs"
              variant="light"
              color="red"
              leftSection={<IconPlayerStop size={14} />}
              disabled={!can}
              onClick={() => void send({ type: 'debug.stop' })}
            >
              {t('panel.stop')}
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap={6} mt="xs">
          {p.preview !== undefined && p.preview !== null && (
            <>
              <Text size="xs" fw={600}>
                {t('panel.preview')}
              </Text>
              <JsonView value={p.preview} maxHeight={200} />
              <Text size="xs" c="dimmed">
                {t('panel.previewHint')}
              </Text>
            </>
          )}
          <Text size="xs" fw={600}>
            {t('panel.vars')}
          </Text>
          <JsonView value={p.vars} maxHeight={200} />
          <Group gap="xs" wrap="wrap">
            <Button
              size="xs"
              leftSection={<IconPlayerTrackNext size={14} />}
              disabled={!can}
              onClick={() => void send({ type: 'debug.continue' })}
              data-testid="debug-continue"
            >
              {t('panel.continue')}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconStepInto size={14} />}
              disabled={!can}
              onClick={() => void send({ type: 'debug.step' })}
              data-testid="debug-step"
            >
              {t('panel.step')}
            </Button>
            <Button
              size="xs"
              variant="default"
              leftSection={<IconPlayerSkipForward size={14} />}
              disabled={!can}
              onClick={() => void send({ type: 'debug.skip' })}
              data-testid="debug-skip"
            >
              {t('panel.skip')}
            </Button>
            <Button
              size="xs"
              variant="light"
              color="red"
              leftSection={<IconPlayerStop size={14} />}
              disabled={!can}
              onClick={() => void send({ type: 'debug.stop' })}
              data-testid="debug-stop"
            >
              {t('panel.stop')}
            </Button>
          </Group>
        </Stack>
      )}
    </Paper>
  );
}

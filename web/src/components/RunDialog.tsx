import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Divider, Group, Modal, Select, Stack, Switch, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { IconPlayerPlay } from '@tabler/icons-react';
import type { Platform, ProcessDetail } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { InputsForm, defaultInputs } from './InputsForm';

export function bindingsKey(processId: string) {
  return `sm.bindings.${processId}`;
}

export function loadBindings(processId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(bindingsKey(processId)) ?? '{}');
  } catch {
    return {};
  }
}

/** Select a platform for every connection slot of a process. */
export function BindingsForm({
  process,
  value,
  onChange,
}: {
  process: ProcessDetail;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  if (!process.definition.connections.length) return null;
  return (
    <Stack gap="sm">
      {process.definition.connections.map((c) => {
        const all = platforms.data ?? [];
        const matching = all.filter((p) => !c.kind || p.kind === c.kind);
        const others = all.filter((p) => c.kind && p.kind !== c.kind);
        const item = (p: Platform) => ({
          value: p.id,
          label: p.permissions?.includes('use') ? p.name : `${p.name} (no permission to use)`,
          disabled: !p.permissions?.includes('use'),
        });
        const data = [
          ...(matching.length ? [{ group: c.kind ? `Kind: ${c.kind}` : 'Platforms', items: matching.map(item) }] : []),
          ...(others.length ? [{ group: 'Other platforms', items: others.map(item) }] : []),
        ];
        const anyBlocked = all.some((p) => !p.permissions?.includes('use'));
        return (
          <Select
            key={c.slot}
            label={`Connection "${c.slot}"`}
            description={
              (c.description || (c.kind ? `Expects a ${c.kind} platform` : '')) +
              (anyBlocked ? ' · platforms you may not use are disabled' : '')
            }
            required
            data={data}
            value={value[c.slot] ?? null}
            onChange={(v) => onChange({ ...value, [c.slot]: v ?? '' })}
            placeholder={all.length ? 'Select platform' : 'No platforms yet – add one under Platforms'}
          />
        );
      })}
    </Stack>
  );
}

export function RunDialog({ processId, opened, onClose }: { processId: string | null; opened: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const proc = useQuery({
    queryKey: ['process', processId],
    queryFn: () => get<ProcessDetail>(`/processes/${processId}`),
    enabled: !!processId && opened,
  });
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (proc.data && opened) {
      setInputs(defaultInputs(proc.data.definition.inputs));
      setBindings(loadBindings(proc.data.id));
      setDryRun(true);
    }
  }, [proc.data, opened]);

  const hasWrites = useMemo(() => JSON.stringify(proc.data?.definition.nodes ?? []).match(/"method":"(POST|PUT|PATCH|DELETE)"|"mutating":true/), [proc.data]);

  const start = async () => {
    if (!proc.data) return;
    setBusy(true);
    try {
      localStorage.setItem(bindingsKey(proc.data.id), JSON.stringify(bindings));
      const r = await post<{ id: string }>('/runs', { processId: proc.data.id, inputs, bindings, dryRun });
      onClose();
      navigate(`/runs/${r.id}`);
    } catch (e) {
      notifyError(e, 'Run not started');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={proc.data ? `Run: ${proc.data.name}` : 'Run process'} size="lg">
      {proc.data && (
        <Stack>
          {proc.data.description && (
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-line' }} lineClamp={6}>
              {proc.data.description}
            </Text>
          )}
          <BindingsForm process={proc.data} value={bindings} onChange={setBindings} />
          {proc.data.definition.inputs.length > 0 && <Divider label="Inputs" labelPosition="left" />}
          <InputsForm defs={proc.data.definition.inputs} value={inputs} onChange={setInputs} />
          <Divider />
          <Switch
            checked={dryRun}
            onChange={(e) => setDryRun(e.currentTarget.checked)}
            label="Dry run – simulate all changes"
            description="Read calls are executed, write calls (POST/PUT/PATCH/DELETE) are only recorded. User tasks still ask you."
          />
          {!dryRun && hasWrites && (
            <Alert color="orange" title="This run will change data">
              The process contains write operations that will be executed against the selected platform(s).
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button leftSection={<IconPlayerPlay size={16} />} onClick={start} loading={busy} color={dryRun ? 'blue' : 'orange'}>
              {dryRun ? 'Start dry run' : 'Start run'}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

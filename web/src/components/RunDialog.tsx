import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Divider, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconPlayerPlay } from '@tabler/icons-react';
import type { Platform, ProcessDetail } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { InputsForm, defaultInputs } from './InputsForm';
import { RunModeField, runModeFlags, type RunMode } from './RunModeField';

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
  const { t } = useTranslation('runs');
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
          label: p.permissions?.includes('use') ? p.name : t('bindings.noPermission', { name: p.name }),
          disabled: !p.permissions?.includes('use'),
        });
        const data = [
          ...(matching.length ? [{ group: c.kind ? t('bindings.kind', { kind: c.kind }) : t('bindings.platforms'), items: matching.map(item) }] : []),
          ...(others.length ? [{ group: t('bindings.otherPlatforms'), items: others.map(item) }] : []),
        ];
        const anyBlocked = all.some((p) => !p.permissions?.includes('use'));
        return (
          <Select
            key={c.slot}
            label={t('bindings.connection', { slot: c.slot })}
            description={[c.description || (c.kind ? t('bindings.expects', { kind: c.kind }) : ''), anyBlocked ? t('bindings.blocked') : '']
              .filter(Boolean)
              .join(' · ')}
            required
            data={data}
            value={value[c.slot] ?? null}
            onChange={(v) => onChange({ ...value, [c.slot]: v ?? '' })}
            placeholder={all.length ? t('bindings.select') : t('bindings.none')}
          />
        );
      })}
    </Stack>
  );
}

export function RunDialog({ processId, opened, onClose }: { processId: string | null; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation(['runs', 'common']);
  const navigate = useNavigate();
  const proc = useQuery({
    queryKey: ['process', processId],
    queryFn: () => get<ProcessDetail>(`/processes/${processId}`),
    enabled: !!processId && opened,
  });
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<RunMode>('dry');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (proc.data && opened) {
      setInputs(defaultInputs(proc.data.definition.inputs));
      setBindings(loadBindings(proc.data.id));
      setMode('dry');
    }
  }, [proc.data, opened]);

  const hasWrites = useMemo(() => JSON.stringify(proc.data?.definition.nodes ?? []).match(/"method":"(POST|PUT|PATCH|DELETE)"|"mutating":true/), [proc.data]);

  const start = async () => {
    if (!proc.data) return;
    setBusy(true);
    try {
      localStorage.setItem(bindingsKey(proc.data.id), JSON.stringify(bindings));
      const r = await post<{ id: string }>('/runs', { processId: proc.data.id, inputs, bindings, ...runModeFlags(mode) });
      onClose();
      navigate(`/runs/${r.id}`);
    } catch (e) {
      notifyError(e, t('dialog.notStarted'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title={proc.data ? t('dialog.title', { name: proc.data.name }) : t('dialog.titleFallback')} size="lg">
      {proc.data && (
        <Stack>
          {proc.data.description && (
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-line' }} lineClamp={6}>
              {proc.data.description}
            </Text>
          )}
          <BindingsForm process={proc.data} value={bindings} onChange={setBindings} />
          {proc.data.definition.inputs.length > 0 && <Divider label={t('dialog.inputs')} labelPosition="left" />}
          <InputsForm defs={proc.data.definition.inputs} value={inputs} onChange={setInputs} />
          <Divider />
          <RunModeField value={mode} onChange={setMode} platformIds={Object.values(bindings)} />
          {mode === 'real' && hasWrites && (
            <Alert color="orange" title={t('dialog.writesTitle')}>
              {t('dialog.writesText')}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button leftSection={<IconPlayerPlay size={16} />} onClick={start} loading={busy} color={mode === 'real' ? 'orange' : undefined}>
              {t(mode === 'test' ? 'dialog.startTestRun' : mode === 'dry' ? 'dialog.startDryRun' : 'dialog.startRun')}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

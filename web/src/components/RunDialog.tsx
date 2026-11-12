import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Divider, Group, Select, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconPlayerPlay } from '@tabler/icons-react';
import type { Platform, ProcessDetail } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { InputsForm, defaultInputs } from './InputsForm';
import { RunModeField, runModeFlags, type RunMode } from './RunModeField';
import { platformKeys, processKeys } from '../queryKeys';
import { IdentitySelect } from './platform/IdentitySelect';
import { FormModal, FormModalCancel } from './FormModal';
import { QueryState } from './common';

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

/** The identities last chosen for a process's slots in this browser (0.13.0, ADR 0009). */
export function loadIdentities(processId: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(`sm.identities.${processId}`) ?? '{}');
  } catch {
    return {};
  }
}
export function storeIdentities(processId: string, identities: Record<string, string>): void {
  try {
    localStorage.setItem(`sm.identities.${processId}`, JSON.stringify(identities));
  } catch {
    /* private mode: not remembered */
  }
}

/** The identities of the slots whose platform is still the one they were chosen for (a slot bound elsewhere uses its default). */
export function identitiesFor(platforms: Platform[] | undefined, bindings: Record<string, string>, identities: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(identities).filter(([slot, iid]) => {
      const p = platforms?.find((x) => x.id === bindings[slot]);
      return !!p && !!p.identities?.some((i) => i.id === iid && !i.default);
    }),
  );
}

/** Select a platform for every connection slot of a process – and, where it has several, one of its identities (0.13.0). */
export function BindingsForm({
  process,
  value,
  onChange,
  identities,
  onIdentitiesChange,
}: {
  process: ProcessDetail;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  /** Slot → identity id (none: the default identity); without onIdentitiesChange no identity is offered */
  identities?: Record<string, string>;
  onIdentitiesChange?: (v: Record<string, string>) => void;
}) {
  const { t } = useTranslation('runs');
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
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
        const bound = all.find((p) => p.id === value[c.slot]);
        return (
          <Stack key={c.slot} gap={6}>
            <Select
              label={t('bindings.connection', { slot: c.slot })}
              description={[
                c.description || (c.kind ? t('bindings.expects', { kind: c.kind }) : ''),
                c.identity?.writes ? t('bindings.needsWrites') : '',
                anyBlocked ? t('bindings.blocked') : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              required
              data={data}
              value={value[c.slot] ?? null}
              onChange={(v) => {
                onChange({ ...value, [c.slot]: v ?? '' });
                // another platform: its default identity until one is chosen
                if (identities && onIdentitiesChange && identities[c.slot]) {
                  const { [c.slot]: _dropped, ...rest } = identities;
                  onIdentitiesChange(rest);
                }
              }}
              placeholder={all.length ? t('bindings.select') : t('bindings.none')}
            />
            {onIdentitiesChange && (
              <IdentitySelect
                platform={bound}
                value={identities?.[c.slot]}
                needsWrites={!!c.identity?.writes}
                label={t('bindings.identity', { slot: c.slot })}
                testId={`identity-select-${c.slot}`}
                onChange={(iid) => {
                  const { [c.slot]: _old, ...rest } = identities ?? {};
                  onIdentitiesChange(iid ? { ...rest, [c.slot]: iid } : rest);
                }}
              />
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

export function RunDialog({ processId, opened, onClose }: { processId: string | null; opened: boolean; onClose: () => void }) {
  const { t } = useTranslation(['runs', 'common']);
  const navigate = useNavigate();
  const proc = useQuery({
    queryKey: processKeys.detail(processId),
    queryFn: () => get<ProcessDetail>(`/processes/${processId}`),
    enabled: !!processId && opened,
  });
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [bindings, setBindings] = useState<Record<string, string>>({});
  const [identities, setIdentities] = useState<Record<string, string>>({});
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms'), enabled: opened });
  const [mode, setMode] = useState<RunMode>('dry');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (proc.data && opened) {
      setInputs(defaultInputs(proc.data.definition.inputs));
      setBindings(loadBindings(proc.data.id));
      setIdentities(loadIdentities(proc.data.id));
      setMode('dry');
    }
  }, [proc.data, opened]);

  const hasWrites = useMemo(() => JSON.stringify(proc.data?.definition.nodes ?? []).match(/"method":"(POST|PUT|PATCH|DELETE)"|"mutating":true/), [proc.data]);

  const start = async () => {
    if (!proc.data) return;
    setBusy(true);
    try {
      localStorage.setItem(bindingsKey(proc.data.id), JSON.stringify(bindings));
      const chosen = identitiesFor(platforms.data, bindings, identities);
      storeIdentities(proc.data.id, chosen);
      const r = await post<{ id: string }>('/runs', {
        processId: proc.data.id,
        inputs,
        bindings,
        ...(Object.keys(chosen).length ? { identities: chosen } : {}),
        ...runModeFlags(mode),
      });
      onClose();
      navigate(`/runs/${r.id}`);
    } catch (e) {
      notifyError(e, t('dialog.notStarted'));
    } finally {
      setBusy(false);
    }
  };

  // FormModal is mounted while open: it asks before Esc or Cancel discard what was entered
  if (!opened) return null;
  return (
    <FormModal onClose={onClose} title={proc.data ? t('dialog.title', { name: proc.data.name }) : t('dialog.titleFallback')} size="lg">
      {/* while the process loads, or when it cannot be read: say so instead of an empty dialog */}
      {!proc.data && <QueryState query={proc} rows={3} />}
      {proc.data && (
        <Stack>
          {proc.data.description && (
            <Text size="sm" c="dimmed" style={{ whiteSpace: 'pre-line' }} lineClamp={6}>
              {proc.data.description}
            </Text>
          )}
          <BindingsForm process={proc.data} value={bindings} onChange={setBindings} identities={identities} onIdentitiesChange={setIdentities} />
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
            <FormModalCancel />
            <Button leftSection={<IconPlayerPlay size={16} />} onClick={start} loading={busy} color={mode === 'real' ? 'orange' : undefined}>
              {t(mode === 'test' ? 'dialog.startTestRun' : mode === 'dry' ? 'dialog.startDryRun' : 'dialog.startRun')}
            </Button>
          </Group>
        </Stack>
      )}
    </FormModal>
  );
}

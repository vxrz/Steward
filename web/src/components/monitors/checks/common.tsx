import { useState } from 'react';
import { Group, NumberInput, SegmentedControl, Select, Text, Textarea } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { get } from '../../../api';
import { type CheckDef, type CheckOf, type CheckType, type MonitorSummary, type Platform, type SystemSummary } from '@sm/shared';

/** Shared parts of the check forms (one component per check type, CHECK_FIELDS in index.ts). */

export type Patch = (p: Partial<CheckDef>) => void;
/** The message to show on a field, if any (#141) */
export type FieldError = (field: string) => string | undefined;

/** What the form of a check type gets from the monitor editor's inspector. */
export interface CheckFieldsProps<T extends CheckType = CheckType> {
  c: CheckOf<T>;
  set: Patch;
  platforms: Platform[];
  monitors: MonitorSummary[];
  monitorKey: string;
  disabled?: boolean;
  err: FieldError;
  /** Heartbeat checks of a saved monitor: the last report received, to write the condition against (v0.3.1) */
  lastReport?: { at: string | null; report: unknown } | null;
}

export const num = (v: string | number) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function PlatformSelect({
  value,
  onChange,
  platforms,
  kinds,
  label,
  disabled,
  error,
}: {
  value: string;
  onChange: (v: string) => void;
  platforms: Platform[];
  /** The platform kinds that fit (checkPlatformKinds); empty or missing: any */
  kinds?: readonly string[];
  label?: string;
  disabled?: boolean;
  error?: string;
}) {
  const { t } = useTranslation('monitors');
  const list = platforms.filter((p) => !kinds?.length || kinds.includes(p.kind));
  return (
    <Select
      label={label ?? t('form.platform')}
      required
      error={error}
      data-field="platform"
      searchable
      disabled={disabled}
      data={list.map((p) => ({ value: p.id, label: `${p.name}${p.environment ? ` (${p.environment})` : ''}` }))}
      value={list.some((p) => p.id === value) ? value : null}
      placeholder={value && !list.some((p) => p.id === value) ? value : t('form.choosePlatform')}
      onChange={(v) => onChange(v ?? '')}
      nothingFoundMessage={kinds?.length ? t('form.noPlatformOfKind', { kind: kinds.join('|') }) : t('form.noPlatform')}
    />
  );
}

/** A system of the service catalogue (the schema check of a system with tbls imports, #222). */
export function SystemSelect({ value, onChange, disabled, error }: { value: string; onChange: (v: string) => void; disabled?: boolean; error?: string }) {
  const { t } = useTranslation('monitors');
  const systems = useQuery({ queryKey: ['systems'], queryFn: () => get<SystemSummary[]>('/systems') });
  const list = systems.data ?? [];
  return (
    <Select
      label={t('form.dbSchemaSystem')}
      description={t('form.dbSchemaSystemHint')}
      required
      error={error}
      data-field="system"
      searchable
      disabled={disabled}
      data={list.map((s) => ({ value: s.id, label: s.name }))}
      value={list.some((s) => s.id === value) ? value : null}
      placeholder={value && !list.some((s) => s.id === value) ? value : t('form.dbSchemaChooseSystem')}
      onChange={(v) => onChange(v ?? '')}
      nothingFoundMessage={t('form.dbSchemaNoSystem')}
    />
  );
}

export function FreshnessFields({
  c,
  set,
  disabled,
  what,
  err,
}: {
  c: CheckOf<'freshness'> | CheckOf<'heartbeat'> | CheckOf<'dynamodb'>;
  set: Patch;
  disabled?: boolean;
  what: 'data' | 'reports';
  err: FieldError;
}) {
  const { t } = useTranslation('monitors');
  // the DynamoDB check has a mode of its own: cadence or maximum age is its freshnessMode
  const mode = c.type === 'dynamodb' ? c.freshnessMode : c.mode;
  const setMode = (m: 'cadence' | 'maxAge') => set(c.type === 'dynamodb' ? { freshnessMode: m } : { mode: m });
  return (
    <>
      <div>
        <Text size="sm" fw={500} mb={4}>
          {t(what === 'data' ? 'form.expectedData' : 'form.expectedReports')}
        </Text>
        <SegmentedControl
          size="xs"
          disabled={disabled}
          value={mode}
          onChange={(v) => setMode(v as 'cadence' | 'maxAge')}
          data={[
            { value: 'cadence', label: t('form.cadence') },
            { value: 'maxAge', label: t('form.maxAge') },
          ]}
        />
      </div>
      {mode === 'cadence' ? (
        <Group grow align="flex-start">
          <NumberInput
            error={err('expectedIntervalSeconds')}
            data-field="expectedIntervalSeconds"
            label={t('form.expectedEvery')}
            required
            min={1}
            disabled={disabled}
            value={c.expectedIntervalSeconds ?? ''}
            onChange={(v) => set({ expectedIntervalSeconds: num(v) })}
          />
          <NumberInput
            error={err('degradedAfterMissed')}
            data-field="degradedAfterMissed"
            label={t('form.degradedAfterMissed')}
            description={t('form.intervalsDefault', { n: 2 })}
            min={1}
            disabled={disabled}
            value={c.degradedAfterMissed ?? ''}
            onChange={(v) => set({ degradedAfterMissed: num(v) })}
          />
          <NumberInput
            error={err('downAfterMissed')}
            data-field="downAfterMissed"
            label={t('form.downAfterMissed')}
            description={t('form.intervalsDefault', { n: 4 })}
            min={1}
            disabled={disabled}
            value={c.downAfterMissed ?? ''}
            onChange={(v) => set({ downAfterMissed: num(v) })}
          />
        </Group>
      ) : (
        <Group grow align="flex-start">
          <NumberInput
            error={err('maxAgeSeconds')}
            data-field="maxAgeSeconds"
            label={t('form.downOlderThan')}
            required
            min={1}
            disabled={disabled}
            value={c.maxAgeSeconds ?? ''}
            onChange={(v) => set({ maxAgeSeconds: num(v) })}
          />
          <NumberInput
            error={err('degradedAgeSeconds')}
            data-field="degradedAgeSeconds"
            label={t('form.degradedOlderThan')}
            description={t('form.optional')}
            min={1}
            disabled={disabled}
            value={c.degradedAgeSeconds ?? ''}
            onChange={(v) => set({ degradedAgeSeconds: num(v) })}
          />
        </Group>
      )}
    </>
  );
}

/** The body of a request: JSON when it parses, else the text as it is (#233). */
export function BodyInput({ value, onChange, disabled, error }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean; error?: string }) {
  const { t } = useTranslation('monitors');
  const [text, setText] = useState(() => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
  return (
    <Textarea
      error={error}
      data-field="body"
      label={t('form.requestBody')}
      description={t('form.requestBodyHint')}
      autosize
      minRows={2}
      maxRows={12}
      disabled={disabled}
      value={text}
      onChange={(e) => {
        const next = e.currentTarget.value;
        setText(next);
        if (!next.trim()) return onChange(undefined);
        try {
          onChange(JSON.parse(next));
        } catch {
          onChange(next);
        }
      }}
      classNames={{ input: 'mono' }}
      spellCheck={false}
    />
  );
}

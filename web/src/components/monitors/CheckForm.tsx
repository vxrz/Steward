import { IdentitySelect, platformByRef } from '../platform/IdentitySelect';
import { Alert, Divider, Group, NumberInput, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { CheckDef, MonitorSummary, ObservedDelay, Platform } from '@sm/shared';
import { checkTypeHelp, checkTypeLabel } from './status';
import { CheckFields } from './checks';
import { num, type FieldError, type Patch } from './checks/common';

/** Fields this form shows a problem on; the others are listed at the top. */
const FORM_FIELDS = [
  'allowedCidrs',
  'allowedDelaySeconds',
  'application',
  'changedWithinHours',
  'maxCheckAgeHours',
  'tag',
  'watch',
  'aspect',
  'assetId',
  'authMode',
  'body',
  'condition',
  'contract',
  'degradedAfterMissed',
  'degradedAgeSeconds',
  'degradedMs',
  'degradedOnRecentFailures',
  'degradedResponseMs',
  'degradedRttMs',
  'description',
  'downAfterMissed',
  'element',
  'endpointKey',
  'expectStatus',
  'expectedIntervalSeconds',
  'failuresBeforeDown',
  'fallbackPort',
  'headers',
  'host',
  'id',
  'indexName',
  'intervalSeconds',
  'key',
  'maxAgeSeconds',
  'method',
  'monitor',
  'name',
  'partitionKey',
  'partitionValues',
  'path',
  'platform',
  'port',
  'rateLimitPerMinute',
  'region',
  'source',
  'statusExpression',
  'system',
  'successesBeforeUp',
  'table',
  'timeAttribute',
  'timeoutSeconds',
  'timestamp',
  'tlsExpiryWarnDays',
  'url',
  'variables',
  'bucket',
  'database',
  'retentionPolicy',
  'measurement',
  'fields',
  'tags',
  'groupBy',
  'expectedSeries',
  'language',
  'lookbackHours',
] as const;

export interface CheckFormProps {
  check: CheckDef;
  onChange: (c: CheckDef) => void;
  platforms: Platform[];
  monitors: MonitorSummary[];
  monitorKey: string;
  disabled?: boolean;
  isNew?: boolean;
  /** Problems of this card by field ('' = the whole card), shown on the fields (#141) */
  errors?: Map<string, string>;
  /** Heartbeat checks of a saved monitor: the last report received, to write the condition against (v0.3.1) */
  lastReport?: { at: string | null; report: unknown } | null;
  /** Freshness checks of a saved monitor: the observed delay (0.13) */
  observedDelay?: ObservedDelay | null;
}

/** Settings of one check (the monitor editor's inspector). */
export function CheckForm({ check: c, onChange, platforms, monitors, monitorKey, disabled, isNew, errors, lastReport, observedDelay }: CheckFormProps) {
  const set: Patch = (p) => onChange({ ...c, ...p } as CheckDef);
  const { t } = useTranslation('monitors');
  const err: FieldError = (field) => errors?.get(field);
  // problems without a field of their own on this form (the whole card, or a field of another mode)
  const shown = new Set(['', ...FORM_FIELDS]);
  const other = [...(errors ?? new Map<string, string>())].filter(([f]) => f === '' || !shown.has(f));
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {checkTypeLabel(c.type)} – {checkTypeHelp(c.type)}
      </Text>
      {other.length > 0 && (
        <Alert color="red" p="xs" data-testid="check-problems">
          {other.map(([f, m]) => (
            <Text key={f} size="xs">
              {f ? `${f}: ` : ''}
              {m}
            </Text>
          ))}
        </Alert>
      )}
      <TextInput
        error={err('name')}
        data-field="name"
        label={t('form.name')}
        required
        disabled={disabled}
        value={c.name}
        onChange={(e) => set({ name: e.currentTarget.value })}
      />
      <TextInput
        error={err('id')}
        data-field="id"
        label={t('form.checkId')}
        description={isNew ? t('form.checkIdHint') : t('form.checkIdFixed')}
        disabled={disabled || !isNew}
        value={c.id}
        onChange={(e) => set({ id: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
      />

      {/* the fields of the check's type (checks/index.ts) */}
      <CheckFields
        c={c}
        set={set}
        platforms={platforms}
        monitors={monitors}
        monitorKey={monitorKey}
        disabled={disabled}
        err={err}
        lastReport={lastReport}
        observedDelay={observedDelay}
      />
      {/* the identity it reads with, where the platform has several (0.13.0, ADR 0009) */}
      {'platform' in c && typeof c.platform === 'string' && c.platform && (
        <IdentitySelect
          platform={platformByRef(platforms, c.platform)}
          value={c.identity}
          onChange={(identity) => set({ identity })}
          disabled={disabled}
          noPrivileged
        />
      )}

      <Divider label={t('form.schedule')} labelPosition="left" />
      <Group grow align="flex-start">
        <NumberInput
          error={err('intervalSeconds')}
          data-field="intervalSeconds"
          label={t('form.interval')}
          description={t('form.monitorDefault')}
          min={5}
          disabled={disabled}
          value={c.intervalSeconds ?? ''}
          onChange={(v) => set({ intervalSeconds: num(v) })}
        />
        <NumberInput
          error={err('timeoutSeconds')}
          data-field="timeoutSeconds"
          label={t('form.timeout')}
          description={t('form.monitorDefault')}
          min={1}
          max={300}
          disabled={disabled}
          value={c.timeoutSeconds ?? ''}
          onChange={(v) => set({ timeoutSeconds: num(v) })}
        />
      </Group>
      <Group grow align="flex-start">
        <NumberInput
          error={err('failuresBeforeDown')}
          data-field="failuresBeforeDown"
          label={t('form.failuresBeforeDown')}
          min={1}
          max={20}
          disabled={disabled}
          value={c.failuresBeforeDown ?? ''}
          onChange={(v) => set({ failuresBeforeDown: num(v) })}
        />
        <NumberInput
          error={err('successesBeforeUp')}
          data-field="successesBeforeUp"
          label={t('form.successesBeforeUp')}
          min={1}
          max={20}
          disabled={disabled}
          value={c.successesBeforeUp ?? ''}
          onChange={(v) => set({ successesBeforeUp: num(v) })}
        />
      </Group>
      <Switch
        label={t('form.critical')}
        disabled={disabled}
        checked={c.critical !== false}
        onChange={(e) => set({ critical: e.currentTarget.checked ? undefined : false })}
      />
      <Switch
        label={t('form.enabled')}
        disabled={disabled}
        checked={c.enabled !== false}
        onChange={(e) => set({ enabled: e.currentTarget.checked ? undefined : false })}
      />
      <Textarea
        error={err('description')}
        data-field="description"
        label={t('form.description')}
        autosize
        minRows={1}
        disabled={disabled}
        value={c.description ?? ''}
        onChange={(e) => set({ description: e.currentTarget.value || undefined })}
      />
    </Stack>
  );
}

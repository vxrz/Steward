import { Divider, Group, NumberInput, SegmentedControl, Select, Stack, Switch, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { type CheckDef, type CheckOf, type MonitorSummary, type Platform } from '@sm/shared';
import { ExpressionInput } from '../editor/ExpressionInput';
import { Hint, KeyValueEditor } from '../common';
import { checkTypeHelp, checkTypeLabel } from './status';

type Patch = (p: Partial<CheckDef>) => void;

const num = (v: string | number) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function PlatformSelect({
  value,
  onChange,
  platforms,
  kind,
  label,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  platforms: Platform[];
  kind?: string;
  label?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('monitors');
  const list = platforms.filter((p) => !kind || p.kind === kind);
  return (
    <Select
      label={label ?? t('form.platform')}
      required
      searchable
      disabled={disabled}
      data={list.map((p) => ({ value: p.id, label: `${p.name}${p.environment ? ` (${p.environment})` : ''}` }))}
      value={list.some((p) => p.id === value) ? value : null}
      placeholder={value && !list.some((p) => p.id === value) ? value : t('form.choosePlatform')}
      onChange={(v) => onChange(v ?? '')}
      nothingFoundMessage={kind ? t('form.noPlatformOfKind', { kind }) : t('form.noPlatform')}
    />
  );
}

function FreshnessFields({
  c,
  set,
  disabled,
  what,
}: {
  c: CheckOf<'freshness'> | CheckOf<'heartbeat'>;
  set: Patch;
  disabled?: boolean;
  what: 'data' | 'reports';
}) {
  const { t } = useTranslation('monitors');
  return (
    <>
      <div>
        <Text size="sm" fw={500} mb={4}>
          {t(what === 'data' ? 'form.expectedData' : 'form.expectedReports')}
        </Text>
        <SegmentedControl
          size="xs"
          disabled={disabled}
          value={c.mode}
          onChange={(v) => set({ mode: v as 'cadence' | 'maxAge' })}
          data={[
            { value: 'cadence', label: t('form.cadence') },
            { value: 'maxAge', label: t('form.maxAge') },
          ]}
        />
      </div>
      {c.mode === 'cadence' ? (
        <Group grow align="flex-start">
          <NumberInput
            label={t('form.expectedEvery')}
            required
            min={1}
            disabled={disabled}
            value={c.expectedIntervalSeconds ?? ''}
            onChange={(v) => set({ expectedIntervalSeconds: num(v) })}
          />
          <NumberInput
            label={t('form.degradedAfterMissed')}
            description={t('form.intervalsDefault', { n: 2 })}
            min={1}
            disabled={disabled}
            value={c.degradedAfterMissed ?? ''}
            onChange={(v) => set({ degradedAfterMissed: num(v) })}
          />
          <NumberInput
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
            label={t('form.downOlderThan')}
            required
            min={1}
            disabled={disabled}
            value={c.maxAgeSeconds ?? ''}
            onChange={(v) => set({ maxAgeSeconds: num(v) })}
          />
          <NumberInput
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

export interface CheckFormProps {
  check: CheckDef;
  onChange: (c: CheckDef) => void;
  platforms: Platform[];
  monitors: MonitorSummary[];
  monitorKey: string;
  disabled?: boolean;
  isNew?: boolean;
}

/** Settings of one check (the monitor editor's inspector). */
export function CheckForm({ check: c, onChange, platforms, monitors, monitorKey, disabled, isNew }: CheckFormProps) {
  const set: Patch = (p) => onChange({ ...c, ...p } as CheckDef);
  const { t } = useTranslation('monitors');
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {checkTypeLabel(c.type)} – {checkTypeHelp(c.type)}
      </Text>
      <TextInput label={t('form.name')} required disabled={disabled} value={c.name} onChange={(e) => set({ name: e.currentTarget.value })} />
      <TextInput
        label={t('form.checkId')}
        description={isNew ? t('form.checkIdHint') : t('form.checkIdFixed')}
        disabled={disabled || !isNew}
        value={c.id}
        onChange={(e) => set({ id: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
      />

      {c.type === 'ping' && (
        <>
          <TextInput label={t('form.hostOrIp')} required disabled={disabled} value={c.host} onChange={(e) => set({ host: e.currentTarget.value })} />
          <Group grow align="flex-start">
            <NumberInput
              label={t('form.fallbackPort')}
              description={t('form.fallbackPortHint')}
              min={1}
              max={65535}
              disabled={disabled}
              value={c.fallbackPort ?? ''}
              onChange={(v) => set({ fallbackPort: num(v) })}
            />
            <NumberInput
              label={t('form.degradedAbove')}
              min={1}
              disabled={disabled}
              value={c.degradedRttMs ?? ''}
              onChange={(v) => set({ degradedRttMs: num(v) })}
            />
          </Group>
        </>
      )}
      {c.type === 'tcp' && (
        <Group grow align="flex-start">
          <TextInput label={t('form.host')} required disabled={disabled} value={c.host} onChange={(e) => set({ host: e.currentTarget.value })} />
          <NumberInput label={t('form.port')} required min={1} max={65535} disabled={disabled} value={c.port} onChange={(v) => set({ port: num(v) ?? 0 })} />
          <NumberInput label={t('form.degradedAbove')} min={1} disabled={disabled} value={c.degradedMs ?? ''} onChange={(v) => set({ degradedMs: num(v) })} />
        </Group>
      )}
      {c.type === 'http' && (
        <>
          <Group grow align="flex-start">
            <Select
              label={t('form.method')}
              data={['GET', 'HEAD', 'POST']}
              disabled={disabled}
              value={c.method}
              onChange={(v) => set({ method: (v ?? 'GET') as 'GET' })}
              maw={120}
            />
            <TextInput
              label={t('secrets.url')}
              required
              disabled={disabled}
              value={c.url}
              onChange={(e) => set({ url: e.currentTarget.value })}
              style={{ flex: 4 }}
            />
          </Group>
          <Group grow align="flex-start">
            <TextInput
              label={t('form.expectedStatus')}
              placeholder="200-399"
              disabled={disabled}
              value={c.expectStatus ?? ''}
              onChange={(e) => set({ expectStatus: e.currentTarget.value || undefined })}
            />
            <NumberInput
              label={t('form.degradedAbove')}
              min={1}
              disabled={disabled}
              value={c.degradedResponseMs ?? ''}
              onChange={(v) => set({ degradedResponseMs: num(v) })}
            />
            <NumberInput
              label={t('form.certWarning')}
              description={t('form.certWarningHint')}
              min={0}
              disabled={disabled}
              value={c.tlsExpiryWarnDays ?? ''}
              onChange={(v) => set({ tlsExpiryWarnDays: num(v) })}
            />
          </Group>
          <ExpressionInput
            label={t('form.condition')}
            description={t('form.conditionHttpHint', { vars: '{ status, headers, body, durationMs }', example: 'body.status = "UP"' })}
            preview={false}
            value={c.condition ?? ''}
            onChange={(v) => set({ condition: v || undefined })}
          />
          <Switch
            label={t('form.insecureTls')}
            disabled={disabled}
            checked={!!c.insecureTls}
            onChange={(e) => set({ insecureTls: e.currentTarget.checked || undefined })}
          />
          <Switch
            label={t('form.useProxy')}
            disabled={disabled}
            checked={c.useProxy !== false}
            onChange={(e) => set({ useProxy: e.currentTarget.checked ? undefined : false })}
          />
        </>
      )}
      {c.type === 'platform' && (
        <>
          <PlatformSelect value={c.platform} onChange={(v) => set({ platform: v })} platforms={platforms} disabled={disabled} />
          <Group grow align="flex-start">
            <Select
              label={t('form.method')}
              data={['GET', 'HEAD', 'POST']}
              disabled={disabled}
              value={c.method}
              onChange={(v) => set({ method: (v ?? 'GET') as 'GET' })}
              maw={120}
            />
            <TextInput
              label={t('form.path')}
              required
              disabled={disabled}
              value={c.path}
              onChange={(e) => set({ path: e.currentTarget.value })}
              style={{ flex: 4 }}
              classNames={{ input: 'mono' }}
            />
          </Group>
          <Text size="sm" fw={500}>
            {t('form.query')}
          </Text>
          <KeyValueEditor value={c.query} onChange={(v) => set({ query: v as Record<string, string> | undefined })} />
          <ExpressionInput
            label={t('form.condition')}
            description={t('form.conditionPlatformHint', { vars: '{ status, headers, body, durationMs }' })}
            preview={false}
            value={c.condition ?? ''}
            onChange={(v) => set({ condition: v || undefined })}
          />
          <NumberInput
            label={t('form.degradedAbove')}
            min={1}
            disabled={disabled}
            value={c.degradedResponseMs ?? ''}
            onChange={(v) => set({ degradedResponseMs: num(v) })}
          />
        </>
      )}
      {c.type === 'freshness' && (
        <>
          <SegmentedControl
            size="xs"
            disabled={disabled}
            value={c.source}
            onChange={(v) => set({ source: v as 'insightsHub' })}
            data={[
              { value: 'insightsHub', label: t('form.sourceInsightsHub') },
              { value: 'platform', label: t('form.sourcePlatform') },
            ]}
          />
          <PlatformSelect
            value={c.platform}
            onChange={(v) => set({ platform: v })}
            platforms={platforms}
            kind={c.source === 'insightsHub' ? 'insights-hub' : undefined}
            disabled={disabled}
          />
          {c.source === 'insightsHub' ? (
            <>
              <Group grow align="flex-start">
                <TextInput
                  label={t('form.assetId')}
                  required
                  disabled={disabled}
                  value={c.assetId ?? ''}
                  onChange={(e) => set({ assetId: e.currentTarget.value })}
                  classNames={{ input: 'mono' }}
                />
                <TextInput
                  label={t('form.aspect')}
                  required
                  disabled={disabled}
                  value={c.aspect ?? ''}
                  onChange={(e) => set({ aspect: e.currentTarget.value })}
                />
              </Group>
              <TagsInput
                label={t('form.variables')}
                description={t('form.variablesHint')}
                disabled={disabled}
                value={c.variables ?? []}
                onChange={(v) => set({ variables: v })}
              />
              <Hint>{t('form.sharedCall')}</Hint>
            </>
          ) : (
            <>
              <TextInput
                label={t('form.path')}
                required
                disabled={disabled}
                value={c.path ?? ''}
                onChange={(e) => set({ path: e.currentTarget.value })}
                classNames={{ input: 'mono' }}
              />
              <ExpressionInput
                label={t('form.timestamp')}
                description={t('form.timestampHint')}
                preview={false}
                value={c.timestamp ?? ''}
                onChange={(v) => set({ timestamp: v || undefined })}
              />
            </>
          )}
          <FreshnessFields c={c} set={set} disabled={disabled} what="data" />
        </>
      )}
      {c.type === 'heartbeat' && (
        <>
          <TextInput
            label={t('form.gatewayKey')}
            description={t('form.defaultValue', { value: `${monitorKey}.${c.id}` })}
            disabled={disabled}
            value={c.key ?? ''}
            placeholder={`${monitorKey}.${c.id}`}
            onChange={(e) => set({ key: e.currentTarget.value || undefined })}
            classNames={{ input: 'mono' }}
          />
          <FreshnessFields c={c} set={set} disabled={disabled} what="reports" />
          <ExpressionInput
            label={t('form.reportCondition')}
            description={t('form.reportConditionHint', { vars: '{ status, value, ts, data }', example: 'value > 0' })}
            preview={false}
            value={c.condition ?? ''}
            onChange={(v) => set({ condition: v || undefined })}
          />
          <ExpressionInput
            label={t('form.statusExpression')}
            description={t('form.statusExpressionHint')}
            preview={false}
            value={c.statusExpression ?? ''}
            onChange={(v) => set({ statusExpression: v || undefined })}
          />
          <Group grow align="flex-start">
            <Select
              label={t('form.authentication')}
              disabled={disabled}
              value={c.authMode}
              onChange={(v) => set({ authMode: (v ?? 'token') as 'token' })}
              data={[
                { value: 'token', label: t('auth.mode.token') },
                { value: 'hmac', label: t('auth.mode.hmac') },
                { value: 'either', label: t('auth.mode.either') },
              ]}
            />
            <NumberInput
              label={t('form.reportsPerMinute')}
              description={t('form.default60')}
              min={1}
              max={600}
              disabled={disabled}
              value={c.rateLimitPerMinute ?? ''}
              onChange={(v) => set({ rateLimitPerMinute: num(v) })}
            />
          </Group>
          <TagsInput
            label={t('gateways.cidrs')}
            description={t('form.cidrsHint')}
            disabled={disabled}
            value={c.allowedCidrs ?? []}
            onChange={(v) => set({ allowedCidrs: v.length ? v : undefined })}
          />
        </>
      )}
      {c.type === 'gatus' && (
        <>
          <PlatformSelect value={c.platform} onChange={(v) => set({ platform: v })} platforms={platforms} kind="gatus" disabled={disabled} />
          <TextInput label={t('form.endpointKey')} description={t('form.endpointKeyHint', { pattern: '<group>_<name>', example: 'plant_historian-api' })} required disabled={disabled} value={c.endpointKey} onChange={(e) => set({ endpointKey: e.currentTarget.value })} classNames={{ input: 'mono' }} />
          <Select
            label={t('form.gatusSource')}
            description={t('form.gatusSourceHint')}
            disabled={disabled}
            allowDeselect={false}
            data={(['auto', 'api', 'metrics'] as const).map((v) => ({ value: v, label: t(`form.gatusSources.${v}`) }))}
            value={c.source ?? 'auto'}
            onChange={(v) => set({ source: v === 'auto' || !v ? undefined : (v as 'api' | 'metrics') })}
          />
          <Group grow align="flex-start">
            <NumberInput
              label={t('form.gatusMaxAge')}
              min={1}
              disabled={disabled}
              value={c.maxAgeSeconds ?? ''}
              onChange={(v) => set({ maxAgeSeconds: num(v) })}
            />
            <NumberInput
              label={t('form.gatusRecent')}
              min={0}
              disabled={disabled}
              value={c.degradedOnRecentFailures ?? ''}
              onChange={(v) => set({ degradedOnRecentFailures: num(v) })}
            />
          </Group>
        </>
      )}
      {c.type === 'monitor' && (
        <Select
          label={t('list.monitor')}
          description={t('form.subMonitorHint')}
          required
          searchable
          disabled={disabled}
          data={monitors.filter((m) => !m.isTemplate && m.key !== monitorKey).map((m) => ({ value: m.id, label: m.name }))}
          value={monitors.some((m) => m.id === c.monitor) ? c.monitor : null}
          onChange={(v) => set({ monitor: v ?? '' })}
        />
      )}

      <Divider label={t('form.schedule')} labelPosition="left" />
      <Group grow align="flex-start">
        <NumberInput
          label={t('form.interval')}
          description={t('form.monitorDefault')}
          min={5}
          disabled={disabled}
          value={c.intervalSeconds ?? ''}
          onChange={(v) => set({ intervalSeconds: num(v) })}
        />
        <NumberInput
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
          label={t('form.failuresBeforeDown')}
          min={1}
          max={20}
          disabled={disabled}
          value={c.failuresBeforeDown ?? ''}
          onChange={(v) => set({ failuresBeforeDown: num(v) })}
        />
        <NumberInput
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

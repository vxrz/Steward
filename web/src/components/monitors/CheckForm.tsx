import { Divider, Group, NumberInput, SegmentedControl, Select, Stack, Switch, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { CHECK_TYPE_INFO, type CheckDef, type CheckOf, type MonitorSummary, type Platform } from '@sm/shared';
import { ExpressionInput } from '../editor/ExpressionInput';
import { Hint, KeyValueEditor } from '../common';

type Patch = (p: Partial<CheckDef>) => void;

const num = (v: string | number) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function PlatformSelect({ value, onChange, platforms, kind, label = 'Platform', disabled }: { value: string; onChange: (v: string) => void; platforms: Platform[]; kind?: string; label?: string; disabled?: boolean }) {
  const list = platforms.filter((p) => !kind || p.kind === kind);
  return (
    <Select
      label={label}
      required
      searchable
      disabled={disabled}
      data={list.map((p) => ({ value: p.id, label: `${p.name}${p.environment ? ` (${p.environment})` : ''}` }))}
      value={list.some((p) => p.id === value) ? value : null}
      placeholder={value && !list.some((p) => p.id === value) ? value : 'Choose a platform'}
      onChange={(v) => onChange(v ?? '')}
      nothingFoundMessage={kind ? `No platform of kind ${kind}` : 'No platform'}
    />
  );
}

function FreshnessFields({ c, set, disabled, what }: { c: CheckOf<'freshness'> | CheckOf<'heartbeat'>; set: Patch; disabled?: boolean; what: string }) {
  return (
    <>
      <div>
        <Text size="sm" fw={500} mb={4}>
          Expected {what}
        </Text>
        <SegmentedControl
          size="xs"
          disabled={disabled}
          value={c.mode}
          onChange={(v) => set({ mode: v as 'cadence' | 'maxAge' })}
          data={[
            { value: 'cadence', label: 'Regular cadence' },
            { value: 'maxAge', label: 'On change (maximum age)' },
          ]}
        />
      </div>
      {c.mode === 'cadence' ? (
        <Group grow align="flex-start">
          <NumberInput label="Expected every (s)" required min={1} disabled={disabled} value={c.expectedIntervalSeconds ?? ''} onChange={(v) => set({ expectedIntervalSeconds: num(v) })} />
          <NumberInput label="Degraded after missed" description="intervals (default 2)" min={1} disabled={disabled} value={c.degradedAfterMissed ?? ''} onChange={(v) => set({ degradedAfterMissed: num(v) })} />
          <NumberInput label="Down after missed" description="intervals (default 4)" min={1} disabled={disabled} value={c.downAfterMissed ?? ''} onChange={(v) => set({ downAfterMissed: num(v) })} />
        </Group>
      ) : (
        <Group grow align="flex-start">
          <NumberInput label="Down when older than (s)" required min={1} disabled={disabled} value={c.maxAgeSeconds ?? ''} onChange={(v) => set({ maxAgeSeconds: num(v) })} />
          <NumberInput label="Degraded when older than (s)" description="optional" min={1} disabled={disabled} value={c.degradedAgeSeconds ?? ''} onChange={(v) => set({ degradedAgeSeconds: num(v) })} />
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
  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {CHECK_TYPE_INFO[c.type].label} – {CHECK_TYPE_INFO[c.type].help}
      </Text>
      <TextInput label="Name" required disabled={disabled} value={c.name} onChange={(e) => set({ name: e.currentTarget.value })} />
      <TextInput
        label="Check id"
        description={isNew ? 'Letters, digits, _ and -; used in links, item keys and the API' : 'Fixed once saved'}
        disabled={disabled || !isNew}
        value={c.id}
        onChange={(e) => set({ id: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
      />

      {c.type === 'ping' && (
        <>
          <TextInput label="Host or IP address" required disabled={disabled} value={c.host} onChange={(e) => set({ host: e.currentTarget.value })} />
          <Group grow align="flex-start">
            <NumberInput
              label="TCP fallback port"
              description="Used when ICMP is not available (default 80)"
              min={1}
              max={65535}
              disabled={disabled}
              value={c.fallbackPort ?? ''}
              onChange={(v) => set({ fallbackPort: num(v) })}
            />
            <NumberInput label="Degraded above (ms)" min={1} disabled={disabled} value={c.degradedRttMs ?? ''} onChange={(v) => set({ degradedRttMs: num(v) })} />
          </Group>
        </>
      )}
      {c.type === 'tcp' && (
        <Group grow align="flex-start">
          <TextInput label="Host" required disabled={disabled} value={c.host} onChange={(e) => set({ host: e.currentTarget.value })} />
          <NumberInput label="Port" required min={1} max={65535} disabled={disabled} value={c.port} onChange={(v) => set({ port: num(v) ?? 0 })} />
          <NumberInput label="Degraded above (ms)" min={1} disabled={disabled} value={c.degradedMs ?? ''} onChange={(v) => set({ degradedMs: num(v) })} />
        </Group>
      )}
      {c.type === 'http' && (
        <>
          <Group grow align="flex-start">
            <Select label="Method" data={['GET', 'HEAD', 'POST']} disabled={disabled} value={c.method} onChange={(v) => set({ method: (v ?? 'GET') as 'GET' })} maw={120} />
            <TextInput label="URL" required disabled={disabled} value={c.url} onChange={(e) => set({ url: e.currentTarget.value })} style={{ flex: 4 }} />
          </Group>
          <Group grow align="flex-start">
            <TextInput label="Expected status" placeholder="200-399" disabled={disabled} value={c.expectStatus ?? ''} onChange={(e) => set({ expectStatus: e.currentTarget.value || undefined })} />
            <NumberInput label="Degraded above (ms)" min={1} disabled={disabled} value={c.degradedResponseMs ?? ''} onChange={(v) => set({ degradedResponseMs: num(v) })} />
            <NumberInput label="Certificate warning (days)" description="0 = off, default 14" min={0} disabled={disabled} value={c.tlsExpiryWarnDays ?? ''} onChange={(v) => set({ tlsExpiryWarnDays: num(v) })} />
          </Group>
          <ExpressionInput
            label="Condition (JSONata, optional)"
            description="Over { status, headers, body, durationMs }, e.g. body.status = &quot;UP&quot;"
            preview={false}
            value={c.condition ?? ''}
            onChange={(v) => set({ condition: v || undefined })}
          />
          <Switch label="Accept self-signed certificates" disabled={disabled} checked={!!c.insecureTls} onChange={(e) => set({ insecureTls: e.currentTarget.checked || undefined })} />
          <Switch label="Use the proxy from the environment" disabled={disabled} checked={c.useProxy !== false} onChange={(e) => set({ useProxy: e.currentTarget.checked ? undefined : false })} />
        </>
      )}
      {c.type === 'platform' && (
        <>
          <PlatformSelect value={c.platform} onChange={(v) => set({ platform: v })} platforms={platforms} disabled={disabled} />
          <Group grow align="flex-start">
            <Select label="Method" data={['GET', 'HEAD', 'POST']} disabled={disabled} value={c.method} onChange={(v) => set({ method: (v ?? 'GET') as 'GET' })} maw={120} />
            <TextInput label="Path" required disabled={disabled} value={c.path} onChange={(e) => set({ path: e.currentTarget.value })} style={{ flex: 4 }} classNames={{ input: 'mono' }} />
          </Group>
          <Text size="sm" fw={500}>
            Query parameters
          </Text>
          <KeyValueEditor value={c.query} onChange={(v) => set({ query: v as Record<string, string> | undefined })} />
          <ExpressionInput
            label="Condition (JSONata, optional)"
            description="Over { status, headers, body, durationMs }; default: HTTP 2xx"
            preview={false}
            value={c.condition ?? ''}
            onChange={(v) => set({ condition: v || undefined })}
          />
          <NumberInput label="Degraded above (ms)" min={1} disabled={disabled} value={c.degradedResponseMs ?? ''} onChange={(v) => set({ degradedResponseMs: num(v) })} />
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
              { value: 'insightsHub', label: 'Insights Hub time series' },
              { value: 'platform', label: 'Any platform API' },
            ]}
          />
          <PlatformSelect value={c.platform} onChange={(v) => set({ platform: v })} platforms={platforms} kind={c.source === 'insightsHub' ? 'insights-hub' : undefined} disabled={disabled} />
          {c.source === 'insightsHub' ? (
            <>
              <Group grow align="flex-start">
                <TextInput label="Asset id" required disabled={disabled} value={c.assetId ?? ''} onChange={(e) => set({ assetId: e.currentTarget.value })} classNames={{ input: 'mono' }} />
                <TextInput label="Aspect" required disabled={disabled} value={c.aspect ?? ''} onChange={(e) => set({ aspect: e.currentTarget.value })} />
              </Group>
              <TagsInput label="Variables" description="The newest value of each must be fresh; the worst counts" disabled={disabled} value={c.variables ?? []} onChange={(v) => set({ variables: v })} />
              <Hint>Checks on the same asset and aspect share one Insights Hub call per cycle.</Hint>
            </>
          ) : (
            <>
              <TextInput label="Path" required disabled={disabled} value={c.path ?? ''} onChange={(e) => set({ path: e.currentTarget.value })} classNames={{ input: 'mono' }} />
              <ExpressionInput label="Timestamp (JSONata)" description="Over the response body; a timestamp or a list (the newest counts)" preview={false} value={c.timestamp ?? ''} onChange={(v) => set({ timestamp: v || undefined })} />
            </>
          )}
          <FreshnessFields c={c} set={set} disabled={disabled} what="data" />
        </>
      )}
      {c.type === 'heartbeat' && (
        <>
          <TextInput
            label="Key for gateway reports"
            description={`Default: ${monitorKey}.${c.id}`}
            disabled={disabled}
            value={c.key ?? ''}
            placeholder={`${monitorKey}.${c.id}`}
            onChange={(e) => set({ key: e.currentTarget.value || undefined })}
            classNames={{ input: 'mono' }}
          />
          <FreshnessFields c={c} set={set} disabled={disabled} what="reports" />
          <ExpressionInput label="Condition on the report (JSONata, optional)" description="Over { status, value, ts, data }, e.g. value > 0" preview={false} value={c.condition ?? ''} onChange={(v) => set({ condition: v || undefined })} />
          <ExpressionInput
            label="Status from the report (JSONata, optional)"
            description="Returns up, degraded, down or true/false; default: the report's status field"
            preview={false}
            value={c.statusExpression ?? ''}
            onChange={(v) => set({ statusExpression: v || undefined })}
          />
          <Group grow align="flex-start">
            <Select
              label="Authentication"
              disabled={disabled}
              value={c.authMode}
              onChange={(v) => set({ authMode: (v ?? 'token') as 'token' })}
              data={[
                { value: 'token', label: 'Static token' },
                { value: 'hmac', label: 'HMAC signature' },
                { value: 'either', label: 'Either' },
              ]}
            />
            <NumberInput label="Reports per minute" description="default 60" min={1} max={600} disabled={disabled} value={c.rateLimitPerMinute ?? ''} onChange={(v) => set({ rateLimitPerMinute: num(v) })} />
          </Group>
          <TagsInput label="Allowed source addresses" description="IP or CIDR; empty = any" disabled={disabled} value={c.allowedCidrs ?? []} onChange={(v) => set({ allowedCidrs: v.length ? v : undefined })} />
        </>
      )}
      {c.type === 'gatus' && (
        <>
          <PlatformSelect value={c.platform} onChange={(v) => set({ platform: v })} platforms={platforms} kind="gatus" disabled={disabled} />
          <TextInput label="Endpoint key" description="<group>_<name>, e.g. plant_historian-api" required disabled={disabled} value={c.endpointKey} onChange={(e) => set({ endpointKey: e.currentTarget.value })} classNames={{ input: 'mono' }} />
          <Group grow align="flex-start">
            <NumberInput label="Down when the newest result is older than (s)" min={1} disabled={disabled} value={c.maxAgeSeconds ?? ''} onChange={(v) => set({ maxAgeSeconds: num(v) })} />
            <NumberInput label="Degraded on failures in the last N results" min={0} disabled={disabled} value={c.degradedOnRecentFailures ?? ''} onChange={(v) => set({ degradedOnRecentFailures: num(v) })} />
          </Group>
        </>
      )}
      {c.type === 'monitor' && (
        <Select
          label="Monitor"
          description="Evaluated on its own schedule; this node shows its aggregated status"
          required
          searchable
          disabled={disabled}
          data={monitors.filter((m) => !m.isTemplate && m.key !== monitorKey).map((m) => ({ value: m.id, label: m.name }))}
          value={monitors.some((m) => m.id === c.monitor) ? c.monitor : null}
          onChange={(v) => set({ monitor: v ?? '' })}
        />
      )}

      <Divider label="Schedule and thresholds" labelPosition="left" />
      <Group grow align="flex-start">
        <NumberInput label="Interval (s)" description="Empty: monitor default" min={5} disabled={disabled} value={c.intervalSeconds ?? ''} onChange={(v) => set({ intervalSeconds: num(v) })} />
        <NumberInput label="Timeout (s)" description="Empty: monitor default" min={1} max={300} disabled={disabled} value={c.timeoutSeconds ?? ''} onChange={(v) => set({ timeoutSeconds: num(v) })} />
      </Group>
      <Group grow align="flex-start">
        <NumberInput label="Failures before down" min={1} max={20} disabled={disabled} value={c.failuresBeforeDown ?? ''} onChange={(v) => set({ failuresBeforeDown: num(v) })} />
        <NumberInput label="Successes before up" min={1} max={20} disabled={disabled} value={c.successesBeforeUp ?? ''} onChange={(v) => set({ successesBeforeUp: num(v) })} />
      </Group>
      <Switch label="Critical (a failure takes the monitor down)" disabled={disabled} checked={c.critical !== false} onChange={(e) => set({ critical: e.currentTarget.checked ? undefined : false })} />
      <Switch label="Enabled" disabled={disabled} checked={c.enabled !== false} onChange={(e) => set({ enabled: e.currentTarget.checked ? undefined : false })} />
      <Textarea label="Description" autosize minRows={1} disabled={disabled} value={c.description ?? ''} onChange={(e) => set({ description: e.currentTarget.value || undefined })} />
    </Stack>
  );
}

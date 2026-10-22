import { useEffect, useMemo, useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  CopyButton,
  Divider,
  Group,
  JsonInput,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconCheck, IconCopy, IconEdit, IconHistory, IconKey, IconPlus, IconSend, IconTrash } from '@tabler/icons-react';
import type {
  ProcessDetail,
  ProcessSummary,
  WebhookAuthMode,
  WebhookFire,
  WebhookMappingPreview,
  WebhookTestResult,
  WebhookTrigger,
  WebhookTriggerSecret,
  WebhookTriggerSettings,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { Hint, PageHeader, StatusBadge } from '../components/common';
import { BindingsForm, loadBindings } from '../components/RunDialog';
import { fmtDate, fmtRelative } from '../format';

type Draft = WebhookTriggerSettings & { id?: string; owner?: string };

const emptyDraft = (): Draft => ({
  name: '',
  description: '',
  processId: '',
  processVersion: null,
  enabled: true,
  dryRun: false,
  inputMapping: {},
  bindings: {},
  authMode: 'token',
  allowedCidrs: [],
  allowedHeaders: [],
  rateLimitPerMinute: 30,
  dedupeSeconds: 300,
  skipIfRunning: true,
});

const toDraft = (t: WebhookTrigger): Draft => ({
  id: t.id,
  owner: t.owner,
  name: t.name,
  description: t.description ?? '',
  processId: t.processId,
  processVersion: t.processVersion ?? null,
  enabled: t.enabled,
  dryRun: t.dryRun,
  inputMapping: t.inputMapping,
  bindings: t.bindings,
  authMode: t.authMode,
  allowedCidrs: t.allowedCidrs,
  allowedHeaders: t.allowedHeaders,
  rateLimitPerMinute: t.rateLimitPerMinute,
  dedupeSeconds: t.dedupeSeconds,
  skipIfRunning: t.skipIfRunning,
});

/** The JSON body of the Gatus custom alert in docs/GATUS.md (placeholders already replaced). */
const GATUS_SAMPLE = {
  event: 'TRIGGERED',
  name: 'Historian API',
  group: 'plant',
  url: 'https://apps.example.com/historian/health',
  description: 'historian health check failed',
  errors: '[STATUS] (503) == 200',
};
/** Mapping of the Gatus alert fields onto the inputs of "Diagnose endpoint outage". */
const GATUS_MAPPING: Record<string, string> = {
  endpointName: 'body.name',
  endpointGroup: 'body.group',
  endpointUrl: 'body.url',
  alertState: 'body.event',
  errors: 'body.errors',
  description: 'body.description',
};

const AUTH_LABEL: Record<WebhookAuthMode, string> = { token: 'static token', hmac: 'HMAC signature', either: 'token or HMAC' };

const hookUrl = (t: Pick<WebhookTrigger, 'path'>) => `${window.location.origin}${t.path}`;

export function TriggersPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const triggers = useQuery({ queryKey: ['triggers'], queryFn: () => get<WebhookTrigger[]>('/triggers'), refetchInterval: 10000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secret, setSecret] = useState<WebhookTriggerSecret | null>(null);
  const [testing, setTesting] = useState<WebhookTrigger | null>(null);
  const [history, setHistory] = useState<WebhookTrigger | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['triggers'] });

  const save = async (d: Draft): Promise<boolean> => {
    const { id, owner: _owner, ...body } = d;
    try {
      if (id) await put(`/triggers/${id}`, body);
      else setSecret(await post<WebhookTriggerSecret>('/triggers', body));
      refresh();
      return true;
    } catch (e) {
      notifyError(e, 'Trigger not saved');
      return false;
    }
  };

  const rotate = async (t: WebhookTrigger) => {
    if (!confirm(`Rotate the secret of "${t.name}"? The current secret stops working immediately – update the caller (e.g. Gatus) right away.`)) return;
    try {
      setSecret(await post<WebhookTriggerSecret>(`/triggers/${t.id}/rotate`));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader
        title="Triggers"
        description="Webhook triggers start a process when another system calls an URL, e.g. a Gatus alert starts a diagnosis runbook. Each trigger has its own secret; runs use the rights of the trigger's owner and are skipped and logged if the owner loses access."
        actions={
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft(emptyDraft())}>
            New webhook trigger
          </Button>
        }
      />
      {triggers.data?.length === 0 && (
        <Text c="dimmed" size="sm">
          No webhook triggers yet.
        </Text>
      )}
      {!!triggers.data?.length && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Active</Table.Th>
                <Table.Th>Name</Table.Th>
                <Table.Th>Security</Table.Th>
                <Table.Th>Last call</Table.Th>
                <Table.Th>Runs started</Table.Th>
                <Table.Th>Last result</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {triggers.data.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>
                    <Switch
                      size="xs"
                      checked={t.enabled}
                      disabled={!t.canEdit}
                      onChange={(e) => save({ ...toDraft(t), enabled: e.currentTarget.checked })}
                      aria-label="Enabled"
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {t.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      <Link to={`/processes/${t.processId}`}>{t.processName ?? t.processId}</Link>
                      {t.processVersion ? ` v${t.processVersion}` : ''} · runs as {t.owner}
                      {t.dryRun && (
                        <Badge ml={4} size="xs" color="yellow" variant="light">
                          dry run
                        </Badge>
                      )}
                    </Text>
                    <Text size="xs" c="dimmed" className="mono">
                      POST {t.path}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" fw={500} className="nowrap">
                      {AUTH_LABEL[t.authMode]}
                    </Text>
                    <Text size="xs" c="dimmed">
                      secret {t.secretPrefix}… · {t.rateLimitPerMinute}/min
                      {t.dedupeSeconds ? ` · dedupe ${t.dedupeSeconds} s` : ''}
                      {t.allowedCidrs.length ? ` · ${t.allowedCidrs.join(', ')}` : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    {t.lastRunId ? (
                      <Stack gap={2} align="flex-start" className="clickable" onClick={() => navigate(`/runs/${t.lastRunId}`)}>
                        {t.lastRunStatus && <StatusBadge status={t.lastRunStatus} size="xs" />}
                        <Text size="xs">{fmtRelative(t.lastFiredAt)}</Text>
                      </Stack>
                    ) : (
                      <Text size="xs">{fmtRelative(t.lastFiredAt)}</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{t.fireCount}</Text>
                    {t.rejectedCount > 0 && (
                      <Tooltip label={`Last rejection ${fmtDate(t.lastRejectedAt)}: ${t.lastRejectedReason ?? ''}`}>
                        <Text size="xs" c="orange">
                          {t.rejectedCount} rejected
                        </Text>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c={t.lastResult && t.lastResult !== 'started' ? 'orange' : 'dimmed'} lineClamp={2} maw={260}>
                      {t.lastResult ?? '–'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={2} wrap="nowrap" justify="flex-end">
                      <Tooltip label="Recent calls">
                        <ActionIcon variant="subtle" onClick={() => setHistory(t)} aria-label="Recent calls">
                          <IconHistory size={16} />
                        </ActionIcon>
                      </Tooltip>
                      {t.canEdit && (
                        <>
                          <Tooltip label="Send a test call">
                            <ActionIcon variant="subtle" onClick={() => setTesting(t)} aria-label="Send a test call" disabled={!t.enabled}>
                              <IconSend size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label="Rotate secret">
                            <ActionIcon variant="subtle" onClick={() => rotate(t)} aria-label="Rotate secret">
                              <IconKey size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <ActionIcon variant="subtle" onClick={() => setDraft(toDraft(t))} aria-label="Edit">
                            <IconEdit size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label="Delete"
                            onClick={async () => {
                              if (!confirm(`Delete webhook trigger "${t.name}"? Calls to its URL will be answered with 404.`)) return;
                              await del(`/triggers/${t.id}`).catch(notifyError);
                              refresh();
                            }}
                          >
                            <IconTrash size={16} />
                          </ActionIcon>
                        </>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {draft && (
        <TriggerModal
          draft={draft}
          onClose={() => setDraft(null)}
          onSave={async (d) => {
            if (await save(d)) {
              if (d.id) notifyOk('Trigger saved');
              setDraft(null);
            }
          }}
        />
      )}
      {secret && <SecretModal created={secret} onClose={() => setSecret(null)} />}
      {testing && <TestModal trigger={testing} onClose={() => (setTesting(null), refresh())} />}
      {history && <HistoryModal trigger={history} onClose={() => setHistory(null)} />}
    </>
  );
}

function parseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: text.trim() ? JSON.parse(text) : {} };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

function TriggerModal({ draft, onClose, onSave }: { draft: Draft; onClose: () => void; onSave: (d: Draft) => void }) {
  const [d, setD] = useState<Draft>(draft);
  const [sample, setSample] = useState(JSON.stringify(GATUS_SAMPLE, null, 2));
  const processes = useQuery({ queryKey: ['processes'], queryFn: () => get<ProcessSummary[]>('/processes') });
  const proc = useQuery({
    queryKey: ['process', d.processId],
    queryFn: () => get<ProcessDetail>(`/processes/${d.processId}`),
    enabled: !!d.processId,
  });
  const inputs = proc.data?.definition.inputs ?? [];

  useEffect(() => {
    if (proc.data && !draft.id && d.processId === proc.data.id && !Object.keys(d.bindings).length) {
      setD((x) => ({ ...x, bindings: loadBindings(proc.data.id), name: x.name || `${proc.data.name} (webhook)` }));
    }
  }, [proc.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const parsed = parseJson(sample);
  const [debounced] = useDebouncedValue(JSON.stringify({ m: d.inputMapping, h: d.allowedHeaders, p: parsed.value }), 400);
  const preview = useQuery({
    queryKey: ['trigger-preview', debounced],
    queryFn: () =>
      post<WebhookMappingPreview>('/triggers/preview-mapping', { inputMapping: d.inputMapping, allowedHeaders: d.allowedHeaders, payload: parsed.value ?? {} }),
    enabled: !parsed.error && Object.keys(d.inputMapping).length > 0,
    retry: false,
  });
  const gatusFits = inputs.some((i) => i.name in GATUS_MAPPING);
  const setMapping = (name: string, expr: string) => {
    const next = { ...d.inputMapping, [name]: expr };
    if (!expr.trim()) delete next[name];
    setD({ ...d, inputMapping: next });
  };

  return (
    <Modal opened onClose={onClose} title={draft.id ? 'Edit webhook trigger' : 'New webhook trigger'} size="xl">
      <Stack>
        <Group grow align="flex-start">
          <Select
            label="Process"
            required
            searchable
            data={(processes.data ?? []).filter((p) => p.permissions.includes('run')).map((p) => ({ value: p.id, label: p.name }))}
            value={d.processId || null}
            onChange={(v) => setD({ ...d, processId: v ?? '', inputMapping: {}, bindings: {}, processVersion: null })}
          />
          <NumberInput
            label="Pin version"
            description="Empty: always the current version"
            min={1}
            max={proc.data?.currentVersion}
            value={d.processVersion ?? ''}
            onChange={(v) => setD({ ...d, processVersion: typeof v === 'number' ? v : null })}
          />
        </Group>
        <TextInput label="Name" required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} />
        <Textarea label="Description" autosize minRows={1} value={d.description ?? ''} onChange={(e) => setD({ ...d, description: e.currentTarget.value })} />
        {proc.data && (
          <>
            <Divider label="Connections" labelPosition="left" />
            <BindingsForm process={proc.data} value={d.bindings} onChange={(b) => setD({ ...d, bindings: b })} />
            <Divider label="Inputs from the request" labelPosition="left" />
            <Text size="xs" c="dimmed">
              One JSONata expression per input, evaluated against <Code>body</Code> (the JSON payload), <Code>headers</Code> (allow-listed headers only) and{' '}
              <Code>query</Code> (URL parameters). Strings need quotes, e.g. <Code>"fixed value"</Code>. Inputs without an expression use their default.
            </Text>
            {gatusFits && (
              <Group>
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={() =>
                    setD({
                      ...d,
                      inputMapping: Object.fromEntries(inputs.filter((i) => GATUS_MAPPING[i.name]).map((i) => [i.name, GATUS_MAPPING[i.name]!])),
                    })
                  }
                >
                  Map a Gatus alert
                </Button>
              </Group>
            )}
            {inputs.length === 0 && <Text size="sm" c="dimmed">This process has no inputs.</Text>}
            {inputs.map((i) => (
              <Group key={i.name} align="flex-start" wrap="nowrap" gap="xs">
                <TextInput
                  style={{ flex: 1 }}
                  size="xs"
                  label={`${i.label ?? i.name} (${i.type}${i.required ? ', required' : ''})`}
                  placeholder={`e.g. body.${i.name}`}
                  classNames={{ input: 'mono' }}
                  value={d.inputMapping[i.name] ?? ''}
                  onChange={(e) => setMapping(i.name, e.currentTarget.value)}
                  error={preview.data?.errors[i.name]}
                />
                <Text size="xs" c="dimmed" mt={26} w={200} truncate title={JSON.stringify(preview.data?.inputs[i.name])}>
                  {d.inputMapping[i.name] ? `→ ${preview.data && i.name in preview.data.inputs ? JSON.stringify(preview.data.inputs[i.name]) : '–'}` : 'default'}
                </Text>
              </Group>
            ))}
            <JsonInput
              label="Sample payload (for the preview only)"
              description="Pre-filled with a Gatus custom alert as configured in docs/GATUS.md"
              autosize
              minRows={4}
              maxRows={12}
              value={sample}
              onChange={setSample}
              error={parsed.error}
              classNames={{ input: 'mono' }}
            />
          </>
        )}
        <Divider label="Security" labelPosition="left" />
        <div>
          <Text size="sm" fw={500} mb={4}>
            Authentication
          </Text>
          <SegmentedControl
            size="xs"
            value={d.authMode}
            onChange={(v) => setD({ ...d, authMode: v as WebhookAuthMode })}
            data={[
              { value: 'token', label: 'Static token' },
              { value: 'hmac', label: 'HMAC signature' },
              { value: 'either', label: 'Either' },
            ]}
          />
          <Text size="xs" c="dimmed" mt={4}>
            Static token: <Code>Authorization: Bearer &lt;secret&gt;</Code> or <Code>X-Steward-Token</Code> (what Gatus can send). HMAC:{' '}
            <Code>X-Steward-Signature: sha256=&lt;hex HMAC-SHA256 of the raw body&gt;</Code> (GitHub-style; the secret never travels).
          </Text>
        </div>
        <TagsInput
          label="Allowed source addresses"
          description="IP addresses or CIDR ranges (IPv4/IPv6), e.g. 10.20.0.0/16. Empty: any address. Behind a reverse proxy, the proxy's address is seen."
          value={d.allowedCidrs}
          onChange={(v) => setD({ ...d, allowedCidrs: v })}
          clearable
        />
        <TagsInput
          label="Headers available to the mapping"
          description="Lower-case names, e.g. x-gatus-instance. Credential headers can never be mapped."
          value={d.allowedHeaders}
          onChange={(v) => setD({ ...d, allowedHeaders: v.map((h) => h.toLowerCase()) })}
          clearable
        />
        <Group grow align="flex-start">
          <NumberInput
            label="Rate limit (calls per minute)"
            min={1}
            max={600}
            value={d.rateLimitPerMinute}
            onChange={(v) => setD({ ...d, rateLimitPerMinute: Number(v) || 1 })}
          />
          <NumberInput
            label="Ignore identical payloads for (s)"
            description="0 = off. Gatus re-sends the same alert as a reminder."
            min={0}
            max={86400}
            value={d.dedupeSeconds}
            onChange={(v) => setD({ ...d, dedupeSeconds: Number(v) || 0 })}
          />
        </Group>
        <Switch
          label="Skip while the previous run is still running or waiting"
          checked={d.skipIfRunning}
          onChange={(e) => setD({ ...d, skipIfRunning: e.currentTarget.checked })}
        />
        <Switch label="Dry run (simulate changes)" checked={d.dryRun} onChange={(e) => setD({ ...d, dryRun: e.currentTarget.checked })} />
        <Switch label="Enabled" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <Hint>
          Runs execute with the rights of {draft.owner ? <b>{draft.owner}</b> : 'you (the owner)'}. The secret is shown once after saving; it is stored encrypted and
          can be rotated at any time.
        </Hint>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onSave(d)} disabled={!d.processId || !d.name}>
            {draft.id ? 'Save' : 'Create and show secret'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <Group justify="space-between" mb={2}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <CopyButton value={text}>
          {({ copied, copy }) => (
            <Button size="compact-xs" variant="subtle" leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </Group>
      <Code block style={{ whiteSpace: 'pre', overflowX: 'auto', fontSize: 12 }}>
        {text}
      </Code>
    </div>
  );
}

function SecretModal({ created, onClose }: { created: WebhookTriggerSecret; onClose: () => void }) {
  const t = created.trigger;
  const url = hookUrl(t);
  const sample = JSON.stringify({ event: 'TRIGGERED', name: 'Historian API', group: 'plant', url: 'https://apps.example.com/historian/health', errors: 'test' });
  const curl =
    t.authMode === 'hmac'
      ? `BODY='${sample}'\nSIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$STEWARD_WEBHOOK_SECRET" | sed 's/^.* //')\ncurl -sS -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "X-Steward-Signature: sha256=$SIG" \\\n  --data "$BODY"`
      : `curl -sS -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $STEWARD_WEBHOOK_SECRET" \\\n  --data '${sample}'`;
  const gatus = `alerting:
  custom:
    url: "${url}"
    method: "POST"
    headers:
      Content-Type: "application/json"
      # the secret comes from Gatus' environment, not from the file
      Authorization: "Bearer \${STEWARD_WEBHOOK_SECRET}"
    body: |
      {
        "event": "[ALERT_TRIGGERED_OR_RESOLVED]",
        "name": "[ENDPOINT_NAME]",
        "group": "[ENDPOINT_GROUP]",
        "url": "[ENDPOINT_URL]",
        "description": "[ALERT_DESCRIPTION]",
        "errors": "[RESULT_ERRORS]"
      }
    default-alert:
      send-on-resolved: true
      failure-threshold: 3

endpoints:
  - name: historian-api
    group: plant
    url: "https://apps.example.com/historian/health"
    conditions:
      - "[STATUS] == 200"
    alerts:
      - type: custom`;
  return (
    <Modal opened onClose={onClose} title={`Secret of "${t.name}"`} size="xl" closeOnClickOutside={false}>
      <Stack>
        <Alert color="orange" title="Copy the secret now">
          It is shown only once and cannot be recovered. Store it in the calling system's secret store (for Gatus: an environment variable such as{' '}
          <Code>STEWARD_WEBHOOK_SECRET</Code>). If it is lost or leaked, rotate it.
        </Alert>
        <CopyBlock label="Secret" text={created.secret} />
        <CopyBlock label="Webhook URL" text={url} />
        <CopyBlock label={t.authMode === 'hmac' ? 'Test with curl (HMAC signature)' : 'Test with curl'} text={curl} />
        {t.authMode !== 'hmac' && <CopyBlock label="Gatus: custom alerting provider (config.yaml)" text={gatus} />}
        <Text size="xs" c="dimmed">
          The host name of the URL must be listed in <Code>SM_ALLOWED_HOSTS</Code> when Gatus runs on another machine. More in{' '}
          <Anchor href="https://github.com/TwiN/gatus#configuring-custom-alerts" target="_blank" rel="noreferrer" size="xs">
            Gatus custom alerts
          </Anchor>{' '}
          and docs/GATUS.md.
        </Text>
        <Group justify="flex-end">
          <Button onClick={onClose}>I have stored the secret</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TestModal({ trigger, onClose }: { trigger: WebhookTrigger; onClose: () => void }) {
  const navigate = useNavigate();
  const [payload, setPayload] = useState(JSON.stringify(GATUS_SAMPLE, null, 2));
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WebhookTestResult | null>(null);
  const parsed = parseJson(payload);
  const send = async () => {
    setBusy(true);
    try {
      setResult(await post<WebhookTestResult>(`/triggers/${trigger.id}/test`, { payload: parsed.value, dryRun }));
    } catch (e) {
      notifyError(e, 'Test call failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={`Test call – ${trigger.name}`} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          Sends the payload through the real endpoint (secret, content type, rate limit, de-duplication and input mapping are checked as for any caller; the
          source address check is skipped). The call and the run are marked as a test.
        </Text>
        <JsonInput label="Payload" autosize minRows={6} maxRows={16} value={payload} onChange={setPayload} error={parsed.error} classNames={{ input: 'mono' }} />
        <Switch label="Dry run (simulate changes)" checked={dryRun || trigger.dryRun} disabled={trigger.dryRun} onChange={(e) => setDryRun(e.currentTarget.checked)} />
        {result && (
          <Alert color={result.status === 202 && result.response.runId ? 'green' : 'orange'} title={`HTTP ${result.status}`}>
            <Stack gap={4}>
              <Text size="sm">
                {result.response.runId ? (
                  <>
                    Run started: <Anchor onClick={() => navigate(`/runs/${result.response.runId}`)}>{result.response.runId}</Anchor>
                  </>
                ) : (
                  (result.response.skipped && `Skipped: ${result.response.skipped}`) || result.response.error
                )}
              </Text>
              <Text size="xs" c="dimmed">
                Mapped inputs:
              </Text>
              <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(result.inputs, null, 2)}
              </Code>
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          <Button leftSection={<IconSend size={14} />} onClick={send} loading={busy} disabled={!!parsed.error}>
            Send test call
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function HistoryModal({ trigger, onClose }: { trigger: WebhookTrigger; onClose: () => void }) {
  const fires = useQuery({ queryKey: ['trigger-fires', trigger.id], queryFn: () => get<WebhookFire[]>(`/triggers/${trigger.id}/fires?limit=100`) });
  const rows = useMemo(() => fires.data ?? [], [fires.data]);
  return (
    <Modal opened onClose={onClose} title={`Recent calls – ${trigger.name}`} size="xl">
      <Text size="xs" c="dimmed" mb="xs">
        Accepted calls (run started, skipped or failed). Rejected calls – wrong secret, address, rate limit, duplicates – are only counted
        {trigger.rejectedCount ? ` (${trigger.rejectedCount} so far)` : ''} and recorded in the audit log.
      </Text>
      {rows.length === 0 && <Text size="sm" c="dimmed">No calls yet.</Text>}
      {rows.length > 0 && (
        <div className="table-scroll">
          <Table fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>From</Table.Th>
                <Table.Th>Outcome</Table.Th>
                <Table.Th>Run</Table.Th>
                <Table.Th>Payload SHA-256</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((f) => (
                <Table.Tr key={f.id}>
                  <Table.Td className="nowrap">{fmtDate(f.ts)}</Table.Td>
                  <Table.Td className="mono">{f.sourceIp}</Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light" color={f.outcome === 'started' ? 'green' : f.outcome === 'skipped' ? 'gray' : 'red'}>
                      {f.outcome}
                    </Badge>
                    {f.test && (
                      <Badge ml={4} size="xs" variant="outline">
                        test
                      </Badge>
                    )}
                    {f.reason && (
                      <Text size="xs" c="dimmed">
                        {f.reason}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>{f.runId ? <Link to={`/runs/${f.runId}`}>{f.runId}</Link> : '–'}</Table.Td>
                  <Table.Td className="mono">{f.payloadHash.slice(0, 12)}…</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Modal>
  );
}

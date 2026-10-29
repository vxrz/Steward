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
import { Link } from 'react-router-dom';
import { IconCheck, IconCopy, IconEdit, IconHistory, IconKey, IconPlus, IconSend, IconTrash, IconWebhook } from '@tabler/icons-react';
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
import { Trans, useTranslation } from 'react-i18next';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { EmptyState, Hint, PageHeader, QueryState, StatusBadge } from '../components/common';
import { BindingsForm, loadBindings } from '../components/RunDialog';
import { fmtDate, fmtNumber, fmtRelative } from '../format';
import { confirmDanger } from '../components/confirm';
import { appUrl } from '../basePath';
import { RunModeField } from '../components/RunModeField';

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

const toDraft = (tr: WebhookTrigger): Draft => ({
  id: tr.id,
  owner: tr.owner,
  name: tr.name,
  description: tr.description ?? '',
  processId: tr.processId,
  processVersion: tr.processVersion ?? null,
  enabled: tr.enabled,
  dryRun: tr.dryRun,
  inputMapping: tr.inputMapping,
  bindings: tr.bindings,
  authMode: tr.authMode,
  allowedCidrs: tr.allowedCidrs,
  allowedHeaders: tr.allowedHeaders,
  rateLimitPerMinute: tr.rateLimitPerMinute,
  dedupeSeconds: tr.dedupeSeconds,
  skipIfRunning: tr.skipIfRunning,
});

/** The JSON body of the Gatus custom alert in docs/GATUS.md (placeholders already replaced). */
// i18n-ignore: sample payload as Gatus sends it
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

const AUTH_MODES: WebhookAuthMode[] = ['token', 'hmac', 'either'];

const hookUrl = (tr: Pick<WebhookTrigger, 'path'>) => appUrl(tr.path);

export function TriggersPage() {
  const { t } = useTranslation(['triggers', 'common']);
  const qc = useQueryClient();
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
      notifyError(e, t('notSaved'));
      return false;
    }
  };

  const rotate = async (tr: WebhookTrigger) => {
    if (!(await confirmDanger({ action: 'rotate', message: t('rotateConfirm', { name: tr.name }) }))) return;
    try {
      setSecret(await post<WebhookTriggerSecret>(`/triggers/${tr.id}/rotate`));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft(emptyDraft())}>
            {t('new')}
          </Button>
        }
      />
      <QueryState query={triggers} />
      {triggers.data?.length === 0 && (
        <EmptyState
          icon={IconWebhook}
          title={t('emptyState.title')}
          action={
            <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft(emptyDraft())}>
              {t('emptyState.action')}
            </Button>
          }
        >
          {t('emptyState.text')}
        </EmptyState>
      )}
      {!!triggers.data?.length && (
        <div className="table-scroll">
          <Table highlightOnHover fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('table.active')}</Table.Th>
                <Table.Th>{t('table.name')}</Table.Th>
                <Table.Th>{t('table.security')}</Table.Th>
                <Table.Th>{t('table.lastCall')}</Table.Th>
                <Table.Th>{t('table.runsStarted')}</Table.Th>
                <Table.Th>{t('table.lastResult')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {triggers.data.map((tr) => (
                <Table.Tr key={tr.id}>
                  <Table.Td>
                    <Switch
                      size="xs"
                      checked={tr.enabled}
                      disabled={!tr.canEdit}
                      onChange={(e) => save({ ...toDraft(tr), enabled: e.currentTarget.checked })}
                      aria-label={t('enabled')}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {tr.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      <Link to={`/processes/${tr.processId}`}>{tr.processName ?? tr.processId}</Link>
                      {tr.processVersion ? ` v${tr.processVersion}` : ''} · {t('runsAs', { owner: tr.owner })}
                      {tr.dryRun && (
                        <Badge ml={4} size="xs" color="yellow" variant="light">
                          {t('common:status.dryrun')}
                        </Badge>
                      )}
                    </Text>
                    <Text size="xs" c="dimmed" className="mono">
                      POST {tr.path}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" fw={500} className="nowrap">
                      {t(`auth.short.${tr.authMode}`)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t('secretLine', { prefix: tr.secretPrefix, rate: tr.rateLimitPerMinute })}
                      {tr.dedupeSeconds ? ` · ${t('dedupeLine', { seconds: tr.dedupeSeconds })}` : ''}
                      {tr.allowedCidrs.length ? ` · ${tr.allowedCidrs.join(', ')}` : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    {tr.lastRunId ? (
                      <Anchor size="sm" component={Link} to={`/runs/${tr.lastRunId}`} underline="never" c="var(--mantine-color-text)">
                        <Stack gap={2} align="flex-start">
                          {tr.lastRunStatus && <StatusBadge status={tr.lastRunStatus} size="xs" />}
                          <Text size="xs">{fmtRelative(tr.lastFiredAt)}</Text>
                        </Stack>
                      </Anchor>
                    ) : (
                      <Text size="xs">{fmtRelative(tr.lastFiredAt)}</Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{fmtNumber(tr.fireCount)}</Text>
                    {tr.rejectedCount > 0 && (
                      <Tooltip label={t('lastRejection', { date: fmtDate(tr.lastRejectedAt), reason: tr.lastRejectedReason ?? '' })}>
                        <Text size="xs" c="orange">
                          {t('rejected', { count: tr.rejectedCount })}
                        </Text>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c={tr.lastResult && tr.lastResult !== 'started' ? 'orange' : 'dimmed'} lineClamp={2} maw={260}>
                      {tr.lastResult ?? '–'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={2} wrap="nowrap" justify="flex-end">
                      <Tooltip label={t('history.action')}>
                        <ActionIcon variant="subtle" onClick={() => setHistory(tr)} aria-label={t('history.actionFor', { name: tr.name })}>
                          <IconHistory size={16} />
                        </ActionIcon>
                      </Tooltip>
                      {tr.canEdit && (
                        <>
                          <Tooltip label={t('test.action')}>
                            <ActionIcon
                              variant="subtle"
                              onClick={() => setTesting(tr)}
                              aria-label={t('test.actionFor', { name: tr.name })}
                              disabled={!tr.enabled}
                            >
                              <IconSend size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <Tooltip label={t('rotate')}>
                            <ActionIcon variant="subtle" onClick={() => rotate(tr)} aria-label={t('rotateFor', { name: tr.name })}>
                              <IconKey size={16} />
                            </ActionIcon>
                          </Tooltip>
                          <ActionIcon variant="subtle" onClick={() => setDraft(toDraft(tr))} aria-label={t('editFor', { name: tr.name })}>
                            <IconEdit size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            color="red"
                            aria-label={t('deleteFor', { name: tr.name })}
                            onClick={async () => {
                              if (!(await confirmDanger({ action: 'delete', message: t('deleteConfirm', { name: tr.name }) }))) return;
                              await del(`/triggers/${tr.id}`).catch(notifyError);
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
              if (d.id) notifyOk(t('saved'));
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
  const { t } = useTranslation(['triggers', 'common']);
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
      setD((x) => ({ ...x, bindings: loadBindings(proc.data.id), name: x.name || t('form.defaultName', { process: proc.data.name }) }));
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
    <Modal opened onClose={onClose} title={draft.id ? t('form.editTitle') : t('new')} size="xl">
      <Stack>
        <Group grow align="flex-start">
          <Select
            label={t('form.process')}
            required
            searchable
            data={(processes.data ?? []).filter((p) => p.permissions.includes('run')).map((p) => ({ value: p.id, label: p.name }))}
            value={d.processId || null}
            onChange={(v) => setD({ ...d, processId: v ?? '', inputMapping: {}, bindings: {}, processVersion: null })}
          />
          <NumberInput
            label={t('form.pinVersion')}
            description={t('form.pinVersionHint')}
            min={1}
            max={proc.data?.currentVersion}
            value={d.processVersion ?? ''}
            onChange={(v) => setD({ ...d, processVersion: typeof v === 'number' ? v : null })}
          />
        </Group>
        <TextInput label={t('form.name')} required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} />
        <Textarea
          label={t('form.description')}
          autosize
          minRows={1}
          value={d.description ?? ''}
          onChange={(e) => setD({ ...d, description: e.currentTarget.value })}
        />
        {proc.data && (
          <>
            <Divider label={t('form.connections')} labelPosition="left" />
            <BindingsForm process={proc.data} value={d.bindings} onChange={(b) => setD({ ...d, bindings: b })} />
            <Divider label={t('form.inputs')} labelPosition="left" />
            <Text size="xs" c="dimmed">
              <Trans t={t} i18nKey="form.inputsHint" values={{ example: '"fixed value"' }} components={{ c: <Code /> }} />
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
                  {t('form.mapGatus')}
                </Button>
              </Group>
            )}
            {inputs.length === 0 && (
              <Text size="sm" c="dimmed">
                {t('form.noInputs')}
              </Text>
            )}
            {inputs.map((i) => (
              <Group key={i.name} align="flex-start" wrap="nowrap" gap="xs">
                <TextInput
                  style={{ flex: 1 }}
                  size="xs"
                  label={t(i.required ? 'form.inputLabelRequired' : 'form.inputLabel', { name: i.label ?? i.name, type: i.type })}
                  placeholder={t('form.inputPlaceholder', { name: i.name })}
                  classNames={{ input: 'mono' }}
                  value={d.inputMapping[i.name] ?? ''}
                  onChange={(e) => setMapping(i.name, e.currentTarget.value)}
                  error={preview.data?.errors[i.name]}
                />
                <Text size="xs" c="dimmed" mt={26} w={200} truncate title={JSON.stringify(preview.data?.inputs[i.name])}>
                  {d.inputMapping[i.name]
                    ? `→ ${preview.data && i.name in preview.data.inputs ? JSON.stringify(preview.data.inputs[i.name]) : '–'}`
                    : t('form.default')}
                </Text>
              </Group>
            ))}
            <JsonInput
              label={t('form.sample')}
              description={t('form.sampleHint')}
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
        <Divider label={t('form.security')} labelPosition="left" />
        <div>
          <Text size="sm" fw={500} mb={4}>
            {t('form.authentication')}
          </Text>
          <SegmentedControl
            size="xs"
            value={d.authMode}
            onChange={(v) => setD({ ...d, authMode: v as WebhookAuthMode })}
            data={AUTH_MODES.map((m) => ({ value: m, label: t(`auth.mode.${m}`) }))}
          />
          <Text size="xs" c="dimmed" mt={4}>
            <Trans
              t={t}
              i18nKey="form.authHint"
              components={{
                bearer: <Code>{'Authorization: Bearer <secret>'}</Code>,
                token: <Code>X-Steward-Token</Code>,
                sig: <Code>{t('form.sigHeader')}</Code>,
              }}
            />
          </Text>
        </div>
        <TagsInput
          label={t('form.cidrs')}
          description={t('form.cidrsHint')}
          value={d.allowedCidrs}
          onChange={(v) => setD({ ...d, allowedCidrs: v })}
          clearable
        />
        <TagsInput
          label={t('form.headers')}
          description={t('form.headersHint')}
          value={d.allowedHeaders}
          onChange={(v) => setD({ ...d, allowedHeaders: v.map((h) => h.toLowerCase()) })}
          clearable
        />
        <Group grow align="flex-start">
          <NumberInput
            label={t('form.rateLimit')}
            min={1}
            max={600}
            value={d.rateLimitPerMinute}
            onChange={(v) => setD({ ...d, rateLimitPerMinute: Number(v) || 1 })}
          />
          <NumberInput
            label={t('form.dedupe')}
            description={t('form.dedupeHint')}
            min={0}
            max={86400}
            value={d.dedupeSeconds}
            onChange={(v) => setD({ ...d, dedupeSeconds: Number(v) || 0 })}
          />
        </Group>
        <Switch label={t('form.skipIfRunning')} checked={d.skipIfRunning} onChange={(e) => setD({ ...d, skipIfRunning: e.currentTarget.checked })} />
        <RunModeField modes={['dry', 'real']} value={d.dryRun ? 'dry' : 'real'} onChange={(m) => setD({ ...d, dryRun: m === 'dry' })} />
        <Switch label={t('enabled')} checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <Hint>{draft.owner ? <Trans t={t} i18nKey="form.rightsOf" values={{ owner: draft.owner }} components={{ b: <b /> }} /> : t('form.rightsOfYou')}</Hint>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => onSave(d)} disabled={!d.processId || !d.name}>
            {draft.id ? t('common:save') : t('form.create')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function CopyBlock({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation('common');
  return (
    <div>
      <Group justify="space-between" mb={2}>
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <CopyButton value={text}>
          {({ copied, copy }) => (
            <Button size="compact-xs" variant="subtle" leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>
              {copied ? t('copied') : t('copy')}
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
  const { t } = useTranslation('triggers');
  const tr = created.trigger;
  const url = hookUrl(tr);
  const sample = JSON.stringify({
    event: 'TRIGGERED',
    name: 'Historian API',
    group: 'plant',
    url: 'https://apps.example.com/historian/health',
    errors: 'test',
  });
  const curl =
    tr.authMode === 'hmac'
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
    <Modal opened onClose={onClose} title={t('secret.title', { name: tr.name })} size="xl" closeOnClickOutside={false}>
      <Stack>
        <Alert color="orange" title={t('secret.copyNow')}>
          <Trans t={t} i18nKey="secret.copyNowText" values={{ name: 'STEWARD_WEBHOOK_SECRET' }} components={{ c: <Code /> }} />
        </Alert>
        <CopyBlock label={t('secret.secret')} text={created.secret} />
        <CopyBlock label={t('secret.url')} text={url} />
        <CopyBlock label={tr.authMode === 'hmac' ? t('secret.curlHmac') : t('secret.curl')} text={curl} />
        {tr.authMode !== 'hmac' && <CopyBlock label={t('secret.gatus')} text={gatus} />}
        <Text size="xs" c="dimmed">
          <Trans
            t={t}
            i18nKey="secret.hostsHint"
            values={{ name: 'SM_ALLOWED_HOSTS', doc: 'docs/GATUS.md' }}
            components={{
              c: <Code />,
              a: <Anchor href="https://github.com/TwiN/gatus#configuring-custom-alerts" target="_blank" rel="noreferrer" size="xs" />,
            }}
          />
        </Text>
        <Group justify="flex-end">
          <Button onClick={onClose}>{t('secret.stored')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TestModal({ trigger, onClose }: { trigger: WebhookTrigger; onClose: () => void }) {
  const { t } = useTranslation(['triggers', 'common']);
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
      notifyError(e, t('test.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('test.title', { name: trigger.name })} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          {t('test.intro')}
        </Text>
        <JsonInput
          label={t('test.payload')}
          autosize
          minRows={6}
          maxRows={16}
          value={payload}
          onChange={setPayload}
          error={parsed.error}
          classNames={{ input: 'mono' }}
        />
        <Switch label={t('form.dryRun')} checked={dryRun || trigger.dryRun} disabled={trigger.dryRun} onChange={(e) => setDryRun(e.currentTarget.checked)} />
        {result && (
          <Alert color={result.status === 202 && result.response.runId ? 'green' : 'orange'} title={`HTTP ${result.status}`}>
            <Stack gap={4}>
              <Text size="sm">
                {result.response.runId ? (
                  <>
                    {t('test.runStarted')}{' '}
                    <Anchor inherit component={Link} to={`/runs/${result.response.runId}`}>
                      {result.response.runId}
                    </Anchor>
                  </>
                ) : (
                  (result.response.skipped && t('test.skipped', { reason: result.response.skipped })) || result.response.error
                )}
              </Text>
              <Text size="xs" c="dimmed">
                {t('test.mappedInputs')}
              </Text>
              <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {JSON.stringify(result.inputs, null, 2)}
              </Code>
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:close')}
          </Button>
          <Button leftSection={<IconSend size={14} />} onClick={send} loading={busy} disabled={!!parsed.error}>
            {t('test.send')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function HistoryModal({ trigger, onClose }: { trigger: WebhookTrigger; onClose: () => void }) {
  const { t } = useTranslation('triggers');
  const fires = useQuery({ queryKey: ['trigger-fires', trigger.id], queryFn: () => get<WebhookFire[]>(`/triggers/${trigger.id}/fires?limit=100`) });
  const rows = useMemo(() => fires.data ?? [], [fires.data]);
  return (
    <Modal opened onClose={onClose} title={t('history.title', { name: trigger.name })} size="xl">
      <Text size="xs" c="dimmed" mb="xs">
        {trigger.rejectedCount ? t('history.introCount', { count: trigger.rejectedCount }) : t('history.intro')}
      </Text>
      {rows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('history.none')}
        </Text>
      )}
      {rows.length > 0 && (
        <div className="table-scroll">
          <Table fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('history.time')}</Table.Th>
                <Table.Th>{t('history.from')}</Table.Th>
                <Table.Th>{t('history.outcome')}</Table.Th>
                <Table.Th>{t('history.run')}</Table.Th>
                <Table.Th>{t('history.payloadHash')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((f) => (
                <Table.Tr key={f.id}>
                  <Table.Td className="nowrap">{fmtDate(f.ts)}</Table.Td>
                  <Table.Td className="mono">{f.sourceIp}</Table.Td>
                  <Table.Td>
                    <Badge size="xs" variant="light" color={f.outcome === 'started' ? 'green' : f.outcome === 'skipped' ? 'gray' : 'red'}>
                      {t(`history.outcomes.${f.outcome}`)}
                    </Badge>
                    {f.test && (
                      <Badge ml={4} size="xs" variant="outline">
                        {t('history.test')}
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

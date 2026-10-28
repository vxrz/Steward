import { useEffect, useState } from 'react';
import { Alert, Button, Code, CopyButton, FileButton, Group, Modal, NumberInput, Select, Stack, Table, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import { IconCheck, IconCopy, IconUpload } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import {
  MONITOR_STATUSES,
  type MonitorDetail,
  type MonitorPlatformReference,
  type MonitorSaveResult,
  type MonitorStatus,
  type TemplateParam,
} from '@sm/shared';
import { useTranslation } from 'react-i18next';
import { get, notifyError, post } from '../../api';
import { fmtDate, fmtNumber } from '../../format';
import { monitorStatusLabel } from './status';
import { appUrl } from '../../basePath';
import { PlatformChoices, chosenPlatforms, platformsComplete } from './PlatformChoices';

export function CopyBlock({ label, text }: { label: string; text: string }) {
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

/** Absolute URL of this Steward (origin + base path) for copy-paste snippets. */
export const origin = () => appUrl();

export function heartbeatCurl(path: string, hmac = false): string {
  const url = `${origin()}${path}`;
  const body = JSON.stringify({ value: 42.7, ts: '2026-10-22T08:15:00Z', data: { unit: 'kW' } });
  if (hmac) {
    return `BODY='${body}'\nSIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$STEWARD_HEARTBEAT_SECRET" | sed 's/^.* //')\ncurl -sS -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "X-Steward-Signature: sha256=$SIG" \\\n  --data "$BODY"`;
  }
  return `curl -sS -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $STEWARD_HEARTBEAT_SECRET" \\\n  --data '${body}'`;
}

export function gatewayCurl(keys: string[]): string {
  const reports = (keys.length ? keys : ['m17.powermeter', 'm17.machine'])
    .slice(0, 3)
    .map((k, i) => ({ key: k, ts: '2026-10-22T08:15:00Z', value: i === 0 ? 42.7 : 1450 }));
  return `curl -sS -X POST '${origin()}/api/hooks/monitors' \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $STEWARD_GATEWAY_SECRET" \\\n  --data '${JSON.stringify({ reports })}'`;
}

/** Shows the secrets of new heartbeat endpoints once. */
export function SecretsModal({ result, onClose }: { result: Pick<MonitorSaveResult, 'secrets'> & { monitor?: MonitorDetail }; onClose: () => void }) {
  const names = new Map((result.monitor?.definition.checks ?? []).map((c) => [c.id, c.name]));
  const { t } = useTranslation('monitors');
  return (
    <Modal opened onClose={onClose} title={t('secrets.title')} size="xl" closeOnClickOutside={false}>
      <Stack>
        <Alert color="orange" title={t('secrets.copyNow')}>
          {t('secrets.copyNowText')}
        </Alert>
        {result.secrets.map((s) => (
          <Stack key={s.checkId} gap={6}>
            <Text fw={600}>{names.get(s.checkId) ?? s.checkId}</Text>
            <CopyBlock label={t('secrets.secret')} text={s.secret} />
            <CopyBlock label={t('secrets.url')} text={`${origin()}${s.path}`} />
            <CopyBlock label={t('secrets.curl')} text={heartbeatCurl(s.path)} />
          </Stack>
        ))}
        <Group justify="flex-end">
          <Button onClick={onClose}>{t('secrets.stored')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function MaintenanceModal({ monitor, onClose, onSaved }: { monitor: MonitorDetail; onClose: () => void; onSaved: () => void }) {
  const [start, setStart] = useState(toLocalInput(new Date()));
  const [hours, setHours] = useState<number>(2);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation(['monitors', 'common']);
  const save = async () => {
    setBusy(true);
    try {
      const s = new Date(start);
      await post(`/monitors/${monitor.id}/maintenance`, { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + hours * 3600000).toISOString(), reason });
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e, t('maintenance.notPlanned'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('maintenance.title', { name: monitor.name })}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('maintenance.intro')}
        </Text>
        <TextInput type="datetime-local" label={t('maintenance.start')} value={start} onChange={(e) => setStart(e.currentTarget.value)} />
        <NumberInput
          label={t('maintenance.duration')}
          min={0.25}
          max={744}
          step={0.5}
          decimalScale={2}
          value={hours}
          onChange={(v) => setHours(Number(v) || 1)}
        />
        <Textarea label={t('maintenance.reason')} required autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!reason.trim()}>
            {t('maintenance.plan')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function AcknowledgeModal({ monitor, onClose, onSaved }: { monitor: MonitorDetail; onClose: () => void; onSaved: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation(['monitors', 'common']);
  return (
    <Modal opened onClose={onClose} title={t('acknowledge.title', { name: monitor.name })}>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('acknowledge.intro')}
        </Text>
        <Textarea label={t('acknowledge.comment')} autosize minRows={2} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/monitors/${monitor.id}/acknowledge`, { comment });
                onSaved();
                onClose();
              } catch (e) {
                notifyError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('acknowledge.button')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Create instances of a template: one with a form, or many from CSV. */
export function InstantiateModal({
  template,
  onClose,
  onCreated,
}: {
  template: MonitorDetail;
  onClose: () => void;
  onCreated: (r: MonitorSaveResult[]) => void;
}) {
  const params = (template.definition.parameters ?? []) as TemplateParam[];
  const [values, setValues] = useState<Record<string, string | number>>(() => Object.fromEntries(params.map((p) => [p.name, p.default ?? ''])));
  const [csv, setCsv] = useState(`name,${params.map((p) => p.name).join(',')}\n`);
  const [tab, setTab] = useState<string | null>('form');
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation(['monitors', 'common']);
  const create = async () => {
    setBusy(true);
    try {
      const body = tab === 'csv' ? { csv } : { rows: [{ params: values }] };
      onCreated(await post<MonitorSaveResult[]>(`/monitors/${template.id}/instances`, body));
      onClose();
    } catch (e) {
      notifyError(e, t('instances.notCreated'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('instances.title', { name: template.name })} size="lg">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="form">{t('instances.one')}</Tabs.Tab>
          <Tabs.Tab value="csv">{t('instances.csv')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="form" pt="sm">
          <Stack gap="xs">
            {params.map((p) =>
              p.type === 'number' ? (
                <NumberInput
                  key={p.name}
                  label={p.label ?? p.name}
                  description={p.description}
                  required={p.required && p.default === undefined}
                  value={values[p.name] ?? ''}
                  onChange={(v) => setValues({ ...values, [p.name]: v })}
                />
              ) : (
                <TextInput
                  key={p.name}
                  label={p.label ?? p.name}
                  description={p.description}
                  required={p.required && p.default === undefined}
                  value={String(values[p.name] ?? '')}
                  onChange={(e) => setValues({ ...values, [p.name]: e.currentTarget.value })}
                />
              ),
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="csv" pt="sm">
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              {t('instances.csvHint')}
            </Text>
            <Textarea
              autosize
              minRows={6}
              maxRows={16}
              value={csv}
              onChange={(e) => setCsv(e.currentTarget.value)}
              classNames={{ input: 'mono' }}
              aria-label="CSV"
            />
            <FileButton accept=".csv,text/csv" onChange={async (f) => f && setCsv(await f.text())}>
              {(props) => (
                <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} w="fit-content">
                  {t('instances.loadCsv')}
                </Button>
              )}
            </FileButton>
          </Stack>
        </Tabs.Panel>
      </Tabs>
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onClose}>
          {t('common:cancel')}
        </Button>
        <Button onClick={create} loading={busy}>
          {t('instances.create')}
        </Button>
      </Group>
    </Modal>
  );
}

interface Example {
  file: string;
  kind: string;
  key: string | null;
  name: string;
  description: string;
}

/** The platform references of a monitor file, looked up while the user picks an example or edits YAML. */
function usePlatformRefs(source: { example: string } | { yaml: string } | null) {
  const [refs, setRefs] = useState<MonitorPlatformReference[]>([]);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const key = source ? JSON.stringify(source) : '';
  useEffect(() => {
    setRefs([]);
    setChoices({});
    if (!source) return;
    let live = true;
    // a short pause while typing; an unreadable file shows its error on import instead
    const timer = setTimeout(
      () => {
        const req =
          'example' in source
            ? post<{ platforms: MonitorPlatformReference[] }>(`/monitors/examples/${encodeURIComponent(source.example)}/preview`)
            : post<{ platforms: MonitorPlatformReference[] }>('/monitors/import/preview', { yaml: source.yaml });
        req.then((r) => live && setRefs(r.platforms)).catch(() => undefined);
      },
      'example' in source ? 0 : 500,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `source`
  }, [key]);
  return { refs, choices, setChoices, platforms: chosenPlatforms(refs, choices), complete: platformsComplete(refs, choices) };
}

export function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (r: MonitorSaveResult) => void }) {
  const examples = useQuery({ queryKey: ['monitor-examples'], queryFn: () => get<Example[]>('/monitors/examples') });
  const [yaml, setYaml] = useState('');
  const [example, setExample] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation('monitors');
  const exampleRefs = usePlatformRefs(example ? { example } : null);
  const yamlRefs = usePlatformRefs(yaml.trim() ? { yaml } : null);
  const run = async (fn: () => Promise<MonitorSaveResult>) => {
    setBusy(true);
    try {
      onImported(await fn());
      onClose();
    } catch (e) {
      notifyError(e, t('importDialog.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('importDialog.title')} size="lg">
      <Stack>
        <Select
          label={t('importDialog.library')}
          placeholder={t('importDialog.choose')}
          data={(examples.data ?? []).map((e) => ({
            value: e.file,
            label: e.kind === 'monitorTemplate' ? t('importDialog.templateName', { name: e.name }) : e.name,
          }))}
          value={example}
          onChange={setExample}
        />
        {example && (
          <Text size="xs" c="dimmed">
            {examples.data?.find((e) => e.file === example)?.description}
          </Text>
        )}
        <PlatformChoices refs={exampleRefs.refs} choices={exampleRefs.choices} onChange={exampleRefs.setChoices} />
        <Group justify="flex-end">
          <Button
            disabled={!example || !exampleRefs.complete}
            loading={busy}
            onClick={() => run(() => post(`/monitors/examples/${encodeURIComponent(example!)}`, { platforms: exampleRefs.platforms }))}
          >
            {t('importDialog.importExample')}
          </Button>
        </Group>
        <Textarea
          label={t('importDialog.paste')}
          autosize
          minRows={6}
          maxRows={18}
          value={yaml}
          onChange={(e) => setYaml(e.currentTarget.value)}
          classNames={{ input: 'mono' }}
        />
        <PlatformChoices refs={yamlRefs.refs} choices={yamlRefs.choices} onChange={yamlRefs.setChoices} />
        <Group justify="space-between">
          <FileButton accept=".yaml,.yml" onChange={async (f) => f && setYaml(await f.text())}>
            {(props) => (
              <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />}>
                {t('importDialog.loadFile')}
              </Button>
            )}
          </FileButton>
          <Button
            disabled={!yaml.trim() || !yamlRefs.complete}
            loading={busy}
            onClick={() => run(() => post('/monitors/import', { yaml, platforms: yamlRefs.platforms }))}
          >
            {t('importDialog.importYaml')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ResultsTable({ rows }: { rows: { ts: string; status: string; message: string; durationMs?: number | null }[] }) {
  const { t } = useTranslation('monitors');
  return (
    <div className="table-scroll">
      <Table fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('history.time')}</Table.Th>
            <Table.Th>{t('history.result')}</Table.Th>
            <Table.Th>{t('history.duration')}</Table.Th>
            <Table.Th>{t('history.message')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={i}>
              <Table.Td className="nowrap">{fmtDate(r.ts)}</Table.Td>
              <Table.Td>{(MONITOR_STATUSES as readonly string[]).includes(r.status) ? monitorStatusLabel(r.status as MonitorStatus) : r.status}</Table.Td>
              <Table.Td>{r.durationMs != null ? `${fmtNumber(r.durationMs)} ms` : ''}</Table.Td>
              <Table.Td>{r.message}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

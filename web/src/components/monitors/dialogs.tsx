import { useState } from 'react';
import { Alert, Button, Code, CopyButton, FileButton, Group, Modal, NumberInput, Select, Stack, Table, Tabs, Text, TextInput, Textarea } from '@mantine/core';
import { IconCheck, IconCopy, IconUpload } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { MonitorDetail, MonitorSaveResult, TemplateParam } from '@sm/shared';
import { get, notifyError, post } from '../../api';

export function CopyBlock({ label, text }: { label: string; text: string }) {
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

export const origin = () => window.location.origin;

export function heartbeatCurl(path: string, hmac = false): string {
  const url = `${origin()}${path}`;
  const body = JSON.stringify({ value: 42.7, ts: '2026-10-22T08:15:00Z', data: { unit: 'kW' } });
  if (hmac) {
    return `BODY='${body}'\nSIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$STEWARD_HEARTBEAT_SECRET" | sed 's/^.* //')\ncurl -sS -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "X-Steward-Signature: sha256=$SIG" \\\n  --data "$BODY"`;
  }
  return `curl -sS -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $STEWARD_HEARTBEAT_SECRET" \\\n  --data '${body}'`;
}

export function gatewayCurl(keys: string[]): string {
  const reports = (keys.length ? keys : ['m17.powermeter', 'm17.machine']).slice(0, 3).map((k, i) => ({ key: k, ts: '2026-10-22T08:15:00Z', value: i === 0 ? 42.7 : 1450 }));
  return `curl -sS -X POST '${origin()}/api/hooks/monitors' \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $STEWARD_GATEWAY_SECRET" \\\n  --data '${JSON.stringify({ reports })}'`;
}

/** Shows the secrets of new heartbeat endpoints once. */
export function SecretsModal({ result, onClose }: { result: Pick<MonitorSaveResult, 'secrets'> & { monitor?: MonitorDetail }; onClose: () => void }) {
  const names = new Map((result.monitor?.definition.checks ?? []).map((c) => [c.id, c.name]));
  return (
    <Modal opened onClose={onClose} title="Heartbeat secrets" size="xl" closeOnClickOutside={false}>
      <Stack>
        <Alert color="orange" title="Copy the secrets now">
          Each secret is shown only once and cannot be recovered. Store it in the reporting system (for example the IoT gateway). If one is lost or leaked, rotate it on the check.
        </Alert>
        {result.secrets.map((s) => (
          <Stack key={s.checkId} gap={6}>
            <Text fw={600}>{names.get(s.checkId) ?? s.checkId}</Text>
            <CopyBlock label="Secret" text={s.secret} />
            <CopyBlock label="URL" text={`${origin()}${s.path}`} />
            <CopyBlock label="Test with curl" text={heartbeatCurl(s.path)} />
          </Stack>
        ))}
        <Group justify="flex-end">
          <Button onClick={onClose}>I have stored the secrets</Button>
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
  const save = async () => {
    setBusy(true);
    try {
      const s = new Date(start);
      await post(`/monitors/${monitor.id}/maintenance`, { startsAt: s.toISOString(), endsAt: new Date(s.getTime() + hours * 3600000).toISOString(), reason });
      onSaved();
      onClose();
    } catch (e) {
      notifyError(e, 'Maintenance not planned');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={`Maintenance – ${monitor.name}`}>
      <Stack>
        <Text size="sm" c="dimmed">
          Checks keep running and their results are recorded, but the monitor shows "maintenance", notifications and runbooks are silenced, and the time does not count against uptime.
        </Text>
        <TextInput type="datetime-local" label="Start" value={start} onChange={(e) => setStart(e.currentTarget.value)} />
        <NumberInput label="Duration (hours)" min={0.25} max={744} step={0.5} decimalScale={2} value={hours} onChange={(v) => setHours(Number(v) || 1)} />
        <Textarea label="Reason" required autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!reason.trim()}>
            Plan maintenance
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function AcknowledgeModal({ monitor, onClose, onSaved }: { monitor: MonitorDetail; onClose: () => void; onSaved: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal opened onClose={onClose} title={`Acknowledge – ${monitor.name}`}>
      <Stack>
        <Text size="sm" c="dimmed">
          Tells others that someone is working on the problem. Further notifications of this monitor are held back until it is up again.
        </Text>
        <Textarea label="Comment" autosize minRows={2} value={comment} onChange={(e) => setComment(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
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
            Acknowledge
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Create instances of a template: one with a form, or many from CSV. */
export function InstantiateModal({ template, onClose, onCreated }: { template: MonitorDetail; onClose: () => void; onCreated: (r: MonitorSaveResult[]) => void }) {
  const params = (template.definition.parameters ?? []) as TemplateParam[];
  const [values, setValues] = useState<Record<string, string | number>>(() => Object.fromEntries(params.map((p) => [p.name, p.default ?? ''])));
  const [csv, setCsv] = useState(`name,${params.map((p) => p.name).join(',')}\n`);
  const [tab, setTab] = useState<string | null>('form');
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const body = tab === 'csv' ? { csv } : { rows: [{ params: values }] };
      onCreated(await post<MonitorSaveResult[]>(`/monitors/${template.id}/instances`, body));
      onClose();
    } catch (e) {
      notifyError(e, 'Instances not created');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={`New monitors from "${template.name}"`} size="lg">
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="form">One monitor</Tabs.Tab>
          <Tabs.Tab value="csv">Many from CSV</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="form" pt="sm">
          <Stack gap="xs">
            {params.map((p) =>
              p.type === 'number' ? (
                <NumberInput key={p.name} label={p.label ?? p.name} description={p.description} required={p.required && p.default === undefined} value={values[p.name] ?? ''} onChange={(v) => setValues({ ...values, [p.name]: v })} />
              ) : (
                <TextInput key={p.name} label={p.label ?? p.name} description={p.description} required={p.required && p.default === undefined} value={String(values[p.name] ?? '')} onChange={(e) => setValues({ ...values, [p.name]: e.currentTarget.value })} />
              ),
            )}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="csv" pt="sm">
          <Stack gap="xs">
            <Text size="sm" c="dimmed">
              One line per monitor. Columns: the parameter names, plus optional "name" and "key". Comma or semicolon separated; the first line is the header.
            </Text>
            <Textarea autosize minRows={6} maxRows={16} value={csv} onChange={(e) => setCsv(e.currentTarget.value)} classNames={{ input: 'mono' }} aria-label="CSV" />
            <FileButton accept=".csv,text/csv" onChange={async (f) => f && setCsv(await f.text())}>
              {(props) => (
                <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />} w="fit-content">
                  Load a CSV file
                </Button>
              )}
            </FileButton>
          </Stack>
        </Tabs.Panel>
      </Tabs>
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={create} loading={busy}>
          Create
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

export function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (r: MonitorSaveResult) => void }) {
  const examples = useQuery({ queryKey: ['monitor-examples'], queryFn: () => get<Example[]>('/monitors/examples') });
  const [yaml, setYaml] = useState('');
  const [example, setExample] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<MonitorSaveResult>) => {
    setBusy(true);
    try {
      onImported(await fn());
      onClose();
    } catch (e) {
      notifyError(e, 'Import failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title="Import a monitor" size="lg">
      <Stack>
        <Select
          label="From the example library"
          placeholder="Choose an example"
          data={(examples.data ?? []).map((e) => ({ value: e.file, label: `${e.name}${e.kind === 'monitorTemplate' ? ' (template)' : ''}` }))}
          value={example}
          onChange={setExample}
        />
        {example && <Text size="xs" c="dimmed">{examples.data?.find((e) => e.file === example)?.description}</Text>}
        <Group justify="flex-end">
          <Button disabled={!example} loading={busy} onClick={() => run(() => post(`/monitors/examples/${encodeURIComponent(example!)}`))}>
            Import example
          </Button>
        </Group>
        <Textarea label="Or paste YAML" autosize minRows={6} maxRows={18} value={yaml} onChange={(e) => setYaml(e.currentTarget.value)} classNames={{ input: 'mono' }} />
        <Group justify="space-between">
          <FileButton accept=".yaml,.yml" onChange={async (f) => f && setYaml(await f.text())}>
            {(props) => (
              <Button {...props} size="xs" variant="light" leftSection={<IconUpload size={14} />}>
                Load a file
              </Button>
            )}
          </FileButton>
          <Button disabled={!yaml.trim()} loading={busy} onClick={() => run(() => post('/monitors/import', { yaml }))}>
            Import YAML
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ResultsTable({ rows }: { rows: { ts: string; status: string; message: string; durationMs?: number | null }[] }) {
  return (
    <div className="table-scroll">
      <Table fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Time</Table.Th>
            <Table.Th>Result</Table.Th>
            <Table.Th>Duration</Table.Th>
            <Table.Th>Message</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r, i) => (
            <Table.Tr key={i}>
              <Table.Td className="nowrap">{new Date(r.ts).toLocaleString()}</Table.Td>
              <Table.Td>{r.status}</Table.Td>
              <Table.Td>{r.durationMs != null ? `${r.durationMs} ms` : ''}</Table.Td>
              <Table.Td>{r.message}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

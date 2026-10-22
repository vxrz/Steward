import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, Group, Modal, NumberInput, SegmentedControl, Stack, Switch, Table, TagsInput, Text, TextInput, Textarea, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { IconEdit, IconFileImport, IconKey, IconLayoutGrid, IconPlus, IconTrash } from '@tabler/icons-react';
import { MONITOR_STATUSES, type MonitorDetail, type MonitorGateway, type MonitorSaveResult, type MonitorSummary } from '@sm/shared';
import { del, get, notifyError, post, put } from '../api';
import { Hint, PageHeader } from '../components/common';
import { fmtDate, fmtRelative } from '../format';
import { MONITOR_COLORS, MONITOR_LABELS, MonitorStatusBadge, causeText, fmtUptime } from '../components/monitors/status';
import { CopyBlock, ImportModal, InstantiateModal, SecretsModal, gatewayCurl } from '../components/monitors/dialogs';

interface Meta {
  canCreate: boolean;
  gatewayPath: string;
}

export function MonitorsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'monitors';
  const meta = useQuery({ queryKey: ['monitor-meta'], queryFn: () => get<Meta>('/monitors/meta') });
  const monitors = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors'), refetchInterval: 10000 });
  const [importing, setImporting] = useState(false);
  const [secrets, setSecrets] = useState<MonitorSaveResult | null>(null);
  const canCreate = !!meta.data?.canCreate;
  const list = monitors.data ?? [];
  const counts = Object.fromEntries(MONITOR_STATUSES.map((s) => [s, list.filter((m) => m.status === s).length]));

  return (
    <>
      <PageHeader
        title="Monitors"
        description="Composable health checks with dependencies: every check runs on its own schedule; links explain failures (root causes) and keep follow-up alerts quiet."
        actions={
          <>
            <Button size="xs" variant="default" leftSection={<IconLayoutGrid size={14} />} component={Link} to="/monitors/wall">
              Status wall
            </Button>
            {canCreate && (
              <>
                <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)}>
                  Import
                </Button>
                <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => navigate('/monitors/new')}>
                  New monitor
                </Button>
              </>
            )}
          </>
        }
      />
      <SegmentedControl
        mb="md"
        size="xs"
        value={tab}
        onChange={(v) => setParams(v === 'monitors' ? {} : { tab: v })}
        data={[
          { value: 'monitors', label: 'Monitors' },
          { value: 'templates', label: 'Templates' },
          ...(canCreate ? [{ value: 'gateways', label: 'Gateways' }] : []),
        ]}
      />
      {tab === 'monitors' && (
        <>
          <Group gap="xs" mb="sm">
            {MONITOR_STATUSES.filter((s) => counts[s]).map((s) => (
              <Badge key={s} color={MONITOR_COLORS[s]} variant="light">
                {counts[s]} {MONITOR_LABELS[s]}
              </Badge>
            ))}
          </Group>
          {monitors.isSuccess && list.length === 0 && (
            <Text c="dimmed" size="sm">
              No monitors yet.{canCreate ? ' Create one, or import an example from the library.' : ''}
            </Text>
          )}
          {list.length > 0 && <MonitorTable monitors={list} />}
        </>
      )}
      {tab === 'templates' && <TemplatesTab canCreate={canCreate} onCreated={(r) => (setSecrets({ monitor: r[0]!.monitor, secrets: r.flatMap((x) => x.secrets) }), qc.invalidateQueries({ queryKey: ['monitors'] }))} />}
      {tab === 'gateways' && canCreate && <GatewaysTab />}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onImported={(r) => {
            qc.invalidateQueries({ queryKey: ['monitors'] });
            if (r.secrets.length) setSecrets(r);
            navigate(`/monitors/${r.monitor.id}`);
          }}
        />
      )}
      {secrets && <SecretsModal result={secrets} onClose={() => setSecrets(null)} />}
    </>
  );
}

function MonitorTable({ monitors }: { monitors: MonitorSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="table-scroll">
      <Table highlightOnHover fz="sm" aria-label="Monitors">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Status</Table.Th>
            <Table.Th>Monitor</Table.Th>
            <Table.Th>Root cause</Table.Th>
            <Table.Th>Uptime 24 h</Table.Th>
            <Table.Th>Uptime 7 d</Table.Th>
            <Table.Th>Last change</Table.Th>
            <Table.Th>Checks</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {monitors.map((m) => (
            <Table.Tr key={m.id} className="clickable" onClick={() => navigate(`/monitors/${m.id}`)}>
              <Table.Td>
                <MonitorStatusBadge status={m.status} />
                {m.acknowledged && (
                  <Badge ml={4} size="xs" variant="outline">
                    acknowledged
                  </Badge>
                )}
              </Table.Td>
              <Table.Td>
                <Anchor component={Link} to={`/monitors/${m.id}`} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                  {m.name}
                </Anchor>
                <Text size="xs" c="dimmed" className="mono">
                  {m.key}
                  {!m.enabled && ' · disabled'}
                  {m.templateId && ' · from template'}
                </Text>
                {m.tags.length > 0 && (
                  <Group gap={4} mt={2}>
                    {m.tags.map((t) => (
                      <Badge key={t} size="xs" variant="default">
                        {t}
                      </Badge>
                    ))}
                  </Group>
                )}
              </Table.Td>
              <Table.Td maw={280}>
                <Text size="xs" c={m.rootCauses.length ? 'red' : 'dimmed'} lineClamp={2}>
                  {m.maintenance ? `Maintenance: ${m.maintenance.reason}` : m.rootCauses.map((c) => causeText(c, m.id)).join(', ') || '–'}
                </Text>
              </Table.Td>
              <Table.Td>{fmtUptime(m.uptime.h24)}</Table.Td>
              <Table.Td>{fmtUptime(m.uptime.d7)}</Table.Td>
              <Table.Td className="nowrap">
                <Tooltip label={fmtDate(m.since)}>
                  <Text size="xs">{fmtRelative(m.since)}</Text>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  {MONITOR_STATUSES.filter((s) => m.counts[s]).map((s) => (
                    <Badge key={s} size="xs" color={MONITOR_COLORS[s]} variant="light" title={MONITOR_LABELS[s]}>
                      {m.counts[s]} {MONITOR_LABELS[s].toLowerCase()}
                    </Badge>
                  ))}
                </Group>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function TemplatesTab({ canCreate, onCreated }: { canCreate: boolean; onCreated: (r: MonitorSaveResult[]) => void }) {
  const navigate = useNavigate();
  const templates = useQuery({ queryKey: ['monitor-templates'], queryFn: () => get<MonitorSummary[]>('/monitors?templates=1') });
  const all = useQuery({ queryKey: ['monitors'], queryFn: () => get<MonitorSummary[]>('/monitors') });
  const [using, setUsing] = useState<MonitorDetail | null>(null);
  return (
    <>
      <Text size="sm" c="dimmed" mb="sm">
        A template is a monitor with parameters (IP address, asset id, cadence …). Create many monitors from it with a form or a CSV file; when the template changes, instances show "template updated" and can be re-synced.
      </Text>
      {templates.data?.length === 0 && <Text size="sm">No templates yet. Import "PowerMeter with machine data" from the example library.</Text>}
      {!!templates.data?.length && (
        <div className="table-scroll">
          <Table fz="sm" aria-label="Templates">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Template</Table.Th>
                <Table.Th>Version</Table.Th>
                <Table.Th>Instances</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {templates.data.map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {t.name}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {t.description}
                    </Text>
                  </Table.Td>
                  <Table.Td>{t.version}</Table.Td>
                  <Table.Td>{(all.data ?? []).filter((m) => m.templateId === t.id).length}</Table.Td>
                  <Table.Td>
                    <Group gap={4} justify="flex-end" wrap="nowrap">
                      {canCreate && (
                        <Button size="compact-xs" onClick={async () => setUsing(await get<MonitorDetail>(`/monitors/${t.id}`))}>
                          New monitors
                        </Button>
                      )}
                      <ActionIcon variant="subtle" aria-label="Open template" onClick={() => navigate(`/monitors/${t.id}`)}>
                        <IconEdit size={16} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {using && <InstantiateModal template={using} onClose={() => setUsing(null)} onCreated={onCreated} />}
    </>
  );
}

type GatewayDraft = { id?: string; name: string; description: string; enabled: boolean; authMode: 'token' | 'hmac' | 'either'; allowedCidrs: string[]; allowedKeys: string[]; rateLimitPerMinute: number };

function GatewaysTab() {
  const qc = useQueryClient();
  const gateways = useQuery({ queryKey: ['monitor-gateways'], queryFn: () => get<MonitorGateway[]>('/monitor-gateways'), refetchInterval: 15000 });
  const [draft, setDraft] = useState<GatewayDraft | null>(null);
  const [secret, setSecret] = useState<{ gateway: MonitorGateway; secret: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['monitor-gateways'] });
  const save = async (d: GatewayDraft) => {
    const { id, ...body } = d;
    try {
      if (id) await put(`/monitor-gateways/${id}`, body);
      else setSecret(await post(`/monitor-gateways`, body));
      setDraft(null);
      refresh();
    } catch (e) {
      notifyError(e, 'Gateway not saved');
    }
  };
  return (
    <>
      <Group justify="space-between" mb="sm" align="flex-start">
        <Text size="sm" c="dimmed" maw={760}>
          A gateway (for example the plant's IoT gateway) reports many heartbeat checks in one call to <span className="mono">POST /api/hooks/monitors</span>, mapped by the check key. It has
          one secret; the allowed keys limit what it may report.
        </Text>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDraft({ name: '', description: '', enabled: true, authMode: 'token', allowedCidrs: [], allowedKeys: [], rateLimitPerMinute: 120 })}>
          New gateway
        </Button>
      </Group>
      {!!gateways.data?.length && (
        <div className="table-scroll">
          <Table fz="sm" aria-label="Gateways">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Gateway</Table.Th>
                <Table.Th>Allowed keys</Table.Th>
                <Table.Th>Last report</Table.Th>
                <Table.Th>Accepted</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {gateways.data.map((g) => (
                <Table.Tr key={g.id}>
                  <Table.Td>
                    <Text size="sm" fw={500}>
                      {g.name}
                      {!g.enabled && ' (disabled)'}
                    </Text>
                    <Text size="xs" c="dimmed">
                      secret {g.secretPrefix}… · {g.authMode} · {g.rateLimitPerMinute}/min · owner {g.owner}
                    </Text>
                  </Table.Td>
                  <Table.Td className="mono">{g.allowedKeys.join(', ') || 'any'}</Table.Td>
                  <Table.Td>{fmtRelative(g.lastSeenAt)}</Table.Td>
                  <Table.Td>
                    {g.acceptedCount}
                    {g.rejectedCount > 0 && (
                      <Text size="xs" c="orange">
                        {g.rejectedCount} rejected
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    {g.canEdit && (
                      <Group gap={2} justify="flex-end" wrap="nowrap">
                        <Tooltip label="Rotate secret">
                          <ActionIcon
                            variant="subtle"
                            aria-label="Rotate secret"
                            onClick={async () => {
                              if (!confirm(`Rotate the secret of "${g.name}"? The current secret stops working immediately.`)) return;
                              setSecret(await post(`/monitor-gateways/${g.id}/rotate`));
                              refresh();
                            }}
                          >
                            <IconKey size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <ActionIcon variant="subtle" aria-label="Edit" onClick={() => setDraft({ ...g })}>
                          <IconEdit size={16} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label="Delete"
                          onClick={async () => {
                            if (!confirm(`Delete gateway "${g.name}"? Its reports will be rejected.`)) return;
                            await del(`/monitor-gateways/${g.id}`).catch(notifyError);
                            refresh();
                          }}
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Group>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {draft && <GatewayModal draft={draft} onClose={() => setDraft(null)} onSave={save} />}
      {secret && (
        <Modal opened onClose={() => setSecret(null)} title={`Secret of "${secret.gateway.name}"`} size="xl" closeOnClickOutside={false}>
          <Stack>
            <Alert color="orange" title="Copy the secret now">
              It is shown only once. Store it in the gateway's configuration; rotate it if it may have leaked.
            </Alert>
            <CopyBlock label="Secret" text={secret.secret} />
            <CopyBlock label="URL" text={`${window.location.origin}/api/hooks/monitors`} />
            <CopyBlock label="Report many checks in one call" text={gatewayCurl(secret.gateway.allowedKeys.map((k) => k.replace('*', 'example')))} />
            <Hint>
              Each report: key (the check key), ts (ISO 8601 or Unix time, optional), value, status (up/degraded/down, optional) and data. HMAC mode: add X-Steward-Gateway with the gateway id and X-Steward-Signature.
            </Hint>
            <Group justify="flex-end">
              <Button onClick={() => setSecret(null)}>I have stored the secret</Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </>
  );
}

function GatewayModal({ draft, onClose, onSave }: { draft: GatewayDraft; onClose: () => void; onSave: (d: GatewayDraft) => void }) {
  const [d, setD] = useState(draft);
  return (
    <Modal opened onClose={onClose} title={draft.id ? 'Edit gateway' : 'New gateway'} size="lg">
      <Stack>
        <TextInput label="Name" required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} />
        <Textarea label="Description" autosize minRows={1} value={d.description} onChange={(e) => setD({ ...d, description: e.currentTarget.value })} />
        <SegmentedControl
          size="xs"
          value={d.authMode}
          onChange={(v) => setD({ ...d, authMode: v as GatewayDraft['authMode'] })}
          data={[
            { value: 'token', label: 'Static token' },
            { value: 'hmac', label: 'HMAC signature' },
            { value: 'either', label: 'Either' },
          ]}
        />
        <TagsInput label="Allowed check keys" description="Wildcard *, e.g. m17.* – empty: every heartbeat check" value={d.allowedKeys} onChange={(v) => setD({ ...d, allowedKeys: v })} />
        <TagsInput label="Allowed source addresses" description="IP or CIDR; empty: any" value={d.allowedCidrs} onChange={(v) => setD({ ...d, allowedCidrs: v })} />
        <NumberInput label="Calls per minute" min={1} max={6000} value={d.rateLimitPerMinute} onChange={(v) => setD({ ...d, rateLimitPerMinute: Number(v) || 1 })} />
        <Switch label="Enabled" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.currentTarget.checked })} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!d.name.trim()} onClick={() => onSave(d)}>
            {draft.id ? 'Save' : 'Create and show secret'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

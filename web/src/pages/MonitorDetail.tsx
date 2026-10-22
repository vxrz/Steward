import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Drawer, Grid, Group, Menu, Paper, ScrollArea, Stack, Switch, Table, Tabs, Text, Timeline, Title, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  IconAlertTriangle,
  IconCheck,
  IconCopy,
  IconDots,
  IconDownload,
  IconEdit,
  IconKey,
  IconPlayerPlay,
  IconRefresh,
  IconSend,
  IconTool,
  IconTrash,
} from '@tabler/icons-react';
import { CHECK_TYPE_INFO, type CheckResultInfo, type CheckState, type MaintenanceWindow, type MonitorDetail, type MonitorHistoryEntry, type MonitorSaveResult } from '@sm/shared';
import { api, del, get, notifyError, notifyOk, post, put } from '../api';
import { JsonView, PageHeader } from '../components/common';
import { AccessEditor } from '../components/AccessEditor';
import { fmtDate, fmtRelative } from '../format';
import { MonitorGraph } from '../components/monitors/MonitorGraph';
import { MONITOR_COLORS, MonitorStatusBadge, causeText, fmtUptime, uptimeText } from '../components/monitors/status';
import { AcknowledgeModal, CopyBlock, InstantiateModal, MaintenanceModal, SecretsModal, gatewayCurl, heartbeatCurl } from '../components/monitors/dialogs';

export function MonitorDetailPage() {
  const { id } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isMobile = useMediaQuery('(max-width: 62em)') ?? false;
  const q = useQuery({ queryKey: ['monitor', id], queryFn: () => get<MonitorDetail>(`/monitors/${id}`), refetchInterval: 5000 });
  const [busy, setBusy] = useState(false);
  const [maint, setMaint] = useState(false);
  const [ack, setAck] = useState(false);
  const [instances, setInstances] = useState(false);
  const [secrets, setSecrets] = useState<Pick<MonitorSaveResult, 'secrets'> & { monitor?: MonitorDetail } | null>(null);
  const selected = search.get('check');
  const select = (c: string | null) => setSearch(c ? { check: c } : {}, { replace: true });
  const refresh = () => qc.invalidateQueries({ queryKey: ['monitor', id] });

  if (q.error) return <Text c="red">{(q.error as Error).message}</Text>;
  const m = q.data;
  if (!m) return null;
  const can = (p: string) => m.permissions.includes(p as never);
  const sel = m.checks.find((c) => c.checkId === selected) ?? null;
  const rootIds = m.rootCauses.filter((r) => r.monitorId === m.id).map((r) => r.checkId);

  const runNow = async () => {
    setBusy(true);
    try {
      await post(`/monitors/${m.id}/run`);
      await refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={
          <Group gap="sm" wrap="wrap">
            <span>{m.name}</span>
            {m.isTemplate ? <Badge variant="outline">template</Badge> : <MonitorStatusBadge status={m.status} size="lg" />}
          </Group>
        }
        description={
          <>
            <span className="mono">{m.key}</span> · owner {m.owner}
            {!m.isTemplate && m.since && ` · since ${fmtDate(m.since)}`}
          </>
        }
        actions={
          <>
            {!m.isTemplate && can('acknowledge') && (
              <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} loading={busy} onClick={runNow} disabled={!m.enabled}>
                Check now
              </Button>
            )}
            {m.isTemplate && (
              <Button size="xs" onClick={() => setInstances(true)}>
                New monitors from template
              </Button>
            )}
            {can('edit') && (
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => navigate(`/monitors/${m.id}/edit`)}>
                Edit
              </Button>
            )}
            <Menu position="bottom-end">
              <Menu.Target>
                <Button size="xs" variant="default" aria-label="More actions" px={8}>
                  <IconDots size={16} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {!m.isTemplate && can('acknowledge') && (
                  <Menu.Item leftSection={<IconTool size={14} />} onClick={() => setMaint(true)}>
                    Plan maintenance
                  </Menu.Item>
                )}
                {!m.isTemplate && can('acknowledge') && m.status !== 'up' && !m.acknowledged && (
                  <Menu.Item leftSection={<IconCheck size={14} />} onClick={() => setAck(true)}>
                    Acknowledge problem
                  </Menu.Item>
                )}
                <Menu.Item leftSection={<IconDownload size={14} />} component="a" href={`/api/monitors/${m.id}/export`}>
                  Export YAML
                </Menu.Item>
                {can('manage') && (
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={14} />}
                    onClick={async () => {
                      if (!confirm(`Delete "${m.name}" with its history? Heartbeat URLs stop working.`)) return;
                      try {
                        await del(`/monitors/${m.id}`);
                        qc.invalidateQueries({ queryKey: ['monitors'] });
                        navigate('/monitors');
                      } catch (e) {
                        notifyError(e);
                      }
                    }}
                  >
                    Delete
                  </Menu.Item>
                )}
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />
      <Stack gap="sm" mb="md">
        {!m.isTemplate && (
          <Text size="sm" c="dimmed">
            Uptime: {uptimeText(m.uptime)}
          </Text>
        )}
        {!m.isTemplate && m.rootCauses.length > 0 && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title="Root cause">
            {m.rootCauses.map((c) => (
              <Text key={`${c.monitorId}/${c.checkId}`} size="sm">
                {c.monitorId === m.id ? (
                  <Anchor onClick={() => select(c.checkId)}>{c.checkName}</Anchor>
                ) : (
                  <Anchor component={Link} to={`/monitors/${c.monitorId}?check=${encodeURIComponent(c.checkId)}`}>
                    {causeText(c, m.id)}
                  </Anchor>
                )}
                {c.monitorId === m.id && m.checks.find((x) => x.checkId === c.checkId)?.last?.message ? ` – ${m.checks.find((x) => x.checkId === c.checkId)!.last!.message}` : ''}
              </Text>
            ))}
          </Alert>
        )}
        {m.maintenance && (
          <Alert color="blue" title="Maintenance window">
            <Group justify="space-between">
              <Text size="sm">
                Until {fmtDate(m.maintenance.endsAt)}: {m.maintenance.reason || 'no reason given'} (by {m.maintenance.createdBy})
              </Text>
              {can('acknowledge') && (
                <Button size="compact-xs" variant="light" onClick={async () => (await del(`/monitors/${m.id}/maintenance/${m.maintenance!.id}`).catch(notifyError), refresh())}>
                  End now
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {m.acknowledged && (
          <Alert color="gray" title={`Acknowledged by ${m.acknowledged.by} ${fmtRelative(m.acknowledged.at)}`}>
            <Group justify="space-between">
              <Text size="sm">{m.acknowledged.comment || 'No comment'}</Text>
              {can('acknowledge') && (
                <Button size="compact-xs" variant="light" onClick={async () => (await del(`/monitors/${m.id}/acknowledge`).catch(notifyError), refresh())}>
                  Remove
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {m.templateOutdated && (
          <Alert color="yellow" title="The template was updated">
            <Group justify="space-between">
              <Text size="sm">This monitor was created from an older version of its template. Re-sync replaces the definition with the current template version (parameters stay).</Text>
              {can('edit') && (
                <Button
                  size="compact-xs"
                  leftSection={<IconRefresh size={12} />}
                  onClick={async () => {
                    try {
                      await post(`/monitors/${m.id}/resync`);
                      notifyOk('Re-synced with the template');
                      refresh();
                    } catch (e) {
                      notifyError(e);
                    }
                  }}
                >
                  Re-sync
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {!m.enabled && !m.isTemplate && <Alert color="gray">This monitor is disabled – its checks do not run.</Alert>}
      </Stack>

      <Tabs defaultValue="graph" keepMounted={false}>
        <Tabs.List mb="sm">
          <Tabs.Tab value="graph">Overview</Tabs.Tab>
          {!m.isTemplate && <Tabs.Tab value="history">History</Tabs.Tab>}
          {!m.isTemplate && m.checks.some((c) => c.type === 'heartbeat') && <Tabs.Tab value="heartbeats">Heartbeat setup</Tabs.Tab>}
          {!m.isTemplate && <Tabs.Tab value="maintenance">Maintenance</Tabs.Tab>}
          <Tabs.Tab value="definition">Definition</Tabs.Tab>
          {can('manage') && <Tabs.Tab value="access">Access</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="graph">
          <Grid>
            <Grid.Col span={{ base: 12, md: sel && !isMobile ? 8 : 12 }}>
              <MonitorGraph def={m.definition} states={m.isTemplate ? undefined : m.checks} rootCauseIds={rootIds} selected={selected} onSelect={select} height={isMobile ? 380 : 520} />
              <Text size="xs" c="dimmed" mt={4}>
                Arrows point from a check to the checks that depend on it. Dashed: soft link (both run; a failing parent explains the child). Solid: hard link (the child is not evaluated while the parent is
                down). Click a check for details.
              </Text>
              {!m.isTemplate && <ChecksTable monitor={m} onSelect={select} />}
            </Grid.Col>
            {sel && !isMobile && (
              <Grid.Col span={{ base: 12, md: 4 }}>
                <Paper withBorder p="sm">
                  <CheckPanel monitor={m} check={sel} onClose={() => select(null)} onSecret={setSecrets} />
                </Paper>
              </Grid.Col>
            )}
          </Grid>
          {isMobile && (
            <Drawer opened={!!sel} onClose={() => select(null)} position="bottom" size="85%" title={sel?.name}>
              {sel && <CheckPanel monitor={m} check={sel} onClose={() => select(null)} onSecret={setSecrets} hideTitle />}
            </Drawer>
          )}
        </Tabs.Panel>
        <Tabs.Panel value="history">
          <HistoryList monitor={m} />
        </Tabs.Panel>
        <Tabs.Panel value="heartbeats">
          <HeartbeatSetup monitor={m} onSecret={setSecrets} />
        </Tabs.Panel>
        <Tabs.Panel value="maintenance">
          <MaintenanceList monitor={m} onPlan={() => setMaint(true)} />
        </Tabs.Panel>
        <Tabs.Panel value="definition">
          <Stack>
            {m.definition.outputs.length > 0 && (
              <Paper withBorder p="sm">
                <Title order={4} mb="xs">
                  Outputs
                </Title>
                {m.definition.outputs.map((o) => (
                  <Text key={o.id} size="sm">
                    <Badge size="xs" variant="light" mr={6}>
                      {o.type}
                    </Badge>
                    {o.id} · {o.on === 'every' ? 'every evaluation' : 'on change'}
                    {o.enabled ? '' : ' · disabled'}
                  </Text>
                ))}
              </Paper>
            )}
            <JsonView value={m.definition} maxHeight={600} />
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="access">
          <AccessEditor
            kind="monitor"
            acl={m.acl}
            owner={m.owner}
            onSave={async (acl, owner) => {
              try {
                await put(`/monitors/${m.id}/access`, { acl, owner: owner ?? undefined });
                notifyOk('Access saved');
                refresh();
              } catch (e) {
                notifyError(e);
              }
            }}
          />
        </Tabs.Panel>
      </Tabs>
      {can('edit') && !m.isTemplate && (
        <Switch
          mt="md"
          label="Enabled"
          checked={m.enabled}
          onChange={async (e) => {
            await post(`/monitors/${m.id}/enabled`, { enabled: e.currentTarget.checked }).catch(notifyError);
            refresh();
          }}
        />
      )}
      {maint && <MaintenanceModal monitor={m} onClose={() => setMaint(false)} onSaved={refresh} />}
      {ack && <AcknowledgeModal monitor={m} onClose={() => setAck(false)} onSaved={refresh} />}
      {instances && <InstantiateModal template={m} onClose={() => setInstances(false)} onCreated={(r) => setSecrets({ monitor: r[0]?.monitor, secrets: r.flatMap((x) => x.secrets) })} />}
      {secrets && <SecretsModal result={secrets} onClose={() => setSecrets(null)} />}
    </>
  );
}

function ChecksTable({ monitor, onSelect }: { monitor: MonitorDetail; onSelect: (id: string) => void }) {
  return (
    <div className="table-scroll" style={{ marginTop: 12 }}>
      <Table fz="sm" highlightOnHover aria-label="Checks">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Check</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th>Latest result</Table.Th>
            <Table.Th>Uptime 24 h</Table.Th>
            <Table.Th>Last check</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {monitor.checks.map((c) => (
            <Table.Tr key={c.checkId} className="clickable" onClick={() => onSelect(c.checkId)}>
              <Table.Td>
                <Text size="sm" fw={500}>
                  {c.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {CHECK_TYPE_INFO[c.type].label}
                </Text>
              </Table.Td>
              <Table.Td className="nowrap">
                <MonitorStatusBadge status={c.status} variant="light" />
              </Table.Td>
              <Table.Td maw={360}>
                <Text size="xs" lineClamp={2}>
                  {c.last?.message ?? '–'}
                </Text>
                {c.causedBy.length > 0 && (
                  <Text size="xs" c="orange">
                    Likely caused by {c.causedBy.map((x) => causeText(x, monitor.id)).join(', ')}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>{fmtUptime(c.uptime.h24)}</Table.Td>
              <Table.Td className="nowrap">{fmtRelative(c.last?.ts)}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function CheckPanel({ monitor, check: c, onClose, onSecret, hideTitle }: { monitor: MonitorDetail; check: CheckState; onClose: () => void; onSecret: (s: { secrets: MonitorSaveResult['secrets'] }) => void; hideTitle?: boolean }) {
  const results = useQuery({ queryKey: ['monitor-results', monitor.id, c.checkId, c.last?.ts], queryFn: () => get<CheckResultInfo[]>(`/monitors/${monitor.id}/checks/${encodeURIComponent(c.checkId)}/results?limit=20`) });
  const history = useQuery({ queryKey: ['monitor-history', monitor.id, c.checkId, c.since], queryFn: () => get<MonitorHistoryEntry[]>(`/monitors/${monitor.id}/history?check=${encodeURIComponent(c.checkId)}&limit=20`) });
  const def = monitor.definition.checks.find((x) => x.id === c.checkId);
  return (
    <Stack gap="xs" data-testid="check-panel">
      {!hideTitle && (
        <Group justify="space-between" wrap="nowrap">
          <Title order={4}>{c.name}</Title>
          <Button size="compact-xs" variant="subtle" onClick={onClose}>
            Close
          </Button>
        </Group>
      )}
      <Group gap="xs">
        <MonitorStatusBadge status={c.status} />
        <Text size="xs" c="dimmed">
          {CHECK_TYPE_INFO[c.type].label} · since {fmtRelative(c.since)}
        </Text>
      </Group>
      {c.last && (
        <Text size="sm">
          {c.last.message}
          {c.last.durationMs != null ? ` (${c.last.durationMs} ms)` : ''}
        </Text>
      )}
      {c.causedBy.length > 0 && (
        <Alert color="orange" p="xs">
          Likely caused by {c.causedBy.map((x) => causeText(x, monitor.id)).join(', ')} – no separate alert is sent for this check.
        </Alert>
      )}
      {c.note && (
        <Alert color="yellow" p="xs">
          {c.note}
        </Alert>
      )}
      <Text size="xs">
        Uptime: {uptimeText(c.uptime)}
        <br />
        Last ok: {fmtDate(c.lastOkAt)} · next check: {c.nextCheckAt ? fmtRelative(c.nextCheckAt) : '–'}
        <br />
        Key: <span className="mono">{c.key}</span>
      </Text>
      {c.monitorRef && (
        <Anchor component={Link} to={`/monitors/${c.monitorRef.id}`} size="sm">
          Open "{c.monitorRef.name}"
        </Anchor>
      )}
      {c.heartbeat && <HeartbeatCard monitor={monitor} check={c} onSecret={onSecret} />}
      <Text size="sm" fw={600} mt="xs">
        Status changes
      </Text>
      <Timeline bulletSize={12} lineWidth={2}>
        {(history.data ?? []).slice(0, 8).map((h) => (
          <Timeline.Item key={h.id} color={MONITOR_COLORS[h.status]} title={<Text size="xs" fw={600}>{`${h.previous ?? '–'} → ${h.status}`}</Text>}>
            <Text size="xs" c="dimmed">
              {fmtDate(h.ts)}
            </Text>
            <Text size="xs" lineClamp={2}>
              {h.message}
            </Text>
          </Timeline.Item>
        ))}
      </Timeline>
      <Text size="sm" fw={600}>
        Latest results
      </Text>
      <ScrollArea.Autosize mah={260}>
        <Stack gap={6}>
          {(results.data ?? []).map((r, i) => (
            <div key={i}>
              <Group gap={6} wrap="nowrap">
                <MonitorStatusBadge status={r.status} size="xs" variant="light" />
                <Text size="xs" c="dimmed">
                  {fmtDate(r.ts)}
                  {r.durationMs != null ? ` · ${r.durationMs} ms` : ''}
                </Text>
              </Group>
              <Text size="xs">{r.message}</Text>
            </div>
          ))}
        </Stack>
      </ScrollArea.Autosize>
      <Text size="sm" fw={600}>
        Configuration
      </Text>
      <JsonView value={def} maxHeight={240} />
    </Stack>
  );
}

function HeartbeatCard({ monitor, check: c, onSecret }: { monitor: MonitorDetail; check: CheckState; onSecret: (s: { secrets: MonitorSaveResult['secrets'] }) => void }) {
  const hb = c.heartbeat!;
  const canEdit = monitor.permissions.includes('edit');
  return (
    <Paper withBorder p="xs">
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          Heartbeat endpoint
        </Text>
        <Text size="xs" className="mono" style={{ wordBreak: 'break-all' }}>
          POST {window.location.origin}
          {hb.path}
        </Text>
        <Text size="xs" c="dimmed">
          {hb.authMode} · secret {hb.secretPrefix}… · last report {fmtRelative(hb.lastPushAt)}
        </Text>
        {hb.lastPush != null && <JsonView value={hb.lastPush} maxHeight={120} />}
        {canEdit && (
          <Group gap={4}>
            <Button
              size="compact-xs"
              variant="light"
              leftSection={<IconSend size={12} />}
              onClick={async () => {
                try {
                  const r = await post<{ status: number; response: { status?: string; error?: string } }>(`/monitors/${monitor.id}/checks/${c.checkId}/test-report`, { status: 'up', value: 1 });
                  notifyOk(`HTTP ${r.status}: ${r.response.status ?? r.response.error ?? ''}`, 'Test report sent');
                } catch (e) {
                  notifyError(e);
                }
              }}
            >
              Send test report
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconKey size={12} />}
              onClick={async () => {
                if (!confirm('Rotate the secret? The reporting system must use the new one right away.')) return;
                try {
                  const r = await api<{ secret: string; path: string }>('POST', `/monitors/${monitor.id}/checks/${c.checkId}/rotate`);
                  onSecret({ secrets: [{ checkId: c.checkId, ...r }] });
                } catch (e) {
                  notifyError(e);
                }
              }}
            >
              Rotate secret
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function HeartbeatSetup({ monitor, onSecret }: { monitor: MonitorDetail; onSecret: (s: { secrets: MonitorSaveResult['secrets'] }) => void }) {
  const hbs = monitor.checks.filter((c) => c.heartbeat);
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        Heartbeat checks are fed by another system, for example the IoT gateway: either one call per check with that check's secret, or one call for many checks with a gateway secret (Monitors →
        Gateways), mapped by the check key. A missing report turns the check down without any request. Body (JSON, max. 64 KB): status (optional: up, degraded, down or true/false), value, ts (ISO 8601 or
        Unix time) and data.
      </Text>
      {hbs.map((c) => (
        <Paper key={c.checkId} withBorder p="sm">
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>{c.name}</Text>
              <MonitorStatusBadge status={c.status} variant="light" />
            </Group>
            <CopyBlock label="URL" text={`${window.location.origin}${c.heartbeat!.path}`} />
            <CopyBlock label="One check (curl)" text={heartbeatCurl(c.heartbeat!.path, c.heartbeat!.authMode === 'hmac')} />
            <Text size="xs" c="dimmed">
              Gateway key: <span className="mono">{c.key}</span> · secret {c.heartbeat!.secretPrefix}… (shown only when created or rotated)
            </Text>
            <HeartbeatCard monitor={monitor} check={c} onSecret={onSecret} />
          </Stack>
        </Paper>
      ))}
      <CopyBlock label="Many checks in one call (gateway)" text={gatewayCurl(hbs.map((c) => c.key))} />
      <Button component={Link} to="/monitors?tab=gateways" size="xs" variant="light" w="fit-content" leftSection={<IconCopy size={14} />}>
        Manage gateways
      </Button>
    </Stack>
  );
}

function HistoryList({ monitor }: { monitor: MonitorDetail }) {
  const h = useQuery({ queryKey: ['monitor-history', monitor.id, 'all', monitor.lastEvaluatedAt], queryFn: () => get<MonitorHistoryEntry[]>(`/monitors/${monitor.id}/history?limit=200`) });
  const name = new Map(monitor.checks.map((c) => [c.checkId, c.name]));
  return (
    <div className="table-scroll">
      <Table fz="sm" aria-label="Status changes">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Time</Table.Th>
            <Table.Th>Check</Table.Th>
            <Table.Th>Change</Table.Th>
            <Table.Th>Message</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(h.data ?? []).map((x) => (
            <Table.Tr key={x.id}>
              <Table.Td className="nowrap">{fmtDate(x.ts)}</Table.Td>
              <Table.Td>{x.checkId ? (name.get(x.checkId) ?? x.checkId) : <b>Monitor</b>}</Table.Td>
              <Table.Td className="nowrap">
                <Group gap={4} wrap="nowrap">
                  {x.previous && <MonitorStatusBadge status={x.previous} size="xs" variant="light" />}→<MonitorStatusBadge status={x.status} size="xs" />
                </Group>
              </Table.Td>
              <Table.Td>
                <Text size="xs">{x.message}</Text>
                {x.causedBy.length > 0 && x.checkId && (
                  <Text size="xs" c="orange">
                    Likely caused by {x.causedBy.map((c) => causeText(c, monitor.id)).join(', ')}
                  </Text>
                )}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </div>
  );
}

function MaintenanceList({ monitor, onPlan }: { monitor: MonitorDetail; onPlan: () => void }) {
  const w = useQuery({ queryKey: ['monitor-maintenance', monitor.id, monitor.maintenance?.id], queryFn: () => get<MaintenanceWindow[]>(`/monitors/${monitor.id}/maintenance`) });
  return (
    <Stack>
      {monitor.permissions.includes('acknowledge') && (
        <Button size="xs" w="fit-content" leftSection={<IconTool size={14} />} onClick={onPlan}>
          Plan maintenance
        </Button>
      )}
      {(w.data ?? []).length === 0 && <Text size="sm" c="dimmed">No maintenance windows.</Text>}
      {(w.data ?? []).map((x) => (
        <Paper key={x.id} withBorder p="xs">
          <Group justify="space-between">
            <div>
              <Text size="sm" fw={500}>
                {fmtDate(x.startsAt)} – {fmtDate(x.endsAt)} {x.active && <Badge size="xs">active</Badge>}
              </Text>
              <Text size="xs" c="dimmed">
                {x.reason} · {x.createdBy}
              </Text>
            </div>
            {monitor.permissions.includes('acknowledge') && Date.parse(x.endsAt) > Date.now() && (
              <Tooltip label={x.active ? 'End now' : 'Remove'}>
                <Button size="compact-xs" variant="subtle" color="red" onClick={async () => (await del(`/monitors/${monitor.id}/maintenance/${x.id}`).catch(notifyError), w.refetch())}>
                  {x.active ? 'End now' : 'Remove'}
                </Button>
              </Tooltip>
            )}
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

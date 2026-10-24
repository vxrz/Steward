import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Drawer,
  Grid,
  Group,
  Menu,
  Paper,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Timeline,
  Title,
  Tooltip,
} from '@mantine/core';
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
import { Trans, useTranslation } from 'react-i18next';
import {
  type CheckResultInfo,
  type CheckState,
  type MaintenanceWindow,
  type MonitorDetail,
  type MonitorHistoryEntry,
  type MonitorSaveResult,
} from '@sm/shared';
import { api, apiUrl, del, get, notifyError, notifyOk, post, put } from '../api';
import { DetailState, JsonView, PageHeader } from '../components/common';
import { GitOriginBadge } from '../components/gitsync/GitOriginBadge';
import { AccessEditor } from '../components/AccessEditor';
import { fmtDate, fmtNumber, fmtRelative } from '../format';
import { MonitorGraph } from '../components/monitors/MonitorGraph';
import { MONITOR_COLORS, MonitorStatusBadge, causeText, checkTypeLabel, fmtUptime, monitorStatusLabel, uptimeText } from '../components/monitors/status';
import { AcknowledgeModal, CopyBlock, InstantiateModal, MaintenanceModal, SecretsModal, gatewayCurl, heartbeatCurl } from '../components/monitors/dialogs';
import { confirmDanger } from '../components/confirm';

export function MonitorDetailPage() {
  const { t } = useTranslation(['monitors', 'common']);
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
  const [secrets, setSecrets] = useState<(Pick<MonitorSaveResult, 'secrets'> & { monitor?: MonitorDetail }) | null>(null);
  const selected = search.get('check');
  const select = (c: string | null) => setSearch(c ? { check: c } : {}, { replace: true });
  const refresh = () => qc.invalidateQueries({ queryKey: ['monitor', id] });

  const m = q.data;
  if (!m) return <DetailState query={q} back="monitors" />;
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
        back="monitors"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{m.name}</span>
            {m.isTemplate ? <Badge variant="outline">{t('detail.template')}</Badge> : <MonitorStatusBadge status={m.status} size="lg" />}
            <GitOriginBadge kind="monitor" id={m.id} />
          </Group>
        }
        description={
          <>
            <span className="mono">{m.key}</span> · {t('detail.owner', { owner: m.owner })}
            {!m.isTemplate && m.since && ` · ${t('detail.since', { date: fmtDate(m.since) })}`}
          </>
        }
        actions={
          <>
            {!m.isTemplate && can('acknowledge') && (
              <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} loading={busy} onClick={runNow} disabled={!m.enabled}>
                {t('detail.checkNow')}
              </Button>
            )}
            {m.isTemplate && (
              <Button size="xs" onClick={() => setInstances(true)}>
                {t('detail.newFromTemplate')}
              </Button>
            )}
            {can('edit') && (
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => navigate(`/monitors/${m.id}/edit`)}>
                {t('detail.edit')}
              </Button>
            )}
            <Menu position="bottom-end">
              <Menu.Target>
                <Button size="xs" variant="default" aria-label={t('detail.moreActions')} px={8}>
                  <IconDots size={16} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {!m.isTemplate && can('acknowledge') && (
                  <Menu.Item leftSection={<IconTool size={14} />} onClick={() => setMaint(true)}>
                    {t('maintenance.plan')}
                  </Menu.Item>
                )}
                {!m.isTemplate && can('acknowledge') && m.status !== 'up' && !m.acknowledged && (
                  <Menu.Item leftSection={<IconCheck size={14} />} onClick={() => setAck(true)}>
                    {t('detail.acknowledgeProblem')}
                  </Menu.Item>
                )}
                <Menu.Item leftSection={<IconDownload size={14} />} component="a" href={apiUrl(`/monitors/${m.id}/export`)}>
                  {t('detail.exportYaml')}
                </Menu.Item>
                {can('manage') && (
                  <Menu.Item
                    color="red"
                    leftSection={<IconTrash size={14} />}
                    onClick={async () => {
                      if (!(await confirmDanger({ action: 'delete', message: t('detail.deleteConfirm', { name: m.name }) }))) return;
                      try {
                        await del(`/monitors/${m.id}`);
                        qc.invalidateQueries({ queryKey: ['monitors'] });
                        navigate('/monitors');
                      } catch (e) {
                        notifyError(e);
                      }
                    }}
                  >
                    {t('common:delete')}
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
            {t('detail.uptime', { uptime: uptimeText(m.uptime) })}
          </Text>
        )}
        {!m.isTemplate && m.rootCauses.length > 0 && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title={t('list.rootCause')}>
            {m.rootCauses.map((c) => (
              <Text key={`${c.monitorId}/${c.checkId}`} size="sm">
                {c.hidden ? (
                  causeText(c, m.id)
                ) : c.monitorId === m.id ? (
                  <Anchor inherit onClick={() => select(c.checkId)}>
                    {c.checkName}
                  </Anchor>
                ) : (
                  <Anchor inherit component={Link} to={`/monitors/${c.monitorId}?check=${encodeURIComponent(c.checkId)}`}>
                    {causeText(c, m.id)}
                  </Anchor>
                )}
                {c.monitorId === m.id && m.checks.find((x) => x.checkId === c.checkId)?.last?.message
                  ? ` – ${m.checks.find((x) => x.checkId === c.checkId)!.last!.message}`
                  : ''}
              </Text>
            ))}
          </Alert>
        )}
        {m.maintenance && (
          <Alert color="blue" title={t('maintenance.window')}>
            <Group justify="space-between">
              <Text size="sm">
                {t('maintenance.until', {
                  date: fmtDate(m.maintenance.endsAt),
                  reason: m.maintenance.reason || t('maintenance.noReason'),
                  user: m.maintenance.createdBy,
                })}
              </Text>
              {can('acknowledge') && (
                <Button
                  size="compact-xs"
                  variant="light"
                  onClick={async () => (await del(`/monitors/${m.id}/maintenance/${m.maintenance!.id}`).catch(notifyError), refresh())}
                >
                  {t('maintenance.endNow')}
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {m.acknowledged && (
          <Alert color="gray" title={t('detail.acknowledgedBy', { user: m.acknowledged.by, when: fmtRelative(m.acknowledged.at) })}>
            <Group justify="space-between">
              <Text size="sm">{m.acknowledged.comment || t('detail.noComment')}</Text>
              {can('acknowledge') && (
                <Button size="compact-xs" variant="light" onClick={async () => (await del(`/monitors/${m.id}/acknowledge`).catch(notifyError), refresh())}>
                  {t('detail.remove')}
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {m.templateOutdated && (
          <Alert color="yellow" title={t('detail.templateUpdated')}>
            <Group justify="space-between">
              <Text size="sm">{t('detail.templateUpdatedText')}</Text>
              {can('edit') && (
                <Button
                  size="compact-xs"
                  leftSection={<IconRefresh size={12} />}
                  onClick={async () => {
                    try {
                      await post(`/monitors/${m.id}/resync`);
                      notifyOk(t('detail.resynced'));
                      refresh();
                    } catch (e) {
                      notifyError(e);
                    }
                  }}
                >
                  {t('detail.resync')}
                </Button>
              )}
            </Group>
          </Alert>
        )}
        {!m.enabled && !m.isTemplate && <Alert color="gray">{t('detail.disabled')}</Alert>}
      </Stack>

      <Tabs defaultValue="graph" keepMounted={false}>
        <Tabs.List mb="sm">
          <Tabs.Tab value="graph">{t('detail.tabs.overview')}</Tabs.Tab>
          {!m.isTemplate && <Tabs.Tab value="history">{t('detail.tabs.history')}</Tabs.Tab>}
          {!m.isTemplate && m.checks.some((c) => c.type === 'heartbeat') && <Tabs.Tab value="heartbeats">{t('detail.tabs.heartbeats')}</Tabs.Tab>}
          {!m.isTemplate && <Tabs.Tab value="maintenance">{t('detail.tabs.maintenance')}</Tabs.Tab>}
          <Tabs.Tab value="definition">{t('detail.tabs.definition')}</Tabs.Tab>
          {can('manage') && <Tabs.Tab value="access">{t('detail.tabs.access')}</Tabs.Tab>}
        </Tabs.List>
        <Tabs.Panel value="graph">
          <Grid>
            <Grid.Col span={{ base: 12, md: sel && !isMobile ? 8 : 12 }}>
              <MonitorGraph
                def={m.definition}
                states={m.isTemplate ? undefined : m.checks}
                rootCauseIds={rootIds}
                selected={selected}
                onSelect={select}
                height={isMobile ? 380 : 520}
              />
              <Text size="xs" c="dimmed" mt={4}>
                {t('detail.graphHint')}
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
                  {t('outputs.title')}
                </Title>
                {m.definition.outputs.map((o) => (
                  <Text key={o.id} size="sm">
                    <Badge size="xs" variant="light" mr={6}>
                      {o.type}
                    </Badge>
                    {o.id} · {o.on === 'every' ? t('detail.onEvery') : t('detail.onChange')}
                    {o.enabled ? '' : ` · ${t('list.disabled')}`}
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
                notifyOk(t('detail.accessSaved'));
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
          label={t('form.enabled')}
          checked={m.enabled}
          onChange={async (e) => {
            await post(`/monitors/${m.id}/enabled`, { enabled: e.currentTarget.checked }).catch(notifyError);
            refresh();
          }}
        />
      )}
      {maint && <MaintenanceModal monitor={m} onClose={() => setMaint(false)} onSaved={refresh} />}
      {ack && <AcknowledgeModal monitor={m} onClose={() => setAck(false)} onSaved={refresh} />}
      {instances && (
        <InstantiateModal
          template={m}
          onClose={() => setInstances(false)}
          onCreated={(r) => setSecrets({ monitor: r[0]?.monitor, secrets: r.flatMap((x) => x.secrets) })}
        />
      )}
      {secrets && <SecretsModal result={secrets} onClose={() => setSecrets(null)} />}
    </>
  );
}

function ChecksTable({ monitor, onSelect }: { monitor: MonitorDetail; onSelect: (id: string) => void }) {
  const { t } = useTranslation('monitors');
  return (
    <div className="table-scroll" style={{ marginTop: 12 }}>
      <Table fz="sm" highlightOnHover aria-label={t('list.checks')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('detail.check')}</Table.Th>
            <Table.Th>{t('list.status')}</Table.Th>
            <Table.Th>{t('detail.latestResult')}</Table.Th>
            <Table.Th>{t('list.uptime24h')}</Table.Th>
            <Table.Th>{t('detail.lastCheck')}</Table.Th>
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
                  {checkTypeLabel(c.type)}
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
                    {t('detail.likelyCausedBy', { causes: c.causedBy.map((x) => causeText(x, monitor.id)).join(', ') })}
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

function CheckPanel({
  monitor,
  check: c,
  onClose,
  onSecret,
  hideTitle,
}: {
  monitor: MonitorDetail;
  check: CheckState;
  onClose: () => void;
  onSecret: (s: { secrets: MonitorSaveResult['secrets'] }) => void;
  hideTitle?: boolean;
}) {
  const results = useQuery({
    queryKey: ['monitor-results', monitor.id, c.checkId, c.last?.ts],
    queryFn: () => get<CheckResultInfo[]>(`/monitors/${monitor.id}/checks/${encodeURIComponent(c.checkId)}/results?limit=20`),
  });
  const history = useQuery({
    queryKey: ['monitor-history', monitor.id, c.checkId, c.since],
    queryFn: () => get<MonitorHistoryEntry[]>(`/monitors/${monitor.id}/history?check=${encodeURIComponent(c.checkId)}&limit=20`),
  });
  const def = monitor.definition.checks.find((x) => x.id === c.checkId);
  const { t } = useTranslation(['monitors', 'common']);
  return (
    <Stack gap="xs" data-testid="check-panel">
      {!hideTitle && (
        <Group justify="space-between" wrap="nowrap">
          <Title order={4}>{c.name}</Title>
          <Button size="compact-xs" variant="subtle" onClick={onClose} style={{ flexShrink: 0 }}>
            {t('common:close')}
          </Button>
        </Group>
      )}
      <Group gap="xs">
        <MonitorStatusBadge status={c.status} />
        <Text size="xs" c="dimmed">
          {checkTypeLabel(c.type)} · {t('detail.since', { date: fmtRelative(c.since) })}
        </Text>
      </Group>
      {c.last && (
        <Text size="sm">
          {c.last.message}
          {c.last.durationMs != null ? ` (${fmtNumber(c.last.durationMs)} ms)` : ''}
        </Text>
      )}
      {c.causedBy.length > 0 && (
        <Alert color="orange" p="xs">
          {t('detail.likelyCausedByNoAlert', { causes: c.causedBy.map((x) => causeText(x, monitor.id)).join(', ') })}
        </Alert>
      )}
      {c.note && (
        <Alert color="yellow" p="xs">
          {c.note}
        </Alert>
      )}
      <Text size="xs">
        {t('detail.uptime', { uptime: uptimeText(c.uptime) })}
        <br />
        {t('detail.lastOkNext', { lastOk: fmtDate(c.lastOkAt), next: c.nextCheckAt ? fmtRelative(c.nextCheckAt) : '–' })}
        <br />
        <Trans t={t} i18nKey="detail.key" values={{ key: c.key }} components={{ c: <span className="mono" /> }} />
      </Text>
      {c.monitorRef &&
        (c.monitorRef.hidden ? (
          <Text size="sm" c="dimmed">
            {t('detail.openHiddenMonitor')}
          </Text>
        ) : (
          <Anchor component={Link} to={`/monitors/${c.monitorRef.id}`} size="sm">
            {t('detail.openMonitor', { name: c.monitorRef.name })}
          </Anchor>
        ))}
      {c.heartbeat && <HeartbeatCard monitor={monitor} check={c} onSecret={onSecret} />}
      <Text size="sm" fw={600} mt="xs">
        {t('detail.statusChanges')}
      </Text>
      <Timeline bulletSize={12} lineWidth={2}>
        {(history.data ?? []).slice(0, 8).map((h) => (
          <Timeline.Item
            key={h.id}
            color={MONITOR_COLORS[h.status]}
            title={<Text size="xs" fw={600}>{`${h.previous ? monitorStatusLabel(h.previous) : '–'} → ${monitorStatusLabel(h.status)}`}</Text>}
          >
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
        {t('detail.latestResults')}
      </Text>
      <ScrollArea.Autosize mah={260}>
        <Stack gap={6}>
          {(results.data ?? []).map((r, i) => (
            <div key={i}>
              <Group gap={6} wrap="nowrap">
                <MonitorStatusBadge status={r.status} size="xs" variant="light" />
                <Text size="xs" c="dimmed">
                  {fmtDate(r.ts)}
                  {r.durationMs != null ? ` · ${fmtNumber(r.durationMs)} ms` : ''}
                </Text>
              </Group>
              <Text size="xs">{r.message}</Text>
            </div>
          ))}
        </Stack>
      </ScrollArea.Autosize>
      <Text size="sm" fw={600}>
        {t('detail.configuration')}
      </Text>
      <JsonView value={def} maxHeight={240} />
    </Stack>
  );
}

function HeartbeatCard({
  monitor,
  check: c,
  onSecret,
}: {
  monitor: MonitorDetail;
  check: CheckState;
  onSecret: (s: { secrets: MonitorSaveResult['secrets'] }) => void;
}) {
  const hb = c.heartbeat!;
  const canEdit = monitor.permissions.includes('edit');
  const { t } = useTranslation('monitors');
  return (
    <Paper withBorder p="xs">
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          {t('heartbeat.endpoint')}
        </Text>
        <Text size="xs" className="mono" style={{ wordBreak: 'break-all' }}>
          POST {window.location.origin}
          {hb.path}
        </Text>
        <Text size="xs" c="dimmed">
          {t('heartbeat.line', {
            auth: t(`auth.short.${hb.authMode as 'token' | 'hmac' | 'either'}`, { defaultValue: hb.authMode }),
            prefix: hb.secretPrefix,
            when: fmtRelative(hb.lastPushAt),
          })}
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
                  const r = await post<{ status: number; response: { status?: string; error?: string } }>(
                    `/monitors/${monitor.id}/checks/${c.checkId}/test-report`,
                    { status: 'up', value: 1 },
                  );
                  notifyOk(`HTTP ${r.status}: ${r.response.status ?? r.response.error ?? ''}`, t('heartbeat.testSent'));
                } catch (e) {
                  notifyError(e);
                }
              }}
            >
              {t('heartbeat.sendTest')}
            </Button>
            <Button
              size="compact-xs"
              variant="subtle"
              leftSection={<IconKey size={12} />}
              onClick={async () => {
                if (!(await confirmDanger({ action: 'rotate', message: t('heartbeat.rotateConfirm') }))) return;
                try {
                  const r = await api<{ secret: string; path: string }>('POST', `/monitors/${monitor.id}/checks/${c.checkId}/rotate`);
                  onSecret({ secrets: [{ checkId: c.checkId, ...r }] });
                } catch (e) {
                  notifyError(e);
                }
              }}
            >
              {t('gateways.rotate')}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function HeartbeatSetup({ monitor, onSecret }: { monitor: MonitorDetail; onSecret: (s: { secrets: MonitorSaveResult['secrets'] }) => void }) {
  const hbs = monitor.checks.filter((c) => c.heartbeat);
  const { t } = useTranslation('monitors');
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        {t('heartbeat.setupIntro')}
      </Text>
      {hbs.map((c) => (
        <Paper key={c.checkId} withBorder p="sm">
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={600}>{c.name}</Text>
              <MonitorStatusBadge status={c.status} variant="light" />
            </Group>
            <CopyBlock label={t('secrets.url')} text={`${window.location.origin}${c.heartbeat!.path}`} />
            <CopyBlock label={t('heartbeat.oneCheck')} text={heartbeatCurl(c.heartbeat!.path, c.heartbeat!.authMode === 'hmac')} />
            <Text size="xs" c="dimmed">
              <Trans
                t={t}
                i18nKey="heartbeat.gatewayKey"
                values={{ key: c.key, prefix: c.heartbeat!.secretPrefix }}
                components={{ c: <span className="mono" /> }}
              />
            </Text>
            <HeartbeatCard monitor={monitor} check={c} onSecret={onSecret} />
          </Stack>
        </Paper>
      ))}
      <CopyBlock label={t('heartbeat.manyChecks')} text={gatewayCurl(hbs.map((c) => c.key))} />
      <Button component={Link} to="/monitors?tab=gateways" size="xs" variant="light" w="fit-content" leftSection={<IconCopy size={14} />}>
        {t('heartbeat.manageGateways')}
      </Button>
    </Stack>
  );
}

function HistoryList({ monitor }: { monitor: MonitorDetail }) {
  const h = useQuery({
    queryKey: ['monitor-history', monitor.id, 'all', monitor.lastEvaluatedAt],
    queryFn: () => get<MonitorHistoryEntry[]>(`/monitors/${monitor.id}/history?limit=200`),
  });
  const name = new Map(monitor.checks.map((c) => [c.checkId, c.name]));
  const { t } = useTranslation('monitors');
  return (
    <div className="table-scroll">
      <Table fz="sm" aria-label={t('detail.statusChanges')}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('history.time')}</Table.Th>
            <Table.Th>{t('detail.check')}</Table.Th>
            <Table.Th>{t('history.change')}</Table.Th>
            <Table.Th>{t('history.message')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {(h.data ?? []).map((x) => (
            <Table.Tr key={x.id}>
              <Table.Td className="nowrap">{fmtDate(x.ts)}</Table.Td>
              <Table.Td>{x.checkId ? (name.get(x.checkId) ?? x.checkId) : <b>{t('list.monitor')}</b>}</Table.Td>
              <Table.Td className="nowrap">
                <Group gap={4} wrap="nowrap">
                  {x.previous && <MonitorStatusBadge status={x.previous} size="xs" variant="light" />}→<MonitorStatusBadge status={x.status} size="xs" />
                </Group>
              </Table.Td>
              <Table.Td>
                {/* monitor level: the root causes in the user's language (the message is built from them) */}
                <Text size="xs">
                  {!x.checkId && x.causedBy.length
                    ? t('list.rootCauseLine', { causes: x.causedBy.map((c) => causeText(c, monitor.id)).join(', ') })
                    : x.message}
                </Text>
                {x.causedBy.length > 0 && x.checkId && (
                  <Text size="xs" c="orange">
                    {t('detail.likelyCausedBy', { causes: x.causedBy.map((c) => causeText(c, monitor.id)).join(', ') })}
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
  const { t } = useTranslation('monitors');
  const w = useQuery({
    queryKey: ['monitor-maintenance', monitor.id, monitor.maintenance?.id],
    queryFn: () => get<MaintenanceWindow[]>(`/monitors/${monitor.id}/maintenance`),
  });
  return (
    <Stack>
      {monitor.permissions.includes('acknowledge') && (
        <Button size="xs" w="fit-content" leftSection={<IconTool size={14} />} onClick={onPlan}>
          {t('maintenance.plan')}
        </Button>
      )}
      {(w.data ?? []).length === 0 && (
        <Text size="sm" c="dimmed">
          {t('maintenance.none')}
        </Text>
      )}
      {(w.data ?? []).map((x) => (
        <Paper key={x.id} withBorder p="xs">
          <Group justify="space-between">
            <div>
              <Text size="sm" fw={500}>
                {fmtDate(x.startsAt)} – {fmtDate(x.endsAt)} {x.active && <Badge size="xs">{t('maintenance.active')}</Badge>}
              </Text>
              <Text size="xs" c="dimmed">
                {x.reason} · {x.createdBy}
              </Text>
            </div>
            {monitor.permissions.includes('acknowledge') && Date.parse(x.endsAt) > Date.now() && (
              <Tooltip label={x.active ? t('maintenance.endNow') : t('detail.remove')}>
                <Button
                  size="compact-xs"
                  variant="subtle"
                  color="red"
                  onClick={async () => (await del(`/monitors/${monitor.id}/maintenance/${x.id}`).catch(notifyError), w.refetch())}
                >
                  {x.active ? t('maintenance.endNow') : t('detail.remove')}
                </Button>
              </Tooltip>
            )}
          </Group>
        </Paper>
      ))}
    </Stack>
  );
}

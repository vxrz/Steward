import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Drawer, Grid, Group, Menu, Paper, ScrollArea, Stack, Table, Tabs, Text, Timeline, Title } from '@mantine/core';
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
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconSend,
  IconReportMedical,
  IconTool,
  IconTrash,
} from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import {
  type CheckResultInfo,
  type CheckState,
  type MaintenanceList as MaintenanceListData,
  type MonitorDetail,
  type MonitorHistoryEntry,
  type MonitorSaveResult,
} from '@sm/shared';
import { api, apiUrl, del, get, notifyError, notifyOk, post } from '../api';
import { CopyId } from '../components/CopyId';
import { DetailState, JsonView } from '../components/common';
import { GitOriginBadge } from '../components/gitsync/GitOriginBadge';
import { LibraryOriginBadge } from '../components/libraries/parts';
import { AccessTab } from '../components/access/AccessTab';
import { OwnerField } from '../components/access/OwnerField';
import { fmtDate, fmtNumber, fmtRelative } from '../format';
import { MonitorGraph } from '../components/monitors/MonitorGraph';
import { TestRunButton } from '../components/monitors/TestRunButton';
import { ObservedDelaySummary } from '../components/monitors/ObservedDelay';
import { MONITOR_COLORS, MonitorStatusBadge, causeText, checkTypeLabel, fmtUptime, monitorStatusLabel, uptimeText } from '../components/monitors/status';
import { CheckSettlingBadge, OffBanner, SettlingNote, StateProblemBanner, WhyThisState, offText, settlingCheckIds } from '../components/monitors/StatePanel';
import { AcknowledgeModal, CopyBlock, InstantiateModal, SecretsModal, gatewayCurl, heartbeatCurl } from '../components/monitors/dialogs';
import { MaintenanceDetailModal, MaintenanceFormModal, TargetBadges, useRepeatLabel } from '../components/catalogue/maintenance';
import { confirmDanger, confirmDialog } from '../components/confirm';
import { appUrl } from '../basePath';
import { MonitorReviewModal, useCanStartReview } from '../components/records/IncidentReview';
import { DetailHeader } from '../components/page/DetailPage';
import { monitorKeys } from '../queryKeys';
import { CopiedFromNote, DuplicateButton } from '../components/duplicate/DuplicateButton';
import { useMe } from '../auth';
import { MonitorIhCoverage } from '../components/plant/InsightsHubMapping';
import { TableScroll } from '../components/TableScroll';

export function MonitorDetailPage() {
  const { t } = useTranslation(['monitors', 'common']);
  const { t: tr } = useTranslation('records');
  const { id } = useParams();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isMobile = useMediaQuery('(max-width: 62em)') ?? false;
  const q = useQuery({ queryKey: monitorKeys.detail(id), queryFn: () => get<MonitorDetail>(`/monitors/${id}`), refetchInterval: 5000 });
  const [busy, setBusy] = useState(false);
  const [maint, setMaint] = useState(false);
  // a maintenance window opened from the page (the catalogue's window form and details, 0.11)
  const [openWindow, setOpenWindow] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const canStartReview = useCanStartReview();
  const { caps } = useMe();
  const [ack, setAck] = useState(false);
  const [instances, setInstances] = useState(false);
  const [secrets, setSecrets] = useState<(Pick<MonitorSaveResult, 'secrets'> & { monitor?: MonitorDetail }) | null>(null);
  const selected = search.get('check');
  const select = (c: string | null) => setSearch(c ? { check: c } : {}, { replace: true });
  const refresh = () => qc.invalidateQueries({ queryKey: monitorKeys.detail(id) });

  const m = q.data;
  if (!m) return <DetailState query={q} back="monitors" />;
  const can = (p: string) => m.permissions.includes(p as never);
  const canCreate = caps.createMonitors;
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

  /** Pausing stops the checks and the messages, so it asks first; resuming does not. */
  const setActive = async (enabled: boolean) => {
    if (
      !enabled &&
      !(await confirmDialog({
        action: 'confirm',
        danger: false,
        title: t('detail.pauseTitle', { name: m.name }),
        message: t('detail.pauseConfirm'),
        confirmLabel: t('detail.pause'),
      }))
    )
      return;
    try {
      await post(`/monitors/${m.id}/enabled`, { enabled });
      notifyOk(enabled ? t('detail.resumed') : t('detail.pausedOk'));
    } catch (e) {
      notifyError(e);
    }
    refresh();
  };

  return (
    <>
      <DetailHeader
        recent={{ label: m.name, kind: 'monitor' }}
        back="monitors"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{m.name}</span>
            {m.isTemplate ? <Badge variant="outline">{t('detail.template')}</Badge> : <MonitorStatusBadge status={m.status} size="lg" />}
            {!m.isTemplate && <SettlingNote state={m.state} />}
            {!m.isTemplate && !m.enabled && (
              <Badge size="lg" variant="outline" color="gray" leftSection={<IconPlayerPause size={14} aria-hidden />} data-testid="monitor-paused">
                {t('detail.paused')}
              </Badge>
            )}
            <GitOriginBadge kind="monitor" id={m.id} />
            <LibraryOriginBadge kind="monitor" id={m.id} />
          </Group>
        }
        description={
          <>
            <span className="mono">{m.key}</span> · {t('detail.owner', { owner: m.owner })}
            {!m.isTemplate && m.since && ` · ${t('detail.since', { date: fmtDate(m.since) })}`}
            <CopyId id={m.id} />
            <CopiedFromNote kind="monitor" id={m.id} pathOf={(id) => `/monitors/${id}`} />
          </>
        }
        actions={
          <>
            {!m.isTemplate && can('edit') && (
              <Button
                size="xs"
                variant="default"
                leftSection={m.enabled ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
                onClick={() => void setActive(!m.enabled)}
              >
                {m.enabled ? t('detail.pause') : t('detail.resume')}
              </Button>
            )}
            {!m.isTemplate && can('acknowledge') && (
              <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} loading={busy} onClick={runNow} disabled={!m.enabled}>
                {t('detail.checkNow')}
              </Button>
            )}
            {!m.isTemplate && can('acknowledge') && m.definition.checks.some((c) => c.type === 'platform' || c.type === 'freshness') && (
              <TestRunButton monitorId={m.id} />
            )}
            {m.isTemplate && (
              <Button size="xs" onClick={() => setInstances(true)}>
                {t('detail.newFromTemplate')}
              </Button>
            )}
            {canCreate && <DuplicateButton kind="monitor" id={m.id} />}
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
                {!m.isTemplate && can('acknowledge') && m.status !== 'up' && m.status !== 'off' && !m.acknowledged && (
                  <Menu.Item leftSection={<IconCheck size={14} />} onClick={() => setAck(true)}>
                    {t('detail.acknowledgeProblem')}
                  </Menu.Item>
                )}
                {!m.isTemplate && canStartReview && (
                  <Menu.Item leftSection={<IconReportMedical size={14} />} onClick={() => setReviewing(true)}>
                    {tr('review.start')}
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
                        qc.invalidateQueries({ queryKey: monitorKeys.all });
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
            {m.offHours ? ` · ${offText(m.offHours)}` : ''}
          </Text>
        )}
        <OffBanner monitor={m} />
        <StateProblemBanner monitor={m} />
        {!m.isTemplate && m.rootCauses.length > 0 && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />} title={t('list.rootCause')} data-testid="monitor-root-cause">
            {(m.state?.reason === 'contradiction' || m.state?.reason === 'required') && (
              <Text size="sm" fw={600} mb={4} data-testid="monitor-contradiction">
                {m.state.message}
              </Text>
            )}
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
              <Button size="compact-xs" variant="light" onClick={() => setOpenWindow(m.maintenance!.id)}>
                {t('maintenance.open')}
              </Button>
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
        {!m.enabled && !m.isTemplate && (
          <Alert color="gray" icon={<IconPlayerPause size={18} />}>
            {t('detail.disabled')}
          </Alert>
        )}
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
                settlingIds={m.isTemplate ? undefined : settlingCheckIds(m.state)}
                selected={selected}
                onSelect={select}
                height={isMobile ? 380 : 520}
              />
              <Text size="xs" c="dimmed" mt={4}>
                {t('detail.graphHint')}
              </Text>
              {!m.isTemplate && <WhyThisState monitor={m} onSelect={select} />}
              {!m.isTemplate && <ChecksTable monitor={m} onSelect={select} />}
              {/* 0.14: the mapped items of plant collections its checks cover */}
              {!m.isTemplate && caps.plant === true && <MonitorIhCoverage monitorId={m.id} />}
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
          <MaintenanceList monitor={m} onPlan={() => setMaint(true)} onOpen={setOpenWindow} />
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
          {/* 0.23.0 (ADR 0033 phase 2): the access list became shares – the Access tab, the owner beside it */}
          <OwnerField kind="monitor" id={m.id} owner={m.owner} canChange={m.permissions.includes('manage')} onSaved={refresh} />
          <AccessTab kind="monitor" id={m.id} />
        </Tabs.Panel>
      </Tabs>
      {maint && (
        <MaintenanceFormModal
          preset={{ kind: 'monitor', id: m.id }}
          onClose={() => setMaint(false)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
            refresh();
          }}
        />
      )}
      {openWindow && (
        <MaintenanceDetailModal
          id={openWindow}
          onClose={() => {
            setOpenWindow(null);
            void qc.invalidateQueries({ queryKey: ['maintenance-windows'] });
            refresh();
          }}
        />
      )}
      {reviewing && <MonitorReviewModal monitorId={m.id} since={m.status === 'down' ? m.since : null} onClose={() => setReviewing(false)} />}
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
  const settling = new Set(settlingCheckIds(monitor.state));
  return (
    <TableScroll style={{ marginTop: 12 }}>
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
                <Group gap={4} wrap="nowrap">
                  <MonitorStatusBadge status={c.status} variant="light" />
                  {settling.has(c.checkId) && <CheckSettlingBadge until={monitor.state?.settlingUntil} />}
                </Group>
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
    </TableScroll>
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
    queryKey: monitorKeys.results(monitor.id, c.checkId, c.last?.ts),
    queryFn: () => get<CheckResultInfo[]>(`/monitors/${monitor.id}/checks/${encodeURIComponent(c.checkId)}/results?limit=20`),
  });
  const history = useQuery({
    queryKey: monitorKeys.history(monitor.id, c.checkId, c.since),
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
        {settlingCheckIds(monitor.state).includes(c.checkId) && <CheckSettlingBadge until={monitor.state?.settlingUntil} />}
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
      {c.observedDelay && <ObservedDelaySummary observed={c.observedDelay} />}
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
          POST {appUrl()}
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
            <CopyBlock label={t('secrets.url')} text={appUrl(c.heartbeat!.path)} />
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
    queryKey: monitorKeys.history(monitor.id, 'all', monitor.lastEvaluatedAt),
    queryFn: () => get<MonitorHistoryEntry[]>(`/monitors/${monitor.id}/history?limit=200`),
  });
  const name = new Map(monitor.checks.map((c) => [c.checkId, c.name]));
  const { t } = useTranslation('monitors');
  return (
    <TableScroll>
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
    </TableScroll>
  );
}

/**
 * The maintenance windows of the monitor: catalogue windows (0.11, ADR 0018) that list it or reach a platform it checks,
 * from 90 days ago on. Planned, changed and cancelled with the catalogue's window form; the details open on click.
 */
function MaintenanceList({ monitor, onPlan, onOpen }: { monitor: MonitorDetail; onPlan: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation('monitors');
  const repeat = useRepeatLabel();
  const [range] = useState(() => ({ from: new Date(Date.now() - 90 * 86400000).toISOString(), to: new Date(Date.now() + 300 * 86400000).toISOString() }));
  const w = useQuery({
    queryKey: ['maintenance-windows', 'target', 'monitor', monitor.id, monitor.maintenance?.id],
    queryFn: () =>
      get<MaintenanceListData>(
        `/maintenance-windows?target=${encodeURIComponent(`monitor:${monitor.id}`)}&from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`,
      ),
  });
  // newest first: the current or next occurrence, else the last one in the range
  const lastOf = (id: string) => (w.data?.occurrences ?? []).filter((o) => o.windowId === id).at(-1);
  const windows = [...(w.data?.windows ?? [])]
    .map((x) => ({ x, at: x.current ?? lastOf(x.id) ?? { startsAt: x.startsAt, endsAt: x.endsAt, active: false } }))
    .sort((a, b) => b.at.startsAt.localeCompare(a.at.startsAt));
  return (
    <Stack data-testid="monitor-maintenance">
      <Text size="sm" c="dimmed">
        {t('maintenance.intro')} {t('maintenance.vsPause')} {t('maintenance.catalogue')}
      </Text>
      {monitor.permissions.includes('acknowledge') && (
        <Button size="xs" w="fit-content" leftSection={<IconTool size={14} />} onClick={onPlan}>
          {t('maintenance.plan')}
        </Button>
      )}
      {w.isSuccess && windows.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('maintenance.none')}
        </Text>
      )}
      {windows.map(({ x, at }) => {
        const direct = x.targets.some((y) => y.kind === 'monitor' && y.id === monitor.id);
        const others = x.targets.filter((y) => !(y.kind === 'monitor' && y.id === monitor.id));
        return (
          <Paper key={x.id} withBorder p="xs" data-testid="monitor-maintenance-window">
            <Stack gap={2} style={{ minWidth: 0 }}>
              <Anchor component="button" type="button" size="sm" fw={500} ta="left" onClick={() => onOpen(x.id)}>
                {x.title}
              </Anchor>
              <Group gap={6} wrap="wrap">
                {at.active && (
                  <Badge size="sm" color="orange" variant="filled" style={{ flexShrink: 0 }}>
                    {t('maintenance.active')}
                  </Badge>
                )}
                <Text size="sm">
                  {fmtDate(at.startsAt)} – {fmtDate(at.endsAt)}
                </Text>
              </Group>
              <Text size="xs" c="dimmed">
                {x.recurrence ? `${repeat(x)} · ` : ''}
                {direct ? t('maintenance.listsMonitor') : t('maintenance.reachesMonitor')} · {x.createdBy}
              </Text>
              {others.length > 0 && <TargetBadges targets={others} />}
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

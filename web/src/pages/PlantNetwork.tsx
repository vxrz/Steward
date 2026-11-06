import { lazy, Suspense, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Menu, Paper, SimpleGrid, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowsLeftRight,
  IconChartDots3,
  IconDevices,
  IconDownload,
  IconGauge,
  IconLock,
  IconNetwork,
  IconPlus,
  IconRoute,
  IconSearch,
  IconShieldLock,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantConduitView, PlantHierarchySite, PlantSiteNetwork, PlantVlanValues, PlantVlanView, PlantZoneValues, PlantZoneView } from '@sm/shared';
import { apiUrl, del, get, notifyError } from '../api';
import { DetailState, EmptyState } from '../components/common';
import { DetailHeader } from '../components/page/DetailPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { confirmDanger } from '../components/confirm';
import { plantKeys } from '../queryKeys';
import { AssetStatusBadge, NotInSourceBadge, PreviewBadge, useNameOf, usePlantLabel } from '../components/plant/common';
import { RowMenu } from '../components/plant/data';
import { CriticalityBadge, ItemRefView, LiveBadge, LiveCounts, NetField, SlBadge } from '../components/plant/network';
import { ConduitModal, SegmentModal, VlanModal, ZoneModal } from '../components/plant/networkForms';
import { DataPathSummary, DeviceHints } from '../components/plant/AssetNetwork';

const TABS = ['', 'diagram', 'vlans', 'zones', 'devices', 'paths'] as const;
type Tab = (typeof TABS)[number];
const TAB_ICONS = { '': IconGauge, diagram: IconChartDots3, vlans: IconNetwork, zones: IconShieldLock, devices: IconDevices, paths: IconRoute } as const;

// the diagram (#230) loads with the graph library, only when its tab is opened
const NetworkDiagramView = lazy(() => import('./plant/views/NetworkDiagramView').then((m) => ({ default: m.NetworkDiagramView })));

type Dialog =
  | { kind: 'vlan'; vlan?: PlantVlanValues }
  | { kind: 'segment'; vlan: PlantVlanValues }
  | { kind: 'zone'; zone?: PlantZoneValues }
  | { kind: 'conduit'; conduit?: PlantConduitView };

const vlanValues = (v: PlantVlanView): PlantVlanValues => {
  const { segment: _s, segmentHint: _h, otherSites: _o, zones: _z, deviceCount: _d, importId: _i, notInSource: _n, ...rest } = v;
  return rest;
};
const zoneValues = (z: PlantZoneView): PlantZoneValues => {
  const { conduits: _c, deviceCount: _d, importId: _i, notInSource: _n, ...rest } = z;
  return rest;
};

function Section({
  title,
  help,
  action,
  children,
  testId,
}: {
  title: string;
  help?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Stack gap="xs" data-testid={testId}>
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Title order={2} fz="h4">
            {title}
          </Title>
          {help && (
            <Text size="xs" c="dimmed">
              {help}
            </Text>
          )}
        </div>
        {action}
      </Group>
      {children}
    </Stack>
  );
}

/**
 * The OT network of a site (#220), on tabs: the live status of its assets (the site's overview dashboard), its IEEE
 * 802.1Q VLANs (with the linked network segment), its IEC 62443-3-2 zones and conduits, the devices and the data
 * paths of its assets. One request holds everything (the diagram of #230 draws from the same answer).
 */
export function PlantNetworkPage() {
  const { t } = useTranslation(['plantNetwork', 'plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const { siteId, tab: rawTab } = useParams();
  const tab: Tab = (TABS as readonly string[]).includes(rawTab ?? '') ? ((rawTab ?? '') as Tab) : '';
  const qc = useQueryClient();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const q = useQuery({ queryKey: plantKeys.network(siteId), queryFn: () => get<PlantSiteNetwork>(`/plant/sites/${encodeURIComponent(siteId!)}/network`) });
  const hierarchy = useQuery({ queryKey: plantKeys.hierarchy, queryFn: () => get<PlantHierarchySite[]>('/plant/hierarchy'), enabled: !!q.data?.canManage });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [search, setSearch] = useState('');
  const n = q.data;
  if (!n) return <DetailState query={q} back="plantSites" />;
  const siteBase = `/plant/sites/${encodeURIComponent(n.site.id)}`;
  const base = `${siteBase}/network`;
  const can = n.canManage;
  const saved = (x: PlantSiteNetwork) => {
    qc.setQueryData(plantKeys.network(siteId), x);
    void qc.invalidateQueries({ queryKey: ['plant', 'assetNetwork'] });
  };
  const remove = async (what: 'vlans' | 'zones' | 'conduits', id: string, name: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t(`removeConfirm.${what}`, { name }) }))) return;
    try {
      saved(await del<PlantSiteNetwork>(`${siteBase}/${what}/${encodeURIComponent(id)}`));
    } catch (e) {
      notifyError(e);
    }
  };
  const zoneName = (id: string) => n.zones.find((z) => z.id === id)?.name ?? id;
  const vlanName = (id: string | null) => (id ? (n.vlans.find((v) => v.id === id)?.name ?? id) : '–');
  const addButton = (text: string, d: Dialog, testId: string) =>
    can && (
      <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setDialog(d)} data-testid={testId}>
        {text}
      </Button>
    );
  const counts: Partial<Record<Tab, number>> = {
    vlans: n.vlans.length,
    zones: n.zones.length + n.conduits.length,
    devices: n.devices.length,
    paths: n.dataPaths.length,
  };
  const s = search.trim().toLowerCase();
  const devices = s
    ? n.devices.filter((d) => [d.id, d.hostname, d.address, d.mac, d.assetName, d.switch, d.switchPort].some((x) => x.toLowerCase().includes(s)))
    : n.devices;

  return (
    <>
      <DetailHeader
        recent={{ label: t('pageTitle', { site: nameOf(n.site) }), kind: 'site' }}
        back={['plantSites', { to: siteBase, label: nameOf(n.site) }]}
        title={t('title')}
        status={<PreviewBadge />}
        description={t('pageHelp', { site: nameOf(n.site) })}
        actions={
          <Button
            size="xs"
            variant="default"
            component="a"
            href={apiUrl(`/plant/export?site=${encodeURIComponent(n.site.id)}`)}
            download
            leftSection={<IconDownload size={14} />}
          >
            {t('plant:export.site')}
          </Button>
        }
        tabs={
          <LinkTabs
            label={t('tabsLabel', { site: nameOf(n.site) })}
            active={tab ? `${base}/${tab}` : base}
            tabs={TABS.map((x) => ({
              to: x ? `${base}/${x}` : base,
              label: t(`tabs.${x || 'overview'}`),
              icon: TAB_ICONS[x],
              count: counts[x],
              testId: `network-tab-${x || 'overview'}`,
            }))}
          />
        }
      />
      <div data-testid={`network-${tab || 'overview'}`}>
        {tab === 'diagram' && (
          <Suspense fallback={null}>
            <NetworkDiagramView siteId={n.site.id} />
          </Suspense>
        )}
        {tab === '' && (
          <Stack gap="lg">
            <Section title={t('overview.title')} help={t('overview.help')}>
              <LiveCounts counts={n.statusCounts} />
            </Section>
            <Section title={label('asset', true)} testId="network-assets">
              {n.assets.length === 0 ? (
                <EmptyState compact icon={IconGauge} title={t('overview.noAssets', { type: label('asset', true, true) })} />
              ) : narrow ? (
                <Stack gap="xs">
                  {n.assets.map((a) => (
                    <Paper key={a.id} withBorder p="sm" data-testid={`live-${a.id}`}>
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(a.id)}`} size="sm" fw={500} style={{ minWidth: 0 }}>
                          {a.name}
                        </Anchor>
                        <LiveBadge live={a.live} size="xs" />
                      </Group>
                      <Text size="xs" c="dimmed">
                        {t('overview.counts', { devices: a.devices, paths: a.paths })}
                      </Text>
                    </Paper>
                  ))}
                </Stack>
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label={label('asset', true)}>
                  <Table fz="sm" aria-label={label('asset', true)}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('plant:form.name')}</Table.Th>
                        <Table.Th>{t('overview.status')}</Table.Th>
                        <Table.Th>{t('overview.live')}</Table.Th>
                        <Table.Th>{t('device.title')}</Table.Th>
                        <Table.Th>{t('path.title')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {n.assets.map((a) => (
                        <Table.Tr key={a.id} data-testid={`live-${a.id}`}>
                          <Table.Td>
                            <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(a.id)}`} size="sm" fw={500}>
                              {a.name}
                            </Anchor>
                          </Table.Td>
                          <Table.Td>
                            <AssetStatusBadge status={a.status as Parameters<typeof AssetStatusBadge>[0]['status']} size="xs" />
                          </Table.Td>
                          <Table.Td>
                            <LiveBadge live={a.live} size="xs" />
                          </Table.Td>
                          <Table.Td>{a.devices}</Table.Td>
                          <Table.Td>{a.paths}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Section>
          </Stack>
        )}

        {tab === 'vlans' && (
          <Section title={t('vlan.title')} help={t('vlan.help')} action={addButton(t('vlan.add'), { kind: 'vlan' }, 'add-vlan')} testId="network-vlans">
            {n.vlans.length === 0 ? (
              <EmptyState
                icon={IconNetwork}
                title={t('vlan.emptyTitle')}
                whoCanAct={can ? undefined : t('whoCanAct')}
                action={addButton(t('vlan.add'), { kind: 'vlan' }, 'add-vlan-empty')}
              >
                {t('vlan.emptyText')}
              </EmptyState>
            ) : (
              <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
                {n.vlans.map((v) => (
                  <Paper key={v.id} withBorder p="sm" data-testid={`vlan-${v.id}`}>
                    <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                      <Stack gap={6} style={{ minWidth: 0 }}>
                        <Group gap={6} wrap="wrap">
                          <Text fw={600} size="sm">
                            {v.name}
                          </Text>
                          {v.vid !== null && (
                            <Badge variant="light" color="blue" size="sm" style={{ minWidth: 'max-content' }}>
                              VID {v.vid}
                            </Badge>
                          )}
                          {v.type && (
                            <Badge variant="default" size="xs">
                              {v.type}
                            </Badge>
                          )}
                          {v.restricted && (
                            <Tooltip label={t('vlan.restrictedHelp')} multiline w={240} withArrow>
                              <Badge variant="outline" color="orange" size="xs" leftSection={<IconLock size={10} aria-hidden />}>
                                {t('vlan.restrictedBadge')}
                              </Badge>
                            </Tooltip>
                          )}
                          {v.notInSource && <NotInSourceBadge size="xs" />}
                        </Group>
                        <Text size="xs" c="dimmed" className="mono">
                          {v.id}
                        </Text>
                        {v.description && <Text size="sm">{v.description}</Text>}
                        <NetField label={t('vlan.subnets')}>
                          {v.subnets.length === 0 ? (
                            '–'
                          ) : (
                            <Stack gap={2}>
                              {v.subnets.map((x) => (
                                <div key={x.cidr}>
                                  <Text size="sm" className="mono">
                                    {x.cidr}
                                    {x.gateway && (
                                      <Text span size="xs" c="dimmed">
                                        {' '}
                                        · {t('vlan.gatewayIs', { address: x.gateway })}
                                      </Text>
                                    )}
                                  </Text>
                                  {x.ranges.length > 0 && (
                                    <Group gap={4} wrap="wrap">
                                      {x.ranges.map((r, i) => (
                                        <Badge
                                          key={i}
                                          size="xs"
                                          variant="outline"
                                          color={r.type === 'blocked' ? 'red' : r.type === 'dynamic' ? 'teal' : 'gray'}
                                          style={{ textTransform: 'none', minWidth: 'max-content' }}
                                        >
                                          {t(`rangeTypes.${r.type}`)}: {r.start} – {r.end}
                                        </Badge>
                                      ))}
                                    </Group>
                                  )}
                                </div>
                              ))}
                            </Stack>
                          )}
                        </NetField>
                        <Group gap="lg" wrap="wrap" style={{ rowGap: 6 }}>
                          <NetField label={t('vlan.segment')}>{v.segment ? <ItemRefView item={v.segment} /> : can ? t('vlan.noSegmentYet') : '–'}</NetField>
                          <NetField label={t('zone.title')}>{v.zones.map(zoneName).join(', ') || '–'}</NetField>
                          <NetField label={t('device.title')}>{v.deviceCount}</NetField>
                          {v.owner && <NetField label={t('owner')}>{v.owner}</NetField>}
                          {v.managedBy && <NetField label={t('vlan.managedBy')}>{v.managedBy}</NetField>}
                        </Group>
                        {(v.rulesAt || v.location || v.otherSites.length > 0) && (
                          <Group gap="lg" wrap="wrap" style={{ rowGap: 6 }}>
                            {v.rulesAt && <NetField label={t('vlan.rulesAt')}>{v.rulesAt}</NetField>}
                            {v.location && <NetField label={t('vlan.location')}>{v.location}</NetField>}
                            {v.otherSites.length > 0 && (
                              <NetField label={t('vlan.otherSites')}>
                                {v.otherSites.map((x, i) => (
                                  <span key={x.id}>
                                    {i > 0 && ', '}
                                    <Anchor component={Link} to={`/plant/sites/${encodeURIComponent(x.id)}/network/vlans`} size="sm">
                                      {x.name}
                                    </Anchor>
                                  </span>
                                ))}
                              </NetField>
                            )}
                          </Group>
                        )}
                        {v.segmentHint && (
                          <Alert color="orange" variant="light" p="xs" data-testid="segment-hint" title={t('vlan.hintTitle')}>
                            <Stack gap={2}>
                              {v.segmentHint.vidDiffers && <Text size="xs">{t('vlan.hintVid', { vlan: v.vid, segment: v.segment?.vid })}</Text>}
                              {v.segmentHint.onlyVlan.length > 0 && (
                                <Text size="xs">{t('vlan.hintOnlyVlan', { subnets: v.segmentHint.onlyVlan.join(', ') })}</Text>
                              )}
                              {v.segmentHint.onlySegment.length > 0 && (
                                <Text size="xs">{t('vlan.hintOnlySegment', { subnets: v.segmentHint.onlySegment.join(', ') })}</Text>
                              )}
                            </Stack>
                          </Alert>
                        )}
                      </Stack>
                      {can && (
                        <RowMenu
                          label={t('vlan.actions', { name: v.name })}
                          onEdit={() => setDialog({ kind: 'vlan', vlan: vlanValues(v) })}
                          onRemove={() => void remove('vlans', v.id, v.name)}
                          extra={
                            !v.segment && (
                              <Menu.Item
                                leftSection={<IconNetwork size={14} />}
                                onClick={() => setDialog({ kind: 'segment', vlan: vlanValues(v) })}
                                data-testid="create-segment"
                              >
                                {t('segment.create')}
                              </Menu.Item>
                            )
                          }
                        />
                      )}
                    </Group>
                  </Paper>
                ))}
              </SimpleGrid>
            )}
          </Section>
        )}

        {tab === 'zones' && (
          <Stack gap="lg">
            <Section title={t('zone.title')} help={t('zone.help')} action={addButton(t('zone.add'), { kind: 'zone' }, 'add-zone')} testId="network-zones">
              {n.zones.length === 0 ? (
                <EmptyState
                  icon={IconShieldLock}
                  title={t('zone.emptyTitle')}
                  whoCanAct={can ? undefined : t('whoCanAct')}
                  action={addButton(t('zone.add'), { kind: 'zone' }, 'add-zone-empty')}
                >
                  {t('zone.emptyText')}
                </EmptyState>
              ) : (
                <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
                  {n.zones.map((z) => (
                    <Paper key={z.id} withBorder p="sm" id={`zone-${z.id}`} data-testid={`zone-${z.id}`}>
                      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                        <Stack gap={6} style={{ minWidth: 0 }}>
                          <Group gap={6} wrap="wrap">
                            <Text fw={600} size="sm">
                              {z.name}
                            </Text>
                            <CriticalityBadge value={z.criticality} size="xs" />
                            <SlBadge value={z.slTarget} size="xs" />
                            {z.notInSource && <NotInSourceBadge size="xs" />}
                          </Group>
                          {z.description && <Text size="sm">{z.description}</Text>}
                          <Group gap="lg" wrap="wrap" style={{ rowGap: 6 }}>
                            <NetField label={t('zone.vlans')}>{z.vlans.map(vlanName).join(', ') || '–'}</NetField>
                            <NetField label={t('owner')}>{z.owner || '–'}</NetField>
                            <NetField label={t('device.title')}>{z.deviceCount}</NetField>
                          </Group>
                          {z.slTarget !== null && (
                            <Text size="xs" c="dimmed">
                              {t('zone.assessedBy', { assessment: z.riskAssessment, date: z.assessedAt ?? '–' })}
                            </Text>
                          )}
                          {z.notes && (
                            <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
                              {z.notes}
                            </Text>
                          )}
                        </Stack>
                        {can && (
                          <RowMenu
                            label={t('zone.actions', { name: z.name })}
                            onEdit={() => setDialog({ kind: 'zone', zone: zoneValues(z) })}
                            onRemove={() => void remove('zones', z.id, z.name)}
                          />
                        )}
                      </Group>
                    </Paper>
                  ))}
                </SimpleGrid>
              )}
            </Section>
            <Section
              title={t('conduit.title')}
              help={t('conduit.help')}
              action={n.zones.length >= 2 && addButton(t('conduit.add'), { kind: 'conduit' }, 'add-conduit')}
              testId="network-conduits"
            >
              {n.conduits.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {n.zones.length < 2 ? t('conduit.needZones') : t('conduit.none')}
                </Text>
              ) : (
                <Stack gap="xs">
                  {n.conduits.map((c) => {
                    const Arrow = c.direction === 'a_to_b' ? IconArrowRight : c.direction === 'b_to_a' ? IconArrowLeft : IconArrowsLeftRight;
                    return (
                      <Paper key={c.id} withBorder p="sm" id={`conduit-${c.id}`} data-testid={`conduit-${c.id}`}>
                        <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                          <Stack gap={6} style={{ minWidth: 0 }}>
                            <Group gap={6} wrap="wrap">
                              <Text fw={600} size="sm">
                                {c.name}
                              </Text>
                              {c.notInSource && <NotInSourceBadge size="xs" />}
                            </Group>
                            <Group gap={6} wrap="wrap" aria-label={t(`directions.${c.direction}`, { a: zoneName(c.zones[0]), b: zoneName(c.zones[1]) })}>
                              <Anchor href={`#zone-${c.zones[0]}`} size="sm">
                                {zoneName(c.zones[0])}
                              </Anchor>
                              <Arrow size={16} aria-hidden />
                              <Anchor href={`#zone-${c.zones[1]}`} size="sm">
                                {zoneName(c.zones[1])}
                              </Anchor>
                            </Group>
                            {c.description && <Text size="sm">{c.description}</Text>}
                            {c.protocols.length > 0 && (
                              <Group gap={4} wrap="wrap">
                                {c.protocols.map((p) => (
                                  <Badge key={p} size="xs" variant="light" color="blue" style={{ textTransform: 'none' }}>
                                    {p}
                                  </Badge>
                                ))}
                              </Group>
                            )}
                            {c.controls.length > 0 && (
                              <NetField label={t('conduit.controls')}>
                                <Text size="sm">{c.controls.join(' · ')}</Text>
                              </NetField>
                            )}
                            <NetField label={t('conduit.linkedFrom')}>
                              {c.linkedFrom.length === 0 ? (
                                <Text size="sm" c="dimmed">
                                  {t('conduit.noFirewallChanges')}
                                </Text>
                              ) : (
                                <Stack gap={2}>
                                  {c.linkedFrom.map((l) => (
                                    <Anchor key={`${l.kind}:${l.id}`} component={Link} to={l.path} size="sm">
                                      {l.label}
                                      {l.note && (
                                        <Text span size="xs" c="dimmed">
                                          {' '}
                                          · {l.note}
                                        </Text>
                                      )}
                                    </Anchor>
                                  ))}
                                </Stack>
                              )}
                            </NetField>
                          </Stack>
                          {can && (
                            <RowMenu
                              label={t('conduit.actions', { name: c.name })}
                              onEdit={() => setDialog({ kind: 'conduit', conduit: c })}
                              onRemove={() => void remove('conduits', c.id, c.name)}
                            />
                          )}
                        </Group>
                      </Paper>
                    );
                  })}
                </Stack>
              )}
            </Section>
          </Stack>
        )}

        {tab === 'devices' && (
          <Section title={t('device.title')} help={t('device.siteHelp')} testId="network-devices">
            {n.devices.length === 0 ? (
              <EmptyState icon={IconDevices} title={t('device.emptyTitle')} whoCanAct={can ? undefined : t('whoCanAct')}>
                {t('device.emptyText', { type: label('asset', false, true) })}
              </EmptyState>
            ) : (
              <>
                <TextInput
                  leftSection={<IconSearch size={14} aria-hidden />}
                  placeholder={t('device.search')}
                  aria-label={t('device.search')}
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  maw={360}
                />
                {devices.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('device.noMatch')}
                  </Text>
                ) : narrow ? (
                  <Stack gap="xs">
                    {devices.map((d) => (
                      <Paper key={`${d.assetId}/${d.id}`} withBorder p="sm" data-testid={`site-device-${d.id}`}>
                        <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
                          <Stack gap={2} style={{ minWidth: 0 }}>
                            <Text size="sm" fw={500} className="mono" style={{ overflowWrap: 'anywhere' }}>
                              {d.hostname || d.id}
                            </Text>
                            <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(d.assetId)}`} size="xs">
                              {d.assetName}
                            </Anchor>
                            <Text size="xs" className="mono">
                              {[d.address, d.mac].filter(Boolean).join(' · ') || '–'}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {[vlanName(d.vlan), [d.switch, d.switchPort].filter(Boolean).join(' ')].filter((x) => x && x !== '–').join(' · ')}
                            </Text>
                            <DeviceHints device={d} />
                          </Stack>
                          <LiveBadge live={d.live} size="xs" />
                        </Group>
                      </Paper>
                    ))}
                  </Stack>
                ) : (
                  <div className="table-scroll" tabIndex={0} role="region" aria-label={t('device.title')}>
                    <Table fz="sm" aria-label={t('device.title')} miw={760}>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t('device.hostname')}</Table.Th>
                          <Table.Th>{label('asset')}</Table.Th>
                          <Table.Th>{t('device.address')}</Table.Th>
                          <Table.Th>{t('device.mac')}</Table.Th>
                          <Table.Th>{t('device.vlan')}</Table.Th>
                          <Table.Th>{t('device.port')}</Table.Th>
                          <Table.Th>{t('device.state')}</Table.Th>
                          <Table.Th>{t('overview.live')}</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {devices.map((d) => (
                          <Table.Tr key={`${d.assetId}/${d.id}`} data-testid={`site-device-${d.id}`}>
                            <Table.Td>
                              <Text size="sm" fw={500} className="mono">
                                {d.hostname || d.id}
                              </Text>
                              <DeviceHints device={d} />
                            </Table.Td>
                            <Table.Td>
                              <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(d.assetId)}`} size="sm">
                                {d.assetName}
                              </Anchor>
                            </Table.Td>
                            <Table.Td className="mono">
                              {d.address || '–'}
                              {d.addressType && (
                                <Text size="xs" c="dimmed">
                                  {t(`addressTypes.${d.addressType}`)}
                                </Text>
                              )}
                            </Table.Td>
                            <Table.Td className="mono">{d.mac || '–'}</Table.Td>
                            <Table.Td>{vlanName(d.vlan)}</Table.Td>
                            <Table.Td className="mono">{[d.switch, d.switchPort].filter(Boolean).join(' · ') || '–'}</Table.Td>
                            <Table.Td>{t(`deviceStates.${d.state}`)}</Table.Td>
                            <Table.Td>
                              <LiveBadge live={d.live} size="xs" />
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </div>
                )}
              </>
            )}
          </Section>
        )}

        {tab === 'paths' && (
          <Section title={t('path.title')} help={t('path.siteHelp')} testId="network-paths">
            {n.dataPaths.length === 0 ? (
              <EmptyState icon={IconRoute} title={t('path.emptyTitle')} whoCanAct={can ? undefined : t('whoCanAct')}>
                {t('path.emptyText', { type: label('asset', false, true) })}
              </EmptyState>
            ) : (
              <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="sm">
                {n.dataPaths.map((p) => (
                  <Paper key={`${p.assetId}/${p.id}`} withBorder p="sm" data-testid={`site-path-${p.id}`}>
                    <Stack gap={4}>
                      <Text size="sm" fw={600}>
                        {p.subject}
                      </Text>
                      <DataPathSummary path={p} withAsset />
                    </Stack>
                  </Paper>
                ))}
              </SimpleGrid>
            )}
          </Section>
        )}
      </div>
      {dialog?.kind === 'vlan' && (
        <VlanModal
          network={n}
          vlan={dialog.vlan}
          sites={(hierarchy.data ?? []).map((x) => ({ id: x.id, name: nameOf(x) }))}
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
      {dialog?.kind === 'segment' && <SegmentModal siteId={n.site.id} vlan={dialog.vlan} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'zone' && <ZoneModal network={n} zone={dialog.zone} onClose={() => setDialog(null)} onSaved={saved} />}
      {dialog?.kind === 'conduit' && (
        <ConduitModal
          network={n}
          conduit={
            dialog.conduit && {
              id: dialog.conduit.id,
              name: dialog.conduit.name,
              description: dialog.conduit.description,
              zones: dialog.conduit.zones,
              direction: dialog.conduit.direction,
              protocols: dialog.conduit.protocols,
              controls: dialog.conduit.controls,
              notes: dialog.conduit.notes,
            }
          }
          onClose={() => setDialog(null)}
          onSaved={saved}
        />
      )}
    </>
  );
}

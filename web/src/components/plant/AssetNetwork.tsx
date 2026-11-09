import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconArrowRight, IconNetwork, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantAssetNetwork, PlantDataPathValues, PlantDataPathView, PlantDeviceValues, PlantDeviceView } from '@sm/shared';
import { del, get, notifyError } from '../../api';
import { EmptyState, QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { plantKeys } from '../../queryKeys';
import { NotInSourceBadge, usePlantLabel } from './common';
import { Breakable, RowMenu } from './data';
import { ItemRefView, LiveBadge, LiveChecks, NetField } from './network';
import { AssetChecksModal, DataPathModal, DeviceModal } from './networkForms';
import { Tokens } from './Tokens';

/** The values of a device as the API takes them (without what the view adds). */
export function deviceValues(d: PlantDeviceView): PlantDeviceValues {
  const { assetId: _a, assetName: _n, live: _l, hints: _h, importId: _i, notInSource: _s, ...v } = d;
  return v;
}
export function pathValues(p: PlantDataPathView): PlantDataPathValues {
  const {
    assetId: _a,
    assetName: _n,
    collectorRef: _c,
    collectorHost: _h,
    peers: _p,
    targets: _t,
    next: _x,
    previous: _y,
    nextMore: _xm,
    previousMore: _ym,
    importId: _i,
    notInSource: _s,
    ...v
  } = p;
  return v;
}

type Dialog = { kind: 'device'; device?: PlantDeviceValues } | { kind: 'path'; path?: PlantDataPathValues } | { kind: 'checks' };

/** What looks wrong with a device (VLAN, address). */
export function DeviceHints({ device }: { device: PlantDeviceView }) {
  const { t } = useTranslation('plantNetwork');
  if (!device.hints.length) return null;
  return (
    <Group gap={4}>
      {device.hints.map((h) => (
        <Badge key={h} size="xs" color="orange" variant="light" style={{ minWidth: 'max-content' }}>
          {t(`hints.${h}`)}
        </Badge>
      ))}
    </Group>
  );
}

/** A data path in a few lines: collector, transfers, destinations and the links of its chain. */
export function DataPathSummary({ path, withAsset }: { path: PlantDataPathView; withAsset?: boolean }) {
  const { t } = useTranslation('plantNetwork');
  const chain = (x: { assetId: string; assetName: string; pathId: string; subject: string }) => (
    <Anchor
      key={`${x.assetId}/${x.pathId}`}
      component={Link}
      to={`/plant/assets/${encodeURIComponent(x.assetId)}#path-${encodeURIComponent(x.pathId)}`}
      size="xs"
    >
      {x.subject} · {x.assetName}
    </Anchor>
  );
  return (
    <Stack gap={4} style={{ minWidth: 0 }}>
      {withAsset && (
        <Text size="xs" c="dimmed">
          <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(path.assetId)}`} size="xs">
            {path.assetName}
          </Anchor>
        </Text>
      )}
      {path.description && (
        <Text size="sm" c="dimmed">
          {path.description}
        </Text>
      )}
      <Group gap={6} wrap="wrap">
        <Text size="xs" c="dimmed">
          {t('path.collector')}:
        </Text>
        {path.collector ? (
          <>
            <Badge size="xs" variant="default">
              {t(`collectorKinds.${path.collector.kind}`)}
            </Badge>
            <ItemRefView item={path.collectorRef} />
            {path.collectorHost && (
              <Text size="xs" c="dimmed" component="span">
                {t('path.onHost')} <ItemRefView item={path.collectorHost} />
              </Text>
            )}
          </>
        ) : (
          <Text size="sm">–</Text>
        )}
      </Group>
      {path.transfers.map((x, i) => (
        <Group key={i} gap={6} wrap="wrap" data-testid="path-transfer">
          <Badge size="xs" variant="light" color="blue">
            {t(`modes.${x.mode}`)}
          </Badge>
          <Text size="sm" className="mono">
            {x.protocol}
            {x.port ? `/${x.port}` : ''}
          </Text>
          <Text size="xs" c="dimmed">
            {x.mode === 'pull' ? t('path.from') : t('path.to')}
          </Text>
          {x.peerKind === 'system' ? <ItemRefView item={path.peers[i] ?? null} fallback={x.peer} /> : <Text size="sm">{x.peer || '–'}</Text>}
        </Group>
      ))}
      {path.destinations.length > 0 && (
        <Group gap={6} wrap="wrap">
          <IconArrowRight size={14} aria-hidden />
          {path.destinations.map((x, i) => (
            <Text key={i} size="sm" component="span" style={{ overflowWrap: 'anywhere' }}>
              {x.kind === 'other' ? x.ref : <ItemRefView item={path.targets[i] ?? null} fallback={x.ref} />}
              {x.path && (
                <Text span size="xs" c="dimmed" className="mono code-wrap">
                  {' '}
                  <Breakable text={x.path} />
                </Text>
              )}
            </Text>
          ))}
        </Group>
      )}
      {(path.previous.length > 0 || path.next.length > 0) && (
        <Stack gap={2} data-testid="path-chain">
          {path.previous.length > 0 && (
            <Group gap={6} wrap="wrap">
              <Text size="xs" c="dimmed">
                {t('path.comesFrom')}
              </Text>
              {path.previous.map(chain)}
              {path.previousMore > 0 && (
                <Text size="xs" c="dimmed">
                  {t('path.chainMore', { count: path.previousMore })}
                </Text>
              )}
            </Group>
          )}
          {path.next.length > 0 && (
            <Group gap={6} wrap="wrap">
              <Text size="xs" c="dimmed">
                {t('path.continuesIn')}
              </Text>
              {path.next.map(chain)}
              {path.nextMore > 0 && (
                <Text size="xs" c="dimmed">
                  {t('path.chainMore', { count: path.nextMore })}
                </Text>
              )}
            </Group>
          )}
        </Stack>
      )}
    </Stack>
  );
}

/**
 * The OT network of an asset (#220): its live status from the linked checks, its devices (network identity) and its
 * data paths. Who sees the site sees it; who manages the site changes it.
 */
export function AssetNetworkSection({ assetId }: { assetId: string }) {
  const { t } = useTranslation(['plantNetwork', 'common']);
  const label = usePlantLabel();
  const qc = useQueryClient();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const q = useQuery({
    queryKey: plantKeys.assetNetwork(assetId),
    queryFn: () => get<PlantAssetNetwork>(`/plant/assets/${encodeURIComponent(assetId)}/network`),
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const n = q.data;
  if (!n) return <QueryState query={q} rows={2} />;
  const base = `/plant/assets/${encodeURIComponent(assetId)}`;
  const done = (x: PlantAssetNetwork) => {
    qc.setQueryData(plantKeys.assetNetwork(assetId), x);
    void qc.invalidateQueries({ queryKey: plantKeys.network(x.asset.siteId) });
  };
  const remove = async (what: 'devices' | 'paths', id: string, name: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t(what === 'devices' ? 'device.removeConfirm' : 'path.removeConfirm', { name }) }))) return;
    try {
      done(await del<PlantAssetNetwork>(`${base}/${what}/${encodeURIComponent(id)}`));
    } catch (e) {
      notifyError(e);
    }
  };
  const can = n.canManage;
  const add = (text: string, d: Dialog, testId: string) =>
    can && (
      <Button
        size="compact-xs"
        variant="default"
        leftSection={<IconPlus size={12} />}
        onClick={() => setDialog(d)}
        data-testid={testId}
        style={{ flex: 'none' }}
      >
        {text}
      </Button>
    );
  const empty = !n.devices.length && !n.dataPaths.length && !n.checks.length;
  return (
    <Stack gap="sm" data-testid="asset-network">
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs">
            <Title order={2} fz="h4">
              {t('asset.title')}
            </Title>
            <LiveBadge live={n.live} />
          </Group>
          <Text size="xs" c="dimmed">
            {t('asset.help')}
          </Text>
        </div>
        <Button
          size="xs"
          variant="subtle"
          component={Link}
          to={`/plant/sites/${encodeURIComponent(n.asset.siteId)}/network`}
          leftSection={<IconNetwork size={14} />}
          style={{ flex: 'none' }}
        >
          {t('asset.siteNetwork')}
        </Button>
      </Group>
      {empty && !can ? (
        <EmptyState compact icon={IconNetwork} title={t('asset.emptyTitle')} whoCanAct={t('whoCanAct')}>
          {t('asset.emptyText', { type: label('asset', false, true) })}
        </EmptyState>
      ) : (
        <Paper withBorder p="md">
          <Stack gap="md">
            <Stack gap={6} data-testid="asset-live">
              <Group justify="space-between" wrap="nowrap" gap="xs">
                <div>
                  <Text size="sm" fw={600}>
                    {t('live.title')}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t('live.help')}
                  </Text>
                </div>
                {can && (
                  <Button
                    size="compact-xs"
                    variant="default"
                    onClick={() => setDialog({ kind: 'checks' })}
                    style={{ flex: 'none' }}
                    data-testid="edit-asset-checks"
                  >
                    {t('checks.edit')}
                  </Button>
                )}
              </Group>
              <LiveChecks live={{ ...n.live, checks: n.live.checks }} empty={t('live.noOwnChecks')} />
            </Stack>
            <Stack gap={6} data-testid="asset-devices">
              <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600}>
                    {t('device.title')}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t('device.help')}
                  </Text>
                </div>
                {add(t('device.add'), { kind: 'device' }, 'add-device')}
              </Group>
              {n.devices.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('device.none')}
                </Text>
              ) : (
                <Stack gap="xs">
                  {n.devices.map((d) => (
                    <Paper key={d.id} withBorder p="sm" data-testid={`device-${d.id}`}>
                      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                        <Stack gap={4} style={{ minWidth: 0 }}>
                          <Group gap={6} wrap="wrap">
                            <Text size="sm" fw={500} className="mono" style={{ overflowWrap: 'anywhere' }}>
                              {d.hostname ? `${d.hostname}${d.domain ? `.${d.domain}` : ''}` : d.id}
                            </Text>
                            <LiveBadge live={d.live} size="xs" />
                            {d.state !== 'active' && (
                              <Badge size="xs" variant="default">
                                {t(`deviceStates.${d.state}`)}
                              </Badge>
                            )}
                            {d.notInSource && <NotInSourceBadge size="xs" />}
                          </Group>
                          {d.purpose && <Text size="xs">{d.purpose}</Text>}
                          <Group gap="lg" wrap="wrap" style={{ rowGap: 6 }}>
                            <NetField label={t('device.address')}>
                              {/* no address but a type: the type alone ("Dynamic (DHCP)"), not "– · Dynamic" */}
                              {d.address ? (
                                <>
                                  <span className="mono nowrap">{d.address}</span>
                                  {d.addressType && (
                                    <Text span size="xs" c="dimmed">
                                      {' '}
                                      · {t(`addressTypes.${d.addressType}`)}
                                    </Text>
                                  )}
                                </>
                              ) : d.addressType ? (
                                t(`addressTypes.${d.addressType}`)
                              ) : (
                                '–'
                              )}
                            </NetField>
                            <NetField label={t('device.vlan')}>
                              <span className="nowrap">{n.vlans.find((x) => x.id === d.vlan)?.name ?? d.vlan ?? '–'}</span>
                            </NetField>
                            <NetField label={t('device.mac')}>
                              <span className="mono nowrap">{d.mac || '–'}</span>
                            </NetField>
                            <NetField label={t('device.port')}>
                              <span className="mono">
                                <Tokens values={[d.switch, d.switchPort]} empty="–" />
                              </span>
                            </NetField>
                          </Group>
                          {(d.flags.length > 0 || d.confidence) && (
                            <Group gap={4}>
                              {d.flags.map((f) => (
                                <Badge key={f} size="xs" variant="outline" color="gray" style={{ textTransform: 'none' }}>
                                  {t(`flags.${f}`, { defaultValue: f.replace(/_/g, ' ') })}
                                </Badge>
                              ))}
                              {d.confidence && (
                                <Badge size="xs" variant="light" color={d.confidence === 'high' ? 'green' : d.confidence === 'medium' ? 'yellow' : 'orange'}>
                                  {t('device.confidenceIs', { value: t(`confidence.${d.confidence}`) })}
                                </Badge>
                              )}
                            </Group>
                          )}
                          <DeviceHints device={d} />
                          {d.live.checks.length > 0 && <LiveChecks live={d.live} />}
                        </Stack>
                        {can && (
                          <RowMenu
                            label={t('device.actions', { name: d.hostname || d.id })}
                            onEdit={() => setDialog({ kind: 'device', device: deviceValues(d) })}
                            onRemove={() => void remove('devices', d.id, d.hostname || d.id)}
                          />
                        )}
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              )}
            </Stack>
            <Stack gap={6} data-testid="asset-paths">
              <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600}>
                    {t('path.title')}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {t('path.help')}
                  </Text>
                </div>
                {add(t('path.add'), { kind: 'path' }, 'add-path')}
              </Group>
              {n.dataPaths.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('path.none')}
                </Text>
              ) : narrow ? (
                <Stack gap="xs">
                  {n.dataPaths.map((p) => (
                    <Paper key={p.id} withBorder p="sm" id={`path-${p.id}`} data-testid={`path-${p.id}`}>
                      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                        <Stack gap={4} style={{ minWidth: 0 }}>
                          <Text size="sm" fw={500}>
                            {p.subject}
                          </Text>
                          <DataPathSummary path={p} />
                        </Stack>
                        {can && (
                          <RowMenu
                            label={t('path.actions', { name: p.subject })}
                            onEdit={() => setDialog({ kind: 'path', path: pathValues(p) })}
                            onRemove={() => void remove('paths', p.id, p.subject)}
                          />
                        )}
                      </Group>
                    </Paper>
                  ))}
                </Stack>
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label={t('path.title')}>
                  <Table fz="sm" aria-label={t('path.title')} verticalSpacing="xs">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('path.subject')}</Table.Th>
                        <Table.Th>{t('path.devices')}</Table.Th>
                        <Table.Th>{t('path.how')}</Table.Th>
                        {can && <Table.Th aria-label={t('actions')} />}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {n.dataPaths.map((p) => (
                        <Table.Tr key={p.id} id={`path-${p.id}`} data-testid={`path-${p.id}`}>
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            <Text size="sm" fw={500}>
                              {p.subject}
                            </Text>
                            <Text size="xs" c="dimmed" className="mono">
                              {p.id}
                            </Text>
                            {p.notInSource && <NotInSourceBadge size="xs" />}
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            <Text size="sm" className="mono">
                              {p.devices.join(', ') || '–'}
                            </Text>
                          </Table.Td>
                          <Table.Td style={{ verticalAlign: 'top' }}>
                            <DataPathSummary path={{ ...p, description: '' }} />
                          </Table.Td>
                          {can && (
                            <Table.Td style={{ verticalAlign: 'top' }}>
                              <RowMenu
                                label={t('path.actions', { name: p.subject })}
                                onEdit={() => setDialog({ kind: 'path', path: pathValues(p) })}
                                onRemove={() => void remove('paths', p.id, p.subject)}
                              />
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Stack>
          </Stack>
        </Paper>
      )}
      {dialog?.kind === 'device' && <DeviceModal network={n} device={dialog.device} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === 'path' && <DataPathModal network={n} path={dialog.path} onClose={() => setDialog(null)} onSaved={done} />}
      {dialog?.kind === 'checks' && <AssetChecksModal assetId={assetId} checks={n.checks} onClose={() => setDialog(null)} onSaved={done} />}
    </Stack>
  );
}

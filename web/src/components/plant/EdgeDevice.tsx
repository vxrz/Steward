import { Anchor, Badge, Group, List, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { IemDeviceStatus, PlantAssetEdge, PlantCollectsFrom, PlantSystemEdge } from '@sm/shared';
import { get } from '../../api';
import { useModuleOn } from '../../modules';
import { plantKeys } from '../../queryKeys';
import { fmtDate } from '../../format';
import { CollapsibleSection } from '../page/CollapsibleSection';

/**
 * Edge devices (0.25.0, ADR 0037 part 3, docs/PLANT.md#edge-devices): a device of an asset that is a Steward system.
 * The asset shows _Apps on this device_ with the device's Industrial Edge status and _Collects data from_; the system's
 * page the plant devices that are it and _Collects data from_. Derived on read; what the reader may not see is counted.
 */

const STATE_COLOR = { online: 'green', offline: 'red', unknown: 'gray', notOnboarded: 'gray' } as const;

/** The Industrial Edge status of a device: the state in words (never colour alone), firmware and last report. */
export function IemStatus({ status }: { status: IemDeviceStatus }) {
  const { t } = useTranslation('plantNetwork');
  if (!status.found)
    return (
      <Text size="xs" c="dimmed" data-testid="iem-status">
        {t('edge.iemNotFound', { id: status.deviceId })}
      </Text>
    );
  return (
    <Group gap={6} wrap="wrap" data-testid="iem-status">
      <Badge size="sm" variant="light" color={STATE_COLOR[status.state]} tt="none">
        {t(`edge.iemStates.${status.state}`)}
      </Badge>
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {[
          status.firmware ? t('edge.firmware', { firmware: status.firmware }) : null,
          status.lastSeen ? t('edge.lastReport', { date: fmtDate(status.lastSeen) }) : null,
          t('edge.rule', { interval: status.intervalMinutes, grace: status.graceMinutes }),
        ]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </Group>
  );
}

/** _Collects data from_: the collections whose collector runs there, grouped by the asset they read. */
export function CollectsFromList({ collects, testId }: { collects: PlantCollectsFrom; testId: string }) {
  const { t } = useTranslation('plantNetwork');
  return (
    <Stack gap="xs" data-testid={testId}>
      {!collects.groups.length && !collects.hidden && (
        <Text size="sm" c="dimmed">
          {t('edge.collectsNone')}
        </Text>
      )}
      {collects.groups.map((g) => (
        <Stack key={g.asset.id} gap={2}>
          <Text size="sm" fw={500}>
            <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(g.asset.id)}`} size="sm">
              {g.asset.name}
            </Anchor>{' '}
            <Text span size="xs" c="dimmed">
              {g.asset.siteName}
            </Text>
          </Text>
          <List size="sm" spacing={2} withPadding>
            {g.collections.map((c) => (
              <List.Item key={c.id}>
                <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(c.assetId)}/collections?collection=${encodeURIComponent(c.id)}`} size="sm">
                  {c.name}
                </Anchor>{' '}
                <Text span size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  {t(c.via === 'host' ? 'edge.viaHost' : 'edge.viaApplication', { collector: c.collectorLabel || t('notVisible') })} ·{' '}
                  {t('edge.items', { count: c.items })}
                </Text>
              </List.Item>
            ))}
          </List>
        </Stack>
      ))}
      {collects.hidden > 0 && (
        <Text size="xs" c="dimmed">
          {t('edge.collectsHidden', { count: collects.hidden })}
        </Text>
      )}
    </Stack>
  );
}

/** On the asset: its devices that are systems, the applications on them, their status, and what they collect. */
export function AssetEdgeSection({ assetId }: { assetId: string }) {
  const { t } = useTranslation(['plantNetwork', 'common']);
  const q = useQuery({
    queryKey: plantKeys.assetEdge(assetId),
    queryFn: () => get<PlantAssetEdge>(`/plant/assets/${encodeURIComponent(assetId)}/edge`),
  });
  const e = q.data;
  if (!e?.devices.length) return null;
  return (
    <CollapsibleSection id="asset-edge" title={t('edge.title')} description={t('edge.help')} count={e.devices.length} testId="asset-edge" collapseOnPhone>
      <Stack gap="md">
        {e.devices.map((d) => (
          <Stack key={d.deviceId} gap={6} data-testid={`edge-device-${d.deviceId}`}>
            <Group gap={6} wrap="wrap">
              <Text size="sm" fw={500} className="mono" style={{ overflowWrap: 'anywhere' }}>
                {d.hostname ? `${d.hostname}${d.domain ? `.${d.domain}` : ''}` : d.deviceId}
              </Text>
              <Text size="sm" c="dimmed">
                →
              </Text>
              {d.system ? (
                d.system.path ? (
                  <Anchor component={Link} to={d.system.path} size="sm">
                    {d.system.name}
                  </Anchor>
                ) : (
                  <Text size="sm">{d.system.name}</Text>
                )
              ) : (
                <Text size="sm" c="dimmed">
                  {t('edge.systemHidden')}
                </Text>
              )}
            </Group>
            {d.iem && <IemStatus status={d.iem} />}
            {d.system && (
              <Stack gap={2}>
                <Text size="sm" fw={600} id={`edge-apps-${d.deviceId}`}>
                  {t('edge.apps')}
                </Text>
                {d.apps.length === 0 && !d.hiddenApps ? (
                  <Text size="sm" c="dimmed">
                    {t('edge.noApps')}
                  </Text>
                ) : (
                  <List size="sm" spacing={2} withPadding aria-labelledby={`edge-apps-${d.deviceId}`}>
                    {d.apps.map((a) => (
                      <List.Item key={`${a.id}/${a.environment}`}>
                        {d.system?.path ? (
                          <Anchor component={Link} to={`/applications/${encodeURIComponent(a.id)}`} size="sm">
                            {a.name}
                          </Anchor>
                        ) : (
                          a.name
                        )}
                        {a.environment && (
                          <Text span size="xs" c="dimmed">
                            {' '}
                            · {a.environment}
                          </Text>
                        )}
                        {a.archived && (
                          <Badge ml={6} size="xs" variant="outline" color="gray">
                            {t('edge.archived')}
                          </Badge>
                        )}
                      </List.Item>
                    ))}
                  </List>
                )}
                {d.hiddenApps > 0 && (
                  <Text size="xs" c="dimmed">
                    {t('edge.appsHidden', { count: d.hiddenApps })}
                  </Text>
                )}
              </Stack>
            )}
          </Stack>
        ))}
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            {t('edge.collects')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('edge.collectsHelp')}
          </Text>
          <CollectsFromList collects={e.collects} testId="asset-collects-from" />
        </Stack>
      </Stack>
    </CollapsibleSection>
  );
}

/** On a system's page (the plant registry on): the plant devices that are it, and what collects data on it. */
export function SystemEdgePanels({ systemId }: { systemId: string }) {
  const { t } = useTranslation('plantNetwork');
  const on = useModuleOn('plant');
  const q = useQuery({
    queryKey: plantKeys.systemEdge(systemId),
    queryFn: () => get<PlantSystemEdge>(`/plant/systems/${encodeURIComponent(systemId)}/edge`),
    enabled: on,
  });
  const e = q.data;
  if (!on || !e || (!e.devices.length && !e.hiddenDevices && !e.collects.groups.length && !e.collects.hidden)) return null;
  return (
    <CollapsibleSection id="system-edge" title={t('edge.systemTitle')} variant="card" size="h5" testId="system-edge" collapseOnPhone>
      <Stack gap="sm">
        {(e.devices.length > 0 || e.hiddenDevices > 0) && (
          <Stack gap={2} data-testid="system-plant-devices">
            <Text size="sm" fw={600}>
              {t('edge.plantDevice')}
            </Text>
            {e.devices.map((d) => (
              <Text key={`${d.assetId}/${d.deviceId}`} size="sm" style={{ overflowWrap: 'anywhere' }}>
                <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(d.assetId)}`} size="sm">
                  {d.assetName}
                </Anchor>{' '}
                <Text span size="xs" c="dimmed">
                  {d.siteName}
                </Text>
                {' · '}
                <span className="mono">{d.hostname ? `${d.hostname}${d.domain ? `.${d.domain}` : ''}` : d.deviceId}</span>
                {d.address && <span className="mono"> · {d.address}</span>}
              </Text>
            ))}
            {e.hiddenDevices > 0 && (
              <Text size="xs" c="dimmed">
                {t('edge.devicesHidden', { count: e.hiddenDevices })}
              </Text>
            )}
            <Text size="xs" c="dimmed">
              {t('edge.hostNameHere')}
            </Text>
          </Stack>
        )}
        <Stack gap={2}>
          <Text size="sm" fw={600}>
            {t('edge.collects')}
          </Text>
          <CollectsFromList collects={e.collects} testId="system-collects-from" />
        </Stack>
      </Stack>
    </CollapsibleSection>
  );
}

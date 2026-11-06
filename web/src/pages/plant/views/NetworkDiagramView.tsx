import { useMemo } from 'react';
import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconArrowsExchange, IconNetwork, IconShieldLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantHostPlacement, PlantSiteNetwork } from '@sm/shared';
import { get } from '../../../api';
import { EmptyState, QueryState } from '../../../components/common';
import { plantKeys } from '../../../queryKeys';
import { usePlantLabel } from '../../../components/plant/common';
import { LegendItem, LineMark } from './common';
import { FlowView } from './FlowView';
import { networkGraph, type NetworkWords } from './networkGraph';
import { LIVE_REFRESH_MS } from './prefs';

/**
 * The OT network of a site as a picture (#230, view 5 – OT network → Diagram): IEC 62443-3-2 zones as areas with
 * their IEEE 802.1Q VLANs and the assets on them, the conduits between the zones, and the data paths drawn across
 * them in the direction they run – devices and VLANs on hover. Live status only from the checks #220 links; the rest
 * is documentation, with direction only. Draws from the same answer as the other tabs of the page.
 */
export function NetworkDiagramView({ siteId }: { siteId: string }) {
  const { t } = useTranslation(['plantViews', 'plantNetwork', 'plant']);
  const label = usePlantLabel();
  const q = useQuery({
    queryKey: plantKeys.network(siteId),
    queryFn: () => get<PlantSiteNetwork>(`/plant/sites/${encodeURIComponent(siteId)}/network`),
    refetchInterval: LIVE_REFRESH_MS,
  });
  const placement = useQuery({
    queryKey: plantKeys.placement(siteId),
    queryFn: () => get<PlantHostPlacement>(`/plant/sites/${encodeURIComponent(siteId)}/network/placement`),
  });
  const words: NetworkWords = useMemo(
    () => ({
      vid: (vid) => t('network.vid', { vid }),
      criticality: (c) => t(`plantNetwork:criticality.${c as 'low'}`),
      sl: (level) => (level ? t('plantNetwork:zone.sl', { level }) : t('plantNetwork:zone.slOpen')),
      direction: (d, a, b) => t(`plantNetwork:directions.${d as 'both'}`, { a, b }),
      devices: (count) => t('network.devices', { count }),
      paths: (count) => t('network.paths', { count }),
      deviceLine: (d) =>
        [d.address || t('network.noAddress'), d.vlan, t(`plantNetwork:deviceStates.${d.state as 'active'}`), t(`network.liveWords.${d.live as 'online'}`)].join(
          ' · ',
        ),
      collectorKind: (k) => t(`plantNetwork:collectorKinds.${k as 'job'}`),
      mode: (m) => t(`plantNetwork:modes.${m as 'pull'}`),
      on: (host) => t('network.on', { host }),
      label: {
        devices: t('plantNetwork:device.title'),
        subnets: t('network.subnets'),
        owner: t('plantNetwork:owner'),
        vlans: t('plantNetwork:zone.vlans'),
        protocols: t('plantNetwork:conduit.protocols'),
        controls: t('network.controls'),
        assessment: t('network.assessment'),
        managedBy: t('network.managedBy'),
        segment: t('network.segment'),
        restricted: t('network.restricted'),
      },
      yes: t('plant:yes'),
      hidden: t('node.hidden'),
      noVlan: t('network.noVlan'),
    }),
    [t],
  );
  const n = q.data;
  const graph = useMemo(() => (n ? networkGraph(n, placement.data, words) : null), [n, placement.data, words]);
  const base = `/plant/sites/${encodeURIComponent(siteId)}/network`;
  const notDrawn = n ? n.assets.filter((a) => !a.devices && !a.paths).length : 0;
  return (
    <Stack gap="sm" data-testid="ot-network-diagram">
      <div>
        <Title order={2} fz="h4">
          {t('network.title')}
        </Title>
        <Text size="xs" c="dimmed">
          {t('network.help', { type: label('asset', true, true) })}
        </Text>
      </div>
      <QueryState query={q} />
      {graph && graph.nodes.length === 0 ? (
        <EmptyState
          icon={IconNetwork}
          title={t('network.emptyTitle')}
          whoCanAct={n?.canManage ? undefined : t('plantNetwork:whoCanAct')}
          action={
            n?.canManage && (
              <Group gap="xs" justify="center">
                <Button variant="default" component={Link} to={`${base}/zones`}>
                  {t('plantNetwork:tabs.zones')}
                </Button>
                <Button variant="default" component={Link} to={`${base}/vlans`}>
                  {t('plantNetwork:tabs.vlans')}
                </Button>
              </Group>
            )
          }
          testId="network-diagram-empty"
        >
          {t('network.emptyText', { type: label('asset', true, true) })}
        </EmptyState>
      ) : (
        graph && (
          <>
            <FlowView
              graph={graph}
              viewId="ot-network"
              title={t('network.exportTitle', { site: n!.site.name })}
              counts="paths"
              pathsTitle={t('plantNetwork:path.title')}
              live={t('network.live')}
              testId="network-diagram-view"
              baseLegend={['flow']}
              legend={
                <>
                  <LegendItem mark={<LineMark kind="online" />}>{t('network.legendOnline')}</LegendItem>
                  <LegendItem mark={<LineMark kind="offline" />}>{t('network.legendOffline')}</LegendItem>
                  <LegendItem mark={<IconShieldLock size={14} style={{ color: 'var(--pv-conduit)' }} />}>{t('network.legendZone')}</LegendItem>
                  <LegendItem mark={<IconNetwork size={14} />}>{t('network.legendVlan')}</LegendItem>
                  <LegendItem mark={<IconArrowsExchange size={14} style={{ color: 'var(--pv-conduit)' }} />}>{t('network.legendConduit')}</LegendItem>
                  <LegendItem mark={<NoConduitMark />}>{t('network.legendNoConduit')}</LegendItem>
                </>
              }
            />
            {notDrawn > 0 && (
              <Text size="xs" c="dimmed" data-testid="network-not-drawn">
                {t('network.notDrawn', { count: notDrawn, type: label('asset', notDrawn !== 1, true) })}
              </Text>
            )}
          </>
        )
      )}
    </Stack>
  );
}

function NoConduitMark() {
  return (
    <svg width={34} height={10} viewBox="0 0 34 10" aria-hidden>
      <path d="M1 5 H27" className="pv-edge-base" data-no-conduit="true" strokeWidth={2} />
      <path d="M27 1 L33 5 L27 9 Z" fill="var(--pv-warn)" />
    </svg>
  );
}

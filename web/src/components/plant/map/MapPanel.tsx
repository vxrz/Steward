import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { Alert, Anchor, Group, Skeleton, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconMapOff } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PLANT_MAP_LIMITS, PLANT_MAP_STATES, type PlantMapClient, type PlantMapSite, type PlantMapStatus } from '@sm/shared';
import { get } from '../../../api';
import { useMe } from '../../../auth';
import { plantKeys } from '../../../queryKeys';
import { hasWebGl2, MapStateLabel } from './mapShared';
import type { SitesMapProps } from './SitesMap';

const SitesMap = lazy(() => import('./SitesMap'));
export const PositionPicker = lazy(() => import('./PositionPicker'));

/** A chunk that does not load (offline, a new release): the list stays, with a note. */
export class MapChunkBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Why the map is not drawn, in words; administrators get the source's last error and a link to the setting. */
export function MapNotice({ why, compact }: { why: 'off' | 'webgl' | 'load'; compact?: boolean }) {
  const { t } = useTranslation('plantMap');
  const { isAdmin: admin } = useMe();
  const status = useQuery({ queryKey: plantKeys.mapStatus, queryFn: () => get<PlantMapStatus>('/plant/map/status'), enabled: why === 'load' && admin });
  return (
    <Alert
      color={why === 'off' ? 'gray' : 'orange'}
      variant="light"
      icon={<IconMapOff size={18} />}
      title={compact ? undefined : t(`notice.${why}.title`)}
      data-testid={`map-notice-${why}`}
    >
      <Text size="sm">{t(`notice.${why}.text`)}</Text>
      {why === 'load' && admin && status.data?.reason && (
        <Text size="sm" mt={4} data-testid="map-failure-reason">
          {t('notice.reason', { reason: status.data.reason })}
        </Text>
      )}
      {admin && why !== 'webgl' && (
        <Anchor component={Link} to="/settings/modules#plant-map" size="sm">
          {t('notice.settings')}
        </Anchor>
      )}
    </Alert>
  );
}

/** The legend of the pins: every state as icon and word. */
export function MapLegend() {
  const { t } = useTranslation('plantMap');
  return (
    <Group gap="md" wrap="wrap" component="ul" m={0} p={0} aria-label={t('legend')} data-testid="map-legend">
      {PLANT_MAP_STATES.map((s) => (
        <li key={s} style={{ listStyle: 'none' }}>
          <MapStateLabel state={s} size="xs" />
        </li>
      ))}
    </Group>
  );
}

/** Why the map cannot be drawn here (null: it can): off, or no WebGL 2 in this browser. */
export function useMapUnavailable(config: PlantMapClient | undefined): 'off' | 'webgl' | null {
  const webgl = useMemo(() => hasWebGl2(), []);
  if (!config) return null;
  return !config.on ? 'off' : !webgl ? 'webgl' : null;
}

/**
 * The map, or why there is none: off, no WebGL 2, or the source failed (`onFailed` tells the parent, which then shows
 * the list). More than 2,000 positions: the first 2,000 are drawn, the list names all.
 */
export function MapPanel({
  config,
  sites,
  height,
  compact,
  onFailed,
  ...rest
}: Omit<SitesMapProps, 'config' | 'onFailed'> & { config: PlantMapClient | undefined; onFailed?: () => void }) {
  const { t } = useTranslation('plantMap');
  const webgl = useMemo(() => hasWebGl2(), []);
  const [failed, setFailed] = useState(false);
  const withGeo = sites.filter((s: PlantMapSite) => s.geo).length;
  if (!config) return <Skeleton height={height} radius="md" />;
  const why = !config.on ? 'off' : !webgl ? 'webgl' : failed ? 'load' : null;
  if (why) return <MapNotice why={why} compact={compact} />;
  const fallback = <MapNotice why="load" compact={compact} />;
  return (
    <>
      <MapChunkBoundary fallback={fallback}>
        <Suspense fallback={<Skeleton height={height} radius="md" />}>
          <SitesMap
            config={config}
            sites={sites}
            height={height}
            compact={compact}
            onFailed={() => {
              setFailed(true);
              onFailed?.();
            }}
            {...rest}
          />
        </Suspense>
      </MapChunkBoundary>
      {withGeo > PLANT_MAP_LIMITS.sites && (
        <Text size="xs" c="dimmed">
          {t('capped', { shown: PLANT_MAP_LIMITS.sites, total: withGeo })}
        </Text>
      )}
    </>
  );
}

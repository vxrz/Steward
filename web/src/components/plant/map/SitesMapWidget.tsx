import { useState } from 'react';
import { Anchor, Group, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMe } from '../../../auth';
import { useNameOf, usePlantConfig } from '../common';
import { MapPanel, useMapUnavailable } from './MapPanel';
import { MapStateLabel, useMapSites } from './mapShared';

/**
 * The dashboard widget "Sites map" (#234): the map of the sites the reader may see, small. Who does not see the plant
 * registry reads "not visible"; without the map (off, no WebGL 2, the source failed) the sites are listed with their
 * state. Never on status pages (they show no dashboard widgets).
 */
export default function SitesMapWidget() {
  const { t } = useTranslation(['plantMap', 'dashboards']);
  const { caps } = useMe();
  const nameOf = useNameOf();
  const visible = caps.plant === true;
  const cfg = usePlantConfig(visible);
  const sites = useMapSites(visible);
  const [failed, setFailed] = useState(false);
  const unavailable = useMapUnavailable(cfg.data?.map) ?? (failed ? 'load' : null);
  if (!visible)
    return (
      <Text size="sm" c="dimmed" data-testid="sites-map-hidden">
        {t('widget.notVisible')}
      </Text>
    );
  const list = sites.data?.sites ?? [];
  if (sites.isSuccess && !list.length)
    return (
      <Text size="sm" c="dimmed">
        {t('widget.none')}
      </Text>
    );
  return (
    <Stack gap="xs" data-testid="sites-map-widget">
      <MapPanel
        config={cfg.data?.map}
        sites={list}
        height={300}
        compact
        label={t('mapLabel', { type: t('widget.sites') })}
        testId="widget-map"
        onFailed={() => setFailed(true)}
      />
      {unavailable && (
        <Stack gap={4} component="ul" m={0} p={0}>
          {list.slice(0, 8).map((s) => (
            <Group key={s.id} component="li" gap="xs" justify="space-between" wrap="nowrap" style={{ listStyle: 'none' }}>
              <Anchor component={Link} to={`/plant/sites/${encodeURIComponent(s.id)}`} size="sm" truncate>
                {nameOf(s)}
              </Anchor>
              <MapStateLabel state={s.state} size="xs" />
            </Group>
          ))}
        </Stack>
      )}
      <Anchor component={Link} to="/plant/map" size="xs">
        {t('widget.open')}
      </Anchor>
    </Stack>
  );
}

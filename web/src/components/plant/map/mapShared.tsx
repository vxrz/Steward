import { Anchor, Group, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconCircleX, IconHelpCircle, type Icon } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { PlantMapClient, PlantMapSite, PlantMapSites, PlantMapState } from '@sm/shared';
import { authHeaders, get } from '../../../api';
import { BASE_PATH } from '../../../basePath';
import { plantKeys } from '../../../queryKeys';
import { LIVE_REFRESH_MS } from '../../../pages/plant/views/prefs';
import '../../../pages/plant/views/views.css';

/**
 * What the map of sites (#234) shares without loading MapLibre: the sites the reader may see, the style URL, the
 * request rule (only Steward's own map routes, with the session headers), the state marks and the attribution.
 */

export function useMapSites(enabled = true) {
  return useQuery({ queryKey: plantKeys.mapSites, queryFn: () => get<PlantMapSites>('/plant/map/sites'), refetchInterval: LIVE_REFRESH_MS, enabled });
}

let webgl2: boolean | null = null;
/** Whether this browser can draw the map: MapLibre needs WebGL 2 (asked once; the test context is let go at once). */
export function hasWebGl2(): boolean {
  if (webgl2 !== null) return webgl2;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    webgl2 = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webgl2 = false; // no canvas at all
  }
  return webgl2;
}

export type MapTheme = 'light' | 'dark';

/** The style of the current source, for this theme and language (absolute: MapLibre resolves nothing itself). */
export function styleUrl(cfg: PlantMapClient, theme: MapTheme, lang: string): string {
  const l = lang.startsWith('de') ? 'de' : 'en';
  return `${window.location.origin}${BASE_PATH}/api/plant/map/style.json?theme=${cfg.themed ? theme : 'light'}&lang=${l}&v=${encodeURIComponent(cfg.version)}`;
}

const MAP_PREFIX = () => `${BASE_PATH}/api/plant/map/`;

/**
 * MapLibre's request hook: every request goes to Steward's own map routes, made absolute and with the session headers
 * (the cookie alone is not enough). Anything else is sent nowhere – a style never makes the browser fetch elsewhere.
 */
export function transformRequest(url: string): { url: string; headers?: Record<string, string>; credentials?: 'same-origin' } {
  let u: URL;
  try {
    u = new URL(url, window.location.origin);
  } catch {
    return { url: 'about:blank' };
  }
  if (u.origin !== window.location.origin || !u.pathname.startsWith(MAP_PREFIX())) return { url: 'about:blank' };
  return { url: u.toString(), headers: authHeaders(), credentials: 'same-origin' };
}

export const STATE_ICON: Record<PlantMapState, Icon> = {
  fail: IconCircleX,
  warn: IconAlertTriangle,
  unknown: IconHelpCircle,
  ok: IconCircleCheck,
  none: IconCircleDashed,
};
export const STATE_VAR: Record<PlantMapState, string> = {
  fail: 'var(--pv-fail)',
  warn: 'var(--pv-warn)',
  unknown: 'var(--pv-unknown)',
  ok: 'var(--pv-ok)',
  none: 'var(--pv-planned)',
};

/** The accessible name of a pin: "Riverside Works, RVS, 2 checks failing". */
export function pinName(t: TFunction<'plantMap'>, s: PlantMapSite, name: string): string {
  const parts = [name];
  if (s.code) parts.push(s.code);
  if (s.live.fail) parts.push(t('pin.offline', { count: s.live.fail }));
  if (s.checks) parts.push(t('pin.checks', { count: s.checks }));
  if (s.live.warn) parts.push(t('pin.warn', { count: s.live.warn }));
  if (s.state === 'unknown') parts.push(t('state.unknown'));
  if (s.state === 'ok') parts.push(t('state.ok'));
  if (s.state === 'none') parts.push(t('state.none'));
  return parts.join(', ');
}

/** The state as icon and word, never colour alone. */
export function MapStateLabel({ state, size = 'sm' }: { state: PlantMapState; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plantMap');
  const I = STATE_ICON[state];
  return (
    <Group gap={4} wrap="nowrap" component="span" data-state={state}>
      <I size={size === 'xs' ? 14 : 16} aria-hidden style={{ color: STATE_VAR[state], flexShrink: 0 }} />
      <Text span size={size}>
        {t(`state.${state}`)}
      </Text>
    </Group>
  );
}

/** "© OpenStreetMap contributors" (linked to its copyright page, as the licence asks) and the source's attribution. */
export function MapAttribution({ cfg }: { cfg: PlantMapClient }) {
  const { t } = useTranslation('plantMap');
  return (
    <Text size="xs" className="pm-attribution" data-testid="map-attribution" component="div">
      {cfg.attribution.map((a, i) => (
        <span key={a}>
          {i > 0 && ' · '}
          {cfg.osm && a === '© OpenStreetMap contributors' ? (
            <Anchor href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" size="xs" inherit>
              {a}
              <span className="pm-sr">{t('attributionNewTab')}</span>
            </Anchor>
          ) : (
            a
          )}
        </span>
      ))}
    </Text>
  );
}

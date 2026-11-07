import { useEffect, useRef, useState } from 'react';
import { Text, useComputedColorScheme } from '@mantine/core';
import { IconMapPinFilled } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { PlantMapClient } from '@sm/shared';
import { MapAttribution, styleUrl, transformRequest } from './mapShared';
import './map.css';

setWorkerUrl(new URL(workerUrl, document.baseURI).href);

/**
 * The position picker of the site form (#234): a click on the map sets latitude and longitude (six decimals, about
 * 10 cm); the zoom of the map becomes the site's zoom when it has none. Typing the numbers stays possible – this is a
 * help for pointing devices, the inputs above it are the form.
 */
export function PositionPicker({
  config,
  lat,
  lon,
  zoom,
  onPick,
}: {
  config: PlantMapClient;
  lat: number | null;
  lon: number | null;
  zoom: number | null;
  onPick: (p: { lat: number; lon: number; zoom: number }) => void;
}) {
  const { t, i18n } = useTranslation('plantMap');
  const scheme = useComputedColorScheme('light');
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const at = useRef({ lat, lon });
  at.current = { lat, lon };

  useEffect(() => {
    if (!box.current) return;
    const has = lat !== null && lon !== null;
    const m = new MapLibreMap({
      container: box.current,
      style: styleUrl(config, scheme, i18n.language),
      transformRequest,
      attributionControl: false,
      maxZoom: config.maxZoom,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      center: has ? [lon, lat] : [10, 50],
      zoom: has ? Math.min(zoom ?? 15, config.maxZoom) : 3,
      locale: { 'Map.Title': t('picker.label'), 'NavigationControl.ZoomIn': t('controls.zoomIn'), 'NavigationControl.ZoomOut': t('controls.zoomOut') },
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), 'top-right');
    const place = () => {
      const c = at.current;
      setPos(c.lat !== null && c.lon !== null ? m.project([c.lon, c.lat]) : null);
    };
    m.on('move', place);
    m.on('load', place);
    m.on('click', (e) => {
      const round = (v: number) => Math.round(v * 1e6) / 1e6;
      pickRef.current({ lat: round(e.lngLat.lat), lon: round(((e.lngLat.lng + 540) % 360) - 180), zoom: Math.round(m.getZoom()) });
    });
    mapRef.current = m;
    return () => {
      m.remove();
      mapRef.current = null;
    };
    // made once; the position follows below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = mapRef.current;
    if (!m) return;
    setPos(lat !== null && lon !== null ? m.project([lon, lat]) : null);
  }, [lat, lon]);

  return (
    <div>
      <div className="pm-wrap" style={{ height: 220, cursor: 'crosshair' }} data-testid="position-picker">
        <div ref={box} className="pm-map" />
        {pos && (
          <IconMapPinFilled
            size={28}
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              transform: `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`,
              color: 'var(--pv-fail)',
              pointerEvents: 'none',
            }}
          />
        )}
        <MapAttribution cfg={config} />
      </div>
      <Text size="xs" c="dimmed" mt={4}>
        {t('picker.help')}
      </Text>
    </div>
  );
}

export default PositionPicker;

import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Group,
  NumberInput,
  PasswordInput,
  Radio,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconInfoCircle, IconMap, IconShieldLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  MAP_KEY_PLACES,
  PLANT_MAP_LIMITS,
  type MapKeyPlace,
  type MapOwnKind,
  type MapSource,
  type PlantMapCheck,
  type PlantMapSettingsView,
  type PlantSettings,
} from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../../api';
import { plantKeys } from '../../../queryKeys';

type Chosen = Exclude<MapSource, 'off'>;
const CHOICES: Chosen[] = ['osm', 'openfreemap', 'own', 'file'];

interface Draft {
  source: Chosen;
  own: { kind: MapOwnKind; url: string; attribution: string; keyPlace: MapKeyPlace; keyName: string; maxZoom: number };
  file: { name: string; attribution: string };
}

const draftOf = (v: PlantMapSettingsView): Draft => ({
  // off: OpenStreetMap is preselected – turning the map on is one click
  source: v.source === 'off' ? 'osm' : v.source,
  own: v.own
    ? { kind: v.own.kind, url: v.own.url, attribution: v.own.attribution, keyPlace: v.own.keyPlace, keyName: v.own.keyName, maxZoom: v.own.maxZoom }
    : { kind: 'raster', url: '', attribution: '', keyPlace: 'none', keyName: '', maxZoom: 19 },
  file: v.file ?? { name: '', attribution: '' },
});

const bytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

/**
 * Settings → Modules → Map of sites (#234, ADR 0015): where the map's tiles come from. Off until an administrator turns
 * it on (OpenStreetMap preselected); each choice says what Steward's server sends where. Saving a new source asks for
 * a step-up (control point plant.mapSource); the API key is stored in the vault and never shown again.
 */
export function PlantMapSettingsCard() {
  const { t } = useTranslation(['plantMap', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: plantKeys.mapSettings, queryFn: () => get<PlantMapSettingsView>('/settings/plant/map') });
  const [d, setD] = useState<Draft | null>(null);
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [check, setCheck] = useState<PlantMapCheck | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) setD(draftOf(q.data));
  }, [q.data]);
  if (!q.data || !d) return null;
  const v = q.data;
  const on = v.source !== 'off';
  const setOwn = (patch: Partial<Draft['own']>) => {
    setCheck(null);
    setD({ ...d, own: { ...d.own, ...patch } });
  };
  const fileChoices = v.files.map((f) => ({
    value: f.name,
    label: `${f.name} (${f.kind === 'unknown' ? t('settings.file.unknown') : t(`settings.file.${f.kind}`)}, ${bytes(f.bytes)})`,
    disabled: !!f.problem,
  }));
  const chosenFile = v.files.find((f) => f.name === d.file.name);
  const keyNeeded = d.own.keyPlace !== 'none';
  // a stored key belongs to its address: another origin needs it entered again (the server refuses it otherwise)
  const originOf = (u: string) => {
    try {
      return new URL(u.replaceAll('{', '').replaceAll('}', '')).origin;
    } catch {
      return u;
    }
  };
  const keyAgain = !!v.own?.hasKey && originOf(d.own.url.trim()) !== originOf(v.own.url);
  const keyStored = !!v.own?.hasKey && !keyAgain;
  const ownValid =
    d.own.url.trim().length > 0 && d.own.attribution.trim().length > 0 && (!keyNeeded || d.own.keyName.trim().length > 0) && (!keyNeeded || !!key || keyStored);
  const valid =
    d.source === 'own'
      ? ownValid
      : d.source === 'file'
        ? !!chosenFile && !chosenFile.problem && (!!d.file.attribution.trim() || !!chosenFile.attribution)
        : true;
  const body = (source: MapSource, extra: Record<string, unknown> = {}) => ({
    source,
    ...(d.source === 'own' || v.own
      ? {
          own: {
            ...d.own,
            url: d.own.url.trim(),
            attribution: d.own.attribution.trim(),
            keyName: keyNeeded ? d.own.keyName.trim() : '',
            ...(key ? { key } : removeKey || !keyNeeded ? (v.own?.hasKey ? { key: '' } : {}) : {}),
          },
        }
      : {}),
    ...(d.source === 'file' && d.file.name ? { file: { name: d.file.name, attribution: d.file.attribution.trim() } } : {}),
    ...extra,
  });
  const save = async (source: MapSource, extra?: Record<string, unknown>, what = 'save') => {
    setBusy(what);
    try {
      // the own part is only sent when it is valid (or chosen): an empty own source would be refused
      const b = body(source, extra);
      if (d.source !== 'own' && !ownValid) delete (b as { own?: unknown }).own;
      const next = await put<PlantMapSettingsView>('/settings/plant/map', b);
      qc.setQueryData(plantKeys.mapSettings, next);
      setKey('');
      setRemoveKey(false);
      // every reader's map follows: the config (its version) and the sites
      void qc.invalidateQueries({ queryKey: plantKeys.config });
      void qc.invalidateQueries({ queryKey: plantKeys.mapStatus });
      notifyOk(source === 'off' ? t('settings.savedOff') : t('settings.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const runCheck = async () => {
    setBusy('check');
    try {
      setCheck(await post<PlantMapCheck>('/settings/plant/map/check', body('own').own));
    } catch (e) {
      setCheck(null);
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const origins = d.source === 'own' && check ? check.origins : d.source === v.source ? v.origins : null;

  return (
    <Card withBorder id="plant-map" data-testid="plant-map-settings">
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Group gap="xs">
            <IconMap size={18} aria-hidden />
            <Title order={5}>{t('settings.title')}</Title>
          </Group>
          <Badge color={on ? 'green' : 'gray'} variant="light" data-testid="map-settings-state">
            {on ? t('settings.on', { source: t(`settings.sources.${v.source}.label`) }) : t('settings.off')}
          </Badge>
        </Group>
        <Text size="sm" c="dimmed">
          {t('settings.description')}
        </Text>
        {!on && (
          <Alert color="blue" variant="light" icon={<IconInfoCircle size={18} />} p="xs">
            <Text size="sm">{t('settings.offNote')}</Text>
          </Alert>
        )}
        <Radio.Group
          label={t('settings.from')}
          value={d.source}
          onChange={(x) => {
            setCheck(null);
            setD({ ...d, source: x as Chosen });
          }}
        >
          <Stack gap="xs" mt={6}>
            {CHOICES.map((c) => (
              <Radio
                key={c}
                value={c}
                label={t(`settings.sources.${c}.label`)}
                description={t(`settings.sources.${c}.privacy`)}
                data-testid={`map-source-${c}`}
              />
            ))}
          </Stack>
        </Radio.Group>

        {d.source === 'own' && (
          <Stack gap="xs" data-testid="map-own">
            <SegmentedControl
              size="xs"
              value={d.own.kind}
              onChange={(x) => setOwn({ kind: x as MapOwnKind })}
              data={[
                { value: 'raster', label: t('settings.own.raster') },
                { value: 'style', label: t('settings.own.style') },
              ]}
              aria-label={t('settings.own.kind')}
            />
            <TextInput
              label={d.own.kind === 'raster' ? t('settings.own.template') : t('settings.own.styleUrl')}
              description={d.own.kind === 'raster' ? t('settings.own.templateHelp') : t('settings.own.styleHelp')}
              placeholder={d.own.kind === 'raster' ? 'https://tiles.example.com/{z}/{x}/{y}.png' : 'https://tiles.example.com/styles/basic/style.json'}
              value={d.own.url}
              maxLength={PLANT_MAP_LIMITS.url}
              onChange={(e) => setOwn({ url: e.currentTarget.value })}
              required
            />
            <TextInput
              label={t('settings.own.attribution')}
              description={t('settings.own.attributionHelp')}
              value={d.own.attribution}
              maxLength={PLANT_MAP_LIMITS.attribution}
              onChange={(e) => setOwn({ attribution: e.currentTarget.value })}
              required
            />
            {d.own.kind === 'raster' && (
              <NumberInput
                label={t('settings.own.maxZoom')}
                min={0}
                max={22}
                allowDecimal={false}
                w={160}
                value={d.own.maxZoom}
                onChange={(x) => setOwn({ maxZoom: typeof x === 'number' ? x : 19 })}
              />
            )}
            <Group gap="xs" align="flex-end" wrap="wrap">
              <Select
                label={t('settings.own.keyPlace')}
                w={200}
                value={d.own.keyPlace}
                onChange={(x) => setOwn({ keyPlace: (x as MapKeyPlace | null) ?? 'none' })}
                allowDeselect={false}
                data={MAP_KEY_PLACES.map((p) => ({ value: p, label: t(`settings.own.keyPlaces.${p}`) }))}
              />
              {keyNeeded && (
                <TextInput
                  label={d.own.keyPlace === 'header' ? t('settings.own.headerName') : t('settings.own.paramName')}
                  w={200}
                  value={d.own.keyName}
                  maxLength={60}
                  onChange={(e) => setOwn({ keyName: e.currentTarget.value })}
                  required
                />
              )}
            </Group>
            {keyNeeded && (
              <Stack gap={4}>
                <PasswordInput
                  label={t('settings.own.key')}
                  description={keyAgain ? t('settings.own.keyAgain') : keyStored ? t('settings.own.keyStored') : t('settings.own.keyHelp')}
                  required={keyAgain}
                  leftSection={<IconShieldLock size={16} aria-hidden />}
                  value={key}
                  onChange={(e) => setKey(e.currentTarget.value)}
                  autoComplete="new-password"
                  disabled={removeKey}
                />
                {keyStored && (
                  <Checkbox size="xs" label={t('settings.own.removeKey')} checked={removeKey} onChange={(e) => setRemoveKey(e.currentTarget.checked)} />
                )}
              </Stack>
            )}
            {d.own.kind === 'style' && (
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="default"
                  onClick={() => void runCheck()}
                  loading={busy === 'check'}
                  disabled={!d.own.url.trim()}
                  data-testid="map-check"
                >
                  {t('settings.own.check')}
                </Button>
                {check && (
                  <Text size="xs" data-testid="map-check-result">
                    {t('settings.own.checked', { count: check.layers, kind: t(`settings.file.${check.kind}`) })}
                  </Text>
                )}
              </Group>
            )}
          </Stack>
        )}

        {d.source === 'file' && (
          <Stack gap="xs" data-testid="map-file">
            <Text size="xs" c="dimmed">
              {t('settings.file.where')} <Code>{v.mapsDir}</Code>
            </Text>
            {v.files.length === 0 ? (
              <Text size="sm">{t('settings.file.none')}</Text>
            ) : (
              <Select
                label={t('settings.file.choose')}
                data={fileChoices}
                value={d.file.name || null}
                onChange={(x) => setD({ ...d, file: { ...d.file, name: x ?? '' } })}
                placeholder={t('settings.file.placeholder')}
                data-testid="map-file-select"
              />
            )}
            {v.files
              .filter((f) => f.problem)
              .map((f) => (
                <Text key={f.name} size="xs" c="orange">
                  {f.name}: {f.problem}
                </Text>
              ))}
            {chosenFile && (
              <TextInput
                label={t('settings.own.attribution')}
                description={chosenFile.attribution ? t('settings.file.attributionFrom', { text: chosenFile.attribution }) : t('settings.file.attributionNone')}
                value={d.file.attribution}
                maxLength={PLANT_MAP_LIMITS.attribution}
                onChange={(e) => setD({ ...d, file: { ...d.file, attribution: e.currentTarget.value } })}
                required={!chosenFile.attribution}
              />
            )}
          </Stack>
        )}

        {origins && (
          <Stack gap={2} data-testid="map-origins">
            <Text size="sm" fw={500}>
              {origins.length ? t('settings.origins') : t('settings.noOrigins')}
            </Text>
            {origins.map((o) => (
              <Code key={o}>{o}</Code>
            ))}
          </Stack>
        )}

        <Group gap="xs" justify="flex-end" wrap="wrap">
          {on && d.source === 'own' && d.own.kind === 'style' && v.source === 'own' && (
            <Button size="xs" variant="default" onClick={() => void save('own', { reload: true }, 'reload')} loading={busy === 'reload'}>
              {t('settings.reload')}
            </Button>
          )}
          {on && (
            <Button
              size="xs"
              variant="default"
              color="red"
              onClick={() => void save('off', undefined, 'off')}
              loading={busy === 'off'}
              data-testid="map-turn-off"
            >
              {t('settings.turnOff')}
            </Button>
          )}
          <Button size="xs" onClick={() => void save(d.source)} loading={busy === 'save'} disabled={!valid} data-testid="map-save">
            {on ? t('settings.save') : t('settings.turnOn', { source: t(`settings.sources.${d.source}.label`) })}
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {t('settings.stepUp')}
        </Text>
      </Stack>
    </Card>
  );
}

/** The map's card, shown while the plant registry is on (its settings need the module). */
export function PlantMapSettingsGate() {
  const plant = useQuery({ queryKey: plantKeys.settings, queryFn: () => get<PlantSettings>('/settings/plant') });
  return plant.data?.enabled ? <PlantMapSettingsCard /> : null;
}

/** Settings → Outbound access: the origins the map's fetcher reaches (allowed for it only, not for processes). */
export function MapTileOrigins() {
  const { t } = useTranslation('plantMap');
  const plant = useQuery({ queryKey: plantKeys.settings, queryFn: () => get<PlantSettings>('/settings/plant') });
  const map = useQuery({
    queryKey: plantKeys.mapSettings,
    queryFn: () => get<PlantMapSettingsView>('/settings/plant/map'),
    enabled: plant.data?.enabled === true,
  });
  if (!map.data || map.data.source === 'off') return null;
  return (
    <Text size="xs" c="dimmed" data-testid="outbound-map-origins">
      {map.data.origins.length ? t('settings.outbound', { origins: map.data.origins.join(', ') }) : t('settings.outboundNone')}
    </Text>
  );
}

import { useCallback, type ReactNode } from 'react';
import { ActionIcon, Anchor, Badge, Button, Checkbox, Group, NumberInput, Select, Stack, Text, TextInput, Tooltip, VisuallyHidden } from '@mantine/core';
import { IconExternalLink, IconMapPin, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  LOCALES,
  PLANT_LIMITS,
  plantName,
  type AssetStatus,
  type ExternalRef,
  type FieldValues,
  type GeoPosition,
  type PlantFieldDef,
  type PlantRecordType,
  type Translations,
} from '@sm/shared';
import { TONE } from '../common';
import { usePlantConfig, useOwnLabel } from './labels';
import { fmtDay } from '../../format';

export { usePlantConfig };

/** Colours of the asset statuses (the same everywhere). */
export const STATUS_COLOR: Record<AssetStatus, string> = {
  planned: TONE.neutral,
  commissioning: TONE.active,
  operational: TONE.ok,
  maintenance: TONE.attention,
  out_of_service: TONE.bad,
  decommissioned: 'dark',
};

/** The display name of a record type (the installation's own name, or the module's word). */
export function usePlantLabel() {
  const { t, i18n } = useTranslation('plant');
  const own = useOwnLabel();
  return useCallback(
    (type: PlantRecordType, plural = false, inSentence = false) => {
      const text = own(type, plural, t(`types.${type}.${plural ? 'other' : 'one'}`));
      // inside a sentence ("New site"): lower case where the language writes nouns so (German does not); acronyms stay
      if (!inSentence || i18n.language.startsWith('de') || !/^\p{Lu}\p{Ll}/u.test(text)) return text;
      return text[0]!.toLocaleLowerCase(i18n.language) + text.slice(1);
    },
    [own, t, i18n.language],
  );
}

/** A name in the UI language (its translation, or the name). */
export function useNameOf() {
  const { i18n } = useTranslation();
  return useCallback((x: { name: string; names?: Translations | null } | null | undefined) => (x ? plantName(x, i18n.language) : ''), [i18n.language]);
}

export function AssetStatusBadge({ status, size = 'sm' }: { status: AssetStatus; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('plant');
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" size={size} style={{ minWidth: 'max-content' }}>
      {t(`status.${status}`)}
    </Badge>
  );
}

/** A record an import kept although its file no longer has it. */
export function NotInSourceBadge({ size = 'sm' }: { size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plant');
  return (
    <Tooltip label={t('notInSourceHint')} multiline w={260} withArrow>
      <Badge color="orange" variant="outline" size={size} style={{ minWidth: 'max-content' }} data-testid="not-in-source">
        {t('notInSource')}
      </Badge>
    </Tooltip>
  );
}

export function PreviewBadge() {
  const { t } = useTranslation('plant');
  return (
    <Tooltip label={t('previewHint')} multiline w={280} withArrow>
      <Badge color="grape" variant="light" size="sm">
        {t('preview')}
      </Badge>
    </Tooltip>
  );
}

export const osmUrl = (g: GeoPosition) => {
  const z = g.zoom ?? 16;
  return `https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lon}#map=${z}/${g.lat}/${g.lon}`;
};

/** A position as text with a link to OpenStreetMap (no map library: the link opens the map in a new tab). */
export function MapLink({ geo, name }: { geo: GeoPosition | null; name: string }) {
  const { t, i18n } = useTranslation('plant');
  if (!geo) return <>–</>;
  const fmt = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 4 });
  return (
    <Anchor href={osmUrl(geo)} target="_blank" rel="noopener noreferrer nofollow" size="sm" style={{ whiteSpace: 'nowrap' }}>
      <Group gap={4} wrap="nowrap" component="span">
        <IconMapPin size={14} aria-hidden />
        <span>
          {fmt.format(geo.lat)}, {fmt.format(geo.lon)}
        </span>
        <VisuallyHidden>{t('map.openNamed', { name })}</VisuallyHidden>
        <IconExternalLink size={12} aria-hidden />
      </Group>
    </Anchor>
  );
}

/** External references: system and id, a link where there is one. */
export function RefsView({ refs }: { refs: ExternalRef[] }) {
  if (!refs.length) return <>–</>;
  return (
    <Stack gap={2} data-testid="external-refs">
      {refs.map((r) => (
        <Text key={`${r.system}:${r.id}`} size="sm" style={{ overflowWrap: 'anywhere' }}>
          <Text span size="xs" c="dimmed" tt="uppercase" fw={600}>
            {r.system}
          </Text>{' '}
          {r.url ? (
            <Anchor href={r.url} target="_blank" rel="noopener noreferrer nofollow" size="sm">
              {r.label || r.id} <IconExternalLink size={12} aria-hidden />
            </Anchor>
          ) : (
            <span className="mono">{r.label || r.id}</span>
          )}
        </Text>
      ))}
    </Stack>
  );
}

const fieldLabel = (d: PlantFieldDef, lang: string) => d.labels[lang] ?? d.labels[lang.split('-')[0]!] ?? d.label;

/** Own field values as label: value pairs (labels from the settings; keys without a definition by their key). */
export function FieldValuesView({
  type,
  values,
  children,
}: {
  type: PlantRecordType;
  values: FieldValues;
  children?: (label: string, value: ReactNode) => ReactNode;
}) {
  const { t, i18n } = useTranslation('plant');
  const cfg = usePlantConfig();
  const defs = cfg.data?.fields[type] ?? [];
  const keys = [...defs.map((d) => d.key).filter((k) => values[k] !== undefined), ...Object.keys(values).filter((k) => !defs.some((d) => d.key === k))];
  if (!keys.length) return null;
  const show = (k: string) => {
    const d = defs.find((x) => x.key === k);
    const v = values[k];
    const text =
      typeof v === 'boolean' ? (v ? t('yes') : t('no')) : d?.kind === 'date' && typeof v === 'string' ? fmtDay(`${v}T00:00:00`) : v === null ? '–' : String(v);
    const value =
      d?.kind === 'url' && typeof v === 'string' ? (
        <Anchor href={v} target="_blank" rel="noopener noreferrer nofollow" size="sm" style={{ overflowWrap: 'anywhere' }}>
          {v}
        </Anchor>
      ) : (
        text
      );
    return children?.(d ? fieldLabel(d, i18n.language) : k, value);
  };
  return <>{keys.map((k) => show(k))}</>;
}

/** Inputs for the own fields of a record type (Settings → Modules → Plant registry). */
export function FieldInputs({
  type,
  values,
  onChange,
  errors,
}: {
  type: PlantRecordType;
  values: FieldValues;
  onChange: (v: FieldValues) => void;
  errors?: boolean;
}) {
  const { t, i18n } = useTranslation('plant');
  const cfg = usePlantConfig();
  const defs = cfg.data?.fields[type] ?? [];
  if (!defs.length) return null;
  const set = (k: string, v: string | number | boolean | null) => onChange({ ...values, [k]: v });
  return (
    <Stack gap="xs" data-testid="own-fields">
      <Text size="sm" fw={600}>
        {t('fields.title')}
      </Text>
      {defs.map((d) => {
        const label = fieldLabel(d, i18n.language);
        const v = values[d.key];
        const missing = errors && d.required && (v === undefined || v === null || v === '') ? t('fields.required') : undefined;
        const common = { label, description: d.help || undefined, required: d.required, error: missing };
        if (d.kind === 'number')
          return <NumberInput key={d.key} {...common} value={typeof v === 'number' ? v : ''} onChange={(x) => set(d.key, typeof x === 'number' ? x : null)} />;
        if (d.kind === 'boolean')
          return (
            <Checkbox key={d.key} label={label} description={d.help || undefined} checked={v === true} onChange={(e) => set(d.key, e.currentTarget.checked)} />
          );
        if (d.kind === 'select')
          return (
            <Select key={d.key} {...common} data={d.options} value={typeof v === 'string' ? v : null} onChange={(x) => set(d.key, x)} clearable={!d.required} />
          );
        return (
          <TextInput
            key={d.key}
            {...common}
            type={d.kind === 'date' ? 'date' : d.kind === 'url' ? 'url' : 'text'}
            maxLength={PLANT_LIMITS.fieldText}
            value={v === null || v === undefined ? '' : String(v)}
            onChange={(e) => set(d.key, e.currentTarget.value)}
          />
        );
      })}
    </Stack>
  );
}

/** The names in the other languages of the installation (de …), next to the name. */
export function TranslationsInput({ value, onChange }: { value: Translations; onChange: (v: Translations) => void }) {
  const { t } = useTranslation('plant');
  const langs = LOCALES.filter((l) => l.code !== 'en');
  return (
    <>
      {langs.map((l) => (
        <TextInput
          key={l.code}
          label={t('form.nameIn', { language: l.nativeName })}
          maxLength={PLANT_LIMITS.name}
          value={value[l.code] ?? ''}
          onChange={(e) => {
            const next = { ...value };
            if (e.currentTarget.value) next[l.code] = e.currentTarget.value;
            else delete next[l.code];
            onChange(next);
          }}
          lang={l.code}
        />
      ))}
    </>
  );
}

/** A stable id from a name: lower case, digits, "-" (what an id may hold). */
export const slugId = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, PLANT_LIMITS.id);

/** External references (system, id, link) as rows to add and remove. */
export function RefsEditor({ value, onChange }: { value: ExternalRef[]; onChange: (v: ExternalRef[]) => void }) {
  const { t } = useTranslation('plant');
  const set = (i: number, patch: Partial<ExternalRef>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Stack gap="xs" data-testid="refs-editor">
      <div>
        <Text size="sm" fw={500}>
          {t('refs.title')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('refs.help')}
        </Text>
      </div>
      {value.map((r, i) => (
        <Group key={i} gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            label={t('refs.system')}
            placeholder="erp"
            value={r.system}
            onChange={(e) => set(i, { system: e.currentTarget.value })}
            maxLength={60}
            style={{ flex: '1 1 100px' }}
          />
          <TextInput
            size="xs"
            label={t('refs.id')}
            value={r.id}
            onChange={(e) => set(i, { id: e.currentTarget.value })}
            maxLength={200}
            style={{ flex: '1 1 120px' }}
            classNames={{ input: 'mono' }}
          />
          <TextInput
            size="xs"
            label={t('refs.url')}
            placeholder="https://"
            value={r.url}
            onChange={(e) => set(i, { url: e.currentTarget.value })}
            maxLength={2000}
            style={{ flex: '2 1 180px' }}
          />
          <ActionIcon
            variant="subtle"
            color="red"
            mb={2}
            aria-label={t('refs.remove', { system: r.system || '–', id: r.id || '–' })}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            <IconTrash size={16} />
          </ActionIcon>
        </Group>
      ))}
      <Button
        size="xs"
        variant="default"
        w="fit-content"
        leftSection={<IconPlus size={14} />}
        onClick={() => onChange([...value, { system: '', id: '', url: '', label: '' }])}
        disabled={value.length >= PLANT_LIMITS.refs}
      >
        {t('refs.add')}
      </Button>
    </Stack>
  );
}

export const refsValid = (refs: ExternalRef[]) =>
  refs.every((r) => r.system.trim() && r.id.trim() && (!r.url.trim() || /^https?:\/\/\S+$/i.test(r.url.trim())));
export const cleanRefs = (refs: ExternalRef[]) => refs.map((r) => ({ system: r.system.trim(), id: r.id.trim(), url: r.url.trim(), label: r.label.trim() }));

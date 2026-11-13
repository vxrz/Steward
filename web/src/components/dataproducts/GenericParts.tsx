import { useState } from 'react';
import { ActionIcon, Alert, Autocomplete, Badge, Button, Group, Paper, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_TECHNOLOGY_LIMITS as TL,
  convertTargets,
  elementKindFits,
  technologyServes,
  type DataElement,
  type DataElementKind,
  type DataElementProperty,
  type DataTechnology,
  type Platform,
} from '@sm/shared';
import { get, post } from '../../api';
import { FormModal } from '../FormModal';
import { useFieldErrors } from '../common';
import { technologyEntry, useTechnologies } from '../../pages/dataproducts/generic';
import { FormButtons, useBusy } from './form';
import { TECHNOLOGY_ICON } from './technologyIcons';

export { TECHNOLOGY_ICON };

/**
 * Generic parts and bridges in the forms (0.25.0, ADR 0037 part 0): the technology – from the technology list (parts
 * or bridges by their role) or a value of one's own, shown as _not in the list_ –, the OpenLineage namespace with the
 * technology's pattern as the hint, key: value properties, and _Convert to …_.
 */

const enc = encodeURIComponent;

/** The technology a value names, as a badge: its name and icon – or the value with _not in the list_. */
export function TechnologyBadge({ value, size = 'sm' }: { value: string | null | undefined; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProducts');
  const list = useTechnologies();
  if (!value) return null;
  const entry = technologyEntry(list.data, value);
  const I = TECHNOLOGY_ICON[entry?.icon ?? 'other'];
  return (
    <Group gap={4} wrap="nowrap" data-testid="technology-badge">
      <Badge size={size} variant="light" color={entry ? 'indigo' : 'gray'} tt="none" leftSection={<I size={12} aria-hidden />}>
        {entry?.name ?? value}
      </Badge>
      {!entry && (
        <Text size="xs" c="dimmed">
          {t('generic.notInList')}
        </Text>
      )}
    </Group>
  );
}

/**
 * A technology: the list's entries of the role (parts, bridges, both) by name, or a value of one's own; below it the
 * hint that a value is not in the list.
 */
export function TechnologyInput({
  value,
  onChange,
  role,
  label,
  description,
  error,
  required,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  role: 'part' | 'bridge';
  label: string;
  description?: string;
  error?: string | null;
  required?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation('dataProducts');
  const list = useTechnologies();
  const entries = (list.data ?? []).filter((x) => technologyServes(x, role));
  const entry = technologyEntry(list.data, value);
  // the stored value is a key: the field shows its name
  const shown = entry && entry.key === value.trim().toLowerCase() ? entry.name : value;
  return (
    <Stack gap={2}>
      <Autocomplete
        label={label}
        description={description}
        data={entries.map((x) => x.name)}
        value={shown}
        onChange={onChange}
        maxLength={TL.value}
        required={required}
        error={error || undefined}
        data-testid={testId}
      />
      {!!value.trim() && !entry && (
        <Text size="xs" c="dimmed" data-testid={testId ? `${testId}-not-listed` : undefined}>
          {t('generic.notInListHint')}
        </Text>
      )}
    </Stack>
  );
}

/** The fields of a generic part in the element form: technology, namespace and properties. */
export function GenericPartFields({
  technology,
  onTechnology,
  namespace,
  onNamespace,
  properties,
  onProperties,
  errors,
}: {
  technology: string;
  onTechnology: (v: string) => void;
  namespace: string;
  onNamespace: (v: string) => void;
  properties: DataElementProperty[];
  onProperties: (v: DataElementProperty[]) => void;
  errors: { technology?: string | null; namespace?: string | null };
}) {
  const { t } = useTranslation('dataProducts');
  const list = useTechnologies();
  const pattern = technologyEntry(list.data, technology)?.olNamespacePattern ?? null;
  return (
    <Paper withBorder p="sm" data-testid="element-generic">
      <Stack gap="xs">
        <Text size="sm" c="dimmed">
          {t('generic.hint')}
        </Text>
        <TechnologyInput
          label={t('generic.technology')}
          description={t('generic.technologyHint')}
          value={technology}
          onChange={onTechnology}
          role="part"
          required
          error={errors.technology}
          testId="element-technology"
        />
        <TextInput
          label={t('generic.namespace')}
          description={pattern ? t('generic.namespaceHintPattern', { pattern }) : t('generic.namespaceHint')}
          required
          maxLength={TL.namespace}
          value={namespace}
          onChange={(e) => onNamespace(e.currentTarget.value)}
          error={errors.namespace || undefined}
          placeholder={pattern ?? undefined}
          className="mono"
          data-testid="element-namespace"
        />
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            {t('generic.properties')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('generic.propertiesHint')}
          </Text>
          {properties.map((p, i) => (
            <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
              <TextInput
                size="xs"
                aria-label={t('generic.propertyKeyNumbered', { n: i + 1 })}
                placeholder={t('generic.propertyKey')}
                value={p.key}
                maxLength={TL.propertyKey}
                onChange={(e) => {
                  const key = e.currentTarget.value;
                  onProperties(properties.map((x, j) => (j === i ? { ...x, key } : x)));
                }}
                style={{ flex: 1, minWidth: 0 }}
              />
              <TextInput
                size="xs"
                aria-label={t('generic.propertyValueNumbered', { n: i + 1 })}
                placeholder={t('generic.propertyValue')}
                value={p.value}
                maxLength={TL.propertyValue}
                onChange={(e) => {
                  const value = e.currentTarget.value;
                  onProperties(properties.map((x, j) => (j === i ? { ...x, value } : x)));
                }}
                style={{ flex: 2, minWidth: 0 }}
              />
              <Tooltip label={t('generic.removeProperty')}>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  size="md"
                  aria-label={t('generic.removePropertyNamed', { key: p.key || i + 1 })}
                  onClick={() => onProperties(properties.filter((_, j) => j !== i))}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}
          {properties.length < TL.properties && (
            <Group>
              <Button
                size="xs"
                variant="subtle"
                leftSection={<IconPlus size={14} />}
                onClick={() => onProperties([...properties, { key: '', value: '' }])}
                data-testid="element-property-add"
              >
                {t('generic.addProperty')}
              </Button>
            </Group>
          )}
        </Stack>
      </Stack>
    </Paper>
  );
}

/** The properties as saved: keys trimmed, rows without a key left out. */
export const cleanProperties = (xs: DataElementProperty[]): DataElementProperty[] =>
  xs.map((p) => ({ key: p.key.trim(), value: p.value.trim() })).filter((p) => p.key);

/** The facts of a generic part on its page: technology, namespace and properties. */
export function GenericPartFacts({ e }: { e: DataElement }) {
  const { t } = useTranslation('dataProducts');
  return (
    <Stack gap="xs" data-testid="element-generic-facts">
      <Group gap="xs">
        <Text size="sm" fw={500}>
          {t('generic.technology')}
        </Text>
        <TechnologyBadge value={e.technology} />
      </Group>
      <div>
        <Text size="sm" fw={500}>
          {t('generic.namespace')}
        </Text>
        <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
          {e.olNamespace ?? '–'}
        </Text>
      </div>
      {e.properties.length > 0 && (
        <div>
          <Text size="sm" fw={500}>
            {t('generic.properties')}
          </Text>
          <Stack gap={2} component="dl" m={0}>
            {e.properties.map((p) => (
              <Group key={p.key} gap={6} wrap="nowrap" align="baseline">
                <Text component="dt" size="sm" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {p.key}:
                </Text>
                <Text component="dd" size="sm" m={0} style={{ overflowWrap: 'anywhere' }}>
                  {p.value || '–'}
                </Text>
              </Group>
            ))}
          </Stack>
        </div>
      )}
    </Stack>
  );
}

/**
 * _Convert to …_: a generic part becomes a specific kind of its role – the same element (id, products, ports, steps,
 * lineage, checks, history); discovery looks after it from then on. Refused when another element is that one already.
 */
export function ConvertElementModal({ e, onClose, onConverted }: { e: DataElement; onClose: () => void; onConverted: (x: DataElement) => void }) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews', 'common']);
  const targets = convertTargets(e.kind);
  const [kind, setKind] = useState<DataElementKind | null>(targets[0] ?? null);
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [qualifiedName, setQualifiedName] = useState(e.qualifiedName);
  const [busy, run] = useBusy();
  const platforms = useQuery({ queryKey: ['dataProducts', 'platforms'], queryFn: () => get<Platform[]>('/platforms'), staleTime: 60_000 });
  const fitting = kind ? (platforms.data ?? []).filter((p) => elementKindFits(kind, p.kind)) : [];
  const needsPlatform = !!kind && !elementKindFits(kind, null);
  const v = useFieldErrors({
    kind: !kind && t('common:validation.required'),
    platform: needsPlatform && !platformId && t('elements.platformRequired'),
    name: !qualifiedName.trim() && t('common:validation.required'),
  });
  const save = () =>
    run(async () => {
      const x = await post<DataElement>(`/data-elements/${enc(e.id)}/convert`, {
        kind,
        platformId,
        ...(qualifiedName.trim() !== e.qualifiedName ? { qualifiedName: qualifiedName.trim() } : {}),
      });
      onConverted(x);
    }, t('generic.notConverted'));
  return (
    <FormModal onClose={onClose} title={t('generic.convertTitle', { name: e.displayName || e.qualifiedName })}>
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Alert color="blue" variant="light">
            {t('generic.convertHint')}
          </Alert>
          <Select
            label={t('generic.convertKind')}
            data={targets.map((k) => ({ value: k, label: t(`dataProductViews:elementKinds.${k}`) }))}
            value={kind}
            onChange={(k) => {
              setKind(k as DataElementKind | null);
              setPlatformId(null);
            }}
            allowDeselect={false}
            error={v.error('kind')}
            data-autofocus
            data-testid="convert-kind"
          />
          <Select
            label={t('elements.platform')}
            description={needsPlatform ? undefined : t('elements.platformOptional')}
            data={fitting.map((p) => ({ value: p.id, label: p.name }))}
            value={platformId}
            onChange={setPlatformId}
            clearable={!needsPlatform}
            searchable
            required={needsPlatform}
            error={v.error('platform')}
            nothingFoundMessage={t('elements.noFittingPlatform')}
            data-testid="convert-platform"
          />
          <TextInput
            label={t('generic.convertName')}
            description={t('generic.convertNameHint')}
            required
            maxLength={1_000}
            value={qualifiedName}
            onChange={(x) => setQualifiedName(x.currentTarget.value)}
            error={v.error('name')}
            className="mono"
            data-testid="convert-name"
          />
          <FormButtons busy={busy} submit={t('generic.convertSubmit')} testId="convert-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** Technologies of the list that serve as parts or bridges – for filters (the list's order). */
export const technologyOptions = (list: readonly DataTechnology[] | undefined, role?: 'part' | 'bridge') =>
  (list ?? []).filter((x) => !role || technologyServes(x, role)).map((x) => ({ value: x.key, label: x.name }));

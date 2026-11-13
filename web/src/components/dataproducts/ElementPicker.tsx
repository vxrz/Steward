import { useMemo, useState } from 'react';
import { Group, MultiSelect, Stack, Text } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import type { DataElementKind, DataElementSummary } from '@sm/shared';
import { qs, useElementSearch } from '../../pages/dataproducts/api';

/** An element chosen in a picker: its id and what the picker shows of it. */
export interface PickedElement {
  id: string;
  label: string;
  detail?: string;
  /** The reader may open the element's page (false: an element shown on a product only, decision 15) */
  visible?: boolean;
}

export const pickedOf = (e: Pick<DataElementSummary, 'id' | 'qualifiedName' | 'environment'> & { kind: DataElementKind }, kindLabel: (k: DataElementKind) => string): PickedElement => ({
  id: e.id,
  label: e.qualifiedName,
  detail: [kindLabel(e.kind), e.environment].filter(Boolean).join(' · '),
});

/**
 * Elements of the catalogue picked by a search the server runs (debounced, the first 20 matches; the catalogue may
 * hold 250,000 elements): name a part of the qualified or display name. Only elements the reader may see are offered.
 * Chosen ones stay shown with their names while the search moves on.
 */
export function ElementPicker({
  label,
  description,
  value,
  onChange,
  environment,
  kind,
  max = 50,
  error,
  exclude,
  testId,
}: {
  label: string;
  description?: string;
  value: PickedElement[];
  onChange: (v: PickedElement[]) => void;
  /** Only elements of this environment (a binding, a product's environment) */
  environment?: string;
  kind?: DataElementKind;
  max?: number;
  error?: string;
  /** Ids not to offer (members already) */
  exclude?: ReadonlySet<string>;
  testId?: string;
}) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews']);
  const [search, setSearch] = useState('');
  const [term] = useDebouncedValue(search.trim(), 250);
  const q = useElementSearch(qs({ q: term, environment, kind }), true);
  const found = useMemo(() => {
    const kindLabel = (k: DataElementKind) => t(`dataProductViews:elementKinds.${k}`);
    return (q.data?.items ?? []).filter((e) => !exclude?.has(e.id)).map((e) => pickedOf(e, kindLabel));
  }, [q.data, exclude, t]);
  const known = useMemo(() => new Map([...found, ...value].map((e) => [e.id, e])), [found, value]);
  const data = [...known.values()].map((e) => ({ value: e.id, label: e.label }));
  const more = (q.data?.total ?? 0) > found.length;
  return (
    <Stack gap={4}>
      <MultiSelect
        label={label}
        description={description}
        data={data}
        value={value.map((e) => e.id)}
        onChange={(ids) => onChange(ids.map((id) => known.get(id)).filter((e): e is PickedElement => !!e))}
        searchable
        searchValue={search}
        onSearchChange={setSearch}
        // the server searched: show its answer as it is
        filter={({ options }) => options}
        maxValues={max}
        clearable
        hidePickedOptions
        error={error}
        nothingFoundMessage={q.isFetching ? t('picker.searching') : t('picker.nothing')}
        placeholder={value.length ? undefined : t('picker.placeholder')}
        renderOption={({ option }) => {
          const e = known.get(option.value);
          return (
            <Stack gap={0}>
              <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                {option.label}
              </Text>
              {e?.detail && (
                <Text size="xs" c="dimmed">
                  {e.detail}
                </Text>
              )}
            </Stack>
          );
        }}
        data-testid={testId}
        comboboxProps={{ withinPortal: true }}
      />
      {more && (
        <Group gap={4}>
          <Text size="xs" c="dimmed" role="status">
            {t('picker.more', { shown: found.length, total: q.data?.countCapped ? `${q.data.total}+` : q.data?.total })}
          </Text>
        </Group>
      )}
    </Stack>
  );
}

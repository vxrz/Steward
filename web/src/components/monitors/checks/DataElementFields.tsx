import { useState } from 'react';
import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { DATA_ELEMENT_KIND_DEFS, elementCheckModes, type CheckDef, type DataElement, type DataElementSummary, type DataPage } from '@sm/shared';
import { get } from '../../../api';
import { Hint } from '../../common';
import { num, type CheckFieldsProps } from './common';

const label = (e: Pick<DataElementSummary, 'displayName' | 'qualifiedName' | 'environment'>) =>
  `${e.displayName && e.displayName !== e.qualifiedName ? `${e.displayName} – ` : ''}${e.qualifiedName}${e.environment ? ` (${e.environment})` : ''}`;

/**
 * An element of a data product (ADR 0036 part 10): its freshness by metadata, or its columns against the contract of
 * its output port. The element is searched in the catalogue (a page of 20 by text); its kind decides the modes and
 * fields offered.
 */
export function DataElementFields({ c, set, disabled, err }: CheckFieldsProps<'data-element'>) {
  const { t } = useTranslation('monitors');
  const [search, setSearch] = useState('');
  const [q] = useDebouncedValue(search.trim(), 300);
  const current = useQuery({
    queryKey: ['data-elements', 'detail', c.element],
    queryFn: () => get<DataElement>(`/data-elements/${encodeURIComponent(c.element)}`),
    enabled: !!c.element,
    retry: false,
  });
  const found = useQuery({
    queryKey: ['data-elements', 'pick', q],
    queryFn: () => get<DataPage<DataElementSummary>>(`/data-elements?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  });
  const el = current.data;
  const options = [...(el ? [el] : []), ...(found.data?.items ?? []).filter((x) => x.id !== el?.id)].map((x) => ({ value: x.id, label: label(x) }));
  const modes = el ? elementCheckModes(el.kind) : (['freshness', 'schema'] as const);
  const mode = c.mode ?? 'freshness';
  const container = !!el && DATA_ELEMENT_KIND_DEFS[el.kind].container;
  const topic = el?.kind === 'kafka.topic';
  return (
    <>
      <Select
        label={t('form.dataElement')}
        description={t('form.dataElementHint')}
        required
        error={err('element') ?? (c.element && current.isError ? t('form.dataElementMissing') : undefined)}
        data-field="element"
        searchable
        clearable={false}
        disabled={disabled}
        data={options}
        value={c.element || null}
        searchValue={search}
        onSearchChange={setSearch}
        filter={({ options: o }) => o}
        placeholder={t('form.chooseDataElement')}
        nothingFoundMessage={found.isFetching ? t('form.searching') : t('form.noDataElement')}
        onChange={(v) => {
          setSearch('');
          set({ element: v ?? '' } as Partial<CheckDef>);
        }}
      />
      <Group grow align="flex-start">
        <Select
          data-field="mode"
          label={t('form.dataElementMode')}
          description={t(`form.dataElementModeHints.${mode}`)}
          allowDeselect={false}
          disabled={disabled}
          data={(['freshness', 'schema'] as const).map((m) => ({ value: m, label: t(`form.dataElementModes.${m}`), disabled: !modes.includes(m) }))}
          value={mode}
          onChange={(v) => set({ mode: v === 'schema' ? 'schema' : 'freshness' } as Partial<CheckDef>)}
        />
        {mode === 'freshness' && (
          <NumberInput
            data-field="maxAgeMinutes"
            label={t('form.dataElementMaxAge')}
            description={t('form.dataElementMaxAgeHint')}
            min={1}
            max={525600}
            disabled={disabled}
            value={c.maxAgeMinutes ?? 1440}
            onChange={(v) => set({ maxAgeMinutes: num(v) ?? 1440 } as Partial<CheckDef>)}
          />
        )}
      </Group>
      {mode === 'freshness' && container && (
        <Select
          data-field="each"
          label={t('form.dataElementEach')}
          allowDeselect={false}
          disabled={disabled}
          data={(['any', 'every'] as const).map((v) => ({ value: v, label: t(`form.dataElementEachOptions.${v}`) }))}
          value={c.each ?? 'any'}
          onChange={(v) => set({ each: v === 'every' ? 'every' : 'any' } as Partial<CheckDef>)}
        />
      )}
      {mode === 'freshness' && topic && (
        <Group grow align="flex-start">
          <TextInput
            data-field="group"
            label={t('form.dataElementGroup')}
            disabled={disabled}
            value={c.group ?? ''}
            onChange={(e) => set({ group: e.currentTarget.value || undefined } as Partial<CheckDef>)}
          />
          <NumberInput
            data-field="maxLag"
            label={t('form.dataElementMaxLag')}
            min={0}
            disabled={disabled || !c.group}
            value={c.maxLag ?? ''}
            onChange={(v) => set({ maxLag: num(v) } as Partial<CheckDef>)}
          />
        </Group>
      )}
      {mode === 'schema' && topic && (
        <NumberInput
          data-field="schemaVersion"
          label={t('form.dataElementSchemaVersion')}
          description={t('form.dataElementSchemaVersionHint')}
          min={1}
          disabled={disabled}
          value={c.schemaVersion ?? ''}
          onChange={(v) => set({ schemaVersion: num(v) } as Partial<CheckDef>)}
        />
      )}
      <Group grow align="flex-start">
        <Select
          data-field="failAs"
          label={t(mode === 'schema' ? 'form.dataElementSchemaFailAs' : 'form.dataElementFailAs')}
          allowDeselect={false}
          disabled={disabled}
          data={(['down', 'degraded'] as const).map((v) => ({ value: v, label: t(`status.${v}`) }))}
          value={c.failAs ?? 'down'}
          onChange={(v) => set({ failAs: (v as 'down' | 'degraded') ?? 'down' } as Partial<CheckDef>)}
        />
        <Select
          data-field="warningAs"
          label={t('form.dataElementWarningAs')}
          description={t(`form.dataElementWarningHints.${mode}`)}
          allowDeselect={false}
          disabled={disabled}
          data={(['degraded', 'up'] as const).map((v) => ({ value: v, label: t(`status.${v}`) }))}
          value={c.warningAs ?? 'degraded'}
          onChange={(v) => set({ warningAs: (v as 'degraded' | 'up') ?? 'degraded' } as Partial<CheckDef>)}
        />
      </Group>
      <Hint>{t(mode === 'schema' ? 'form.dataElementSchemaNote' : 'form.dataElementFreshnessNote')}</Hint>
    </>
  );
}

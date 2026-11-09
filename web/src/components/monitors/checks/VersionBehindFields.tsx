import { Group, MultiSelect, NumberInput, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { type CheckDef, type ApplicationSummary, type StackProduct } from '@sm/shared';
import { get } from '../../../api';
import { num, type CheckFieldsProps } from './common';

/** The application of a version check (#241): its name, so the definition works in every installation. */
export function VersionBehindFields({ c, set, disabled, err }: CheckFieldsProps<'version-behind'>) {
  const { t } = useTranslation('monitors');
  const apps = useQuery({ queryKey: ['applications', false], queryFn: () => get<ApplicationSummary[]>('/applications') });
  const products = useQuery({ queryKey: ['stack-products'], queryFn: () => get<{ source: string; products: StackProduct[] }>('/catalogue/stack-products') });
  const list = apps.data ?? [];
  const known = list.find((a) => a.name.toLowerCase() === c.application.toLowerCase() || a.id === c.application);
  return (
    <>
      <Select
        label={t('form.versionApplication')}
        description={t('form.versionApplicationHint')}
        required
        error={err('application')}
        data-field="application"
        searchable
        disabled={disabled}
        data={list.map((a) => ({ value: a.name, label: a.name }))}
        value={known?.name ?? null}
        placeholder={c.application && !known ? c.application : t('form.versionChooseApplication')}
        onChange={(v) => set({ application: v ?? '' } as Partial<CheckDef>)}
        nothingFoundMessage={t('form.versionNoApplication')}
      />
      <Group grow align="flex-start">
        <TextInput
          label={t('form.versionEnvironment')}
          description={t('form.versionEnvironmentHint')}
          disabled={disabled}
          value={c.environment ?? ''}
          onChange={(e) => set({ environment: e.currentTarget.value || undefined } as Partial<CheckDef>)}
        />
        <MultiSelect
          label={t('form.versionProducts')}
          description={t('form.versionProductsHint')}
          searchable
          clearable
          limit={50}
          maxValues={50}
          disabled={disabled}
          data={(products.data?.products ?? []).map((p) => ({ value: p.id, label: p.label }))}
          value={c.products ?? []}
          onChange={(v) => set({ products: v.length ? v : undefined } as Partial<CheckDef>)}
        />
      </Group>
      <Group grow align="flex-start">
        <NumberInput
          data-field="maxMinors"
          label={t('form.versionMaxMinors')}
          description={t('form.versionMaxMinorsHint')}
          min={0}
          max={1000}
          disabled={disabled}
          value={c.maxMinors ?? 2}
          onChange={(v) => set({ maxMinors: num(v) ?? 2 } as Partial<CheckDef>)}
        />
        <NumberInput
          data-field="maxDays"
          label={t('form.versionMaxDays')}
          description={t('form.versionMaxDaysHint')}
          min={1}
          max={3650}
          disabled={disabled}
          value={c.maxDays ?? ''}
          onChange={(v) => set({ maxDays: num(v) } as Partial<CheckDef>)}
        />
      </Group>
      <Group grow align="flex-start">
        <Select
          label={t('form.versionMajorAs')}
          allowDeselect={false}
          disabled={disabled}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.majorAs ?? 'down'}
          onChange={(v) => set({ majorAs: v === 'degraded' ? 'degraded' : 'down' } as Partial<CheckDef>)}
        />
        <Select
          label={t('form.versionEolAs')}
          allowDeselect={false}
          disabled={disabled}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
            { value: 'ignore', label: t('form.versionEolIgnore') },
          ]}
          value={c.eolAs ?? 'down'}
          onChange={(v) => set({ eolAs: (v as 'down' | 'degraded' | 'ignore') ?? 'down' } as Partial<CheckDef>)}
        />
      </Group>
    </>
  );
}

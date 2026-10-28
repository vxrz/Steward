import { MultiSelect, Select, type MultiSelectProps, type SelectProps } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { ApplicationSummary } from '@sm/shared';
import { get } from '../../api';

/**
 * Picks an application of the service catalogue (not archived) – for inputs of type application. `by` decides what
 * the value is: the id (a run), or the name (a default in a process definition, which then works in every
 * installation, e.g. through Git sync).
 */
export function ApplicationSelect({
  value,
  onChange,
  by,
  ...props
}: Omit<SelectProps, 'value' | 'onChange' | 'data'> & { value: string | null; onChange: (v: string | null) => void; by: 'id' | 'name' }) {
  const { t } = useTranslation('runs');
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => get<ApplicationSummary[]>('/applications') });
  const data = (apps.data ?? []).map((a) => ({ value: by === 'id' ? a.id : a.name, label: a.name }));
  // a stored name or id that is not in the list (archived, renamed, another installation) stays visible
  if (value && !data.some((d) => d.value === value)) data.unshift({ value, label: value });
  return <Select {...props} data={data} value={value} onChange={onChange} searchable clearable nothingFoundMessage={t('inputs.noApplications')} />;
}

/** Picks several applications – for inputs of type applications (#104); none picked means all of them. */
export function ApplicationsMultiSelect({
  value,
  onChange,
  by,
  ...props
}: Omit<MultiSelectProps, 'value' | 'onChange' | 'data'> & { value: string[]; onChange: (v: string[]) => void; by: 'id' | 'name' }) {
  const { t } = useTranslation('runs');
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => get<ApplicationSummary[]>('/applications') });
  const data = (apps.data ?? []).map((a) => ({ value: by === 'id' ? a.id : a.name, label: a.name }));
  for (const v of value) if (!data.some((d) => d.value === v)) data.unshift({ value: v, label: v });
  return (
    <MultiSelect
      {...props}
      data={data}
      value={value}
      onChange={onChange}
      searchable
      clearable
      placeholder={value.length ? undefined : t('inputs.allApplications')}
      nothingFoundMessage={t('inputs.noApplications')}
    />
  );
}

import { Group, NumberInput, Select, TextInput, Textarea } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** A PromQL query against WARN and CRIT levels (#110). */
export function PrometheusFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'prometheus'>) {
  const { t } = useTranslation('monitors');
  return (
    <>
      <PlatformSelect
        value={c.platform}
        onChange={(v) => set({ platform: v })}
        platforms={platforms}
        kinds={checkPlatformKinds(c)}
        disabled={disabled}
        error={err('platform')}
      />
      <Textarea
        error={err('query')}
        data-field="query"
        label={t('form.promQuery')}
        description={t('form.promQueryHint')}
        required
        autosize
        minRows={2}
        disabled={disabled}
        value={c.query}
        onChange={(e) => set({ query: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
      />
      <Group grow align="flex-start">
        <Select
          data-field="direction"
          label={t('form.promDirection')}
          allowDeselect={false}
          disabled={disabled}
          data={(['above', 'below'] as const).map((v) => ({ value: v, label: t(`form.promDirections.${v}`) }))}
          value={c.direction ?? 'above'}
          onChange={(v) => set({ direction: v === 'below' ? 'below' : 'above' })}
        />
        <NumberInput
          error={err('warn')}
          data-field="warn"
          label={t('form.promWarn')}
          disabled={disabled}
          value={c.warn ?? ''}
          onChange={(v) => set({ warn: typeof v === 'number' ? v : undefined })}
          allowDecimal
        />
        <NumberInput
          error={err('crit')}
          data-field="crit"
          label={t('form.promCrit')}
          required
          disabled={disabled}
          value={c.crit}
          onChange={(v) => set({ crit: typeof v === 'number' ? v : 0 })}
          allowDecimal
        />
      </Group>
      <Group grow align="flex-start">
        <Select
          data-field="noData"
          label={t('form.promNoData')}
          description={t('form.promNoDataHint')}
          allowDeselect={false}
          disabled={disabled}
          data={(['unknown', 'up', 'down'] as const).map((v) => ({ value: v, label: t(`form.promNoDataStates.${v}`) }))}
          value={c.noData ?? 'unknown'}
          onChange={(v) => set({ noData: (v as 'unknown' | 'up' | 'down') ?? 'unknown' })}
        />
        <TextInput
          data-field="unit"
          label={t('form.promUnit')}
          disabled={disabled}
          value={c.unit ?? ''}
          onChange={(e) => set({ unit: e.currentTarget.value || undefined })}
        />
      </Group>
    </>
  );
}

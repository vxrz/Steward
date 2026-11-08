import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** An endpoint monitored by Gatus. */
export function GatusFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'gatus'>) {
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
      <TextInput
        error={err('endpointKey')}
        data-field="endpointKey"
        label={t('form.endpointKey')}
        description={t('form.endpointKeyHint', { pattern: '<group>_<name>', example: 'plant_historian-api' })}
        required
        disabled={disabled}
        value={c.endpointKey}
        onChange={(e) => set({ endpointKey: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
      />
      <Select
        error={err('source')}
        data-field="source"
        label={t('form.gatusSource')}
        description={t('form.gatusSourceHint')}
        disabled={disabled}
        allowDeselect={false}
        data={(['auto', 'api', 'metrics'] as const).map((v) => ({ value: v, label: t(`form.gatusSources.${v}`) }))}
        value={c.source ?? 'auto'}
        onChange={(v) => set({ source: v === 'auto' || !v ? undefined : (v as 'api' | 'metrics') })}
      />
      <Group grow align="flex-start">
        <NumberInput
          error={err('maxAgeSeconds')}
          data-field="maxAgeSeconds"
          label={t('form.gatusMaxAge')}
          min={1}
          disabled={disabled}
          value={c.maxAgeSeconds ?? ''}
          onChange={(v) => set({ maxAgeSeconds: num(v) })}
        />
        <NumberInput
          error={err('degradedOnRecentFailures')}
          data-field="degradedOnRecentFailures"
          label={t('form.gatusRecent')}
          min={0}
          disabled={disabled}
          value={c.degradedOnRecentFailures ?? ''}
          onChange={(v) => set({ degradedOnRecentFailures: num(v) })}
        />
      </Group>
    </>
  );
}

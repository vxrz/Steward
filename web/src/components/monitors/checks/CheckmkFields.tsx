import { Group, NumberInput, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** A host or service in Checkmk. */
export function CheckmkFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'checkmk'>) {
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
      <Group grow align="flex-start">
        <TextInput
          error={err('host')}
          data-field="host"
          label={t('form.cmkHost')}
          required
          disabled={disabled}
          value={c.host}
          onChange={(e) => set({ host: e.currentTarget.value })}
          classNames={{ input: 'mono' }}
        />
        <TextInput
          error={err('service')}
          data-field="service"
          label={t('form.cmkService')}
          description={t('form.cmkServiceHint')}
          disabled={disabled}
          value={c.service ?? ''}
          onChange={(e) => set({ service: e.currentTarget.value || undefined })}
        />
      </Group>
      <NumberInput
        error={err('maxAgeSeconds')}
        data-field="maxAgeSeconds"
        label={t('form.cmkMaxAge')}
        description={t('form.cmkMaxAgeHint')}
        min={1}
        disabled={disabled}
        value={c.maxAgeSeconds ?? ''}
        onChange={(v) => set({ maxAgeSeconds: num(v) })}
      />
    </>
  );
}

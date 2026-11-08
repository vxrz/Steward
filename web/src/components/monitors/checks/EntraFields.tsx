import { Group, NumberInput, Select, TagsInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** Entra ID app credentials or the Microsoft 365 service health. */
export function EntraFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'entra'>) {
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
      <Select
        label={t('form.entraMode')}
        allowDeselect={false}
        disabled={disabled}
        data={(['app-credentials', 'service-health'] as const).map((m) => ({ value: m, label: t(`form.entraModes.${m}`) }))}
        value={c.mode ?? 'app-credentials'}
        onChange={(v) => set({ mode: (v as 'app-credentials' | 'service-health') ?? 'app-credentials' })}
      />
      {(c.mode ?? 'app-credentials') === 'app-credentials' ? (
        <>
          <Group grow align="flex-start">
            <NumberInput
              label={t('form.entraWithinDays')}
              description={t('form.entraWithinDaysHint')}
              min={1}
              max={365}
              disabled={disabled}
              value={c.withinDays ?? 30}
              onChange={(v) => set({ withinDays: Number(v) || 30 })}
            />
            <NumberInput
              label={t('form.entraDownWithinDays')}
              min={0}
              max={365}
              disabled={disabled}
              value={c.downWithinDays ?? 7}
              onChange={(v) => set({ downWithinDays: v === '' ? 7 : Number(v) })}
            />
          </Group>
          <TagsInput
            error={err('apps')}
            data-field="apps"
            label={t('form.entraApps')}
            description={t('form.entraAppsHint')}
            disabled={disabled}
            value={c.apps ?? []}
            onChange={(v) => set({ apps: v.length ? v : undefined })}
          />
        </>
      ) : (
        <TagsInput
          error={err('services')}
          data-field="services"
          label={t('form.entraServices')}
          description={t('form.entraServicesHint')}
          disabled={disabled}
          value={c.services ?? []}
          onChange={(v) => set({ services: v.length ? v : undefined })}
        />
      )}
    </>
  );
}

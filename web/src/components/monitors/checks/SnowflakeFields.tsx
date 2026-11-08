import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** A Snowflake table, tasks or a warehouse (#115). */
export function SnowflakeFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'snowflake'>) {
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
        <Select
          label={t('form.snowflakeMode')}
          allowDeselect={false}
          disabled={disabled}
          data={(['freshness', 'tasks', 'credits'] as const).map((m) => ({ value: m, label: t(`form.snowflakeModes.${m}`) }))}
          value={c.mode}
          onChange={(v) => set({ mode: (v as 'freshness' | 'tasks' | 'credits') ?? 'freshness' })}
        />
        <TextInput
          error={err('object')}
          data-field="object"
          label={t(`form.snowflakeObject.${c.mode}`)}
          description={t(`form.snowflakeObjectHint.${c.mode}`)}
          required
          disabled={disabled}
          value={c.object}
          onChange={(e) => set({ object: e.currentTarget.value })}
          classNames={{ input: 'mono' }}
        />
      </Group>
      <Group grow align="flex-start">
        {c.mode === 'freshness' ? (
          <NumberInput
            label={t('form.snowflakeMaxAge')}
            min={1}
            max={525600}
            disabled={disabled}
            value={c.maxAgeMinutes ?? 1440}
            onChange={(v) => set({ maxAgeMinutes: Number(v) || undefined })}
          />
        ) : (
          <NumberInput
            label={t('form.snowflakeWithinHours')}
            min={1}
            max={720}
            disabled={disabled}
            value={c.withinHours ?? 24}
            onChange={(v) => set({ withinHours: Number(v) || undefined })}
          />
        )}
        {c.mode === 'credits' && (
          <NumberInput
            label={t('form.snowflakeMaxCredits')}
            min={0}
            decimalScale={2}
            disabled={disabled}
            value={c.maxCredits ?? ''}
            onChange={(v) => set({ maxCredits: v === '' ? undefined : Number(v) })}
          />
        )}
        <Select
          label={t('form.snowflakeFailAs')}
          allowDeselect={false}
          disabled={disabled}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.failAs ?? 'down'}
          onChange={(v) => set({ failAs: (v as 'down' | 'degraded') ?? 'down' })}
        />
      </Group>
    </>
  );
}

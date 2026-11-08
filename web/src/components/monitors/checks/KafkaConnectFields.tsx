import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** Kafka Connect connectors and tasks (#223). */
export function KafkaConnectFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'kafka-connect'>) {
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
        error={err('connector')}
        data-field="connector"
        label={t('form.connectConnector')}
        description={t('form.connectConnectorHint')}
        disabled={disabled}
        value={c.connector ?? ''}
        onChange={(e) => set({ connector: e.currentTarget.value || undefined })}
        classNames={{ input: 'mono' }}
      />
      <Group grow align="flex-start">
        <Select
          label={t('form.connectNotRunningAs')}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.notRunningAs ?? 'down'}
          allowDeselect={false}
          disabled={disabled}
          onChange={(v) => v && set({ notRunningAs: v as 'down' | 'degraded' })}
        />
        <Select
          label={t('form.connectPausedAs')}
          data={[
            { value: 'up', label: t('status.up') },
            { value: 'degraded', label: t('status.degraded') },
            { value: 'down', label: t('status.down') },
          ]}
          value={c.pausedAs ?? 'degraded'}
          allowDeselect={false}
          disabled={disabled}
          onChange={(v) => v && set({ pausedAs: v as 'up' | 'down' | 'degraded' })}
        />
      </Group>
      <NumberInput
        error={err('failedMinutes')}
        data-field="failedMinutes"
        label={t('form.connectFailedMinutes')}
        description={t('form.connectFailedMinutesHint')}
        min={1}
        disabled={disabled}
        value={c.failedMinutes ?? ''}
        onChange={(v) => set({ failedMinutes: num(v) })}
      />
      <NumberInput
        error={err('maxLag')}
        data-field="maxLag"
        label={t('form.connectMaxLag')}
        description={t('form.connectMaxLagHint')}
        min={0}
        disabled={disabled}
        value={c.maxLag ?? ''}
        onChange={(v) => set({ maxLag: num(v) })}
      />
      <NumberInput
        error={err('quietMinutes')}
        data-field="quietMinutes"
        label={t('form.connectQuiet')}
        description={t('form.connectQuietHint')}
        min={1}
        disabled={disabled}
        value={c.quietMinutes ?? ''}
        onChange={(v) => set({ quietMinutes: num(v) })}
      />
      <Select
        label={t('form.quietAs')}
        data={[
          { value: 'down', label: t('status.down') },
          { value: 'degraded', label: t('status.degraded') },
        ]}
        value={c.quietAs ?? 'degraded'}
        allowDeselect={false}
        disabled={disabled || c.quietMinutes === undefined}
        onChange={(v) => v && set({ quietAs: v as 'down' | 'degraded' })}
      />
    </>
  );
}

import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** Messages on MQTT topics (#113). */
export function MqttFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'mqtt'>) {
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
          error={err('topic')}
          data-field="topic"
          label={t('form.mqttTopic')}
          description={t('form.mqttTopicHint')}
          required
          disabled={disabled}
          value={c.topic}
          onChange={(e) => set({ topic: e.currentTarget.value })}
          classNames={{ input: 'mono' }}
        />
        <Select
          label={t('form.mqttMode')}
          data={[
            { value: 'any', label: t('form.mqttModeAny') },
            { value: 'each', label: t('form.mqttModeEach') },
          ]}
          value={c.mode ?? 'any'}
          allowDeselect={false}
          disabled={disabled}
          onChange={(v) => v && set({ mode: v as 'any' | 'each' })}
        />
      </Group>
      <Group grow align="flex-start">
        <NumberInput
          error={err('withinMinutes')}
          data-field="withinMinutes"
          label={t('form.mqttWithin')}
          required
          min={1}
          disabled={disabled}
          value={c.withinMinutes}
          onChange={(v) => set({ withinMinutes: num(v) ?? 15 })}
        />
        <Select
          label={t('form.quietAs')}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.quietAs ?? 'down'}
          allowDeselect={false}
          disabled={disabled}
          onChange={(v) => v && set({ quietAs: v as 'down' | 'degraded' })}
        />
        <NumberInput
          error={err('minClients')}
          data-field="minClients"
          label={t('form.mqttMinClients')}
          description={t('form.mqttMinClientsHint')}
          min={0}
          disabled={disabled}
          value={c.minClients ?? ''}
          onChange={(v) => set({ minClients: num(v) })}
        />
      </Group>
    </>
  );
}

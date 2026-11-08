import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** A Kafka topic: new messages, a consumer group, the schema version (#112). */
export function KafkaFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'kafka'>) {
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
        error={err('topic')}
        data-field="topic"
        label={t('form.kafkaTopic')}
        required
        disabled={disabled}
        value={c.topic}
        onChange={(e) => set({ topic: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
      />
      <Group grow align="flex-start">
        <NumberInput
          error={err('messagesWithinMinutes')}
          data-field="messagesWithinMinutes"
          label={t('form.kafkaWithin')}
          description={t('form.kafkaWithinHint')}
          min={1}
          disabled={disabled}
          value={c.messagesWithinMinutes ?? ''}
          onChange={(v) => set({ messagesWithinMinutes: num(v) })}
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
      </Group>
      <Group grow align="flex-start">
        <TextInput
          error={err('group')}
          data-field="group"
          label={t('form.kafkaGroup')}
          description={t('form.kafkaGroupHint')}
          disabled={disabled}
          value={c.group ?? ''}
          onChange={(e) => set({ group: e.currentTarget.value || undefined })}
          classNames={{ input: 'mono' }}
        />
        <NumberInput
          error={err('maxLag')}
          data-field="maxLag"
          label={t('form.kafkaMaxLag')}
          min={0}
          disabled={disabled || !c.group}
          value={c.maxLag ?? ''}
          onChange={(v) => set({ maxLag: num(v) })}
        />
        <NumberInput
          error={err('stuckMinutes')}
          data-field="stuckMinutes"
          label={t('form.kafkaStuck')}
          min={1}
          disabled={disabled || !c.group}
          value={c.stuckMinutes ?? 15}
          onChange={(v) => set({ stuckMinutes: num(v) ?? 15 })}
        />
      </Group>
      <NumberInput
        error={err('schemaVersion')}
        data-field="schemaVersion"
        label={t('form.kafkaSchema')}
        description={t('form.kafkaSchemaHint')}
        min={1}
        disabled={disabled}
        value={c.schemaVersion ?? ''}
        onChange={(v) => set({ schemaVersion: num(v) })}
      />
    </>
  );
}

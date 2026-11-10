import { Group, NumberInput, SegmentedControl, Select, Stack, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** Confluent Cloud (#123): the clusters are provisioned, or the managed connectors and their tasks run. */
export function ConfluentFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'confluent'>) {
  const { t } = useTranslation('monitors');
  const target = c.target ?? 'connectors';
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
      <Stack gap={4}>
        <Text size="sm" fw={500} id="confluent-target-label">
          {t('form.confluentTarget')}
        </Text>
        <SegmentedControl
          aria-labelledby="confluent-target-label"
          data={[
            { value: 'connectors', label: t('form.confluentConnectors') },
            { value: 'clusters', label: t('form.confluentClusters') },
          ]}
          value={target}
          disabled={disabled}
          onChange={(v) => set({ target: v as 'clusters' | 'connectors' })}
        />
      </Stack>
      <TextInput
        error={err('resource')}
        data-field="resource"
        label={target === 'clusters' ? t('form.confluentCluster') : t('form.confluentConnector')}
        description={target === 'clusters' ? t('form.confluentClusterHint') : t('form.confluentConnectorHint')}
        disabled={disabled}
        value={c.resource ?? ''}
        onChange={(e) => set({ resource: e.currentTarget.value || undefined })}
        classNames={{ input: 'mono' }}
      />
      <Group grow align="flex-start">
        <Select
          label={t('form.confluentFailedAs')}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.notRunningAs ?? 'down'}
          allowDeselect={false}
          disabled={disabled}
          onChange={(v) => v && set({ notRunningAs: v as 'down' | 'degraded' })}
        />
        {target === 'connectors' && (
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
        )}
      </Group>
      {target === 'connectors' && (
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
      )}
    </>
  );
}

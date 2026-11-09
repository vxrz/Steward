import { Group, Select, TagsInput, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { DYNAMODB_LIMITS, DYNAMODB_MODES, DYNAMODB_REQUIREMENTS, DYNAMODB_TIME_FORMATS, checkPlatformKinds, type DynamoDbMode } from '@sm/shared';
import { Hint } from '../../common';
import { PlatformSelect, FreshnessFields, type CheckFieldsProps } from './common';

/** A DynamoDB table: newest item, write activity or hygiene (#233). */
export function DynamoDbFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'dynamodb'>) {
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
        error={err('table')}
        data-field="table"
        label={t('form.ddbTable')}
        required
        disabled={disabled}
        value={c.table}
        onChange={(e) => set({ table: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
        spellCheck={false}
      />
      <TextInput
        error={err('region')}
        data-field="region"
        label={t('form.ddbRegion')}
        description={t('form.ddbRegionHint', {
          region: platforms.find((p) => p.id === c.platform)?.config.auth?.aws?.region || 'us-east-1',
        })}
        placeholder={platforms.find((p) => p.id === c.platform)?.config.auth?.aws?.region || 'eu-central-1'}
        disabled={disabled}
        value={c.region ?? ''}
        onChange={(e) => set({ region: e.currentTarget.value || undefined })}
        classNames={{ input: 'mono' }}
        spellCheck={false}
      />
      <Select
        data-field="mode"
        label={t('form.ddbMode')}
        description={t(`form.ddbModeHints.${c.mode}`)}
        allowDeselect={false}
        disabled={disabled}
        data={DYNAMODB_MODES.map((m) => ({ value: m, label: t(`form.ddbModes.${m}`) }))}
        value={c.mode}
        onChange={(v) => set({ mode: (v as DynamoDbMode | null) ?? 'newestItem' })}
      />
      {c.mode === 'newestItem' && (
        <>
          <TextInput
            error={err('indexName')}
            data-field="indexName"
            label={t('form.ddbIndex')}
            description={t('form.ddbIndexHint')}
            disabled={disabled}
            value={c.indexName ?? ''}
            onChange={(e) => set({ indexName: e.currentTarget.value || undefined })}
            classNames={{ input: 'mono' }}
            spellCheck={false}
          />
          <Group grow align="flex-start">
            <TextInput
              error={err('partitionKey')}
              data-field="partitionKey"
              label={t('form.ddbPartitionKey')}
              required
              disabled={disabled}
              value={c.partitionKey ?? ''}
              onChange={(e) => set({ partitionKey: e.currentTarget.value || undefined })}
              classNames={{ input: 'mono' }}
              spellCheck={false}
              style={{ flex: 3 }}
            />
            <Select
              data-field="partitionKeyType"
              label={t('form.ddbPartitionKeyType')}
              allowDeselect={false}
              disabled={disabled}
              data={(['S', 'N'] as const).map((v) => ({ value: v, label: t(`form.ddbKeyTypes.${v}`) }))}
              value={c.partitionKeyType}
              onChange={(v) => set({ partitionKeyType: v === 'N' ? 'N' : 'S' })}
            />
          </Group>
          <TagsInput
            error={err('partitionValues')}
            data-field="partitionValues"
            label={t('form.ddbPartitionValues')}
            description={t('form.ddbPartitionValuesHint')}
            required
            disabled={disabled}
            value={c.partitionValues ?? []}
            onChange={(v) => set({ partitionValues: v })}
            maxTags={DYNAMODB_LIMITS.partitionValues}
            splitChars={[]}
          />
          <Group grow align="flex-start">
            <TextInput
              error={err('timeAttribute')}
              data-field="timeAttribute"
              label={t('form.ddbTimeAttribute')}
              required
              disabled={disabled}
              value={c.timeAttribute ?? ''}
              onChange={(e) => set({ timeAttribute: e.currentTarget.value || undefined })}
              classNames={{ input: 'mono' }}
              spellCheck={false}
            />
            <Select
              data-field="timeFormat"
              label={t('form.ddbTimeFormat')}
              allowDeselect={false}
              disabled={disabled}
              data={DYNAMODB_TIME_FORMATS.map((v) => ({ value: v, label: t(`form.ddbTimeFormats.${v}`) }))}
              value={c.timeFormat}
              onChange={(v) => set({ timeFormat: (v as (typeof DYNAMODB_TIME_FORMATS)[number] | null) ?? 'auto' })}
            />
          </Group>
        </>
      )}
      {c.mode === 'hygiene' ? (
        <>
          {(
            [
              ['activeTable', 'ddbActive'],
              ['pointInTimeRecovery', 'ddbPitr'],
              ['timeToLive', 'ddbTtl'],
            ] as const
          ).map(([field, label]) => (
            <Select
              key={field}
              data-field={field}
              label={t(`form.${label}`)}
              allowDeselect={false}
              disabled={disabled}
              data={DYNAMODB_REQUIREMENTS.map((v) => ({ value: v, label: t(`form.ddbRequirements.${v}`) }))}
              value={c[field]}
              onChange={(v) => set({ [field]: v === 'report' ? 'report' : 'required' })}
            />
          ))}
          <Select
            data-field="failAs"
            label={t('form.ddbFailAs')}
            allowDeselect={false}
            disabled={disabled}
            data={[
              { value: 'degraded', label: t('status.degraded') },
              { value: 'down', label: t('status.down') },
            ]}
            value={c.failAs}
            onChange={(v) => set({ failAs: v === 'down' ? 'down' : 'degraded' })}
          />
        </>
      ) : (
        <FreshnessFields c={c} set={set} disabled={disabled} what="data" err={err} />
      )}
      <Hint>{t('form.ddbPolicy')}</Hint>
    </>
  );
}

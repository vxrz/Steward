import { Group, SegmentedControl, Select, TagsInput, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { ExpressionInput } from '../../editor/ExpressionInput';
import { Hint, KeyValueEditor } from '../../common';
import { PlatformSelect, FreshnessFields, BodyInput, type CheckFieldsProps } from './common';

/** The newest timestamp of an Insights Hub time series or of an API answer. */
export function FreshnessCheckFields({ c, set, platforms, disabled, err, observedDelay }: CheckFieldsProps<'freshness'>) {
  const { t } = useTranslation('monitors');
  return (
    <>
      <SegmentedControl
        size="xs"
        disabled={disabled}
        value={c.source}
        onChange={(v) => set({ source: v as 'insightsHub' })}
        data={[
          { value: 'insightsHub', label: t('form.sourceInsightsHub') },
          { value: 'platform', label: t('form.sourcePlatform') },
        ]}
      />
      <PlatformSelect
        value={c.platform}
        onChange={(v) => set({ platform: v })}
        platforms={platforms}
        kinds={checkPlatformKinds(c)}
        disabled={disabled}
        error={err('platform')}
      />
      {c.source === 'insightsHub' ? (
        <>
          <Group grow align="flex-start">
            <TextInput
              error={err('assetId')}
              data-field="assetId"
              label={t('form.assetId')}
              required
              disabled={disabled}
              value={c.assetId ?? ''}
              onChange={(e) => set({ assetId: e.currentTarget.value })}
              classNames={{ input: 'mono' }}
            />
            <TextInput
              error={err('aspect')}
              data-field="aspect"
              label={t('form.aspect')}
              required
              disabled={disabled}
              value={c.aspect ?? ''}
              onChange={(e) => set({ aspect: e.currentTarget.value })}
            />
          </Group>
          <TagsInput
            error={err('variables')}
            data-field="variables"
            label={t('form.variables')}
            description={t('form.variablesHint')}
            required
            disabled={disabled}
            value={c.variables ?? []}
            onChange={(v) => set({ variables: v })}
          />
          <Hint>{t('form.sharedCall')}</Hint>
        </>
      ) : (
        <>
          <Group grow align="flex-start">
            <Select
              error={err('method')}
              data-field="method"
              label={t('form.method')}
              data={['GET', 'POST']}
              allowDeselect={false}
              disabled={disabled}
              value={c.method ?? 'GET'}
              onChange={(v) => set({ method: v === 'POST' ? 'POST' : undefined, ...(v === 'POST' ? {} : { body: undefined }) })}
              maw={120}
            />
            <TextInput
              error={err('path')}
              data-field="path"
              label={t('form.path')}
              required
              disabled={disabled}
              value={c.path ?? ''}
              onChange={(e) => set({ path: e.currentTarget.value })}
              style={{ flex: 4 }}
              classNames={{ input: 'mono' }}
            />
          </Group>
          <div data-field="headers">
            <Text size="sm" fw={500}>
              {t('form.headers')}
            </Text>
            <Text size="xs" c="dimmed" mb={4}>
              {t('form.headersHint')}
            </Text>
            <KeyValueEditor value={c.headers} onChange={(v) => set({ headers: v as Record<string, string> | undefined })} />
            {err('headers') && (
              <Text size="xs" c="red" mt={4}>
                {err('headers')}
              </Text>
            )}
          </div>
          {c.method === 'POST' && <BodyInput value={c.body} onChange={(v) => set({ body: v })} disabled={disabled} error={err('body')} />}
          <ExpressionInput
            error={err('timestamp')}
            data-field="timestamp"
            label={t('form.timestamp')}
            description={t('form.timestampHint')}
            required
            preview={false}
            value={c.timestamp ?? ''}
            onChange={(v) => set({ timestamp: v || undefined })}
          />
        </>
      )}
      <FreshnessFields c={c} set={set} disabled={disabled} what="data" err={err} observedDelay={observedDelay} />
    </>
  );
}

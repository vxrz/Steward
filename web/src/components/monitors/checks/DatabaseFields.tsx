import { Group, NumberInput, Select, TagsInput, TextInput, Textarea } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** A database platform: connection, replication or a query (#203). */
export function DatabaseFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'database'>) {
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
        data-field="mode"
        label={t('form.dbMode')}
        description={t(`form.dbModeHints.${c.mode ?? 'connection'}`)}
        allowDeselect={false}
        disabled={disabled}
        data={(['connection', 'replication', 'query'] as const).map((m) => ({ value: m, label: t(`form.dbModes.${m}`) }))}
        value={c.mode ?? 'connection'}
        onChange={(v) => set({ mode: (v as 'connection' | 'replication' | 'query') ?? 'connection' })}
      />
      {c.mode === 'query' && (
        <>
          <Textarea
            error={err('sql')}
            data-field="sql"
            label={t('form.dbSql')}
            description={t('form.dbSqlHint', { pg: '$1', my: '?', ms: '@p1' })}
            required
            autosize
            minRows={2}
            disabled={disabled}
            value={c.sql ?? ''}
            onChange={(e) => set({ sql: e.currentTarget.value || undefined })}
            classNames={{ input: 'mono' }}
            spellCheck={false}
          />
          <TagsInput
            data-field="params"
            label={t('form.dbParams')}
            description={t('form.dbParamsHint')}
            disabled={disabled}
            value={(c.params ?? []).map(String)}
            onChange={(v) => set({ params: v.length ? v : undefined })}
            splitChars={[]}
          />
        </>
      )}
      {c.mode !== 'connection' && (
        <>
          <Group grow align="flex-start">
            <Select
              data-field="direction"
              label={t('form.promDirection')}
              allowDeselect={false}
              disabled={disabled}
              data={(['above', 'below'] as const).map((v) => ({ value: v, label: t(`form.promDirections.${v}`) }))}
              value={c.direction ?? 'above'}
              onChange={(v) => set({ direction: v === 'below' ? 'below' : 'above' })}
            />
            <NumberInput
              error={err('warn')}
              data-field="warn"
              label={t('form.promWarn')}
              disabled={disabled}
              value={c.warn ?? ''}
              onChange={(v) => set({ warn: typeof v === 'number' ? v : undefined })}
              allowDecimal
            />
            <NumberInput
              error={err('crit')}
              data-field="crit"
              label={c.mode === 'replication' ? t('form.dbCritLag') : t('form.promCrit')}
              required
              disabled={disabled}
              value={c.crit ?? ''}
              onChange={(v) => set({ crit: typeof v === 'number' ? v : undefined })}
              allowDecimal
            />
          </Group>
          <Group grow align="flex-start">
            <Select
              data-field="noData"
              label={t('form.dbNoData')}
              description={t(`form.dbNoDataHints.${c.mode}`)}
              allowDeselect={false}
              disabled={disabled}
              data={(['unknown', 'up', 'down'] as const).map((v) => ({ value: v, label: t(`form.promNoDataStates.${v}`) }))}
              value={c.noData ?? 'unknown'}
              onChange={(v) => set({ noData: (v as 'unknown' | 'up' | 'down') ?? 'unknown' })}
            />
            {c.mode === 'query' && (
              <TextInput
                data-field="unit"
                label={t('form.promUnit')}
                disabled={disabled}
                value={c.unit ?? ''}
                onChange={(e) => set({ unit: e.currentTarget.value || undefined })}
              />
            )}
          </Group>
        </>
      )}
    </>
  );
}

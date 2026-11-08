import { Group, NumberInput, SegmentedControl, Select, Switch, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds, type CheckDef } from '@sm/shared';
import { PlatformSelect, SystemSelect, num, type CheckFieldsProps } from './common';

/** Schema changes of a database platform or a system (#222). */
export function DbSchemaFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'db-schema'>) {
  const { t } = useTranslation('monitors');
  const onSystem = c.system !== undefined;
  const mode = c.mode ?? 'breaking';
  return (
    <>
      <div>
        <Text size="sm" fw={500} mb={4} id={`dbschema-on-${c.id}`}>
          {t('form.dbSchemaOn')}
        </Text>
        <SegmentedControl
          size="xs"
          disabled={disabled}
          aria-labelledby={`dbschema-on-${c.id}`}
          value={onSystem ? 'system' : 'platform'}
          onChange={(v) => set((v === 'system' ? { platform: undefined, system: '', read: false } : { system: undefined, platform: '' }) as Partial<CheckDef>)}
          data={[
            { value: 'platform', label: t('form.dbSchemaOnPlatform') },
            { value: 'system', label: t('form.dbSchemaOnSystem') },
          ]}
        />
      </div>
      {onSystem ? (
        <SystemSelect value={c.system ?? ''} onChange={(v) => set({ system: v } as Partial<CheckDef>)} disabled={disabled} error={err('system')} />
      ) : (
        <PlatformSelect
          value={c.platform ?? ''}
          onChange={(v) => set({ platform: v } as Partial<CheckDef>)}
          platforms={platforms}
          kinds={checkPlatformKinds(c)}
          disabled={disabled}
          error={err('platform')}
        />
      )}
      <Group grow align="flex-start">
        <Select
          data-field="mode"
          label={t('form.dbSchemaMode')}
          description={t(`form.dbSchemaModeHints.${mode}`)}
          allowDeselect={false}
          disabled={disabled}
          data={(['breaking', 'changed'] as const).map((m) => ({ value: m, label: t(`form.dbSchemaModes.${m}`) }))}
          value={mode}
          onChange={(v) => set({ mode: v === 'changed' ? 'changed' : 'breaking', failAs: undefined } as Partial<CheckDef>)}
        />
        <NumberInput
          data-field="withinHours"
          label={t('form.dbSchemaWithin')}
          min={1}
          max={8760}
          disabled={disabled}
          error={err('withinHours')}
          value={c.withinHours ?? 24}
          onChange={(v) => set({ withinHours: num(v) ?? 24 } as Partial<CheckDef>)}
        />
      </Group>
      <Group grow align="flex-start">
        <Select
          data-field="failAs"
          label={t('form.dbSchemaFailAs')}
          allowDeselect={false}
          disabled={disabled}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.failAs ?? (mode === 'breaking' ? 'down' : 'degraded')}
          onChange={(v) => set({ failAs: (v as 'down' | 'degraded') ?? undefined } as Partial<CheckDef>)}
        />
        <Select
          data-field="noData"
          label={t('form.dbSchemaNoData')}
          allowDeselect={false}
          disabled={disabled}
          data={(['unknown', 'up', 'down'] as const).map((v) => ({ value: v, label: t(`form.promNoDataStates.${v}`) }))}
          value={c.noData ?? 'unknown'}
          onChange={(v) => set({ noData: (v as 'unknown' | 'up' | 'down') ?? 'unknown' } as Partial<CheckDef>)}
        />
      </Group>
      {!onSystem && (
        <Switch
          data-field="read"
          label={t('form.dbSchemaRead')}
          description={t('form.dbSchemaReadHint')}
          disabled={disabled}
          checked={!!c.read}
          onChange={(e) => set({ read: e.currentTarget.checked } as Partial<CheckDef>)}
        />
      )}
    </>
  );
}

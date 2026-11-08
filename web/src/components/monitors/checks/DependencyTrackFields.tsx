import { Group, NumberInput, Select, Switch, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** Open findings of a Dependency-Track project (#119). */
export function DependencyTrackFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'dependency-track'>) {
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
        error={err('project')}
        data-field="project"
        label={t('form.dtrackProject')}
        description={t('form.dtrackProjectHint')}
        required
        disabled={disabled}
        value={c.project}
        onChange={(e) => set({ project: e.currentTarget.value })}
        classNames={{ input: 'mono' }}
      />
      <Group grow align="flex-start">
        <NumberInput
          label={t('form.dtrackMaxCritical')}
          min={0}
          disabled={disabled}
          value={c.maxCritical ?? 0}
          onChange={(v) => set({ maxCritical: Number(v) || 0 })}
        />
        <NumberInput
          label={t('form.dtrackMaxHigh')}
          description={t('form.dtrackMaxHighHint')}
          min={0}
          disabled={disabled}
          value={c.maxHigh ?? ''}
          onChange={(v) => set({ maxHigh: v === '' ? undefined : Number(v) })}
        />
        <Select
          label={t('form.dtrackFailAs')}
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
      <Switch
        label={t('form.dtrackPolicyFail')}
        disabled={disabled}
        checked={c.policyFail ?? true}
        onChange={(e) => set({ policyFail: e.currentTarget.checked })}
      />
    </>
  );
}

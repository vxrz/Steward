import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** The pipeline of a repository branch (#107). */
export function GitFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'git'>) {
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
          error={err('repository')}
          data-field="repository"
          label={t('form.gitRepository')}
          description={t('form.gitRepositoryHint')}
          required
          disabled={disabled}
          value={c.repository}
          onChange={(e) => set({ repository: e.currentTarget.value })}
          classNames={{ input: 'mono' }}
        />
        <TextInput
          error={err('branch')}
          data-field="branch"
          label={t('form.gitBranch')}
          description={t('form.gitBranchHint')}
          disabled={disabled}
          value={c.branch ?? ''}
          onChange={(e) => set({ branch: e.currentTarget.value || undefined })}
          classNames={{ input: 'mono' }}
        />
      </Group>
      <Group grow align="flex-start">
        <Select
          label={t('form.gitFailedAs')}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.failedAs ?? 'down'}
          allowDeselect={false}
          disabled={disabled}
          onChange={(v) => v && set({ failedAs: v as 'down' | 'degraded' })}
        />
        <NumberInput
          error={err('maxCritical')}
          data-field="maxCritical"
          label={t('form.gitMaxCritical')}
          min={0}
          disabled={disabled}
          value={c.maxCritical ?? ''}
          onChange={(v) => set({ maxCritical: num(v) })}
        />
        <NumberInput
          error={err('maxHigh')}
          data-field="maxHigh"
          label={t('form.gitMaxHigh')}
          description={t('form.gitAlertsHint')}
          min={0}
          disabled={disabled}
          value={c.maxHigh ?? ''}
          onChange={(v) => set({ maxHigh: num(v) })}
        />
      </Group>
    </>
  );
}

import { Group, NumberInput, Select, TagsInput, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** Hygiene of IBM Verify Privilege Vault secrets (#205). */
export function PrivilegeVaultFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'privilege-vault'>) {
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
        error={err('folder')}
        data-field="folder"
        label={t('form.vaultFolder')}
        description={t('form.vaultFolderHint')}
        disabled={disabled}
        value={c.folder ?? ''}
        onChange={(e) => set({ folder: e.currentTarget.value || undefined })}
        classNames={{ input: 'mono' }}
      />
      <TagsInput
        label={t('form.vaultPrivilegedFolders')}
        description={t('form.vaultPrivilegedFoldersHint')}
        disabled={disabled}
        value={c.privilegedFolders ?? []}
        onChange={(v) => set({ privilegedFolders: v })}
        classNames={{ input: 'mono' }}
      />
      <TagsInput
        label={t('form.vaultPrivilegedTemplates')}
        description={t('form.vaultPrivilegedTemplatesHint')}
        disabled={disabled}
        value={c.privilegedTemplates ?? []}
        onChange={(v) => set({ privilegedTemplates: v })}
      />
      <Group grow align="flex-start">
        <NumberInput
          error={err('maxAgeDays')}
          data-field="maxAgeDays"
          label={t('form.vaultMaxAgeDays')}
          min={1}
          max={3650}
          disabled={disabled}
          value={c.maxAgeDays ?? 90}
          onChange={(v) => set({ maxAgeDays: Number(v) || 90 })}
        />
        <NumberInput
          label={t('form.vaultMaxFindings')}
          description={t('form.vaultMaxFindingsHint')}
          min={0}
          disabled={disabled}
          value={c.maxFindings ?? 0}
          onChange={(v) => set({ maxFindings: Number(v) || 0 })}
        />
        <Select
          label={t('form.vaultFailAs')}
          allowDeselect={false}
          disabled={disabled}
          data={[
            { value: 'down', label: t('status.down') },
            { value: 'degraded', label: t('status.degraded') },
          ]}
          value={c.failAs ?? 'degraded'}
          onChange={(v) => set({ failAs: (v as 'down' | 'degraded') ?? 'degraded' })}
        />
      </Group>
    </>
  );
}

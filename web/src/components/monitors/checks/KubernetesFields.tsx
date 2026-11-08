import { Group, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { checkPlatformKinds } from '@sm/shared';
import { PlatformSelect, type CheckFieldsProps } from './common';

/** Deployments of a Kubernetes namespace (#111). */
export function KubernetesFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'kubernetes'>) {
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
          error={err('namespace')}
          data-field="namespace"
          label={t('form.k8sNamespace')}
          required
          disabled={disabled}
          value={c.namespace}
          onChange={(e) => set({ namespace: e.currentTarget.value })}
          classNames={{ input: 'mono' }}
        />
        <TextInput
          error={err('deployment')}
          data-field="deployment"
          label={t('form.k8sDeployment')}
          description={t('form.k8sDeploymentHint')}
          disabled={disabled}
          value={c.deployment ?? ''}
          onChange={(e) => set({ deployment: e.currentTarget.value || undefined })}
          classNames={{ input: 'mono' }}
        />
      </Group>
    </>
  );
}

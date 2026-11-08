import { Group, NumberInput, Select, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { ExpressionInput } from '../../editor/ExpressionInput';
import { KeyValueEditor } from '../../common';
import { PlatformSelect, num, type CheckFieldsProps } from './common';

/** An operation through a platform (its authentication and base URL). */
export function PlatformCheckFields({ c, set, platforms, disabled, err }: CheckFieldsProps<'platform'>) {
  const { t } = useTranslation('monitors');
  return (
    <>
      <PlatformSelect value={c.platform} onChange={(v) => set({ platform: v })} platforms={platforms} disabled={disabled} error={err('platform')} />
      <Group grow align="flex-start">
        <Select
          error={err('method')}
          data-field="method"
          label={t('form.method')}
          data={['GET', 'HEAD', 'POST']}
          disabled={disabled}
          value={c.method}
          onChange={(v) => set({ method: (v ?? 'GET') as 'GET' })}
          maw={120}
        />
        <TextInput
          error={err('path')}
          data-field="path"
          label={t('form.path')}
          required
          disabled={disabled}
          value={c.path}
          onChange={(e) => set({ path: e.currentTarget.value })}
          style={{ flex: 4 }}
          classNames={{ input: 'mono' }}
        />
      </Group>
      <Text size="sm" fw={500}>
        {t('form.query')}
      </Text>
      <KeyValueEditor value={c.query} onChange={(v) => set({ query: v as Record<string, string> | undefined })} />
      <ExpressionInput
        error={err('condition')}
        data-field="condition"
        label={t('form.condition')}
        description={t('form.conditionPlatformHint', { vars: '{ status, headers, body, durationMs }' })}
        preview={false}
        value={c.condition ?? ''}
        onChange={(v) => set({ condition: v || undefined })}
      />
      <NumberInput
        error={err('degradedResponseMs')}
        data-field="degradedResponseMs"
        label={t('form.degradedAbove')}
        min={1}
        disabled={disabled}
        value={c.degradedResponseMs ?? ''}
        onChange={(v) => set({ degradedResponseMs: num(v) })}
      />
    </>
  );
}

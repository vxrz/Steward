import { Group, NumberInput, Select, Switch, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { ExpressionInput } from '../../editor/ExpressionInput';
import { num, type CheckFieldsProps } from './common';

/** A URL: method, expected status, condition, TLS. */
export function HttpFields({ c, set, disabled, err }: CheckFieldsProps<'http'>) {
  const { t } = useTranslation('monitors');
  return (
    <>
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
          error={err('url')}
          data-field="url"
          label={t('secrets.url')}
          required
          disabled={disabled}
          value={c.url}
          onChange={(e) => set({ url: e.currentTarget.value })}
          style={{ flex: 4 }}
        />
      </Group>
      <Group grow align="flex-start">
        <TextInput
          error={err('expectStatus')}
          data-field="expectStatus"
          label={t('form.expectedStatus')}
          placeholder="200-399"
          disabled={disabled}
          value={c.expectStatus ?? ''}
          onChange={(e) => set({ expectStatus: e.currentTarget.value || undefined })}
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
        <NumberInput
          error={err('tlsExpiryWarnDays')}
          data-field="tlsExpiryWarnDays"
          label={t('form.certWarning')}
          description={t('form.certWarningHint')}
          min={0}
          disabled={disabled}
          value={c.tlsExpiryWarnDays ?? ''}
          onChange={(v) => set({ tlsExpiryWarnDays: num(v) })}
        />
      </Group>
      <ExpressionInput
        error={err('condition')}
        data-field="condition"
        label={t('form.condition')}
        description={t('form.conditionHttpHint', { vars: '{ status, headers, body, durationMs }', example: 'body.status = "UP"' })}
        preview={false}
        value={c.condition ?? ''}
        onChange={(v) => set({ condition: v || undefined })}
      />
      <Switch
        label={t('form.insecureTls')}
        disabled={disabled}
        checked={!!c.insecureTls}
        onChange={(e) => set({ insecureTls: e.currentTarget.checked || undefined })}
      />
      <Switch
        label={t('form.useProxy')}
        disabled={disabled}
        checked={c.useProxy !== false}
        onChange={(e) => set({ useProxy: e.currentTarget.checked ? undefined : false })}
      />
    </>
  );
}

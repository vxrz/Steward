import { Group, NumberInput, Select, TagsInput, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { ExpressionInput } from '../../editor/ExpressionInput';
import { JsonView } from '../../common';
import { fmtDate, fmtRelative } from '../../../format';
import { FreshnessFields, num, type CheckFieldsProps } from './common';

/** Reports pushed to Steward: the expected cadence, the condition and who may report. */
export function HeartbeatFields({ c, set, monitorKey, disabled, err, lastReport }: CheckFieldsProps<'heartbeat'>) {
  const { t } = useTranslation('monitors');
  return (
    <>
      <TextInput
        error={err('key')}
        data-field="key"
        label={t('form.gatewayKey')}
        description={t('form.defaultValue', { value: `${monitorKey}.${c.id}` })}
        disabled={disabled}
        value={c.key ?? ''}
        placeholder={`${monitorKey}.${c.id}`}
        onChange={(e) => set({ key: e.currentTarget.value || undefined })}
        classNames={{ input: 'mono' }}
      />
      <FreshnessFields c={c} set={set} disabled={disabled} what="reports" err={err} />
      <div data-testid="last-report">
        <Text size="sm" fw={500}>
          {t('form.lastReport')}
        </Text>
        {lastReport?.report != null ? (
          <>
            <Text size="xs" c="dimmed">
              {t('form.lastReportHint', { when: lastReport.at ? `${fmtDate(lastReport.at)} (${fmtRelative(lastReport.at)})` : '' })}
            </Text>
            <JsonView value={lastReport.report} maxHeight={140} />
          </>
        ) : (
          <Text size="xs" c="dimmed">
            {t('form.lastReportNone')}
          </Text>
        )}
      </div>
      <ExpressionInput
        error={err('condition')}
        data-field="condition"
        label={t('form.reportCondition')}
        description={t('form.reportConditionHint', { vars: '{ status, value, ts, data }', example: 'value > 0' })}
        preview={false}
        value={c.condition ?? ''}
        onChange={(v) => set({ condition: v || undefined })}
      />
      <ExpressionInput
        error={err('statusExpression')}
        data-field="statusExpression"
        label={t('form.statusExpression')}
        description={t('form.statusExpressionHint')}
        preview={false}
        value={c.statusExpression ?? ''}
        onChange={(v) => set({ statusExpression: v || undefined })}
      />
      <Group grow align="flex-start">
        <Select
          error={err('authMode')}
          data-field="authMode"
          label={t('form.authentication')}
          disabled={disabled}
          value={c.authMode}
          onChange={(v) => set({ authMode: (v ?? 'token') as 'token' })}
          data={[
            { value: 'token', label: t('auth.mode.token') },
            { value: 'hmac', label: t('auth.mode.hmac') },
            { value: 'either', label: t('auth.mode.either') },
          ]}
        />
        <NumberInput
          error={err('rateLimitPerMinute')}
          data-field="rateLimitPerMinute"
          label={t('form.reportsPerMinute')}
          description={t('form.default60')}
          min={1}
          max={600}
          disabled={disabled}
          value={c.rateLimitPerMinute ?? ''}
          onChange={(v) => set({ rateLimitPerMinute: num(v) })}
        />
      </Group>
      <TagsInput
        error={err('allowedCidrs')}
        data-field="allowedCidrs"
        label={t('gateways.cidrs')}
        description={t('form.cidrsHint')}
        disabled={disabled}
        value={c.allowedCidrs ?? []}
        onChange={(v) => set({ allowedCidrs: v.length ? v : undefined })}
      />
    </>
  );
}

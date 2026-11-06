import { Group, NumberInput, Select, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { COST_CHECK_PERIODS, COST_SCOPES, type CheckDef, type CheckOf, type CostOverview, type CostScope } from '@sm/shared';
import { get } from '../../api';
import { costKeys } from '../../queryKeys';

/**
 * The fields of the monitor check "Cost change" (#226): what the costs are of (the scopes the editor may see), the
 * comparison and the limits – a percentage, an amount, or both.
 */
export function CostCheckFields({
  c,
  set,
  disabled,
  err,
}: {
  c: CheckOf<'cost'>;
  set: (p: Partial<CheckDef>) => void;
  disabled?: boolean;
  err: (field: string) => string | undefined;
}) {
  const { t } = useTranslation('monitors');
  const scope = (c.scope ?? 'service') as CostScope;
  const q = useQuery({ queryKey: costKeys.overview(scope), queryFn: () => get<CostOverview>(`/costs?scope=${scope}`) });
  const targets = [...new Map((q.data?.rows ?? []).map((r) => [r.id, r.name])).entries()].map(([value, label]) => ({ value, label }));
  return (
    <>
      <Group grow align="flex-start">
        <Select
          data-field="scope"
          label={t('form.cost.scope')}
          allowDeselect={false}
          disabled={disabled}
          data={COST_SCOPES.map((s) => ({ value: s, label: t(`form.cost.scopes.${s}`) }))}
          value={scope}
          onChange={(v) => set({ scope: (v ?? 'service') as CostScope, target: '' } as Partial<CheckDef>)}
        />
        <Select
          data-field="target"
          label={t('form.cost.target')}
          searchable
          disabled={disabled}
          data={targets}
          value={c.target || null}
          nothingFoundMessage={t('form.cost.targetEmpty')}
          onChange={(v) => set({ target: v ?? '' } as Partial<CheckDef>)}
          error={err('target')}
        />
      </Group>
      <Select
        data-field="period"
        label={t('form.cost.period')}
        allowDeselect={false}
        disabled={disabled}
        data={COST_CHECK_PERIODS.map((p) => ({ value: p, label: t(`form.cost.periods.${p}`) }))}
        value={c.period ?? 'month'}
        onChange={(v) => set({ period: v === 'monthToDate' ? 'monthToDate' : 'month' } as Partial<CheckDef>)}
      />
      <Group grow align="flex-start">
        <NumberInput
          data-field="maxIncreasePct"
          label={t('form.cost.maxIncreasePct')}
          min={0}
          max={100000}
          disabled={disabled}
          value={c.maxIncreasePct ?? ''}
          onChange={(v) => set({ maxIncreasePct: typeof v === 'number' ? v : undefined } as Partial<CheckDef>)}
          error={err('maxIncreasePct')}
        />
        <TextInput
          data-field="maxIncrease"
          label={t('form.cost.maxIncrease')}
          description={t('form.cost.maxIncreaseHint')}
          inputMode="decimal"
          disabled={disabled}
          value={c.maxIncrease ?? ''}
          onChange={(e) => set({ maxIncrease: e.currentTarget.value.trim() || undefined } as Partial<CheckDef>)}
          error={err('maxIncrease')}
        />
        <TextInput
          data-field="currency"
          label={t('form.cost.currency')}
          description={t('form.cost.currencyHint')}
          maxLength={3}
          disabled={disabled}
          value={c.currency ?? ''}
          onChange={(e) => set({ currency: e.currentTarget.value.trim().toUpperCase() || undefined } as Partial<CheckDef>)}
          error={err('currency')}
        />
      </Group>
      <Group grow align="flex-start">
        <Select
          data-field="failAs"
          label={t('form.cost.failAs')}
          allowDeselect={false}
          disabled={disabled}
          data={(['degraded', 'down'] as const).map((s) => ({ value: s, label: t(`form.cost.statuses.${s}`) }))}
          value={c.failAs ?? 'degraded'}
          onChange={(v) => set({ failAs: v === 'down' ? 'down' : 'degraded' } as Partial<CheckDef>)}
        />
        <Select
          data-field="noData"
          label={t('form.cost.noData')}
          allowDeselect={false}
          disabled={disabled}
          data={(['unknown', 'up'] as const).map((s) => ({ value: s, label: t(`form.cost.statuses.${s}`) }))}
          value={c.noData ?? 'unknown'}
          onChange={(v) => set({ noData: v === 'up' ? 'up' : 'unknown' } as Partial<CheckDef>)}
        />
      </Group>
    </>
  );
}

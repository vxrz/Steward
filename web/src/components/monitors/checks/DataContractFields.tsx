import { Group, NumberInput, Select } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { type CheckDef, type DataContractSummary } from '@sm/shared';
import { get } from '../../../api';
import { Hint } from '../../common';
import { dataContractKeys } from '../../../queryKeys';
import { num, type CheckFieldsProps } from './common';

/** A data contract (#221): its test through the data contract service, or Steward's own findings. */
export function DataContractFields({ c, set, disabled, err }: CheckFieldsProps<'data-contract'>) {
  const { t } = useTranslation('monitors');
  const contracts = useQuery({ queryKey: dataContractKeys.list, queryFn: () => get<DataContractSummary[]>('/data-contracts') });
  const list = contracts.data ?? [];
  const mode = c.mode ?? 'test';
  return (
    <>
      <Select
        label={t('form.contract')}
        description={t('form.contractHint')}
        required
        error={err('contract')}
        data-field="contract"
        searchable
        disabled={disabled}
        data={list.map((x) => ({ value: x.id, label: `${x.name} (${x.key})` }))}
        value={list.some((x) => x.id === c.contract) ? c.contract : null}
        placeholder={c.contract && !list.some((x) => x.id === c.contract) ? c.contract : t('form.chooseContract')}
        onChange={(v) => set({ contract: v ?? '' } as Partial<CheckDef>)}
        nothingFoundMessage={t('form.noContract')}
      />
      <Group grow align="flex-start">
        <Select
          data-field="mode"
          label={t('form.contractMode')}
          description={t(`form.contractModeHints.${mode}`)}
          allowDeselect={false}
          disabled={disabled}
          data={(['test', 'findings'] as const).map((m) => ({ value: m, label: t(`form.contractModes.${m}`) }))}
          value={mode}
          onChange={(v) => set({ mode: v === 'findings' ? 'findings' : 'test' } as Partial<CheckDef>)}
        />
        {mode === 'findings' && (
          <NumberInput
            data-field="testedWithinDays"
            label={t('form.contractTestedWithin')}
            min={1}
            max={365}
            disabled={disabled}
            value={c.testedWithinDays ?? 7}
            onChange={(v) => set({ testedWithinDays: num(v) ?? 7 } as Partial<CheckDef>)}
          />
        )}
      </Group>
      <Group grow align="flex-start">
        <Select
          data-field="failAs"
          label={t(mode === 'test' ? 'form.contractFailAs' : 'form.contractErrorAs')}
          allowDeselect={false}
          disabled={disabled}
          data={(['down', 'degraded'] as const).map((v) => ({ value: v, label: t(`status.${v}`) }))}
          value={c.failAs ?? 'down'}
          onChange={(v) => set({ failAs: (v as 'down' | 'degraded') ?? 'down' } as Partial<CheckDef>)}
        />
        <Select
          data-field="warningAs"
          label={t(mode === 'test' ? 'form.contractWarningAs' : 'form.contractWarningFindingAs')}
          allowDeselect={false}
          disabled={disabled}
          data={(['degraded', 'up'] as const).map((v) => ({ value: v, label: t(`status.${v}`) }))}
          value={c.warningAs ?? 'degraded'}
          onChange={(v) => set({ warningAs: (v as 'degraded' | 'up') ?? 'degraded' } as Partial<CheckDef>)}
        />
      </Group>
      {mode === 'test' && <Hint>{t('form.contractTestHint')}</Hint>}
    </>
  );
}

import { Select } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { HIDDEN_MONITOR_REF } from '@sm/shared';
import { type CheckFieldsProps } from './common';

/** The aggregated status of another monitor. */
export function SubMonitorFields({ c, set, monitors, monitorKey, disabled, err }: CheckFieldsProps<'monitor'>) {
  const { t } = useTranslation('monitors');
  return (
    <Select
      error={err('monitor')}
      data-field="monitor"
      label={t('list.monitor')}
      description={t('form.subMonitorHint')}
      required
      searchable
      disabled={disabled}
      data={[
        ...monitors.filter((m) => !m.isTemplate && m.key !== monitorKey).map((m) => ({ value: m.id, label: m.name })),
        // a sub-monitor the user may not view: kept as it is when saved
        ...(c.monitor === HIDDEN_MONITOR_REF ? [{ value: HIDDEN_MONITOR_REF, label: t('detail.hiddenMonitor') }] : []),
      ]}
      value={c.monitor === HIDDEN_MONITOR_REF || monitors.some((m) => m.id === c.monitor) ? c.monitor : null}
      onChange={(v) => set({ monitor: v ?? '' })}
    />
  );
}

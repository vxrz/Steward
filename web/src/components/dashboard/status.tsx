import { Group, Text, Tooltip } from '@mantine/core';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconCircleX, IconHelpCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DatasetStatus } from '@sm/shared';
import i18n from '../../i18n';

/** Severity order used for sorting and stacked bars (good first, unknown last). */
export const STATUS_ORDER: DatasetStatus[] = ['good', 'warning', 'serious', 'critical', 'unknown'];
/** Worst first – used when sorting tables by status. */
export const SEVERITY_RANK: Record<DatasetStatus, number> = { critical: 0, serious: 1, warning: 2, unknown: 3, good: 4 };

/** `label` is read at render time, so it follows the UI language. */
const meta = (status: DatasetStatus, color: string, Icon: typeof IconCircleCheck) => ({
  color,
  Icon,
  get label(): string {
    return i18n.t(`dashboards:status.${status}`);
  },
});

export const STATUS_META: Record<DatasetStatus, { readonly label: string; color: string; Icon: typeof IconCircleCheck }> = {
  good: meta('good', 'var(--viz-good)', IconCircleCheck),
  warning: meta('warning', 'var(--viz-warning)', IconAlertTriangle),
  serious: meta('serious', 'var(--viz-serious)', IconAlertCircle),
  critical: meta('critical', 'var(--viz-critical)', IconCircleX),
  unknown: meta('unknown', 'var(--viz-unknown)', IconHelpCircle),
};

export function asStatus(v: unknown): DatasetStatus {
  return (STATUS_ORDER as string[]).includes(String(v)) ? (v as DatasetStatus) : 'unknown';
}

/** Status is never color alone: colored icon + text label (+ optional reason tooltip). */
export function StatusLabel({ status, text, count, size = 'sm' }: { status?: DatasetStatus; text?: string; count?: number; size?: 'xs' | 'sm' }) {
  useTranslation('dashboards');
  const s = asStatus(status);
  const m = STATUS_META[s];
  const body = (
    <Group gap={4} wrap="nowrap" className="viz-root" style={{ display: 'inline-flex' }}>
      <m.Icon size={size === 'xs' ? 14 : 16} color={m.color} stroke={2} aria-hidden />
      <Text size={size} c="var(--viz-text-primary)" span>
        {m.label}
        {count !== undefined && (
          <Text span size={size} c="var(--viz-text-secondary)" className="viz-num">
            {' '}
            {count}
          </Text>
        )}
      </Text>
    </Group>
  );
  return text ? (
    <Tooltip label={text} withArrow multiline maw={320}>
      <span style={{ cursor: 'help' }}>{body}</span>
    </Tooltip>
  ) : (
    body
  );
}

export function StatusCounts({ counts, size = 'xs' }: { counts: Partial<Record<DatasetStatus, number>>; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dashboards');
  const present = STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0);
  if (!present.length)
    return (
      <Text size={size} c="dimmed">
        {t('status.none')}
      </Text>
    );
  return (
    <Group gap={10} wrap="wrap">
      {present.map((s) => (
        <StatusLabel key={s} status={s} count={counts[s]} size={size} />
      ))}
    </Group>
  );
}

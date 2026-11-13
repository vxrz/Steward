import { Badge } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconHelpCircle,
  IconLock,
  IconPower,
  IconTool,
  type Icon,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataHealthStatus } from '@sm/shared';

/**
 * Health in the data products pictures (ADR 0036 part 10, WP3's statuses): an icon and a word with every colour, never
 * colour alone. Only linked checks give health; without one an element says _No data_, never OK.
 */

export const HEALTH_ICON: Record<DataHealthStatus, Icon> = {
  up: IconCircleCheck,
  degraded: IconAlertTriangle,
  down: IconCircleX,
  unknown: IconHelpCircle,
  blocked: IconLock,
  maintenance: IconTool,
  off: IconPower,
  noData: IconCircleDashed,
};

const HEALTH_COLOR: Record<DataHealthStatus, string> = {
  up: 'green',
  degraded: 'orange',
  down: 'red',
  unknown: 'gray',
  blocked: 'orange',
  maintenance: 'blue',
  off: 'gray',
  noData: 'gray',
};

/** The colour of a status as a CSS value (the plant views' tokens, light and dark). */
export const healthVar = (s: DataHealthStatus): string =>
  s === 'up'
    ? 'var(--pv-ok)'
    : s === 'down'
      ? 'var(--pv-fail)'
      : s === 'degraded' || s === 'blocked'
        ? 'var(--pv-warn)'
        : s === 'maintenance'
          ? 'var(--pv-flow)'
          : 'var(--pv-unknown)';

/** Health as an icon and a word. */
export function HealthBadge({ status, size = 'sm' }: { status: DataHealthStatus; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProductViews');
  const I = HEALTH_ICON[status];
  return (
    <Badge
      size={size}
      color={HEALTH_COLOR[status]}
      variant="light"
      leftSection={<I size={size === 'xs' ? 10 : 12} aria-hidden />}
      style={{ minWidth: 'max-content', textTransform: 'none' }}
      data-health={status}
    >
      {t(`health.${status}`)}
    </Badge>
  );
}

import { Badge, Tooltip } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { unitSymbol, type PlantUnitMismatch } from '@sm/shared';

/**
 * 0.12.0: small marks for KPI potential and template profiles – a template badge, whether an asset's data for a KPI is
 * collected already, and data point inputs it delivers in another unit than the KPI expects.
 */

/** A template profile: only for other profiles to extend. */
export function TemplateBadge({ size = 'xs' }: { size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plantModel');
  return (
    <Tooltip label={t('template.badgeHelp')} withArrow multiline maw={280}>
      <Badge size={size} variant="light" color="grape" tabIndex={0} data-testid="template-badge">
        {t('template.badge')}
      </Badge>
    </Tooltip>
  );
}

/** Whether a data collection of the asset maps every data point input of the KPI. */
export function CollectedBadge({ collected }: { collected: boolean }) {
  const { t } = useTranslation('plantModel');
  return (
    <Tooltip label={t(collected ? 'potential.readyHelp' : 'potential.collectHelp')} withArrow multiline maw={300}>
      <Badge size="xs" variant="light" color={collected ? 'teal' : 'gray'} tabIndex={0} data-testid={collected ? 'potential-ready' : 'potential-collect'}>
        {t(collected ? 'potential.ready' : 'potential.collect')}
      </Badge>
    </Tooltip>
  );
}

/** Data point inputs in another unit: one badge, the list on hover. */
export function UnitsBadge({ units }: { units: PlantUnitMismatch[] | undefined }) {
  const { t } = useTranslation('plantModel');
  if (!units?.length) return null;
  const incompatible = units.some((u) => u.relation === 'incompatible');
  const list = units
    .map((u) =>
      t(u.relation === 'convertible' ? 'units.lineConvertible' : 'units.line', {
        point: u.point,
        expected: unitSymbol(u.expected),
        actual: unitSymbol(u.actual),
      }),
    )
    .join('\n');
  return (
    <Tooltip label={list} withArrow multiline maw={340} style={{ whiteSpace: 'pre-line' }}>
      <Badge size="xs" variant="light" color={incompatible ? 'red' : 'orange'} tabIndex={0} data-testid="units-differ">
        {t('units.differ', { count: units.length })}
      </Badge>
    </Tooltip>
  );
}

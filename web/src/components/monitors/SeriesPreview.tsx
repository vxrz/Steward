import { ScrollArea, Table, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { SeriesFreshness } from '@sm/shared';
import { fmtDate } from '../../format';
import { fmtSeconds } from './ObservedDelay';
import { MonitorStatusBadge } from './status';

/** Check now of an InfluxDB freshness check (0.18.0): the newest timestamp, age and status of every series, the worst first. */
export function SeriesPreview({ series }: { series: SeriesFreshness[] }) {
  const { t } = useTranslation('monitors');
  const rank = { down: 3, degraded: 2, unknown: 1 } as Record<string, number>;
  const sorted = [...series].sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0) || (b.ageSeconds ?? Infinity) - (a.ageSeconds ?? Infinity));
  return (
    <ScrollArea.Autosize mah={220} mt={4} data-testid="series-preview">
      <Table fz="xs" verticalSpacing={2} horizontalSpacing={6}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('form.influxSeries')}</Table.Th>
            <Table.Th>{t('form.influxNewest')}</Table.Th>
            <Table.Th>{t('form.influxAge')}</Table.Th>
            <Table.Th>{t('form.influxStatus')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {sorted.map((s) => (
            <Table.Tr key={s.name}>
              <Table.Td style={{ overflowWrap: 'anywhere' }}>{s.name || t('form.influxOneSeries')}</Table.Td>
              <Table.Td>
                {s.newest ? (
                  fmtDate(s.newest)
                ) : (
                  <Text span size="xs" c="dimmed">
                    {t('form.influxNoData')}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>{s.ageSeconds === null ? '–' : fmtSeconds(s.ageSeconds)}</Table.Td>
              <Table.Td>
                <MonitorStatusBadge status={s.status} size="xs" />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea.Autosize>
  );
}

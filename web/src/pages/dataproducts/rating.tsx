import { Badge, Button, Group, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconShieldHalf } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CIA_DIMENSIONS, type DataRating } from '@sm/shared';
import { RatingBadges, useLevel } from '../../components/catalogue/cia';
import { TableScroll } from '../../components/TableScroll';
import { fmtDate } from '../../format';
import { Section } from './parts';

export { RatingBadges };

/** A CIA rating per dimension with its justification, who rated and when (as on applications), and _Rate_. */
export function RatingPanelReadOnly({ rating, onRate }: { rating: DataRating; onRate?: () => void }) {
  const { t } = useTranslation(['dataProducts', 'applications']);
  const level = useLevel();
  return (
    <Section
      title={t('rating.title')}
      testId="rating-panel"
      actions={
        onRate && (
          <Button size="xs" variant="default" leftSection={<IconShieldHalf size={14} />} onClick={onRate}>
            {t('rating.rate')}
          </Button>
        )
      }
    >
      <TableScroll>
        <Table fz="sm" aria-label={t('rating.title')}>
          <Table.Tbody>
            {CIA_DIMENSIONS.map((d) => {
              const r = rating[d];
              return (
                <Table.Tr key={d}>
                  <Table.Th scope="row" w="35%">
                    {t(`applications:cia.dimensions.${d}`)}
                  </Table.Th>
                  <Table.Td>
                    {r ? (
                      <Stack gap={2}>
                        <Group gap={6}>
                          <Badge color={r.needsRerating ? 'yellow' : (level(d, r.level)?.color ?? 'gray')} variant="light" tt="none">
                            {level(d, r.level)?.label ?? r.level}
                          </Badge>
                          {r.needsRerating && (
                            <Badge color="yellow" variant="outline" tt="none" leftSection={<IconAlertTriangle size={11} aria-hidden />}>
                              {t('applications:cia.needsRerating')}
                            </Badge>
                          )}
                        </Group>
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {r.justification}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {t('applications:cia.ratedBy', { user: r.ratedBy, date: fmtDate(r.ratedAt) })}
                        </Text>
                      </Stack>
                    ) : (
                      <Text size="sm" c="dimmed">
                        {t('applications:cia.notRated')}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </TableScroll>
    </Section>
  );
}

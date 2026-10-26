import { Anchor, Box, Group, List, Paper, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SCORECARD_PARTS, type ScorecardPart, type ServiceScorecardDetail, type ServiceScorecardHistoryPoint } from '@sm/shared';
import { get } from '../../api';
import { QueryState } from '../common';
import { useLevel } from '../catalogue/cia';
import { AttentionBadge, PART_COLORS, PartBadge } from './common';

/** The scorecard of one service (service page): four parts side by side, each with its own status, and the stored days. */
export function ScorecardPanel({ serviceId }: { serviceId: string }) {
  const { t } = useTranslation('scorecard');
  const q = useQuery({
    queryKey: ['scorecard', 'service', serviceId],
    queryFn: () => get<ServiceScorecardDetail>(`/scorecard/services/${encodeURIComponent(serviceId)}`),
  });
  const c = q.data;
  return (
    <Stack gap="xs" data-testid="scorecard-panel">
      <Group justify="space-between">
        <Text fw={600}>{t('panelTitle')}</Text>
        {c && <AttentionBadge attention={c.attention} />}
      </Group>
      <QueryState query={q} rows={2} />
      {c && (
        <>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
            {SCORECARD_PARTS.map((p) => (
              <Paper key={p} withBorder p="sm" data-testid={`part-${p}`}>
                <Group justify="space-between" mb={4} wrap="nowrap">
                  <Text size="sm" fw={600}>
                    {t(`parts.${p}`)}
                  </Text>
                  <PartBadge status={c[p].status} size="xs" />
                </Group>
                <PartDetails card={c} part={p} />
              </Paper>
            ))}
          </SimpleGrid>
          <History points={c.history} />
        </>
      )}
    </Stack>
  );
}

const counts = (c: { total: number; met: number; open: number; notMet: number }) => ({ total: c.total, met: c.met, open: c.open, notMet: c.notMet });

function PartDetails({ card: c, part }: { card: ServiceScorecardDetail; part: ScorecardPart }) {
  const { t } = useTranslation(['scorecard', 'applications', 'duties']);
  const level = useLevel();
  if (part === 'duties') {
    const d = c.duties;
    if (!d.mandatory.total && !d.recommended.total && !d.optional.total)
      return (
        <Text size="xs" c="dimmed">
          {t('duties.none')}
        </Text>
      );
    const notMet = d.items.filter((i) => i.result === 'notMet');
    return (
      <Stack gap={2}>
        <Text size="xs">{t('duties.mandatory', counts(d.mandatory))}</Text>
        <Text size="xs">{t('duties.recommended', counts(d.recommended))}</Text>
        <Text size="xs" c="dimmed">
          {t('duties.optional', { count: d.optional.total })}
        </Text>
        {notMet.length > 0 && (
          <List size="xs" spacing={0}>
            {notMet.map((i) => (
              <List.Item key={i.dutyId}>
                <Anchor component={Link} to={`/duties/${i.dutyId}`} size="xs">
                  {i.name}
                </Anchor>{' '}
                {t('duties.notMetItem', { level: t(`duties:levels.${i.level}`), period: i.lastClosed?.key ?? i.current?.key ?? '' })}
              </List.Item>
            ))}
          </List>
        )}
      </Stack>
    );
  }
  if (part === 'availability') {
    const a = c.availability;
    if (!a.total)
      return (
        <Text size="xs" c="dimmed">
          {t('availability.none')}
        </Text>
      );
    return (
      <Stack gap={2}>
        <Text size="xs">{t('availability.summary', { total: a.total, met: a.met, below: a.below, noData: a.noData })}</Text>
        {a.objectives
          .filter((o) => o.status !== 'met')
          .map((o) => (
            <Text size="xs" key={o.id}>
              {o.name}: {t(`objectiveStatuses.${o.status}`)}
            </Text>
          ))}
      </Stack>
    );
  }
  if (part === 'documentation') {
    const d = c.documentation;
    const missing = d.expected.filter((e) => !e.satisfiedBy.length);
    return (
      <Stack gap={2}>
        {d.documents > 0 && (
          <Text size="xs">{t('documentation.summary', { released: d.released, documents: d.documents, overdue: d.overdue, dueSoon: d.dueSoon })}</Text>
        )}
        {!d.released && <Text size="xs">{t('documentation.noneReleased')}</Text>}
        {missing.length > 0 && (
          <List size="xs" spacing={0} data-testid="expected-missing">
            {missing.map((e) => (
              <List.Item key={`${e.ruleId}-${e.applicationId}`}>
                {t('documentation.expectedMissing', {
                  type: e.typeName,
                  key: e.typeKey,
                  application: e.applicationName,
                  dimension: t(`applications:cia.dimensions.${e.dimension}`),
                  level: level(e.dimension, e.level)?.label ?? e.level,
                })}
              </List.Item>
            ))}
          </List>
        )}
        {d.expected.length > missing.length && (
          <Text size="xs" c="dimmed">
            {t('documentation.expectedPresent', { count: d.expected.length - missing.length })}
          </Text>
        )}
      </Stack>
    );
  }
  const p = c.protection;
  if (!p.applications && p.dimensions.every((x) => !x.override))
    return (
      <Text size="xs" c="dimmed">
        {t('protection.noApplications')}
      </Text>
    );
  return (
    <Stack gap={2}>
      {p.scaleInvalid && <Text size="xs">{t('protection.scaleInvalid')}</Text>}
      {p.dimensions.map((x) => (
        <Text size="xs" key={x.dimension}>
          {t(`applications:cia.dimensions.${x.dimension}`)}: {level(x.dimension, x.effective)?.label ?? t('applications:cia.notRated')}
          {!x.ok && !x.override && x.total > 0 ? ` – ${t('protection.rated', { rated: x.rated, total: x.total })}` : ''}
          {x.needsRerating ? ` – ${t('protection.rerate', { count: x.needsRerating })}` : ''}
        </Text>
      ))}
    </Stack>
  );
}

/** The stored days (oldest first) as a strip of small squares, with a summary for screen readers. */
function History({ points }: { points: ServiceScorecardHistoryPoint[] }) {
  const { t } = useTranslation('scorecard');
  if (!points.length)
    return (
      <Text size="xs" c="dimmed">
        {t('history.none')}
      </Text>
    );
  const bad = points.filter((p) => p.attention).length;
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" id="scorecard-history">
        {t('history.summary', { count: points.length, attention: bad })}
      </Text>
      <Group gap={2} wrap="wrap" role="img" aria-labelledby="scorecard-history" data-testid="scorecard-history">
        {points.map((p) => (
          <Tooltip key={p.day} label={`${p.day}: ${p.attention ? t('attention') : t('allGood')}`}>
            <Box w={8} h={16} bg={`var(--mantine-color-${p.attention ? PART_COLORS.attention : PART_COLORS.ok}-filled)`} style={{ borderRadius: 2 }} />
          </Tooltip>
        ))}
      </Group>
    </Stack>
  );
}

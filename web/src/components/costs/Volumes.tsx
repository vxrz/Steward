import { Badge, Group, Paper, Progress, Stack, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { CostPlanYear, CostVolumeStatus, CostVolumeWarning } from '@sm/shared';
import { fmtDay } from '../../format';
import { fmtMoney } from './common';

/**
 * Volumes of contracts (0.19.0, ADR 0032 part 3, docs/COSTS.md#volumes): a volume per contract year or for the term,
 * prepaid or billed by use – what is used, what is left, the share, a linear estimate of the use at the period's end
 * (labelled as an estimate) and the warnings. A reader who may not see every service or platform that books to the
 * volume gets the warnings only.
 */

const WARNING_COLOR: Record<CostVolumeWarning, string> = {
  runsOut: 'orange',
  usedUp: 'red',
  shortfall: 'yellow',
  ceiling: 'orange',
  overCeiling: 'red',
};

/** One warning of a volume, as a badge with its text (the day it runs out when estimated). */
export function VolumeWarningBadge({ w, runsOutOn }: { w: CostVolumeWarning; runsOutOn: string | null }) {
  const { t } = useTranslation('costs');
  return (
    <Badge
      size="xs"
      variant="light"
      color={WARNING_COLOR[w]}
      leftSection={<IconAlertTriangle size={10} aria-hidden />}
      style={{ whiteSpace: 'normal', height: 'auto' }}
      data-testid={`volume-warning-${w}`}
    >
      {w === 'runsOut' && runsOutOn ? t('volumes.warnings.runsOutOn', { date: fmtDay(runsOutOn) }) : t(`volumes.warnings.${w}`)}
    </Badge>
  );
}

/** Used, left and the estimate of a volume's current period (state only: the warnings). */
export function VolumeUse({ v, upTo }: { v: CostVolumeStatus; upTo: string | null }) {
  const { t } = useTranslation('costs');
  const pct = v.sharePct ?? 0;
  return (
    <Stack gap={2} miw={200} data-testid="volume-use">
      <Text size="xs" c="dimmed">
        {t(`volumes.per.${v.per}`, { from: fmtDay(v.period.from), to: fmtDay(v.period.to) })}
      </Text>
      {v.used !== null ? (
        <>
          <Progress
            value={Math.min(100, pct)}
            color={v.warnings.some((w) => w === 'usedUp' || w === 'overCeiling') ? 'red' : v.warnings.length ? 'orange' : 'blue'}
            size="sm"
            aria-label={t('volumes.shareLabel', { pct })}
          />
          <Text size="xs" className="viz-num">
            {t('volumes.usedOf', { used: fmtMoney(v.used, v.currency), amount: fmtMoney(v.amount, v.currency), pct })}
          </Text>
          <Text size="xs" className="viz-num">
            {t('volumes.left', { left: fmtMoney(v.left, v.currency) })}
            {v.committed === 'minimum' && v.minimum !== null ? ` · ${t('volumes.minimum', { amount: fmtMoney(v.minimum, v.currency) })}` : ''}
          </Text>
          <Text size="xs" c="dimmed" data-testid="volume-estimate">
            {v.expectedAtEnd !== null
              ? t('volumes.estimate', { amount: fmtMoney(v.expectedAtEnd, v.currency), date: fmtDay(v.period.to) })
              : t('volumes.tooEarly')}
          </Text>
        </>
      ) : (
        <Text size="xs" c="dimmed" data-testid="volume-state-only">
          {v.stateOnly ? t('volumes.stateOnly') : t('volumes.amountsHidden')}
        </Text>
      )}
      {upTo !== null && Number(upTo) !== 0 && (
        <Text size="xs" c="dimmed" className="viz-num" data-testid="volume-up-to">
          {t('volumes.upTo', { amount: fmtMoney(upTo, v.currency) })}
        </Text>
      )}
      {v.warnings.length > 0 && (
        <Group gap={4} wrap="wrap">
          {v.warnings.map((w) => (
            <VolumeWarningBadge key={w} w={w} runsOutOn={v.runsOutOn} />
          ))}
        </Group>
      )}
    </Stack>
  );
}

/** A cost plan's section "Volumes": the volume schedules the service or platform pays, each with its current period. */
export function VolumesSection({ d }: { d: CostPlanYear }) {
  const { t } = useTranslation('costs');
  if (!d.volumes.length) return null;
  return (
    <Stack gap="sm" data-testid="plan-volumes">
      <Title order={3} size="h5">
        {t('volumes.title')}
      </Title>
      <Text size="xs" c="dimmed" maw={720}>
        {t('volumes.help')}
      </Text>
      <Group gap="sm" align="stretch" wrap="wrap">
        {d.volumes.map((v) => (
          <Paper key={v.scheduleId} withBorder p="sm" miw={260} style={{ flex: '1 1 260px' }} data-testid="plan-volume">
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                {v.title}
              </Text>
              {v.contractHidden && (
                <Text size="xs" c="dimmed">
                  {t('commitments.hiddenContract')}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {t(`volumes.billing.${v.billing}`)} · {t(`volumes.committed.${v.committed}`)} · {t(`volumes.consumption.${v.consumption}`)}
              </Text>
              <VolumeUse v={v} upTo={null} />
            </Stack>
          </Paper>
        ))}
      </Group>
      <Text size="xs" c="dimmed">
        {t('volumes.estimateNote')}
      </Text>
    </Stack>
  );
}

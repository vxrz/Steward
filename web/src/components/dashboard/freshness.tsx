import { Badge, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconClock, IconFlask } from '@tabler/icons-react';
import type { DatasetSource } from '@sm/shared';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { fmtRelative } from '../../format';
import { dateTime } from './format';

type T = TFunction<['dashboards', 'common', 'editor']>;

const HOUR = 60;
const DAY = 24 * HOUR;

/** "3 days 4 h", "2 h 30 min", "45 min" (two units at most). */
export function durationText(t: T, minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const days = Math.floor(m / DAY);
  const hours = Math.floor((m % DAY) / HOUR);
  const mins = m % HOUR;
  const parts = [
    days ? t('fresh.days', { count: days }) : '',
    hours ? t('fresh.hours', { count: hours }) : '',
    mins && !days ? t('fresh.minutes', { count: mins }) : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : t('fresh.minutes', { count: 0 });
}

/** A schedule's interval in words: "hourly", "every 15 minutes", "daily", "weekly", "monthly", "quarterly", "every 3 days 4 h". */
export function intervalText(t: T, interval: number): string {
  // a gap across a daylight saving change is an hour longer or shorter: still "daily"
  const days = Math.round(interval / DAY);
  const minutes = days >= 1 && Math.abs(interval - days * DAY) <= HOUR ? days * DAY : interval;
  if (minutes === HOUR) return t('fresh.hourly');
  if (minutes === DAY) return t('fresh.daily');
  if (minutes === 7 * DAY) return t('fresh.weekly');
  // calendar months and quarters differ in length: the gap between the next two runs is 28–31 days (35 for "the first
  // Monday") or 89–92 days
  if (minutes >= 28 * DAY && minutes <= 35 * DAY && minutes % DAY === 0) return t('fresh.monthly');
  if (minutes >= 89 * DAY && minutes <= 92 * DAY && minutes % DAY === 0) return t('fresh.quarterly');
  if (minutes >= 365 * DAY && minutes <= 366 * DAY && minutes % DAY === 0) return t('fresh.yearly');
  if (minutes < HOUR) return t('fresh.everyMinutes', { count: minutes });
  if (minutes < DAY && minutes % HOUR === 0) return t('fresh.everyHours', { count: minutes / HOUR });
  if (minutes % DAY === 0) return t('fresh.everyDays', { count: minutes / DAY });
  return t('fresh.every', { duration: durationText(t, minutes) });
}

/** Why a source is stale after its limit: its schedule (or a parent's), the publish step, or the default. */
export function staleRuleText(t: T, s: DatasetSource): string {
  const duration = durationText(t, s.staleAfterMinutes);
  const reason =
    s.staleReason === 'schedule'
      ? s.viaProcess
        ? t('fresh.reason.via', { process: s.viaProcess.name })
        : s.scheduleName
          ? t('fresh.reason.schedule', { name: s.scheduleName })
          : t('fresh.reason.scheduleUnnamed')
      : s.staleReason === 'fixed'
        ? s.scheduleId
          ? t('fresh.reason.fixedScheduled')
          : t('fresh.reason.fixed')
        : t('fresh.reason.default');
  return t('fresh.staleAfter', { duration, reason });
}

export type FreshState = 'fresh' | 'due' | 'stale';

/** Fresh; due (a scheduled run is overdue, not stale yet); stale (past the limit). */
export function freshState(s: DatasetSource, now = Date.now()): FreshState {
  if (s.stale) return 'stale';
  const age = now - Date.parse(s.updatedAt);
  // a quarter of the interval (at least 2 minutes) for the run itself
  if (s.expectedMinutes && age > s.expectedMinutes * 60000 + Math.max(2 * 60000, s.expectedMinutes * 15000)) return 'due';
  return 'fresh';
}

export const staleSince = (s: DatasetSource): string => new Date(Date.parse(s.updatedAt) + s.staleAfterMinutes * 60000).toISOString();

/** The status of a source as a chip: Fresh, Due, Stale since … */
export function FreshChip({ source }: { source: DatasetSource }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  const state = freshState(source);
  if (state === 'stale')
    return (
      <Tooltip label={fmtRelative(staleSince(source))}>
        <Badge size="sm" color="yellow" variant="light" leftSection={<IconAlertTriangle size={12} />} data-state="stale">
          {t('fresh.staleSince', { when: dateTime(staleSince(source)) })}
        </Badge>
      </Tooltip>
    );
  if (state === 'due')
    return (
      <Tooltip label={t('fresh.dueHint')} multiline maw={280}>
        <Badge size="sm" color="blue" variant="light" leftSection={<IconClock size={12} />} data-state="due">
          {t('fresh.due')}
        </Badge>
      </Tooltip>
    );
  return (
    <Badge size="sm" color="green" variant="light" leftSection={<IconCircleCheck size={12} />} data-state="fresh">
      {t('fresh.fresh')}
    </Badge>
  );
}

/**
 * One source of a dataset (#142): its status, when it was updated, how often it is expected and when it counts as
 * stale (and why), and the next run of its own schedule. Lines wrap: nothing is cut off in a narrow widget.
 */
export function SourceFreshness({ source: s, showName }: { source: DatasetSource; showName: boolean }) {
  const { t } = useTranslation(['dashboards', 'common', 'editor']);
  return (
    <Stack gap={2} data-testid="source-freshness" data-source={s.id}>
      <Group gap={6} wrap="wrap" align="center">
        <FreshChip source={s} />
        {showName && (
          <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
            {s.name}
          </Text>
        )}
        <Tooltip label={dateTime(s.updatedAt)}>
          <Text size="sm">{t('list.updated', { when: fmtRelative(s.updatedAt) })}</Text>
        </Tooltip>
        {s.dryRun && (
          <Badge size="xs" color="gray" variant="light" leftSection={<IconFlask size={10} />}>
            {t('common:status.dryrun')}
          </Badge>
        )}
      </Group>
      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
        {[s.expectedMinutes ? intervalText(t, s.expectedMinutes) : null, staleRuleText(t, s)].filter(Boolean).join(' · ')}
      </Text>
      <Text size="xs" c={s.nextRunAt ? undefined : 'dimmed'} data-testid="source-next-run">
        {s.nextRunAt ? (
          <Tooltip label={dateTime(s.nextRunAt)}>
            <span>{t('fresh.next', { when: fmtRelative(s.nextRunAt) })}</span>
          </Tooltip>
        ) : (
          t('w.notScheduled')
        )}
      </Text>
    </Stack>
  );
}

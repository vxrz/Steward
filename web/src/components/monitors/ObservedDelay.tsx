import { Alert, Button, Paper, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import {
  SUGGESTION_MIN_COVERAGE_SECONDS,
  SUGGESTION_MIN_SAMPLES,
  suggestFreshness,
  type CheckDef,
  type CheckOf,
  type FreshnessSettings,
  type ObservedDelay,
} from '@sm/shared';
import { fmtNumber } from '../../format';

/** The observed delay of a freshness check (0.13, docs/MONITORS.md "How fresh is fresh"): figures and suggestion. */

/** 45 s · 90 s · 1 min · 6 min · 2 h 10 min (unit symbols are the same in all supported languages). */
export function fmtSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60 || (s < 120 && s % 60)) return `${fmtNumber(s)} s`;
  if (s < 7200) return `${fmtNumber(Math.round(s / 60))} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${fmtNumber(h)} h ${m} min` : `${fmtNumber(h)} h`;
}

/** What Steward measured: peak age before new data, delay, samples and what was left out. */
export function ObservedDelaySummary({ observed }: { observed: ObservedDelay }) {
  const { t } = useTranslation('monitors');
  const w = observed.worst;
  const x = observed.excluded;
  const left = [
    x.failedReads && t('observed.failedReads', { count: x.failedReads }),
    x.wentBackwards && t('observed.wentBackwards', { count: x.wentBackwards }),
    x.futureTimestamps && t('observed.futureTimestamps', { count: x.futureTimestamps }),
    x.maintenance && t('observed.maintenance', { count: x.maintenance }),
  ].filter(Boolean);
  return (
    <Stack gap={4} data-testid="observed-delay">
      <Text size="sm" fw={600}>
        {t('observed.title', { days: observed.windowDays })}
      </Text>
      {w?.peakAge ? (
        <Text size="xs" data-testid="observed-delay-figures">
          {t('observed.figures', {
            median: fmtSeconds(w.peakAge.median),
            p95: fmtSeconds(w.peakAge.p95),
            max: fmtSeconds(w.peakAge.max),
            delay: w.delay ? `${fmtSeconds(w.delay.low)}–${fmtSeconds(w.delay.high)}` : '–',
            count: w.samples,
            every: fmtSeconds(observed.intervalSeconds),
          })}
        </Text>
      ) : (
        <Text size="xs" c="dimmed">
          {t('observed.none', { every: fmtSeconds(observed.intervalSeconds) })}
        </Text>
      )}
      {w && observed.variables.length > 1 && (
        <Text size="xs" c="dimmed">
          {t('observed.worstVariable', { name: w.name })}
        </Text>
      )}
      {left.length > 0 && (
        <Text size="xs" c="orange" data-testid="observed-delay-excluded">
          {t('observed.excluded', { list: left.join(', ') })}
        </Text>
      )}
      {w?.peakAge && !observed.enough && (
        <Text size="xs" c="dimmed">
          {t('observed.notEnough', {
            hours: SUGGESTION_MIN_COVERAGE_SECONDS / 3600,
            samples: SUGGESTION_MIN_SAMPLES,
            coverage: fmtSeconds(w.coverageSeconds),
            count: w.samples,
          })}
        </Text>
      )}
      <Text size="xs" c="dimmed">
        {t('observed.note')}
      </Text>
    </Stack>
  );
}

/** The freshness settings of a check as the suggestion reads them. */
function settingsOf(c: CheckOf<'freshness'> | CheckOf<'heartbeat'> | CheckOf<'dynamodb'>): FreshnessSettings {
  return {
    mode: c.type === 'dynamodb' ? c.freshnessMode : c.mode,
    expectedIntervalSeconds: c.expectedIntervalSeconds,
    maxAgeSeconds: c.maxAgeSeconds,
    degradedAgeSeconds: c.degradedAgeSeconds,
    allowedDelaySeconds: c.allowedDelaySeconds,
  };
}

/** The editor: the figures, and the suggestion for the values in the form (old → new) with a button to apply it. */
export function ObservedDelayEditor({
  observed,
  c,
  set,
  disabled,
}: {
  observed: ObservedDelay;
  c: CheckOf<'freshness'> | CheckOf<'heartbeat'> | CheckOf<'dynamodb'>;
  set: (p: Partial<CheckDef>) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('monitors');
  const s = suggestFreshness(observed, settingsOf(c));
  const value = (v: number | null) => (v === null ? t('observed.notSet') : fmtSeconds(v));
  return (
    <Paper withBorder p="xs">
      <Stack gap={6}>
        <ObservedDelaySummary observed={observed} />
        {s &&
          (s.changes.length ? (
            <Alert color="blue" p="xs" data-testid="observed-delay-suggestion">
              <Text size="xs" mb={4}>
                {t('observed.suggestion', { p95: fmtSeconds(s.basedOnSeconds), margin: fmtSeconds(s.marginSeconds) })}
              </Text>
              {s.changes.map((ch) => (
                <Text key={ch.field} size="xs" data-testid={`suggestion-${ch.field}`}>
                  {t(`observed.field.${ch.field}`)}: {value(ch.from)} → <b>{value(ch.to)}</b>
                </Text>
              ))}
              <Button
                size="compact-xs"
                mt={6}
                disabled={disabled}
                data-testid="apply-suggestion"
                onClick={() => set(Object.fromEntries(s.changes.map((ch) => [ch.field, ch.to ?? undefined])) as Partial<CheckDef>)}
              >
                {t('observed.apply')}
              </Button>
            </Alert>
          ) : (
            <Text size="xs" c="teal" data-testid="observed-delay-covered">
              {t('observed.covered')}
            </Text>
          ))}
      </Stack>
    </Paper>
  );
}

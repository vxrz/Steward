import { useState } from 'react';
import { Anchor, Badge, Group, Spoiler, Stack, Switch, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { FailedCheckGroup } from '@sm/shared';
import { SeverityBadge } from '../common';
import { fmtRelative } from '../../format';
import { useMe } from '../../auth';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { ShowAll, useShowMore } from '../page/ShowAll';

/** How many entries the card shows before "Show all". */
const FIRST = 10;

/**
 * Failed checks of the last 7 days on the start page (#138): one entry per process and check with its latest
 * message, how often it failed and since when. The header toggles the list and keeps the counts visible; the
 * choice is remembered per user, and a folded card opens again when another check starts failing. Checks that
 * passed again are hidden unless asked for.
 */
export function FailedChecksCard({ checks }: { checks: FailedCheckGroup[] }) {
  const { t } = useTranslation('dashboard');
  const { username } = useMe();
  const [showResolved, setShowResolved] = useState(false);
  const failing = checks.filter((c) => !c.resolved);
  const shown = showResolved ? checks : failing;
  const list = useShowMore(shown, FIRST);
  if (!checks.length) return null;

  const resolved = checks.length - failing.length;
  const errors = failing.filter((c) => c.severity === 'error').length;
  const warnings = failing.filter((c) => c.severity === 'warning').length;
  const counts = [
    t('checks.count', { count: failing.length }),
    ...(errors ? [t('checks.errors', { count: errors })] : []),
    ...(warnings ? [t('checks.warnings', { count: warnings })] : []),
    ...(resolved ? [t('checks.resolvedCount', { count: resolved })] : []),
  ].join(' · ');

  return (
    <CollapsibleSection
      id="failed-checks"
      testId="failed-checks"
      variant="card"
      size="h5"
      title={t('failedChecks')}
      icon={<IconAlertTriangle size={18} color="var(--mantine-color-orange-6)" aria-hidden style={{ flex: 'none' }} />}
      summary={
        <Text size="sm" c="dimmed" data-testid="failed-checks-counts">
          {counts}
        </Text>
      }
      remember="section.dashboard.failed-checks"
      rememberLegacyKey={`sm.failedChecks.open.${username}`}
      alertKey={failing
        .map((c) => `${c.processId}/${c.checkId}`)
        .sort()
        .join(',')}
    >
      <Stack gap={8}>
        {resolved > 0 && (
          <Switch
            size="xs"
            label={t('checks.showResolved', { count: resolved })}
            checked={showResolved}
            onChange={(e) => setShowResolved(e.currentTarget.checked)}
          />
        )}
        {!list.items.length && (
          <Text size="sm" c="dimmed">
            {t('checks.allResolved')}
          </Text>
        )}
        {list.items.map((c) => (
          <Group key={`${c.processId}/${c.checkId}`} justify="space-between" gap={4} wrap="wrap" align="flex-start" data-testid="failed-check">
            <div style={{ minWidth: 0, flex: 1 }}>
              {/* what was found first (the check's result), the expectation (its name) under it */}
              <Group gap={6} wrap="nowrap" align="flex-start">
                <SeverityBadge severity={c.severity} />
                <Spoiler
                  maxHeight={44}
                  showLabel={t('checks.showMore')}
                  hideLabel={t('checks.showLess')}
                  styles={{ control: { fontSize: 'var(--mantine-font-size-xs)' } }}
                  style={{ minWidth: 0 }}
                >
                  <Anchor component={Link} to={`/runs/${c.runId}`} size="sm" style={{ overflowWrap: 'anywhere' }} data-testid="failed-check-result">
                    {c.message || t('checks.failedName', { name: c.name })}
                  </Anchor>
                  {c.resolved && (
                    <Badge size="xs" variant="light" color="green" ml={6}>
                      {t('checks.resolved')}
                    </Badge>
                  )}
                </Spoiler>
              </Group>
              {c.message && (
                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }} data-testid="failed-check-expected">
                  {t('checks.expected', { name: c.name })}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {c.resolved ? t('checks.failedTimes', { count: c.count }) : t('checks.failingSince', { since: fmtRelative(c.since), count: c.streak })}
                {' · '}
                <Anchor inherit component={Link} to={`/runs?processId=${encodeURIComponent(c.processId)}&checks=failed`}>
                  {t('checks.failedRuns')}
                </Anchor>
              </Text>
            </div>
            <Text size="xs" c="dimmed" className="nowrap">
              {c.processName} · {fmtRelative(c.ts)}
            </Text>
          </Group>
        ))}
        <ShowAll state={list} id="failed-checks" />
      </Stack>
    </CollapsibleSection>
  );
}

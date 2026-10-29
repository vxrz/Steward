import { useState } from 'react';
import { Anchor, Badge, Button, Card, Group, Spoiler, Stack, Switch, Text, Title, UnstyledButton } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { FailedCheckGroup } from '@sm/shared';
import { SeverityBadge } from '../common';
import { fmtRelative } from '../../format';
import { useMe } from '../../auth';

/** How many entries the card shows before "Show all". */
const FIRST = 10;

const openKey = (user: string) => `sm.failedChecks.open.${user}`;
function readOpen(user: string): boolean {
  try {
    return localStorage.getItem(openKey(user)) !== '0';
  } catch {
    return true;
  }
}

/**
 * Failed checks of the last 7 days on the start page (#138): one entry per process and check with its latest
 * message, how often it failed and since when. The header toggles the list and keeps the counts visible; the
 * choice is remembered per user in this browser. Checks that passed again are hidden unless asked for.
 */
export function FailedChecksCard({ checks }: { checks: FailedCheckGroup[] }) {
  const { t } = useTranslation('dashboard');
  const { username } = useMe();
  const [open, setOpen] = useState(() => readOpen(username));
  const [showResolved, setShowResolved] = useState(false);
  const [all, setAll] = useState(false);
  if (!checks.length) return null;

  const failing = checks.filter((c) => !c.resolved);
  const resolved = checks.length - failing.length;
  const shown = showResolved ? checks : failing;
  const visible = all ? shown : shown.slice(0, FIRST);
  const errors = failing.filter((c) => c.severity === 'error').length;
  const warnings = failing.filter((c) => c.severity === 'warning').length;
  const counts = [
    t('checks.count', { count: failing.length }),
    ...(errors ? [t('checks.errors', { count: errors })] : []),
    ...(warnings ? [t('checks.warnings', { count: warnings })] : []),
    ...(resolved ? [t('checks.resolvedCount', { count: resolved })] : []),
  ].join(' · ');
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(openKey(username), o ? '0' : '1');
      } catch {
        /* storage blocked: only for this page view */
      }
      return !o;
    });
  };

  return (
    <Card withBorder data-testid="failed-checks">
      <UnstyledButton
        onClick={toggle}
        aria-expanded={open}
        aria-controls={open ? 'failed-checks-list' : undefined}
        style={{ width: '100%' }}
        data-testid="failed-checks-toggle"
      >
        <Group gap="xs" wrap="nowrap">
          {open ? <IconChevronDown size={16} aria-hidden /> : <IconChevronRight size={16} aria-hidden />}
          <IconAlertTriangle size={18} color="var(--mantine-color-orange-6)" aria-hidden />
          <Title order={5}>{t('failedChecks')}</Title>
          <Text size="sm" c="dimmed" data-testid="failed-checks-counts">
            · {counts}
          </Text>
        </Group>
      </UnstyledButton>
      {open && (
        <Stack gap={8} mt="xs" id="failed-checks-list">
          {resolved > 0 && (
            <Switch
              size="xs"
              label={t('checks.showResolved', { count: resolved })}
              checked={showResolved}
              onChange={(e) => setShowResolved(e.currentTarget.checked)}
            />
          )}
          {!visible.length && (
            <Text size="sm" c="dimmed">
              {t('checks.allResolved')}
            </Text>
          )}
          {visible.map((c) => (
            <Group key={`${c.processId}/${c.checkId}`} justify="space-between" gap={4} wrap="wrap" align="flex-start" data-testid="failed-check">
              <div style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6}>
                  <SeverityBadge severity={c.severity} />
                  <Anchor component={Link} to={`/runs/${c.runId}`} size="sm">
                    {c.name}
                  </Anchor>
                  {c.resolved && (
                    <Badge size="xs" variant="light" color="green">
                      {t('checks.resolved')}
                    </Badge>
                  )}
                </Group>
                {c.message && (
                  <Spoiler
                    maxHeight={36}
                    showLabel={t('checks.showMore')}
                    hideLabel={t('checks.showLess')}
                    styles={{ control: { fontSize: 'var(--mantine-font-size-xs)' } }}
                  >
                    <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                      {c.message}
                    </Text>
                  </Spoiler>
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
          {shown.length > FIRST && (
            <Button size="compact-xs" variant="subtle" w="fit-content" onClick={() => setAll((a) => !a)}>
              {all ? t('checks.showFewer') : t('checks.showAll', { count: shown.length })}
            </Button>
          )}
        </Stack>
      )}
    </Card>
  );
}

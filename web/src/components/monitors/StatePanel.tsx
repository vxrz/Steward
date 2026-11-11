import { Alert, Anchor, Badge, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { IconCheck, IconClockHour4, IconPower, IconQuestionMark, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { CellVerdict, MonitorDetail, MonitorStateInfo, StateCellView, UptimeSet } from '@sm/shared';
import i18n from '../../i18n';
import { dateTimeFormat, fmtDate, fmtNumber } from '../../format';
import { monitorStatusLabel } from './status';

/**
 * Monitor states (0.13, ADR 0021) on the monitor page: the grey Off banner that replaces the red root cause while every
 * check agrees, and the "Why this state" panel – which cells selected the state, which are required, what is expected
 * of the others and whether each agrees. Agreement and contradiction are words and signs, never colour alone.
 */

/** "3 h 10 min", "45 min" from seconds. */
export function fmtSpan(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '–';
  const min = Math.round(seconds / 60);
  if (min < 60) return `${fmtNumber(min)} min`;
  const h = Math.floor(min / 60);
  return `${fmtNumber(h)} h${min % 60 ? ` ${fmtNumber(min % 60)} min` : ''}`;
}

/** "Up 97 % · Off 31 h": the off hours next to the uptime (they do not count in it). */
export function offText(off: UptimeSet | null): string {
  if (!off || !(off.d30 || off.d7 || off.h24)) return '';
  const h = (v: number | null) => `${fmtNumber(v ?? 0, { maximumFractionDigits: 1 })} h`;
  return i18n.t('monitors:states.offTime' as 'common:add', { h24: h(off.h24), d7: h(off.d7), d30: h(off.d30) }) as string;
}

/** Amber: a check that deviates while the settle time runs – not counted yet, so not red. */
export const SETTLING_COLOR = 'orange';

/** The checks whose expectation deviates while the settle time runs (they do not count until it ends). */
export function settlingCheckIds(s: Pick<MonitorStateInfo, 'settlingUntil' | 'cells'> | null | undefined): string[] {
  if (!s?.settlingUntil) return [];
  return [...new Set(s.cells.filter((c) => c.verdict === 'settling').map((c) => c.checkId))];
}

/** "14:00" today, the date and time otherwise. */
function fmtUntil(iso: string): string {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? dateTimeFormat({ timeStyle: 'short' }).format(d) : fmtDate(iso);
}

/**
 * Next to the monitor's status while its state settles: "settling until 14:00 – 1 check not as expected yet". The status
 * stays as computed; this says why red cards do not count yet.
 */
export function SettlingNote({ state, size = 'lg' }: { state: MonitorStateInfo | null | undefined; size?: 'sm' | 'lg' }) {
  const { t } = useTranslation('monitors');
  if (!state?.settlingUntil) return null;
  const n = settlingCheckIds(state).length;
  return (
    <Badge
      size={size}
      variant="outline"
      color={SETTLING_COLOR}
      leftSection={<IconClockHour4 size={size === 'lg' ? 14 : 11} aria-hidden />}
      data-testid="monitor-settling"
      style={{ textTransform: 'none' }}
    >
      {t('states.settlingUntil', { date: fmtUntil(state.settlingUntil) })}
      {n ? ` – ${t('states.notAsExpectedYet', { count: n })}` : ''}
    </Badge>
  );
}

/** On a check (card, row) that deviates while the settle time runs. */
export function CheckSettlingBadge({ until }: { until?: string | null }) {
  const { t } = useTranslation('monitors');
  return (
    <Badge
      size="xs"
      variant="light"
      color={SETTLING_COLOR}
      leftSection={<IconClockHour4 size={10} aria-hidden />}
      title={until ? t('states.settlingUntil', { date: fmtUntil(until) }) : undefined}
      data-testid="check-settling"
      style={{ flexShrink: 0 }}
    >
      {t('states.verdict.settling')}
    </Badge>
  );
}

const VERDICT_ICON: Record<CellVerdict, typeof IconCheck> = { agrees: IconCheck, contradicts: IconX, settling: IconClockHour4, unknown: IconQuestionMark };
const VERDICT_COLOR: Record<CellVerdict, string> = { agrees: 'gray', contradicts: 'red', settling: SETTLING_COLOR, unknown: 'gray' };

export function VerdictBadge({ verdict }: { verdict: CellVerdict }) {
  const { t } = useTranslation('monitors');
  const Icon = VERDICT_ICON[verdict];
  return (
    <Badge
      size="sm"
      variant={verdict === 'contradicts' ? 'filled' : 'light'}
      color={VERDICT_COLOR[verdict]}
      leftSection={<Icon size={12} aria-hidden />}
      data-verdict={verdict}
      style={{ minWidth: 'max-content' }}
    >
      {t(`states.verdict.${verdict}`)}
    </Badge>
  );
}

/** The grey banner of a monitor that is off as its state expects (instead of the red root cause). */
export function OffBanner({ monitor }: { monitor: MonitorDetail }) {
  const { t } = useTranslation('monitors');
  const s = monitor.state;
  if (!s || monitor.status !== 'off') return null;
  return (
    <Alert
      color="gray"
      variant="light"
      icon={<IconPower size={18} />}
      title={t('states.offBanner', { state: s.name ?? monitorStatusLabel('off') })}
      data-testid="monitor-off-banner"
    >
      <Text size="sm">
        {t('states.offSince', { date: fmtDate(s.since) })}
        {s.settlingUntil ? ` · ${t('states.settlingUntil', { date: fmtDate(s.settlingUntil) })}` : ''}
        {s.maxOffSeconds ? ` · ${t('states.offOfMax', { off: fmtSpan(s.offSeconds), max: fmtSpan(s.maxOffSeconds) })}` : ''}
        {s.plannedDowntime ? ` · ${t('states.plannedDowntime')}` : ''}
      </Text>
      {s.unknownChecks > 0 && (
        <Text size="xs" c="dimmed">
          {t('states.unknownChecks', { count: s.unknownChecks })}
        </Text>
      )}
    </Alert>
  );
}

const roleOrder = (c: StateCellView) => (c.role === 'when' ? 0 : c.role === 'requires' ? 1 : 2);

/** "Why this state": every cell of the selected state, and on a contradiction the closest state and what deviates. */
export function WhyThisState({ monitor, onSelect }: { monitor: MonitorDetail; onSelect?: (checkId: string) => void }) {
  const { t } = useTranslation('monitors');
  const s: MonitorStateInfo | null = monitor.state;
  if (!s || monitor.isTemplate) return null;
  const nameOf = (id: string) => monitor.checks.find((c) => c.checkId === id)?.name ?? id;
  const messageOf = (id: string) => monitor.checks.find((c) => c.checkId === id)?.last?.message ?? '';
  const cells = [...s.cells].sort((a, b) => roleOrder(a) - roleOrder(b));
  const deviating = new Set(s.contradiction?.checks.map((c) => c.checkId) ?? []);
  return (
    <Paper withBorder p="sm" mt="sm" data-testid="why-this-state">
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap">
          <Title order={3} size="h5">
            {t('states.whyTitle')}
          </Title>
          <Text size="sm" fw={600} data-testid="state-name">
            {s.id ? t('states.current', { state: s.name ?? s.id }) : t('states.otherwise')}
          </Text>
        </Group>
        <Text size="sm" data-testid="state-summary">
          {s.id ? t('states.since', { date: fmtDate(s.since) }) : ''}
          {s.settlingUntil ? ` · ${t('states.settlingUntil', { date: fmtDate(s.settlingUntil) })}` : ''}
          {s.maxOffSeconds ? ` · ${t('states.offOfMax', { off: fmtSpan(s.offSeconds), max: fmtSpan(s.maxOffSeconds) })}` : ''}
          {s.plannedDowntime ? ` · ${t('states.plannedDowntime')}` : ''}
        </Text>
        <Text size="sm" c={s.reason === 'contradiction' || s.reason === 'required' ? 'red' : undefined} data-testid="state-message" aria-live="polite">
          {t(`states.reason.${s.reason}`)} – {s.message}
        </Text>
        {s.contradiction && (
          <Text size="sm" data-testid="state-contradiction">
            {t('states.closest', { state: s.contradiction.closestName })}{' '}
            {s.contradiction.checks
              .map((c) =>
                t('states.deviates', {
                  check: nameOf(c.checkId),
                  expected: t(`states.cell.${c.expected as 'up' | 'down' | 'off'}`),
                  actual: monitorStatusLabel(c.actual),
                }),
              )
              .join('; ')}
          </Text>
        )}
        {cells.length > 0 && (
          <Table.ScrollContainer minWidth={420}>
            <Table striped withTableBorder fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">{t('states.role')}</Table.Th>
                  <Table.Th scope="col">{t('states.check')}</Table.Th>
                  <Table.Th scope="col">{t('states.expected')}</Table.Th>
                  <Table.Th scope="col">{t('states.actual')}</Table.Th>
                  <Table.Th scope="col">{t('states.verdictTitle')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {cells.map((c) => (
                  <Table.Tr key={`${c.role}/${c.checkId}`} data-testid={`state-cell-${c.checkId}`} data-verdict={c.verdict}>
                    <Table.Td>{t(`states.roles.${c.role}`)}</Table.Td>
                    <Table.Th scope="row" fw={deviating.has(c.checkId) ? 700 : 400}>
                      {onSelect ? (
                        <Anchor component="button" type="button" size="sm" inherit onClick={() => onSelect(c.checkId)}>
                          {nameOf(c.checkId)}
                        </Anchor>
                      ) : (
                        nameOf(c.checkId)
                      )}
                      {messageOf(c.checkId) && (
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {messageOf(c.checkId)}
                        </Text>
                      )}
                    </Table.Th>
                    <Table.Td>{t(`states.cell.${c.expected}`)}</Table.Td>
                    <Table.Td>{monitorStatusLabel(c.actual)}</Table.Td>
                    <Table.Td>
                      <VerdictBadge verdict={c.verdict} />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
        {s.changesLastHour > 0 && (
          <Text size="xs" c="dimmed">
            {t('states.changesLastHour', { count: s.changesLastHour })}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

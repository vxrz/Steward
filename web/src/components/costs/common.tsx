import { Badge, Group, Progress, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { currencyMinorUnits, type CostBudgetStateName, type CostScope } from '@sm/shared';
import { dateTimeFormat, numberFormat } from '../../format';

/**
 * An amount (decimal text) in its currency, in the UI language: "1,840.00 USD" → "$1,840.00" / "1.840,00 $" – rounded
 * to the currency's minor units (0.18.0): "¥8,333" for JPY, "KWD 12.500" for the Kuwaiti dinar.
 */
export function fmtMoney(amount: string | null | undefined, currency: string, digits = currencyMinorUnits(currency)): string {
  if (amount === null || amount === undefined || amount === '') return '–';
  const n = Number(amount);
  if (!Number.isFinite(n)) return '–';
  try {
    return numberFormat({ style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  } catch {
    // a code Intl does not know: the number and the code
    return `${numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)} ${currency}`;
  }
}

/**
 * An amount with a real minus sign (U+2212) instead of the hyphen Intl writes – for amounts that are subtracted, as
 * in a derived price's breakdown: "−US$10.00" / "−10,00 $".
 */
export const fmtMoneySigned = (amount: string | null | undefined, currency: string): string => fmtMoney(amount, currency).replace('-', '\u2212');

/** An amount (decimal text) as a number with the currency's minor units, without the code: "8,333" for JPY. */
export function fmtAmount(amount: string | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || amount === '') return '–';
  const n = Number(amount);
  const digits = currencyMinorUnits(currency);
  return Number.isFinite(n) ? numberFormat({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n) : '–';
}

/**
 * When an amount has more decimals than its currency has minor units (1500.50 JPY): the decimals allowed and the
 * code, for the form's error; null when it fits (the server refuses it as well, 0.18.0).
 */
export function tooManyDecimals(amount: string, currency: string): { digits: number; currency: string } | null {
  const m = /[.,](\d+)$/.exec(amount.trim());
  const code = currency.trim().toUpperCase();
  const digits = currencyMinorUnits(code);
  return m && m[1]!.replace(/0+$/, '').length > digits ? { digits, currency: code } : null;
}

/** +12.5 % / −3 % (the sign always shown), or "–". */
export function fmtChange(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '–';
  const s = numberFormat({ maximumFractionDigits: 1, signDisplay: 'exceptZero' }).format(pct);
  return `${s} %`;
}

/** "Oct 2026" / "Okt. 2026" from YYYY-MM. */
export function fmtMonth(month: string, style: 'short' | 'long' = 'short'): string {
  return dateTimeFormat({ month: style, year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
}

/** "Oct" / "Okt." from YYYY-MM (chart axes). */
export const fmtMonthOnly = (month: string): string => dateTimeFormat({ month: 'short', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

export const SCOPE_PATH = (scope: CostScope, id: string): string => `/costs/${scope}/${encodeURIComponent(id)}`;

/** Whose cost plan: a service, or (0.19.0, ADR 0032) a platform's own. */
export interface PlanOwner {
  kind: 'service' | 'platform';
  id: string;
}

/** The key of a plan in the query cache (a service's id, as before 0.19; a platform's with its kind). */
export const ownerKey = (o: PlanOwner): string => (o.kind === 'service' ? o.id : `platform:${o.id}`);

/** Where a plan lives in the app: the service's Cost plan tab, the platform's Cost plan tab. */
export const planPath = (o: PlanOwner): string =>
  o.kind === 'service' ? `/services/${encodeURIComponent(o.id)}/costs` : `/platforms/${encodeURIComponent(o.id)}?tab=costPlan`;

/** A change in percent with its sign; a rise of more than 10 % in red (the sign says it as well). */
export function ChangeText({ pct }: { pct: number | null }) {
  if (pct === null)
    return (
      <Text span size="sm" c="dimmed">
        –
      </Text>
    );
  return (
    <Text span size="sm" className="viz-num" c={pct > 10 ? 'red' : undefined} data-testid="cost-change">
      {fmtChange(pct)}
    </Text>
  );
}

const STATE_COLOR: Record<CostBudgetStateName, string> = { ok: 'teal', warning: 'orange', exceeded: 'red' };
const STATE_ICON = { ok: IconCircleCheck, warning: IconAlertTriangle, exceeded: IconCircleX };

/** The budget's state as a badge: icon, word and colour (never colour alone). */
export function BudgetBadge({ state }: { state: CostBudgetStateName }) {
  const { t } = useTranslation('costs');
  const I = STATE_ICON[state];
  return (
    <Badge color={STATE_COLOR[state]} variant="light" leftSection={<I size={12} aria-hidden />} data-testid="budget-state">
      {t(`budget.states.${state}`)}
    </Badge>
  );
}

/** This month's share of the budget as a bar with the percentage; without a percentage (state only): the badge. */
export function BudgetBar({ pct, state }: { pct: number | null; state: CostBudgetStateName | null }) {
  const { t } = useTranslation('costs');
  if (pct === null && state) return <BudgetBadge state={state} />;
  if (pct === null || !state)
    return (
      <Text span size="sm" c="dimmed">
        –
      </Text>
    );
  return (
    <Tooltip label={t('budget.pctOf', { pct: numberFormat({ maximumFractionDigits: 1 }).format(pct) })} withArrow>
      <Group gap={6} wrap="nowrap" miw={110}>
        <Progress
          value={Math.min(100, pct)}
          color={STATE_COLOR[state]}
          size="sm"
          style={{ flex: 1, minWidth: 50 }}
          aria-label={t('budget.pctOf', { pct: numberFormat({ maximumFractionDigits: 1 }).format(pct) })}
        />
        <Text span size="xs" className="viz-num">
          {numberFormat({ maximumFractionDigits: 0 }).format(pct)} %
        </Text>
      </Group>
    </Tooltip>
  );
}

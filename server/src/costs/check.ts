import { fromMicros, toMicros, type CheckOf, type MonitorStatus } from '@sm/shared';
import { runAs, type AuthUser } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { CheckSetupError } from '../monitors/platforms.js';
import { HttpError } from '../util.js';
import { scopeInfo } from './access.js';
import { addMonths, monthOf, scopeMonths } from './query.js';

/**
 * The monitor check "Cost change" (#226, docs/COSTS.md#monitor-check): the costs of a service, application, team or
 * platform against the period before – the last complete month against the month before (period "month"), or this
 * month so far against the same share of the month before ("monthToDate"). It fails when they rose by more than
 * `maxIncreasePct` percent or by more than `maxIncrease`. It runs with the monitor owner's rights – also when the
 * monitor engine calls it without a request: they must see the scope, and a service or team counts only the
 * applications they may see; amounts appear in the message only when they may see them.
 */

const SCOPE_LABEL = { service: 'Service', application: 'Application', team: 'Team', platform: 'Platform' } as const;

/** Saving or trying a check: the person doing it must see the scope – one they may not see answers like a missing one. */
export function requireVisibleCostScope(check: string, c: Pick<CheckOf<'cost'>, 'scope' | 'target'>): void {
  if (!scopeInfo(c.scope, c.target))
    throw new HttpError(400, `Check "${check}": ${c.scope} "${c.target}" not found`, 'COST_SCOPE_NOT_FOUND', { scope: c.scope, id: c.target });
}

export function costCheck(c: CheckOf<'cost'>, ctx: { owner: string; now: () => number }): { status: MonitorStatus; message: string; value?: unknown } {
  const u = findUserByName(ctx.owner);
  if (!u || !u.active) throw new CheckSetupError(`the monitor owner ${ctx.owner} is missing or deactivated`);
  const owner = toAuthUser(u);
  return runAs(owner, () => ownerCheck(c, owner, ctx.now()));
}

function ownerCheck(c: CheckOf<'cost'>, owner: AuthUser, now: number): { status: MonitorStatus; message: string; value?: unknown } {
  const info = scopeInfo(c.scope, c.target, owner);
  if (!info) throw new CheckSetupError(`${c.scope} ${c.target} does not exist or the monitor owner may not see it`);
  const month = monthOf(now);
  const sums = scopeMonths(c.scope, c.target, addMonths(month, -2), owner);
  const currency =
    c.currency ?? [...sums.entries()].map(([cur, m]) => [cur, [...m.values()].reduce((n, x) => n + x.e, 0)] as const).sort((a, b) => b[1] - a[1])[0]?.[0];
  const m = currency ? sums.get(currency) : undefined;
  const what = `${SCOPE_LABEL[c.scope]} "${info.name}"`;
  let current: number | undefined;
  let previous: number | undefined;
  let label: string;
  if (c.period === 'monthToDate') {
    const start = Date.parse(`${month}-01T00:00:00Z`);
    const next = Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`);
    const share = (now - start) / (next - start);
    current = m?.get(month)?.e;
    const p = m?.get(addMonths(month, -1))?.e;
    previous = p === undefined ? undefined : Math.round(p * share);
    label = `${month} so far against the same share of ${addMonths(month, -1)}`;
  } else {
    current = m?.get(addMonths(month, -1))?.e;
    previous = m?.get(addMonths(month, -2))?.e;
    label = `${addMonths(month, -1)} against ${addMonths(month, -2)}`;
  }
  if (current === undefined || previous === undefined || !currency) return { status: c.noData, message: `${what}: no costs to compare (${label})` };
  const change = current - previous;
  const pct = previous > 0 ? Math.round((change / previous) * 1000) / 10 : null;
  const amount = (n: number) => (info.amounts ? `${fromMicros(n)} ${currency}` : '');
  const value = {
    currency,
    period: c.period,
    changePct: pct,
    ...(info.amounts ? { current: fromMicros(current), previous: fromMicros(previous), change: fromMicros(change) } : {}),
  };
  const limitAmount = c.maxIncrease !== undefined ? toMicros(c.maxIncrease) : null;
  const overPct = c.maxIncreasePct !== undefined && (pct === null ? change > 0 : pct > c.maxIncreasePct);
  const overAmount = limitAmount !== null && change > limitAmount;
  const changeText = `${pct === null ? 'new costs' : `${pct > 0 ? '+' : ''}${pct} %`}${info.amounts ? ` (${amount(previous)} → ${amount(current)})` : ''}`;
  if (overPct || overAmount) {
    const limits = [
      overPct ? `more than ${c.maxIncreasePct} %` : '',
      overAmount && info.amounts ? `more than ${fromMicros(limitAmount!)} ${currency}` : overAmount ? 'more than the amount allowed' : '',
    ]
      .filter(Boolean)
      .join(' and ');
    return { status: c.failAs, message: `${what}: costs up ${changeText}, ${limits} – ${label}`.slice(0, 1000), value };
  }
  return { status: 'up', message: `${what}: costs ${changeText} – ${label}`.slice(0, 1000), value };
}

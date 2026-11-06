import { costBudgetInput, fromMicros, toMicros, type CostBudget, type CostBudgetScope } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { HttpError, nowIso } from '../util.js';
import { requireScope, scopeInfo } from './access.js';
import { budgetOf, budgetRow, monthOf } from './query.js';

/**
 * Monthly cost budgets per service, application or team (#226, docs/COSTS.md#budgets), modelled on the AI budgets:
 *
 * - who may change the service or application (its editors; teams: administrators) sets, changes and removes one;
 * - **raising** a budget – a higher amount, another currency, or no budget any more – needs a step-up: the control
 *   point `cost.budget` of the assurance policy (on by default; lowering one never asks); every change is audited
 *   (`cost.budget_changed`, before and after, the comment);
 * - at 80 % and at 100 % of the month's budget a notice goes out once per budget, month and level (event "Cost
 *   budget") to the owners and the members of the owning teams (administrators when there are none). A budget never
 *   stops anything: showback, not a limit.
 */

export interface BudgetChange {
  scope: CostBudgetScope;
  scopeId: string;
  amount: string | null;
  currency: string;
  comment?: string;
}

/** Whether this change raises the budget: a higher amount, another currency, or none any more (an existing one removed). */
export function raisesBudget(input: Pick<BudgetChange, 'scope' | 'scopeId' | 'amount' | 'currency'>): boolean {
  const b = budgetRow(input.scope, input.scopeId);
  if (!b) return false;
  if (input.amount === null) return true;
  if (input.currency.toUpperCase() !== b.currency) return true;
  return (toMicros(input.amount) ?? 0) > Number(b.amount);
}

/** Whether the caller may change the scope's budget (the route asks for the step-up only then). */
export function mayChangeBudget(scope: CostBudgetScope, id: string): boolean {
  return scopeInfo(scope, id)?.canEditBudget === true;
}

export function setBudget(body: unknown): CostBudget | null {
  const x = costBudgetInput.parse(body);
  const info = requireScope(x.scope, x.scopeId);
  if (!info.canEditBudget) throw new HttpError(403, `You are not allowed to change the cost budget of "${info.name}"`, 'FORBIDDEN', { context: 'costBudget' });
  const before = budgetRow(x.scope, x.scopeId);
  const raised = raisesBudget({ scope: x.scope, scopeId: x.scopeId, amount: x.amount, currency: x.currency });
  const micros = x.amount === null ? null : toMicros(x.amount)!;
  const fmt = (a: number | null | undefined, c: string | undefined) => (a === null || a === undefined ? 'no budget' : `${fromMicros(a)} ${c}`);
  db().tx(() => {
    if (micros === null) db().run('DELETE FROM cost_budgets WHERE scope = ? AND scope_id = ?', x.scope, x.scopeId);
    else
      db().run(
        `INSERT INTO cost_budgets (scope, scope_id, amount, currency, comment, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency, comment = excluded.comment,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        x.scope,
        x.scopeId,
        micros,
        x.currency,
        x.comment ?? '',
        nowIso(),
        currentActor(),
      );
    // a raised budget may warn again this month
    if (raised || micros === null) db().run('DELETE FROM cost_budget_notices WHERE scope = ? AND scope_id = ?', x.scope, x.scopeId);
    audit({
      action: 'cost.budget_changed',
      entityType: x.scope,
      entityId: x.scopeId,
      summary: `Cost budget of ${x.scope} "${info.name}" ${micros === null ? 'removed' : raised ? 'raised' : before ? 'changed' : 'set'}: ${fmt(micros, x.currency)} a month (was ${fmt(before ? Number(before.amount) : null, before?.currency)})`,
      details: {
        scope: x.scope,
        scopeId: x.scopeId,
        before: before ? { amount: fromMicros(Number(before.amount)), currency: before.currency } : null,
        after: micros === null ? null : { amount: fromMicros(micros), currency: x.currency },
        raised,
        ...(x.comment ? { comment: x.comment } : {}),
      },
    });
  });
  checkBudgetNotices();
  return budgetOf(x.scope, x.scopeId, info.amounts);
}

// ---------- notices ----------

export type BudgetNotice = { scope: CostBudgetScope; scopeId: string; name: string; level: 80 | 100; budget: CostBudget; month: string };
type NoticeHook = (n: BudgetNotice) => void;
let hook: NoticeHook | null = null;
/** The notification module sends the notices (set at start-up, no import cycle). */
export function onCostBudgetNotice(fn: NoticeHook): void {
  hook = fn;
}

/** Sends the 80 % and the 100 % notice of every budget once per month (the job, after each read, after a change). */
export function checkBudgetNotices(now = Date.now()): number {
  const month = monthOf(now);
  let sent = 0;
  for (const r of db().all<{ scope: CostBudgetScope; scope_id: string }>('SELECT scope, scope_id FROM cost_budgets ORDER BY scope, scope_id')) {
    const info = scopeInfo(r.scope, r.scope_id, null);
    if (!info) continue;
    // the whole scope (no reader); each recipient's text leaves out what they may not see (notifications/service.ts)
    const b = budgetOf(r.scope, r.scope_id, true, now, null);
    if (!b) continue;
    const level: 80 | 100 | null = b.state === 'exceeded' ? 100 : b.state === 'warning' ? 80 : null;
    if (!level) continue;
    const fresh = db().run(
      'INSERT INTO cost_budget_notices (scope, scope_id, month, level, sent_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      r.scope,
      r.scope_id,
      month,
      level,
      new Date(now).toISOString(),
    ).changes;
    if (fresh) {
      sent++;
      hook?.({ scope: r.scope, scopeId: r.scope_id, name: info.name, level, budget: b, month });
    }
  }
  return sent;
}

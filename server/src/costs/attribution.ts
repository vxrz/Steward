import { fiscalYearLabel, fiscalYearOf, fromMicros, type CostAttribution, type CostPlanCadence, type CostPlanCategory } from '@sm/shared';
import { db } from '../db.js';
import { HttpError } from '../util.js';
import { catalogueVisibleNow } from '../records/access.js';
import { ScopeCtx } from '../suppliers/contract-scope.js';
import { supplierRefs, visibleContracts } from '../suppliers/links.js';
import { scopeInfo, type ScopeInfo } from './access.js';
import { lineMonths, lineTitle, startMonth, thisMonth, type LineRow } from './plans.js';

/**
 * Cost attribution of applications and systems (0.19.0, ADR 0032 part 1, docs/COSTS.md#costs-and-contracts-of-an-application-or-system):
 * a read-only rollup on the application's and the system's page – the service stays the one that plans and pays, so an
 * application shared by two services is never counted twice: each line, entry and schedule belongs to one service and
 * is listed once.
 *
 * - Lines, entries (their own target, or their line's) and payment schedules that name the item, of the services the
 *   reader may see; contracts that name it for a covered service (supplier_contract_items) or that those pay for – only
 *   contracts the reader may see (ADR 0031), the others are neither listed nor counted.
 * - Amounts follow the service's "Hide amounts from viewers" (ScopeInfo.amounts): without them a row has no amounts and
 *   is not totalled (`amountsHidden`).
 * - A fixed number of statements, whatever the number of rows.
 */

interface Row {
  id: string;
  name: string;
  owners: string;
}

export function costAttribution(kind: 'application' | 'system', id: string, year?: number, now = Date.now()): CostAttribution {
  const item = db().get<Row>(`SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'systems'} WHERE id = ?`, id);
  if (!item || !catalogueVisibleNow(kind, item))
    throw new HttpError(404, `${kind === 'application' ? 'Application' : 'System'} ${id} not found`, 'COST_SCOPE_NOT_FOUND', { scope: kind, id });
  const start = startMonth();
  const cur = fiscalYearOf(thisMonth(now), start);
  const fy = year ?? cur;
  const lines = db().all<LineRow>(
    "SELECT * FROM cost_plan_lines WHERE target_kind = ? AND target_id = ? AND service_id <> '' ORDER BY fiscal_year DESC, title, id",
    kind,
    id,
  );
  const entries = db().all<{
    id: string;
    service_id: string;
    entry_date: string;
    amount: number;
    currency: string;
    reference: string;
    plan_line_id: string | null;
    supplier_contract_id: string | null;
  }>(
    `SELECT e.id, e.service_id, e.entry_date, e.amount, e.currency, e.reference, e.plan_line_id, e.supplier_contract_id FROM cost_entries e
       LEFT JOIN cost_plan_lines l ON l.id = e.plan_line_id
      WHERE e.service_id <> '' AND ((e.target_kind = ? AND e.target_id = ?) OR (e.target_kind IS NULL AND l.target_kind = ? AND l.target_id = ?))
      ORDER BY e.entry_date DESC, e.id`,
    kind,
    id,
    kind,
    id,
  );
  const schedules = db().all<{ id: string; service_id: string; title: string; billing: string; amount: number; currency: string; contract_id: string }>(
    "SELECT id, service_id, title, billing, amount, currency, contract_id FROM cost_schedules WHERE target_kind = ? AND target_id = ? AND service_id <> '' ORDER BY title, id",
    kind,
    id,
  );
  const named = db().all<{ contract_id: string; service_id: string }>(
    'SELECT contract_id, service_id FROM supplier_contract_items WHERE kind = ? AND item_id = ?',
    kind,
    id,
  );
  // the services the reader may see, once each
  const infos = new Map<string, ScopeInfo | null>();
  const info = (sid: string) => {
    if (!infos.has(sid)) infos.set(sid, scopeInfo('service', sid));
    return infos.get(sid)!;
  };
  const seenLines = lines.filter((l) => !!info(l.service_id));
  const seenEntries = entries.filter((e) => !!info(e.service_id));
  const seenSchedules = schedules.filter((x) => !!info(x.service_id));
  const contracts = visibleContracts([
    ...seenLines.map((l) => l.supplier_contract_id),
    ...seenEntries.map((e) => e.supplier_contract_id),
    ...seenSchedules.map((x) => x.contract_id),
    ...named.map((n) => n.contract_id),
  ]);
  const refs = supplierRefs([...contracts.values()].map((c) => c.supplierId));
  let amountsHidden = false;
  const money = (sid: string, v: number) => {
    if (info(sid)!.amounts) return fromMicros(v);
    amountsHidden = true;
    return null;
  };
  // totals per fiscal year and currency: each line and entry once, only where amounts are seen
  const totals = new Map<string, { planned: number; incurred: number }>();
  const tot = (y: number, currency: string) => {
    const k = `${y}|${currency}`;
    let t = totals.get(k);
    if (!t) totals.set(k, (t = { planned: 0, incurred: 0 }));
    return t;
  };
  for (const l of seenLines)
    if (info(l.service_id)!.amounts) tot(Number(l.fiscal_year), l.currency).planned += lineMonths(l).reduce((a, b) => a + b, 0);
    else amountsHidden = true;
  for (const e of seenEntries)
    if (info(e.service_id)!.amounts) tot(fiscalYearOf(e.entry_date, start), e.currency).incurred += Number(e.amount);
    else amountsHidden = true;
  const titles = new Map(seenLines.map((l) => [l.id, lineTitle(l, contracts)]));
  const ctx = new ScopeCtx().load(named.map((n) => n.contract_id));
  const contractList: CostAttribution['contracts'] = [...contracts.values()]
    .map((c) => {
      const mine = named.filter((n) => n.contract_id === c.id && ctx.seesService(n.service_id, true));
      return {
        id: c.id,
        title: c.title,
        reference: c.reference,
        supplier: refs.get(c.supplierId) ?? null,
        endsOn: c.endsOn,
        services: mine.map((n) => ({
          id: n.service_id,
          name: ctx.service(n.service_id)?.name ?? '',
          purpose: ctx.coverOf(c.id).find((x) => x.service_id === n.service_id)?.purpose ?? '',
        })),
        named: mine.length > 0,
      };
    })
    .sort((a, b) => Number(b.named) - Number(a.named) || a.title.localeCompare(b.title));
  const ofYear = (d: string) => fiscalYearOf(d, start) === fy;
  const years = new Set<number>([fy, cur]);
  for (const l of seenLines) years.add(Number(l.fiscal_year));
  for (const e of seenEntries) years.add(fiscalYearOf(e.entry_date, start));
  const contractOf = (cid: string | null) => {
    const c = cid ? contracts.get(cid) : undefined;
    return { contract: c ? { id: c.id, title: c.title } : null, contractHidden: !!cid && !c };
  };
  return {
    kind,
    id,
    name: item.name,
    fiscalYear: fy,
    label: fiscalYearLabel(fy, start),
    years: [...years].sort((a, b) => b - a).map((y) => ({ fiscalYear: y, label: fiscalYearLabel(y, start) })),
    contracts: contractList,
    lines: seenLines
      .filter((l) => Number(l.fiscal_year) === fy)
      .map((l) => ({
        id: l.id,
        serviceId: l.service_id,
        serviceName: info(l.service_id)!.name,
        title: titles.get(l.id)!,
        category: l.category as CostPlanCategory,
        cadence: l.cadence as CostPlanCadence,
        currency: l.currency,
        amount: money(l.service_id, Number(l.amount)),
        planned: money(
          l.service_id,
          lineMonths(l).reduce((a, b) => a + b, 0),
        ),
        ...contractOf(l.supplier_contract_id),
      })),
    entries: seenEntries
      .filter((e) => ofYear(e.entry_date))
      .map((e) => ({
        id: e.id,
        serviceId: e.service_id,
        serviceName: info(e.service_id)!.name,
        date: e.entry_date,
        currency: e.currency,
        amount: money(e.service_id, Number(e.amount)),
        reference: e.reference,
        planLineTitle: e.plan_line_id ? (titles.get(e.plan_line_id) ?? null) : null,
      })),
    schedules: seenSchedules.map((x) => ({
      id: x.id,
      serviceId: x.service_id,
      serviceName: info(x.service_id)!.name,
      title: x.title,
      billing: x.billing,
      currency: x.currency,
      amount: x.billing === 'dates' ? null : money(x.service_id, Number(x.amount)),
      ...contractOf(x.contract_id),
    })),
    totals: [...totals.entries()]
      .map(([k, t]) => {
        const [y, currency] = k.split('|');
        return {
          fiscalYear: Number(y),
          label: fiscalYearLabel(Number(y), start),
          currency: currency!,
          planned: fromMicros(t.planned),
          incurred: fromMicros(t.incurred),
        };
      })
      .sort((a, b) => b.fiscalYear - a.fiscalYear || a.currency.localeCompare(b.currency)),
    amountsHidden,
  };
}

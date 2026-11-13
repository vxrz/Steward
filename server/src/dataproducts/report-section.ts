import { z, type ZodType } from 'zod';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { contractAccess } from '../auth/policy.js';
import { defineReportSection } from '../reports/sections.js';
import { productAccess } from './access.js';
import { scorecardsOf } from './scorecard.js';
import { snapshotsAt } from './scorecard-history.js';
import { bindingsOf, chunks, marks, portsOf, type ProductRow } from './store.js';
import { dataProductsSectionDraw, type DataProductsSectionData, type DataProductsSectionRow } from './report-section-draw.js';

/**
 * The "Data products" section of scheduled reports (0.24.0, ADR 0036 phase 2; the module's report section for ADR
 * 0034 – modules.ts): per product the owner of the schedule may see (built inside runAs(owner)), in its default
 * environment (production first) or the one configured – the maturity now and at the start of the period (the daily
 * snapshots, scorecard-history.ts), the parts met, the healthy part, the quality results of its output elements in the
 * period and the breaking versions of its bound contracts the owner may see. A fixed number of statements per 200
 * products.
 */

const MAX_PRODUCTS = 300;

const schema = z.object({
  /** Products to include; null: every product the owner may see (at most 300, by name) */
  productIds: z.array(z.string().min(1).max(100)).max(200).nullable().default(null),
  /** An environment instead of each product's default (production first) */
  environment: z.string().trim().min(1).max(60).nullable().default(null),
});

type Config = z.infer<typeof schema>;

const iso = (t: number) => new Date(t).toISOString();

function visibleProducts(c: Config): ProductRow[] {
  const u = currentUser();
  if (!u) return [];
  return db()
    .all<ProductRow>("SELECT * FROM dp_products WHERE lifecycle <> 'retired' ORDER BY name_norm, id")
    .filter((p) => (!c.productIds || c.productIds.includes(p.id)) && productAccess(u, p).permissions.includes('view'));
}

function build(c: Config, ctx: { from: number; to: number; now: number }): DataProductsSectionData {
  const out: DataProductsSectionData = { rows: [], more: 0, totals: { products: 0, rising: 0, falling: 0, failed: 0, breaking: 0 } };
  const u = currentUser();
  const all = visibleProducts(c);
  out.more = Math.max(0, all.length - MAX_PRODUCTS);
  const products = all.slice(0, MAX_PRODUCTS);
  if (!u || !products.length) return out;
  const from = iso(ctx.from);
  const to = iso(ctx.to);
  const startDay = from.slice(0, 10);
  for (const part of chunks(products, 200)) {
    const ids = part.map((p) => p.id);
    const cards = scorecardsOf(u, ids, c.environment ?? undefined, Math.min(ctx.to, ctx.now));
    // snapshots at the start of the period, per environment shown
    const byEnv = new Map<string, string[]>();
    for (const card of cards.values()) byEnv.set(card.environment ?? '', [...(byEnv.get(card.environment ?? '') ?? []), card.productId]);
    const before = new Map<string, number>();
    for (const [env, pids] of byEnv) for (const [pid, pt] of snapshotsAt(pids, env, startDay)) before.set(pid, pt.maturity);
    // output elements per product in the environment shown, and the bound contracts
    const ports = portsOf(ids).filter((p) => p.direction === 'output' && p.lifecycle !== 'retired');
    const bindings = bindingsOf(ports.map((p) => p.id));
    const productOfPort = new Map(ports.map((p) => [p.id, p.product_id]));
    const elementsOf = new Map<string, Set<string>>();
    const contractsOf = new Map<string, Set<string>>();
    for (const b of bindings) {
      const pid = productOfPort.get(b.port_id)!;
      if ((cards.get(pid)?.environment ?? null) !== b.environment) continue;
      const els = elementsOf.get(pid) ?? new Set<string>();
      for (const e of b.elementIds) els.add(e);
      elementsOf.set(pid, els);
      if (b.contract_id && contractAccess(u, { id: b.contract_id }).permissions.includes('view'))
        contractsOf.set(pid, new Set([...(contractsOf.get(pid) ?? []), b.contract_id]));
    }
    const elementIds = [...new Set([...elementsOf.values()].flatMap((s) => [...s]))];
    const quality = new Map<string, { passed: number; failed: number }>();
    for (const ep of chunks(elementIds))
      for (const r of db().all<{ element_id: string; status: string; n: number | string }>(
        `SELECT element_id, status, COUNT(*) AS n FROM dp_quality_results WHERE element_id IN (${marks(ep.length)}) AND observed_at >= ? AND observed_at < ?
           AND source <> 'check' GROUP BY element_id, status`,
        ...ep,
        from,
        to,
      )) {
        const q = quality.get(r.element_id) ?? { passed: 0, failed: 0 };
        if (r.status === 'passed') q.passed += Number(r.n);
        else if (r.status === 'failed' || r.status === 'error') q.failed += Number(r.n);
        quality.set(r.element_id, q);
      }
    const contractIds = [...new Set([...contractsOf.values()].flatMap((s) => [...s]))];
    const breaking = new Map<string, number>();
    for (const cp of chunks(contractIds))
      for (const r of db().all<{ contract_id: string; n: number | string }>(
        `SELECT contract_id, COUNT(*) AS n FROM data_contract_versions WHERE contract_id IN (${marks(cp.length)}) AND breaking_count > 0
           AND created_at >= ? AND created_at < ? GROUP BY contract_id`,
        ...cp,
        from,
        to,
      ))
        breaking.set(r.contract_id, Number(r.n));
    for (const p of part) {
      const card = cards.get(p.id);
      if (!card) continue;
      const parts = card.parts.filter((x) => x.group === 'part');
      const q = [...(elementsOf.get(p.id) ?? [])].reduce(
        (a, e) => ({ passed: a.passed + (quality.get(e)?.passed ?? 0), failed: a.failed + (quality.get(e)?.failed ?? 0) }),
        { passed: 0, failed: 0 },
      );
      const row: DataProductsSectionRow = {
        name: p.name,
        key: p.key,
        environment: card.environment,
        maturity: card.maturity,
        maturityBefore: before.get(p.id) ?? null,
        met: parts.filter((x) => x.state === 'met').length,
        parts: parts.length,
        health: parts.find((x) => x.id === 'healthy')?.state ?? 'noEvidence',
        passed: q.passed,
        failed: q.failed,
        breaking: [...(contractsOf.get(p.id) ?? [])].reduce((n, id) => n + (breaking.get(id) ?? 0), 0),
      };
      out.rows.push(row);
      if (row.maturityBefore !== null && row.maturity > row.maturityBefore) out.totals.rising++;
      if (row.maturityBefore !== null && row.maturity < row.maturityBefore) out.totals.falling++;
      out.totals.failed += row.failed;
      out.totals.breaking += row.breaking;
    }
  }
  out.totals.products = out.rows.length + out.more;
  return out;
}

export const dataProductsSection = defineReportSection<Config, DataProductsSectionData>({
  ...dataProductsSectionDraw,
  schema: schema as unknown as ZodType<Config>,
  validate: (c) => {
    if (!c.productIds) return;
    const u = currentUser();
    const rows = new Map(
      chunks(c.productIds).flatMap((part) =>
        db()
          .all<ProductRow>(`SELECT * FROM dp_products WHERE id IN (${marks(part.length)})`, ...part)
          .map((r) => [r.id, r] as const),
      ),
    );
    // a product the owner may not see reads like a missing one
    const missing = c.productIds.filter((id) => {
      const p = rows.get(id);
      return !p || !u || !productAccess(u, p).permissions.includes('view');
    });
    if (missing.length) throw Object.assign(new Error(`Data product(s) not found: ${missing.join(', ')}`), { statusCode: 400 });
  },
  build,
});

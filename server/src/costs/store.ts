import { fromMicros, type CostGranularity, type CostSource } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { newId, nowIso, parseJson } from '../util.js';

/**
 * The cost model's store (#226, docs/COSTS.md#the-cost-model): writing the lines of a source and linking them to
 * platforms, components and applications.
 *
 * A read of a source hands over every line of a window (the last days or months it re-reads). Lines are identified by
 * their key within the source platform and source: a line that comes again replaces the stored one, a stored line of
 * the window that does not come again is removed. A line whose charge period had ended before it was last read and
 * whose amount changes (or that goes away) is a **correction** – late and corrected figures, e.g. AWS and Snowflake
 * values that change for up to 72 hours and until the month is closed. Corrections are marked on the line and audited
 * (`cost.corrected`, per month and currency, before and after). A line of a period that is still running (the current
 * month so far) simply changes.
 */

export interface CostLine {
  /** Unique within the source platform and source */
  key: string;
  granularity: CostGranularity;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  chargePeriodStart: string;
  chargePeriodEnd: string;
  /** Whole millionths of the currency */
  billed: number;
  effective: number;
  currency: string;
  provider: string;
  service: string;
  category: string;
  resourceId: string;
  resourceName: string;
  subAccountId: string;
  chargeCategory: string;
  tags: Record<string, string>;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  removed: number;
  unchanged: number;
  corrections: { month: string; currency: string; before: string; after: string; lines: number }[];
}

interface Existing {
  id: string;
  line_key: string;
  billed_cost: number;
  effective_cost: number;
  charge_period_end: string;
  read_at: string;
  month: string;
  billing_currency: string;
}

// ---------- mapping ----------

export interface Link {
  platformId: string;
  componentId: string | null;
  applicationId: string | null;
}

type MapInput = Pick<CostLine, 'tags' | 'resourceId' | 'subAccountId'>;

const lower = (s: string) => s.trim().toLowerCase();

/**
 * How the lines of a source platform are linked (docs/COSTS.md#mapping):
 *   1. Confluent Cloud: the cluster (ResourceId lkc-…) or, failing that, the environment (SubAccountId env-…) names the
 *      Kafka platform whose variable confluentClusterId (confluentEnvironmentId) matches – the cost belongs to that
 *      platform; its application is the one all Kafka topic components on it belong to, or the platform's own.
 *   2. The tag (cost source setting tagKey, default "application") names a component on the platform (an AWS cloud
 *      account's name is its tag value) or else an application by its name (case-insensitive, unique).
 *   3. The platform's own application (Catalogue → application → integrations).
 *   4. Otherwise the line stays unassigned – shown per platform as "unassigned".
 */
export function mapper(sourcePlatformId: string, source: CostSource): (l: MapInput) => Link {
  const tagKey = db().get<{ tag_key: string }>('SELECT tag_key FROM cost_sources WHERE platform_id = ?', sourcePlatformId)?.tag_key || 'application';
  const own = new Map(
    db()
      .all<{ platform_id: string; application_id: string }>(
        'SELECT p.platform_id, p.application_id FROM application_platforms p JOIN applications a ON a.id = p.application_id WHERE a.archived = 0',
      )
      .map((r) => [r.platform_id, r.application_id]),
  );
  const comps = db().all<{ id: string; application_id: string; name: string; type: string; platform_id: string }>(
    `SELECT c.id, c.application_id, c.name, c.type, c.platform_id FROM application_components c JOIN applications a ON a.id = c.application_id
      WHERE a.archived = 0 AND c.platform_id IS NOT NULL`,
  );
  const appsByName = new Map<string, string | null>();
  for (const a of db().all<{ id: string; name: string }>('SELECT id, name FROM applications WHERE archived = 0')) {
    const k = lower(a.name);
    // a name two applications share links neither
    appsByName.set(k, appsByName.has(k) ? null : a.id);
  }
  const compOn = (platformId: string, name: string) => {
    const hits = comps.filter((c) => c.platform_id === platformId && lower(c.name) === lower(name));
    return hits.length === 1 ? hits[0]! : null;
  };
  /** The application of a Kafka platform: the one all its topic components belong to, else its own. */
  const kafkaApp = (platformId: string): string | null => {
    const apps = new Set(comps.filter((c) => c.platform_id === platformId && c.type === 'kafka-topic').map((c) => c.application_id));
    if (apps.size === 1) return [...apps][0]!;
    return own.get(platformId) ?? null;
  };
  const kafka =
    source === 'confluent'
      ? db()
          .all<{ id: string; config: string }>("SELECT id, config FROM platforms WHERE kind = 'kafka'")
          .map((p) => {
            const v = parseJson<{ variables?: Record<string, unknown> }>(p.config, {}).variables ?? {};
            return { id: p.id, cluster: String(v.confluentClusterId ?? '').trim(), environment: String(v.confluentEnvironmentId ?? '').trim() };
          })
      : [];
  return (l) => {
    let platformId = sourcePlatformId;
    if (source === 'confluent') {
      const byCluster = l.resourceId ? kafka.filter((k) => k.cluster && k.cluster === l.resourceId) : [];
      const byEnv = !byCluster.length && l.subAccountId ? kafka.filter((k) => k.environment && k.environment === l.subAccountId && !k.cluster) : [];
      const hit = byCluster.length === 1 ? byCluster[0] : byEnv.length === 1 ? byEnv[0] : undefined;
      if (hit) return { platformId: hit.id, componentId: null, applicationId: kafkaApp(hit.id) };
    }
    const tag = Object.hasOwn(l.tags, tagKey) ? String(l.tags[tagKey] ?? '').trim() : '';
    if (tag) {
      const c = compOn(platformId, tag);
      if (c) return { platformId, componentId: c.id, applicationId: c.application_id };
      const app = appsByName.get(lower(tag));
      if (app) return { platformId, componentId: null, applicationId: app };
    }
    platformId = sourcePlatformId;
    return { platformId, componentId: null, applicationId: own.get(platformId) ?? null };
  };
}

/**
 * Links every line of a source platform again (the catalogue changed: a new component, an application renamed). One
 * update per distinct tag set and resource – not per line. Returns the lines whose link changed.
 */
export function remap(sourcePlatformId: string, source: CostSource): number {
  const map = mapper(sourcePlatformId, source);
  const groups = db().all<{
    tags: string;
    resource_id: string;
    sub_account_id: string;
    platform_id: string;
    component_id: string | null;
    application_id: string | null;
  }>(
    `SELECT DISTINCT tags, resource_id, sub_account_id, platform_id, component_id, application_id FROM cost_records WHERE source_platform_id = ? AND source = ?`,
    sourcePlatformId,
    source,
  );
  let changed = 0;
  db().tx(() => {
    for (const g of groups) {
      const link = map({ tags: parseJson<Record<string, string>>(g.tags, {}), resourceId: g.resource_id, subAccountId: g.sub_account_id });
      if (link.platformId === g.platform_id && link.componentId === g.component_id && link.applicationId === g.application_id) continue;
      changed += db().run(
        `UPDATE cost_records SET platform_id = ?, component_id = ?, application_id = ?
          WHERE source_platform_id = ? AND source = ? AND tags = ? AND resource_id = ? AND sub_account_id = ?`,
        link.platformId,
        link.componentId,
        link.applicationId,
        sourcePlatformId,
        source,
        g.tags,
        g.resource_id,
        g.sub_account_id,
      ).changes;
    }
  });
  return changed;
}

// ---------- writing ----------

/** Tags as stored: keys sorted, so equal tag sets compare equal. */
export const tagsText = (tags: Record<string, string>): string =>
  JSON.stringify(Object.fromEntries(Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));

/**
 * Writes the lines of one read or import. `window` (charge period starts, from inclusive, to exclusive): stored lines of
 * the source in it that do not come again are removed; null keeps every other line (an import that adds).
 */
export function ingest(o: {
  sourcePlatformId: string;
  sourceName: string;
  source: CostSource;
  lines: CostLine[];
  window: { from: string; to: string } | null;
  actor: string;
  importId?: string | null;
  now?: string;
}): IngestResult {
  const now = o.now ?? nowIso();
  const map = mapper(o.sourcePlatformId, o.source);
  const out: IngestResult = { inserted: 0, updated: 0, removed: 0, unchanged: 0, corrections: [] };
  const corr = new Map<string, { month: string; currency: string; before: number; after: number; lines: number }>();
  const correct = (month: string, currency: string, before: number, after: number) => {
    const k = `${month}|${currency}`;
    const c = corr.get(k) ?? { month, currency, before: 0, after: 0, lines: 0 };
    c.before += before;
    c.after += after;
    c.lines++;
    corr.set(k, c);
  };
  db().tx(() => {
    const existing = new Map<string, Existing>();
    const keys = new Set(o.lines.map((l) => l.key));
    if (o.window) {
      for (const r of db().all<Existing>(
        `SELECT id, line_key, billed_cost, effective_cost, charge_period_end, read_at, month, billing_currency FROM cost_records
          WHERE source_platform_id = ? AND source = ? AND charge_period_start >= ? AND charge_period_start < ?`,
        o.sourcePlatformId,
        o.source,
        o.window.from,
        o.window.to,
      ))
        existing.set(r.line_key, r);
    }
    // lines outside the window that come again (a source that re-reads fewer days than it sent before)
    // (an import's keys carry its id: they are new by definition)
    const missing = o.importId ? [] : [...keys].filter((k) => !existing.has(k));
    for (let i = 0; i < missing.length; i += 500) {
      const part = missing.slice(i, i + 500);
      for (const r of db().all<Existing>(
        `SELECT id, line_key, billed_cost, effective_cost, charge_period_end, read_at, month, billing_currency FROM cost_records
          WHERE source_platform_id = ? AND source = ? AND line_key IN (${part.map(() => '?').join(', ')})`,
        o.sourcePlatformId,
        o.source,
        ...part,
      ))
        existing.set(r.line_key, r);
    }
    for (const l of o.lines) {
      const before = existing.get(l.key);
      const link = map(l);
      const month = l.chargePeriodStart.slice(0, 7);
      if (before) {
        const same = Number(before.billed_cost) === l.billed && Number(before.effective_cost) === l.effective;
        const closed = before.charge_period_end <= before.read_at;
        if (!same && closed) correct(before.month, before.billing_currency, Number(before.effective_cost), l.effective);
        db().run(
          `UPDATE cost_records SET granularity = ?, billing_period_start = ?, billing_period_end = ?, charge_period_start = ?, charge_period_end = ?, month = ?,
             billed_cost = ?, effective_cost = ?, billing_currency = ?, provider_name = ?, service_name = ?, service_category = ?, resource_id = ?,
             resource_name = ?, sub_account_id = ?, charge_category = ?, tags = ?, platform_id = ?, component_id = ?, application_id = ?, import_id = ?,
             read_at = ?, corrected_at = CASE WHEN ? = 1 THEN ? ELSE corrected_at END
           WHERE id = ?`,
          l.granularity,
          l.billingPeriodStart,
          l.billingPeriodEnd,
          l.chargePeriodStart,
          l.chargePeriodEnd,
          month,
          l.billed,
          l.effective,
          l.currency,
          l.provider,
          l.service,
          l.category,
          l.resourceId,
          l.resourceName,
          l.subAccountId,
          l.chargeCategory,
          tagsText(l.tags),
          link.platformId,
          link.componentId,
          link.applicationId,
          o.importId ?? null,
          now,
          !same && closed ? 1 : 0,
          now,
          before.id,
        );
        if (same) out.unchanged++;
        else out.updated++;
      } else {
        db().run(
          `INSERT INTO cost_records (id, source_platform_id, source, line_key, granularity, billing_period_start, billing_period_end, charge_period_start,
             charge_period_end, month, billed_cost, effective_cost, billing_currency, provider_name, service_name, service_category, resource_id,
             resource_name, sub_account_id, charge_category, tags, platform_id, component_id, application_id, import_id, read_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          newId('cost_'),
          o.sourcePlatformId,
          o.source,
          l.key,
          l.granularity,
          l.billingPeriodStart,
          l.billingPeriodEnd,
          l.chargePeriodStart,
          l.chargePeriodEnd,
          month,
          l.billed,
          l.effective,
          l.currency,
          l.provider,
          l.service,
          l.category,
          l.resourceId,
          l.resourceName,
          l.subAccountId,
          l.chargeCategory,
          tagsText(l.tags),
          link.platformId,
          link.componentId,
          link.applicationId,
          o.importId ?? null,
          now,
        );
        out.inserted++;
      }
    }
    if (o.window) {
      const gone = [...existing.values()].filter((r) => !keys.has(r.line_key) && r.line_key);
      for (const r of gone) {
        if (r.charge_period_end <= r.read_at) correct(r.month, r.billing_currency, Number(r.effective_cost), 0);
        db().run('DELETE FROM cost_records WHERE id = ?', r.id);
        out.removed++;
      }
    }
    out.corrections = [...corr.values()]
      .sort((a, b) => (a.month + a.currency).localeCompare(b.month + b.currency))
      .map((c) => ({ month: c.month, currency: c.currency, before: fromMicros(c.before), after: fromMicros(c.after), lines: c.lines }));
    if (out.corrections.length)
      audit({
        action: 'cost.corrected',
        actor: o.actor,
        entityType: 'platform',
        entityId: o.sourcePlatformId,
        summary: `Costs of "${o.sourceName}" corrected by the source: ${out.corrections
          .slice(0, 6)
          .map((c) => `${c.month} ${c.currency} ${c.before} → ${c.after}`)
          .join(', ')}${out.corrections.length > 6 ? ' …' : ''}`,
        details: { source: o.source, importId: o.importId ?? null, corrections: out.corrections.slice(0, 50) },
      });
  });
  return out;
}

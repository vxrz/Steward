import { fromMicros, type CostGranularity, type CostSource } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { type AuthUser } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { canEditService } from '../records/access.js';
import { newId, nowIso, parseJson } from '../util.js';

/**
 * The cost model's store (#226, docs/COSTS.md#the-cost-model-focus): writing the lines of a source and linking them to
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
 * The tag that names the application: the cost source's setting; without one, an AWS account's variable tagKey (the
 * tag its components use) or "application".
 */
export function tagKeyOf(platformId: string): string {
  const own = db().get<{ tag_key: string }>('SELECT tag_key FROM cost_sources WHERE platform_id = ?', platformId)?.tag_key;
  if (own) return own;
  const p = db().get<{ config: string }>('SELECT config FROM platforms WHERE id = ?', platformId);
  const v = parseJson<{ variables?: Record<string, unknown> }>(p?.config, {}).variables ?? {};
  return String(v.tagKey ?? '').trim() || 'application';
}

/**
 * How the lines of a source platform are linked (docs/COSTS.md#mapping):
 *   1. Confluent Cloud: the cluster (ResourceId lkc-…) or, failing that, the environment (SubAccountId env-…) names the
 *      Kafka platform whose variable confluentClusterId (confluentEnvironmentId) matches – the cost belongs to that
 *      platform; its application is the one all Kafka topic components on it belong to, or the platform's own.
 *   2. The tag (cost source setting tagKey, default "application") names a component on the platform (an AWS cloud
 *      account's name is its tag value) or else an application by its name (case-insensitive, unique). FOCUS files
 *      (imported or pushed by a person, not read from the provider) link by name only to an application the importer
 *      may change (a push: the token's creator) or one tied to the platform (its own, or one with a component on it):
 *      nobody books costs on another team's application.
 *   3. The platform's own application (Catalogue → application → integrations).
 *   4. Otherwise the line stays unassigned – shown per platform as "unassigned".
 * The lookups are built once per mapper (maps by platform and name): a line costs the same however large the catalogue.
 */
export function mapper(sourcePlatformId: string, source: CostSource, importer: AuthUser | null = null): (l: MapInput) => Link {
  return mapperFor(mappingBase(sourcePlatformId, source), importer);
}

interface MappingBase {
  sourcePlatformId: string;
  source: CostSource;
  tagKey: string;
  own: Map<string, string>;
  /** components on a platform, by platform id and lower-case name */
  compsByName: Map<string, CompRow[]>;
  /** the applications of the Kafka topic components per platform */
  kafkaTopicApps: Map<string, Set<string>>;
  /** application id by lower-case name (null: a name two applications share) */
  appsByName: Map<string, string | null>;
  appOwners: Map<string, string>;
  /** applications tied to the source platform: its own, and those with a component on it */
  tied: Set<string>;
  kafka: { id: string; cluster: string; environment: string }[];
}

interface CompRow {
  id: string;
  application_id: string;
  name: string;
  type: string;
  platform_id: string;
}

function mappingBase(sourcePlatformId: string, source: CostSource): MappingBase {
  const own = new Map(
    db()
      .all<{ platform_id: string; application_id: string }>(
        'SELECT p.platform_id, p.application_id FROM application_platforms p JOIN applications a ON a.id = p.application_id WHERE a.archived = 0',
      )
      .map((r) => [r.platform_id, r.application_id]),
  );
  const compsByName = new Map<string, CompRow[]>();
  const kafkaTopicApps = new Map<string, Set<string>>();
  const tied = new Set<string>();
  const ownApp = own.get(sourcePlatformId);
  if (ownApp) tied.add(ownApp);
  for (const c of db().all<CompRow>(
    `SELECT c.id, c.application_id, c.name, c.type, c.platform_id FROM application_components c JOIN applications a ON a.id = c.application_id
      WHERE a.archived = 0 AND c.platform_id IS NOT NULL`,
  )) {
    const k = `${c.platform_id}\u0000${lower(c.name)}`;
    const list = compsByName.get(k);
    if (list) list.push(c);
    else compsByName.set(k, [c]);
    if (c.type === 'kafka-topic') kafkaTopicApps.set(c.platform_id, (kafkaTopicApps.get(c.platform_id) ?? new Set<string>()).add(c.application_id));
    if (c.platform_id === sourcePlatformId) tied.add(c.application_id);
  }
  const appsByName = new Map<string, string | null>();
  const appOwners = new Map<string, string>();
  for (const a of db().all<{ id: string; name: string; owners: string }>('SELECT id, name, owners FROM applications WHERE archived = 0')) {
    const k = lower(a.name);
    // a name two applications share links neither
    appsByName.set(k, appsByName.has(k) ? null : a.id);
    appOwners.set(a.id, a.owners);
  }
  const kafka =
    source === 'confluent'
      ? db()
          .all<{ id: string; config: string }>("SELECT id, config FROM platforms WHERE kind = 'kafka'")
          .map((p) => {
            const v = parseJson<{ variables?: Record<string, unknown> }>(p.config, {}).variables ?? {};
            return { id: p.id, cluster: String(v.confluentClusterId ?? '').trim(), environment: String(v.confluentEnvironmentId ?? '').trim() };
          })
      : [];
  return { sourcePlatformId, source, tagKey: tagKeyOf(sourcePlatformId), own, compsByName, kafkaTopicApps, appsByName, appOwners, tied, kafka };
}

function mapperFor(b: MappingBase, importer: AuthUser | null): (l: MapInput) => Link {
  const { sourcePlatformId, source, tagKey, own } = b;
  const compOn = (platformId: string, name: string) => {
    const hits = b.compsByName.get(`${platformId}\u0000${lower(name)}`);
    return hits?.length === 1 ? hits[0]! : null;
  };
  /** The application of a Kafka platform: the one all its topic components belong to, else its own. */
  const kafkaApp = (platformId: string): string | null => {
    const apps = b.kafkaTopicApps.get(platformId);
    if (apps?.size === 1) return [...apps][0]!;
    return own.get(platformId) ?? null;
  };
  // FOCUS files: an application by name only when tied to the platform or the importer may change it (asked once each)
  const mayLink = new Map<string, boolean>();
  const linkable = (appId: string): boolean => {
    if (source !== 'focus' || b.tied.has(appId)) return true;
    let ok = mayLink.get(appId);
    if (ok === undefined) {
      ok = canEditService(importer, { kind: 'application', id: appId, owners: parseJson<string[]>(b.appOwners.get(appId), []) });
      mayLink.set(appId, ok);
    }
    return ok;
  };
  return (l) => {
    let platformId = sourcePlatformId;
    if (source === 'confluent') {
      const byCluster = l.resourceId ? b.kafka.filter((k) => k.cluster && k.cluster === l.resourceId) : [];
      const byEnv = !byCluster.length && l.subAccountId ? b.kafka.filter((k) => k.environment && k.environment === l.subAccountId && !k.cluster) : [];
      const hit = byCluster.length === 1 ? byCluster[0] : byEnv.length === 1 ? byEnv[0] : undefined;
      if (hit) return { platformId: hit.id, componentId: null, applicationId: kafkaApp(hit.id) };
    }
    const tag = Object.hasOwn(l.tags, tagKey) ? String(l.tags[tagKey] ?? '').trim() : '';
    if (tag) {
      const c = compOn(platformId, tag);
      if (c) return { platformId, componentId: c.id, applicationId: c.application_id };
      const app = b.appsByName.get(lower(tag));
      if (app && linkable(app)) return { platformId, componentId: null, applicationId: app };
    }
    platformId = sourcePlatformId;
    return { platformId, componentId: null, applicationId: own.get(platformId) ?? null };
  };
}

/** Links many lines, giving the event loop a turn between chunks (a FOCUS file has up to 500,000 rows). */
export async function mapLines(map: (l: MapInput) => Link, lines: MapInput[], chunk = 5000): Promise<Link[]> {
  const out: Link[] = new Array<Link>(lines.length);
  for (let i = 0; i < lines.length; i++) {
    if (i && i % chunk === 0) await yieldToEventLoop();
    out[i] = map(lines[i]!);
  }
  return out;
}

/**
 * Who a FOCUS import links with (mapper above): the person who imported it, for a push the token's creator – as they
 * are now (their rights may have changed since). Unknown: nobody (only applications tied to the platform).
 */
function importers(sourcePlatformId: string): Map<string, AuthUser | null> {
  const out = new Map<string, AuthUser | null>();
  for (const r of db().all<{ id: string; via: string; actor: string; created_by: string | null }>(
    `SELECT i.id, i.via, i.actor, t.created_by FROM cost_imports i LEFT JOIN cost_push_tokens t ON t.id = i.token_id WHERE i.platform_id = ?`,
    sourcePlatformId,
  )) {
    const name = r.via === 'push' ? r.created_by : r.actor;
    const u = name ? findUserByName(name) : undefined;
    out.set(r.id, u ? toAuthUser(u) : null);
  }
  return out;
}

/**
 * Links every line of a source platform again (the catalogue changed: a new component, an application renamed). One
 * update per distinct tag set and resource (FOCUS files: and import) – not per line. Returns the lines whose link
 * changed.
 */
export function remap(sourcePlatformId: string, source: CostSource): number {
  const base = mappingBase(sourcePlatformId, source);
  const focus = source === 'focus';
  const who = focus ? importers(sourcePlatformId) : new Map<string, AuthUser | null>();
  const maps = new Map<string, (l: MapInput) => Link>();
  const mapOf = (importId: string) => {
    let m = maps.get(importId);
    if (!m) {
      m = mapperFor(base, who.get(importId) ?? null);
      maps.set(importId, m);
    }
    return m;
  };
  const groups = db().all<{
    tags: string;
    resource_id: string;
    sub_account_id: string;
    platform_id: string;
    component_id: string | null;
    application_id: string | null;
    import_id: string | null;
  }>(
    `SELECT DISTINCT tags, resource_id, sub_account_id, platform_id, component_id, application_id, ${focus ? 'import_id' : 'NULL AS import_id'}
       FROM cost_records WHERE source_platform_id = ? AND source = ?`,
    sourcePlatformId,
    source,
  );
  let changed = 0;
  db().tx(() => {
    for (const g of groups) {
      const map = mapOf(focus ? (g.import_id ?? '') : '');
      const link = map({ tags: parseJson<Record<string, string>>(g.tags, {}), resourceId: g.resource_id, subAccountId: g.sub_account_id });
      if (link.platformId === g.platform_id && link.componentId === g.component_id && link.applicationId === g.application_id) continue;
      changed += db().run(
        `UPDATE cost_records SET platform_id = ?, component_id = ?, application_id = ?
          WHERE source_platform_id = ? AND source = ? AND tags = ? AND resource_id = ? AND sub_account_id = ?${focus ? " AND COALESCE(import_id, '') = ?" : ''}`,
        link.platformId,
        link.componentId,
        link.applicationId,
        sourcePlatformId,
        source,
        g.tags,
        g.resource_id,
        g.sub_account_id,
        ...(focus ? [g.import_id ?? ''] : []),
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
  /** The links of `lines`, in their order (a FOCUS import links them before, with the importer's rights: mapLines) */
  links?: Link[];
}): IngestResult {
  const now = o.now ?? nowIso();
  const map = o.links ? null : mapper(o.sourcePlatformId, o.source);
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
    for (const [i, l] of o.lines.entries()) {
      const before = existing.get(l.key);
      const link = o.links ? o.links[i]! : map!(l);
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

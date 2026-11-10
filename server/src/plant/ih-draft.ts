import { z } from 'zod';
import { suggestFreshness, type PlantIhGroup, type PlantIhMapping } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso } from '../util.js';
import { requireManage } from './access.js';
import { ihMapping, ihPlatformOf, sinkOf } from './ih.js';
import { ihWatchIndex, storeLinks, type IhWatchCheck } from './ih-monitors.js';

/**
 * "Create monitor" from an Insights Hub mapping (0.14, docs/MONITORS.md "From an Insights Hub mapping"): only for the
 * variables no check watches yet, one freshness check per Insights Hub asset and aspect with those variables. The
 * allowance for late data comes from what Steward measured on the asset's other checks (the observed delay, 0.13);
 * the states follow the monitor with states the asset links to (its Off states keep the new checks quiet while the
 * machine is off as planned). The monitor is created **disabled** – a draft for review – and never enabled here. Its
 * checks are linked to the items they cover, so the monitor's page and the sink both show the coverage.
 */

export const ihMonitorInput = z
  .object({
    /** The asset/aspect groups to cover (default: every group with unwatched variables) */
    groups: z
      .array(z.object({ assetId: z.string().trim().min(1).max(200), aspect: z.string().trim().min(1).max(200) }).strict())
      .max(100)
      .optional(),
    name: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export interface IhMonitorResult {
  monitor: { id: string; key: string; name: string; enabled: boolean };
  checks: { id: string; assetId: string; aspect: string; variables: string[]; allowance: Allowance }[];
  items: number;
  /** The monitor whose states it follows (null: no states – add them before enabling) */
  follows: { monitorId: string; key: string; name: string } | null;
  mapping: PlantIhMapping;
}

interface Allowance {
  /** measured: the observed delay of a check on the same Insights Hub asset; peer: that check's own setting; none */
  source: 'measured' | 'peer' | 'none';
  seconds: number | null;
  from: { monitorId: string; checkId: string } | null;
}

type Freshness = { mode: 'cadence'; expectedIntervalSeconds: number } | { mode: 'maxAge'; maxAgeSeconds: number };

/** cadence for a collection read every interval, else (on change, on a trigger) a maximum age. */
const freshnessOf = (mode: string, intervalMs: number | null): Freshness =>
  mode === 'interval' && intervalMs && intervalMs > 0
    ? { mode: 'cadence', expectedIntervalSeconds: Math.min(86400, Math.max(1, Math.ceil(intervalMs / 1000))) }
    : { mode: 'maxAge', maxAgeSeconds: 900 };

/** The allowance (allowedDelaySeconds, or a maximum age for maxAge) from the asset's other checks: measured first. */
async function allowanceFor(
  g: PlantIhGroup,
  platformId: string,
  f: Freshness,
  index: IhWatchCheck[],
): Promise<{ allowance: Allowance; fields: Record<string, number> }> {
  const peers = index
    .filter((w) => w.platformId === platformId && w.assetId === g.assetId.toLowerCase())
    .sort((a, b) => Number(b.aspect === g.aspect) - Number(a.aspect === g.aspect));
  const { parseDelayState, summarizeDelay, delayIdentity } = await import('../monitors/delay.js');
  for (const w of peers) {
    const row = db().get<{ observed_delay: string | null }>(
      'SELECT observed_delay FROM monitor_checks WHERE monitor_id = ? AND check_id = ?',
      w.monitor.id,
      w.check.id,
    );
    const st = parseDelayState(row?.observed_delay);
    if (!st || st.id !== delayIdentity(w.check as unknown as Parameters<typeof delayIdentity>[0])) continue;
    const sum = summarizeDelay(st, w.intervalSeconds, Date.now());
    const s = sum ? suggestFreshness(sum, f) : null;
    if (!s) continue;
    const fields: Record<string, number> = {};
    for (const c of s.changes) if (c.to !== null) fields[c.field] = c.to;
    const seconds = fields.allowedDelaySeconds ?? fields.maxAgeSeconds ?? null;
    return { allowance: { source: 'measured', seconds, from: { monitorId: w.monitor.id, checkId: w.check.id } }, fields };
  }
  const peer = peers.find((w) => (w.check.allowedDelaySeconds ?? 0) > 0);
  if (peer)
    return {
      allowance: { source: 'peer', seconds: peer.check.allowedDelaySeconds!, from: { monitorId: peer.monitor.id, checkId: peer.check.id } },
      fields: { allowedDelaySeconds: peer.check.allowedDelaySeconds! },
    };
  return { allowance: { source: 'none', seconds: null, from: null }, fields: {} };
}

/** POST …/insights-hub/monitor */
export async function createIhMonitor(assetId: string, collectionId: string, sinkId: string, input: z.output<typeof ihMonitorInput>): Promise<IhMonitorResult> {
  const { perms, row, v, sink } = sinkOf(assetId, collectionId, sinkId);
  requireManage(perms, 'create a monitor for this mapping');
  const p = ihPlatformOf(sink);
  if (!p) throw new HttpError(409, 'The sink’s target is no Insights Hub platform', 'PLANT_SINK_NOT_IH', { sink: sinkId });
  const view = ihMapping(assetId, collectionId, sinkId);
  const groups = view.groups.filter(
    (g) => g.unwatched.length && (!input.groups || input.groups.some((x) => x.assetId.toLowerCase() === g.assetId.toLowerCase() && x.aspect === g.aspect)),
  );
  if (!groups.length)
    throw new HttpError(409, 'Every mapped variable is watched by a monitor check already – nothing to create', 'PLANT_IH_NOTHING_TO_WATCH', { sink: sinkId });
  // a target the last check found missing gets no check: there is nothing to read (fix the mapping first)
  const missing = new Set(
    view.items
      .filter((i) => i.target && i.check && ['asset_missing', 'aspect_missing', 'variable_missing'].includes(i.check.status))
      .map((i) => `${i.target!.assetId.toLowerCase()}\u0000${i.target!.aspect}\u0000${i.target!.variable}`),
  );
  const wanted = groups
    .map((g) => ({ g, variables: g.unwatched.filter((x) => !missing.has(`${g.assetId.toLowerCase()}\u0000${g.aspect}\u0000${x}`)) }))
    .filter((x) => x.variables.length);
  if (!wanted.length)
    throw new HttpError(
      409,
      'The variables no check watches were not found in Insights Hub by the last check – correct the mapping first',
      'PLANT_IH_NOTHING_TO_WATCH',
      {
        sink: sinkId,
        context: 'missing',
      },
    );
  const index = ihWatchIndex();
  const f = freshnessOf(v.mode, v.intervalMs);
  const checks: IhMonitorResult['checks'] = [];
  const defs: Record<string, unknown>[] = [];
  for (const [i, { g, variables: all }] of wanted.slice(0, 100).entries()) {
    const id = `ih-${i + 1}`;
    const { allowance, fields } = await allowanceFor(g, p.id, f, index);
    const variables = all.slice(0, 50);
    checks.push({ id, assetId: g.assetId, aspect: g.aspect, variables, allowance });
    defs.push({
      id,
      name: `${g.assetName || g.assetId} – ${g.aspect} in Insights Hub`.slice(0, 120),
      type: 'freshness',
      source: 'insightsHub',
      platform: p.id,
      assetId: g.assetId,
      aspect: g.aspect,
      variables,
      ...f,
      ...fields,
      x: (i % 4) * 200,
      y: Math.floor(i / 4) * 160,
    });
  }
  // the states of the monitor the asset links to: Off there means the new checks are expected down
  const leader = view.leader;
  const states = leader
    ? {
        from: leader.key,
        cases: leader.states.map((s) => ({
          id: s.id,
          name: s.name,
          ...(s.off ? { status: 'off' } : {}),
          expect: Object.fromEntries(checks.map((c) => [c.id, s.off ? 'down' : 'up'])),
        })),
      }
    : undefined;
  const name = input.name ?? `${row.name} – ${sink.name} (${v.name})`.slice(0, 160);
  const definition = {
    name,
    description: [
      `Draft made from the Insights Hub mapping of the data collection "${v.name}" of the plant asset "${row.name}" (sink "${sink.name}"): it watches the mapped variables no other check watched.`,
      leader
        ? `It follows the states of "${leader.name}": while that monitor is off, these checks are expected to fail. Review the expected statuses.`
        : 'No monitor with states is linked to the asset: add states (or link the asset to the monitor that knows when the machine is off) before enabling it, so planned off times stay quiet.',
      checks.some((c) => c.allowance.source === 'none')
        ? 'Some checks have no measured delay yet: enable them with a short interval and apply the suggestion of the observed delay after a day.'
        : 'The allowance for late data comes from the observed delay of the asset’s other checks.',
      'Review it, then enable it.',
    ].join('\n\n'),
    tags: ['insights-hub', 'plant'],
    intervalSeconds: 60,
    checks: defs,
    ...(states ? { states } : {}),
  };
  const svc = await import('../monitors/service.js');
  // never enabled here: a draft for review
  const saved = await svc.createMonitor({ enabled: false, definition });
  const at = nowIso();
  const by = me().username;
  const links = checks.flatMap((c) =>
    view.items
      .filter(
        (it) =>
          it.target && it.target.assetId.toLowerCase() === c.assetId.toLowerCase() && it.target.aspect === c.aspect && c.variables.includes(it.target.variable),
      )
      .map((it) => ({ item: it.item, monitorId: saved.monitor.id, checkId: c.id })),
  );
  db().tx(() => {
    storeLinks(assetId, collectionId, sinkId, links, 'created', by, at);
    audit({
      action: 'plant.ih_monitor_created',
      entityType: 'asset',
      entityId: assetId,
      summary: `Monitor "${saved.monitor.name}" created (disabled) from the Insights Hub mapping of sink "${sink.name}" (collection "${v.name}") of asset "${row.name}": ${checks.length} checks for ${links.length} items`,
      details: {
        collection: collectionId,
        sink: sinkId,
        monitor: saved.monitor.id,
        checks: checks.map((c) => ({ id: c.id, assetId: c.assetId, aspect: c.aspect, variables: c.variables, allowance: c.allowance.source })),
        items: links.length,
        follows: leader?.monitorId ?? null,
      },
    });
  });
  return {
    monitor: { id: saved.monitor.id, key: saved.monitor.key, name: saved.monitor.name, enabled: saved.monitor.enabled },
    checks,
    items: links.length,
    follows: leader ? { monitorId: leader.monitorId, key: leader.key, name: leader.name } : null,
    mapping: ihMapping(assetId, collectionId, sinkId),
  };
}

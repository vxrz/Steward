import {
  PLANT_IH_LIMITS as IL,
  type Platform,
  type PlantIhCheckRun,
  type PlantIhItemCheck,
  type PlantIhItemStatus,
  type PlantIhMapping,
  type PlantIhRunError,
  unitRelation,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { getConnection } from '../platforms/service.js';
import { platformRequest, type HttpResult } from '../platforms/http.js';
import { HttpError, nowIso } from '../util.js';
import { requireManage } from './access.js';
import { ihMapping, ihPlatformOf, platformUseProblem, sinkOf } from './ih.js';
import { ihWatchIndex, storeDetectedLinks, watching } from './ih-monitors.js';

/**
 * "Check mapping" (0.14, docs/PLANT.md "Insights Hub mapping"): reads the tenant – never writes – with the platform's
 * default identity, as the person who asks, and reports per item whether its asset exists, the aspect is on it and the
 * variable is in the aspect's type, with the unit and type compared to the data point's as hints only. It does not
 * look at the asset hierarchy: it differs from the plant's ISA-95 hierarchy on purpose.
 *
 * Bounded: at most PLANT_IH_LIMITS.assetsPerRun assets per run (the others are "not checked"), their aspects in pages
 * of PLANT_IH_LIMITS.aspectPage (at most aspectPages pages), each asset and aspect type read once per run. A 401 or 403
 * stops the run (every later read would fail the same way), so does a 429 after the platform's own retries.
 */

interface IhVariable {
  name: string;
  dataType: string;
  unit: string;
}
interface IhAspect {
  name: string;
  aspectTypeId: string;
  variables: IhVariable[] | null;
}

class StopRun extends Error {
  constructor(
    public code: PlantIhRunError,
    message: string,
    public status?: number,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

const vars = (x: unknown): IhVariable[] | null =>
  Array.isArray(x)
    ? (x as Record<string, unknown>[]).map((v) => ({ name: String(v?.name ?? ''), dataType: String(v?.dataType ?? ''), unit: String(v?.unit ?? '') }))
    : null;

/** Type families of a data point's type and an Insights Hub variable's dataType; a hint only where both are known. */
const family = (t: string): string | null => {
  const x = t.trim().toLowerCase();
  if (!x) return null;
  if (/^(u?s?int\d*|u?dint|u?lint|word|dword|lword|short|long|byte|integer|int)$/.test(x)) return 'int';
  if (/^(float\d*|double|real|lreal|decimal|number)$/.test(x)) return 'float';
  if (/^(bool|boolean|bit)$/.test(x)) return 'bool';
  if (/^(string|big_string|text|char|wstring)$/.test(x)) return 'string';
  if (/^(timestamp|datetime|date|time)$/.test(x)) return 'timestamp';
  return null;
};
/** int fits a float variable; every other difference is a hint. */
const typeDiffers = (point: string, ih: string) => {
  const a = family(point);
  const b = family(ih);
  return !!a && !!b && a !== b && !(a === 'int' && b === 'float');
};

function retryAfter(r: HttpResult): number | undefined {
  const h = r.headers['retry-after'];
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n));
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.round((at - Date.now()) / 1000));
}

/** Stops on the answers that make every further read fail. */
function stopOn(r: HttpResult, platform: Platform): void {
  if (r.status === 401) throw new StopRun('unauthorized', `"${platform.name}" refused the credentials (HTTP 401): check the identity's client`, 401);
  if (r.status === 403)
    throw new StopRun('forbidden', `"${platform.name}" answered 403: the identity may not read Asset Management (it needs a role that reads assets)`, 403);
  if (r.status === 429) {
    const after = retryAfter(r);
    throw new StopRun(
      'rate_limited',
      `"${platform.name}" limits the requests (HTTP 429)${after !== undefined ? ` – try again in ${after} s` : ''}`,
      429,
      after,
    );
  }
}

/** POST …/insights-hub/check */
export async function checkIhMapping(assetId: string, collectionId: string, sinkId: string): Promise<PlantIhMapping> {
  const { perms, row, v, sink } = sinkOf(assetId, collectionId, sinkId);
  requireManage(perms, 'check this mapping');
  const p = ihPlatformOf(sink);
  if (!p) throw new HttpError(409, 'The sink’s target is no Insights Hub platform', 'PLANT_SINK_NOT_IH', { sink: sinkId });
  const problem = platformUseProblem(p.id);
  if (problem) throw new HttpError(403, problem, 'FORBIDDEN', { context: 'platformUse', platform: p.id });
  let conn: ReturnType<typeof getConnection>;
  try {
    conn = getConnection(p.id);
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(409, String(e), 'PLATFORM_UNAVAILABLE');
  }
  const { platform, secrets } = conn;
  const assetPath = String(platform.config.variables?.assetPath || '/api/assetmanagement/v3').replace(/\/+$/, '');
  const view = ihMapping(assetId, collectionId, sinkId);
  const mapped = view.items.filter((i) => i.target);

  let requests = 0;
  const get = async (url: string, query?: Record<string, unknown>): Promise<HttpResult> => {
    requests++;
    try {
      return await platformRequest(platform, secrets, { method: 'GET', url, query, maxResponseBytes: 4 * 1024 * 1024 });
    } catch (e) {
      throw new StopRun('failed', `The read failed: ${(e as Error).message}`.slice(0, 300));
    }
  };

  // each asset once: does it exist, and its aspects with their variables
  const assetIds = [...new Set(mapped.map((i) => i.target!.assetId))];
  const read = assetIds.slice(0, IL.assetsPerRun);
  const assets = new Map<string, { name: string; aspects: Map<string, IhAspect> } | null>();
  const aspectTypes = new Map<string, IhVariable[] | null>();
  let stop: StopRun | null = null;
  try {
    for (const id of read) {
      const a = await get(`${assetPath}/assets/${encodeURIComponent(id)}`);
      stopOn(a, platform);
      if (a.status === 404) {
        assets.set(id, null);
        continue;
      }
      if (!a.ok) throw new StopRun('failed', `"${platform.name}" answered HTTP ${a.status} for an asset`, a.status);
      const name = String((a.body as { name?: unknown })?.name ?? '');
      const aspects = new Map<string, IhAspect>();
      for (let page = 0; page < IL.aspectPages; page++) {
        const r = await get(`${assetPath}/assets/${encodeURIComponent(id)}/aspects`, { page, size: IL.aspectPage });
        stopOn(r, platform);
        if (!r.ok) throw new StopRun('failed', `"${platform.name}" answered HTTP ${r.status} for the aspects of an asset`, r.status);
        const body = r.body as { _embedded?: { aspects?: Record<string, unknown>[] }; page?: { totalPages?: number } };
        for (const x of body?._embedded?.aspects ?? [])
          aspects.set(String(x.name ?? ''), { name: String(x.name ?? ''), aspectTypeId: String(x.aspectTypeId ?? ''), variables: vars(x.variables) });
        if (page + 1 >= Number(body?.page?.totalPages ?? 1)) break;
      }
      // an aspect without its variables: its aspect type has them (read once per run)
      for (const asp of aspects.values()) {
        if (asp.variables || !asp.aspectTypeId) continue;
        if (!aspectTypes.has(asp.aspectTypeId)) {
          if (aspectTypes.size >= IL.aspectTypes) break;
          const t = await get(`${assetPath}/aspecttypes/${encodeURIComponent(asp.aspectTypeId)}`);
          stopOn(t, platform);
          aspectTypes.set(asp.aspectTypeId, t.ok ? vars((t.body as { variables?: unknown })?.variables) : null);
        }
        asp.variables = aspectTypes.get(asp.aspectTypeId) ?? null;
      }
      assets.set(id, { name, aspects });
    }
  } catch (e) {
    if (!(e instanceof StopRun)) throw e;
    stop = e;
  }

  const results: PlantIhItemCheck[] = [];
  const counts: Partial<Record<PlantIhItemStatus, number>> = {};
  for (const it of mapped) {
    const t = it.target!;
    const base = { item: it.item, assetId: t.assetId, aspect: t.aspect, variable: t.variable };
    let r: PlantIhItemCheck;
    if (!assets.has(t.assetId)) r = { ...base, status: stop ? 'failed' : 'not_checked' };
    else {
      const a = assets.get(t.assetId);
      const asp = a?.aspects.get(t.aspect);
      const variable = asp?.variables?.find((x) => x.name === t.variable);
      if (!a) r = { ...base, status: 'asset_missing' };
      else if (!asp) r = { ...base, status: 'aspect_missing', assetName: a.name };
      else if (!variable) r = { ...base, status: 'variable_missing', assetName: a.name };
      else {
        const pu = it.dataPoint?.unit ?? '';
        const pt = it.dataPoint?.dataType ?? '';
        // the usual spellings read as one (rpm is /min, kWh is kW.h – the KPI units of 0.12)
        const unit = pu && variable.unit && unitRelation(pu, variable.unit) !== 'same' ? { point: pu, ih: variable.unit } : undefined;
        const type = typeDiffers(pt, variable.dataType) ? { point: pt, ih: variable.dataType } : undefined;
        r = { ...base, status: unit ? 'unit_differs' : type ? 'type_differs' : 'ok', assetName: a.name, ...(unit ? { unit } : {}), ...(type ? { type } : {}) };
      }
    }
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    results.push(r);
  }
  const at = nowIso();
  const by = me().username;
  const run: PlantIhCheckRun = {
    checkedAt: at,
    checkedBy: by,
    platformId: p.id,
    identity: platform.identityName ?? '',
    counts,
    assets: assets.size,
    requests,
    capped: assetIds.length > read.length,
    error: stop
      ? {
          code: stop.code,
          message: stop.message,
          ...(stop.status ? { status: stop.status } : {}),
          ...(stop.retryAfterSeconds !== undefined ? { retryAfterSeconds: stop.retryAfterSeconds } : {}),
        }
      : null,
  };
  // the names Insights Hub has for the assets, kept for display where the mapping has none (no hierarchy compared)
  db().tx(() => {
    db().run(
      `INSERT INTO plant_ih_checks (asset_id, collection_id, sink_id, platform_id, checked_at, checked_by, run, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (asset_id, collection_id, sink_id) DO UPDATE SET platform_id = excluded.platform_id, checked_at = excluded.checked_at,
         checked_by = excluded.checked_by, run = excluded.run, items = excluded.items`,
      assetId,
      collectionId,
      sinkId,
      p.id,
      at,
      by,
      JSON.stringify(run),
      JSON.stringify(results),
    );
    // the monitor checks that watch the items now (also those the reader may not see): stored, so the monitor's page
    // tells what it covers
    const index = ihWatchIndex();
    storeDetectedLinks(
      assetId,
      collectionId,
      sinkId,
      mapped.flatMap((i) =>
        watching(index, p.id, i.target!.assetId, i.target!.aspect, i.target!.variable).map((w) => ({
          item: i.item,
          monitorId: w.monitor.id,
          checkId: w.check.id,
        })),
      ),
      by,
      at,
    );
    audit({
      action: 'plant.ih_mapping_checked',
      entityType: 'asset',
      entityId: assetId,
      summary: `Insights Hub mapping of sink "${sink.name}" (collection "${v.name}") of asset "${row.name}" checked: ${results.filter((x) => x.status === 'ok').length} of ${results.length} items ok${stop ? ` – stopped: ${stop.code}` : ''}`,
      details: {
        collection: collectionId,
        sink: sinkId,
        platform: p.id,
        identity: run.identity,
        counts,
        assets: run.assets,
        requests,
        capped: run.capped,
        error: run.error?.code ?? null,
      },
    });
  });
  return ihMapping(assetId, collectionId, sinkId);
}

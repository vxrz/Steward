import { type Platform } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { audit } from '../audit.js';
import { vault } from '../vault.js';
import { currentActor } from '../auth/context.js';
import { platformFor } from '../monitors/platforms.js';
import { HttpError } from '../util.js';
import { costSettings, requireScope } from './access.js';
import { aiLines, awsLines, awsWindow, confluentLines, confluentRanges, readFrom, snowflakeCosts, type ConfluentCost } from './readers.js';
import { noteRead, sourceOfKind, sourceRow } from './service.js';
import { ingest, remap, type IngestResult } from './store.js';

/**
 * Reading the connectors' costs into the cost model (#226): once a day for AWS, Snowflake and Confluent Cloud (their
 * figures change for up to 72 hours and until the month is closed – each read re-reads the last 35 days, the AWS read
 * the last 12 months), hourly for the AI gateways (their usage log is local). A source is read with the rights of who
 * last changed its settings (they must still be allowed to use the platform). Every call goes through the platform's
 * own client and so through the outbound policy.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INTERVAL: Record<string, number> = { aws: DAY, snowflake: DAY, confluent: DAY, ai: HOUR };

/** AWS lines read by aws/service.ts (component reads and the cost job): written into the model, the last 13 months. */
export function ingestAws(
  p: Platform,
  lines: { month: string; tag: string; service: string; amount: string; unit: string }[],
  tagKey: string,
  actor: string,
  now = Date.now(),
): IngestResult | null {
  const window = awsWindow(lines);
  if (!window) return null;
  const at = new Date(now).toISOString();
  const r = ingest({ sourcePlatformId: p.id, sourceName: p.name, source: 'aws', lines: awsLines(lines, tagKey), window, actor, now: at });
  noteRead(p.id, { error: null, note: 'Cost Explorer GetCostAndUsage (UnblendedCost, by tag and service)', at });
  return r;
}

export interface ReadOutcome {
  source: string;
  lines: number;
  result: IngestResult | null;
  note: string | null;
  error: string | null;
}

/** Reads one platform's costs now (the job, or "Read now" by who may manage it). */
export async function readSource(platformId: string, actor: string, now = Date.now()): Promise<ReadOutcome> {
  const { platform, secrets } = platformFor(actor, platformId);
  const source = sourceOfKind(platform.kind);
  const at = new Date(now).toISOString();
  try {
    if (source === 'aws') {
      const { readAwsCosts } = await import('../aws/service.js');
      const r = await readAwsCosts(platformId, actor, now);
      if (r.error) throw new Error(r.error);
      return { source, lines: 0, result: null, note: 'Cost Explorer GetCostAndUsage (UnblendedCost, by tag and service)', error: null };
    }
    if (source === 'snowflake') {
      const { snowflakeClient } = await import('../snowflake/service.js');
      const from = readFrom(platformId, source, now);
      const row = sourceRow(platformId);
      const r = await snowflakeCosts(snowflakeClient(platform, secrets), platform, from, {
        price: row?.credit_price ?? null,
        currency: row?.credit_currency ?? null,
      });
      const result = ingest({
        sourcePlatformId: platformId,
        sourceName: platform.name,
        source,
        lines: r.lines,
        window: { from: `${from}T00:00:00.000Z`, to: new Date(now + DAY).toISOString() },
        actor,
        now: at,
      });
      noteRead(platformId, { error: null, note: r.note, at });
      return { source, lines: r.lines.length, result, note: r.note, error: null };
    }
    if (source === 'confluent') {
      const { confluentPages } = await import('../kafka/confluent.js');
      const from = readFrom(platformId, source, now);
      const ranges = confluentRanges(from, now);
      const items: ConfluentCost[] = [];
      for (const r of ranges) {
        try {
          items.push(
            ...(await confluentPages<ConfluentCost>(platform, secrets, '/billing/v1/costs', { start_date: r.start, end_date: r.end }, 'The Costs API')),
          );
        } catch (e) {
          const m = (e as Error).message;
          // the Costs API needs another role than the access reviews
          throw new Error(m.includes('HTTP 403') ? 'The Costs API answered HTTP 403 – the Cloud API key needs the OrganizationAdmin or BillingAdmin role' : m);
        }
      }
      const lines = confluentLines(items);
      const result = ranges.length
        ? ingest({
            sourcePlatformId: platformId,
            sourceName: platform.name,
            source,
            lines,
            window: { from: `${ranges[0]!.start}T00:00:00.000Z`, to: `${ranges.at(-1)!.end}T00:00:00.000Z` },
            actor,
            now: at,
          })
        : null;
      const note = 'Costs API GET /billing/v1/costs (daily, US dollars)';
      noteRead(platformId, { error: null, note, at });
      return { source, lines: lines.length, result, note, error: null };
    }
    if (source === 'ai') {
      const from = readFrom(platformId, source, now);
      const currency = sourceRow(platformId)?.currency ?? costSettings().defaultCurrency;
      const lines = aiLines(platformId, from, currency);
      const result = ingest({
        sourcePlatformId: platformId,
        sourceName: platform.name,
        source,
        lines,
        window: { from: `${from}T00:00:00.000Z`, to: new Date(now + DAY).toISOString() },
        actor,
        now: at,
      });
      const note = `The usage log's costs (prices on the models, ${currency})`;
      noteRead(platformId, { error: null, note, at });
      return { source, lines: lines.length, result, note, error: null };
    }
    throw new HttpError(400, `"${platform.name}" has no cost connector – import FOCUS files for it`, 'COST_SOURCE_NO_CONNECTOR');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const error = (e as Error).message.slice(0, 500);
    noteRead(platformId, { error, at });
    return { source, lines: 0, result: null, note: null, error };
  }
}

/** "Read now" (who may manage the platform). AWS keeps to one read a day – Cost Explorer charges every request. */
export async function readNow(platformId: string): Promise<ReadOutcome> {
  const info = requireScope('platform', platformId);
  if (!info.canManageSource)
    throw new HttpError(403, 'You are not allowed to read the costs of this platform', 'PLATFORM_MANAGE_FORBIDDEN', { name: info.name });
  const out = await readSource(platformId, currentActor());
  audit({
    action: 'cost.read',
    entityType: 'platform',
    entityId: platformId,
    summary: `Costs of "${info.name}" read now: ${out.error ? `failed – ${out.error.slice(0, 200)}` : `${out.lines} line(s)${out.result?.corrections.length ? `, ${out.result.corrections.length} correction(s)` : ''}`}`,
    details: { source: out.source, lines: out.lines, note: out.note, error: out.error },
  });
  return out;
}

/**
 * The job "costs": reads the sources that are due, links every source's lines again (the catalogue may have changed)
 * once a day, and leaves budgets and notices to budgets.ts. Returns how many sources were read.
 */
export async function runCostJob(now = Date.now()): Promise<{ read: number; failed: number; remapped: number }> {
  if (!vault().unlocked) return { read: 0, failed: 0, remapped: 0 };
  let read = 0;
  let failed = 0;
  const rows = db().all<{ platform_id: string; kind: string; updated_by: string; last_read_at: string | null }>(
    `SELECT s.platform_id, p.kind, s.updated_by, s.last_read_at FROM cost_sources s JOIN platforms p ON p.id = s.platform_id WHERE s.enabled = 1 ORDER BY s.platform_id`,
  );
  for (const r of rows) {
    const source = sourceOfKind(r.kind);
    const every = INTERVAL[source];
    if (!every) continue;
    if (r.last_read_at && now - Date.parse(r.last_read_at) < every && Date.parse(r.last_read_at) <= now) continue;
    try {
      const out = await readSource(r.platform_id, r.updated_by, now);
      if (out.error) failed++;
      else read++;
    } catch (err) {
      failed++;
      noteRead(r.platform_id, { error: (err as Error).message, at: new Date(now).toISOString() });
      logger.warn({ err, platform: r.platform_id }, 'reading platform costs failed');
    }
  }
  // the catalogue may have changed (a new component, an application renamed): link every source's lines again, daily
  let remapped = 0;
  const last = lastRemap;
  if (!last || now - last >= DAY) {
    lastRemap = now;
    for (const s of db().all<{ source_platform_id: string; source: string }>('SELECT DISTINCT source_platform_id, source FROM cost_records'))
      remapped += remap(s.source_platform_id, s.source as Parameters<typeof remap>[1]);
  }
  return { read, failed, remapped };
}
let lastRemap = 0;

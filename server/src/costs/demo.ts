import { AWS_KIND, CONFLUENT_KIND, LLM_GATEWAY_KIND, SNOWFLAKE_KIND } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { nowIso } from '../util.js';
import { readSource } from './sources.js';
import { tagKeyOf } from './store.js';

/**
 * Demo costs (#226): the cost sources of the demo platforms – AWS (demo), Snowflake (demo), Confluent Cloud (demo) and
 * LLM gateway (demo) – turned on and read once, so the costs pages, the budget and the reports have figures. The
 * mocks answer like the real APIs (Cost Explorer, USAGE_IN_CURRENCY_DAILY, the Costs API).
 */
export async function setupCostDemo(actor: string): Promise<number> {
  const rows = db().all<{ id: string; kind: string }>(
    `SELECT id, kind FROM platforms WHERE name LIKE '%(demo)' AND kind IN (?, ?, ?, ?) ORDER BY name`,
    AWS_KIND,
    SNOWFLAKE_KIND,
    CONFLUENT_KIND,
    LLM_GATEWAY_KIND,
  );
  let read = 0;
  for (const p of rows) {
    if (db().get('SELECT platform_id FROM cost_sources WHERE platform_id = ? AND enabled = 1', p.id)) continue;
    const now = nowIso();
    db().run(
      `INSERT INTO cost_sources (platform_id, enabled, tag_key, currency, updated_at, updated_by) VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT (platform_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      p.id,
      tagKeyOf(p.id),
      p.kind === LLM_GATEWAY_KIND ? 'USD' : null,
      now,
      actor,
    );
    try {
      const r = await readSource(p.id, actor);
      if (r.error) logger.warn({ platform: p.id, error: r.error }, 'demo costs not read');
      else read++;
    } catch (err) {
      logger.warn({ err: (err as Error).message, platform: p.id }, 'demo costs not read');
    }
  }
  return read;
}

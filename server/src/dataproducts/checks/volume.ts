import type { CheckOf, Platform } from '@sm/shared';
import { db } from '../../db.js';
import type { SnowflakeClient } from '../../snowflake/client.js';
import { recordQualityResult } from '../quality.js';
import type { ElementRow } from '../store.js';
import { snowflakeIdent, snowflakeParts, type CheckResult } from './freshness.js';

/**
 * Volume of an element by metadata (0.24.0, ADR 0036 part 10 phase 2): Snowflake `ROW_COUNT` or `BYTES` of
 * `<db>.INFORMATION_SCHEMA.TABLES` (the same catalogue row as freshness – never a SELECT on the table), a Kafka topic's
 * messages from its end offsets (ListOffsets – no consumer group, no message read). Each reading is kept
 * (`dp_volume_readings`, at most one per 5 minutes, 8 days) and compared with the newest reading at least
 * `windowMinutes` old: below `minRows`, grown by less than `minGrowth` (stalled) or changed by more than
 * `maxChangePct` in either direction is `failAs`. The verdict is also a completeness quality result (quality.ts).
 */

type Check = CheckOf<'data-element'>;
const MINUTE = 60_000;
const KEEP_MS = 8 * 24 * 60 * MINUTE;
const STORE_EVERY_MS = 5 * MINUTE;

const fmt = (n: number): string => n.toLocaleString('en-GB');

/** The newest reading at least `windowMs` old, and whether one younger than STORE_EVERY_MS exists. */
function readingsOf(elementId: string, measure: string, now: number, windowMs: number): { before: { value: number; at: string } | null; recent: boolean } {
  const before = db().get<{ value: number | string; read_at: string }>(
    'SELECT value, read_at FROM dp_volume_readings WHERE element_id = ? AND measure = ? AND read_at <= ? ORDER BY read_at DESC LIMIT 1',
    elementId,
    measure,
    new Date(now - windowMs).toISOString(),
  );
  const recent = !!db().get('SELECT 1 FROM dp_volume_readings WHERE element_id = ? AND measure = ? AND read_at > ?', elementId, measure, new Date(now - STORE_EVERY_MS).toISOString());
  return { before: before ? { value: Number(before.value), at: before.read_at } : null, recent };
}

function store(elementId: string, measure: string, value: number, now: number, recent: boolean): void {
  if (recent) return;
  db().tx(() => {
    db().run('INSERT INTO dp_volume_readings (element_id, measure, read_at, value) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', elementId, measure, new Date(now).toISOString(), value);
    db().run('DELETE FROM dp_volume_readings WHERE element_id = ? AND measure = ? AND read_at < ?', elementId, measure, new Date(now - KEEP_MS).toISOString());
  });
}

/** The verdict on a reading (pure; exported for the tests). */
export function judgeVolume(
  c: Pick<Check, 'minRows' | 'minGrowth' | 'maxChangePct' | 'failAs'>,
  what: string,
  unit: string,
  value: number,
  before: { value: number; at: string } | null,
): CheckResult {
  const v: Record<string, unknown> = { value, before: before?.value ?? null, beforeAt: before?.at ?? null };
  const problems: string[] = [];
  if (c.minRows !== undefined && value < c.minRows) problems.push(`${fmt(value)} ${unit} (at least ${fmt(c.minRows)})`);
  let change = '';
  if (before) {
    const delta = value - before.value;
    v.change = delta;
    change = `${delta >= 0 ? '+' : ''}${fmt(delta)} ${unit} since ${before.at.slice(0, 16).replace('T', ' ')} UTC`;
    if (c.minGrowth !== undefined && delta < c.minGrowth) problems.push(`grew by ${fmt(delta)} ${unit} (at least ${fmt(c.minGrowth)})`);
    if (c.maxChangePct !== undefined && before.value > 0) {
      const pct = Math.round((Math.abs(delta) / before.value) * 10_000) / 100;
      v.changePct = pct;
      if (pct > c.maxChangePct) problems.push(`changed by ${pct} % (at most ${c.maxChangePct} %)`);
    }
  }
  if (problems.length) return { status: c.failAs, message: `${what}: ${problems.join('; ')}`, value: v };
  return {
    status: 'up',
    message: `${what}: ${fmt(value)} ${unit}${change ? `, ${change}` : before ? '' : ' – the first reading; the change is judged once a window has passed'}`,
    value: v,
  };
}

function finish(c: Check, el: ElementRow, measure: string, unit: string, what: string, value: number, now: number): CheckResult {
  const { before, recent } = readingsOf(el.id, measure, now, (c.windowMinutes ?? 60) * MINUTE);
  const r = judgeVolume(c, what, unit, value, before);
  store(el.id, measure, value, now, recent);
  recordQualityResult({
    elementId: el.id,
    source: 'check',
    name: `volume:${measure}`,
    dimension: 'completeness',
    status: r.status === 'up' ? 'passed' : 'failed',
    value,
    message: r.message,
    observedAt: new Date(now).toISOString(),
  });
  return r;
}

/** Volume of a Snowflake table or dynamic table: one row of its database's INFORMATION_SCHEMA.TABLES. */
export async function snowflakeVolume(c: Check, el: ElementRow, sf: SnowflakeClient, now: number): Promise<CheckResult> {
  const parts = snowflakeParts(el.qualified_name);
  if (!parts || parts.length !== 3) return { status: 'unknown', message: `"${el.qualified_name}" is not DATABASE.SCHEMA.TABLE` };
  const [d, s, t] = parts as [string, string, string];
  const [row] = await sf.query(`/* steward:dp-table-volume */ SELECT ROW_COUNT, BYTES FROM IDENTIFIER(?) WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [
    `${snowflakeIdent(d)}.INFORMATION_SCHEMA.TABLES`,
    s,
    t,
  ]);
  const measure = c.measure ?? 'rows';
  const raw = measure === 'bytes' ? row?.BYTES : row?.ROW_COUNT;
  if (!row || raw === null || raw === undefined || !Number.isFinite(Number(raw)))
    return { status: 'unknown', message: `Snowflake: no ${measure === 'bytes' ? 'size' : 'row count'} of ${parts.join('.')} (no such table, a view, or no access to its metadata)` };
  return finish(c, el, measure, measure === 'bytes' ? 'bytes' : 'rows', `Snowflake: ${parts.join('.')}`, Number(raw), now);
}

/** Volume of a Kafka topic: the sum of its partitions' end offsets (messages written so far). */
export async function kafkaVolume(c: Check, el: ElementRow, platform: Platform, secrets: Record<string, string>, now: number): Promise<CheckResult> {
  if (platform.kind !== 'kafka') return { status: 'unknown', message: `"${platform.name}" is not a Kafka platform` };
  if ((c.measure ?? 'rows') === 'bytes') return { status: 'unknown', message: 'Kafka: the size of a topic is not read – measure its messages' };
  const { withKafka, kafkaError } = await import('../../kafka/client.js');
  let ends: { end: number }[];
  try {
    ends = await withKafka(platform, secrets, (k) => k.ends(el.qualified_name));
  } catch (e) {
    return { status: 'unknown', message: `Kafka could not be read: ${kafkaError(e)}`.slice(0, 500) };
  }
  if (!ends.length) return { status: 'unknown', message: `Kafka: no topic "${el.qualified_name}"` };
  return finish(c, el, 'offsets', 'messages', `Kafka: ${el.qualified_name}`, ends.reduce((n, e) => n + e.end, 0), now);
}

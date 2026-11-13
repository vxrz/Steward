import { DATA_PRODUCT_LIMITS, type CheckOf, type MonitorStatus, type Platform } from '@sm/shared';
import { db } from '../../db.js';
import { ISO, SnowflakeClient, type Row } from '../../snowflake/client.js';
import { descendantsOf, elementsByIds, type ElementRow } from '../store.js';

/**
 * Freshness of an element by metadata (ADR 0036 part 10, decision 13): never a data value, never a SELECT on a user
 * table. Snowflake: `LAST_ALTERED` of `<db>.INFORMATION_SCHEMA.TABLES` (it also moves on DDL and background
 * maintenance – _changed_, not _loaded_), the data timestamp of a dynamic table's last successful refresh
 * (`DYNAMIC_TABLE_REFRESH_HISTORY`), a task's last successful run (`TASK_HISTORY`, the last 7 days), a schema's or a
 * database's newest (any) or oldest (every) table. Kafka: the newest message's time (ListOffsets by max timestamp,
 * Kafka 3.0+; else end offsets that stop moving), optionally a consumer group's lag; a bundle's topics any or every.
 *
 * Names go into statements as bindings; the database of an INFORMATION_SCHEMA table function is an identifier, checked
 * against a strict pattern and quoted (snowflakeIdent).
 */

export type CheckResult = { status: MonitorStatus; message: string; value?: unknown };
type Check = CheckOf<'data-element'>;

const STATUS_RANK: Record<string, number> = { up: 0, degraded: 1, unknown: 1, down: 2 };
export const worse = (a: MonitorStatus, b: MonitorStatus): MonitorStatus => ((STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a);

// ---------- Snowflake names ----------

/** One part of a name: letters, digits, _, $ and - (quoted parts keep their case; unquoted ones are upper case). */
const PART_RE = /^[A-Za-z0-9_$-]{1,255}$/;
const PLAIN_RE = /^[A-Z_][A-Z0-9_$]*$/;

/**
 * The parts of a qualified Snowflake name (`SHOP.SALES.ORDERS`, `"Shop"."Sales"."Orders"`) as Snowflake stores them, or
 * null when a part has characters Steward does not put into a statement.
 */
export function snowflakeParts(qualifiedName: string): string[] | null {
  const s = qualifiedName.trim();
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let wasQuoted = false;
  const push = () => {
    const p = wasQuoted ? cur : cur.toUpperCase();
    if (!PART_RE.test(p)) return false;
    parts.push(p);
    cur = '';
    wasQuoted = false;
    return true;
  };
  for (const ch of s) {
    if (ch === '"') {
      quoted = !quoted;
      wasQuoted = true;
      continue;
    }
    if (ch === '.' && !quoted) {
      if (!push()) return null;
      continue;
    }
    cur += ch;
  }
  if (quoted || !push() || parts.length > 3) return null;
  return parts;
}

/** An identifier for a statement: plain upper-case names as they are, others in double quotes (no quote inside: PART_RE). */
export const snowflakeIdent = (part: string): string => (PLAIN_RE.test(part) ? part : `"${part}"`);

const ageMinutes = (iso: string | null | undefined, now: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 60_000)) : null;
};

const fmtAge = (m: number): string => (m < 120 ? `${m} minutes` : m < 2880 ? `${Math.round(m / 60)} hours` : `${Math.round(m / 1440)} days`);

function judgeAge(c: Check, what: string, minutes: number | null, maxAge: number, value: Record<string, unknown>, note = ''): CheckResult {
  if (minutes === null) return { status: 'unknown', message: `${what}: no time found${note}`, value };
  value.minutes = minutes;
  return minutes > maxAge
    ? { status: c.failAs, message: `${what} last changed ${fmtAge(minutes)} ago (at most ${fmtAge(maxAge)})${note}`, value }
    : { status: 'up', message: `${what} changed ${fmtAge(minutes)} ago${note}`, value };
}

/** Freshness of a Snowflake element. */
export async function snowflakeFreshness(c: Check, el: ElementRow, sf: SnowflakeClient, now: number): Promise<CheckResult> {
  const parts = snowflakeParts(el.qualified_name);
  if (!parts) return { status: 'unknown', message: `"${el.qualified_name}" is no Snowflake name Steward reads (letters, digits, _, $ and - per part)` };
  const maxAge = c.maxAgeMinutes ?? 1440;
  const [d, s, t] = parts as [string, string?, string?];
  const tables = `${snowflakeIdent(d)}.INFORMATION_SCHEMA.TABLES`;
  const name = parts.join('.');
  switch (el.kind) {
    case 'snowflake.table':
    case 'snowflake.view': {
      if (parts.length !== 3) return { status: 'unknown', message: `"${el.qualified_name}" is not DATABASE.SCHEMA.TABLE` };
      // as the snowflake check (#115): one row of the database's information schema
      const [row] = await sf.query(
        `/* steward:dp-table-fresh */ SELECT TO_VARCHAR(LAST_ALTERED, ${ISO}) AS LAST_ALTERED, TABLE_TYPE FROM IDENTIFIER(?) WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [tables, s!, t!],
      );
      if (!row?.LAST_ALTERED) return { status: 'unknown', message: `Snowflake: no table ${name} (or no access to its metadata)` };
      return judgeAge(c, `Snowflake: ${name}`, ageMinutes(row.LAST_ALTERED, now), maxAge, { lastAltered: row.LAST_ALTERED });
    }
    case 'snowflake.dynamicTable': {
      if (parts.length !== 3) return { status: 'unknown', message: `"${el.qualified_name}" is not DATABASE.SCHEMA.TABLE` };
      const [row] = await sf.query(
        `/* steward:dp-dynamic-refresh */ SELECT TO_VARCHAR(MAX(IFF(STATE = 'SUCCEEDED', DATA_TIMESTAMP, NULL)), ${ISO}) AS DATA_TIMESTAMP,
         MAX_BY(STATE, REFRESH_START_TIME) AS LAST_STATE, MAX_BY(STATE_MESSAGE, REFRESH_START_TIME) AS LAST_MESSAGE
         FROM TABLE(${snowflakeIdent(d)}.INFORMATION_SCHEMA.DYNAMIC_TABLE_REFRESH_HISTORY(NAME => ?, RESULT_LIMIT => 100))`,
        [parts.map(snowflakeIdent).join('.')],
      );
      const failed = row?.LAST_STATE === 'FAILED' || row?.LAST_STATE === 'UPSTREAM_FAILED';
      const note = failed ? ` – the last refresh failed${row?.LAST_MESSAGE ? `: ${row.LAST_MESSAGE.slice(0, 200)}` : ''}` : '';
      if (!row?.DATA_TIMESTAMP && !row?.LAST_STATE)
        return { status: 'unknown', message: `Snowflake: no refresh of the dynamic table ${name} found (or no access)` };
      const r = judgeAge(
        c,
        `Snowflake: dynamic table ${name}`,
        ageMinutes(row.DATA_TIMESTAMP, now),
        maxAge,
        {
          dataTimestamp: row.DATA_TIMESTAMP ?? null,
          lastState: row.LAST_STATE ?? null,
        },
        note,
      );
      return failed && r.status === 'up' ? { ...r, status: c.warningAs } : r;
    }
    case 'snowflake.task': {
      if (parts.length !== 3) return { status: 'unknown', message: `"${el.qualified_name}" is not DATABASE.SCHEMA.TASK` };
      const [row] = await sf.query(
        `/* steward:dp-task-runs */ SELECT TO_VARCHAR(MAX(IFF(STATE = 'SUCCEEDED', COMPLETED_TIME, NULL)), ${ISO}) AS LAST_SUCCESS,
         MAX_BY(STATE, SCHEDULED_TIME) AS LAST_STATE, MAX_BY(ERROR_MESSAGE, SCHEDULED_TIME) AS LAST_ERROR
         FROM TABLE(${snowflakeIdent(d)}.INFORMATION_SCHEMA.TASK_HISTORY(TASK_NAME => ?, RESULT_LIMIT => 100))
         WHERE SCHEMA_NAME = ? AND STATE IN ('SUCCEEDED', 'FAILED', 'FAILED_AND_AUTO_SUSPENDED', 'CANCELLED')`,
        [t!, s!],
      );
      const failed = !!row?.LAST_STATE && row.LAST_STATE !== 'SUCCEEDED';
      const note = failed
        ? ` – the last run ${row!.LAST_STATE!.toLowerCase().replaceAll('_', ' ')}${row?.LAST_ERROR ? `: ${row.LAST_ERROR.slice(0, 200)}` : ''}`
        : '';
      if (!row?.LAST_SUCCESS)
        return {
          status: row?.LAST_STATE ? c.failAs : 'unknown',
          message: `Snowflake: task ${name} – no successful run in the last 7 days${note}`,
          value: { lastState: row?.LAST_STATE ?? null },
        };
      const r = judgeAge(
        c,
        `Snowflake: task ${name}`,
        ageMinutes(row.LAST_SUCCESS, now),
        maxAge,
        { lastSuccess: row.LAST_SUCCESS, lastState: row.LAST_STATE },
        note,
      );
      // the last run failed but an earlier one is recent enough: a warning
      return failed && r.status === 'up' ? { ...r, status: c.warningAs } : r;
    }
    case 'snowflake.schema':
    case 'snowflake.database': {
      if (el.kind === 'snowflake.schema' && parts.length !== 2) return { status: 'unknown', message: `"${el.qualified_name}" is not DATABASE.SCHEMA` };
      const [row] = await sf.query(
        `/* steward:dp-project-fresh */ SELECT COUNT(*) AS TABLES, TO_VARCHAR(MAX(LAST_ALTERED), ${ISO}) AS NEWEST, TO_VARCHAR(MIN(LAST_ALTERED), ${ISO}) AS OLDEST,
         MIN_BY(TABLE_SCHEMA || '.' || TABLE_NAME, LAST_ALTERED) AS OLDEST_NAME, COUNT_IF(LAST_ALTERED < DATEADD(minute, ?, CURRENT_TIMESTAMP())) AS STALE
         FROM IDENTIFIER(?) WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA <> 'INFORMATION_SCHEMA' AND (? = '' OR TABLE_SCHEMA = ?)`,
        [-maxAge, tables, s ?? '', s ?? ''],
      );
      return judgeProject(c, `Snowflake: ${name}`, row, maxAge, now);
    }
    default:
      return { status: 'unknown', message: `Snowflake: the freshness of a ${el.kind.slice('snowflake.'.length)} is not read – link a check of your own` };
  }
}

function judgeProject(c: Check, what: string, row: Row | undefined, maxAge: number, now: number): CheckResult {
  const n = Number(row?.TABLES ?? 0);
  if (!n) return { status: 'unknown', message: `${what}: no table found (or no access to the metadata)` };
  const stale = Number(row?.STALE ?? 0);
  const value: Record<string, unknown> = { tables: n, stale, newest: row?.NEWEST ?? null, oldest: row?.OLDEST ?? null };
  if (c.each === 'every') {
    const m = ageMinutes(row?.OLDEST, now);
    if (stale > 0 && m !== null)
      return {
        status: c.failAs,
        message: `${what}: ${stale} of ${n} tables not changed within ${fmtAge(maxAge)} – the oldest, ${row?.OLDEST_NAME ?? '?'}, ${fmtAge(m)} ago`,
        value: { ...value, minutes: m },
      };
    return { status: 'up', message: `${what}: all ${n} tables changed within ${fmtAge(maxAge)}`, value: { ...value, minutes: m } };
  }
  return judgeAge(c, `${what} (newest of ${n} tables)`, ageMinutes(row?.NEWEST, now), maxAge, value);
}

// ---------- Kafka ----------

/** When the end offsets of a topic last moved (per platform and topic) – the fallback before Kafka 3.0. */
const moved = new Map<string, { value: number; since: number }>();
function movedSince(key: string, value: number, now: number): number {
  const prev = moved.get(key);
  if (!prev || prev.value !== value) moved.set(key, { value, since: now });
  if (moved.size > 50_000) moved.delete(moved.keys().next().value!);
  return moved.get(key)!.since;
}

/** The topics of a bundle: its children in the catalogue, else catalogue topics whose name starts with its name (without a trailing `*`). */
export function bundleTopics(bundle: ElementRow): string[] {
  const children = [...elementsByIds(descendantsOf([bundle.id], DATA_PRODUCT_LIMITS.bundleTopics)).values()].filter((e) => e.kind === 'kafka.topic');
  if (children.length) return children.map((e) => e.qualified_name).sort();
  const prefix = bundle.name_norm.replace(/\*+$/, '');
  if (!prefix) return [];
  return db()
    .all<{ qualified_name: string }>(
      `SELECT qualified_name FROM dp_elements WHERE platform_id = ? AND environment = ? AND kind = 'kafka.topic' AND name_norm >= ? AND name_norm < ? ORDER BY name_norm LIMIT ?`,
      bundle.platform_id,
      bundle.environment,
      prefix,
      prefix + String.fromCodePoint(0x10ffff),
      DATA_PRODUCT_LIMITS.bundleTopics,
    )
    .map((r) => r.qualified_name);
}

/** Freshness of a Kafka topic or bundle (and a consumer group's lag on a topic). */
export async function kafkaFreshness(c: Check, el: ElementRow, platform: Platform, secrets: Record<string, string>, now: number): Promise<CheckResult> {
  if (platform.kind !== 'kafka')
    return { status: 'unknown', message: `"${platform.name}" is not a Kafka platform – Steward reads topics through a Kafka platform (bootstrap servers)` };
  const { withKafka, kafkaError } = await import('../../kafka/client.js');
  const { lagOf } = await import('../../kafka/service.js');
  const maxAge = c.maxAgeMinutes ?? 1440;
  const topics = el.kind === 'kafka.topicBundle' ? bundleTopics(el) : [el.qualified_name];
  if (!topics.length) return { status: 'unknown', message: `Kafka: the bundle ${el.qualified_name} has no topics in the catalogue` };
  let read: { topic: string; age: number | null; ends: number }[];
  let lag: { lag: number } | null | undefined;
  try {
    read = await withKafka(platform, secrets, async (k) => {
      const out: { topic: string; age: number | null; ends: number }[] = [];
      for (const topic of topics) {
        const ends = await k.ends(topic);
        if (!ends.length) continue;
        const end = ends.reduce((n, e) => n + e.end, 0);
        const newest = await k.newest(topic);
        // without the newest message's time: when the end offsets last moved, known once a window has passed
        const since = movedSince(`${platform.id}|${topic}`, end, now);
        const last = newest ?? (now - since >= maxAge * 60_000 ? since : null);
        out.push({ topic, ends: end, age: last === null ? null : Math.max(0, Math.floor((now - last) / 60_000)) });
        if (c.group && el.kind === 'kafka.topic') {
          const g = (await k.groups(topic, [c.group]))[0];
          lag = g ? lagOf(ends, g) : null;
        }
      }
      return out;
    });
  } catch (e) {
    return { status: 'unknown', message: `Kafka could not be read: ${kafkaError(e)}`.slice(0, 500) };
  }
  if (!read.length) return { status: 'unknown', message: `Kafka: no topic ${topics.length === 1 ? `"${topics[0]}"` : `of the bundle ${el.qualified_name}`}` };
  const known = read.filter((r) => r.age !== null) as { topic: string; age: number }[];
  const value: Record<string, unknown> = { topics: read.length };
  let r: CheckResult;
  if (!known.length) r = { status: 'unknown', message: `Kafka: ${el.qualified_name} – watching for new messages`, value };
  else if (el.kind === 'kafka.topicBundle' && c.each === 'every') {
    const stale = known.filter((x) => x.age > maxAge).sort((a, b) => b.age - a.age);
    value.stale = stale.length;
    r = stale.length
      ? {
          status: c.failAs,
          message: `Kafka: ${stale.length} of ${read.length} topics of ${el.qualified_name} without a new message for more than ${fmtAge(maxAge)}: ${stale
            .slice(0, 5)
            .map((x) => x.topic)
            .join(', ')}${stale.length > 5 ? ` and ${stale.length - 5} more` : ''}`,
          value,
        }
      : { status: 'up', message: `Kafka: every topic of ${el.qualified_name} got a message within ${fmtAge(maxAge)}`, value };
  } else {
    const newest = Math.min(...known.map((x) => x.age));
    value.minutes = newest;
    const what =
      el.kind === 'kafka.topicBundle'
        ? `Kafka: the newest message of ${read.length} topics of ${el.qualified_name}`
        : `Kafka: ${el.qualified_name} – the newest message`;
    r =
      newest > maxAge
        ? { status: c.failAs, message: `${what} is ${fmtAge(newest)} old (at most ${fmtAge(maxAge)})`, value }
        : { status: 'up', message: `${what} is ${fmtAge(newest)} old`, value };
  }
  if (c.group && el.kind === 'kafka.topic') {
    if (!lag) return { ...r, status: worse(r.status, 'unknown'), message: `${r.message}; consumer group ${c.group} has no offsets on it` };
    value.lag = lag.lag;
    if (c.maxLag !== undefined && lag.lag > c.maxLag)
      return { ...r, status: worse(r.status, 'degraded'), message: `${r.message}; group ${c.group} lag ${lag.lag} (at most ${c.maxLag})` };
    return { ...r, message: `${r.message}; group ${c.group} lag ${lag.lag}` };
  }
  return r;
}

import { AWS_REGION_RE, DYNAMODB_LIMITS, type CheckOf, type MonitorStatus, type Platform } from '@sm/shared';
import { AwsClient, endpointFor, homeRegion } from './client.js';
import { freshnessStatus, freshnessWindowSeconds, fmtAge, type FreshnessConfig } from '../monitors/logic.js';

/**
 * The DynamoDB monitor check (#233): is the data in a table current? Signed per service like the other AWS calls
 * (SigV4 for `dynamodb` and, for the write activity, `monitoring` – CloudWatch), AWS JSON 1.0 with X-Amz-Target.
 *
 *   newestItem     DynamoDB Query, one per partition key value: Limit 1, newest first (ScanIndexForward false),
 *                  only the key and the time attribute projected – every attribute name is a placeholder of
 *                  ExpressionAttributeNames, never part of an expression; nothing of the item is kept
 *   writeActivity  CloudWatch GetMetricData: Sum of AWS/DynamoDB ConsumedWriteCapacityUnits of the table, one call
 *   hygiene        DescribeTable, DescribeContinuousBackups, DescribeTimeToLive
 *
 * Never Scan or GetItem. Throttling is `unknown` (the table may be fine), never `down`.
 */

export const DYNAMODB_TARGET = 'DynamoDB_20120810';
export const CLOUDWATCH_TARGET = 'GraniteServiceVersion20100801';

/** AWS error codes that mean "too many requests right now". */
export const THROTTLING_CODES: ReadonlySet<string> = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'Throttling',
  'RequestLimitExceeded',
  'TooManyRequestsException',
]);

/** An answer of AWS is at most this large here (a Query of one projected item, a few Describe calls). */
const MAX_ANSWER_BYTES = 1024 * 1024;
/** Queries at the same time (one per partition key value). */
const PARALLEL = 4;

export interface DynamoDbResult {
  status: MonitorStatus;
  message: string;
  value?: unknown;
}

type Check = CheckOf<'dynamodb'>;

const freshnessOf = (c: Check): FreshnessConfig => ({
  mode: c.freshnessMode,
  expectedIntervalSeconds: c.expectedIntervalSeconds,
  degradedAfterMissed: c.degradedAfterMissed,
  downAfterMissed: c.downAfterMissed,
  maxAgeSeconds: c.maxAgeSeconds,
  degradedAgeSeconds: c.degradedAgeSeconds,
});

/** The check's region (or the platform's main region); it becomes part of the endpoint's host name, so it must be one. */
export function regionOf(p: Platform, c: Pick<Check, 'region'>): string {
  const region = c.region?.trim() || homeRegion(p);
  if (!AWS_REGION_RE.test(region)) throw new Error(`"${region.slice(0, 40)}" is not an AWS region`);
  return region;
}

// ---------- requests ----------

/**
 * The Query for the newest item of one partition key value. The attribute names only appear as values of
 * ExpressionAttributeNames (#pk, #t) and the key value only as an ExpressionAttributeValue (:pk): whatever they
 * contain, they cannot change the expressions.
 */
export function newestItemQuery(c: Check, value: string): Record<string, unknown> {
  const names: Record<string, string> = { '#pk': c.partitionKey ?? '', '#t': c.timeAttribute ?? '' };
  return {
    TableName: c.table,
    ...(c.indexName ? { IndexName: c.indexName } : {}),
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ':pk': c.partitionKeyType === 'N' ? { N: value } : { S: value } },
    ProjectionExpression: '#pk, #t',
    Limit: 1,
    ScanIndexForward: false,
    ReturnConsumedCapacity: 'NONE',
  };
}

/** CloudWatch periods (seconds) from fine to coarse; older data is only kept at the coarser ones. */
const PERIODS = [60, 300, 900, 3600, 21600, 86400];
/** Longest look-back of the write activity: CloudWatch keeps hourly data for 455 days. */
const MAX_LOOKBACK_SECONDS = 455 * 86400;

/** The GetMetricData request of the write activity: the window and a half, at most about 1500 data points. */
export function writeActivityRequest(c: Check, now: number): { body: Record<string, unknown>; periodSeconds: number; lookbackSeconds: number } {
  const lookbackSeconds = Math.min(Math.ceil(freshnessWindowSeconds(freshnessOf(c)) * 1.5), MAX_LOOKBACK_SECONDS);
  const periodSeconds = PERIODS.find((p) => lookbackSeconds / p <= 1440) ?? 86400;
  const end = Math.ceil(now / 1000 / 60) * 60;
  const start = end - Math.ceil(lookbackSeconds / periodSeconds) * periodSeconds;
  return {
    periodSeconds,
    lookbackSeconds,
    body: {
      MetricDataQueries: [
        {
          Id: 'writes',
          MetricStat: {
            Metric: { Namespace: 'AWS/DynamoDB', MetricName: 'ConsumedWriteCapacityUnits', Dimensions: [{ Name: 'TableName', Value: c.table }] },
            Period: periodSeconds,
            Stat: 'Sum',
          },
          ReturnData: true,
        },
      ],
      // AWS JSON: timestamps are seconds since the epoch
      StartTime: start,
      EndTime: end,
      ScanBy: 'TimestampDescending',
      MaxDatapoints: 1500,
    },
  };
}

// ---------- time of an item ----------

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?(Z|[+-]\d{2}(?::?\d{2})?)?(?=$|[^0-9:.,+-])/i;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const MIN_MS = Date.UTC(1970, 0, 1);
const MAX_MS = Date.UTC(9999, 11, 31);

/** An ISO 8601 date or date-time at the start of a string (a sort key such as 2026-11-06T10:15:00Z#order-1 too); no zone: UTC. */
export function parseIso(text: string): number | null {
  const m = ISO_RE.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = '', zone] = m;
  let z = (zone ?? 'Z').toUpperCase();
  if (z !== 'Z') z = z.length === 3 ? `${z}:00` : z.includes(':') ? z : `${z.slice(0, 3)}:${z.slice(3)}`;
  const ms = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}${frac ? `.${frac.padEnd(3, '0').slice(0, 3)}` : ''}${z}`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The time of a DynamoDB attribute value ({ S: … } or { N: … }) in milliseconds, or why it is none. `auto`: a number
 * below 1e11 is epoch seconds (until the year 5138), above it epoch milliseconds; a string is ISO 8601 or a number.
 */
export function attributeTime(attr: unknown, format: Check['timeFormat']): { ms: number } | { error: string } {
  const a = (attr ?? {}) as { S?: unknown; N?: unknown };
  const raw = typeof a.N === 'string' ? a.N : typeof a.S === 'string' ? a.S : null;
  if (raw === null) return { error: 'is neither a string nor a number' };
  const numeric = NUMBER_RE.test(raw.trim());
  let ms: number | null;
  if (format === 'iso8601') {
    if (typeof a.N === 'string') return { error: 'is a number, not an ISO 8601 date' };
    ms = parseIso(raw);
    if (ms === null) return { error: 'is not an ISO 8601 date' };
  } else if (format === 'epochSeconds' || format === 'epochMillis') {
    if (!numeric) return { error: `is not a number (${format === 'epochSeconds' ? 'epoch seconds' : 'epoch milliseconds'})` };
    ms = Number(raw) * (format === 'epochSeconds' ? 1000 : 1);
  } else if (numeric) {
    const n = Number(raw);
    ms = Math.abs(n) < 1e11 ? n * 1000 : n;
  } else {
    ms = parseIso(raw);
    if (ms === null) return { error: 'is neither an ISO 8601 date nor a number' };
  }
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return { error: 'is not a time between 1970 and 9999' };
  return { ms };
}

// ---------- errors ----------

interface AwsFailure {
  status: MonitorStatus;
  message: string;
  throttled: boolean;
}

/** What an AWS error means for the check: throttling → unknown, a missing table or index → down, the rest → unknown. */
export function classifyAwsError(e: unknown, what: string, c: Check, region: string): AwsFailure {
  const err = e as Error & { awsCode?: string; status?: number };
  const code = err.awsCode ?? '';
  const msg = (err.message ?? String(e)).slice(0, 400);
  if (THROTTLING_CODES.has(code) || err.status === 429)
    return { status: 'unknown', throttled: true, message: `${what} was throttled by AWS (${code || 'HTTP 429'}) – read again on the next run` };
  if (code === 'ResourceNotFoundException')
    return {
      status: 'down',
      throttled: false,
      message: `table ${c.table}${c.indexName && what === 'Query' ? ` (index ${c.indexName})` : ''} not found in ${region}`,
    };
  if (code === 'AccessDeniedException' || code === 'AccessDenied' || err.status === 403) {
    const action = what === 'GetMetricData' ? 'cloudwatch:GetMetricData' : `dynamodb:${what}`;
    return {
      status: 'unknown',
      throttled: false,
      message: `${msg} – the policy needs ${action}${what === 'GetMetricData' ? '' : ` on the table${what === 'Query' ? ' and its /index/*' : ''}`}`,
    };
  }
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return { status: 'unknown', throttled: false, message: `${what}: no answer in time` };
  return { status: 'unknown', throttled: false, message: msg };
}

// ---------- the check ----------

const RANK: Record<MonitorStatus, number> = { up: 0, maintenance: 1, blocked: 2, unknown: 3, degraded: 4, down: 5 };
const worse = (a: MonitorStatus, b: MonitorStatus): MonitorStatus => (RANK[b] > RANK[a] ? b : a);
const label = (c: Check) => `DynamoDB ${c.table}`;

interface KeyResult {
  key: string;
  status: MonitorStatus;
  message: string;
  ageSeconds: number | null;
}

async function newestItem(aws: AwsClient, c: Check, region: string, now: number): Promise<DynamoDbResult> {
  const values = (c.partitionValues ?? []).slice(0, DYNAMODB_LIMITS.partitionValues);
  if (!values.length) return { status: 'unknown', message: `${label(c)}: no partition key value to read` };
  const fresh = freshnessOf(c);
  const one = async (value: string): Promise<KeyResult> => {
    let r: { Items?: Record<string, unknown>[] };
    try {
      r = await aws.json('dynamodb', region, `${DYNAMODB_TARGET}.Query`, newestItemQuery(c, value), { version: '1.0', maxBytes: MAX_ANSWER_BYTES });
    } catch (e) {
      const f = classifyAwsError(e, 'Query', c, region);
      return { key: value, status: f.status, message: f.message, ageSeconds: null };
    }
    const item = r.Items?.[0];
    if (!item) return { key: value, status: 'down', message: `no item with ${c.partitionKey} = ${value}`, ageSeconds: null };
    const attr = item[c.timeAttribute ?? ''];
    if (attr === undefined)
      return { key: value, status: 'unknown', message: `the newest item of ${value} has no attribute ${c.timeAttribute}`, ageSeconds: null };
    const t = attributeTime(attr, c.timeFormat);
    if ('error' in t) return { key: value, status: 'unknown', message: `${c.timeAttribute} of the newest item of ${value} ${t.error}`, ageSeconds: null };
    const f = freshnessStatus(t.ms, now, fresh, `item of ${value}`);
    return { key: value, status: f.status, message: f.message, ageSeconds: f.ageSeconds === null ? null : Math.round(f.ageSeconds) };
  };
  const per: KeyResult[] = [];
  for (let i = 0; i < values.length; i += PARALLEL) per.push(...(await Promise.all(values.slice(i, i + PARALLEL).map(one))));
  const status = per.reduce<MonitorStatus>((s, p) => worse(s, p.status), 'up');
  const ages = per.map((p) => p.ageSeconds);
  const value = {
    ageSeconds: ages.some((a) => a === null) ? null : Math.max(...(ages as number[])),
    keys: per.map((p) => ({ key: p.key, ageSeconds: p.ageSeconds })),
  };
  const messages = [...new Set(per.filter((p) => p.status !== 'up').map((p) => p.message))];
  let message: string;
  if (per.length === 1) message = per[0]!.message;
  else if (messages.length) message = messages.join('; ');
  else message = `All ${per.length} partition keys are fresh (oldest ${fmtAge(value.ageSeconds ?? 0)})`;
  return { status, message: `${label(c)}: ${message}`, value };
}

async function writeActivity(aws: AwsClient, c: Check, region: string, now: number): Promise<DynamoDbResult> {
  const req = writeActivityRequest(c, now);
  type Res = {
    MetricDataResults?: { Id?: string; Timestamps?: (number | string)[]; Values?: number[]; StatusCode?: string }[];
    Messages?: { Value?: string }[];
  };
  let r: Res;
  try {
    r = await aws.json<Res>('monitoring', region, `${CLOUDWATCH_TARGET}.GetMetricData`, req.body, { version: '1.0', maxBytes: MAX_ANSWER_BYTES });
  } catch (e) {
    const f = classifyAwsError(e, 'GetMetricData', c, region);
    return { status: f.status === 'down' ? 'unknown' : f.status, message: `${label(c)}: ${f.message}` };
  }
  const res = r.MetricDataResults?.find((x) => x.Id === 'writes') ?? r.MetricDataResults?.[0];
  if (res?.StatusCode === 'Forbidden' || res?.StatusCode === 'InternalError')
    return {
      status: 'unknown',
      message: `${label(c)}: CloudWatch answered ${res.StatusCode}${r.Messages?.[0]?.Value ? ` (${r.Messages[0].Value.slice(0, 200)})` : ''}`,
    };
  const ts = res?.Timestamps ?? [];
  const vals = res?.Values ?? [];
  let newest: number | null = null;
  let writes = 0;
  ts.forEach((t, i) => {
    const v = Number(vals[i] ?? 0);
    const ms = typeof t === 'number' ? t * 1000 : Date.parse(String(t));
    if (!Number.isFinite(v) || !Number.isFinite(ms) || v <= 0) return;
    writes += v;
    // a data point is the start of its period: the writes happened within it
    const end = Math.min(ms + req.periodSeconds * 1000, now);
    if (newest === null || end > newest) newest = end;
  });
  const f = freshnessStatus(newest, now, freshnessOf(c), 'write');
  const units = Math.round(writes * 100) / 100;
  const message =
    newest === null
      ? `no writes within the last ${fmtAge(req.lookbackSeconds)} (CloudWatch ConsumedWriteCapacityUnits)`
      : `${f.message} (${units} write capacity units in the last ${fmtAge(req.lookbackSeconds)}, by ${fmtAge(req.periodSeconds)} periods)`;
  return {
    status: newest === null ? 'down' : f.status,
    message: `${label(c)}: ${message}`,
    value: { writes: units, ageSeconds: f.ageSeconds === null ? null : Math.round(f.ageSeconds) },
  };
}

const fmtBytes = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} bytes`;

async function hygiene(aws: AwsClient, c: Check, region: string): Promise<DynamoDbResult> {
  const call = <T>(action: string) =>
    aws.json<T>('dynamodb', region, `${DYNAMODB_TARGET}.${action}`, { TableName: c.table }, { version: '1.0', maxBytes: MAX_ANSWER_BYTES });
  let table: { TableStatus?: string; ItemCount?: number; TableSizeBytes?: number } | undefined;
  try {
    table = (await call<{ Table?: typeof table }>('DescribeTable')).Table;
  } catch (e) {
    const f = classifyAwsError(e, 'DescribeTable', c, region);
    return { status: f.status, message: `${label(c)}: ${f.message}` };
  }
  let status: MonitorStatus = 'up';
  const problems: string[] = [];
  const notes: string[] = [];
  const judge = (requirement: 'required' | 'report', ok: boolean | null, good: string, bad: string, unread?: string) => {
    if (ok === null) {
      if (requirement === 'required') status = worse(status, 'unknown');
      (requirement === 'required' ? problems : notes).push(unread ?? bad);
    } else if (ok) notes.push(good);
    else if (requirement === 'required') {
      status = worse(status, c.failAs);
      problems.push(bad);
    } else notes.push(`${bad} (reported only)`);
  };
  const tableStatus = table?.TableStatus ?? 'unknown';
  judge(c.activeTable, tableStatus === 'ACTIVE', 'ACTIVE', `status ${tableStatus}`);
  const itemCount = typeof table?.ItemCount === 'number' ? table.ItemCount : null;
  const sizeBytes = typeof table?.TableSizeBytes === 'number' ? table.TableSizeBytes : null;
  if (itemCount !== null) notes.push(`${itemCount.toLocaleString('en-US')} items`);
  if (sizeBytes !== null) notes.push(fmtBytes(sizeBytes));

  let pitr: boolean | null = null;
  let pitrError = '';
  try {
    const r = await call<{ ContinuousBackupsDescription?: { PointInTimeRecoveryDescription?: { PointInTimeRecoveryStatus?: string } } }>(
      'DescribeContinuousBackups',
    );
    pitr = r.ContinuousBackupsDescription?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus === 'ENABLED';
  } catch (e) {
    pitrError = classifyAwsError(e, 'DescribeContinuousBackups', c, region).message;
  }
  judge(c.pointInTimeRecovery, pitr, 'point-in-time recovery on', 'point-in-time recovery off', `point-in-time recovery not readable: ${pitrError}`);

  let ttl: string | null = null;
  let ttlAttribute = '';
  let ttlError = '';
  try {
    const r = await call<{ TimeToLiveDescription?: { TimeToLiveStatus?: string; AttributeName?: string } }>('DescribeTimeToLive');
    ttl = r.TimeToLiveDescription?.TimeToLiveStatus ?? 'DISABLED';
    ttlAttribute = r.TimeToLiveDescription?.AttributeName ?? '';
  } catch (e) {
    ttlError = classifyAwsError(e, 'DescribeTimeToLive', c, region).message;
  }
  judge(
    c.timeToLive,
    ttl === null ? null : ttl === 'ENABLED' || ttl === 'ENABLING',
    `time to live on${ttlAttribute ? ` (${ttlAttribute})` : ''}`,
    `time to live ${ttl === null ? 'off' : ttl.toLowerCase()}`,
    `time to live not readable: ${ttlError}`,
  );
  return {
    status,
    message: `${label(c)}: ${[...problems, ...notes].join(', ')}`,
    value: { status: tableStatus, itemCount, tableSizeBytes: sizeBytes, pointInTimeRecovery: pitr, timeToLive: ttl },
  };
}

/** Runs a DynamoDB check against the platform (the caller checked the platform kind and the outbound policy). */
export async function dynamoDbCheck(p: Platform, secrets: Record<string, string>, c: Check, signal: AbortSignal, now: number): Promise<DynamoDbResult> {
  const aws = new AwsClient(p, secrets, signal);
  const region = regionOf(p, c);
  if (c.mode === 'writeActivity') return writeActivity(aws, c, region, now);
  if (c.mode === 'hygiene') return hygiene(aws, c, region);
  return newestItem(aws, c, region, now);
}

/** The endpoints a check calls: DynamoDB, and CloudWatch for the write activity (the outbound policy counts them as the platform's own). */
export function dynamoDbEndpoints(p: Platform, c: Check): string[] {
  const region = regionOf(p, c);
  return [endpointFor(p, c.mode === 'writeActivity' ? 'monitoring' : 'dynamodb', region)];
}

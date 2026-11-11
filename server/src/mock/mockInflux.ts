import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Simulated InfluxDB for demo mode and tests (0.18.0), one base URL per API generation, mounted at /mock:
 *   /influxdb1  GET /ping (204, X-Influxdb-Version), GET /query?db&q&epoch – InfluxQL, JSON results[].series[]; basic auth
 *   /influxdb2  GET /health, GET /api/v2/buckets, POST /api/v2/query?org – Flux (JSON body), annotated CSV; Authorization: Token
 * The data are fixed and relative to now: database or bucket "plant", measurement "machine_data", tags site and device,
 * fields temperature and pressure – press-01, press-02 and press-04 report every few seconds, press-03 stopped three
 * hours ago (the stale series of the demo). The mock reads exactly the queries Steward writes: it tokenises them as the
 * dialect does (quoted names and strings with their escapes), so a name with quotes in it stays a name.
 */

export const DEMO_INFLUX = {
  v1: { username: 'steward-reader', password: 'demo-influx-password' },
  v2: { token: 'demo-influx2-token', org: 'acme' },
  database: 'plant',
  measurement: 'machine_data',
} as const;

interface Point {
  site: string;
  device: string;
  /** Age of the newest value per field (ms) */
  fields: Record<string, number>;
}

const SERIES: Point[] = [
  { site: 'hall-2', device: 'press-01', fields: { temperature: 20_000, pressure: 20_000 } },
  { site: 'hall-2', device: 'press-02', fields: { temperature: 35_000, pressure: 35_000 } },
  { site: 'hall-2', device: 'press-03', fields: { temperature: 3 * 3600_000, pressure: 3 * 3600_000 } },
  { site: 'hall-3', device: 'press-04', fields: { temperature: 50_000, pressure: 50_000 } },
];

/** For tests: what was asked (version, method, path, the Authorization header, query string and body). */
export const influxRequests: { version: 1 | 2; method: string; path: string; authorization?: string; query: Record<string, unknown>; body: unknown }[] = [];
let extra: Point[] = [];
/** For tests: more series (e.g. more than the cap), or [] for the fixed ones only. */
export function setInfluxExtraSeries(points: Point[]): void {
  extra = points;
}
export function resetInflux(): void {
  extra = [];
  influxRequests.length = 0;
}

// ---------- tokens ----------

type Tok = { t: 'ident' | 'string' | 'word' | 'num' | 'punct'; v: string };

/**
 * Tokens of InfluxQL or Flux: double-quoted names or Flux strings and single-quoted InfluxQL strings, all with backslash
 * escapes; words, numbers and single characters.
 */
function tokens(text: string, dialect: 'influxql' | 'flux'): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const quoted = (q: string): string => {
    let v = '';
    i++;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '\\') {
        const next = text[i + 1];
        if (next === undefined) throw new Error('unterminated escape');
        v += next;
        i += 2;
        continue;
      }
      if (ch === q) {
        i++;
        return v;
      }
      v += ch;
      i++;
    }
    throw new Error('unterminated quote');
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) i++;
    else if (ch === '"') out.push({ t: dialect === 'flux' ? 'string' : 'ident', v: quoted('"') });
    else if (ch === "'" && dialect !== 'flux') out.push({ t: 'string', v: quoted("'") });
    else if (/[A-Za-z_]/.test(ch)) {
      let v = '';
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) v += text[i++];
      out.push({ t: 'word', v });
    } else if (/\d/.test(ch)) {
      let v = '';
      while (i < text.length && /[0-9.]/.test(text[i]!)) v += text[i++];
      out.push({ t: 'num', v });
    } else if ((ch === '=' || ch === '!' || ch === '>' || ch === '<' || ch === '|') && /[=>]/.test(text[i + 1] ?? '')) {
      out.push({ t: 'punct', v: ch + text[i + 1] });
      i += 2;
    } else {
      out.push({ t: 'punct', v: ch });
      i++;
    }
  }
  return out;
}

const word = (t: Tok | undefined, w: string) => t?.t === 'word' && t.v.toUpperCase() === w.toUpperCase();

interface Query {
  measurement: string;
  field?: string;
  fields: string[];
  tags: Record<string, string>;
  groupBy?: string;
  lookbackMs: number;
  /** SLIMIT, Flux's last limit(n:): series (rows) at most */
  limit?: number;
}

/** The series a query sees: newest time per (group value, field). */
function answer(q: Query, now: number): { group: string | null; field?: string; time: number }[] {
  if (q.measurement !== DEMO_INFLUX.measurement) return [];
  const out = new Map<string, { group: string | null; field?: string; time: number }>();
  for (const p of [...SERIES, ...extra]) {
    if (Object.entries(q.tags).some(([k, v]) => (p as unknown as Record<string, string>)[k] !== v)) continue;
    const group = q.groupBy ? ((p as unknown as Record<string, string | undefined>)[q.groupBy] ?? null) : null;
    const fields = q.fields.length ? q.fields : [undefined];
    for (const f of fields) {
      const ages = f ? (p.fields[f] === undefined ? [] : [p.fields[f]!]) : Object.values(p.fields);
      if (!ages.length) continue;
      const time = now - Math.min(...ages);
      if (time < now - q.lookbackMs) continue;
      const key = `${group}\u0000${f ?? ''}`;
      const prev = out.get(key);
      if (!prev || time > prev.time) out.set(key, { group, field: f, time });
    }
  }
  const rows = [...out.values()].sort((a, b) => String(a.group).localeCompare(String(b.group)));
  return q.limit ? rows.slice(0, q.limit) : rows;
}

// ---------- InfluxQL ----------

/** Splits statements at semicolons outside quotes. */
function statementsOf(text: string): Tok[][] {
  const all = tokens(text, 'influxql');
  const out: Tok[][] = [[]];
  for (const t of all) {
    if (t.t === 'punct' && t.v === ';') out.push([]);
    else out[out.length - 1]!.push(t);
  }
  return out.filter((s) => s.length);
}

function parseInfluxQl(st: Tok[]): Query | 'show-databases' {
  if (word(st[0], 'SHOW') && word(st[1], 'DATABASES')) return 'show-databases';
  if (!word(st[0], 'SELECT')) throw new Error('only SELECT and SHOW DATABASES');
  let i = 1;
  let field: string | undefined;
  if (st[i]?.v === '*') i++;
  else if (word(st[i], 'last') && st[i + 1]?.v === '(' && st[i + 2]?.t === 'ident' && st[i + 3]?.v === ')') {
    field = st[i + 2]!.v;
    i += 4;
  } else throw new Error('expected * or last("field")');
  if (!word(st[i], 'FROM')) throw new Error('expected FROM');
  i++;
  let measurement = '';
  while (st[i]?.t === 'ident') {
    measurement = st[i]!.v; // "db"."rp"."m": the last one is the measurement
    i++;
    if (st[i]?.v === '.') i++;
    else break;
  }
  const tags: Record<string, string> = {};
  let lookbackMs = 3600_000;
  let groupBy: string | undefined;
  let limit: number | undefined;
  for (; i < st.length; i++) {
    if (word(st[i], 'time') && st[i + 1]?.v === '>' && word(st[i + 2], 'now')) {
      const n = st.slice(i, i + 9).find((t) => t.t === 'num');
      const unit = st[st.indexOf(n!) + 1];
      lookbackMs = Number(n?.v ?? 0) * 1000 * (unit?.v === 's' ? 1 : 0);
    } else if (st[i]?.t === 'ident' && st[i + 1]?.v === '=' && st[i + 2]?.t === 'string') {
      tags[st[i]!.v] = st[i + 2]!.v;
      i += 2;
    } else if (word(st[i], 'GROUP') && word(st[i + 1], 'BY') && st[i + 2]?.t === 'ident') {
      groupBy = st[i + 2]!.v;
      i += 2;
    } else if (word(st[i], 'SLIMIT') && st[i + 1]?.t === 'num') limit = Number(st[i + 1]!.v);
  }
  return { measurement, field, fields: field ? [field] : [], tags, groupBy, lookbackMs, limit };
}

/** One statement's result; times as epoch ms (epoch=ms) or RFC 3339 */
function v1Result(q: Query, now: number, statementId: number, epochMs: boolean) {
  const rows = answer(q, now);
  if (!rows.length) return { statement_id: statementId };
  const valueCol = q.field ? 'last' : 'temperature';
  const time = (ms: number) => (epochMs ? ms : new Date(ms).toISOString());
  if (!q.groupBy) return { statement_id: statementId, series: [{ name: q.measurement, columns: ['time', valueCol], values: [[time(rows[0]!.time), 21.5]] }] };
  return {
    statement_id: statementId,
    series: rows.map((r) => ({ name: q.measurement, tags: { [q.groupBy!]: r.group ?? '' }, columns: ['time', valueCol], values: [[time(r.time), 21.5]] })),
  };
}

// ---------- Flux ----------

function parseFlux(text: string): Query & { bucket: string } {
  const t = tokens(text, 'flux');
  const at = (i: number, ...vs: string[]) => vs.every((v, k) => t[i + k]?.v === v);
  let bucket = '';
  let measurement = '';
  const tags: Record<string, string> = {};
  const fields: string[] = [];
  let group: string[] | null = null;
  let lookbackMs = 3600_000;
  let limit: number | undefined;
  for (let i = 0; i < t.length; i++) {
    if (at(i, 'from', '(', 'bucket', ':') && t[i + 4]?.t === 'string') bucket = t[i + 4]!.v;
    else if (at(i, 'range', '(', 'start', ':', '-') && t[i + 5]?.t === 'num') lookbackMs = Number(t[i + 5]!.v) * 1000;
    else if (at(i, 'r', '.', '_measurement', '==') && t[i + 4]?.t === 'string') measurement = t[i + 4]!.v;
    else if (at(i, 'r', '.', '_field', '==') && t[i + 4]?.t === 'string') fields.push(t[i + 4]!.v);
    else if (at(i, 'r', '[') && t[i + 2]?.t === 'string' && at(i + 3, ']', '==') && t[i + 5]?.t === 'string') tags[t[i + 2]!.v] = t[i + 5]!.v;
    else if (at(i, 'limit', '(', 'n', ':') && t[i + 4]?.t === 'num') limit = Number(t[i + 4]!.v);
    else if (group === null && at(i, 'group', '(', 'columns', ':', '[')) {
      group = [];
      for (let k = i + 5; t[k] && t[k]!.v !== ']'; k++) if (t[k]!.t === 'string') group.push(t[k]!.v);
    }
  }
  const groupBy = (group ?? []).find((g) => g !== '_field');
  // the last limit() caps the merged table (limit(n: 1) per group is what the newest per group means anyway)
  return { bucket, measurement, fields, tags, groupBy, lookbackMs, limit };
}

/** RFC 3339 with nanoseconds, as Flux writes with dateTimeFormat RFC3339Nano */
const rfc3339Nano = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000000Z');
const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function fluxCsv(q: Query, now: number): string {
  const rows = answer(q, now);
  const cols = ['_time', ...(q.groupBy ? [q.groupBy] : []), ...(q.fields.length ? ['_field'] : [])];
  const lines = [
    `#datatype,string,long,dateTime:RFC3339Nano${cols
      .slice(1)
      .map(() => ',string')
      .join('')}`,
    `#group,false,false,false${cols
      .slice(1)
      .map(() => ',false')
      .join('')}`,
    `#default,_result,,${cols
      .slice(1)
      .map(() => ',')
      .join('')}`,
    `,result,table,${cols.map(csvCell).join(',')}`,
    ...rows.map((r) => `,,0,${rfc3339Nano(r.time)}${q.groupBy ? `,${csvCell(r.group ?? '')}` : ''}${q.fields.length ? `,${csvCell(r.field ?? '')}` : ''}`),
  ];
  return `${lines.join('\r\n')}\r\n\r\n`;
}

// ---------- routes ----------

const basicOk = (h: string | undefined) => h === `Basic ${Buffer.from(`${DEMO_INFLUX.v1.username}:${DEMO_INFLUX.v1.password}`).toString('base64')}`;

function log(version: 1 | 2, req: FastifyRequest): void {
  influxRequests.push({
    version,
    method: req.method,
    path: req.url.split('?')[0]!.replace(/^.*?\/(influxdb[12])\//, '/$1/'),
    authorization: req.headers.authorization,
    query: { ...(req.query as Record<string, unknown>) },
    body: req.body ?? null,
  });
}

export async function mockInflux(app: FastifyInstance): Promise<void> {
  // ---- 1.x ----
  app.get('/influxdb1/ping', async (req, reply) => {
    log(1, req);
    return reply.code(204).header('X-Influxdb-Version', '1.11.8').header('X-Influxdb-Build', 'OSS').send();
  });
  app.get('/influxdb1/query', async (req, reply) => {
    log(1, req);
    if (!basicOk(req.headers.authorization)) return reply.code(401).send({ error: 'authorization failed' });
    const { db: dbName, q, epoch } = req.query as { db?: string; q?: string; epoch?: string };
    let statements: Tok[][];
    try {
      statements = statementsOf(String(q ?? ''));
    } catch (e) {
      return reply.code(400).send({ error: `error parsing query: ${(e as Error).message}` });
    }
    const now = Date.now();
    const results = statements.map((st, i) => {
      try {
        const parsed = parseInfluxQl(st);
        if (parsed === 'show-databases') return { statement_id: i, series: [{ name: 'databases', columns: ['name'], values: [[DEMO_INFLUX.database]] }] };
        if (dbName !== DEMO_INFLUX.database) return { statement_id: i, error: `database not found: ${String(dbName ?? '')}` };
        return v1Result(parsed, now, i, epoch === 'ms');
      } catch (e) {
        return { statement_id: i, error: `error parsing query: ${(e as Error).message}` };
      }
    });
    return reply.header('X-Influxdb-Version', '1.11.8').send({ results });
  });

  // ---- 2.x ----
  const v2Auth = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.headers.authorization === `Token ${DEMO_INFLUX.v2.token}`) return true;
    void reply.code(401).send({ code: 'unauthorized', message: 'unauthorized access' });
    return false;
  };
  app.get('/influxdb2/health', async (req) => {
    log(2, req);
    return { name: 'influxdb', message: 'ready for queries and writes', status: 'pass', checks: [], version: 'v2.7.12', commit: 'demo' };
  });
  app.get('/influxdb2/api/v2/buckets', async (req, reply) => {
    log(2, req);
    if (!v2Auth(req, reply)) return reply;
    return { buckets: [{ id: '0000000000000001', name: DEMO_INFLUX.database, orgID: '0000000000000002' }] };
  });
  app.post('/influxdb2/api/v2/query', async (req, reply) => {
    log(2, req);
    if (!v2Auth(req, reply)) return reply;
    const org = (req.query as { org?: string; orgID?: string }).org ?? (req.query as { orgID?: string }).orgID;
    if (org !== DEMO_INFLUX.v2.org) return reply.code(404).send({ code: 'not found', message: `organization name "${String(org ?? '')}" not found` });
    const body = req.body as { query?: unknown } | string | null;
    const text = typeof body === 'string' ? body : String(body?.query ?? '');
    let q: ReturnType<typeof parseFlux>;
    try {
      q = parseFlux(text);
    } catch (e) {
      return reply.code(400).send({ code: 'invalid', message: `compilation failed: ${(e as Error).message}` });
    }
    if (q.bucket !== DEMO_INFLUX.database)
      return reply.code(404).send({ code: 'not found', message: `failed to initialize execute state: could not find bucket "${q.bucket}"` });
    return reply.type('text/csv; charset=utf-8').send(fluxCsv(q, Date.now()));
  });
}

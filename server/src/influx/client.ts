import { INFLUX_KIND, influxVersionOf, influxVersionText, type InfluxVersion, type Platform } from '@sm/shared';
import { buildUrl, platformRequest, resolveBaseUrl, secretValues, type HttpRequest, type HttpResult } from '../platforms/http.js';
import { assertOutboundAllowed } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { authHint, bodyKind, errorDetail, isJson } from '../platforms/answers.js';
import {
  InfluxQueryError,
  capSeries,
  fluxQuery,
  influxQlError,
  influxQlStatements,
  parseFlux,
  parseInfluxQl,
  type InfluxReadSpec,
  type InfluxSeries,
} from './query.js';

/**
 * InfluxDB over HTTP (0.18.0, docs/MONITORS.md#freshness-in-influxdb) – Steward's platform client, nothing else: the
 * platform's base URL, credentials, retries, timeouts and outbound policy, as for every platform request.
 *   1.x  GET  /query?db=&rp=&q=&epoch=ms        InfluxQL, JSON (results[].series[]); basic (user/password) or bearer (JWT)
 *   2.x  POST /api/v2/query?org=                 Flux as JSON {query, type, dialect}, annotated CSV; Authorization: Token
 * Connection test: 1.x GET /ping (204) and SHOW DATABASES, 2.x GET /health and GET /api/v2/buckets?limit=1.
 */

export class InfluxError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Answers are small (one row per series): more than this is refused, not read. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

/** The API generation of the platform – its variable version (1 or 2). */
export function platformVersion(p: Platform): InfluxVersion {
  if (p.kind !== INFLUX_KIND) throw new InfluxError(`"${p.name}" is not an InfluxDB platform`);
  const v = influxVersionOf(p.config.variables);
  if (v) return v;
  const text = influxVersionText(p.config.variables);
  throw new InfluxError(
    text
      ? `InfluxDB version "${text.slice(0, 40)}" of the platform "${p.name}" is not supported – set its variable version to 1 or 2`
      : `The platform "${p.name}" names no InfluxDB version – set its variable version to 1 or 2`,
  );
}

/**
 * One request to the platform's base URL: the outbound policy first (as for the platform and freshness checks), then
 * the platform client with its authentication, retries and concurrency limit.
 */
export async function influxRequest(p: Platform, secrets: Record<string, string>, req: HttpRequest, signal?: AbortSignal): Promise<HttpResult> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(req.url) || req.url.startsWith('//')) throw new InfluxError('InfluxDB requests go to the platform base URL only');
  const target = await buildUrl(p, secrets, req.url, {});
  await assertOutboundAllowed(target, outboundContext(), { platformOrigins: [target] });
  return platformRequest(p, secrets, { maxResponseBytes: MAX_ANSWER_BYTES, ...req }, signal);
}

const redact = (text: string, secrets: Record<string, string>) =>
  secretValues(secrets).reduce((t, v) => (v && t.includes(v) ? t.split(v).join('***') : t), text);

/** A failed answer in plain words: who answered, the likely cause and the fix. */
async function failure(p: Platform, secrets: Record<string, string>, res: HttpResult, what: string): Promise<InfluxError> {
  // a Flux answer is read as text: an error body is JSON all the same
  let r = res;
  if (typeof r.body === 'string' && /json/i.test(r.headers['content-type'] ?? ''))
    try {
      r = { ...r, body: JSON.parse(r.body) as unknown };
    } catch {
      /* not JSON after all: shown as text */
    }
  const head = `InfluxDB answered HTTP ${r.status} to ${what}`;
  let text: string;
  if (r.status === 401 || r.status === 403) text = `${head} – ${authHint(p, r.status)}`;
  else if (r.status === 404) {
    const base = await resolveBaseUrl(p, secrets).catch(() => p.baseUrl);
    const detail = isJson(r) ? `: ${errorDetail(r)}` : '';
    text = `${head}${detail} – the database or bucket does not exist, or there is no InfluxDB ${platformVersion(p)}.x API at ${base} (the base URL is the server root, e.g. https://HOST:8086)`;
  } else text = `${head}: ${isJson(r) ? errorDetail(r) : bodyKind(r)}`;
  return new InfluxError(redact(text, secrets).slice(0, 500), r.status);
}

export interface InfluxReadOptions {
  version: InfluxVersion;
  /** 2.x: the organisation (name or id) – the platform variable org */
  org?: string;
  expectedSeries?: readonly string[];
  signal?: AbortSignal;
}

export interface InfluxRead {
  series: InfluxSeries[];
  /** Series found before the cap (and expected ones added) */
  total: number;
  truncated: boolean;
}

/** Reads the newest timestamp of every series the spec describes. */
export async function readInfluxSeries(p: Platform, secrets: Record<string, string>, spec: InfluxReadSpec, opts: InfluxReadOptions): Promise<InfluxRead> {
  let series: InfluxSeries[];
  const ask = async (req: HttpRequest, what: string): Promise<HttpResult> => {
    const r = await influxRequest(p, secrets, req, opts.signal);
    if (!r.ok) throw await failure(p, secrets, r, what);
    return r;
  };
  try {
    if (opts.version === '1') {
      // every statement in one request: result i is statement i
      const q = influxQlStatements(spec).join('; ');
      const r = await ask({ method: 'GET', url: '/query', query: { db: spec.database, q, epoch: 'ms' } }, 'the InfluxQL query');
      series = parseInfluxQl(r.body, spec);
    } else {
      const org = opts.org?.trim();
      const r = await ask(
        {
          method: 'POST',
          url: '/api/v2/query',
          ...(org ? { query: { org } } : {}),
          headers: { accept: 'application/csv' },
          body: {
            query: fluxQuery(spec),
            type: 'flux',
            dialect: { header: true, delimiter: ',', annotations: ['datatype', 'group', 'default'], dateTimeFormat: 'RFC3339Nano' },
          },
          bodyType: 'json',
          rawText: true,
          intent: 'read',
        },
        'the Flux query',
      );
      series = parseFlux(typeof r.body === 'string' ? r.body : '', spec);
    }
  } catch (e) {
    if (e instanceof InfluxQueryError) throw new InfluxError(redact(e.message, secrets).slice(0, 500));
    throw e;
  }
  return capSeries(series, spec, opts.expectedSeries);
}

// ---------- connection test ----------

export interface InfluxTestCheck {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * "Test connection" of an InfluxDB platform: the version's ping or health endpoint, then one cheap request that needs
 * the credentials, so a wrong token fails the test. Throws with the reason when it fails.
 */
export async function testInflux(p: Platform, secrets: Record<string, string>): Promise<{ message: string; checks: InfluxTestCheck[] }> {
  const version = platformVersion(p);
  const signal = AbortSignal.timeout(30000);
  const checks: InfluxTestCheck[] = [];
  const header = (r: HttpResult, k: string) => r.headers[k] ?? r.headers[k.toLowerCase()];
  const step = async (name: string, req: HttpRequest, judge: (r: HttpResult) => string): Promise<string> => {
    const r = await influxRequest(p, secrets, req, signal);
    if (!r.ok) {
      const e = await failure(p, secrets, r, `${req.method} ${req.url}`);
      checks.push({ name, ok: false, message: e.message });
      throw new InfluxError(`${e.message}${checks.length > 1 ? ` (${checks.length - 1} earlier step(s) passed)` : ''}`, r.status);
    }
    const message = judge(r);
    checks.push({ name, ok: true, message });
    return message;
  };
  if (version === '1') {
    const ping = await step(
      'ping',
      { method: 'GET', url: '/ping' },
      (r) => `GET /ping → HTTP ${r.status}${header(r, 'x-influxdb-version') ? `, InfluxDB ${header(r, 'x-influxdb-version')}` : ''}`,
    );
    await step('sign-in', { method: 'GET', url: '/query', query: { q: 'SHOW DATABASES' } }, (r) => {
      const err = influxQlError(r.body);
      if (err) throw new InfluxError(redact(`SHOW DATABASES failed: ${err}`, secrets).slice(0, 300));
      return 'SHOW DATABASES answered: the credentials work';
    });
    return { message: `${ping}; the credentials work`, checks };
  }
  // 2.x: /health needs no token
  const health = await step('health', { method: 'GET', url: '/health' }, (r) => {
    const b = (isJson(r) ? r.body : null) as { status?: string; version?: string; message?: string } | null;
    if (b?.status && b.status !== 'pass')
      throw new InfluxError(`InfluxDB reports status "${String(b.status).slice(0, 40)}": ${String(b.message ?? '').slice(0, 200)}`);
    return `GET /health → ${b?.status ?? `HTTP ${r.status}`}${b?.version ? `, InfluxDB ${String(b.version).slice(0, 40)}` : ''}`;
  });
  const org = String(p.config.variables?.org ?? '').trim();
  await step(
    'token',
    { method: 'GET', url: '/api/v2/buckets', query: { limit: 1, ...(org ? { org } : {}) } },
    () => 'GET /api/v2/buckets answered: the token works',
  );
  return { message: `${health}; the token works`, checks };
}

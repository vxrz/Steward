import type { Platform } from '@sm/shared';
import { audit } from '../audit.js';
import { buildUrl, platformRequest, secretValues, tokenInfo } from './http.js';
import { judgeHttpTest } from './connectionTest.js';
import { driverOf } from './drivers.js';
import { shownHeaders, where } from './answers.js';

/** The answer of "Test connection" (POST /platforms/:id/test) and of the periodic test (v0.4.0). */
export interface ConnectionTestResult {
  ok: boolean;
  status: number;
  durationMs: number;
  message: string;
  body?: unknown;
  headers?: Record<string, string>;
  url?: string;
  checks?: { name: string; ok: boolean; message: string }[];
  token?: { fetchedAt: string; expiresAt: string } | null;
}

/** Every secret value of the platform in a string, object or list → *** */
export function redactSecrets<T>(v: T, secrets: Record<string, string>): T {
  const vals = secretValues(secrets);
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return vals.reduce((s, sec) => (sec && s.includes(sec) ? s.split(sec).join('***') : s), x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [k, walk(val)]));
    return x;
  };
  return walk(v) as T;
}

/**
 * Tests the connection of a platform and writes `platform.tested` to the audit log (the platform list's "last test"
 * and the platform page's health read it). `periodic`: started by the platform's periodic test (actor system).
 * Never throws for a failing platform: the result says why.
 */
export async function runConnectionTest(p: Platform, secrets: Record<string, string>, opts: { periodic?: boolean } = {}): Promise<ConnectionTestResult> {
  const actor = opts.periodic ? { actor: 'system' } : {};
  const extra = opts.periodic ? { periodic: true } : {};
  const done = (r: ConnectionTestResult, summary: string): ConnectionTestResult => {
    audit({
      ...actor,
      action: 'platform.tested',
      entityType: 'platform',
      entityId: p.id,
      summary,
      details: { ok: r.ok, ...(r.status ? { status: r.status } : {}), message: r.message.slice(0, 500), ...extra },
    });
    return r;
  };
  const testPath = p.config.testPath || '/';
  // a connector with its own test (platforms/drivers.ts): Kafka, MQTT, AWS, Snowflake, databases, Microsoft Graph …
  const own = driverOf(p.kind)?.test;
  if (own) {
    const t0 = Date.now();
    try {
      const r = await own.run(p, secrets);
      const message = redactSecrets(r.message, secrets);
      return done(
        {
          ok: r.ok,
          // a database answers no HTTP status: the UI shows none
          status: r.ok && !own.noStatus ? 200 : 0,
          durationMs: Date.now() - t0,
          message,
          body: null,
          token: own.token ? tokenInfo(p) : null,
          ...(r.checks ? { checks: redactSecrets(r.checks, secrets) } : {}),
        },
        `Connection test "${p.name}": ${message.slice(0, 300)}${r.ok ? '' : ' – failed'}`,
      );
    } catch (e) {
      let message = redactSecrets((e as Error).message, secrets);
      if (own.failureHint) message = own.failureHint(message, p);
      return done({ ok: false, status: 0, durationMs: Date.now() - t0, message }, `Connection test "${p.name}" failed: ${message.slice(0, 200)}`);
    }
  }
  try {
    // at most 1 MB of the answer: enough to tell an API from a page, and to show it
    const res = await platformRequest(p, secrets, { method: 'GET', url: testPath, truncateResponseBytes: 1024 * 1024 });
    // say which request was made: without a test path it is the base URL itself (often a portal behind its own login)
    const what = `GET ${testPath}${p.config.testPath ? '' : ' (no test path set: the base URL itself)'}`;
    // a status below 400 is not enough: a redirect to a sign-in page or an HTML portal page is no working API (v0.3.1)
    const verdict = judgeHttpTest(p, what, await buildUrl(p, secrets, testPath), res);
    return done(
      {
        ok: verdict.ok,
        status: res.status,
        durationMs: res.durationMs,
        message: redactSecrets(verdict.message, secrets),
        body: redactSecrets(res.body, secrets),
        // who answered: content type, server, proxy, sign-in challenge, redirect target
        headers: redactSecrets(shownHeaders(res.headers), secrets),
        url: where(res.url),
        // when the cached access token was issued: roles granted later need a new one (POST …/token/renew)
        token: tokenInfo(p),
      },
      `Connection test "${p.name}": GET ${testPath} → HTTP ${res.status} (${res.durationMs} ms)${verdict.ok ? '' : ' – failed'}`,
    );
  } catch (e) {
    const message = redactSecrets((e as Error).message, secrets);
    return done({ ok: false, status: 0, durationMs: 0, message }, `Connection test "${p.name}" failed: ${message.slice(0, 200)}`);
  }
}

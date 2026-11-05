import { LLM_GATEWAY_KIND, PVAULT_KIND, type Platform } from '@sm/shared';
import { audit } from '../audit.js';
import { buildUrl, platformRequest, secretValues, tokenInfo } from './http.js';
import { judgeHttpTest } from './connectionTest.js';
import { snowflakeJwtHint } from './jwt.js';
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
  // Microsoft Graph (v0.5.0): the sign-in, the admin consent and every part Steward reads, with what is missing;
  // LLM gateways (0.6.0): the model list and one minimal request per model that is set up
  if (p.kind === 'microsoft-graph' || p.kind === LLM_GATEWAY_KIND) {
    const t0 = Date.now();
    try {
      const r =
        p.kind === LLM_GATEWAY_KIND
          ? await (await import('../ai/gateway.js')).testGateway(p, secrets)
          : await (await import('../entra/service.js')).testGraph(p, secrets);
      const message = redactSecrets(r.message, secrets);
      return done(
        {
          ok: r.ok,
          status: r.ok ? 200 : 0,
          durationMs: Date.now() - t0,
          message,
          body: null,
          token: tokenInfo(p.id),
          checks: redactSecrets(r.checks, secrets),
        },
        `Connection test "${p.name}": ${message.slice(0, 300)}${r.ok ? '' : ' – failed'}`,
      );
    } catch (e) {
      const message = redactSecrets((e as Error).message, secrets);
      return done({ ok: false, status: 0, durationMs: Date.now() - t0, message }, `Connection test "${p.name}" failed: ${message.slice(0, 200)}`);
    }
  }
  // Kafka (#112) and MQTT (#113) are no HTTP APIs: their test connects to the cluster or broker; AWS (#116) asks STS who it is
  if (p.kind === 'kafka' || p.kind === 'mqtt' || p.kind === 'aws' || p.kind === 'snowflake' || p.kind === PVAULT_KIND) {
    const t0 = Date.now();
    try {
      let checks: { name: string; ok: boolean; message: string }[] | undefined;
      const message =
        p.kind === 'kafka'
          ? await (await import('../kafka/service.js')).testKafka(p, secrets)
          : p.kind === 'aws'
            ? await (await import('../aws/service.js')).testAws(p, secrets).then((r) => ((checks = r.checks), r.message))
            : p.kind === 'snowflake'
              ? await (await import('../snowflake/service.js')).testSnowflake(p, secrets)
              : p.kind === PVAULT_KIND
                ? // IBM Verify Privilege Vault (#205): signs in, then every read Steward makes, naming missing permissions
                  await (await import('../pvault/service.js')).testPrivilegeVault(p, secrets).then((r) => ((checks = r.checks), r.message))
                : await (await import('../mqtt/listener.js')).testMqtt(p, secrets);
      // AWS: every part Steward reads, with what is missing (the test passes when STS works)
      return done(
        {
          ok: true,
          status: 200,
          durationMs: Date.now() - t0,
          message,
          body: null,
          token: p.kind === PVAULT_KIND ? tokenInfo(p.id) : null,
          ...(checks ? { checks: redactSecrets(checks, secrets) } : {}),
        },
        `Connection test "${p.name}": ${message}`,
      );
    } catch (e) {
      let message = redactSecrets((e as Error).message, secrets);
      // Snowflake's "390144 JWT token is invalid" says nothing about why: the usual causes
      if (p.kind === 'snowflake') message = snowflakeJwtHint(message, p.config.variables);
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
        token: tokenInfo(p.id),
      },
      `Connection test "${p.name}": GET ${testPath} → HTTP ${res.status} (${res.durationMs} ms)${verdict.ok ? '' : ' – failed'}`,
    );
  } catch (e) {
    const message = redactSecrets((e as Error).message, secrets);
    return done({ ok: false, status: 0, durationMs: 0, message }, `Connection test "${p.name}" failed: ${message.slice(0, 200)}`);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { ADMIN, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Operations metrics (O7), the HTTP server's metrics and spans (O11), one metric prefix with deprecated aliases, and
 * database timing (A8) – docs/METRICS.md.
 */
const exporter = new InMemorySpanExporter();
let s: TestServer;

beforeAll(async () => {
  s = await startTestServer();
  const { initTelemetry } = await import('../src/telemetry.js');
  initTelemetry({ exporter, simple: true });
  await setup(s);
});
afterAll(async () => {
  await s?.app.close();
});

const metrics = async (): Promise<string> => s.api('GET', '/metrics');
/** The value of one series ("name{labels}" exactly, or a name without labels). */
const value = (text: string, series: string): number | undefined => {
  const line = text.split('\n').find((l) => l.startsWith(series + ' '));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
};

describe('operations metrics', () => {
  it('report the vault, readiness and the build', async () => {
    const text = await metrics();
    expect(value(text, 'sm_vault_unlocked')).toBe(1);
    expect(value(text, 'sm_readiness_check{check="vault"}')).toBe(1);
    expect(value(text, 'sm_readiness_check{check="database"}')).toBe(1);
    expect(value(text, 'sm_ready')).toBe(value(text, 'sm_readiness_check{check="scheduler"}'));
    const { config } = await import('../src/config.js');
    expect(text).toMatch(new RegExp(`^sm_build_info\\{version="${config.version.replace(/\./g, '\\.')}",commit="[^"]+"\\} 1$`, 'm'));
  });

  it('report the last backup and restore test (0 before the first), from the backup runs', async () => {
    let text = await metrics();
    for (const m of [
      'sm_backup_enabled',
      'sm_backup_last_success_timestamp_seconds',
      'sm_backup_last_failure_timestamp_seconds',
      'sm_backup_last_size_bytes',
      'sm_backup_restore_test_last_success_timestamp_seconds',
      'sm_backup_restore_test_last_failure_timestamp_seconds',
    ])
      expect(value(text, m), m).toBe(0);
    const { db } = await import('../src/db.js');
    const add = (id: string, kind: string, status: string, at: string, bytes: number | null) =>
      db().run(
        "INSERT INTO backup_runs (id, kind, status, trigger_kind, started_at, finished_at, bytes, steps) VALUES (?, ?, ?, 'schedule', ?, ?, ?, '[]')",
        id,
        kind,
        status,
        at,
        at,
        bytes,
      );
    add('bkp_m1', 'backup', 'succeeded', '2026-11-01T02:15:00.000Z', 1000);
    add('bkp_m2', 'backup', 'succeeded', '2026-11-02T02:15:00.000Z', 2500);
    add('bkp_m3', 'backup', 'failed', '2026-11-03T02:15:00.000Z', null);
    add('bkp_m4', 'restore_test', 'succeeded', '2026-11-01T03:45:00.000Z', 2500);
    add('bkp_m5', 'backup', 'running', '2026-11-04T02:15:00.000Z', null);
    await new Promise((r) => setTimeout(r, 1100)); // the backup rows are read at most once a second
    text = await metrics();
    expect(value(text, 'sm_backup_last_success_timestamp_seconds')).toBe(Date.parse('2026-11-02T02:15:00Z') / 1000);
    expect(value(text, 'sm_backup_last_size_bytes')).toBe(2500);
    expect(value(text, 'sm_backup_last_failure_timestamp_seconds')).toBe(Date.parse('2026-11-03T02:15:00Z') / 1000);
    expect(value(text, 'sm_backup_restore_test_last_success_timestamp_seconds')).toBe(Date.parse('2026-11-01T03:45:00Z') / 1000);
    expect(value(text, 'sm_backup_restore_test_last_failure_timestamp_seconds')).toBe(0);
  });

  it('can be scraped while the vault is locked, and say so', async () => {
    await s.api('POST', '/vault/lock');
    try {
      await new Promise((r) => setTimeout(r, 1100));
      const text = await metrics();
      expect(value(text, 'sm_vault_unlocked')).toBe(0);
      expect(value(text, 'sm_ready')).toBe(0);
      expect(value(text, 'sm_readiness_check{check="vault"}')).toBe(0);
      // the rest of the API still waits for the unlock
      await expect(s.api('GET', '/runs')).rejects.toMatchObject({ status: 423 });
    } finally {
      await s.api('POST', '/vault/unlock', { passphrase: 'correct horse battery' });
    }
  });
});

describe("Steward's own HTTP server", () => {
  it('has a request duration histogram by method, route template and status code', async () => {
    await s.api('GET', '/runs?limit=1');
    await expect(s.api('GET', '/runs/run_does_not_exist')).rejects.toMatchObject({ status: 404 });
    const text = await metrics();
    expect(text).toMatch(
      /^sm_http_server_request_duration_seconds_count\{http_request_method="GET",http_route="\/api\/runs",http_response_status_code="200"\} [1-9]/m,
    );
    // the template, not the path: ids never become label values
    expect(text).toMatch(/http_route="\/api\/runs\/:id",http_response_status_code="404"/);
    expect(text).not.toContain('run_does_not_exist');
    expect(text).toMatch(/^sm_http_server_request_duration_seconds_bucket\{le="0\.005",http_request_method="GET",http_route="\/api\/runs"/m);
  });

  it('opens a SERVER span per request (OpenTelemetry HTTP conventions), continuing the caller’s trace', async () => {
    exporter.reset();
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const res = await fetch(`${s.base}/api/health?x=1`, { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` } });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    const span = exporter.getFinishedSpans().find((sp) => sp.name === 'GET /api/health')!;
    expect(span).toBeTruthy();
    expect(span.kind).toBe(1); // SpanKind.SERVER
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/api/health',
      'url.path': '/api/health',
      'url.scheme': 'http',
      'http.response.status_code': 200,
    });
    expect(Object.keys(span.attributes)).not.toContain('client.address');
  });
});

describe('the shipped alert rules (examples/prometheus/steward-alerts.yml)', () => {
  it('use only metrics Steward serves, and every rule has a severity and a summary', async () => {
    const file = path.resolve(__dirname, '..', '..', 'examples', 'prometheus', 'steward-alerts.yml');
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    const rules = doc.groups.flatMap((g: any) => g.rules);
    expect(rules.map((r: any) => r.alert)).toEqual(
      expect.arrayContaining(['StewardVaultLocked', 'StewardNotReady', 'StewardSchedulerStalled', 'StewardBackgroundJobFailing', 'StewardNoRecentBackup']),
    );
    // what a started server has registered (bootstrap.ts): the background jobs and their metrics
    const { registerFeatureJobs } = await import('../src/features/index.js');
    const { registeredJobs } = await import('../src/jobs/registry.js');
    registerFeatureJobs();
    const { startEventLoopMonitor, stopEventLoopMonitor } = await import('../src/eventloop.js');
    startEventLoopMonitor();
    const text = await metrics().finally(() => stopEventLoopMonitor());
    const served = new Set(text.split('\n').flatMap((l) => (l.startsWith('# TYPE ') ? [l.split(' ')[2]!] : [])));
    for (const r of rules) {
      expect(r.alert, JSON.stringify(r)).toMatch(/^Steward[A-Z]\w+$/);
      expect(['critical', 'warning', 'info'], r.alert).toContain(r.labels?.severity);
      expect(r.annotations?.summary, r.alert).toBeTruthy();
      expect(r.for, r.alert).toMatch(/^\d+[smh]$/);
      for (const m of String(r.expr).match(/\bsm_[a-z0-9_]+/g) ?? []) {
        const base = m.replace(/_(bucket|count|sum)$/, '');
        expect(served.has(m) || served.has(base), `${r.alert}: ${m}`).toBe(true);
        // never the deprecated names
        expect(text, m).not.toContain(`# HELP ${base} Deprecated`);
      }
    }
    // the scheduler rule names a job that exists
    expect(registeredJobs()).toContain('scheduler-heartbeat');
  });
});

describe('one metric prefix', () => {
  it('serves the renamed metrics under their new sm_ names and, until 0.12, the old ones as deprecated aliases', async () => {
    const { countEvaluation } = await import('../src/monitors/metrics.js');
    countEvaluation('heartbeat', 'up');
    const text = await metrics();
    expect(value(text, 'sm_monitor_evaluations_total{type="heartbeat",result="up"}')).toBeGreaterThanOrEqual(1);
    expect(value(text, 'steward_monitor_evaluations_total{type="heartbeat",result="up"}')).toBe(
      value(text, 'sm_monitor_evaluations_total{type="heartbeat",result="up"}'),
    );
    expect(text).toContain('# HELP steward_monitor_evaluations_total Deprecated: use sm_monitor_evaluations_total (this name is removed in 0.12).');
    for (const [old, now] of [
      ['steward_mcp_requests_total', 'sm_mcp_requests_total'],
      ['steward_mcp_tool_calls_total', 'sm_mcp_tool_calls_total'],
      ['steward_mcp_gateway_calls_total', 'sm_mcp_gateway_calls_total'],
      ['steward_monitor_status', 'sm_monitor_status'],
      ['steward_monitor_last_ok_timestamp', 'sm_monitor_last_ok_timestamp_seconds'],
      ['sm_http_requests_total', 'sm_http_client_requests_total'],
      ['sm_http_request_duration_seconds', 'sm_http_client_request_duration_seconds'],
    ]) {
      expect(text, now).toContain(`# TYPE ${now} `);
      expect(text, old).toContain(`# HELP ${old} Deprecated: use ${now} `);
    }
    // no other prefix
    const names = new Set(text.split('\n').flatMap((l) => (l.startsWith('# TYPE ') ? [l.split(' ')[2]!] : [])));
    expect([...names].filter((n) => !n.startsWith('sm_') && !n.startsWith('steward_'))).toEqual([]);
  });
});

describe('database timing', () => {
  it('measures statements by kind and transactions, and logs slow ones without their values', async () => {
    const { db } = await import('../src/db.js');
    const { overrideConfig, reloadConfig } = await import('../src/config.js');
    const { logger } = await import('../src/log.js');
    db().get('SELECT 1 AS x');
    db().tx(() => db().run("UPDATE settings SET value = value WHERE key = 'none'"));
    let text = await metrics();
    const dialect = db().dialect;
    expect(value(text, `sm_db_statement_duration_seconds_count{dialect="${dialect}",operation="select"}`)).toBeGreaterThan(0);
    expect(value(text, `sm_db_statement_duration_seconds_count{dialect="${dialect}",operation="update"}`)).toBeGreaterThan(0);
    expect(value(text, `sm_db_transaction_duration_seconds_count{dialect="${dialect}"}`)).toBeGreaterThan(0);

    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    const warn = logger.warn.bind(logger);
    (logger as unknown as { warn: (o: Record<string, unknown>, m: string) => void }).warn = (obj, msg) => void lines.push({ obj, msg });
    overrideConfig({ SM_DB_SLOW_MS: 1 });
    try {
      // a statement that takes a while on both databases
      const slow =
        dialect === 'sqlite'
          ? "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300000) SELECT COUNT(*) AS c FROM n WHERE 'secret-value' <> ?"
          : "SELECT pg_sleep(0.02), 'x' <> ? AS c";
      db().get(slow, 'parameter-value');
      db().get(slow, 'parameter-value'); // a second time within a minute: counted, not logged again
    } finally {
      reloadConfig();
      (logger as unknown as { warn: typeof warn }).warn = warn;
    }
    const logged = lines.filter((l) => l.msg === 'slow database statement');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.obj).toMatchObject({ dialect, operation: dialect === 'sqlite' ? 'with' : 'select', slowMs: 1 });
    expect(String(logged[0]!.obj.sql).length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(logged[0]!.obj)).not.toContain('parameter-value');
    text = await metrics();
    expect(value(text, `sm_db_slow_statements_total{dialect="${dialect}",operation="${dialect === 'sqlite' ? 'with' : 'select'}"}`)).toBeGreaterThanOrEqual(2);
  });

  it('names statement kinds from a small fixed set', async () => {
    const { statementKind } = await import('../src/database/timing.js');
    expect(
      [
        'SELECT 1',
        '  select * from runs',
        '(SELECT 1) UNION (SELECT 2)',
        '/* c */ INSERT INTO x VALUES (1)',
        '-- c\nUPDATE x SET a = 1',
        'DELETE FROM x',
        'WITH a AS (SELECT 1) SELECT * FROM a',
        'CREATE TABLE t (id TEXT)',
        'VACUUM',
        'PRAGMA wal_checkpoint',
        'BEGIN IMMEDIATE',
        'FETCH 1000 FROM c',
        'EXPLAIN SELECT 1',
      ].map(statementKind),
    ).toEqual(['select', 'select', 'select', 'insert', 'update', 'delete', 'with', 'ddl', 'ddl', 'pragma', 'transaction', 'cursor', 'other']);
  });

  it('adds the database time of a request to its trace span', async () => {
    exporter.reset();
    const signedIn = await s.as(ADMIN.username, ADMIN.password);
    await signedIn('GET', '/runs?limit=1');
    await new Promise((r) => setTimeout(r, 50));
    const span = exporter.getFinishedSpans().find((sp) => sp.name === 'GET /api/runs')!;
    expect(Number(span.attributes['sm.db.statements'])).toBeGreaterThan(0);
    expect(typeof span.attributes['sm.db.duration_ms']).toBe('number');
  });
});

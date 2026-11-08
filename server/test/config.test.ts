import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, VARS, parseEnv, parseEnvPart, withoutName } from '../src/config-schema.js';

const SERVER = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(SERVER, '..');

describe('configuration schema', () => {
  it('keeps every default when nothing is set', () => {
    const e = parseEnv({});
    expect(e).toMatchObject({
      SM_PORT: 4310,
      SM_HOST: '127.0.0.1',
      SM_ALLOWED_HOSTS: [],
      SM_DEMO: false,
      SM_UPGRADE_BACKUPS: 3,
      SM_SESSION_IDLE_MINUTES: 30,
      SM_SESSION_MAX_HOURS: 12,
      SM_STEP_UP_MINUTES: 5,
      SM_RATE_LIMIT_PER_MINUTE: 600,
      SM_API_RATE_LIMIT: 600,
      SM_API_V1: true,
      SM_MCP_RATE_LIMIT: 120,
      SM_MCP_GATEWAY_RATE_LIMIT: 30,
      SM_MCP_GATEWAY_CONCURRENCY: 2,
      SM_METRICS_PUBLIC: false,
      SM_METRIC_RETENTION_DAYS: 400,
      SM_AUDIT_CHECKPOINT_MINUTES: 60,
      SM_EVIDENCE_MAX_MB: 512,
      SM_EVIDENCE_RETENTION_DAYS: 7,
      SM_MIGRATION_MAX_MB: 2048,
      SM_MIGRATION_MAX_UNPACKED_MB: 20480,
      SM_EXPR_TIMEOUT_MS: 5000,
      SM_EXPR_MAX_DEPTH: 1000,
      SM_EXPR_MAX_SEQUENCE: 1_000_000,
      SM_PDF_WORKER: 'auto',
      SM_OTEL_PROPAGATE: true,
      SM_SENTRY_ENVIRONMENT: 'production',
      SM_SENTRY_TRACES_SAMPLE_RATE: 0,
      SM_PG_DUMP: 'pg_dump',
      SM_PG_RESTORE: 'pg_restore',
      SM_BACKUP_SINGLE_PUT_BYTES: 32 * 1024 * 1024,
      SM_BACKUP_PART_BYTES: 16 * 1024 * 1024,
      SM_MONITOR_AUTOSTART: true,
      SM_MONITOR_TICK_MS: 1000,
      SM_MONITOR_CONCURRENCY: 8,
      SM_MONITOR_EVAL_CONCURRENCY: 8,
      SM_GATUS_AUTOSTART: true,
      SM_PASSWORD_HASH_CONCURRENCY: 2,
    });
    expect(e.SM_PASSWORD_LOGIN).toBeUndefined();
    expect(e.SM_MCP).toBeUndefined();
    expect(e.SM_CHROMIUM_SANDBOX).toBeUndefined();
    expect(e.SM_TRUST_PROXY).toBeUndefined();
  });

  it('parses the value types (blank = not set)', () => {
    const e = parseEnv({
      SM_PORT: ' 0 ',
      SM_ALLOWED_HOSTS: 'a.example.com, ,b.example.com',
      SM_GATUS_AUTOSTART: '0',
      SM_MONITOR_AUTOSTART: 'off',
      SM_METRICS_PUBLIC: '1',
      SM_API_V1: 'disabled',
      SM_MCP: 'off',
      SM_RATE_LIMIT_PER_MINUTE: 'off',
      SM_API_RATE_LIMIT: '0',
      SM_TRUST_PROXY: 'loopback, 10.0.0.0/8',
      SM_BASE_PATH: 'steward/',
      SM_CHROMIUM_SANDBOX: 'true',
      SM_PDF_WORKER: 'on',
      SM_SENTRY_TRACES_SAMPLE_RATE: '0.25',
      SM_MIGRATION_MAX_UNPACKED_MB: '0.5',
      SM_HOST: '   ',
    });
    expect(e).toMatchObject({
      SM_PORT: 0,
      SM_ALLOWED_HOSTS: ['a.example.com', 'b.example.com'],
      SM_GATUS_AUTOSTART: false,
      SM_MONITOR_AUTOSTART: false,
      SM_METRICS_PUBLIC: true,
      SM_API_V1: false,
      SM_MCP: false,
      SM_RATE_LIMIT_PER_MINUTE: 0,
      SM_API_RATE_LIMIT: 0,
      SM_TRUST_PROXY: ['loopback', '10.0.0.0/8'],
      SM_BASE_PATH: '/steward',
      SM_CHROMIUM_SANDBOX: true,
      SM_PDF_WORKER: 'auto',
      SM_SENTRY_TRACES_SAMPLE_RATE: 0.25,
      SM_MIGRATION_MAX_UNPACKED_MB: 0.5,
      SM_HOST: '127.0.0.1',
    });
  });

  it('names every bad variable on its own line', () => {
    let err: unknown;
    try {
      parseEnv({
        SM_PORT: '80a',
        SM_API_DOCS: 'everyone',
        SM_STEP_UP_MINUTES: '30',
        SM_GATUS_AUTOSTART: 'maybe',
        SM_TRUST_PROXY: 'true',
        SM_BASE_PATH: '/a b',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    expect(ce.problems.map((p) => p.name).sort()).toEqual([
      'SM_API_DOCS',
      'SM_BASE_PATH',
      'SM_GATUS_AUTOSTART',
      'SM_PORT',
      'SM_STEP_UP_MINUTES',
      'SM_TRUST_PROXY',
    ]);
    expect(ce.message).toContain('SM_PORT: "80a" is not a whole number from 0 to 65535');
    expect(ce.message).toContain('SM_API_DOCS: "everyone" is not one of off, authenticated, public');
    expect(ce.message).toContain('SM_STEP_UP_MINUTES: "30" is not a whole number from 1 to 15');
    expect(ce.message).toMatch(/SM_TRUST_PROXY: .*trust any client/);
    expect(ce.message.split('\n')).toHaveLength(7);
  });

  it('reads only some variables for the CLIs and the health check', () => {
    expect(parseEnvPart({ SM_PORT: '4400', SM_API_DOCS: 'nonsense' }, ['SM_PORT'])).toEqual({ SM_PORT: 4400 });
    expect(() => parseEnvPart({ SM_PORT: 'x' }, ['SM_PORT'])).toThrow(/SM_PORT: "x"/);
  });

  it('documents every variable, and every SM_* variable the server reads is in the schema', () => {
    for (const [name, x] of Object.entries(VARS)) {
      expect(x.doc.description.length, name).toBeGreaterThan(10);
    }
    // a variable read anywhere in server/src must be declared (the ESLint rule keeps reads in config.ts); the contract
    // check (cli/contract.ts) is an API client with variables of its own (STEWARD_URL / SM_URL, …), not server settings
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, f.name);
        if (f.isDirectory()) walk(full);
        else if (f.name.endsWith('.ts') && f.name !== 'contract.ts')
          for (const m of fs.readFileSync(full, 'utf8').matchAll(/\benv\.(SM_[A-Z0-9_]+)/g)) names.add(m[1]!);
      }
    };
    walk(path.join(SERVER, 'src'));
    for (const n of names) expect(Object.keys(VARS), n).toContain(n);
  });
});

describe('start-up', () => {
  it('refuses to start with an invalid variable and says which one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-config-'));
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: SERVER,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, SM_DATA_DIR: dir, SM_PORT: 'eighty', SM_SESSION_MAX_HOURS: '0', SM_LOG_LEVEL: 'silent' },
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Invalid configuration');
      expect(r.stderr).toContain('SM_PORT: "eighty" is not a whole number from 0 to 65535');
      expect(r.stderr).toContain('SM_SESSION_MAX_HOURS: "0" is not a whole number from 1 to 720');
      expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reloadConfig() re-reads process.env into the same object (tests)', async () => {
    const { env, reloadConfig, overrideConfig } = await import('../src/config.js');
    const before = process.env.SM_API_RATE_LIMIT;
    try {
      process.env.SM_API_RATE_LIMIT = '7';
      expect(reloadConfig()).toBe(env);
      expect(env.SM_API_RATE_LIMIT).toBe(7);
      overrideConfig({ SM_API_RATE_LIMIT: 9 });
      expect(env.SM_API_RATE_LIMIT).toBe(9);
      process.env.SM_API_RATE_LIMIT = 'lots';
      expect(() => reloadConfig()).toThrow(ConfigError);
    } finally {
      if (before === undefined) delete process.env.SM_API_RATE_LIMIT;
      else process.env.SM_API_RATE_LIMIT = before;
      reloadConfig();
    }
  });
});

describe('generated documentation', () => {
  it('docs/CONFIGURATION.md matches the schema (npm run config:docs -- --check)', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'server/src/cli/config-docs.ts', '--check'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('withoutName', () => {
  it('drops a leading variable name and its separator, nothing else', () => {
    expect(withoutName('SM_BASE_PATH: must start with /', 'SM_BASE_PATH')).toBe('must start with /');
    expect(withoutName('SM_BASE_PATH=x is not allowed', 'SM_BASE_PATH')).toBe('x is not allowed');
    expect(withoutName('SM_BASE_PATHS: other', 'SM_BASE_PATH')).toBe('SM_BASE_PATHS: other');
    expect(withoutName('must start with /', 'SM_BASE_PATH')).toBe('must start with /');
    // a name with regex characters is taken literally
    expect(withoutName('A.B: x', 'A.B')).toBe('x');
    expect(withoutName('AxB: x', 'A.B')).toBe('AxB: x');
  });
});

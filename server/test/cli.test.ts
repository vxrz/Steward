import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

function run(script: string, args: string[], env: Record<string, string> = {}, input?: string) {
  const r = spawnSync(TSX, [path.join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    env: { ...process.env, NO_COLOR: '1', SM_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cli-')), ...env },
    timeout: 60000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const validate = (...a: string[]) => run('server/src/cli/validate.ts', a);
const contract = (a: string[], env?: Record<string, string>, input?: string) => run('server/src/cli/contract.ts', a, env, input);
const desktop = (...a: string[]) => run('server/src/desktop/launcher.ts', a);

describe('validate CLI', () => {
  it('prints help and version', () => {
    const h = validate('--help');
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('Usage:');
    expect(h.stdout).toContain('Examples:');
    expect(validate('-V').stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects unknown options with a hint (exit 2, stderr)', () => {
    const r = validate('--jsno');
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("unknown option '--jsno'");
    expect(r.stderr).toContain('Did you mean --json?');
  });

  it('reports a missing path as usage error', () => {
    expect(validate('does/not/exist.yaml').code).toBe(2);
  });

  it('prints JSON and fails (exit 1) on an invalid definition', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-validate-'));
    fs.writeFileSync(path.join(dir, 'bad.yaml'), 'name: Broken\nnodes: [{ id: a, type: nope }]\nwires: []\n');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const r = validate('--json', dir);
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(false);
    expect(out.errors).toBe(2);
    expect(out.files.map((f: { kind: string }) => f.kind).sort()).toEqual(['process', 'unreadable']);
  });

  it('accepts the example library without colours when piped', () => {
    const r = validate(path.join(ROOT, 'examples', 'processes'));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 error(s)');
    expect(r.stdout).not.toContain('\x1b[');
  });
});

describe('contract CLI', () => {
  it('needs a platform and a token (exit 2)', () => {
    const r = contract([], { SM_TOKEN: '', STEWARD_TOKEN: '', SM_PLATFORM: '', STEWARD_PLATFORM: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('no platform given');
    expect(contract(['--platform', 'p'], { SM_TOKEN: '', STEWARD_TOKEN: '' }).stderr).toContain('no API token given');
  });

  it('rejects unknown options', () => {
    const r = contract(['--plattform', 'x']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Did you mean --platform?');
  });

  it('takes the token from STEWARD_TOKEN or a file and never prints it', () => {
    const token = 'smt_cliTestToken0123456789';
    const fromEnv = contract(['--url', 'http://127.0.0.1:9', '--platform', 'p', '--timeout', '5'], { STEWARD_TOKEN: token });
    expect(fromEnv.code).toBe(2);
    expect(fromEnv.stderr).toContain('Cannot reach http://127.0.0.1:9');
    const fromStdin = contract(['--url', 'http://127.0.0.1:9', '--platform', 'p', '--token-file', '-'], {}, `${token}\n`);
    expect(fromStdin.code).toBe(2);
    const onCommandLine = contract(['--url', 'http://127.0.0.1:9', '--platform', 'p', '--token', token]);
    expect(onCommandLine.stderr).toContain('warning: --token is visible in shell history');
    for (const r of [fromEnv, fromStdin, onCommandLine]) expect(r.stdout + r.stderr).not.toContain(token);
  });
});

describe('desktop launcher CLI', () => {
  it('prints help and version', () => {
    const h = desktop('-h');
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('--send-test-error');
    expect(desktop('--version').stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects unknown options and bad values (exit 2)', () => {
    const r = desktop('--no-opne');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Did you mean --no-open?');
    expect(desktop('--port', 'abc').code).toBe(2);
    expect(desktop('--autostart', 'yes').code).toBe(2);
  });

  it('--send-test-error fails without a DSN', () => {
    const r = desktop('--send-test-error');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('SM_SENTRY_DSN is not set');
  });
});

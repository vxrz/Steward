import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/** The stdio bridge (npm run mcp / steward mcp) against a running test server. */
let s: TestServer;
let token: string;
const root = path.resolve(import.meta.dirname, '../..');

interface Run {
  code: number | null;
  lines: any[];
  stdout: string;
  stderr: string;
}

/** Starts the bridge, writes the messages (one per line), closes stdin and collects the answers. */
function bridge(args: string[], messages: unknown[], env: Record<string, string | undefined> = {}, waitFor = messages.length): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/cli/mcp.ts', ...args], {
      cwd: root,
      env: { ...process.env, STEWARD_API_KEY: undefined, ...env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.split('\n').filter(Boolean).length >= waitFor) child.stdin.end();
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)); // stdout carries nothing but JSON-RPC messages
      resolve({ code, lines, stdout, stderr });
    });
    for (const m of messages) child.stdin.write(typeof m === 'string' ? `${m}\n` : `${JSON.stringify(m)}\n`);
    if (!waitFor) child.stdin.end();
  });
}

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/mcp-server', { enabled: true });
  token = (await s.api('POST', '/me/tokens', { name: 'bridge', scope: 'mcp' })).token;
});
afterAll(async () => s?.app.close());

describe('MCP stdio bridge', () => {
  it('legacy client: initialize, initialized, tools/list and a tool call', async () => {
    const r = await bridge(
      ['--url', s.base],
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'desktop', version: '1' } },
        },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
      ],
      { STEWARD_API_KEY: token },
      1,
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].result.protocolVersion).toBe('2025-06-18');
    expect(r.stdout).not.toContain(token);
  }, 40_000);

  it('modern client and a token file; errors keep the request id', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bridge-'));
    const file = path.join(dir, 'token');
    fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
    const r = await bridge(
      ['--url', s.base, '--api-key-file', file],
      [
        { jsonrpc: '2.0', id: 'a', method: 'server/discover', params: { _meta: meta } },
        { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: 'get_system_status', arguments: {}, _meta: meta } },
        'this is not json',
      ],
    );
    expect(r.code, r.stderr).toBe(0);
    const byId = new Map(r.lines.map((l) => [l.id ?? null, l]));
    expect(byId.get('a').result.supportedVersions).toEqual(['2026-07-28']);
    expect(byId.get('b').result.structuredContent.you.username).toBe('admin');
    expect(byId.get(null).error.code).toBe(-32700);
  }, 40_000);

  it('passes refusals on with the request id (wrong token scope)', async () => {
    const rest = (await s.api('POST', '/me/tokens', { name: 'rest', scope: 'read' })).token;
    const r = await bridge(['--url', s.base], [{ jsonrpc: '2.0', id: 7, method: 'server/discover', params: { _meta: meta } }], { STEWARD_API_KEY: rest });
    expect(r.lines[0]).toMatchObject({ id: 7, error: { code: -31003 } });
  }, 40_000);

  it('refuses to hand the token to a look-alike on the local port', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bridge-'));
    fs.writeFileSync(
      path.join(dir, 'instance.json'),
      JSON.stringify({ v: 1, product: 'steward', instanceId: 'other', secret: Buffer.alloc(32).toString('base64'), pid: 1, url: s.base, startedAt: '' }),
    );
    const r = await bridge(['--url', s.base, '--data-dir', dir], [], { STEWARD_API_KEY: token }, 0);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not the Steward started from/);
  }, 40_000);

  it('usage errors: no token, plain http to another host, bad URL', async () => {
    const none = await bridge(['--url', s.base], [], {}, 0);
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/no token/);
    const http = await bridge(['--url', 'http://steward.example.com'], [], { STEWARD_API_KEY: token }, 0);
    expect(http.code).toBe(2);
    expect(http.stderr).toMatch(/unencrypted/);
    const bad = await bridge(['--url', 'ftp://x'], [], { STEWARD_API_KEY: token }, 0);
    expect(bad.code).toBe(2);
    const help = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', 'server/src/cli/mcp.ts', '--help'], { cwd: root });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out));
    });
    expect(help).toMatch(/--api-key-file/);
  }, 60_000);
});

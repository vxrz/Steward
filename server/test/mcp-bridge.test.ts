import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
  // as main.ts does once the server listens: the bridge checks this proof before it sends the token
  const { writeInstanceFile } = await import('../src/instance.js');
  writeInstanceFile(s.base);
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
    const r = await bridge(['--url', s.base, '--data-dir', dir, '--wait', '0'], [], { STEWARD_API_KEY: token }, 0);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not the Steward started from/);
  }, 40_000);

  it('does not send the token to a local port while no instance file proves it is Steward', async () => {
    // a program on a local port while Steward is stopped (no instance.json in the data folder)
    const seen: (string | undefined)[] = [];
    const fake = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    try {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bridge-'));
      const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
      const started = Date.now();
      const r = await bridge(
        ['--url', url, '--data-dir', empty, '--wait', '1'],
        [{ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }],
        {
          STEWARD_API_KEY: token,
        },
        0,
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/no Steward has started from .*not sending the token.*--no-instance-check/s);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000); // it waited for Steward to start
      expect(seen.filter(Boolean)).toEqual([]);
      expect(r.stderr).not.toContain(token);
    } finally {
      fake.close();
    }
  }, 40_000);

  it('waits for a local Steward that is still starting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bridge-'));
    const pending = bridge(
      ['--url', s.base, '--data-dir', dir, '--wait', '20'],
      [{ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }],
      {
        STEWARD_API_KEY: token,
      },
    );
    await new Promise((r) => setTimeout(r, 1500));
    fs.copyFileSync(path.join(s.dataDir, 'instance.json'), path.join(dir, 'instance.json'));
    const r = await pending;
    expect(r.code, r.stderr).toBe(0);
    expect(r.lines[0].result.supportedVersions).toEqual(['2026-07-28']);
  }, 40_000);

  it('--no-instance-check skips the proof with a warning', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bridge-'));
    const r = await bridge(
      ['--url', s.base, '--data-dir', empty, '--no-instance-check'],
      [{ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: meta } }],
      {
        STEWARD_API_KEY: token,
      },
    );
    expect(r.code, r.stderr).toBe(0);
    expect(r.lines[0].result.supportedVersions).toEqual(['2026-07-28']);
    expect(r.stderr).toMatch(/warning: --no-instance-check/);
  }, 40_000);

  it('proves the identity again after the connection was lost', async () => {
    // a stand-in for Steward on its own port that knows the secret of its data folder …
    const { proofOf } = await import('../src/instance-proof.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bridge-'));
    const secret = Buffer.alloc(32, 7).toString('base64');
    const seen: { who: string; auth?: string }[] = [];
    const serve = (who: string, port: number) =>
      new Promise<http.Server>((resolve) => {
        const srv = http.createServer((req, res) => {
          const u = new URL(req.url!, 'http://x');
          if (u.pathname === '/api/instance') {
            const proof = who === 'steward' ? proofOf(secret, u.searchParams.get('challenge')!, port) : 'nope';
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ instanceId: 'i1', proof }));
            return;
          }
          seen.push({ who, auth: req.headers.authorization });
          let body = '';
          req.on('data', (d) => (body += d));
          req.on('end', () =>
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(body).id, result: { who } })),
          );
        });
        srv.listen(port, '127.0.0.1', () => resolve(srv));
      });
    let steward = await serve('steward', 0);
    const port = (steward.address() as AddressInfo).port;
    steward.close();
    steward = await serve('steward', port);
    fs.writeFileSync(path.join(dir, 'instance.json'), JSON.stringify({ v: 1, product: 'steward', instanceId: 'i1', secret, pid: 1, url: '', startedAt: '' }));

    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/cli/mcp.ts', '--url', `http://127.0.0.1:${port}`, '--data-dir', dir, '--wait', '1'], {
      cwd: root,
      env: { ...process.env, STEWARD_API_KEY: token } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const answer = async (id: number) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: { _meta: meta } })}\n`);
      for (let i = 0; i < 100; i++) {
        const line = stdout
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .find((l) => l.id === id);
        if (line) return line;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no answer to ${id}: ${stderr}`);
    };
    try {
      expect((await answer(1)).result.who).toBe('steward');
      // Steward stops …
      steward.closeAllConnections();
      await new Promise((r) => steward.close(r));
      expect((await answer(2)).error.message).toMatch(/cannot reach/);
      // … and another program takes the port
      const impostor = await serve('impostor', port);
      try {
        expect((await answer(3)).error.message).toMatch(/not the Steward started from/);
        expect(seen.filter((x) => x.who === 'impostor')).toEqual([]);
      } finally {
        impostor.closeAllConnections();
        impostor.close();
      }
      expect(seen.filter((x) => x.who === 'steward').map((x) => x.auth)).toEqual([`Bearer ${token}`]);
    } finally {
      child.stdin.end();
      child.kill();
    }
  }, 60_000);

  it('usage errors: no token, plain http to another host, bad URL', async () => {
    const none = await bridge(['--url', s.base], [], {}, 0);
    expect(none.code).toBe(2);
    expect(none.stderr).toMatch(/no token/);
    const http = await bridge(['--url', 'http://steward.example.com'], [], { STEWARD_API_KEY: token }, 0);
    expect(http.code).toBe(2);
    expect(http.stderr).toMatch(/unencrypted/);
    const bad = await bridge(['--url', 'ftp://x'], [], { STEWARD_API_KEY: token }, 0);
    expect(bad.code).toBe(2);
    const wait = await bridge(['--url', s.base, '--wait', 'soon'], [], { STEWARD_API_KEY: token }, 0);
    expect(wait.code).toBe(2);
    expect(wait.stderr).toMatch(/--wait/);
    const help = await new Promise<string>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', 'server/src/cli/mcp.ts', '--help'], { cwd: root });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', () => resolve(out));
    });
    expect(help).toMatch(/--api-key-file/);
    expect(help).toMatch(/--no-instance-check/);
  }, 60_000);
});

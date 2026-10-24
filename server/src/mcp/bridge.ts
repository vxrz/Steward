/**
 * stdio bridge for desktop MCP clients (Claude Desktop, VS Code, …): reads newline-delimited JSON-RPC
 * messages from stdin, sends each one to a running Steward's Streamable HTTP endpoint (POST /api/mcp)
 * and writes the answers to stdout. It is deliberately thin: it never opens the database, the vault or
 * the server configuration – it only holds the MCP token and forwards messages.
 *
 *   steward mcp --url https://steward.example.com --api-key-file ~/.steward-mcp-token
 *   STEWARD_API_KEY=smt_… npm run mcp -- --url http://127.0.0.1:4310
 *
 * stdout carries MCP messages only; everything else goes to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BRAND } from '@sm/shared';
import { EXIT_FAILURE, EXIT_OK, UsageError, parseCli, usageFailure } from '../cli/args.js';
import { verifyInstanceAt } from '../instance-proof.js';
import { parseBasePath } from '../basePath.js';

/** SM_BASE_PATH of a local Steward for the default URL (an invalid value: the root – the server refuses to start with it anyway). */
function localBasePath(): string {
  try {
    return parseBasePath(process.env.SM_BASE_PATH);
  } catch {
    return '';
  }
}

const help = (command: string) => `MCP stdio bridge for ${BRAND.name}: connects a desktop MCP client to a running ${BRAND.name}.

Usage:
  ${command} [options]

Options:
  --url <url>             ${BRAND.name} address (default: $STEWARD_URL or http://127.0.0.1:$SM_PORT$SM_BASE_PATH, port 4310)
  --api-key-file <file>   File with the MCP token (scope "MCP client"); default: $STEWARD_API_KEY
  --data-dir <path>       Data folder of a local ${BRAND.name}, to check that the URL really is it
                          (default: $SM_DATA_DIR or the per-user folder)
  --allow-http            Allow plain http:// to a host other than this computer (the token travels unencrypted)
  --wait <seconds>        For a local URL: how long to wait for ${BRAND.name} to start and prove its identity (default 10)
  --no-instance-check     Send the token to a local URL without the identity check (less safe: any program on
                          the port gets the token). Only for setups where the check cannot work, e.g. ${BRAND.name}
                          in Docker published on localhost.
  --timeout <seconds>     Time limit per request (default 60)
  -h, --help              Show this help

The token is never written to stdout or into logs. Create it on your profile page in ${BRAND.name}
(scope "MCP client"); an administrator has to turn on the MCP server under Settings.

Example (Claude Desktop, claude_desktop_config.json):
  { "mcpServers": { "steward": { "command": "${command.split(' ')[0]}", "args": ["mcp", "--url", "http://127.0.0.1:4310", "--api-key-file", "/path/to/token"] } } }

Exit status: 0 = input closed, 1 = failure (cannot reach or verify ${BRAND.name}), 2 = usage error.
`;

const OPTIONS = {
  url: { type: 'string' },
  'api-key-file': { type: 'string' },
  'data-dir': { type: 'string' },
  'allow-http': { type: 'boolean' },
  wait: { type: 'string' },
  'no-instance-check': { type: 'boolean' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

const PV = 'io.modelcontextprotocol/protocolVersion';
const MAX_LINE = 1024 * 1024;
const err = (s: string) => process.stderr.write(`${BRAND.slug} mcp: ${s}\n`);

const LOOPBACK = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase()) || /^127\./.test(host);

/** Header value per the 2026-07-28 transport: plain ASCII as is, anything else Base64 in =?base64?…?= */
export function headerValue(v: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(v) && !/^=\?base64\?.*\?=$/.test(v);
  return plain ? v : `=?base64?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function readToken(file: string | undefined): string {
  let token: string | undefined;
  if (file) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new UsageError(`cannot read --api-key-file ${file}: ${(e as Error).message}`);
    }
    if (process.platform !== 'win32') {
      try {
        if (fs.statSync(file).mode & 0o077) err(`warning: ${file} is readable by other users – restrict it (chmod 600)`);
      } catch {
        /* ignore */
      }
    }
    token = text.trim();
  } else token = process.env.STEWARD_API_KEY?.trim();
  delete process.env.STEWARD_API_KEY;
  if (!token) throw new UsageError('no token: give --api-key-file <file> or set STEWARD_API_KEY');
  if (!/^smt_[A-Za-z0-9_-]{20,200}$/.test(token)) throw new UsageError(`the token does not look like a ${BRAND.name} API token (smt_…)`);
  return token;
}

function defaultDataDir(): string {
  if (process.env.SM_DATA_DIR) return path.resolve(process.env.SM_DATA_DIR);
  const here = typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : process.cwd();
  return path.resolve(here, '..', '..', '..', 'data'); // source tree default (config.ts); the desktop launcher sets SM_DATA_DIR
}

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
}

export async function runBridge(argv: string[], command = `${BRAND.slug} mcp`): Promise<number> {
  let values;
  try {
    ({ values } = parseCli(argv, OPTIONS));
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, command);
    throw e;
  }
  if (values.help) {
    process.stdout.write(help(command));
    return EXIT_OK;
  }
  let token: string;
  let endpoint: URL;
  let timeoutMs = 60_000;
  let waitMs = 10_000;
  try {
    token = readToken(values['api-key-file']);
    const raw = (values.url ?? process.env.STEWARD_URL ?? `http://127.0.0.1:${process.env.SM_PORT ?? 4310}${localBasePath()}`).trim();
    let base: URL;
    try {
      base = new URL(raw);
    } catch {
      throw new UsageError(`--url: "${raw}" is not a URL`);
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new UsageError('--url must be an http:// or https:// address');
    if (base.username || base.password || base.search || base.hash) throw new UsageError('--url must not contain user info, a query or a fragment');
    if (base.protocol === 'http:' && !LOOPBACK(base.hostname) && !values['allow-http']) {
      throw new UsageError(`plain http:// to ${base.hostname} would send the token unencrypted – use https:// (or --allow-http on a trusted network)`);
    }
    endpoint = new URL(base.pathname.replace(/\/+$/, '').endsWith('/api/mcp') ? base.toString() : `${base.origin}${base.pathname.replace(/\/+$/, '')}/api/mcp`);
    if (values.timeout !== undefined) {
      const n = Number(values.timeout);
      if (!Number.isFinite(n) || n < 1 || n > 600) throw new UsageError('--timeout takes 1–600 seconds');
      timeoutMs = n * 1000;
    }
    if (values.wait !== undefined) {
      const n = Number(values.wait);
      if (!Number.isFinite(n) || n < 0 || n > 600) throw new UsageError('--wait takes 0–600 seconds');
      waitMs = n * 1000;
    }
  } catch (e) {
    if (e instanceof UsageError) return usageFailure(e, command);
    throw e;
  }

  // A local URL could be answered by another program on the port (for example while Steward is
  // stopped): the server has to prove it is the Steward started from our data folder (it knows the
  // secret in its instance.json) before it gets the token – at start and again after a lost connection.
  const local = LOOPBACK(endpoint.hostname);
  const instancePath = path.join(values['data-dir'] ? path.resolve(values['data-dir']) : defaultDataDir(), 'instance.json');
  if (local && values['no-instance-check']) {
    err(`warning: --no-instance-check – the token goes to whatever program listens on ${endpoint.origin}, without checking that it is ${BRAND.name}`);
  }
  const mustProve = local && !values['no-instance-check'];
  /** Retries while Steward may still be starting; returns an error message, or null when the proof succeeded. */
  const proveInstance = async (): Promise<string | null> => {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const check = await verifyInstanceAt(endpoint.href.replace(/\/api\/mcp$/, ''), instancePath);
      if (check === 'ok') return null;
      if (Date.now() >= deadline) {
        return check === 'no-file'
          ? `no ${BRAND.name} has started from ${path.dirname(instancePath)} (no instance.json) – not sending the token to ${endpoint.origin}. Start ${BRAND.name}, give its data folder with --data-dir, or see --no-instance-check (less safe) for Docker setups.`
          : `${endpoint.origin} is not the ${BRAND.name} started from ${path.dirname(instancePath)} – not sending the token. Is ${BRAND.name} running, or does another program use the port?`;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  let proof: Promise<string | null> | null = null;
  /** The current proof (shared by concurrent requests); started again after a connection error. */
  const ensureProof = (): Promise<string | null> => {
    if (!mustProve) return Promise.resolve(null);
    if (!proof) {
      const p: Promise<string | null> = proveInstance().then((m) => {
        if (m && proof === p) proof = null; // try again with the next message
        return m;
      });
      proof = p;
    }
    return proof;
  };
  if (mustProve) {
    const m = await ensureProof();
    if (m) {
      err(m);
      return EXIT_FAILURE;
    }
  }

  let legacyVersion: string | undefined;
  const inFlight = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

  const forward = async (msg: Message): Promise<void> => {
    const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
    const key = isRequest ? JSON.stringify(msg.id) : '';
    const ac = new AbortController();
    if (isRequest) inFlight.set(key, ac);
    const meta = msg.params?._meta as Record<string, unknown> | undefined;
    const version = typeof meta?.[PV] === 'string' ? (meta[PV] as string) : msg.method === 'initialize' ? undefined : legacyVersion;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(version ? { 'mcp-protocol-version': headerValue(version) } : {}),
      ...(typeof msg.method === 'string' ? { 'mcp-method': headerValue(msg.method) } : {}),
    };
    const name = msg.method === 'resources/read' ? msg.params?.uri : msg.method === 'tools/call' || msg.method === 'prompts/get' ? msg.params?.name : undefined;
    if (typeof name === 'string') headers['mcp-name'] = headerValue(name);
    const fail = (message: string, code = -32603) => isRequest && write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    const refused = await ensureProof();
    if (refused || ac.signal.aborted) {
      if (isRequest) inFlight.delete(key);
      if (refused && !ac.signal.aborted) {
        err(refused);
        fail(refused);
      }
      return;
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
        redirect: 'error',
        signal: AbortSignal.any([ac.signal, AbortSignal.timeout(timeoutMs)]),
      });
      if (res.status === 202) return;
      const text = await res.text();
      const ct = res.headers.get('content-type') ?? '';
      const bodies: unknown[] = [];
      if (ct.includes('text/event-stream')) {
        for (const ev of text.split(/\r?\n\r?\n/)) {
          const data = ev
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (data) bodies.push(JSON.parse(data));
        }
      } else if (text) bodies.push(JSON.parse(text));
      for (const b of bodies) {
        const r = b as { id?: unknown; result?: { protocolVersion?: unknown }; error?: { code?: number; message?: string } };
        if (msg.method === 'initialize' && typeof r.result?.protocolVersion === 'string') legacyVersion = r.result.protocolVersion;
        // refusals at the HTTP layer (401, 403, 429 …) carry no id: give them the request's id
        if (r.error && (r.id === undefined || r.id === null)) {
          if (isRequest) write({ jsonrpc: '2.0', id: msg.id, error: { code: r.error.code ?? -32603, message: r.error.message ?? `HTTP ${res.status}` } });
          else err(`notification refused: ${r.error.message ?? `HTTP ${res.status}`}`);
        } else write(b);
      }
      if (!bodies.length && !res.ok) fail(`${BRAND.name} answered HTTP ${res.status}`);
    } catch (e) {
      if (ac.signal.aborted) return; // cancelled by the client: no answer
      // Steward may have stopped and another program may take the port: prove its identity again before the next request.
      if ((e as Error).name !== 'TimeoutError') proof = null;
      const m =
        (e as Error).name === 'TimeoutError'
          ? `no answer from ${BRAND.name} within ${timeoutMs / 1000} s`
          : `cannot reach ${BRAND.name} at ${endpoint.origin}: ${(e as Error).message}`;
      err(m);
      fail(m);
    } finally {
      if (isRequest) inFlight.delete(key);
    }
  };

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    if (line.length > MAX_LINE) {
      write({ jsonrpc: '2.0', error: { code: -32600, message: 'Message too large' } });
      return;
    }
    let msg: Message;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      write({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      write({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid request' } });
      return;
    }
    // stdio cancellation: abort the HTTP request (on HTTP, closing it is the cancellation signal)
    if (msg.method === 'notifications/cancelled') {
      const id = msg.params?.requestId;
      inFlight.get(JSON.stringify(id))?.abort();
      return;
    }
    const p: Promise<void> = forward(msg).then(
      () => undefined,
      (e) => void err(String(e)),
    );
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  await new Promise<void>((resolve) => rl.once('close', () => resolve()));
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  return EXIT_OK;
}

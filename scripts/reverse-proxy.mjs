#!/usr/bin/env node
/**
 * A minimal HTTP reverse proxy for tests: Steward behind a proxy under a path prefix (SM_BASE_PATH),
 * the way nginx, Traefik or Caddy run it in production. Used by server/test/base-path.test.ts and by
 * the UI tests (E2E_BASE_PATH, see e2e/global-setup.ts). Not meant for production use.
 *
 * - passes the path on unchanged (like `proxy_pass http://steward:4310;` without a trailing slash) –
 *   or, with `stripPrefix`, strips it like a misconfigured proxy (to test that this fails clearly);
 * - sets X-Forwarded-For (appended), X-Forwarded-Proto and X-Forwarded-Host (the Host the client used);
 * - sends Host: <target host> upstream (nginx's default $proxy_host);
 * - streams request and response bodies (Server-Sent Events, downloads) and leaves responses unchanged.
 *
 *   node scripts/reverse-proxy.mjs --target http://127.0.0.1:4310 [--port 8080] [--proto https]
 */
import http from 'node:http';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

/**
 * @param {{ target: string, port?: number, host?: string, proto?: string, stripPrefix?: string }} opts
 * @returns {Promise<{ url: string, port: number, requests: { method: string, path: string, status: number }[], close: () => Promise<void> }>}
 */
export async function startReverseProxy(opts) {
  const target = new URL(opts.target);
  /** @type {{ method: string, path: string, status: number }[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    let path = req.url ?? '/';
    if (opts.stripPrefix && (path === opts.stripPrefix || path.startsWith(opts.stripPrefix + '/'))) path = path.slice(opts.stripPrefix.length) || '/';
    /** @type {Record<string, string | string[]>} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers[k] = v;
    const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const xff = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = xff ? `${xff}, ${peer}` : peer;
    headers['x-forwarded-proto'] = opts.proto ?? 'http';
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers.host = target.host;
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method, path, headers }, (up) => {
      requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', status: up.statusCode ?? 0 });
      /** @type {Record<string, string | string[]>} */
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) out[k] = v;
      res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('Bad gateway');
    });
    req.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://${opts.host ?? '127.0.0.1'}:${address.port}`,
    port: address.port,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve(undefined));
      }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({
    options: { target: { type: 'string' }, port: { type: 'string' }, proto: { type: 'string' }, 'strip-prefix': { type: 'string' } },
  });
  if (!values.target) {
    process.stderr.write('Usage: node scripts/reverse-proxy.mjs --target http://127.0.0.1:4310 [--port 8080] [--proto https] [--strip-prefix /steward]\n');
    process.exit(2);
  }
  const p = await startReverseProxy({
    target: values.target,
    port: values.port ? Number(values.port) : 0,
    proto: values.proto,
    stripPrefix: values['strip-prefix'],
  });
  process.stdout.write(`${p.url}\n`);
}

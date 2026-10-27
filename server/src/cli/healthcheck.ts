/**
 * Container health check (the image's HEALTHCHECK): asks this machine's Steward for <base path>/api/health
 * and exits 0 on HTTP 200, 1 otherwise. It reads the same settings as the server – SM_PORT, the base path
 * from SM_BASE_PATH or SM_PUBLIC_URL, and HTTPS when SM_TLS_CERT/SM_TLS_KEY are set – so the check keeps
 * working under a path prefix, on another port and with Steward's own TLS.
 *
 * It only talks to 127.0.0.1 and sends nothing secret, so the TLS certificate (issued for the public host
 * name) is not verified here.
 */
import http from 'node:http';
import https from 'node:https';
import { resolveBasePath } from '../basePath.js';

const HELP = `Check that Steward on this machine answers <base path>/api/health (container health check).

Usage:
  node --import tsx server/src/cli/healthcheck.ts

Reads SM_PORT (default 4310), SM_BASE_PATH or SM_PUBLIC_URL, and SM_TLS_CERT/SM_TLS_KEY like the server.

Exit codes:
  0  Steward answered 200
  1  no answer, or another status`;

const TIMEOUT_MS = 4000;

function healthUrl(env: NodeJS.ProcessEnv): URL {
  const { basePath } = resolveBasePath(env);
  const port = Number(env.SM_PORT ?? 4310);
  const scheme = env.SM_TLS_CERT && env.SM_TLS_KEY ? 'https' : 'http';
  return new URL(`${scheme}://127.0.0.1:${port}${basePath}/api/health`);
}

function check(url: URL): Promise<number> {
  return new Promise((resolve) => {
    const options: https.RequestOptions = { timeout: TIMEOUT_MS };
    if (url.protocol === 'https:') {
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- only 127.0.0.1 inside the container, no credentials sent, the answer's body is discarded; the certificate is issued for the public host name
      options.rejectUnauthorized = false;
    }
    const get = url.protocol === 'https:' ? https.get : http.get;
    const req = get(url, options, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
  });
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

let url: URL;
try {
  url = healthUrl(process.env);
} catch (e) {
  console.error(`healthcheck: ${(e as Error).message}`);
  process.exit(1);
}
const status = await check(url);
if (status !== 200) console.error(`healthcheck: ${url.href} answered ${status || 'nothing'}`);
process.exit(status === 200 ? 0 : 1);

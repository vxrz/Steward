/**
 * Container health check (the image's HEALTHCHECK): asks this machine's Steward for <base path>/api/health
 * and exits 0 on HTTP 200, 1 otherwise. It reads the same settings as the server – SM_PORT, the base path
 * from SM_BASE_PATH or SM_PUBLIC_URL, and HTTPS when SM_TLS_CERT/SM_TLS_KEY are set – so the check keeps
 * working under a path prefix, on another port and with Steward's own TLS.
 *
 * With Steward's own TLS it trusts exactly the certificate in SM_TLS_CERT: the certificate is issued for the
 * public host name, not 127.0.0.1, so it is pinned by its fingerprint instead of checking the name. Steward
 * reads that file at start, so after a renewal the check fails until Steward is restarted.
 */
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { resolveBasePath } from '../basePath.js';

const HELP = `Check that Steward on this machine answers <base path>/api/health (container health check).

Usage:
  node --import tsx server/src/cli/healthcheck.ts

Reads SM_PORT (default 4310), SM_BASE_PATH or SM_PUBLIC_URL, and SM_TLS_CERT/SM_TLS_KEY like the server.
With SM_TLS_CERT it accepts only the certificate in that file.

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

/** TLS options that accept only the certificate in SM_TLS_CERT (the first one in the file is Steward's own). */
function pinnedTls(certFile: string): https.RequestOptions {
  const pem = fs.readFileSync(certFile);
  const fingerprint = new X509Certificate(pem).fingerprint256;
  return {
    ca: pem,
    // the file may hold Steward's certificate with its chain but without the root: trust it as it is
    allowPartialTrustChain: true,
    checkServerIdentity: (_host, cert) => (cert.fingerprint256 === fingerprint ? undefined : new Error('the certificate is not the one in SM_TLS_CERT')),
  };
}

function check(url: URL, tls: https.RequestOptions): Promise<number> {
  return new Promise((resolve) => {
    const get = url.protocol === 'https:' ? https.get : http.get;
    const req = get(url, { timeout: TIMEOUT_MS, ...tls }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      if (url.protocol === 'https:') console.error(`healthcheck: ${e.message}`);
      resolve(0);
    });
  });
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

let url: URL;
let tls: https.RequestOptions = {};
try {
  url = healthUrl(process.env);
  if (url.protocol === 'https:') tls = pinnedTls(process.env.SM_TLS_CERT ?? '');
} catch (e) {
  console.error(`healthcheck: ${(e as Error).message}`);
  process.exit(1);
}
const status = await check(url, tls);
if (status !== 200) console.error(`healthcheck: ${url.href} answered ${status || 'nothing'}`);
process.exit(status === 200 ? 0 : 1);

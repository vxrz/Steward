import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../../e2e/support/selfsigned.js';

// The image's HEALTHCHECK (server/src/cli/healthcheck.ts) must follow the server's own settings: the base path,
// the port and Steward's own TLS. Before, it always asked http://127.0.0.1:4310/api/health and a container under
// /steward was reported unhealthy.
const ROOT = path.resolve(import.meta.dirname, '../..');
const TSX = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const SCRIPT = path.join(ROOT, 'server/src/cli/healthcheck.ts');

const servers: (http.Server | https.Server)[] = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-healthcheck-'));
afterAll(() => {
  servers.forEach((s) => s.close());
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A self-signed certificate for the public host name (not 127.0.0.1), written to a file like SM_TLS_CERT. */
function certificateFile(name: string) {
  const cert = selfSignedCertificate({ commonName: 'steward.example', notAfter: new Date(Date.now() + 86400000) });
  const file = path.join(dir, `${name}.pem`);
  fs.writeFileSync(file, cert.pem);
  return { ...cert, file };
}

/** A stand-in for Steward that answers 200 only at `path`, over HTTPS with `tls`. */
async function stub(healthPath: string, tls?: { pem: string; privateKeyPem: string }): Promise<number> {
  const handler: http.RequestListener = (req, res) => {
    res.writeHead(req.url === healthPath ? 200 : 404, { 'content-type': 'application/json' }).end('{}');
  };
  let server: http.Server | https.Server;
  if (tls) {
    server = https.createServer({ cert: tls.pem, key: tls.privateKeyPem }, handler);
  } else {
    server = http.createServer(handler);
  }
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

function run(env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SM_(BASE_PATH|PUBLIC_URL|PORT|TLS_CERT|TLS_KEY)$/.test(k)));
    const child = spawn(TSX, [SCRIPT], { cwd: ROOT, env: { ...clean, ...env } });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('container health check', () => {
  it('asks /api/health at the root', async () => {
    const port = await stub('/api/health');
    expect((await run({ SM_PORT: String(port) })).code).toBe(0);
  });

  it('follows SM_BASE_PATH and the path of SM_PUBLIC_URL', async () => {
    const port = await stub('/steward/api/health');
    expect((await run({ SM_PORT: String(port), SM_BASE_PATH: '/steward' })).code).toBe(0);
    expect((await run({ SM_PORT: String(port), SM_PUBLIC_URL: 'https://apps.example.com/steward' })).code).toBe(0);
    // without the base path it would ask /api/health, which Steward under /steward answers with 404
    const r = await run({ SM_PORT: String(port) });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('answered 404');
  });

  it('uses HTTPS when Steward serves TLS itself and accepts only the certificate in SM_TLS_CERT', async () => {
    const own = certificateFile('own');
    const port = await stub('/api/health', own);
    expect((await run({ SM_PORT: String(port), SM_TLS_CERT: own.file, SM_TLS_KEY: '/x/key.pem' })).code).toBe(0);
    // another certificate in the file (e.g. renewed, but Steward not restarted yet) fails
    const other = certificateFile('other');
    const renewed = await run({ SM_PORT: String(port), SM_TLS_CERT: other.file, SM_TLS_KEY: '/x/key.pem' });
    expect(renewed.code).toBe(1);
    expect(renewed.stderr).toContain('certificate');
    // an unreadable certificate file fails with its error
    const missing = await run({ SM_PORT: String(port), SM_TLS_CERT: path.join(dir, 'missing.pem'), SM_TLS_KEY: '/x/key.pem' });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('missing.pem');
    // plain HTTP against a TLS port gets no answer
    expect((await run({ SM_PORT: String(port) })).code).toBe(1);
  });

  it('fails when nothing answers or the settings are invalid', async () => {
    const port = await stub('/api/health');
    await new Promise<void>((resolve) => servers.at(-1)!.close(() => resolve()));
    expect((await run({ SM_PORT: String(port) })).code).toBe(1);
    const bad = await run({ SM_BASE_PATH: '/a b' });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('SM_BASE_PATH');
  });
});

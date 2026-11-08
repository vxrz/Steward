import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../../e2e/support/selfsigned.js';

/**
 * Security review 0.10.0 S6: the Teams-bot listener (meant to face the internet) used Node's default TLS 1.2 cipher list
 * (CBC suites, and RSA key exchange without forward secrecy with an RSA key). Every built-in TLS listener now uses the
 * same settings as the main server (tls.ts): TLS 1.2+, forward-secret AEAD suites only, SM_TLS_CIPHERS.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tls-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function certificate(): { cert: string; key: string } {
  const c = selfSignedCertificate({ commonName: 'bot.example', notAfter: new Date(Date.now() + 86_400_000) });
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  fs.writeFileSync(cert, c.pem);
  fs.writeFileSync(key, c.privateKeyPem);
  return { cert, key };
}

/** The cipher a TLS 1.2 client offering only `ciphers` gets, or "refused". */
function negotiate(port: number, ciphers: string, maxVersion: tls.SecureVersion = 'TLSv1.2'): Promise<string> {
  return new Promise((resolve) => {
    const socket = tls.connect({ port, host: '127.0.0.1', rejectUnauthorized: false, maxVersion, ciphers }, () => {
      resolve(socket.getCipher().name);
      socket.end();
    });
    socket.on('error', () => resolve('refused'));
  });
}

describe('TLS settings of the built-in listeners', () => {
  it('the Teams-bot listener refuses CBC suites and old protocol versions, like the main server', async () => {
    const { config } = await import('../src/config.js');
    const { buildBotApp } = await import('../src/msteams/listener.js');
    const before = config.tls;
    config.tls = certificate();
    try {
      const bot = await buildBotApp();
      await bot.listen({ host: '127.0.0.1', port: 0 });
      const port = (bot.server.address() as AddressInfo).port;
      try {
        // Node's default list accepts these (forward-secret but CBC); the main server's list does not
        expect(await negotiate(port, 'ECDHE-ECDSA-AES128-SHA256')).toBe('refused');
        expect(await negotiate(port, 'ECDHE-ECDSA-AES128-SHA')).toBe('refused');
        expect(await negotiate(port, 'ECDHE-ECDSA-AES128-GCM-SHA256')).toBe('ECDHE-ECDSA-AES128-GCM-SHA256');
        expect(await negotiate(port, 'ECDHE-ECDSA-AES128-SHA', 'TLSv1.1')).toBe('refused');
      } finally {
        await bot.close();
      }
    } finally {
      config.tls = before;
    }
  });

  it('every listener takes its options from one place (SM_TLS_CIPHERS overrides the list)', async () => {
    const { tlsServerOptions, TLS_CIPHERS } = await import('../src/tls.js');
    const { overrideConfig, reloadConfig } = await import('../src/config.js');
    const files = certificate();
    expect(tlsServerOptions(files)).toMatchObject({ minVersion: 'TLSv1.2', ciphers: TLS_CIPHERS, honorCipherOrder: true });
    overrideConfig({ SM_TLS_CIPHERS: 'ECDHE-ECDSA-AES256-GCM-SHA384' });
    try {
      expect(tlsServerOptions(files)?.ciphers).toBe('ECDHE-ECDSA-AES256-GCM-SHA384');
    } finally {
      reloadConfig();
    }
    expect(tlsServerOptions(undefined)).toBeUndefined();
    // no listener builds its own TLS options any more
    for (const file of ['app.ts', 'main.ts', 'msteams/listener.ts']) {
      const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', file), 'utf8');
      expect(src, file).not.toMatch(/minVersion:/);
      expect(src, file).toContain('tlsServerOptions()');
    }
  });
});

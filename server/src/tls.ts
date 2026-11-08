import fs from 'node:fs';
import type { SecureVersion } from 'node:tls';
import { config, env } from './config.js';

/**
 * TLS settings for the built-in HTTPS servers: TLS 1.2 or newer, forward-secret AEAD cipher suites
 * only (TLS 1.3 suites are always on). SM_TLS_CIPHERS overrides the TLS 1.2 list.
 */
export const TLS_CIPHERS =
  'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305';

export interface TlsServerOptions {
  cert: Buffer;
  key: Buffer;
  minVersion: SecureVersion;
  ciphers: string;
  honorCipherOrder: boolean;
}

/**
 * The options of every listener Steward opens with SM_TLS_CERT/SM_TLS_KEY: the main server, the Teams-bot listener and
 * the small server that answers probes while waiting for the database. One place, so they cannot drift apart.
 */
export function tlsServerOptions(tls: { cert: string; key: string } | undefined = config.tls): TlsServerOptions | undefined {
  if (!tls) return undefined;
  return {
    cert: fs.readFileSync(tls.cert),
    key: fs.readFileSync(tls.key),
    minVersion: 'TLSv1.2',
    ciphers: env.SM_TLS_CIPHERS || TLS_CIPHERS,
    honorCipherOrder: true,
  };
}

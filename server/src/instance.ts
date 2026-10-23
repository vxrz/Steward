import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { BRAND } from '@sm/shared';
import { config } from './config.js';
import { proofOf, verifyInstanceAt } from './instance-proof.js';

export { proofOf };

/**
 * Instance identity, so the desktop launcher does not hand the user's window (and the passphrase
 * prompt) to another program that happens to listen on the port: at start the server writes a
 * random secret to <data dir>/instance.json (readable only by the user, 0600) and answers
 * GET /api/instance?challenge=… with an HMAC of the challenge. Only a process that can read the
 * user's data folder can check it – and only the real server can answer it.
 */
export interface InstanceFile {
  v: 1;
  product: string;
  instanceId: string;
  secret: string;
  pid: number;
  url: string;
  startedAt: string;
}

export const instanceFile = (dataDir = config.dataDir): string => path.join(dataDir, 'instance.json');
let current: InstanceFile | undefined;

/** Called once the server listens. */
export function writeInstanceFile(url: string): InstanceFile {
  current = {
    v: 1,
    product: BRAND.slug,
    instanceId: crypto.randomUUID(),
    secret: crypto.randomBytes(32).toString('base64'),
    pid: process.pid,
    url,
    startedAt: new Date().toISOString(),
  };
  const file = instanceFile();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return current;
}

export function removeInstanceFile(): void {
  try {
    const f = instanceFile();
    const onDisk = JSON.parse(fs.readFileSync(f, 'utf8')) as InstanceFile;
    if (current && onDisk.instanceId === current.instanceId) fs.rmSync(f, { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * The launcher's check: does the server at `url` know the secret in our data folder?
 * 'ok' | 'no-file' (no Steward of ours has started) | 'mismatch' (something else answers).
 */
export function verifyInstance(url: string, dataDir = config.dataDir, timeoutMs = 2000): Promise<'ok' | 'no-file' | 'mismatch'> {
  return verifyInstanceAt(url, instanceFile(dataDir), timeoutMs);
}

export async function instanceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/instance', async (req, reply) => {
    const challenge = String((req.query as { challenge?: string }).challenge ?? '');
    if (!current) return reply.code(404).send({ error: 'Not available' });
    if (!/^[0-9a-f]{32,128}$/.test(challenge)) return reply.code(400).send({ error: 'challenge: 32–128 hex characters' });
    reply.header('cache-control', 'no-store');
    return { product: current.product, instanceId: current.instanceId, proof: proofOf(current.secret, challenge, config.port) };
  });
}

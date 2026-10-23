/**
 * Instance proof (see instance.ts) without the server configuration, so tools that must not load
 * config.ts – the MCP stdio bridge – can check that a local URL is really the user's Steward.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { InstanceFile } from './instance.js';

/** Bound to the port the server listens on: a program on another port cannot relay the challenge to the real server. */
export function proofOf(secret: string, challenge: string, port: number | string): string {
  return crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(`steward-instance-v1\n${port}\n${challenge}`).digest('hex');
}

/**
 * The launcher's check: does the server at `url` know the secret in our data folder?
 * 'ok' | 'no-file' (no Steward of ours has started) | 'mismatch' (something else answers).
 */
export async function verifyInstanceAt(url: string, file: string, timeoutMs = 2000): Promise<'ok' | 'no-file' | 'mismatch'> {
  let inst: InstanceFile;
  try {
    inst = JSON.parse(fs.readFileSync(file, 'utf8')) as InstanceFile;
  } catch {
    return 'no-file';
  }
  const challenge = crypto.randomBytes(32).toString('hex');
  try {
    const res = await fetch(`${url}/api/instance?challenge=${challenge}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'mismatch';
    const body = (await res.json()) as { instanceId?: string; proof?: string };
    const port = new URL(url).port || (url.startsWith('https:') ? '443' : '80');
    const expected = Buffer.from(proofOf(inst.secret, challenge, port));
    const got = Buffer.from(String(body.proof ?? ''));
    return body.instanceId === inst.instanceId && got.length === expected.length && crypto.timingSafeEqual(got, expected) ? 'ok' : 'mismatch';
  } catch {
    return 'mismatch';
  }
}

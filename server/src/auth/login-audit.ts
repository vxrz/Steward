import crypto from 'node:crypto';
import { audit } from '../audit.js';
import { readSetting, writeSetting } from '../settings.js';
import { nowIso } from '../util.js';

/**
 * Audit entries for failed sign-ins, bounded and privacy-friendly:
 * - per account (or unknown user name) and source address, the first failure of a minute is
 *   recorded right away, further ones in that minute are summed up in one entry when it ends;
 * - at most BUDGET individual entries per minute in total, everything above is summed up in one
 *   "failed sign-ins" entry per minute (a flood cannot fill the immutable log);
 * - a user name that belongs to no account is not stored: it is often a password typed into the
 *   wrong field. Instead a pseudonym (keyed hash, "ref") lets you see repeated attempts.
 */
const WINDOW_MS = 60_000;
const BUDGET = 100;

interface Bucket {
  count: number;
  first: string;
  actor: string;
  entityId: string | null;
  label: string;
  ip?: string;
  userRef?: string;
}
const buckets = new Map<string, Bucket>();
let window = { start: 0, individual: 0 };
let overflow: { count: number; accounts: Set<string>; addresses: Set<string>; first: string } | null = null;

/** Per-installation key for pseudonyms of unknown user names (kept in the database, not secret enough to need the vault). */
function pseudonymKey(): Buffer {
  let k = readSetting<string | null>('security.pseudonymKey', null);
  if (!k) {
    k = crypto.randomBytes(32).toString('base64');
    writeSetting('security.pseudonymKey', k);
  }
  return Buffer.from(k, 'base64');
}

export function pseudonym(username: string): string {
  return crypto.createHmac('sha256', pseudonymKey()).update(username.trim().toLowerCase()).digest('hex').slice(0, 12);
}

/**
 * Pseudonym of a user name for traces (OpenTelemetry): keyed with the same per-installation key, but in its own
 * domain, so whoever holds the traces can neither re-identify users by hashing known names nor link the value to
 * the "ref" of failed sign-ins.
 */
export function tracePseudonym(username: string): string {
  return crypto.createHmac('sha256', pseudonymKey()).update(`trace:${username}`).digest('hex').slice(0, 16);
}

function flush(key: string): void {
  const b = buckets.get(key);
  buckets.delete(key);
  if (!b || b.count === 0) return;
  audit({
    actor: b.actor,
    action: 'auth.login_failed',
    entityType: 'user',
    entityId: b.entityId,
    summary: `${b.count} more failed sign-in(s) ${b.label}${b.ip ? ` from ${b.ip}` : ''} within one minute`,
    details: { ip: b.ip, count: b.count, from: b.first, to: nowIso(), userRef: b.userRef, aggregated: true },
  });
}

function flushOverflow(): void {
  const o = overflow;
  overflow = null;
  if (!o) return;
  audit({
    actor: 'anonymous',
    action: 'auth.login_failed',
    entityType: 'user',
    summary: `${o.count} further failed sign-in(s) for ${o.accounts.size} account(s) / user name(s) from ${o.addresses.size} address(es) within one minute (rate of failures above ${BUDGET}/min)`,
    details: { count: o.count, accounts: o.accounts.size, addresses: [...o.addresses].slice(0, 20), from: o.first, to: nowIso(), aggregated: true },
  });
}

export function recordFailedLogin(i: { username: string; account: { id: string; username: string; disabled: boolean } | null; ip?: string }): void {
  const userRef = i.account ? undefined : pseudonym(i.username);
  const who = i.account ? `u:${i.account.id}` : `x:${userRef}`;
  const key = `${who}|${i.ip ?? ''}`;
  const existing = buckets.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  const now = Date.now();
  if (now - window.start >= WINDOW_MS) window = { start: now, individual: 0 };
  if (window.individual >= BUDGET) {
    if (!overflow) {
      overflow = { count: 0, accounts: new Set(), addresses: new Set(), first: nowIso() };
      setTimeout(flushOverflow, WINDOW_MS).unref();
    }
    overflow.count++;
    if (overflow.accounts.size < 10000) overflow.accounts.add(who);
    if (i.ip && overflow.addresses.size < 1000) overflow.addresses.add(i.ip);
    return;
  }
  window.individual++;
  const label = i.account ? `for "${i.account.username}"` : `with an unknown user name (ref ${userRef})`;
  const actor = i.account ? i.account.username : 'anonymous';
  audit({
    actor,
    action: 'auth.login_failed',
    entityType: 'user',
    entityId: i.account?.id ?? null,
    summary: `Failed sign-in ${label}${i.account?.disabled ? ' (account disabled)' : ''}`,
    details: { ip: i.ip, ...(userRef ? { userRef } : {}) },
  });
  buckets.set(key, { count: 0, first: nowIso(), actor, entityId: i.account?.id ?? null, label, ip: i.ip, userRef });
  setTimeout(() => flush(key), WINDOW_MS).unref();
}

/** Writes all pending aggregates now (shutdown, tests). */
export function flushFailedLoginAudit(): void {
  for (const k of [...buckets.keys()]) flush(k);
  flushOverflow();
}

import type { Platform } from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { currentUser, runAs } from '../auth/context.js';
import { findUserByName, toAuthUser } from '../auth/users.js';
import { getConnection, getPlatform } from '../platforms/service.js';
import { HttpError } from '../util.js';

/**
 * Platform access for checks and outputs. They run in the background with the
 * rights of the monitor's owner: the owner must still exist, be active and may
 * use the platform (checked again at most once a minute).
 */
const cache = new Map<string, { ok: string | null; at: number }>();
const TTL_MS = 60000;

export class CheckSetupError extends Error {}

export function ownerProblem(owner: string, platformId: string): string | null {
  const key = `${owner.toLowerCase()}|${platformId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;
  let problem: string | null = null;
  const u = findUserByName(owner);
  if (!u || !u.active) problem = `the monitor owner ${owner} is missing or deactivated`;
  else {
    try {
      const p = runAs(toAuthUser(u), () => getPlatform(platformId));
      if (!p.permissions.includes('use')) problem = `the monitor owner ${owner} may not use platform "${p.name}"`;
    } catch {
      problem = `platform ${platformId} does not exist`;
    }
  }
  cache.set(key, { ok: problem, at: Date.now() });
  return problem;
}

export function clearPlatformAccessCache(): void {
  cache.clear();
}

/** A platform's name and kind, without its secrets (the kind guard of checks.ts); undefined: no such platform. */
export function platformKindRow(id: string): { name: string; kind: string } | undefined {
  return db().get<{ name: string; kind: string }>('SELECT name, kind FROM platforms WHERE id = ?', id);
}

/** Platform + decrypted secrets for a background call on behalf of `owner`; throws CheckSetupError otherwise. */
export function platformFor(owner: string, platformId: string): { platform: Platform; secrets: Record<string, string> } {
  if (!vault().unlocked) throw new CheckSetupError('the vault is locked');
  const problem = ownerProblem(owner, platformId);
  if (problem) throw new CheckSetupError(problem);
  try {
    // the platform with its default identity (0.9.0, ADR 0009: a check or output naming an identity comes in step 2)
    const { platform, secrets } = getConnection(platformId);
    return { platform, secrets };
  } catch (e) {
    throw new CheckSetupError(e instanceof HttpError ? e.message : String(e));
  }
}

/** The answer for a platform reference that finds nothing – and for a platform the caller may not see (the same). */
export const platformNotFound = (ref: string, kind?: string): HttpError =>
  new HttpError(400, `Platform "${ref}" not found${kind ? ` (expected a platform of kind ${kind})` : ''}`, 'PLATFORM_NOT_FOUND', {
    id: ref,
    ...(kind ? { context: 'kind', kind } : {}),
  });

/**
 * The platform as the caller sees it; one the caller may not see (no right at all) answers like a missing one, before
 * anything names it or its kind. Without a caller (a job, Git sync) every platform is visible.
 */
export function requireVisiblePlatform(id: string, ref: string = id, kind?: string): Platform {
  let p: Platform;
  try {
    p = getPlatform(id);
  } catch {
    throw platformNotFound(ref, kind);
  }
  if (currentUser() && !p.permissions.length) throw platformNotFound(ref, kind);
  return p;
}

/** Resolves a platform reference (id or name) to an id; `kind` disambiguates. */
export function resolvePlatformRef(ref: string, kind?: string): { id: string; name: string; kind: string } {
  const rows = db().all<{ id: string; name: string; kind: string }>('SELECT id, name, kind FROM platforms ORDER BY name');
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;
  const named = rows.filter((r) => r.name.toLowerCase() === ref.toLowerCase());
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new HttpError(400, `Several platforms are called "${ref}" – use the platform id`, 'PLATFORM_AMBIGUOUS', { name: ref });
  // "Insights Hub" also finds "Insights Hub (production)" when it is the only such platform
  const prefixed = rows.filter((r) => r.name.toLowerCase().startsWith(ref.toLowerCase()) && (!kind || r.kind === kind));
  if (prefixed.length === 1) return prefixed[0]!;
  if (kind) {
    const ofKind = rows.filter((r) => r.kind === kind);
    if (ofKind.length === 1) return ofKind[0]!;
  }
  throw platformNotFound(ref, kind);
}

import {
  PV_FINDING_KINDS,
  PVAULT_HEARTBEAT_FAILED,
  PVAULT_LIMITS,
  pvPrivileged,
  type Platform,
  type PvFinding,
  type PvFindingKind,
  type PvHygieneOptions,
  type PvSecret,
} from '@sm/shared';
import { effectivePermissions } from './access.js';
import { mapLimit, PvClient, type PvPermission } from './client.js';

/**
 * Hygiene of the vault's secrets (v0.5.0, #205) – metadata only:
 *
 *   heartbeat      the last heartbeat failed (Failed, UnableToConnect, AccountLockedOut …)
 *   notRotated     the password was not changed within maxAgeDays, never, or the last change failed (out of sync)
 *   expired        the password is past its expiry (daysUntilExpiration below 0)
 *   autoChangeOff  automatic password changing (remote password changing) is off
 *   noOwner        nobody holds the permission Owner on the secret (its own or inherited from its folder)
 *   noCheckout     a privileged secret without checkout
 *   noApproval     a privileged secret that needs no approval for access
 *
 * Privileged: in a privileged folder (or below) or of a privileged template (PvPrivilegedScope).
 */

const DAY = 86_400_000;
const FAILED = new Set<string>(PVAULT_HEARTBEAT_FAILED.map((x) => x.toLowerCase()));

export interface PvHygiene {
  readAt: string;
  secrets: number;
  privileged: number;
  findings: PvFinding[];
  /** findings per kind (every kind looked for, 0 included) */
  counts: Partial<Record<PvFindingKind, number>>;
}

const base = (s: PvSecret, privileged: boolean) => ({ secretId: s.id, secret: s.name, folder: s.folderPath, template: s.templateName, privileged });

/** The findings of one secret (without noOwner, which needs its permissions). */
export function secretFindings(s: PvSecret, o: PvHygieneOptions, now: number, kinds: Set<PvFindingKind>): PvFinding[] {
  const privileged = pvPrivileged(s, o);
  const out: PvFinding[] = [];
  const add = (kind: PvFindingKind, detail: string) => kinds.has(kind) && out.push({ kind, ...base(s, privileged), detail });
  if (s.heartbeat && FAILED.has(s.heartbeat.toLowerCase())) add('heartbeat', `heartbeat ${s.heartbeat}`);
  const changed = s.lastPasswordChangeAt ? Date.parse(s.lastPasswordChangeAt) : NaN;
  if (s.outOfSync) add('notRotated', 'the last password change failed (out of sync)');
  else if (!Number.isFinite(changed)) add('notRotated', 'the password was never changed by the vault');
  else if (now - changed > o.maxAgeDays * DAY)
    add('notRotated', `last change ${s.lastPasswordChangeAt!.slice(0, 10)} (${Math.floor((now - changed) / DAY)} days, at most ${o.maxAgeDays})`);
  if (s.daysUntilExpiration !== null && s.daysUntilExpiration < 0) add('expired', `expired ${-s.daysUntilExpiration} days ago`);
  if (!s.autoChangeEnabled) add('autoChangeOff', 'automatic password changing is off');
  if (privileged && !s.checkOutEnabled) add('noCheckout', 'privileged, without checkout');
  if (privileged && !s.requiresApproval) add('noApproval', 'privileged, access without approval');
  return out;
}

export async function vaultHygiene(platform: Platform, secrets: Record<string, string>, o: PvHygieneOptions, now = Date.now()): Promise<PvHygiene> {
  const kinds = new Set<PvFindingKind>(o.kinds?.length ? o.kinds : PV_FINDING_KINDS);
  const c = new PvClient(platform, secrets);
  const folders = kinds.has('noOwner') || o.folder ? await c.folders() : [];
  const list = await c.secretsIn(o.folder ?? '', folders.length ? folders : undefined);
  const findings = list.flatMap((s) => secretFindings(s, o, now, kinds));
  if (kinds.has('noOwner')) {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const folderPerms = new Map<number, PvPermission[]>();
    const owned = await mapLimit(list, PVAULT_LIMITS.concurrency, async (s) => {
      const { perms } = await effectivePermissions(c, s, await c.secretPermissions(s.id), byId, folderPerms);
      return perms.some((p) => p.role.toLowerCase() === 'owner');
    });
    list.forEach((s, i) => {
      if (!owned[i]) findings.push({ kind: 'noOwner', ...base(s, pvPrivileged(s, o)), detail: 'nobody holds the permission Owner' });
    });
  }
  const order = new Map(PV_FINDING_KINDS.map((k, i) => [k, i]));
  findings.sort((a, b) => Number(b.privileged) - Number(a.privileged) || order.get(a.kind)! - order.get(b.kind)! || a.secret.localeCompare(b.secret));
  const counts: Partial<Record<PvFindingKind, number>> = {};
  for (const k of kinds) counts[k] = findings.filter((f) => f.kind === k).length;
  return { readAt: new Date(now).toISOString(), secrets: list.length, privileged: list.filter((s) => pvPrivileged(s, o)).length, findings, counts };
}

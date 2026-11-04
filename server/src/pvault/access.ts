import { PVAULT_LIMITS, pvFolderWithin, type AccessSubject, type Platform, type PvSecret } from '@sm/shared';
import { HttpError } from '../util.js';
import { mapLimit, PvClient, type PvFolder, type PvPermission, type PvUser } from './client.js';

/**
 * IBM Verify Privilege Vault as an access review source (v0.5.0, #205): who has access to which secret and folder,
 * directly or through a group, with the permission level, and who holds which role. One subject per user (named by
 * the user name with its domain; e-mail address and plain user name as aliases, so person reviews match them):
 *
 *   Secret \IT\Servers\root@db1 (#12): Owner                       a secret permission of the user
 *   Secret \IT\Servers\root@db1 (#12): View via group DB Admins     … through a group the user is a member of
 *   Folder \IT\Servers: Edit (secrets: Owner)                       a folder permission (folder role, secrets role)
 *   Role Administrator                                              a role, directly or "via group …"
 *
 * A secret that inherits its permissions and lists none of its own gets those of its folder (the nearest folder up
 * that does not inherit), marked "from folder …". A group whose members the account may not read stays a subject of
 * its own (type group). Only reads.
 */

const label = (s: PvSecret) => `Secret ${s.folderPath ? `${s.folderPath}\\` : ''}${s.name} (#${s.id})`;

/** domain\user or user */
const qualified = (name: string, domain: string) => (domain ? `${domain}\\${name}` : name);

/** The folder whose permissions a folder has: itself, or the nearest one up that does not inherit. */
function effectiveFolder(id: number | null, byId: Map<number, PvFolder>): PvFolder | undefined {
  let f = id ? byId.get(id) : undefined;
  for (let i = 0; f && f.inheritPermissions && f.parentId && i < 50; i++) {
    const up = byId.get(f.parentId);
    if (!up) break;
    f = up;
  }
  return f;
}

/**
 * The permissions that decide who reaches a secret: its own, or – when it inherits and lists none – those its folder
 * (the nearest one up that does not inherit) gives for secrets. `from`: that folder's path, '' for its own.
 */
export async function effectivePermissions(
  c: PvClient,
  s: PvSecret,
  own: PvPermission[],
  byId: Map<number, PvFolder>,
  folderPerms: Map<number, PvPermission[]>,
): Promise<{ perms: PvPermission[]; from: string }> {
  if (own.length || !s.inheritsPermissions) return { perms: own, from: '' };
  const f = effectiveFolder(s.folderId, byId);
  if (!f) return { perms: own, from: '' };
  const fp = folderPerms.get(f.id) ?? (await c.folderPermissions(f.id));
  folderPerms.set(f.id, fp);
  return { perms: fp.filter((p) => p.secretRole).map((p) => ({ ...p, role: p.secretRole! })), from: f.path };
}

export async function privilegeVaultAccess(platform: Platform, secrets: Record<string, string>, folder: string): Promise<AccessSubject[]> {
  const c = new PvClient(platform, secrets);
  const folders = await c.folders();
  const byId = new Map(folders.map((f) => [f.id, f]));
  const inScope = await c.secretsIn(folder, folders);
  const users = await c.users();
  const groups = await c.groups();
  const userById = new Map(users.map((u) => [u.id, u]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // permissions of each secret, and of the folders in scope
  const secretPerms = await mapLimit(inScope, PVAULT_LIMITS.concurrency, (s) => c.secretPermissions(s.id));
  const folderIds = [...new Set(folders.filter((f) => !folder || inScope.some((s) => s.folderId === f.id) || pvFolderWithin(f.path, folder)).map((f) => f.id))];
  const folderPerms = new Map<number, PvPermission[]>();
  await mapLimit(folderIds, PVAULT_LIMITS.concurrency, async (id) => folderPerms.set(id, await c.folderPermissions(id)));

  // members of the groups that hold something (members unreadable: the group stays a subject)
  const memberOf = new Map<number, number[] | null>();
  const memberIds = async (gid: number) => {
    if (!memberOf.has(gid))
      memberOf.set(
        gid,
        await c.groupMembers(gid).catch(() => null), // a group the account may not read: kept as a subject of its own
      );
    return memberOf.get(gid)!;
  };

  const subjects = new Map<string, AccessSubject>();
  const userSubject = (u: PvUser): AccessSubject => {
    const id = qualified(u.username, u.domain).toLowerCase();
    let s = subjects.get(id);
    if (!s) {
      s = {
        id,
        name: u.displayName || u.username,
        type: u.application ? 'technical' : 'user',
        rights: [],
        aliases: [...new Set([u.username.toLowerCase(), u.email, `#${u.id}`].filter(Boolean))].filter((a) => a !== id),
        ...(u.lastLoginAt || !u.enabled
          ? {
              activity: [!u.enabled ? 'disabled in the vault' : '', u.lastLoginAt ? `last login ${u.lastLoginAt.slice(0, 10)}` : ''].filter(Boolean).join(', '),
              activityInfo: { lastLoginAt: u.lastLoginAt, passwordWithoutMfa: !u.domain && !u.twoFactor && !u.application },
            }
          : {}),
      };
      subjects.set(id, s);
    }
    return s;
  };
  const groupSubject = (gid: number, name: string): AccessSubject => {
    const g = groupById.get(gid);
    const id = `group:${qualified(g?.name || name, g?.domain ?? '').toLowerCase()}`;
    let s = subjects.get(id);
    if (!s) subjects.set(id, (s = { id, name: g?.name || name, type: 'group', rights: [] }));
    return s;
  };
  /** Gives the right to the user, or to every member of the group ("via group …"). */
  const grant = async (p: PvPermission, right: string) => {
    if (p.userId) {
      const u = userById.get(p.userId);
      if (u) userSubject(u).rights.push(right);
      else {
        const id = qualified(p.name || `#${p.userId}`, p.domain).toLowerCase();
        const s = subjects.get(id) ?? { id, name: p.name || `#${p.userId}`, type: 'user', rights: [] };
        subjects.set(id, s);
        s.rights.push(right);
      }
      return;
    }
    if (!p.groupId) return;
    const members = await memberIds(p.groupId);
    const gname = groupById.get(p.groupId)?.name || p.name;
    if (members === null) {
      groupSubject(p.groupId, p.name).rights.push(right);
      return;
    }
    for (const uid of members) {
      const u = userById.get(uid);
      if (u) userSubject(u).rights.push(`${right} via group ${gname}`);
    }
  };

  for (let i = 0; i < inScope.length; i++) {
    const s = inScope[i]!;
    const { perms, from } = await effectivePermissions(c, s, secretPerms[i]!, byId, folderPerms);
    for (const p of perms) if (p.role) await grant(p, `${label(s)}: ${p.role}${from ? ` from folder ${from}` : ''}`);
  }
  for (const [fid, perms] of folderPerms) {
    if (!folderIds.includes(fid)) continue;
    const f = byId.get(fid);
    for (const p of perms) if (p.role) await grant(p, `Folder ${f?.path ?? `#${fid}`}: ${p.role}${p.secretRole ? ` (secrets: ${p.secretRole})` : ''}`);
  }
  // roles: every enabled user (an administrator role matters even without a secret permission)
  const roleUsers = users.filter((u) => u.enabled);
  if (roleUsers.length > PVAULT_LIMITS.principals)
    throw new HttpError(400, `The vault has more than ${PVAULT_LIMITS.principals} users`, 'SNAPSHOT_TOO_LARGE', { max: PVAULT_LIMITS.principals });
  const roles = await mapLimit(roleUsers, PVAULT_LIMITS.concurrency, (u) => c.userRoles(u.id));
  roleUsers.forEach((u, i) => {
    for (const r of roles[i]!) {
      if (!r.roleName) continue;
      if (r.direct) userSubject(u).rights.push(`Role ${r.roleName}`);
      for (const g of r.groups) userSubject(u).rights.push(`Role ${r.roleName} via group ${g}`);
    }
  });
  return [...subjects.values()].map((s) => ({ ...s, rights: [...new Set(s.rights)].sort() })).filter((s) => s.rights.length > 0);
}

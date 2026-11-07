import { CHANGEDETECTION_KIND, type AclEntry, type PlatformPermission } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { parseJson } from '../util.js';

/**
 * The stored watches of changedetection.io platforms (#242) as other modules need them – kept free of the platform and
 * link services, so the platform service and the links module can import it without a cycle.
 */

/** Everything of a platform (it is deleted). */
export function deleteWatchesOf(platformId: string): void {
  db().run('DELETE FROM cd_watches WHERE platform_id = ?', platformId);
  db().run('DELETE FROM cd_reads WHERE platform_id = ?', platformId);
}

/** Page watches linked to an application or a service, for the item's backlinks: only those of platforms the reader may see. */
export function watchesLinkingTo(kind: string, id: string): { platformId: string; uuid: string; title: string; vendor: string }[] {
  const column = kind === 'application' ? 'application_id' : kind === 'service' ? 'service_id' : null;
  if (!column) return [];
  const rows = db().all<{ platform_id: string; uuid: string; title: string; vendor: string; acl: string }>(
    `SELECT w.platform_id, w.uuid, w.title, w.vendor, p.acl FROM cd_watches w JOIN platforms p ON p.id = w.platform_id
     WHERE w.${column} = ? AND p.kind = ? ORDER BY lower(w.title), w.uuid`,
    id,
    CHANGEDETECTION_KIND,
  );
  const user = currentUser();
  const visible = new Map<string, boolean>();
  return rows
    .filter((r) => {
      if (!visible.has(r.platform_id))
        visible.set(r.platform_id, platformPermissions(user, { id: r.platform_id, acl: parseJson<AclEntry<PlatformPermission>[]>(r.acl, []) }).length > 0);
      return visible.get(r.platform_id);
    })
    .map((r) => ({ platformId: r.platform_id, uuid: r.uuid, title: r.title, vendor: r.vendor }));
}

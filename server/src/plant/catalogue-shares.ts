import type { PlantCatalogueKind, PlantCataloguePermission } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { HttpError, nowIso } from '../util.js';
import { currentActor, currentUser } from '../auth/context.js';
import { owningTeams, setOwningTeams } from '../auth/policy.js';
import { isRestricted, sharesChanged } from '../auth/share-store.js';
import { ACCESS_AUDIT, auditAccessChange } from '../auth/access-change.js';
import type { ShareKindDef } from '../auth/shares.js';
import { PLANT_CATALOGUE_SHARES, catalogueEntryAccess } from './catalogue-access.js';

/**
 * The plant catalogues as kinds of the shares core (0.21.0, #293; auth/shares.ts): what the expiry job, its reminders
 * and the Access tab need – the share model, the entry's name and page, and the rights of a user (through the policy
 * module, shares included). Registered by the plant feature's manifest.
 */
const named = (table: string) => (id: string) => db().get<{ name: string }>(`SELECT name FROM ${table} WHERE id = ?`, id)?.name;

export const PLANT_CATALOGUE_SHARE_KINDS: readonly ShareKindDef<PlantCataloguePermission>[] = [
  {
    kind: 'device_profile',
    model: PLANT_CATALOGUE_SHARES,
    name: named('plant_profiles'),
    link: (id) => `/plant/profiles/${encodeURIComponent(id)}`,
    rights: (u, id) => catalogueEntryAccess(u, 'device_profile', id).permissions,
  },
  {
    kind: 'kpi_definition',
    model: PLANT_CATALOGUE_SHARES,
    name: named('plant_kpis'),
    link: (id) => `/plant/kpis/${encodeURIComponent(id)}`,
    rights: (u, id) => catalogueEntryAccess(u, 'kpi_definition', id).permissions,
  },
];

// ---------- copies ----------

/** Where a copy's scope comes from: the original (Duplicate) or the leading profile (Extract a base). */
export interface CatalogueCopy {
  kind: PlantCatalogueKind;
  /** The entry whose scope the copy takes */
  from: { id: string; name: string };
  /** The new entry */
  to: { id: string; name: string };
  /** How the copy came about, for the audit summary: "a copy of", "the base extracted from" */
  as: 'copy' | 'base';
  /** Write the audit entries (false: a preview, rolled back) */
  audit?: boolean;
}

/**
 * The refusal when the caller would not see the copy (they reach its original only through a share, which a copy does
 * not get): nothing is written.
 */
export const copyNotVisible = (kind: PlantCatalogueKind, id: string): HttpError =>
  new HttpError(
    403,
    'The copy would belong to the owning teams of the original (or only its shares, if it is Restricted), and you would not see it – ask a member of those teams or an administrator',
    'PLANT_COPY_NOT_VISIBLE',
    { kind, id },
  );

/**
 * A copy of a device profile or KPI definition – duplicated, or a base extracted from profiles – belongs where its
 * original does (0.21.0, ADR 0033 part 3): its owning teams, and Restricted when the original is, never the whole
 * instance's when the original was not. A team's entry is not copied into one everyone sees. Shares are not copied:
 * they were given to the original. Audited like any other change of owning teams (`access.owning_teams_changed`) and of
 * the scope (`access.scope_changed`); no step-up – the copy is no wider than its original, whose readers it gets.
 * Throws `PLANT_COPY_NOT_VISIBLE` (in the caller's transaction) when the caller would not see the copy.
 */
export function copyCatalogueScope(c: CatalogueCopy): { teams: string[]; restricted: boolean } {
  const teams = owningTeams(c.kind, c.from.id);
  const restricted = isRestricted(c.kind, c.from.id);
  const names = teams.map((t) => t.name);
  const label = `${c.kind} "${c.to.name}"`;
  const origin =
    c.as === 'copy' ? `those of "${c.from.name}" (${c.from.id}), which it copies` : `those of "${c.from.name}" (${c.from.id}), its leading profile`;
  if (teams.length) {
    setOwningTeams(
      c.kind,
      c.to.id,
      teams.map((t) => t.id),
    );
    if (c.audit !== false)
      audit({
        action: 'access.owning_teams_changed',
        entityType: c.kind,
        entityId: c.to.id,
        summary: `Owning teams of ${label}: ${names.join(', ')} – ${origin}`,
        details: { before: [], after: names, from: c.from.id },
      });
  }
  if (restricted) {
    db().run(
      'INSERT INTO resource_restrictions (kind, resource_id, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING',
      c.kind,
      c.to.id,
      currentActor(),
      nowIso(),
    );
    sharesChanged();
    if (c.audit !== false)
      auditAccessChange({
        action: ACCESS_AUDIT.scopeChanged,
        entityType: c.kind,
        entityId: c.to.id,
        summary: `${label} is Restricted like "${c.from.name}" (${c.from.id}): instance roles give nothing on it, only its ${names.length ? 'owning teams and ' : ''}shares`,
        details: { before: 'open', after: 'restricted', owningTeams: names, from: c.from.id },
      });
  }
  const u = currentUser();
  if (u && !catalogueEntryAccess(u, c.kind, c.to.id).permissions.includes('view')) throw copyNotVisible(c.kind, c.to.id);
  return { teams: names, restricted };
}

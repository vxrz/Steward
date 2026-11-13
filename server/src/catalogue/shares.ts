import { db } from '../db.js';
import { parseJson } from '../util.js';
import { CATALOGUE_SHARE_MODEL, catalogueAccess, catalogueTeams, type CatalogueKind } from '../auth/policy.js';
import type { ShareKindDef } from '../auth/shares.js';

/**
 * Services, applications, systems and suppliers switched to shares (ADR 0033 phase 1, #291, #292): what the shares
 * core and the Access tab need of them. The rights are catalogueAccess() – shares, the Restricted scope and the owners'
 * implied Edit included – so every surface that asks it follows. Owners are not stored as shares: their Edit is
 * computed from the owner field (`implied`).
 */

const TABLES: Record<CatalogueKind, string> = { service: 'services', application: 'applications', system: 'systems', supplier: 'suppliers' };
const PATHS: Record<CatalogueKind, string> = { service: '/services', application: '/applications', system: '/systems', supplier: '/suppliers' };

type Right = 'view' | 'edit' | 'manage';

export function catalogueShareKind(kind: CatalogueKind): ShareKindDef<Right> {
  const row = (id: string) => db().get<{ name: string; owners: string }>(`SELECT name, owners FROM ${TABLES[kind]} WHERE id = ?`, id);
  return {
    kind,
    model: CATALOGUE_SHARE_MODEL,
    name: (id) => row(id)?.name,
    link: (id) => `${PATHS[kind]}/${id}`,
    rights: (u, id) => {
      const r = row(id);
      if (!r) return [];
      const d = catalogueAccess(u, { kind, id, owners: parseJson<string[]>(r.owners, []) });
      return (['view', 'edit', 'manage'] as const).filter((p) => d[p]);
    },
    implied: (id) =>
      [...new Set(parseJson<string[]>(row(id)?.owners ?? '[]', []).map((s) => s.trim().toLowerCase()))]
        .filter((s) => /^(user|team):./.test(s))
        .map((subject) => ({ subject, level: 'edit' as const, as: 'owner' as const })),
    // an application without owning teams of its own belongs to its services' teams
    teams: (id) => catalogueTeams(kind, id),
  };
}

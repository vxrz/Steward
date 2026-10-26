import { byDimension, type ApplicationRating, type CiaDimension } from '@sm/shared';
import { db } from '../db.js';
import { currentScale, levelLabel, protectionNeedOf, ratingsOf } from './cia.js';
import { serviceApplications } from './applications.js';

/**
 * The protection need in evidence packs: for a service, its effective protection need per dimension (derived with
 * the maximum principle, or overridden with a reason) and the CIA rating of each of its applications; for a
 * platform, the application it belongs to with its rating. Labels as on the scale when the pack is built.
 */

export interface PackRating {
  level: string;
  label: string;
  justification: string;
  ratedBy: string;
  ratedAt: string;
  needsRerating: boolean;
}

export interface PackNeed {
  effective: string | null;
  effectiveLabel: string | null;
  derived: string | null;
  derivedLabel: string | null;
  derivedFrom: string[];
  rated: number;
  total: number;
  needsRerating: number;
  override: { level: string; label: string; reason: string; setBy: string; setAt: string } | null;
}

export interface PackCatalogue {
  scale: { mode: string };
  service?: {
    id: string;
    name: string;
    protectionNeed: Record<CiaDimension, PackNeed>;
    applications: { id: string; name: string; archived: boolean; role: string | null; roleText: string; rating: Record<CiaDimension, PackRating | null> }[];
  };
  /** Platform packs: the application the platform belongs to (null: none) */
  application?: { id: string; name: string; archived: boolean; rating: Record<CiaDimension, PackRating | null> } | null;
}

type Scale = ReturnType<typeof currentScale>;

function packRating(r: ApplicationRating, scale: Scale): Record<CiaDimension, PackRating | null> {
  return byDimension((d) => {
    const x = r[d];
    return x
      ? {
          level: x.level,
          label: levelLabel(d, x.level, scale) ?? x.level,
          justification: x.justification,
          ratedBy: x.ratedBy,
          ratedAt: x.ratedAt,
          needsRerating: x.needsRerating,
        }
      : null;
  });
}

export function serviceCatalogue(serviceId: string): PackCatalogue | null {
  const s = db().get<{ id: string; name: string }>('SELECT id, name FROM services WHERE id = ?', serviceId);
  if (!s) return null;
  const scale = currentScale();
  const need = protectionNeedOf(serviceId);
  const protectionNeed = byDimension((d): PackNeed => {
    const n = need[d];
    return {
      effective: n.effective,
      effectiveLabel: levelLabel(d, n.effective, scale),
      derived: n.derived,
      derivedLabel: levelLabel(d, n.derived, scale),
      derivedFrom: n.derivedFrom,
      rated: n.rated,
      total: n.total,
      needsRerating: n.needsRerating,
      override: n.override
        ? {
            level: n.override.level,
            label: levelLabel(d, n.override.level, scale) ?? n.override.level,
            reason: n.override.reason,
            setBy: n.override.setBy,
            setAt: n.override.setAt,
          }
        : null,
    };
  });
  return {
    scale: { mode: scale.mode },
    service: {
      id: s.id,
      name: s.name,
      protectionNeed,
      applications: serviceApplications(serviceId).map((a) => ({
        id: a.id,
        name: a.name,
        archived: a.archived,
        role: a.role,
        roleText: a.roleText,
        rating: packRating(a.rating, scale),
      })),
    },
  };
}

export function platformCatalogue(platformId: string): PackCatalogue {
  const scale = currentScale();
  const a = db().get<{ id: string; name: string; archived: number }>(
    'SELECT a.id, a.name, a.archived FROM application_platforms ap JOIN applications a ON a.id = ap.application_id WHERE ap.platform_id = ?',
    platformId,
  );
  if (!a) return { scale: { mode: scale.mode }, application: null };
  const r = ratingsOf([a.id]).get(a.id)!;
  return { scale: { mode: scale.mode }, application: { id: a.id, name: a.name, archived: !!a.archived, rating: packRating(r, scale) } };
}

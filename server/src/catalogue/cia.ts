import { z } from 'zod';
import {
  boundedRecord,
  byDimension,
  CIA_COLORS,
  CIA_DIMENSIONS,
  CIA_LEVEL_KEY_RE,
  CIA_LIMITS,
  CIA_SCALE_MODES,
  DEFAULT_CIA_LEVELS,
  levelRank,
  type ApplicationRating,
  type CiaDimension,
  type CiaLevel,
  type CiaRating,
  type CiaScale,
  type CiaScaleMode,
  type ProtectionNeedDimension,
  type ProtectionNeedOverride,
  type ServiceProtectionNeed,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { forbid, me } from '../records/access.js';

/**
 * CIA scales, ratings and the derived protection need of a service.
 *
 * - The scale is the BSI default (normal / high / very high) unless an administrator saved a custom one: one scale for
 *   all three dimensions ("all") or one per dimension. Levels are ordered lowest first; the order decides the maximum.
 * - Ratings store the level key. A scale change never deletes a rating: a rating whose level is no longer on the new
 *   scale is either mapped to a level of the new scale (an explicit mapping in the save request) or flagged
 *   "needs re-rating" – it keeps its old level and justification, shows the old label, and does not count for the
 *   maximum until someone rates it again. The same holds for the overrides of services.
 * - The derived protection need of a service is, per dimension, the highest valid rating across its applications that
 *   are not archived (maximum principle, BSI-Standard 200-2); an override (with a reason) replaces it.
 */

interface ScaleRow {
  dimension: string;
  levels: string;
  updated_at: string;
  updated_by: string;
}

export interface RatingRow {
  application_id: string;
  dimension: string;
  level: string;
  justification: string;
  rated_at: string;
  rated_by: string;
  needs_rerating: number;
  previous_label: string | null;
}

export interface OverrideRow {
  service_id: string;
  dimension: string;
  level: string;
  reason: string;
  set_at: string;
  set_by: string;
  needs_rerating: number;
  previous_label: string | null;
}

const defaultLevels = (): CiaLevel[] => DEFAULT_CIA_LEVELS.map((l) => ({ ...l }));

/** The scale in use: its mode and the ordered levels of each dimension. */
export function currentScale(): { mode: CiaScaleMode; levels: Record<CiaDimension, CiaLevel[]>; updatedAt: string | null; updatedBy: string | null } {
  const rows = db().all<ScaleRow>('SELECT * FROM cia_scales');
  const all = rows.find((r) => r.dimension === 'all');
  const perDim = CIA_DIMENSIONS.map((d) => rows.find((r) => r.dimension === d));
  const parse = (r: ScaleRow | undefined) => {
    const levels = parseJson<CiaLevel[]>(r?.levels ?? null, []);
    return levels.length >= CIA_LIMITS.minLevels ? levels : defaultLevels();
  };
  const latest = rows.reduce<ScaleRow | undefined>((a, r) => (!a || r.updated_at > a.updated_at ? r : a), undefined);
  if (perDim.every(Boolean)) {
    return {
      mode: 'perDimension',
      levels: byDimension((d) => parse(perDim[CIA_DIMENSIONS.indexOf(d)])),
      updatedAt: latest?.updated_at ?? null,
      updatedBy: latest?.updated_by ?? null,
    };
  }
  if (all) {
    const levels = parse(all);
    return {
      mode: 'shared',
      levels: { confidentiality: levels, integrity: levels, availability: levels },
      updatedAt: all.updated_at,
      updatedBy: all.updated_by,
    };
  }
  return {
    mode: 'default',
    levels: { confidentiality: defaultLevels(), integrity: defaultLevels(), availability: defaultLevels() },
    updatedAt: latest?.updated_at ?? null,
    updatedBy: latest?.updated_by ?? null,
  };
}

export function levelsOf(d: CiaDimension, scale = currentScale()): CiaLevel[] {
  return scale.levels[d];
}

/** Label of a level key in a dimension (the key itself when it is not on the scale). */
export function levelLabel(d: CiaDimension, key: string | null | undefined, scale = currentScale()): string | null {
  if (!key) return null;
  return scale.levels[d].find((l) => l.key === key)?.label ?? key;
}

function usage(): Record<CiaDimension, Record<string, number>> {
  const rows = db().all<{ dimension: string; level: string; n: number }>(
    `SELECT dimension, level, COUNT(*) AS n FROM application_ratings GROUP BY dimension, level
     UNION ALL SELECT dimension, level, COUNT(*) AS n FROM service_protection_overrides GROUP BY dimension, level`,
  );
  return byDimension((d) => {
    const counts = new Map<string, number>();
    for (const r of rows) if (r.dimension === d) counts.set(r.level, (counts.get(r.level) ?? 0) + Number(r.n));
    return Object.fromEntries(counts);
  });
}

export const canEditScale = (u = currentUser()): boolean => isAdmin(u);

export function getScale(): CiaScale {
  me();
  const s = currentScale();
  return { ...s, usage: usage(), canEdit: canEditScale() };
}

// ---------- changing the scale ----------

const levelInput = z
  .object({
    key: z.string().trim().regex(CIA_LEVEL_KEY_RE, 'a key such as high or very_high: lower case letters, digits and _'),
    label: z.string().trim().min(1).max(CIA_LIMITS.label),
    description: z.string().trim().max(CIA_LIMITS.description).default(''),
    color: z.enum(CIA_COLORS),
  })
  .strict();
const levelsInput = z
  .array(levelInput)
  .max(CIA_LIMITS.maxLevels)
  .min(CIA_LIMITS.minLevels)
  .refine((ls) => new Set(ls.map((l) => l.key)).size === ls.length, 'Each level needs its own key');

/** For each dimension (or "all"): old level key → new level key (or null: flag for re-rating). */
const mappingInput = boundedRecord(boundedRecord(z.string().trim().regex(CIA_LEVEL_KEY_RE).nullable(), CIA_LIMITS.maxLevels * 4), CIA_DIMENSIONS.length + 1);

export const scaleInput = z
  .object({
    mode: z.enum(CIA_SCALE_MODES),
    /** mode shared: the levels for all three dimensions */
    levels: levelsInput.optional(),
    /** mode perDimension: the levels of each dimension */
    dimensions: z.object({ confidentiality: levelsInput, integrity: levelsInput, availability: levelsInput }).strict().optional(),
    /**
     * Ratings whose level is not on the new scale: map them to a level of the new scale; levels not mapped are
     * flagged "needs re-rating". Keys: a dimension, or "all" for every dimension (a dimension's own entry wins).
     */
    mapping: mappingInput.default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.mode === 'shared' && !v.levels) ctx.addIssue({ code: 'custom', path: ['levels'], message: 'A shared scale needs its levels' });
    if (v.mode === 'perDimension' && !v.dimensions)
      ctx.addIssue({ code: 'custom', path: ['dimensions'], message: 'A scale per dimension needs the levels of each dimension' });
    for (const k of Object.keys(v.mapping))
      if (k !== 'all' && !(CIA_DIMENSIONS as readonly string[]).includes(k))
        ctx.addIssue({ code: 'custom', path: ['mapping', k], message: 'Unknown dimension' });
  });
export type ScaleInput = z.infer<typeof scaleInput>;

const mappingFor = (m: ScaleInput['mapping'], d: CiaDimension): Map<string, string | null> =>
  new Map([...Object.entries(m.all ?? {}), ...Object.entries(m[d] ?? {})]);

/**
 * Saves a scale (administrators). Ratings and overrides whose level the new scale no longer has are mapped (mapping)
 * or flagged for re-rating – never deleted. One audit entry with the levels and what happened to the ratings.
 */
export function saveScale(input: ScaleInput): CiaScale {
  const u = me();
  if (!canEditScale(u)) forbid('change the CIA scale', 'changeCiaScale');
  const before = currentScale();
  const next: Record<CiaDimension, CiaLevel[]> =
    input.mode === 'default'
      ? { confidentiality: defaultLevels(), integrity: defaultLevels(), availability: defaultLevels() }
      : input.mode === 'shared'
        ? { confidentiality: input.levels!, integrity: input.levels!, availability: input.levels! }
        : input.dimensions!;
  // the mapping may only name levels that disappear, and only map them to levels of the new scale
  for (const d of CIA_DIMENSIONS) {
    const keys = new Set(next[d].map((l) => l.key));
    for (const [from, to] of mappingFor(input.mapping, d)) {
      if (keys.has(from))
        throw new HttpError(400, `The level "${from}" stays on the ${d} scale – only levels that are removed can be mapped`, 'CIA_MAPPING_LEVEL_KEPT', {
          level: from,
          dimension: d,
        });
      if (to !== null && !keys.has(to))
        throw new HttpError(400, `The level "${to}" is not on the new ${d} scale`, 'CIA_MAPPING_TARGET_UNKNOWN', { level: to, dimension: d });
    }
  }
  const now = nowIso();
  const effects = new Map<CiaDimension, { mapped: number; flagged: number }>();
  db().tx(() => {
    db().run('DELETE FROM cia_scales');
    if (input.mode === 'shared')
      db().run('INSERT INTO cia_scales (dimension, levels, updated_at, updated_by) VALUES (?, ?, ?, ?)', 'all', JSON.stringify(input.levels), now, u.username);
    if (input.mode === 'perDimension')
      for (const d of CIA_DIMENSIONS)
        db().run('INSERT INTO cia_scales (dimension, levels, updated_at, updated_by) VALUES (?, ?, ?, ?)', d, JSON.stringify(next[d]), now, u.username);
    for (const d of CIA_DIMENSIONS) {
      const keys = new Set(next[d].map((l) => l.key));
      const map = mappingFor(input.mapping, d);
      const e = { mapped: 0, flagged: 0 };
      const handle = (table: 'application_ratings' | 'service_protection_overrides', idCol: 'application_id' | 'service_id') => {
        const rows = db().all<{ id: string; level: string; needs_rerating: number }>(
          `SELECT ${idCol} AS id, level, needs_rerating FROM ${table} WHERE dimension = ?`,
          d,
        );
        for (const r of rows) {
          if (keys.has(r.level)) continue;
          const oldLabel = before.levels[d].find((l) => l.key === r.level)?.label ?? r.level;
          const to = map.get(r.level);
          if (to) {
            // mapped: valid again on the new scale (unless it waited for a re-rating anyway); the old label stays visible
            db().run(`UPDATE ${table} SET level = ?, previous_label = ? WHERE ${idCol} = ? AND dimension = ?`, to, oldLabel, r.id, d);
            e.mapped++;
          } else if (!r.needs_rerating) {
            db().run(`UPDATE ${table} SET needs_rerating = 1, previous_label = ? WHERE ${idCol} = ? AND dimension = ?`, oldLabel, r.id, d);
            e.flagged++;
          }
        }
      };
      handle('application_ratings', 'application_id');
      handle('service_protection_overrides', 'service_id');
      effects.set(d, e);
    }
    const describe = (ls: CiaLevel[]) => ls.map((l) => l.key).join(' < ');
    audit({
      action: 'catalogue.cia_scale_changed',
      entityType: 'cia_scale',
      entityId: 'cia_scale',
      summary: `CIA scale changed to ${input.mode === 'default' ? 'the BSI default' : input.mode === 'shared' ? `one scale (${describe(next.confidentiality)})` : 'one scale per dimension'}: ${CIA_DIMENSIONS.map(
        (d) => `${d} ${effects.get(d)!.mapped} mapped, ${effects.get(d)!.flagged} flagged for re-rating`,
      ).join('; ')}`,
      details: {
        mode: input.mode,
        previousMode: before.mode,
        levels: next,
        previousLevels: before.levels,
        mapping: input.mapping,
        effects: byDimension((d) => effects.get(d)!),
      },
    });
  });
  return getScale();
}

// ---------- ratings ----------

export function toRating(r: RatingRow | undefined, d: CiaDimension, scale: ReturnType<typeof currentScale>): CiaRating | null {
  if (!r) return null;
  return {
    level: r.level,
    justification: r.justification,
    ratedAt: r.rated_at,
    ratedBy: r.rated_by,
    // flagged by a scale change, or (defensively) a level that is not on the scale
    needsRerating: !!r.needs_rerating || levelRank(scale.levels[d], r.level) < 0,
    previousLabel: r.previous_label ?? null,
  };
}

/** Ratings of these applications (all: undefined), by application. */
export function ratingsOf(appIds?: string[]): Map<string, ApplicationRating> {
  const scale = currentScale();
  const rows = db().all<RatingRow>('SELECT * FROM application_ratings');
  const byApp = new Map<string, RatingRow[]>();
  for (const r of rows) {
    if (appIds && !appIds.includes(r.application_id)) continue;
    byApp.set(r.application_id, [...(byApp.get(r.application_id) ?? []), r]);
  }
  const out = new Map<string, ApplicationRating>();
  for (const id of appIds ?? [...byApp.keys()]) {
    const rs = byApp.get(id) ?? [];
    out.set(
      id,
      byDimension((d) =>
        toRating(
          rs.find((x) => x.dimension === d),
          d,
          scale,
        ),
      ),
    );
  }
  return out;
}

export const emptyRating = (): ApplicationRating => ({ confidentiality: null, integrity: null, availability: null });

const ratingDim = z
  .object({
    level: z.string().trim().regex(CIA_LEVEL_KEY_RE),
    justification: z.string().trim().min(1, 'Give a justification').max(CIA_LIMITS.justification),
  })
  .strict()
  .nullable()
  .optional();
/** Per dimension: a level with its justification, null to remove the rating, missing to keep it. */
export const ratingInput = z.object({ confidentiality: ratingDim, integrity: ratingDim, availability: ratingDim }).strict();
export type RatingInput = z.infer<typeof ratingInput>;

const overrideDim = z
  .object({
    level: z.string().trim().regex(CIA_LEVEL_KEY_RE),
    reason: z.string().trim().min(1, 'Give a reason').max(CIA_LIMITS.reason),
  })
  .strict()
  .nullable()
  .optional();
/** Per dimension: the overriding level with its reason, null to remove the override, missing to keep it. */
export const overrideInput = z.object({ confidentiality: overrideDim, integrity: overrideDim, availability: overrideDim }).strict();
export type OverrideInput = z.infer<typeof overrideInput>;

/** A level must be on the dimension's current scale. */
export function checkLevel(d: CiaDimension, level: string, scale = currentScale()): void {
  if (levelRank(scale.levels[d], level) < 0)
    throw new HttpError(400, `"${level}" is not a level of the ${d} scale (${scale.levels[d].map((l) => l.key).join(', ')})`, 'CIA_LEVEL_UNKNOWN', {
      level,
      dimension: d,
      allowed: scale.levels[d].map((l) => l.key).join(', '),
    });
}

// ---------- protection need of services ----------

interface MemberRow {
  service_id: string;
  application_id: string;
  archived: number;
}

/**
 * The protection need of these services (all: undefined): per dimension the highest valid rating across the
 * applications that are not archived (maximum principle), the override and the effective level.
 */
export function protectionNeeds(serviceIds?: string[]): Map<string, ServiceProtectionNeed> {
  const scale = currentScale();
  const members = db().all<MemberRow>(
    'SELECT sa.service_id, sa.application_id, a.archived FROM service_applications sa JOIN applications a ON a.id = sa.application_id',
  );
  const ratings = ratingsOf();
  const overrides = db().all<OverrideRow>('SELECT * FROM service_protection_overrides');
  const ids = serviceIds ?? [...new Set([...members.map((m) => m.service_id), ...overrides.map((o) => o.service_id)])];
  const out = new Map<string, ServiceProtectionNeed>();
  for (const sid of ids) {
    const apps = members.filter((m) => m.service_id === sid && !m.archived).map((m) => m.application_id);
    const need: ServiceProtectionNeed = byDimension((d): ProtectionNeedDimension => {
      const levels = scale.levels[d];
      let best = -1;
      let from: string[] = [];
      let rated = 0;
      let stale = 0;
      for (const a of apps) {
        const r = ratings.get(a)?.[d];
        if (!r) continue;
        if (r.needsRerating) {
          stale++;
          continue;
        }
        rated++;
        const rank = levelRank(levels, r.level);
        if (rank > best) {
          best = rank;
          from = [a];
        } else if (rank === best) from.push(a);
      }
      const o = overrides.find((x) => x.service_id === sid && x.dimension === d);
      const override: ProtectionNeedOverride | null = o
        ? {
            level: o.level,
            reason: o.reason,
            setAt: o.set_at,
            setBy: o.set_by,
            needsRerating: !!o.needs_rerating || levelRank(levels, o.level) < 0,
            previousLabel: o.previous_label ?? null,
          }
        : null;
      const derived = best >= 0 ? levels[best]!.key : null;
      return {
        derived,
        derivedFrom: from,
        rated,
        total: apps.length,
        needsRerating: stale,
        override,
        effective: override && !override.needsRerating ? override.level : derived,
      };
    });
    out.set(sid, need);
  }
  return out;
}

export function protectionNeedOf(serviceId: string): ServiceProtectionNeed {
  return protectionNeeds([serviceId]).get(serviceId)!;
}

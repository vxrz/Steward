import {
  BUILT_IN_DATA_TECHNOLOGIES,
  DATA_TECHNOLOGY_LIMITS as TL,
  builtInTechnologies,
  dataTechnologyInput,
  dataTechnologyKey,
  findTechnology,
  type DataTechnology,
  type DataTechnologyIcon,
  type DataTechnologyRole,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { requireAdmin } from '../auth/access.js';
import { HttpError, nowIso } from '../util.js';

/**
 * The technology list of parts and bridges (0.25.0, ADR 0037 part 0): the built-in entries of shared/src/dataTechnologies.ts
 * and those administrators add (dp_technologies). Every reader of the module reads it (the pictures, the filters, the
 * forms and the scorecard use it); administrators add, change and remove their own entries – built-in ones stay as they
 * are. A technology an element or a runner names that is in neither shows as _not in the list_ and is kept.
 *
 * The list is read once and kept until it changes (a change here clears it): the pictures and the scorecard use it
 * without a statement of their own.
 */

interface TechnologyRow {
  key: string;
  name: string;
  role: DataTechnologyRole;
  icon: DataTechnologyIcon;
  ol_namespace_pattern: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

let cached: { at: number; list: DataTechnology[] } | null = null;
/** How long the list is kept without a change here (another process of the instance may have changed it). */
const KEEP_MS = 60_000;

/** The whole list: the built-in entries first (in their order), then the administrators' by name. */
export function technologyList(now = Date.now()): DataTechnology[] {
  if (cached && now - cached.at < KEEP_MS) return cached.list;
  const custom = db()
    .all<TechnologyRow>('SELECT * FROM dp_technologies ORDER BY name, key')
    .map((r): DataTechnology => ({
      key: r.key,
      name: r.name,
      role: r.role,
      icon: r.icon,
      olNamespacePattern: r.ol_namespace_pattern,
      builtIn: false,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
  const list = [...builtInTechnologies(), ...custom];
  cached = { at: now, list };
  return list;
}

/** Forgets the kept list (tests, and after a change). */
export function forgetTechnologies(): void {
  cached = null;
}

/** The entry a stored value names, or null (_not in the list_). */
export const technologyOf = (value: string | null | undefined): DataTechnology | null => findTechnology(technologyList(), value);

const isBuiltIn = (key: string) => BUILT_IN_DATA_TECHNOLOGIES.some((t) => t.key === key);

/** Adds or changes an administrator's entry (PUT /api/data-products/technologies/:key). */
export function putTechnology(rawKey: string, body: unknown): DataTechnology {
  const u = requireAdmin('change the technology list', 'dataProducts');
  const key = dataTechnologyKey.parse(rawKey);
  if (isBuiltIn(key)) throw new HttpError(409, `"${key}" is a built-in technology – it cannot be changed`, 'DATA_TECHNOLOGY_BUILT_IN', { key });
  const input = dataTechnologyInput.parse(body);
  const existing = db().get<TechnologyRow>('SELECT * FROM dp_technologies WHERE key = ?', key);
  // a name is one entry: another key (built in or not) with the same name would make a typed value ambiguous
  const clash = technologyList().find((t) => t.key !== key && t.name.trim().toLowerCase() === input.name.trim().toLowerCase());
  if (clash) throw new HttpError(409, `"${input.name}" is the name of another technology (${clash.key})`, 'DATA_TECHNOLOGY_EXISTS', { name: input.name });
  if (!existing && Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM dp_technologies')!.n) >= TL.custom)
    throw new HttpError(409, `Limit reached: at most ${TL.custom} technologies of your own`, 'DATA_PRODUCT_LIMIT', { context: 'technologies', max: TL.custom });
  const now = nowIso();
  db().tx(() => {
    if (existing)
      db().run(
        'UPDATE dp_technologies SET name = ?, role = ?, icon = ?, ol_namespace_pattern = ?, updated_at = ?, updated_by = ? WHERE key = ?',
        input.name,
        input.role,
        input.icon,
        input.olNamespacePattern || null,
        now,
        u.username,
        key,
      );
    else
      db().run(
        `INSERT INTO dp_technologies (key, name, role, icon, ol_namespace_pattern, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key,
        input.name,
        input.role,
        input.icon,
        input.olNamespacePattern || null,
        now,
        u.username,
        now,
        u.username,
      );
    audit({
      action: existing ? 'datatechnology.updated' : 'datatechnology.created',
      entityType: 'data_technology',
      entityId: key,
      summary: `Technology "${input.name}" (${key}, ${input.role}) ${existing ? 'changed' : 'added to the technology list'}`,
      details: { key, role: input.role, icon: input.icon, olNamespacePattern: input.olNamespacePattern },
    });
  });
  forgetTechnologies();
  return technologyList().find((t) => t.key === key)!;
}

/** Removes an administrator's entry; elements and runners that name it keep the value (then _not in the list_). */
export function deleteTechnology(rawKey: string): void {
  requireAdmin('change the technology list', 'dataProducts');
  const key = dataTechnologyKey.parse(rawKey);
  if (isBuiltIn(key)) throw new HttpError(409, `"${key}" is a built-in technology – it cannot be removed`, 'DATA_TECHNOLOGY_BUILT_IN', { key });
  const existing = db().get<TechnologyRow>('SELECT * FROM dp_technologies WHERE key = ?', key);
  if (!existing) throw new HttpError(404, `Technology ${key} not found`, 'DATA_TECHNOLOGY_NOT_FOUND', { key });
  db().tx(() => {
    db().run('DELETE FROM dp_technologies WHERE key = ?', key);
    audit({
      action: 'datatechnology.deleted',
      entityType: 'data_technology',
      entityId: key,
      summary: `Technology "${existing.name}" (${key}) removed from the technology list`,
    });
  });
  forgetTechnologies();
}

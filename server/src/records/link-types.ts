import { z } from 'zod';
import { BUILTIN_LINK_TYPES, LINK_TYPE_ICONS, LINK_TYPE_KEY_RE, type LinkType, type LinkTypeIcon } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor } from '../auth/context.js';
import { HttpError, nowIso } from '../util.js';
import { canManageRecordTypes, forbid, me } from './access.js';

/**
 * Types of external links (runbook, repository, monitoring, …). The built-in types live in code and cannot
 * change; administrators add their own (name and an icon from a fixed set), rename and archive them. Links
 * store the type's key, which never changes, so renaming a type renames it on every link.
 */

interface LinkTypeRow {
  key: string;
  name: string;
  icon: string;
  archived: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

/** At most this many types of their own (a list to choose from, not a tag cloud). */
export const MAX_CUSTOM_LINK_TYPES = 100;

const BUILTIN_KEYS = new Set(BUILTIN_LINK_TYPES.map((t) => t.key));

const builtin = (): LinkType[] =>
  BUILTIN_LINK_TYPES.map((t) => ({ ...t, builtin: true, archived: false, createdAt: null, createdBy: null, updatedAt: null, updatedBy: null }));

const toType = (r: LinkTypeRow): LinkType => ({
  key: r.key,
  name: r.name,
  icon: (LINK_TYPE_ICONS as readonly string[]).includes(r.icon) ? (r.icon as LinkTypeIcon) : 'link',
  builtin: false,
  archived: !!r.archived,
  createdAt: r.created_at,
  createdBy: r.created_by,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

const customRow = (key: string) => db().get<LinkTypeRow>('SELECT * FROM link_types WHERE key = ?', key);

/** Built-in types first (in their fixed order), then the administrators' own by name; archived ones too (links keep them). */
export function listLinkTypes(): LinkType[] {
  me();
  return [...builtin(), ...db().all<LinkTypeRow>('SELECT * FROM link_types ORDER BY lower(name), key').map(toType)];
}

/** A link type by key (built-in or custom, archived too), or undefined. */
export function linkTypeByKey(key: string): LinkType | undefined {
  const b = BUILTIN_LINK_TYPES.find((t) => t.key === key);
  if (b) return builtin().find((t) => t.key === key);
  const r = customRow(key);
  return r ? toType(r) : undefined;
}

/** The type of a new or changed link: null (no type), or a known type that is not archived. */
export function checkLinkType(key: string | null | undefined): string | null {
  if (key === null || key === undefined || key === '') return null;
  const t = linkTypeByKey(key);
  if (!t) throw new HttpError(400, `Unknown link type "${key}"`, 'LINK_TYPE_UNKNOWN', { type: key });
  if (t.archived) throw new HttpError(400, `The link type "${t.name}" is archived`, 'LINK_TYPE_ARCHIVED', { type: t.name });
  return t.key;
}

/** The link type's key as given in a link: a stable key (built-in or an administrator's own). */
export const linkTypeKey = z.string().trim().max(40).regex(LINK_TYPE_KEY_RE, 'a link type key such as runbook');

export const linkTypeInput = z
  .object({
    /** Optional on creation (derived from the name); fixed afterwards */
    key: linkTypeKey.optional(),
    name: z.string().trim().min(1).max(60),
    icon: z.enum(LINK_TYPE_ICONS),
  })
  .strict();
export const linkTypeUpdate = z
  .object({
    name: z.string().trim().min(1).max(60),
    icon: z.enum(LINK_TYPE_ICONS),
    archived: z.boolean().default(false),
  })
  .strict();

const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');

function requireAdmin(what: string): void {
  if (!canManageRecordTypes(me())) forbid(what, 'manageLinkTypes');
}

function nameTaken(name: string, exceptKey?: string): boolean {
  const n = name.toLowerCase();
  if (BUILTIN_LINK_TYPES.some((t) => t.name.toLowerCase() === n)) return true;
  return !!db().get('SELECT 1 FROM link_types WHERE lower(name) = ? AND key <> ?', n, exceptKey ?? '');
}

export function createLinkType(input: z.infer<typeof linkTypeInput>): LinkType {
  requireAdmin('manage link types');
  const count = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM link_types')!.n);
  if (count >= MAX_CUSTOM_LINK_TYPES)
    throw new HttpError(400, `At most ${MAX_CUSTOM_LINK_TYPES} link types of your own`, 'LINK_TYPE_LIMIT', { max: MAX_CUSTOM_LINK_TYPES });
  if (nameTaken(input.name)) throw new HttpError(409, `A link type named "${input.name}" exists already`, 'LINK_TYPE_EXISTS', { name: input.name });
  let key = input.key ?? slug(input.name);
  if (!LINK_TYPE_KEY_RE.test(key)) key = `type-${key}`.slice(0, 40).replace(/-+$/, '');
  if (!LINK_TYPE_KEY_RE.test(key)) key = 'custom';
  if (input.key) {
    if (BUILTIN_KEYS.has(key) || customRow(key)) throw new HttpError(409, `The link type key "${key}" is taken`, 'LINK_TYPE_KEY_TAKEN', { key });
  } else {
    // derived keys: the first free one (runbook-2, runbook-3, …)
    const base = key.slice(0, 36);
    for (let i = 2; BUILTIN_KEYS.has(key) || customRow(key); i++) key = `${base}-${i}`;
  }
  const now = nowIso();
  const actor = currentActor();
  db().tx(() => {
    db().run(
      'INSERT INTO link_types (key, name, icon, archived, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 0, ?, ?, ?, ?)',
      key,
      input.name,
      input.icon,
      now,
      actor,
      now,
      actor,
    );
    audit({
      action: 'link_type.created',
      entityType: 'link_type',
      entityId: key,
      summary: `Link type "${input.name}" (${key}) created`,
      details: { key, name: input.name, icon: input.icon },
    });
  });
  return toType(customRow(key)!);
}

export function updateLinkType(key: string, input: z.infer<typeof linkTypeUpdate>): LinkType {
  requireAdmin('manage link types');
  if (BUILTIN_KEYS.has(key)) throw new HttpError(400, 'Built-in link types cannot be changed', 'LINK_TYPE_BUILTIN', { key });
  const cur = customRow(key);
  if (!cur) throw new HttpError(404, `Link type ${key} not found`, 'LINK_TYPE_NOT_FOUND', { key });
  if (nameTaken(input.name, key)) throw new HttpError(409, `A link type named "${input.name}" exists already`, 'LINK_TYPE_EXISTS', { name: input.name });
  const changes = [
    ...(cur.name !== input.name ? ['name'] : []),
    ...(cur.icon !== input.icon ? ['icon'] : []),
    ...(!!cur.archived !== input.archived ? ['archived'] : []),
  ];
  if (!changes.length) return toType(cur);
  db().tx(() => {
    db().run(
      'UPDATE link_types SET name = ?, icon = ?, archived = ?, updated_at = ?, updated_by = ? WHERE key = ?',
      input.name,
      input.icon,
      input.archived ? 1 : 0,
      nowIso(),
      currentActor(),
      key,
    );
    audit({
      action: changes.length === 1 && changes[0] === 'archived' ? (input.archived ? 'link_type.archived' : 'link_type.restored') : 'link_type.updated',
      entityType: 'link_type',
      entityId: key,
      summary: `Link type "${input.name}" (${key}) changed (${changes.join(', ')})`,
      details: { key, changes, name: input.name, previousName: cur.name, icon: input.icon, archived: input.archived },
    });
  });
  return toType(customRow(key)!);
}

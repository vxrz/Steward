import { z } from 'zod';
import {
  CREDENTIAL_TYPES,
  DEFAULT_CREDENTIAL_REMINDERS,
  type CertificateInfo,
  type Credential,
  type CredentialDue,
  type CredentialDueKind,
  type CredentialEvent,
  type CredentialEventKind,
  type CredentialLink,
  type CredentialPermission,
  type CredentialReminderSettings,
  type CredentialStatus,
  type MonitorPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin, matches, platformPermissions } from '../auth/permissions.js';
import { monitorPermissions } from '../monitors/model.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { likeEscape } from '../database/sql.js';
import { canReadRecords } from '../records/access.js';
import { readSetting, writeSetting } from '../settings.js';
import { setCertificateExpiryHook } from '../gatus/metrics.js';
import { assertEmailsAllowed } from '../notifications/domains.js';
import { assertNoSecrets, SecretFoundError } from './secrets.js';
import { parseCertificate, certificateBytes } from './certificates.js';
import * as platforms from '../platforms/service.js';
import * as processes from '../processes/service.js';

/**
 * Credentials register: documents credentials (what, where kept, who owns them,
 * expiry / rotation / review dates). There is no column for a secret value, and
 * free-text fields are checked for things that look like one (secrets.ts).
 *
 * Access:
 *   - read: admin, designer, operator, approver, auditor; viewers only entries they own.
 *   - create / edit: admin, designer, operator; plus the Steward users and team
 *     members listed as owners of an entry (for that entry).
 *   - archive, restore, delete: administrators.
 */

const DAY = 86400000;
const READ_ROLES = ['admin', 'designer', 'operator', 'approver', 'auditor'];
const EDIT_ROLES = ['admin', 'designer', 'operator'];

export interface CredentialRow {
  id: string;
  name: string;
  type: (typeof CREDENTIAL_TYPES)[number];
  platform_id: string | null;
  platform_text: string;
  environment: string;
  description: string;
  used_by: string;
  owners: string;
  owner_subjects: string;
  location_text: string;
  location_url: string | null;
  issued_at: string | null;
  expires_at: string | null;
  rotation_interval_days: number | null;
  last_rotated_at: string | null;
  review_interval_days: number | null;
  last_reviewed_at: string | null;
  certificate: string | null;
  gatus_platform_id: string | null;
  gatus_endpoint_key: string | null;
  reminders: string | null;
  notes: string;
  tags: string;
  archived: number;
  version: number;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

// ---------- settings ----------

const SETTINGS_KEY = 'credentials.reminders';

export function reminderSettings(): CredentialReminderSettings {
  const s = readSetting<Partial<CredentialReminderSettings>>(SETTINGS_KEY, {});
  return { ...DEFAULT_CREDENTIAL_REMINDERS, ...s, daysBefore: normDays(s.daysBefore ?? DEFAULT_CREDENTIAL_REMINDERS.daysBefore) };
}

const normDays = (d: number[]) => [...new Set(d.filter((x) => Number.isInteger(x) && x >= 0 && x <= 365))].sort((a, b) => b - a);

export const reminderSettingsSchema = z.object({
  enabled: z.boolean(),
  daysBefore: z.array(z.number().int().min(0).max(365)).max(10),
  overdueEveryDays: z.number().int().min(0).max(365),
  dueSoonDays: z.number().int().min(1).max(365),
});

export function saveReminderSettings(input: z.infer<typeof reminderSettingsSchema>): CredentialReminderSettings {
  const before = reminderSettings();
  const next = { ...input, daysBefore: normDays(input.daysBefore) };
  writeSetting(SETTINGS_KEY, next);
  audit({
    action: 'credential.settings_changed',
    entityType: 'settings',
    entityId: 'credentials',
    summary: `Credential reminder settings changed (${next.enabled ? `reminders ${next.daysBefore.join(', ')} days before, overdue every ${next.overdueEveryDays || '–'} days` : 'reminders off'}; due soon within ${next.dueSoonDays} days)`,
    details: { from: before, to: next },
  });
  return reminderSettings();
}

// ---------- permissions ----------

export const isOwner = (u: AuthUser, r: Pick<CredentialRow, 'owner_subjects'>): boolean => parseJson<string[]>(r.owner_subjects, []).some((s) => matches(u, s));

export function credentialPermissions(u: AuthUser | null, r: Pick<CredentialRow, 'owner_subjects' | 'archived'>): CredentialPermission[] {
  if (!u) return [];
  const out = new Set<CredentialPermission>();
  const owner = isOwner(u, r);
  if (owner || u.roles.some((x) => READ_ROLES.includes(x))) out.add('view');
  if ((owner || u.roles.some((x) => EDIT_ROLES.includes(x))) && !r.archived) out.add('edit');
  if (isAdmin(u)) ['view', 'edit', 'archive', 'delete'].forEach((p) => out.add(p as CredentialPermission));
  return (['view', 'edit', 'archive', 'delete'] as const).filter((p) => out.has(p));
}

export const canCreateCredentials = (u: AuthUser | null = currentUser()): boolean => !!u && u.roles.some((x) => EDIT_ROLES.includes(x));

/** May the user see any entry at all (list, export, API)? */
export const canReadRegister = (u: AuthUser | null = currentUser()): boolean => !!u;

// ---------- dues and status ----------

const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString();

export function nextRotation(r: Pick<CredentialRow, 'rotation_interval_days' | 'last_rotated_at' | 'issued_at' | 'created_at'>): string | null {
  if (!r.rotation_interval_days) return null;
  return addDays(r.last_rotated_at ?? r.issued_at ?? r.created_at, r.rotation_interval_days);
}
export function nextReview(r: Pick<CredentialRow, 'review_interval_days' | 'last_reviewed_at' | 'created_at'>): string | null {
  if (!r.review_interval_days) return null;
  return addDays(r.last_reviewed_at ?? r.created_at, r.review_interval_days);
}

const RANK: Record<CredentialStatus, number> = { ok: 0, dueSoon: 1, overdue: 2, expired: 3 };
export const worstCredentialStatus = (l: CredentialStatus[]): CredentialStatus => l.reduce<CredentialStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');

/** Whole days until `due` (rounded up while ahead, down once passed: 1 h left → 1, 1 h over → -1). */
export const daysUntil = (due: number, now: number): number => {
  const ms = due - now;
  return ms > 0 ? Math.ceil(ms / DAY) : Math.floor(ms / DAY);
};

export function computeDues(r: CredentialRow, now = Date.now(), dueSoonDays = reminderSettings().dueSoonDays): CredentialDue[] {
  const list: [CredentialDueKind, string | null][] = [
    ['expiry', r.expires_at],
    ['rotation', nextRotation(r)],
    ['review', nextReview(r)],
  ];
  return list
    .filter((x): x is [CredentialDueKind, string] => !!x[1])
    .map(([kind, dueAt]) => {
      const t = Date.parse(dueAt);
      const status: CredentialStatus = t <= now ? (kind === 'expiry' ? 'expired' : 'overdue') : t - now <= dueSoonDays * DAY ? 'dueSoon' : 'ok';
      return { kind, dueAt, daysLeft: daysUntil(t, now), status };
    });
}

// ---------- link labels (generic; other features register their kinds) ----------

type LinkResolver = (id: string) => string | null;
const linkResolvers = new Map<string, LinkResolver>();
/** Registers how links of a kind are shown (e.g. "service" for a service catalogue). Returns null when the object is missing or not visible. */
export function registerCredentialLinkKind(kind: string, resolve: LinkResolver): void {
  linkResolvers.set(kind, resolve);
}

registerCredentialLinkKind('process', (id) => {
  const r = db().get<{ name: string }>('SELECT name FROM processes WHERE id = ?', id);
  if (!r) return null;
  return processes.permissionsFor(id).includes('view') ? r.name : null;
});
registerCredentialLinkKind('platform', (id) => {
  try {
    const p = platforms.getPlatform(id);
    return p.permissions.length ? p.name : null;
  } catch {
    return null;
  }
});
registerCredentialLinkKind('monitor', (id) => {
  const r = db().get<{ name: string; owner: string; acl: string }>('SELECT name, owner, acl FROM monitors WHERE id = ? OR key = ?', id, id);
  if (!r) return null;
  return monitorPermissions(currentUser(), { owner: r.owner, acl: parseJson(r.acl, []) }).includes('view' as MonitorPermission) ? r.name : null;
});

// Catalogue services: the catalogue's read rule (records/access.ts).
registerCredentialLinkKind('service', (id) => {
  if (!canReadRecords()) return null;
  return db().get<{ name: string }>('SELECT name FROM services WHERE id = ?', id)?.name ?? null;
});

const resolveLink = (l: CredentialLink): CredentialLink => {
  const fn = linkResolvers.get(l.kind);
  let label: string | null;
  try {
    label = fn ? fn(l.id) : null;
  } catch {
    label = null;
  }
  return { kind: l.kind, id: l.id, label };
};

// ---------- mapping ----------

/** The name of the linked platform – only for users with a right on it (null otherwise, like a missing platform). */
function platformName(id: string | null, u: AuthUser | null): string | null {
  if (!id) return null;
  const p = db().get<{ name: string; acl: string }>('SELECT name, acl FROM platforms WHERE id = ?', id);
  return p && platformPermissions(u, { acl: parseJson(p.acl, []) }).length ? p.name : null;
}

export function toCredential(r: CredentialRow, u: AuthUser | null = currentUser(), now = Date.now(), settings = reminderSettings()): Credential {
  const dues = computeDues(r, now, settings.dueSoonDays);
  const usedBy = parseJson<{ text?: string; links?: CredentialLink[] }>(r.used_by, {});
  const next = dues.map((d) => d.dueAt).sort()[0] ?? null;
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    platformId: r.platform_id,
    platformName: platformName(r.platform_id, u),
    platformText: r.platform_text,
    environment: r.environment,
    description: r.description,
    usedBy: { text: usedBy.text ?? '', links: (usedBy.links ?? []).map(resolveLink) },
    owners: parseJson(r.owners, []),
    ownerSubjects: parseJson(r.owner_subjects, []),
    location: { text: r.location_text, url: r.location_url },
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    rotationIntervalDays: r.rotation_interval_days,
    lastRotatedAt: r.last_rotated_at,
    reviewIntervalDays: r.review_interval_days,
    lastReviewedAt: r.last_reviewed_at,
    nextRotationAt: nextRotation(r),
    nextReviewAt: nextReview(r),
    nextDueAt: next,
    status: worstCredentialStatus(dues.map((d) => d.status)),
    dues,
    certificate: r.certificate ? parseJson<CertificateInfo | null>(r.certificate, null) : null,
    gatus: r.gatus_platform_id && r.gatus_endpoint_key ? { platformId: r.gatus_platform_id, endpointKey: r.gatus_endpoint_key } : null,
    reminders: r.reminders ? parseJson(r.reminders, null) : null,
    notes: r.notes,
    tags: parseJson(r.tags, []),
    archived: !!r.archived,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    version: r.version,
    permissions: credentialPermissions(u, r),
  };
}

// ---------- input ----------

const dateish = z
  .string()
  .trim()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'enter a date (YYYY-MM-DD) or an ISO timestamp')
  .transform((s) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s).toISOString());

const linkSchema = z.object({ kind: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, 'lower-case kind, e.g. process'), id: z.string().trim().min(1).max(200) });
const ownerSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.string().trim().max(80).default('') });
/** Plain e-mail addresses per entry (each one gets the reminders of the entry). */
export const MAX_CREDENTIAL_OWNER_EMAILS = 10;
const subjectSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):.{1,100}$/, 'use user:<name> or team:<name>');

export const credentialInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(CREDENTIAL_TYPES),
  platformId: z.string().max(100).nullable().optional(),
  platformText: z.string().trim().max(200).default(''),
  environment: z.string().trim().max(100).default(''),
  description: z.string().max(4000).default(''),
  usedBy: z.object({ text: z.string().max(2000).default(''), links: z.array(linkSchema).max(50).default([]) }).prefault({}),
  owners: z.array(ownerSchema).max(MAX_CREDENTIAL_OWNER_EMAILS).default([]),
  ownerSubjects: z.array(subjectSchema).max(20).default([]),
  location: z.object({ text: z.string().max(1000).default(''), url: z.string().trim().max(2000).nullable().optional() }).prefault({}),
  issuedAt: dateish.nullable().optional(),
  expiresAt: dateish.nullable().optional(),
  rotationIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  lastRotatedAt: dateish.nullable().optional(),
  reviewIntervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  lastReviewedAt: dateish.nullable().optional(),
  gatus: z
    .object({ platformId: z.string().min(1).max(100), endpointKey: z.string().trim().min(1).max(300) })
    .nullable()
    .optional(),
  reminders: z
    .object({
      daysBefore: z.array(z.number().int().min(0).max(365)).max(10).optional(),
      overdueEveryDays: z.number().int().min(0).max(365).optional(),
      disabled: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  notes: z.string().max(10000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  /** Upload: a public certificate (base64 of PEM/CRT/DER, or PEM text); null removes the stored metadata */
  certificate: z
    .object({ contentBase64: z.string().max(400_000).optional(), pem: z.string().max(300_000).optional() })
    .nullable()
    .optional(),
  /** Optimistic locking on update */
  version: z.number().int().optional(),
});
export type CredentialInput = z.infer<typeof credentialInputSchema>;

/** Links people can click are http(s) only; keepass://, kdbx and file paths are kept as text (shown copyable). */
export function checkLocationUrl(u: string | null | undefined): string | null {
  const v = u?.trim();
  if (!v) return null;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, 'The location link contains control characters', 'LOCATION_INVALID', { context: 'control' });
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v)?.[1]?.toLowerCase();
  // a single letter is a Windows drive (C:\…); no scheme = a path or a database name
  if (scheme && scheme.length > 1 && !['http', 'https', 'keepass', 'kdbx', 'file', 'smb'].includes(scheme)) {
    throw new HttpError(400, `Links with "${scheme}:" are not allowed. Use an http(s) link, a keepass:// link or a file path.`, 'LOCATION_SCHEME', { scheme });
  }
  if (scheme === 'http' || scheme === 'https') {
    try {
      new URL(v);
    } catch {
      throw new HttpError(400, 'The location link is not a valid URL', 'LOCATION_INVALID');
    }
  }
  return v;
}

function secretCheck(b: CredentialInput): void {
  try {
    assertNoSecrets({
      Name: b.name,
      Platform: b.platformText,
      Environment: b.environment,
      Description: b.description,
      'Used by': b.usedBy.text,
      'Owner role': b.owners.map((o) => o.role),
      Location: b.location.text,
      'Location link': b.location.url ?? '',
      Notes: b.notes,
      Tags: b.tags,
      'Gatus endpoint': b.gatus?.endpointKey ?? '',
    });
  } catch (e) {
    if (e instanceof SecretFoundError)
      throw new HttpError(400, e.message, 'SECRET_DETECTED', {
        field: e.field,
        kind: { message: e.kind, code: 'SECRET_KIND', params: { context: e.kindId } },
      });
    throw e;
  }
}

/** A platform the user has a right on (the same answer as for a missing one otherwise); an unchanged link is kept. */
function checkPlatform(id: string | null | undefined, unchanged: string | null): void {
  if (!id || id === unchanged) return;
  const p = db().get<{ acl: string }>('SELECT acl FROM platforms WHERE id = ?', id);
  if (!p || !platformPermissions(currentUser(), { acl: parseJson(p.acl, []) }).length)
    throw new HttpError(400, `Platform ${id} not found`, 'PLATFORM_NOT_FOUND', { id });
}

function checkGatus(g: CredentialInput['gatus']): void {
  if (!g) return;
  const p = db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', g.platformId);
  if (!p || p.kind !== 'gatus') throw new HttpError(400, 'Expiry sync needs a Gatus platform', 'GATUS_PLATFORM_REQUIRED');
  let perms: string[] = [];
  try {
    perms = platforms.getPlatform(g.platformId).permissions;
  } catch {
    /* not visible */
  }
  if (!perms.length) throw new HttpError(400, 'Expiry sync needs a Gatus platform you have access to', 'GATUS_PLATFORM_REQUIRED');
}

// ---------- queries ----------

export function credentialRow(id: string): CredentialRow {
  const r = db().get<CredentialRow>('SELECT * FROM credentials WHERE id = ?', id);
  if (!r) throw new HttpError(404, `Credential ${id} not found`, 'CREDENTIAL_NOT_FOUND', { id });
  return r;
}

/** An entry the current user may see (404 otherwise, so ids cannot be probed). */
export function requireCredential(id: string, perm: CredentialPermission = 'view'): CredentialRow {
  const r = db().get<CredentialRow>('SELECT * FROM credentials WHERE id = ?', id);
  const perms = r ? credentialPermissions(currentUser(), r) : [];
  if (!r || !perms.includes('view')) throw new HttpError(404, `Credential ${id} not found`, 'CREDENTIAL_NOT_FOUND', { id });
  if (!perms.includes(perm)) {
    throw new HttpError(
      403,
      r.archived && perm === 'edit' ? 'Archived entries cannot be changed – restore it first' : `You are not allowed to ${perm} this entry`,
      r.archived && perm === 'edit' ? 'CREDENTIAL_ARCHIVED' : 'FORBIDDEN',
      r.archived && perm === 'edit' ? undefined : { context: 'credential' },
    );
  }
  return r;
}

export interface CredentialFilter {
  q?: string;
  type?: string[];
  platform?: string;
  status?: string[];
  owner?: string;
  tag?: string;
  dueWithinDays?: number;
  archived?: 'exclude' | 'include' | 'only';
}

/** Entries the current user may see, newest due date first, filtered. */
export function listCredentials(f: CredentialFilter = {}, now = Date.now()): Credential[] {
  const u = currentUser();
  const settings = reminderSettings();
  const where: string[] = [];
  const params: unknown[] = [];
  if ((f.archived ?? 'exclude') === 'exclude') where.push('archived = 0');
  else if (f.archived === 'only') where.push('archived = 1');
  if (f.type?.length) {
    where.push(`type IN (${f.type.map(() => '?').join(',')})`);
    params.push(...f.type);
  }
  const rows = db().all<CredentialRow>(`SELECT * FROM credentials ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name, id`, ...params);
  const needle = f.q?.trim().toLowerCase();
  const owner = f.owner?.trim().toLowerCase();
  return rows
    .filter((r) => credentialPermissions(u, r).includes('view'))
    .map((r) => toCredential(r, u, now, settings))
    .filter(
      (c) =>
        !needle ||
        [c.name, c.description, c.platformText, c.platformName ?? '', c.environment, c.location.text, c.usedBy.text, ...c.tags].some((x) =>
          x.toLowerCase().includes(needle),
        ),
    )
    .filter(
      (c) =>
        !f.platform ||
        c.platformId === f.platform ||
        c.platformText.toLowerCase() === f.platform.toLowerCase() ||
        (c.platformName ?? '').toLowerCase() === f.platform.toLowerCase(),
    )
    .filter((c) => !f.status?.length || f.status.includes(c.status))
    .filter((c) => !owner || c.owners.some((o) => o.email.includes(owner)) || c.ownerSubjects.some((s) => s.includes(owner)))
    .filter((c) => !f.tag || c.tags.includes(f.tag))
    .filter((c) => f.dueWithinDays === undefined || (!!c.nextDueAt && Date.parse(c.nextDueAt) <= now + f.dueWithinDays * DAY));
}

/**
 * Entries the current user may see that name an item under "used by" (for
 * backlinks on the item's page). Entries the user may not see are left out.
 */
export function credentialsLinkingTo(kind: string, id: string): CredentialRow[] {
  const u = currentUser();
  if (!u) return [];
  return db()
    .all<CredentialRow>("SELECT * FROM credentials WHERE lower(used_by) LIKE ? ESCAPE '\\' ORDER BY name, id", `%${likeEscape(id.toLowerCase())}%`)
    .filter((r) => parseJson<{ links?: CredentialLink[] }>(r.used_by, {}).links?.some((l) => l.kind === kind && l.id === id))
    .filter((r) => credentialPermissions(u, r).includes('view'));
}

export function getCredential(id: string): Credential {
  return toCredential(requireCredential(id));
}

export function credentialHistory(id: string): CredentialEvent[] {
  requireCredential(id);
  return db()
    .all<{ id: number; ts: string; actor: string; kind: CredentialEventKind; comment: string; details: string }>(
      'SELECT * FROM credential_events WHERE credential_id = ? ORDER BY id DESC LIMIT 500',
      id,
    )
    .map((e) => ({ id: Number(e.id), ts: e.ts, actor: e.actor, kind: e.kind, comment: e.comment, details: parseJson(e.details, {}) }));
}

export function addEvent(
  credentialId: string,
  kind: CredentialEventKind,
  actor: string,
  comment = '',
  details: Record<string, unknown> = {},
  ts = nowIso(),
): void {
  db().run(
    'INSERT INTO credential_events (credential_id, ts, actor, kind, comment, details) VALUES (?, ?, ?, ?, ?, ?)',
    credentialId,
    ts,
    actor,
    kind,
    comment.slice(0, 2000),
    JSON.stringify(details),
  );
}

// ---------- changes ----------

const me = (): AuthUser => {
  const u = currentUser();
  if (!u) throw new HttpError(401, 'Please sign in', 'NOT_SIGNED_IN');
  return u;
};

const COLUMNS: Record<string, (b: CredentialInput) => unknown> = {
  name: (b) => b.name,
  type: (b) => b.type,
  platform_id: (b) => b.platformId || null,
  platform_text: (b) => b.platformText,
  environment: (b) => b.environment,
  description: (b) => b.description,
  used_by: (b) => JSON.stringify({ text: b.usedBy.text, links: b.usedBy.links }),
  owners: (b) => JSON.stringify(b.owners),
  owner_subjects: (b) => JSON.stringify([...new Set(b.ownerSubjects)]),
  location_text: (b) => b.location.text,
  location_url: (b) => checkLocationUrl(b.location.url),
  issued_at: (b) => b.issuedAt ?? null,
  expires_at: (b) => b.expiresAt ?? null,
  rotation_interval_days: (b) => b.rotationIntervalDays ?? null,
  last_rotated_at: (b) => b.lastRotatedAt ?? null,
  review_interval_days: (b) => b.reviewIntervalDays ?? null,
  last_reviewed_at: (b) => b.lastReviewedAt ?? null,
  gatus_platform_id: (b) => b.gatus?.platformId ?? null,
  gatus_endpoint_key: (b) => b.gatus?.endpointKey ?? null,
  reminders: (b) =>
    b.reminders ? JSON.stringify({ ...b.reminders, ...(b.reminders.daysBefore ? { daysBefore: normDays(b.reminders.daysBefore) } : {}) }) : null,
  notes: (b) => b.notes,
  tags: (b) => JSON.stringify([...new Set(b.tags)]),
};

const emailsOf = (owners: { email: string }[]): string[] => [...new Set(owners.map((o) => o.email.trim().toLowerCase()))].sort();

/** Validates an input (`before`: the stored entry on update) and maps it to columns. */
function prepare(b: CredentialInput, before?: CredentialRow): { values: Record<string, unknown>; certificate: CertificateInfo | null | undefined } {
  secretCheck(b);
  checkPlatform(b.platformId, before?.platform_id ?? null);
  // new owner addresses must have an allowed domain (stored ones stay; notify() checks them again on every send)
  const stored = new Set(before ? emailsOf(parseJson(before.owners, [])) : []);
  assertEmailsAllowed(emailsOf(b.owners).filter((e) => !stored.has(e)));
  checkGatus(b.gatus);
  const values = Object.fromEntries(Object.entries(COLUMNS).map(([col, fn]) => [col, fn(b)]));
  let certificate: CertificateInfo | null | undefined;
  if (b.certificate === null) certificate = null;
  else if (b.certificate) {
    certificate = parseCertificate(certificateBytes(b.certificate));
    // the certificate's validity wins unless an explicit expiry was entered together with it
    if (!b.expiresAt) values.expires_at = certificate.chainNotAfter;
    if (!b.issuedAt) values.issued_at = certificate.notBefore;
  }
  return { values, certificate };
}

export function createCredential(b: CredentialInput): Credential {
  const u = me();
  if (!canCreateCredentials(u))
    throw new HttpError(403, 'You are not allowed to add entries to the credentials register', 'FORBIDDEN', { context: 'createCredential' });
  const { values, certificate } = prepare(b);
  const id = newId('cred_');
  const now = nowIso();
  const row = {
    ...values,
    id,
    certificate: certificate ? JSON.stringify(certificate) : null,
    archived: 0,
    version: 1,
    created_at: now,
    created_by: u.username,
    updated_at: now,
    updated_by: u.username,
  };
  const cols = Object.keys(row);
  db().tx(() => {
    db().run(
      `INSERT INTO credentials (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...cols.map((c) => (row as Record<string, unknown>)[c]),
    );
    addEvent(id, 'created', u.username, '', { type: b.type, expiresAt: values.expires_at ?? null });
    if (certificate)
      addEvent(id, 'certificate', u.username, '', { fingerprint256: certificate.fingerprint256, notAfter: certificate.notAfter, subject: certificate.subject });
    audit({
      action: 'credential.created',
      entityType: 'credential',
      entityId: id,
      summary: `Credential register: "${b.name}" (${b.type}) added`,
      details: auditView(values, certificate),
    });
  });
  return toCredential(credentialRow(id), u);
}

/** What the audit log records of an entry (all of it is documentation, none of it secret). */
function auditView(values: Record<string, unknown>, certificate?: CertificateInfo | null): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  if (certificate !== undefined)
    out.certificate = certificate ? { fingerprint256: certificate.fingerprint256, subject: certificate.subject, notAfter: certificate.notAfter } : null;
  return out;
}

export function updateCredential(id: string, b: CredentialInput): Credential {
  const u = me();
  const before = requireCredential(id, 'edit');
  if (b.version !== undefined && b.version !== before.version)
    throw new HttpError(409, 'The entry was changed by someone else meanwhile – reload it and try again', 'VERSION_CONFLICT');
  const { values, certificate } = prepare(b, before);
  if (!u.roles.some((x) => EDIT_ROLES.includes(x))) {
    // owners (not editor roles) may not remove themselves from the owner list – they would lock themselves out
    if (!isOwner(u, { owner_subjects: String(values.owner_subjects) }))
      throw new HttpError(400, 'You edit this entry as one of its owners: keep yourself (or your team) in the owner list', 'OWNER_REQUIRED', {
        context: 'credential',
      });
    // … nor change who gets its reminders by e-mail
    if (emailsOf(parseJson(before.owners, [])).join('\n') !== emailsOf(b.owners).join('\n'))
      throw new HttpError(
        403,
        'You edit this entry as one of its owners: only designers, operators and administrators can change the owner e-mail addresses',
        'FORBIDDEN',
        { context: 'credentialOwnerEmails' },
      );
  }
  if (certificate !== undefined) values.certificate = certificate ? JSON.stringify(certificate) : null;
  const changed = Object.keys(values).filter((k) => String((before as unknown as Record<string, unknown>)[k] ?? '') !== String(values[k] ?? ''));
  if (!changed.length) return toCredential(before, u);
  const now = nowIso();
  db().tx(() => {
    const r = db().run(
      `UPDATE credentials SET ${changed.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`,
      ...changed.map((c) => values[c]),
      now,
      u.username,
      id,
      before.version,
    );
    if (!r.changes) throw new HttpError(409, 'The entry was changed by someone else meanwhile – reload it and try again', 'VERSION_CONFLICT');
    addEvent(id, 'updated', u.username, '', { fields: changed });
    if (certificate)
      addEvent(id, 'certificate', u.username, '', { fingerprint256: certificate.fingerprint256, notAfter: certificate.notAfter, subject: certificate.subject });
    audit({
      action: 'credential.updated',
      entityType: 'credential',
      entityId: id,
      summary: `Credential register: "${b.name}" changed (${changed.join(', ')})`,
      details: {
        changes: Object.fromEntries(
          changed.map((c) => [
            c,
            c === 'certificate'
              ? auditView({}, certificate).certificate
              : { from: (before as unknown as Record<string, unknown>)[c] ?? null, to: values[c] ?? null },
          ]),
        ),
      },
    });
  });
  return toCredential(credentialRow(id), u);
}

export const rotatedSchema = z.object({
  rotatedAt: dateish.optional(),
  comment: z.string().max(2000).default(''),
  /** New expiry date of the rotated credential */
  expiresAt: dateish.nullable().optional(),
  certificate: z.object({ contentBase64: z.string().max(400_000).optional(), pem: z.string().max(300_000).optional() }).optional(),
});

export function markRotated(id: string, b: z.infer<typeof rotatedSchema>): Credential {
  const u = me();
  const r = requireCredential(id, 'edit');
  assertCommentSafe(b.comment);
  const at = b.rotatedAt ?? nowIso();
  if (Date.parse(at) > Date.now() + DAY) throw new HttpError(400, 'The rotation date cannot be in the future', 'DATE_IN_FUTURE', { context: 'rotation' });
  const certificate = b.certificate ? parseCertificate(certificateBytes(b.certificate)) : undefined;
  const expires = b.expiresAt !== undefined ? b.expiresAt : certificate ? certificate.chainNotAfter : r.expires_at;
  db().tx(() => {
    db().run(
      `UPDATE credentials SET last_rotated_at = ?, expires_at = ?, certificate = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?`,
      at,
      expires,
      certificate ? JSON.stringify(certificate) : r.certificate,
      nowIso(),
      u.username,
      id,
    );
    addEvent(id, 'rotated', u.username, b.comment, {
      rotatedAt: at,
      expiresAt: { from: r.expires_at, to: expires },
      ...(certificate ? { fingerprint256: certificate.fingerprint256 } : {}),
    });
    audit({
      action: 'credential.rotated',
      entityType: 'credential',
      entityId: id,
      summary: `Credential register: "${r.name}" rotated on ${at.slice(0, 10)}${expires !== r.expires_at ? `, expires ${expires ? expires.slice(0, 10) : 'never'}` : ''}`,
      details: {
        rotatedAt: at,
        comment: b.comment || undefined,
        expiresAt: { from: r.expires_at, to: expires },
        ...(certificate ? { fingerprint256: certificate.fingerprint256 } : {}),
      },
    });
  });
  return toCredential(credentialRow(id), u);
}

export const reviewedSchema = z.object({ reviewedAt: dateish.optional(), comment: z.string().max(2000).default('') });

export function markReviewed(id: string, b: z.infer<typeof reviewedSchema>): Credential {
  const u = me();
  const r = requireCredential(id, 'edit');
  assertCommentSafe(b.comment);
  const at = b.reviewedAt ?? nowIso();
  if (Date.parse(at) > Date.now() + DAY) throw new HttpError(400, 'The review date cannot be in the future', 'DATE_IN_FUTURE', { context: 'review' });
  db().tx(() => {
    db().run('UPDATE credentials SET last_reviewed_at = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?', at, nowIso(), u.username, id);
    addEvent(id, 'reviewed', u.username, b.comment, { reviewedAt: at });
    audit({
      action: 'credential.reviewed',
      entityType: 'credential',
      entityId: id,
      summary: `Credential register: "${r.name}" reviewed on ${at.slice(0, 10)}`,
      details: { reviewedAt: at, comment: b.comment || undefined },
    });
  });
  return toCredential(credentialRow(id), u);
}

function assertCommentSafe(comment: string): void {
  try {
    assertNoSecrets({ Comment: comment });
  } catch (e) {
    if (e instanceof SecretFoundError)
      throw new HttpError(400, e.message, 'SECRET_DETECTED', {
        field: e.field,
        kind: { message: e.kind, code: 'SECRET_KIND', params: { context: e.kindId } },
      });
    throw e;
  }
}

export function setArchived(id: string, archived: boolean): Credential {
  const u = me();
  const r = requireCredential(id, 'archive');
  if (!!r.archived === archived) return toCredential(r, u);
  db().tx(() => {
    db().run(
      'UPDATE credentials SET archived = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?',
      archived ? 1 : 0,
      nowIso(),
      u.username,
      id,
    );
    addEvent(id, archived ? 'archived' : 'restored', u.username);
    audit({
      action: archived ? 'credential.archived' : 'credential.restored',
      entityType: 'credential',
      entityId: id,
      summary: `Credential register: "${r.name}" ${archived ? 'archived' : 'restored'}`,
    });
  });
  return toCredential(credentialRow(id), u);
}

export function deleteCredential(id: string): void {
  const r = requireCredential(id, 'delete');
  db().tx(() => {
    for (const t of ['credential_events', 'credential_reminders']) db().run(`DELETE FROM ${t} WHERE credential_id = ?`, id);
    db().run('DELETE FROM credentials WHERE id = ?', id);
    audit({
      action: 'credential.deleted',
      entityType: 'credential',
      entityId: id,
      summary: `Credential register: "${r.name}" deleted`,
      details: { name: r.name, type: r.type },
    });
  });
}

// ---------- Gatus expiry sync ----------

/** Certificate expiry from Gatus metrics: update "expires at" when it moved by more than 12 hours (a renewed certificate). */
export function syncExpiryFromGatus(platformId: string, expiries: Map<string, string>): number {
  const rows = db().all<CredentialRow>('SELECT * FROM credentials WHERE gatus_platform_id = ? AND archived = 0', platformId);
  let n = 0;
  for (const r of rows) {
    const next = r.gatus_endpoint_key ? expiries.get(r.gatus_endpoint_key) : undefined;
    if (!next) continue;
    if (r.expires_at && Math.abs(Date.parse(r.expires_at) - Date.parse(next)) <= 12 * 3600000) continue;
    db().tx(() => {
      db().run('UPDATE credentials SET expires_at = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?', next, nowIso(), 'system', r.id);
      addEvent(r.id, 'expirySynced', 'system', '', { from: r.expires_at, to: next, endpointKey: r.gatus_endpoint_key });
      audit({
        actor: 'system',
        action: 'credential.expiry_synced',
        entityType: 'credential',
        entityId: r.id,
        summary: `Credential register: "${r.name}" expires ${next.slice(0, 10)} (was ${r.expires_at ? r.expires_at.slice(0, 10) : 'not set'}) – from the Gatus certificate metric of ${r.gatus_endpoint_key}`,
        details: { from: r.expires_at, to: next, platformId, endpointKey: r.gatus_endpoint_key },
      });
    });
    n++;
  }
  return n;
}
setCertificateExpiryHook((platformId, expiries) => void syncExpiryFromGatus(platformId, expiries));

// ---------- CSV ----------

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  // formula injection: a leading =, +, -, @ (or tab/CR) would be evaluated by spreadsheet programs
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function credentialsCsv(list: Credential[]): string {
  const head = [
    'id',
    'name',
    'type',
    'platform',
    'environment',
    'status',
    'expires_at',
    'next_rotation_at',
    'next_review_at',
    'rotation_interval_days',
    'last_rotated_at',
    'review_interval_days',
    'last_reviewed_at',
    'owners',
    'owner_users_teams',
    'used_by',
    'location',
    'location_link',
    'certificate_fingerprint_sha256',
    'tags',
    'archived',
    'updated_at',
    'updated_by',
  ];
  const lines = list.map((c) =>
    [
      c.id,
      c.name,
      c.type,
      c.platformName ?? c.platformText,
      c.environment,
      c.status,
      c.expiresAt,
      c.nextRotationAt,
      c.nextReviewAt,
      c.rotationIntervalDays,
      c.lastRotatedAt,
      c.reviewIntervalDays,
      c.lastReviewedAt,
      c.owners.map((o) => (o.role ? `${o.email} (${o.role})` : o.email)),
      c.ownerSubjects,
      [c.usedBy.text, ...c.usedBy.links.map((l) => `${l.kind}:${l.label ?? l.id}`)].filter(Boolean),
      c.location.text,
      c.location.url,
      c.certificate?.fingerprint256,
      c.tags,
      c.archived ? 'yes' : 'no',
      c.updatedAt,
      c.updatedBy,
    ]
      .map(csvCell)
      .join(','),
  );
  return '\ufeff' + [head.join(','), ...lines].join('\r\n') + '\r\n';
}

/** Small summary for the home page widget. */
export function dueSummary(now = Date.now()): { overdue: number; expired: number; dueSoon: number; items: Credential[] } {
  const list = listCredentials({}, now).filter((c) => c.status !== 'ok');
  const order = { expired: 0, overdue: 1, dueSoon: 2, ok: 3 } as const;
  list.sort((a, b) => order[a.status] - order[b.status] || (a.nextDueAt ?? '').localeCompare(b.nextDueAt ?? ''));
  return {
    expired: list.filter((c) => c.status === 'expired').length,
    overdue: list.filter((c) => c.status === 'overdue').length,
    dueSoon: list.filter((c) => c.status === 'dueSoon').length,
    items: list.slice(0, 8),
  };
}

/**
 * The start page's "Credentials due" tile: entries the current user may see. null for a user who reads
 * only the entries they own and owns none (viewers), so they get no tile.
 */
export function dueAttention(now = Date.now()): { expired: number; overdue: number; dueSoon: number } | null {
  const u = currentUser();
  const list = listCredentials({}, now);
  if (!list.length && !(u && u.roles.some((x) => READ_ROLES.includes(x)))) return null;
  const n = (s: CredentialStatus) => list.filter((c) => c.status === s).length;
  return { expired: n('expired'), overdue: n('overdue'), dueSoon: n('dueSoon') };
}

import { z } from 'zod';
import {
  COMPONENT_LIMITS,
  SYSTEM_KINDS,
  SYSTEM_LIMITS,
  type AclEntry,
  type ApplicationSystemLink,
  type PlatformPermission,
  type SbomFormat,
  type SbomPreview,
  type StackEntry,
  type SystemApplicationRef,
  type SystemDetail,
  type SystemKind,
  type SystemSummary,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { platformPermissions } from '../auth/permissions.js';
import { canCreateServices, canEditService, forbid, me } from '../records/access.js';
import { httpUrl } from '../records/links.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import {
  applySbomChanges,
  matchSbom,
  planSbom,
  readSbom,
  requireKnownProducts,
  stackSummary,
  systemHolder,
  toEntry,
  writeStack,
  type SbomInput,
  type StackRow,
} from './components.js';
import { lifecycleSettings, releasesOf } from './lifecycle.js';
import { byEnvironment, environmentValue } from './environments.js';
import { credentialsBelongingTo, toCredential } from '../credentials/service.js';

/**
 * Systems (#129): servers, VMs, clusters, appliances and cloud services that applications run on – often several
 * applications on one system. A system has its own tech stack (the operating system and runtimes live on it once)
 * and an optional link to the Steward platform it is. Applications run on systems in an environment ("runs on").
 *
 * Permissions like applications: everyone who can sign in reads; designers and administrators create systems; they
 * and the owners change them. Whoever may edit an application links it to a system.
 */

interface SystemRow {
  id: string;
  name: string;
  kind: string;
  vendor: string;
  cmdb_url: string;
  owners: string;
  note: string;
  platform_id: string | null;
  sbom_format: string | null;
  sbom_name: string | null;
  sbom_imported_at: string | null;
  sbom_imported_by: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface LinkRow {
  id: string;
  application_id: string;
  system_id: string;
  environment: string;
  note: string;
  created_at: string;
  created_by: string;
}

const ownerSubject = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(user|team):[^\s].{0,119}$/, 'Use user:<name> or team:<name>');

const stackEntryInput = z
  .object({
    product: z.string().trim().min(1).max(100),
    version: z.string().trim().max(COMPONENT_LIMITS.version).default(''),
  })
  .strict();

export const systemInput = z
  .object({
    name: z.string().trim().min(1).max(SYSTEM_LIMITS.name),
    kind: z.enum(SYSTEM_KINDS),
    vendor: z.string().trim().max(SYSTEM_LIMITS.vendor).default(''),
    cmdbUrl: z.union([httpUrl, z.literal('')]).default(''),
    owners: z.array(ownerSubject).max(20).default([]),
    note: z.string().max(SYSTEM_LIMITS.note).default(''),
    /** The Steward platform this system is (the reader must see it); missing: unchanged (none for a new system) */
    platformId: z.string().trim().min(1).max(200).nullable().optional(),
    /** The whole stack (missing: unchanged), like a component's */
    stack: z.array(stackEntryInput).max(COMPONENT_LIMITS.stackPerComponent).optional(),
  })
  .strict();
export type SystemInput = z.infer<typeof systemInput>;

export const systemLinkInput = z
  .object({
    systemId: z.string().trim().min(1).max(100),
    environment: environmentValue.default(''),
    note: z.string().trim().max(SYSTEM_LIMITS.linkNote).default(''),
  })
  .strict();
export const systemLinkUpdate = systemLinkInput.omit({ systemId: true });

// ---------- reading ----------

const ownersOf = (r: Pick<SystemRow, 'owners'>) => parseJson<string[]>(r.owners, []);
export const canEditSystem = (u: AuthUser | null, r: Pick<SystemRow, 'owners'>): boolean => canEditService(u, ownersOf(r));

function row(id: string): SystemRow {
  const r = db().get<SystemRow>('SELECT * FROM systems WHERE id = ?', id);
  if (!r) throw new HttpError(404, `System ${id} not found`, 'SYSTEM_NOT_FOUND', { id });
  return r;
}

type PlatformRow = { id: string; name: string; environment: string; acl: string };
const platformVisible = (u: AuthUser | null, p: Pick<PlatformRow, 'acl'>) =>
  platformPermissions(u, { acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).length > 0;

function platformsById(): Map<string, PlatformRow> {
  return new Map(
    db()
      .all<PlatformRow>('SELECT id, name, environment, acl FROM platforms')
      .map((p) => [p.id, p]),
  );
}

/** The stacks of all systems (or these), by system. */
function stacksOf(ids?: string[]): Map<string, StackEntry[]> {
  const rows = db()
    .all<StackRow>('SELECT * FROM system_stack ORDER BY product')
    .filter((r) => !ids || ids.includes(r.system_id!));
  const releases = releasesOf([...new Set(rows.map((r) => r.product))]);
  const { warnDays } = lifecycleSettings();
  const out = new Map<string, StackEntry[]>();
  for (const r of rows) out.set(r.system_id!, [...(out.get(r.system_id!) ?? []), toEntry(r, releases, warnDays)]);
  return out;
}

function toSummary(r: SystemRow, x: { stack: StackEntry[]; links: LinkRow[]; platforms: Map<string, PlatformRow>; u: AuthUser | null }): SystemSummary {
  const p = r.platform_id ? x.platforms.get(r.platform_id) : undefined;
  const visible = !!p && platformVisible(x.u, p);
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as SystemKind,
    vendor: r.vendor,
    cmdbUrl: r.cmdb_url,
    owners: ownersOf(r),
    note: r.note,
    platform: p && visible ? { id: p.id, name: p.name, environment: p.environment } : null,
    platformHidden: !!p && !visible,
    applicationCount: new Set(x.links.map((l) => l.application_id)).size,
    environments: byEnvironment([...new Set(x.links.map((l) => l.environment))], (e) => e),
    eol: x.stack.filter((s) => s.lifecycle?.state === 'eol').length,
    ending: x.stack.filter((s) => s.lifecycle?.state === 'ending').length,
    updatedAt: r.updated_at,
  };
}

function linksBySystem(): Map<string, LinkRow[]> {
  const out = new Map<string, LinkRow[]>();
  for (const l of db().all<LinkRow>('SELECT * FROM application_systems')) out.set(l.system_id, [...(out.get(l.system_id) ?? []), l]);
  return out;
}

const sbomOf = (r: SystemRow): SystemDetail['sbom'] =>
  r.sbom_format && r.sbom_imported_at
    ? { format: r.sbom_format as SbomFormat, name: r.sbom_name ?? '', importedAt: r.sbom_imported_at, importedBy: r.sbom_imported_by ?? '' }
    : null;

/** A system with its stack, SBOM, creation and applications (the public API's list and the detail page). */
export type SystemEntry = Omit<SystemDetail, 'canEdit' | 'credentials'>;

type AppRef = { id: string; name: string; archived: number };
const appsById = () =>
  new Map(
    db()
      .all<AppRef>('SELECT id, name, archived FROM applications')
      .map((a) => [a.id, a]),
  );

function toEntryOf(
  r: SystemRow,
  stack: StackEntry[],
  links: LinkRow[],
  ctx: { platforms: Map<string, PlatformRow>; apps: Map<string, AppRef>; u: AuthUser | null },
): SystemEntry {
  const { platforms, apps, u } = ctx;
  const applications: SystemApplicationRef[] = byEnvironment(
    links.map((l) => ({
      linkId: l.id,
      applicationId: l.application_id,
      applicationName: apps.get(l.application_id)?.name ?? l.application_id,
      archived: !!apps.get(l.application_id)?.archived,
      environment: l.environment,
      note: l.note,
    })),
    (l) => l.environment,
    (a, b) => a.applicationName.localeCompare(b.applicationName),
  );
  return {
    ...toSummary(r, { stack, links, platforms, u }),
    stack,
    sbom: sbomOf(r),
    applications,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
  };
}

export function listSystemEntries(): SystemEntry[] {
  const u = me();
  const stacks = stacksOf();
  const links = linksBySystem();
  const ctx = { platforms: platformsById(), apps: appsById(), u };
  return db()
    .all<SystemRow>('SELECT * FROM systems ORDER BY name')
    .map((r) => toEntryOf(r, stacks.get(r.id) ?? [], links.get(r.id) ?? [], ctx));
}

export function listSystems(): SystemSummary[] {
  const u = me();
  const stacks = stacksOf();
  const links = linksBySystem();
  const platforms = platformsById();
  return db()
    .all<SystemRow>('SELECT * FROM systems ORDER BY name')
    .map((r) => toSummary(r, { stack: stacks.get(r.id) ?? [], links: links.get(r.id) ?? [], platforms, u }));
}

/** The credentials register entries that belong to a system (#143), archived ones left out. */
function systemCredentials(id: string, u: AuthUser): SystemDetail['credentials'] {
  return credentialsBelongingTo('system', [id])
    .filter((r) => !r.archived)
    .map((r) => toCredential(r, u))
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      nextDueAt: c.nextDueAt,
      roles: c.roles.map((x) => x.role),
      relation: 'belongsTo' as const,
      componentName: null,
    }));
}

export function getSystem(id: string): SystemDetail {
  const u = me();
  const r = row(id);
  const links = db().all<LinkRow>('SELECT * FROM application_systems WHERE system_id = ?', id);
  return {
    ...toEntryOf(r, stacksOf([id]).get(id) ?? [], links, { platforms: platformsById(), apps: appsById(), u }),
    credentials: systemCredentials(id, u),
    canEdit: canEditSystem(u, r),
  };
}

/** The systems an application runs on, with their stacks, in environment order. */
export function systemLinksOf(appId: string): ApplicationSystemLink[] {
  const rows = db().all<LinkRow & { name: string; kind: string; vendor: string }>(
    `SELECT l.*, s.name, s.kind, s.vendor FROM application_systems l JOIN systems s ON s.id = l.system_id WHERE l.application_id = ?`,
    appId,
  );
  const stacks = stacksOf([...new Set(rows.map((r) => r.system_id))]);
  return byEnvironment(
    rows.map((r) => ({
      id: r.id,
      systemId: r.system_id,
      name: r.name,
      kind: r.kind as SystemKind,
      vendor: r.vendor,
      environment: r.environment,
      note: r.note,
      stack: stacks.get(r.system_id) ?? [],
      createdAt: r.created_at,
      createdBy: r.created_by,
    })),
    (l) => l.environment,
    (a, b) => a.name.localeCompare(b.name),
  );
}

/** Number of "runs on" links per application. */
export function systemCounts(): Map<string, number> {
  return new Map(
    db()
      .all<{ id: string; n: number }>('SELECT application_id AS id, COUNT(*) AS n FROM application_systems GROUP BY application_id')
      .map((c) => [c.id, Number(c.n)]),
  );
}

// ---------- changing ----------

function requireEditable(id: string, what: string): SystemRow {
  const r = row(id);
  if (!canEditSystem(currentUser(), r)) forbid(what, 'changeSystem');
  return r;
}

function nameTaken(name: string, except = ''): boolean {
  return !!db().get('SELECT 1 FROM systems WHERE lower(name) = lower(?) AND id <> ?', name, except);
}

/** The platform must exist and be visible to the user (else it reads as not found). */
function checkPlatform(platformId: string | null, u: AuthUser): void {
  if (!platformId) return;
  const p = db().get<PlatformRow>('SELECT id, name, environment, acl FROM platforms WHERE id = ?', platformId);
  if (!p || !platformVisible(u, p)) throw new HttpError(404, `Platform ${platformId} not found`, 'PLATFORM_NOT_FOUND', { id: platformId });
}

export function createSystem(input: SystemInput): SystemDetail {
  const u = me();
  if (!canCreateServices(u)) forbid('create systems', 'createSystem');
  if (nameTaken(input.name)) throw new HttpError(409, `A system "${input.name}" exists already`, 'SYSTEM_EXISTS', { name: input.name });
  const platformId = input.platformId ?? null;
  checkPlatform(platformId, u);
  if (input.stack) requireKnownProducts(input.stack);
  const id = newId('sys_');
  const now = nowIso();
  const owners = [...new Set(input.owners)];
  db().tx(() => {
    db().run(
      `INSERT INTO systems (id, name, kind, vendor, cmdb_url, owners, note, platform_id, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.kind,
      input.vendor,
      input.cmdbUrl,
      JSON.stringify(owners),
      input.note,
      platformId,
      now,
      u.username,
      now,
      u.username,
    );
    const diff = input.stack ? writeStack(systemHolder(id), input.stack, u) : null;
    audit({
      action: 'system.created',
      entityType: 'system',
      entityId: id,
      summary: `System "${input.name}" (${input.kind}) created${diff?.added.length ? ` (stack: ${stackSummary(diff)})` : ''}`,
      details: { name: input.name, kind: input.kind, vendor: input.vendor, owners, platformId, stack: diff?.added ?? [] },
    });
  });
  return getSystem(id);
}

export function updateSystem(id: string, input: SystemInput): SystemDetail {
  const u = me();
  const cur = requireEditable(id, 'change this system');
  if (nameTaken(input.name, id)) throw new HttpError(409, `A system "${input.name}" exists already`, 'SYSTEM_EXISTS', { name: input.name });
  // keeping a platform the user cannot see is fine (missing: unchanged); choosing one needs to see it
  const platformId = input.platformId === undefined ? cur.platform_id : input.platformId;
  if (platformId !== cur.platform_id) checkPlatform(platformId, u);
  if (input.stack) requireKnownProducts(input.stack);
  const owners = [...new Set(input.owners)];
  const next = {
    name: input.name,
    kind: input.kind,
    vendor: input.vendor,
    cmdb_url: input.cmdbUrl,
    owners: JSON.stringify(owners),
    note: input.note,
    platform_id: platformId,
  };
  const fields = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== cur[k]);
  db().tx(() => {
    const diff = input.stack ? writeStack(systemHolder(id), input.stack, u) : { added: [], changed: [], removed: [] };
    const stackChanged = diff.added.length + diff.changed.length + diff.removed.length > 0;
    if (!fields.length && !stackChanged) return;
    db().run(
      'UPDATE systems SET name = ?, kind = ?, vendor = ?, cmdb_url = ?, owners = ?, note = ?, platform_id = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      next.name,
      next.kind,
      next.vendor,
      next.cmdb_url,
      next.owners,
      next.note,
      next.platform_id,
      nowIso(),
      u.username,
      id,
    );
    audit({
      action: 'system.changed',
      entityType: 'system',
      entityId: id,
      summary: `System "${input.name}" changed (${[...fields.map((f) => (f === 'cmdb_url' ? 'cmdbUrl' : f === 'platform_id' ? 'platform' : f)), ...(stackChanged ? [`stack: ${stackSummary(diff)}`] : [])].join(', ')})`,
      details: {
        changes: fields,
        ...(fields.includes('name') ? { name: { old: cur.name, new: input.name } } : {}),
        ...(fields.includes('owners') ? { owners: { old: ownersOf(cur), new: owners } } : {}),
        ...(fields.includes('platform_id') ? { platformId: { old: cur.platform_id, new: platformId } } : {}),
        ...(stackChanged ? { stack: diff } : {}),
      },
    });
  });
  return getSystem(id);
}

/** Deletes a system that no application runs on any more (remove the "runs on" links first). */
export function deleteSystem(id: string): void {
  me();
  const cur = requireEditable(id, 'delete this system');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM application_systems WHERE system_id = ?', id)?.n ?? 0);
  if (n) throw new HttpError(409, `Applications still run on "${cur.name}" (${n})`, 'SYSTEM_IN_USE', { name: cur.name, count: n });
  // credentials keep what they belong to: move or archive them first (#143)
  const creds = Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM credentials WHERE belongs_kind = 'system' AND belongs_id = ?", id)?.n ?? 0);
  if (creds)
    throw new HttpError(409, `Credentials register entries belong to "${cur.name}" (${creds})`, 'SYSTEM_HAS_CREDENTIALS', { name: cur.name, count: creds });
  const stack = db().all<StackRow>('SELECT * FROM system_stack WHERE system_id = ?', id);
  db().tx(() => {
    db().run('DELETE FROM system_stack WHERE system_id = ?', id);
    db().run('DELETE FROM systems WHERE id = ?', id);
    audit({
      action: 'system.deleted',
      entityType: 'system',
      entityId: id,
      summary: `System "${cur.name}" deleted`,
      details: { name: cur.name, kind: cur.kind, stack: stack.map((s) => ({ product: s.product, version: s.version, source: s.source })) },
    });
  });
}

export async function previewSystemSbom(id: string, input: SbomInput): Promise<SbomPreview> {
  requireEditable(id, 'change this system');
  const sbom = await readSbom(input);
  const found = matchSbom(sbom.items);
  return { format: sbom.format, name: sbom.name, total: sbom.items.length, matched: found.size, changes: planSbom(systemHolder(id), found) };
}

export async function importSystemSbom(id: string, input: SbomInput): Promise<{ system: SystemDetail; preview: SbomPreview }> {
  // before anything is fetched: only those who may change the system make the server fetch a URL
  requireEditable(id, 'change this system');
  const sbom = await readSbom(input);
  // checked again after the (slow) fetch
  const u = me();
  const cur = requireEditable(id, 'change this system');
  const found = matchSbom(sbom.items);
  const changes = planSbom(systemHolder(id), found);
  const now = nowIso();
  db().tx(() => {
    applySbomChanges(systemHolder(id), changes, u, now);
    db().run(
      'UPDATE systems SET sbom_format = ?, sbom_name = ?, sbom_imported_at = ?, sbom_imported_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      sbom.format,
      sbom.name.slice(0, 200),
      now,
      u.username,
      now,
      u.username,
      id,
    );
    const counted = (k: string) => changes.filter((c) => c.action === k).length;
    audit({
      action: 'system.sbom_imported',
      entityType: 'system',
      entityId: id,
      summary:
        `SBOM (${sbom.format === 'cyclonedx' ? 'CycloneDX' : 'SPDX'}) imported into system "${cur.name}": ` +
        `${counted('add')} added, ${counted('update')} changed, ${counted('remove')} removed, ${counted('manual')} kept as entered by hand`,
      details: {
        format: sbom.format,
        name: sbom.name,
        ...(input.url ? { url: input.url } : {}),
        total: sbom.items.length,
        matched: found.size,
        changes: changes.filter((c) => c.action !== 'keep').map((c) => ({ action: c.action, product: c.product, version: c.version, other: c.other })),
      },
    });
  });
  return { system: getSystem(id), preview: { format: sbom.format, name: sbom.name, total: sbom.items.length, matched: found.size, changes } };
}

// ---------- runs on (application ↔ system) ----------

type AppRow = { id: string; name: string; owners: string; archived: number };
type CanEditApp = (u: AuthUser | null, r: Pick<AppRow, 'owners'>) => boolean;

function editableApp(appId: string, canEdit: CanEditApp): AppRow {
  const a = db().get<AppRow>('SELECT id, name, owners, archived FROM applications WHERE id = ?', appId);
  if (!a) throw new HttpError(404, `Application ${appId} not found`, 'APPLICATION_NOT_FOUND', { id: appId });
  if (!canEdit(currentUser(), a)) forbid('change the systems of this application', 'changeApplication');
  if (a.archived) throw new HttpError(409, `Application "${a.name}" is archived`, 'APPLICATION_ARCHIVED', { name: a.name });
  return a;
}

function linkRow(appId: string, linkId: string): LinkRow {
  const l = db().get<LinkRow>('SELECT * FROM application_systems WHERE id = ? AND application_id = ?', linkId, appId);
  if (!l) throw new HttpError(404, 'The application does not run on this system', 'SYSTEM_LINK_NOT_FOUND', { id: linkId });
  return l;
}

const linkExists = (appId: string, systemId: string, environment: string, except = '') =>
  !!db().get(
    'SELECT 1 FROM application_systems WHERE application_id = ? AND system_id = ? AND environment = ? AND id <> ?',
    appId,
    systemId,
    environment,
    except,
  );

const touchApplication = (id: string, u: AuthUser) => db().run('UPDATE applications SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, id);

const envText = (e: string) => e || 'all environments';

export function linkSystem(appId: string, input: z.infer<typeof systemLinkInput>, canEdit: CanEditApp): void {
  const u = me();
  const a = editableApp(appId, canEdit);
  const s = row(input.systemId);
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM application_systems WHERE application_id = ?', appId)?.n ?? 0);
  if (n >= SYSTEM_LIMITS.perApplication)
    throw new HttpError(409, `An application runs on at most ${SYSTEM_LIMITS.perApplication} systems`, 'SYSTEM_LINK_LIMIT', {
      max: SYSTEM_LIMITS.perApplication,
    });
  if (linkExists(appId, s.id, input.environment))
    throw new HttpError(409, `"${a.name}" runs on "${s.name}" (${envText(input.environment)}) already`, 'SYSTEM_LINK_EXISTS', {
      name: s.name,
      environment: input.environment,
    });
  const id = newId('asl_');
  db().tx(() => {
    db().run(
      'INSERT INTO application_systems (id, application_id, system_id, environment, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      appId,
      s.id,
      input.environment,
      input.note,
      nowIso(),
      u.username,
    );
    touchApplication(appId, u);
    audit({
      action: 'application.system_linked',
      entityType: 'application',
      entityId: appId,
      summary: `Application "${a.name}" runs on system "${s.name}" (${envText(input.environment)})`,
      details: { linkId: id, systemId: s.id, system: s.name, environment: input.environment, note: input.note },
    });
  });
}

export function updateSystemLink(appId: string, linkId: string, input: z.infer<typeof systemLinkUpdate>, canEdit: CanEditApp): void {
  const u = me();
  const a = editableApp(appId, canEdit);
  const cur = linkRow(appId, linkId);
  if (cur.environment === input.environment && cur.note === input.note) return;
  const s = row(cur.system_id);
  if (linkExists(appId, cur.system_id, input.environment, linkId))
    throw new HttpError(409, `"${a.name}" runs on "${s.name}" (${envText(input.environment)}) already`, 'SYSTEM_LINK_EXISTS', {
      name: s.name,
      environment: input.environment,
    });
  db().tx(() => {
    db().run('UPDATE application_systems SET environment = ?, note = ? WHERE id = ?', input.environment, input.note, linkId);
    touchApplication(appId, u);
    audit({
      action: 'application.system_link_changed',
      entityType: 'application',
      entityId: appId,
      summary: `Application "${a.name}" on system "${s.name}": ${envText(cur.environment)} → ${envText(input.environment)}`,
      details: { linkId, systemId: s.id, environment: { old: cur.environment, new: input.environment }, note: { old: cur.note, new: input.note } },
    });
  });
}

export function unlinkSystem(appId: string, linkId: string, canEdit: CanEditApp): void {
  const u = me();
  const a = editableApp(appId, canEdit);
  const cur = linkRow(appId, linkId);
  const s = db().get<{ name: string }>('SELECT name FROM systems WHERE id = ?', cur.system_id);
  db().tx(() => {
    db().run('DELETE FROM application_systems WHERE id = ?', linkId);
    touchApplication(appId, u);
    audit({
      action: 'application.system_unlinked',
      entityType: 'application',
      entityId: appId,
      summary: `Application "${a.name}" no longer runs on system "${s?.name ?? cur.system_id}" (${envText(cur.environment)})`,
      details: { linkId, systemId: cur.system_id, system: s?.name ?? null, environment: cur.environment },
    });
  });
}

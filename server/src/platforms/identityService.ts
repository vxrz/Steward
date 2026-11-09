/**
 * Managing platform identities (0.13.0, ADR 0009 step 2): create, change and delete identities, their credentials,
 * access list, MCP mode, read-only flag and operation filter, and which one is the default. The routes check the
 * platform's `manage` right (and a step-up where the ADR asks for one); this module keeps the rules of the data: one
 * default identity, unique names, variables that may not move where requests go, seals and audit entries.
 *
 * Who may use an identity is decided by identityAccess() (auth/policy.ts).
 */
import {
  DATABASE_KIND,
  type AclEntry,
  type AuthConfig,
  type IdentityMcp,
  type IdentityOperationFilter,
  type Platform,
  type PlatformIdentity,
  type PlatformIdentityInput,
  type PlatformIdentitySettings,
  AUTH_TYPES,
} from '@sm/shared';
import { db } from '../db.js';
import { vault } from '../vault.js';
import { audit } from '../audit.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { cleanAcl } from '../auth/permissions.js';
import { forgetOwningTeams, identityAccess } from '../auth/policy.js';
import { invalidateIdentityCaches, invalidatePlatformCaches } from './http.js';
import { requireIdentityIntact, requirePlatformIntact, sealIdentity } from './integrity.js';
import { fixedVariables, identityRow, identityRows, parseMcp, type IdentityRow } from './identities.js';
import { getConnection, getPlatform, listOperations, storedConfig } from './service.js';
import { cleanFilter, filterWidens, resolveOperationRef, specPathOf } from './operationFilter.js';

export const IDENTITY_LIMITS = { name: 100, description: 2000, variables: 100, perPlatform: 50 } as const;

const flag = (v: number | boolean | null | undefined) => v === true || Number(v) === 1;
const actor = () => currentUser()?.username ?? 'system';

/** "Snowflake · Read only": the default identity's name only where a platform has more than one. */
export function identityLabel(platformName: string, identityName: string | undefined, several = true): string {
  return identityName && several ? `${platformName} · ${identityName}` : platformName;
}

/** An identity of a platform (404 IDENTITY_NOT_FOUND – also for an identity of another platform). */
export function requireIdentity(platformId: string, identityId: string): IdentityRow {
  const r = identityRow(platformId, identityId);
  if (!r) throw new HttpError(404, `Identity ${identityId} not found`, 'IDENTITY_NOT_FOUND', { id: identityId });
  return r;
}

/**
 * The identity a reference names (its id, or its name – case-insensitive, as Git sync and monitors may use names); no
 * reference: the default identity. Never an identity of another platform.
 */
export function resolveIdentityRef(platformId: string, ref?: string | null): IdentityRow {
  const rows = identityRows(platformId);
  if (!ref) {
    const def = rows.find((r) => flag(r.is_default));
    if (!def) throw new HttpError(404, `The platform ${platformId} has no default identity`, 'IDENTITY_NOT_FOUND', { id: '' });
    return def;
  }
  const hit = rows.find((r) => r.id === ref) ?? rows.find((r) => r.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw new HttpError(404, `Identity "${ref.slice(0, 100)}" not found`, 'IDENTITY_NOT_FOUND', { id: ref.slice(0, 100) });
  return hit;
}

/** Whether `u` may use the identity (both `use` on the platform and on the identity; ADR 0009). */
export function mayUseIdentity(u: AuthUser | null, platform: Pick<Platform, 'id' | 'acl'>, r: IdentityRow): boolean {
  return identityAccess(u, platform, { id: r.id, default: flag(r.is_default), acl: parseJson<AclEntry<'use'>[]>(r.acl, []) }).permissions.includes('use');
}

const audited = (platform: Platform, r: Pick<IdentityRow, 'id' | 'name'>, action: string, summary: string, details: Record<string, unknown> = {}) =>
  audit({
    action,
    entityType: 'platform',
    entityId: platform.id,
    summary: `${identityLabel(platform.name, r.name)}: ${summary}`,
    details: { identityId: r.id, identityName: r.name, ...details },
  });

function cleanName(platformId: string, name: unknown, except?: string): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new HttpError(400, 'Name is required', 'NAME_REQUIRED');
  if (n.length > IDENTITY_LIMITS.name) throw new HttpError(400, `At most ${IDENTITY_LIMITS.name} characters`, 'IDENTITY_NAME_INVALID');
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(n)) throw new HttpError(400, 'The name may not contain control characters', 'IDENTITY_NAME_INVALID');
  const clash = identityRows(platformId).find((r) => r.id !== except && r.name.toLowerCase() === n.toLowerCase());
  if (clash) throw new HttpError(409, `The platform has an identity called "${n}" already`, 'IDENTITY_NAME_TAKEN', { name: n });
  return n;
}

function cleanAuth(input: unknown): AuthConfig | null {
  if (input === null || input === undefined) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Sign-in settings must be an object', 'IDENTITY_AUTH_INVALID');
  const type = (input as { type?: unknown }).type;
  if (typeof type !== 'string' || !(AUTH_TYPES as readonly string[]).includes(type))
    throw new HttpError(400, `Unknown sign-in type "${String(type).slice(0, 40)}"`, 'IDENTITY_AUTH_INVALID');
  const text = JSON.stringify(input);
  if (text.length > 20000) throw new HttpError(400, 'Sign-in settings too large', 'IDENTITY_AUTH_INVALID');
  return JSON.parse(text) as AuthConfig;
}

/**
 * Variables of an identity: strings only; none that decides where requests or credentials go – the base URL, the token
 * URL of the platform's or the identity's sign-in, trusted origins, the portal (IDENTITY_VARIABLE_FIXED).
 */
function cleanVariables(platformId: string, input: unknown, auth: AuthConfig | null): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Variables must be an object', 'IDENTITY_VARIABLES_INVALID');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > IDENTITY_LIMITS.variables) throw new HttpError(400, `At most ${IDENTITY_LIMITS.variables} variables`, 'IDENTITY_VARIABLES_INVALID');
  const p = getPlatform(platformId);
  const fixed = fixedVariables({ baseUrl: p.baseUrl, auth: p.config.auth as never, http: p.config.http, portalUrl: p.config.portalUrl }, auth as never);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new HttpError(400, `Invalid variable name "${k.slice(0, 64)}"`, 'IDENTITY_VARIABLES_INVALID');
    if (typeof v !== 'string' || v.length > 2000) throw new HttpError(400, `Variable "${k}": a text of at most 2000 characters`, 'IDENTITY_VARIABLES_INVALID');
    if (fixed.has(k))
      throw new HttpError(
        400,
        `The variable "${k}" decides where requests or credentials go (base URL, token URL, trusted origins) – an identity cannot change it`,
        'IDENTITY_VARIABLE_FIXED',
        { name: k },
      );
    out[k] = v;
  }
  return out;
}

/** The URLs of sign-in settings that credentials go to: token URL, login and refresh requests, the AWS STS endpoint. */
function authUrls(a: AuthConfig | null | undefined): { field: string; url: string }[] {
  if (!a) return [];
  const out: { field: string; url: string }[] = [];
  const add = (field: string, v: unknown) => typeof v === 'string' && v.trim() && out.push({ field, url: v.trim() });
  add('tokenUrl', a.tokenUrl);
  add('request.url', a.request?.url);
  add('refresh.request.url', a.refresh?.request?.url);
  add('aws.stsEndpoint', a.aws?.stsEndpoint);
  return out;
}

/**
 * A URL template with only {{ baseUrl }} and {{ vars.x }} filled in – synchronously, so the check needs no expression
 * engine. Anything else in {{ … }} cannot be checked: null.
 */
function fillUrl(template: string, baseUrl: string, vars: Record<string, string>): string | null {
  const filled = template.replace(/\{\{\s*(baseUrl|vars\.([A-Za-z_][A-Za-z0-9_]*))\s*\}\}/g, (_m, what: string, name?: string) =>
    what === 'baseUrl' ? baseUrl.replace(/\/+$/, '') : (vars[name!] ?? ''),
  );
  return filled.includes('{{') || filled.includes('}}') ? null : filled;
}

const originOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
};

/**
 * An identity's own sign-in settings may send its credentials only to the platform's own origins (0.13.0, ADR 0009): the
 * base URL's, the trusted origins and the origins of the platform's own sign-in (token URL, login, refresh, STS endpoint).
 * A relative URL goes to the base URL. A URL that names anything else – or uses an expression that cannot be checked
 * without the credentials – is refused (IDENTITY_AUTH_ORIGIN).
 */
function checkAuthOrigins(platformId: string, auth: AuthConfig | null, variables: Record<string, string>): void {
  if (!auth) return;
  const stored = storedConfig(platformId);
  const p = getPlatform(platformId);
  const platformVars = stored.variables ?? {};
  const base = fillUrl(p.baseUrl, '', platformVars) ?? '';
  const allowed = new Set<string>();
  const addOrigin = (url: string | null) => {
    const o = originOf(url);
    if (o) allowed.add(o);
  };
  addOrigin(base);
  for (const t of stored.http?.trustedOrigins ?? []) addOrigin(fillUrl(t, base, platformVars));
  for (const { url } of authUrls(stored.auth)) addOrigin(url.startsWith('/') ? null : fillUrl(url, base, platformVars));
  // the identity's variables over the platform's (those that decide where requests go cannot be set: cleanVariables)
  const vars = { ...platformVars, ...variables };
  for (const { field, url } of authUrls(auth)) {
    if (url.startsWith('/') && !url.startsWith('//')) continue;
    const filled = fillUrl(url, base, vars);
    const origin = originOf(filled);
    if (!origin || !allowed.has(origin))
      throw new HttpError(
        400,
        `The sign-in setting ${field} sends the identity's credentials to ${origin ?? 'an address that cannot be checked'} – an identity may only sign in at the platform's own origins (${[...allowed].join(', ') || 'none'})`,
        'IDENTITY_AUTH_ORIGIN',
        { field, origin: origin ?? url.slice(0, 200), allowed: [...allowed].join(', ') },
      );
  }
}

/** An operation filter: only for platforms with an API specification; references must name operations of its specs. */
function checkedFilter(platform: Platform, input: unknown): IdentityOperationFilter | null {
  if (input === undefined || input === null) return null;
  const f = cleanFilter(input);
  if (!f) throw new HttpError(400, 'An operation filter needs a preset: read or chosen', 'IDENTITY_FILTER_INVALID');
  const ops = listOperations(platform.id);
  if (!ops.length)
    throw new HttpError(400, `"${platform.name}" has no API specification – an operation filter needs one`, 'IDENTITY_FILTER_NOT_AVAILABLE', {
      name: platform.name,
    });
  const unknown = f.operations.find((r) => !resolveOperationRef(r, ops));
  if (unknown)
    throw new HttpError(400, `${unknown.method} ${unknown.specPath} is not an operation of the platform's specifications`, 'IDENTITY_FILTER_INVALID');
  // the references as the specification has them (the operation id of now)
  return {
    preset: f.preset,
    operations: f.operations.map((r) => {
      const o = resolveOperationRef(r, ops)!;
      return { specId: o.specId, method: o.method.toUpperCase(), specPath: specPathOf(o), ...(o.operationId ? { operationId: o.operationId } : {}) };
    }),
  };
}

/** The platform for a change: refused while it (or the identity) was changed outside Steward – it would be sealed unseen. */
function platformForChange(platformId: string): Platform {
  requirePlatformIntact(platformId);
  return getPlatform(platformId);
}

const mutable = (p: Platform, r: IdentityRow) => requireIdentityIntact(r, p.name);

function view(platformId: string, identityId: string): PlatformIdentity {
  return getPlatform(platformId).identities!.find((i) => i.id === identityId)!;
}

/** Create an identity (closed: no access list, no credentials, MCP off). */
export function createIdentity(platformId: string, input: PlatformIdentityInput): PlatformIdentity {
  const p = platformForChange(platformId);
  if (identityRows(platformId).length >= IDENTITY_LIMITS.perPlatform)
    throw new HttpError(400, `At most ${IDENTITY_LIMITS.perPlatform} identities per platform`, 'IDENTITY_LIMIT', { max: IDENTITY_LIMITS.perPlatform });
  const name = cleanName(platformId, input.name);
  const auth = cleanAuth(input.auth);
  const variables = cleanVariables(platformId, input.variables, auth);
  checkAuthOrigins(platformId, auth, variables);
  const filter = checkedFilter(p, input.operationFilter);
  const id = newId('pi_');
  const ts = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO platform_identities (id, platform_id, name, description, is_default, auth, variables, secrets, acl, read_only, privileged, operation_filter,
         mcp, credential_source, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL, '[]', ?, 0, ?, ?, NULL, ?, ?, ?, ?)`,
      id,
      platformId,
      name,
      (input.description ?? '').slice(0, IDENTITY_LIMITS.description),
      auth ? JSON.stringify(auth) : null,
      JSON.stringify(variables),
      input.readOnly ? 1 : 0,
      filter ? JSON.stringify(filter) : null,
      JSON.stringify({ mode: 'off' }),
      ts,
      actor(),
      ts,
      actor(),
    );
    sealIdentity(id);
    audited(p, { id, name }, 'platform.identity_created', 'identity created', {
      readOnly: !!input.readOnly,
      ownSignIn: !!auth,
      variables: Object.keys(variables),
      operationFilter: filter ? { preset: filter.preset, operations: filter.operations.length } : null,
    });
  });
  return view(platformId, id);
}

/** What changing an identity loosens (a step-up, ADR 0009): read-only off, a wider or removed operation filter. */
export function identityChangeLoosens(platformId: string, identityId: string, input: Partial<PlatformIdentityInput>): boolean {
  const r = identityRow(platformId, identityId);
  if (!r) return false;
  if (input.readOnly === false && flag(r.read_only)) return true;
  if (input.operationFilter === undefined) return false;
  const before = parseJson<IdentityOperationFilter | null>(r.operation_filter, null);
  return filterWidens(before, cleanFilter(input.operationFilter), listOperations(platformId));
}

/** Change an identity's name, description, sign-in settings, variables, read-only flag and operation filter. */
export function updateIdentity(platformId: string, identityId: string, input: Partial<PlatformIdentityInput>): PlatformIdentity {
  const p = platformForChange(platformId);
  const r = requireIdentity(platformId, identityId);
  mutable(p, r);
  const name = input.name !== undefined ? cleanName(platformId, input.name, r.id) : r.name;
  const auth = input.auth !== undefined ? cleanAuth(input.auth) : parseJson<AuthConfig | null>(r.auth, null);
  const variables = input.variables !== undefined ? cleanVariables(platformId, input.variables, auth) : parseJson<Record<string, string>>(r.variables, {});
  // the identity's own sign-in may not make a variable it already sets decide where requests go
  if (input.auth !== undefined && input.variables === undefined) cleanVariables(platformId, variables, auth);
  // its own sign-in only at the platform's own origins (with its variables of now)
  if (input.auth !== undefined || input.variables !== undefined) checkAuthOrigins(platformId, auth, variables);
  const beforeFilter = parseJson<IdentityOperationFilter | null>(r.operation_filter, null);
  const filter = input.operationFilter !== undefined ? checkedFilter(p, input.operationFilter) : beforeFilter;
  const readOnly = input.readOnly !== undefined ? input.readOnly : flag(r.read_only);
  const description = input.description !== undefined ? input.description.slice(0, IDENTITY_LIMITS.description) : r.description;
  const changed: string[] = [];
  if (name !== r.name) changed.push('name');
  if (description !== r.description) changed.push('description');
  if (JSON.stringify(auth) !== JSON.stringify(parseJson(r.auth, null))) changed.push('signIn');
  if (JSON.stringify(variables) !== JSON.stringify(parseJson(r.variables, {}))) changed.push('variables');
  if (readOnly !== flag(r.read_only)) changed.push('readOnly');
  const filterChanged = JSON.stringify(filter) !== JSON.stringify(beforeFilter);
  db().tx(() => {
    db().run(
      `UPDATE platform_identities SET name = ?, description = ?, auth = ?, variables = ?, read_only = ?, operation_filter = ?, updated_at = ?, updated_by = ?
       WHERE id = ? AND platform_id = ?`,
      name,
      description,
      auth ? JSON.stringify(auth) : null,
      JSON.stringify(variables),
      readOnly ? 1 : 0,
      filter ? JSON.stringify(filter) : null,
      nowIso(),
      actor(),
      r.id,
      platformId,
    );
    sealIdentity(r.id);
    if (changed.length)
      audited(
        p,
        { id: r.id, name },
        'platform.identity_updated',
        `identity changed (${changed.join(', ')})${name !== r.name ? ` – renamed from "${r.name}"` : ''}`,
        {
          changed,
          ...(name !== r.name ? { previousName: r.name } : {}),
          ...(changed.includes('readOnly') ? { readOnly } : {}),
          ...(changed.includes('variables') ? { variables: Object.keys(variables) } : {}),
          ...(changed.includes('signIn') ? { signIn: auth?.type ?? null } : {}),
        },
      );
    if (filterChanged)
      audited(
        p,
        { id: r.id, name },
        'platform.identity_filter_changed',
        filter
          ? `operation filter: ${filter.preset}${filter.operations.length ? ` + ${filter.operations.length} chosen` : ''}`
          : 'operation filter removed (all operations)',
        {
          before: beforeFilter ? { preset: beforeFilter.preset, operations: beforeFilter.operations } : null,
          after: filter ? { preset: filter.preset, operations: filter.operations } : null,
        },
      );
  });
  invalidateIdentityCaches(platformId, r.id);
  return view(platformId, r.id);
}

/** Where an identity is named: schedules, webhook triggers, monitors (checks, outputs), monitor outputs' process slots. */
export function identityReferences(platformId: string, r: Pick<IdentityRow, 'id' | 'name'>): { kind: string; id: string; name: string }[] {
  const out: { kind: string; id: string; name: string }[] = [];
  const like = `%${r.id}%`;
  for (const s of db().all<{ id: string; name: string; identities: string }>('SELECT id, name, identities FROM schedules WHERE identities LIKE ?', like))
    if (Object.values(parseJson<Record<string, string>>(s.identities, {})).includes(r.id)) out.push({ kind: 'schedule', id: s.id, name: s.name });
  for (const t of db().all<{ id: string; name: string; identities: string }>('SELECT id, name, identities FROM webhook_triggers WHERE identities LIKE ?', like))
    if (Object.values(parseJson<Record<string, string>>(t.identities, {})).includes(r.id)) out.push({ kind: 'trigger', id: t.id, name: t.name });
  // monitors name an identity by id or by name, next to the platform (id or name)
  for (const m of db().all<{ id: string; name: string; definition: string }>('SELECT id, name, definition FROM monitors')) {
    const def = parseJson<{
      checks?: { platform?: string; identity?: string }[];
      outputs?: { platform?: string; identity?: string; identities?: Record<string, string> }[];
    }>(m.definition, {});
    const names = (x: { identity?: string }) => !!x.identity && (x.identity === r.id || x.identity.toLowerCase() === r.name.toLowerCase());
    const hit =
      (def.checks ?? []).some((c) => names(c) && !!c.platform) ||
      (def.outputs ?? []).some((o) => (names(o) && !!o.platform) || Object.values(o.identities ?? {}).includes(r.id));
    if (hit) out.push({ kind: 'monitor', id: m.id, name: m.name });
  }
  return out;
}

/** Delete an identity: never the default, never one still named by a schedule, trigger or monitor (IDENTITY_IN_USE). */
export function deleteIdentity(platformId: string, identityId: string): void {
  const p = getPlatform(platformId);
  const r = requireIdentity(platformId, identityId);
  if (flag(r.is_default))
    throw new HttpError(409, 'The default identity cannot be deleted – make another identity the default first', 'IDENTITY_DEFAULT_NOT_DELETABLE');
  const refs = identityReferences(platformId, r);
  if (refs.length)
    throw new HttpError(
      409,
      `The identity "${r.name}" is still used by ${refs
        .slice(0, 10)
        .map((x) => `${x.kind} "${x.name}"`)
        .join(', ')}${refs.length > 10 ? ` and ${refs.length - 10} more` : ''}`,
      'IDENTITY_IN_USE',
      { name: r.name, uses: refs.slice(0, 10).map((x) => `${x.kind} "${x.name}"`) },
    );
  db().tx(() => {
    db().run('DELETE FROM platform_identities WHERE id = ? AND platform_id = ?', r.id, platformId);
    forgetOwningTeams('platform_identity', r.id);
    audited(p, r, 'platform.identity_deleted', 'identity deleted', { secretKeys: secretNames(r.secrets) });
  });
  invalidateIdentityCaches(platformId, r.id);
}

function secretNames(blob: string | null): string[] {
  try {
    return blob ? Object.keys(vault().decrypt<Record<string, string>>(blob)) : [];
  } catch {
    return [];
  }
}

/** Merge an identity's credentials: an empty string or null removes a key. Values are never logged or returned. */
export function setIdentitySecrets(platformId: string, identityId: string, patch: Record<string, string | null>): PlatformIdentity {
  const p = platformForChange(platformId);
  const r = requireIdentity(platformId, identityId);
  const { secrets: current } = getConnection(platformId, r.id);
  const changed: string[] = [];
  const removed: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') {
      if (k in current) removed.push(k);
      delete current[k];
    } else if (current[k] !== v) {
      current[k] = v;
      changed.push(k);
    }
  }
  const ts = nowIso();
  db().tx(() => {
    db().run(
      'UPDATE platform_identities SET secrets = ?, updated_at = ?, updated_by = ? WHERE id = ? AND platform_id = ?',
      Object.keys(current).length ? vault().encrypt(current) : null,
      ts,
      actor(),
      r.id,
      platformId,
    );
    sealIdentity(r.id);
    audited(p, r, 'platform.identity_secrets_changed', `credentials changed (${[...changed, ...removed.map((x) => `-${x}`)].join(', ') || 'no change'})`, {
      set: changed,
      removed,
    });
  });
  invalidateIdentityCaches(platformId, r.id);
  return view(platformId, r.id);
}

/** The access list of an identity that is not the default (the default identity is open to everyone with `use`). */
export function setIdentityAccess(platformId: string, identityId: string, aclInput: unknown): PlatformIdentity {
  const p = getPlatform(platformId);
  const r = requireIdentity(platformId, identityId);
  if (flag(r.is_default))
    throw new HttpError(
      400,
      'The default identity has no access list: everyone with "use" on the platform may use it – narrow the platform\'s access instead',
      'IDENTITY_DEFAULT_NO_ACCESS_LIST',
    );
  const acl = cleanAcl(aclInput, ['use'] as const).filter((e) => e.permissions.length);
  const before = parseJson<AclEntry<'use'>[]>(r.acl, []);
  db().tx(() => {
    db().run(
      'UPDATE platform_identities SET acl = ?, updated_at = ?, updated_by = ? WHERE id = ? AND platform_id = ?',
      JSON.stringify(acl),
      nowIso(),
      actor(),
      r.id,
      platformId,
    );
    audited(
      p,
      r,
      'platform.identity_access_changed',
      `access: ${acl.length ? acl.map((e) => e.subject).join(', ') : 'closed (administrators and owning teams only)'}`,
      {
        acl,
        previous: before,
      },
    );
  });
  return view(platformId, r.id);
}

/** Whether a new access list adds someone (a step-up, ADR 0009). */
export function accessAddsSubjects(platformId: string, identityId: string, aclInput: unknown): boolean {
  const r = identityRow(platformId, identityId);
  // not a list: refused by the route's validation, nobody gains anything
  if (!Array.isArray(aclInput)) return false;
  if (!r) return true;
  const before = new Set(parseJson<AclEntry<'use'>[]>(r.acl, []).map((e) => e.subject));
  return aclInput.some(
    (e) =>
      !before.has(
        String((e as { subject?: unknown })?.subject ?? '')
          .trim()
          .toLowerCase(),
      ),
  );
}

/** An identity's MCP mode: off, read, or approved writes (confirm or fourEyes). Database platforms: never writes. */
export function setIdentityMcp(platformId: string, identityId: string, input: IdentityMcp): PlatformIdentity {
  const p = platformForChange(platformId);
  const r = requireIdentity(platformId, identityId);
  mutable(p, r);
  const before = parseMcp(r.mcp);
  const writes = input.writes === 'confirm' || input.writes === 'fourEyes' ? input.writes : (before.writes ?? undefined);
  const mode = input.mode === 'writes' || input.mode === 'read' ? input.mode : 'off';
  if (mode === 'writes' && !writes) throw new HttpError(400, 'Approved writes need an approval mode: confirm or fourEyes', 'IDENTITY_MCP_INVALID');
  if (p.kind === DATABASE_KIND && mode === 'writes')
    throw new HttpError(
      400,
      `"${p.name}" is a database platform: its MCP gateway is read-only (changing statements are not available)`,
      'MCP_WRITES_NOT_AVAILABLE',
      { name: p.name },
    );
  const next: IdentityMcp = mode === 'writes' ? { mode, writes: writes! } : writes ? { mode, writes } : { mode };
  db().tx(() => {
    db().run(
      'UPDATE platform_identities SET mcp = ?, updated_at = ?, updated_by = ? WHERE id = ? AND platform_id = ?',
      JSON.stringify(next),
      nowIso(),
      actor(),
      r.id,
      platformId,
    );
    sealIdentity(r.id);
    audited(
      p,
      r,
      'platform.identity_mcp_changed',
      `MCP: ${next.mode === 'writes' ? `approved writes (${next.writes})` : next.mode}${before.mode !== next.mode ? ` (was ${before.mode})` : ''}`,
      { mcp: next, previous: before },
    );
  });
  return view(platformId, r.id);
}

/** Whether a new MCP mode turns changing calls on (step-up mcp.allowWrites, as for the platform's gateway). */
export function mcpTurnsWritesOn(platformId: string, identityId: string, input: { mode?: unknown }): boolean {
  const r = identityRow(platformId, identityId);
  return input.mode === 'writes' && (!r || parseMcp(r.mcp).mode !== 'writes');
}

/**
 * Make an identity the default (everyone with `use` on the platform gets it; step-up). The new default needs no access
 * list (it is cleared, recorded in the audit entry); the former default becomes closed like any other identity.
 */
export function makeDefaultIdentity(platformId: string, identityId: string): PlatformIdentity {
  const p = platformForChange(platformId);
  const r = requireIdentity(platformId, identityId);
  mutable(p, r);
  if (flag(r.is_default)) return view(platformId, r.id);
  if (flag(r.disabled))
    throw new HttpError(409, `The identity "${r.name}" is disabled – an administrator enables it first`, 'IDENTITY_DISABLED', {
      identity: r.name,
      platform: p.name,
    });
  const before = identityRows(platformId).find((x) => flag(x.is_default));
  const ts = nowIso();
  db().tx(() => {
    if (before) {
      db().run('UPDATE platform_identities SET is_default = 0, updated_at = ?, updated_by = ? WHERE id = ?', ts, actor(), before.id);
      sealIdentity(before.id);
    }
    db().run("UPDATE platform_identities SET is_default = 1, acl = '[]', updated_at = ?, updated_by = ? WHERE id = ?", ts, actor(), r.id);
    sealIdentity(r.id);
    audited(p, r, 'platform.identity_default_changed', `is the default identity now${before ? ` (was "${before.name}")` : ''}`, {
      previousDefault: before ? { id: before.id, name: before.name } : null,
      clearedAccessList: parseJson<AclEntry<'use'>[]>(r.acl, []),
    });
  });
  // plain platform objects stand for the default identity in the caches: all of the platform's entries go
  invalidatePlatformCaches(platformId);
  return view(platformId, r.id);
}

/**
 * Enable an identity that was kept disabled when an administrator confirmed settings changed outside Steward (0.13.0,
 * ADR 0009). The caller is an administrator who confirmed with a step-up after reading its access list; the audit entry
 * records what was enabled – access list, credential names, sign-in, MCP mode.
 */
export function enableIdentity(platformId: string, identityId: string): PlatformIdentity {
  const p = platformForChange(platformId);
  const r = requireIdentity(platformId, identityId);
  mutable(p, r);
  if (!flag(r.disabled)) return view(platformId, r.id);
  db().tx(() => {
    db().run(
      'UPDATE platform_identities SET disabled = 0, updated_at = ?, updated_by = ? WHERE id = ? AND platform_id = ?',
      nowIso(),
      actor(),
      r.id,
      platformId,
    );
    sealIdentity(r.id);
    audited(p, r, 'platform.identity_enabled', 'identity enabled after it was added or changed outside Steward', {
      acl: parseJson<AclEntry<'use'>[]>(r.acl, []),
      secretKeys: secretNames(r.secrets),
      signIn: parseJson<AuthConfig | null>(r.auth, null)?.type ?? null,
      variables: Object.keys(parseJson<Record<string, string>>(r.variables, {})),
      mcp: parseMcp(r.mcp),
      readOnly: flag(r.read_only),
    });
  });
  invalidateIdentityCaches(platformId, r.id);
  return view(platformId, r.id);
}

/** An identity's settings for its managers: sign-in settings, variables, the variables it may not set, its filter resolved. */
export function identitySettings(platformId: string, identityId: string): PlatformIdentitySettings {
  const p = getPlatform(platformId);
  const r = requireIdentity(platformId, identityId);
  const auth = parseJson<AuthConfig | null>(r.auth, null);
  const ops = listOperations(platformId);
  const filter = parseJson<IdentityOperationFilter | null>(r.operation_filter, null);
  const stored = storedConfig(platformId);
  return {
    auth,
    variables: parseJson<Record<string, string>>(r.variables, {}),
    fixedVariables: [
      ...fixedVariables({ baseUrl: p.baseUrl, auth: stored.auth as never, http: stored.http, portalUrl: stored.portalUrl }, auth as never),
    ].sort(),
    operations: (filter?.operations ?? []).map((ref) => {
      const o = resolveOperationRef(ref, ops);
      return { ...ref, path: o?.path ?? null, stale: !o };
    }),
  };
}

/** The identities of a platform an operation filter reference would go stale for when these specs change (audit details). */
export function identitiesUsingSpecs(platformId: string, specIds: string[]): { id: string; name: string }[] {
  const ids = new Set(specIds);
  return identityRows(platformId)
    .filter((r) => {
      const f = parseJson<IdentityOperationFilter | null>(r.operation_filter, null);
      return !!f && (f.preset === 'read' || f.operations.some((o) => ids.has(o.specId)));
    })
    .map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Copy the operation filters of a platform's identities to another platform (Copy specs, "Also copy the operation
 * filters"): per identity of the source, the target's identity of the same name gets the filter – references mapped to
 * the copied specs –, or a new identity is created without credentials, closed and with MCP off. Never secrets, access
 * lists or MCP modes. The caller checks `manage` on the target.
 */
export function copyIdentityFilters(
  sourceId: string,
  targetId: string,
  specMap: Map<string, string>,
): { created: string[]; updated: string[]; skipped: string[] } {
  const target = platformForChange(targetId);
  const out = { created: [] as string[], updated: [] as string[], skipped: [] as string[] };
  const targetRows = identityRows(targetId);
  for (const src of identityRows(sourceId)) {
    const f = parseJson<IdentityOperationFilter | null>(src.operation_filter, null);
    if (!f) continue;
    const mapped: IdentityOperationFilter = {
      preset: f.preset,
      operations: f.operations.filter((o) => specMap.has(o.specId)).map((o) => ({ ...o, specId: specMap.get(o.specId)! })),
    };
    const existing = targetRows.find((t) => t.name.toLowerCase() === src.name.toLowerCase());
    if (existing) {
      // a copy never loosens an identity of the target (that needs its managers' step-up on the Identities tab)
      if (identityChangeLoosens(targetId, existing.id, { operationFilter: mapped })) {
        out.skipped.push(existing.name);
        continue;
      }
      updateIdentity(targetId, existing.id, { operationFilter: mapped, ...(flag(src.read_only) ? { readOnly: true } : {}) });
      out.updated.push(existing.name);
    } else {
      createIdentity(targetId, { name: src.name, description: src.description, readOnly: flag(src.read_only), operationFilter: mapped });
      out.created.push(src.name);
    }
  }
  if (out.created.length || out.updated.length)
    audit({
      action: 'platform.identity_filters_copied',
      entityType: 'platform',
      entityId: targetId,
      summary: `Operation filters copied to "${target.name}"${out.created.length ? ` – created: ${out.created.join(', ')}` : ''}${out.updated.length ? ` – updated: ${out.updated.join(', ')}` : ''}`,
      details: { from: sourceId, ...out },
    });
  return out;
}

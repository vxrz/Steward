/**
 * The read-only flag and the operation filter of a platform identity, enforced before anything is sent (0.13.0, ADR
 * 0009 step 3). One check, `assertIdentityAllows`, called by platformRequest on every redirect hop, by the dry-run and
 * test-run branches of the http step (a write that would be refused fails the dry run the same way), by the non-HTTP
 * steps and by the MCP gateway.
 *
 * - A read-only identity refuses every method but GET and HEAD (IDENTITY_READ_ONLY). A step's `mutating: false` does not
 *   count. A POST that only reads passes when the identity's operation filter chooses that operation, or when Steward's
 *   own code marks the request `intent: 'read'` (Prometheus queries, AWS query APIs, Snowflake statements, LLM calls).
 * - With an operation filter, a request that matches no allowed operation is refused (IDENTITY_OPERATION_REFUSED).
 * - The flags come from the identity as getConnection (or getPlatform) read it, with its seal checked – a platform
 *   object without them (a synthetic one) reads the row and checks the seal here.
 */
import { BRAND, type ApiOperation, type IdentityOperationFilter, type Platform, type PlatformIdentity } from '@sm/shared';
import { audit } from '../audit.js';
import { HttpError } from '../util.js';
import { defaultIdentityRow, identityRow, toIdentity } from './identities.js';
import { identityIntegrity } from './integrity.js';
import { SAFE_METHODS, allowedOperations, decide, pathBelowBase } from './operationFilter.js';

/** What a request says about itself. `read`: Steward's own fixed read that uses another method (never set by steps). */
export type RequestIntent = 'read';

type WithIdentity = Platform & { identityId?: string };

/** The rules of the identity a platform object stands for: the one getConnection merged in, else the default identity. */
export function identityRules(p: WithIdentity): Pick<PlatformIdentity, 'id' | 'name' | 'readOnly' | 'operationFilter' | 'integrity'> | null {
  const id = p.identityId;
  const known = p.identities?.find((i) => (id ? i.id === id : i.default));
  if (known) return known;
  if (!p.id || p.id.startsWith('offline:')) return null;
  const row = id ? identityRow(p.id, id) : defaultIdentityRow(p.id);
  if (!row) return null; // a platform still in the old layout (before the one-time step): no identity rules yet
  return toIdentity(row, { secretKeys: [], integrity: identityIntegrity(row), mayUse: false });
}

/** Whether the identity restricts anything (the fast path of platformRequest). */
export function restricts(p: WithIdentity): boolean {
  const r = identityRules(p);
  return !!r && (r.readOnly || !!r.operationFilter || r.integrity === 'mismatch' || r.integrity === 'unsealed');
}

export interface IdentityRequest {
  method: string;
  /** The final URL of this hop (after buildUrl) */
  url: string;
  intent?: RequestIntent;
  /** The resolved base URL (resolved when missing) */
  baseUrl?: string;
}

/** "Snowflake · Read only" (the default identity's name only where it matters: always here, it names who refused). */
export const identityLabel = (p: Pick<Platform, 'name'>, identityName: string) => `${p.name} · ${identityName}`;

function refuse(p: WithIdentity, identity: { id: string; name: string }, code: string, message: string, params: Record<string, string>): never {
  try {
    audit({
      action: 'platform.identity_refused',
      entityType: 'platform',
      entityId: p.id,
      summary: `${identityLabel(p, identity.name)}: ${message}`.slice(0, 500),
      details: { identityId: identity.id, identityName: identity.name, code, ...params },
    });
  } catch {
    /* the refusal stands without its audit entry (vault locked) */
  }
  throw Object.assign(new HttpError(403, message, code, { platform: p.name, identity: identity.name, ...params }), { retryable: false });
}

/** The platform's operations (all specs), read once per check. */
async function operationsOf(platformId: string): Promise<ApiOperation[]> {
  const { listOperations } = await import('./service.js');
  return listOperations(platformId);
}

/**
 * Refuses a request the identity may not send (IDENTITY_READ_ONLY, IDENTITY_OPERATION_REFUSED), audited as
 * `platform.identity_refused`. Nothing is sent before it passes.
 */
export async function assertIdentityAllows(p: WithIdentity, secrets: Record<string, string>, req: IdentityRequest): Promise<void> {
  const r = identityRules(p);
  if (!r) return;
  if (r.integrity === 'mismatch' || r.integrity === 'unsealed')
    throw Object.assign(
      new HttpError(
        409,
        `The credentials of "${p.name}" were changed outside ${BRAND.name} (directly in the database) – no requests are sent until an administrator reviews them and confirms (platform page)`,
        'PLATFORM_CONFIG_UNVERIFIED',
      ),
      { retryable: false },
    );
  const method = req.method.trim().toUpperCase();
  const safe = SAFE_METHODS.has(method);
  if (!r.readOnly && !r.operationFilter) return;
  let where = req.url;
  try {
    const u = new URL(req.url);
    where = `${u.origin}${u.pathname}`;
  } catch {
    /* shown as given */
  }
  if (!r.operationFilter) {
    if (safe || req.intent === 'read') return;
    refuse(p, r, 'IDENTITY_READ_ONLY', `the identity is read-only: ${method} ${where} is not sent`, { method, path: where.slice(0, 300) });
  }
  const filter = r.operationFilter as IdentityOperationFilter;
  const ops = await operationsOf(p.id);
  let base = req.baseUrl;
  if (base === undefined) {
    const { resolveBaseUrl } = await import('./http.js');
    base = await resolveBaseUrl(p, secrets).catch(() => '');
  }
  const rel = pathBelowBase(req.url, base);
  const d = decide(method, rel, ops, allowedOperations(filter, ops));
  if (!d.allowed) {
    const path = rel ?? where;
    refuse(
      p,
      r,
      'IDENTITY_OPERATION_REFUSED',
      `the identity's operation filter does not allow ${method} ${path.slice(0, 300)}${d.operation ? ` (${d.unmatched ? 'closest operation' : 'operation'}: ${d.operation})` : ' (no operation of the API specifications matches)'}`,
      { method, path: path.slice(0, 300), operation: d.operation ?? '' },
    );
  }
  // a read-only identity: a changing method only for an operation the filter chose (or Steward's own reads)
  if (r.readOnly && !safe && req.intent !== 'read') {
    const chosen =
      filter.operations.length > 0 && decide(method, rel, ops, allowedOperations({ preset: 'chosen', operations: filter.operations }, ops)).allowed;
    if (!chosen) refuse(p, r, 'IDENTITY_READ_ONLY', `the identity is read-only: ${method} ${where} is not sent`, { method, path: where.slice(0, 300) });
  }
}

/** A step that is not a request (access changes, browser interactions): refused for a read-only identity (IDENTITY_READ_ONLY). */
export function assertIdentityWrites(p: WithIdentity, what: string): void {
  const r = identityRules(p);
  if (r?.readOnly) refuse(p, r, 'IDENTITY_READ_ONLY', `the identity is read-only: ${what} is not allowed`, { method: what, path: '' });
}

/** A step no operation describes (browser steps): refused when the identity has an operation filter (IDENTITY_OPERATION_REFUSED). */
export function assertNoFilter(p: WithIdentity, what: string): void {
  const r = identityRules(p);
  if (r?.operationFilter)
    refuse(p, r, 'IDENTITY_OPERATION_REFUSED', `the identity's operation filter allows API operations only: ${what} is not allowed`, {
      method: what,
      path: '',
      operation: '',
    });
}

/** The current identity row's read-only flag (for save checks of writers: monitor outputs). */
export function identityIsReadOnly(platformId: string, identityId?: string): boolean {
  const row = identityId ? identityRow(platformId, identityId) : defaultIdentityRow(platformId);
  return !!row && (Number(row.read_only) === 1 || row.read_only === true);
}

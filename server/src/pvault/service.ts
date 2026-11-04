import { PVAULT_LIMITS, pvPrivileged, type Platform, type PvAuditEvent, type PvPrivilegedScope, type PvSecret } from '@sm/shared';
import { HttpError } from '../util.js';
import { mapLimit, PvClient, PvError, toSecret } from './client.js';

/**
 * IBM Verify Privilege Vault (#205): the connection test that names missing permissions, privileged use from the audit,
 * and the secret lookup for the credentials register. Access reviews: access.ts; hygiene: hygiene.ts; the credentials
 * register link: credentials.ts.
 */

export interface PvTestCheck {
  name: string;
  ok: boolean;
  message: string;
}

/**
 * Signs in and tries every read Steward makes, one item each: what works and – in plain words – which permission is
 * missing for the rest. Passes when the sign-in works (like the AWS test); the checks say what the account may not read.
 */
export async function testPrivilegeVault(p: Platform, secrets: Record<string, string>): Promise<{ message: string; checks: PvTestCheck[] }> {
  const c = new PvClient(p, secrets);
  const me = await c.currentUser();
  const who = me.userName || me.displayName || 'the service account';
  const checks: PvTestCheck[] = [];
  const probe = async <T>(name: string, run: () => Promise<T>, ok: (v: T) => string): Promise<T | null> => {
    try {
      const v = await run();
      checks.push({ name, ok: true, message: ok(v) });
      return v;
    } catch (e) {
      checks.push({ name, ok: false, message: e instanceof PvError ? e.message : (e as Error).message.slice(0, 300) });
      return null;
    }
  };
  type Page = { records?: { id?: number }[]; total?: number };
  const one = { take: 1 };
  const sec = await probe(
    'Secrets',
    () => c.get<Page>('/secrets', { ...one, 'filter.includeRestricted': 'true' }),
    (v) => `${v.total ?? v.records?.length ?? 0} secrets listed`,
  );
  const folders = await probe(
    'Folders',
    () => c.get<Page>('/folders', { ...one, 'filter.folderTypeId': 1 }),
    (v) => `${v.total ?? v.records?.length ?? 0} folders`,
  );
  const secretId = sec?.records?.[0]?.id;
  const folderId = folders?.records?.[0]?.id;
  if (secretId) {
    await probe(
      'Secret permissions',
      () => c.get<Page>('/secret-permissions', { ...one, 'filter.secretId': secretId }),
      () => 'readable',
    );
    await probe(
      'Secret audit',
      () => c.get<Page>(`/secrets/${secretId}/audits`, one),
      () => 'readable',
    );
  } else
    checks.push({ name: 'Secret permissions', ok: false, message: 'Not tried: the service account lists no secret – give it List on the folders to review' });
  if (folderId)
    await probe(
      'Folder permissions',
      () => c.get<Page>('/folder-permissions', { ...one, 'filter.folderId': folderId }),
      () => 'readable',
    );
  await probe(
    'Users',
    () => c.get<Page>('/users', one),
    (v) => `${v.total ?? v.records?.length ?? 0} users`,
  );
  await probe(
    'Groups',
    () => c.get<Page>('/groups', one),
    (v) => `${v.total ?? v.records?.length ?? 0} groups`,
  );
  await probe(
    'Roles',
    () => c.get<Page>('/roles', one),
    (v) => `${v.total ?? v.records?.length ?? 0} roles`,
  );
  if (me.id)
    await probe(
      'Role assignments',
      () => c.get<Page>(`/users/${me.id}/roles-assigned`, one),
      () => 'readable',
    );
  await probe(
    'Secret templates',
    () => c.get<Page>('/secret-templates', one),
    (v) => `${v.total ?? v.records?.length ?? 0} templates`,
  );
  await probe(
    'Access requests',
    () => c.get<Page>('/secret-access-requests', { ...one, 'filter.status': 'Approved' }),
    () => 'readable',
  );
  const missing = checks.filter((x) => !x.ok);
  return {
    message: missing.length
      ? `Signed in as ${who} – ${checks.length - missing.length} of ${checks.length} reads work; missing: ${missing.map((x) => x.name).join(', ')} (see the checks)`
      : `Signed in as ${who} – every read Steward makes works`,
    checks,
  };
}

/** Secrets whose name contains the text (for linking a credentials register entry): id, name, folder, template. */
export async function lookupSecrets(
  p: Platform,
  secrets: Record<string, string>,
  q: string,
): Promise<Pick<PvSecret, 'id' | 'name' | 'folderPath' | 'templateName'>[]> {
  const c = new PvClient(p, secrets);
  const body = await c.get<{ records?: Record<string, unknown>[] }>('/secrets', {
    'filter.searchText': q.slice(0, 100),
    'filter.includeRestricted': 'true',
    take: 25,
  });
  return (body.records ?? []).map(toSecret).map((s) => ({ id: s.id, name: s.name, folderPath: s.folderPath, templateName: s.templateName }));
}

export interface PrivilegedUseOptions extends PvPrivilegedScope {
  from: string;
  to: string;
  /** Only secrets of this folder and below ('' = all) */
  folder?: string;
}

/** Audit actions that are the vault's own work, not a use of the secret. */
const SYSTEM_ACTIONS = ['HEARTBEAT', 'HEARTBEATSUCCESS', 'HEARTBEATFAILURE', 'RPC', 'PASSWORDCHANGE', 'CHANGEPASSWORD', 'DISCOVERY'];

/**
 * Who used the privileged secrets in a period: views, checkouts, check-ins, password displays, launches, edits from each
 * secret's audit, and the access requests. Privileged: the scope's folders and templates; neither set – every secret in
 * the folder. Sorted by time.
 */
export async function privilegedUse(
  p: Platform,
  secrets: Record<string, string>,
  o: PrivilegedUseOptions,
): Promise<{ secrets: number; events: PvAuditEvent[]; truncated: boolean }> {
  const from = new Date(o.from).toISOString();
  const to = new Date(o.to).toISOString();
  if (!(from < to)) throw new HttpError(400, 'The period ends before it starts', 'PVAULT_PERIOD');
  if (Date.parse(to) - Date.parse(from) > PVAULT_LIMITS.auditDays * 86_400_000)
    throw new HttpError(400, `The period is longer than ${PVAULT_LIMITS.auditDays} days`, 'PVAULT_PERIOD');
  const c = new PvClient(p, secrets);
  const all = await c.secretsIn(o.folder ?? '');
  const scoped = o.folders.length || o.templates.length ? all.filter((s) => pvPrivileged(s, o)) : all;
  if (scoped.length > PVAULT_LIMITS.auditSecrets)
    throw new HttpError(
      400,
      `${scoped.length} secrets are more than the ${PVAULT_LIMITS.auditSecrets} whose audit is read at once – name the privileged folders or templates`,
      'PVAULT_TOO_MANY',
      { max: PVAULT_LIMITS.auditSecrets },
    );
  const byId = new Map(scoped.map((s) => [s.id, s]));
  const audits = await mapLimit(scoped, PVAULT_LIMITS.concurrency, (s) => c.audits(s.id, from, to));
  const events: PvAuditEvent[] = [];
  scoped.forEach((s, i) => {
    for (const a of audits[i]!) {
      if (!a.at || SYSTEM_ACTIONS.some((x) => a.action.replace(/\s+/g, '').startsWith(x))) continue;
      events.push({ at: a.at, secretId: s.id, secret: s.name, folder: s.folderPath, user: a.user, action: a.action, notes: a.notes, ticket: a.ticket });
    }
  });
  // access requests of these secrets in the period (a vault without approval workflows has none, or refuses the list)
  const requests = await c.accessRequests().catch((e: unknown) => {
    if (e instanceof PvError && (e.status === 403 || e.status === 404)) return []; // not readable: the audit alone is the evidence
    throw e;
  });
  for (const r of requests) {
    const s = byId.get(r.secretId);
    const at = r.requestedAt;
    if (!s || !at || at < from || at > to) continue;
    events.push({
      at,
      secretId: s.id,
      secret: s.name,
      folder: s.folderPath,
      user: r.user,
      action: `ACCESS REQUEST ${r.status.toUpperCase() || 'PENDING'}`,
      notes: [r.comment, r.approver ? `answered by ${r.approver}${r.respondedAt ? ` ${r.respondedAt.slice(0, 16)}` : ''}` : '']
        .filter(Boolean)
        .join(' – ')
        .slice(0, 500),
      ticket: r.ticket,
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at) || a.secretId - b.secretId);
  const truncated = events.length > PVAULT_LIMITS.auditEvents;
  return { secrets: scoped.length, events: events.slice(0, PVAULT_LIMITS.auditEvents), truncated };
}

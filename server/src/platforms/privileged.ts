/**
 * Privileged identities (0.14.0, ADR 0009 step 4): which identities a request names are privileged – read from the
 * identity rows as they are now (the default identity where a slot names none), without anyone's rights: the routes'
 * step-up rules (`StepUpRule.when`) ask with it before the handler runs, and the handlers check again (a flag set in
 * between is not slipped past, privilegedRefusal).
 *
 * Using a privileged identity is the control point platform.privilegedIdentity: starting a run, saving a schedule or a
 * webhook trigger, a request explorer call, approving an MCP request – each asks for a step-up. A run may in addition
 * wait for a start approval by a second person (engine/runner.ts).
 */
import { currentStore, currentUser } from '../auth/context.js';
import { requireStepUp } from '../auth/assurance.js';
import { HttpError } from '../util.js';
import { defaultIdentityRow, identityRow, type IdentityRow } from './identities.js';
import { db } from '../db.js';

const flag = (v: number | boolean | null | undefined) => v === true || Number(v) === 1;

export interface PrivilegedUse {
  slot?: string;
  platformId: string;
  platformName: string;
  identityId: string;
  identityName: string;
}

const platformName = (id: string) => db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', id)?.name ?? id;

/** The identity a platform and an (optional) identity id stand for – the default identity without one; undefined: unknown. */
function rowOf(platformId: string, identityId?: string | null): IdentityRow | undefined {
  if (typeof platformId !== 'string' || !platformId) return undefined;
  return identityId ? identityRow(platformId, identityId) : defaultIdentityRow(platformId);
}

/** Whether this identity (the default identity without an id) is privileged now. */
export function isPrivileged(platformId: string, identityId?: string | null): boolean {
  const r = rowOf(platformId, identityId);
  return !!r && flag(r.privileged);
}

/** The privileged identities among the slots of a start, a schedule or a trigger (slot → platform id, slot → identity id). */
export function privilegedSlots(bindings: unknown, identities: unknown): PrivilegedUse[] {
  const b = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? (bindings as Record<string, unknown>) : {};
  const i = identities && typeof identities === 'object' && !Array.isArray(identities) ? (identities as Record<string, unknown>) : {};
  const out: PrivilegedUse[] = [];
  for (const [slot, pid] of Object.entries(b)) {
    if (typeof pid !== 'string') continue;
    const iid = typeof i[slot] === 'string' ? (i[slot] as string) : undefined;
    const r = rowOf(pid, iid);
    if (r && flag(r.privileged)) out.push({ slot, platformId: pid, platformName: platformName(pid), identityId: r.id, identityName: r.name });
  }
  return out;
}

/** Whether a start, schedule or trigger names a privileged identity (the step-up rules' `when`). */
export const namesPrivileged = (bindings: unknown, identities: unknown): boolean => privilegedSlots(bindings, identities).length > 0;

/**
 * The step-up of platform.privilegedIdentity in a handler, for the uses a request makes (`uses` empty: none). A route that
 * declares it with `StepUpRule.when` has asked already – its proof is in the request (also "not required" when the
 * policy turned the step-up off) and nothing is asked again. Otherwise – the routes where it depends on a stored object
 * (approving a start approval or an MCP request, "Run now" of a schedule), or an identity marked privileged between the
 * hook and the handler – it is asked now: the answer to send (403 STEP_UP_REQUIRED, SESSION_REQUIRED for API tokens), or
 * undefined when the request may go on (the proof is noted for its audit entries). Never an unconfirmed use.
 */
export function privilegedRefusal(uses: PrivilegedUse[]): { status: number; body: Record<string, unknown> } | undefined {
  if (!uses.length) return undefined;
  const proofs = (currentStore()?.assurance?.proofs ?? []) as { point?: string; stepUp?: unknown }[];
  if (proofs.some((p) => p.point === 'platform.privilegedIdentity' && p.stepUp)) return undefined;
  const u = currentUser();
  if (!u) return { status: 401, body: { error: 'Please sign in', code: 'NOT_SIGNED_IN' } };
  return requireStepUp(['platform.privilegedIdentity'], u, 'usePrivilegedIdentity');
}

/** privilegedRefusal as an error, for services without the reply (the refusal's code and text; the route asked first). */
export function assertPrivilegedConfirmed(uses: PrivilegedUse[]): void {
  const r = privilegedRefusal(uses);
  if (!r) return;
  const u = uses[0]!;
  throw new HttpError(
    r.status,
    `The identity "${u.identityName}" of "${u.platformName}" is privileged – confirm it is you first`,
    typeof r.body.code === 'string' ? r.body.code : 'STEP_UP_REQUIRED',
    { identity: u.identityName, platform: u.platformName },
  );
}

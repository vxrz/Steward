import type { UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { runAs } from '../auth/context.js';
import { toAuthUser } from '../auth/users.js';
import { fourEyesRequired, mayDecideInTeams, noteFourEyes } from '../auth/assurance.js';
import { visibleTask } from '../engine/run-access.js';
import { authorizeSignal } from '../engine/commands.js';
import { engine } from '../engine/index.js';
import { decide as decideMcpRequest, getRequest } from '../mcp/requests.js';
import { HttpError } from '../util.js';
import { botApproved, botConfig } from './settings.js';

/**
 * THE decision entry point of the Teams bot (ADR 0013): `decideFromTeams()` runs as the person who clicked (runAs, no
 * session) and goes through the engine boundary like the route `POST /api/tasks/:id/complete` – `authorizeSignal` of
 * engine/commands.ts (visibility, `canDecide`, four-eyes) and `engine().signal(task.decide)`; the task.completed entry
 * gets `via: "teams"` through the signal's `audit` details. MCP requests go through `decide()` of mcp/requests.ts,
 * which checks `mayApprove`, the expiry and the claim itself. A person who could not decide in Steward cannot decide here.
 *
 * Teams never gets a shortcut: anything that needs a step-up (Teams cannot show one), select decisions, manual steps
 * and their verification, and proposals answer `needsSteward`; a control point (or the bot itself, `teams.bot`) whose
 * assurance rule says "not in Microsoft Teams" answers `policy`; a person without a Steward sign-in within the bot's
 * `signInDays` answers `signIn` (their roles and teams come from that sign-in – security review 0.10.0).
 */

export type ItemKind = 'task' | 'mcp_request';
export type Verb = 'approve' | 'reject';

export interface TeamsClicker {
  tenantId: string;
  aadObjectId: string;
  conversationKind: string;
}

export type Refusal = 'gone' | 'mayNot' | 'needsSteward' | 'policy' | 'decided' | 'signIn';
export type TeamsOutcome = { ok: true; status: 'approved' | 'rejected' } | { ok: false; reason: Refusal | 'stale'; message?: string };

/** Whether the person signed in to Steward recently enough for their stored roles to count (the bot's signInDays). */
export function signedInRecently(user: UserInfo, now = Date.now()): boolean {
  const at = user.lastLoginAt ? Date.parse(user.lastLoginAt) : NaN;
  return Number.isFinite(at) && now - at <= botConfig().signInDays * 86_400_000;
}

/** A short cache of what one person may do with one item (card refreshes come in bursts): 30 seconds. */
const cache = new Map<string, { at: number; v: { ok: true } | { ok: false; reason: Refusal } }>();
const CACHE_MS = 30_000;

/** The version of an item a card was built for: a task's status, round and stage; a request's status. */
export function versionOf(kind: ItemKind, id: string): string | null {
  if (kind === 'task') {
    const r = db().get<{ status: string; round: number | null; stage: string | null }>('SELECT status, round, stage FROM run_tasks WHERE id = ?', id);
    return r ? `${r.status}:${r.round ?? 1}:${r.stage ?? ''}` : null;
  }
  const r = db().get<{ status: string }>('SELECT status FROM mcp_requests WHERE id = ?', id);
  return r ? r.status : null;
}

/** What `user` may do with an item from a card now (the card's buttons; computed per viewer and on every click). */
export function teamsDecidable(user: UserInfo, kind: ItemKind, id: string, opts: { fresh?: boolean } = {}): { ok: true } | { ok: false; reason: Refusal } {
  const key = `${user.id}|${kind}|${id}|${versionOf(kind, id) ?? ''}`;
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const v = decidableNow(user, kind, id);
  if (cache.size > 5000) cache.clear();
  cache.set(key, { at: Date.now(), v });
  return v;
}

function decidableNow(user: UserInfo, kind: ItemKind, id: string): { ok: true } | { ok: false; reason: Refusal } {
  return runAs(toAuthUser(user), () => {
    if (kind === 'task') {
      // the one task, checked as the route checks it (not a search of the newest tasks)
      const t = visibleTask(id);
      if (!t) return { ok: false, reason: 'gone' };
      if (t.status !== 'open') return { ok: false, reason: 'decided' };
      // select decisions need the items, manual steps the entry and the evidence: in Steward; a start approval of a
      // privileged run (0.14.0) needs the approver's step-up, which Teams cannot show
      if (t.mode !== 'approve' || t.startApproval) return { ok: false, reason: 'needsSteward' };
      if (!t.canDecide) return { ok: false, reason: 'mayNot' };
      if (!botApproved() || !mayDecideInTeams('run.decide')) return { ok: false, reason: 'policy' };
      if (!signedInRecently(user)) return { ok: false, reason: 'signIn' };
      return { ok: true };
    }
    let r;
    try {
      r = getRequest(id);
    } catch {
      return { ok: false, reason: 'gone' };
    }
    if (r.status !== 'pending') return { ok: false, reason: 'decided' };
    // proposals need the comparison; a request with a privileged identity (0.14.0) the approver's step-up
    if (r.mode === 'review' || r.privileged) return { ok: false, reason: 'needsSteward' };
    if (!r.canApprove && !r.canReject) return { ok: false, reason: 'mayNot' };
    if (!botApproved() || !mayDecideInTeams('mcp.write')) return { ok: false, reason: 'policy' };
    if (!signedInRecently(user)) return { ok: false, reason: 'signIn' };
    return { ok: true };
  });
}

/** Whether `user` may see the item at all (card refreshes show its facts only then). */
export function teamsVisible(user: UserInfo, kind: ItemKind, id: string): boolean {
  return runAs(toAuthUser(user), () => {
    if (kind === 'task') return !!visibleTask(id);
    try {
      getRequest(id);
      return true;
    } catch {
      return false; // not found or not readable for this person
    }
  });
}

/** Decides an item from a card, as `user`, with the same checks as in Steward; the version must still match. */
export async function decideFromTeams(
  user: UserInfo,
  item: { kind: ItemKind; id: string },
  verb: Verb,
  version: string,
  comment: string,
  who: TeamsClicker,
): Promise<TeamsOutcome> {
  if (versionOf(item.kind, item.id) !== version) return { ok: false, reason: 'stale' };
  const can = teamsDecidable(user, item.kind, item.id, { fresh: true });
  if (!can.ok) return can;
  const note = comment.trim().slice(0, 500);
  const teams = { tenantId: who.tenantId, aadObjectId: who.aadObjectId, conversationKind: who.conversationKind };
  const au = toAuthUser(user);
  try {
    return await runAs(au, async () => {
      if (item.kind === 'task') {
        const t = visibleTask(item.id)!;
        // the proof records "via teams" (authorizeSignal notes the same point again: the existing proof is kept)
        if (fourEyesRequired('run.decide', t.fourEyes)) noteFourEyes('run.decide', [t.startedBy], au, { itemRequires: t.fourEyes, via: 'teams' });
        authorizeSignal(t.runId, { type: 'task.decide', taskId: item.id });
        await engine().signal(
          t.runId,
          {
            type: 'task.decide',
            taskId: item.id,
            decision: { approved: verb === 'approve', selectedKeys: [], comment: note || undefined, via: 'teams' },
            audit: { via: 'teams', teams },
          },
          au.username,
        );
        return { ok: true, status: verb === 'approve' ? 'approved' : 'rejected' } as const;
      }
      const r = getRequest(item.id);
      if (r.mode === 'fourEyes' && verb === 'approve') noteFourEyes('mcp.write', [r.requestedBy], au, { itemRequires: true, via: 'teams' });
      if (verb === 'approve' ? !r.canApprove : !r.canReject) return { ok: false, reason: 'mayNot' } as const;
      await decideMcpRequest(item.id, { approve: verb === 'approve', comment: note, via: { via: 'teams', teams } });
      return { ok: true, status: verb === 'approve' ? 'approved' : 'rejected' } as const;
    });
  } catch (e) {
    const status = (e as HttpError).statusCode;
    // someone was faster (the exactly-once claim), or the item changed between the check and the write
    if (status === 409) return { ok: false, reason: 'decided' };
    if (status === 403 || status === 404) return { ok: false, reason: 'mayNot' };
    throw e;
  }
}

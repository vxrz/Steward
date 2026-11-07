import type { TaskRecord, UserInfo } from '@sm/shared';
import { db } from '../db.js';
import { runAs } from '../auth/context.js';
import { toAuthUser } from '../auth/users.js';
import { fourEyesRequired, mayDecideInTeams, noteFourEyes } from '../auth/assurance.js';
import { visibleTasks } from '../routes/helpers.js';
import { completeTask } from '../engine/runner.js';
import { decide as decideMcpRequest, getRequest } from '../mcp/requests.js';
import { HttpError } from '../util.js';

/**
 * THE decision entry point of the Teams bot (ADR 0013): `decideFromTeams()` runs as the person who clicked (runAs, no
 * session) and calls exactly what the routes call – for decision steps `visibleTasks`, `canDecide`, four-eyes
 * (`fourEyesRequired` / `noteFourEyes`) and `completeTask`; for MCP requests `decide()` of mcp/requests.ts, which
 * checks `mayApprove`, the expiry and the claim itself. A person who could not decide in Steward cannot decide here.
 *
 * Teams never gets a shortcut: anything that needs a step-up (Teams cannot show one), select decisions, manual steps
 * and their verification, and proposals answer `needsSteward`; a control point whose assurance rule says "not in
 * Microsoft Teams" answers `policy`.
 *
 * At merge time this is the one place to switch to the engine command layer (engine/commands.ts, authorizeSignal).
 */

export type ItemKind = 'task' | 'mcp_request';
export type Verb = 'approve' | 'reject';

export interface TeamsClicker {
  tenantId: string;
  aadObjectId: string;
  conversationKind: string;
}

export type TeamsOutcome =
  { ok: true; status: 'approved' | 'rejected' } | { ok: false; reason: 'gone' | 'stale' | 'mayNot' | 'needsSteward' | 'policy' | 'decided'; message?: string };

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
export function teamsDecidable(
  user: UserInfo,
  kind: ItemKind,
  id: string,
): { ok: true } | { ok: false; reason: 'gone' | 'mayNot' | 'needsSteward' | 'policy' | 'decided' } {
  return runAs(toAuthUser(user), () => {
    if (kind === 'task') {
      const t: TaskRecord | undefined = visibleTasks().find((x) => x.id === id);
      if (!t) return { ok: false, reason: 'gone' };
      if (t.status !== 'open') return { ok: false, reason: 'decided' };
      // select decisions need the items, manual steps the entry and the evidence: in Steward
      if (t.mode !== 'approve') return { ok: false, reason: 'needsSteward' };
      if (!t.canDecide) return { ok: false, reason: 'mayNot' };
      if (!mayDecideInTeams('run.decide')) return { ok: false, reason: 'policy' };
      return { ok: true };
    }
    let r;
    try {
      r = getRequest(id);
    } catch {
      return { ok: false, reason: 'gone' };
    }
    if (r.status !== 'pending') return { ok: false, reason: 'decided' };
    // proposals need the comparison
    if (r.mode === 'review') return { ok: false, reason: 'needsSteward' };
    if (!r.canApprove && !r.canReject) return { ok: false, reason: 'mayNot' };
    if (!mayDecideInTeams('mcp.write')) return { ok: false, reason: 'policy' };
    return { ok: true };
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
  const can = teamsDecidable(user, item.kind, item.id);
  if (!can.ok) return can;
  const note = comment.trim().slice(0, 500);
  const teams = { tenantId: who.tenantId, aadObjectId: who.aadObjectId, conversationKind: who.conversationKind };
  const au = toAuthUser(user);
  try {
    return await runAs(au, async () => {
      if (item.kind === 'task') {
        const t = visibleTasks().find((x) => x.id === item.id)!;
        if (fourEyesRequired('run.decide', t.fourEyes)) noteFourEyes('run.decide', [t.startedBy], au, { itemRequires: t.fourEyes, via: 'teams' });
        await completeTask(item.id, { approved: verb === 'approve', selectedKeys: [], comment: note || undefined, via: 'teams' }, au.username, {
          via: 'teams',
          teams,
        });
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

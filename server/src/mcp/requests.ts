import { z } from 'zod';
import { boundedRecord, MCP_REQUEST_LIMITS, type McpRequest, type McpRequestKind, type McpRequestStatus, type McpWriteMode, type Platform } from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { config } from '../config.js';
import { runAs, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { findUserByName, listUsers, toAuthUser } from '../auth/users.js';
import * as platforms from '../platforms/service.js';
import { getProcess, permissionsFor } from '../processes/service.js';
import { startRun } from '../engine/runner.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { ToolError, cap, defineTool, type ToolContext, type ToolDef } from './tooling.js';
import { executeGatewayCall, writeDecision, type QueryValue } from './gateway.js';
import { mcpRunRequests } from './config.js';
import { me } from '../auth/access.js';

/**
 * Requests of MCP clients that wait for a person in Steward (#11). A changing gateway call (POST, PUT, PATCH, DELETE)
 * and a run never happen when an assistant asks: they become a request. Depending on the platform's setting the token
 * owner confirms it (confirm) or an approver or administrator other than the token owner approves it (fourEyes); runs
 * are confirmed by the token owner and then follow the process's own approval steps. An approved request runs once, as
 * the token owner, with the rights and settings at that moment; a request nobody decided on expires after 24 hours.
 * Every step is in the audit log (entity mcp_request).
 */

interface Row {
  id: string;
  kind: McpRequestKind;
  status: McpRequestStatus | 'approved';
  mode: Exclude<McpWriteMode, 'off'>;
  requested_by: string;
  token_id: string;
  token_name: string;
  reason: string;
  created_at: string;
  expires_at: string;
  platform_id: string | null;
  operation: string | null;
  method: string | null;
  path: string | null;
  path_template: string | null;
  query: string;
  body: string | null;
  process_id: string | null;
  process_name: string | null;
  inputs: string;
  dry_run: number;
  decided_by: string | null;
  decided_at: string | null;
  comment: string;
  executed_at: string | null;
  result_status: number | null;
  result_body: string | null;
  run_id: string | null;
  error: string | null;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const has = (u: AuthUser | null, roles: string[]) => !!u && u.roles.some((r) => roles.includes(r));

/** Whether `u` may use the platform (and so see what is asked of it). */
function usesPlatform(u: AuthUser, platformId: string | null): boolean {
  if (!platformId) return false;
  try {
    return runAs(u, () => platforms.getPlatform(platformId).permissions.includes('use'));
  } catch {
    return false;
  }
}

const isOpen = (r: Row) => r.status === 'pending' && r.expires_at > nowIso();
/** fourEyes: an approver or administrator other than the token owner, who may use the platform */
const secondPerson = (u: AuthUser, r: Row) => !same(u.username, r.requested_by) && (isAdmin(u) || has(u, ['approver'])) && usesPlatform(u, r.platform_id);
const mayApprove = (u: AuthUser, r: Row) => isOpen(r) && (r.mode === 'confirm' ? same(u.username, r.requested_by) : secondPerson(u, r));
const mayReject = (u: AuthUser, r: Row) => isOpen(r) && (same(u.username, r.requested_by) || isAdmin(u) || (r.mode === 'fourEyes' && secondPerson(u, r)));
const mayRead = (u: AuthUser, r: Row) => same(u.username, r.requested_by) || isAdmin(u) || has(u, ['auditor']) || (r.mode === 'fourEyes' && secondPerson(u, r));

function toRequest(r: Row, u: AuthUser): McpRequest {
  return {
    id: r.id,
    kind: r.kind,
    // an approved request runs right away; "approved" is only seen while it does
    status: r.status === 'approved' ? 'pending' : r.status,
    mode: r.mode,
    requestedBy: r.requested_by,
    tokenName: r.token_name,
    reason: r.reason,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    platformId: r.platform_id,
    platformName: r.platform_id ? (platformName(u, r.platform_id) ?? null) : null,
    operation: r.operation,
    method: r.method,
    path: r.path,
    query: parseJson(r.query, {}),
    body: r.body === null ? null : parseJson(r.body, null),
    processId: r.process_id,
    processName: r.process_name,
    inputs: parseJson(r.inputs, {}),
    dryRun: !!r.dry_run,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    comment: r.comment,
    executedAt: r.executed_at,
    resultStatus: r.result_status,
    resultBody: r.result_body === null ? null : parseJson(r.result_body, r.result_body),
    runId: r.run_id,
    error: r.error,
    canApprove: mayApprove(u, r),
    canReject: mayReject(u, r),
  };
}

function platformName(u: AuthUser, id: string): string | undefined {
  try {
    return runAs(u, () => platforms.getPlatform(id).name);
  } catch {
    return undefined;
  }
}

const rowOf = (id: string) => db().get<Row>('SELECT * FROM mcp_requests WHERE id = ?', id);

/** Requests nobody decided on in time expire (audited once each). */
export function expireRequests(now = nowIso()): number {
  const rows = db().all<Row>("SELECT * FROM mcp_requests WHERE status = 'pending' AND expires_at <= ? LIMIT 500", now);
  for (const r of rows) {
    if (db().run("UPDATE mcp_requests SET status = 'expired' WHERE id = ? AND status = 'pending'", r.id).changes !== 1) continue;
    audit({
      actor: 'system',
      action: 'mcp.request_expired',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `Request of ${r.requested_by}'s AI assistant expired without a decision: ${describe(r)}`,
      details: { kind: r.kind, requestedBy: r.requested_by, platformId: r.platform_id, processId: r.process_id },
    });
  }
  return rows.length;
}

const describe = (r: Pick<Row, 'kind' | 'method' | 'path' | 'process_name' | 'dry_run'>) =>
  r.kind === 'gateway' ? `${r.method} ${r.path}` : `run "${r.process_name}"${r.dry_run ? ' (dry run)' : ''}`;

/** The people who decide a request: the token owner (confirm), or every second person (fourEyes). */
function deciders(r: Row) {
  if (r.mode === 'confirm') return listUsers().filter((x) => x.active && same(x.username, r.requested_by));
  return listUsers().filter((x) => x.active && secondPerson(toAuthUser(x), r));
}

function notifyDeciders(r: Row): void {
  void import('../notifications/service.js')
    .then(({ notify }) => {
      const what = describe(r);
      notify({
        event: 'mcp.request',
        recipients: deciders(r),
        text: (locale) =>
          locale === 'de'
            ? {
                title: `KI-Assistent von ${r.requested_by}: ${r.mode === 'confirm' ? 'Bitte bestätigen' : 'Freigabe nötig'}`,
                body: `Der KI-Assistent (Token „${r.token_name}") möchte: ${what}. Begründung des Assistenten: ${r.reason}. Entscheiden Sie in Steward unter KI-Anfragen; ohne Entscheidung verfällt die Anfrage nach ${MCP_REQUEST_LIMITS.expiryHours} Stunden.`,
              }
            : {
                title: `${r.requested_by}'s AI assistant: ${r.mode === 'confirm' ? 'please confirm' : 'approval needed'}`,
                body: `The AI assistant (token "${r.token_name}") wants to: ${what}. The assistant's reason: ${r.reason}. Decide in Steward under AI requests; without a decision the request expires after ${MCP_REQUEST_LIMITS.expiryHours} hours.`,
              },
        link: `/mcp-requests/${r.id}`,
        ...(r.platform_id ? { about: { kind: 'platform' as const, id: r.platform_id } } : {}),
        inAppKey: r.id,
        externalKey: `mcp-request:${r.id}`,
        data: { requestId: r.id, kind: r.kind },
      });
    })
    .catch((err) => logger.warn({ err }, 'could not notify about an MCP request'));
}

function insert(r: Row): void {
  db().tx(() => {
    db().run(
      `INSERT INTO mcp_requests (id, kind, status, mode, requested_by, token_id, token_name, reason, created_at, expires_at, platform_id, operation, method, path,
         path_template, query, body, process_id, process_name, inputs, dry_run)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.kind,
      r.mode,
      r.requested_by,
      r.token_id,
      r.token_name,
      r.reason,
      r.created_at,
      r.expires_at,
      r.platform_id,
      r.operation,
      r.method,
      r.path,
      r.path_template,
      r.query,
      r.body,
      r.process_id,
      r.process_name,
      r.inputs,
      r.dry_run,
    );
    audit({
      action: 'mcp.request_created',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `${r.requested_by}'s AI assistant (token "${r.token_name}") asks to ${describe(r)} – ${r.mode === 'confirm' ? 'the token owner confirms' : 'a second person approves'}`,
      details: {
        kind: r.kind,
        mode: r.mode,
        tokenId: r.token_id,
        platformId: r.platform_id,
        method: r.method,
        pathTemplate: r.path_template,
        processId: r.process_id,
        dryRun: !!r.dry_run,
        reason: r.reason.slice(0, 500),
      },
    });
  });
  notifyDeciders(r);
}

function base(ctx: ToolContext, kind: McpRequestKind, mode: Row['mode'], reason: string): Row {
  expireRequests();
  const open = Number(
    db().get<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_requests WHERE requested_by = ? AND status = 'pending'", ctx.principal.user.username)?.n ?? 0,
  );
  if (open >= MCP_REQUEST_LIMITS.pendingPerUser)
    throw new ToolError(`${open} requests are waiting for a decision already – wait until they are decided (or ask the user to withdraw some in Steward)`);
  const created = new Date();
  return {
    id: newId('mrq_'),
    kind,
    status: 'pending',
    mode,
    requested_by: ctx.principal.user.username,
    token_id: ctx.principal.tokenId,
    token_name: ctx.principal.tokenName,
    reason: reason.trim().slice(0, MCP_REQUEST_LIMITS.reason),
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + MCP_REQUEST_LIMITS.expiryHours * 3_600_000).toISOString(),
    platform_id: null,
    operation: null,
    method: null,
    path: null,
    path_template: null,
    query: '{}',
    body: null,
    process_id: null,
    process_name: null,
    inputs: '{}',
    dry_run: 0,
    decided_by: null,
    decided_at: null,
    comment: '',
    executed_at: null,
    result_status: null,
    result_body: null,
    run_id: null,
    error: null,
  };
}

/** What an assistant is told about its new request. */
const created = (r: Row) => ({
  status: 'pending',
  requestId: r.id,
  needs: r.mode === 'confirm' ? 'the token owner confirms it in Steward' : 'an approver or administrator other than the token owner approves it in Steward',
  expiresAt: r.expires_at,
  decideAt: `${(config.publicUrl ?? '').replace(/\/$/, '')}${config.basePath ?? ''}/mcp-requests/${r.id}`,
  note: 'Nothing has been changed yet. Tell the user that the request waits for a decision in Steward, and check the outcome later with get_operation_request.',
});

/** A changing gateway call (validated by the gateway tool) becomes a request. */
export function createGatewayRequest(
  ctx: ToolContext,
  p: Platform,
  c: { operation: string | null; method: string; path: string; pathTemplate: string; query: Record<string, QueryValue>; body: unknown; reason: string },
) {
  const d = writeDecision(p, c);
  if (!d.allowed) throw new ToolError(d.reason);
  if (!c.reason.trim()) throw new ToolError('Give `reason`: why this change is needed – the person who decides sees it');
  const r = base(ctx, 'gateway', d.mode as Row['mode'], c.reason);
  Object.assign(r, {
    platform_id: p.id,
    operation: c.operation,
    method: c.method,
    path: c.path,
    path_template: c.pathTemplate,
    query: JSON.stringify(c.query ?? {}),
    body: c.body === undefined ? null : JSON.stringify(c.body),
  });
  insert(r);
  return created(r);
}

/** An assistant asks to start a run (instance setting "run requests"); the token owner confirms it. */
export function createRunRequest(ctx: ToolContext, a: { processId: string; inputs?: Record<string, unknown>; dryRun?: boolean; reason: string }) {
  if (!mcpRunRequests()) throw new ToolError('Starting runs is not available through MCP on this Steward (an administrator can allow run requests)');
  let proc;
  try {
    proc = getProcess(a.processId);
  } catch {
    proc = null;
  }
  if (!proc || !permissionsFor(a.processId).includes('view')) throw new ToolError(`Process ${a.processId} not found`);
  if (!permissionsFor(a.processId).includes('run')) throw new ToolError(`You may not run "${proc.name}"`);
  const secret = (proc.definition.inputs ?? []).filter((i) => i.type === 'secret' && a.inputs && a.inputs[i.name] !== undefined).map((i) => i.name);
  if (secret.length) throw new ToolError(`Secret inputs (${secret.join(', ')}) cannot be given through MCP – start this run in Steward`);
  const r = base(ctx, 'run', 'confirm', a.reason);
  Object.assign(r, { process_id: proc.id, process_name: proc.name, inputs: JSON.stringify(a.inputs ?? {}), dry_run: a.dryRun ? 1 : 0 });
  insert(r);
  return created(r);
}

/** The assistant's view of one of its own requests. */
export function requestForAssistant(ctx: ToolContext, id: string) {
  expireRequests();
  const r = rowOf(id);
  if (!r || !same(r.requested_by, ctx.principal.user.username)) throw new ToolError(`Request ${id} not found`);
  return {
    requestId: r.id,
    kind: r.kind,
    status: r.status === 'approved' ? 'running' : r.status,
    what: describe(r),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    comment: r.comment || null,
    executedAt: r.executed_at,
    resultStatus: r.result_status,
    result: r.result_body === null ? null : parseJson(r.result_body, r.result_body),
    runId: r.run_id,
    error: r.error,
  };
}

// ---------- the web app ----------

export function listRequests(scope: 'mine' | 'decide' | 'all'): McpRequest[] {
  expireRequests();
  const u = me();
  const rows =
    scope === 'mine'
      ? db().all<Row>('SELECT * FROM mcp_requests WHERE lower(requested_by) = lower(?) ORDER BY created_at DESC LIMIT 200', u.username)
      : db().all<Row>(`SELECT * FROM mcp_requests ${scope === 'decide' ? "WHERE status = 'pending'" : ''} ORDER BY created_at DESC LIMIT 500`);
  return rows
    .filter((r) => mayRead(u, r) && (scope !== 'decide' || mayApprove(u, r)))
    .slice(0, 200)
    .map((r) => toRequest(r, u));
}

export function getRequest(id: string): McpRequest {
  expireRequests();
  const u = me();
  const r = rowOf(id);
  if (!r || !mayRead(u, r)) throw new HttpError(404, `Request ${id} not found`, 'MCP_REQUEST_NOT_FOUND', { id });
  return toRequest(r, u);
}

/** Approve (runs it now, once, as the token owner) or reject a request. */
export async function decide(id: string, input: { approve: boolean; comment: string }): Promise<McpRequest> {
  expireRequests();
  const u = me();
  const r = rowOf(id);
  if (!r || !mayRead(u, r)) throw new HttpError(404, `Request ${id} not found`, 'MCP_REQUEST_NOT_FOUND', { id });
  const comment = input.comment.trim().slice(0, MCP_REQUEST_LIMITS.comment);
  if (!isOpen(r)) throw new HttpError(409, 'The request is no longer open', 'MCP_REQUEST_DECIDE');
  if (!input.approve) {
    if (!mayReject(u, r)) throw new HttpError(409, 'The request is no longer open, or you may not decide it', 'MCP_REQUEST_DECIDE');
    const own = same(u.username, r.requested_by);
    const status = own ? 'withdrawn' : 'rejected';
    db().tx(() => {
      if (
        db().run(
          `UPDATE mcp_requests SET status = ?, decided_by = ?, decided_at = ?, comment = ? WHERE id = ? AND status = 'pending'`,
          status,
          u.username,
          nowIso(),
          comment,
          id,
        ).changes !== 1
      )
        throw new HttpError(409, 'The request is no longer open', 'MCP_REQUEST_DECIDE');
      audit({
        action: own ? 'mcp.request_withdrawn' : 'mcp.request_rejected',
        entityType: 'mcp_request',
        entityId: id,
        summary: `${own ? 'Withdrawn' : 'Rejected'}: ${describe(r)} (asked by ${r.requested_by}'s AI assistant)${comment ? ` – ${comment.slice(0, 200)}` : ''}`,
        details: { kind: r.kind, mode: r.mode, requestedBy: r.requested_by, comment },
      });
    });
    return getRequest(id);
  }
  if (!mayApprove(u, r))
    throw new HttpError(
      403,
      r.mode === 'confirm' ? 'Only the token owner confirms this request' : 'An approver or administrator other than the token owner approves this request',
      'MCP_REQUEST_APPROVE',
    );
  // claim it: whoever gets here first runs it, exactly once
  const at = nowIso();
  if (
    db().run(
      "UPDATE mcp_requests SET status = 'approved', decided_by = ?, decided_at = ?, comment = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
      u.username,
      at,
      comment,
      id,
      at,
    ).changes !== 1
  )
    throw new HttpError(409, 'The request is no longer open', 'MCP_REQUEST_DECIDE');
  audit({
    action: 'mcp.request_approved',
    entityType: 'mcp_request',
    entityId: id,
    summary: `${r.mode === 'confirm' ? 'Confirmed' : 'Approved'}: ${describe(r)} (asked by ${r.requested_by}'s AI assistant)${comment ? ` – ${comment.slice(0, 200)}` : ''}`,
    details: { kind: r.kind, mode: r.mode, requestedBy: r.requested_by, comment },
  });
  const outcome = await execute(r);
  db().run(
    'UPDATE mcp_requests SET status = ?, executed_at = ?, result_status = ?, result_body = ?, run_id = ?, error = ? WHERE id = ?',
    outcome.error ? 'failed' : 'done',
    nowIso(),
    outcome.status ?? null,
    outcome.body === undefined ? null : JSON.stringify(outcome.body).slice(0, MCP_REQUEST_LIMITS.resultChars + 2000),
    outcome.runId ?? null,
    outcome.error ?? null,
    id,
  );
  audit({
    actor: r.requested_by,
    action: 'mcp.request_executed',
    entityType: 'mcp_request',
    entityId: id,
    summary: `${describe(r)} for ${r.requested_by}'s AI assistant: ${outcome.error ? `failed – ${outcome.error.slice(0, 200)}` : outcome.runId ? `run ${outcome.runId} started` : `HTTP ${outcome.status}`}`,
    details: { kind: r.kind, approvedBy: u.username, status: outcome.status ?? null, runId: outcome.runId ?? null, error: outcome.error ?? null },
  });
  return getRequest(id);
}

/** Runs an approved request as the token owner, with the rights and settings of now. */
async function execute(r: Row): Promise<{ status?: number; body?: unknown; runId?: string; error?: string }> {
  const owner = findUserByName(r.requested_by);
  if (!owner || !owner.active) return { error: `The token owner ${r.requested_by} is no longer active` };
  const asOwner = toAuthUser(owner);
  try {
    return await runAs(asOwner, async () => {
      if (r.kind === 'run') {
        if (!mcpRunRequests()) return { error: 'Run requests were turned off in the meantime' };
        if (!permissionsFor(r.process_id!).includes('run')) return { error: `${r.requested_by} may no longer run this process` };
        const runId = await startRun({ processId: r.process_id!, inputs: parseJson(r.inputs, {}), dryRun: !!r.dry_run }, { actor: r.requested_by });
        return { runId };
      }
      let p: Platform;
      try {
        p = platforms.getPlatform(r.platform_id!);
      } catch {
        return { error: 'The platform is gone, or the token owner may no longer use it' };
      }
      if (!p.config.mcpGateway?.enabled || !p.permissions.includes('use'))
        return { error: 'The MCP gateway of the platform was turned off, or the token owner may no longer use it' };
      const now = p.config.mcpGateway.writes ?? 'off';
      if (now === 'off') return { error: 'Changing calls through MCP were turned off for this platform in the meantime' };
      if (now === 'fourEyes' && r.mode === 'confirm') return { error: 'The platform now needs a second person to approve changing calls – ask again' };
      const query = parseJson<Record<string, QueryValue>>(r.query, {});
      const res = await executeGatewayCall(
        p,
        { actor: r.requested_by, tokenId: r.token_id, tokenName: r.token_name, requestId: r.id },
        owner.id,
        {
          op: null,
          operationRef: r.operation,
          method: r.method!,
          path: r.path!,
          pathTemplate: r.path_template ?? r.path!,
          query,
          queryNames: Object.keys(query),
          ...(r.body !== null ? { body: parseJson(r.body, null) } : {}),
        },
        AbortSignal.timeout(60_000),
      );
      return { status: res.status, body: cap(res.body, { maxString: 4000, maxArray: 50, maxDepth: 8 }) };
    });
  } catch (e) {
    return { error: (e as Error).message.slice(0, 1000) };
  }
}

// ---------- the tools (#11) ----------

export const requestTools: ToolDef[] = [
  defineTool({
    name: 'get_operation_request',
    title: 'Check a request waiting for approval',
    description:
      'The state of one of your requests (from platform_call_operation with a changing operation, or request_run): pending, done (with the HTTP status and the response, or the run id), failed (with the reason), rejected, withdrawn or expired. Nothing runs until a person decides in Steward.',
    input: z.object({ requestId: z.string().min(1).max(100).describe('`requestId` from the answer to your request') }).strict(),
    visible: () => true,
    handler: (a, ctx) => requestForAssistant(ctx, a.requestId),
  }),
  defineTool({
    name: 'request_run',
    title: 'Ask to start a run',
    description:
      'Asks to start a run of a process you may run. Nothing starts until the token owner confirms it in Steward; then the run follows the process with its own approval steps. Give `reason`. Secret inputs cannot be given here. You get a `requestId` – tell the user and check the outcome later with get_operation_request.',
    input: z
      .object({
        processId: z.string().min(1).max(200).describe('Process id (from search_processes)'),
        inputs: boundedRecord(z.unknown(), 100).optional().describe('Input values by name (see get_process)'),
        dryRun: z.boolean().default(false).describe('A dry run: changing platform calls are skipped'),
        reason: z.string().trim().min(5).max(MCP_REQUEST_LIMITS.reason).describe('Why, in one or two sentences – the token owner sees it'),
      })
      .strict(),
    visible: () => mcpRunRequests(),
    asks: true,
    handler: (a, ctx) => createRunRequest(ctx, a),
  }),
];

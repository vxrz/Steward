import { z } from 'zod';
import {
  boundedRecord,
  MCP_REQUEST_LIMITS,
  type McpCatalogueProposal,
  type McpMappingsProposal,
  type McpPlantProposal,
  type McpProposalSummary,
  type McpProposalSelection,
  type McpRequest,
  type McpRequestKind,
  type McpRequestStatus,
  type McpWriteMode,
  type Platform,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { logger } from '../log.js';
import { config } from '../config.js';
import { runAs, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { noteFourEyes, samePerson } from '../auth/assurance.js';
import { findUserByName, listUsers, toAuthUser } from '../auth/users.js';
import * as platforms from '../platforms/service.js';
import { assertPrivilegedConfirmed, isPrivileged, type PrivilegedUse } from '../platforms/privileged.js';
import { getProcess } from '../processes/service.js';
import { engine } from '../engine/index.js';
import { startProblem } from '../engine/commands.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { ToolError, cap, defineTool, type ToolContext, type ToolDef } from './tooling.js';
import { executeGatewayCall, writeDecision, type GatewayPlatform, type QueryValue } from './gateway.js';
import { mcpRunRequests } from './config.js';
import { t } from '../i18n/index.js';
import { mcpCardParts } from '../msteams/cards.js';
import { mcpSettled } from '../msteams/followup.js';
import { me, hasRole } from '../auth/access.js';

/**
 * Requests of MCP clients that wait for a person in Steward (#11). A changing gateway call (POST, PUT, PATCH, DELETE)
 * and a run never happen when an assistant asks: they become a request. Depending on the platform's setting the token
 * owner confirms it (confirm) or an approver or administrator other than the token owner approves it (fourEyes); runs
 * are confirmed by the token owner and then follow the process's own approval steps. An approved request runs once, as
 * the token owner, with the rights and settings at that moment; a request nobody decided on expires after 24 hours.
 * Every step is in the audit log (entity mcp_request).
 */

export interface Row {
  id: string;
  kind: McpRequestKind;
  status: McpRequestStatus | 'approved';
  mode: Exclude<McpWriteMode, 'off'> | 'review';
  requested_by: string;
  token_id: string;
  token_name: string;
  reason: string;
  created_at: string;
  expires_at: string;
  platform_id: string | null;
  /** The platform identity of a gateway request (0.13.0, ADR 0009); null: the default identity */
  identity_id?: string | null;
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
  /** Proposals (#74): the proposed catalogue or mappings (JSON) */
  payload: string | null;
  /** 0.10.0 (ADR 0013): 'teams' when decided in a Microsoft Teams card */
  decided_via?: string | null;
}

/**
 * Proposals an assistant makes for a person to review (#74: control catalogues and mappings). The module that owns
 * the kind says who may accept, how the reviewer sees it and what accepting does; the inbox, expiry, notifications
 * and audit trail are the same as for other requests.
 */
export interface ReviewKind {
  /** Who may accept (and see) it */
  mayAccept: (u: AuthUser, r: Row) => boolean;
  /** Who is told about a new proposal */
  deciders: (r: Row) => UserInfo[];
  /** One line for the audit log and notifications */
  describe: (r: Row) => string;
  /** What the proposal is about, for lists (cheap: no comparison, no lookups) */
  summary: (r: Row) => McpProposalSummary;
  view: (r: Row, u: AuthUser) => McpCatalogueProposal | McpMappingsProposal | McpPlantProposal;
  /** Applies what the reviewer accepted, as the reviewer; the result is stored with the request */
  apply: (r: Row, selection: McpProposalSelection | undefined, u: AuthUser) => { body: unknown; error?: string };
  /**
   * 0.12.0: checked as the reviewer before the request is claimed – a refusal (an HttpError) leaves the request open,
   * for example when what it would apply changed since it was proposed and the reviewer has not confirmed that
   */
  precheck?: (r: Row, selection: McpProposalSelection | undefined, u: AuthUser) => void;
  /** 0.12.0: called in the transaction that rejects or withdraws it (an audit entry of the module, for example) */
  onRejected?: (r: Row, u: AuthUser, o: { withdrawn: boolean; comment: string }) => void;
  /** 0.17.0: called when it expired without a decision (what an unfinished proposal kept can go, for example) */
  onExpired?: (r: Row) => void;
}
const REVIEW_KINDS = new Map<McpRequestKind, ReviewKind>();
export function registerReviewKind(kind: McpRequestKind, def: ReviewKind): void {
  REVIEW_KINDS.set(kind, def);
}
const reviewOf = (r: Row) => (r.mode === 'review' ? REVIEW_KINDS.get(r.kind) : undefined);
/** A proposal whose assistant is still sending parts (read once per row: payloads can be large) */
const incompleteOf = new WeakMap<Row, boolean>();
const incomplete = (r: Row): boolean => {
  if (r.mode !== 'review') return false;
  let v = incompleteOf.get(r);
  if (v === undefined) incompleteOf.set(r, (v = !!parseJson<{ incomplete?: boolean }>(r.payload, {}).incomplete));
  return v;
};

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Whether `u` may use the platform (and so see what is asked of it) – and the request's identity (0.13.0, ADR 0009). */
function usesPlatform(u: AuthUser, platformId: string | null, identityId?: string | null): boolean {
  if (!platformId) return false;
  try {
    return runAs(u, () => {
      const p = platforms.getPlatform(platformId);
      if (!p.permissions.includes('use')) return false;
      const i = identityId ? p.identities?.find((x) => x.id === identityId) : p.identities?.find((x) => x.default);
      return !p.identities?.length || !!i?.mayUse;
    });
  } catch {
    return false;
  }
}

const isOpen = (r: Row) => r.status === 'pending' && r.expires_at > nowIso();
/** fourEyes: an approver or administrator other than the token owner, who may use the platform */
// (by identity: former names and a linked single sign-on identity are the token owner too, auth/assurance.ts)
const secondPerson = (u: AuthUser, r: Row) =>
  !samePerson(r.requested_by, u) && (isAdmin(u) || hasRole(u, ['approver'])) && usesPlatform(u, r.platform_id, r.identity_id);
const mayApprove = (u: AuthUser, r: Row) => {
  if (!isOpen(r)) return false;
  const review = reviewOf(r);
  if (r.mode === 'review') return !!review && !incomplete(r) && review.mayAccept(u, r);
  return r.mode === 'confirm' ? same(u.username, r.requested_by) : secondPerson(u, r);
};
const mayReject = (u: AuthUser, r: Row) =>
  isOpen(r) &&
  (same(u.username, r.requested_by) || isAdmin(u) || (r.mode === 'fourEyes' && secondPerson(u, r)) || (r.mode === 'review' && !!reviewOf(r)?.mayAccept(u, r)));
const mayRead = (u: AuthUser, r: Row) =>
  same(u.username, r.requested_by) ||
  isAdmin(u) ||
  hasRole(u, ['auditor']) ||
  (r.mode === 'fourEyes' && secondPerson(u, r)) ||
  (r.mode === 'review' && !!reviewOf(r)?.mayAccept(u, r));

/** The request as `u` sees it; lists leave out a proposal's comparison (the detail has it). */
function toRequest(r: Row, u: AuthUser, detail = true): McpRequest {
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
    ...(privilegedRequest(r) ? { privileged: true } : {}),
    platformId: r.platform_id,
    platformName: r.platform_id ? (platformName(u, r.platform_id) ?? null) : null,
    identityId: r.identity_id ?? null,
    identityName: r.platform_id && r.identity_id ? (identityName(u, r.platform_id, r.identity_id) ?? null) : null,
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
    decidedVia: r.decided_via === 'teams' ? 'teams' : null,
    comment: r.comment,
    executedAt: r.executed_at,
    resultStatus: r.result_status,
    resultBody: r.result_body === null ? null : parseJson(r.result_body, r.result_body),
    runId: r.run_id,
    error: r.error,
    proposal: detail ? (reviewOf(r)?.view(r, u) ?? null) : null,
    proposalSummary: reviewOf(r)?.summary(r) ?? null,
    canApprove: mayApprove(u, r),
    canReject: mayReject(u, r),
  };
}

/**
 * A gateway request whose identity is privileged now (0.14.0, ADR 0009 step 4): approving it needs the approver's step-up
 * (platform.privilegedIdentity) and is never done in Microsoft Teams.
 */
export function privilegedRequest(r: Pick<Row, 'kind' | 'platform_id' | 'identity_id'>): boolean {
  return r.kind === 'gateway' && !!r.platform_id && isPrivileged(r.platform_id, r.identity_id);
}

/** What approving this request (by id) uses of a privileged identity – the decision route asks for the step-up. */
export function privilegedUsesOf(id: string, approve: unknown): PrivilegedUse[] {
  if (approve !== true) return [];
  const r = rowOf(id);
  if (!r || !privilegedRequest(r)) return [];
  const name = db().get<{ name: string }>('SELECT name FROM platform_identities WHERE id = ?', r.identity_id)?.name ?? r.identity_id ?? '';
  const platform = db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', r.platform_id)?.name ?? r.platform_id!;
  return [{ platformId: r.platform_id!, platformName: platform, identityId: r.identity_id ?? '', identityName: name }];
}

function identityName(u: AuthUser, platformId: string, identityId: string): string | undefined {
  try {
    return runAs(u, () => platforms.getPlatform(platformId).identities?.find((i) => i.id === identityId)?.name);
  } catch {
    return undefined;
  }
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
    reviewOf(r)?.onExpired?.(r);
    audit({
      actor: 'system',
      action: 'mcp.request_expired',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `Request of ${r.requested_by}'s AI assistant expired without a decision: ${describe(r)}`,
      details: { kind: r.kind, requestedBy: r.requested_by, platformId: r.platform_id, processId: r.process_id },
    });
    settledLater(r.id, { status: 'expired', at: now });
  }
  return rows.length;
}

const describe = (r: Row) =>
  r.mode === 'review'
    ? (reviewOf(r)?.describe(r) ?? r.kind)
    : r.kind === 'gateway'
      ? `${r.method} ${r.path}`
      : `run "${r.process_name}"${r.dry_run ? ' (dry run)' : ''}`;

/** The people who decide a request: the token owner (confirm), or every second person (fourEyes). */
function deciders(r: Row) {
  if (r.mode === 'review') return reviewOf(r)?.deciders(r) ?? [];
  if (r.mode === 'confirm') return listUsers().filter((x) => x.active && same(x.username, r.requested_by));
  return listUsers().filter((x) => x.active && secondPerson(toAuthUser(x), r));
}

function notifyDeciders(r: Row): void {
  void import('../notifications/service.js')
    .then(({ notify }) => {
      const what = describe(r);
      const review = r.mode === 'review';
      const expiry = review ? `${MCP_REQUEST_LIMITS.proposalExpiryDays} days` : `${MCP_REQUEST_LIMITS.expiryHours} hours`;
      const expiryDe = review ? `${MCP_REQUEST_LIMITS.proposalExpiryDays} Tagen` : `${MCP_REQUEST_LIMITS.expiryHours} Stunden`;
      const platformName = r.platform_id ? (db().get<{ name: string }>('SELECT name FROM platforms WHERE id = ?', r.platform_id)?.name ?? null) : null;
      notify({
        event: 'mcp.request',
        recipients: deciders(r),
        // a person reads the assistant's reason; a channel card only what is decided (ADR 0013: never bodies or values)
        personal: true,
        text: (locale, u) => {
          const parts = mcpCardParts(locale, { ...r, platformName });
          if (!u)
            return {
              title: t(locale, 'teamsCard.mcpTitle', {
                user: r.requested_by,
                what: r.kind === 'gateway' ? `${r.method ?? ''} ${r.path_template ?? ''}`.trim() : (r.process_name ?? ''),
              }),
              body: t(locale, 'teamsCard.mcpChannelBody'),
              parts,
            };
          return locale === 'de'
            ? {
                title: `KI-Assistent von ${r.requested_by}: ${review ? 'Vorschlag zur Prüfung' : r.mode === 'confirm' ? 'Bitte bestätigen' : 'Freigabe nötig'}`,
                body: `Der KI-Assistent (Token „${r.token_name}") ${review ? 'schlägt vor' : 'möchte'}: ${what}. Begründung des Assistenten: ${r.reason}. ${review ? 'Prüfen' : 'Entscheiden'} Sie in Steward unter KI-Anfragen; ohne Entscheidung verfällt die Anfrage nach ${expiryDe}.`,
                parts,
              }
            : {
                title: `${r.requested_by}'s AI assistant: ${review ? 'a proposal to review' : r.mode === 'confirm' ? 'please confirm' : 'approval needed'}`,
                body: `The AI assistant (token "${r.token_name}") ${review ? 'proposes' : 'wants to'}: ${what}. The assistant's reason: ${r.reason}. ${review ? 'Review it' : 'Decide'} in Steward under AI requests; without a decision the request expires after ${expiry}.`,
                parts,
              };
        },
        link: `/mcp-requests/${r.id}`,
        ...(r.platform_id ? { about: { kind: 'platform' as const, id: r.platform_id } } : {}),
        inAppKey: r.id,
        externalKey: `mcp-request:${r.id}`,
        data: { requestId: r.id, kind: r.kind },
        // quiet hours (ADR 0012): a request that would expire inside them breaks through
        expiresAt: r.expires_at,
        decision: { kind: 'mcp_request', id: r.id },
      });
    })
    .catch((err) => logger.warn({ err }, 'could not notify about an MCP request'));
}

function insert(r: Row): void {
  db().tx(() => {
    db().run(
      `INSERT INTO mcp_requests (id, kind, status, mode, requested_by, token_id, token_name, reason, created_at, expires_at, platform_id, operation, method, path,
         path_template, query, body, process_id, process_name, inputs, dry_run, payload, identity_id)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      r.payload,
      r.identity_id ?? null,
    );
    audit({
      action: 'mcp.request_created',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `${r.requested_by}'s AI assistant (token "${r.token_name}") ${r.mode === 'review' ? 'proposes' : 'asks to'} ${describe(r)} – ${r.mode === 'review' ? 'a person reviews it' : r.mode === 'confirm' ? 'the token owner confirms' : 'a second person approves'}`,
      details: {
        kind: r.kind,
        mode: r.mode,
        tokenId: r.token_id,
        platformId: r.platform_id,
        ...(r.identity_id ? { identityId: r.identity_id } : {}),
        method: r.method,
        pathTemplate: r.path_template,
        processId: r.process_id,
        dryRun: !!r.dry_run,
        reason: r.reason.slice(0, 500),
      },
    });
  });
  if (!incomplete(r)) notifyDeciders(r);
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
    expires_at: new Date(
      created.getTime() + (mode === 'review' ? MCP_REQUEST_LIMITS.proposalExpiryDays * 24 : MCP_REQUEST_LIMITS.expiryHours) * 3_600_000,
    ).toISOString(),
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
    payload: null,
  };
}

/** What an assistant is told about its new request. */
const created = (r: Row) => ({
  status: 'pending',
  requestId: r.id,
  needs:
    r.mode === 'review'
      ? 'a person reviews it in Steward, may edit it, and accepts all or parts'
      : r.mode === 'confirm'
        ? 'the token owner confirms it in Steward'
        : 'an approver or administrator other than the token owner approves it in Steward',
  expiresAt: r.expires_at,
  decideAt: `${(config.publicUrl ?? '').replace(/\/$/, '')}${config.basePath ?? ''}/mcp-requests/${r.id}`,
  note: 'Nothing has been changed yet. Tell the user that the request waits for a decision in Steward, and check the outcome later with get_operation_request.',
});

/** Proposals are kept small enough for the reviewers' inbox: per proposal and over all open proposals of one person. */
function checkProposalSize(r: Row): void {
  const size = Buffer.byteLength(r.payload ?? '');
  if (size > MCP_REQUEST_LIMITS.proposalBytes)
    throw new ToolError(
      `The proposal is too large (${Math.ceil(size / 1024)} KB, at most ${MCP_REQUEST_LIMITS.proposalBytes / 1024} KB) – split it into several proposals`,
    );
  const others = Number(
    db().get<{ n: number | null }>(
      "SELECT SUM(LENGTH(payload)) AS n FROM mcp_requests WHERE requested_by = ? AND status = 'pending' AND mode = 'review' AND id <> ?",
      r.requested_by,
      r.id,
    )?.n ?? 0,
  );
  if (others + size > MCP_REQUEST_LIMITS.proposalBytesPerUser)
    throw new ToolError('Your open proposals are too large together – wait until some are decided (or ask the user to withdraw some in Steward)');
}

/** A proposal for review (#74): a new request, or the next part of the assistant's own proposal that is still incomplete. */
export function saveProposal(
  ctx: ToolContext,
  kind: McpRequestKind,
  o: { proposalId?: string; reason?: string; payload: (prev: unknown) => { incomplete: boolean } & Record<string, unknown> },
) {
  if (!o.proposalId) {
    if (!o.reason?.trim()) throw new ToolError('Give `reason`: what the proposal is and where it comes from – the reviewer sees it');
    const r = base(ctx, kind, 'review', o.reason);
    r.payload = JSON.stringify(o.payload(null));
    checkProposalSize(r);
    insert(r);
    return { ...created(r), complete: !incomplete(r) };
  }
  expireRequests();
  const r = rowOf(o.proposalId);
  if (!r || r.kind !== kind || !same(r.requested_by, ctx.principal.user.username) || r.status !== 'pending')
    throw new ToolError(`Proposal ${o.proposalId} not found, or it is no longer open`);
  if (!incomplete(r)) throw new ToolError(`Proposal ${o.proposalId} is complete already – start a new proposal for further changes`);
  const next = o.payload(parseJson(r.payload, null));
  r.payload = JSON.stringify(next);
  checkProposalSize(r);
  db().run("UPDATE mcp_requests SET payload = ? WHERE id = ? AND status = 'pending'", r.payload, r.id);
  if (!next.incomplete) {
    audit({
      action: 'mcp.proposal_completed',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `${r.requested_by}'s AI assistant completed its proposal: ${describe(r)}`,
      details: { kind: r.kind },
    });
    notifyDeciders(r);
  }
  return { ...created(r), complete: !next.incomplete };
}

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
    // the identity of the call (0.13.0, ADR 0009): approval re-checks its rights, mode and flags
    identity_id: (p as GatewayPlatform).mcpIdentity?.id ?? null,
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
  // the command layer's start check (ADR 0011); asked again at approval time, with the rights of then
  const problem = proc ? startProblem(undefined, { processId: a.processId }) : null;
  if (!proc || problem?.code === 'processNotFound') throw new ToolError(`Process ${a.processId} not found`);
  if (problem) throw new ToolError(`You may not run "${proc.name}"`);
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
    .map((r) => toRequest(r, u, false));
}

export function getRequest(id: string): McpRequest {
  expireRequests();
  const u = me();
  const r = rowOf(id);
  if (!r || !mayRead(u, r)) throw new HttpError(404, `Request ${id} not found`, 'MCP_REQUEST_NOT_FOUND', { id });
  return toRequest(r, u);
}

/** Where a decision was taken: Microsoft Teams (ADR 0013), with who clicked there (never a session). */
export interface DecidedVia {
  via: 'teams';
  teams: { tenantId: string; aadObjectId: string; conversationKind: string };
}

/** The outcome follows the decision cards (ADR 0013), outside the deciding step. */
function settledLater(id: string, o: Parameters<typeof mcpSettled>[1]): void {
  setImmediate(() => {
    try {
      mcpSettled(id, o);
    } catch (err) {
      logger.warn({ err, id }, 'decision follow-up failed');
    }
  });
}

/**
 * Approve (runs it now, once, as the token owner – a proposal is applied as the reviewer) or reject a request. The one
 * way to decide: the route and the Teams bot (msteams/decide.ts) both come here.
 */
export async function decide(
  id: string,
  input: { approve: boolean; comment: string; selection?: McpProposalSelection; via?: DecidedVia },
): Promise<McpRequest> {
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
          `UPDATE mcp_requests SET status = ?, decided_by = ?, decided_at = ?, comment = ?, decided_via = ? WHERE id = ? AND status = 'pending'`,
          status,
          u.username,
          nowIso(),
          comment,
          input.via?.via ?? null,
          id,
        ).changes !== 1
      )
        throw new HttpError(409, 'The request is no longer open', 'MCP_REQUEST_DECIDE');
      reviewOf(r)?.onRejected?.(r, u, { withdrawn: own, comment });
      audit({
        action: own ? 'mcp.request_withdrawn' : 'mcp.request_rejected',
        entityType: 'mcp_request',
        entityId: id,
        summary: `${own ? 'Withdrawn' : 'Rejected'}${input.via ? ' via Microsoft Teams' : ''}: ${describe(r)} (asked by ${r.requested_by}'s AI assistant)${comment ? ` – ${comment.slice(0, 200)}` : ''}`,
        details: { kind: r.kind, mode: r.mode, requestedBy: r.requested_by, comment, ...(input.via ?? {}) },
      });
    });
    settledLater(id, { status: own ? 'withdrawn' : 'rejected', by: u.username, via: input.via?.via });
    return getRequest(id);
  }
  if (!mayApprove(u, r))
    throw new HttpError(
      403,
      r.mode === 'review'
        ? incomplete(r)
          ? 'The assistant is still sending this proposal'
          : 'You may not accept this proposal'
        : r.mode === 'confirm'
          ? 'Only the token owner confirms this request'
          : 'An approver or administrator other than the token owner approves this request',
      'MCP_REQUEST_APPROVE',
    );
  // a privileged identity (0.14.0): the approver confirmed in Steward (the route's step-up) – never from a Teams card
  if (privilegedRequest(r)) {
    if (input.via) throw new HttpError(403, 'A request with a privileged identity is approved in Steward, with a confirmation', 'MCP_REQUEST_PRIVILEGED');
    assertPrivilegedConfirmed(privilegedUsesOf(id, true));
  }
  if (r.mode === 'fourEyes') noteFourEyes('mcp.write', [r.requested_by], u, { itemRequires: true });
  // a proposal's own check as the reviewer: refused, the request stays open (0.12.0)
  const pre = reviewOf(r)?.precheck;
  if (pre) runAs(u, () => pre(r, input.selection, u));
  // claim it: whoever gets here first runs it, exactly once
  const at = nowIso();
  if (
    db().run(
      "UPDATE mcp_requests SET status = 'approved', decided_by = ?, decided_at = ?, comment = ?, decided_via = ? WHERE id = ? AND status = 'pending' AND expires_at > ?",
      u.username,
      at,
      comment,
      input.via?.via ?? null,
      id,
      at,
    ).changes !== 1
  )
    throw new HttpError(409, 'The request is no longer open', 'MCP_REQUEST_DECIDE');
  audit({
    action: 'mcp.request_approved',
    entityType: 'mcp_request',
    entityId: id,
    summary: `${r.mode === 'review' ? 'Accepted' : r.mode === 'confirm' ? 'Confirmed' : 'Approved'}${input.via ? ' via Microsoft Teams' : ''}: ${describe(r)} (asked by ${r.requested_by}'s AI assistant)${comment ? ` – ${comment.slice(0, 200)}` : ''}`,
    details: { kind: r.kind, mode: r.mode, requestedBy: r.requested_by, comment, ...(input.via ?? {}) },
  });
  const review = reviewOf(r);
  const outcome = review ? applyProposal(review, r, input.selection, u) : await execute(r);
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
    actor: review ? u.username : r.requested_by,
    action: 'mcp.request_executed',
    entityType: 'mcp_request',
    entityId: id,
    summary: review
      ? `${describe(r)} for ${r.requested_by}'s AI assistant: ${outcome.error ? `failed – ${outcome.error.slice(0, 200)}` : `applied by ${u.username}`}`
      : `${describe(r)} for ${r.requested_by}'s AI assistant: ${outcome.error ? `failed – ${outcome.error.slice(0, 200)}` : outcome.runId ? `run ${outcome.runId} started` : `HTTP ${outcome.status}`}`,
    details: {
      kind: r.kind,
      approvedBy: u.username,
      status: outcome.status ?? null,
      runId: outcome.runId ?? null,
      error: outcome.error ?? null,
      ...(review ? { result: outcome.body ?? null } : {}),
      ...(input.via ?? {}),
    },
  });
  settledLater(id, { status: outcome.error ? 'failed' : 'approved', by: u.username, via: input.via?.via });
  return getRequest(id);
}

/** Applies an accepted proposal as the reviewer (their rights decide what may be applied). */
function applyProposal(
  review: ReviewKind,
  r: Row,
  selection: McpProposalSelection | undefined,
  u: AuthUser,
): { status?: number; body?: unknown; runId?: string; error?: string } {
  try {
    return runAs(u, () => review.apply(r, selection, u));
  } catch (e) {
    return { error: (e as Error).message.slice(0, 1000) };
  }
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
        if (startProblem(asOwner, { processId: r.process_id! })) return { error: `${r.requested_by} may no longer run this process` };
        const { runId } = await engine().start({
          processId: r.process_id!,
          inputs: parseJson(r.inputs, {}),
          bindings: {},
          mode: r.dry_run ? 'dry' : 'live',
          actor: r.requested_by,
          origin: { trigger: 'manual' },
        });
        return { runId };
      }
      let p: GatewayPlatform;
      try {
        p = platforms.getPlatform(r.platform_id!);
      } catch {
        return { error: 'The platform is gone, or the token owner may no longer use it' };
      }
      // the identity of the request (0.13.0, ADR 0009) – its rights, MCP mode and flags of now
      const identity = r.identity_id ? p.identities?.find((i) => i.id === r.identity_id) : p.identities?.find((i) => i.default);
      if (p.identities?.length && !identity) return { error: 'The identity of the request no longer exists' };
      if (!p.permissions.includes('use') || (identity && (!identity.mayUse || identity.mcp.mode === 'off')) || (!identity && !p.config.mcpGateway?.enabled))
        return { error: 'The MCP gateway of the platform was turned off, or the token owner may no longer use it' };
      if (identity) p = { ...p, mcpIdentity: identity };
      const now = writeDecision(p, { method: r.method ?? 'POST' }).mode;
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

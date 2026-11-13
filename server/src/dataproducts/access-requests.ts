import {
  DATA_GOVERNANCE_ID_PREFIX,
  DATA_GOVERNANCE_LIMITS as G,
  DATA_PRODUCT_ID_PREFIX,
  CIA_DIMENSIONS,
  dataAccessDecisionInput,
  dataAccessRequestInput,
  dataAccessSettingsInput,
  highOrAbove,
  type DataAccessApproval,
  type DataAccessRequest,
  type DataAccessRequestStatus,
  type DataAccessSettings,
  type DataAgreement,
  type DataConsumerKind,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { forbid, me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { auditAccessChange, requireAccessGrant } from '../auth/access-change.js';
import { samePerson } from '../auth/assurance.js';
import { isAdmin, matches, processPermissions } from '../auth/permissions.js';
import { currentScale } from '../catalogue/cia.js';
import { canViewCatalogue } from '../records/access.js';
import { logger } from '../log.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { productAccess } from './access.js';
import { HIDDEN, json, portNotFound, productNotFound, refOf } from './common.js';
import { writeIdentities } from './consumers-actual.js';
import { claimNotice, decidersOf, people, personOf, productLink, send, seesProduct, t, titleName } from './governance-notices.js';
import { ratingsByItem } from './ratings.js';
import { editableProduct, visibleProduct } from './service.js';
import { bindingsOf, chunks, marks, portRow, productRow, productsByIds, type PortRow, type ProductRow } from './store.js';

/**
 * Access requests per output port (ADR 0036 part 12 phase 2, decision 25): a person asks for access – who consumes,
 * the purpose, the environment, until when, the agreement, the platform identities that will read; the product's
 * owners decide (else who manages the product). **Four eyes** when the product's rating is high or above in a
 * dimension (shared highOrAbove): two different people approve. Nobody decides their own request.
 *
 * An approval is a widening – it asks for the step-up `access.grant` and is an access change (`access.` family) – and
 * makes a **registered consumer** with the identities; where the product's access settings say so it records the
 * platform ticket as a **ticket reference** and starts a **run of the process** the platform team owns (as the
 * approver, with their run right – the existing process approvals apply). Steward never grants on a platform itself.
 * Decisions and settings are session-only; every step is audited; `dataproduct.access_requested` and
 * `dataproduct.access_decided` tell the people once.
 */

interface RequestRow {
  id: string;
  product_id: string;
  port_id: string;
  environment: string;
  requester: string;
  consumer_kind: string;
  ref_id: string | null;
  consumer_subjects: string;
  consumer_text: string;
  purpose: string;
  until_date: string | null;
  agreement: string | null;
  identities: string;
  status: DataAccessRequestStatus;
  four_eyes: number;
  approvals: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string;
  consumer_id: string | null;
  ticket_id: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SettingsRow {
  product_id: string;
  process_id: string | null;
  ticket_source: string | null;
  review_months: number | null;
  updated_at: string;
  updated_by: string;
}

export const requestNotFound = (id: string) => new HttpError(404, `Access request ${id} not found`, 'DATA_ACCESS_REQUEST_NOT_FOUND', { id });
const state = (message: string, context: string, extra: Record<string, string | number> = {}) =>
  new HttpError(409, message, 'DATA_ACCESS_REQUEST_STATE', { context, ...extra });

// ---------- who decides ----------

/** Whether `u` is a named owner of the product. */
const isOwner = (u: AuthUser, p: ProductRow) => parseJson<string[]>(p.owners, []).some((s) => matches(u, s));

/** Whether `u` decides requests of the product: a named owner; without owners, who manages it; administrators. */
export function decidesFor(u: AuthUser, p: ProductRow): boolean {
  if (!productAccess(u, p).permissions.length) return false;
  if (isAdmin(u) || isOwner(u, p)) return true;
  return !parseJson<string[]>(p.owners, []).length && productAccess(u, p).permissions.includes('manage');
}

function mayDecide(u: AuthUser, r: RequestRow, p: ProductRow): boolean {
  if (r.status !== 'pending' || !decidesFor(u, p) || samePerson(r.requester, u)) return false;
  return !parseJson<DataAccessApproval[]>(r.approvals, []).some((a) => samePerson(a.by, u));
}

/** Four eyes: the product's rating is high or above in a dimension (the top two levels of the scale). */
export function needsFourEyes(productId: string): boolean {
  const scale = currentScale();
  const rating = ratingsByItem('product', [productId], scale).get(productId);
  if (!rating) return false;
  return CIA_DIMENSIONS.some((d) => {
    const r = rating[d];
    return !!r && !r.needsRerating && highOrAbove(scale.levels[d].map((l) => l.key), r.level);
  });
}

// ---------- reading ----------

function consumerLabel(u: AuthUser, r: RequestRow, products: Map<string, ProductRow>): string | null {
  const subjects = parseJson<string[]>(r.consumer_subjects, []);
  if (r.consumer_kind === 'team' || r.consumer_kind === 'user') return subjects[0] ?? null;
  if (r.consumer_kind === 'text') return r.consumer_text;
  if (!r.ref_id) return null;
  if (r.consumer_kind === 'product') {
    const p = products.get(r.ref_id) ?? productRow(r.ref_id);
    return p && productAccess(u, p).permissions.length ? p.name : null;
  }
  const row = db().get<{ id: string; name: string; owners: string }>(
    `SELECT id, name, owners FROM ${r.consumer_kind === 'application' ? 'applications' : 'services'} WHERE id = ?`,
    r.ref_id,
  );
  return row && canViewCatalogue(u, { kind: r.consumer_kind as 'application' | 'service', id: row.id, owners: parseJson<string[]>(row.owners, []) })
    ? row.name
    : null;
}

function view(u: AuthUser, r: RequestRow, p: ProductRow, port: PortRow | undefined, products: Map<string, ProductRow>): DataAccessRequest {
  const label = consumerLabel(u, r, products);
  const hiddenRef = (r.consumer_kind === 'application' || r.consumer_kind === 'service' || r.consumer_kind === 'product') && label === null;
  return {
    id: r.id,
    product: productAccess(u, p).permissions.length ? refOf(p) : HIDDEN,
    portId: r.port_id,
    portName: port?.name ?? '',
    portVersion: port?.version ?? '',
    environment: r.environment,
    requester: r.requester,
    consumer: {
      kind: r.consumer_kind as DataConsumerKind,
      refId: hiddenRef ? null : r.ref_id,
      subject: r.consumer_kind === 'team' || r.consumer_kind === 'user' ? (parseJson<string[]>(r.consumer_subjects, [])[0] ?? null) : null,
      text: r.consumer_text,
      label,
    },
    purpose: r.purpose,
    until: r.until_date,
    agreement: parseJson<DataAgreement | null>(r.agreement, null),
    identities: parseJson<string[]>(r.identities, []),
    status: r.status,
    fourEyes: !!r.four_eyes,
    approvals: parseJson<DataAccessApproval[]>(r.approvals, []),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionComment: r.decision_comment,
    consumerId: r.consumer_id,
    ticketId: r.ticket_id,
    runId: r.run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    mayDecide: mayDecide(u, r, p),
    mayWithdraw: r.status === 'pending' && samePerson(r.requester, u),
  };
}

/** Views of request rows a reader may see (bulk: products and ports read once per page). */
function views(u: AuthUser, rows: RequestRow[]): DataAccessRequest[] {
  const products = productsByIds([...new Set(rows.map((r) => r.product_id))]);
  const ports = new Map<string, PortRow>();
  for (const part of chunks([...new Set(rows.map((r) => r.port_id))]))
    for (const p of db().all<PortRow>(`SELECT * FROM dp_ports WHERE id IN (${marks(part.length)})`, ...part)) ports.set(p.id, p);
  const out: DataAccessRequest[] = [];
  for (const r of rows) {
    const p = products.get(r.product_id);
    if (!p || !productAccess(u, p).permissions.length) continue;
    out.push(view(u, r, p, ports.get(r.port_id), products));
  }
  return out;
}

export const listQuery = z
  .object({
    scope: z.enum(['mine', 'decide', 'all']).default('all'),
    status: z.enum(['pending', 'approved', 'refused', 'withdrawn']).optional(),
    productId: z.string().max(100).optional(),
  })
  .strict();

/**
 * GET /api/data-products/access-requests – requests of products the reader may see: `mine` (asked by them), `decide`
 * (waiting for their decision), `all`; the newest first, at most a page.
 */
export function listRequests(q: z.infer<typeof listQuery>): { items: DataAccessRequest[]; total: number } {
  const u = me();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) (where.push('status = ?'), params.push(q.status));
  if (q.productId) (where.push('product_id = ?'), params.push(q.productId));
  if (q.scope === 'mine') (where.push('lower(requester) = ?'), params.push(u.username.toLowerCase()));
  if (q.scope === 'decide') where.push("status = 'pending'");
  const rows = db().all<RequestRow>(
    `SELECT * FROM dp_access_requests${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
    5_000,
  );
  let items = views(u, rows);
  if (q.scope === 'decide') items = items.filter((r) => r.mayDecide);
  return { items: items.slice(0, G.requestPage), total: items.length };
}

/** GET /api/data-products/:id/access-requests */
export function productRequests(productId: string): { items: DataAccessRequest[]; total: number } {
  const { row } = visibleProduct(productId);
  return listRequests({ scope: 'all', productId: row.id });
}

function requestRow(id: string): RequestRow {
  const r = db().get<RequestRow>('SELECT * FROM dp_access_requests WHERE id = ?', id);
  if (!r) throw requestNotFound(id);
  return r;
}

/** A request whose product the caller may see (else: not found). */
function visibleRequest(id: string, u: AuthUser): { r: RequestRow; p: ProductRow } {
  const r = requestRow(id);
  const p = productRow(r.product_id);
  if (!p || !productAccess(u, p).permissions.length) throw requestNotFound(id);
  return { r, p };
}

export function getRequest(id: string): DataAccessRequest {
  const u = me();
  const { r, p } = visibleRequest(id, u);
  return view(u, r, p, portRow(r.port_id), new Map([[p.id, p]]));
}

// ---------- asking ----------

/** What a request names must fit its kind; an application, service or product must be one the requester may see. */
function checkConsumer(u: AuthUser, c: z.infer<typeof dataAccessRequestInput>['consumer']): void {
  const bad = (problem: string) => new HttpError(400, 'The consumer is not complete', 'DATA_CONSUMER_INVALID', { context: problem });
  if ((c.kind === 'team' || c.kind === 'user') && !c.subject?.startsWith(`${c.kind}:`)) throw bad('subject');
  if (c.kind === 'text' && !c.text) throw bad('text');
  if (c.kind === 'application' || c.kind === 'service' || c.kind === 'product') {
    if (!c.refId) throw bad('ref');
    const label = consumerLabel(
      u,
      { consumer_kind: c.kind, ref_id: c.refId, consumer_subjects: '[]', consumer_text: '' } as RequestRow,
      new Map(),
    );
    if (!label) throw c.kind === 'product' ? productNotFound(c.refId) : bad('notFound');
  }
}

/** POST /api/data-products/:id/ports/:portId/access-requests – who may see the product. */
export function requestAccess(productId: string, portId: string, body: unknown): DataAccessRequest {
  const u = me();
  const { row: p } = visibleProduct(productId, u);
  const port = portRow(portId);
  if (!port || port.product_id !== p.id) throw portNotFound(portId);
  if (port.direction !== 'output') throw state('Access is asked for an output port', 'inputPort');
  if (port.lifecycle === 'retired' || p.lifecycle === 'retired') throw state('The port is retired', 'retired');
  const input = dataAccessRequestInput.parse(body);
  if (!bindingsOf([port.id]).some((b) => b.environment === input.environment))
    throw state(`The port is not bound in ${input.environment}`, 'notBound', { environment: input.environment });
  checkConsumer(u, input.consumer);
  const subjects = input.consumer.subject && (input.consumer.kind === 'team' || input.consumer.kind === 'user') ? [input.consumer.subject.toLowerCase()] : [];
  const refId = input.consumer.kind === 'application' || input.consumer.kind === 'service' || input.consumer.kind === 'product' ? input.consumer.refId : null;
  const open = db().all<RequestRow>("SELECT * FROM dp_access_requests WHERE port_id = ? AND status = 'pending'", port.id);
  if (open.length >= G.pendingPerPort) throw state(`At most ${G.pendingPerPort} open requests per port`, 'limit', { max: G.pendingPerPort });
  if (
    open.some(
      (r) =>
        samePerson(r.requester, u) &&
        r.environment === input.environment &&
        r.consumer_kind === input.consumer.kind &&
        (r.ref_id ?? null) === refId &&
        r.consumer_subjects === json(subjects) &&
        r.consumer_text === input.consumer.text,
    )
  )
    throw state('You asked for this access already – the request is open', 'exists');
  const id = newId(DATA_GOVERNANCE_ID_PREFIX.request);
  const now = nowIso();
  const fourEyes = needsFourEyes(p.id);
  db().tx(() => {
    db().run(
      `INSERT INTO dp_access_requests (id, product_id, port_id, environment, requester, consumer_kind, ref_id, consumer_subjects, consumer_text, purpose, until_date, agreement, identities, status, four_eyes, approvals, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, '[]', ?, ?)`,
      id,
      p.id,
      port.id,
      input.environment,
      u.username,
      input.consumer.kind,
      refId,
      json(subjects),
      input.consumer.kind === 'text' ? input.consumer.text : '',
      input.purpose,
      input.until,
      input.agreement ? json(input.agreement) : null,
      json(input.identities),
      fourEyes ? 1 : 0,
      now,
      now,
    );
    audit({
      action: 'dataproduct.access_requested',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": access to port "${port.name}" in ${input.environment} requested (${input.consumer.kind})${fourEyes ? ' – four eyes' : ''}`,
      details: {
        requestId: id,
        portId: port.id,
        environment: input.environment,
        consumer: input.consumer.kind,
        until: input.until,
        identities: input.identities.length,
        fourEyes,
      },
    });
  });
  noticeRequested(id, 'new');
  return getRequest(id);
}

/** POST /api/data-products/access-requests/:requestId/withdraw – the requester, while it is open. */
export function withdrawRequest(id: string): DataAccessRequest {
  const u = me();
  const { r, p } = visibleRequest(id, u);
  if (!samePerson(r.requester, u)) forbid('withdraw this access request', 'dataProducts');
  if (r.status !== 'pending') throw state('The request is decided already', 'notPending');
  db().tx(() => {
    db().run("UPDATE dp_access_requests SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'pending'", nowIso(), r.id);
    audit({
      action: 'dataproduct.access_withdrawn',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": an access request was withdrawn`,
      details: { requestId: r.id, portId: r.port_id },
    });
  });
  return getRequest(id);
}

// ---------- deciding ----------

function settingsRow(productId: string): SettingsRow | undefined {
  return db().get<SettingsRow>('SELECT * FROM dp_access_settings WHERE product_id = ?', productId);
}

/**
 * POST /api/data-products/access-requests/:requestId/decision (session only): approve or refuse. A refusal needs a
 * comment. An approval asks for the step-up `access.grant`; with four eyes the first approval waits for a second,
 * different person. The last approval registers the consumer, records the ticket and starts the process (settings).
 */
export async function decideRequest(id: string, body: unknown): Promise<DataAccessRequest> {
  const u = me();
  const { r, p } = visibleRequest(id, u);
  const input = dataAccessDecisionInput.parse(body);
  if (r.status !== 'pending') throw state('The request is decided already', 'notPending');
  if (samePerson(r.requester, u)) throw state('Nobody decides their own request', 'ownRequest');
  if (!decidesFor(u, p)) forbid('decide access requests of this data product', 'dataProducts');
  const approvals = parseJson<DataAccessApproval[]>(r.approvals, []);
  if (approvals.some((a) => samePerson(a.by, u))) throw state('A second person approves', 'secondPerson');
  const port = portRow(r.port_id);
  const now = nowIso();
  if (input.decision === 'refuse') {
    if (!input.comment) throw state('Say why the request is refused', 'comment');
    db().tx(() => {
      db().run(
        "UPDATE dp_access_requests SET status = 'refused', decided_by = ?, decided_at = ?, decision_comment = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        u.username,
        now,
        input.comment,
        now,
        r.id,
      );
      audit({
        action: 'dataproduct.access_refused',
        entityType: 'data_product',
        entityId: p.id,
        summary: `Data product "${p.name}": access to port "${port?.name ?? ''}" refused`,
        details: { requestId: r.id, portId: r.port_id, environment: r.environment, comment: input.comment.slice(0, 500) },
      });
    });
    noticeDecided(r.id);
    return getRequest(r.id);
  }
  // an approval widens access: confirmed like every grant (API tokens cannot)
  requireAccessGrant(u);
  const approval: DataAccessApproval = { by: u.username, at: now, comment: input.comment };
  const last = !r.four_eyes || approvals.length >= 1;
  if (!last) {
    db().tx(() => {
      db().run('UPDATE dp_access_requests SET approvals = ?, updated_at = ? WHERE id = ?', json([...approvals, approval]), now, r.id);
      audit({
        action: 'dataproduct.access_approved',
        entityType: 'data_product',
        entityId: p.id,
        summary: `Data product "${p.name}": access to port "${port?.name ?? ''}" approved by the first of two people`,
        details: { requestId: r.id, portId: r.port_id, environment: r.environment, step: 1 },
      });
    });
    noticeRequested(r.id, 'second');
    return getRequest(r.id);
  }
  const settings = settingsRow(p.id);
  // the process run: the approver's run right is checked before anything is written
  const processId = settings?.process_id ?? null;
  if (processId) {
    const { authorizeStart } = await import('../engine/commands.js');
    authorizeStart(u, { processId });
  }
  const consumerId = newId(DATA_PRODUCT_ID_PREFIX.consumer);
  const subjects = parseJson<string[]>(r.consumer_subjects, []);
  const identities = parseJson<string[]>(r.identities, []);
  db().tx(() => {
    db().run(
      `INSERT INTO dp_consumers (id, port_id, consumer_kind, ref_id, consumer_subjects, consumer_text, purpose, since, end_date, agreement, contacts, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      consumerId,
      r.port_id,
      r.consumer_kind,
      r.ref_id,
      json(subjects),
      r.consumer_text,
      r.purpose,
      now.slice(0, 10),
      r.until_date,
      r.agreement,
      json([`user:${r.requester.toLowerCase()}`]),
      now,
      u.username,
      now,
      u.username,
    );
    writeIdentities(consumerId, identities);
    db().run(
      "UPDATE dp_access_requests SET status = 'approved', approvals = ?, decided_by = ?, decided_at = ?, decision_comment = ?, consumer_id = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
      json([...approvals, approval]),
      u.username,
      now,
      input.comment,
      consumerId,
      now,
      r.id,
    );
    audit({
      action: 'dataproduct.access_approved',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": access to port "${port?.name ?? ''}" in ${r.environment} approved – consumer registered`,
      details: { requestId: r.id, portId: r.port_id, environment: r.environment, consumerId, approvals: [...approvals, approval].map((a) => a.by) },
    });
    auditAccessChange({
      action: 'access.data_port_consumer_granted',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": ${r.consumer_kind} ${subjects[0] ?? r.consumer_text ?? ''} registered as a consumer of port "${port?.name ?? ''}" (${r.environment})${r.until_date ? ` until ${r.until_date}` : ''}`,
      details: {
        requestId: r.id,
        portId: r.port_id,
        environment: r.environment,
        consumerId,
        granted: [{ subject: subjects[0] ?? `${r.consumer_kind}:${r.ref_id ?? r.consumer_text}`, rights: ['consume'] }],
        identities,
        until: r.until_date,
        requester: r.requester,
      },
    });
    db().run('UPDATE dp_products SET revision = revision + 1, updated_at = ?, updated_by = ? WHERE id = ?', now, u.username, p.id);
  });
  // the ticket of the grant, recorded as a ticket reference (the tickets module's rules: who may add one, the source)
  if (input.ticket && settings?.ticket_source) {
    try {
      const { createTicket, ticketInputSchema } = await import('../tickets/service.js');
      const tk = createTicket(
        ticketInputSchema.parse({
          source: settings.ticket_source,
          externalNumber: input.ticket.externalNumber,
          externalUrl: input.ticket.externalUrl,
          title: `Access to ${p.name} / ${port?.name ?? ''} (${r.environment})`.slice(0, 200),
          status: 'open',
          links: [{ kind: 'data-product', id: p.id }],
        }),
      );
      db().run('UPDATE dp_access_requests SET ticket_id = ? WHERE id = ?', tk.id, r.id);
    } catch (err) {
      logger.warn({ err, requestId: r.id }, 'the ticket reference of an access request could not be added');
      db().run('UPDATE dp_access_requests SET decision_comment = ? WHERE id = ?', `${input.comment}\n[ticket: ${(err as Error).message}]`.trim().slice(0, 2_500), r.id);
    }
  }
  // the platform team's process, live, as the approver (its own approvals apply)
  if (processId) {
    try {
      const { engine } = await import('../engine/index.js');
      const started = await engine().start({
        processId,
        inputs: {
          dataProduct: p.key,
          port: port?.name ?? '',
          portVersion: port?.version ?? '',
          environment: r.environment,
          consumer: subjects[0] ?? r.consumer_text ?? r.ref_id ?? '',
          identities: identities.join(', '),
          until: r.until_date ?? '',
          purpose: r.purpose.slice(0, 1000),
          requestId: r.id,
        },
        bindings: {},
        mode: 'live',
        actor: u.username,
        origin: { trigger: 'manual' },
      });
      db().run('UPDATE dp_access_requests SET run_id = ? WHERE id = ?', started.runId, r.id);
    } catch (err) {
      logger.warn({ err, requestId: r.id }, 'the process of an access request could not start');
      db().run(
        'UPDATE dp_access_requests SET decision_comment = ? WHERE id = ?',
        `${input.comment}\n[process: ${(err as Error).message}]`.trim().slice(0, 2_500),
        r.id,
      );
    }
  }
  noticeDecided(r.id);
  return getRequest(r.id);
}

// ---------- settings ----------

function settingsView(productId: string, row: SettingsRow | undefined, u: AuthUser): DataAccessSettings {
  let process: DataAccessSettings['process'] = null;
  if (row?.process_id) {
    const pr = db().get<{ id: string; name: string; owner: string | null; acl: string }>('SELECT id, name, owner, acl FROM processes WHERE id = ?', row.process_id);
    // a process the reader may not see is not named
    const visible = !!pr && processPermissions(u, { id: pr.id, owner: pr.owner, acl: parseJson(pr.acl, []) }).includes('view');
    process = { id: row.process_id, name: visible ? pr.name : null };
  }
  return {
    productId,
    process,
    ticketSource: row?.ticket_source ?? null,
    reviewMonths: row?.review_months === null || row?.review_months === undefined ? null : Number(row.review_months),
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** GET /api/data-products/:id/access-settings */
export function getSettings(productId: string): DataAccessSettings {
  const u = me();
  const { row } = visibleProduct(productId, u);
  return settingsView(row.id, settingsRow(row.id), u);
}

/** PUT /api/data-products/:id/access-settings – who manages the product (session only); the process must be one they may run. */
export async function putSettings(productId: string, body: unknown): Promise<DataAccessSettings> {
  const u = me();
  const { row: p } = editableProduct(productId, 'manage');
  const input = dataAccessSettingsInput.parse(body);
  if (input.processId) {
    const { authorizeStart } = await import('../engine/commands.js');
    authorizeStart(u, { processId: input.processId });
  }
  if (input.ticketSource) {
    const { ticketSettings } = await import('../tickets/service.js');
    if (!ticketSettings().sources.some((x) => x.key === input.ticketSource))
      throw new HttpError(400, `Unknown ticket source "${input.ticketSource}"`, 'TICKET_SOURCE_UNKNOWN');
  }
  const before = settingsRow(p.id);
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO dp_access_settings (product_id, process_id, ticket_source, review_months, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (product_id) DO UPDATE SET process_id = excluded.process_id, ticket_source = excluded.ticket_source, review_months = excluded.review_months,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      p.id,
      input.processId,
      input.ticketSource,
      input.reviewMonths,
      now,
      u.username,
    );
    audit({
      action: 'dataproduct.access_settings_changed',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}": access settings changed`,
      details: {
        before: before ? { processId: before.process_id, ticketSource: before.ticket_source, reviewMonths: before.review_months } : null,
        after: input,
      },
    });
  });
  return settingsView(p.id, settingsRow(p.id), u);
}

export const reviewMonthsOf = (productId: string): number | null => {
  const r = settingsRow(productId);
  return r?.review_months === null || r?.review_months === undefined ? null : Number(r.review_months);
};

// ---------- notices ----------

/** `dataproduct.access_requested` to who decides (never the requester or who approved already), once per request and step. */
export function noticeRequested(id: string, step: 'new' | 'second'): number {
  try {
    const r = db().get<RequestRow>('SELECT * FROM dp_access_requests WHERE id = ?', id);
    const p = r ? productRow(r.product_id) : undefined;
    if (!r || !p || !claimNotice('request', r.id, step)) return 0;
    const port = portRow(r.port_id);
    const approvals = parseJson<DataAccessApproval[]>(r.approvals, []);
    const all = people();
    const to = decidersOf(all, p).filter((x) => !samePerson(r.requester, x.auth) && !approvals.some((a) => samePerson(a.by, x.auth)));
    const portName = `${port?.name ?? ''}${port?.version ? ` ${port.version}` : ''}`;
    return send({
      event: 'dataproduct.access_requested',
      recipients: to,
      link: productLink(p.id, 'access'),
      key: `request:${r.id}:${step}`,
      title: (l) => t(l, 'dataProductGovernance.requested.title', { product: titleName(p.name), port: titleName(portName, 60) }),
      lines: (l) => [
        t(l, 'dataProductGovernance.requested.body', { requester: r.requester, port: portName, product: p.name, environment: r.environment }),
        t(l, 'dataProductGovernance.requested.purpose', { purpose: r.purpose.slice(0, 500) }),
        ...(r.until_date ? [t(l, 'dataProductGovernance.requested.until', { date: r.until_date })] : []),
        ...(step === 'second'
          ? [t(l, 'dataProductGovernance.requested.second', { first: approvals[0]?.by ?? '' })]
          : r.four_eyes
            ? [t(l, 'dataProductGovernance.requested.fourEyes')]
            : []),
        t(l, 'dataProductGovernance.requested.hint'),
      ],
      data: { productId: p.id, portId: r.port_id, requestId: r.id },
    });
  } catch (err) {
    logger.warn({ err, id }, 'access request notice could not be sent');
    return 0;
  }
}

/** `dataproduct.access_decided` to the requester (when they may still see the product), once per request. */
export function noticeDecided(id: string): number {
  try {
    const r = db().get<RequestRow>('SELECT * FROM dp_access_requests WHERE id = ?', id);
    const p = r ? productRow(r.product_id) : undefined;
    if (!r || !p || (r.status !== 'approved' && r.status !== 'refused') || !claimNotice('request', r.id, 'decided')) return 0;
    const who = personOf(r.requester);
    if (!who || !seesProduct(who, p)) return 0;
    const port = portRow(r.port_id);
    const portName = `${port?.name ?? ''}${port?.version ? ` ${port.version}` : ''}`;
    return send({
      event: 'dataproduct.access_decided',
      recipients: [who],
      link: productLink(p.id, 'access'),
      key: `request:${r.id}:decided`,
      title: (l) => t(l, `dataProductGovernance.decided.${r.status === 'approved' ? 'approvedTitle' : 'refusedTitle'}`, { product: titleName(p.name) }),
      lines: (l) => [
        t(l, `dataProductGovernance.decided.${r.status === 'approved' ? 'approvedBody' : 'refusedBody'}`, {
          port: portName,
          product: p.name,
          environment: r.environment,
          by: r.decided_by ?? '',
        }),
        ...(r.decision_comment ? [t(l, 'dataProductGovernance.decided.comment', { comment: r.decision_comment.slice(0, 500) })] : []),
        ...(r.status === 'approved' ? [t(l, 'dataProductGovernance.decided.hint')] : []),
      ],
      data: { productId: p.id, portId: r.port_id, requestId: r.id, status: r.status },
    });
  } catch (err) {
    logger.warn({ err, id }, 'access decision notice could not be sent');
    return 0;
  }
}

/** Requests of a product removed with it (service.deleteProduct does not know them: the job tidies up). */
export function forgetRequestsOfMissingProducts(): number {
  return db().run('DELETE FROM dp_access_requests WHERE product_id NOT IN (SELECT id FROM dp_products)').changes;
}

export { isOwner as isProductOwner };

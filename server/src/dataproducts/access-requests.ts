import {
  DATA_ACCESS_REQUEST_STATUSES,
  dataAccessSettingsInput,
  dataConsumerFulfilmentInput,
  DATA_GOVERNANCE_LIMITS as G,
  type DataAccessApproval,
  type DataAccessRequest,
  type DataAccessRequestStatus,
  type DataAccessSettings,
  type DataAgreement,
  type DataConsumerFulfilment,
  type DataConsumerKind,
} from '@sm/shared';
import { z } from 'zod';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { processPermissions } from '../auth/permissions.js';
import { canViewCatalogue } from '../records/access.js';
import { logger } from '../log.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { productAccess } from './access.js';
import { HIDDEN, portNotFound, refOf } from './common.js';
import { editableProduct, visibleProduct } from './service.js';
import { chunks, marks, portRow, productRow, productsByIds, type ConsumerRow, type PortRow, type ProductRow } from './store.js';

/**
 * Access requests per output port (0.24.0, ADR 0036 part 12 phase 2) – **retired in 0.25.1** (ADR 0038 part 3): Steward
 * documents access that was decided elsewhere (a consumer registration with a documented decision, ports.ts); it does
 * not run requests and approvals. The requests made until then stay **readable as history** for one release (GET);
 * asking, deciding and withdrawing answer `410 DATA_ACCESS_DOCUMENTED_ONLY`. The upgrade turned pending requests into
 * registrations whose approval is not documented, and gave the registrations of approved requests a documented
 * decision from the approval (dataproducts/governance-upgrade.ts).
 *
 * What stays here: the product's **access settings** – the platform team's process and the ticket source of the
 * optional fulfilment of a registration, and the interval of port access reviews – and the **fulfilment** itself:
 * the platform ticket recorded as a ticket reference and a run of the process started as the person who records the
 * registration (with their run right; the process's own approvals apply). Steward never grants on a platform itself.
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

/** Asking for access, deciding and withdrawing a request are gone (0.25.1): access is documented on a registration. */
export const documentedOnly = () =>
  new HttpError(
    410,
    'Steward documents access decided elsewhere: register the consumer with the decision on the port instead of requesting access',
    'DATA_ACCESS_DOCUMENTED_ONLY',
  );

// ---------- reading (history) ----------

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
    fourEyes: !!Number(r.four_eyes),
    approvals: parseJson<DataAccessApproval[]>(r.approvals, []),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionComment: r.decision_comment,
    consumerId: r.consumer_id,
    ticketId: r.ticket_id,
    runId: r.run_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // nothing is decided or withdrawn in Steward any more (0.25.1)
    mayDecide: false,
    mayWithdraw: false,
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
    status: z.enum(DATA_ACCESS_REQUEST_STATUSES).optional(),
    productId: z.string().max(100).optional(),
  })
  .strict();

/**
 * GET /api/data-products/access-requests (read-only history, deprecated in 0.25.1) – requests of products the reader
 * may see: `mine` (asked by them), `decide` (none any more: nothing is decided in Steward), `all`; the newest first, at
 * most a page.
 */
export function listRequests(q: z.infer<typeof listQuery>): { items: DataAccessRequest[]; total: number } {
  const u = me();
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) (where.push('status = ?'), params.push(q.status));
  if (q.productId) (where.push('product_id = ?'), params.push(q.productId));
  if (q.scope === 'mine') (where.push('lower(requester) = ?'), params.push(u.username.toLowerCase()));
  if (q.scope === 'decide') return { items: [], total: 0 };
  const rows = db().all<RequestRow>(
    `SELECT * FROM dp_access_requests${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params,
    5_000,
  );
  const items = views(u, rows);
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

// ---------- settings ----------

function settingsRow(productId: string): SettingsRow | undefined {
  return db().get<SettingsRow>('SELECT * FROM dp_access_settings WHERE product_id = ?', productId);
}

function settingsView(productId: string, row: SettingsRow | undefined, u: AuthUser): DataAccessSettings {
  let process: DataAccessSettings['process'] = null;
  if (row?.process_id) {
    const pr = db().get<{ id: string; name: string; owner: string | null; acl: string }>(
      'SELECT id, name, owner, acl FROM processes WHERE id = ?',
      row.process_id,
    );
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

// ---------- fulfilment of a registration ----------

/**
 * POST /api/data-products/:id/ports/:portId/consumers/:consumerId/fulfilment (session only, who may change the product):
 * the optional IT work after access was documented – the platform ticket recorded as a ticket reference (where the
 * product's access settings name a ticket source) and a run of the platform team's process started live as the caller
 * (their run right is checked first; the process's own approvals apply). Each happens once per registration; a step
 * that fails is reported and can be tried again.
 */
export async function fulfilConsumer(productId: string, portId: string, consumerId: string, body: unknown): Promise<DataConsumerFulfilment> {
  const u = me();
  const { row: p } = editableProduct(productId);
  const port = portRow(portId);
  if (!port || port.product_id !== p.id) throw portNotFound(portId);
  const c = db().get<ConsumerRow>('SELECT * FROM dp_consumers WHERE id = ? AND port_id = ?', consumerId, port.id);
  if (!c) throw new HttpError(404, `Consumer ${consumerId} not found`, 'DATA_CONSUMER_NOT_FOUND', { id: consumerId });
  const input = dataConsumerFulfilmentInput.parse(body ?? {});
  const settings = settingsRow(p.id);
  const problems: string[] = [];
  const label = (parseJson<string[]>(c.consumer_subjects, [])[0] ?? c.consumer_text) || c.ref_id || c.consumer_kind;
  if (input.ticket && !c.ticket_id) {
    if (!settings?.ticket_source) throw new HttpError(400, 'The product names no ticket source', 'DATA_CONSUMER_INVALID', { context: 'ticketSource' });
    try {
      const { createTicket, ticketInputSchema } = await import('../tickets/service.js');
      const tk = createTicket(
        ticketInputSchema.parse({
          source: settings.ticket_source,
          externalNumber: input.ticket.externalNumber,
          externalUrl: input.ticket.externalUrl,
          title: `Access to ${p.name} / ${port.name} (${label})`.slice(0, 200),
          status: 'open',
          links: [{ kind: 'data-product', id: p.id }],
        }),
      );
      db().run('UPDATE dp_consumers SET ticket_id = ? WHERE id = ?', tk.id, c.id);
    } catch (err) {
      logger.warn({ err, consumerId: c.id }, 'the ticket reference of a registration could not be added');
      problems.push(`ticket: ${(err as Error).message}`.slice(0, 500));
    }
  }
  if (input.startProcess && !c.run_id) {
    const processId = settings?.process_id ?? null;
    if (!processId) throw new HttpError(400, 'The product names no process', 'DATA_CONSUMER_INVALID', { context: 'process' });
    const { authorizeStart } = await import('../engine/commands.js');
    authorizeStart(u, { processId });
    try {
      const { engine } = await import('../engine/index.js');
      const identities = db()
        .all<{ identity: string }>('SELECT identity FROM dp_consumer_identities WHERE consumer_id = ? ORDER BY identity', c.id)
        .map((x) => x.identity);
      const started = await engine().start({
        processId,
        inputs: {
          dataProduct: p.key,
          port: port.name,
          portVersion: port.version ?? '',
          consumer: label,
          identities: identities.join(', '),
          until: c.end_date ?? '',
          purpose: c.purpose.slice(0, 1000),
          consumerId: c.id,
        },
        bindings: {},
        mode: 'live',
        actor: u.username,
        origin: { trigger: 'manual' },
      });
      db().run('UPDATE dp_consumers SET run_id = ? WHERE id = ?', started.runId, c.id);
    } catch (err) {
      logger.warn({ err, consumerId: c.id }, 'the process of a registration could not start');
      problems.push(`process: ${(err as Error).message}`.slice(0, 500));
    }
  }
  const after = db().get<ConsumerRow>('SELECT * FROM dp_consumers WHERE id = ?', c.id)!;
  audit({
    action: 'dataproduct.consumer_fulfilment',
    entityType: 'data_product',
    entityId: p.id,
    summary: `Data product "${p.name}": fulfilment of a consumer of port "${port.name}"${after.ticket_id ? ' – ticket recorded' : ''}${after.run_id ? ' – process started' : ''}${problems.length ? ` – ${problems.length} problem(s)` : ''}`,
    details: { portId: port.id, consumerId: c.id, ticketId: after.ticket_id, runId: after.run_id, problems },
  });
  return { consumerId: c.id, ticketId: after.ticket_id, runId: after.run_id, problems };
}

/** Requests of a product removed with it (service.deleteProduct does not know them: the job tidies up). */
export function forgetRequestsOfMissingProducts(): number {
  return db().run('DELETE FROM dp_access_requests WHERE product_id NOT IN (SELECT id FROM dp_products)').changes;
}

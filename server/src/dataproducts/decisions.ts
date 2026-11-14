import { documentedDecisionInput, type ContactSnapshot, type DocumentedDecision, type DocumentedEvidence } from '@sm/shared';
import { db } from '../db.js';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { canReadRecordRow } from '../records/access.js';
import { ticketAccess } from '../tickets/service.js';
import { snapshotsOf } from '../contacts/service.js';
import { HttpError, nowIso, parseJson } from '../util.js';

/**
 * Documented decisions of the data products module (0.25.1, ADR 0038 parts 3–5): a decision made outside Steward –
 * an access decided in a meeting, the outcome of a port access review, an endorsement, the approval of a semantic model
 * version – recorded here: who decided (contacts, frozen as ContactSnapshot), on which date (not in the future), the
 * evidence (a record, a ticket reference, a document, an address, a text), a note, and the Steward user who recorded it
 * and when. Stored as JSON on the item it belongs to (dp_consumers.decision, dp_port_reviews.decision,
 * dp_endorsements.decision, dp_semantic_signoffs.decision).
 *
 * - **Who decided** must be contacts the recorder may see and that are active (contacts/service.ts snapshotsOf); the
 *   names are frozen, so the evidence keeps its meaning when a contact changes or leaves. An erased contact keeps its
 *   name in the snapshot and its id becomes null (forgetErasedContact, a hook of the directory).
 * - **Evidence** of kind record, ticket or document names an item by id: the recorder must see it; a reader sees its
 *   label only when they may see it too (otherwise null – never named).
 * - **Seals** (port access reviews) cover the decision without the contacts' ids (sealedDecision): erasing a contact
 *   does not break a seal.
 */

const today = () => nowIso().slice(0, 10);
export const decisionInvalid = (message: string, context: string) => new HttpError(400, message, 'DATA_DECISION_INVALID', { context });

/** Whether the reader may see a record, ticket reference or document named as evidence, and its label then. */
function evidenceLabels(u: AuthUser | null, evidence: readonly { kind: string; value: string }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const records = [...new Set(evidence.filter((e) => e.kind === 'record' || e.kind === 'document').map((e) => e.value))];
  for (const id of records) {
    const r = db().get<{ id: string; title: string; owner: string; type_id: string; fields: string }>(
      'SELECT id, title, owner, type_id, fields FROM records WHERE id = ?',
      id,
    );
    out.set(`record:${id}`, r && canReadRecordRow(u, r) ? r.title : null);
  }
  const tickets = [...new Set(evidence.filter((e) => e.kind === 'ticket').map((e) => e.value))];
  if (tickets.length) {
    for (const id of tickets) out.set(`ticket:${id}`, null);
    // the tickets module decides who sees a ticket reference (owning teams, responsibles)
    const rows = db().all<{ id: string; external_number: string; title: string; responsible: string }>(
      `SELECT id, external_number, title, responsible FROM ticket_refs WHERE id IN (${tickets.map(() => '?').join(', ')})`,
      ...tickets,
    );
    for (const r of rows) if (u && ticketAccess(u, r).permissions.includes('view')) out.set(`ticket:${r.id}`, `${r.external_number} ${r.title}`.trim());
  }
  return out;
}

const keyOf = (e: { kind: string; value: string }) => `${e.kind === 'document' ? 'record' : e.kind}:${e.value}`;

/**
 * A documented decision from the input of a form (DocumentedDecisionInput): checked and frozen, recorded by the
 * current user now. Throws 400 DATA_DECISION_INVALID (a date in the future, evidence the recorder may not see),
 * 404 CONTACT_NOT_FOUND or 409 CONTACT_LEFT (contacts/service.ts).
 */
export function documentDecision(body: unknown, u: AuthUser | null = currentUser()): DocumentedDecision {
  const input = documentedDecisionInput.parse(body);
  if (input.decidedOn > today()) throw decisionInvalid('The decision date is not in the future', 'decidedOn');
  const decidedBy = snapshotsOf(input.decidedBy, u);
  const labels = evidenceLabels(u, input.evidence);
  for (const e of input.evidence) {
    if (e.kind === 'url' && !/^https?:\/\/\S+$/i.test(e.value)) throw decisionInvalid('An address starts with http:// or https://', 'evidenceUrl');
    if ((e.kind === 'record' || e.kind === 'document' || e.kind === 'ticket') && !labels.get(keyOf(e)))
      throw decisionInvalid('The evidence names an item that was not found', 'evidenceNotFound');
  }
  return {
    decidedBy,
    decidedOn: input.decidedOn,
    evidence: input.evidence.map((e) => ({ kind: e.kind, value: e.value })),
    note: input.note,
    recordedBy: u?.username ?? 'system',
    recordedAt: nowIso(),
  };
}

/** A stored decision as `u` reads it: evidence items they may not see have no label (null). */
export function decisionView(raw: string | null | undefined, u: AuthUser | null = currentUser()): DocumentedDecision | null {
  const d = parseJson<DocumentedDecision | null>(raw ?? null, null);
  if (!d) return null;
  const labels = evidenceLabels(u, d.evidence ?? []);
  return {
    ...d,
    evidence: (d.evidence ?? []).map((e): DocumentedEvidence =>
      e.kind === 'record' || e.kind === 'document' || e.kind === 'ticket'
        ? { kind: e.kind, value: labels.get(keyOf(e)) ? e.value : '', label: labels.get(keyOf(e)) ?? null }
        : { kind: e.kind, value: e.value },
    ),
  };
}

/** Names and roles only (exports, /api/v1, MCP, reports): the decision without contact ids. */
export const decisionNames = (d: DocumentedDecision | null): { decidedBy: Pick<ContactSnapshot, 'name' | 'role'>[]; decidedOn: string } | null =>
  d ? { decidedBy: d.decidedBy.map((x) => ({ name: x.name, role: x.role })), decidedOn: d.decidedOn } : null;

/** What a seal covers of a decision: everything but the contacts' ids, so erasing a contact keeps the seal. */
export function sealedDecision(raw: string | null | undefined): unknown {
  const d = parseJson<DocumentedDecision | null>(raw ?? null, null);
  if (!d) return null;
  return { ...d, decidedBy: (d.decidedBy ?? []).map((x) => ({ name: x.name, role: x.role })) };
}

/** A decision frozen from Steward users (the upgrade): person contacts linked to them, as `snapshots` gives them. */
export function decisionOfUsers(
  snapshots: ContactSnapshot[],
  decidedAt: string,
  recordedBy: string,
  note = '',
  evidence: DocumentedEvidence[] = [],
): DocumentedDecision {
  return { decidedBy: snapshots, decidedOn: decidedAt.slice(0, 10), evidence, note: note.slice(0, 2000), recordedBy, recordedAt: decidedAt };
}

// ---------- the directory's hooks ----------

/** The JSON columns that hold documented decisions. */
const DECISION_COLUMNS: readonly { table: string; key: string }[] = [
  { table: 'dp_consumers', key: 'id' },
  { table: 'dp_port_reviews', key: 'id' },
  { table: 'dp_endorsements', key: 'product_id' },
  { table: 'dp_semantic_signoffs', key: 'id' },
];

/** Documented decisions that name these contacts, per contact id (the contact's where-used page counts them). */
export function countDecisions(contactIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!contactIds.length) return out;
  const wanted = new Set(contactIds);
  for (const c of DECISION_COLUMNS)
    for (const r of db().all<{ decision: string }>(`SELECT decision FROM ${c.table} WHERE decision IS NOT NULL AND decision LIKE '%"contactId":"ct_%'`))
      for (const id of new Set(parseJson<DocumentedDecision | null>(r.decision, null)?.decidedBy.map((x) => x.contactId) ?? []))
        if (id && wanted.has(id)) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

/** An erased contact (GDPR Art. 17): its id becomes null in every snapshot, its name stays (evidence). */
export function forgetErasedContact(contactId: string): void {
  const needle = `%"contactId":"${contactId.replace(/[%_\\]/g, (m) => `\\${m}`)}"%`;
  for (const c of DECISION_COLUMNS)
    for (const r of db().all<{ k: string; decision: string }>(`SELECT ${c.key} AS k, decision FROM ${c.table} WHERE decision LIKE ? ESCAPE '\\'`, needle)) {
      const d = parseJson<DocumentedDecision | null>(r.decision, null);
      if (!d) continue;
      d.decidedBy = d.decidedBy.map((x) => (x.contactId === contactId ? { ...x, contactId: null } : x));
      db().run(`UPDATE ${c.table} SET decision = ? WHERE ${c.key} = ?`, JSON.stringify(d), r.k);
    }
}

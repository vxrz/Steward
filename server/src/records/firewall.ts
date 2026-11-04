import {
  FIREWALL_RULE_IDENTITY,
  FIREWALL_RULES_COLUMNS,
  FIREWALL_RULES_TYPE_ID,
  FIREWALL_TYPE_ID,
  tableRows,
  type FirewallChangeRef,
  type FirewallRulesDocument,
  type SystemFirewall,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { canEditRecord, canReadRecordRow, canViewCatalogue, type ActionReason } from './access.js';
import { HttpError, parseJson } from '../util.js';
import { owningTeams, setOwningTeams } from '../auth/policy.js';
import { docRow, documentStates, editionRow } from './document-model.js';
import { attachmentRows, type RecordRow } from './model.js';
import { createRecord, revise, transition, updateRecord } from './service.js';
import { typeRow } from './types.js';
import { listTickets } from '../tickets/service.js';

/**
 * Firewall changes (FWC) and the approved firewall rules (FWR) of segments and systems (#208).
 *
 * - A firewall change names the segments and systems it affects as links (kind "system") and lists rule lines in its
 *   table field "rules"; each line adds (or changes) or removes a rule.
 * - It is verified by someone other than the implementer (change workflow, verify) after evidence was added (an
 *   evidence file or a link to the run that collected it), and only then closed.
 * - Closing it applies its lines to the "Approved firewall rules" document of each affected item – a new one when
 *   there is none – and submits that edition, so an approver (four-eyes: not the person who closed the change)
 *   confirms the approved state. A document that already waits for approval stops the close until it is decided.
 */

type Row = Record<string, string>;

export const isFirewallChange = (r: Pick<RecordRow, 'type_id'>): boolean => r.type_id === FIREWALL_TYPE_ID;

/** The systems a record links to (all of them, also those the reader may not see). */
function linkedSystems(recordId: string): { id: string; name: string; owners: string }[] {
  return db().all<{ id: string; name: string; owners: string }>(
    "SELECT s.id, s.name, s.owners FROM item_links l JOIN systems s ON s.id = l.to_id WHERE l.from_kind = 'record' AND l.from_id = ? AND l.to_kind = 'system' ORDER BY s.name",
    recordId,
  );
}

/** Why an action of a firewall change is not possible yet (on top of the workflow's rules), or null. */
export function firewallActionReason(r: RecordRow, action: string): ActionReason | null {
  if (!isFirewallChange(r)) return null;
  if (action === 'submit' && !linkedSystems(r.id).length)
    return { code: 'FWC_AFFECTED_REQUIRED', message: 'Link the network segments or systems this firewall change affects first' };
  if (action === 'verify') {
    const evidence = attachmentRows(r.id, 'evidence').length > 0;
    const run = !!db().get("SELECT 1 FROM item_links WHERE from_kind = 'record' AND from_id = ? AND to_kind = 'run'", r.id);
    if (!evidence && !run)
      return {
        code: 'FWC_EVIDENCE_REQUIRED',
        message: "Add the evidence first: a file (e.g. the provider's confirmation or a rule export) or a link to the run that collected it",
      };
  }
  if (action === 'close' && r.status !== 'verified')
    return { code: 'FWC_VERIFY_FIRST', message: 'A firewall change is verified by a second person before it is closed' };
  return null;
}

// ---------- rules ----------

const identity = (row: Row) => FIREWALL_RULE_IDENTITY.map((k) => (row[k] ?? '').trim().toLowerCase()).join('\u0000');
const RULE_KEYS = FIREWALL_RULES_COLUMNS.map((c) => c.key).filter((k) => k !== 'approvedBy');

/** The approved rules after a change: "remove" lines take matching rules out, the others add or replace them. */
export function mergeRules(current: Row[], lines: Row[], changeNumber: string): Row[] {
  const out = current.map((r) => ({ ...r }));
  for (const line of lines) {
    const i = out.findIndex((r) => identity(r) === identity(line));
    if (line.change === 'remove') {
      if (i >= 0) out.splice(i, 1);
      continue;
    }
    const rule: Row = Object.fromEntries([...RULE_KEYS.map((k) => [k, line[k] ?? '']), ['approvedBy', changeNumber]]);
    if (i >= 0) out[i] = rule;
    else out.push(rule);
  }
  return out;
}

/** What a line of a change does against the approved rules: a new rule, a changed one, the same, a removal, or a removal of nothing. */
export type RuleComparison = 'new' | 'changed' | 'same' | 'removes' | 'notFound';

export function compareRules(current: Row[], lines: Row[]): RuleComparison[] {
  return lines.map((line) => {
    const found = current.find((r) => identity(r) === identity(line));
    if (line.change === 'remove') return found ? 'removes' : 'notFound';
    if (!found) return 'new';
    return RULE_KEYS.every((k) => (found[k] ?? '').trim() === (line[k] ?? '').trim()) ? 'same' : 'changed';
  });
}

// ---------- the approved rules documents ----------

type DocRecord = RecordRow;

/** The approved-rules documents that link to a system (withdrawn ones left out), newest first. */
function rulesDocuments(systemId: string): DocRecord[] {
  return db().all<DocRecord>(
    `SELECT r.* FROM item_links l JOIN records r ON r.id = l.from_id
     WHERE l.from_kind = 'record' AND l.to_kind = 'system' AND l.to_id = ? AND r.type_id = ? AND r.status <> 'withdrawn'
     ORDER BY r.created_at DESC`,
    systemId,
    FIREWALL_RULES_TYPE_ID,
  );
}

/** The rules a document shows: those of its current edition, or of its draft before the first approval. */
function approvedRulesOf(d: DocRecord): Row[] {
  const current = docRow(d.id)?.current_edition;
  const e = current ? editionRow(d.id, current) : undefined;
  const fields = parseJson<Record<string, string>>(e ? e.fields : d.fields, {});
  return tableRows(fields.approvedRules);
}

/** The rules a document has now (the draft of the next edition while it is revised). */
const draftRulesOf = (d: DocRecord): Row[] => tableRows(parseJson<Record<string, string>>(d.fields, {}).approvedRules);

interface Step {
  system: { id: string; name: string };
  doc: DocRecord | null;
}

/**
 * Checks before a firewall change is closed (the caller runs it before its transaction): every affected system is
 * visible to the person closing it and its approved rules can take the change.
 */
export function planClose(r: RecordRow): Step[] {
  if (!isFirewallChange(r)) return [];
  const t = typeRow(FIREWALL_RULES_TYPE_ID);
  // an installation that archived the approved rules type does without them
  if (!t || t.archived) return [];
  const u = currentUser();
  const steps: Step[] = [];
  const seen = new Set<string>();
  for (const s of linkedSystems(r.id)) {
    if (u && !canViewCatalogue(u, { kind: 'system', id: s.id, owners: parseJson<string[]>(s.owners, []) }))
      throw new HttpError(403, 'This firewall change affects a system you may not see: someone who sees it closes the change', 'FWC_SYSTEM_HIDDEN');
    const doc = rulesDocuments(s.id)[0] ?? null;
    if (doc) {
      if (!u || !canEditRecord(u, doc) || !canReadRecordRow(u, doc))
        throw new HttpError(403, `You may not change the approved firewall rules of "${s.name}"`, 'FWC_RULES_FORBIDDEN', { name: s.name });
      if (doc.status === 'in_review')
        throw new HttpError(
          409,
          `The approved firewall rules ${doc.number} of "${s.name}" wait for the approval of an earlier change: approve or reject that edition first`,
          'FWC_RULES_IN_REVIEW',
          { number: doc.number, name: s.name },
        );
    }
    // one document for several affected systems takes the change once
    if (doc && seen.has(doc.id)) continue;
    if (doc) seen.add(doc.id);
    steps.push({ system: { id: s.id, name: s.name }, doc });
  }
  return steps;
}

/**
 * Applies a closed firewall change to the approved rules (in the caller's transaction): drafts the next edition of
 * each document (or a first document), writes the merged rules and submits it for approval.
 */
export function applyClose(r: RecordRow, steps: Step[]): void {
  const lines = tableRows(parseJson<Record<string, string>>(r.fields, {}).rules);
  const summary = `${r.number}: ${r.title}`.slice(0, 2000);
  const why = `Firewall change ${r.number} closed`;
  for (const step of steps) {
    let doc = step.doc;
    if (!doc) {
      const made = createRecord({
        type: FIREWALL_RULES_TYPE_ID,
        title: `Approved firewall rules – ${step.system.name}`.slice(0, 300),
        fields: { approvedRules: JSON.stringify(mergeRules([], lines, r.number)) },
        links: [{ kind: 'system', id: step.system.id, note: 'applies to' }],
      });
      // the rules belong to the teams of the change (none: the creator's, as for any new record)
      const teams = owningTeams('record', r.id).map((x) => x.id);
      if (teams.length) setOwningTeams('record', made.id, teams);
      transition(made.id, { action: 'submit', changeSummary: summary });
      continue;
    }
    if (doc.status === 'published') {
      revise(doc.id, why);
      doc = db().get<DocRecord>('SELECT * FROM records WHERE id = ?', doc.id)!;
    }
    const fields = parseJson<Record<string, string>>(doc.fields, {});
    updateRecord(doc.id, { fields: { ...fields, approvedRules: JSON.stringify(mergeRules(draftRulesOf(doc), lines, r.number)) }, comment: why });
    const edition = docRow(doc.id)?.current_edition;
    transition(doc.id, { action: 'submit', changeSummary: summary, ...(edition ? { editionKind: 'minor' as const } : {}) });
  }
}

// ---------- reading ----------

const readable = (u: AuthUser | null, r: RecordRow) => !!u && canReadRecordRow(u, r);

/** The firewall part of a system page: its approved rules, the firewall changes and the tickets that name it. */
export function firewallOf(systemId: string): SystemFirewall {
  const u = currentUser();
  const docs = rulesDocuments(systemId).filter((d) => readable(u, d));
  const states = documentStates(
    undefined,
    undefined,
    docs.map((d) => d.id),
  );
  const documents: FirewallRulesDocument[] = docs.map((d) => {
    const st = states.get(d.id);
    return {
      id: d.id,
      number: d.number,
      title: d.title,
      status: d.status,
      edition: st?.edition ?? null,
      reviewStatus: st?.review.status ?? 'none',
      nextReviewAt: st?.review.nextReviewAt ?? null,
      daysLeft: st?.review.daysLeft ?? null,
      rules: approvedRulesOf(d),
      pending: d.status === 'in_review' || d.status === 'revising',
    };
  });
  const changes: FirewallChangeRef[] = db()
    .all<RecordRow>(
      `SELECT r.* FROM item_links l JOIN records r ON r.id = l.from_id
       WHERE l.from_kind = 'record' AND l.to_kind = 'system' AND l.to_id = ? AND r.type_id = ? ORDER BY r.updated_at DESC`,
      systemId,
      FIREWALL_TYPE_ID,
    )
    .filter((r) => readable(u, r))
    .map((r) => {
      const f = parseJson<Record<string, string>>(r.fields, {});
      return {
        id: r.id,
        number: r.number,
        title: r.title,
        status: r.status,
        done: r.status === 'closed' || r.status === 'cancelled',
        implementer: f.implementer ?? null,
        providerTicket: f.providerTicket ?? null,
        ruleCount: tableRows(f.rules).length,
        updatedAt: r.updated_at,
      };
    });
  const tickets = u
    ? listTickets({ link: `system:${systemId}` }).map((x) => ({
        id: x.id,
        source: x.source,
        sourceLabel: x.sourceLabel,
        externalNumber: x.externalNumber,
        externalUrl: x.externalUrl,
        title: x.title,
        status: x.status,
      }))
    : [];
  return { documents, changes, tickets };
}

/** For a firewall change: per affected system the reader may see, its approved rules and what each line does to them. */
export function firewallContext(r: RecordRow): {
  items: {
    system: { id: string; name: string };
    document: { id: string; number: string; edition: string | null; status: string } | null;
    comparison: RuleComparison[];
  }[];
} {
  const u = currentUser();
  const lines = tableRows(parseJson<Record<string, string>>(r.fields, {}).rules);
  const items = linkedSystems(r.id)
    .filter((s) => !u || canViewCatalogue(u, { kind: 'system', id: s.id, owners: parseJson<string[]>(s.owners, []) }))
    .map((s) => {
      const doc = rulesDocuments(s.id).find((d) => readable(u, d)) ?? null;
      return {
        system: { id: s.id, name: s.name },
        document: doc ? { id: doc.id, number: doc.number, edition: docRow(doc.id)?.current_edition ?? null, status: doc.status } : null,
        comparison: compareRules(doc ? approvedRulesOf(doc) : [], lines),
      };
    });
  return { items };
}

import { z } from 'zod';
import {
  boundedRecord,
  MCP_REQUEST_LIMITS,
  PLANT_FORMAT_VERSION,
  PLANT_PROPOSAL_LIMITS,
  type McpPlantPreview,
  type McpPlantProposal,
  type McpProposalSelection,
  type PlantChange,
  type PlantImportPreview,
  type PlantImportResult,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { me } from '../auth/access.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { HttpError, parseJson, sha256 } from '../util.js';
import { ToolError, defineTool, type ToolContext, type ToolDef } from '../mcp/tooling.js';
import { registerReviewKind, saveProposal, type Row } from '../mcp/requests.js';
import { asProposer, canManageCatalogue, plantManagesSome, plantProposesSome, siteRights } from './access.js';
import { samePerson } from '../auth/assurance.js';
import { withAuditDetails } from '../audit.js';
import { applyStored, insertChangeSet, insertOp, quietDryRun, reviewNeeded, sourceOf, type CsRow } from './changesets/core.js';
import { plantEnabled } from './settings.js';
import { applyImport, importInput, previewImport, type ImportInput } from './import.js';
import { issueMessages, plantFileSchema, SCHEMA_ID } from './format.js';
import { redactValue } from './collections-redact.js';
import { combineParts, PartConflict, PartKeyRefused } from './proposal-parts.js';
import { proposalSources } from './proposal-sources.js';

/**
 * Changes to the plant registry proposed by AI assistants (0.12.0, docs/PLANT.md "Proposals from assistants"). An
 * assistant connected through MCP sends a document of the plant import format; Steward checks it with the import's
 * preview – a dry run, with the rights of the token owner – and stores it as a proposal in the AI requests inbox. Nothing
 * is written until a person who may import into the registry applies it there: the preview runs again with their rights,
 * a preview that changed since the proposal needs their confirmation, and the import core applies it in one transaction.
 *
 * A proposal only adds and changes: `remove:`, removing entries that are not in the document, renaming ids and the
 * import's replace mode are refused – when proposed and again when applied.
 */

/**
 * What a proposal's request carries (mcp_requests.payload); the document and its preview are in its change set (0.13),
 * or in plant_proposals (0.12). 0.17.0: while the assistant is still sending parts, the parts received so far are kept
 * here (`documents`, each as sent) – there is no change set yet; the last part makes it one and leaves only the count.
 */
interface Payload {
  type: 'plant';
  title: string;
  incomplete: boolean;
  added: number;
  changed: number;
  /** 0.17.0: the number of parts (left out: one) */
  parts?: number;
  /** 0.17.0: the parts received so far, while incomplete */
  documents?: string[];
}

interface ProposalRow {
  id: string;
  title: string;
  document: string;
  sha256: string;
  preview: string;
  fingerprint: string;
  import_id: string | null;
}

/** The preview as stored with the proposal: checks keep the site they are about (left out for who may not see it). */
type Stored = Omit<McpPlantPreview, 'checks'> & { checks: { code: string; message: string; siteId: string | null }[] };

const payloadOf = (r: Pick<Row, 'payload'>): Payload => parseJson<Payload>(r.payload, { type: 'plant', title: '', incomplete: false, added: 0, changed: 0 });
/** 0.17.0: the assistant is still sending parts – nobody reviews it yet. */
const unfinished = (r: Pick<Row, 'payload'>): boolean => !!payloadOf(r).incomplete;
/** The payload without the parts' documents (what stays when it is complete, withdrawn or expired). */
const withoutDocuments = ({ documents, ...p }: Payload): Payload => ({ ...p, parts: documents?.length ?? p.parts ?? 0 });

/** 0.13.0: a proposal is a change set (source assistant) on its MCP request; proposals decided in 0.12 stay in plant_proposals. */
const changeSetOf = (requestId: string): CsRow | undefined => db().get<CsRow>('SELECT * FROM plant_change_sets WHERE mcp_request_id = ?', requestId);
function rowOf(id: string): (ProposalRow & { changeSetId: string | null }) | undefined {
  const cs = changeSetOf(id);
  if (cs) {
    const src = db().get<{ content: string; sha256: string }>('SELECT content, sha256 FROM plant_change_sources WHERE change_set_id = ? AND seq = 1', cs.id);
    return {
      id,
      title: cs.title,
      document: src?.content ?? sourceOf(cs.id, 1) ?? '{}',
      sha256: src?.sha256 ?? '',
      preview: cs.preview,
      fingerprint: cs.fingerprint,
      import_id: cs.import_id,
      changeSetId: cs.id,
    };
  }
  const legacy = db().get<ProposalRow>('SELECT * FROM plant_proposals WHERE id = ?', id);
  return legacy ? { ...legacy, changeSetId: null } : undefined;
}

/** Whether a proposal's change set needs a second person (then its token owner never applies it). */
const needsReview = (requestId: string): boolean => {
  const cs = changeSetOf(requestId);
  return !!cs && reviewNeeded(parseJson<string[]>(cs.sites, []), !!Number(cs.catalogue));
};

/** The import's input for a proposal: the document as a file, adding and changing only (never replace, remove or rename). */
const inputOf = (document: string): ImportInput =>
  importInput.parse({ files: [{ name: 'proposal.json', content: document }], mode: 'update', removeMissing: false, cascade: false });

/** Keys of an import that remove, rename or replace: never in a proposal. */
const REFUSED_KEYS: Record<string, string> = {
  remove: 'A proposal may only add and change entries: leave out `remove` – removing entries is done by a person in Steward',
  removeMissing: 'A proposal may only add and change entries: removing what a document does not have is not possible',
  cascade: 'A proposal may only add and change entries: nothing is removed, so there is nothing to take along',
  idMap: 'A proposal cannot change ids: renaming entries is done by a person in Steward (Change id)',
  renames: 'A proposal cannot change ids: renaming entries is done by a person in Steward (Change id)',
  rename: 'A proposal cannot change ids: renaming entries is done by a person in Steward (Change id)',
  mode: 'A proposal adds and changes (the import mode "update"); another mode is not possible',
  missing: 'A proposal may only add and change entries: entries the document does not have stay as they are',
  replaces: 'A proposal cannot replace an earlier import: it only adds and changes',
};

/**
 * Where a document holds something that looks like a credential (0.12): the values the redaction of kept collector
 * configurations would remove – a secret-looking key or name/value pair (password, token, API key, Authorization …),
 * a password in a URL. A proposal never carries one: it is refused, nothing is stored.
 */
function secretPaths(doc: unknown): string[] {
  const { value } = redactValue(doc);
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, at: string) => {
    if (out.length >= 20) return;
    if (typeof a === 'string' || typeof b === 'string') {
      if (a !== b) out.push(at || '(document)');
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object')
      for (const k of Object.keys(a as object))
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${at}[${k}]` : at ? `${at}.${k}` : k);
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(at || '(document)');
  };
  walk(doc, value, '');
  return out;
}

/** Items the changes would drop from lists inside their entries (a proposal may change an item, never drop it). */
function dropsOf(p: PlantImportPreview): { entry: string; path: string }[] {
  return p.changes.flatMap((c) => (c.drops ?? []).map((path) => ({ entry: `${c.kind} "${c.id}"`, path })));
}
const dropText = (d: { entry: string; path: string }) => `${d.entry} would lose ${d.path}`;

/** What a preview may not hold for a proposal (also when applied: the registry may have changed). */
function refusedByPreview(p: PlantImportPreview): string | null {
  if (p.renames.length) return 'A proposal cannot change ids';
  if (p.counts.remove || p.counts.mark || p.removals?.items.length) return 'A proposal may only add and change entries';
  const drops = dropsOf(p);
  if (drops.length) return `A proposal may not drop items from an entry: ${drops.slice(0, 5).map(dropText).join('; ')}`;
  return null;
}

/** The first item a preview would drop, as the refusal of applying it. */
function refuseDrops(p: PlantImportPreview): void {
  const d = dropsOf(p)[0];
  if (d) throw new HttpError(409, `A proposal may not drop items from an entry: ${dropText(d)}`, 'PLANT_PROPOSAL_REMOVES', d);
}

/** The preview reduced to what a proposal shows: added and changed entries (unchanged and skipped ones are left out). */
function stored(p: PlantImportPreview): Stored {
  return {
    counts: { add: p.counts.add, change: p.counts.change },
    changes: p.changes.filter((c) => c.action === 'add' || c.action === 'change'),
    warnings: p.warnings.slice(0, 50),
    checks: p.checks.slice(0, 100).map((c) => ({ code: c.code, message: c.message, siteId: c.subject.kind === 'asset' ? c.subject.siteId : null })),
  };
}

/** What the preview would write: the same fingerprint means the same entries, fields and values. */
function fingerprintOf(s: Pick<Stored, 'changes'>): string {
  const key = (c: PlantChange) => `${c.kind}\u0000${c.siteId}\u0000${c.id}\u0000${c.action}`;
  const changes = [...s.changes].sort((a, b) => key(a).localeCompare(key(b))).map((c) => [key(c), c.fields ?? [], c.diff ?? []]);
  return sha256(JSON.stringify(changes)).slice(0, 32);
}

/** A preview as `u` may see it: entries and checks of sites they may not see are left out (new sites are shown). */
function seesFor(u: AuthUser): (siteId: string | null) => boolean {
  const rows = db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites');
  const rights = siteRights(rows, u);
  return (siteId: string | null) => !siteId || !rights.has(siteId) || !!rights.get(siteId)?.includes('view');
}
function forReader(s: Stored, u: AuthUser): { preview: McpPlantPreview; hidden: number } {
  const sees = seesFor(u);
  const changes = s.changes.filter((c) => sees(c.siteId));
  return {
    preview: {
      counts: s.counts,
      changes,
      warnings: s.warnings,
      checks: s.checks.filter((c) => sees(c.siteId)).map(({ code, message }) => ({ code, message })),
    },
    hidden: s.changes.length - changes.length,
  };
}

/** The preview of now, as `u` (null: `u` may not import into the registry). */
function previewNow(p: ProposalRow): { preview: PlantImportPreview; stored: Stored } | null {
  let preview: PlantImportPreview;
  try {
    preview = proposerPreview(p.document);
  } catch (e) {
    if (e instanceof HttpError && (e.statusCode === 403 || e.statusCode === 404)) return null;
    throw e;
  }
  return { preview, stored: stored(preview) };
}

const mayApply = (u: AuthUser) => plantEnabled() && plantManagesSome(u);

/**
 * The import's preview of a proposal's document with the rights of who asks: who may only propose (0.13.0) sees what it
 * would do with their propose right counted as manage, in a transaction that is rolled back.
 */
function proposerPreview(document: string): PlantImportPreview {
  return quietDryRun(() => asProposer(() => previewImport(inputOf(document))));
}

/** 0.13.0: the preview fingerprint of a proposal now (Plant → Changes applies it through its request). */
export function proposalFingerprintNow(requestId: string): string {
  const p = rowOf(requestId);
  const n = p ? previewNow(p) : null;
  return n ? fingerprintOf(n.stored) : '';
}

function view(r: Row, u: AuthUser): McpPlantProposal {
  const p = rowOf(r.id);
  const pay = payloadOf(r);
  const empty: McpPlantPreview = { counts: { add: 0, change: 0 }, changes: [], warnings: [], checks: [] };
  // 0.17.0: still coming in parts – only its owner (and who reads every request) sees it, without a preview yet; once
  // withdrawn or expired without its last part, it was never proposed
  if (pay.incomplete)
    return {
      type: 'plant',
      title: pay.title,
      incomplete: r.status === 'pending',
      unfinished: true,
      document: { bytes: (pay.documents ?? []).reduce((n, d) => n + Buffer.byteLength(d), 0), sha256: '' },
      proposed: empty,
      now: null,
      changedSince: false,
      hidden: 0,
      importId: null,
      changeSetId: null,
      parts: pay.documents?.length ?? pay.parts ?? 0,
    };
  if (!p)
    return {
      type: 'plant',
      title: pay.title,
      incomplete: false,
      document: { bytes: 0, sha256: '' },
      proposed: empty,
      now: null,
      changedSince: false,
      hidden: 0,
      importId: null,
      changeSetId: null,
    };
  const proposed = forReader(parseJson<Stored>(p.preview, { ...empty, checks: [] }), u);
  // the preview of now only while it can still be applied, and for who may apply it
  let now: McpPlantProposal['now'] = null;
  if (r.status === 'pending' && r.expires_at > new Date().toISOString() && mayApply(u)) {
    const n = previewNow(p);
    if (n) {
      const seen = forReader(n.stored, u);
      const refused = refusedByPreview(n.preview);
      now = {
        ...seen.preview,
        ok: n.preview.ok && !refused,
        problems: [...n.preview.problems.slice(0, 50), ...(refused ? [{ file: '(proposal)', path: '(document)', message: refused }] : [])],
        fingerprint: fingerprintOf(n.stored),
      };
    }
  }
  // 0.17.0: the data points it adds or changes with their source, and whether that document is kept in Steward
  const sources = proposalSources(p.document, seesFor(u));
  return {
    type: 'plant',
    title: p.title,
    incomplete: false,
    document: { bytes: Buffer.byteLength(p.document), sha256: p.sha256 },
    proposed: proposed.preview,
    now,
    changedSince: !!now && now.fingerprint !== p.fingerprint,
    hidden: proposed.hidden,
    importId: p.import_id,
    changeSetId: p.changeSetId,
    parts: pay.parts ?? 1,
    sources: sources.groups,
    sourcesMore: sources.more,
  };
}

/** Before the request is claimed: the reviewer may import, the preview is clean, and a changed preview is confirmed. */
function precheck(r: Row, selection: McpProposalSelection | undefined, u: AuthUser): void {
  if (!mayApply(u)) throw new HttpError(403, 'You may not change the plant registry', 'MCP_REQUEST_APPROVE');
  // under review (plant.changeSet) the token owner never applies their assistant's proposal, administrators included
  if (needsReview(r.id) && samePerson(r.requested_by, u))
    throw new HttpError(409, 'A second person applies it: it is your assistant’s proposal', 'PLANT_CHANGESET_OWN', { id: r.id });
  const p = rowOf(r.id);
  if (!p) throw new HttpError(404, `Request ${r.id} not found`, 'MCP_REQUEST_NOT_FOUND', { id: r.id });
  const n = previewNow(p);
  if (!n) throw new HttpError(403, 'You may not change the plant registry', 'MCP_REQUEST_APPROVE');
  // the registry may have changed since: what applying it would drop now is refused, too
  refuseDrops(n.preview);
  const refused = refusedByPreview(n.preview);
  if (!n.preview.ok || refused)
    throw new HttpError(
      409,
      `The proposal cannot be applied now: ${refused ?? n.preview.problems[0]?.message ?? 'see the preview'}`,
      'PLANT_PROPOSAL_INVALID',
      {
        count: n.preview.problems.length + (refused ? 1 : 0),
      },
    );
  const fp = fingerprintOf(n.stored);
  const confirmed = selection?.plant?.fingerprint;
  // what the reviewer saw is what is applied: a changed preview needs their confirmation of it
  if ((confirmed && confirmed !== fp) || (!confirmed && fp !== p.fingerprint))
    throw new HttpError(409, 'What the proposal changes is no longer what it was – look at the preview of now and confirm it', 'PLANT_PROPOSAL_CHANGED');
}

/** Applies the proposal as the reviewer, through the change sets' apply core (history, revisions) in one transaction. */
function apply(r: Row, selection: McpProposalSelection | undefined, u: AuthUser) {
  const p = rowOf(r.id);
  if (!p) throw new HttpError(404, `Request ${r.id} not found`, 'MCP_REQUEST_NOT_FOUND', { id: r.id });
  const expected = selection?.plant?.fingerprint ?? p.fingerprint;
  // the same check as before the claim (one synchronous step): a difference rolls everything back
  const check = (result: PlantImportResult) => {
    refuseDrops(result);
    const refused = refusedByPreview(result);
    if (refused || fingerprintOf(stored(result)) !== expected)
      throw new HttpError(409, refused ?? 'What the proposal changes is no longer what it was', 'PLANT_PROPOSAL_CHANGED');
  };
  return db().tx(() => {
    let result: PlantImportResult;
    if (p.changeSetId) {
      const done = applyStored(p.changeSetId, null, u, {
        viaRequest: true,
        check: (imports) => {
          if (!imports[0]) throw new HttpError(409, 'What the proposal changes is no longer what it was', 'PLANT_PROPOSAL_CHANGED');
          check(imports[0]);
        },
      });
      result = done.imports[0]!;
    } else {
      result = applyImport(inputOf(p.document));
      check(result);
      db().run('UPDATE plant_proposals SET import_id = ? WHERE id = ?', result.import.id, p.id);
    }
    withAuditDetails(p.changeSetId ? { changeSetId: p.changeSetId } : {}, () =>
      audit({
        action: 'plant.proposal_applied',
        entityType: 'plant_import',
        entityId: result.import.id,
        summary: `Plant registry changes "${p.title}" proposed by ${r.requested_by}'s AI assistant applied by ${u.username}: ${result.counts.add} added, ${result.counts.change} changed`,
        details: {
          requestId: r.id,
          requestedBy: r.requested_by,
          tokenName: r.token_name,
          counts: result.counts,
          sha256: p.sha256,
          confirmedChange: !!selection?.plant,
        },
      }),
    );
    return { body: { importId: result.import.id, added: result.counts.add, changed: result.counts.change } };
  });
}

/** Who is told about a proposal: the token owner (when they may import) and who manages the catalogues. */
function deciders(r: Row): UserInfo[] {
  if (!plantEnabled()) return [];
  return listUsers().filter((x) => {
    if (!x.active) return false;
    const u = toAuthUser(x);
    // under review the token owner is no decider of their assistant's proposal
    return x.username.toLowerCase() === r.requested_by.toLowerCase() ? plantManagesSome(u) && !needsReview(r.id) : canManageCatalogue(u);
  });
}

registerReviewKind('plant', {
  // 0.17.0: an unfinished proposal is no reviewer's yet (its owner sees it, may withdraw it; nobody accepts it)
  mayAccept: (u, r) => !unfinished(r) && mayApply(u) && !(needsReview(r.id) && samePerson(r.requested_by, u)),
  deciders,
  describe: (r) => {
    const p = payloadOf(r);
    if (p.incomplete) return `plant registry changes "${p.title}" (${p.documents?.length ?? 0} part(s) so far)`;
    return `plant registry changes "${p.title}" (${p.added} added, ${p.changed} changed${p.parts && p.parts > 1 ? `, in ${p.parts} parts` : ''})`;
  },
  summary: (r) => {
    const p = payloadOf(r);
    return { type: 'plant', title: p.title, added: p.added, changed: p.changed };
  },
  view,
  precheck,
  apply,
  // 0.17.0: the parts of an unfinished proposal are not kept once it is closed
  onExpired: (r) => {
    if (unfinished(r)) db().run('UPDATE mcp_requests SET payload = ? WHERE id = ?', JSON.stringify(withoutDocuments(payloadOf(r))), r.id);
  },
  onRejected: (r, u, o) => {
    if (unfinished(r)) db().run('UPDATE mcp_requests SET payload = ? WHERE id = ?', JSON.stringify(withoutDocuments(payloadOf(r))), r.id);
    const cs = changeSetOf(r.id);
    if (cs)
      db().run(
        "UPDATE plant_change_sets SET state = ?, decided_at = ?, decided_by = ?, comment = ?, updated_at = ?, expires_at = NULL WHERE id = ? AND state = 'proposed'",
        o.withdrawn ? 'withdrawn' : 'rejected',
        new Date().toISOString(),
        u.username,
        o.comment,
        new Date().toISOString(),
        cs.id,
      );
    audit({
      action: 'plant.proposal_rejected',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `Plant registry changes "${payloadOf(r).title}" proposed by ${r.requested_by}'s AI assistant ${o.withdrawn ? 'withdrawn' : `rejected by ${u.username}`}${o.comment ? ` – ${o.comment.slice(0, 200)}` : ''}`,
      details: {
        requestId: r.id,
        requestedBy: r.requested_by,
        withdrawn: o.withdrawn,
        comment: o.comment,
        ...(cs ? { changeSetId: cs.id } : {}),
        ...(unfinished(r) ? { unfinished: true, parts: payloadOf(r).documents?.length ?? 0 } : {}),
      },
    });
  },
});

// ---------- the tool ----------

/** 0.13.0: an assistant may propose with its owner's `propose` right instead of `manage`. */
const mayPropose = () => plantEnabled() && (plantManagesSome(me()) || plantProposesSome(me()));

const KNOWN = new Set(['title', 'rationale', 'document', 'proposalId', 'more']);
const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;
const L = PLANT_PROPOSAL_LIMITS;

/** A document holding what looks like a credential is refused (each part, and the parts combined). */
function refuseSecrets(doc: unknown, what: string): void {
  const secrets = secretPaths(doc);
  if (secrets.length)
    throw new ToolError(
      `${what} holds what looks like a credential – nothing was proposed. Leave out passwords, tokens, keys and passwords in URLs (Steward never keeps them; a setting may say "[redacted]"):\n${secrets.map((p) => `- ${p}`).join('\n')}`,
    );
}

/** The import's preview of a document as the token owner, its refusals as the assistant reads them. */
function previewFor(document: string): PlantImportPreview {
  try {
    return proposerPreview(document);
  } catch (e) {
    if (e instanceof HttpError && e.statusCode < 500) throw new ToolError(e.message);
    throw e;
  }
}

const problemLines = (p: PlantImportPreview, max: number) =>
  p.problems
    .slice(0, max)
    .map((x) => `- ${x.path}: ${x.message}`)
    .join('\n');

/** Bytes of the open proposals of the token owner besides `except` (their documents, their parts so far). */
function openBytes(username: string, except: string | null): number {
  const sum = (sql: string) => Number(db().get<{ n: number | null }>(sql, username, except ?? '')?.n ?? 0);
  return (
    sum(`SELECT SUM(LENGTH(s.content)) AS n FROM plant_change_sources s JOIN plant_change_sets c ON c.id = s.change_set_id
         JOIN mcp_requests r ON r.id = c.mcp_request_id WHERE r.requested_by = ? AND r.status = 'pending' AND r.id <> ?`) +
    sum(
      "SELECT SUM(LENGTH(p.document)) AS n FROM plant_proposals p JOIN mcp_requests r ON r.id = p.id WHERE r.requested_by = ? AND r.status = 'pending' AND r.id <> ?",
    ) +
    // 0.17.0: the parts of unfinished proposals
    sum("SELECT SUM(LENGTH(payload)) AS n FROM mcp_requests WHERE requested_by = ? AND status = 'pending' AND kind = 'plant' AND id <> ?")
  );
}

/** The token owner's unfinished proposal a further part belongs to (0.17.0). */
function unfinishedOf(id: string, ctx: ToolContext): Row {
  const r = db().get<Row>('SELECT * FROM mcp_requests WHERE id = ?', id);
  if (!r || r.kind !== 'plant' || r.status !== 'pending' || r.expires_at <= new Date().toISOString() || !samePerson(r.requested_by, ctx.principal.user))
    throw new ToolError(`Proposal ${id} not found, or it is no longer open (an unfinished proposal expires ${L.partExpiryHours} hours after its last part)`);
  if (!unfinished(r)) throw new ToolError(`Proposal ${id} is complete already – start a new proposal for further changes`);
  return r;
}

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/**
 * The last (or only) part: the import's preview of the whole document as the token owner, its refusals, then the
 * proposal – a proposed change set on the AI request – for a person to review. `parts` > 1: the request exists already.
 */
function finish(
  ctx: ToolContext,
  o: { title: string; rationale: string | undefined; document: string; requestId: string | null; parts: number; inTx?: () => void },
): Record<string, unknown> {
  const bytes = Buffer.byteLength(o.document);
  const of = o.parts > 1 ? `The ${o.parts} parts together have` : 'The document has';
  // the import's own checks: the format, the model's rules, the token owner's rights – a dry run
  const preview = previewFor(o.document);
  if (!preview.ok)
    throw new ToolError(
      `${of} ${preview.problems.length} problem(s) – nothing was proposed. Fix them and send it again${o.parts > 1 ? ' (this part again, fixed, or further parts that bring what is missing; the parts so far stay until the proposal expires)' : ''}:\n${problemLines(preview, 30)}`,
    );
  const drops = dropsOf(preview);
  if (drops.length)
    throw new ToolError(
      `A proposal may only add and change: it may change an item of a list, never drop one – nothing was proposed. Send the lists with every item they have now (get_device_profile, get_plant_asset and get_kpi_definition return them), plus your changes:\n${drops
        .slice(0, 20)
        .map((d) => `- ${dropText(d)}`)
        .join('\n')}`,
    );
  const refused = refusedByPreview(preview);
  if (refused) throw new ToolError(refused);
  if (!preview.counts.add && !preview.counts.change) throw new ToolError('The document changes nothing: every entry in it is as it is in Steward already');
  // the proposals of one person together stay small enough for the reviewers' inbox
  if (openBytes(ctx.principal.user.username, o.requestId) + bytes > MCP_REQUEST_LIMITS.proposalBytesPerUser)
    throw new ToolError('Your open proposals are too large together – wait until some are decided (or ask the user to withdraw some in Steward)');
  const snapshot = stored(preview);
  const title = o.title;
  const final: Payload = {
    type: 'plant',
    title,
    incomplete: false,
    added: preview.counts.add,
    changed: preview.counts.change,
    ...(o.parts > 1 ? { parts: o.parts } : {}),
  };
  // the preview above is a dry run (a transaction rolled back): never inside the transaction that keeps the proposal
  const res = db().tx(() => {
    o.inTx?.();
    // the last part: now it is reviewed like any proposal, for as long (the reviewers are told only now)
    if (o.requestId)
      db().run(
        'UPDATE mcp_requests SET expires_at = ? WHERE id = ? AND status = ?',
        hoursFromNow(MCP_REQUEST_LIMITS.proposalExpiryDays * 24),
        o.requestId,
        'pending',
      );
    const created = saveProposal(ctx, 'plant', {
      ...(o.requestId ? { proposalId: o.requestId } : { reason: o.rationale }),
      payload: (prev) => {
        if (o.requestId && ((prev as Payload | null)?.documents?.length ?? 0) !== o.parts - 1)
          throw new ToolError('Another part of this proposal arrived meanwhile – send this part again');
        return { ...final };
      },
    });
    // 0.13.0: a proposed change set (source assistant) on the request – AI requests and Plant → Changes show it
    const sites = [...new Set(preview.changes.map((c) => c.siteId).filter(Boolean))].sort();
    const catalogue = preview.changes.some((c) => c.kind === 'profile' || c.kind === 'kpi');
    const req = db().get<{ expires_at: string }>('SELECT expires_at FROM mcp_requests WHERE id = ?', created.requestId);
    const csId = insertChangeSet({
      state: 'proposed',
      source: 'assistant',
      title,
      by: ctx.principal.user.username,
      mcpRequestId: created.requestId,
      sites,
      catalogue,
      expiresAt: req?.expires_at ?? null,
    });
    insertOp(
      csId,
      {
        op: 'import',
        kind: null,
        scope: '',
        id: '',
        name: title,
        origin: 'derived',
        baseRevision: null,
        base: null,
        value: { proposal: true },
        source: o.document,
      },
      ctx.principal.user.username,
    );
    const at = new Date().toISOString();
    db().run(
      'UPDATE plant_change_sets SET preview = ?, fingerprint = ?, proposed_at = ?, proposed_by = ?, review = ? WHERE id = ?',
      JSON.stringify(snapshot),
      fingerprintOf(snapshot),
      at,
      ctx.principal.user.username,
      reviewNeeded(sites, catalogue) ? 1 : 0,
      csId,
    );
    audit({
      action: 'plant.proposal_created',
      entityType: 'mcp_request',
      entityId: created.requestId,
      summary: `${ctx.principal.user.username}'s AI assistant (token "${ctx.principal.tokenName}") proposes plant registry changes "${title}": ${preview.counts.add} added, ${preview.counts.change} changed${o.parts > 1 ? `, in ${o.parts} parts` : ''} – a person reviews them`,
      details: {
        tokenId: ctx.principal.tokenId,
        counts: preview.counts,
        byKind: preview.byKind,
        bytes,
        sha256: sha256(o.document),
        changeSetId: csId,
        parts: o.parts,
      },
    });
    return { ...created, expiresAt: req?.expires_at ?? created.expiresAt };
  });
  return {
    ...res,
    added: preview.counts.add,
    changed: preview.counts.change,
    ...(o.parts > 1 ? { parts: o.parts } : {}),
    checks: preview.checks.slice(0, 20).map((c) => c.message),
    warnings: preview.warnings.slice(0, 20).map((w) => `${w.path}: ${w.message}`),
  };
}

export const plantProposalTools: ToolDef[] = [
  defineTool({
    name: 'propose_plant_changes',
    title: 'Propose changes to the plant registry',
    description: [
      `Proposes additions and changes to the plant registry as a document of the plant import format (JSON Schema ${SCHEMA_ID}; get_plant_import_format describes it). Steward checks it with the import's preview – nothing is written – and a person who may change the registry reviews it in Steward (AI requests) and applies or rejects it. Only adding and changing: \`remove\`, renaming ids, removing what the document leaves out and dropping an item from a list inside an entry are refused – a list given replaces the list, so send it with every item it has now.`,
      'The document: { "version": 1, ... } with any of sites (each with areas → work_centers → work_units, buildings, assets), assets, device_profiles, kpi_definitions, assignments, ot_networks, asset_networks. Entries are matched by id; an existing entry is updated with the keys the document gives (keys left out keep their values; a list given replaces the list).',
      'Device profiles with inheritance: a profile names its base with "extends" and lists in "interfaces" only what it adds or changes – an entry with an inherited id changes that interface (only the keys it gives; inherited data points in its groups or data_points with the keys that change, e.g. { "id": "spindle_speed", "address": "ns=3;s=…" }); an entry with a new id is an own interface and needs "protocol". Descriptions are inherited too: give one only to describe an item anew.',
      'Sources: when you read a data point from a manual or data sheet, give it a "source": { "document": "<title with version, as the manual names itself – or the number of a record in Steward that keeps it>", "page": "112", "section": "6.3 OPC UA variables" }. The reviewer sees it next to each data point and is offered to keep the manual with the profile; you cannot upload the manual.',
      'Asset-specific implementations go in an assignment: { "asset": "<id>", "profile": "<profile id>", "interfaces": [{ "interface": "opc-ua", "endpoint": "opc.tcp://…" }], "overrides": [{ "data_point": "<id>", "address": "<this asset’s address>", "notes": "…" }], "additions": { "interfaces": [ … ], "data_points": [{ "interface": "<id>", "group": "…", "id": "…", "address": "…", "description": "…" }] } }.',
      'A gateway or ETL integration, end to end, in three layers: (1) the profile’s data points with the gateway’s variable names as known-as names ("aliases": ["Spindle_speedActSP1"]); (2) the asset’s own addresses as assignment overrides; (3) in "asset_networks": [{ "asset": "<id>", "collections": [ … ], "collection_sinks": [ … ] }] a data collection per dataset or flow – { "id", "name", "collector": { "kind": "job" | "application" | "platform" | "process", "ref": "<name or id>" }, "interface": "<interface id>", "mode": "interval" | "on_change" | "trigger" | "other", "interval_ms", "items": [{ "address": "<what it reads>", "output_name": "<its name in the gateway>", "data_point": "<data point id, or leave out: raw>", "description": "…" }], "access": { "read": [ … ], "write": [ … ] }, "settings": [{ "key", "value" }] } – and per collection its sinks: { "collection": "<id>", "sinks": [{ "id", "name", "kind": "system" | "platform" | "application" | "dataset" | "publication" | "other", "ref", "object": "<topic, table, aspect>", "transforms": [{ "kind", "field", "expression", "description" }], "mappings": [{ "item": "<output name>", "target": "<its name there>" }] }] }. Expressions and code are kept as text and never run. Never send credentials: a password, token, key or a password in a URL refuses the document.',
      'Lists replace lists: send an existing collection’s items and sinks, an assignment’s overrides and a profile’s data points with every item they have now (get_data_collection, get_plant_asset and get_device_profile return them), plus your additions and changes – a proposal that would drop an item is refused.',
      `Large documents come in parts (a manual with hundreds of data points): at most ${L.documentBytes / 1024} KB per call. Send the first part with \`more: true\` (with title and rationale), then each further part with the returned \`proposalId\`, the last one with \`more: false\` – at most ${L.parts} parts and ${L.totalBytes / 1024 / 1024} MB together. Each part is a document of the format by itself ("version": 1, the keys an entry needs, such as a profile's id and name). Steward combines them: the same entry in several parts is merged – keys a later part adds are added, interfaces, groups, data points and other entries with ids are merged by id (so one profile's data points can be spread over parts), lists of plain values get the new values; a value given differently in two parts refuses that part. Each part is checked when it comes (its format, credentials, how it combines; the preview of the parts so far while they are small) – fix and resend a refused part. The preview runs on the combined document with the last part; a reviewer sees the proposal only then. An unfinished proposal expires ${L.partExpiryHours} hours after its last part.`,
      `Start from what is there: get_device_profile and get_kpi_definition return \`file\`, get_plant_asset \`assignmentFile\`, in this format. Give a short \`title\` and a \`rationale\` (where the information comes from); the reviewer sees both.`,
    ].join('\n\n'),
    input: z
      .object({
        title: z.string().trim().min(3).max(L.title).optional().describe('What the changes are, in a few words (the first or only part)'),
        rationale: z
          .string()
          .trim()
          .min(5)
          .max(MCP_REQUEST_LIMITS.reason)
          .optional()
          .describe('Why, and where the information comes from (a document, a configuration) – the reviewer sees it (the first or only part)'),
        document: boundedRecord(z.unknown(), 64).describe(
          `A document of the plant import format (${SCHEMA_ID}), version ${PLANT_FORMAT_VERSION} – the whole one, or one part`,
        ),
        proposalId: z.string().min(1).max(100).optional().describe('A further part: the `requestId` of your unfinished proposal'),
        more: z.boolean().default(false).describe('true when further parts follow; the last (or only) part leaves it out'),
      })
      // keys of the import that remove or rename are refused with a reason, not as unknown arguments
      .catchall(z.unknown()),
    visible: () => mayPropose(),
    asks: true,
    handler: (a, ctx) => {
      if (!plantEnabled()) throw new ToolError('The plant registry is not enabled on this Steward (Settings → Modules)');
      if (!plantManagesSome(me()) && !plantProposesSome(me()))
        throw new ToolError(
          'You may not change the plant registry: only who may propose changes to it (designers, administrators, operators, approvers, plant viewers and who manages or may propose for a site) can propose changes',
        );
      for (const k of Object.keys(a)) {
        if (KNOWN.has(k)) continue;
        throw new ToolError(REFUSED_KEYS[k] ?? `Unknown argument "${k}": give title, rationale and document (and for parts proposalId and more)`);
      }
      const doc = a.document as Record<string, unknown>;
      for (const k of ['remove']) if (k in doc) throw new ToolError(REFUSED_KEYS[k]!);
      const more = a.more === true;
      const what = a.proposalId || more ? 'This part' : 'The document';
      refuseSecrets(doc, what);
      const document = JSON.stringify(doc);
      const bytes = Buffer.byteLength(document);
      if (bytes > L.documentBytes)
        throw new ToolError(
          `${what} is too large (${kb(bytes)}, at most ${L.documentBytes / 1024} KB) – split it into parts: the first with more: true, the next ones with the returned proposalId`,
        );
      const title = typeof a.title === 'string' ? a.title : undefined;
      const rationale = typeof a.rationale === 'string' ? a.rationale : undefined;
      if (!a.proposalId && (!title || !rationale)) throw new ToolError('Give `title` and `rationale` (with the first part of a proposal in parts)');
      // one document, as before 0.17.0
      if (!a.proposalId && !more) return finish(ctx, { title: title!, rationale, document, requestId: null, parts: 1 });

      // ---------- in parts (0.17.0) ----------
      // each part is a document of the format by itself: its own problems are told now, when they are cheap to fix
      const own = plantFileSchema.safeParse(doc);
      if (!own.success)
        throw new ToolError(
          `${what} is no document of the import format – it was not kept. Fix it and send it again:\n${issueMessages(own.error.issues)
            .slice(0, 30)
            .map((m) => `- ${m.path}: ${m.message}`)
            .join('\n')}`,
        );
      const prev = a.proposalId ? unfinishedOf(a.proposalId, ctx) : null;
      const before = prev ? (payloadOf(prev).documents ?? []) : [];
      const parts = [...before, document];
      if (parts.length > L.parts)
        throw new ToolError(`A proposal has at most ${L.parts} parts – send the rest as a proposal of its own once this one is complete (more: false)`);
      let combined: Record<string, unknown>;
      try {
        combined = combineParts(parts.map((p) => JSON.parse(p) as unknown));
      } catch (e) {
        if (e instanceof PartConflict) throw new ToolError(`Part ${parts.length} does not combine with the parts before – it was not kept:\n- ${e.message}`);
        if (e instanceof PartKeyRefused) throw new ToolError(`Part ${parts.length} was not kept:\n- ${e.message}`);
        throw e;
      }
      const whole = JSON.stringify(combined);
      const total = Buffer.byteLength(whole);
      if (total > L.totalBytes)
        throw new ToolError(
          `The parts together would be too large (${kb(total)}, at most ${L.totalBytes / 1024 / 1024} MB) – make this the last part of this proposal, and propose the rest separately`,
        );
      refuseSecrets(combined, 'The parts together');
      const partAudit = (requestId: string) =>
        audit({
          action: 'plant.proposal_part_received',
          entityType: 'mcp_request',
          entityId: requestId,
          summary: `${ctx.principal.user.username}'s AI assistant (token "${ctx.principal.tokenName}") sent part ${parts.length} of plant registry changes "${prev ? payloadOf(prev).title : title}"${more ? '' : ' – the last one'}`,
          details: { tokenId: ctx.principal.tokenId, part: parts.length, bytes, totalBytes: total, sha256: sha256(document), last: !more },
        });
      if (!more) {
        // the last part: the whole document is previewed and proposed; a refusal keeps the parts so far
        return finish(ctx, {
          title: payloadOf(prev!).title,
          rationale: undefined,
          document: whole,
          requestId: prev!.id,
          parts: parts.length,
          inTx: () => partAudit(prev!.id),
        });
      }
      // the parts so far, previewed while that is quick: problems a later part may still resolve (a profile it brings)
      const soFar = total <= L.partPreviewBytes ? previewFor(whole) : null;
      const res = db().tx(() => {
        const saved = saveProposal(ctx, 'plant', {
          ...(prev ? { proposalId: prev.id } : { reason: rationale }),
          payload: (p) => {
            if (((p as Payload | null)?.documents?.length ?? 0) !== before.length)
              throw new ToolError('Another part of this proposal arrived meanwhile – send this part again');
            return { type: 'plant', title: prev ? payloadOf(prev).title : title!, incomplete: true, added: 0, changed: 0, documents: parts } satisfies Payload;
          },
        });
        // unfinished: it expires a day after its last part, and nobody is told yet
        const expiresAt = hoursFromNow(L.partExpiryHours);
        db().run("UPDATE mcp_requests SET expires_at = ? WHERE id = ? AND status = 'pending'", expiresAt, saved.requestId);
        partAudit(saved.requestId);
        return { requestId: saved.requestId, expiresAt };
      });
      return {
        status: 'incomplete',
        proposalId: res.requestId,
        requestId: res.requestId,
        part: parts.length,
        bytes: total,
        expiresAt: res.expiresAt,
        ...(soFar
          ? {
              problemsSoFar: soFar.problems.slice(0, 30).map((p) => `${p.path}: ${p.message}`),
              dropsSoFar: dropsOf(soFar)
                .slice(0, 20)
                .map((d) => dropText(d)),
            }
          : { note: `The parts together are larger than ${L.partPreviewBytes / 1024} KB: the preview runs with the last part.` }),
        next: `Send the next part with proposalId "${res.requestId}" (more: true while further parts follow; the last one with more: false). Problems so far about entries a later part brings are fine; others need a fix – an earlier part cannot be replaced, a value given differently in a later part is refused.`,
        note2: 'Nothing has been proposed yet: a person sees it once the last part is in.',
      };
    },
  }),
];

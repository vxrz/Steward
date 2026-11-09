import { z } from 'zod';
import {
  MCP_REQUEST_LIMITS,
  PLANT_FORMAT_VERSION,
  PLANT_PROPOSAL_LIMITS,
  type McpPlantPreview,
  type McpPlantProposal,
  type McpProposalSelection,
  type PlantChange,
  type PlantImportPreview,
  type UserInfo,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { me } from '../auth/access.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { HttpError, parseJson, sha256 } from '../util.js';
import { ToolError, defineTool, type ToolDef } from '../mcp/tooling.js';
import { registerReviewKind, saveProposal, type Row } from '../mcp/requests.js';
import { canManageCatalogue, plantManagesSome, siteRights } from './access.js';
import { plantEnabled } from './settings.js';
import { applyImport, importInput, previewImport, type ImportInput } from './import.js';
import { SCHEMA_ID } from './format.js';

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

/** What a proposal's request carries (mcp_requests.payload); the document and its preview are in plant_proposals. */
interface Payload {
  type: 'plant';
  title: string;
  incomplete: false;
  added: number;
  changed: number;
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

const payloadOf = (r: Row): Payload => parseJson<Payload>(r.payload, { type: 'plant', title: '', incomplete: false, added: 0, changed: 0 });
const rowOf = (id: string) => db().get<ProposalRow>('SELECT * FROM plant_proposals WHERE id = ?', id);

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
function forReader(s: Stored, u: AuthUser): { preview: McpPlantPreview; hidden: number } {
  const rows = db().all<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites');
  const rights = siteRights(rows, u);
  const sees = (siteId: string | null) => !siteId || !rights.has(siteId) || !!rights.get(siteId)?.includes('view');
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
    preview = previewImport(inputOf(p.document));
  } catch (e) {
    if (e instanceof HttpError && (e.statusCode === 403 || e.statusCode === 404)) return null;
    throw e;
  }
  return { preview, stored: stored(preview) };
}

const mayApply = (u: AuthUser) => plantEnabled() && plantManagesSome(u);

function view(r: Row, u: AuthUser): McpPlantProposal {
  const p = rowOf(r.id);
  const pay = payloadOf(r);
  const empty: McpPlantPreview = { counts: { add: 0, change: 0 }, changes: [], warnings: [], checks: [] };
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
  };
}

/** Before the request is claimed: the reviewer may import, the preview is clean, and a changed preview is confirmed. */
function precheck(r: Row, selection: McpProposalSelection | undefined, u: AuthUser): void {
  if (!mayApply(u)) throw new HttpError(403, 'You may not change the plant registry', 'MCP_REQUEST_APPROVE');
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

/** Applies the proposal as the reviewer, through the import core in one transaction. */
function apply(r: Row, selection: McpProposalSelection | undefined, u: AuthUser) {
  const p = rowOf(r.id);
  if (!p) throw new HttpError(404, `Request ${r.id} not found`, 'MCP_REQUEST_NOT_FOUND', { id: r.id });
  return db().tx(() => {
    const result = applyImport(inputOf(p.document));
    refuseDrops(result);
    const refused = refusedByPreview(result);
    // the same check as before the claim (one synchronous step): a difference rolls everything back
    const expected = selection?.plant?.fingerprint ?? p.fingerprint;
    if (refused || fingerprintOf(stored(result)) !== expected)
      throw new HttpError(409, refused ?? 'What the proposal changes is no longer what it was', 'PLANT_PROPOSAL_CHANGED');
    db().run('UPDATE plant_proposals SET import_id = ? WHERE id = ?', result.import.id, p.id);
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
    });
    return { body: { importId: result.import.id, added: result.counts.add, changed: result.counts.change } };
  });
}

/** Who is told about a proposal: the token owner (when they may import) and who manages the catalogues. */
function deciders(r: Row): UserInfo[] {
  if (!plantEnabled()) return [];
  return listUsers().filter((x) => {
    if (!x.active) return false;
    const u = toAuthUser(x);
    return x.username.toLowerCase() === r.requested_by.toLowerCase() ? plantManagesSome(u) : canManageCatalogue(u);
  });
}

registerReviewKind('plant', {
  mayAccept: (u) => mayApply(u),
  deciders,
  describe: (r) => {
    const p = payloadOf(r);
    return `plant registry changes "${p.title}" (${p.added} added, ${p.changed} changed)`;
  },
  summary: (r) => {
    const p = payloadOf(r);
    return { type: 'plant', title: p.title, added: p.added, changed: p.changed };
  },
  view,
  precheck,
  apply,
  onRejected: (r, u, o) =>
    audit({
      action: 'plant.proposal_rejected',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `Plant registry changes "${payloadOf(r).title}" proposed by ${r.requested_by}'s AI assistant ${o.withdrawn ? 'withdrawn' : `rejected by ${u.username}`}${o.comment ? ` – ${o.comment.slice(0, 200)}` : ''}`,
      details: { requestId: r.id, requestedBy: r.requested_by, withdrawn: o.withdrawn, comment: o.comment },
    }),
});

// ---------- the tool ----------

const mayPropose = () => plantEnabled() && plantManagesSome(me());

const KNOWN = new Set(['title', 'rationale', 'document']);

export const plantProposalTools: ToolDef[] = [
  defineTool({
    name: 'propose_plant_changes',
    title: 'Propose changes to the plant registry',
    description: [
      `Proposes additions and changes to the plant registry as a document of the plant import format (JSON Schema ${SCHEMA_ID}; get_plant_import_format describes it). Steward checks it with the import's preview – nothing is written – and a person who may change the registry reviews it in Steward (AI requests) and applies or rejects it. Only adding and changing: \`remove\`, renaming ids, removing what the document leaves out and dropping an item from a list inside an entry are refused – a list given replaces the list, so send it with every item it has now.`,
      'The document: { "version": 1, ... } with any of sites (each with areas → work_centers → work_units, buildings, assets), assets, device_profiles, kpi_definitions, assignments, ot_networks, asset_networks. Entries are matched by id; an existing entry is updated with the keys the document gives (keys left out keep their values; a list given replaces the list).',
      'Device profiles with inheritance: a profile names its base with "extends" and lists in "interfaces" only what it adds or changes – an entry with an inherited id changes that interface (only the keys it gives; inherited data points in its groups or data_points with the keys that change, e.g. { "id": "spindle_speed", "address": "ns=3;s=…" }); an entry with a new id is an own interface and needs "protocol". Descriptions are inherited too: give one only to describe an item anew.',
      'Asset-specific implementations go in an assignment: { "asset": "<id>", "profile": "<profile id>", "interfaces": [{ "interface": "opc-ua", "endpoint": "opc.tcp://…" }], "overrides": [{ "data_point": "<id>", "address": "<this asset’s address>", "notes": "…" }], "additions": { "interfaces": [ … ], "data_points": [{ "interface": "<id>", "group": "…", "id": "…", "address": "…", "description": "…" }] } }.',
      'Gateway names for data collections: put a gateway’s variable names as known-as names on the data points ("aliases": ["Spindle_speedActSP1"]) and the asset’s addresses as overrides; the import of a collector’s configuration then maps its items by these names. Data collections themselves are imported by a person on the asset page.',
      `Start from what is there: get_device_profile and get_kpi_definition return \`file\`, get_plant_asset \`assignmentFile\`, in this format. At most ${PLANT_PROPOSAL_LIMITS.documentBytes / 1024} KB per document; larger changes in several proposals. Give a short \`title\` and a \`rationale\` (where the information comes from); the reviewer sees both.`,
    ].join('\n\n'),
    input: z
      .object({
        title: z.string().trim().min(3).max(PLANT_PROPOSAL_LIMITS.title).describe('What the changes are, in a few words'),
        rationale: z
          .string()
          .trim()
          .min(5)
          .max(MCP_REQUEST_LIMITS.reason)
          .describe('Why, and where the information comes from (a document, a configuration) – the reviewer sees it'),
        document: z.record(z.string(), z.unknown()).describe(`A document of the plant import format (${SCHEMA_ID}), version ${PLANT_FORMAT_VERSION}`),
      })
      // keys of the import that remove or rename are refused with a reason, not as unknown arguments
      .catchall(z.unknown()),
    visible: () => mayPropose(),
    asks: true,
    handler: (a, ctx) => {
      if (!plantEnabled()) throw new ToolError('The plant registry is not enabled on this Steward (Settings → Modules)');
      if (!plantManagesSome(me()))
        throw new ToolError(
          'You may not change the plant registry: only who may import into it (designers, administrators, managers of a site) can propose changes',
        );
      for (const k of Object.keys(a)) {
        if (KNOWN.has(k)) continue;
        throw new ToolError(REFUSED_KEYS[k] ?? `Unknown argument "${k}": give title, rationale and document`);
      }
      const doc = a.document as Record<string, unknown>;
      for (const k of ['remove']) if (k in doc) throw new ToolError(REFUSED_KEYS[k]!);
      const document = JSON.stringify(doc);
      const bytes = Buffer.byteLength(document);
      if (bytes > PLANT_PROPOSAL_LIMITS.documentBytes)
        throw new ToolError(
          `The document is too large (${Math.ceil(bytes / 1024)} KB, at most ${PLANT_PROPOSAL_LIMITS.documentBytes / 1024} KB) – split it into several proposals`,
        );
      // the import's own checks: the format, the model's rules, the token owner's rights – a dry run
      let preview: PlantImportPreview;
      try {
        preview = previewImport(inputOf(document));
      } catch (e) {
        if (e instanceof HttpError && e.statusCode < 500) throw new ToolError(e.message);
        throw e;
      }
      if (!preview.ok)
        throw new ToolError(
          `The document has ${preview.problems.length} problem(s) – nothing was proposed. Fix them and send it again:\n${preview.problems
            .slice(0, 30)
            .map((p) => `- ${p.path}: ${p.message}`)
            .join('\n')}`,
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
      const open = Number(
        db().get<{ n: number | null }>(
          "SELECT SUM(LENGTH(p.document)) AS n FROM plant_proposals p JOIN mcp_requests r ON r.id = p.id WHERE r.requested_by = ? AND r.status = 'pending'",
          ctx.principal.user.username,
        )?.n ?? 0,
      );
      if (open + bytes > MCP_REQUEST_LIMITS.proposalBytesPerUser)
        throw new ToolError('Your open proposals are too large together – wait until some are decided (or ask the user to withdraw some in Steward)');
      const snapshot = stored(preview);
      const title = a.title;
      const res = db().tx(() => {
        const created = saveProposal(ctx, 'plant', {
          reason: a.rationale,
          payload: () => ({ type: 'plant', title, incomplete: false, added: preview.counts.add, changed: preview.counts.change }) satisfies Payload,
        });
        db().run(
          'INSERT INTO plant_proposals (id, title, document, sha256, preview, fingerprint, import_id) VALUES (?, ?, ?, ?, ?, ?, NULL)',
          created.requestId,
          title,
          document,
          sha256(document),
          JSON.stringify(snapshot),
          fingerprintOf(snapshot),
        );
        audit({
          action: 'plant.proposal_created',
          entityType: 'mcp_request',
          entityId: created.requestId,
          summary: `${ctx.principal.user.username}'s AI assistant (token "${ctx.principal.tokenName}") proposes plant registry changes "${title}": ${preview.counts.add} added, ${preview.counts.change} changed – a person reviews them`,
          details: { tokenId: ctx.principal.tokenId, counts: preview.counts, byKind: preview.byKind, bytes, sha256: sha256(document) },
        });
        return created;
      });
      return {
        ...res,
        added: preview.counts.add,
        changed: preview.counts.change,
        checks: preview.checks.slice(0, 20).map((c) => c.message),
        warnings: preview.warnings.slice(0, 20).map((w) => `${w.path}: ${w.message}`),
      };
    },
  }),
];

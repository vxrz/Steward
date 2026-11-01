import { z } from 'zod';
import {
  CONTROL_TAG_KINDS,
  MCP_REQUEST_LIMITS,
  type ControlTagKind,
  type McpCatalogueProposal,
  type McpMappingsProposal,
  type McpProposalSelection,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { ToolError, defineTool, type ToolDef } from '../mcp/tooling.js';
import { registerReviewKind, saveProposal, type Row } from '../mcp/requests.js';
import { mcpControlProposals } from '../mcp/config.js';
import { canManageCatalogues, canTagControls, me } from './access.js';
import {
  LIMITS,
  addTag,
  catalogueControls,
  catalogueInput,
  controlText,
  createCatalogue,
  findCatalogue,
  listCatalogues,
  resolveTarget,
  updateCatalogue,
  upsertControls,
} from './controls.js';

/**
 * Control catalogues and mappings proposed by AI assistants (#74). A company's own control set comes in every format;
 * an assistant connected through MCP reads the document on its side and sends Steward only the structured result:
 * the catalogue (ref, title, description), and suggested mappings of its controls to Steward items with a reason.
 * Nothing applies directly: a proposal waits in the AI requests inbox, compared with the catalogue of the same key.
 * The reviewer edits it, unticks what is wrong and accepts all or parts – administrators for catalogues, everyone who
 * may map controls for mappings. Accepted mappings remember who proposed and who accepted them.
 */

interface CataloguePayload {
  type: 'catalogue';
  key: string;
  name: string;
  version: string;
  description: string;
  controls: z.infer<typeof controlText>[];
  incomplete: boolean;
}
interface MappingsPayload {
  type: 'mappings';
  catalogueKey: string;
  mappings: { ref: string; kind: ControlTagKind; targetId: string; reason: string }[];
  incomplete: boolean;
}

const payloadOf = <T>(r: Row): T => parseJson<T>(r.payload, {} as T);
const admins = () => listUsers().filter((u) => u.active && canManageCatalogues(toAuthUser(u)));
const owner = (r: Row) => listUsers().filter((u) => u.active && u.username.toLowerCase() === r.requested_by.toLowerCase() && canTagControls(toAuthUser(u)));

// ---------- catalogues ----------

function catalogueView(r: Row): McpCatalogueProposal {
  const p = payloadOf<CataloguePayload>(r);
  const cat = findCatalogue(p.key);
  const current = cat ? catalogueControls(cat.id) : [];
  const byRef = new Map(current.map((c) => [c.ref.toLowerCase(), c]));
  const proposed = new Set(p.controls.map((c) => c.ref.toLowerCase()));
  return {
    type: 'catalogue',
    key: p.key,
    name: p.name,
    version: p.version,
    description: p.description,
    incomplete: p.incomplete,
    existing: cat ? { id: cat.id, name: cat.name, version: cat.version, builtin: cat.builtin } : null,
    controls: p.controls.map((c) => {
      const cur = byRef.get(c.ref.toLowerCase());
      if (!cur) return { ...c, change: 'new' as const };
      const same = cur.title === c.title && cur.description === c.description;
      return { ...c, change: same ? ('same' as const) : ('changed' as const), ...(same ? {} : { before: { title: cur.title, description: cur.description } }) };
    }),
    missing: current.filter((c) => !proposed.has(c.ref.toLowerCase())).map((c) => ({ ref: c.ref, title: c.title, mapped: c.mapped })),
  };
}

const selectionSchema = z
  .object({
    skip: z.array(z.string().trim().min(1).max(40)).max(LIMITS.controls).default([]),
    edits: z.array(controlText).max(MCP_REQUEST_LIMITS.proposalPart).default([]),
    remove: z.array(z.string().trim().min(1).max(40)).max(LIMITS.controls).default([]),
  })
  .strict();

function applyCatalogue(r: Row, selection: McpProposalSelection | undefined, u: AuthUser) {
  if (!canManageCatalogues(u)) throw new HttpError(403, 'Only administrators accept control catalogues', 'MCP_REQUEST_APPROVE');
  const p = payloadOf<CataloguePayload>(r);
  // what the reviewer accepted (some left out, some edited) – or the whole proposal as it is
  const sel = selectionSchema.parse(selection?.catalogue ?? {});
  const skip = new Set(sel.skip.map((r) => r.toLowerCase()));
  const edits = new Map(sel.edits.map((e) => [e.ref.toLowerCase(), e]));
  const chosen = {
    controls: p.controls.filter((c) => !skip.has(c.ref.toLowerCase())).map((c) => ({ ...c, ...(edits.get(c.ref.toLowerCase()) ?? {}), ref: c.ref })),
    remove: sel.remove,
  };
  const refs = new Set<string>();
  for (const c of chosen.controls) {
    if (refs.has(c.ref.toLowerCase())) throw new HttpError(400, `Control ${c.ref} appears twice`, 'CONTROL_DUPLICATE', { ref: c.ref });
    refs.add(c.ref.toLowerCase());
  }
  let cat = findCatalogue(p.key);
  let result = { catalogueId: '', key: p.key, created: false, added: 0, updated: 0, removed: 0 };
  db().tx(() => {
    if (!cat) {
      const c = createCatalogue(catalogueInput.parse({ key: p.key, name: p.name, version: p.version, description: p.description }));
      cat = { id: c.id, key: c.key, name: c.name, version: c.version, builtin: false };
      result.created = true;
    } else if (!cat.builtin && (p.version || p.name)) {
      updateCatalogue(cat.id, { name: p.name || cat.name, version: p.version || cat.version, description: p.description });
    }
    const counts = upsertControls(cat.id, chosen.controls, cat.builtin ? [] : chosen.remove);
    result = { ...result, catalogueId: cat.id, key: cat.key, ...counts };
    db().run('UPDATE control_catalogues SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, cat.id);
    audit({
      action: 'control_catalogue.imported',
      entityType: 'control_catalogue',
      entityId: cat.id,
      summary: `${counts.added} control(s) added, ${counts.updated} changed and ${counts.removed} removed in catalogue ${cat.key} – proposed by ${r.requested_by}'s AI assistant, accepted by ${u.username}`,
      details: { ...counts, requestId: r.id, requestedBy: r.requested_by, tokenName: r.token_name },
    });
  });
  return { body: result };
}

// ---------- mappings ----------

function mappingsView(r: Row, u: AuthUser): McpMappingsProposal {
  const p = payloadOf<MappingsPayload>(r);
  const cat = findCatalogue(p.catalogueKey);
  const controls = new Map((cat ? catalogueControls(cat.id) : []).map((c) => [c.ref.toLowerCase(), c]));
  const tagged = (controlId: string, kind: string, targetId: string) =>
    !!db().get('SELECT 1 FROM control_tags WHERE control_id = ? AND kind = ? AND target_id = ?', controlId, kind, targetId);
  return {
    type: 'mappings',
    catalogueKey: p.catalogueKey,
    catalogueId: cat?.id ?? null,
    incomplete: p.incomplete,
    mappings: p.mappings.map((m, index) => {
      const c = controls.get(m.ref.toLowerCase());
      const t = resolveTarget(m.kind, m.targetId, u);
      const state = !c ? 'noControl' : !t ? 'notVisible' : tagged(c.id, m.kind, m.targetId) ? 'mapped' : 'new';
      return {
        index,
        ref: m.ref,
        controlId: c?.id ?? null,
        controlTitle: c?.title ?? '',
        kind: m.kind,
        targetId: t ? m.targetId : null,
        label: t?.label ?? '',
        path: t?.path ?? null,
        reason: m.reason,
        state,
      };
    }),
  };
}

function applyMappings(r: Row, selection: McpProposalSelection | undefined, u: AuthUser) {
  if (!canTagControls(u)) throw new HttpError(403, 'You may not map items to controls', 'MCP_REQUEST_APPROVE');
  const view = mappingsView(r, u);
  const chosen = selection?.mappings
    ? new Set(z.array(z.number().int().min(0).max(MCP_REQUEST_LIMITS.proposalMappings)).max(MCP_REQUEST_LIMITS.proposalMappings).parse(selection.mappings))
    : new Set(view.mappings.map((m) => m.index));
  const suggestion = { requestedBy: r.requested_by, tokenName: r.token_name, acceptedBy: u.username, requestId: r.id };
  let mapped = 0;
  let skipped = 0;
  const p = payloadOf<MappingsPayload>(r);
  for (const m of view.mappings) {
    if (!chosen.has(m.index)) continue;
    // only what the reviewer may see and map now; the rest is reported, not applied
    if (m.state !== 'new' || !m.controlId) {
      skipped++;
      continue;
    }
    const src = p.mappings[m.index]!;
    addTag(m.controlId, { kind: src.kind, targetId: src.targetId }, suggestion);
    mapped++;
  }
  return { body: { catalogueKey: view.catalogueKey, mapped, skipped } };
}

registerReviewKind('catalogue', {
  mayAccept: (u) => canManageCatalogues(u),
  deciders: () => admins(),
  describe: (r) => {
    const p = payloadOf<CataloguePayload>(r);
    return `control catalogue ${p.key} "${p.name}" (${p.controls?.length ?? 0} controls)`;
  },
  view: (r) => catalogueView(r),
  apply: applyCatalogue,
});

registerReviewKind('mappings', {
  mayAccept: (u) => canTagControls(u),
  // the token owner (if they may map controls) and the administrators
  deciders: (r) => {
    const all = [...owner(r), ...admins()];
    return all.filter((u, i) => all.findIndex((x) => x.id === u.id) === i);
  },
  describe: (r) => {
    const p = payloadOf<MappingsPayload>(r);
    return `${p.mappings?.length ?? 0} mapping(s) for controls of ${p.catalogueKey}`;
  },
  view: mappingsView,
  apply: applyMappings,
});

// ---------- the tools ----------

const reasonArg = z
  .string()
  .trim()
  .min(5)
  .max(MCP_REQUEST_LIMITS.reason)
  .optional()
  .describe('First part only: what this is and where it comes from (document, version) – the reviewer sees it');
const partArgs = {
  proposalId: z.string().min(1).max(100).optional().describe('To add a further part: the `requestId` of your incomplete proposal'),
  more: z
    .boolean()
    .default(false)
    .describe('true when further parts follow (at most 200 entries per call); the reviewer sees the proposal once the last part is in'),
};

/** The tools need the instance setting (off by default) and the right to map controls. */
const mayMap = () => mcpControlProposals() && canTagControls(me());

/** Items the assistant may map: the kinds and how to find them. */
function targetsOf(kind: ControlTagKind, query: string, u: AuthUser): { id: string; label: string }[] {
  const like = `%${query.toLowerCase()}%`;
  const sql: Record<ControlTagKind, string> = {
    process: 'SELECT id FROM processes WHERE lower(name) LIKE ? ORDER BY name LIMIT 200',
    recordType: 'SELECT id FROM record_types WHERE lower(key) LIKE ? OR lower(name) LIKE ? ORDER BY key LIMIT 200',
    record: 'SELECT id FROM records WHERE lower(number) LIKE ? OR lower(title) LIKE ? ORDER BY number LIMIT 200',
    monitor: 'SELECT id FROM monitors WHERE is_template = 0 AND lower(name) LIKE ? ORDER BY name LIMIT 200',
    reportSchedule: 'SELECT id FROM report_schedules WHERE lower(name) LIKE ? ORDER BY name LIMIT 200',
    accessCheck: 'SELECT id FROM access_checks WHERE lower(name) LIKE ? ORDER BY name LIMIT 200',
  };
  const params = sql[kind].split('?').length - 1;
  const ids = db().all<{ id: string }>(sql[kind], ...Array.from({ length: params }, () => like));
  const out: { id: string; label: string }[] = [];
  for (const { id } of ids) {
    const t = resolveTarget(kind, id, u);
    if (t) out.push({ id, label: t.label });
    if (out.length >= 50) break;
  }
  return out;
}

export const proposalTools: ToolDef[] = [
  defineTool({
    name: 'list_control_catalogues',
    title: 'List control catalogues',
    description:
      'The control catalogues in Steward (key, name, version, number of controls) – to know whether a company catalogue exists already before proposing one, and which catalogue to propose mappings for.',
    input: z.object({}).strict(),
    visible: () => mayMap(),
    handler: () => {
      if (!mayMap()) throw new ToolError('Control proposals are not available here');
      return { catalogues: listCatalogues().map((c) => ({ key: c.key, name: c.name, version: c.version, controls: c.controlCount, builtin: c.builtin })) };
    },
  }),
  defineTool({
    name: 'get_control_catalogue',
    title: 'Read a control catalogue',
    description: 'The controls of a catalogue (ref, title, description, number of mapped Steward items).',
    input: z.object({ key: z.string().min(1).max(60).describe('Catalogue key (from list_control_catalogues)') }).strict(),
    visible: () => mayMap(),
    handler: (a) => {
      if (!mayMap()) throw new ToolError('Control proposals are not available here');
      const cat = findCatalogue(a.key);
      if (!cat) throw new ToolError(`Catalogue ${a.key} not found`);
      return { key: cat.key, name: cat.name, version: cat.version, controls: catalogueControls(cat.id).map(({ id: _id, ...c }) => c) };
    },
  }),
  defineTool({
    name: 'find_mapping_targets',
    title: 'Find Steward items to map to controls',
    description:
      'Steward items of one kind whose name contains `query` (at most 50, only what you may see): processes, record types, records, monitors, report schedules, access reconciliation checks. Use their `id` in propose_control_mappings.',
    input: z
      .object({
        kind: z.enum(CONTROL_TAG_KINDS).describe('process, recordType, record, monitor, reportSchedule or accessCheck'),
        query: z.string().max(100).default('').describe('Part of the name (empty: the first 50)'),
      })
      .strict(),
    visible: () => mayMap(),
    handler: (a) => {
      if (!mayMap()) throw new ToolError('Control proposals are not available here');
      return { kind: a.kind, items: targetsOf(a.kind, a.query, me()) };
    },
  }),
  defineTool({
    name: 'propose_control_catalogue',
    title: 'Propose a control catalogue',
    description:
      "Proposes a company's own control catalogue (for example converted from an ISMS policy, group requirements or a customer's list). Send only what the document says: ref (its own numbering), title and description per control; do not invent controls, and keep combined requirements together as the document does. Nothing changes until an administrator reviews it in Steward, edits it and accepts all or parts. A key that exists already updates that catalogue (the reviewer sees what changes). At most 200 controls per call: send the first part with `more: true`, then the next parts with the returned `proposalId`.",
    input: z
      .object({
        key: z.string().min(2).max(40).describe('Catalogue key, 2–40 letters, digits, . _ - (e.g. ACME-ISMS)'),
        name: z.string().min(1).max(120).describe('Name of the catalogue'),
        version: z.string().max(40).default('').describe('Version or date of the source document'),
        description: z.string().max(LIMITS.description).default('').describe('Source and scope, one or two sentences'),
        controls: z.array(controlText).min(1).max(MCP_REQUEST_LIMITS.proposalPart),
        reason: reasonArg,
        ...partArgs,
      })
      .strict(),
    visible: () => mayMap(),
    asks: true,
    handler: (a, ctx) => {
      if (!mayMap())
        throw new ToolError(
          'Control proposals are not available: an administrator allows them in the MCP settings, and designers and administrators may make them',
        );
      const meta = catalogueInput.safeParse({ key: a.key, name: a.name, version: a.version, description: a.description });
      if (!meta.success) throw new ToolError(meta.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const res = saveProposal(ctx, 'catalogue', {
        proposalId: a.proposalId,
        reason: a.reason,
        payload: (prev) => {
          const before = prev as CataloguePayload | null;
          if (before && before.key.toLowerCase() !== meta.data.key.toLowerCase())
            throw new ToolError(`Proposal ${a.proposalId} is for catalogue ${before.key}`);
          const controls = [...(before?.controls ?? []), ...a.controls];
          const refs = new Set<string>();
          for (const c of controls) {
            if (refs.has(c.ref.toLowerCase())) throw new ToolError(`Control ${c.ref} appears twice`);
            refs.add(c.ref.toLowerCase());
          }
          if (controls.length > LIMITS.controls) throw new ToolError(`At most ${LIMITS.controls} controls per catalogue`);
          // the name, version and description of the first part stand; later parts only add controls
          const head = before ? { key: before.key, name: before.name, version: before.version, description: before.description } : meta.data;
          return { type: 'catalogue', ...head, controls, incomplete: a.more };
        },
      });
      return { ...res, controls: a.controls.length, ...(a.more ? { next: 'Send the next part with this proposalId; the last part with more: false.' } : {}) };
    },
  }),
  defineTool({
    name: 'propose_control_mappings',
    title: 'Propose control mappings',
    description:
      'Proposes which Steward items (from find_mapping_targets) provide evidence for which controls of a catalogue, each with a short reason. Only existing controls of the catalogue and items you may see. Nothing changes until a person who may map controls reviews the list in Steward and accepts all or parts. At most 200 mappings per call: further parts with `more` and the returned `proposalId`.',
    input: z
      .object({
        catalogueKey: z.string().min(1).max(60).describe('Catalogue key (from list_control_catalogues)'),
        mappings: z
          .array(
            z
              .object({
                ref: z.string().trim().min(1).max(40).describe('Control ref in the catalogue'),
                kind: z.enum(CONTROL_TAG_KINDS),
                targetId: z.string().trim().min(1).max(200).describe('Item id from find_mapping_targets'),
                reason: z.string().trim().min(3).max(300).describe('Why this item is evidence for the control, in one sentence'),
              })
              .strict(),
          )
          .min(1)
          .max(MCP_REQUEST_LIMITS.proposalPart),
        reason: reasonArg,
        ...partArgs,
      })
      .strict(),
    visible: () => mayMap(),
    asks: true,
    handler: (a, ctx) => {
      const u = me();
      if (!mayMap())
        throw new ToolError(
          'Control proposals are not available: an administrator allows them in the MCP settings, and designers and administrators may make them',
        );
      const cat = findCatalogue(a.catalogueKey);
      if (!cat) throw new ToolError(`Catalogue ${a.catalogueKey} not found – propose the catalogue first and wait until it is accepted`);
      const refs = new Set(catalogueControls(cat.id).map((c) => c.ref.toLowerCase()));
      const unknownRefs = a.mappings.filter((m) => !refs.has(m.ref.toLowerCase())).map((m) => m.ref);
      if (unknownRefs.length) throw new ToolError(`Not in catalogue ${cat.key}: ${[...new Set(unknownRefs)].slice(0, 20).join(', ')}`);
      const unknownTargets = a.mappings.filter((m) => !resolveTarget(m.kind, m.targetId, u)).map((m) => `${m.kind} ${m.targetId}`);
      if (unknownTargets.length) throw new ToolError(`Not found (or not visible to you): ${[...new Set(unknownTargets)].slice(0, 20).join(', ')}`);
      const res = saveProposal(ctx, 'mappings', {
        proposalId: a.proposalId,
        reason: a.reason,
        payload: (prev) => {
          const before = prev as MappingsPayload | null;
          if (before && before.catalogueKey.toLowerCase() !== cat.key.toLowerCase())
            throw new ToolError(`Proposal ${a.proposalId} is for catalogue ${before.catalogueKey}`);
          const mappings = [...(before?.mappings ?? []), ...a.mappings];
          if (mappings.length > MCP_REQUEST_LIMITS.proposalMappings)
            throw new ToolError(`At most ${MCP_REQUEST_LIMITS.proposalMappings} mappings per proposal`);
          return { type: 'mappings', catalogueKey: cat.key, mappings, incomplete: a.more };
        },
      });
      return { ...res, mappings: a.mappings.length, ...(a.more ? { next: 'Send the next part with this proposalId; the last part with more: false.' } : {}) };
    },
  }),
];

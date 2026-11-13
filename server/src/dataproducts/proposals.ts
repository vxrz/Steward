import { z } from 'zod';
import {
  boundedRecord,
  DATA_SEMANTIC_LIMITS as SL,
  MCP_REQUEST_LIMITS,
  type DataProductImportChange,
  type DataProductImportPreview,
  type McpDataProductsProposal,
  type McpProposalSelection,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth/context.js';
import { currentUser } from '../auth/context.js';
import { listUsers, toAuthUser } from '../auth/users.js';
import { moduleEnabled } from '../modules/registry.js';
import { HttpError, parseJson, sha256 } from '../util.js';
import { ToolError, defineTool, type ToolDef } from '../mcp/tooling.js';
import { registerReviewKind, saveProposal, type Row } from '../mcp/requests.js';
import { canManageModule, domainAccess, objectAccess, productAccess, usesModule } from './access.js';
import { DATA_PRODUCT_FORMAT_VERSION, SCHEMA_ID, dataProductsFileSchema, dataProductsJsonSchema, issueMessages } from './format.js';
import { applyImport, credentialPlaces, previewImport } from './import.js';
import { saveSemanticVersion } from './semantic.js';
import { lintSemanticDocument, parseSemanticDocument } from './semantic-lint.js';
import { editableProduct } from './service.js';
import type { DomainRow, ObjectRow, ProductRow } from './store.js';

/**
 * Data products proposed by AI assistants (ADR 0036 part 14, phase 2; the pattern of the plant registry's proposals).
 * An assistant connected through MCP sends a document of the module's file format – new products, elements, ports,
 * steps, data objects, domains and changes to them, read from a Snowflake schema (search_data_elements) or a dbt
 * manifest it has locally. Steward checks it with the import's preview as the token owner – nothing is written – and
 * keeps it as a proposal in the AI requests inbox. **A person applies it**: whoever uses the module accepts it there, the
 * preview runs again with their rights (a preview that changed since the proposal needs their confirmation) and the
 * import applies it in one transaction, as them, audited as every import. An assistant never applies anything.
 *
 * Only additions and changes: the import's mode is always _add and update_ – nothing is removed, no list item dropped,
 * no product retired; credential-looking values refuse the document (their places are named, never their values).
 * Large proposals come in parts, each a document of the format; together they are one import (several files).
 */

export const DATA_PRODUCT_PROPOSAL_LIMITS = {
  /** One part as sent (an MCP request is at most 64 KB) */
  partBytes: 48 * 1024,
  parts: 20,
  title: 120,
} as const;

/** A semantic model proposed for a product (0.25.0, ADR 0037 part 4): saved as a new version when applied. */
interface SemanticPart {
  /** The product as the assistant named it (id or key) */
  product: string;
  document: string;
  note: string;
  sha256: string;
}

interface Payload {
  type: 'dataProducts';
  title: string;
  incomplete: boolean;
  /** The parts as sent (JSON), each a file of the import */
  documents: string[];
  /** 0.25.0: semantic models of products, each saved as a version of that product's model */
  semanticModels?: SemanticPart[];
  added: number;
  changed: number;
  /** The preview when it was proposed (the token owner's rights) */
  proposed: { counts: { add: number; change: number }; changes: DataProductImportChange[]; warnings: string[]; fingerprint: string } | null;
  result?: { add: number; change: number; semanticVersions?: number } | null;
}

const payloadOf = (r: Pick<Row, 'payload'>): Payload =>
  parseJson<Payload>(r.payload, { type: 'dataProducts', title: '', incomplete: false, documents: [], added: 0, changed: 0, proposed: null });
const filesOf = (p: Payload) => p.documents.map((content, i) => ({ name: `proposal-${i + 1}.json`, content }));
const semanticOf = (p: Payload): SemanticPart[] => p.semanticModels ?? [];

/**
 * The product a semantic model names, as `u` may see it: by id, else by key – or a key the proposal's import adds
 * (null id: it exists once the import ran). Undefined: not known or not theirs to see.
 */
function semanticProduct(name: string, u: AuthUser, addedKeys: ReadonlySet<string>): { id: string | null; key: string; name: string } | undefined {
  const row =
    db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', name) ?? db().get<ProductRow>('SELECT * FROM dp_products WHERE key = ?', name.toLowerCase());
  if (row) return productAccess(u, row).permissions.length ? { id: row.id, key: row.key, name: row.name } : undefined;
  return addedKeys.has(name.toLowerCase()) ? { id: null, key: name.toLowerCase(), name } : undefined;
}

/** Keys of the products the import of a proposal adds (its preview). */
const addedProductKeys = (changes: readonly DataProductImportChange[]): Set<string> =>
  new Set(changes.filter((c) => c.kind === 'dataProduct' && c.action === 'add').map((c) => c.key.toLowerCase()));

/** The semantic models as the reader sees them: per product, the lint, and whether it differs from the newest version. */
function semanticView(p: Payload, u: AuthUser, added: ReadonlySet<string>): NonNullable<McpDataProductsProposal['semanticModels']> {
  return semanticOf(p).map((m) => {
    const target = semanticProduct(m.product, u, added);
    const latest = target?.id
      ? db().get<{ version: number; sha256: string }>(
          'SELECT version, sha256 FROM dp_semantic_versions WHERE product_id = ? ORDER BY version DESC LIMIT 1',
          target.id,
        )
      : undefined;
    const lint = lintSemanticDocument(m.document);
    return {
      product: target ? { id: target.id, key: target.key, name: target.name } : null,
      bytes: Buffer.byteLength(m.document),
      sha256: m.sha256,
      note: m.note,
      lintFindings: lint.findings.length + lint.more,
      revision: lint.revision,
      currentVersion: latest ? Number(latest.version) : null,
      unchanged: !!latest && latest.sha256 === m.sha256,
      document: target ? m.document : '',
    };
  });
}
const importBody = (p: Payload, fingerprint?: string) => ({ files: filesOf(p), mode: 'update' as const, ...(fingerprint ? { fingerprint } : {}) });
const documentSha = (p: Payload) => sha256(p.documents.join('\n'));
const documentBytes = (p: Payload) => p.documents.reduce((n, d) => n + Buffer.byteLength(d), 0);

const mayUse = (u: AuthUser | null): boolean => moduleEnabled('dataProducts') && usesModule(u);

/**
 * Whether the reader may see what a change of the proposal names: a new entry is the assistant's text; a change names an
 * existing product, data object or domain – by key, shown only where the reader may see it; an element's change names
 * it by its qualified name – shown only to who may see it now (the reader's preview lists it).
 */
function seen(c: DataProductImportChange, u: AuthUser, nowKeys: Set<string> | null): boolean {
  if (c.action === 'add') return true;
  if (nowKeys) return nowKeys.has(`${c.kind}\u0000${c.key}`);
  if (c.kind === 'dataProduct') {
    const p = db().get<ProductRow>('SELECT * FROM dp_products WHERE key = ?', c.key);
    return !p || productAccess(u, p).permissions.length > 0;
  }
  if (c.kind === 'dataObject') {
    const o = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE key = ?', c.key);
    return !o || objectAccess(u, o).permissions.length > 0;
  }
  if (c.kind === 'domain') {
    const d = db().get<DomainRow>('SELECT * FROM dp_domains WHERE key = ?', c.key);
    return !d || domainAccess(u, d).permissions.length > 0;
  }
  return false;
}

const EMPTY_PREVIEW: DataProductImportPreview = {
  mode: 'update',
  counts: { add: 0, change: 0, unchanged: 0, skip: 0 },
  changes: [],
  problems: [],
  warnings: [],
  files: [],
  fingerprint: 'semantic-models-only',
};

/** The import's preview now, as the current person – null when it cannot run (a parse problem is a problem of it). */
function previewNow(p: Payload): DataProductImportPreview {
  // a proposal of semantic models only (0.25.0) imports nothing
  if (!p.documents.length) return EMPTY_PREVIEW;
  return previewImport(importBody(p));
}

const isOpen = (r: Row) => r.status === 'pending';

function view(r: Row, u: AuthUser): McpDataProductsProposal {
  const p = payloadOf(r);
  const mayApply = isOpen(r) && !p.incomplete && mayUse(u);
  let now: McpDataProductsProposal['now'] = null;
  if (mayApply) {
    const n = previewNow(p);
    now = {
      counts: { add: n.counts.add, change: n.counts.change },
      changes: n.changes.filter((c) => c.action === 'add' || c.action === 'change'),
      warnings: n.warnings,
      problems: n.problems,
      ok: !n.problems.length,
      fingerprint: n.fingerprint,
    };
  }
  const nowKeys = now ? new Set(now.changes.map((c) => `${c.kind}\u0000${c.key}`)) : null;
  const proposedChanges = p.proposed?.changes ?? [];
  const shown = proposedChanges.filter((c) => seen(c, u, nowKeys));
  const semantic = semanticOf(p).length ? semanticView(p, u, addedProductKeys(now?.changes ?? proposedChanges)) : [];
  return {
    ...(semantic.length ? { semanticModels: semantic } : {}),
    type: 'dataProducts',
    title: p.title,
    incomplete: p.incomplete,
    document: { bytes: documentBytes(p), sha256: documentSha(p) },
    parts: p.documents.length,
    proposed: {
      counts: p.proposed?.counts ?? { add: 0, change: 0 },
      changes: shown,
      warnings: shown.length === proposedChanges.length ? (p.proposed?.warnings ?? []) : [],
    },
    now,
    changedSince: !!now && !!p.proposed && now.fingerprint !== p.proposed.fingerprint,
    hidden: proposedChanges.length - shown.length,
    result: p.result ?? null,
  };
}

const selectionOf = (s: McpProposalSelection | undefined) =>
  z
    .object({ fingerprint: z.string().trim().max(80) })
    .strict()
    .optional()
    .parse(s?.dataProducts);

/** As the reviewer, before the request is claimed: the preview now must be clean, and confirmed when it changed. */
function precheck(r: Row, selection: McpProposalSelection | undefined, u: AuthUser): void {
  if (!mayUse(u)) throw new HttpError(403, 'You may not apply data products proposals', 'MCP_REQUEST_APPROVE');
  const p = payloadOf(r);
  const n = previewNow(p);
  if (n.problems.length) {
    const first = n.problems[0]!;
    throw new HttpError(
      409,
      `The proposal cannot be applied (${n.problems.length} problem(s)): ${first.path}: ${first.message}`,
      'DATA_PRODUCT_IMPORT_INVALID',
      {
        count: n.problems.length,
        file: first.file,
        path: first.path,
        message: first.message,
      },
    );
  }
  const sel = selectionOf(selection);
  if (p.proposed && n.fingerprint !== p.proposed.fingerprint && sel?.fingerprint !== n.fingerprint)
    throw new HttpError(
      409,
      'The proposal’s preview changed since it was proposed – check the preview of now and accept it again',
      'DATA_PRODUCT_IMPORT_CHANGED',
    );
  // semantic models (0.25.0): each names a product the reviewer may change (or one the import adds)
  const added = addedProductKeys(n.changes);
  for (const m of semanticOf(p)) {
    const target = semanticProduct(m.product, u, added);
    if (!target)
      throw new HttpError(404, `The data product ${m.product} of a proposed semantic model is not known`, 'DATA_PRODUCT_NOT_FOUND', {
        id: m.product.slice(0, 100),
      });
    if (target.id) editableProduct(target.id);
  }
}

/** Applies the proposal as the reviewer (their rights): the import, mode add and update, in one transaction. */
function apply(r: Row, selection: McpProposalSelection | undefined, u: AuthUser): { body: unknown } {
  const p = payloadOf(r);
  const n = previewNow(p);
  const sel = selectionOf(selection);
  // the preview the reviewer confirmed (changed since), else the proposed one – what else came in between is refused
  const fingerprint = p.proposed && n.fingerprint !== p.proposed.fingerprint ? sel?.fingerprint : n.fingerprint;
  const counts = db().tx(() => {
    const result = p.documents.length ? applyImport(importBody(p, fingerprint ?? 'unconfirmed')) : null;
    const c = { add: result?.counts.add ?? 0, change: result?.counts.change ?? 0, semanticVersions: 0 };
    // semantic models (0.25.0): a version of each product's model, saved as the reviewer, the requester as its proposer
    for (const m of semanticOf(p)) {
      const target = semanticProduct(m.product, u, new Set([m.product.toLowerCase()]));
      if (!target?.id)
        throw new HttpError(404, `The data product ${m.product} of a proposed semantic model is not known`, 'DATA_PRODUCT_NOT_FOUND', {
          id: m.product.slice(0, 100),
        });
      const saved = saveSemanticVersion(target.id, { document: m.document, note: m.note }, { origin: 'proposal', proposedBy: r.requested_by, requestId: r.id });
      if (saved.created) c.semanticVersions++;
    }
    return c;
  });
  db().run('UPDATE mcp_requests SET payload = ? WHERE id = ?', JSON.stringify({ ...p, result: counts }), r.id);
  audit({
    action: 'dataproduct.proposal_applied',
    entityType: 'mcp_request',
    entityId: r.id,
    summary: `Data products proposal "${p.title}" of ${r.requested_by}'s AI assistant applied by ${u.username}: ${counts.add} added, ${counts.change} changed${counts.semanticVersions ? `, ${counts.semanticVersions} semantic model version(s) saved` : ''}`,
    details: { requestId: r.id, requestedBy: r.requested_by, tokenName: r.token_name, counts, sha256: documentSha(p) },
  });
  return { body: counts };
}

registerReviewKind('dataProducts', {
  // a person who uses the module applies it (the import checks their rights entry by entry); never while incomplete
  mayAccept: (u, r) => !payloadOf(r).incomplete && mayUse(u),
  deciders: (r) => {
    const all = listUsers().filter((x) => {
      if (!x.active) return false;
      const a = toAuthUser(x);
      return x.username.toLowerCase() === r.requested_by.toLowerCase() ? usesModule(a) : canManageModule(a);
    });
    return all.filter((x, i) => all.findIndex((y) => y.id === x.id) === i);
  },
  describe: (r) => {
    const p = payloadOf(r);
    return p.incomplete
      ? `data products proposal "${p.title}" (${p.documents.length} part(s) so far)`
      : `data products proposal "${p.title}" (${p.added} added, ${p.changed} changed${semanticOf(p).length ? `, ${semanticOf(p).length} semantic model(s)` : ''})`;
  },
  summary: (r) => {
    const p = payloadOf(r);
    return { type: 'dataProducts', title: p.title, added: p.added, changed: p.changed };
  },
  view,
  precheck,
  apply,
  onRejected: (r, u, o) => {
    audit({
      action: 'dataproduct.proposal_rejected',
      entityType: 'mcp_request',
      entityId: r.id,
      summary: `Data products proposal "${payloadOf(r).title}" of ${r.requested_by}'s AI assistant ${o.withdrawn ? 'withdrawn' : `rejected by ${u.username}`}${o.comment ? ` – ${o.comment.slice(0, 200)}` : ''}`,
      details: { requestId: r.id, requestedBy: r.requested_by, withdrawn: o.withdrawn, comment: o.comment },
    });
  },
});

// ---------- semantic models in proposals (0.25.0, ADR 0037 part 4) ----------

/** A semantic model's text as data for the credential check (unparsable text is checked as a string). */
function semanticDocOf(text: string): unknown {
  const parsed = parseSemanticDocument(text);
  return parsed.doc ?? text;
}

const semanticPart = (m: { product: string; document: string; note?: string }): SemanticPart => ({
  product: m.product.trim(),
  document: m.document,
  note: (m.note ?? '').trim(),
  sha256: sha256(m.document),
});

/**
 * The semantic models of a complete proposal, as the token owner: each names a product they may see (or one the
 * proposal adds); the number that differ from the newest version of their product.
 */
function checkSemanticModels(p: Payload, changes: readonly DataProductImportChange[], u: AuthUser): number {
  const added = addedProductKeys(changes);
  let changed = 0;
  for (const m of semanticOf(p)) {
    const target = semanticProduct(m.product, u, added);
    if (!target) throw new ToolError(`Semantic model: the data product "${m.product}" is not known (or you may not see it) – name it by its id or key`);
    const latest = target.id
      ? db().get<{ sha256: string }>('SELECT sha256 FROM dp_semantic_versions WHERE product_id = ? ORDER BY version DESC LIMIT 1', target.id)
      : undefined;
    if (!latest || latest.sha256 !== m.sha256) changed++;
  }
  return changed;
}

// ---------- the tools ----------

const L = DATA_PRODUCT_PROPOSAL_LIMITS;
const visible = () => mayUse(currentUser());

/** Products retired by a proposal: retiring is a person's decision in Steward (it tells consumers). */
function retiring(doc: Record<string, unknown>): string[] {
  const list = [...(Array.isArray(doc.data_products) ? doc.data_products : []), ...(doc.data_product ? [doc.data_product] : [])];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && (p as Record<string, unknown>).lifecycle === 'retired')
    .map((p) => String(p.key ?? '?'));
}

export const dataProductProposalTools: ToolDef[] = [
  defineTool({
    name: 'get_data_products_format',
    title: 'Get the data products file format',
    description: `The JSON Schema (${SCHEMA_ID}) of Steward's data products file format, version ${DATA_PRODUCT_FORMAT_VERSION}: domains, data_objects, elements and data_products (with members, ports, bindings, consumers and steps). propose_data_product_changes takes a document of this format.`,
    input: z.object({}).strict(),
    visible,
    handler: () => ({
      schemaId: SCHEMA_ID,
      version: DATA_PRODUCT_FORMAT_VERSION,
      identity:
        'Domains, data objects and products by key; elements by platform (name), kind, qualified_name and environment; ports by direction, name and version; steps by name within their product. Platforms, applications and processes by name, data contracts by their ODCS id.',
      schema: dataProductsJsonSchema(),
    }),
  }),
  defineTool({
    name: 'propose_data_product_changes',
    title: 'Propose data products, elements, ports and steps',
    description: [
      `Proposes additions and changes to the data products module as a document of its file format (get_data_products_format; { "version": ${DATA_PRODUCT_FORMAT_VERSION}, "data_products": [...], "elements": [...], "data_objects": [...], "domains": [...] }). Steward checks it with the import's preview – nothing is written – and a person who uses the module reviews it in Steward (AI requests) and applies or rejects it. You never apply it.`,
      'Only adding and changing: an existing entry takes the keys the document gives (keys left out keep their values); list items (members, ports, consumers, steps) are matched and added or changed, never removed. Retiring a product is refused – a person does that. Never send credentials: a password, token, key or a password in a URL refuses the document.',
      'To document a product from a Snowflake schema, read its discovered elements with search_data_elements and name them (platform, kind, qualified_name, environment) as members, port bindings and step inputs and outputs; elements Steward does not know yet go under "elements". From a dbt manifest: models and sources become elements and steps (inputs → outputs), exposures registered consumers.',
      `Large documents come in parts of at most ${L.partBytes / 1024} KB: the first with more: true (with title and rationale), the next ones with the returned proposalId, the last with more: false – at most ${L.parts} parts. Each part is a document of the format by itself; together they are one import.`,
      `Semantic models (Apache Ossie 0.1.1 or 0.2.0.dev0, YAML or JSON text) go under semanticModels: { product: id or key, document, note } – each becomes a new version of that product's model, stored as written, when a person applies the proposal (get_product_semantic_model reads the current one). Steward keeps the governed copy; metrics are defined in dbt, Snowflake semantic views or BI tools. A part may carry semantic models without a document.`,
    ].join('\n\n'),
    input: z
      .object({
        title: z.string().trim().min(3).max(L.title).optional().describe('What the proposal is, in a few words (the first or only part)'),
        rationale: z
          .string()
          .trim()
          .min(5)
          .max(MCP_REQUEST_LIMITS.reason)
          .optional()
          .describe('Why, and where it comes from (a schema, a dbt manifest) – the reviewer sees it (the first or only part)'),
        document: boundedRecord(z.unknown(), 16)
          .optional()
          .describe(`A document of the data products file format, version ${DATA_PRODUCT_FORMAT_VERSION} (optional when the part carries semantic models)`),
        semanticModels: z
          .array(
            z
              .object({
                product: z.string().min(1).max(200).describe('The data product: its id or key (or the key of a product this proposal adds)'),
                document: z.string().min(1).max(L.partBytes).describe('The Apache Ossie document as YAML or JSON text (0.1.1 or 0.2.0.dev0)'),
                note: z.string().trim().max(500).optional().describe('What changed, for the version history'),
              })
              .strict(),
          )
          .max(SL.proposalModels)
          .optional()
          .describe(
            `Semantic models (Apache Ossie) of products, each saved as a new version of that product's model when a person applies the proposal – at most ${SL.proposalModels} per proposal`,
          ),
        proposalId: z.string().min(1).max(100).optional().describe('A further part: the `requestId` of your unfinished proposal'),
        more: z.boolean().default(false).describe('true when further parts follow; the last (or only) part leaves it out'),
      })
      .strict(),
    visible,
    asks: true,
    handler: (a, ctx) => {
      if (!mayUse(currentUser())) throw new ToolError('The data products module is off, or you do not use it');
      if (!a.document && !a.semanticModels?.length) throw new ToolError('Send a document of the format, semantic models, or both');
      const doc = (a.document ?? null) as Record<string, unknown> | null;
      const models = a.semanticModels ?? [];
      const what = a.proposalId || a.more ? 'This part' : 'The document';
      const modelSecrets = models.flatMap((m, i) =>
        credentialPlaces(semanticDocOf(m.document)).map((x) => `semanticModels[${i}]${x.startsWith('/') ? x : `.${x}`}`),
      );
      if (modelSecrets.length)
        throw new ToolError(
          `A semantic model holds what looks like a credential – nothing was proposed. Leave out passwords, tokens, keys and passwords in URLs:\n${modelSecrets.map((x) => `- ${x}`).join('\n')}`,
        );
      const modelBytes = models.reduce((n, m) => n + Buffer.byteLength(m.document), 0);
      if (modelBytes > L.partBytes)
        throw new ToolError(`The semantic models of one part are too large (at most ${L.partBytes / 1024} KB together) – send them in further parts`);
      const secrets = doc ? credentialPlaces(doc) : [];
      if (secrets.length)
        throw new ToolError(
          `${what} holds what looks like a credential – nothing was proposed. Leave out passwords, tokens, keys and passwords in URLs:\n${secrets.map((x) => `- ${x}`).join('\n')}`,
        );
      const retired = doc ? retiring(doc) : [];
      if (retired.length) throw new ToolError(`A proposal does not retire products (${retired.join(', ')}) – a person does that in Steward`);
      const text = doc ? JSON.stringify(doc) : null;
      if (text && Buffer.byteLength(text) > L.partBytes)
        throw new ToolError(
          `${what} is too large (at most ${L.partBytes / 1024} KB) – split it into parts: the first with more: true, the next ones with the returned proposalId`,
        );
      if (!a.proposalId && (!a.title || !a.rationale)) throw new ToolError('Give `title` and `rationale` (with the first part of a proposal in parts)');
      const more = a.more === true;
      // each part is a document of the format by itself: its format problems are told now (names it refers to may be in
      // another part – they are checked with the last one)
      const own = doc ? dataProductsFileSchema.safeParse(doc) : null;
      const formatProblems = !own || own.success ? [] : issueMessages(own.error.issues);
      if (formatProblems.length && (more || a.proposalId))
        throw new ToolError(
          `${what} is no document of the format – it was not kept. Fix it and send it again:\n${formatProblems
            .slice(0, 20)
            .map((x) => `- ${x.path}: ${x.message}`)
            .join('\n')}`,
        );
      let preview: DataProductImportPreview | null = null;
      const r = saveProposal(ctx, 'dataProducts', {
        proposalId: a.proposalId,
        reason: a.rationale,
        payload: (prev) => {
          const before = prev ? (prev as Payload) : null;
          if (before && before.documents.length + (before.semanticModels?.length ?? 0) >= L.parts)
            throw new ToolError(`A proposal has at most ${L.parts} parts`);
          const documents = [...(before?.documents ?? []), ...(text ? [text] : [])];
          const semanticModels = [...(before?.semanticModels ?? []), ...models.map(semanticPart)];
          if (semanticModels.length > SL.proposalModels) throw new ToolError(`A proposal has at most ${SL.proposalModels} semantic models`);
          const base: Payload = {
            type: 'dataProducts',
            title: before?.title ?? a.title!,
            incomplete: more,
            documents,
            ...(semanticModels.length ? { semanticModels } : {}),
            added: 0,
            changed: 0,
            proposed: null,
          };
          if (more) return { ...base };
          // the last part: the preview of all parts together, as the token owner – problems refuse it
          preview = previewNow(base);
          if (preview.problems.length)
            throw new ToolError(
              `The proposal cannot be applied as it is (${preview.problems.length} problem(s)) – nothing was kept of this part. Fix and send it again:\n${preview.problems
                .slice(0, 30)
                .map((x) => `- ${x.file} ${x.path}: ${x.message}`)
                .join('\n')}`,
            );
          const semanticChanges = checkSemanticModels(base, preview.changes, ctx.principal.user);
          if (!preview.counts.add && !preview.counts.change && !semanticChanges)
            throw new ToolError('The proposal changes nothing – Steward has all of it already');
          return {
            ...base,
            added: preview.counts.add,
            changed: preview.counts.change,
            proposed: {
              counts: { add: preview.counts.add, change: preview.counts.change },
              changes: preview.changes.filter((c) => c.action === 'add' || c.action === 'change'),
              warnings: preview.warnings,
              fingerprint: preview.fingerprint,
            },
          };
        },
      });
      const p = preview as DataProductImportPreview | null;
      if (!more && p)
        audit({
          action: 'dataproduct.proposal_created',
          entityType: 'mcp_request',
          entityId: r.requestId,
          summary: `Data products proposal "${a.title ?? ''}" of ${ctx.principal.user.username}'s AI assistant: ${p.counts.add} to add, ${p.counts.change} to change${models.length || a.proposalId ? ' (with any semantic models)' : ''}`,
          details: { counts: p.counts, requestedBy: ctx.principal.user.username, semanticModels: models.length },
        });
      return {
        ...r,
        ...(p ? { preview: { counts: p.counts, warnings: p.warnings.slice(0, 20) } } : {}),
        note: more
          ? 'Part kept. Send the next part with this proposalId; the last one with more: false.'
          : 'Nothing has been changed yet. A person reviews the proposal in Steward (AI requests) and applies or rejects it.',
      };
    },
  }),
];

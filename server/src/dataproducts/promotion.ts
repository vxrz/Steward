import {
  DATA_GOVERNANCE_ID_PREFIX,
  DATA_GOVERNANCE_LIMITS as G,
  dataPromotionInput,
  promotedNames,
  type DataEnvironmentRule,
  type DataMemberRole,
  type DataObjectives,
  type DataPromotion,
  type DataPromotionElement,
  type DataPromotionPreview,
  type DataRef,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { contractAccess } from '../auth/policy.js';
import { HttpError, canonicalJson, newId, nowIso, parseJson, sha256 } from '../util.js';
import { elementAccess } from './access.js';
import { HIDDEN, json } from './common.js';
import { addMembers } from './elements.js';
import { setBinding } from './ports.js';
import { editableProduct, ensureEnvironment, touchProduct, visibleProduct } from './service.js';
import { bindingsOf, chunks, elementTeamIds, marks, membersOf, portsOf, type ElementRow } from './store.js';

/**
 * Promotion between environments (ADR 0036 part 4, decision 11): _Promote_ proposes the next environment's
 * memberships and port bindings from the current one by the **name rules** of the discovery sources (a prefix or
 * suffix per environment: `DEV_DB.SALES.ORDERS` → `PROD_DB.SALES.ORDERS`; the same name as a second candidate for
 * platforms per environment), previews what exists there and what is missing, and – applied by who may change the
 * product, in a signed-in session – adds the members and binds the ports through the services of the pages (rights,
 * limits, roles, environments), and records the promotion with its **evidence**: a change record, a ticket, a process
 * run (a template process _Promote a data product_ with its approvals) or an address. Steward deploys nothing; the
 * preview's fingerprint refuses an apply when what it would do changed since. Audited (`dataproduct.promoted`).
 */

const invalid = (message: string, context: string, extra: Record<string, string | number> = {}) =>
  new HttpError(409, message, 'DATA_PROMOTION_INVALID', { context, ...extra });

/** The environment rules of the discovery sources of these platforms (the order of the sources, then of their rules). */
function rulesOf(platformIds: readonly string[]): DataEnvironmentRule[] {
  const out: DataEnvironmentRule[] = [];
  for (const part of chunks([...new Set(platformIds.filter(Boolean))]))
    for (const r of db().all<{ environment_rules: string }>(
      `SELECT environment_rules FROM dp_discovery_sources WHERE platform_id IN (${marks(part.length)}) ORDER BY created_at, id`,
      ...part,
    ))
      for (const x of parseJson<DataEnvironmentRule[]>(r.environment_rules, []))
        if (!out.some((y) => y.match === x.match && y.value === x.value && y.environment === x.environment)) out.push(x);
  return out;
}

interface Plan {
  preview: DataPromotionPreview;
  /** For the apply: members to add per role and flags, bindings with their next element ids */
  memberAdds: { role: DataMemberRole; includeDescendants: boolean; elementIds: string[] }[];
  bindingSets: {
    portId: string;
    elementIds: string[];
    contractId: string | null;
    contractVersion: number | null;
    contractServer: string | null;
    objectives: DataObjectives;
  }[];
}

function plan(u: AuthUser, productId: string, from: string, to: string): Plan {
  if (from === to) throw invalid('Promote to another environment', 'sameEnvironment');
  const members = membersOf([productId]);
  const ports = portsOf([productId]);
  const bindings = bindingsOf(ports.map((p) => p.id));
  const sourceIds = new Set([
    ...members.map((m) => m.element_id),
    ...bindings.filter((b) => b.environment === from).flatMap((b) => b.elementIds),
    ...bindings.filter((b) => b.environment === to).flatMap((b) => b.elementIds),
  ]);
  const elements = new Map<string, ElementRow>();
  for (const part of chunks([...sourceIds]))
    for (const e of db().all<ElementRow>(`SELECT * FROM dp_elements WHERE id IN (${marks(part.length)})`, ...part)) elements.set(e.id, e);
  const sourceMembers = members.filter((m) => elements.get(m.element_id)?.environment === from);
  const sourceBindings = bindings.filter((b) => b.environment === from);
  const sources = new Map<string, ElementRow>();
  for (const m of sourceMembers) sources.set(m.element_id, elements.get(m.element_id)!);
  for (const b of sourceBindings) for (const id of b.elementIds) if (elements.get(id)) sources.set(id, elements.get(id)!);
  if (sources.size > G.promotionElements) throw invalid(`At most ${G.promotionElements} elements per promotion`, 'tooLarge', { max: G.promotionElements });
  const rules = rulesOf([...sources.values()].map((e) => e.platform_id));
  // candidates per source element; the targets in one read per chunk of names
  const candidates = new Map<string, string[]>();
  for (const e of sources.values()) candidates.set(e.id, promotedNames(e.qualified_name, e.kind, from, to, rules));
  const wanted = [...new Set([...candidates.values()].flat().map((n) => n.toLowerCase()))];
  const targets: ElementRow[] = [];
  for (const part of chunks(wanted))
    targets.push(...db().all<ElementRow>(`SELECT * FROM dp_elements WHERE environment = ? AND name_norm IN (${marks(part.length)})`, to, ...part));
  const teams = elementTeamIds(targets.map((t) => t.id));
  const visible = (t: ElementRow) => elementAccess(u, teams.get(t.id) ?? []).permissions.length > 0;
  let hidden = 0;
  const targetOf = (e: ElementRow): ElementRow | null => {
    for (const name of candidates.get(e.id) ?? []) {
      const n = name.toLowerCase();
      const found = targets.filter((t) => t.kind === e.kind && t.name_norm === n);
      // the same platform first (several environments in one account), else another platform (one per environment)
      const pick = found.find((t) => t.platform_id === e.platform_id) ?? found[0];
      if (pick) {
        if (!visible(pick)) {
          hidden++;
          return null;
        }
        return pick;
      }
    }
    return null;
  };
  const memberIds = new Set(members.map((m) => m.element_id));
  const resolved = new Map<string, ElementRow | null>();
  for (const e of sources.values()) resolved.set(e.id, targetOf(e));
  const describe = (e: ElementRow, already: (t: ElementRow) => boolean): DataPromotionElement => {
    const t = resolved.get(e.id) ?? null;
    return {
      sourceId: e.id,
      sourceName: e.qualified_name,
      kind: e.kind,
      candidates: candidates.get(e.id) ?? [],
      targetId: t?.id ?? null,
      targetName: t?.qualified_name ?? null,
      state: !t ? 'missing' : already(t) ? 'already' : 'found',
    };
  };
  const previewMembers = sourceMembers
    .map((m) => ({ ...describe(sources.get(m.element_id)!, (t) => memberIds.has(t.id)), role: m.role }))
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName));
  const contracts = new Map<string, DataRef>();
  const contractIds = [...new Set(sourceBindings.map((b) => b.contract_id).filter((x): x is string => !!x))];
  for (const part of chunks(contractIds))
    for (const c of db().all<{ id: string; contract_key: string; name: string }>(
      `SELECT id, contract_key, name FROM data_contracts WHERE id IN (${marks(part.length)})`,
      ...part,
    ))
      contracts.set(c.id, contractAccess(u, { id: c.id }).permissions.includes('view') ? { id: c.id, key: c.contract_key, name: c.name } : HIDDEN);
  const previewBindings: DataPromotionPreview['bindings'] = [];
  const bindingSets: Plan['bindingSets'] = [];
  for (const b of sourceBindings) {
    const port = ports.find((p) => p.id === b.port_id)!;
    const target = bindings.find((x) => x.port_id === b.port_id && x.environment === to);
    const bound = new Set(target?.elementIds ?? []);
    const els = b.elementIds
      .map((id) => sources.get(id))
      .filter((e): e is ElementRow => !!e)
      .map((e) => describe(e, (t) => bound.has(t.id)))
      .sort((x, y) => x.sourceName.localeCompare(y.sourceName));
    previewBindings.push({
      portId: port.id,
      portName: port.name,
      version: port.version,
      contract: b.contract_id ? (contracts.get(b.contract_id) ?? HIDDEN) : null,
      contractVersion: b.contract_version === null ? null : Number(b.contract_version),
      targetBound: !!target,
      elements: els,
    });
    const adds = els.filter((x) => x.state === 'found').map((x) => x.targetId!);
    if (adds.length || !target)
      bindingSets.push({
        portId: port.id,
        // what is bound there stays (setBinding keeps elements the person may not see); the found ones join
        elementIds: [...new Set([...(target?.elementIds ?? []).filter((id) => elements.has(id)), ...adds])],
        contractId: target ? target.contract_id : (b.contract_id ?? null),
        contractVersion: target ? target.contract_version : b.contract_version,
        contractServer: target ? target.contract_server : null,
        objectives: parseJson<DataObjectives>((target ?? b).objectives, {}),
      });
  }
  previewBindings.sort((a, b) => a.portName.localeCompare(b.portName) || a.version.localeCompare(b.version));
  const memberAdds = new Map<string, Plan['memberAdds'][number]>();
  for (const m of sourceMembers) {
    const t = resolved.get(m.element_id);
    if (!t || memberIds.has(t.id)) continue;
    const key = `${m.role}|${m.include_descendants ? 1 : 0}`;
    const g = memberAdds.get(key) ?? { role: m.role, includeDescendants: !!m.include_descendants, elementIds: [] };
    if (!g.elementIds.includes(t.id)) g.elementIds.push(t.id);
    memberAdds.set(key, g);
  }
  const all = [...previewMembers, ...previewBindings.flatMap((b) => b.elements)];
  const counts = {
    found: all.filter((x) => x.state === 'found').length,
    missing: all.filter((x) => x.state === 'missing').length,
    already: all.filter((x) => x.state === 'already').length,
  };
  const fingerprint = sha256(
    canonicalJson({
      from,
      to,
      members: previewMembers.map((m) => [m.sourceId, m.targetId, m.state, m.role]),
      bindings: previewBindings.map((b) => [b.portId, b.targetBound, b.elements.map((x) => [x.sourceId, x.targetId, x.state])]),
    }),
  ).slice(0, 32);
  return {
    preview: { productId, from, to, rules, members: previewMembers, bindings: previewBindings, counts, hidden, fingerprint },
    memberAdds: [...memberAdds.values()],
    bindingSets,
  };
}

/** GET /api/data-products/:id/promotion?from=&to= – who may see the product. */
export function promotionPreview(productId: string, from: string, to: string): DataPromotionPreview {
  const u = me();
  const { row } = visibleProduct(productId, u);
  return plan(u, row.id, from.trim(), to.trim()).preview;
}

/** POST /api/data-products/:id/promotion (session only) – who may change the product. */
export function promote(productId: string, body: unknown): { promotion: DataPromotion; preview: DataPromotionPreview } {
  const u = me();
  const { row: p } = editableProduct(productId);
  const input = dataPromotionInput.parse(body);
  const pl = plan(u, p.id, input.from, input.to);
  if (input.fingerprint && input.fingerprint !== pl.preview.fingerprint) throw invalid('The product changed since the preview – look at it again', 'changed');
  if (!pl.memberAdds.length && !pl.bindingSets.length) throw invalid('There is nothing to promote', 'nothingToDo');
  const id = newId(DATA_GOVERNANCE_ID_PREFIX.promotion);
  const now = nowIso();
  const added = pl.memberAdds.reduce((n, g) => n + g.elementIds.length, 0);
  db().tx(() => {
    ensureEnvironment(p.id, input.to);
    for (const g of pl.memberAdds)
      for (let i = 0; i < g.elementIds.length; i += 500)
        addMembers(p.id, p.name, {
          elementIds: g.elementIds.slice(i, i + 500),
          role: g.role,
          includeDescendants: g.includeDescendants,
          note: `promoted from ${input.from}`,
        });
    for (const b of pl.bindingSets)
      setBinding(p.id, p.name, b.portId, input.to, {
        elementIds: b.elementIds,
        contractId: b.contractId,
        contractVersion: b.contractVersion,
        contractServer: b.contractServer,
        objectives: b.objectives,
      });
    db().run(
      'INSERT INTO dp_promotions (id, product_id, from_env, to_env, members, bindings, missing, evidence, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      p.id,
      input.from,
      input.to,
      added,
      pl.bindingSets.length,
      pl.preview.counts.missing,
      input.evidence ? json(input.evidence) : null,
      input.note,
      u.username,
      now,
    );
    touchProduct(p.id);
    audit({
      action: 'dataproduct.promoted',
      entityType: 'data_product',
      entityId: p.id,
      summary: `Data product "${p.name}" promoted from ${input.from} to ${input.to}: ${added} member(s), ${pl.bindingSets.length} binding(s), ${pl.preview.counts.missing} not found${input.evidence ? ` – evidence: ${input.evidence.kind} ${input.evidence.ref}` : ''}`,
      details: {
        promotionId: id,
        from: input.from,
        to: input.to,
        members: added,
        bindings: pl.bindingSets.map((b) => b.portId),
        missing: pl.preview.counts.missing,
        evidence: input.evidence,
        fingerprint: pl.preview.fingerprint,
      },
    });
  });
  return { promotion: promotionsOf(p.id).find((x) => x.id === id)!, preview: plan(u, p.id, input.from, input.to).preview };
}

interface PromotionRow {
  id: string;
  product_id: string;
  from_env: string;
  to_env: string;
  members: number;
  bindings: number;
  missing: number;
  evidence: string | null;
  note: string;
  created_by: string;
  created_at: string;
}

function promotionsOf(productId: string): DataPromotion[] {
  return db()
    .all<PromotionRow>('SELECT * FROM dp_promotions WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', productId, G.promotionsListed)
    .map((r) => ({
      id: r.id,
      productId: r.product_id,
      from: r.from_env,
      to: r.to_env,
      members: Number(r.members),
      bindings: Number(r.bindings),
      missing: Number(r.missing),
      evidence: parseJson(r.evidence, null),
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    }));
}

/** GET /api/data-products/:id/promotions – the newest first. */
export function listPromotions(productId: string): DataPromotion[] {
  const { row } = visibleProduct(productId);
  return promotionsOf(row.id);
}

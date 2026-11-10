import { z } from 'zod';
import {
  PLANT_DOC_GAPS,
  PLANT_DOC_HINTS,
  PLANT_DOC_KINDS,
  PLANT_DOC_REVIEW_LIMITS,
  type PlantDocConfirmation,
  type PlantDocGap,
  type PlantDocHealth,
  type PlantDocHealthGroup,
  type PlantDocHealthItem,
  type PlantDocHint,
  type PlantDocKind,
  type PlantDocReview,
  type PlantDocuments,
  type PlantSiteDetail,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { canReadRecordRow } from '../records/access.js';
import { HttpError, nowIso, parseJson } from '../util.js';
import { canManageCatalogue, sitePermissions } from './access.js';
import { plantSettings } from './settings.js';
import { getSite, visibleAsset, visibleSite } from './service.js';
import { allAssignments, allKpis, allProfiles } from './data-model.js';
import { inputGaps } from './checks.js';
import { collectedPoints, isCollected } from './potential.js';
import { collectionLinkId } from './links.js';

/**
 * Documentation still current (0.14, docs/PLANT.md "Documentation still current"). Plant assets and their documents
 * live for decades: a document (a record linked to a plant entry) or an asset's documentation as a whole can be
 * confirmed as still current – who and when, audited (`plant.document_confirmed`, `plant.documentation_confirmed`), the
 * last one kept here. An optional review interval – per document type (plant settings) or per site (the site's settings)
 * – turns into a gentle hint when a confirmation is due: never an error, never a notification.
 *
 * Confirming is a light action, not a change set operation (ADR 0020): it changes no entry's values and no revision,
 * there is nothing to review, compare or revert – it is a note that someone looked, like a periodic review of a record.
 * Who may propose changes on the site (operators and plant viewers included: who knows the plant best) may confirm.
 * The site's interval is a setting of the site, changed by who manages it, as its other settings.
 *
 * This is not the periodic review of living documents (RECORDS.md), which is a control with reminders and editions.
 */

const MONTH_MS = 30.4375 * 86400000;
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** The intervals per document type (record type key → months) from the plant settings. */
export const typeMonths = (): Record<string, number> => plantSettings().documentReview ?? {};

export const siteMonths = (siteId: string | null): number | null => {
  if (!siteId) return null;
  const v = db().get<{ doc_review_months: number | null }>('SELECT doc_review_months FROM plant_sites WHERE id = ?', siteId)?.doc_review_months;
  return v === null || v === undefined || !Number(v) ? null : Number(v);
};

/** Add months to an ISO time (calendar months, the day kept where the month has it). */
function plusMonths(at: string, months: number): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return new Date(Date.now() + months * MONTH_MS).toISOString();
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString();
}

/** The hint of an interval: due when the last confirmation – else the baseline (the last change) – is older. */
export function reviewOf(months: number | null, confirmation: PlantDocConfirmation | null, baseline: string, now = Date.now()): PlantDocReview | null {
  if (!months) return null;
  const dueAt = plusMonths(confirmation?.at ?? baseline, months);
  return { months, dueAt, due: Date.parse(dueAt) <= now };
}

export function confirmationsOf(kind: 'record' | 'asset', ids: string[]): Map<string, PlantDocConfirmation> {
  const out = new Map<string, PlantDocConfirmation>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db().all<{ target_id: string; confirmed_at: string; confirmed_by: string }>(
      `SELECT target_id, confirmed_at, confirmed_by FROM plant_doc_confirmations WHERE kind = ? AND target_id IN (${marks(chunk.length)})`,
      kind,
      ...chunk,
    ))
      out.set(r.target_id, { at: r.confirmed_at, by: r.confirmed_by });
  }
  return out;
}

const recordChanged = (ids: string[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db().all<{ id: string; updated_at: string }>(`SELECT id, updated_at FROM records WHERE id IN (${marks(chunk.length)})`, ...chunk))
      out.set(r.id, r.updated_at);
  }
  return out;
};

/** The site of a Documents panel's entry (null: a device profile, which belongs to no site). */
function siteOfEntry(kind: PlantDocKind, id: string): string | null {
  if (kind === 'site') return id;
  if (kind === 'device-profile') return null;
  const assetId = kind === 'asset' ? id : collectionLinkId(id)?.assetId;
  return assetId ? (db().get<{ site_id: string }>('SELECT site_id FROM plant_assets WHERE id = ?', assetId)?.site_id ?? null) : null;
}

/** May the reader confirm on this entry's panel: who may propose changes on its site; on a device profile who manages the catalogues. */
function mayConfirm(kind: PlantDocKind, siteId: string | null): boolean {
  const u = currentUser();
  if (!u) return false;
  if (kind === 'device-profile') return canManageCatalogue(u);
  const s = siteId ? db().get<{ id: string; acl: string }>('SELECT id, acl FROM plant_sites WHERE id = ?', siteId) : undefined;
  return !!s && sitePermissions(s, u).includes('propose');
}

/** Adds the confirmations and hints to a Documents panel (documents.ts plantDocuments). */
export function withConfirmations(d: PlantDocuments, now = Date.now()): PlantDocuments {
  const siteId = siteOfEntry(d.kind, d.id);
  const site = siteMonths(siteId);
  const types = typeMonths();
  const all = [d.own, ...d.inherited].flatMap((g) => g.documents);
  const conf = confirmationsOf(
    'record',
    all.map((x) => x.id),
  );
  const changed = recordChanged(all.map((x) => x.id));
  for (const g of [d.own, ...d.inherited])
    g.documents = g.documents.map((x) => {
      const confirmation = conf.get(x.id) ?? null;
      return { ...x, confirmation, review: reviewOf(types[x.typeKey] ?? site, confirmation, changed.get(x.id) ?? nowIso(), now) };
    });
  d.canConfirm = mayConfirm(d.kind, siteId);
  if (d.kind === 'asset') {
    const confirmation = confirmationsOf('asset', [d.id]).get(d.id) ?? null;
    const created = db().get<{ created_at: string }>('SELECT created_at FROM plant_assets WHERE id = ?', d.id)?.created_at ?? nowIso();
    d.documentation = { confirmation, review: reviewOf(site, confirmation, created, now) };
  }
  return d;
}

// ---------- confirming ----------

export const confirmInput = z
  .object({
    kind: z.enum(['record', 'asset']),
    id: z.string().trim().min(1).max(200),
    entry: z
      .object({ kind: z.enum(PLANT_DOC_KINDS), id: z.string().trim().min(1).max(300) })
      .strict()
      .optional(),
  })
  .strict();

/**
 * POST /api/plant/documents/confirm: "Still current" – of a document listed on an entry's Documents panel (own or
 * inherited), or of an asset's documentation as a whole. Returns the panel again.
 */
export async function confirmCurrent(input: z.infer<typeof confirmInput>): Promise<PlantDocuments> {
  const { plantDocuments } = await import('./documents.js');
  const entry = input.kind === 'asset' ? { kind: 'asset' as const, id: input.id } : input.entry;
  if (!entry) throw new HttpError(400, 'Name the page the document is listed on (entry)', 'PLANT_DOC_ENTRY');
  // the panel as the reader sees it: a hidden site reads like a missing one (404), a record they may not read is not listed
  const panel = plantDocuments(entry.kind, entry.id);
  if (!panel.canConfirm) throw new HttpError(403, 'You may not confirm the documentation of this entry', 'FORBIDDEN', { context: 'confirmPlantDocs' });
  const u = currentUser()!;
  const at = nowIso();
  if (input.kind === 'record') {
    const doc = [panel.own, ...panel.inherited].flatMap((g) => g.documents).find((x) => x.id === input.id);
    if (!doc) throw new HttpError(404, `Document ${input.id} is not listed on this page`, 'PLANT_DOC_NOT_LISTED', { id: input.id });
    db().tx(() => {
      upsert('record', doc.id, at, u.username);
      audit({
        action: 'plant.document_confirmed',
        entityType: 'record',
        entityId: doc.id,
        summary: `Document ${doc.number} "${doc.title}" confirmed as still current (on ${entry.kind} "${panel.label}")`,
        details: { entry, previous: doc.confirmation },
      });
    });
  } else {
    db().tx(() => {
      upsert('asset', input.id, at, u.username);
      audit({
        action: 'plant.documentation_confirmed',
        entityType: 'asset',
        entityId: input.id,
        summary: `The documentation of asset "${panel.label}" confirmed as still current`,
        details: { previous: panel.documentation?.confirmation ?? null },
      });
    });
  }
  return plantDocuments(entry.kind, entry.id);
}

function upsert(kind: 'record' | 'asset', id: string, at: string, by: string): void {
  db().run(
    `INSERT INTO plant_doc_confirmations (kind, target_id, confirmed_at, confirmed_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (kind, target_id) DO UPDATE SET confirmed_at = excluded.confirmed_at, confirmed_by = excluded.confirmed_by`,
    kind,
    id,
    at,
    by,
  );
}

// ---------- the site's interval (a setting of the site) ----------

export const siteDocReviewInput = z.object({ months: z.number().int().min(1).max(PLANT_DOC_REVIEW_LIMITS.monthsMax).nullable() }).strict();

/** PUT /api/plant/sites/:siteId/doc-review: who manages the site sets how often its documentation should be confirmed. */
export function setSiteDocReview(siteId: string, months: number | null): PlantSiteDetail {
  const { row, perms } = visibleSite(siteId);
  if (!perms.includes('manage')) throw new HttpError(403, 'You may not change this site', 'FORBIDDEN', { context: 'managePlant' });
  const before = siteMonths(siteId);
  if (before !== months)
    db().tx(() => {
      db().run('UPDATE plant_sites SET doc_review_months = ? WHERE id = ?', months, siteId);
      audit({
        action: 'site.doc_review_changed',
        entityType: 'site',
        entityId: siteId,
        summary: months
          ? `The documentation of site "${row.name}" should be confirmed every ${months} months`
          : `The documentation of site "${row.name}" has no review interval any more`,
        details: { old: before, new: months },
      });
    });
  return getSite(siteId);
}

// ---------- documentation health of a site ----------

type AssetRow = { id: string; name: string; created_at: string };
const enc = encodeURIComponent;

/** GET /api/plant/sites/:siteId/documentation: gaps to fill and confirmations that are due, each linked to where. */
export function documentationHealth(siteId: string, now = Date.now()): PlantDocHealth {
  const { perms } = visibleSite(siteId);
  const assets = db().all<AssetRow>('SELECT id, name, created_at FROM plant_assets WHERE site_id = ?', siteId);
  assets.sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const ids = new Set(assets.map((a) => a.id));
  const assetPath = (id: string) => `/plant/assets/${enc(id)}`;
  const gaps = new Map<PlantDocGap, PlantDocHealthItem[]>(PLANT_DOC_GAPS.map((g) => [g, []]));
  const hints = new Map<PlantDocHint, PlantDocHealthItem[]>(PLANT_DOC_HINTS.map((h) => [h, []]));
  const assignments = allAssignments();
  const profiles = allProfiles();
  const kpis = [...allKpis().values()].filter((k) => k.inputs.some((i) => i.kind === 'data_point'));
  const collected = collectedPoints(ids);
  for (const a of assets) {
    const as = assignments.get(a.id);
    const profile = as?.profileId ? profiles.get(as.profileId) : undefined;
    if (!as?.profileId) {
      gaps.get('assetNoProfile')!.push({ id: a.id, name: a.name, detail: '', path: `${assetPath(a.id)}#data` });
      continue;
    }
    if (!profile) continue;
    for (const def of kpis) {
      if (as.kpis.some((k) => k.kpi === def.id)) continue;
      if (inputGaps(def, as, profile).length || isCollected(def, collected.get(a.id), profile)) continue;
      gaps.get('kpiNotCollected')!.push({ id: `${a.id}/${def.id}`, name: def.name, detail: a.name, path: `${assetPath(a.id)}/collections` });
    }
  }
  const inSite = <T extends { asset_id: string }>(rows: T[]) => rows.filter((r) => ids.has(r.asset_id));
  for (const d of inSite(
    db().all<{ asset_id: string; id: string; hostname: string; vlan_id: string | null }>('SELECT asset_id, id, hostname, vlan_id FROM plant_devices'),
  ))
    if (!d.vlan_id)
      gaps
        .get('deviceNoVlan')!
        .push({
          id: `${d.asset_id}/${d.id}`,
          name: d.hostname || d.id,
          detail: byId.get(d.asset_id)!.name,
          path: `/plant/sites/${enc(siteId)}/network/devices`,
        });
  for (const p of inSite(
    db().all<{ asset_id: string; id: string; subject: string; destinations: string }>('SELECT asset_id, id, subject, destinations FROM plant_data_paths'),
  ))
    if (!parseJson<unknown[]>(p.destinations, []).length)
      gaps
        .get('pathNoSink')!
        .push({ id: `${p.asset_id}/${p.id}`, name: p.subject, detail: byId.get(p.asset_id)!.name, path: `/plant/sites/${enc(siteId)}/network/paths` });
  for (const c of inSite(
    db().all<{ asset_id: string; id: string; name: string; items: string; sinks: string; destination: string | null }>(
      'SELECT asset_id, id, name, items, sinks, destination FROM plant_collections',
    ),
  )) {
    const item = {
      id: `${c.asset_id}/${c.id}`,
      name: c.name,
      detail: byId.get(c.asset_id)!.name,
      path: `${assetPath(c.asset_id)}/collections?collection=${enc(c.id)}`,
    };
    if (!parseJson<unknown[]>(c.items, []).length) gaps.get('collectionNoItems')!.push(item);
    if (!parseJson<unknown[]>(c.sinks, []).length && !c.destination) gaps.get('collectionNoSink')!.push(item);
  }

  // hints: confirmations that are due
  const site = siteMonths(siteId);
  const types = typeMonths();
  const assetConf = confirmationsOf(
    'asset',
    assets.map((a) => a.id),
  );
  let confirmed = 0;
  for (const a of assets) {
    const c = assetConf.get(a.id) ?? null;
    const r = reviewOf(site, c, a.created_at, now);
    if (c && !r?.due) confirmed++;
    if (r?.due)
      hints.get('assetNotConfirmed')!.push({ id: a.id, name: a.name, detail: '', path: `${assetPath(a.id)}#documents`, confirmation: c, dueAt: r.dueAt });
  }
  // the documents of the site and its assets (and their collections), as far as the reader may read them
  const u = currentUser();
  if (!plantOnly(u) && (site || Object.keys(types).length)) {
    const links = db().all<{ id: string; kind: string; entry: string }>(
      `SELECT from_id AS id, to_kind AS kind, to_id AS entry FROM item_links WHERE from_kind = 'record' AND to_kind IN ('site', 'asset', 'data-collection', 'data-sink')`,
    );
    const back = db().all<{ id: string; kind: string; entry: string }>(
      `SELECT to_id AS id, from_kind AS kind, from_id AS entry FROM item_links WHERE to_kind = 'record' AND from_kind IN ('site', 'asset')`,
    );
    const entryAsset = (kind: string, entry: string) => (kind === 'site' ? null : kind === 'asset' ? entry : (collectionLinkId(entry)?.assetId ?? null));
    const where = new Map<string, string | null>();
    for (const l of [...links, ...back]) {
      const asset = entryAsset(l.kind, l.entry);
      if ((l.kind === 'site' && l.entry === siteId) || (asset && ids.has(asset))) if (!where.has(l.id)) where.set(l.id, asset);
    }
    const recIds = [...where.keys()];
    const rows: { id: string; number: string; title: string; type_id: string; fields: string; owner: string; updated_at: string; type_key: string }[] = [];
    for (let i = 0; i < recIds.length; i += 500) {
      const chunk = recIds.slice(i, i + 500);
      rows.push(
        ...db().all<(typeof rows)[number]>(
          `SELECT r.id, r.number, r.title, r.type_id, r.fields, r.owner, r.updated_at, t.key AS type_key FROM records r JOIN record_types t ON t.id = r.type_id WHERE r.id IN (${marks(chunk.length)})`,
          ...chunk,
        ),
      );
    }
    const conf = confirmationsOf(
      'record',
      rows.map((r) => r.id),
    );
    rows.sort((a, b) => a.number.localeCompare(b.number));
    for (const r of rows) {
      if (!canReadRecordRow(u, r)) continue;
      const c = conf.get(r.id) ?? null;
      const rev = reviewOf(types[r.type_key] ?? site, c, r.updated_at, now);
      if (!rev?.due) continue;
      const asset = where.get(r.id);
      hints.get('documentNotConfirmed')!.push({
        id: r.id,
        name: `${r.number} ${r.title}`,
        detail: asset ? (byId.get(asset)?.name ?? '') : '',
        path: asset ? `${assetPath(asset)}#documents` : `/plant/sites/${enc(siteId)}#documents`,
        confirmation: c,
        dueAt: rev.dueAt,
      });
    }
  }
  const groups = <K extends string>(m: Map<K, PlantDocHealthItem[]>): PlantDocHealthGroup<K>[] =>
    [...m].map(([kind, items]) => ({ kind, total: items.length, items: items.slice(0, PLANT_DOC_REVIEW_LIMITS.items) }));
  return {
    siteId,
    reviewMonths: site,
    typeMonths: types,
    gaps: groups(gaps),
    hints: groups(hints),
    assets: assets.length,
    confirmed,
    canManage: perms.includes('manage'),
  };
}

/** An asset's documentation for the public API (GET /api/v1/plant/assets/:assetId/documentation). */
export async function assetDocumentation(assetId: string) {
  visibleAsset(assetId);
  const { plantDocuments } = await import('./documents.js');
  const d = plantDocuments('asset', assetId);
  return {
    assetId,
    confirmation: d.documentation?.confirmation ?? null,
    review: d.documentation?.review ?? null,
    documents: [d.own, ...d.inherited].flatMap((g) =>
      g.documents.map((x) => ({
        id: x.id,
        number: x.number,
        title: x.title,
        typeKey: x.typeKey,
        inheritedFrom: g.from ? { kind: g.from.kind, id: g.from.id } : null,
        confirmation: x.confirmation,
        review: x.review,
      })),
    ),
    hidden: [d.own, ...d.inherited].reduce((n, g) => n + g.hidden, 0),
  };
}

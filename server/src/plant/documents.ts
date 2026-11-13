import { PLANT_SOURCE_TYPE_ID, type PlantDocGroup, type PlantDocItem, type PlantDocKind, type PlantDocuments } from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { plantOnly } from '../auth/policy.js';
import { forbid } from '../auth/access.js';
import { canCreateRecords, canReadRecordRow } from '../records/access.js';
import { HttpError } from '../util.js';
import { requirePlant } from './settings.js';
import { visibleAsset, visibleSite } from './service.js';
import { profileNotFound } from './catalogue.js';
import { allAssignments, allProfiles, profileRowOf } from './data-model.js';
import { collectionRowOf, collectionRows, sinksOf } from './collections-model.js';
import { collectionNotFound } from './collections.js';
import { collectionLinkId, seesProfiles } from './links.js';
import { withConfirmations } from './doc-review.js';
import { HiddenRefs, seesEntry } from './catalogue-access.js';
import { PLANT_HIDDEN } from '@sm/shared';

/**
 * The Documents panel of plant pages (0.12, docs/PLANT.md "Documents"): the records linked to a site, asset, device
 * profile, data collection or sink – and, read-only, those of what it inherits from: a derived profile its base
 * profiles' records, an asset its profile chain's and its collections' (and their sinks'), a collection its sinks'.
 *
 * A record the reader may not read is counted, not named (as links elsewhere); a plant viewer reads no records.
 */

type RecRow = {
  id: string;
  number: string;
  title: string;
  status: string;
  type_id: string;
  fields: string;
  owner: string;
  type_key: string;
  type_name: string;
  workflow: string;
};

const REC_SELECT =
  'SELECT r.id, r.number, r.title, r.status, r.type_id, r.fields, r.owner, t.key AS type_key, t.name AS type_name, t.workflow FROM records r JOIN record_types t ON t.id = r.type_id';

const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** The ids of the records linked to an entry: records that link to it, and records a site or asset links to. */
function linkedRecordIds(kind: PlantDocKind, id: string): string[] {
  const ids = db()
    .all<{ id: string }>("SELECT from_id AS id FROM item_links WHERE from_kind = 'record' AND to_kind = ? AND to_id = ?", kind, id)
    .map((r) => r.id);
  if (kind === 'site' || kind === 'asset')
    ids.push(
      ...db()
        .all<{ id: string }>("SELECT to_id AS id FROM item_links WHERE from_kind = ? AND from_id = ? AND to_kind = 'record'", kind, id)
        .map((r) => r.id),
    );
  return [...new Set(ids)];
}

function group(kind: PlantDocKind, id: string, from: PlantDocGroup['from'], counted = false): PlantDocGroup {
  const ids = linkedRecordIds(kind, id);
  if (!ids.length) return { from, documents: [], hidden: 0 };
  // files follow the profile (0.21.0, #293): the documents of a profile the reader may not see are counted only
  if (counted) return { from, documents: [], hidden: ids.length };
  const u = currentUser();
  const rows: RecRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    rows.push(...db().all<RecRow>(`${REC_SELECT} WHERE r.id IN (${marks(chunk.length)})`, ...chunk));
  }
  // a plant viewer reads no records: every one is counted only
  const readable = plantOnly(u) ? [] : rows.filter((r) => canReadRecordRow(u, r));
  const editions = new Map<string, string | null>();
  const files = new Map<string, number>();
  if (readable.length) {
    const rid = readable.map((r) => r.id);
    for (const d of db().all<{ record_id: string; current_edition: string | null }>(
      `SELECT record_id, current_edition FROM record_documents WHERE record_id IN (${marks(rid.length)})`,
      ...rid,
    ))
      editions.set(d.record_id, d.current_edition);
    for (const a of db().all<{ record_id: string; n: number }>(
      `SELECT record_id, COUNT(*) AS n FROM record_attachments WHERE kind = 'file' AND record_id IN (${marks(rid.length)}) GROUP BY record_id`,
      ...rid,
    ))
      files.set(a.record_id, Number(a.n));
  }
  const documents = readable
    .map((r): PlantDocItem => ({
      id: r.id,
      number: r.number,
      title: r.title,
      typeKey: r.type_key,
      typeName: r.type_name,
      workflow: r.workflow,
      status: r.status,
      edition: editions.get(r.id) ?? null,
      attachments: files.get(r.id) ?? 0,
      generated: r.type_id === PLANT_SOURCE_TYPE_ID,
      // 0.14: filled in for the whole panel (doc-review.ts withConfirmations)
      confirmation: null,
      review: null,
    }))
    .sort((a, b) => a.number.localeCompare(b.number));
  // records that no longer exist (a link left behind) are neither named nor counted
  return { from, documents, hidden: rows.length - readable.length };
}

const assetPath = (id: string) => `/plant/assets/${encodeURIComponent(id)}`;
const collectionPath = (assetId: string, id: string) => `${assetPath(assetId)}/collections?collection=${encodeURIComponent(id)}`;

/** The profile chain of a profile (itself first), resolved; [] when unknown. */
const chainOf = (profileId: string | null | undefined): string[] => (profileId ? (allProfiles().get(profileId)?.chain ?? []) : []);

/** The groups a collection passes on: its sinks. */
function sinkGroups(assetId: string, collectionId: string): PlantDocGroup[] {
  const r = collectionRowOf(assetId, collectionId);
  if (!r) return [];
  return sinksOf(r).map((s) =>
    group('data-sink', `${assetId}/${collectionId}/${s.id}`, {
      kind: 'data-sink',
      id: `${assetId}/${collectionId}/${s.id}`,
      label: `${r.name} › ${s.name || s.id}`,
      path: collectionPath(assetId, collectionId),
    }),
  );
}

/**
 * A record is listed once: where the entry has it itself, else under the first entry it inherits it from (the gateway
 * configuration document is linked to the asset and the collection). Groups left without records go.
 */
function withoutRepeats(d: PlantDocuments): PlantDocuments {
  const seen = new Set(d.own.documents.map((x) => x.id));
  d.inherited = d.inherited
    .map((g) => {
      const documents = g.documents.filter((x) => !seen.has(x.id));
      for (const x of documents) seen.add(x.id);
      return { ...g, documents };
    })
    .filter((g) => g.documents.length || g.hidden);
  return d;
}

/** GET /api/plant/documents?kind=&id= : the records of an entry and those it inherits, as far as the reader may read them. */
export function plantDocuments(kind: PlantDocKind, id: string): PlantDocuments {
  requirePlant();
  const u = currentUser();
  const canCreate = !plantOnly(u) && canCreateRecords(u);
  const own = (label: string): PlantDocuments => ({ kind, id, label, own: group(kind, id, null), inherited: [], canCreate, canConfirm: false });
  return withConfirmations(panel(kind, id, own));
}

/**
 * The groups of profiles a page inherits documents from (an asset its profile chain, a derived profile its bases). A
 * profile the reader may not see is not named – "1 document of a profile you may not see" (part 4).
 */
function profileGroups(chain: string[], profiles: Map<string, { name: string }>): PlantDocGroup[] {
  const u = currentUser();
  const refs = new HiddenRefs((p) => seesEntry(u, 'device_profile', p), chain);
  return chain.map((p) => {
    const hidden = refs.hides(p);
    const from = hidden
      ? { kind: 'device-profile' as const, id: refs.ref(p), label: PLANT_HIDDEN, path: null }
      : { kind: 'device-profile' as const, id: p, label: profiles.get(p)?.name ?? p, path: `/plant/profiles/${encodeURIComponent(p)}` };
    return group('device-profile', p, from, hidden);
  });
}

function panel(kind: PlantDocKind, id: string, own: (label: string) => PlantDocuments): PlantDocuments {
  switch (kind) {
    case 'site': {
      const { row } = visibleSite(id);
      return own(row.name);
    }
    case 'asset': {
      const { row } = visibleAsset(id);
      const out = own(row.name);
      const profiles = allProfiles();
      const chain = chainOf(allAssignments().get(id)?.profileId);
      out.inherited.push(...profileGroups(chain, profiles));
      for (const c of collectionRows(id)) {
        out.inherited.push(
          group('data-collection', `${id}/${c.id}`, { kind: 'data-collection', id: `${id}/${c.id}`, label: c.name, path: collectionPath(id, c.id) }),
        );
        out.inherited.push(...sinkGroups(id, c.id));
      }
      return withoutRepeats(out);
    }
    case 'device-profile': {
      if (!seesProfiles()) forbid('see device profiles');
      const r = profileRowOf(id);
      if (!r || !seesEntry(currentUser(), 'device_profile', id)) throw profileNotFound(id);
      const out = own(r.name);
      // the bases, nearest first (the chain starts with the profile itself)
      out.inherited.push(...profileGroups(chainOf(id).slice(1), allProfiles()));
      return withoutRepeats(out);
    }
    case 'data-collection':
    case 'data-sink': {
      const k = collectionLinkId(id);
      if (!k || (kind === 'data-sink') !== !!k.sinkId)
        throw new HttpError(400, `"${id}" is not a ${kind} id (<asset>/<collection>${kind === 'data-sink' ? '/<sink>' : ''})`, 'PLANT_DOC_ID', { id });
      visibleAsset(k.assetId);
      const c = collectionRowOf(k.assetId, k.collectionId);
      if (!c) throw collectionNotFound(k.collectionId);
      if (kind === 'data-sink') {
        const s = sinksOf(c).find((x) => x.id === k.sinkId);
        if (!s) throw new HttpError(404, `Sink ${k.sinkId} not found`, 'PLANT_SINK_NOT_FOUND', { id: k.sinkId! });
        return own(s.name || s.id);
      }
      const out = own(c.name);
      out.inherited = sinkGroups(k.assetId, k.collectionId);
      return withoutRepeats(out);
    }
  }
}

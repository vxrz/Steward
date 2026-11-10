import { PLANT_PROPOSAL_LIMITS, PROFILE_POINT_FIELDS, type McpPlantSourceGroup, type PlantDataPoint, type PlantDocKind } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { HttpError } from '../util.js';
import { allAssignments, resolvedProfile } from './data-model.js';
import { dataPointSchema, type DataPointFile } from './format.js';
import { pointKeysOfFile, pointOfFile } from './import-data.js';
import { plantDocuments } from './documents.js';
import { currentId } from './ids.js';

/**
 * The sources of the data points a plant proposal adds or changes (0.16.1, docs/PLANT.md "Sources of data points"): an
 * assistant that reads a manual names, per data point, the document and the page. The review lists them by entry and
 * document, and says whether that document is kept in Steward – a record linked to the profile (or the asset), its own
 * or inherited, whose number or title is the one the source names. Otherwise the reviewer is offered to attach it on the
 * entry's Documents panel: an assistant cannot upload a manual, and nothing here creates or links records.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const listOf = (doc: Obj, one: string, many: string): Obj[] => [
  ...(isObj(doc[one]) ? [doc[one] as Obj] : []),
  ...(Array.isArray(doc[many]) ? (doc[many] as unknown[]).filter(isObj) : []),
];
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const FIELDS = ['id', 'name', ...PROFILE_POINT_FIELDS] as const;

/** Whether a data point of the document differs from the stored one: all its fields, or (an inherited one) the keys given. */
function changes(d: DataPointFile, stored: PlantDataPoint, full: boolean): boolean {
  if (full) {
    const next = pointOfFile(d) as unknown as Obj;
    return FIELDS.some((k) => !same(next[k], (stored as unknown as Obj)[k]));
  }
  const keys = pointKeysOfFile(d) as unknown as Obj;
  return PROFILE_POINT_FIELDS.some((k) => keys[k] !== undefined && !same(keys[k], (stored as unknown as Obj)[k]));
}

interface Found {
  kind: 'profile' | 'asset';
  entry: string;
  entryName: string;
  exists: boolean;
  iface: string;
  group: string;
  point: DataPointFile;
  action: 'add' | 'change';
}

function profilePoints(doc: Obj, out: Found[]): void {
  for (const p of listOf(doc, 'device_profile', 'device_profiles')) {
    const id = currentId('profile', '', str(p.id));
    if (!id) continue;
    const stored = resolvedProfile(id);
    const storedPoints = new Map<string, PlantDataPoint>();
    for (const i of stored?.interfaces ?? []) for (const g of i.groups) for (const x of g.dataPoints) storedPoints.set(x.id, x);
    for (const i of arr(p.interfaces)) {
      const items: [string, Obj][] = [
        ...arr(i.groups).flatMap((g) => arr(g.data_points).map((d): [string, Obj] => [str(g.name), d])),
        ...arr(i.data_points).map((d): [string, Obj] => ['', d]),
      ];
      for (const [group, raw] of items) {
        if (!isObj(raw.source)) continue;
        const parsed = dataPointSchema.safeParse(raw);
        if (!parsed.success) continue;
        const now = storedPoints.get(parsed.data.id);
        const origin = stored?.origins.points[parsed.data.id];
        const own = !origin || (origin.kind === 'own' && origin.from === id);
        const action = !now ? 'add' : changes(parsed.data, now, own) ? 'change' : null;
        if (action)
          out.push({
            kind: 'profile',
            entry: id,
            entryName: stored?.name ?? (str(p.name) || id),
            exists: !!stored,
            iface: str(i.id),
            group,
            point: parsed.data,
            action,
          });
      }
    }
  }
}

function assetPoints(doc: Obj, sees: (siteId: string | null) => boolean, out: Found[]): void {
  const assignments = listOf(doc, 'assignment', 'assignments').filter((a) => isObj(a.additions));
  if (!assignments.length) return;
  const stored = allAssignments();
  for (const a of assignments) {
    const id = currentId('asset', '', str(a.asset));
    const row = db().get<{ site_id: string; name: string }>('SELECT site_id, name FROM plant_assets WHERE id = ?', id);
    // an asset of a site the reader may not see is left out, as its entry in the preview
    if (!row || !sees(row.site_id)) continue;
    const now = stored.get(id)?.additions?.dataPoints ?? [];
    for (const raw of arr((a.additions as Obj).data_points)) {
      if (!isObj(raw.source)) continue;
      const parsed = dataPointSchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== 'interface' && k !== 'group')));
      if (!parsed.success) continue;
      const iface = str(raw.interface);
      const was = now.find((x) => x.id === parsed.data.id && x.interface === iface);
      const action = !was ? 'add' : changes(parsed.data, was, true) ? 'change' : null;
      if (action) out.push({ kind: 'asset', entry: id, entryName: row.name, exists: true, iface, group: str(raw.group), point: parsed.data, action });
    }
  }
}

/** The records linked to an entry (its own and inherited), as the reader sees them; none when they may not read them. */
function recordsOf(kind: PlantDocKind, id: string): { id: string; number: string; title: string }[] {
  try {
    const d = plantDocuments(kind, id);
    return [...d.own.documents, ...d.inherited.flatMap((g) => g.documents)].map((x) => ({ id: x.id, number: x.number, title: x.title }));
  } catch (e) {
    if (!(e instanceof HttpError)) logger.debug({ err: e }, 'documents of a proposal’s entry not read');
    return [];
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/** The sources of a proposal's document, grouped by entry and document, at most PLANT_PROPOSAL_LIMITS.sourcePoints points. */
export function proposalSources(document: string, sees: (siteId: string | null) => boolean): { groups: McpPlantSourceGroup[]; more: number } {
  let doc: unknown;
  try {
    doc = JSON.parse(document);
  } catch {
    return { groups: [], more: 0 };
  }
  if (!isObj(doc)) return { groups: [], more: 0 };
  const found: Found[] = [];
  profilePoints(doc, found);
  assetPoints(doc, sees, found);
  const shown = found.slice(0, PLANT_PROPOSAL_LIMITS.sourcePoints);
  const groups = new Map<string, McpPlantSourceGroup>();
  const records = new Map<string, { id: string; number: string; title: string }[]>();
  for (const f of shown) {
    const s = f.point.source!;
    const document = s.document.trim();
    const key = `${f.kind}\u0000${f.entry}\u0000${norm(document)}`;
    let g = groups.get(key);
    if (!g) {
      const rkey = `${f.kind}\u0000${f.entry}`;
      if (f.exists && !records.has(rkey)) records.set(rkey, recordsOf(f.kind === 'profile' ? 'device-profile' : 'asset', f.entry));
      const record = (records.get(rkey) ?? []).find((r) => norm(r.number) === norm(document) || norm(r.title) === norm(document)) ?? null;
      g = { kind: f.kind, entry: f.entry, entryName: f.entryName, exists: f.exists, document, record, points: [] };
      groups.set(key, g);
    }
    g.points.push({
      interface: f.iface,
      group: f.group,
      id: f.point.id,
      name: f.point.name?.trim() || f.point.id,
      action: f.action,
      page: s.page === null || s.page === undefined ? '' : String(s.page).trim(),
      section: (s.section ?? '').trim(),
    });
  }
  return { groups: [...groups.values()], more: found.length - shown.length };
}

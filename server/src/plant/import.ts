import { z } from 'zod';
import YAML from 'yaml';
import {
  LEVEL_RECORD_TYPE,
  PLANT_FORMAT_VERSION,
  PLANT_IMPORT_MODES,
  PLANT_DIFF_LIMITS,
  PLANT_LIMITS,
  plantStewardChoicesInput,
  PLANT_MISSING,
  type ExternalRef,
  type FieldValues,
  type PlantChange,
  type PlantChangeAction,
  type PlantChangeKind,
  type PlantCounts,
  type PlantImportMode,
  type PlantImportPreview,
  type PlantImportProblem,
  type PlantImportResult,
  type PlantImportSummary,
  type PlantLevel,
  type PlantMissing,
  type PlantPermission,
  type PlantRecordType,
  type PlantKpiValues,
  type PlantProfileValues,
  type PlantResolvedProfile,
  type PlantAssignmentValues,
  type PlantEntryKind,
  plantIdMapInput,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { assignCreatorTeams } from '../auth/policy.js';
import { parseYaml } from '../yaml-safe.js';
import { HttpError, newId, nowIso, parseJson, sha256 } from '../util.js';
import { canCreateSites, plantManagesSome, siteRights } from './access.js';
import { fieldDefs, fieldProblems, isDate, isHttpUrl, plantSettings, requirePlant } from './settings.js';
import { issueMessages, plantFileSchema, SCHEMA_ID, type AreaFile, type AssetFile, type PlantFile, type SiteFile } from './format.js';
import { assignmentOut, computeData, dataPlanEmpty, emptyDataPlan, kpiOut, profileOut, planData, pushWrite, type DataPlan, type Write } from './import-data.js';
import { allAssignments, allKpis, allProfiles, ownProfiles } from './data-model.js';
import { HiddenRefs, assignmentRefs, catalogueScope, kpiRefs, presentAssignment, presentInputs, type CatalogueScope } from './catalogue-access.js';
import { assetPoints } from './collections-model.js';
import { applyRenames, missingEntries, planIds } from './import-ids.js';
import { auditBulkRenames, dryRun } from './rename.js';
import { planRemoval, type Target } from './removal.js';
import { assetNetworksOut, computeNetwork, emptyNetPlan, netPlanEmpty, otNetworkOut, planNetwork, type NetPlan } from './import-network.js';
import {
  assetValuesOf,
  buildingProblem,
  buildingValuesOf,
  cleanRefs,
  cleanTags,
  equipmentCycle,
  loadAllIndexes,
  nodeProblem,
  nodeValuesOf,
  refsOf,
  removeAssetRow,
  removeSiteRows,
  resolveLocation,
  siteValuesOf,
  upsertAsset,
  upsertBuilding,
  upsertNode,
  upsertSite,
  type AssetRow,
  type AssetValues,
  type BuildingRow,
  type BuildingValues,
  type NodeRow,
  type NodeValues,
  type SiteIndex,
  type SiteRow,
  type SiteValues,
} from './model.js';

/**
 * YAML import of the plant registry (#218): parse and check the files (size, keys, depth, the schema, the model rules),
 * compare them with what is stored and show what an import adds, changes and removes – then apply it in one
 * transaction, audited with its counts and the files' SHA-256.
 *
 * Identity: records are matched by their stable ids – a site by its id, a node or building by its site and id, an
 * asset by its id. Modes:
 * - add: only records that are not there yet; the others are left as they are;
 * - update: add, and overwrite what the file says (keys the file leaves out keep their values);
 * - replace: the file is the truth for an earlier import: its records are written in full, and the records that
 *   earlier import wrote and the file no longer has are removed or kept and marked "not in source".
 * Records people added by hand are never removed by an import.
 */

export const importInput = z
  .object({
    files: z
      // the bytes of all files together are checked before parsing (413 PLANT_IMPORT_TOO_LARGE)
      .array(z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(PLANT_LIMITS.importBytes * 2) }).strict())
      .min(1)
      .max(PLANT_LIMITS.importFiles),
    mode: z.enum(PLANT_IMPORT_MODES),
    missing: z.enum(PLANT_MISSING).default('mark'),
    replaces: z.string().trim().max(64).nullable().default(null),
    /** 0.11.0: old → new ids for the files' ids and references; mapped old ids that exist are renamed first */
    idMap: plantIdMapInput.optional(),
    /** 0.11.0: remove the entries of the kinds and sites the files cover that the files do not have */
    removeMissing: z.boolean().default(false),
    /** 0.11.0: removals take what belongs to an entry along (otherwise such an entry is refused) */
    cascade: z.boolean().default(false),
    /** 0.13.0: the preview's fingerprint – a different result is refused (PLANT_IMPORT_CHANGED); without it (scripts) the import applies as before */
    fingerprint: z.string().trim().max(80).optional(),
    /**
     * 0.19.0: fields changed in Steward since the last import keep Steward's value (`take: steward`, the default) or
     * take the file's – for all, and per field (changesets/steward.ts)
     */
    changedInSteward: plantStewardChoicesInput.optional(),
  })
  .strict();
export type ImportInput = z.infer<typeof importInput>;

// ---------- reading the files ----------

/** Nesting depth of a parsed document (iterative: deep nesting cannot overflow the stack). */
function depthOf(v: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d > max) max = d;
    if (d > PLANT_LIMITS.importDepth + 1) return d;
    for (const c of Array.isArray(x) ? x : Object.values(x)) stack.push([c, d + 1]);
  }
  return max;
}

interface Parsed {
  name: string;
  sha256: string;
  bytes: number;
  file: PlantFile | null;
}

function readFiles(files: ImportInput['files'], problems: PlantImportProblem[]): Parsed[] {
  const total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (total > PLANT_LIMITS.importBytes)
    throw new HttpError(413, `The files are too large together (at most ${PLANT_LIMITS.importBytes / 1024 / 1024} MB)`, 'PLANT_IMPORT_TOO_LARGE', {
      mb: PLANT_LIMITS.importBytes / 1024 / 1024,
    });
  const names = new Set<string>();
  return files.map((f) => {
    const out: Parsed = { name: f.name, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content), file: null };
    if (names.has(f.name)) {
      problems.push({ file: f.name, path: '(file)', message: 'The same file name is given twice' });
      return out;
    }
    names.add(f.name);
    let raw: unknown;
    try {
      raw = parseYaml(f.content, { maxBytes: PLANT_LIMITS.importBytes, maxKeys: 500_000, maxAliasCount: 100 });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const err = e as Error & { linePos?: { line: number; col: number }[] };
      const pos = err.linePos?.[0];
      problems.push({ file: f.name, path: pos ? `line ${pos.line}, column ${pos.col}` : '(file)', message: err.message.split('\n')[0]! });
      return out;
    }
    if (depthOf(raw) > PLANT_LIMITS.importDepth) {
      problems.push({ file: f.name, path: '(document)', message: `The document is nested deeper than ${PLANT_LIMITS.importDepth} levels` });
      return out;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { version?: unknown }).version === undefined)
      problems.push({ file: f.name, path: 'version', message: `Required: version: ${PLANT_FORMAT_VERSION} (the format of the file)` });
    const r = plantFileSchema.safeParse(raw);
    if (!r.success) {
      for (const m of issueMessages(r.error.issues))
        if (!(m.path === 'version' && problems.some((p) => p.file === f.name && p.path === 'version'))) problems.push({ file: f.name, ...m });
      return out;
    }
    out.file = r.data;
    return out;
  });
}

/** What the keys of a file can write (0.13.0, the change sets' tracker reads only these kinds). */
const FILE_KINDS: Record<string, PlantEntryKind[]> = {
  version: [],
  enterprise: [],
  site: ['site', 'node', 'building', 'asset'],
  sites: ['site', 'node', 'building', 'asset'],
  assets: ['asset'],
  ot_network: ['vlan', 'zone', 'conduit'],
  ot_networks: ['vlan', 'zone', 'conduit'],
  asset_network: ['asset_checks', 'device', 'data_path', 'collection'],
  asset_networks: ['asset_checks', 'device', 'data_path', 'collection'],
  device_profile: ['profile'],
  device_profiles: ['profile'],
  kpi_definition: ['kpi'],
  kpi_definitions: ['kpi'],
  assignment: ['assignment'],
  assignments: ['assignment'],
};
/** Files up to this size are read twice for their kinds; a larger import costs more than reading the whole registry. */
const KINDS_OF_BYTES = 1024 * 1024;

/**
 * The kinds of entries an import can write (0.13.0, the region of the change sets' tracker): the kinds its files hold –
 * when it adds and changes only (no replace, no removal, no id mapping) and the files are small; otherwise null (any).
 */
export function importKindsOf(input: ImportInput): PlantEntryKind[] | null {
  if (input.mode === 'replace' || input.removeMissing || input.idMap?.entries.length) return null;
  if (input.files.reduce((n, f) => n + f.content.length, 0) > KINDS_OF_BYTES) return null;
  const kinds = new Set<PlantEntryKind>();
  for (const f of input.files) {
    let raw: unknown;
    try {
      raw = parseYaml(f.content, { maxBytes: PLANT_LIMITS.importBytes, maxKeys: 500_000, maxAliasCount: 100 });
    } catch {
      return null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    for (const k of Object.keys(raw)) {
      const list = Object.hasOwn(FILE_KINDS, k) ? FILE_KINDS[k] : undefined;
      if (!list) return null;
      list.forEach((x) => kinds.add(x));
    }
  }
  return [...kinds];
}

// ---------- the plan: what the files say ----------

interface Origin {
  file: string;
  path: string;
}

interface PlannedSite extends Origin {
  values: Partial<SiteValues> & { id: string };
}
interface PlannedNode extends Origin {
  siteId: string;
  position: number;
  /** level, parent and name always (the nesting says them); the other keys when the file gives them */
  values: Partial<NodeValues> & Pick<NodeValues, 'id' | 'level' | 'parentId' | 'name'>;
}
interface PlannedBuilding extends Origin {
  siteId: string;
  position: number;
  values: Partial<BuildingValues> & { id: string; name: string };
}
interface PlannedAsset extends Origin {
  /** The site named or nested in (null: none given) */
  siteId: string | null;
  values: Partial<AssetValues> & { id: string; name: string };
  children: string[];
}

interface Plan {
  enterprise: string | null;
  sites: Map<string, PlannedSite>;
  nodes: Map<string, PlannedNode>; // key site/id
  buildings: Map<string, PlannedBuilding>;
  assets: Map<string, PlannedAsset>;
  /** Device profiles, KPI definitions and assignments (#219, import-data.ts) */
  data: DataPlan;
  /** The OT network of sites and assets (#220, import-network.ts) */
  net: NetPlan;
}

const key = (siteId: string, id: string) => `${siteId}/${id}`;
const has = <T extends object>(o: T, k: keyof T) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v: string | null | undefined) => (v ?? '').trim();
const refsFromFile = (refs: SiteFile['external_refs']): ExternalRef[] =>
  cleanRefs((refs ?? []).map((r) => ({ system: r.system.trim(), id: String(r.id).trim(), url: str(r.url), label: str(r.label) })));

function siteFromFile(s: SiteFile): PlannedSite['values'] {
  const v: PlannedSite['values'] = { id: s.id, name: s.name.trim() };
  if (has(s, 'code')) v.code = str(s.code);
  if (has(s, 'names')) v.names = s.names ?? {};
  if (has(s, 'description')) v.description = str(s.description);
  if (has(s, 'geo')) v.geo = s.geo ? { lat: s.geo.lat, lon: s.geo.lon, zoom: s.geo.zoom ?? null } : null;
  if (has(s, 'contacts'))
    v.contacts = (s.contacts ?? []).map((c) => ({ name: c.name.trim(), role: str(c.role), email: str(c.email), phone: str(c.phone), url: str(c.url) }));
  if (has(s, 'external_refs')) v.refs = refsFromFile(s.external_refs);
  if (has(s, 'fields')) v.fields = (s.fields ?? {}) as FieldValues;
  return v;
}

function assetFromFile(a: AssetFile): PlannedAsset['values'] {
  const v: PlannedAsset['values'] = { id: a.id, name: a.name.trim() };
  if (has(a, 'manufacturer')) v.manufacturer = str(a.manufacturer);
  if (has(a, 'model')) v.model = str(a.model);
  if (has(a, 'status')) v.status = a.status ?? 'operational';
  if (a.location) {
    const l = a.location;
    if (has(l, 'area')) v.areaId = l.area ?? null;
    if (has(l, 'work_center')) v.workCenterId = l.work_center ?? null;
    if (has(l, 'work_unit')) v.workUnitId = l.work_unit ?? null;
    if (has(l, 'building')) v.buildingId = l.building ?? null;
  }
  if (has(a, 'parent')) v.parentId = a.parent ?? null;
  if (a.taxonomy) {
    if (has(a.taxonomy, 'domain')) v.domain = str(a.taxonomy.domain);
    if (has(a.taxonomy, 'process_area')) v.processArea = str(a.taxonomy.process_area);
    if (has(a.taxonomy, 'role')) v.role = str(a.taxonomy.role);
  }
  if (has(a, 'tags')) v.tags = cleanTags((a.tags ?? []).map((t) => t.trim()).filter(Boolean));
  if (a.lifecycle) {
    if (has(a.lifecycle, 'commissioned')) v.commissioned = a.lifecycle.commissioned ?? null;
    if (has(a.lifecycle, 'end_of_support')) v.endOfSupport = a.lifecycle.end_of_support ?? null;
  }
  if (has(a, 'description')) v.description = str(a.description);
  if (has(a, 'capabilities')) v.capabilities = (a.capabilities ?? []).map((c) => c.trim()).filter(Boolean);
  if (has(a, 'image')) v.imageName = str(a.image);
  if (has(a, 'external_refs')) v.refs = refsFromFile(a.external_refs);
  if (has(a, 'fields')) v.fields = (a.fields ?? {}) as FieldValues;
  return v;
}

function plan(parsed: Parsed[], problems: PlantImportProblem[]): Plan {
  const p: Plan = {
    enterprise: null,
    sites: new Map(),
    nodes: new Map(),
    buildings: new Map(),
    assets: new Map(),
    data: emptyDataPlan(),
    net: emptyNetPlan(),
  };
  const twice = (o: Origin, what: string, first: Origin) =>
    problems.push({ ...o, message: `${what} is defined twice (also in ${first.file} at ${first.path})` });
  const addAsset = (a: AssetFile, siteId: string | null, o: Origin) => {
    if (siteId && a.location?.site && a.location.site !== siteId)
      problems.push({ ...o, path: `${o.path}.location.site`, message: `The asset is listed below site "${siteId}" but names site "${a.location.site}"` });
    const first = p.assets.get(a.id);
    if (first) return twice(o, `Asset "${a.id}"`, first);
    p.assets.set(a.id, { ...o, siteId: siteId ?? a.location?.site ?? null, values: assetFromFile(a), children: a.children ?? [] });
  };
  for (const f of parsed) {
    if (!f.file) continue;
    if (f.file.enterprise?.name) p.enterprise = f.file.enterprise.name.trim();
    const sites: [SiteFile, string][] = f.file.site ? [[f.file.site, 'site']] : (f.file.sites ?? []).map((s, i) => [s, `sites[${i}]`]);
    for (const [s, path] of sites) {
      const o = { file: f.name, path };
      const first = p.sites.get(s.id);
      if (first) {
        twice(o, `Site "${s.id}"`, first);
        continue;
      }
      p.sites.set(s.id, { ...o, values: siteFromFile(s) });
      (s.buildings ?? []).forEach((b, i) => {
        const bo = { file: f.name, path: `${path}.buildings[${i}]` };
        const k = key(s.id, b.id);
        const fb = p.buildings.get(k);
        if (fb) return twice(bo, `Building "${b.id}"`, fb);
        const v: PlannedBuilding['values'] = { id: b.id, name: b.name.trim() };
        if (has(b, 'names')) v.names = b.names ?? {};
        if (has(b, 'kind')) v.kind = b.kind ?? 'building';
        if (has(b, 'parent')) v.parentId = b.parent ?? null;
        if (has(b, 'description')) v.description = str(b.description);
        if (has(b, 'fields')) v.fields = (b.fields ?? {}) as FieldValues;
        p.buildings.set(k, { ...bo, siteId: s.id, position: i, values: v });
      });
      type NodeFile = {
        id: string;
        name: string;
        names?: Record<string, string>;
        description?: string | null;
        fields?: unknown;
        building?: string | null;
        type?: string;
        domain?: string | null;
      };
      const node = (n: NodeFile, level: PlantLevel, parentId: string | null, position: number, o: Origin) => {
        const k = key(s.id, n.id);
        const fn = p.nodes.get(k);
        if (fn) {
          twice(o, `Node "${n.id}"`, fn);
          return false;
        }
        const v: PlannedNode['values'] = { id: n.id, level, parentId, name: n.name.trim() };
        if (has(n, 'names')) v.names = n.names ?? {};
        if (has(n, 'type')) v.type = n.type ?? '';
        if (has(n, 'domain')) v.domain = str(n.domain);
        if (has(n, 'building')) v.buildingId = n.building ?? null;
        if (has(n, 'description')) v.description = str(n.description);
        if (has(n, 'fields')) v.fields = (n.fields ?? {}) as FieldValues;
        p.nodes.set(k, { ...o, siteId: s.id, position, values: v });
        return true;
      };
      (s.areas ?? []).forEach((a: AreaFile, i) => {
        const ao = { file: f.name, path: `${path}.areas[${i}]` };
        if (!node(a, 'area', null, i, ao)) return;
        (a.work_centers ?? []).forEach((wc, j) => {
          const wo = { file: f.name, path: `${ao.path}.work_centers[${j}]` };
          if (!node(wc, 'work_center', a.id, j, wo)) return;
          (wc.work_units ?? []).forEach((wu, k) => node(wu, 'work_unit', wc.id, k, { file: f.name, path: `${wo.path}.work_units[${k}]` }));
        });
      });
      (s.assets ?? []).forEach((a, i) => addAsset(a, s.id, { file: f.name, path: `${path}.assets[${i}]` }));
    }
    (f.file.assets ?? []).forEach((a, i) => addAsset(a, null, { file: f.name, path: `assets[${i}]` }));
    planData(p.data, f.file, f.name, problems);
    planNetwork(p.net, f.file, f.name, problems);
  }
  return p;
}

// ---------- comparing with what is stored ----------

const SITE_DEFAULTS = (id: string): SiteValues => ({ id, code: '', name: id, names: {}, description: '', geo: null, contacts: [], refs: [], fields: {} });
const NODE_DEFAULTS = (v: Pick<NodeValues, 'id' | 'level' | 'parentId' | 'name'>): NodeValues => ({
  ...v,
  names: {},
  type: '',
  domain: '',
  buildingId: null,
  description: '',
  fields: {},
});
const BUILDING_DEFAULTS = (id: string): BuildingValues => ({ id, name: id, names: {}, kind: 'building', parentId: null, description: '', fields: {} });
const ASSET_DEFAULTS = (id: string, siteId: string): AssetValues => ({
  id,
  siteId,
  areaId: null,
  workCenterId: null,
  workUnitId: null,
  buildingId: null,
  name: id,
  manufacturer: '',
  model: '',
  status: 'operational',
  parentId: null,
  domain: '',
  processArea: '',
  role: '',
  tags: [],
  commissioned: null,
  endOfSupport: null,
  description: '',
  capabilities: [],
  imageName: '',
  refs: [],
  fields: {},
});

/** A field value as stored (text fields keep numbers as text). */
function storedFields(type: PlantRecordType, v: FieldValues): FieldValues {
  const defs = fieldDefs(type);
  return Object.fromEntries(
    Object.entries(v)
      .filter(([, x]) => x !== null && x !== '')
      .map(([k, x]) => [k, typeof x === 'number' && defs.find((d) => d.key === k)?.kind === 'text' ? String(x) : x]),
  );
}

interface Stored {
  sites: Map<string, SiteRow>;
  indexes: Map<string, SiteIndex>;
  assets: Map<string, AssetRow>;
  rights: Map<string, PlantPermission[]>;
}

function stored(): Stored {
  const sites = db().all<SiteRow>('SELECT * FROM plant_sites');
  return {
    sites: new Map(sites.map((s) => [s.id, s])),
    indexes: loadAllIndexes(),
    assets: new Map(
      db()
        .all<AssetRow>('SELECT * FROM plant_assets')
        .map((a) => [a.id, a]),
    ),
    rights: siteRights(sites),
  };
}

const emptyCounts = (): PlantCounts => ({ add: 0, change: 0, remove: 0, mark: 0, unchanged: 0, skip: 0 });

interface Computed {
  preview: PlantImportPreview;
  writes: Write[];
  plan: Plan;
  /** The parsed files, with the id mapping and the aliases applied */
  files: PlantFile[];
  /** Entries the files remove (`remove:`) */
  removeTargets: (Target & { origin: Origin })[];
}

/** Whether an entry the files remove is also one they define. */
function definedInFiles(p: Plan, t: Target): boolean {
  const k = key(t.scope, t.id);
  switch (t.kind) {
    case 'site':
      return p.sites.has(t.id);
    case 'asset':
      return p.assets.has(t.id);
    case 'node':
      return p.nodes.has(k);
    case 'building':
      return p.buildings.has(k);
    case 'profile':
      return p.data.profiles.has(t.id);
    case 'kpi':
      return p.data.kpis.has(t.id);
    case 'vlan':
      return p.net.vlans.has(k);
    case 'zone':
      return p.net.zones.has(k);
    case 'conduit':
      return p.net.conduits.has(k);
    case 'device':
      return p.net.devices.has(k);
    case 'data_path':
      return p.net.paths.has(k);
  }
}

function compute(input: ImportInput, importId: string): Computed {
  requirePlant();
  const u = me();
  const problems: PlantImportProblem[] = [];
  const warnings: PlantImportProblem[] = [];
  const parsed = readFiles(input.files, problems);
  const files = parsed.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes }));
  const allSha = sha256(parsed.map((f) => `${f.name}\0${f.sha256}`).join('\n'));
  // 0.11.0: the id mapping and old ids (aliases); mapped entries that exist are renamed first (compute runs in the
  // import's transaction – a rolled-back one for the preview)
  const ids = planIds(
    parsed.flatMap((f) => (f.file ? [{ name: f.name, file: f.file }] : [])),
    input.idMap,
  );
  problems.push(...ids.problems);
  const renamed = !problems.length && ids.renames.length ? applyRenames(ids, u.username) : { done: [], problems: [] };
  problems.push(...renamed.problems);
  const p = plan(parsed, problems);
  for (const t of ids.removals) {
    if (t.scope === null || (t.kind !== 'site' && t.kind !== 'asset' && t.kind !== 'profile' && t.kind !== 'kpi' && !t.scope))
      problems.push({ ...t.origin, message: `Name the ${['device', 'data_path'].includes(t.kind) ? 'asset' : 'site'} of ${t.kind} "${t.id}"` });
    else if (definedInFiles(p, t)) problems.push({ ...t.origin, message: `${t.kind} "${t.id}" is in the files and in remove` });
  }
  const s = stored();
  const mode: PlantImportMode = input.mode;
  const missing: PlantMissing = input.missing;
  let replaces: PlantImportPreview['replaces'] = null;
  if (mode === 'replace') {
    // an earlier import the caller may not see (listImports) is one that does not exist
    const found = input.replaces ? db().get<ImportRow>('SELECT * FROM plant_imports WHERE id = ?', input.replaces) : undefined;
    const prev = found && importVisible(found, s.rights) ? found : undefined;
    if (!prev) problems.push({ file: '(import)', path: 'replaces', message: 'Choose the earlier import this file replaces' });
    else
      replaces = {
        id: prev.id,
        createdAt: prev.created_at,
        createdBy: prev.created_by,
        files: parseJson<{ name: string }[]>(prev.files, []).map((f) => f.name),
      };
  }
  const settings = plantSettings();
  if (p.enterprise && settings.enterprise && p.enterprise !== settings.enterprise)
    warnings.push({
      file: '(files)',
      path: 'enterprise.name',
      message: `The file names the enterprise "${p.enterprise}", the settings "${settings.enterprise}" (not changed by an import)`,
    });

  const at = nowIso();
  const meta = { importId, notInSource: false, at, by: u.username };
  const writes: Write[] = [];
  const full = mode === 'replace';
  const prevId = replaces?.id ?? null;
  const fromPrev = (r: { import_id: string | null } | undefined) => !!prevId && r?.import_id === prevId;

  // ---- rights: new sites need the right to add sites; everything in an existing site the manage right
  const canManage = (siteId: string) => {
    if (s.sites.has(siteId)) return !!s.rights.get(siteId)?.includes('manage');
    return canCreateSites(u);
  };
  const refused = new Set<string>();
  // a stored site the caller may not see: nothing of it is named, it reads like a new one (no hint that it exists)
  const hiddenSite = (id: string) => s.sites.has(id) && !s.rights.get(id)?.includes('view');
  const needManage = (siteId: string, o: Origin) => {
    if (canManage(siteId) || refused.has(siteId)) return;
    refused.add(siteId);
    problems.push({
      ...o,
      message: s.sites.has(siteId) && !hiddenSite(siteId) ? `You may not change site "${siteId}"` : `You may not add or change site "${siteId}"`,
    });
  };

  // ---- sites
  const postSites = new Map<string, SiteValues>();
  for (const [id, r] of s.sites) postSites.set(id, siteValuesOf(r, []));
  const siteRefs = refsOf(
    'site',
    [...p.sites.keys()].filter((id) => s.sites.has(id)),
  );
  for (const ps of p.sites.values()) {
    needManage(ps.values.id, ps);
    const cur = s.sites.get(ps.values.id);
    const before = cur ? siteValuesOf(cur, siteRefs.get(cur.id) ?? []) : null;
    const after: SiteValues = { ...(before && !full ? before : SITE_DEFAULTS(ps.values.id)), ...ps.values };
    after.fields = storedFields('site', after.fields);
    for (const fp of fieldProblems('site', after.fields, settings)) problems.push({ ...ps, path: `${ps.path}.fields.${fp.field}`, message: fp.message });
    for (const [i, c] of after.contacts.entries()) {
      if (c.email && !/^[^\s@]+@[^\s@]+$/.test(c.email)) problems.push({ ...ps, path: `${ps.path}.contacts[${i}].email`, message: 'Use an e-mail address' });
      if (c.url && !isHttpUrl(c.url)) problems.push({ ...ps, path: `${ps.path}.contacts[${i}].url`, message: 'Use an http or https address' });
    }
    after.refs.forEach(
      (r, i) => r.url && !isHttpUrl(r.url) && problems.push({ ...ps, path: `${ps.path}.external_refs[${i}].url`, message: 'Use an http or https address' }),
    );
    postSites.set(after.id, after);
    pushWrite(
      writes,
      mode,
      'site',
      after.id,
      after.id,
      after.name,
      before,
      after,
      cur,
      () => {
        upsertSite(after, meta);
        if (!cur) assignCreatorTeams('site', after.id, u);
      },
      () => db().run('UPDATE plant_sites SET import_id = ?, not_in_source = 0 WHERE id = ?', importId, after.id),
    );
  }
  // site codes stay unique
  const codes = new Map<string, string>();
  for (const v of postSites.values()) {
    if (!v.code) continue;
    const other = codes.get(v.code.toLowerCase());
    if (other) {
      const ps = p.sites.get(v.id) ?? p.sites.get(other);
      problems.push({
        file: ps?.file ?? '(files)',
        path: `${ps?.path ?? 'sites'}.code`,
        message:
          hiddenSite(other) || hiddenSite(v.id) ? `Another site has the code ${v.code} already` : `Sites "${other}" and "${v.id}" have the same code ${v.code}`,
      });
    }
    codes.set(v.code.toLowerCase(), v.id);
  }

  // ---- the post state of the hierarchy and buildings, site by site
  const removing = { nodes: new Set<string>(), buildings: new Set<string>(), assets: new Set<string>(), sites: new Set<string>() };
  if (mode === 'replace' && missing === 'remove' && prevId) {
    for (const [sid, idx] of s.indexes) {
      for (const n of idx.nodes.values()) if (fromPrev(n) && !p.nodes.has(key(sid, n.id))) removing.nodes.add(key(sid, n.id));
      for (const b of idx.buildings.values()) if (fromPrev(b) && !p.buildings.has(key(sid, b.id))) removing.buildings.add(key(sid, b.id));
    }
    for (const a of s.assets.values()) if (fromPrev(a) && !p.assets.has(a.id)) removing.assets.add(a.id);
    for (const r of s.sites.values()) if (fromPrev(r) && !p.sites.has(r.id)) removing.sites.add(r.id);
  }
  const post = new Map<string, SiteIndex>();
  const postIndex = (siteId: string): SiteIndex => {
    let x = post.get(siteId);
    if (x) return x;
    const idx = s.indexes.get(siteId);
    x = { siteId, nodes: new Map(), buildings: new Map() };
    for (const n of idx?.nodes.values() ?? []) if (!removing.nodes.has(key(siteId, n.id))) x.nodes.set(n.id, n);
    for (const b of idx?.buildings.values() ?? []) if (!removing.buildings.has(key(siteId, b.id))) x.buildings.set(b.id, b);
    post.set(siteId, x);
    return x;
  };
  const fakeNode = (siteId: string, v: NodeValues, position: number): NodeRow => ({
    site_id: siteId,
    id: v.id,
    level: v.level,
    parent_id: v.parentId,
    name: v.name,
    names: JSON.stringify(v.names),
    type: v.type,
    domain: v.domain,
    building_id: v.buildingId,
    description: v.description,
    position,
    fields: JSON.stringify(v.fields),
    import_id: importId,
    not_in_source: 0,
    created_at: at,
    created_by: u.username,
    updated_at: at,
    updated_by: u.username,
  });
  const knownSite = (siteId: string, o: Origin) => {
    if (postSites.has(siteId) && (s.sites.has(siteId) ? s.rights.get(siteId)?.includes('view') : true)) return true;
    problems.push({ ...o, message: `There is no site "${siteId}"` });
    return false;
  };
  // buildings first (nodes name them)
  const postBuildings = new Map<string, BuildingValues>();
  for (const pb of p.buildings.values()) {
    const cur = s.indexes.get(pb.siteId)?.buildings.get(pb.values.id);
    const before = cur ? buildingValuesOf(cur) : null;
    const after: BuildingValues = { ...(before && !full ? before : BUILDING_DEFAULTS(pb.values.id)), ...pb.values };
    after.fields = storedFields('building', after.fields);
    postBuildings.set(key(pb.siteId, after.id), after);
    postIndex(pb.siteId).buildings.set(after.id, {
      ...(cur ?? ({} as BuildingRow)),
      site_id: pb.siteId,
      id: after.id,
      name: after.name,
      names: JSON.stringify(after.names),
      kind: after.kind,
      parent_id: after.parentId,
      description: after.description,
      position: pb.position,
      fields: JSON.stringify(after.fields),
    } as BuildingRow);
  }
  for (const pb of p.buildings.values()) {
    const after = postBuildings.get(key(pb.siteId, pb.values.id))!;
    const bp = buildingProblem(postIndex(pb.siteId), after);
    if (bp) problems.push({ ...pb, path: `${pb.path}.parent`, message: bp.problem });
    for (const fp of fieldProblems('building', after.fields, settings)) problems.push({ ...pb, path: `${pb.path}.fields.${fp.field}`, message: fp.message });
    const cur = s.indexes.get(pb.siteId)?.buildings.get(pb.values.id);
    const before = cur ? buildingValuesOf(cur) : null;
    const position = pb.position;
    pushWrite(
      writes,
      mode,
      'building',
      pb.siteId,
      after.id,
      after.name,
      before,
      after,
      cur,
      () => upsertBuilding(pb.siteId, after, position, meta),
      () =>
        db().run(
          'UPDATE plant_buildings SET import_id = ?, not_in_source = 0, position = ? WHERE site_id = ? AND id = ?',
          importId,
          position,
          pb.siteId,
          after.id,
        ),
    );
  }
  // the hierarchy is written as the file nests it: level, parent and position always come from the file
  const postNodes = new Map<string, { before: NodeValues | null; after: NodeValues; cur: NodeRow | undefined }>();
  for (const pn of p.nodes.values()) {
    const cur = s.indexes.get(pn.siteId)?.nodes.get(pn.values.id);
    const before = cur ? nodeValuesOf(cur) : null;
    const after: NodeValues = { ...(before && !full ? before : NODE_DEFAULTS(pn.values)), ...pn.values };
    after.fields = storedFields(LEVEL_RECORD_TYPE[after.level], after.fields);
    postNodes.set(key(pn.siteId, after.id), { before, after, cur });
    postIndex(pn.siteId).nodes.set(after.id, fakeNode(pn.siteId, after, pn.position));
  }
  for (const pn of p.nodes.values()) {
    const { before, after, cur } = postNodes.get(key(pn.siteId, pn.values.id))!;
    const v = after;
    const type = LEVEL_RECORD_TYPE[v.level];
    if (cur && cur.level !== v.level)
      problems.push({ ...pn, path: `${pn.path}.id`, message: `"${v.id}" is a ${cur.level.replace('_', ' ')} in Steward, here a ${v.level.replace('_', ' ')}` });
    const np = nodeProblem(postIndex(pn.siteId), after);
    if (np)
      problems.push({
        ...pn,
        path: `${pn.path}${np.code === 'PLANT_BUILDING_UNKNOWN' ? '.building' : np.code === 'PLANT_NODE_TYPE' ? '.type' : ''}`,
        message: np.problem,
      });
    for (const fp of fieldProblems(type, after.fields, settings)) problems.push({ ...pn, path: `${pn.path}.fields.${fp.field}`, message: fp.message });
    const position = pn.position;
    pushWrite(
      writes,
      mode,
      v.level,
      pn.siteId,
      v.id,
      v.name,
      before,
      after,
      cur,
      () => upsertNode(pn.siteId, after, position, meta),
      () => db().run('UPDATE plant_nodes SET import_id = ?, not_in_source = 0, position = ? WHERE site_id = ? AND id = ?', importId, position, pn.siteId, v.id),
    );
  }
  for (const pn of [...p.nodes.values(), ...p.buildings.values()]) {
    needManage(pn.siteId, pn);
    if (!p.sites.has(pn.siteId)) knownSite(pn.siteId, pn);
  }

  // ---- assets
  const assetRefs = refsOf(
    'asset',
    [...p.assets.keys()].filter((id) => s.assets.has(id)),
  );
  const postParent = new Map<string, string | null>();
  for (const a of s.assets.values()) if (!removing.assets.has(a.id)) postParent.set(a.id, a.parent_id);
  const postSite = new Map<string, string>();
  for (const a of s.assets.values()) if (!removing.assets.has(a.id)) postSite.set(a.id, a.site_id);
  const afterAssets = new Map<string, { pa: PlannedAsset; before: AssetValues | null; after: AssetValues; cur: AssetRow | undefined }>();
  for (const pa of p.assets.values()) {
    const cur = s.assets.get(pa.values.id);
    if (cur && hiddenSite(cur.site_id)) {
      // the id is taken in a site the caller may not see: that site is named only where the file names it itself
      if (p.sites.has(cur.site_id) || pa.siteId === cur.site_id) needManage(cur.site_id, pa);
      else problems.push({ ...pa, path: `${pa.path}.id`, message: `You may not add or change asset "${pa.values.id}"` });
      continue;
    }
    if (cur && mode !== 'add') needManage(cur.site_id, pa);
    const siteId = pa.siteId ?? cur?.site_id ?? null;
    if (!siteId) {
      problems.push({ ...pa, path: `${pa.path}.location.site`, message: 'Name the site of the asset (location.site), or list it below its site' });
      continue;
    }
    if (!knownSite(siteId, { ...pa, path: `${pa.path}.location.site` })) continue;
    if (!cur || mode !== 'add') needManage(siteId, pa);
    const before = cur ? assetValuesOf(cur, assetRefs.get(cur.id) ?? []) : null;
    const base = before && !full ? { ...before } : ASSET_DEFAULTS(pa.values.id, siteId);
    // a new site keeps nothing of the old location: the levels are of the new site
    if (before && !full && before.siteId !== siteId)
      Object.assign(base, { areaId: null, workCenterId: null, workUnitId: null, buildingId: null, parentId: null });
    const after: AssetValues = { ...base, ...pa.values, siteId };
    after.fields = storedFields('asset', after.fields);
    const loc = resolveLocation(postIndex(siteId), after);
    if ('problem' in loc) problems.push({ ...pa, path: `${pa.path}.location`, message: loc.problem });
    else Object.assign(after, loc.value);
    if (after.commissioned && !isDate(after.commissioned))
      problems.push({ ...pa, path: `${pa.path}.lifecycle.commissioned`, message: 'Use a date (YYYY-MM-DD)' });
    if (after.endOfSupport && !isDate(after.endOfSupport))
      problems.push({ ...pa, path: `${pa.path}.lifecycle.end_of_support`, message: 'Use a date (YYYY-MM-DD)' });
    after.refs.forEach(
      (r, i) => r.url && !isHttpUrl(r.url) && problems.push({ ...pa, path: `${pa.path}.external_refs[${i}].url`, message: 'Use an http or https address' }),
    );
    for (const fp of fieldProblems('asset', after.fields, settings)) problems.push({ ...pa, path: `${pa.path}.fields.${fp.field}`, message: fp.message });
    postParent.set(after.id, after.parentId);
    postSite.set(after.id, siteId);
    afterAssets.set(after.id, { pa, before, after, cur });
  }
  // children lists: the other way to say parent
  for (const { pa } of afterAssets.values()) {
    for (const [i, c] of pa.children.entries()) {
      const child = afterAssets.get(c);
      const o = { ...pa, path: `${pa.path}.children[${i}]` };
      if (!child && !postParent.has(c)) {
        problems.push({ ...o, message: `There is no asset "${c}"` });
        continue;
      }
      const said = child ? (has(child.pa.values, 'parentId') ? child.after.parentId : null) : postParent.get(c);
      if (said && said !== pa.values.id) {
        problems.push({ ...o, message: `"${c}" names "${said}" as its parent` });
        continue;
      }
      if (child) child.after.parentId = pa.values.id;
      else if (s.assets.has(c)) problems.push({ ...o, message: `"${c}" is not in the file: set its parent there (parent: ${pa.values.id})` });
      postParent.set(c, pa.values.id);
    }
  }
  for (const { pa, before, after, cur } of afterAssets.values()) {
    if (after.parentId) {
      if (after.parentId === after.id) problems.push({ ...pa, path: `${pa.path}.parent`, message: 'An asset cannot be its own parent' });
      else if (!postParent.has(after.parentId)) problems.push({ ...pa, path: `${pa.path}.parent`, message: `There is no asset "${after.parentId}"` });
      else if (postSite.get(after.parentId) !== after.siteId)
        problems.push({ ...pa, path: `${pa.path}.parent`, message: `The parent "${after.parentId}" is in another site` });
      else {
        const cycle = equipmentCycle(after.id, after.parentId, (x) => postParent.get(x));
        if (cycle) problems.push({ ...pa, path: `${pa.path}.parent`, message: `The equipment hierarchy has a cycle: ${cycle.join(' → ')}` });
      }
    }
    pushWrite(
      writes,
      mode,
      'asset',
      after.siteId,
      after.id,
      after.name,
      before,
      after,
      cur,
      () => upsertAsset(after, meta),
      () => db().run('UPDATE plant_assets SET import_id = ?, not_in_source = 0 WHERE id = ?', importId, after.id),
    );
  }

  // ---- what the earlier import wrote and the file no longer has
  if (mode === 'replace' && prevId) {
    const gone = <R extends { import_id: string | null; not_in_source: number }>(
      kind: PlantChangeKind,
      siteId: string,
      r: R,
      id: string,
      name: string,
      remove: () => void,
      mark: () => void,
    ) => {
      if (!fromPrev(r)) return;
      // records of sites the caller may not see are not theirs to hear of: they stay, unnamed
      if (!s.rights.get(siteId)?.includes('view')) return;
      if (!s.rights.get(siteId)?.includes('manage')) {
        warnings.push({
          file: '(files)',
          path: kind,
          message: `${kind.replace('_', ' ')} "${id}" is not in the files, but you may not change site "${siteId}": it stays`,
        });
        return;
      }
      if (missing === 'remove') writes.push({ kind, action: 'remove', siteId, id, name, apply: remove });
      else if (r.not_in_source) writes.push({ kind, action: 'unchanged', siteId, id, name, note: 'not in source', apply: mark });
      else writes.push({ kind, action: 'mark', siteId, id, name, note: 'kept, marked "not in source"', apply: mark });
    };
    for (const a of s.assets.values())
      if (!p.assets.has(a.id))
        gone(
          'asset',
          a.site_id,
          a,
          a.id,
          a.name,
          () => removeAssetRow(a.id),
          () => db().run('UPDATE plant_assets SET not_in_source = 1, import_id = ? WHERE id = ?', importId, a.id),
        );
    for (const [sid, idx] of s.indexes) {
      for (const n of idx.nodes.values())
        if (!p.nodes.has(key(sid, n.id)))
          gone(
            n.level,
            sid,
            n,
            n.id,
            n.name,
            () => db().run('DELETE FROM plant_nodes WHERE site_id = ? AND id = ?', sid, n.id),
            () => db().run('UPDATE plant_nodes SET not_in_source = 1, import_id = ? WHERE site_id = ? AND id = ?', importId, sid, n.id),
          );
      for (const b of idx.buildings.values())
        if (!p.buildings.has(key(sid, b.id)))
          gone(
            'building',
            sid,
            b,
            b.id,
            b.name,
            () => db().run('DELETE FROM plant_buildings WHERE site_id = ? AND id = ?', sid, b.id),
            () => db().run('UPDATE plant_buildings SET not_in_source = 1, import_id = ? WHERE site_id = ? AND id = ?', importId, sid, b.id),
          );
    }
    for (const r of s.sites.values())
      if (!p.sites.has(r.id)) {
        // a site keeps the records people added by hand: then it stays, marked
        const kept = [...s.assets.values()].some((a) => a.site_id === r.id && !removing.assets.has(a.id) && !p.assets.has(a.id) && postSite.get(a.id) === r.id);
        const movedIn = [...afterAssets.values()].some((x) => x.after.siteId === r.id);
        // OT network records added by hand (#220) keep their site, too
        const handNet = ['plant_vlans', 'plant_zones', 'plant_conduits'].some(
          (t) => !!db().get(`SELECT 1 FROM ${t} WHERE site_id = ? AND (import_id IS NULL OR import_id <> ?)`, r.id, prevId),
        );
        const hand = kept || movedIn || handNet || [...postIndex(r.id).nodes.values()].length > 0 || postIndex(r.id).buildings.size > 0;
        if (missing === 'remove' && hand && fromPrev(r)) {
          warnings.push({
            file: '(files)',
            path: 'sites',
            message: `Site "${r.id}" is not in the files but still holds records that stay: it is kept and marked`,
          });
          writes.push({
            kind: 'site',
            action: 'mark',
            siteId: r.id,
            id: r.id,
            name: r.name,
            note: 'kept, marked "not in source" (it still holds records)',
            apply: () => db().run('UPDATE plant_sites SET not_in_source = 1, import_id = ? WHERE id = ?', importId, r.id),
          });
          removing.sites.delete(r.id);
        } else
          gone(
            'site',
            r.id,
            r,
            r.id,
            r.name,
            () => removeSiteRows(r.id),
            () => db().run('UPDATE plant_sites SET not_in_source = 1, import_id = ? WHERE id = ?', importId, r.id),
          );
      }
    // records that stay and name something that goes: they lose that reference
    if (missing === 'remove') {
      for (const a of s.assets.values()) {
        if (removing.assets.has(a.id) || afterAssets.has(a.id)) continue;
        const lost: string[] = [];
        const idx = postIndex(a.site_id);
        if (a.parent_id && removing.assets.has(a.parent_id)) lost.push('parentId');
        for (const [col, k] of [
          ['area_id', 'areaId'],
          ['work_center_id', 'workCenterId'],
          ['work_unit_id', 'workUnitId'],
        ] as const)
          if (a[col] && !idx.nodes.has(a[col]!)) lost.push(k);
        if (a.building_id && !idx.buildings.has(a.building_id)) lost.push('buildingId');
        if (!lost.length) continue;
        writes.push({
          kind: 'asset',
          action: 'change',
          siteId: a.site_id,
          id: a.id,
          name: a.name,
          fields: lost,
          note: 'names a record that is removed',
          apply: () => {
            if (lost.includes('parentId')) db().run('UPDATE plant_assets SET parent_id = NULL WHERE id = ?', a.id);
            if (lost.some((x) => x !== 'parentId' && x !== 'buildingId')) {
              // the location keeps the levels that stay
              const keep = (id: string | null) => (id && idx.nodes.has(id) ? id : null);
              const wu = keep(a.work_unit_id);
              const wc = wu ? a.work_center_id : keep(a.work_center_id);
              const ar = wc ? a.area_id : keep(a.area_id);
              db().run('UPDATE plant_assets SET area_id = ?, work_center_id = ?, work_unit_id = ? WHERE id = ?', ar, wc, wu, a.id);
            }
            if (lost.includes('buildingId')) db().run('UPDATE plant_assets SET building_id = NULL WHERE id = ?', a.id);
          },
        });
      }
      for (const [sid, idx] of s.indexes)
        for (const n of idx.nodes.values()) {
          if (removing.nodes.has(key(sid, n.id)) || p.nodes.has(key(sid, n.id))) continue;
          const parentGone = n.parent_id && removing.nodes.has(key(sid, n.parent_id));
          const buildingGone = n.building_id && removing.buildings.has(key(sid, n.building_id));
          if (parentGone)
            problems.push({
              file: '(files)',
              path: n.level,
              message: `"${n.id}" was added by hand below "${n.parent_id}", which the import removes – add it to the file, or keep and mark the missing records`,
            });
          else if (buildingGone)
            writes.push({
              kind: n.level,
              action: 'change',
              siteId: sid,
              id: n.id,
              name: n.name,
              fields: ['buildingId'],
              note: 'names a building that is removed',
              apply: () => db().run('UPDATE plant_nodes SET building_id = NULL WHERE site_id = ? AND id = ?', sid, n.id),
            });
        }
    }
  }

  // ---- device profiles, KPI definitions and assignments (#219)
  let postData: { assignments: Map<string, PlantAssignmentValues>; profiles: Map<string, PlantResolvedProfile> } | null = null;
  const checks = computeData({
    onPost: (assignments, profiles) => (postData = { assignments, profiles }),
    plan: p.data,
    mode,
    missing,
    prevId,
    importId,
    meta,
    user: u,
    writes,
    problems,
    warnings,
    rights: s.rights,
    sites: s.sites,
    storedAssets: s.assets,
    postSite,
    removedAssets: removing.assets,
    fileSites: new Set(p.sites.keys()),
    needManage,
  });
  // ---- the OT network of sites and assets (#220)
  computeNetwork({
    plan: p.net,
    mode,
    missing,
    prevId,
    importId,
    meta,
    writes,
    problems,
    warnings,
    rights: s.rights,
    sites: s.sites,
    storedAssets: s.assets,
    postSites: new Set([...postSites.keys()].filter((id) => !removing.sites.has(id))),
    removedSites: removing.sites,
    postSite,
    removedAssets: removing.assets,
    fileSites: new Set(p.sites.keys()),
    needManage,
    assetModel: (assetId) => {
      const a = postData?.assignments.get(assetId) ?? null;
      const m = assetPoints(a, a?.profileId ? postData?.profiles.get(a.profileId) : null);
      return { interfaces: new Set(m.interfaces.map((i) => i.id)), points: new Set(m.points.map((x) => x.id)) };
    },
  });

  // what the file would change in sites the caller may not see is not shown (it cannot be imported anyway)
  // 0.12.0: the first changes say what differs, field by field
  let diffs = 0;
  const changes: PlantChange[] = writes
    .filter((w) => !hiddenSite(w.siteId))
    .map(({ apply: _a, diff, drops, ...c }) => {
      const dropped = drops?.() ?? [];
      return { ...c, ...(diff && diffs++ < PLANT_DIFF_LIMITS.entries ? { diff: diff() } : {}), ...(dropped.length ? { drops: dropped } : {}) };
    });
  const counts = emptyCounts();
  const byKind: PlantImportPreview['byKind'] = {};
  for (const c of changes) {
    counts[c.action]++;
    (byKind[c.kind] ??= emptyCounts())[c.action]++;
  }
  const empty = !p.sites.size && !p.nodes.size && !p.buildings.size && !p.assets.size && dataPlanEmpty(p.data) && netPlanEmpty(p.net);
  if (empty && mode !== 'replace' && !problems.length && !ids.removals.length)
    problems.push({
      file: '(files)',
      path: '(document)',
      message: 'The files hold no records (sites, hierarchy, buildings, assets, device profiles, KPI definitions, assignments or OT networks)',
    });
  const preview: PlantImportPreview = {
    ok: problems.length === 0,
    mode,
    missing,
    replaces,
    files,
    sha256: allSha,
    problems: problems.slice(0, 200),
    warnings: warnings.slice(0, 200),
    changes,
    counts,
    byKind,
    checks,
    renames: renamed.done,
    aliasUses: ids.aliasUses,
    removals: null,
    stepUp: false,
  };
  return { preview, writes, plan: p, files: parsed.flatMap((f) => (f.file ? [f.file] : [])), removeTargets: ids.removals };
}

/** Applies the writes of an import: removals last – what stays may still name them while it is written. */
function applyWrites(writes: Write[]): void {
  for (const w of writes) if (w.action !== 'remove') w.apply();
  const order: PlantChangeKind[] = [
    'data_path',
    'device',
    'asset_checks',
    'conduit',
    'zone',
    'vlan',
    'assignment',
    'asset',
    'work_unit',
    'work_center',
    'area',
    'building',
    'site',
    'kpi',
    'profile',
  ];
  for (const kind of order) for (const w of writes) if (w.action === 'remove' && w.kind === kind) w.apply();
}

interface Ran extends Computed {
  removal: ReturnType<typeof planRemoval> | null;
}

/**
 * An import in a transaction: renames, the writes of the files and the entries they remove – what a refused removal
 * says is a problem of the preview. The preview runs it in a transaction that is rolled back.
 */
function run(input: ImportInput, importId: string): Ran {
  const c = compute(input, importId);
  let removal: Ran['removal'] = null;
  if (c.preview.ok) {
    applyWrites(c.writes);
    const targets: Target[] = [...c.removeTargets, ...(input.removeMissing ? missingEntries(c.files) : [])];
    if (targets.length) {
      removal = planRemoval(targets, { cascade: input.cascade });
      c.preview.removals = removal.plan;
      const origin = new Map(c.removeTargets.map((t) => [`${t.kind}|${t.scope}|${t.id}`, t.origin]));
      // an entry that is not there (any more) is left out: a file with a remove list imports again unchanged
      for (const i of removal.plan.items)
        if (i.refused && i.refused.code !== 'PLANT_ENTRY_NOT_FOUND')
          c.preview.problems.push({
            ...(origin.get(`${i.kind}|${i.scope}|${i.id}`) ?? { file: '(import)', path: 'removeMissing' }),
            message: i.refused.message,
          });
      if (c.preview.problems.length) c.preview.ok = false;
    }
  }
  c.preview.stepUp = stepUpOf(c.preview) !== null;
  return { ...c, removal };
}

/** The control point an import's step-up belongs to: more than one entry renamed or removed – bulk; one rename – single. */
function stepUpOf(p: PlantImportPreview): 'plant.bulkChange' | 'plant.renameId' | null {
  // the entries chosen for removal (what goes with one of them does not make it a bulk removal)
  const removed = p.counts.remove + (p.removals?.items.filter((i) => !i.refused).length ?? 0);
  if (p.renames.length > 1 || removed > 1) return 'plant.bulkChange';
  if (p.renames.length === 1) return 'plant.renameId';
  return null;
}

/** The step-up points of POST /api/plant/import (route config): what the preview of the body would rename and remove. */
export function importStepUpPoints(body: unknown): string[] {
  const input = importInput.safeParse(body);
  if (!input.success) return [];
  requirePlant();
  if (!plantManagesSome(me())) return [];
  const p = dryRun(() => run(input.data, 'preview').preview);
  const point = p.ok ? stepUpOf(p) : null;
  return point ? [point] : [];
}

// ---------- the API ----------

export function previewImport(input: ImportInput): PlantImportPreview {
  requirePlant();
  // the same right as the import itself: a preview shows what an import would change
  if (!plantManagesSome(me())) throw new HttpError(403, 'You are not allowed to import into the plant registry', 'FORBIDDEN', { context: 'managePlant' });
  return dryRun(() => run(input, 'preview').preview);
}

export function applyImport(input: ImportInput): PlantImportResult {
  requirePlant();
  const u = me();
  if (!plantManagesSome(u)) throw new HttpError(403, 'You are not allowed to import into the plant registry', 'FORBIDDEN', { context: 'managePlant' });
  const id = newId('pim_');
  return db().tx(() => {
    const { preview, writes, removal } = run(input, id);
    if (!preview.ok)
      throw new HttpError(400, `The files have ${preview.problems.length} problems – see the preview`, 'PLANT_IMPORT_INVALID', {
        count: preview.problems.length,
      });
    removal?.apply();
    // profiles and KPI definitions belong to no site
    const sites = [...new Set(writes.map((w) => w.siteId).filter(Boolean))].sort();
    db().run(
      'INSERT INTO plant_imports (id, created_at, created_by, mode, missing, replaces, files, sha256, counts, sites) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      nowIso(),
      u.username,
      preview.mode,
      preview.missing,
      preview.replaces?.id ?? null,
      JSON.stringify(preview.files),
      preview.sha256,
      JSON.stringify({ ...preview.counts, byKind: preview.byKind }),
      JSON.stringify(sites),
    );
    const c = preview.counts;
    const ids = (action: PlantChangeAction) =>
      writes
        .filter((w) => w.action === action)
        .slice(0, 200)
        .map(
          (w) =>
            `${w.kind}:${w.siteId === w.id || !w.siteId || ['assignment', 'device', 'data_path', 'asset_checks'].includes(w.kind) ? w.id : `${w.siteId}/${w.id}`}`,
        );
    audit({
      action: 'plant.imported',
      entityType: 'plant_import',
      entityId: id,
      summary: `Plant registry import (${preview.mode}${preview.mode === 'replace' ? `, missing records ${preview.missing === 'remove' ? 'removed' : 'marked'}` : ''}): ${c.add} added, ${c.change} changed, ${c.remove} removed, ${c.mark} marked, ${c.unchanged} unchanged, ${c.skip} skipped – ${preview.files.length} file(s), SHA-256 ${preview.sha256.slice(0, 16)}…`,
      details: {
        mode: preview.mode,
        missing: preview.missing,
        replaces: preview.replaces?.id ?? null,
        files: preview.files,
        sha256: preview.sha256,
        counts: preview.counts,
        byKind: preview.byKind,
        sites,
        added: ids('add'),
        changed: ids('change'),
        removed: ids('remove'),
        marked: ids('mark'),
        // 0.11.0: renames by the id mapping (also audited as plant.ids_changed) and removed entries
        renamed: preview.renames.slice(0, 200).map((r) => `${r.kind}:${r.scope ? `${r.scope}/` : ''}${r.id}→${r.newId}`),
        removedEntries: (removal?.entries ?? []).slice(0, 200).map((e) => `${e.kind}:${e.scope ? `${e.scope}/` : ''}${e.id}`),
        cascade: input.cascade,
      },
    });
    auditBulkRenames(
      preview.renames.map((r) => ({ kind: r.kind, scope: r.scope, from: r.id, to: r.newId, references: r.references })),
      `import ${id}`,
    );
    return { ...preview, import: importSummary(id)! };
  });
}

interface ImportRow {
  id: string;
  created_at: string;
  created_by: string;
  mode: PlantImportMode;
  missing: PlantMissing;
  replaces: string | null;
  files: string;
  sha256: string;
  counts: string;
  sites: string;
}

function toSummary(r: ImportRow, records: number): PlantImportSummary {
  const counts = parseJson<PlantCounts & { byKind?: unknown }>(r.counts, emptyCounts());
  const { byKind: _b, ...c } = counts;
  return {
    id: r.id,
    createdAt: r.created_at,
    createdBy: r.created_by,
    mode: r.mode,
    missing: r.missing,
    replaces: r.replaces,
    files: parseJson(r.files, []),
    sha256: r.sha256,
    counts: { ...emptyCounts(), ...c },
    sites: parseJson(r.sites, []),
    records,
  };
}

function recordCounts(): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of [
    'plant_sites',
    'plant_nodes',
    'plant_buildings',
    'plant_assets',
    'plant_profiles',
    'plant_kpis',
    'plant_assignments',
    'plant_vlans',
    'plant_zones',
    'plant_conduits',
    'plant_devices',
    'plant_data_paths',
    'plant_asset_checks',
  ])
    for (const r of db().all<{ import_id: string; n: number }>(`SELECT import_id, COUNT(*) AS n FROM ${t} WHERE import_id IS NOT NULL GROUP BY import_id`))
      out.set(r.import_id, (out.get(r.import_id) ?? 0) + Number(r.n));
  return out;
}

export function importSummary(id: string): PlantImportSummary | null {
  const r = db().get<ImportRow>('SELECT * FROM plant_imports WHERE id = ?', id);
  return r ? toSummary(r, recordCounts().get(id) ?? 0) : null;
}

/** Earlier imports, newest first (the ones whose sites the caller may see, or that wrote nothing that is left). */
export function listImports(): PlantImportSummary[] {
  requirePlant();
  const rights = siteRights(db().all<SiteRow>('SELECT id, acl FROM plant_sites'));
  const counts = recordCounts();
  return db()
    .all<ImportRow>('SELECT * FROM plant_imports ORDER BY created_at DESC LIMIT 200')
    .filter((r) => importVisible(r, rights))
    .map((r) => toSummary(r, counts.get(r.id) ?? 0));
}

/** Whether the caller sees an import: every site it wrote that still exists is one they may see. */
function importVisible(r: Pick<ImportRow, 'sites'>, rights: Map<string, PlantPermission[]>): boolean {
  return parseJson<string[]>(r.sites, []).every((s) => !rights.has(s) || rights.get(s)!.includes('view'));
}

// ---------- export ----------

const clean = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) =>
        v !== null &&
        v !== undefined &&
        v !== '' &&
        !(Array.isArray(v) && !v.length) &&
        !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length),
    ),
  ) as Partial<T>;

const refsToFile = (refs: ExternalRef[]) => refs.map((r) => clean({ system: r.system, id: r.id, url: r.url, label: r.label }));

export interface ExportQuery {
  /** One site (`site:`) with the assignments of its assets */
  site?: string;
  /** One device profile (`device_profile:`) */
  profile?: string;
  /** One KPI definition (`kpi_definition:`) */
  kpi?: string;
  /** `catalogue`: the device profiles and KPI definitions only */
  part?: 'all' | 'catalogue';
}

export interface ExportOptions {
  /** yaml (default; with a comment naming the JSON Schema) or json (the same document) */
  format?: 'yaml' | 'json';
  /** Exported through the public API with this token (recorded in the audit entry) */
  tokenId?: string;
}

export const EXPORT_TYPES = { yaml: 'application/yaml; charset=utf-8', json: 'application/json; charset=utf-8' } as const;

/**
 * The registry as a document of format 1 (YAML, or the same as JSON): every site the caller may see with the catalogues
 * and the assignments of their assets, one site (`site:` and its assignments), the catalogues only, one device profile
 * or one KPI definition. The importer reads both.
 */
/** A profile's own part as written in a file (a derived profile only with what it adds and changes, 0.11.0). */
/** A profile's own part as the file holds it; 0.21.0: a base the reader may not see by its placeholder (#293, part 4). */
function ownProfileOut(
  id: string,
  resolved: Map<string, PlantResolvedProfile>,
  own: Map<string, PlantProfileValues>,
  scope: CatalogueScope = catalogueScope(null),
): Record<string, unknown> {
  const p = own.get(id)!;
  const refs = new HiddenRefs(scope.profile, resolved.get(id)?.chain.slice(1) ?? []);
  return profileOut({ ...p, extends: refs.ref(p.extends) }, p.extends ? (resolved.get(p.extends) ?? null) : null);
}

/** A KPI definition as the file holds it, profiles the reader may not see by their placeholders. */
const shownKpiOut = (k: PlantKpiValues, scope: CatalogueScope) => kpiOut({ ...k, inputs: presentInputs(k, kpiRefs(k, scope)) });

export function exportYaml(
  q: ExportQuery = {},
  opts: ExportOptions = {},
): { filename: string; content: string; contentType: string; sites: number; assets: number } {
  requirePlant();
  const u = me();
  const format = opts.format ?? 'yaml';
  const header = `# yaml-language-server: $schema=${SCHEMA_ID}\n# Steward plant registry, format ${PLANT_FORMAT_VERSION} (docs/PLANT.md) – exported ${nowIso()} by ${u.username}\n`;
  const render = (doc: Record<string, unknown>) => (format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : header + YAML.stringify(doc, { lineWidth: 0 }));
  const file = (name: string) => (format === 'json' ? name.replace(/\.yaml$/, '.json') : name);
  // through the public API: the token is named in the audit entry
  const via = opts.tokenId ? { via: 'api', tokenId: opts.tokenId } : {};
  // a resolved profile's interfaces are the effective ones; the file holds the own part
  const own = ownProfiles();
  const viaText = opts.tokenId ? ' via the API' : '';
  // 0.21.0 (#293): the catalogue the reader may see – entries of other teams are left out, a hidden base or input profile
  // of a visible entry and an asset's hidden profile or KPI definition are written as placeholders (they import back)
  const scope = catalogueScope();
  // one catalogue record, or the catalogues
  if (q.profile || q.kpi || q.part === 'catalogue') {
    const all = allProfiles();
    const profiles = new Map([...all].filter(([id]) => scope.profile(id)));
    const kpis = new Map([...allKpis()].filter(([id]) => scope.kpi(id)));
    let doc: Record<string, unknown>;
    let filename: string;
    if (q.profile) {
      const pr = profiles.get(q.profile);
      if (!pr) throw new HttpError(404, `Device profile ${q.profile} not found`, 'PLANT_PROFILE_NOT_FOUND', { id: q.profile });
      doc = { version: PLANT_FORMAT_VERSION, device_profile: ownProfileOut(pr.id, all, own, scope) };
      filename = `${pr.id}.profile.plant.yaml`;
    } else if (q.kpi) {
      const k = kpis.get(q.kpi);
      if (!k) throw new HttpError(404, `KPI definition ${q.kpi} not found`, 'PLANT_KPI_NOT_FOUND', { id: q.kpi });
      doc = { version: PLANT_FORMAT_VERSION, kpi_definition: shownKpiOut(k, scope) };
      filename = `${k.id}.kpi.plant.yaml`;
    } else {
      doc = {
        version: PLANT_FORMAT_VERSION,
        ...(profiles.size ? { device_profiles: [...profiles.keys()].map((id) => ownProfileOut(id, all, own, scope)) } : {}),
        ...(kpis.size ? { kpi_definitions: [...kpis.values()].map((k) => shownKpiOut(k, scope)) } : {}),
      };
      filename = 'plant-catalogue.plant.yaml';
    }
    const content = render(doc);
    audit({
      action: 'plant.exported',
      entityType: q.profile ? 'device_profile' : q.kpi ? 'kpi_definition' : 'plant_import',
      entityId: q.profile ?? q.kpi ?? null,
      summary: q.profile
        ? `Device profile ${q.profile} exported${viaText}`
        : q.kpi
          ? `KPI definition ${q.kpi} exported${viaText}`
          : `Plant registry catalogues exported${viaText} (${profiles.size} device profiles, ${kpis.size} KPI definitions)`,
      details: { profiles: q.profile ? 1 : q.kpi ? 0 : profiles.size, kpis: q.kpi ? 1 : q.profile ? 0 : kpis.size, format, ...via, sha256: sha256(content) },
    });
    return { filename: file(filename), content, contentType: EXPORT_TYPES[format], sites: 0, assets: 0 };
  }
  const siteId = q.site;
  const sites = db().all<SiteRow>('SELECT * FROM plant_sites ORDER BY name, id');
  const rights = siteRights(sites);
  const chosen = sites.filter((s) => rights.get(s.id)!.includes('view') && (!siteId || s.id === siteId));
  if (siteId && !chosen.length) throw new HttpError(404, `Site ${siteId} not found`, 'PLANT_SITE_NOT_FOUND', { id: siteId });
  const indexes = loadAllIndexes();
  const ids = new Set(chosen.map((s) => s.id));
  const assets = db()
    .all<AssetRow>('SELECT * FROM plant_assets ORDER BY name, id')
    .filter((a) => ids.has(a.site_id));
  const siteRefs = refsOf(
    'site',
    chosen.map((s) => s.id),
  );
  const assetRefs = refsOf(
    'asset',
    assets.map((a) => a.id),
  );
  let assetCount = 0;
  const out = chosen.map((s) => {
    const v = siteValuesOf(s, siteRefs.get(s.id) ?? []);
    const idx = indexes.get(s.id) ?? { siteId: s.id, nodes: new Map(), buildings: new Map() };
    const nodes = [...idx.nodes.values()];
    const nodeOut = (n: NodeRow) => {
      const x = nodeValuesOf(n);
      return clean({
        id: x.id,
        name: x.name,
        names: x.names,
        type: x.type,
        domain: x.level === 'area' ? x.domain : '',
        building: x.buildingId,
        description: x.description,
        fields: x.fields,
      });
    };
    const siteAssets = assets.filter((a) => a.site_id === s.id);
    assetCount += siteAssets.length;
    return clean({
      id: v.id,
      code: v.code,
      name: v.name,
      names: v.names,
      description: v.description,
      geo: v.geo ? clean({ lat: v.geo.lat, lon: v.geo.lon, zoom: v.geo.zoom }) : null,
      contacts: v.contacts.map((c) => clean({ ...c })),
      external_refs: refsToFile(v.refs),
      fields: v.fields,
      buildings: [...idx.buildings.values()].map((b) => {
        const x = buildingValuesOf(b);
        return clean({
          id: x.id,
          name: x.name,
          names: x.names,
          kind: x.kind === 'building' ? '' : x.kind,
          parent: x.parentId,
          description: x.description,
          fields: x.fields,
        });
      }),
      areas: nodes
        .filter((n) => n.level === 'area')
        .map((a) => ({
          ...nodeOut(a),
          ...clean({
            work_centers: nodes
              .filter((n) => n.level === 'work_center' && n.parent_id === a.id)
              .map((wc) => ({ ...nodeOut(wc), ...clean({ work_units: nodes.filter((n) => n.level === 'work_unit' && n.parent_id === wc.id).map(nodeOut) }) })),
          }),
        })),
      assets: siteAssets.map((a) => {
        const x = assetValuesOf(a, assetRefs.get(a.id) ?? []);
        return clean({
          id: x.id,
          name: x.name,
          manufacturer: x.manufacturer,
          model: x.model,
          status: x.status,
          location: clean({ area: x.areaId, work_center: x.workCenterId, work_unit: x.workUnitId, building: x.buildingId }),
          parent: x.parentId,
          taxonomy: clean({ domain: x.domain, process_area: x.processArea, role: x.role }),
          tags: x.tags,
          lifecycle: clean({ commissioned: x.commissioned, end_of_support: x.endOfSupport }),
          description: x.description,
          capabilities: x.capabilities,
          image: x.imageName,
          external_refs: refsToFile(x.refs),
          fields: x.fields,
        });
      }),
    });
  });
  const enterprise = plantSettings().enterprise;
  // part 2 (#219): the whole registry carries the catalogues; a site and the whole registry the assignments of their assets
  const assignments = allAssignments();
  const resolvedProfiles = allProfiles();
  const assigned = assets
    .filter((a) => assignments.has(a.id))
    .map((a) => {
      const x = assignments.get(a.id)!;
      const chain = x.profileId ? (resolvedProfiles.get(x.profileId)?.chain ?? []) : [];
      return assignmentOut(a.id, presentAssignment(x, assignmentRefs(x, chain, scope)));
    });
  const profiles = siteId ? [] : [...resolvedProfiles.keys()].filter((id) => scope.profile(id));
  const kpis = siteId ? [] : [...allKpis().values()].filter((k) => scope.kpi(k.id));
  // part 3 (#220): the OT network of the sites and of their assets
  const networks = chosen.map((x) => otNetworkOut(x.id)).filter((x): x is Record<string, unknown> => !!x);
  const assetNetworks = assetNetworksOut(assets.map((a) => a.id));
  const doc = {
    version: PLANT_FORMAT_VERSION,
    ...(enterprise ? { enterprise: { name: enterprise } } : {}),
    ...(siteId ? { site: out[0] } : { sites: out }),
    ...(profiles.length ? { device_profiles: profiles.map((id) => ownProfileOut(id, resolvedProfiles, own, scope)) } : {}),
    ...(kpis.length ? { kpi_definitions: kpis.map((k) => shownKpiOut(k, scope)) } : {}),
    ...(assigned.length ? { assignments: assigned } : {}),
    ...(networks.length ? (siteId ? { ot_network: networks[0] } : { ot_networks: networks }) : {}),
    ...(assetNetworks.length ? { asset_networks: assetNetworks } : {}),
  };
  const content = render(doc);
  audit({
    action: 'plant.exported',
    entityType: siteId ? 'site' : 'plant_import',
    entityId: siteId ?? null,
    summary: `Plant registry exported${viaText} (${out.length} sites, ${assetCount} assets${siteId ? '' : `, ${profiles.length} device profiles, ${kpis.length} KPI definitions`})`,
    details: {
      sites: out.length,
      assets: assetCount,
      profiles: profiles.length,
      kpis: kpis.length,
      assignments: assigned.length,
      otNetworks: networks.length,
      assetNetworks: assetNetworks.length,
      format,
      ...via,
      sha256: sha256(content),
    },
  });
  return { filename: file(`${siteId ?? 'plant-registry'}.plant.yaml`), content, contentType: EXPORT_TYPES[format], sites: out.length, assets: assetCount };
}

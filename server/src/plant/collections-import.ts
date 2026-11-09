import { z } from 'zod';
import {
  COLLECTION_FORMATS,
  COLLECTION_PREVIEW_FORMATS,
  COLLECTOR_KINDS,
  dataTypeOf,
  PLANT_COLLECTION_LIMITS as L,
  PLANT_ID_RE,
  type CollectionFormat,
  type PlantAssignmentValues,
  type PlantCollectionImportProblem,
  type PlantCollectionImportResult,
  type PlantCollectionPreview,
  type PlantCollectionPreviewEntry,
  type PlantCollectionPreviewItem,
  type PlantCollectionValues,
  type PlantCollector,
  type PlantItemDecision,
  type PlantItemSuggestion,
  type PlantProfileValues,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso, sha256 } from '../util.js';
import { parseYaml } from '../yaml-safe.js';
import { canManageCatalogue, requireManage } from './access.js';
import { changedKeys } from './model.js';
import { visibleAsset } from './service.js';
import { checkedProfile } from './catalogue.js';
import {
  assignmentProblems,
  assignmentRowOf,
  assignmentValuesOf,
  kpiRowOf,
  ownProfiles,
  resolvedProfile,
  upsertAssignment,
  upsertProfile,
} from './data-model.js';
import { assetContext, checkCollection, type AssetContext } from './collections.js';
import { resolveChain } from './resolve.js';
import {
  collectionRows,
  collectionValuesOf,
  collectorKey,
  mappingsOf,
  nameKey,
  rememberMapping,
  sameAddress,
  similarity,
  upsertCollection,
} from './collections-model.js';
import { detectFormat, parseCsvRows, parseGateway, parseIeOpcUa, parseNodeRed, parseTable, type ParsedCollection } from './collections-formats.js';

/**
 * The import of data collections (0.11.0, docs/adr/0019-data-collections.md): a collector's configuration files are
 * read into collections for one asset and collector, every item gets a suggested data point – a mapping file, a
 * remembered mapping, the asset's address, a name or known-as name, a fuzzy name (never applied unconfirmed) – and
 * the person confirms or changes them in the preview. The apply writes what the preview showed and the person's
 * decisions, in one transaction: the collections, the remembered pairs, the asset's addresses (assignment overrides),
 * known-as names and new data points. Importing needs the manage right on the asset's site; a known-as name or a data
 * point on the profile needs the catalogue right.
 */

const file = z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(L.fileBytes) }).strict();

export const collectionImportInput = z
  .object({
    collector: z
      .object({ kind: z.enum(COLLECTOR_KINDS), ref: z.string().trim().min(1).max(200), host: z.string().trim().min(1).max(100).nullable().default(null) })
      .strict(),
    format: z.union([z.enum(COLLECTION_FORMATS), z.literal('auto')]).default('auto'),
    files: z.array(file).min(1).max(L.files),
    mappingFile: file.nullable().default(null),
    interfaceId: z.string().trim().min(1).max(120).nullable().default(null),
    dataPathId: z.string().trim().min(1).max(100).nullable().default(null),
    /** Remove this collector's collections of the asset that the files no longer have */
    replace: z.boolean().default(false),
    decisions: z
      .array(
        z
          .object({
            collection: z.string().max(100),
            index: z.number().int().min(0).max(L.items),
            dataPoint: z.string().trim().min(1).max(120).nullable(),
            recordAddress: z.boolean().optional(),
            alias: z.enum(['none', 'profile', 'collector']).optional(),
            add: z
              .object({
                target: z.enum(['asset', 'profile']),
                id: z.string().trim().min(1).max(120),
                name: z.string().trim().min(1).max(200),
                interface: z.string().trim().min(1).max(120),
                group: z.string().trim().max(200).default(''),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .max(L.items)
      .default([]),
  })
  .strict();
export type CollectionImportInput = z.infer<typeof collectionImportInput>;

// ---------- reading the files ----------

function readFiles(input: CollectionImportInput, problems: PlantCollectionImportProblem[]): { format: CollectionFormat; collections: ParsedCollection[] } {
  const total = input.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (total > L.fileBytes)
    throw new HttpError(413, `The files are too large (at most ${L.fileBytes / 1024 / 1024} MB)`, 'PLANT_IMPORT_TOO_LARGE', { mb: L.fileBytes / 1024 / 1024 });
  let format: CollectionFormat | null = input.format === 'auto' ? null : input.format;
  const collections: ParsedCollection[] = [];
  for (const f of input.files) {
    const csv = /\.(csv|txt)$/i.test(f.name);
    let doc: unknown;
    if (!csv)
      try {
        doc = parseYaml(f.content, { maxBytes: L.fileBytes, maxKeys: 500_000, maxAliasCount: 100 });
      } catch (e) {
        if (e instanceof HttpError) throw e;
        problems.push({ file: f.name, path: '(file)', message: (e as Error).message.split('\n')[0]! });
        continue;
      }
    const found = detectFormat(f.name, f.content, doc);
    const use = format ?? found;
    if (!use) {
      problems.push({ file: f.name, path: '(file)', message: 'Not a format Steward reads (see docs/PLANT.md, "Data collections")' });
      continue;
    }
    if (format && found && found !== format && input.format === 'auto')
      problems.push({ file: f.name, path: '(file)', message: 'All files of one import must have the same format' });
    format = use;
    if (use === 'gateway_json') {
      if (!doc || typeof doc !== 'object' || !Array.isArray((doc as { datasets?: unknown }).datasets)) {
        problems.push({ file: f.name, path: 'datasets', message: 'Expected datasets of data points' });
        continue;
      }
      collections.push(...parseGateway(doc as Record<string, unknown>, f.name, problems));
    } else if (use === 'table') {
      const rows = csv ? parseCsvRows(f.content) : Array.isArray(doc) ? doc : ((doc as { items?: unknown[] } | undefined)?.items ?? []);
      collections.push(
        ...parseTable(
          rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object'),
          f.name,
          problems,
        ),
      );
    } else if (use === 'ie_opcua') {
      if (!doc || typeof doc !== 'object' || !('UIConfig' in doc)) {
        problems.push({ file: f.name, path: 'UIConfig', message: 'Expected the connector’s exported configuration (UIConfig.datapoints.OPCUA)' });
        continue;
      }
      collections.push(...parseIeOpcUa(doc as Record<string, unknown>, f.name, problems));
    } else {
      if (!Array.isArray(doc)) {
        problems.push({ file: f.name, path: '(file)', message: 'Expected a Node-RED flow export (a list of nodes)' });
        continue;
      }
      collections.push(...parseNodeRed(doc as Record<string, unknown>[], f.name, problems));
    }
  }
  const items = collections.reduce((n, c) => n + c.items.length, 0);
  if (items > L.items) problems.push({ file: '(files)', path: '(files)', message: `At most ${L.items} items in one import` });
  return { format: format ?? 'table', collections };
}

/** gateway_name or address → data point, from a CSV (gateway_name,address,data_point) or YAML ({ mapping: [...] }) file. */
function readMapping(f: { name: string; content: string } | null, problems: PlantCollectionImportProblem[]) {
  if (!f) return [] as { gatewayName: string; address: string; dataPoint: string }[];
  let rows: Record<string, unknown>[] = [];
  if (/\.(csv|txt)$/i.test(f.name)) rows = parseCsvRows(f.content);
  else
    try {
      const doc = parseYaml(f.content, { maxBytes: L.fileBytes, maxKeys: 200_000, maxAliasCount: 10 });
      const list = Array.isArray(doc) ? doc : ((doc as { mapping?: unknown[] } | null)?.mapping ?? []);
      rows = list.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      problems.push({ file: f.name, path: '(file)', message: (e as Error).message.split('\n')[0]! });
    }
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());
  return rows
    .map((r) => ({ gatewayName: s(r.gateway_name), address: s(r.address), dataPoint: s(r.data_point) }))
    .filter((r) => r.dataPoint && (r.gatewayName || r.address));
}

// ---------- suggestions ----------

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 80) || 'collection';

interface Plan {
  ctx: AssetContext;
  collector: PlantCollector;
  entries: { id: string; values: PlantCollectionValues; before: PlantCollectionValues | null; position: number | null; items: PlantCollectionPreviewItem[] }[];
  removed: { id: string; name: string }[];
  format: CollectionFormat;
}

function suggest(
  it: { address: string; outputName: string; dataPoint: string | null },
  ctx: AssetContext,
  protocol: (iface: string) => ReturnType<AssetContext['protocolOf']>,
  mapping: { gatewayName: string; address: string; dataPoint: string }[],
  remembered: Map<string, string>,
  collectorAliases: Map<string, string>,
  before: Map<string, string>,
): { suggestion: PlantItemSuggestion; alternatives: { dataPoint: string; confidence: number }[] } {
  const has = (id: string) => ctx.points.some((p) => p.id === id);
  const hit = (dataPoint: string, reason: PlantItemSuggestion['reason'], confidence: number, accepted = true) => ({
    suggestion: { dataPoint, reason, confidence, accepted },
    alternatives: [],
  });
  // the file names its data point itself (the generic table)
  if (it.dataPoint && has(it.dataPoint)) return hit(it.dataPoint, 'mapping_file', 1);
  const m = mapping.find((x) => (x.gatewayName && x.gatewayName === it.outputName) || (x.address && it.address && sameAddress(x.address, it.address, null)));
  if (m && has(m.dataPoint)) return hit(m.dataPoint, 'mapping_file', 1);
  const r = (it.outputName && remembered.get(it.outputName)) || before.get(`${it.outputName}\u0000${it.address}`);
  if (r && has(r)) return hit(r, 'remembered', 1);
  if (it.address) {
    const byAddress = ctx.points.filter((p) => p.address && sameAddress(p.address, it.address, protocol(p.interface)));
    if (byAddress.length)
      return {
        ...hit(byAddress[0]!.id, 'address', byAddress.length === 1 ? 0.95 : 0.8),
        alternatives: byAddress.slice(1).map((p) => ({ dataPoint: p.id, confidence: 0.8 })),
      };
  }
  const key = nameKey(it.outputName);
  if (key) {
    const byName = ctx.points.find((p) => nameKey(p.id) === key || nameKey(p.name) === key);
    if (byName) return hit(byName.id, 'name', 0.9);
    const byAlias = ctx.points.find((p) => p.aliases.some((a) => nameKey(a) === key));
    if (byAlias) return hit(byAlias.id, 'alias', 0.9);
    const ca = [...collectorAliases].find(([n]) => nameKey(n) === key)?.[1];
    if (ca && has(ca)) return hit(ca, 'collector_alias', 0.85);
    const scored = ctx.points
      .map((p) => ({ dataPoint: p.id, confidence: Math.max(...[p.id, p.name, ...p.aliases].map((n) => similarity(n, it.outputName))) }))
      .filter((x) => x.confidence >= 0.5)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map((x) => ({ ...x, confidence: Math.round(x.confidence * 0.8 * 100) / 100 }));
    if (scored.length)
      return {
        suggestion: { dataPoint: scored[0]!.dataPoint, reason: 'fuzzy', confidence: scored[0]!.confidence, accepted: false },
        alternatives: scored.slice(1),
      };
  }
  return { suggestion: { dataPoint: null, reason: 'none', confidence: 0, accepted: false }, alternatives: [] };
}

function plan(assetId: string, input: CollectionImportInput, problems: PlantCollectionImportProblem[], warnings: PlantCollectionImportProblem[]): Plan {
  const { format, collections } = readFiles(input, problems);
  const mapping = readMapping(input.mappingFile, problems);
  const ctx = assetContext(assetId);
  if (input.interfaceId && !ctx.interfaces.some((i) => i.id === input.interfaceId))
    problems.push({ file: '(import)', path: 'interfaceId', message: `The asset has no interface "${input.interfaceId}"` });
  const key = collectorKey(input.collector);
  const rows = collectionRows(assetId);
  const stored = rows.map((r) => ({ r, v: collectionValuesOf(r) }));
  const mine = stored.filter((x) => collectorKey(x.v.collector) === key);
  const remembered = new Map<string, string>();
  const collectorAliases = new Map<string, string>();
  for (const m of mappingsOf(key, assetId)) (m.asset_id ? remembered : collectorAliases).set(m.gateway_name, m.data_point);
  const protocol = (iface: string) => ctx.protocolOf(input.interfaceId ?? iface);
  const taken = new Set(rows.map((r) => r.id));
  const entries: Plan['entries'] = [];
  for (const c of collections) {
    const prev = mine.find((x) => x.v.name === c.name);
    let id = prev?.r.id ?? slug(c.name);
    if (!prev) {
      const stem = PLANT_ID_RE.test(id) ? id : 'collection';
      id = stem;
      for (let n = 2; taken.has(id) || entries.some((e) => e.id === id); n++) id = `${stem}-${n}`.slice(0, 80);
    }
    if (entries.some((e) => e.id === id)) {
      warnings.push({ file: '(files)', path: c.name, message: `Collection "${c.name}" is there twice: the second is left out` });
      continue;
    }
    const before = new Map((prev?.v.items ?? []).filter((i) => i.dataPoint).map((i) => [`${i.outputName}\u0000${i.address}`, i.dataPoint!]));
    const items: PlantCollectionPreviewItem[] = c.items.map((it, index) => {
      const s = suggest(it, ctx, protocol, mapping, remembered, collectorAliases, before);
      const point = s.suggestion.dataPoint ? ctx.points.find((p) => p.id === s.suggestion.dataPoint) : undefined;
      return {
        ...it,
        dataPoint: s.suggestion.accepted ? s.suggestion.dataPoint : null,
        index,
        suggestion: s.suggestion,
        alternatives: s.alternatives,
        pointAddress: point ? point.address : null,
        newAlias: !!point && !!it.outputName && ![point.id, point.name, ...point.aliases].some((n) => n === it.outputName),
      };
    });
    const values: PlantCollectionValues = {
      id,
      name: c.name,
      collector: input.collector,
      dataPathId: input.dataPathId ?? prev?.v.dataPathId ?? null,
      interfaceId: input.interfaceId ?? prev?.v.interfaceId ?? null,
      mode: c.mode,
      intervalMs: c.intervalMs,
      debounceMs: c.debounceMs,
      triggers: c.triggers,
      composition: c.composition,
      destination: c.destination ?? prev?.v.destination ?? null,
      access: c.access,
      settings: c.settings.slice(0, L.settings),
      items: items.map(({ index: _i, suggestion: _s, alternatives: _a, pointAddress: _p, newAlias: _n, ...x }) => x),
      notes: c.notes || prev?.v.notes || '',
      format,
      sourceFile: input.files
        .map((f) => f.name)
        .join(', ')
        .slice(0, 200),
    };
    entries.push({ id, values, before: prev?.v ?? null, position: prev?.r.position ?? null, items });
  }
  const removed = input.replace ? mine.filter((x) => !entries.some((e) => e.id === x.r.id)).map((x) => ({ id: x.r.id, name: x.r.name })) : [];
  for (const e of entries)
    for (const p of checkCollection(assetId, e.values, e.before, ctx))
      if (!p.path.startsWith('items')) problems.push({ file: '(import)', path: `${e.id}.${p.path}`, message: p.message });
  return { ctx, collector: input.collector, entries, removed, format };
}

const action = (e: Plan['entries'][number]): PlantCollectionPreviewEntry['action'] =>
  !e.before ? 'add' : changedKeys({ ...e.before, sourceFile: '' }, { ...e.values, sourceFile: '' }).length ? 'change' : 'unchanged';

export function previewCollectionImport(assetId: string, input: CollectionImportInput): PlantCollectionPreview {
  const a = visibleAsset(assetId);
  requireManage(a.perms, 'import data collections for this asset');
  const problems: PlantCollectionImportProblem[] = [];
  const warnings: PlantCollectionImportProblem[] = [];
  const p = plan(assetId, input, problems, warnings);
  return {
    format: p.format,
    preview: COLLECTION_PREVIEW_FORMATS.includes(p.format),
    collections: [
      ...p.entries.map((e) => {
        const { items: _i, ...values } = e.values;
        return { id: e.id, name: e.values.name, action: action(e), values, items: e.items };
      }),
      ...p.removed.map((r) => {
        const v = collectionValuesOf(collectionRows(assetId).find((x) => x.id === r.id)!);
        const { items: _i, ...values } = v;
        return { id: r.id, name: r.name, action: 'remove' as const, values, items: [] };
      }),
    ],
    problems,
    warnings,
    points: p.ctx.points.map(({ aliases: _a, protocol: _p, ...x }) => x),
    canManageCatalogue: canManageCatalogue(),
  };
}

// ---------- applying ----------

function failed(problems: PlantCollectionImportProblem[]): never {
  const { path, message } = problems[0]!;
  throw new HttpError(400, `${path}: ${message}`, 'PLANT_COLLECTION_IMPORT_INVALID', { path, message, problems: problems.length });
}

/** Adds a data point to a profile's own part: an own interface, or one it inherits (through the override). */
function addToProfile(
  own: PlantProfileValues,
  iface: string,
  group: string,
  point: PlantProfileValues['interfaces'][number]['groups'][number]['dataPoints'][number],
) {
  const put = <T extends { groups: PlantProfileValues['interfaces'][number]['groups'] }>(x: T): T => {
    const g = x.groups.find((y) => y.name === group);
    return g
      ? { ...x, groups: x.groups.map((y) => (y === g ? { ...y, dataPoints: [...y.dataPoints, point] } : y)) }
      : { ...x, groups: [...x.groups, { name: group, description: '', dataPoints: [point] }] };
  };
  if (own.interfaces.some((i) => i.id === iface)) return { ...own, interfaces: own.interfaces.map((i) => (i.id === iface ? put(i) : i)) };
  const o = own.interfaceOverrides.find((x) => x.interface === iface) ?? { interface: iface, present: true, groups: [], fileSets: [] };
  return {
    ...own,
    interfaceOverrides: [...own.interfaceOverrides.filter((x) => x.interface !== iface), put(o)],
  };
}

export function applyCollectionImport(assetId: string, input: CollectionImportInput): PlantCollectionImportResult & { preview: PlantCollectionPreview } {
  const a = visibleAsset(assetId);
  requireManage(a.perms, 'import data collections for this asset');
  const problems: PlantCollectionImportProblem[] = [];
  const warnings: PlantCollectionImportProblem[] = [];
  const p = plan(assetId, input, problems, warnings);
  if (problems.length) failed(problems);
  const by = me().username;
  const at = nowIso();
  const catalogue = canManageCatalogue();
  const decisions = new Map<string, PlantItemDecision>(input.decisions.map((d) => [`${d.collection}\u0000${d.index}`, d]));
  const result: PlantCollectionImportResult = {
    collections: { added: 0, changed: 0, unchanged: 0, removed: p.removed.length },
    items: { mapped: 0, raw: 0 },
    remembered: 0,
    addresses: 0,
    aliases: { profile: 0, collector: 0 },
    added: { asset: 0, profile: 0 },
  };
  // what the decisions write besides the collections: the assignment (addresses, additions, known-as names of added
  // data points) and the profile (known-as names, new data points)
  const r = assignmentRowOf(assetId);
  const assignmentBefore: PlantAssignmentValues | null = r ? assignmentValuesOf(r) : null;
  const assignment: PlantAssignmentValues = structuredClone(
    assignmentBefore ?? {
      profileId: null,
      firmware: '',
      interfaces: [],
      overrides: [],
      additions: { interfaces: [], dataPoints: [] },
      publications: [],
      kpis: [],
      notes: '',
    },
  );
  const profileId = assignment.profileId;
  const profiles = ownProfiles();
  let profile = profileId ? structuredClone(profiles.get(profileId) ?? null) : null;
  const profileBefore = profile ? structuredClone(profile) : null;
  const resolved = resolvedProfile(profileId);
  const pointsAdded = new Map<string, string>();
  const remember: [string, string, string][] = [];
  const need = (ok: boolean, path: string, message: string) => !ok && problems.push({ file: '(decisions)', path, message });

  for (const e of p.entries) {
    e.values.items = e.items.map((it) => {
      const d = decisions.get(`${e.id}\u0000${it.index}`);
      let dataPoint = d ? d.dataPoint : it.suggestion.accepted ? it.suggestion.dataPoint : null;
      if (d?.add) {
        const add = d.add;
        const exists = p.ctx.points.some((x) => x.id === add.id) || pointsAdded.has(add.id);
        need(!exists, `${e.id}.items[${it.index}].add.id`, `Data point "${add.id}" exists already`);
        need(
          p.ctx.interfaces.some((i) => i.id === add.interface),
          `${e.id}.items[${it.index}].add.interface`,
          `The asset has no interface "${add.interface}"`,
        );
        const point = {
          id: add.id,
          name: add.name,
          description: '',
          dataType: dataTypeOf(it.outputType) ?? '',
          unit: '',
          address: it.address,
          access: 'read' as const,
          updateRateMs: null,
          enumValues: [],
          aliases: it.outputName && it.outputName !== add.id ? [it.outputName] : [],
          notes: '',
          publications: [],
        };
        if (!exists) {
          if (add.target === 'profile') {
            need(catalogue, `${e.id}.items[${it.index}].add`, 'You may not change device profiles');
            need(!!profile, `${e.id}.items[${it.index}].add`, 'The asset has no device profile');
            const onProfile = resolved?.interfaces.some((i) => i.id === add.interface);
            need(!!onProfile, `${e.id}.items[${it.index}].add.interface`, `The profile has no interface "${add.interface}"`);
            if (profile && catalogue && onProfile) profile = addToProfile(profile, add.interface, add.group, point);
            result.added.profile++;
          } else {
            assignment.additions.dataPoints.push({ ...point, interface: add.interface, group: add.group });
            result.added.asset++;
          }
          pointsAdded.set(add.id, add.target);
        }
        dataPoint = add.id;
      }
      if (dataPoint) {
        const known = p.ctx.points.find((x) => x.id === dataPoint);
        need(!!known || pointsAdded.has(dataPoint), `${e.id}.items[${it.index}].dataPoint`, `The asset has no data point "${dataPoint}"`);
        if (d?.recordAddress && it.address && known && known.address !== it.address) {
          const o = assignment.overrides.find((x) => x.dataPoint === dataPoint);
          if (o) o.address = it.address;
          else assignment.overrides.push({ dataPoint, available: true, address: it.address, unit: null, dataType: null, updateRateMs: null, notes: '' });
          result.addresses++;
        }
        if (d?.alias === 'collector' && it.outputName) {
          remember.push([collectorKey(p.collector), '', it.outputName]);
          result.aliases.collector++;
        }
        if (d?.alias === 'profile' && it.outputName && known) {
          if (known.added) {
            const x = assignment.additions.dataPoints.find((y) => y.id === dataPoint);
            if (x && !x.aliases.includes(it.outputName)) x.aliases.push(it.outputName);
            for (const i of assignment.additions.interfaces)
              for (const g of i.groups)
                for (const y of g.dataPoints) if (y.id === dataPoint && !y.aliases.includes(it.outputName)) y.aliases.push(it.outputName);
          } else {
            need(catalogue, `${e.id}.items[${it.index}].alias`, 'You may not change device profiles: remember the name for this collector instead');
            if (profile && catalogue) profile = withAlias(profile, resolved, dataPoint, it.outputName);
          }
          result.aliases.profile++;
        }
        if (it.outputName) remember.push([collectorKey(p.collector), assetId, it.outputName]);
        result.items.mapped++;
      } else result.items.raw++;
      const { index: _i, suggestion: _s, alternatives: _a, pointAddress: _p, newAlias: _n, ...rest } = it;
      return { ...rest, dataPoint: dataPoint ?? null };
    });
  }
  if (problems.length) failed(problems);
  // the assignment and the profile are checked as an edit would check them
  const assignmentChanged = JSON.stringify(assignment) !== JSON.stringify(assignmentBefore);
  if (assignmentChanged) {
    const probs = assignmentProblems(assignment, resolvedAfter(profile, profiles), (id) => !!kpiRowOf(id));
    if (probs.length) failed(probs.map((x) => ({ file: '(assignment)', path: x.path, message: x.message })));
  }
  const profileChanged = !!profile && JSON.stringify(profile) !== JSON.stringify(profileBefore);
  if (profile && profileChanged) profile = checkedProfile(profile, new Map(profiles), (probs) => failed(probs.map((x) => ({ file: '(profile)', ...x }))));
  // collections that now name data points added above are checked against the model after the import
  db().tx(() => {
    const meta = { at, by };
    if (profile && profileChanged) {
      upsertProfile(profile, meta, { keepSource: true });
      audit({
        action: 'device_profile.updated',
        entityType: 'device_profile',
        entityId: profile.id,
        summary: `Device profile "${profile.name}" changed by an import of data collections (known-as names, data points)`,
        details: { via: 'collection_import', asset: assetId, aliases: result.aliases.profile, added: result.added.profile },
      });
    }
    if (assignmentChanged) {
      upsertAssignment(assetId, assignment, meta, { keepSource: true });
      audit({
        action: 'asset.assignment_set',
        entityType: 'asset',
        entityId: assetId,
        summary: `Assignment of asset "${a.row.name}" changed by an import of data collections (${result.addresses} addresses, ${result.added.asset} data points added)`,
        details: { via: 'collection_import', addresses: result.addresses, added: result.added.asset },
      });
    }
    let next = Number(db().get<{ n: number | null }>('SELECT MAX(position) AS n FROM plant_collections WHERE asset_id = ?', assetId)?.n ?? -1) + 1;
    for (const e of p.entries) {
      const act = action(e);
      result.collections[act === 'add' ? 'added' : act === 'change' ? 'changed' : 'unchanged']++;
      if (act === 'unchanged') continue;
      upsertCollection(assetId, e.values, e.position ?? next++, meta);
    }
    for (const x of p.removed) db().run('DELETE FROM plant_collections WHERE asset_id = ? AND id = ?', assetId, x.id);
    const seen = new Set<string>();
    for (const e of p.entries)
      for (const it of e.values.items)
        if (it.dataPoint && it.outputName)
          for (const [k, asset, name] of remember)
            if (name === it.outputName && !seen.has(`${k}\u0000${asset}\u0000${name}`)) {
              seen.add(`${k}\u0000${asset}\u0000${name}`);
              rememberMapping(k, asset, name, it.dataPoint, meta);
              if (asset) result.remembered++;
            }
    audit({
      action: 'plant.collection_imported',
      entityType: 'asset',
      entityId: assetId,
      summary: `Data collections of asset "${a.row.name}" imported for ${p.collector.kind} ${p.collector.ref} (${result.collections.added} added, ${result.collections.changed} changed, ${result.collections.removed} removed; ${result.items.mapped} items mapped, ${result.items.raw} raw)`,
      details: {
        format: p.format,
        collector: p.collector,
        ...result,
        files: input.files.map((f) => ({ name: f.name, sha256: sha256(f.content) })),
        ...(input.mappingFile ? { mappingFile: { name: input.mappingFile.name, sha256: sha256(input.mappingFile.content) } } : {}),
      },
    });
  });
  return { ...result, preview: previewCollectionImport(assetId, { ...input, decisions: [] }) };
}

/** The profile as resolved after the import's changes to its own part. */
function resolvedAfter(profile: PlantProfileValues | null, own: Map<string, PlantProfileValues>) {
  if (!profile) return null;
  const all = new Map(own);
  all.set(profile.id, profile);
  return resolveFrom(profile.id, all);
}
const resolveFrom = (id: string, all: Map<string, PlantProfileValues>) => resolveChain(id, (x) => all.get(x));

/** A known-as name on a profile data point: its own one, or an inherited one (through the override). */
function withAlias(own: PlantProfileValues, resolved: ReturnType<typeof resolvedProfile>, pointId: string, name: string): PlantProfileValues {
  const add = (list: string[] | undefined) => (list?.includes(name) ? list : [...(list ?? []), name]);
  const mapPoints = <T extends { groups: PlantProfileValues['interfaces'][number]['groups'] }>(x: T): T => ({
    ...x,
    groups: x.groups.map((g) => ({ ...g, dataPoints: g.dataPoints.map((d) => (d.id === pointId ? { ...d, aliases: add(d.aliases) } : d)) })),
  });
  const ownHas = (x: { groups: PlantProfileValues['interfaces'][number]['groups'] }) => x.groups.some((g) => g.dataPoints.some((d) => d.id === pointId));
  if (own.interfaces.some(ownHas)) return { ...own, interfaces: own.interfaces.map(mapPoints) };
  if (own.interfaceOverrides.some(ownHas)) return { ...own, interfaceOverrides: own.interfaceOverrides.map(mapPoints) };
  // inherited: the override keeps the effective names and adds this one
  const effective = resolved?.interfaces.flatMap((i) => i.groups.flatMap((g) => g.dataPoints)).find((d) => d.id === pointId)?.aliases ?? [];
  const o = own.pointOverrides.find((x) => x.dataPoint === pointId);
  const next = { ...(o ?? { dataPoint: pointId, present: true }), aliases: add(o?.aliases ?? effective) };
  return { ...own, pointOverrides: [...own.pointOverrides.filter((x) => x.dataPoint !== pointId), next] };
}

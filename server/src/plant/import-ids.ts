import {
  PLANT_ID_SCOPE,
  type PlantAliasUse,
  type PlantIdKind,
  type PlantIdMapInput,
  type PlantImportProblem,
  type PlantPlannedRename,
  type PlantRemovableKind,
} from '@sm/shared';
import { db } from '../db.js';
import type { PlantFile } from './format.js';
import { aliasTarget, entryOf, idFormatProblem } from './ids.js';
import { checkRename, renameEntry, type RenameOf } from './rename.js';
import type { Target } from './removal.js';

/**
 * The import's ids (0.11.0, docs/PLANT.md#changing-ids): the id mapping a person gives (a table of old → new ids and
 * simple rules), applied to the ids of the files and to the references inside them; old ids (aliases) in the files,
 * read as the entries they lead to; and the entries the files remove (`remove:`, or "Remove entries that are not in
 * the files"). An entry whose old id is mapped and exists is renamed through the rename core first – so export → map →
 * import renames many entries at once – and then updated from the files.
 */

/** One id in a file: a definition (an entry of the file) or a reference; scope as the file says it. */
interface Occurrence {
  kind: PlantIdKind;
  id: string;
  /** The site, asset or profile id in the file's terms ('' for sites, assets, profiles, KPI definitions; null: unknown) */
  scope: string | null;
  def: boolean;
  file: string;
  path: string;
  set(v: string): void;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const one = <T>(sql: string, ...p: unknown[]) => db().get<T>(sql, ...p);

/** Every id of a file, with a setter that writes the mapped id back. */
function occurrences(name: string, f: PlantFile): Occurrence[] {
  const out: Occurrence[] = [];
  const add = (kind: PlantIdKind, o: Obj, k: string, scope: string | null, def: boolean, path: string) => {
    const v = o[k];
    if (typeof v === 'string' && v) out.push({ kind, id: v, scope, def, file: name, path: `${path}.${k}`, set: (x) => (o[k] = x) });
  };
  const addList = (kind: PlantIdKind, o: Obj, k: string, scope: string | null, path: string) => {
    const arr = o[k];
    if (Array.isArray(arr))
      arr.forEach((v, i) => {
        if (typeof v === 'string' && v) out.push({ kind, id: v, scope, def: false, file: name, path: `${path}.${k}[${i}]`, set: (x) => (arr[i] = x) });
      });
  };
  const file = f as unknown as Obj;
  const assetSite = new Map<string, string>();
  const asset = (a: Obj, site: string | null, path: string) => {
    const loc = isObj(a.location) ? a.location : null;
    const s =
      site ??
      (typeof loc?.site === 'string' ? loc.site : null) ??
      (typeof a.id === 'string' ? (one<{ site_id: string }>('SELECT site_id FROM plant_assets WHERE id = ?', a.id)?.site_id ?? null) : null);
    if (typeof a.id === 'string' && s) assetSite.set(a.id, s);
    add('asset', a, 'id', '', true, path);
    if (loc) {
      add('site', loc, 'site', '', false, `${path}.location`);
      for (const k of ['area', 'work_center', 'work_unit']) add('node', loc, k, s, false, `${path}.location`);
      add('building', loc, 'building', s, false, `${path}.location`);
    }
    add('asset', a, 'parent', '', false, path);
    addList('asset', a, 'children', '', path);
  };
  const sites: [Obj, string][] = isObj(file.site) ? [[file.site, 'site']] : list(file.sites).map((s, i) => [s, `sites[${i}]`]);
  for (const [s, path] of sites) {
    const sid = typeof s.id === 'string' ? s.id : null;
    add('site', s, 'id', '', true, path);
    list(s.buildings).forEach((b, i) => {
      add('building', b, 'id', sid, true, `${path}.buildings[${i}]`);
      add('building', b, 'parent', sid, false, `${path}.buildings[${i}]`);
    });
    const node = (n: Obj, p: string) => {
      add('node', n, 'id', sid, true, p);
      add('building', n, 'building', sid, false, p);
    };
    list(s.areas).forEach((a, i) => {
      node(a, `${path}.areas[${i}]`);
      list(a.work_centers).forEach((w, j) => {
        node(w, `${path}.areas[${i}].work_centers[${j}]`);
        list(w.work_units).forEach((u, k) => node(u, `${path}.areas[${i}].work_centers[${j}].work_units[${k}]`));
      });
    });
    list(s.assets).forEach((a, i) => asset(a, sid, `${path}.assets[${i}]`));
  }
  list(file.assets).forEach((a, i) => asset(a, null, `assets[${i}]`));
  const profiles: [Obj, string][] = isObj(file.device_profile)
    ? [[file.device_profile, 'device_profile']]
    : list(file.device_profiles).map((x, i) => [x, `device_profiles[${i}]`]);
  for (const [p, path] of profiles) {
    const pid = typeof p.id === 'string' ? p.id : null;
    add('profile', p, 'id', '', true, path);
    list(p.interfaces).forEach((i, n) => {
      const ip = `${path}.interfaces[${n}]`;
      add('interface', i, 'id', pid, true, ip);
      list(i.groups).forEach((g, m) => list(g.data_points).forEach((d, k) => add('data_point', d, 'id', pid, true, `${ip}.groups[${m}].data_points[${k}]`)));
      list(i.data_points).forEach((d, k) => add('data_point', d, 'id', pid, true, `${ip}.data_points[${k}]`));
    });
  }
  const kpis: [Obj, string][] = isObj(file.kpi_definition)
    ? [[file.kpi_definition, 'kpi_definition']]
    : list(file.kpi_definitions).map((x, i) => [x, `kpi_definitions[${i}]`]);
  for (const [k, path] of kpis) {
    add('kpi', k, 'id', '', true, path);
    list(k.inputs).forEach((x, i) => {
      const at = `${path}.inputs[${i}]`;
      add('profile', x, 'profile', '', false, at);
      // 0.13: any of several profiles (the first is the input's profile) and the mapping per profile
      addList('profile', x, 'profiles', '', at);
      const mapping = isObj(x.mapping) ? x.mapping : null;
      const names = [
        ...(typeof x.profile === 'string' && x.profile ? [x.profile] : []),
        ...(Array.isArray(x.profiles) ? x.profiles.filter((v): v is string => typeof v === 'string' && !!v) : []),
      ];
      // an input's data point is the id in its profiles that do not map it: read in the first of them
      const arr = x.data_points;
      if (Array.isArray(arr))
        arr.forEach((v, n) => {
          if (typeof v !== 'string' || !v) return;
          const scope = names.length ? (names.find((pk) => !(isObj(mapping?.[pk]) && typeof (mapping![pk] as Obj)[v] === 'string')) ?? null) : null;
          if (names.length && !scope) return;
          out.push({ kind: 'data_point', id: v, scope, def: false, file: name, path: `${at}.data_points[${n}]`, set: (y) => (arr[n] = y) });
        });
      for (const pk of Object.keys(mapping ?? {})) {
        const m = mapping![pk];
        if (isObj(m)) for (const dk of Object.keys(m)) add('data_point', m, dk, pk, false, `${at}.mapping.${pk}`);
        out.push({
          kind: 'profile',
          id: pk,
          scope: '',
          def: false,
          file: name,
          path: `${at}.mapping`,
          set: (v) => {
            if (v === pk || !mapping) return;
            mapping[v] = mapping[pk];
            delete mapping[pk];
          },
        });
      }
    });
  }
  const assignments: [Obj, string][] = isObj(file.assignment)
    ? [[file.assignment, 'assignment']]
    : list(file.assignments).map((x, i) => [x, `assignments[${i}]`]);
  for (const [a, path] of assignments) {
    const profile =
      typeof a.profile === 'string' && a.profile
        ? a.profile
        : typeof a.asset === 'string'
          ? (one<{ profile_id: string | null }>('SELECT profile_id FROM plant_assignments WHERE asset_id = ?', a.asset)?.profile_id ?? null)
          : null;
    add('asset', a, 'asset', '', false, path);
    add('site', a, 'site', '', false, path);
    add('profile', a, 'profile', '', false, path);
    list(a.interfaces).forEach((x, i) => add('interface', x, 'interface', profile, false, `${path}.interfaces[${i}]`));
    list(a.overrides).forEach((x, i) => add('data_point', x, 'data_point', profile, false, `${path}.overrides[${i}]`));
    list(a.publications).forEach((x, i) => add('data_point', x, 'data_point', profile, false, `${path}.publications[${i}]`));
    list(a.kpis).forEach((x, i) => add('kpi', x, 'kpi', '', false, `${path}.kpis[${i}]`));
  }
  const nets: [Obj, string][] = isObj(file.ot_network) ? [[file.ot_network, 'ot_network']] : list(file.ot_networks).map((x, i) => [x, `ot_networks[${i}]`]);
  for (const [n, path] of nets) {
    const sid = typeof n.site === 'string' ? n.site : null;
    add('site', n, 'site', '', false, path);
    list(n.vlans).forEach((v, i) => {
      add('vlan', v, 'id', sid, true, `${path}.vlans[${i}]`);
      addList('site', v, 'sites', '', `${path}.vlans[${i}]`);
    });
    list(n.zones).forEach((z, i) => {
      add('zone', z, 'id', sid, true, `${path}.zones[${i}]`);
      addList('vlan', z, 'vlans', sid, `${path}.zones[${i}]`);
    });
    list(n.conduits).forEach((c, i) => {
      add('conduit', c, 'id', sid, true, `${path}.conduits[${i}]`);
      addList('zone', c, 'zones', sid, `${path}.conduits[${i}]`);
    });
  }
  const assetNets: [Obj, string][] = isObj(file.asset_network)
    ? [[file.asset_network, 'asset_network']]
    : list(file.asset_networks).map((x, i) => [x, `asset_networks[${i}]`]);
  for (const [n, path] of assetNets) {
    const aid = typeof n.asset === 'string' ? n.asset : null;
    const site =
      (typeof n.site === 'string' ? n.site : null) ??
      (aid ? (assetSite.get(aid) ?? one<{ site_id: string }>('SELECT site_id FROM plant_assets WHERE id = ?', aid)?.site_id ?? null) : null);
    add('asset', n, 'asset', '', false, path);
    add('site', n, 'site', '', false, path);
    list(n.devices).forEach((d, i) => {
      add('device', d, 'id', aid, true, `${path}.devices[${i}]`);
      add('vlan', d, 'vlan', site, false, `${path}.devices[${i}]`);
    });
    list(n.data_paths).forEach((p, i) => {
      add('data_path', p, 'id', aid, true, `${path}.data_paths[${i}]`);
      addList('device', p, 'devices', aid, `${path}.data_paths[${i}]`);
      list(p.transfers).forEach((t, j) => {
        if (t.peer_kind === 'device') add('device', t, 'peer', aid, false, `${path}.data_paths[${i}].transfers[${j}]`);
      });
    });
  }
  list(file.remove).forEach((r, i) => {
    const kind = r.kind as PlantRemovableKind;
    const scopeKey = PLANT_ID_SCOPE[kind] === 'site' ? 'site' : PLANT_ID_SCOPE[kind] === 'asset' ? 'asset' : null;
    const scope = scopeKey ? (typeof r[scopeKey] === 'string' ? (r[scopeKey] as string) : null) : '';
    add(kind, r, 'id', scope, false, `remove[${i}]`);
    add('site', r, 'site', '', false, `remove[${i}]`);
    add('asset', r, 'asset', '', false, `remove[${i}]`);
  });
  return out;
}

// ---------- the mapping ----------

/** The id the person's mapping gives (undefined: not mapped): the table first (its kind, then any kind), then the rules. */
function mapper(map: PlantIdMapInput | undefined): (kind: PlantIdKind, id: string) => string | undefined {
  if (!map || (!map.entries.length && !map.rules.length)) return () => undefined;
  const byKind = new Map<string, string>();
  for (const e of map.entries) byKind.set(`${e.kind ?? '*'}|${e.old}`, e.new);
  return (kind, id) => {
    const direct = byKind.get(`${kind}|${id}`) ?? byKind.get(`*|${id}`);
    if (direct !== undefined) return direct;
    let v = id;
    for (const r of map.rules) {
      if (r.kinds.length && !r.kinds.includes(kind)) continue;
      if (r.type === 'lowerCase') v = v.toLowerCase();
      else if (r.type === 'addPrefix') v = `${r.to}${v}`;
      else if (r.type === 'addSuffix') v = `${v}${r.to}`;
      else if (r.type === 'replacePrefix' && r.from && v.startsWith(r.from)) v = `${r.to}${v.slice(r.from.length)}`;
    }
    return v === id ? undefined : v;
  };
}

export interface IdPlan {
  renames: (RenameOf & { name: string; origin: { file: string; path: string } })[];
  aliasUses: PlantAliasUse[];
  problems: PlantImportProblem[];
  /** Entries the files remove (`remove:`), in final ids */
  removals: (Target & { origin: { file: string; path: string } })[];
}

/**
 * Applies the mapping and the aliases to the files (in place) and plans the renames. Scopes are resolved with the
 * stored entries: a building of site "a" that the mapping renames to "b" is looked up in "a" and renamed in "b".
 */
export function planIds(files: { name: string; file: PlantFile }[], map: PlantIdMapInput | undefined): IdPlan {
  const mapped = mapper(map);
  const problems: PlantImportProblem[] = [];
  const aliasUses = new Map<string, PlantAliasUse>();
  const occ = files.flatMap((f) => occurrences(f.name, f.file));
  /** Where a scope entry (site, asset, profile) of the files is stored now, and what it is called after the import. */
  const memo = new Map<string, { stored: string; final: string; source: string | null }>();
  const resolveGlobal = (kind: PlantIdKind, id: string) => resolve(kind, '', '', id);
  function resolve(kind: PlantIdKind, storedScope: string, finalScope: string, id: string): { stored: string; final: string; source: string | null } {
    const k = `${kind}|${storedScope}|${id}`;
    const hit = memo.get(k);
    if (hit) return hit;
    const target = mapped(kind, id);
    const exists = !!entryOf(kind, storedScope, id);
    const alias = exists ? null : aliasTarget(kind, storedScope, id);
    let r: { stored: string; final: string; source: string | null };
    if (target !== undefined) {
      const source = exists ? id : alias;
      const taken = entryOf(kind, storedScope, target) ? null : aliasTarget(kind, storedScope, target);
      if (taken && taken !== source)
        problems.push({
          file: '(id mapping)',
          path: kind,
          message: `"${target}" is an old id of ${kind} "${taken}" and still leads to it – an administrator can remove that alias first`,
        });
      r = { stored: source ?? target, final: target, source: source && source !== target ? source : null };
    } else if (alias) {
      aliasUses.set(`${kind}|${finalScope}|${id}`, { kind, scope: finalScope, oldId: id, newId: alias });
      r = { stored: alias, final: alias, source: null };
    } else r = { stored: id, final: id, source: null };
    memo.set(k, r);
    return r;
  }
  const scopeOf = (kind: PlantIdKind, fileScope: string | null): { stored: string; final: string } | null => {
    const sk = PLANT_ID_SCOPE[kind];
    if (sk === 'none') return { stored: '', final: '' };
    if (fileScope === null) return null;
    const r = resolveGlobal(sk === 'site' ? 'site' : sk === 'asset' ? 'asset' : 'profile', fileScope);
    return { stored: r.stored, final: r.final };
  };
  const renames = new Map<string, IdPlan['renames'][number]>();
  const finals = new Map<string, Set<string>>();
  const removals: IdPlan['removals'] = [];
  for (const o of occ) {
    const sc = scopeOf(o.kind, o.scope);
    let final: string;
    if (!sc) {
      // a scope the files do not say (an input without a profile): only the mapping applies
      final = mapped(o.kind, o.id) ?? o.id;
    } else {
      const r = resolve(o.kind, sc.stored, sc.final, o.id);
      final = r.final;
      if (r.source) {
        const k = `${o.kind}|${sc.final}|${r.source}`;
        if (!renames.has(k)) {
          const e = entryOf(o.kind, sc.stored, r.source);
          renames.set(k, { kind: o.kind, scope: sc.final, from: r.source, to: final, name: e?.name ?? r.source, origin: { file: o.file, path: o.path } });
        }
      }
      if (o.def) {
        const fk = `${o.kind}|${sc.final}|${final}`;
        const s = finals.get(fk) ?? new Set<string>();
        s.add(o.id);
        finals.set(fk, s);
      }
    }
    if (final !== o.id) {
      const format = idFormatProblem(o.kind, final);
      if (format && mapped(o.kind, o.id) !== undefined) problems.push({ file: o.file, path: o.path, message: `The mapping gives "${final}": ${format}` });
      o.set(final);
    }
    if (o.path.startsWith('remove[') && o.path.endsWith('.id') && sc)
      removals.push({ kind: o.kind as PlantRemovableKind, scope: sc.final, id: final, origin: { file: o.file, path: o.path } });
  }
  // conflicts: two old ids for one new id, an old id that is also a new one (chains, cycles)
  for (const [fk, olds] of finals)
    if (olds.size > 1) {
      const [kind, scope, id] = fk.split('|');
      problems.push({
        file: '(id mapping)',
        path: kind!,
        message: `${[...olds].map((x) => `"${x}"`).join(' and ')} would all become ${kind} "${id}"${scope ? ` in ${scope}` : ''}`,
      });
    }
  const sources = new Set([...renames.values()].map((r) => `${r.kind}|${r.scope}|${r.from}`));
  for (const r of renames.values())
    if (sources.has(`${r.kind}|${r.scope}|${r.to}`))
      problems.push({
        ...r.origin,
        message: `"${r.to}" is both an old and a new ${r.kind} id in the mapping (${r.from} → ${r.to}) – chains and cycles are not allowed; rename in two imports`,
      });
  // the scopes first: a building is renamed in its site once the site has its new id
  const order: PlantIdKind[] = [
    'site',
    'asset',
    'profile',
    'kpi',
    'building',
    'node',
    'vlan',
    'zone',
    'conduit',
    'device',
    'data_path',
    'interface',
    'data_point',
  ];
  const sorted = order.flatMap((k) => [...renames.values()].filter((r) => r.kind === k));
  return { renames: sorted, aliasUses: [...aliasUses.values()], problems, removals };
}

/**
 * Renames the planned entries (inside the import's transaction), each through the rename core with its checks
 * (rights, rules, the new id free). Problems are collected; nothing is renamed past the first one.
 */
export function applyRenames(plan: IdPlan, by: string): { done: PlantPlannedRename[]; problems: PlantImportProblem[] } {
  const done: PlantPlannedRename[] = [];
  const problems: PlantImportProblem[] = [];
  for (const r of plan.renames) {
    const c = checkRename(r.kind, r.scope, r.from, r.to);
    if (c.problem) {
      problems.push({ ...r.origin, message: `Renaming ${r.kind} "${r.from}" to "${r.to}": ${c.problem.message}` });
      continue;
    }
    const references = renameEntry(r, by);
    done.push({ kind: r.kind, scope: r.scope, id: r.from, newId: r.to, name: r.name, references });
  }
  return { done, problems };
}

/**
 * "Remove entries that are not in the files": within each site (and asset) of the files, the entries of the kinds the
 * files list there that the files do not have – never anything outside: other sites, kinds the files do not list.
 * Device profiles and KPI definitions only when a file lists them all (`device_profiles:`, `kpi_definitions:`).
 */
export function missingEntries(files: PlantFile[]): Target[] {
  const out: Target[] = [];
  const inFiles = new Set<string>();
  const k = (kind: string, scope: string, id: string) => `${kind}|${scope}|${id}`;
  const covered: { kind: PlantRemovableKind; scope: string }[] = [];
  const assetSites = new Set<string>();
  const catalogue = { profile: false, kpi: false };
  for (const f of files) {
    for (const s of f.site ? [f.site] : (f.sites ?? [])) {
      if (s.buildings) covered.push({ kind: 'building', scope: s.id });
      if (s.areas) covered.push({ kind: 'node', scope: s.id });
      if (s.assets) assetSites.add(s.id);
      for (const b of s.buildings ?? []) inFiles.add(k('building', s.id, b.id));
      for (const a of s.areas ?? []) {
        inFiles.add(k('node', s.id, a.id));
        for (const w of a.work_centers ?? []) {
          inFiles.add(k('node', s.id, w.id));
          for (const u of w.work_units ?? []) inFiles.add(k('node', s.id, u.id));
        }
      }
      for (const a of s.assets ?? []) inFiles.add(k('asset', '', a.id));
    }
    for (const a of f.assets ?? []) {
      inFiles.add(k('asset', '', a.id));
      const site = a.location?.site ?? one<{ site_id: string }>('SELECT site_id FROM plant_assets WHERE id = ?', a.id)?.site_id;
      if (site) assetSites.add(site);
    }
    if (f.device_profiles) catalogue.profile = true;
    if (f.kpi_definitions) catalogue.kpi = true;
    for (const p of f.device_profile ? [f.device_profile] : (f.device_profiles ?? [])) inFiles.add(k('profile', '', p.id));
    for (const x of f.kpi_definition ? [f.kpi_definition] : (f.kpi_definitions ?? [])) inFiles.add(k('kpi', '', x.id));
    for (const n of f.ot_network ? [f.ot_network] : (f.ot_networks ?? [])) {
      for (const [kind, items] of [
        ['vlan', n.vlans],
        ['zone', n.zones],
        ['conduit', n.conduits],
      ] as const) {
        if (items) covered.push({ kind, scope: n.site });
        for (const x of items ?? []) inFiles.add(k(kind, n.site, x.id));
      }
    }
    for (const n of f.asset_network ? [f.asset_network] : (f.asset_networks ?? [])) {
      if (n.devices) covered.push({ kind: 'device', scope: n.asset });
      if (n.data_paths) covered.push({ kind: 'data_path', scope: n.asset });
      for (const x of n.devices ?? []) inFiles.add(k('device', n.asset, x.id));
      for (const x of n.data_paths ?? []) inFiles.add(k('data_path', n.asset, x.id));
    }
  }
  const TABLE: Record<string, [string, string]> = {
    building: ['plant_buildings', 'site_id'],
    node: ['plant_nodes', 'site_id'],
    vlan: ['plant_vlans', 'site_id'],
    zone: ['plant_zones', 'site_id'],
    conduit: ['plant_conduits', 'site_id'],
    device: ['plant_devices', 'asset_id'],
    data_path: ['plant_data_paths', 'asset_id'],
  };
  const seen = new Set<string>();
  const push = (t: Target) => {
    const x = k(t.kind, t.scope, t.id);
    if (inFiles.has(x) || seen.has(x)) return;
    seen.add(x);
    out.push(t);
  };
  for (const c of covered) {
    const [table, col] = TABLE[c.kind]!;
    for (const r of db().all<{ id: string }>(`SELECT id FROM ${table} WHERE ${col} = ? ORDER BY id`, c.scope)) push({ kind: c.kind, scope: c.scope, id: r.id });
  }
  for (const s of assetSites)
    for (const r of db().all<{ id: string }>('SELECT id FROM plant_assets WHERE site_id = ? ORDER BY id', s)) push({ kind: 'asset', scope: '', id: r.id });
  if (catalogue.profile) for (const r of db().all<{ id: string }>('SELECT id FROM plant_profiles ORDER BY id')) push({ kind: 'profile', scope: '', id: r.id });
  if (catalogue.kpi) for (const r of db().all<{ id: string }>('SELECT id FROM plant_kpis ORDER BY id')) push({ kind: 'kpi', scope: '', id: r.id });
  return out;
}

import {
  addressProblem,
  PLANT_DATA_LIMITS as L,
  PLANT_PROFILE_MAX_DEPTH,
  PROFILE_INTERFACE_FIELDS,
  PROFILE_POINT_FIELDS,
  type PlantAssignmentValues,
  type PlantDataPoint,
  type PlantFileSet,
  type PlantInterface,
  type PlantInterfaceOverride,
  type PlantModelOrigin,
  type PlantProfilePointOverride,
  type PlantProfileValues,
  type PlantResolvedProfile,
  plantOriginKey,
} from '@sm/shared';

/**
 * Profile inheritance and asset additions (0.11.0, ADR 0007 "Update 0.11"): the one place where the effective model
 * of a device profile – its bases' interfaces, groups, data points and files with its own changes and additions – and
 * the model of an asset (its resolved profile with the assignment's additions) are computed. Every reader of a profile
 * (data point pages, who delivers what, assignments, checks, KPI inputs, data flow and lineage, coverage) uses these
 * functions; only the editor and the export read a profile's own part.
 *
 * Pure functions over values, so the import can resolve its post state the same way.
 */

const clone = <T>(v: T): T => structuredClone(v);

/** The own part of every profile, by id, as `resolveAll` reads it. */
export type OwnProfiles = Map<string, PlantProfileValues>;

const ownOrigin = (id: string): PlantModelOrigin => ({ kind: 'own', from: id, fields: [], changedBy: [], descriptionFrom: id });
const key = plantOriginKey;

/** The origins of an own interface: it, its groups, data points and file sets (into `o`). */
function ownInterface(o: PlantResolvedProfile['origins'], i: PlantInterface, id: string): void {
  o.interfaces[i.id] = ownOrigin(id);
  for (const g of i.groups) {
    o.groups[key(i.id, g.name)] = ownOrigin(id);
    for (const d of g.dataPoints) o.points[d.id] = ownOrigin(id);
  }
  for (const f of i.fileSets) o.fileSets[key(i.id, f.id)] = ownOrigin(id);
}

/** A profile without a base, as a resolved profile. */
function plain(p: PlantProfileValues): PlantResolvedProfile {
  const origins: PlantResolvedProfile['origins'] = { interfaces: {}, points: {}, groups: {}, fileSets: {} };
  for (const i of p.interfaces) ownInterface(origins, i, p.id);
  return {
    ...clone(p),
    chain: [p.id],
    descriptionFrom: p.id,
    origins,
    notPresent: { interfaces: [], points: [] },
    unusedOverrides: { interfaces: [], points: [] },
  };
}

const FILE_SET_FIELDS = ['name', 'description', 'format', 'direction', 'pathPattern', 'producedPer', 'retention', 'encoding', 'notes'] as const;
/** The fields in which a file set differs from the one it replaces. */
const fileSetChanges = (a: PlantFileSet, b: PlantFileSet): string[] => FILE_SET_FIELDS.filter((k) => a[k] !== b[k]);

/** Whether a value was set in an override (a key left out reads as inherited). */
const given = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k) && (o as Record<string, unknown>)[k] !== undefined;

/**
 * The effective model of a profile from its own part and its base's effective model. A base that does not exist (or
 * a cycle, which the rules refuse) reads as no base.
 */
export function resolveOver(p: PlantProfileValues, base: PlantResolvedProfile | null): PlantResolvedProfile {
  if (!p.extends || !base) return plain({ ...p, extends: p.extends ?? null });
  const interfaces: PlantInterface[] = clone(base.interfaces);
  const inherit = (o: PlantModelOrigin): PlantModelOrigin => ({
    kind: 'inherited',
    from: o.from,
    fields: [],
    changedBy: [...o.changedBy, ...(o.kind === 'overridden' ? [base.id] : [])],
    descriptionFrom: o.descriptionFrom,
  });
  const inheritAll = (r: Record<string, PlantModelOrigin>) => Object.fromEntries(Object.entries(r).map(([k, o]) => [k, inherit(o)]));
  const origins: PlantResolvedProfile['origins'] = {
    interfaces: inheritAll(base.origins.interfaces),
    points: inheritAll(base.origins.points),
    groups: inheritAll(base.origins.groups),
    fileSets: inheritAll(base.origins.fileSets),
  };
  const notPresent = clone(base.notPresent);
  const unused = { interfaces: [] as string[], points: [] as string[] };
  const touch = (o: PlantModelOrigin | undefined, fields: string[]) => {
    if (!o || !fields.length) return;
    o.kind = 'overridden';
    o.fields = [...new Set([...o.fields, ...fields])];
    if (fields.includes('description')) o.descriptionFrom = p.id;
  };

  // inherited interfaces: changed, not present, data points and files added
  for (const io of p.interfaceOverrides) {
    const at = interfaces.findIndex((i) => i.id === io.interface);
    if (at < 0) {
      unused.interfaces.push(io.interface);
      continue;
    }
    const iface = interfaces[at]!;
    if (!io.present) {
      interfaces.splice(at, 1);
      notPresent.interfaces.push({ id: iface.id, name: iface.name || iface.id, by: p.id });
      for (const g of iface.groups) {
        delete origins.groups[key(iface.id, g.name)];
        for (const d of g.dataPoints) delete origins.points[d.id];
      }
      for (const f of iface.fileSets) delete origins.fileSets[key(iface.id, f.id)];
      delete origins.interfaces[iface.id];
      continue;
    }
    // 0.13: the protocol only of an interface whose inherited protocol is "other" (a base across protocols)
    const fields = PROFILE_INTERFACE_FIELDS.filter((k) => given(io, k) && (k !== 'protocol' || iface.protocol === 'other'));
    for (const k of fields) (iface as unknown as Record<string, unknown>)[k] = clone(io[k]);
    touch(origins.interfaces[iface.id], fields);
    for (const g of io.groups) {
      const into = iface.groups.find((x) => x.name === g.name);
      const added = clone(g.dataPoints);
      if (into) {
        into.dataPoints.push(...added);
        // 0.12.0: a description replaces the inherited group's; an empty one inherits it
        if (g.description) {
          into.description = g.description;
          touch(origins.groups[key(iface.id, g.name)], ['description']);
        }
      } else {
        iface.groups.push({ name: g.name, description: g.description, dataPoints: added });
        origins.groups[key(iface.id, g.name)] = ownOrigin(p.id);
      }
      for (const d of added) origins.points[d.id] = ownOrigin(p.id);
    }
    for (const f of io.fileSets) {
      const same = iface.fileSets.findIndex((x) => x.id === f.id);
      if (same >= 0) {
        const inherited = iface.fileSets[same]!;
        // a file set of the same id replaces the inherited one; an empty description inherits it (0.12.0)
        const next = { ...clone(f), description: f.description || inherited.description };
        const fields = fileSetChanges(inherited, next);
        iface.fileSets[same] = next;
        touch(origins.fileSets[key(iface.id, f.id)], fields);
      } else {
        iface.fileSets.push(clone(f));
        origins.fileSets[key(iface.id, f.id)] = ownOrigin(p.id);
      }
    }
  }

  // inherited data points: changed or not present
  for (const po of p.pointOverrides) {
    let found: { iface: PlantInterface; list: PlantDataPoint[]; index: number } | null = null;
    for (const iface of interfaces)
      for (const g of iface.groups) {
        const index = g.dataPoints.findIndex((d) => d.id === po.dataPoint);
        if (index >= 0 && origins.points[po.dataPoint]?.kind !== 'own') found = { iface, list: g.dataPoints, index };
      }
    if (!found) {
      unused.points.push(po.dataPoint);
      continue;
    }
    const point = found.list[found.index]!;
    if (!po.present) {
      found.list.splice(found.index, 1);
      notPresent.points.push({ id: point.id, name: point.name || point.id, interface: found.iface.id, by: p.id });
      delete origins.points[point.id];
      continue;
    }
    const fields = PROFILE_POINT_FIELDS.filter((k) => given(po, k));
    for (const k of fields) (point as unknown as Record<string, unknown>)[k] = clone(po[k]);
    touch(origins.points[point.id], fields);
  }

  // own interfaces
  for (const i of p.interfaces) {
    interfaces.push(clone(i));
    ownInterface(origins, i, p.id);
  }

  // the data points without a group come last (as everywhere)
  for (const i of interfaces) i.groups = [...i.groups.filter((g) => g.name), ...i.groups.filter((g) => !g.name)];
  return {
    ...clone(p),
    // what the derived profile leaves empty, its base says
    manufacturer: p.manufacturer || base.manufacturer,
    model: p.model || base.model,
    category: p.category || base.category,
    // 0.12.0: the description, too (the own part keeps it empty; the export writes only the own part)
    description: p.description || base.description,
    descriptionFrom: p.description ? p.id : base.descriptionFrom,
    interfaces,
    chain: [p.id, ...base.chain],
    origins,
    notPresent,
    unusedOverrides: unused,
  };
}

/** Every profile resolved (a chain is resolved once). */
export function resolveAll(own: OwnProfiles): Map<string, PlantResolvedProfile> {
  const out = new Map<string, PlantResolvedProfile>();
  const visiting = new Set<string>();
  const go = (id: string): PlantResolvedProfile | null => {
    const done = out.get(id);
    if (done) return done;
    const p = own.get(id);
    if (!p) return null;
    if (visiting.has(id) || visiting.size >= PLANT_PROFILE_MAX_DEPTH * 4) return null;
    visiting.add(id);
    const base = p.extends ? go(p.extends) : null;
    visiting.delete(id);
    const r = resolveOver(p, base);
    out.set(id, r);
    return r;
  };
  for (const id of [...own.keys()].sort()) go(id);
  // the map keeps the order of the own map (by name, as read)
  return new Map([...own.keys()].map((id) => [id, out.get(id)!]));
}

/** One profile resolved, reading only its chain. */
export function resolveChain(id: string, read: (id: string) => PlantProfileValues | undefined): PlantResolvedProfile | null {
  const chain: PlantProfileValues[] = [];
  const seen = new Set<string>();
  let cur = read(id);
  while (cur && !seen.has(cur.id) && chain.length < PLANT_PROFILE_MAX_DEPTH * 4) {
    seen.add(cur.id);
    chain.push(cur);
    cur = cur.extends ? read(cur.extends) : undefined;
  }
  if (!chain.length) return null;
  let r: PlantResolvedProfile | null = null;
  for (const p of chain.reverse()) r = resolveOver(p, r);
  return r;
}

/** Whether a profile (resolved) is, or extends, the given profile id. */
export const isOrExtends = (p: Pick<PlantResolvedProfile, 'chain'> | undefined | null, id: string): boolean => !!p && p.chain.includes(id);

/** The profiles that extend the given one, directly or through others (not the profile itself). */
export function descendantsOf(id: string, own: OwnProfiles): string[] {
  const children = new Map<string, string[]>();
  for (const p of own.values()) if (p.extends) children.set(p.extends, [...(children.get(p.extends) ?? []), p.id]);
  const out: string[] = [];
  const queue = [...(children.get(id) ?? [])];
  while (queue.length) {
    const x = queue.shift()!;
    if (x === id || out.includes(x)) continue;
    out.push(x);
    queue.push(...(children.get(x) ?? []));
  }
  return out;
}

// ---------- rules (refused on save and import) ----------

export interface ModelProblem {
  path: string;
  message: string;
}

/** What `extends` may not name: the profile itself, a profile that does not exist, a cycle, a chain too long. */
export function extendsProblems(id: string, base: string | null, own: OwnProfiles): ModelProblem[] {
  if (!base) return [];
  if (base === id) return [{ path: 'extends', message: 'A profile cannot extend itself' }];
  if (!own.has(base)) return [{ path: 'extends', message: `There is no device profile "${base}"` }];
  const seen = new Set([id]);
  let cur: string | null = base;
  let depth = 1;
  while (cur) {
    if (seen.has(cur)) return [{ path: 'extends', message: `Profile "${base}" extends "${id}" already (directly or through others): no cycles` }];
    seen.add(cur);
    depth++;
    cur = own.get(cur)?.extends ?? null;
  }
  // the deepest profile below this one counts, too
  const below = (x: string): number => Math.max(0, ...[...own.values()].filter((p) => p.extends === x && p.id !== x).map((p) => 1 + below(p.id)));
  if (depth + below(id) > PLANT_PROFILE_MAX_DEPTH)
    return [{ path: 'extends', message: `At most ${PLANT_PROFILE_MAX_DEPTH} profiles in a chain (a profile and its bases)` }];
  return [];
}

/**
 * What the effective model may not hold (for a derived profile; a profile without base keeps the rules of
 * `profileProblems`): an interface or data point id twice, an address that does not fit its interface's protocol.
 */
export function resolvedProblems(r: PlantResolvedProfile): ModelProblem[] {
  const out: ModelProblem[] = [];
  // 0.13: a protocol this profile sets on an inherited interface whose base has one now (not "other" any more)
  for (const o of r.interfaceOverrides) {
    const iface = r.interfaces.find((i) => i.id === o.interface);
    if (o.present && o.protocol && iface && iface.protocol !== o.protocol)
      out.push({
        path: 'interfaces',
        message: `Interface "${o.interface}" has protocol ${iface.protocol} in the base – only an inherited interface of protocol "other" gets its protocol in the profile that extends it`,
      });
  }
  const ifaces = new Set<string>();
  const points = new Set<string>();
  let count = 0;
  for (const iface of r.interfaces) {
    if (ifaces.has(iface.id)) out.push({ path: 'interfaces', message: `Interface "${iface.id}" is there twice (inherited and own)` });
    ifaces.add(iface.id);
    for (const g of iface.groups)
      for (const d of g.dataPoints) {
        count++;
        if (points.has(d.id)) out.push({ path: 'interfaces', message: `Data point "${d.id}" is there twice (inherited and own)` });
        points.add(d.id);
        const a = addressProblem(iface.protocol, d.address);
        if (a) out.push({ path: 'interfaces', message: `Data point "${d.id}": ${a}` });
      }
  }
  if (count > L.dataPoints) out.push({ path: 'interfaces', message: `At most ${L.dataPoints} data points per profile` });
  return out;
}

/**
 * The own part of a derived profile: an override twice, an own interface with the id of an inherited one (change it
 * instead), and the effective model's rules.
 */
export function ownPartProblems(p: PlantProfileValues, base: PlantResolvedProfile | null): ModelProblem[] {
  const out: ModelProblem[] = [];
  if (!p.extends) {
    if (p.interfaceOverrides.length) out.push({ path: 'interface_overrides', message: 'Only a profile that extends another can change inherited interfaces' });
    if (p.pointOverrides.length) out.push({ path: 'point_overrides', message: 'Only a profile that extends another can change inherited data points' });
    return out;
  }
  const seen = new Set<string>();
  p.interfaceOverrides.forEach((o, i) => {
    if (seen.has(o.interface)) out.push({ path: `interface_overrides[${i}].interface`, message: `Interface "${o.interface}" is changed twice` });
    seen.add(o.interface);
    const inherited = base?.interfaces.find((x) => x.id === o.interface);
    if (!inherited) return;
    // 0.13: an inherited interface gets a protocol only where the base leaves it open ("other")
    if (o.protocol && o.protocol !== inherited.protocol && inherited.protocol !== 'other')
      out.push({
        path: `interface_overrides[${i}].protocol`,
        message: `Interface "${o.interface}" is inherited with protocol ${inherited.protocol}: only an inherited interface of protocol "other" gets its protocol here`,
      });
    const protocol = inherited.protocol === 'other' ? (o.protocol ?? 'other') : inherited.protocol;
    o.groups.forEach((g, j) =>
      g.dataPoints.forEach((d, k) => {
        const a = addressProblem(protocol, d.address);
        if (a) out.push({ path: `interface_overrides[${i}].groups[${j}].data_points[${k}].address`, message: a });
      }),
    );
  });
  const points = new Set<string>();
  p.pointOverrides.forEach((o, i) => {
    if (points.has(o.dataPoint)) out.push({ path: `point_overrides[${i}].data_point`, message: `Data point "${o.dataPoint}" is changed twice` });
    points.add(o.dataPoint);
  });
  const inheritedIds = new Set(base?.interfaces.map((i) => i.id) ?? []);
  p.interfaces.forEach((iface, i) => {
    if (inheritedIds.has(iface.id))
      out.push({
        path: `interfaces[${i}].id`,
        message: `Interface "${iface.id}" is inherited from "${p.extends}" – change it there, or add data points to it`,
      });
  });
  if (out.length) return out;
  return resolvedProblems(resolveOver(p, base));
}

/**
 * The own part in a stable order (so an export imports back unchanged): overrides of inherited interfaces and data
 * points in the order of the base's model, unused ones last; groups that add nothing to an inherited group are left out.
 */
export function normalizeOwnPart(p: PlantProfileValues, base: PlantResolvedProfile | null): PlantProfileValues {
  if (!p.extends || !base) return p;
  const ifaceAt = new Map(base.interfaces.map((x, i) => [x.id, i]));
  const pointAt = new Map<string, number>();
  let n = 0;
  for (const i of base.interfaces) for (const g of i.groups) for (const d of g.dataPoints) pointAt.set(d.id, n++);
  const order = <T>(list: T[], key: (x: T) => string, at: Map<string, number>) =>
    list
      .map((x, i) => ({ x, i, at: at.get(key(x)) ?? Number.MAX_SAFE_INTEGER }))
      .sort((a, b) => a.at - b.at || a.i - b.i)
      .map((y) => y.x);
  const interfaceOverrides = order(p.interfaceOverrides, (o) => o.interface, ifaceAt)
    .map((o) => {
      const inherited = base.interfaces.find((x) => x.id === o.interface);
      const names = inherited?.groups.map((g) => g.name) ?? [];
      const groupAt = new Map(names.map((g, i) => [g, i]));
      // a group of an inherited name stays when it adds data points or describes the group (0.12.0)
      const kept = o.groups.filter((g) => g.dataPoints.length || g.description || !groupAt.has(g.name));
      // a file set that only repeats the inherited one (an empty description inherits) is no change
      const fileSets = o.fileSets.filter((f) => {
        const was = inherited?.fileSets.find((x) => x.id === f.id);
        return !was || fileSetChanges(was, { ...f, description: f.description || was.description }).length > 0;
      });
      const inheritedGroups = order(
        kept.filter((g) => groupAt.has(g.name)),
        (g) => g.name,
        groupAt,
      );
      return { ...o, groups: [...inheritedGroups, ...kept.filter((g) => !groupAt.has(g.name))], fileSets };
    })
    // an override that changes and adds nothing is no override
    .filter((o) => !o.present || PROFILE_INTERFACE_FIELDS.some((k) => given(o, k)) || o.groups.length || o.fileSets.length);
  return {
    ...p,
    interfaceOverrides: interfaceOverrides.map(canonicalInterface),
    pointOverrides: order(p.pointOverrides, (o) => o.dataPoint, pointAt).map(canonicalPoint),
  };
}

/** An override with its keys in one order (an edit and an import compare equal); not present: nothing else. */
function canonicalInterface(o: PlantInterfaceOverride): PlantInterfaceOverride {
  if (!o.present) return { interface: o.interface, present: false, groups: [], fileSets: [] };
  const out: Record<string, unknown> = { interface: o.interface, present: true };
  for (const k of PROFILE_INTERFACE_FIELDS) if (given(o, k)) out[k] = o[k];
  return { ...(out as unknown as PlantInterfaceOverride), groups: o.groups, fileSets: o.fileSets };
}
function canonicalPoint(o: PlantProfilePointOverride): PlantProfilePointOverride {
  if (!o.present) return { dataPoint: o.dataPoint, present: false };
  const out: Record<string, unknown> = { dataPoint: o.dataPoint, present: true };
  for (const k of PROFILE_POINT_FIELDS) if (given(o, k)) out[k] = o[k];
  return out as unknown as PlantProfilePointOverride;
}

// ---------- the model of an asset ----------

export interface AssetModel {
  /** The profile's interfaces with the asset's additions */
  interfaces: PlantInterface[];
  /** Interfaces and data points the asset adds itself */
  added: { interfaces: Set<string>; points: Set<string> };
  /** Data points the asset adds that its profile has now, too (the profile's wins) */
  shadowed: string[];
}

/**
 * An asset's model: its resolved profile (or nothing) with the data points the assignment adds to the profile's
 * interfaces and the interfaces it adds. A data point added on the asset whose id the profile has (since) is the
 * profile's: it is reported as shadowed, never counted twice.
 */
export function assetModel(
  a: Pick<PlantAssignmentValues, 'additions'> | null | undefined,
  profile: Pick<PlantProfileValues, 'interfaces'> | null | undefined,
): AssetModel {
  const interfaces: PlantInterface[] = clone(profile?.interfaces ?? []);
  const added = { interfaces: new Set<string>(), points: new Set<string>() };
  const shadowed: string[] = [];
  const add = a?.additions;
  if (!add || (!add.interfaces.length && !add.dataPoints.length)) return { interfaces, added, shadowed };
  const taken = new Set(interfaces.flatMap((i) => i.groups.flatMap((g) => g.dataPoints.map((d) => d.id))));
  const ifaceIds = new Set(interfaces.map((i) => i.id));
  for (const i of add.interfaces) {
    if (ifaceIds.has(i.id)) continue;
    const copy = clone(i);
    for (const g of copy.groups)
      g.dataPoints = g.dataPoints.filter((d) => {
        if (taken.has(d.id)) {
          shadowed.push(d.id);
          return false;
        }
        taken.add(d.id);
        added.points.add(d.id);
        return true;
      });
    interfaces.push(copy);
    ifaceIds.add(i.id);
    added.interfaces.add(i.id);
  }
  for (const x of add.dataPoints) {
    const iface = interfaces.find((i) => i.id === x.interface);
    if (!iface) continue;
    if (taken.has(x.id)) {
      shadowed.push(x.id);
      continue;
    }
    const { interface: _i, group, ...point } = x;
    const into = iface.groups.find((g) => g.name === group);
    if (into) into.dataPoints.push(clone(point));
    else iface.groups.push({ name: group, description: '', dataPoints: [clone(point)] });
    taken.add(x.id);
    added.points.add(x.id);
  }
  return { interfaces, added, shadowed };
}

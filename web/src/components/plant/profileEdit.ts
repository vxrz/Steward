import {
  PROFILE_INTERFACE_FIELDS,
  PROFILE_POINT_FIELDS,
  type PlantDataPoint,
  type PlantInterface,
  type PlantInterfaceOverride,
  type PlantProfileDetail,
  type PlantProfilePointOverride,
  type PlantProfileValues,
} from '@sm/shared';

/**
 * Editing a device profile's own part from its effective model (0.11.0): an own interface or data point is changed in
 * place; an inherited one gets an override with the fields that differ from the base (none left: no override); "not
 * present" and "restore" add and remove the override that drops it. The server resolves and checks the result.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The data points without a group come last (as the file lists them). */
export const ordered = (groups: PlantInterface['groups']) => [...groups.filter((g) => g.name), ...groups.filter((g) => !g.name && g.dataPoints.length)];

/** Puts a data point into its group (a new group is added), in place when it stays in its group. */
export function placePoint<T extends { groups: PlantInterface['groups'] }>(iface: T, point: PlantDataPoint, group: string, was: string | null): T {
  const groups = iface.groups.map((g) => ({ ...g, dataPoints: [...g.dataPoints] }));
  const from = was === null ? null : groups.find((g) => g.dataPoints.some((d) => d.id === was));
  if (from && from.name === group) {
    from.dataPoints = from.dataPoints.map((d) => (d.id === was ? point : d));
    return { ...iface, groups };
  }
  if (from) from.dataPoints = from.dataPoints.filter((d) => d.id !== was);
  const to = groups.find((g) => g.name === group);
  if (to) to.dataPoints.push(point);
  else groups.push({ name: group, description: '', dataPoints: [point] });
  return { ...iface, groups: ordered(groups) };
}

export const isOwnInterface = (p: PlantProfileDetail, id: string) => p.own.interfaces.some((i) => i.id === id);
export const baseInterface = (p: PlantProfileDetail, id: string) => p.base?.interfaces.find((i) => i.id === id);
export const basePoint = (p: PlantProfileDetail, id: string) =>
  p.base?.interfaces.flatMap((i) => i.groups.flatMap((g) => g.dataPoints)).find((d) => d.id === id);

const overrideOf = (own: PlantProfileValues, iface: string): PlantInterfaceOverride =>
  own.interfaceOverrides.find((o) => o.interface === iface) ?? { interface: iface, present: true, groups: [], fileSets: [] };
const withOverride = (own: PlantProfileValues, o: PlantInterfaceOverride): PlantProfileValues => ({
  ...own,
  interfaceOverrides: own.interfaceOverrides.some((x) => x.interface === o.interface)
    ? own.interfaceOverrides.map((x) => (x.interface === o.interface ? o : x))
    : [...own.interfaceOverrides, o],
});
const withPointOverride = (own: PlantProfileValues, id: string, o: PlantProfilePointOverride | null): PlantProfileValues => ({
  ...own,
  pointOverrides: [...own.pointOverrides.filter((x) => x.dataPoint !== id), ...(o ? [o] : [])],
});

/** A changed or new interface. */
export function saveInterface(p: PlantProfileDetail, iface: PlantInterface): PlantProfileValues {
  const own = p.own;
  const inherited = baseInterface(p, iface.id);
  if (!inherited || isOwnInterface(p, iface.id)) {
    const at = own.interfaces.findIndex((i) => i.id === iface.id);
    return {
      ...own,
      interfaces: at >= 0 ? own.interfaces.map((i, k) => (k === at ? { ...iface, groups: i.groups, fileSets: i.fileSets } : i)) : [...own.interfaces, iface],
    };
  }
  const o: PlantInterfaceOverride = {
    interface: iface.id,
    present: true,
    groups: overrideOf(own, iface.id).groups,
    fileSets: overrideOf(own, iface.id).fileSets,
  };
  for (const k of PROFILE_INTERFACE_FIELDS) if (!same(iface[k], inherited[k])) (o as unknown as Record<string, unknown>)[k] = iface[k];
  return withOverride(own, o);
}

/** A changed or new data point on an interface (own, or inherited: then it is added through the override). */
export function savePoint(p: PlantProfileDetail, ifaceId: string, point: PlantDataPoint, group: string, was: string | null): PlantProfileValues {
  const own = p.own;
  const inherited = was ? basePoint(p, was) : undefined;
  if (inherited && p.origins.points[was!]?.kind !== 'own') {
    const o: PlantProfilePointOverride = { dataPoint: point.id, present: true };
    for (const k of PROFILE_POINT_FIELDS) if (!same(point[k], inherited[k])) (o as unknown as Record<string, unknown>)[k] = point[k];
    return withPointOverride(own, point.id, Object.keys(o).length > 2 ? o : null);
  }
  if (isOwnInterface(p, ifaceId)) return { ...own, interfaces: own.interfaces.map((i) => (i.id === ifaceId ? placePoint(i, point, group, was) : i)) };
  return withOverride(own, placePoint(overrideOf(own, ifaceId), point, group, was));
}

/** Removes an own data point (one added to an inherited interface, too). */
export function removePoint(p: PlantProfileDetail, ifaceId: string, id: string): PlantProfileValues {
  const own = p.own;
  const drop = <T extends { groups: PlantInterface['groups'] }>(x: T): T => ({
    ...x,
    groups: x.groups.map((g) => ({ ...g, dataPoints: g.dataPoints.filter((d) => d.id !== id) })),
  });
  if (isOwnInterface(p, ifaceId)) return { ...own, interfaces: own.interfaces.map((i) => (i.id === ifaceId ? drop(i) : i)) };
  return withOverride(own, drop(overrideOf(own, ifaceId)));
}

/** Marks an inherited data point as not present, or restores it (the override that dropped it goes). */
export const setPointPresent = (p: PlantProfileDetail, id: string, present: boolean): PlantProfileValues =>
  withPointOverride(p.own, id, present ? null : { dataPoint: id, present: false });

/** Back to the base's values: the data point's override goes. */
export const resetPoint = (p: PlantProfileDetail, id: string): PlantProfileValues => withPointOverride(p.own, id, null);

/** Marks an inherited interface as not present, or restores it. */
export function setInterfacePresent(p: PlantProfileDetail, id: string, present: boolean): PlantProfileValues {
  const own = p.own;
  if (present) return { ...own, interfaceOverrides: own.interfaceOverrides.filter((o) => o.interface !== id) };
  return withOverride(own, { interface: id, present: false, groups: [], fileSets: [] });
}

/** Back to the base's values for the interface's own fields (what it adds stays). */
export function resetInterface(p: PlantProfileDetail, id: string): PlantProfileValues {
  const o = overrideOf(p.own, id);
  return withOverride(p.own, { interface: id, present: true, groups: o.groups, fileSets: o.fileSets });
}

/** A group renamed or described: an own interface's group, or a group the profile adds to an inherited interface. */
export function saveGroup(p: PlantProfileDetail, ifaceId: string, was: string, name: string, description: string): PlantProfileValues {
  const own = p.own;
  const rename = <T extends { groups: PlantInterface['groups'] }>(x: T): T => ({
    ...x,
    groups: x.groups.map((g) => (g.name === was ? { ...g, name, description } : g)),
  });
  if (isOwnInterface(p, ifaceId)) return { ...own, interfaces: own.interfaces.map((i) => (i.id === ifaceId ? rename(i) : i)) };
  return withOverride(own, rename(overrideOf(own, ifaceId)));
}

// ---------- descriptions (0.12.0): inherited ones are described anew here, or go back to the inherited one ----------

/** An inherited interface's description changed here (text), or back to the inherited one (null). */
export function describeInterface(p: PlantProfileDetail, id: string, text: string | null): PlantProfileValues {
  const o: PlantInterfaceOverride = { ...overrideOf(p.own, id) };
  // the inherited text again is no change
  if (text === null || text === baseInterface(p, id)?.description) delete o.description;
  else o.description = text;
  return withOverride(p.own, o);
}

/** An inherited group's description changed here; an empty one is the inherited description again. */
export function describeGroup(p: PlantProfileDetail, ifaceId: string, group: string, given: string): PlantProfileValues {
  const o = overrideOf(p.own, ifaceId);
  const text = given === baseInterface(p, ifaceId)?.groups.find((g) => g.name === group)?.description ? '' : given;
  const groups = o.groups.some((g) => g.name === group)
    ? o.groups.map((g) => (g.name === group ? { ...g, description: text } : g))
    : [...o.groups, { name: group, description: text, dataPoints: [] }];
  return withOverride(p.own, { ...o, groups });
}

/** An inherited file set's description changed here; an empty one is the inherited description again. */
export function describeFileSet(p: PlantProfileDetail, ifaceId: string, fileSetId: string, given: string): PlantProfileValues {
  const o = overrideOf(p.own, ifaceId);
  const inherited = baseInterface(p, ifaceId)?.fileSets.find((f) => f.id === fileSetId);
  const text = given === inherited?.description ? '' : given;
  const fileSets = o.fileSets.some((f) => f.id === fileSetId)
    ? o.fileSets.map((f) => (f.id === fileSetId ? { ...f, description: text } : f))
    : inherited
      ? [...o.fileSets, { ...inherited, description: text }]
      : o.fileSets;
  return withOverride(p.own, { ...o, fileSets });
}

/** An inherited data point's description back to the inherited one (its other changes stay). */
export function resetPointDescription(p: PlantProfileDetail, id: string): PlantProfileValues {
  const o = p.own.pointOverrides.find((x) => x.dataPoint === id);
  if (!o) return p.own;
  const { description: _d, ...rest } = o;
  return withPointOverride(p.own, id, Object.keys(rest).length > 2 || !rest.present ? rest : null);
}

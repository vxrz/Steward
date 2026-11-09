import { z } from 'zod';
import {
  boundedRecord,
  PLANT_DATA_LIMITS as L,
  PLANT_LIMITS,
  PROFILE_INTERFACE_FIELDS,
  PROFILE_POINT_FIELDS,
  matchPoints,
  type PlantDataPoint,
  type PlantExtractCandidates,
  type PlantExtractInput,
  type PlantExtractPointProblem,
  type PlantExtractPreview,
  type PlantExtractProblem,
  type PlantInterface,
  type PlantInterfaceOverride,
  type PlantProfilePointOverride,
  type PlantProfileValues,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { me } from '../auth/access.js';
import { HttpError, nowIso } from '../util.js';
import { canManageCatalogue } from './access.js';
import { requirePlant } from './settings.js';
import { plantId } from './model.js';
import { aliasTarget } from './ids.js';
import { allAssignments, ownProfiles, pointName, pointsOf, upsertProfile } from './data-model.js';
import { assetModel, resolveAll, type OwnProfiles } from './resolve.js';
import { checkRename, dryRun, profileFamily, renameEntry } from './rename.js';
import { checkedProfile, visibleAssets } from './catalogue.js';

/**
 * Extract a base profile (0.12.0, docs/PLANT.md "Extracting a base profile"): two or more device profiles without a
 * base share data points (power meters of one vendor that deliver the same quantities, for example). The shared data
 * points become a new base profile – a template by default – that each of them extends, in one transaction:
 *
 * - matched by id; where a profile's id differs, it is renamed to the base's with the rename core (rename.ts): the old
 *   id stays an alias, and assets, KPI definitions and data collections follow. Interfaces holding shared data points
 *   are matched the same way (the leading profile's id, or the id the input gives the base's interface); 0.13: where
 *   their protocols differ, the base's interface has the protocol `other` and its data points no address – each profile
 *   sets its protocol and the addresses as overrides;
 * - the base's data points take name, description, data type, unit, access and values from the leading profile;
 *   address, update rate, known-as names, notes and publications only where every profile agrees (else empty);
 * - each profile keeps, as overrides, only the fields that differ from the base; what it does not share stays its own;
 * - nothing about assets changes: the model of every asset (and of every profile) is compared before and after – the
 *   same interfaces, groups and data points with the same fields, ids renamed as mapped (the order may change: inherited
 *   items come first). A difference stops the extraction.
 *
 * Limits: a profile that extends another already is refused (0.12.0); the chain of a profile that extends one of them
 * must stay within PLANT_PROFILE_MAX_DEPTH; a data point whose group differs from the leading profile's is refused
 * (an override cannot move a data point to another group).
 */

const label = z.string().trim().min(1).max(PLANT_LIMITS.name);

export const extractInput = z
  .object({
    id: plantId,
    name: label,
    description: z.string().trim().max(L.longText).default(''),
    template: z.boolean().default(true),
    leading: plantId,
    profiles: z.array(plantId).min(2).max(20),
    points: z
      .array(z.object({ id: pointName, from: boundedRecord(pointName, 20) }).strict())
      .min(1)
      .max(L.dataPoints),
    // 0.13: the base's interface ids, by the leading profile's interface id (left out: the same)
    interfaces: boundedRecord(pointName, L.interfaces).optional(),
  })
  .strict();

export const candidatesInput = z.object({ profiles: z.array(plantId).min(2).max(20), leading: plantId }).strict();

function requireCatalogue(): string {
  requirePlant();
  const u = me();
  if (!canManageCatalogue(u)) throw new HttpError(403, 'You are not allowed to change device profiles', 'FORBIDDEN', { context: 'managePlantCatalogue' });
  return u.username;
}

/** A value with its object keys sorted, as text: equal values compare equal whatever the key order. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x,
  );
/** The value every list entry has, or `empty` when they differ. */
const agree = <T>(values: T[], empty: T): T => (values.every((v) => stable(v) === stable(values[0])) ? values[0]! : empty);

type Located = { iface: PlantInterface; group: string; point: PlantDataPoint };
const located = (p: Pick<PlantProfileValues, 'interfaces'>) => new Map(pointsOf(p).map((x) => [x.point.id, x as Located]));

// ---------- candidates ----------

/** The data points of the leading profile and, per other profile, the best match: same id, a known-as name, the name; same unit preferred. */
export function extractCandidates(input: z.infer<typeof candidatesInput>): PlantExtractCandidates {
  requireCatalogue();
  const own = ownProfiles();
  const ids = [...new Set(input.profiles)];
  for (const id of [...ids, input.leading]) if (!own.has(id)) throw new HttpError(404, `Device profile ${id} not found`, 'PLANT_PROFILE_NOT_FOUND', { id });
  const resolved = resolveAll(own);
  const v = visibleAssets();
  const using = new Map<string, number>();
  for (const [assetId, a] of allAssignments()) if (a.profileId && v.assets.has(assetId)) using.set(a.profileId, (using.get(a.profileId) ?? 0) + 1);
  const lead = resolved.get(input.leading)!;
  const others = ids.filter((id) => id !== input.leading);
  const leadPoints = pointsOf(lead);
  // 0.13: the matching is shared with a KPI input's mapping (shared matchPoints)
  const found = new Map(
    others.map((id) => [
      id,
      matchPoints(
        leadPoints.map((x) => x.point),
        pointsOf(resolved.get(id)!).map((x) => x.point),
      ),
    ]),
  );
  const points: PlantExtractCandidates['points'] = leadPoints.map(({ iface, group, point }, n) => {
    const matches: PlantExtractCandidates['points'][number]['matches'] = {};
    for (const id of others) {
      const best = found.get(id)![n];
      matches[id] = best ? { id: best.point.id, name: best.point.name, unit: best.point.unit, by: best.by } : null;
    }
    return { id: point.id, name: point.name, unit: point.unit, interface: iface.id, protocol: iface.protocol, group, matches };
  });
  return {
    profiles: ids.map((id) => {
      const p = own.get(id)!;
      return {
        id,
        name: p.name,
        extends: p.extends,
        template: p.template,
        assets: using.get(id) ?? 0,
        dataPoints: pointsOf(resolved.get(id)!).map((x) => ({ id: x.point.id, name: x.point.name, unit: x.point.unit, interface: x.iface.id })),
        interfaces: resolved.get(id)!.interfaces.map((i) => ({ id: i.id, name: i.name, protocol: i.protocol })),
      };
    }),
    points,
  };
}

// ---------- analysis: what can go into the base ----------

type Problem = PlantExtractPreview['problems'][number];
type PointProblem = NonNullable<PlantExtractPreview['points'][number]['problem']>;

interface Analysis {
  problems: Problem[];
  points: Map<string, PointProblem | null>;
  /** The data points that go into the base, in the input's order */
  ok: PlantExtractInput['points'];
  /** Per profile: its interface id → the base's interface id */
  ifaces: Map<string, Map<string, string>>;
}

function analyse(input: PlantExtractInput, own: OwnProfiles): Analysis {
  const problems: Problem[] = [];
  const points = new Map<string, PointProblem | null>();
  const ids = [...new Set(input.profiles)];
  const ifaces = new Map(ids.map((id) => [id, new Map<string, string>()]));
  const out = (): Analysis => ({ problems, points, ok: input.points.filter((p) => points.get(p.id) === null), ifaces });
  const say = (code: PlantExtractProblem, message: string, params: Record<string, string> = {}) => problems.push({ code, message, params });
  if (ids.length < 2) say('not_enough', 'Choose two or more device profiles');
  if (!ids.includes(input.leading)) say('leading', 'The leading profile is one of the chosen profiles', { profile: input.leading });
  for (const id of ids) {
    const p = own.get(id);
    if (!p) say('profile_unknown', `There is no device profile "${id}"`, { profile: id });
    else if (p.extends)
      say('has_base', `Device profile "${p.name}" extends "${p.extends}" already – only profiles without a base can get a new one`, {
        profile: id,
        base: p.extends,
      });
  }
  if (own.has(input.id)) say('base_taken', `A device profile with the id ${input.id} exists already`, { id: input.id });
  else {
    const alias = aliasTarget('profile', '', input.id);
    if (alias) say('base_taken', `"${input.id}" is an old id of device profile "${alias}" and still leads to it`, { id: input.id });
  }
  if (problems.length) return out();
  const where = new Map(ids.map((id) => [id, located(own.get(id)!)]));
  const reverse = new Map(ids.map((id) => [id, new Map<string, string>()]));
  const used = new Map(ids.map((id) => [id, new Set<string>()]));
  const names = new Map(ids.map((id) => [id, own.get(id)!.name]));
  // 0.13: the base's id of a leading interface (the input's, else the same)
  const target = (leadIface: string) => input.interfaces?.[leadIface] || leadIface;
  for (const bp of input.points) {
    let problem: PointProblem | null = null;
    const fail = (code: PlantExtractPointProblem, message: string, params: Record<string, string>) => (problem ??= { code, message, params });
    if (points.has(bp.id)) {
      // a base id twice: the second is refused, the first stays as it was judged
      continue;
    }
    const lead = where.get(input.leading)!.get(bp.from[input.leading] ?? '');
    const seen = new Set<string>();
    for (const id of ids) {
      const src = bp.from[id];
      const at = src ? where.get(id)!.get(src) : undefined;
      if (!src || !at) {
        fail('missing', `Device profile "${names.get(id)}" has no data point "${src ?? bp.id}"`, { profile: id, point: src ?? bp.id });
        continue;
      }
      if (used.get(id)!.has(src) || seen.has(`${id}/${src}`))
        fail('twice', `Data point "${src}" of "${names.get(id)}" is matched twice`, { profile: id, point: src });
      seen.add(`${id}/${src}`);
      if (!lead) continue;
      // 0.13: interfaces of different protocols share a base interface of protocol "other" (no refusal any more)
      if (at.group !== lead.group)
        fail(
          'group',
          `Data point "${src}" of "${names.get(id)}" is in group "${at.group}", in the leading profile in "${lead.group}" – rename the group first`,
          {
            profile: id,
            point: src,
            group: at.group,
            leading: lead.group,
          },
        );
      else {
        const mapped = ifaces.get(id)!.get(at.iface.id);
        const back = reverse.get(id)!.get(lead.iface.id);
        const to = target(lead.iface.id);
        // two leading interfaces given the same base id
        const clash = [...reverse.get(input.leading)!.keys()].some((li) => li !== lead.iface.id && target(li) === to);
        if ((mapped && mapped !== to) || (back && back !== at.iface.id) || clash)
          fail(
            'interface',
            `Data point "${src}" of "${names.get(id)}" is on interface "${at.iface.id}", which other shared data points place elsewhere – a base interface stands for one interface of each profile`,
            { profile: id, point: src, interface: at.iface.id },
          );
        else {
          // the ids it gets: the interface's and the data point's (the rename core's rules: free in the family, no old id of another)
          const renames: [kind: 'interface' | 'data_point', from: string, to: string][] = [];
          if (!mapped && at.iface.id !== to) renames.push(['interface', at.iface.id, to]);
          if (src !== bp.id) renames.push(['data_point', src, bp.id]);
          for (const [kind, from, to] of renames) {
            const c = checkRename(kind, id, from, to);
            if (c.problem)
              fail(
                'id_taken',
                `${kind === 'interface' ? 'Interface' : 'Data point'} "${from}" of "${names.get(id)}" cannot get the id "${to}": ${c.problem.message}`,
                {
                  profile: id,
                  point: src,
                  id: to,
                },
              );
          }
        }
      }
    }
    if (!lead && !problem)
      fail('missing', `The leading profile has no data point "${bp.from[input.leading] ?? bp.id}"`, { profile: input.leading, point: bp.id });
    points.set(bp.id, problem);
    if (problem || !lead) continue;
    for (const id of ids) {
      const at = where.get(id)!.get(bp.from[id]!)!;
      used.get(id)!.add(bp.from[id]!);
      ifaces.get(id)!.set(at.iface.id, target(lead.iface.id));
      reverse.get(id)!.set(lead.iface.id, at.iface.id);
    }
  }
  // a base id given twice
  const counts = new Map<string, number>();
  for (const bp of input.points) counts.set(bp.id, (counts.get(bp.id) ?? 0) + 1);
  for (const [id, n] of counts)
    if (n > 1 && points.get(id) === null) points.set(id, { code: 'twice', message: `The base data point "${id}" is given twice`, params: { point: id } });
  const ok = out();
  if (!problems.length && !ok.ok.length) say('no_points', 'Choose at least one data point every profile can share');
  // an interface with a shared data point whose renames were refused is not mapped
  for (const [id, m] of ifaces) for (const from of [...m.keys()]) if (!ok.ok.some((bp) => where.get(id)!.get(bp.from[id]!)?.iface.id === from)) m.delete(from);
  return ok;
}

// ---------- the model before and after ----------

/** A model's interfaces as one text: sorted (the order may change), ids renamed as mapped. */
function fingerprint(interfaces: PlantInterface[], ifaceIds: Map<string, string>, pointIds: Map<string, string>): string {
  const byKey = <T>(list: T[], key: (x: T) => string) => [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return stable(
    byKey(
      interfaces.map((i) => ({
        ...i,
        id: ifaceIds.get(i.id) ?? i.id,
        groups: byKey(
          i.groups.map((g) => ({
            ...g,
            dataPoints: byKey(
              g.dataPoints.map((d) => ({ ...d, id: pointIds.get(d.id) ?? d.id })),
              (d) => d.id,
            ),
          })),
          (g) => g.name,
        ),
        fileSets: byKey(i.fileSets, (f) => f.id),
      })),
      (i) => i.id,
    ),
  );
}

// ---------- building the base and the profiles' own parts ----------

/** The base as named in the input, without interfaces (the preview of a refused extraction). */
const buildEmpty = (input: PlantExtractInput): PlantProfileValues => ({
  id: input.id,
  name: input.name,
  manufacturer: '',
  model: '',
  version: '',
  category: '',
  description: input.description,
  notes: '',
  interfaces: [],
  extends: null,
  template: input.template,
  interfaceOverrides: [],
  pointOverrides: [],
});

function buildBase(input: PlantExtractInput, own: OwnProfiles, shared: string[]): PlantProfileValues {
  const ids = [...new Set(input.profiles)];
  const lead = own.get(input.leading)!;
  const at = new Map(ids.map((id) => [id, located(own.get(id)!)]));
  const sharedSet = new Set(shared);
  const interfaces: PlantInterface[] = [];
  for (const li of lead.interfaces) {
    // 0.13: the profiles' interfaces of different protocols share one of protocol "other", without addresses
    const theirs = ids.map((id) => own.get(id)!.interfaces.find((x) => x.id === li.id)).filter((x) => !!x);
    const mixed = theirs.some((x) => x.protocol !== li.protocol);
    const groups = li.groups
      .map((g) => {
        const pts = g.dataPoints.filter((d) => sharedSet.has(d.id));
        if (!pts.length) return null;
        const descriptions = ids.map(
          (id) =>
            own
              .get(id)!
              .interfaces.find((x) => x.id === li.id)
              ?.groups.find((x) => x.name === g.name)?.description ?? '',
        );
        return {
          name: g.name,
          description: agree(descriptions, ''),
          dataPoints: pts.map((d): PlantDataPoint => {
            const all = ids.map((id) => at.get(id)!.get(d.id)!.point);
            return {
              id: d.id,
              name: d.name,
              description: d.description,
              dataType: d.dataType,
              unit: d.unit,
              address: mixed
                ? ''
                : agree(
                    all.map((x) => x.address),
                    '',
                  ),
              access: d.access,
              updateRateMs: agree(
                all.map((x) => x.updateRateMs),
                null,
              ),
              enumValues: [...d.enumValues],
              aliases: agree(
                all.map((x) => x.aliases),
                [],
              ),
              notes: agree(
                all.map((x) => x.notes),
                '',
              ),
              publications: agree(
                all.map((x) => x.publications),
                [],
              ),
            };
          }),
        };
      })
      .filter((g) => g !== null);
    if (!groups.length) continue;
    const base: PlantInterface = { ...structuredClone(li), groups, fileSets: [] };
    if (mixed) {
      base.protocol = 'other';
      // what every profile's interface agrees on; the rest each profile sets
      base.defaultPort = agree(
        theirs.map((x) => x.defaultPort),
        null,
      );
      base.version = agree(
        theirs.map((x) => x.version),
        '',
      );
      base.client = agree(
        theirs.map((x) => x.client),
        '',
      );
    }
    interfaces.push(base);
  }
  const field = (k: 'manufacturer' | 'model' | 'version' | 'category') =>
    agree(
      ids.map((id) => own.get(id)![k]),
      '',
    );
  return {
    id: input.id,
    name: input.name,
    manufacturer: field('manufacturer'),
    model: field('model'),
    version: field('version'),
    category: field('category'),
    description: input.description,
    notes: '',
    interfaces,
    extends: null,
    template: input.template,
    interfaceOverrides: [],
    pointOverrides: [],
  };
}

/** A profile's own part once it extends the base: what it does not share, and what differs from the base. */
function ownPartOver(p: PlantProfileValues, base: PlantProfileValues): PlantProfileValues {
  const baseIfaces = new Map(base.interfaces.map((i) => [i.id, i]));
  const shared = new Set(pointsOf(base).map((x) => x.point.id));
  const basePoints = located(base);
  const interfaceOverrides: PlantInterfaceOverride[] = [];
  for (const bi of base.interfaces) {
    const mine = p.interfaces.find((i) => i.id === bi.id)!;
    const o: Record<string, unknown> = { interface: bi.id, present: true };
    for (const k of PROFILE_INTERFACE_FIELDS) if (stable(mine[k]) !== stable(bi[k])) o[k] = structuredClone(mine[k]);
    const groups: PlantInterfaceOverride['groups'] = [];
    for (const g of mine.groups) {
      const rest = g.dataPoints.filter((d) => !shared.has(d.id));
      const bg = bi.groups.find((x) => x.name === g.name);
      if (bg) {
        const description = g.description !== bg.description ? g.description : '';
        if (rest.length || description) groups.push({ name: g.name, description, dataPoints: structuredClone(rest) });
      } else groups.push(structuredClone({ ...g, dataPoints: rest }));
    }
    interfaceOverrides.push({ ...(o as unknown as PlantInterfaceOverride), groups, fileSets: structuredClone(mine.fileSets) });
  }
  const pointOverrides: PlantProfilePointOverride[] = [];
  const mineAt = located(p);
  for (const id of shared) {
    const mine = mineAt.get(id)!.point;
    const theirs = basePoints.get(id)!.point;
    const fields = PROFILE_POINT_FIELDS.filter((k) => stable(mine[k]) !== stable(theirs[k]));
    if (!fields.length) continue;
    const o: Record<string, unknown> = { dataPoint: id, present: true };
    for (const k of fields) o[k] = structuredClone(mine[k]);
    pointOverrides.push(o as unknown as PlantProfilePointOverride);
  }
  return {
    ...p,
    extends: base.id,
    interfaces: p.interfaces.filter((i) => !baseIfaces.has(i.id)),
    interfaceOverrides,
    pointOverrides,
  };
}

// ---------- preview and apply ----------

/**
 * The extraction inside a transaction (the caller rolls it back for a preview): renames, the base, the profiles'
 * own parts, the comparison of every model before and after. Fills the preview; throws only on a fault.
 */
function run(input: PlantExtractInput, by: string, write: boolean): PlantExtractPreview {
  const own0 = ownProfiles();
  const a = analyse(input, own0);
  const ids = [...new Set(input.profiles)];
  const preview: PlantExtractPreview = {
    base: { ...buildEmpty(input) },
    points: input.points.map((p) => ({ id: p.id, problem: a.points.get(p.id) ?? null })),
    profiles: [],
    problems: a.problems,
    ok: false,
  };
  // the second entry of a base id twice is judged with the first
  if (a.problems.length) return preview;
  const v = visibleAssets();
  const res0 = resolveAll(own0);
  const assignments = allAssignments();
  // per profile: the renames (interface, data point) as mapped
  const ifaceRen = new Map(ids.map((id) => [id, new Map([...a.ifaces.get(id)!].filter(([f, t]) => f !== t))]));
  const pointRen = new Map(ids.map((id) => [id, new Map(a.ok.filter((bp) => bp.from[id] !== bp.id).map((bp) => [bp.from[id]!, bp.id]))]));
  // the models before: every profile of the families and every asset with one of them
  const families = new Map(ids.map((id) => [id, profileFamily(id)]));
  const familyOf = new Map<string, string>();
  for (const [id, f] of families) for (const x of f) familyOf.set(x, id);
  const before = new Map<string, string>();
  for (const [pid, top] of familyOf) before.set(`profile:${pid}`, fingerprint(res0.get(pid)?.interfaces ?? [], ifaceRen.get(top)!, pointRen.get(top)!));
  for (const [assetId, x] of assignments) {
    const top = x.profileId ? familyOf.get(x.profileId) : undefined;
    if (!top) continue;
    before.set(`asset:${assetId}`, fingerprint(assetModel(x, res0.get(x.profileId!)).interfaces, ifaceRen.get(top)!, pointRen.get(top)!));
  }

  // 1. the ids as the base has them (the rename core: references follow, the old id stays an alias)
  const renames = new Map(ids.map((id) => [id, [] as PlantExtractPreview['profiles'][number]['renames']]));
  for (const id of ids) {
    for (const [from, to] of ifaceRen.get(id)!) {
      const counts = renameEntry({ kind: 'interface', scope: id, from, to }, by);
      renames.get(id)!.push({ kind: 'interface', from, to, references: counts.reduce((n, c) => n + c.count, 0) });
    }
    for (const [from, to] of pointRen.get(id)!) {
      const counts = renameEntry({ kind: 'data_point', scope: id, from, to }, by);
      renames.get(id)!.push({ kind: 'data_point', from, to, references: counts.reduce((n, c) => n + c.count, 0) });
    }
  }

  // 2. the base and the profiles' own parts, with the rules of a save
  const own1 = ownProfiles();
  const base = buildBase(
    input,
    own1,
    a.ok.map((p) => p.id),
  );
  preview.base = base;
  const rules: string[] = [];
  const fail = (who: string) => (problems: { path: string; message: string }[]) => rules.push(`${who}: ${problems[0]!.path}: ${problems[0]!.message}`);
  const work = new Map(own1);
  const savedBase = checkedProfile(structuredClone(base), work, fail(`Base "${base.id}"`));
  const derived = ids.map((id) => {
    return checkedProfile(ownPartOver(own1.get(id)!, base), work, fail(`Device profile "${id}"`));
  });
  for (const id of ids) {
    const d = derived.find((x) => x.id === id)!;
    preview.profiles.push({
      id,
      name: d.name,
      renames: renames.get(id)!,
      pointOverrides: d.pointOverrides.map((o) => ({ dataPoint: o.dataPoint, fields: PROFILE_POINT_FIELDS.filter((k) => k in o) })),
      interfaceOverrides: d.interfaceOverrides.map((o) => ({
        interface: o.interface,
        fields: [
          ...PROFILE_INTERFACE_FIELDS.filter((k) => k in o),
          ...(o.groups.some((g) => g.dataPoints.length) ? ['dataPoints'] : []),
          ...(o.fileSets.length ? ['fileSets'] : []),
        ],
      })),
      own: {
        interfaces: d.interfaces.length,
        points: pointsOf(d).length + d.interfaceOverrides.reduce((n, o) => n + o.groups.reduce((m, g) => m + g.dataPoints.length, 0), 0),
      },
      assets: [...assignments].filter(([assetId, x]) => x.profileId === id && v.assets.has(assetId)).length,
    });
  }
  if (rules.length) {
    preview.problems.push({ code: 'rules', message: rules[0]!, params: { message: rules[0]! } });
    return preview;
  }

  // 3. written, and every model compared with the one before
  const at = nowIso();
  upsertProfile(savedBase, { at, by });
  for (const d of derived) upsertProfile(d, { at, by }, { keepSource: true });
  const res2 = resolveAll(ownProfiles());
  const changed: string[] = [];
  for (const [pid] of familyOf)
    if (fingerprint(res2.get(pid)?.interfaces ?? [], new Map(), new Map()) !== before.get(`profile:${pid}`)) changed.push(`profile ${pid}`);
  for (const [assetId, x] of allAssignments()) {
    const key = `asset:${assetId}`;
    if (!before.has(key)) continue;
    if (fingerprint(assetModel(x, res2.get(x.profileId ?? '')).interfaces, new Map(), new Map()) !== before.get(key))
      changed.push(v.assets.has(assetId) ? `asset ${assetId}` : 'an asset');
  }
  if (changed.length) {
    preview.problems.push({
      code: 'rules',
      message: `The model of ${changed.slice(0, 3).join(', ')} would change – nothing is changed`,
      params: { message: `The model of ${changed.slice(0, 3).join(', ')} would change` },
    });
    return preview;
  }
  preview.ok = preview.points.every((p) => !p.problem);
  if (write && preview.ok) {
    const renamed = [...renames].flatMap(([id, list]) => list.map((r) => ({ profile: id, ...r })));
    audit({
      action: 'device_profile.base_extracted',
      entityType: 'device_profile',
      entityId: base.id,
      summary: `Base profile "${base.name}" (${base.id}) extracted from ${ids.map((id) => `"${own0.get(id)!.name}"`).join(', ')}: ${a.ok.length} data points, ${renamed.length} ids changed (the old ids still lead to them)`,
      details: { profiles: ids, leading: input.leading, template: base.template, points: a.ok.map((p) => p.id), renames: renamed.slice(0, 150) },
    });
  }
  return preview;
}

/** POST /api/plant/profiles/extract-base/preview: what the extraction would do, without doing it. */
export function previewExtract(input: z.infer<typeof extractInput>): PlantExtractPreview {
  const by = requireCatalogue();
  return dryRun(() => run(input, by, false));
}

/** POST /api/plant/profiles/extract-base: extracts the base in one transaction; refused (nothing changed) while anything is refused. */
export function extractBase(input: z.infer<typeof extractInput>): PlantExtractPreview {
  const by = requireCatalogue();
  if (Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM plant_profiles')!.n) >= L.profiles)
    throw new HttpError(409, `At most ${L.profiles} device profiles`, 'PLANT_LIMIT', { max: L.profiles });
  class Refused extends Error {
    constructor(readonly preview: PlantExtractPreview) {
      super('refused');
    }
  }
  try {
    return db().tx(() => {
      const p = run(input, by, true);
      if (!p.ok) throw new Refused(p);
      return p;
    });
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const first = e.preview.problems[0] ?? e.preview.points.find((p) => p.problem)?.problem;
    throw new HttpError(409, first?.message ?? 'The base profile cannot be extracted', 'PLANT_EXTRACT_REFUSED', {
      code: first?.code ?? 'rules',
      message: first?.message ?? '',
    });
  }
}

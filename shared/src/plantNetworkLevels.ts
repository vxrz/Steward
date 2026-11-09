import { ZONE_LEVELS, type ZoneLevel } from './plantNetwork.js';

/**
 * The level of every zone of a site for the OT network diagram (#230): the level the zone documents, else one derived
 * from what is known – for drawing only, nothing is stored. Bottom to top, as in the Purdue model: field devices,
 * control (cells), supervisory, operations, the DMZ, the enterprise network, external parties.
 *
 * 1. a zone's own level (`set`);
 * 2. its name and description, or a VLAN of the type `dmz` (`name`): "DMZ", "SCADA", "MES", "office", "cloud" …;
 * 3. a zone with assets on its VLANs is on the control level (`assets`);
 * 4. a zone without assets: reached from a zone with assets through conduits only past a DMZ – the enterprise side
 *    (`conduits`); otherwise between the cells and the DMZ, on the operations level (`default`).
 */

export type ZoneLevelSource = 'set' | 'name' | 'assets' | 'conduits' | 'default';

export interface ZoneLevelOf {
  level: ZoneLevel;
  source: ZoneLevelSource;
}

/** The level's place, bottom (0) to top. */
export const zoneLevelRank = (l: ZoneLevel): number => ZONE_LEVELS.indexOf(l);

// most specific first: a "DMZ of the office" is a DMZ, a "SCADA control room" supervisory, not control; English
// words whole, German compounds ("Fertigungszellen") inside words
const HINTS: [ZoneLevel, RegExp][] = [
  ['dmz', /\bdmz\b|demilitari[sz]ed|perimeter|grenznetz/i],
  ['external', /\b(cloud|internet|vendors?|suppliers?|remote access|third[- ]party|external)\b|lieferant|fernwartung|extern/i],
  ['enterprise', /\b(enterprise|office|corporate|business|erp)\b|unternehmen|büro|verwaltung/i],
  ['supervisory', /\b(scada|hmi|supervis\w*|control room|dcs)\b|leitstand|leitwarte|prozessleit/i],
  ['operations', /\b(mes|historian|operations|site ops)\b|betriebsf/i],
  ['field', /\b(field|sensors?|instrumentation)\b|feldebene|feldger/i],
  ['control', /\b(cells?|plcs?|sps|machines?|lines?|production|assembly|safety|sis|robots?)\b|zelle|fertigung|produktion|montage|maschine|roboter|linie/i],
];
/** "IT" in capitals only (not the English word "it") */
const IT = /\bIT\b/;

export function zoneLevels(
  zones: { id: string; name: string; description: string; level: ZoneLevel | null; vlans: string[] }[],
  o: {
    /** The type of each VLAN of the site (production, dmz …) */
    vlanType: Map<string, string>;
    /** Zones with an asset on one of their VLANs */
    withAssets: Set<string>;
    conduits: { zones: [string, string] }[];
  },
): Map<string, ZoneLevelOf> {
  const out = new Map<string, ZoneLevelOf>();
  for (const z of zones) {
    if (z.level) {
      out.set(z.id, { level: z.level, source: 'set' });
      continue;
    }
    const text = `${z.name} ${z.description}`;
    const hint = z.vlans.some((v) => o.vlanType.get(v)?.toLowerCase() === 'dmz')
      ? 'dmz'
      : (HINTS.find(([, re]) => re.test(text))?.[0] ?? (IT.test(text) ? 'enterprise' : undefined));
    if (hint) out.set(z.id, { level: hint, source: 'name' });
    else if (o.withAssets.has(z.id)) out.set(z.id, { level: 'control', source: 'assets' });
  }
  // the rest: from the zones with assets through the conduits – past a DMZ is the enterprise side
  const next = new Map<string, string[]>();
  for (const c of o.conduits) {
    const [a, b] = c.zones;
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  const isDmz = (id: string) => out.get(id)?.level === 'dmz';
  const near = new Set<string>();
  const queue = zones.filter((z) => o.withAssets.has(z.id)).map((z) => z.id);
  for (const id of queue) near.add(id);
  while (queue.length) {
    const id = queue.shift()!;
    if (isDmz(id)) continue; // do not pass a DMZ
    for (const x of next.get(id) ?? [])
      if (!near.has(x)) {
        near.add(x);
        queue.push(x);
      }
  }
  // what is reached past a DMZ
  const far = new Set<string>();
  const past = [...near].filter(isDmz);
  for (const id of past) far.add(id);
  while (past.length) {
    const id = past.shift()!;
    for (const x of next.get(id) ?? [])
      if (!near.has(x) && !far.has(x)) {
        far.add(x);
        past.push(x);
      }
  }
  for (const z of zones)
    if (!out.has(z.id)) out.set(z.id, far.has(z.id) ? { level: 'enterprise', source: 'conduits' } : { level: 'operations', source: 'default' });
  return out;
}

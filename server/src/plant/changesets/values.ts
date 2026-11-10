import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { parseJson } from '../../util.js';

/**
 * How the values of the plant history and the import's baselines are stored (0.15.0, ADR 0020 "Performance"): JSON
 * text, and from 0.15.0 a value of 96 characters or more compressed – `z1:` and the base64 of its raw DEFLATE
 * (RFC 1951, node:zlib) with the preset dictionary below – when that is shorter. Text, so the same on SQLite and
 * PostgreSQL (whose own compression of text starts at 2 kB); rows written before 0.15.0 are plain JSON and stay
 * readable as they are. Every reader goes through `historyText` / `historyValues`; hashes are over the JSON text (the
 * audit entry's historySha256 is verified against the decoded rows, see track.ts `historySha256Of`).
 */

const PREFIX = 'z1:';
/** Shorter values are kept as they are (a field or two of a change: compressing gains nothing) */
const MIN = 96;

/**
 * The preset dictionary of `z1:`: the shape of each kind's values (its keys, empty values), the most frequent kinds
 * last. Never change it – a value written with it is read with it; a new dictionary is a new prefix (`z2:`).
 */
const DICTIONARY = Buffer.from(
  [
    '{"id":"","name":"","names":{},"category":"","type":"","description":"","formula":"","unit":"","rangeMin":null,"rangeMax":null,"trend":null,"timing":null,"audience":[],"methodology":null,"strategy":"","implementation":"","dynamicColumns":false,"rollUp":"","inputs":[{"kind":"","profile":"","dataPoints":[""],"notes":""}],"parameters":[],"columns":[],"computation":{"summary":"","diagram":"","steps":[],"identities":[],"limits":[]},"notes":""}',
    '{"id":"","name":"","manufacturer":"","model":"","version":"","category":"","description":"","notes":"","interfaces":[{"id":"","name":"","protocol":"","direction":"","description":"","version":"","defaultPort":null,"authentication":"","client":"","notes":"","groups":[{"name":"","description":"","dataPoints":[{"id":"","name":"","description":"","dataType":"","unit":"","address":"","access":"","updateRateMs":null,"enumValues":[],"aliases":[],"notes":"","publications":[]}]}],"fileSets":[]}],"extends":null,"template":false,"interfaceOverrides":[],"pointOverrides":[]}',
    '{"id":"","code":"","name":"","names":{},"description":"","geo":null,"contacts":[],"refs":[],"fields":{}}',
    '{"id":"","name":"","names":{},"kind":"","parentId":null,"description":"","fields":{}}',
    '{"id":"","level":"","parentId":null,"name":"","names":{},"type":"","domain":"","buildingId":null,"description":"","fields":{}}',
    '{"id":"","name":"","vid":0,"type":"","owner":"","description":"","subnets":[{"cidr":"","gateway":"","description":"","ranges":[]}],"restricted":false,"managedBy":"","rulesAt":"","sites":[],"location":"","segmentId":null,"notes":""}',
    '{"id":"","name":"","description":"","criticality":null,"level":"","vlans":[""],"owner":"","slTarget":null,"riskAssessment":"","assessedAt":null,"notes":""}',
    '{"id":"","name":"","description":"","zones":[""],"direction":"","protocols":[""],"controls":[],"notes":""}',
    '{"checks":[]}',
    '{"id":"","name":"","collector":{"kind":"","ref":"","host":null},"dataPathId":null,"interfaceId":"","mode":"","intervalMs":0,"debounceMs":null,"triggers":[],"composition":"","destination":null,"sinks":[],"access":{"read":[],"write":[],"create":[],"delete":[]},"settings":[],"items":[{"address":"","outputName":"","outputType":"","dataPoint":null,"transform":{"note":"","scale":null,"offset":null,"cast":""},"description":"","notes":""}],"description":"","notes":"","format":"","sourceFile":""}',
    '{"id":"","subject":"","description":"","devices":[""],"collector":{"kind":"","ref":"","host":null},"transfers":[{"protocol":"","mode":"","peerKind":"","peer":"","port":0,"notes":""}],"destinations":[{"kind":"","ref":"","path":"","notes":""}],"notes":""}',
    '{"profileId":"","firmware":"","interfaces":[{"interface":"","active":true,"endpoint":"","notes":""}],"overrides":[],"additions":{"interfaces":[],"dataPoints":[]},"publications":[],"kpis":[],"notes":""}',
    '{"id":"","hostname":"","domain":"","purpose":"","mac":"","serial":"","vlan":"","addressType":"","address":"","switch":"","switchPort":"","wallOutlet":"","cmdbPort":"","state":"","flags":[],"confidence":null,"owner":"","monitoring":"","checks":[],"notes":""}',
    '{"id":"","siteId":"","areaId":"","workCenterId":"","workUnitId":"","buildingId":null,"name":"","manufacturer":"","model":"","status":"","parentId":null,"domain":"","processArea":"","role":"","tags":[""],"commissioned":null,"endOfSupport":null,"description":"","capabilities":[],"imageName":"","refs":[],"fields":{}}',
  ].join(''),
);

/** A value as stored: its JSON text, compressed when that is shorter. */
export function storedValues(json: string): string {
  if (json.length < MIN) return json;
  const z = PREFIX + deflateRawSync(json, { dictionary: DICTIONARY }).toString('base64');
  return z.length < json.length ? z : json;
}

/** The JSON text of a stored value (as written: plain JSON, or `z1:` decompressed). */
export function historyText(stored: string | null | undefined): string {
  if (typeof stored !== 'string') return '';
  if (!stored.startsWith(PREFIX)) return stored;
  return inflateRawSync(Buffer.from(stored.slice(PREFIX.length), 'base64'), { dictionary: DICTIONARY }).toString('utf8');
}

/** The values of a stored value (the fallback when it is not JSON). */
export function historyValues<T>(stored: string | null | undefined, fallback: T): T {
  let text: string;
  try {
    text = historyText(stored);
  } catch {
    return fallback;
  }
  return parseJson<T>(text, fallback);
}

/** Whether a stored value is compressed. */
export const isCompressed = (stored: string | null | undefined): boolean => typeof stored === 'string' && stored.startsWith(PREFIX);

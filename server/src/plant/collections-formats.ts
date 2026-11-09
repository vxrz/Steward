import {
  type CollectionFormat,
  type CollectionMode,
  type PlantCollectionAccess,
  PLANT_COLLECTION_LIMITS as L,
  type PlantCollectionImportProblem,
  type PlantCollectionItem,
  type PlantCollectionSink,
  type PlantCollectionTrigger,
  type PlantSinkTransform,
  type SinkTransformKind,
} from '@sm/shared';
import { csvCells } from './collections-redact.js';
import { idOf } from './collections-model.js';

/**
 * The importers of data collections (0.11.0, docs/adr/0019-data-collections.md): each reads a collector's
 * configuration into collections of items – address, output name and type, transform – without data points (the
 * mapping is collections-import.ts). Formats are recognised by their structure, never by a product name or the value
 * of a `type` key. Nothing is executed (Node-RED function code is kept as text, never run) and no credentials are read.
 * Since 0.12 the importers also fill the sinks – where the data goes – where the format names them.
 */

/** A sink as an importer found it. */
export const sinkOf = (name: string, x: Partial<PlantCollectionSink> = {}): PlantCollectionSink => ({
  id: idOf(name),
  name: name.slice(0, L.text) || 'sink',
  kind: 'other',
  ref: '',
  object: '',
  format: '',
  schedule: '',
  owner: '',
  description: '',
  transforms: [],
  mappings: [],
  imported: true,
  ...x,
});
const step = (kind: SinkTransformKind, x: Partial<PlantSinkTransform> = {}): PlantSinkTransform => ({
  kind,
  field: '',
  expression: '',
  window: '',
  function: '',
  description: '',
  ...x,
});
/** A sink added to a collection once (by id); a second one with the same id gets "-2", "-3" … */
const addSink = (c: ParsedCollection, sk: PlantCollectionSink): PlantCollectionSink => {
  const same = c.sinks.find((x) => x.name === sk.name && x.object === sk.object && x.ref === sk.ref);
  if (same) return same;
  let id = sk.id;
  for (let n = 2; c.sinks.some((x) => x.id === id); n++) id = `${sk.id}-${n}`.slice(0, 80);
  const out = { ...sk, id };
  if (c.sinks.length < L.sinks) c.sinks.push(out);
  return out;
};
const itemKey = (it: Pick<PlantCollectionItem, 'outputName' | 'address'>) => it.outputName || it.address;

export interface ParsedCollection {
  name: string;
  mode: CollectionMode;
  intervalMs: number | null;
  debounceMs: number | null;
  triggers: PlantCollectionTrigger[];
  composition: string;
  /** Where the data goes (0.12): the sinks the file names, with their transformations and item mapping */
  sinks: PlantCollectionSink[];
  access: PlantCollectionAccess;
  settings: { key: string; value: string }[];
  items: PlantCollectionItem[];
  notes: string;
}

export interface ParsedFile {
  format: CollectionFormat;
  collections: ParsedCollection[];
}

type Problem = PlantCollectionImportProblem;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).trim();
const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const emptyAccess = (): PlantCollectionAccess => ({ read: [], write: [], create: [], delete: [] });
const item = (address: string, outputName: string, outputType = '', note = '', notes = ''): PlantCollectionItem => ({
  address,
  outputName,
  outputType,
  dataPoint: null,
  transform: { note, scale: null, offset: null, cast: '' },
  notes,
});
const base = (name: string): ParsedCollection => ({
  name,
  mode: 'interval',
  intervalMs: null,
  debounceMs: null,
  triggers: [],
  composition: '',
  sinks: [],
  access: emptyAccess(),
  settings: [],
  items: [],
  notes: '',
});

// ---------- recognising ----------

/** Gateway JSON: datasets that hold data points with addresses. */
const isGateway = (v: unknown) =>
  isObj(v) &&
  Array.isArray(v.datasets) &&
  v.datasets.some((d) => isObj(d) && Array.isArray(d.datapoints) && d.datapoints.some((p) => isObj(p) && 'address' in p));
/** A Node-RED flow export: an array of nodes with id and type, wired to each other. */
const isNodeRed = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((n) => isObj(n) && typeof n.id === 'string' && typeof n.type === 'string');
/** An Industrial Edge OPC UA connector export: UIConfig.datapoints.OPCUA[] with tags. */
const isIeOpcUa = (v: unknown) => isObj(v) && isObj(v.UIConfig) && isObj(v.UIConfig.datapoints) && Array.isArray((v.UIConfig.datapoints as Obj).OPCUA);

export function detectFormat(name: string, content: string, parsed: unknown): CollectionFormat | null {
  if (isGateway(parsed)) return 'gateway_json';
  if (isIeOpcUa(parsed)) return 'ie_opcua';
  if (isNodeRed(parsed)) return 'node_red';
  if (/\.(csv|txt)$/i.test(name) || (parsed === undefined && /^[^\n]*[,;]/.test(content))) return 'table';
  if (Array.isArray(parsed) || (isObj(parsed) && Array.isArray(parsed.items))) return 'table';
  return null;
}

// ---------- gateway JSON: datasets of data points ----------

const GATEWAY_MODES: Record<string, CollectionMode> = { interval: 'interval', onchange: 'on_change', on_change: 'on_change', trigger: 'trigger' };

/** Keys that name where a sink writes – what it looks like, never a product or a type value. */
const TARGET_KEYS = ['topic', 'table', 'bucket', 'measurement', 'queue', 'stream', 'exchange', 'collection', 'aspect', 'index', 'path', 'filename', 'file'];
/** Keys that name the target system of a sink. */
const HOST_KEYS = ['broker', 'host', 'hostname', 'server', 'endpoint', 'url', 'uri', 'address', 'database'];
const FORMAT_KEYS = ['format', 'protocol', 'encoding', 'contentType', 'payloadFormat', 'serialization'];
const SCHEDULE_KEYS = ['interval', 'publishInterval', 'flushInterval', 'batch', 'batchSize', 'maxBatchSize', 'cycle', 'schedule', 'qos', 'retain'];
/** Sections of the gateway file that are not sinks (datasets, data points, triggers, access patterns). */
const GATEWAY_SECTIONS = new Set([
  'datasets',
  'datapoints',
  'triggers',
  'patterns',
  'whitelistedAddresses',
  'readPatterns',
  'writePatterns',
  'createPatterns',
  'deletePatterns',
  'eventsToIgnore',
]);

/** Target keys that need a host or format beside them to make a sink (a "path" alone is often a buffer or a log). */
const WEAK_TARGET_KEYS = new Set(['path', 'filename', 'file', 'collection', 'index']);
const has = (o: Obj, keys: readonly string[]) => keys.some((k) => typeof o[k] === 'string' && str(o[k]) !== '');

/** An object that looks like a sink: it names a target object (a topic, a table …), weak ones with a host or format. */
const sinkLike = (o: unknown): o is Obj =>
  isObj(o) &&
  (has(
    o,
    TARGET_KEYS.filter((k) => !WEAK_TARGET_KEYS.has(k)),
  ) ||
    (has(o, [...WEAK_TARGET_KEYS]) && (has(o, HOST_KEYS) || has(o, FORMAT_KEYS))));

/** A host or URL as a sink's target: the host of a URL (never its user information or path). */
const hostOf = (v: string): string => {
  try {
    const u = new URL(v);
    return u.host || v;
  } catch {
    return v;
  }
};

/** The sinks of a section of a gateway file: every object (or list of objects) under a key that looks like a sink. */
function gatewaySinks(o: Obj): PlantCollectionSink[] {
  const out: PlantCollectionSink[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (GATEWAY_SECTIONS.has(k)) continue;
    const list = Array.isArray(v) ? v.filter(sinkLike) : sinkLike(v) ? [v] : [];
    list.forEach((x, i) => {
      const target = TARGET_KEYS.find((t) => typeof x[t] === 'string' && str(x[t]));
      const host = HOST_KEYS.map((h) => str(x[h])).find(Boolean) ?? '';
      const name = str(x.name) || str(x.id) || (list.length > 1 ? `${k} ${i + 1}` : k);
      out.push(
        sinkOf(name, {
          ref: host ? hostOf(host) : '',
          object: target ? str(x[target]) : '',
          format: FORMAT_KEYS.map((f) => str(x[f])).find(Boolean) ?? '',
          schedule: SCHEDULE_KEYS.filter((s) => x[s] !== undefined && str(x[s]) !== '')
            .map((s) => `${s}: ${str(x[s])}`)
            .join(', '),
          description: `From the section "${k}" of the file`,
        }),
      );
    });
  }
  return out;
}

/** Keys of a data point that name its field in the sinks. */
const ITEM_TARGET_KEYS = ['target', 'targetName', 'field', 'column', 'topicSuffix'];

export function parseGateway(doc: Obj, file: string, problems: Problem[]): ParsedCollection[] {
  // the collector's access patterns and settings hold for every dataset of the file
  const access = emptyAccess();
  access.read.push(...strings(doc.readPatterns));
  access.write.push(...strings(doc.writePatterns));
  access.create.push(...strings(doc.createPatterns));
  access.delete.push(...strings(doc.deletePatterns));
  for (const p of Array.isArray(doc.patterns) ? doc.patterns : []) {
    if (!isObj(p) || !str(p.path)) continue;
    for (const k of ['read', 'write', 'create', 'delete'] as const) if (p[k] === true && !access[k].includes(str(p.path))) access[k].push(str(p.path));
  }
  const settings: { key: string; value: string }[] = [];
  if (doc.type !== undefined) settings.push({ key: 'type', value: str(doc.type) });
  for (const k of ['bufferEnabled', 'maxBufferSize', 'plcTimeSync', 'sendEvents'] as const)
    if (doc[k] !== undefined) settings.push({ key: k, value: str(doc[k]) });
  if (doc.eventsToIgnore !== undefined) settings.push({ key: 'eventsToIgnore', value: strings(doc.eventsToIgnore).join(', ') || str(doc.eventsToIgnore) });
  const white = (Array.isArray(doc.whitelistedAddresses) ? doc.whitelistedAddresses : [])
    .filter(isObj)
    .map((w) => [str(w.address), str(w.type)].filter(Boolean).join(' '));
  if (white.length) settings.push({ key: 'whitelistedAddresses', value: white.join(', ') });
  const fileSinks = gatewaySinks(doc);
  const out: ParsedCollection[] = [];
  (doc.datasets as unknown[]).forEach((d, i) => {
    if (!isObj(d)) return void problems.push({ file, path: `datasets[${i}]`, message: 'Expected a dataset (a mapping)' });
    const c = base(str(d.name) || `dataset ${i + 1}`);
    const mode = str(d.mode).toLowerCase();
    c.mode = GATEWAY_MODES[mode] ?? (mode ? 'other' : 'interval');
    c.intervalMs = num(d.interval);
    c.debounceMs = num(d.debounce);
    c.composition = str(d.triggercomposition);
    c.triggers = (Array.isArray(d.triggers) ? d.triggers : []).filter(isObj).map((t) => ({
      name: str(t.name),
      condition: str(t.condition),
      referencePoint: str(t.referenceDatapoint),
      referenceValue: str(t.referenceValue),
    }));
    if (c.triggers.length && c.mode === 'interval' && !d.interval) c.mode = 'trigger';
    c.access = structuredClone(access);
    c.settings = [...settings];
    for (const k of ['unavailable', 'new', 'readings'] as const) if (d[k] !== undefined) c.settings.push({ key: k, value: str(d[k]) });
    // sinks of the whole file and of this dataset (0.12)
    for (const sk of [...fileSinks, ...gatewaySinks(d)]) addSink(c, structuredClone(sk));
    (Array.isArray(d.datapoints) ? d.datapoints : []).forEach((p, j) => {
      if (!isObj(p) || !str(p.address))
        return void problems.push({ file, path: `datasets[${i}].datapoints[${j}].address`, message: 'Required (the address read)' });
      const it = item(str(p.address), str(p.name), str(p.type));
      c.items.push(it);
      const target = ITEM_TARGET_KEYS.map((k) => str(p[k])).find(Boolean);
      if (target) for (const sk of c.sinks) sk.mappings.push({ item: itemKey(it), target, transform: '' });
    });
    out.push(c);
  });
  return out;
}

// ---------- generic CSV / YAML ----------

/** CSV with a header row; "," or ";" between cells; quotes as RFC 4180. */
export function parseCsvRows(text: string): Record<string, string>[] {
  const [head, ...rest] = csvCells(text).rows;
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return rest.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

export const TABLE_COLUMNS = [
  'collection',
  'mode',
  'interval_ms',
  'debounce_ms',
  'source_address',
  'data_point',
  'output_name',
  'output_type',
  'transform',
  'destination',
  'notes',
  // 0.12: the sink a row's item goes to and its name there
  'sink',
  'target',
] as const;

const TABLE_MODES: Record<string, CollectionMode> = { interval: 'interval', on_change: 'on_change', onchange: 'on_change', trigger: 'trigger', other: 'other' };

/** Rows of the generic table (CSV rows, or YAML entries with the same keys): grouped into collections by `collection`. */
export function parseTable(rows: Record<string, unknown>[], file: string, problems: Problem[]): ParsedCollection[] {
  const out = new Map<string, ParsedCollection>();
  const untargeted: [ParsedCollection, PlantCollectionSink['mappings'][number]][] = [];
  if (rows.length && !Object.keys(rows[0]!).some((k) => (TABLE_COLUMNS as readonly string[]).includes(k)))
    problems.push({ file, path: 'line 1', message: `Expected a header row with the columns ${TABLE_COLUMNS.join(', ')}` });
  rows.forEach((r, i) => {
    const at = `line ${i + 2}`;
    const unknown = Object.keys(r).filter((k) => k && !(TABLE_COLUMNS as readonly string[]).includes(k));
    if (unknown.length && i === 0)
      problems.push({ file, path: 'line 1', message: `Unknown columns ${unknown.map((k) => `"${k}"`).join(', ')} (see docs/PLANT.md)` });
    const name = str(r.collection) || 'collection';
    let c = out.get(name);
    if (!c) {
      c = base(name);
      const mode = str(r.mode).toLowerCase();
      c.mode = TABLE_MODES[mode] ?? (mode ? 'other' : 'interval');
      c.intervalMs = num(r.interval_ms);
      c.debounceMs = num(r.debounce_ms);
      out.set(name, c);
    }
    const address = str(r.source_address);
    const point = str(r.data_point);
    if (!address && !point) return void problems.push({ file, path: at, message: 'Give source_address or data_point' });
    const it = item(address, str(r.output_name), str(r.output_type), str(r.transform), str(r.notes));
    if (point) it.dataPoint = point;
    c.items.push(it);
    // the sink of the row (0.12): its own column, else the destination (0.11) as one
    const sinkName = str(r.sink) || str(r.destination);
    if (sinkName) {
      const sk = addSink(c, sinkOf(sinkName, { ref: str(r.destination) }));
      if (str(r.target) || str(r.transform)) sk.mappings.push({ item: itemKey(it), target: str(r.target), transform: str(r.transform) });
    } else if (str(r.target)) untargeted.push([c, { item: itemKey(it), target: str(r.target), transform: str(r.transform) }]);
  });
  // a target without a sink: the item's name in every sink of its collection
  for (const [c, m] of untargeted) for (const sk of c.sinks) if (!sk.mappings.some((x) => x.item === m.item)) sk.mappings.push(m);
  return [...out.values()];
}

// ---------- Industrial Edge OPC UA connector (preview) ----------

const IE_MODES: Record<string, CollectionMode> = { cyclic: 'interval', cyclic_on_change: 'on_change', cyclic_onchange: 'on_change', onchange: 'on_change' };

/**
 * The connector's exported configuration: `UIConfig.datapoints.OPCUA[]` – one entry per connection with its server
 * (`OPCUAUrl`, `portNumber`) and `tags[]` (`name`, `address`, `dataType`, `acquisitionCycle`, `acquisitionMode`,
 * `accessMode`, `comments`). One collection per connection and acquisition cycle and mode. Sign-in data of the export
 * (user, password, certificate passwords) is never read.
 */
export function parseIeOpcUa(doc: Obj, file: string, problems: Problem[]): ParsedCollection[] {
  const out: ParsedCollection[] = [];
  const conns = ((doc.UIConfig as Obj).datapoints as Obj).OPCUA as unknown[];
  conns.forEach((c, i) => {
    if (!isObj(c)) return;
    const name = str(c.name) || `connection ${i + 1}`;
    const groups = new Map<string, ParsedCollection>();
    (Array.isArray(c.tags) ? c.tags : []).forEach((t, j) => {
      if (!isObj(t) || !str(t.address)) return void problems.push({ file, path: `UIConfig.datapoints.OPCUA[${i}].tags[${j}].address`, message: 'Required' });
      const cycle = num(t.acquisitionCycle);
      const mode = str(t.acquisitionMode);
      const key = `${cycle ?? ''}|${mode}`;
      let g = groups.get(key);
      if (!g) {
        g = base(name);
        g.mode = IE_MODES[mode.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()] ?? (mode ? 'other' : 'interval');
        g.intervalMs = cycle;
        // the Databus topic when the export names one (a key with "topic" in its name), else unknown
        const topic = Object.entries(c).find(([k, v]) => /topic/i.test(k) && typeof v === 'string' && v.trim())?.[1] as string | undefined;
        g.sinks = [
          sinkOf('Databus', {
            ref: 'Industrial Edge Databus',
            object: topic?.trim() ?? '',
            format: 'MQTT',
            description: topic ? '' : 'The connector publishes to the Databus; its export does not name the topic (unknown)',
          }),
        ];
        g.settings = [
          ...(str(c.OPCUAUrl) ? [{ key: 'server', value: [str(c.OPCUAUrl), str(c.portNumber)].filter(Boolean).join(':') }] : []),
          ...(['authenticationMode', 'securityPolicy', 'encryptionMode'] as const).filter((k) => str(c[k])).map((k) => ({ key: k, value: str(c[k]) })),
          ...(mode ? [{ key: 'acquisitionMode', value: mode }] : []),
        ];
        groups.set(key, g);
      }
      const access = str(t.accessMode).toLowerCase();
      if (access.includes('w')) g.access.write.push(str(t.address));
      g.items.push(item(str(t.address), str(t.name), str(t.dataType), '', str(t.comments)));
    });
    const many = groups.size > 1;
    for (const g of groups.values()) {
      if (many) g.name = `${name} · ${g.intervalMs ?? '–'} ms ${g.settings.find((s) => s.key === 'acquisitionMode')?.value ?? ''}`.trim();
      out.push(g);
    }
  });
  return out;
}

// ---------- Node-RED flow export ----------

const NR_SOURCE = /^(opcua-item|opcua item|s7 in|s7in|modbus-read|modbus-getter|modbus-flex-getter|mqtt in|amqp in|kafka-consumer)$/i;
const NR_SINK =
  /^(mqtt out|http request|file|file out|mysql|postgresql|postgres|mssql|influxdb out|influxdb batch|mongodb out|mongodb4|sqlite|tdengine|kafka-producer|amqp out|websocket out|tcp out|udp out)$/i;
const NR_TRANSFORM = /^(function|change|template|switch|range|json|csv|split|join)$/i;

const addressOf = (n: Obj): string => {
  const t = str(n.type).toLowerCase();
  if (t.startsWith('opcua')) return str(n.item);
  if (t.startsWith('modbus')) {
    const table = str(n.dataType).toLowerCase();
    const tbl = table.includes('coil')
      ? 'coil'
      : table.includes('input') && table.includes('register')
        ? 'input'
        : table.includes('input')
          ? 'discrete'
          : 'holding';
    const qty = num(n.quantity);
    return n.adr !== undefined ? `${tbl}:${str(n.adr)}${qty && qty > 1 ? `,${qty}` : ''}` : '';
  }
  if (t.startsWith('s7')) return str(n.variable);
  return str(n.topic);
};

const changeRules = (n: Obj): string =>
  (Array.isArray(n.rules) ? n.rules : [])
    .filter(isObj)
    .map((r) => {
      const p = `${str(r.pt) || 'msg'}.${str(r.p)}`;
      if (r.t === 'set') return `set ${p} to ${str(r.to)}`;
      if (r.t === 'change') return `change ${p}: ${str(r.from)} → ${str(r.to)}`;
      if (r.t === 'delete') return `delete ${p}`;
      if (r.t === 'move') return `move ${p} to ${str(r.to)}`;
      return str(r.t);
    })
    .join('; ');

/** A transformation node on the way to a sink: a note for the item, a step for the sink. */
interface NrStep {
  note: string;
  step: PlantSinkTransform;
}

const NR_STEP_KINDS: Record<string, SinkTransformKind> = {
  function: 'compute',
  change: 'rename',
  template: 'format',
  switch: 'filter',
  range: 'scale',
  json: 'format',
  csv: 'format',
  split: 'other',
  join: 'aggregate',
};

/**
 * A transformation node as a step. A function node's code is kept as text (documentation – Steward never runs it);
 * a change node's rules, a range node's scaling and a switch node's rules are described.
 */
function nodeRedStep(n: Obj, type: string): NrStep {
  const t = type.toLowerCase();
  const name = str(n.name);
  const label = `${t}${name ? ` "${name}"` : ''}`;
  const rules = t === 'change' ? changeRules(n) : '';
  const expression =
    t === 'function'
      ? str(n.func).slice(0, L.longText)
      : t === 'change'
        ? rules
        : t === 'template'
          ? str(n.template).slice(0, L.longText)
          : t === 'range'
            ? `${str(n.minin)}…${str(n.maxin)} → ${str(n.minout)}…${str(n.maxout)}`
            : t === 'switch'
              ? (Array.isArray(n.rules) ? n.rules : [])
                  .filter(isObj)
                  .map((r) => [str(r.t), str(r.v)].filter(Boolean).join(' '))
                  .join('; ')
              : '';
  const join =
    t === 'join'
      ? {
          window: [str(n.count) && `${str(n.count)} messages`, str(n.timeout) && `${str(n.timeout)} s`].filter(Boolean).join(', '),
          function: str(n.mode) || str(n.build),
        }
      : {};
  return {
    note: `${label}${rules ? ` (${rules})` : ''}`,
    step: step(NR_STEP_KINDS[t] ?? 'other', { field: str(n.property) || '', expression, description: `${label} (node ${str(n.id)})`, ...join }),
  };
}

/** The path of a URL (its host is the sink's target; user information is never kept). */
const urlPath = (v: string): string => {
  if (!v) return '';
  try {
    const u = new URL(v);
    return `${u.pathname}${u.search}`;
  } catch {
    return v;
  }
};

/**
 * The target of a sink node: the host of the config node it uses (a broker, a database server – any field that holds
 * the id of another node), else the host of its URL. Config nodes' `credentials` are never read.
 */
function nodeRedTarget(n: Obj, byId: Map<string, Obj>): string {
  for (const [k, v] of Object.entries(n)) {
    if (k === 'id' || k === 'z' || k === 'wires' || k === 'credentials' || typeof v !== 'string') continue;
    const cfg = byId.get(v);
    if (!cfg || cfg === n || Array.isArray(cfg.wires)) continue;
    const host = ['broker', 'host', 'hostname', 'server', 'url', 'hostUrl', 'database', 'db'].map((h) => str(cfg[h])).find(Boolean);
    if (host) {
      const port = str(cfg.port);
      const h = hostOf(host);
      return port && !h.includes(':') ? `${h}:${port}` : h;
    }
  }
  return str(n.url) ? hostOf(str(n.url)) : '';
}

/**
 * Source nodes (OPC UA items, S7 and Modbus reads, MQTT in …) are followed along their `wires` to sink nodes (MQTT out,
 * HTTP request, database and file nodes; `debug` ends a way without a sink). Each sink is a collection whose items are
 * the sources that reach it; function, change and template nodes on the way are transform notes. An inject node
 * before a source gives its interval. `credentials` of nodes are never read.
 */
export function parseNodeRed(nodes: Obj[], file: string, problems: Problem[]): ParsedCollection[] {
  const byId = new Map(nodes.map((n) => [str(n.id), n]));
  const upstream = new Map<string, string[]>();
  for (const n of nodes)
    for (const out of Array.isArray(n.wires) ? n.wires : [])
      for (const to of Array.isArray(out) ? out : []) upstream.set(str(to), [...(upstream.get(str(to)) ?? []), str(n.id)]);
  const collections = new Map<string, ParsedCollection>();
  const sources = nodes.filter((n) => NR_SOURCE.test(str(n.type)));
  if (!sources.length) problems.push({ file, path: '(flow)', message: 'No source nodes (OPC UA, S7, Modbus, MQTT in …) in this flow' });
  for (const src of sources) {
    // an inject node that triggers the source: its repeat is the interval
    const inject = (upstream.get(str(src.id)) ?? []).map((id) => byId.get(id)).find((n) => n && str(n.type) === 'inject');
    const unit = ({ ms: 0.001, s: 1, m: 60, h: 3600 } as Record<string, number>)[str(src.rateUnit)];
    // the inject node's repeat, or the source's own polling rate (Modbus read), in seconds
    const repeat = inject ? Number(str(inject.repeat)) : unit && str(src.rate) ? Number(str(src.rate)) * unit : NaN;
    // breadth first along the wires, at most 50 nodes deep; every way that ends in a sink is an item of that sink
    const queue: { id: string; via: NrStep[] }[] = (Array.isArray(src.wires) ? src.wires : []).flatMap((o) =>
      (Array.isArray(o) ? o : []).map((to) => ({ id: str(to), via: [] as NrStep[] })),
    );
    const seen = new Set<string>();
    while (queue.length) {
      const { id, via } = queue.shift()!;
      if (seen.has(id) || via.length > 50) continue;
      seen.add(id);
      const n = byId.get(id);
      if (!n) continue;
      const type = str(n.type);
      if (type === 'debug') continue;
      if (NR_SINK.test(type)) {
        const key = str(n.id);
        let c = collections.get(key);
        const object = str(n.topic) || urlPath(str(n.url)) || str(n.filename) || str(n.table) || str(n.measurement) || str(n.collection);
        if (!c) {
          c = base(str(n.name) || [type, object].filter(Boolean).join(' '));
          c.mode = / in$/i.test(str(src.type)) ? 'on_change' : 'interval';
          // the sink node is the collection's sink (0.12); its target: the config node's host, or the URL's host
          c.sinks = [
            sinkOf(str(n.name) || type, {
              ref: nodeRedTarget(n, byId),
              object,
              format: [type, str(n.method), str(n.ret)].filter(Boolean).join(' · '),
              description: `Node-RED ${type} node ${key}`,
            }),
          ];
          c.notes = `Node-RED: ${type} node ${key}`;
          collections.set(key, c);
        }
        if (Number.isFinite(repeat) && repeat > 0) c.intervalMs = c.intervalMs ?? Math.round(repeat * 1000);
        const it = item(
          addressOf(src),
          str(src.name) || str(src.topic) || str(src.item),
          str(src.datatype) || str(src.dataType),
          via.map((x) => x.note).join(' → '),
        );
        if (!c.items.some((x) => x.address === it.address && x.outputName === it.outputName)) c.items.push(it);
        // the transformation nodes on the way, as the sink's steps (in order, once each)
        const sk = c.sinks[0]!;
        for (const x of via)
          if (!sk.transforms.some((t) => t.description === x.step.description) && sk.transforms.length < L.transforms) sk.transforms.push(x.step);
        continue;
      }
      const st = NR_TRANSFORM.test(type) ? nodeRedStep(n, type) : null;
      const next = st ? [...via, st] : via;
      for (const o of Array.isArray(n.wires) ? n.wires : []) for (const to of Array.isArray(o) ? o : []) queue.push({ id: str(to), via: next });
    }
  }
  return [...collections.values()];
}

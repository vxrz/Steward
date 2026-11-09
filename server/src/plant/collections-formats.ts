import {
  PLANT_LIMITS,
  type CollectionFormat,
  type CollectionMode,
  type PlantCollectionAccess,
  type PlantCollectionDestination,
  type PlantCollectionImportProblem,
  type PlantCollectionItem,
  type PlantCollectionTrigger,
} from '@sm/shared';

/**
 * The importers of data collections (0.11.0, docs/adr/0019-data-collections.md): each reads a collector's
 * configuration into collections of items – address, output name and type, transform – without data points (the
 * mapping is collections-import.ts). Formats are recognised by their structure, never by a product name or the value
 * of a `type` key. Nothing is executed (Node-RED function code is named, never run) and no credentials are read.
 */

export interface ParsedCollection {
  name: string;
  mode: CollectionMode;
  intervalMs: number | null;
  debounceMs: number | null;
  triggers: PlantCollectionTrigger[];
  composition: string;
  destination: PlantCollectionDestination | null;
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
const item = (address: string, outputName: string, outputType = '', note = '', notes = '', description = ''): PlantCollectionItem => ({
  address,
  outputName,
  outputType,
  dataPoint: null,
  transform: { note, scale: null, offset: null, cast: '' },
  description,
  notes,
});
const base = (name: string): ParsedCollection => ({
  name,
  mode: 'interval',
  intervalMs: null,
  debounceMs: null,
  triggers: [],
  composition: '',
  destination: null,
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
    (Array.isArray(d.datapoints) ? d.datapoints : []).forEach((p, j) => {
      if (!isObj(p) || !str(p.address))
        return void problems.push({ file, path: `datasets[${i}].datapoints[${j}].address`, message: 'Required (the address read)' });
      c.items.push(item(str(p.address), str(p.name), str(p.type)));
    });
    out.push(c);
  });
  return out;
}

// ---------- generic CSV / YAML ----------

/** CSV with a header row; "," or ";" between cells; quotes as RFC 4180. */
export function parseCsvRows(text: string): Record<string, string>[] {
  const body = text.replace(/^\uFEFF/, '');
  const first = body.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') ((cell += '"'), i++);
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  const [head, ...rest] = rows;
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
  // 0.12.0: what the value is (optional)
  'description',
] as const;

const TABLE_MODES: Record<string, CollectionMode> = { interval: 'interval', on_change: 'on_change', onchange: 'on_change', trigger: 'trigger', other: 'other' };

/** Rows of the generic table (CSV rows, or YAML entries with the same keys): grouped into collections by `collection`. */
export function parseTable(rows: Record<string, unknown>[], file: string, problems: Problem[]): ParsedCollection[] {
  const out = new Map<string, ParsedCollection>();
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
      if (str(r.destination)) c.destination = { kind: 'other', ref: str(r.destination), path: '', notes: '' };
      out.set(name, c);
    }
    const address = str(r.source_address);
    const point = str(r.data_point);
    if (!address && !point) return void problems.push({ file, path: at, message: 'Give source_address or data_point' });
    const it = item(address, str(r.output_name), str(r.output_type), str(r.transform), str(r.notes), str(r.description).slice(0, PLANT_LIMITS.description));
    if (point) it.dataPoint = point;
    c.items.push(it);
  });
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
        g.destination = {
          kind: 'other',
          ref: 'Industrial Edge Databus',
          path: '',
          notes: 'The connector publishes to the Databus; its export does not name the topic',
        };
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
    const queue: { id: string; via: string[] }[] = (Array.isArray(src.wires) ? src.wires : []).flatMap((o) =>
      (Array.isArray(o) ? o : []).map((to) => ({ id: str(to), via: [] as string[] })),
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
        if (!c) {
          c = base(str(n.name) || [type, str(n.topic) || str(n.url) || str(n.filename) || str(n.table)].filter(Boolean).join(' '));
          c.mode = / in$/i.test(str(src.type)) ? 'on_change' : 'interval';
          c.destination = { kind: 'other', ref: type, path: str(n.topic) || str(n.url) || str(n.filename) || str(n.table), notes: '' };
          c.notes = `Node-RED: ${type} node ${key}`;
          collections.set(key, c);
        }
        if (Number.isFinite(repeat) && repeat > 0) c.intervalMs = c.intervalMs ?? Math.round(repeat * 1000);
        const it = item(addressOf(src), str(src.name) || str(src.topic) || str(src.item), str(src.datatype) || str(src.dataType), via.join(' → '));
        if (!c.items.some((x) => x.address === it.address && x.outputName === it.outputName)) c.items.push(it);
        continue;
      }
      const note = NR_TRANSFORM.test(type)
        ? `${type}${str(n.name) ? ` "${str(n.name)}"` : ''}${type === 'change' && changeRules(n) ? ` (${changeRules(n)})` : ''}`
        : null;
      const next = note ? [...via, note] : via;
      for (const o of Array.isArray(n.wires) ? n.wires : []) for (const to of Array.isArray(o) ? o : []) queue.push({ id: str(to), via: next });
    }
  }
  return [...collections.values()];
}

import { Worker } from 'node:worker_threads';
import { logger } from '../../log.js';
import { sha256 } from '../../util.js';

/**
 * dbt files parsed off the main thread (0.25.0, a carry-over of the 0.24.0 release review): `JSON.parse` of a 40 MB
 * `manifest.json` alone holds the event loop for about a second. A worker thread (started for the file, from source
 * text like the SQLite snapshot's – nothing to bundle) parses the body, computes its SHA-256 and keeps only the fields
 * dbt.ts reads of each node or result (no code, descriptions, columns or messages); the main thread then **pulls** the
 * nodes in parts of PART items – one message per part, each a short turn of the event loop – validates them with the
 * schemas of dbt.ts and writes them in batches. Pulling (instead of the worker posting everything) keeps the main
 * thread from deserialising every part in one turn.
 *
 * The worker gets a copy of the body and a heap limit, and at most DBT_WORKERS run at a time; when it cannot start (an unusual runtime), the same reading runs
 * on the main thread (`stripDbt` below – the worker's source is that function's twin, the tests compare both).
 */

/** Items handed over per message. */
export const PART = 2_000;
/** Heap of the worker: a 40 MB manifest parses into a few hundred MB of objects. */
const WORKER_HEAP_MB = 1_024;

export type DbtFileKind = 'manifest' | 'runResults';

/** What a file is, before its items: the metadata dbt.ts reads and the shape and size of its lists. */
export interface DbtHead {
  /** The type of the whole document: 'object' for a dbt file */
  doc: 'object' | 'array' | 'other';
  metadata: unknown;
  /** manifest: nodes and sources; run results: results */
  lists: Record<string, { kind: 'object' | 'array' | 'missing' | 'other'; count: number }>;
}

/** A dbt file being read: its head, then its items part by part (null: no more). */
export interface DbtReader {
  sha256: string;
  head: DbtHead;
  /** manifest: [list, key, node] per item; run results: the result */
  next(): Promise<unknown[] | null>;
  close(): void;
  /** For the tests: whether a worker thread reads it */
  inWorker: boolean;
}

/** Why a body is no dbt file at all (dbt.ts and push.ts answer DATA_LINEAGE_DBT_INVALID). */
export class DbtBodyError extends Error {
  constructor(readonly reason: 'empty' | 'json') {
    super(reason === 'empty' ? 'The body is empty' : 'The body is not JSON');
  }
}

// ---------- what is kept of a node and a result (the main-thread twin of the worker's source) ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** A value as the schema should see it: objects reduced to `keys` (each mapped by `inner`), anything else kept (the schema refuses it). */
function pick(v: unknown, keys: readonly string[], inner: Record<string, (x: unknown) => unknown> = {}): unknown {
  if (!isObj(v)) return Array.isArray(v) ? [] : v;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (Object.hasOwn(v, k)) out[k] = inner[k] ? inner[k](v[k]) : v[k];
  return out;
}
const NODE_KEYS = [
  'resource_type',
  'name',
  'unique_id',
  'database',
  'schema',
  'alias',
  'identifier',
  'config',
  'depends_on',
  'attached_node',
  'column_name',
  'test_metadata',
] as const;
const node = (v: unknown) =>
  pick(v, NODE_KEYS, {
    config: (x) => pick(x, ['materialized', 'enabled']),
    depends_on: (x) => pick(x, ['nodes']),
    test_metadata: (x) => (x === null ? null : pick(x, ['name'])),
  });
const result = (v: unknown) =>
  pick(v, ['unique_id', 'status', 'failures', 'timing'], {
    timing: (x) => (Array.isArray(x) ? x.slice(0, 11).map((t) => pick(t, ['name', 'completed_at'])) : x),
  });
const listKind = (v: unknown): DbtHead['lists'][string]['kind'] => (v === undefined ? 'missing' : Array.isArray(v) ? 'array' : isObj(v) ? 'object' : 'other');
const count = (v: unknown) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : 0);

/** The head and the items of a parsed dbt document (pure; the worker runs its twin). */
export function stripDbt(file: DbtFileKind, doc: unknown): { head: DbtHead; items: unknown[] } {
  if (!isObj(doc)) return { head: { doc: Array.isArray(doc) ? 'array' : 'other', metadata: undefined, lists: {} }, items: [] };
  if (file === 'manifest') {
    const items: unknown[] = [];
    for (const list of ['nodes', 'sources'] as const) {
      const v = doc[list];
      if (isObj(v)) for (const [k, x] of Object.entries(v)) items.push([list, k, node(x)]);
    }
    return {
      head: {
        doc: 'object',
        metadata: pick(doc.metadata, ['dbt_schema_version', 'adapter_type']),
        lists: { nodes: { kind: listKind(doc.nodes), count: count(doc.nodes) }, sources: { kind: listKind(doc.sources), count: count(doc.sources) } },
      },
      items,
    };
  }
  return {
    head: {
      doc: 'object',
      metadata: pick(doc.metadata, ['dbt_schema_version', 'generated_at', 'invocation_id']),
      lists: { results: { kind: listKind(doc.results), count: count(doc.results) } },
    },
    items: Array.isArray(doc.results) ? doc.results.map(result) : [],
  };
}

// ---------- the worker ----------

/**
 * The worker's source: the twin of stripDbt (plain JavaScript, no imports but Node's own). Messages: the worker posts
 * `{ t: 'head' }` or `{ t: 'fail' }` once, then answers each `'next'` with `{ t: 'part', items }` (empty: the end).
 */
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const crypto = require('node:crypto');
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function pick(v, keys, inner) {
  if (!isObj(v)) return Array.isArray(v) ? [] : v;
  const out = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = inner && inner[k] ? inner[k](v[k]) : v[k];
  return out;
}
const NODE_KEYS = ['resource_type', 'name', 'unique_id', 'database', 'schema', 'alias', 'identifier', 'config', 'depends_on', 'attached_node', 'column_name', 'test_metadata'];
const node = (v) => pick(v, NODE_KEYS, {
  config: (x) => pick(x, ['materialized', 'enabled']),
  depends_on: (x) => pick(x, ['nodes']),
  test_metadata: (x) => (x === null ? null : pick(x, ['name'])),
});
const result = (v) => pick(v, ['unique_id', 'status', 'failures', 'timing'], { timing: (x) => (Array.isArray(x) ? x.slice(0, 11).map((t) => pick(t, ['name', 'completed_at'])) : x) });
const listKind = (v) => (v === undefined ? 'missing' : Array.isArray(v) ? 'array' : isObj(v) ? 'object' : 'other');
const count = (v) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : 0);
const buf = Buffer.from(workerData.bytes.buffer, workerData.bytes.byteOffset, workerData.bytes.byteLength);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
let items = [];
let head = null;
const text = buf.toString('utf8');
let doc;
let failed = null;
if (!text.trim()) failed = 'empty';
else {
  try {
    doc = JSON.parse(text);
  } catch {
    failed = 'json';
  }
}
if (failed) parentPort.postMessage({ t: 'fail', reason: failed, sha256 });
else {
  if (!isObj(doc)) head = { doc: Array.isArray(doc) ? 'array' : 'other', metadata: undefined, lists: {} };
  else if (workerData.file === 'manifest') {
    for (const list of ['nodes', 'sources']) {
      const v = doc[list];
      if (isObj(v)) for (const k of Object.keys(v)) items.push([list, k, node(v[k])]);
    }
    head = {
      doc: 'object',
      metadata: pick(doc.metadata, ['dbt_schema_version', 'adapter_type']),
      lists: { nodes: { kind: listKind(doc.nodes), count: count(doc.nodes) }, sources: { kind: listKind(doc.sources), count: count(doc.sources) } },
    };
  } else {
    head = {
      doc: 'object',
      metadata: pick(doc.metadata, ['dbt_schema_version', 'generated_at', 'invocation_id']),
      lists: { results: { kind: listKind(doc.results), count: count(doc.results) } },
    };
    items = Array.isArray(doc.results) ? doc.results.map(result) : [];
  }
  doc = undefined;
  parentPort.postMessage({ t: 'head', head, sha256 });
}
let at = 0;
parentPort.on('message', (m) => {
  if (m !== 'next') return;
  const part = items.slice(at, at + workerData.part);
  at += part.length;
  parentPort.postMessage({ t: 'part', items: part });
  if (!part.length) items = [];
});
`;

type FromWorker = { t: 'head'; head: DbtHead; sha256: string } | { t: 'fail'; reason: 'empty' | 'json'; sha256: string } | { t: 'part'; items: unknown[] };

/** Reads a dbt file on the main thread (the fallback, and the tests' comparison). */
export function readDbtInThread(file: DbtFileKind, raw: Buffer): DbtReader {
  const hash = sha256(raw);
  const text = raw.toString('utf8');
  if (!text.trim()) throw new DbtBodyError('empty');
  let doc: unknown;
  try {
    doc = JSON.parse(text) as unknown;
  } catch {
    throw new DbtBodyError('json');
  }
  const { head, items } = stripDbt(file, doc);
  let at = 0;
  return {
    sha256: hash,
    head,
    inWorker: false,
    next: async () => {
      if (at >= items.length) return null;
      const part = items.slice(at, at + PART);
      at += part.length;
      return part;
    },
    close: () => undefined,
  };
}

/**
 * Worker threads at a time, server-wide: each may take WORKER_HEAP_MB, and the files of one source already wait for each
 * other (push.ts) – files of several sources wait here for a free worker instead of each starting one.
 */
export const DBT_WORKERS = 2;
let busy = 0;
const queued: (() => void)[] = [];

/** A worker slot (waits for one); the function given back frees it (once – a freed slot goes to the next waiting). */
async function workerSlot(): Promise<() => void> {
  if (busy < DBT_WORKERS) busy++;
  else await new Promise<void>((resolve) => queued.push(resolve)); // the slot is handed over as it is freed
  let freed = false;
  return () => {
    if (freed) return;
    freed = true;
    const next = queued.shift();
    if (next) next();
    else busy--;
  };
}

/** For the tests: start no worker (the fallback path). */
let workerOff = false;
export function setDbtWorkerOff(off: boolean): void {
  workerOff = off;
}

/**
 * Opens a dbt file: parsed in a worker thread (else on the main thread). Throws DbtBodyError for an empty body or one
 * that is not JSON; the caller validates the head and the items.
 */
export async function openDbtFile(file: DbtFileKind, raw: Buffer): Promise<DbtReader> {
  if (workerOff) return readDbtInThread(file, raw);
  const release = await workerSlot();
  let worker: Worker;
  try {
    // a copy of the body for the worker (the caller's buffer may be a slice of a larger one)
    const bytes = new Uint8Array(raw.byteLength);
    bytes.set(raw);
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { file, part: PART, bytes },
      transferList: [bytes.buffer],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    });
  } catch (err) {
    release();
    logger.warn({ err }, 'the dbt parse worker could not start: parsing on the main thread');
    return readDbtInThread(file, raw);
  }
  let waiting: { resolve: (m: FromWorker) => void; reject: (e: Error) => void } | null = null;
  let failure: Error | null = null;
  const queue: FromWorker[] = [];
  worker.on('message', (m: FromWorker) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.resolve(m);
    } else queue.push(m);
  });
  const fail = (e: Error) => {
    failure = e;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.reject(e);
    }
  };
  worker.on('error', (e) => fail(e));
  worker.on('exit', (code) => fail(new Error(`the dbt parse worker stopped (exit code ${code})`)));
  const receive = (): Promise<FromWorker> => {
    const m = queue.shift();
    if (m) return Promise.resolve(m);
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => (waiting = { resolve, reject }));
  };
  const close = () => {
    worker.removeAllListeners('exit');
    void worker.terminate();
    release();
  };
  let first: FromWorker;
  try {
    first = await receive();
  } catch (e) {
    close();
    // a worker that ran out of memory or died: the file is too much for it – say so as a refused body, never on the main thread
    logger.warn({ err: e }, 'the dbt parse worker failed');
    throw e;
  }
  if (first.t === 'fail') {
    close();
    throw new DbtBodyError(first.reason);
  }
  if (first.t !== 'head') {
    close();
    throw new Error('the dbt parse worker answered out of order');
  }
  let done = false;
  return {
    sha256: first.sha256,
    head: first.head,
    inWorker: true,
    next: async () => {
      if (done) return null;
      worker.postMessage('next');
      const m = await receive();
      if (m.t !== 'part' || !m.items.length) {
        done = true;
        close();
        return null;
      }
      return m.items;
    },
    close,
  };
}

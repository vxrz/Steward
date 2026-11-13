import { z } from 'zod';
import {
  DATA_PRODUCT_LIMITS,
  CIA_DIMENSIONS,
  DATA_PRODUCT_IMPORT_MODES,
  DATA_PRODUCT_IMPORT_ORIGINS_LISTED,
  DATA_PRODUCT_IMPORT_ORIGIN_RE,
  DATA_PRODUCT_IMPORT_REMOVALS_WITHOUT_STEP_UP,
  elementNameNorm,
  type AclEntry,
  type DataObjectives,
  type DataProductImportChange,
  type DataProductImportCounts,
  type DataProductImportField,
  type DataProductImportKind,
  type DataProductImportMode,
  type DataProductImportOrigin,
  type DataProductImportPreview,
  type DataProductImportProblem,
  type DataProductImportResult,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import { audit, withoutAudit } from '../audit.js';
import { holdingNotices } from './notices.js';
import { contractAccess, platformAccess } from '../auth/policy.js';
import { permissionsFor } from '../processes/service.js';
import { canViewCatalogue } from '../records/access.js';
import { checkYamlLimits, parseYaml } from '../yaml-safe.js';
import { isSecretKey, redactUserinfo } from '../plant/collections-redact.js';
import { HttpError, nowIso, parseJson, sha256 } from '../util.js';
import { isOdpsDocument, odpsToFile } from './odps-import.js';
import { domainAccess, elementAccess, objectAccess, productAccess } from './access.js';
import * as svc from './service.js';
import * as el from './elements.js';
import * as ports from './ports.js';
import { writeIdentities } from './consumers-actual.js';
import * as steps from './steps.js';
import { ratingsByItem } from './ratings.js';
import {
  chunks,
  consumersOf,
  elementTeamIds,
  elementsByIds,
  marks,
  membersOf,
  portsOf,
  type DomainRow,
  type ElementRow,
  type ObjectRow,
  type PortRow,
  type ProductRow,
} from './store.js';
import {
  DATA_PRODUCT_FORMAT_VERSION,
  DATA_PRODUCT_IMPORT_LIMITS as IL,
  dataProductsFileSchema,
  issueMessages,
  portIdentity,
  type BindingFile,
  type ConsumerFile,
  type DataProductsFile,
  type DomainFile,
  type ElementFile,
  type ElementRefFile,
  type ObjectFile,
  type PortFile,
  type ProductFile,
  type RunnerFile,
  type StepFile,
} from './format.js';
import { Snapshot, consumerIdentity, domainEntry, elementEntry, elementKey, elementSort, objectEntry, productEntry } from './export.js';

/**
 * The import of Steward's file format (ADR 0036 part 15): the files are read within limits (8 MB together, 500 files,
 * keys bounded before parsing, duplicate keys, 100 aliases, 12 levels), refused when a value looks like a credential
 * (the places are named), checked against the format and compared with what is stored – field by field – before
 * anything is written. Modes: _add only_ (entries that exist are skipped) and _add and update_ (entries that exist take
 * what the files say; a key a file leaves out keeps Steward's value; nothing is removed).
 *
 * Every write goes through the module's services, as the person importing: their rights, the limits, the rules of
 * lifecycles, bindings and steps, the access.grant step-up for owners named from outside the owning teams and the
 * audit trail are those of the pages. What the person may not see does not exist for an import – a key, element,
 * platform, contract or application they may not see is refused like an unknown one, never named. The preview runs the
 * same writes in a transaction that is rolled back (not audited), so it finds what the services would refuse. The
 * import is one transaction, audited once more as `dataproduct.imported` with its counts and the files' SHA-256.
 */

export const importInput = z
  .object({
    files: z
      .array(z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(IL.bytes * 2) }).strict())
      .min(1)
      .max(IL.files),
    mode: z.enum(DATA_PRODUCT_IMPORT_MODES),
    /** The preview's fingerprint: a different result is refused (DATA_PRODUCT_IMPORT_CHANGED) */
    fingerprint: z.string().trim().max(80).optional(),
    /**
     * Phase 2: the name the import keeps its entries under (any mode); mode replace replaces the earlier import of this
     * origin – its entries the files no longer hold are removed
     */
    origin: z.string().trim().regex(DATA_PRODUCT_IMPORT_ORIGIN_RE, 'letters, digits and . _ - : / (at most 100)').optional(),
  })
  .strict()
  .refine((x) => x.mode !== 'replace' || !!x.origin, { message: 'Replacing needs the origin of the earlier import', path: ['origin'] });
export type ImportInput = z.infer<typeof importInput>;

/** What the module's own callers add (Git sync): the files are the whole of their products' lists (members, ports, steps, consumers). */
export interface ImportOptions {
  replaceLists?: boolean;
}

// ---------- reading ----------

function depthOf(v: unknown): number {
  let max = 0;
  const stack: [unknown, number][] = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (x === null || typeof x !== 'object') continue;
    if (d > max) max = d;
    if (d > IL.depth + 1) return d;
    for (const c of Array.isArray(x) ? x : Object.values(x)) stack.push([c, d + 1]);
  }
  return max;
}

const pathOf = (base: string, key: string | number) => (typeof key === 'number' ? `${base}[${key}]` : base ? `${base}.${key}` : key);

/** Places of values that look like a credential: a secret-looking key, a password in a URL (never kept, never echoed). */
export function credentialPlaces(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, at: string, depth: number) => {
    if (out.length >= 20 || depth > IL.depth + 2) return;
    if (typeof v === 'string') {
      if (redactUserinfo(v).hit) out.push(at || '(document)');
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, pathOf(at, i), depth + 1));
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      const here = pathOf(at, k);
      if (isSecretKey(k) && x !== null && x !== '' && x !== undefined) {
        out.push(here);
        continue;
      }
      walk(x, here, depth + 1);
    }
  };
  walk(doc, '', 0);
  return out;
}

interface Parsed {
  name: string;
  sha256: string;
  bytes: number;
  file: DataProductsFile | null;
}

/**
 * A JSON file read with JSON.parse (0.25.0): the YAML parser took about 2 s for a file of 20,000 elements, JSON.parse
 * a hundredth of that. The same limits as YAML's (bytes, keys); a duplicate key or a syntax error leaves it to the YAML
 * reader, which names the place – so a JSON file is read exactly as before.
 */
function parseJsonFile(text: string): unknown {
  const t = text.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  checkYamlLimits(text, { maxBytes: IL.bytes, maxKeys: IL.keys });
  if (!jsonKeysUnique(text)) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // the YAML reader reads it again and names the place of the error
    return undefined;
  }
}

/** Whether every object of a JSON text has unique keys (a linear scan; an unreadable text passes – JSON.parse refuses it). */
export function jsonKeysUnique(t: string): boolean {
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 34) {
      let j = i + 1;
      let escaped = false;
      for (; j < t.length; j++) {
        const d = t.charCodeAt(j);
        if (d === 92) {
          j++;
          escaped = true;
        } else if (d === 34) break;
      }
      if (expectKey) {
        let key = t.slice(i + 1, j);
        if (escaped)
          try {
            key = JSON.parse(t.slice(i, j + 1)) as string;
          } catch {
            // not a JSON string: JSON.parse refuses the text and the YAML reader names the place
            return true;
          }
        const keys = stack[stack.length - 1];
        if (keys) {
          if (keys.has(key)) return false;
          keys.add(key);
        }
        expectKey = false;
      }
      i = j;
    } else if (c === 123) {
      stack.push(new Set());
      expectKey = true;
    } else if (c === 91) {
      stack.push(null);
      expectKey = false;
    } else if (c === 125 || c === 93) {
      stack.pop();
      expectKey = false;
    } else if (c === 44) expectKey = stack[stack.length - 1] instanceof Set;
  }
  return true;
}

function readFiles(files: ImportInput['files'], problems: DataProductImportProblem[], warnings: string[] = [], odps = { n: 0 }): Parsed[] {
  const total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  if (total > IL.bytes)
    throw new HttpError(413, `The files are too large together (at most ${IL.bytes / 1024 / 1024} MB)`, 'DATA_PRODUCT_IMPORT_TOO_LARGE', {
      mb: IL.bytes / 1024 / 1024,
    });
  const names = new Set<string>();
  return files.map((f) => {
    const out: Parsed = { name: f.name, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content), file: null };
    if (names.has(f.name)) {
      problems.push({ file: f.name, path: '(file)', message: 'The same file name is given twice' });
      return out;
    }
    names.add(f.name);
    let raw: unknown;
    try {
      raw = parseJsonFile(f.content) ?? parseYaml(f.content, { maxBytes: IL.bytes, maxKeys: IL.keys, maxAliasCount: IL.aliases });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      const err = e as Error & { linePos?: { line: number; col: number }[] };
      const pos = err.linePos?.[0];
      problems.push({ file: f.name, path: pos ? `line ${pos.line}, column ${pos.col}` : '(file)', message: err.message.split('\n')[0]!.slice(0, 300) });
      return out;
    }
    if (depthOf(raw) > IL.depth) {
      problems.push({ file: f.name, path: '(document)', message: `The document is nested deeper than ${IL.depth} levels` });
      return out;
    }
    const secrets = credentialPlaces(raw);
    if (secrets.length) {
      for (const p of secrets)
        problems.push({
          file: f.name,
          path: p,
          message: 'Looks like a credential – Steward never keeps one in a data products file: leave out passwords, tokens, keys and passwords in addresses',
          code: 'DATA_PRODUCT_IMPORT_SECRET',
        });
      return out;
    }
    // phase 2: an ODPS document is read as a data product of the format (ODPS import)
    if (isOdpsDocument(raw)) {
      const c = odpsToFile(raw);
      odps.n++;
      warnings.push(...c.warnings);
      for (const p of c.problems) problems.push({ file: f.name, path: p.path, message: p.message });
      if (!c.file) return out;
      raw = c.file;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { version?: unknown }).version === undefined)
      problems.push({ file: f.name, path: 'version', message: `Required: version: ${DATA_PRODUCT_FORMAT_VERSION} (the format of the file)` });
    const r = dataProductsFileSchema.safeParse(raw);
    if (!r.success) {
      for (const m of issueMessages(r.error.issues))
        if (!(m.path === 'version' && problems.some((p) => p.file === f.name && p.path === 'version'))) problems.push({ file: f.name, ...m });
      return out;
    }
    out.file = r.data;
    return out;
  });
}

// ---------- comparing ----------

/** Lists whose items are matched by an identity (the others are replaced as a whole). */
const KEYED: Record<string, (x: never) => string> = {
  environments: (x: { environment: string }) => x.environment,
  members: (x: { element: ElementRefFile }) => elementKey(x.element),
  ports: (x: PortFile) => portIdentity(x),
  'ports.bindings': (x: BindingFile) => x.environment,
  'ports.consumers': (x: ConsumerFile) => consumerIdentity(x),
  steps: (x: StepFile) => x.name.toLowerCase(),
  elements: (x: { element: ElementRefFile }) => elementKey(x.element),
};
/** Objects whose keys are taken one by one (a key left out keeps its value). */
const MERGED = new Set(['rating', 'rating.reasons', 'support', 'ports.objectives', 'ports.bindings.objectives']);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);

/** What a file says over what is stored: keys it leaves out keep their values; listed items are matched, not replaced. */
export function overlay<T>(cur: T, inc: unknown, path = ''): T {
  if (!isObj(inc)) return cur;
  const out: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
  for (const [k, v] of Object.entries(inc)) {
    if (v === undefined) continue;
    const p = path ? `${path}.${k}` : k;
    const c = out[k];
    if (KEYED[p] && Array.isArray(v)) {
      const id = KEYED[p] as (x: unknown) => string;
      const list = Array.isArray(c) ? [...c] : [];
      for (const item of v) {
        const i = list.findIndex((x) => id(x) === id(item));
        if (i >= 0) list[i] = overlay(list[i], item, p);
        else list.push(item);
      }
      out[k] = list;
    } else if (MERGED.has(p) && isObj(v) && isObj(c)) out[k] = overlay(c, v, p);
    else out[k] = v;
  }
  return out as T;
}

const shown = (v: unknown): unknown => {
  const s = JSON.stringify(v ?? null);
  return s.length > 300 ? `${s.slice(0, 300)}…` : v;
};

/** The fields that differ, items of keyed lists one by one. */
function diffOf(cur: unknown, next: unknown, path = '', label = '', out: DataProductImportField[] = []): DataProductImportField[] {
  if (!isObj(cur) || !isObj(next)) return out;
  for (const k of new Set([...Object.keys(cur), ...Object.keys(next)])) {
    const p = path ? `${path}.${k}` : k;
    const l = label ? `${label}.${k}` : k;
    const a = cur[k];
    const b = next[k];
    if (b === undefined || same(a, b)) continue;
    if (KEYED[p] && Array.isArray(b)) {
      const id = KEYED[p] as (x: unknown) => string;
      const before = Array.isArray(a) ? a : [];
      for (const item of b) {
        const old = before.find((x) => id(x) === id(item));
        const name = `${l}[${id(item).split('\u0000').filter(Boolean).join(' ')}]`;
        if (!old) out.push({ field: name, before: null, after: 'added' });
        else if (!same(old, item)) diffOf(old, item, p, name, out);
      }
    } else out.push({ field: l, before: shown(a), after: shown(b) });
  }
  return out;
}

// ---------- the plan ----------

interface Entry<T, R> {
  file: string;
  key: string;
  action: 'add' | 'change';
  row: R | null;
  /** What the file says (references made canonical) */
  incoming: T;
  /** What is stored, as a file would say it (null: new) */
  current: T | null;
  /** Stored overlaid with the file: what is written */
  merged: T;
}

interface Plan {
  mode: DataProductImportMode;
  files: { name: string; sha256: string; bytes: number }[];
  problems: DataProductImportProblem[];
  warnings: string[];
  changes: DataProductImportChange[];
  counts: DataProductImportCounts;
  domains: Entry<DomainFile, DomainRow>[];
  objects: Entry<ObjectFile, ObjectRow>[];
  elements: Entry<ElementFile, ElementRow>[];
  products: Entry<ProductFile, ProductRow>[];
  /** The plan's look-ups (the ids of what the import adds join them while it runs) */
  r: Resolver | null;
  /** Phase 2: the origin the entries are kept under; replace: the lists of products are the files' */
  origin: string | null;
  replaceLists: boolean;
  /** Everything the files name, by kind and key (unchanged entries too: they stay the origin's) */
  named: { domains: Set<string>; objects: Set<string>; products: Set<string>; elements: Set<string> };
  /** Mode replace: the origin's entries the files no longer hold, to be removed (visible to the importer) */
  removals: { products: ProductRow[]; objects: ObjectRow[]; domains: DomainRow[]; elements: ElementRow[]; gone: { kind: string; id: string }[] };
  odps: number;
}

const storedKey = (platformId: string, kind: string, environment: string, norm: string) => `${platformId}\u0000${kind}\u0000${environment}\u0000${norm}`;

/** The element references a product's file names: members, port bindings, steps' ends. */
function productElementRefs(p: ProductFile): ElementRefFile[] {
  const out: ElementRefFile[] = [];
  for (const m of p.members ?? []) if (m?.element) out.push(m.element);
  for (const port of p.ports ?? []) for (const b of port?.bindings ?? []) for (const e of b?.elements ?? []) if (e) out.push(e);
  for (const st of p.steps ?? []) for (const e of [...(st?.inputs ?? []), ...(st?.outputs ?? [])]) if (e) out.push(e);
  return out;
}

interface PlatformRef {
  id: string;
  name: string;
}

/** Looks up what files name, as the importing person may see it. */
class Resolver {
  readonly s: Snapshot;
  private platformsByName = new Map<string, PlatformRef[]>();
  private platformsById = new Map<string, PlatformRef>();
  /** Element ids by elementKey of their canonical reference: existing ones, then those the import adds */
  readonly elementIds = new Map<string, string>();
  /** Elements the import adds (by elementKey) */
  readonly fileElements = new Map<string, ElementFile>();
  readonly domainIds = new Map<string, string>();
  readonly objectIds = new Map<string, string>();
  readonly productIds = new Map<string, string>();

  constructor(s: Snapshot) {
    this.s = s;
    for (const p of db().all<{ id: string; name: string; acl: string }>('SELECT id, name, acl FROM platforms')) {
      if (!platformAccess(s.u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions.length) continue;
      const r = { id: p.id, name: p.name };
      this.platformsById.set(p.id, r);
      const k = p.name.trim().toLowerCase();
      this.platformsByName.set(k, [...(this.platformsByName.get(k) ?? []), r]);
    }
  }

  platform(ref: Pick<ElementRefFile, 'platform' | 'platform_id'>): PlatformRef | null | string {
    if (ref.platform_id) return this.platformsById.get(ref.platform_id) ?? `The platform ${ref.platform_id} is not known`;
    if (!ref.platform) return null;
    const hits = this.platformsByName.get(ref.platform.trim().toLowerCase()) ?? [];
    if (hits.length > 1) return `${hits.length} platforms are named "${ref.platform}" – name it by platform_id`;
    return hits[0] ?? `The platform "${ref.platform}" is not known`;
  }

  /** A stored element by its reference, where the person may see it (or `allow` holds it: a product's own member). */
  stored(ref: ElementRefFile, platformId: string, allow?: ReadonlySet<string>): ElementRow | undefined {
    const k = storedKey(platformId, ref.kind, ref.environment ?? '', elementNameNorm(ref.qualified_name));
    let row: ElementRow | null | undefined = this.prefetched.get(k);
    if (row === undefined)
      row =
        db().get<ElementRow>(
          'SELECT * FROM dp_elements WHERE platform_id = ? AND kind = ? AND environment = ? AND name_norm = ?',
          platformId,
          ref.kind,
          ref.environment ?? '',
          elementNameNorm(ref.qualified_name),
        ) ?? null;
    if (!row) return undefined;
    if (allow?.has(row.id)) return row;
    const visible = this.visible.get(row.id) ?? elementAccess(this.s.u, elementTeamIds([row.id]).get(row.id) ?? []).permissions.length > 0;
    return visible ? row : undefined;
  }

  /** Stored elements read in bulk (0.25.0): an import of 20,000 elements read them one statement each */
  private prefetched = new Map<string, ElementRow | null>();
  private visible = new Map<string, boolean>();

  /**
   * Reads the stored elements these references name in bulk – one statement per platform and 500 names, their owning
   * teams per 500 ids – so that stored() needs no statement of its own for them (a missing one is remembered too).
   */
  prefetch(refs: readonly ElementRefFile[]): void {
    const wanted = new Map<string, Set<string>>();
    for (const ref of refs) {
      const p = this.platform(ref);
      if (typeof p === 'string' || typeof ref.qualified_name !== 'string' || typeof ref.kind !== 'string') continue;
      const pid = p?.id ?? '';
      const norm = elementNameNorm(ref.qualified_name);
      this.prefetched.set(storedKey(pid, ref.kind, ref.environment ?? '', norm), null);
      const set = wanted.get(pid) ?? new Set<string>();
      set.add(norm);
      wanted.set(pid, set);
    }
    const rows: ElementRow[] = [];
    for (const [pid, names] of wanted)
      for (const part of chunks([...names]))
        rows.push(...db().all<ElementRow>(`SELECT * FROM dp_elements WHERE platform_id = ? AND name_norm IN (${marks(part.length)})`, pid, ...part));
    const teams = elementTeamIds(rows.map((r) => r.id));
    for (const row of rows) {
      const k = storedKey(row.platform_id, row.kind, row.environment, row.name_norm);
      if (this.prefetched.has(k)) this.prefetched.set(k, row);
      this.visible.set(row.id, elementAccess(this.s.u, teams.get(row.id) ?? []).permissions.length > 0);
    }
  }

  /**
   * A reference made canonical (the stored element's names, or the file's element): `ref` and its key, or a problem.
   * `allow`: elements that are part of the product already – its content, also where the person may not see them.
   */
  element(ref: ElementRefFile, allow?: ReadonlySet<string>): { ref: ElementRefFile; key: string } | string {
    const p = this.platform(ref);
    if (typeof p === 'string') return p;
    const base: ElementRefFile = {
      ...(p ? { platform: p.name } : {}),
      kind: ref.kind,
      qualified_name: ref.qualified_name.trim(),
      environment: ref.environment ?? '',
    };
    const row = this.stored(base, p?.id ?? '', allow);
    if (row) {
      const canonical: ElementRefFile = {
        ...(p ? { platform: p.name } : {}),
        kind: row.kind,
        qualified_name: row.qualified_name,
        environment: row.environment,
      };
      const key = elementKey(canonical);
      this.elementIds.set(key, row.id);
      return { ref: canonical, key };
    }
    const key = elementKey(base);
    const own = this.fileElements.get(key);
    if (own) return { ref: { ...base, qualified_name: own.qualified_name }, key };
    return `The element ${ref.qualified_name} (${ref.kind}${ref.environment ? `, ${ref.environment}` : ''}) is not known – add it under elements`;
  }

  elementId(ref: ElementRefFile): string {
    const id = this.elementIds.get(elementKey(ref));
    if (!id) throw new HttpError(404, `Element ${ref.qualified_name} not found`, 'DATA_ELEMENT_NOT_FOUND', { id: ref.qualified_name });
    return id;
  }

  /** A visible domain, data object or product by key (hidden ones are unknown). */
  domain(key: string): DomainRow | undefined {
    const d = db().get<DomainRow>('SELECT * FROM dp_domains WHERE key = ?', key);
    return d && domainAccess(this.s.u, d).permissions.length ? d : undefined;
  }
  object(key: string): ObjectRow | undefined {
    const o = db().get<ObjectRow>('SELECT * FROM dp_objects WHERE key = ?', key);
    return o && objectAccess(this.s.u, o).permissions.length ? o : undefined;
  }
  product(key: string): ProductRow | undefined {
    const p = db().get<ProductRow>('SELECT * FROM dp_products WHERE key = ?', key);
    return p && productAccess(this.s.u, p).permissions.length ? p : undefined;
  }
  domainId(key: string): string {
    const id = this.domainIds.get(key) ?? this.domain(key)?.id;
    if (!id) throw new HttpError(404, `Data domain ${key} not found`, 'DATA_DOMAIN_NOT_FOUND', { id: key });
    return id;
  }
  objectId(key: string): string {
    const id = this.objectIds.get(key) ?? this.object(key)?.id;
    if (!id) throw new HttpError(404, `Data object ${key} not found`, 'DATA_OBJECT_NOT_FOUND', { id: key });
    return id;
  }
  productId(key: string): string {
    const id = this.productIds.get(key) ?? this.product(key)?.id;
    if (!id) throw new HttpError(404, `Data product ${key} not found`, 'DATA_PRODUCT_NOT_FOUND', { id: key });
    return id;
  }

  /** A data contract by its ODCS id, among those the person may see. */
  contractId(odcsId: string): string {
    const rows = db()
      .all<{ id: string }>('SELECT id FROM data_contracts WHERE contract_key = ? ORDER BY id', odcsId)
      .filter((r) => contractAccess(this.s.u, { id: r.id }).permissions.includes('view'));
    if (rows.length > 1)
      throw new HttpError(409, `${rows.length} data contracts have the id "${odcsId}"`, 'DATA_CONTRACT_KEY_AMBIGUOUS', { count: rows.length, key: odcsId });
    if (!rows[0]) throw new HttpError(404, `Data contract ${odcsId} not found`, 'DATA_PORT_CONTRACT', { context: 'notFound' });
    return rows[0].id;
  }

  /** An application, service or process by name, among those the person may see. */
  named(kind: 'application' | 'service' | 'process' | 'platform', name: string): string {
    const n = name.trim().toLowerCase();
    const ids =
      kind === 'platform'
        ? (this.platformsByName.get(n) ?? []).map((p) => p.id)
        : kind === 'process'
          ? db()
              .all<{ id: string; name: string }>('SELECT id, name FROM processes')
              .filter((r) => r.name.trim().toLowerCase() === n && permissionsFor(r.id).includes('view'))
              .map((r) => r.id)
          : db()
              .all<{ id: string; name: string; owners: string }>(`SELECT id, name, owners FROM ${kind === 'application' ? 'applications' : 'services'}`)
              .filter((r) => r.name.trim().toLowerCase() === n && canViewCatalogue(this.s.u, { kind, id: r.id, owners: parseJson<string[]>(r.owners, []) }))
              .map((r) => r.id);
    if (ids.length > 1) throw new HttpError(409, `${ids.length} ${kind}s are named "${name}"`, 'DATA_PRODUCT_IMPORT_INVALID', { context: 'ambiguous', name });
    if (!ids[0]) throw new HttpError(404, `The ${kind} "${name}" is not known`, 'DATA_PRODUCT_IMPORT_INVALID', { context: 'unknown', name });
    return ids[0];
  }
}

/** Element references of an entry made canonical (in place); problems for those that cannot be found. */
function canonicalRefs(r: Resolver, v: unknown, at: string, problem: (path: string, message: string) => void, allow?: ReadonlySet<string>): void {
  const walk = (x: unknown, here: string) => {
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${here}[${i}]`));
    if (!isObj(x)) return;
    for (const [k, y] of Object.entries(x)) {
      const p = `${here}.${k}`;
      const isRef = (z: unknown): z is ElementRefFile => isObj(z) && typeof z.kind === 'string' && typeof z.qualified_name === 'string';
      if (
        (k === 'element' && isRef(y)) ||
        ((k === 'elements' || k === 'inputs' || k === 'outputs') && Array.isArray(y) && y.every(isRef) && y.length && !('element' in (y[0] as object)))
      ) {
        const list = Array.isArray(y) ? y : [y];
        const out = list.map((ref, i) => {
          const c = r.element(ref, allow);
          if (typeof c === 'string') {
            problem(Array.isArray(y) ? `${p}[${i}]` : p, c);
            return ref;
          }
          return c.ref;
        });
        x[k] = Array.isArray(y) ? out : out[0];
        continue;
      }
      walk(y, p);
    }
  };
  walk(v, at);
}

/** Lists a file may give in any order, in the order an export writes them (so they compare). */
function normaliseProduct(p: ProductFile): void {
  const refs = (xs: ElementRefFile[] | undefined) => xs?.sort(elementSort);
  for (const x of p.ports ?? []) {
    x.version ??= '';
    if (x.successor) x.successor.version ??= '';
    if (x.source?.product) x.source.version ??= '';
    x.data_objects?.sort();
    for (const b of x.bindings ?? []) refs(b.elements);
    x.bindings?.sort((a, b) => a.environment.localeCompare(b.environment));
  }
  for (const st of p.steps ?? []) {
    refs(st.inputs);
    refs(st.outputs);
    if (st.runner?.kind === 'tool') st.runner = { kind: 'tool', tool: st.runner.tool ?? '', text: st.runner.text ?? '' };
    for (const n of st.notes ?? []) n.text ??= '';
  }
  for (const x of p.ports ?? []) for (const c of x.consumers ?? []) if (c.agreement) c.agreement.label ??= '';
  for (const r of p.external_refs ?? []) r.label ??= '';
}

/** The same for a data object: list items an export writes without their empty values. */
function normaliseObject(o: ObjectFile): void {
  for (const a of o.attributes ?? []) {
    a.description ??= '';
    a.personal ??= false;
  }
  for (const r of o.external_refs ?? []) r.label ??= '';
}

const entriesOf = <T>(many: T[] | undefined, one: T | undefined): T[] => [...(many ?? []), ...(one ? [one] : [])];
const label = (kind: string, key: string) => `${kind}[${key}]`;

function buildPlan(input: ImportInput, o: ImportOptions = {}): Plan {
  const problems: DataProductImportProblem[] = [];
  const warnings: string[] = [];
  const odps = { n: 0 };
  const parsed = readFiles(input.files, problems, warnings, odps);
  const replace = input.mode === 'replace';
  const plan: Plan = {
    mode: input.mode,
    files: parsed.map((p) => ({ name: p.name, sha256: p.sha256, bytes: p.bytes })),
    problems,
    warnings,
    changes: [],
    counts: { add: 0, change: 0, unchanged: 0, skip: 0, ...(replace || o.replaceLists ? { remove: 0, removedItems: 0, keptHidden: 0 } : {}) },
    domains: [],
    objects: [],
    elements: [],
    products: [],
    r: null,
    origin: input.origin ?? null,
    replaceLists: replace || !!o.replaceLists,
    named: { domains: new Set(), objects: new Set(), products: new Set(), elements: new Set() },
    removals: { products: [], objects: [], domains: [], elements: [], gone: [] },
    odps: odps.n,
  };
  if (problems.length) return plan;
  const s = new Snapshot();
  const r = new Resolver(s);
  plan.r = r;
  const seen = new Set<string>();
  const once = (file: string, kind: string, key: string): boolean => {
    const k = `${kind}\u0000${key.toLowerCase()}`;
    if (seen.has(k)) {
      problems.push({ file, path: label(kind, key), message: 'The files give this entry twice' });
      return false;
    }
    seen.add(k);
    return true;
  };
  const record = <T, R>(
    kind: DataProductImportKind,
    list: Entry<T, R>[],
    e: { file: string; key: string; row: R | null; incoming: T; current: T | null },
    compare?: (x: T) => unknown,
    merge: (cur: T, inc: T) => { merged: T; removed: DataProductImportField[] } = (cur, inc) => ({ merged: overlay(cur, inc), removed: [] }),
  ) => {
    if (!e.current || !e.row) {
      plan.counts.add++;
      plan.changes.push({ kind, key: e.key, action: 'add', fields: [] });
      list.push({ ...e, action: 'add', merged: e.incoming });
      return;
    }
    if (plan.mode === 'add') {
      plan.counts.skip++;
      plan.changes.push({ kind, key: e.key, action: 'skip', fields: [], reason: 'exists' });
      return;
    }
    const { merged, removed } = merge(e.current, e.incoming);
    const fields = [...diffOf(compare ? compare(e.current) : e.current, compare ? compare(merged) : merged), ...removed];
    if (removed.length) plan.counts.removedItems = (plan.counts.removedItems ?? 0) + removed.length;
    if (!fields.length) {
      plan.counts.unchanged++;
      return;
    }
    plan.counts.change++;
    plan.changes.push({ kind, key: e.key, action: 'change', fields: fields.slice(0, 100) });
    list.push({ ...e, action: 'change', merged });
  };

  const files = parsed.filter((p): p is Parsed & { file: DataProductsFile } => !!p.file);
  // elements the files add: known before references are made canonical
  let elementCount = 0;
  const fileElements: { file: string; entry: ElementFile; index: number }[] = [];
  for (const f of files)
    for (const [i, e] of (f.file.elements ?? []).entries()) {
      elementCount++;
      fileElements.push({ file: f.name, entry: e, index: i });
    }
  if (elementCount > IL.elements) {
    problems.push({
      file: files[0]?.name ?? '',
      path: 'elements',
      message: `An import adds or changes at most ${IL.elements.toLocaleString('en-GB')} elements`,
    });
    return plan;
  }
  // the stored elements the files name, read in bulk (0.25.0)
  r.prefetch([
    ...fileElements.map((x) => x.entry),
    ...files.flatMap((f) => entriesOf(f.file.data_products, f.file.data_product).flatMap((p) => productElementRefs(p))),
  ]);
  for (const { file, entry, index } of fileElements) {
    const p = r.platform(entry);
    if (typeof p === 'string') {
      problems.push({ file, path: `elements[${index}].platform`, message: p });
      continue;
    }
    const ref: ElementRefFile = {
      ...(p ? { platform: p.name } : {}),
      kind: entry.kind,
      qualified_name: entry.qualified_name.trim(),
      environment: entry.environment ?? '',
    };
    const { platform: _platform, platform_id: _id, ...rest } = entry;
    const incoming: ElementFile = { ...rest, ...ref };
    const row = r.stored(ref, p?.id ?? '');
    const key = elementKey(row ? { ...ref, qualified_name: row.qualified_name } : ref);
    if (!once(file, 'elements', key)) continue;
    plan.named.elements.add(key);
    if (row) {
      r.elementIds.set(key, row.id);
      s.elements([row.id]);
    } else r.fileElements.set(key, { ...incoming });
    const current = row ? elementEntry(s, row) : null;
    const display = `${ref.platform ? `${ref.platform}: ` : ''}${ref.qualified_name} (${ref.kind}${ref.environment ? `, ${ref.environment}` : ''})`;
    // an import changes the people's fields of an element: its parent and flags come from where it was made
    const people = (x: ElementFile) => {
      const { parent: _p, flags: _f, ...y } = x;
      return y;
    };
    if (row && current) {
      if (entry.parent !== undefined && (entry.parent ?? null) !== (current.parent ?? null))
        plan.warnings.push(`${display}: an import does not move an element to another parent`);
      record('element', plan.elements, { file, key: display, row, incoming: { ...incoming, qualified_name: row.qualified_name }, current }, people);
    } else record('element', plan.elements, { file, key: display, row: null, incoming, current: null });
  }

  for (const f of files) {
    for (const d of entriesOf(f.file.domains, f.file.domain)) {
      if (!once(f.name, 'domains', d.key)) continue;
      plan.named.domains.add(d.key);
      const row = r.domain(d.key) ?? null;
      record('domain', plan.domains, { file: f.name, key: d.key, row, incoming: d, current: row ? domainEntry(s, row) : null });
    }
  }
  for (const f of files) {
    for (const [i, o] of entriesOf(f.file.data_objects, f.file.data_object).entries()) {
      if (!once(f.name, 'data_objects', o.key)) continue;
      plan.named.objects.add(o.key);
      const incoming = structuredClone(o);
      normaliseObject(incoming);
      canonicalRefs(r, incoming, `data_objects[${i}]`, (path, message) => problems.push({ file: f.name, path, message }));
      const row = r.object(o.key) ?? null;
      let current: ObjectFile | null = null;
      if (row) {
        const links = db().all<{ element_id: string; note: string }>('SELECT element_id, note FROM dp_object_elements WHERE object_id = ?', row.id);
        s.elements(links.map((l) => l.element_id));
        current = objectEntry(s, row, ratingsByItem('object', [row.id]).get(row.id)!, links);
      }
      record('dataObject', plan.objects, { file: f.name, key: o.key, row, incoming, current });
    }
  }
  for (const f of files) {
    for (const [i, p] of entriesOf(f.file.data_products, f.file.data_product).entries()) {
      if (!once(f.name, 'data_products', p.key)) continue;
      plan.named.products.add(p.key);
      const row = r.product(p.key) ?? null;
      const incoming = structuredClone(p);
      canonicalRefs(
        r,
        incoming,
        `data_products[${i}]`,
        (path, message) => problems.push({ file: f.name, path, message }),
        row ? new Set(membersOf([row.id]).map((m) => m.element_id)) : undefined,
      );
      normaliseProduct(incoming);
      const current = row ? productEntry(s, row) : null;
      // replace: what the product holds that the reader may not see is kept (counted) – members on hidden platforms,
      // consumers they may not see
      if (row && plan.replaceLists) plan.counts.keptHidden = (plan.counts.keptHidden ?? 0) + hiddenItems(row, current!);
      // ports the files leave out that hold consumers the importer may not see stay (and count as kept)
      const keepPorts = row && plan.replaceLists ? portsWithHiddenConsumers(row, current!) : new Set<string>();
      const kept = (incoming.ports ?? []).map((x) => portIdentity(x));
      const keptHiddenPorts = [...keepPorts].filter((id) => !kept.includes(id));
      if (keptHiddenPorts.length) plan.counts.keptHidden = (plan.counts.keptHidden ?? 0) + keptHiddenPorts.length;
      record(
        'dataProduct',
        plan.products,
        { file: f.name, key: p.key, row, incoming, current },
        undefined,
        plan.replaceLists ? (cur, inc) => replacedLists(cur, inc, keepPorts) : undefined,
      );
    }
  }
  if (input.mode === 'replace' && input.origin) planRemovals(plan, input.origin, s);
  if (plan.changes.length > IL.changes) plan.changes = plan.changes.slice(0, IL.changes);
  return plan;
}

// ---------- replace (phase 2) ----------

/** Members, ports, steps and consumers of the product that the export of it leaves out (the reader may not see them). */
function hiddenItems(row: ProductRow, current: ProductFile): number {
  const ports = portsOf([row.id]);
  const consumers = consumersOf(ports.map((p) => p.id)).filter((c) => ports.find((p) => p.id === c.port_id)?.direction === 'output');
  const shownConsumers = (current.ports ?? []).reduce((n, p) => n + (p.consumers?.length ?? 0), 0);
  return Math.max(0, membersOf([row.id]).length - (current.members?.length ?? 0)) + Math.max(0, consumers.length - shownConsumers);
}

/**
 * Output ports of the product with consumers the export leaves out (the reader may not see them): a replace that leaves
 * such a port out keeps it – removing the port would remove those consumers with it.
 */
function portsWithHiddenConsumers(row: ProductRow, current: ProductFile): Set<string> {
  const out = new Set<string>();
  const ports = portsOf([row.id]).filter((p) => p.direction === 'output');
  const consumers = consumersOf(ports.map((p) => p.id));
  for (const port of ports) {
    const id = portIdentity(port);
    const shown = (current.ports ?? []).find((x) => portIdentity(x) === id)?.consumers?.length ?? 0;
    if (consumers.filter((c) => c.port_id === port.id).length > shown) out.add(id);
  }
  return out;
}

const listName = (x: string) => x.split('\u0000').filter(Boolean).join(' ');

/**
 * The product as the files say it, its lists included: members, ports, steps and the consumers of each port are those
 * of the file (an item the file leaves out is removed); other fields as add and update (a key left out keeps its value).
 */
function replacedLists(
  cur: ProductFile,
  inc: ProductFile,
  keepPorts: ReadonlySet<string> = new Set(),
): { merged: ProductFile; removed: DataProductImportField[] } {
  const merged = overlay(cur, inc);
  const removed: DataProductImportField[] = [];
  const keep = <T>(field: string, list: T[] | undefined, wanted: T[] | undefined, id: (x: T) => string): T[] => {
    const ids = new Set((wanted ?? []).map(id));
    const out: T[] = [];
    for (const x of list ?? []) {
      if (ids.has(id(x))) out.push(x);
      else removed.push({ field: `${field}[${listName(id(x))}]`, before: 'present', after: 'removed' });
    }
    return out;
  };
  merged.members = keep('members', merged.members, inc.members, (x) => elementKey(x.element));
  const wantedPorts = [...(inc.ports ?? []), ...(merged.ports ?? []).filter((x) => keepPorts.has(portIdentity(x)))];
  merged.ports = keep('ports', merged.ports, wantedPorts, (x) => portIdentity(x)).map((port) => {
    const want = (inc.ports ?? []).find((x) => portIdentity(x) === portIdentity(port));
    // a port kept for consumers the importer may not see keeps its consumers as they are
    if (port.direction !== 'output' || !want) return port;
    return { ...port, consumers: keep(`ports[${portIdentity(port)}].consumers`, port.consumers, want?.consumers, (c) => consumerIdentity(c)) };
  });
  merged.steps = keep('steps', merged.steps, inc.steps, (x) => x.name.toLowerCase());
  return { merged, removed };
}

/**
 * The entries an earlier import of `origin` brought in that the files no longer hold: removed when the importer may see
 * them (their delete right is checked by the services when it runs), kept and counted when not. Discovered elements are
 * discovery's and never removed; an element still part of a product that stays, and a domain still used, are kept with
 * a warning.
 */
function planRemovals(plan: Plan, origin: string, s: Snapshot): void {
  const rows = db().all<{ kind: string; item_id: string }>('SELECT kind, item_id FROM dp_import_origins WHERE origin = ? ORDER BY kind, item_id', origin);
  const ids = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.item_id);
  const fetch = <T extends { id: string }>(table: string, list: string[]): T[] =>
    chunks(list).flatMap((part) => db().all<T>(`SELECT * FROM ${table} WHERE id IN (${marks(part.length)})`, ...part));
  const hidden = () => (plan.counts.keptHidden = (plan.counts.keptHidden ?? 0) + 1);
  const remove = (kind: DataProductImportKind, key: string) => {
    plan.counts.remove = (plan.counts.remove ?? 0) + 1;
    plan.changes.push({ kind, key, action: 'remove', fields: [] });
  };
  const gone = (kind: string, list: string[], found: { id: string }[]) => {
    const have = new Set(found.map((x) => x.id));
    for (const id of list) if (!have.has(id)) plan.removals.gone.push({ kind, id });
  };

  const productIds = ids('dataProduct');
  const products = fetch<ProductRow>('dp_products', productIds);
  gone('dataProduct', productIds, products);
  for (const p of products) {
    if (plan.named.products.has(p.key)) continue;
    if (!productAccess(s.u, p).permissions.length) {
      hidden();
      continue;
    }
    plan.removals.products.push(p);
    remove('dataProduct', p.key);
  }
  const removedProducts = new Set(plan.removals.products.map((p) => p.id));

  const objectIds = ids('dataObject');
  const objects = fetch<ObjectRow>('dp_objects', objectIds);
  gone('dataObject', objectIds, objects);
  for (const o of objects) {
    if (plan.named.objects.has(o.key)) continue;
    if (!objectAccess(s.u, o).permissions.length) {
      hidden();
      continue;
    }
    plan.removals.objects.push(o);
    remove('dataObject', o.key);
  }

  const elementIds = ids('element');
  const elements = elementsByIds(elementIds);
  gone('element', elementIds, [...elements.values()]);
  const teams = elementTeamIds([...elements.keys()]);
  // what products keep each element: memberships in products that stay, after the files' member lists
  const stayingMembers = new Map<string, number>();
  const replaced = new Map(plan.products.filter((e) => e.row).map((e) => [e.row!.id, new Set((e.merged.members ?? []).map((m) => elementKey(m.element)))]));
  const memberships = chunks([...elements.keys()]).flatMap((part) =>
    db().all<{ product_id: string; element_id: string }>(`SELECT product_id, element_id FROM dp_members WHERE element_id IN (${marks(part.length)})`, ...part),
  );
  for (const m of memberships) {
    if (!elements.has(m.element_id) || removedProducts.has(m.product_id)) continue;
    const ref = s.ref(m.element_id);
    const after = replaced.get(m.product_id);
    if (after && ref && !after.has(elementKey(ref))) continue;
    stayingMembers.set(m.element_id, (stayingMembers.get(m.element_id) ?? 0) + 1);
  }
  for (const e of elements.values()) {
    const ref = s.ref(e.id);
    if (ref && plan.named.elements.has(elementKey(ref))) continue;
    if (e.source === 'discovered') continue;
    if (!ref || !elementAccess(s.u, teams.get(e.id) ?? []).permissions.length) {
      hidden();
      continue;
    }
    const display = `${ref.platform ? `${ref.platform}: ` : ''}${ref.qualified_name} (${ref.kind}${ref.environment ? `, ${ref.environment}` : ''})`;
    const staying = stayingMembers.get(e.id) ?? 0;
    if (staying) {
      plan.warnings.push(`${display}: kept – still part of ${staying} data product(s)`);
      continue;
    }
    plan.removals.elements.push(e);
    remove('element', display);
  }

  const domainIds = ids('domain');
  const domains = fetch<DomainRow>('dp_domains', domainIds);
  gone('domain', domainIds, domains);
  const removedObjects = new Set(plan.removals.objects.map((o) => o.id));
  for (const d of domains) {
    if (plan.named.domains.has(d.key)) continue;
    if (!domainAccess(s.u, d).permissions.length) {
      hidden();
      continue;
    }
    // used by a product, data object or sub-domain that stays: kept
    const users =
      db()
        .all<{ id: string }>('SELECT id FROM dp_products WHERE domain_id = ?', d.id)
        .filter((x) => !removedProducts.has(x.id)).length +
      db()
        .all<{ id: string }>('SELECT id FROM dp_objects WHERE domain_id = ?', d.id)
        .filter((x) => !removedObjects.has(x.id)).length +
      db()
        .all<{ id: string; key: string }>('SELECT id, key FROM dp_domains WHERE parent_id = ?', d.id)
        .filter((x) => !domains.some((y) => y.id === x.id && !plan.named.domains.has(y.key))).length;
    if (users) {
      plan.warnings.push(`domains[${d.key}]: kept – still used by ${users} entr${users === 1 ? 'y' : 'ies'}`);
      continue;
    }
    plan.removals.domains.push(d);
    remove('domain', d.key);
  }
}

/** Removals of a plan: entries and list items together (more than one asks for the step-up dataproduct.bulkChange). */
const removalsOf = (plan: Plan): number => (plan.counts.remove ?? 0) + (plan.counts.removedItems ?? 0);

// ---------- writing ----------

const STEP_UP = new Set(['STEP_UP_REQUIRED', 'SESSION_REQUIRED', 'ASSURANCE_MFA_REQUIRED']);

class Rollback extends Error {}

interface Run {
  dry: boolean;
  r: Resolver;
  plan: Plan;
  /** Entries that failed in a dry run: what depends on them is not tried */
  failed: Set<string>;
}

/** One write of an entry; a dry run records a refusal as a problem and goes on, an import stops at it. */
function step(run: Run, file: string, entry: string, what: string, fn: () => void): boolean {
  if (run.failed.has(entry)) return false;
  try {
    fn();
    return true;
  } catch (e) {
    if (!run.dry || !(e instanceof HttpError) || e.statusCode >= 500) {
      if (e instanceof HttpError && !STEP_UP.has(e.code ?? '') && e.statusCode < 500) e.message = `${entry}${what ? ` (${what})` : ''}: ${e.message}`;
      throw e;
    }
    run.failed.add(entry);
    if (STEP_UP.has(e.code ?? '')) run.plan.warnings.push(`${entry}: names someone outside the owning teams – importing asks you to confirm it is you`);
    else if (run.plan.problems.length < IL.problems)
      run.plan.problems.push({ file, path: `${entry}${what ? ` (${what})` : ''}`, message: e.message, ...(e.code ? { code: e.code } : {}) });
    return false;
  }
}

const strings = (s: string | null | undefined): string[] => parseJson<string[]>(s ?? '[]', []);

function objectivesInput(o: PortFile['objectives'] | undefined): DataObjectives {
  if (!o) return {};
  return {
    ...(o.freshness_minutes !== undefined ? { freshnessMinutes: o.freshness_minutes } : {}),
    ...(o.availability_pct !== undefined ? { availabilityPct: o.availability_pct } : {}),
    ...(o.completeness !== undefined ? { completeness: o.completeness } : {}),
    ...(o.completeness_pct !== undefined ? { completenessPct: o.completeness_pct } : {}),
    ...(o.update_schedule !== undefined ? { updateSchedule: o.update_schedule } : {}),
    ...(o.retention !== undefined ? { retention: o.retention } : {}),
  };
}

const ratingInput = (rating: ObjectFile['rating'] | undefined, before: ObjectFile['rating'] | undefined): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const d of CIA_DIMENSIONS) {
    const v = rating?.[d];
    if (v === undefined || same(v, before?.[d] ?? null)) continue;
    out[d] = v;
  }
  return out;
};

function writeDomains(run: Run): void {
  const { r } = run;
  // top-level domains first: a sub-domain names its parent
  const order = [...run.plan.domains].sort((a, b) => Number(!!a.merged.parent) - Number(!!b.merged.parent));
  for (const e of order) {
    const m = e.merged;
    const entry = label('domains', e.key);
    step(run, e.file, entry, '', () => {
      const body = {
        key: m.key,
        name: m.name,
        description: m.description ?? '',
        parentId: m.parent === undefined ? (e.row?.parent_id ?? null) : m.parent ? r.domainId(m.parent) : null,
        colour: m.colour ?? null,
        owners: m.owners ?? [],
      };
      const d = e.row ? svc.updateDomain(e.row.id, body) : svc.createDomain(body);
      r.domainIds.set(m.key, d.id);
    });
  }
}

function writeObjects(run: Run): void {
  const { r } = run;
  for (const e of run.plan.objects) {
    const m = e.merged;
    const entry = label('data_objects', e.key);
    const basics = (x: ObjectFile | null) => {
      if (!x) return null;
      const { rating: _r, elements: _e, ...rest } = x;
      return rest;
    };
    if (!e.row || !same(basics(e.current), basics(m)))
      step(run, e.file, entry, '', () => {
        const body = {
          key: m.key,
          name: m.name,
          definition: m.definition ?? '',
          synonyms: m.synonyms ?? [],
          domainId: m.domain === undefined ? (e.row?.domain_id ?? null) : m.domain ? r.domainId(m.domain) : null,
          lifecycle: m.lifecycle ?? 'draft',
          classification: m.classification ?? null,
          personalData: m.personal_data ?? 'none',
          categories: m.categories ?? [],
          specialCategories: m.special_categories ?? [],
          subjects: m.subjects ?? [],
          legalBasis: m.legal_basis ?? null,
          legalNote: m.legal_note ?? '',
          purposes: m.purposes ?? [],
          retention: m.retention ?? '',
          deletionRule: m.deletion_rule ?? '',
          regulatoryFlags: m.regulatory_flags ?? [],
          attributes: (m.attributes ?? []).map((a) => ({ name: a.name, description: a.description ?? '', personal: !!a.personal })),
          owner: m.owner ?? null,
          stewards: m.stewards ?? [],
          custodians: m.custodians ?? [],
          externalRefs: (m.external_refs ?? []).map((x) => ({ label: x.label ?? '', url: x.url })),
        };
        const o = e.row ? svc.updateObject(e.row.id, body) : svc.createObject(body);
        r.objectIds.set(m.key, o.id);
      });
    else r.objectIds.set(m.key, e.row!.id);
    const rating = ratingInput(m.rating, e.current?.rating);
    if (Object.keys(rating).length) step(run, e.file, entry, 'rating', () => void svc.rateObject(r.objectId(m.key), rating));
  }
}

/** The implementing elements of data objects (after the elements exist). */
function writeObjectElements(run: Run): void {
  const { r } = run;
  for (const e of run.plan.objects) {
    const before = new Map((e.current?.elements ?? []).map((x) => [elementKey(x.element), x.note ?? '']));
    for (const link of e.merged.elements ?? []) {
      const k = elementKey(link.element);
      if (before.has(k) && before.get(k) === (link.note ?? '')) continue;
      step(run, e.file, label('data_objects', e.key), `element ${link.element.qualified_name}`, () =>
        el.addObjectElement(r.objectId(e.merged.key), { elementId: r.elementId(link.element), note: link.note ?? '' }),
      );
    }
  }
}

/**
 * What a background import (import-jobs.ts) keeps of the elements it writes, in the transaction that writes them: an
 * element it added, and the fields an element it changed had before – to take them back if the import fails later.
 */
export interface ElementJournal {
  added(id: string): void;
  changed(row: ElementRow): void;
}

function writeElements(run: Run): void {
  for (const _ of elementWrites(run));
}

/** The element writes one by one (a generator: a background import commits them in batches between its turns). */
function* elementWrites(run: Run, journal?: ElementJournal): Generator<void> {
  const { r } = run;
  // parents first: an element names its parent by its qualified name (same platform and environment)
  const pending = [...run.plan.elements];
  const parentOf = (e: Entry<ElementFile, ElementRow>): string | null => {
    const parent = e.merged.parent;
    if (!parent) return null;
    const ref = {
      ...(e.merged.platform ? { platform: e.merged.platform } : {}),
      kind: e.merged.kind,
      qualified_name: parent,
      environment: e.merged.environment ?? '',
    };
    // the parent's kind is not written: any element of that name on the platform in that environment
    const p = r.platform(ref);
    const platformId = p && typeof p !== 'string' ? p.id : '';
    const row = db().get<{ id: string }>(
      'SELECT id FROM dp_elements WHERE platform_id = ? AND environment = ? AND name_norm = ? ORDER BY kind LIMIT 1',
      platformId,
      ref.environment,
      elementNameNorm(parent),
    );
    return row?.id ?? null;
  };
  // what the import reads once for all its elements (the room in the catalogue, the creator's teams, the platforms)
  const batch = el.elementBatch();
  // pending new elements by their (lower-case) qualified name: a parent this import adds is waited for (counted, so the
  // check costs nothing per element – 20,000 elements must not compare 20,000 × 20,000 names)
  const adding = new Map<string, number>();
  const named = (e: Entry<ElementFile, ElementRow>) => e.merged.qualified_name.toLowerCase();
  for (const e of pending) if (!e.row) adding.set(named(e), (adding.get(named(e)) ?? 0) + 1);
  let todo = pending;
  for (let round = 0; todo.length && round < 12; round++) {
    const later: typeof todo = [];
    for (const e of todo) {
      const m = e.merged;
      const entry = label('elements', e.key);
      if (e.row) {
        step(run, e.file, entry, '', () => {
          journal?.changed(e.row!);
          const api = parseJson<Record<string, unknown> | null>(e.row!.api_ref, null);
          el.updateElement(e.row!.id, {
            displayName: m.display_name ?? e.row!.display_name,
            layer: m.layer ?? e.row!.layer,
            description: m.description ?? e.row!.description,
            typeLabel: m.type_label ?? e.row!.type_label,
            ...(m.api_ref !== undefined ? { apiRef: m.api_ref ? { ...(api ?? {}), ...m.api_ref } : null } : {}),
          });
        });
        yield;
        continue;
      }
      const parentId = parentOf(e);
      // the parent is added by this import, later in the list: next round
      const parent = m.parent?.toLowerCase();
      if (parent && !parentId && round < 11 && (adding.get(parent) ?? 0) - (parent === named(e) ? 1 : 0) > 0) {
        later.push(e);
        continue;
      }
      step(run, e.file, entry, '', () => {
        const p = r.platform(m);
        const id = el.insertElement(
          {
            platformId: p && typeof p !== 'string' ? p.id : null,
            kind: m.kind,
            qualifiedName: m.qualified_name,
            displayName: m.display_name ?? '',
            environment: m.environment ?? '',
            parentId,
            layer: m.layer ?? '',
            description: m.description ?? '',
            typeLabel: m.type_label ?? '',
            apiRef: m.api_ref ?? null,
            flags: Object.entries(m.flags ?? {}).map(([name, value]) => ({ name, value })),
          },
          'imported',
          batch,
        );
        r.elementIds.set(elementKey(m), id);
        journal?.added(id);
      });
      adding.set(named(e), (adding.get(named(e)) ?? 1) - 1);
      yield;
    }
    todo = later;
  }
}

function productBody(r: Resolver, e: Entry<ProductFile, ProductRow>, withSuccessor: boolean) {
  const m = e.merged;
  const row = e.row;
  const support = { channel: '', url: '', hours: '', ...parseJson<Record<string, string>>(row?.support ?? '{}', {}), ...(m.support ?? {}) };
  let successorId: string | null = row?.successor_id ?? null;
  if (m.successor !== undefined && withSuccessor) successorId = m.successor ? r.productId(m.successor) : null;
  else if (m.successor && !withSuccessor) successorId = r.productIds.get(m.successor) ?? r.product(m.successor)?.id ?? successorId;
  return {
    key: m.key,
    name: m.name,
    description: m.description ?? '',
    purpose: m.purpose ?? '',
    type: m.type ?? null,
    domainId: m.domain === undefined ? (row?.domain_id ?? null) : m.domain ? r.domainId(m.domain) : null,
    owners: m.owners ?? [],
    support: { channel: support.channel ?? '', url: support.url ?? '', hours: support.hours ?? '' },
    criticality: m.criticality ?? null,
    tier: m.tier ?? null,
    version: m.version ?? '',
    valueStatement: m.value_statement ?? '',
    valueTier: m.value_tier ?? null,
    valueAmount: m.value_amount === undefined || m.value_amount === null ? null : Math.round(m.value_amount * 1e6),
    valueCurrency: m.value_currency ?? null,
    successorId,
    tags: m.tags ?? [],
    externalRefs: (m.external_refs ?? []).map((x) => ({ label: x.label ?? '', url: x.url })),
  };
}

const BASICS: (keyof ProductFile)[] = [
  'key',
  'name',
  'description',
  'purpose',
  'type',
  'domain',
  'owners',
  'support',
  'criticality',
  'tier',
  'version',
  'value_statement',
  'value_tier',
  'value_amount',
  'value_currency',
  'tags',
  'external_refs',
];
const pick = (x: ProductFile | null, keys: (keyof ProductFile)[]) => (x ? Object.fromEntries(keys.map((k) => [k, x[k]])) : null);

/** The source of an input port as the service takes it. */
function sourceInput(r: Resolver, src: PortFile['source']): unknown {
  if (!src) return null;
  if (src.element) return { kind: 'element', elementId: r.elementId(src.element) };
  if (src.product) {
    const pid = r.productId(src.product);
    const sp = portsOf([pid]).find((p) => p.direction === 'output' && p.name === src.port && p.version === (src.version ?? ''));
    if (!sp)
      throw new HttpError(404, `Port ${src.product}/${src.port ?? ''} ${src.version ?? ''} not found`, 'DATA_PORT_NOT_FOUND', {
        id: `${src.product}/${src.port ?? ''}`,
      });
    return { kind: 'port', portId: sp.id };
  }
  if (src.text) return { kind: 'text', text: src.text };
  return null;
}

function portBody(r: Resolver, x: PortFile, row: PortRow | undefined, productPorts: PortRow[], strictSuccessor: boolean) {
  let successorId: string | null = row?.successor_id ?? null;
  if (x.successor) {
    const found = productPorts.find((p) => p.name === x.successor!.name && p.version === (x.successor!.version ?? '') && p.id !== row?.id);
    if (!found && strictSuccessor)
      throw new HttpError(404, `Port ${x.successor.name} ${x.successor.version ?? ''} not found`, 'DATA_PORT_NOT_FOUND', { id: x.successor.name });
    successorId = found?.id ?? (strictSuccessor ? null : successorId);
  } else if (x.successor === null) successorId = null;
  return {
    direction: x.direction,
    name: x.name,
    type: x.type ?? 'table',
    version: x.version ?? '',
    description: x.description ?? '',
    lifecycle: x.lifecycle ?? 'draft',
    sunsetDate: x.sunset_date ?? null,
    successorId,
    objectives: objectivesInput(x.objectives),
    source:
      x.source === undefined
        ? row?.source_kind === 'port'
          ? { kind: 'port', portId: row.source_port_id }
          : row?.source_kind === 'element'
            ? { kind: 'element', elementId: row.source_element_id }
            : row?.source_kind === 'text'
              ? { kind: 'text', text: row.source_text }
              : null
        : sourceInput(r, x.source),
    objectIds: (x.data_objects ?? []).map((k) => r.objectId(k)),
    ...(row ? { position: Number(row.position) } : {}),
    // 0.25.0: left out, a file port keeps its format and partition keys
    ...(x.file_format !== undefined ? { fileFormat: x.file_format } : {}),
    ...(x.partitioning !== undefined ? { partitioning: x.partitioning } : {}),
  };
}

function runnerInput(r: Resolver, x: RunnerFile | null | undefined, rowRunner: string | null): unknown {
  if (x === undefined) return parseJson(rowRunner, null);
  if (!x) return null;
  if (x.kind === 'tool') return { kind: 'tool', tool: x.tool ?? '', text: x.text ?? '' };
  if (x.kind === 'connector') return { kind: 'connector', platformId: r.named('platform', x.platform ?? ''), name: x.name ?? '' };
  if (x.kind === 'element') {
    if (!x.element) throw new HttpError(400, 'The runner names no element', 'DATA_STEP_INVALID', { context: 'runner' });
    return { kind: 'element', id: r.elementId(x.element) };
  }
  return { kind: x.kind, id: r.named(x.kind, x.name ?? '') };
}

function consumerBody(r: Resolver, c: ConsumerFile) {
  return {
    kind: c.kind,
    refId: c.kind === 'product' ? r.productId(c.ref ?? '') : c.kind === 'application' || c.kind === 'service' ? r.named(c.kind, c.ref ?? '') : null,
    subject: c.kind === 'team' || c.kind === 'user' ? (c.subject ?? null) : null,
    text: c.text ?? '',
    purpose: c.purpose ?? '',
    since: c.since ?? null,
    endDate: c.end_date ?? null,
    agreement: c.agreement ? { kind: c.agreement.kind, ref: c.agreement.ref, label: c.agreement.label ?? '' } : null,
    contacts: c.contacts ?? [],
  };
}

/** Products in four passes: basics (and environments and members), output then input ports, bindings, consumers and steps, then successors, ratings and lifecycles. */
function writeProducts(run: Run): void {
  const { r } = run;
  const entries = run.plan.products;
  const entryOf = (e: Entry<ProductFile, ProductRow>) => label('data_products', e.key);
  const productOf = (e: Entry<ProductFile, ProductRow>) => r.productId(e.merged.key);
  const nameOf = (e: Entry<ProductFile, ProductRow>) => e.merged.name;

  // 1. basics, environments, members
  for (const e of entries) {
    const entry = entryOf(e);
    if (!e.row || !same(pick(e.current, BASICS), pick(e.merged, BASICS)))
      step(run, e.file, entry, '', () => {
        const body = productBody(r, e, false);
        const p = e.row ? svc.updateProduct(e.row.id, body) : svc.createProduct(body);
        r.productIds.set(e.merged.key, p.id);
      });
    else r.productIds.set(e.merged.key, e.row!.id);
    const envs = new Map((e.current?.environments ?? []).map((x) => [x.environment, x.state]));
    for (const x of e.merged.environments ?? [])
      if (!envs.has(x.environment) || envs.get(x.environment) !== (x.state ?? 'planned'))
        step(
          run,
          e.file,
          entry,
          `environment ${x.environment}`,
          () => void svc.setEnvironment(productOf(e), x.environment, x.state ?? envs.get(x.environment) ?? 'planned'),
        );
    const members = new Map((e.current?.members ?? []).map((x) => [elementKey(x.element), x]));
    // the import itself (0.25.0) adds members up to 500 at a time with the same role, scope and note – one write and
    // audit entry per group instead of per member; the preview (dry) keeps one per member, so a refusal names its member
    const groups = new Map<string, { ids: string[]; names: string[]; body: { role: string; includeDescendants: boolean; note: string } }>();
    for (const x of e.merged.members ?? []) {
      const old = members.get(elementKey(x.element));
      if (old && same(old, x)) continue;
      const body = {
        role: x.role ?? old?.role ?? 'internal',
        includeDescendants: x.include_descendants ?? old?.include_descendants ?? false,
        note: x.note ?? old?.note ?? '',
      };
      if (!run.dry && r.elementIds.has(elementKey(x.element))) {
        const k = JSON.stringify(body);
        const g = groups.get(k) ?? { ids: [], names: [], body };
        g.ids.push(r.elementId(x.element));
        g.names.push(x.element.qualified_name);
        groups.set(k, g);
        continue;
      }
      step(
        run,
        e.file,
        entry,
        `member ${x.element.qualified_name}`,
        () =>
          void el.addMembers(productOf(e), nameOf(e), {
            elementIds: [r.elementId(x.element)],
            role: x.role ?? old?.role ?? 'internal',
            includeDescendants: x.include_descendants ?? old?.include_descendants ?? false,
            note: x.note ?? old?.note ?? '',
          }),
      );
    }
    for (const g of groups.values())
      for (let i = 0; i < g.ids.length; i += DATA_PRODUCT_LIMITS.membersPerRequest)
        step(
          run,
          e.file,
          entry,
          `members ${g.names.slice(i, i + 3).join(', ')}${g.ids.length - i > 3 ? ' …' : ''}`,
          () => void el.addMembers(productOf(e), nameOf(e), { ...g.body, elementIds: g.ids.slice(i, i + DATA_PRODUCT_LIMITS.membersPerRequest) }),
        );
  }

  // 2. ports: output ports of every product first (input ports name them), then the successors (once all exist)
  const writePorts = (direction: 'output' | 'input') => {
    for (const e of entries) {
      const entry = entryOf(e);
      if (run.failed.has(entry)) continue;
      const current = new Map((e.current?.ports ?? []).map((x) => [portIdentity(x), x]));
      for (const x of (e.merged.ports ?? []).filter((p) => p.direction === direction)) {
        const old = current.get(portIdentity(x));
        const strip = (p: PortFile | undefined) => {
          if (!p) return null;
          const { bindings: _b, consumers: _c, successor: _s, ...rest } = p;
          return rest;
        };
        if (old && same(strip(old), strip(x))) continue;
        step(run, e.file, entry, `port ${portIdentity(x)}`, () => {
          const pid = productOf(e);
          const list = portsOf([pid]);
          const row = list.find((p) => portIdentity(p) === portIdentity(x));
          const body = portBody(r, x, row, list, false);
          if (row) ports.updatePort(pid, nameOf(e), row.id, body);
          else ports.addPort(pid, nameOf(e), body);
          svc.touchProduct(pid);
        });
      }
    }
  };
  writePorts('output');
  writePorts('input');
  for (const e of entries) {
    const entry = entryOf(e);
    if (run.failed.has(entry)) continue;
    for (const x of e.merged.ports ?? []) {
      if (x.successor === undefined) continue;
      step(run, e.file, entry, `successor of port ${portIdentity(x)}`, () => {
        const pid = productOf(e);
        const list = portsOf([pid]);
        const row = list.find((p) => portIdentity(p) === portIdentity(x));
        if (!row) return;
        const body = portBody(r, x, row, list, true);
        if ((row.successor_id ?? null) !== body.successorId) {
          ports.updatePort(pid, nameOf(e), row.id, body);
          svc.touchProduct(pid);
        }
      });
    }
  }

  // 3. bindings, consumers, steps
  for (const e of entries) {
    const entry = entryOf(e);
    if (run.failed.has(entry)) continue;
    const current = new Map((e.current?.ports ?? []).map((x) => [portIdentity(x), x]));
    for (const x of e.merged.ports ?? []) {
      const old = current.get(portIdentity(x));
      const portRow = () => portsOf([productOf(e)]).find((p) => portIdentity(p) === portIdentity(x));
      const oldBindings = new Map((old?.bindings ?? []).map((b) => [b.environment, b]));
      for (const b of x.bindings ?? []) {
        const ob = oldBindings.get(b.environment);
        if (ob && same(ob, b)) continue;
        step(run, e.file, entry, `port ${portIdentity(x)} in ${b.environment}`, () => {
          const pr = portRow();
          if (!pr) throw new HttpError(404, `Port ${portIdentity(x)} not found`, 'DATA_PORT_NOT_FOUND', { id: portIdentity(x) });
          const stored = db().get<{ contract_id: string | null; contract_version: number | null; contract_server: string | null }>(
            'SELECT contract_id, contract_version, contract_server FROM dp_port_bindings WHERE port_id = ? AND environment = ?',
            pr.id,
            b.environment,
          );
          const keepContract = b.contract === undefined;
          ports.setBinding(productOf(e), nameOf(e), pr.id, b.environment, {
            elementIds: (b.elements ?? []).map((ref) => r.elementId(ref)),
            contractId: keepContract ? (stored?.contract_id ?? null) : b.contract ? r.contractId(b.contract) : null,
            contractVersion: keepContract && b.contract_version === undefined ? (stored?.contract_version ?? null) : (b.contract_version ?? null),
            contractServer: keepContract && b.contract_server === undefined ? (stored?.contract_server ?? null) : (b.contract_server ?? null),
            objectives: objectivesInput(b.objectives),
          });
          svc.touchProduct(productOf(e));
        });
      }
      const oldConsumers = new Map((old?.consumers ?? []).map((c) => [consumerIdentity(c), c]));
      for (const c of x.consumers ?? []) {
        const oc = oldConsumers.get(consumerIdentity(c));
        if (oc && same(oc, c)) continue;
        step(run, e.file, entry, `consumer ${consumerIdentity(c)} of port ${portIdentity(x)}`, () => {
          const pr = portRow();
          if (!pr) throw new HttpError(404, `Port ${portIdentity(x)} not found`, 'DATA_PORT_NOT_FOUND', { id: portIdentity(x) });
          const body = consumerBody(r, c);
          const existing = oc ? consumersOf([pr.id]).find((row) => consumerIdentityOfRow(run.r, row) === consumerIdentity(c)) : undefined;
          const id = existing
            ? (ports.updateConsumer(productOf(e), nameOf(e), pr.id, existing.id, body), existing.id)
            : ports.addConsumer(productOf(e), nameOf(e), pr.id, body).id;
          // the platform identities it names (0.24.0); a file that leaves them out keeps them
          if (c.identities) db().tx(() => writeIdentities(id, c.identities!));
        });
      }
    }
    const oldSteps = new Map((e.current?.steps ?? []).map((x) => [x.name.toLowerCase(), x]));
    for (const x of e.merged.steps ?? []) {
      const old = oldSteps.get(x.name.toLowerCase());
      if (old && same(old, x)) continue;
      step(run, e.file, entry, `step ${x.name}`, () => {
        const pid = productOf(e);
        const stored = old ? steps.productSteps(pid).find((st) => st.name.toLowerCase() === x.name.toLowerCase()) : undefined;
        const rowRunner = stored ? (db().get<{ runner: string | null }>('SELECT runner FROM dp_steps WHERE id = ?', stored.id)?.runner ?? null) : null;
        const body = {
          name: x.name,
          kind: x.kind ?? 'transform',
          runner: runnerInput(r, x.runner, rowRunner),
          schedule: x.schedule ?? '',
          description: x.description ?? '',
          notes: (x.notes ?? []).map((n) => ({ kind: n.kind, text: n.text ?? '' })),
          inputs: (x.inputs ?? []).map((ref) => r.elementId(ref)),
          outputs: (x.outputs ?? []).map((ref) => r.elementId(ref)),
        };
        if (stored) steps.updateStep(pid, nameOf(e), stored.id, body);
        else steps.createStep(pid, nameOf(e), body);
      });
    }
  }

  // 4. successors (products the import adds), ratings (the floor needs the ports), lifecycles (active needs ports and owners)
  for (const e of entries) {
    const entry = entryOf(e);
    if (run.failed.has(entry)) continue;
    const m = e.merged;
    if (m.successor !== undefined && m.successor !== (e.current?.successor ?? null))
      step(run, e.file, entry, 'successor', () => {
        const pid = productOf(e);
        const row = db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', pid)!;
        const want = m.successor ? r.productId(m.successor) : null;
        if (row.successor_id !== want) svc.updateProduct(pid, { ...productBody(r, { ...e, row }, true), successorId: want });
      });
    const before = e.current?.rating;
    const rating: Record<string, unknown> = ratingInput(m.rating, before);
    if (m.rating?.classification !== undefined && (m.rating.classification ?? null) !== (before?.classification ?? null))
      rating.classification = m.rating.classification;
    if (m.rating?.reasons !== undefined && !same(m.rating.reasons, before?.reasons ?? {})) rating.reasons = m.rating.reasons;
    if (Object.keys(rating).length) step(run, e.file, entry, 'rating', () => void svc.rateProduct(productOf(e), rating));
    const cur = e.current?.lifecycle ?? 'proposed';
    const want = m.lifecycle ?? cur;
    const sunsetChanged = m.sunset_date !== undefined && (m.sunset_date ?? null) !== (e.current?.sunset_date ?? null);
    if (want !== cur || (sunsetChanged && (want === 'deprecated' || want === 'retired')))
      step(
        run,
        e.file,
        entry,
        'lifecycle',
        () => void svc.changeLifecycle(productOf(e), { lifecycle: want, ...(m.sunset_date !== undefined ? { sunsetDate: m.sunset_date } : {}) }),
      );
  }
}

/** A stored consumer's identity in the file's words (as the person may see it). */
function consumerIdentityOfRow(r: Resolver, c: ReturnType<typeof consumersOf>[number]): string {
  const kind = c.consumer_kind;
  if (kind === 'team' || kind === 'user') return `${kind}:${strings(c.consumer_subjects)[0] ?? ''}`.toLowerCase();
  if (kind === 'text') return `text:${c.consumer_text}`.toLowerCase();
  const ref = c.ref_id ? (kind === 'product' ? r.s.productKey(c.ref_id) : r.s.catalogueName(kind as 'application' | 'service', c.ref_id)) : null;
  return `${kind}:${ref ?? ''}`.toLowerCase();
}

function execute(plan: Plan, dry: boolean): void {
  if (!plan.r) return;
  const run: Run = { dry, r: plan.r, plan, failed: new Set() };
  writeDomains(run);
  writeObjects(run);
  writeElements(run);
  writeRest(run);
}

/** Everything after the elements: the data objects' elements, the products, the removals of a replace, the origins. */
function writeRest(run: Run): void {
  const { plan } = run;
  writeObjectElements(run);
  writeProducts(run);
  if (plan.replaceLists) removeListItems(run);
  if (plan.mode === 'replace') writeRemovals(run);
  if (plan.origin && !run.dry) recordOrigins(run, plan.origin);
}

/** Replace: the members, ports, steps and consumers of the files' products that the files leave out. */
function removeListItems(run: Run): void {
  const { r } = run;
  for (const e of run.plan.products) {
    if (!e.row || !e.current) continue;
    const entry = label('data_products', e.key);
    if (run.failed.has(entry)) continue;
    const pid = e.row.id;
    const name = e.merged.name;
    const wantPorts = new Map((e.merged.ports ?? []).map((x) => [portIdentity(x), x]));
    const portRows = portsOf([pid]);
    // consumers of the ports that stay
    for (const port of portRows) {
      const want = wantPorts.get(portIdentity(port));
      if (!want || port.direction !== 'output') continue;
      const keep = new Set((want.consumers ?? []).map((c) => consumerIdentity(c)));
      const shown = new Set((e.current.ports ?? []).find((x) => portIdentity(x) === portIdentity(port))?.consumers?.map((c) => consumerIdentity(c)) ?? []);
      for (const c of consumersOf([port.id])) {
        const id = consumerIdentityOfRow(r, c);
        // only what the export showed the importer can be removed (a consumer they may not see stays)
        if (keep.has(id) || !shown.has(id)) continue;
        step(run, e.file, entry, `remove consumer ${id} of port ${portIdentity(port)}`, () => ports.removeConsumer(pid, name, port.id, c.id));
      }
    }
    const wantSteps = new Set((e.merged.steps ?? []).map((x) => x.name.toLowerCase()));
    const shownSteps = new Set((e.current.steps ?? []).map((x) => x.name.toLowerCase()));
    for (const st of steps.productSteps(pid))
      if (!wantSteps.has(st.name.toLowerCase()) && shownSteps.has(st.name.toLowerCase()))
        step(run, e.file, entry, `remove step ${st.name}`, () => steps.deleteStep(pid, name, st.id));
    for (const port of portRows)
      if (!wantPorts.has(portIdentity(port))) step(run, e.file, entry, `remove port ${portIdentity(port)}`, () => ports.deletePort(pid, name, port.id));
    const wantMembers = new Set((e.merged.members ?? []).map((m) => elementKey(m.element)));
    for (const m of membersOf([pid])) {
      const ref = r.s.ref(m.element_id);
      // a member on a platform the importer may not see is never removed (it is not in the file they could write)
      if (!ref || wantMembers.has(elementKey(ref))) continue;
      step(run, e.file, entry, `remove member ${ref.qualified_name}`, () => el.removeMember(pid, name, m.element_id));
    }
    // the product changed (its revision: Git sync tells changes in Steward by it)
    if (!run.failed.has(entry)) svc.touchProduct(pid);
  }
}

/** Replace: the origin's entries the files no longer hold – products, then elements and data objects, then domains (sub-domains first). */
function writeRemovals(run: Run): void {
  const x = run.plan.removals;
  for (const p of x.products) step(run, '(replace)', label('data_products', p.key), 'remove', () => svc.deleteProduct(p.id));
  for (const e of x.elements) step(run, '(replace)', label('elements', e.qualified_name), 'remove', () => el.deleteElement(e.id));
  for (const o of x.objects) step(run, '(replace)', label('data_objects', o.key), 'remove', () => svc.deleteObject(o.id));
  const domains = [...x.domains].sort((a, b) => Number(!!b.parent_id) - Number(!!a.parent_id));
  for (const d of domains) step(run, '(replace)', label('domains', d.key), 'remove', () => svc.deleteDomain(d.id));
}

/** Keeps every entry the files name under the import's origin (and forgets those it removed or that are gone). */
function recordOrigins(run: Run, origin: string): void {
  const { r, plan } = run;
  const at = nowIso();
  const add = (kind: string, id: string | undefined) => {
    if (id) db().run('INSERT INTO dp_import_origins (origin, kind, item_id, recorded_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', origin, kind, id, at);
  };
  const byKey = (table: string, key: string) => db().get<{ id: string }>(`SELECT id FROM ${table} WHERE key = ?`, key)?.id;
  for (const k of plan.named.domains) add('domain', r.domainIds.get(k) ?? byKey('dp_domains', k));
  for (const k of plan.named.objects) add('dataObject', r.objectIds.get(k) ?? byKey('dp_objects', k));
  for (const k of plan.named.products) add('dataProduct', r.productIds.get(k) ?? byKey('dp_products', k));
  for (const k of plan.named.elements) add('element', r.elementIds.get(k));
  const forget = [
    ...plan.removals.products.map((x) => ({ kind: 'dataProduct', id: x.id })),
    ...plan.removals.objects.map((x) => ({ kind: 'dataObject', id: x.id })),
    ...plan.removals.domains.map((x) => ({ kind: 'domain', id: x.id })),
    ...plan.removals.elements.map((x) => ({ kind: 'element', id: x.id })),
    ...plan.removals.gone,
  ];
  for (const f of forget) db().run('DELETE FROM dp_import_origins WHERE origin = ? AND kind = ? AND item_id = ?', origin, f.kind, f.id);
}

function fingerprintOf(plan: Plan): string {
  return sha256(stable({ mode: plan.mode, counts: plan.counts, changes: plan.changes, files: plan.files.map((f) => f.sha256), origin: plan.origin })).slice(
    0,
    32,
  );
}

/**
 * How many entries and list items an import of this body removes (mode replace, or a caller's replaced lists) – the
 * route asks for the step-up dataproduct.bulkChange above one. Reads only; a body that does not parse removes nothing.
 */
export function importRemovals(body: unknown): number {
  const input = importInput.safeParse(body);
  if (!input.success || input.data.mode !== 'replace') return 0;
  try {
    return removalsOf(buildPlan(input.data));
  } catch {
    return 0;
  }
}

/** What an import of these files would add, change and skip – nothing is written. */
export function previewImport(body: unknown, o: ImportOptions = {}): DataProductImportPreview {
  const input = importInput.parse(body);
  const plan = buildPlan(input, o);
  if (!plan.problems.length) {
    try {
      withoutAudit(() =>
        holdingNotices(false, () =>
          db().tx(() => {
            execute(plan, true);
            throw new Rollback();
          }),
        ),
      );
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
  }
  return {
    mode: plan.mode,
    counts: plan.counts,
    changes: plan.changes,
    problems: plan.problems.slice(0, IL.problems),
    warnings: [...new Set(plan.warnings)].slice(0, 100),
    files: plan.files,
    fingerprint: fingerprintOf(plan),
    origin: plan.origin,
    stepUp: removalsOf(plan) > DATA_PRODUCT_IMPORT_REMOVALS_WITHOUT_STEP_UP,
    ...(plan.odps ? { odps: plan.odps } : {}),
  };
}

/** The plan of an import, checked: problems and a preview that changed since refuse it (nothing is written). */
function checkedPlan(body: unknown, o: ImportOptions): Plan {
  const input = importInput.parse(body);
  const plan = buildPlan(input, o);
  if (plan.problems.length) {
    const secret = plan.problems.filter((p) => p.code === 'DATA_PRODUCT_IMPORT_SECRET');
    if (secret.length)
      throw new HttpError(
        400,
        `The files hold what looks like a credential – nothing was imported: ${secret
          .slice(0, 5)
          .map((p) => `${p.file} ${p.path}`)
          .join('; ')}`,
        'DATA_PRODUCT_IMPORT_SECRET',
        {
          count: secret.length,
          places: secret
            .slice(0, 5)
            .map((p) => `${p.file} ${p.path}`)
            .join('; '),
        },
      );
    const first = plan.problems[0]!;
    throw new HttpError(
      400,
      `The files cannot be imported (${plan.problems.length} problem(s)): ${first.file} ${first.path}: ${first.message}`,
      'DATA_PRODUCT_IMPORT_INVALID',
      {
        count: plan.problems.length,
        file: first.file,
        path: first.path,
        message: first.message,
      },
    );
  }
  if (input.fingerprint && input.fingerprint !== fingerprintOf(plan))
    throw new HttpError(409, 'The data products changed since the preview – check the preview again', 'DATA_PRODUCT_IMPORT_CHANGED');
  return plan;
}

/** Imports the files in one transaction (400 DATA_PRODUCT_IMPORT_INVALID with the first problems, nothing written). */
export function applyImport(body: unknown, o: ImportOptions = {}): DataProductImportResult {
  // a background import's journal could not take back what this one changed: it waits (Git sync, proposals)
  const job = db().get<{ created_by: string }>("SELECT created_by FROM dp_import_jobs WHERE state = 'running' LIMIT 1");
  if (job)
    throw new HttpError(409, `An import of ${job.created_by} is running – try again when it has ended`, 'DATA_PRODUCT_IMPORT_RUNNING', {
      by: job.created_by,
    });
  return commitPlanned({ plan: checkedPlan(body, o) });
}

/** The audit entry of an import, in its transaction. */
function auditImport(plan: Plan, job?: string): void {
  const c = plan.counts;
  const mode = plan.mode === 'add' ? 'add only' : plan.mode === 'replace' ? `replace ${plan.origin}` : 'add and update';
  audit({
    action: 'dataproduct.imported',
    entityType: 'data_product',
    summary: `Data products imported (${mode}): ${c.add} added, ${c.change} changed, ${c.unchanged} unchanged, ${c.skip} skipped${
      c.remove !== undefined ? `, ${c.remove} removed, ${c.removedItems ?? 0} list item(s) removed, ${c.keptHidden ?? 0} kept (not visible)` : ''
    } – ${plan.files.length} file(s)${plan.odps ? ` (${plan.odps} ODPS)` : ''}`,
    details: {
      mode: plan.mode,
      counts: c,
      files: plan.files,
      ...(plan.origin ? { origin: plan.origin } : {}),
      ...(plan.odps ? { odps: plan.odps } : {}),
      ...(job ? { job } : {}),
      ...(plan.mode === 'replace'
        ? {
            removed: plan.changes
              .filter((x) => x.action === 'remove')
              .map((x) => ({ kind: x.kind, key: x.key }))
              .slice(0, 500),
          }
        : {}),
    },
  });
}

const resultOf = (plan: Plan): DataProductImportResult => ({ mode: plan.mode, counts: plan.counts, warnings: [...new Set(plan.warnings)].slice(0, 100) });

/** A checked import plan, for import-jobs.ts (opaque but for its size). */
export interface PlannedImport {
  plan: Plan;
}

/**
 * The checked plan of an import and how many elements it writes (0.25.0): the route runs an import with more than
 * DATA_PRODUCT_IMPORT_JOB_ELEMENTS of them in the background (import-jobs.ts), smaller ones at once.
 */
export function planImport(
  body: unknown,
  o: ImportOptions = {},
): { planned: PlannedImport; elementWrites: number; mode: DataProductImportMode; origin: string | null } {
  const plan = checkedPlan(body, o);
  return { planned: { plan }, elementWrites: plan.elements.length, mode: plan.mode, origin: plan.origin };
}

/** Writes a checked plan in one transaction. */
export function commitPlanned({ plan }: PlannedImport): DataProductImportResult {
  // deprecations it makes tell their consumers once it is committed (a refused import tells nobody)
  holdingNotices(true, () =>
    db().tx(() => {
      execute(plan, false);
      auditImport(plan);
    }),
  );
  return resultOf(plan);
}

/**
 * Writes a checked plan in steps (0.25.0, the background import): the elements first, in transactions of at most
 * `batchMs` each with a turn of the event loop between (each writes what it did to `journal` and calls `batch` with the
 * elements written so far, in its transaction), then everything else – domains, data objects, products, removals,
 * origins and the audit entry – in one transaction. A failure throws: the caller takes back what the journal holds.
 */
export async function commitPlannedStepwise(
  { plan }: PlannedImport,
  journal: ElementJournal,
  o: { batchMs: number; batch: (done: number, total: number, ms: number) => void; beforeRest?: () => void; rest?: (ms: number) => void; job?: string },
): Promise<DataProductImportResult> {
  if (!plan.r) return resultOf(plan);
  const run: Run = { dry: false, r: plan.r, plan, failed: new Set() };
  const total = plan.elements.length;
  const writes = elementWrites(run, journal);
  let done = 0;
  let end = false;
  while (!end) {
    const t0 = performance.now();
    db().tx(() => {
      while (performance.now() - t0 < o.batchMs) {
        if (writes.next().done) {
          end = true;
          break;
        }
        done++;
      }
      o.batch(done, total, performance.now() - t0);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  o.beforeRest?.();
  const t1 = performance.now();
  holdingNotices(true, () =>
    db().tx(() => {
      writeDomains(run);
      writeObjects(run);
      writeRest(run);
      auditImport(plan, o.job);
    }),
  );
  o.rest?.(performance.now() - t1);
  return resultOf(plan);
}

/**
 * GET /api/data-products/import-origins – the origins of earlier imports, each with the entries under it the caller
 * may see, the newest first (DATA_PRODUCT_IMPORT_ORIGINS_LISTED): the suggestions of _Replace an earlier import_. An
 * origin whose entries the caller may not see is neither listed nor counted.
 */
export function importOrigins(): { items: DataProductImportOrigin[] } {
  const u = me();
  const seen = new Map<string, { entries: number; lastAt: string }>();
  const count = (origin: string, at: string) => {
    const o = seen.get(origin) ?? { entries: 0, lastAt: at };
    o.entries += 1;
    if (at > o.lastAt) o.lastAt = at;
    seen.set(origin, o);
  };
  type Joined<T> = T & { origin: string; recorded_at: string };
  const joined = <T>(table: string, kind: string) =>
    db().all<Joined<T>>(
      `SELECT t.*, o.origin AS origin, o.recorded_at AS recorded_at FROM dp_import_origins o JOIN ${table} t ON t.id = o.item_id WHERE o.kind = ?`,
      kind,
    );
  for (const r of joined<ProductRow>('dp_products', 'dataProduct')) if (productAccess(u, r).permissions.length) count(r.origin, r.recorded_at);
  for (const r of joined<ObjectRow>('dp_objects', 'dataObject')) if (objectAccess(u, r).permissions.length) count(r.origin, r.recorded_at);
  for (const r of joined<DomainRow>('dp_domains', 'domain')) if (domainAccess(u, r).permissions.length) count(r.origin, r.recorded_at);
  const elements = db().all<{ origin: string; recorded_at: string; item_id: string }>(
    "SELECT o.origin, o.recorded_at, o.item_id FROM dp_import_origins o JOIN dp_elements e ON e.id = o.item_id WHERE o.kind = 'element'",
  );
  const teams = elementTeamIds([...new Set(elements.map((e) => e.item_id))]);
  for (const r of elements) if (elementAccess(u, teams.get(r.item_id) ?? []).permissions.length) count(r.origin, r.recorded_at);
  const items = [...seen]
    .map(([origin, o]) => ({ origin, entries: o.entries, lastAt: o.lastAt }))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.origin.localeCompare(b.origin))
    .slice(0, DATA_PRODUCT_IMPORT_ORIGINS_LISTED);
  return { items };
}

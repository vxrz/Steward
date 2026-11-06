import {
  DB_SCHEMA_LIMITS,
  qualifiedTable,
  type DbSchemaChange,
  type DbSchemaChangeKind,
  type DbSchemaDialect,
  type DbSchemaDiff,
  type DbSchemaDoc,
  type DbSchemaIndex,
  type DbSchemaTable,
} from '@sm/shared';
import { fkSignature } from './model.js';

/**
 * Changes between two snapshots (#222, docs/DATABASES.md#changes-between-snapshots): added, removed and changed tables
 * and columns (type, null, default), keys and indexes. A change is **breaking** when a reader or writer that worked
 * before can fail afterwards:
 *
 * - a table or a column was removed;
 * - a column type was narrowed (shorter text, a smaller integer, less precision) or changed to another kind of type;
 * - a column became NOT NULL without a default, or a new NOT NULL column has none;
 * - a key was removed or changed: the primary key, a unique key or a foreign key.
 *
 * Everything else – new tables, columns, keys and indexes, wider types, nullable columns, other defaults, removed plain
 * indexes – is not breaking. When a snapshot was truncated, removals cannot be told from what was left out: they are
 * not listed (nor removed keys and indexes) and the diff is marked incomplete.
 */

// ---------- data types ----------

interface TypeInfo {
  /** int, text, binary, numeric, float, bool, timestamp, timestamptz, date, time, other */
  family: string;
  /** The type in a canonical spelling (int4 and integer are the same) */
  canon: string;
  /** Integer rank, float rank, text or binary length (Infinity: unbounded), numeric precision, time precision */
  size?: number;
  scale?: number;
  unicode?: boolean;
  unsigned?: boolean;
}

/** The type tables are Maps: a type called constructor or toString is a type like any other, not Object.prototype's. */
const INT_RANK = new Map<string, number>(
  Object.entries({
    tinyint: 1,
    int1: 1,
    smallint: 2,
    int2: 2,
    smallserial: 2,
    mediumint: 3,
    int3: 3,
    integer: 4,
    int: 4,
    int4: 4,
    serial: 4,
    bigint: 5,
    int8: 5,
    bigserial: 5,
  }),
);
const INT_CANON = ['', 'tinyint', 'smallint', 'mediumint', 'integer', 'bigint'];

/** Text types: unicode, and the length when no length is given (Infinity: unbounded). */
const TEXT = new Map<string, { unicode: boolean; size: number }>(
  Object.entries({
    varchar: { unicode: false, size: Infinity },
    'character varying': { unicode: false, size: Infinity },
    char: { unicode: false, size: 1 },
    character: { unicode: false, size: 1 },
    bpchar: { unicode: false, size: Infinity },
    nvarchar: { unicode: true, size: 1 },
    'national character varying': { unicode: true, size: 1 },
    nchar: { unicode: true, size: 1 },
    'national character': { unicode: true, size: 1 },
    text: { unicode: false, size: Infinity },
    ntext: { unicode: true, size: Infinity },
    citext: { unicode: false, size: Infinity },
    tinytext: { unicode: false, size: 255 },
    mediumtext: { unicode: false, size: 16_777_215 },
    longtext: { unicode: false, size: 4_294_967_295 },
    string: { unicode: true, size: Infinity },
    varchar2: { unicode: false, size: Infinity },
    nvarchar2: { unicode: true, size: Infinity },
    clob: { unicode: false, size: Infinity },
    nclob: { unicode: true, size: Infinity },
  }),
);
const BINARY = new Map<string, number>(
  Object.entries({
    bytea: Infinity,
    varbinary: Infinity,
    binary: 1,
    blob: 65_535,
    tinyblob: 255,
    mediumblob: 16_777_215,
    longblob: 4_294_967_295,
    image: Infinity,
    bytes: Infinity,
  }),
);
const ALIAS = new Map<string, string>(
  Object.entries({
    bool: 'boolean',
    bit: 'boolean',
    float4: 'real',
    float8: 'double precision',
    double: 'double precision',
    decimal: 'numeric',
    dec: 'numeric',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    datetime: 'timestamp',
    datetime2: 'timestamp',
    smalldatetime: 'timestamp',
    datetimeoffset: 'timestamptz',
    'time without time zone': 'time',
    'time with time zone': 'timetz',
  }),
);

/** "varchar(120) character set utf8mb4 collate x" → base "varchar", args [120]. */
function split(raw: string): { base: string; args: string[]; unsigned: boolean; suffix: string } {
  let s = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  s = s.replace(/ (character set|charset|collate) \S+/g, '').trim();
  const unsigned = /\bunsigned\b/.test(s);
  s = s
    .replace(/\b(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const open = s.indexOf('(');
  if (open < 0) return { base: s, args: [], unsigned, suffix: '' };
  const close = s.indexOf(')', open);
  const base = s.slice(0, open).trim();
  const args = (close < 0 ? s.slice(open + 1) : s.slice(open + 1, close))
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  // "timestamp(3) with time zone", "time(6) without time zone": the part after the brackets belongs to the name
  const suffix = close < 0 ? '' : s.slice(close + 1).trim();
  return { base: suffix ? `${base} ${suffix}` : base, args, unsigned, suffix };
}

const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined;
  if (s === 'max') return Infinity;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** A data type with its family and size, for the comparison of two snapshots. Exported for the unit tests. */
export function typeInfo(raw: string, dialect: DbSchemaDialect = 'other'): TypeInfo {
  const { base: b0, args, unsigned } = split(raw);
  const array = b0.endsWith('[]');
  const b1 = array ? b0.slice(0, -2).trim() : b0;
  const base = ALIAS.get(b1) ?? b1;
  if (array) return { family: 'other', canon: `${typeInfo(b1, dialect).canon}[]` };
  const rank = INT_RANK.get(base);
  if (rank !== undefined) {
    // tinyint(1) is MySQL's boolean; display widths (int(11)) mean nothing
    return { family: 'int', canon: `${INT_CANON[rank]}${unsigned ? ' unsigned' : ''}`, size: rank, unsigned };
  }
  const t = TEXT.get(base);
  if (t) {
    // MariaDB/MySQL "text" holds 65,535 bytes; elsewhere it is unbounded
    const dflt = base === 'text' && dialect === 'mysql' ? 65_535 : t.size;
    const size = num(args[0]) ?? dflt;
    return { family: 'text', canon: `${t.unicode ? 'n' : ''}text(${size})`, size, unicode: t.unicode };
  }
  const binary = BINARY.get(base);
  if (binary !== undefined) {
    const size = num(args[0]) ?? binary;
    return { family: 'binary', canon: `binary(${size})`, size };
  }
  if (base === 'numeric' || base === 'number') {
    const p = num(args[0]) ?? Infinity;
    const sc = num(args[1]) ?? 0;
    return { family: 'numeric', canon: `numeric(${p},${sc})`, size: p, scale: sc };
  }
  if (base === 'real' || base === 'double precision' || base === 'float') {
    // float(n): up to 24 bits is a real, more a double precision
    const rank = base === 'real' ? 1 : base === 'double precision' ? 2 : (num(args[0]) ?? 53) <= 24 ? 1 : 2;
    return { family: 'float', canon: rank === 1 ? 'real' : 'double precision', size: rank };
  }
  if (base === 'boolean') return { family: 'bool', canon: 'boolean' };
  if (base === 'timestamp' || base === 'timestamptz' || base === 'time' || base === 'timetz') {
    const p = num(args[0]) ?? 6;
    return { family: base, canon: `${base}(${p})`, size: p };
  }
  if (base === 'date') return { family: 'date', canon: 'date' };
  return { family: 'other', canon: args.length ? `${base}(${args.join(',')})` : base };
}

/** How a column type changed: the same, wider (fits every old value), narrower, or another kind of type. */
export function compareTypes(before: string, after: string, dialect: DbSchemaDialect = 'other'): 'same' | 'widened' | 'narrowed' | 'changed' {
  const a = typeInfo(before, dialect);
  const b = typeInfo(after, dialect);
  if (a.canon === b.canon) return 'same';
  if (a.family !== b.family) {
    // a whole number fits a numeric with room for it, and any text type takes a number written out
    if (a.family === 'int' && b.family === 'numeric' && (b.size ?? 0) - (b.scale ?? 0) >= [0, 3, 5, 7, 10, 19][a.size ?? 5]!) return 'widened';
    return 'changed';
  }
  switch (a.family) {
    case 'int':
      if (a.unsigned !== b.unsigned)
        // a signed type needs one rank more to take the unsigned values
        return !a.unsigned ? ((b.size ?? 0) > (a.size ?? 0) ? 'changed' : 'narrowed') : (b.size ?? 0) > (a.size ?? 0) ? 'widened' : 'narrowed';
      return (b.size ?? 0) > (a.size ?? 0) ? 'widened' : 'narrowed';
    case 'text':
      if (a.unicode && !b.unicode) return 'narrowed';
      return (b.size ?? 0) >= (a.size ?? 0) ? 'widened' : 'narrowed';
    case 'binary':
    case 'float':
    case 'timestamp':
    case 'timestamptz':
    case 'time':
    case 'timetz':
      return (b.size ?? 0) >= (a.size ?? 0) ? 'widened' : 'narrowed';
    case 'numeric': {
      const ints = (x: TypeInfo) => (x.size ?? 0) - (x.scale ?? 0);
      return ints(b) >= ints(a) && (b.scale ?? 0) >= (a.scale ?? 0) ? 'widened' : 'narrowed';
    }
    default:
      return 'changed';
  }
}

// ---------- tables ----------

const keyOf = (t: Pick<DbSchemaTable, 'schema' | 'name'>) => `${t.schema ?? ''}\u0000${t.name}`;
const list = (cols: string[]) => cols.join(', ');
const ixSignature = (i: DbSchemaIndex) => (i.columns.length ? `(${i.columns.join(',')})` : `name:${i.name}`);

const ORDER: Record<DbSchemaChangeKind, number> = {
  'table-added': 0,
  'table-removed': 1,
  'table-type': 2,
  'column-added': 3,
  'column-removed': 4,
  'column-type': 5,
  'column-nullable': 6,
  'column-default': 7,
  'primary-key-added': 8,
  'primary-key-removed': 9,
  'primary-key-changed': 10,
  'foreign-key-added': 11,
  'foreign-key-removed': 12,
  'unique-added': 13,
  'unique-removed': 14,
  'index-added': 15,
  'index-removed': 16,
};

function tableChanges(a: DbSchemaTable, b: DbSchemaTable, dialect: DbSchemaDialect, removals: boolean, out: DbSchemaChange[]): void {
  const table = qualifiedTable(b);
  if (a.type !== b.type) out.push({ kind: 'table-type', table, before: a.type, after: b.type, breaking: false });
  const before = new Map(a.columns.map((c) => [c.name, c]));
  const after = new Map(b.columns.map((c) => [c.name, c]));
  for (const c of b.columns) {
    const old = before.get(c.name);
    if (!old) {
      const noDefault = !c.nullable && c.default === null;
      out.push({
        kind: 'column-added',
        table,
        column: c.name,
        after: `${c.type}${c.nullable ? '' : ' NOT NULL'}`,
        breaking: noDefault,
        ...(noDefault ? { reason: 'notNullWithoutDefault' as const } : {}),
      });
      continue;
    }
    const how = compareTypes(old.type, c.type, dialect);
    if (how !== 'same')
      out.push({
        kind: 'column-type',
        table,
        column: c.name,
        before: old.type,
        after: c.type,
        breaking: how === 'narrowed' || how === 'changed',
        ...(how === 'narrowed' ? { reason: 'typeNarrowed' as const } : how === 'changed' ? { reason: 'typeChanged' as const } : {}),
      });
    if (old.nullable !== c.nullable) {
      const breaking = !c.nullable && c.default === null;
      out.push({
        kind: 'column-nullable',
        table,
        column: c.name,
        before: old.nullable ? 'NULL' : 'NOT NULL',
        after: c.nullable ? 'NULL' : 'NOT NULL',
        breaking,
        ...(breaking ? { reason: 'notNullWithoutDefault' as const } : {}),
      });
    }
    if ((old.default ?? null) !== (c.default ?? null))
      out.push({ kind: 'column-default', table, column: c.name, before: old.default, after: c.default, breaking: false });
  }
  if (removals)
    for (const c of a.columns)
      if (!after.has(c.name)) out.push({ kind: 'column-removed', table, column: c.name, before: c.type, breaking: true, reason: 'columnRemoved' });

  // the primary key
  const pa = a.primaryKey?.columns ?? [];
  const pb = b.primaryKey?.columns ?? [];
  if (!pa.length && pb.length) out.push({ kind: 'primary-key-added', table, name: b.primaryKey?.name ?? undefined, after: list(pb), breaking: false });
  else if (!removals) {
    // a truncated snapshot may lack keys it has
  } else if (pa.length && !pb.length)
    out.push({ kind: 'primary-key-removed', table, name: a.primaryKey?.name ?? undefined, before: list(pa), breaking: true, reason: 'keyRemoved' });
  else if (list(pa) !== list(pb))
    out.push({
      kind: 'primary-key-changed',
      table,
      name: b.primaryKey?.name ?? undefined,
      before: list(pa),
      after: list(pb),
      breaking: true,
      reason: 'keyRemoved',
    });

  // foreign keys, by what they reference (names are often generated)
  const fa = new Map(a.foreignKeys.map((f) => [fkSignature(f), f]));
  const fb = new Map(b.foreignKeys.map((f) => [fkSignature(f), f]));
  const ref = (f: DbSchemaTable['foreignKeys'][number]) =>
    `(${list(f.columns)}) → ${f.refSchema ? `${f.refSchema}.` : ''}${f.refTable} (${list(f.refColumns)})`;
  for (const [k, f] of fb) if (!fa.has(k)) out.push({ kind: 'foreign-key-added', table, name: f.name ?? undefined, after: ref(f), breaking: false });
  for (const [k, f] of fa)
    if (removals && !fb.has(k))
      out.push({ kind: 'foreign-key-removed', table, name: f.name ?? undefined, before: ref(f), breaking: true, reason: 'keyRemoved' });

  // unique keys and plain indexes, by their columns (the index of the primary key is the primary key's business)
  const ia = new Map(a.indexes.filter((i) => !i.primary).map((i) => [`${i.unique ? 'u' : 'i'}${ixSignature(i)}`, i]));
  const ib = new Map(b.indexes.filter((i) => !i.primary).map((i) => [`${i.unique ? 'u' : 'i'}${ixSignature(i)}`, i]));
  for (const [k, i] of ib)
    if (!ia.has(k)) out.push({ kind: i.unique ? 'unique-added' : 'index-added', table, name: i.name, after: list(i.columns) || i.definition, breaking: false });
  for (const [k, i] of ia)
    if (removals && !ib.has(k))
      out.push(
        i.unique
          ? { kind: 'unique-removed', table, name: i.name, before: list(i.columns) || i.definition, breaking: true, reason: 'keyRemoved' }
          : { kind: 'index-removed', table, name: i.name, before: list(i.columns) || i.definition, breaking: false },
      );
}

/** The changes from snapshot `a` to snapshot `b`. */
export function diffSchemas(a: DbSchemaDoc, b: DbSchemaDoc): DbSchemaDiff {
  const incomplete = a.truncated || b.truncated;
  const removals = !incomplete;
  const out: DbSchemaChange[] = [];
  const before = new Map(a.tables.map((t) => [keyOf(t), t]));
  const after = new Map(b.tables.map((t) => [keyOf(t), t]));
  for (const t of b.tables) {
    const old = before.get(keyOf(t));
    if (!old) out.push({ kind: 'table-added', table: qualifiedTable(t), after: t.type, breaking: false });
    else tableChanges(old, t, b.dialect, removals, out);
  }
  if (removals)
    for (const t of a.tables)
      if (!after.has(keyOf(t))) out.push({ kind: 'table-removed', table: qualifiedTable(t), before: t.type, breaking: true, reason: 'tableRemoved' });
  out.sort((x, y) => (x.table < y.table ? -1 : x.table > y.table ? 1 : ORDER[x.kind] - ORDER[y.kind]));
  const breaking = out.filter((c) => c.breaking).length;
  // breaking changes first when there are more than can be kept
  const kept =
    out.length > DB_SCHEMA_LIMITS.changes ? [...out.filter((c) => c.breaking), ...out.filter((c) => !c.breaking)].slice(0, DB_SCHEMA_LIMITS.changes) : out;
  return { changes: kept, total: out.length, breaking, incomplete };
}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DB_SCHEMA_LIMITS, type DbSchemaDoc } from '@sm/shared';
import { buildDoc, contentHash, type TableInput } from '../src/dbschema/model.js';
import { compareTypes, diffSchemas, typeInfo } from '../src/dbschema/diff.js';
import { lintRule, parseTbls, parseTblsLint } from '../src/dbschema/tbls.js';
import { exportSchema, toDbml, toDdl } from '../src/dbschema/export.js';
import { assembleSchema, mssqlType, SCHEMA_PARTS, SCHEMA_SQL } from '../src/dbms/schema-catalog.js';
import { demoSchemaRows } from '../src/dbms/demo-schema.js';

/**
 * Database schemas (#222) without a server: the breaking-change rules of the diff, the tbls parser and lint mapping,
 * the DBML and DDL generators, and the assembly of the catalog rows of each DBMS.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(here, 'fixtures', 'tbls', name), 'utf8');

const orders = (over: Partial<TableInput> = {}): TableInput => ({
  schema: 'public',
  name: 'orders',
  columns: [
    { name: 'id', type: 'integer', nullable: false, default: null },
    { name: 'customer', type: 'varchar(40)', nullable: true, default: null },
    { name: 'total', type: 'numeric(10,2)', nullable: true, default: '0' },
  ],
  primaryKey: { name: 'orders_pkey', columns: ['id'] },
  foreignKeys: [],
  indexes: [{ name: 'orders_pkey', columns: ['id'], unique: true, primary: true }],
  ...over,
});
const doc = (tables: TableInput[], over: Partial<DbSchemaDoc> = {}): DbSchemaDoc => ({
  ...buildDoc({ dialect: 'postgresql', database: 'shop', tables }),
  ...over,
});
const kinds = (d: ReturnType<typeof diffSchemas>) => d.changes.map((c) => `${c.kind}${c.column ? `:${c.column}` : ''}${c.breaking ? '!' : ''}`);

describe('data types', () => {
  it('knows aliases, lengths and families', () => {
    expect(typeInfo('int4').canon).toBe(typeInfo('integer').canon);
    expect(typeInfo('character varying(120)').canon).toBe(typeInfo('VARCHAR(120)').canon);
    expect(typeInfo('int(11)').canon).toBe('integer');
    expect(typeInfo('varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin').canon).toBe('text(40)');
    expect(typeInfo('timestamp(3) with time zone')).toMatchObject({ family: 'timestamptz', size: 3 });
    expect(typeInfo('nvarchar(max)')).toMatchObject({ family: 'text', size: Infinity, unicode: true });
    expect(typeInfo('text', 'mysql').size).toBe(65_535);
    expect(typeInfo('integer[]').family).toBe('other');
  });

  it('tells widened from narrowed and changed', () => {
    expect(compareTypes('varchar(40)', 'varchar(80)')).toBe('widened');
    expect(compareTypes('varchar(80)', 'varchar(40)')).toBe('narrowed');
    expect(compareTypes('varchar(80)', 'text')).toBe('widened');
    expect(compareTypes('text', 'varchar(255)')).toBe('narrowed');
    expect(compareTypes('nvarchar(40)', 'varchar(40)')).toBe('narrowed');
    expect(compareTypes('varchar(40)', 'nvarchar(40)')).toBe('widened');
    expect(compareTypes('smallint', 'integer')).toBe('widened');
    expect(compareTypes('bigint', 'integer')).toBe('narrowed');
    expect(compareTypes('int unsigned', 'bigint')).toBe('widened');
    expect(compareTypes('int unsigned', 'int')).toBe('narrowed');
    expect(compareTypes('integer', 'numeric(12,0)')).toBe('widened');
    expect(compareTypes('integer', 'numeric(5,0)')).toBe('changed');
    expect(compareTypes('numeric(10,2)', 'numeric(12,2)')).toBe('widened');
    expect(compareTypes('numeric(10,2)', 'numeric(10,3)')).toBe('narrowed');
    expect(compareTypes('real', 'double precision')).toBe('widened');
    expect(compareTypes('float8', 'float4')).toBe('narrowed');
    expect(compareTypes('integer', 'text')).toBe('changed');
    expect(compareTypes('int4', 'integer')).toBe('same');
    expect(compareTypes('bool', 'boolean')).toBe('same');
    expect(compareTypes('jsonb', 'json')).toBe('changed');
  });
});

describe('changes between snapshots', () => {
  it('finds nothing between equal schemas', () => {
    const d = diffSchemas(doc([orders()]), doc([orders()]));
    expect(d).toEqual({ changes: [], total: 0, breaking: 0, incomplete: false });
  });

  it('marks removed tables and columns as breaking, new ones not', () => {
    const before = doc([orders(), { schema: 'public', name: 'legacy', columns: [{ name: 'x', type: 'int', nullable: true }] }]);
    const after = doc([
      orders({ columns: [orders().columns![0]!, orders().columns![2]!, { name: 'note', type: 'text', nullable: true, default: null }] }),
      { schema: 'public', name: 'invoices', columns: [{ name: 'id', type: 'int', nullable: false }] },
    ]);
    const d = diffSchemas(before, after);
    expect(kinds(d)).toEqual(['table-added', 'table-removed!', 'column-added:note', 'column-removed:customer!']);
    expect(d.breaking).toBe(2);
    expect(d.changes.find((c) => c.kind === 'table-removed')).toMatchObject({ table: 'public.legacy', reason: 'tableRemoved' });
  });

  it('marks narrowed and other types as breaking, wider ones not', () => {
    const before = doc([orders()]);
    const wide = doc([
      orders({ columns: [{ name: 'id', type: 'bigint', nullable: false }, { name: 'customer', type: 'varchar(80)', nullable: true }, orders().columns![2]!] }),
    ]);
    expect(kinds(diffSchemas(before, wide))).toEqual(['column-type:id', 'column-type:customer']);
    const narrow = doc([
      orders({ columns: [{ name: 'id', type: 'smallint', nullable: false }, { name: 'customer', type: 'integer', nullable: true }, orders().columns![2]!] }),
    ]);
    const d = diffSchemas(before, narrow);
    expect(kinds(d)).toEqual(['column-type:id!', 'column-type:customer!']);
    expect(d.changes.map((c) => c.reason)).toEqual(['typeNarrowed', 'typeChanged']);
  });

  it('NOT NULL without a default is breaking, with one it is not', () => {
    const before = doc([orders()]);
    const cols = orders().columns!;
    const notNull = doc([
      orders({
        columns: [
          cols[0]!,
          { ...cols[1]!, nullable: false },
          { ...cols[2]!, nullable: false },
          { name: 'status', type: 'text', nullable: false, default: null },
          { name: 'source', type: 'text', nullable: false, default: "'web'" },
        ],
      }),
    ]);
    const d = diffSchemas(before, notNull);
    expect(kinds(d)).toEqual(['column-added:status!', 'column-added:source', 'column-nullable:customer!', 'column-nullable:total']);
    expect(d.changes.filter((c) => c.breaking).every((c) => c.reason === 'notNullWithoutDefault')).toBe(true);
    // the other way round (NOT NULL → NULL) and a new default are not breaking
    expect(
      diffSchemas(notNull, before)
        .changes.filter((c) => c.kind.startsWith('column-nullable'))
        .every((c) => !c.breaking),
    ).toBe(true);
    const dflt = doc([orders({ columns: [cols[0]!, { ...cols[1]!, default: "'x'" }, cols[2]!] })]);
    expect(kinds(diffSchemas(before, dflt))).toEqual(['column-default:customer']);
  });

  it('removed keys are breaking: primary, unique and foreign', () => {
    const customers: TableInput = {
      schema: 'public',
      name: 'customers',
      columns: [{ name: 'id', type: 'int', nullable: false }],
      primaryKey: { name: 'c_pk', columns: ['id'] },
    };
    const fk = {
      name: 'orders_customer_fkey',
      columns: ['customer'],
      refSchema: 'public',
      refTable: 'customers',
      refColumns: ['id'],
      onDelete: 'cascade',
      onUpdate: null,
    };
    const unique = { name: 'orders_customer_key', columns: ['customer'], unique: true, primary: false };
    const plain = { name: 'orders_total_idx', columns: ['total'], unique: false, primary: false };
    const before = doc([customers, orders({ foreignKeys: [fk], indexes: [...orders().indexes!, unique, plain] })]);
    const after = doc([customers, orders({ primaryKey: null, foreignKeys: [], indexes: [] })]);
    const d = diffSchemas(before, after);
    expect(kinds(d)).toEqual(['primary-key-removed!', 'foreign-key-removed!', 'unique-removed!', 'index-removed']);
    expect(d.changes.filter((c) => c.breaking).every((c) => c.reason === 'keyRemoved')).toBe(true);
    // added back: none of them breaking; a renamed foreign key is the same key
    const back = diffSchemas(after, before);
    expect(back.breaking).toBe(0);
    const renamed = doc([customers, orders({ foreignKeys: [{ ...fk, name: 'fk_2' }], indexes: [...orders().indexes!, unique, plain] })]);
    expect(diffSchemas(before, renamed).total).toBe(0);
    // a primary key on other columns is a changed (removed) key
    const otherPk = doc([
      customers,
      orders({ primaryKey: { name: 'orders_pkey', columns: ['id', 'customer'] }, foreignKeys: [fk], indexes: [...orders().indexes!, unique, plain] }),
    ]);
    expect(kinds(diffSchemas(before, otherPk))).toEqual(['primary-key-changed!']);
  });

  it('a truncated snapshot lists no removals and says so', () => {
    const before = doc([orders(), { schema: 'public', name: 'zeta', columns: [{ name: 'x', type: 'int', nullable: true }] }]);
    const after = doc([orders({ primaryKey: null })], { truncated: true });
    const d = diffSchemas(before, after);
    expect(d.incomplete).toBe(true);
    expect(d.changes).toEqual([]);
  });

  it('keeps the breaking changes first when there are too many to list', () => {
    // six new tables of 1,000 columns each: 6,006 changes, the removed table of orders among them
    const wide = (n: number): TableInput => ({
      schema: 'public',
      name: `t${n}`,
      columns: Array.from({ length: 1000 }, (_, i) => ({ name: `c${i}`, type: 'int' })),
    });
    const empty = (n: number): TableInput => ({ schema: 'public', name: `t${n}`, columns: [] });
    const d = diffSchemas(doc([orders(), ...[1, 2, 3, 4, 5, 6].map(empty)]), doc([1, 2, 3, 4, 5, 6].map(wide)));
    expect(d.total).toBe(6001);
    expect(d.changes).toHaveLength(DB_SCHEMA_LIMITS.changes);
    expect(d.changes[0]).toMatchObject({ kind: 'table-removed', breaking: true });
  });
});

describe('the schema model', () => {
  it('sorts, drops duplicates and applies the limits', () => {
    const d = buildDoc({
      dialect: 'mysql',
      tables: [
        {
          schema: 'b',
          name: 'x',
          columns: [
            { name: 'a', type: 'int' },
            { name: 'a', type: 'text' },
          ],
        },
        { schema: 'a', name: 'y', columns: [] },
        { schema: 'a', name: 'y', columns: [] },
      ],
    });
    expect(d.tables.map((t) => `${t.schema}.${t.name}`)).toEqual(['a.y', 'b.x']);
    expect(d.tables[1]!.columns).toEqual([{ name: 'a', type: 'int', nullable: true, default: null, comment: null }]);
    expect(d.truncated).toBe(false);
    const big = buildDoc({ dialect: 'postgresql', tables: Array.from({ length: DB_SCHEMA_LIMITS.tables + 1 }, (_, i) => ({ name: `t${i}`, columns: [] })) });
    expect(big.tables).toHaveLength(DB_SCHEMA_LIMITS.tables);
    expect(big.truncated).toBe(true);
  });

  it('hashes the schema and checks, not the server version', () => {
    const a = doc([orders()], { serverVersion: '16.1' });
    const b = doc([orders()], { serverVersion: '16.4' });
    expect(contentHash(a, [])).toBe(contentHash(b, []));
    expect(contentHash(a, [])).not.toBe(contentHash(a, [{ rule: 'x', target: 'y', message: 'z' }]));
  });
});

describe('tbls import', () => {
  it('reads the sample schema.json', () => {
    const { doc: d, warnings } = parseTbls(fixture('schema.json'));
    expect(d).toMatchObject({ dialect: 'postgresql', product: 'postgres', serverVersion: 'PostgreSQL 16.4', database: 'bakery', truncated: false });
    expect(d.tables.map((t) => `${t.schema}.${t.name}:${t.type}`)).toEqual(['public.customers:table', 'public.loaves:table', 'reports.daily_loaves:view']);
    const loaves = d.tables[1]!;
    expect(loaves.primaryKey).toEqual({ name: 'loaves_pkey', columns: ['id'] });
    expect(loaves.foreignKeys).toEqual([
      {
        name: 'loaves_customer_id_fkey',
        columns: ['customer_id'],
        refSchema: 'public',
        refTable: 'customers',
        refColumns: ['id'],
        onUpdate: null,
        onDelete: 'CASCADE',
      },
    ]);
    expect(loaves.columns.find((c) => c.name === 'kind')).toEqual({
      name: 'kind',
      type: 'varchar(40)',
      nullable: false,
      default: "'rye'::character varying",
      comment: null,
    });
    expect(d.tables[0]!.indexes.find((i) => i.name === 'customers_email_key')).toMatchObject({ unique: true, primary: false });
    expect(d.tables[0]!.indexes.find((i) => i.name === 'customers_pkey')).toMatchObject({ unique: true, primary: true });
    // the relation repeats the constraint: no second foreign key
    expect(warnings).toEqual([]);
  });

  it('takes foreign keys from relations when tables have no constraints', () => {
    const s = JSON.parse(fixture('schema.json'));
    for (const t of s.tables) t.constraints = (t.constraints ?? []).filter((c: { type: string }) => c.type !== 'FOREIGN KEY');
    const { doc: d, warnings } = parseTbls(JSON.stringify(s));
    expect(d.tables[1]!.foreignKeys).toMatchObject([{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' }]);
    expect(warnings[0]).toMatch(/1 foreign key/);
  });

  it('refuses what is not a tbls schema', () => {
    expect(() => parseTbls('not json')).toThrow(/not JSON/);
    expect(() => parseTbls('[]')).toThrow(/not a tbls schema/);
    expect(() => parseTbls('{"tables": [{"name": "x", "type": "TABLE"}]}')).toThrow(/tables\.0\.columns/);
    expect(() => parseTbls('{"tables": [{"name": "x", "type": "TABLE", "columns": [{"name": "a", "type": "int", "nullable": "yes"}]}]}')).toThrow(/nullable/);
    try {
      parseTbls('{"tables": 1}');
    } catch (e) {
      expect((e as { code?: string; statusCode?: number }).code).toBe('DB_SCHEMA_TBLS_INVALID');
      expect((e as { statusCode?: number }).statusCode).toBe(400);
    }
  });

  it('refuses schemas beyond the limits', () => {
    const tables = Array.from({ length: DB_SCHEMA_LIMITS.tables + 1 }, (_, i) => ({ name: `t${i}`, type: 'TABLE', columns: [] }));
    expect(() => parseTbls(JSON.stringify({ tables }))).toThrow(expect.objectContaining({ code: 'DB_SCHEMA_TOO_LARGE', statusCode: 413 }));
    expect(() => parseTbls(' '.repeat(DB_SCHEMA_LIMITS.importBytes + 1))).toThrow(expect.objectContaining({ code: 'DB_SCHEMA_TOO_LARGE' }));
  });

  it('keeps keys of the input out of object prototypes', () => {
    const { doc: d } = parseTbls(
      '{"tables": [{"name": "__proto__", "type": "TABLE", "columns": [{"name": "constructor", "type": "int", "nullable": true}]}], "__proto__": {"polluted": 1}}',
    );
    expect(d.tables[0]!.name).toBe('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('turns tbls lint output into checks named by their rule', () => {
    expect(parseTblsLint(fixture('lint.txt'))).toEqual([
      { rule: 'requireTableComment', target: 'public.loaves', message: 'table comment required.' },
      { rule: 'requireColumnComment', target: 'public.loaves.kind', message: 'column comment required.' },
      { rule: 'columnCount', target: 'public.customers', message: 'too many columns. [3/2]' },
    ]);
    expect(lintRule("column 'created' required.")).toBe('requireColumns');
    expect(lintRule('foreign key columns do not have an index. [loaves]')).toBe('requireForeignKeyIndex');
    expect(lintRule('table `x` is not included in any viewpoints.')).toBe('requireViewpoints');
    expect(lintRule('something new.')).toBe('tbls-lint');
    expect(parseTblsLint('[{"rule": "ownRule", "target": "t", "message": "m"}, {"target": "u", "message": "index comment required."}]')).toEqual([
      { rule: 'ownRule', target: 't', message: 'm' },
      { rule: 'requireIndexComment', target: 'u', message: 'index comment required.' },
    ]);
    expect(parseTblsLint('')).toEqual([]);
  });
});

describe('exports', () => {
  const d = () => parseTbls(fixture('schema.json')).doc;

  it('writes DBML', () => {
    const dbml = toDbml(d());
    expect(dbml).toContain(`Project "bakery" {\n  database_type: 'PostgreSQL'\n}`);
    expect(dbml).toContain(`Table "public"."customers" {`);
    expect(dbml).toContain(`  "id" integer [pk, not null, default: \`nextval('customers_id_seq'::regclass)\`]`);
    expect(dbml).toContain(`  "email" varchar(120) [not null, unique, note: 'Sign-in']`);
    expect(dbml).toContain(`  "baked_at" "timestamp with time zone"`);
    expect(dbml).toContain(`    "customer_id" [name: 'loaves_customer_idx']`);
    expect(dbml).toContain(`Table "reports"."daily_loaves" [note: 'view'] {`);
    expect(dbml).toContain(`  Note: 'People who order'`);
    expect(dbml).toContain(`Ref loaves_customer_id_fkey: "public"."loaves"."customer_id" > "public"."customers"."id" [delete: cascade]`);
  });

  it('quotes names and texts in DBML', () => {
    const x = buildDoc({
      dialect: 'postgresql',
      tables: [{ schema: null, name: 'a"b', comment: "it's\nmulti", columns: [{ name: 'c', type: 'int', nullable: true, default: 'true' }] }],
    });
    const out = toDbml(x);
    expect(out).toContain('Table "a\\"b" {');
    expect(out).toContain(`Note: 'it\\'s multi'`);
    expect(out).toContain('"c" int [default: true]');
  });

  it('writes DDL for the source dialect', () => {
    const pg = toDdl(d());
    expect(pg).toContain('-- Dialect: PostgreSQL');
    expect(pg).toContain(
      `CREATE TABLE "public"."loaves" (\n  "id" integer NOT NULL,\n  "customer_id" integer NOT NULL,\n  "kind" varchar(40) NOT NULL DEFAULT 'rye'::character varying,`,
    );
    expect(pg).toContain('  CONSTRAINT "loaves_pkey" PRIMARY KEY ("id")\n);');
    expect(pg).toContain(`COMMENT ON COLUMN "public"."customers"."email" IS 'Sign-in';`);
    expect(pg).toContain('CREATE UNIQUE INDEX "customers_email_key" ON "public"."customers" ("email");');
    expect(pg).toContain(
      'ALTER TABLE "public"."loaves" ADD CONSTRAINT "loaves_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id") ON DELETE CASCADE;',
    );
    expect(pg).toContain('-- view reports.daily_loaves: the definition is not part of the snapshot');
    const my = toDdl({ ...d(), dialect: 'mysql' });
    expect(my).toContain(
      "CREATE TABLE `public`.`customers` (\n  `id` integer NOT NULL DEFAULT nextval('customers_id_seq'::regclass),\n  `email` varchar(120) NOT NULL COMMENT 'Sign-in',",
    );
    expect(my).toContain(") COMMENT='People who order';");
    const ms = toDdl({ ...d(), dialect: 'sqlserver' });
    expect(ms).toContain('CREATE TABLE [public].[customers] (');
    expect(ms).toContain('-- customers.email: Sign-in');
    const other = toDdl({ ...d(), dialect: 'other', product: 'bigquery' });
    expect(other).toContain('-- Dialect: standard SQL (source: bigquery)');
    // identity columns keep their clause
    const ident = toDdl(
      buildDoc({ dialect: 'sqlserver', tables: [{ schema: 'dbo', name: 't', columns: [{ name: 'id', type: 'int', nullable: false, default: 'IDENTITY' }] }] }),
    );
    expect(ident).toContain('[id] int NOT NULL IDENTITY');
  });

  it('names the files', () => {
    expect(exportSchema(d(), 'dbml', 'bakery', '2026-11-06T10:00:00Z')).toMatchObject({ fileName: 'bakery-2026-11-06.dbml' });
    expect(exportSchema(d(), 'sql', 'Shop / prod', '2026-11-06T10:00:00Z')).toMatchObject({ fileName: 'Shop-prod-2026-11-06.sql' });
    const json = exportSchema(d(), 'json', 'x', '2026-11-06T10:00:00Z');
    expect(JSON.parse(json.body)).toMatchObject({ format: 'steward-db-schema', version: 1, tables: expect.any(Array) });
  });
});

describe('the catalog read', () => {
  it('has a statement for every part and DBMS, without recursion or parameters', () => {
    for (const flavour of ['postgresql', 'mysql', 'mariadb', 'sqlserver'] as const)
      for (const part of SCHEMA_PARTS) {
        const sql = SCHEMA_SQL[flavour][part];
        expect(sql).toMatch(/^SELECT /);
        expect(sql).not.toMatch(/RECURSIVE|\$1|\?|@p1|;/i);
      }
    // MariaDB/MySQL: one information_schema view per statement (joins across views meet different collations)
    for (const part of SCHEMA_PARTS) expect(SCHEMA_SQL.mysql[part].match(/information_schema\./g)).toHaveLength(1);
  });

  it('assembles PostgreSQL rows (the demo schema)', () => {
    const parts = Object.fromEntries(SCHEMA_PARTS.map((p) => [p, { rows: demoSchemaRows(p), truncated: false }])) as Parameters<typeof assembleSchema>[1];
    const d = assembleSchema('postgresql', parts, { database: 'shop', version: '16.4' });
    expect(d.tables.map((t) => t.name)).toEqual(['customers', 'invoices', 'open_orders', 'order_lines', 'orders', 'products']);
    const lines = d.tables.find((t) => t.name === 'order_lines')!;
    expect(lines.primaryKey).toEqual({ name: 'order_lines_pkey', columns: ['order_id', 'line'] });
    expect(lines.foreignKeys.map((f) => `${f.columns}>${f.refTable}:${f.onDelete}`)).toEqual(['order_id>orders:CASCADE', 'product_id>products:NO ACTION']);
    expect(d.tables.find((t) => t.name === 'open_orders')!.type).toBe('view');
    expect(d.tables.find((t) => t.name === 'customers')!.columns[0]).toEqual({
      name: 'id',
      type: 'integer',
      nullable: false,
      default: 'GENERATED BY DEFAULT AS IDENTITY',
      comment: null,
    });
  });

  it('assembles MariaDB/MySQL rows: keys from one view, defaults as MariaDB writes them', () => {
    const t = (name: string) => ({ schema_name: 'shop', table_name: name });
    const d = assembleSchema(
      'mariadb',
      {
        tables: {
          rows: [
            { ...t('orders'), table_type: 'BASE TABLE', comment: '' },
            { ...t('v'), table_type: 'VIEW', comment: 'VIEW' },
          ],
          truncated: false,
        },
        columns: {
          rows: [
            {
              ...t('orders'),
              column_name: 'id',
              position: 1,
              data_type: 'int(11)',
              nullable: 'NO',
              column_default: null,
              extra: 'auto_increment',
              comment: '',
            },
            {
              ...t('orders'),
              column_name: 'note',
              position: 2,
              data_type: 'varchar(40)',
              nullable: 'YES',
              column_default: 'NULL',
              extra: '',
              comment: 'free text',
            },
            { ...t('orders'), column_name: 'state', position: 3, data_type: "enum('a','b')", nullable: 'NO', column_default: "'a'", extra: '', comment: '' },
            {
              ...t('orders'),
              column_name: 'total2',
              position: 4,
              data_type: 'int(11)',
              nullable: 'YES',
              column_default: null,
              extra: 'VIRTUAL GENERATED',
              generation: '`id` * 2',
              comment: '',
            },
          ],
          truncated: false,
        },
        keys: {
          rows: [
            { ...t('orders'), constraint_name: 'PRIMARY', column_name: 'id', position: 1, ref_schema: null, ref_table: null, ref_column: null },
            { ...t('orders'), constraint_name: 'fk_v', column_name: 'note', position: 1, ref_schema: 'shop', ref_table: 'v', ref_column: 'x' },
            { ...t('orders'), constraint_name: 'uq', column_name: 'state', position: 1, ref_schema: null, ref_table: null, ref_column: null },
          ],
          truncated: false,
        },
        references: { rows: [{ table_name: 'orders', constraint_name: 'fk_v', on_update: 'RESTRICT', on_delete: 'SET NULL' }], truncated: false },
        indexes: {
          rows: [
            { ...t('orders'), index_name: 'PRIMARY', non_unique: 0, position: 1, column_name: 'id' },
            { ...t('orders'), index_name: 'uq', non_unique: 0, position: 1, column_name: 'state' },
            { ...t('orders'), index_name: 'ix', non_unique: 1, position: 1, column_name: 'note' },
          ],
          truncated: false,
        },
      },
      { database: 'shop', version: '11.4.2-MariaDB' },
    );
    expect(d).toMatchObject({ dialect: 'mysql', product: 'MariaDB' });
    const o = d.tables[0]!;
    expect(o.columns.map((c) => c.default)).toEqual(['AUTO_INCREMENT', null, "'a'", 'GENERATED ALWAYS AS (`id` * 2) VIRTUAL']);
    expect(o.columns[1]!.comment).toBe('free text');
    expect(o.primaryKey).toEqual({ name: 'PRIMARY', columns: ['id'] });
    expect(o.foreignKeys).toEqual([
      { name: 'fk_v', columns: ['note'], refSchema: 'shop', refTable: 'v', refColumns: ['x'], onUpdate: 'RESTRICT', onDelete: 'SET NULL' },
    ]);
    expect(o.indexes.map((i) => `${i.name}:${i.unique}:${i.primary}`)).toEqual(['PRIMARY:true:true', 'ix:false:false', 'uq:true:false']);
    expect(d.tables[1]).toMatchObject({ type: 'view', comment: null });
  });

  it('assembles SQL Server rows: declared types and bracketed defaults', () => {
    expect(mssqlType({ type_name: 'nvarchar', max_length: 80 })).toBe('nvarchar(40)');
    expect(mssqlType({ type_name: 'varchar', max_length: -1 })).toBe('varchar(max)');
    expect(mssqlType({ type_name: 'decimal', num_precision: 10, num_scale: 2 })).toBe('decimal(10,2)');
    expect(mssqlType({ type_name: 'datetime2', num_scale: 3 })).toBe('datetime2(3)');
    const t = { schema_name: 'dbo', table_name: 'orders' };
    const d = assembleSchema(
      'sqlserver',
      {
        tables: { rows: [{ ...t, table_type: 'table', comment: 'All orders' }], truncated: false },
        columns: {
          rows: [
            { ...t, column_name: 'id', position: 1, type_name: 'int', max_length: 4, nullable: false, is_identity: true, column_default: null, computed: null },
            {
              ...t,
              column_name: 'state',
              position: 2,
              type_name: 'nvarchar',
              max_length: 40,
              nullable: true,
              is_identity: false,
              column_default: "('open')",
              computed: null,
            },
            {
              ...t,
              column_name: 'n',
              position: 3,
              type_name: 'int',
              max_length: 4,
              nullable: true,
              is_identity: false,
              column_default: '((0))',
              computed: null,
            },
          ],
          truncated: false,
        },
        keys: { rows: [{ ...t, constraint_name: 'PK_orders', constraint_type: 'PRIMARY KEY', column_name: 'id', position: 1 }], truncated: false },
        references: {
          rows: [
            {
              ...t,
              constraint_name: 'FK_x',
              column_name: 'n',
              position: 1,
              ref_schema: 'dbo',
              ref_table: 'x',
              ref_column: 'id',
              on_update: 'NO_ACTION',
              on_delete: 'SET_NULL',
            },
          ],
          truncated: false,
        },
        indexes: { rows: [{ ...t, index_name: 'PK_orders', is_unique: true, is_primary: true, column_name: 'id', position: 1 }], truncated: false },
      },
      { database: 'shop', version: '16.0' },
    );
    const o = d.tables[0]!;
    expect(o.columns.map((c) => `${c.name} ${c.type} ${c.default}`)).toEqual(['id int IDENTITY', "state nvarchar(20) 'open'", 'n int 0']);
    expect(o.foreignKeys[0]).toMatchObject({ onUpdate: 'NO ACTION', onDelete: 'SET NULL' });
    expect(o.comment).toBe('All orders');
  });

  it('marks a part that reached its limit as truncated', () => {
    const parts = Object.fromEntries(SCHEMA_PARTS.map((p) => [p, { rows: demoSchemaRows(p), truncated: p === 'indexes' }])) as Parameters<
      typeof assembleSchema
    >[1];
    expect(assembleSchema('postgresql', parts, { database: 'shop', version: '' }).truncated).toBe(true);
  });
});

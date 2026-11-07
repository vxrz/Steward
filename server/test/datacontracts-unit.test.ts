import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { factsOf, lintContract, parseContract, propertyPaths } from '../src/datacontracts/odcs.js';
import { comparePhysical, diffContracts } from '../src/datacontracts/diff.js';
import { logicalOfSql } from '../src/datacontracts/draft.js';
import { serverHeaders } from '../src/datacontracts/testing.js';
import { validateFile } from '../src/cli/validate.js';
import path from 'node:path';

/**
 * Data contracts without a server (#221): reading within limits, the JSON Schema check of ODCS v3.0.2, the facts,
 * the comparison of versions (breaking changes), type mapping of drafts and the CLI headers of a test.
 */

type Prop = Record<string, unknown>;
interface Doc {
  schema: { name: string; quality?: unknown[]; properties: Prop[]; [k: string]: unknown }[];
  servers: Record<string, unknown>[];
  [k: string]: unknown;
}
const base = (): Doc => ({
  apiVersion: 'v3.0.2',
  kind: 'DataContract',
  id: 'orders',
  name: 'Orders',
  version: '1.0.0',
  status: 'active',
  servers: [{ server: 'prod', type: 'postgresql', host: 'db.example.internal', port: 5432, database: 'shop', schema: 'public' }],
  schema: [
    {
      name: 'orders',
      physicalType: 'table',
      quality: [{ rule: 'rowCount', mustBeGreaterThan: 0 }],
      properties: [
        { name: 'id', logicalType: 'integer', physicalType: 'integer', required: true },
        { name: 'status', logicalType: 'string', physicalType: 'varchar(20)', logicalTypeOptions: { maxLength: 20 } },
        { name: 'total', logicalType: 'number', quality: [{ rule: 'nullValues', mustBeLessThan: 10 }] },
        {
          name: 'customer',
          logicalType: 'object',
          properties: [
            { name: 'name', logicalType: 'string' },
            { name: 'address', logicalType: 'object', properties: [{ name: 'city', logicalType: 'string' }] },
          ],
        },
      ],
    },
  ],
});
const changed = (f: (d: Doc) => void) => {
  const d = base();
  f(d);
  return d;
};
const kinds = (a: unknown, b: unknown) =>
  diffContracts(a as never, b as never).changes.map((c) => `${c.kind}${c.breaking ? '!' : ''}${c.field ? `:${c.field}` : ''}`);
const props = (d: Doc) => d.schema[0]!.properties;

describe('reading', () => {
  it('reads a contract and its facts', () => {
    const p = parseContract(YAML.stringify(base()));
    expect(p.problems).toEqual([]);
    const f = factsOf(p.doc);
    expect(f).toMatchObject({ key: 'orders', name: 'Orders', version: '1.0.0', apiVersion: 'v3.0.2', status: 'active' });
    expect(f.schemas[0]!.properties).toEqual(['customer', 'customer.address', 'customer.address.city', 'customer.name', 'id', 'status', 'total']);
    expect(f.servers).toEqual([{ server: 'prod', type: 'postgresql' }]);
  });

  it('reports YAML errors, alias bombs, deep nesting and what is not an ODCS v3 contract – and refuses oversized texts', () => {
    expect(parseContract('a: [1, 2').problems[0]!.source).toBe('yaml');
    const bomb = [
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
    ].join('\n');
    expect(parseContract(bomb).problems[0]!.message).toMatch(/alias/i);
    const deep = `${Array.from({ length: 40 }, (_, i) => `${'  '.repeat(i)}k${i}:`).join('\n')} 1\n`;
    expect(parseContract(deep).problems[0]!.message).toContain('deeper');
    expect(parseContract('- 1\n- 2\n').problems[0]!.message).toContain('mapping');
    const p = parseContract('apiVersion: v2.2.2\nkind: Contract\n');
    expect(p.problems.map((x) => x.path)).toEqual(['/kind', '/apiVersion', '/id']);
    expect(() => parseContract(`a: "${'x'.repeat(1024 * 1024)}"`)).toThrow(/too large/);
    // a duplicate key is a YAML error
    expect(parseContract('id: a\nid: b\n').problems[0]!.message).toMatch(/unique/i);
  });

  it('lists property paths of nested objects and array items', () => {
    expect(propertyPaths({ properties: [{ name: 'tags', logicalType: 'array', items: { properties: [{ name: 'label' }] } }] })).toEqual(['tags', 'tags.label']);
  });
});

describe('the JSON Schema check (ODCS v3.0.2)', () => {
  it('passes a valid contract and names unknown fields, wrong enums and bad formats', () => {
    expect(lintContract(base() as never)).toEqual([]);
    const bad = changed((d) => {
      d.unknown = true;
      props(d)[0]!.logicalType = 'int';
      d.contractCreatedTs = 'yesterday';
    });
    const f = lintContract(bad as never);
    expect(f.map((x) => x.path).sort()).toEqual(['/', '/contractCreatedTs', '/schema/0/properties/0/logicalType']);
    expect(f.find((x) => x.path === '/')!.message).toBe('unknown is not a field of ODCS v3.0.2');
    expect(f.every((x) => x.source === 'schema' && x.severity === 'error')).toBe(true);
  });

  it('does not check a later v3 version against v3.0.2, but says so', () => {
    const f = lintContract(changed((d) => (d.apiVersion = 'v3.1.0')) as never);
    expect(f).toEqual([expect.objectContaining({ severity: 'info', path: '/apiVersion' })]);
  });
});

describe('comparing versions', () => {
  it('finds nothing between equal versions', () => {
    expect(diffContracts(base() as never, base() as never)).toEqual({ changes: [], total: 0, breaking: 0 });
  });

  it('marks removed schema objects and fields as breaking – a removed parent once', () => {
    expect(
      kinds(
        base(),
        changed((d) => (d.schema[0]!.properties = props(d).filter((p) => p.name !== 'customer'))),
      ),
    ).toEqual(['field-removed!:customer']);
    expect(
      kinds(
        base(),
        changed((d) => (d.schema = [])),
      ),
    ).toEqual(['schema-removed!']);
    expect(
      kinds(
        changed((d) => (d.schema = [])),
        base(),
      ),
    ).toEqual(['schema-added']);
  });

  it('marks new required fields, required and unique added as breaking; optional additions not', () => {
    expect(
      kinds(
        base(),
        changed((d) => props(d).push({ name: 'channel', logicalType: 'string' })),
      ),
    ).toEqual(['field-added:channel']);
    expect(
      kinds(
        base(),
        changed((d) => props(d).push({ name: 'channel', logicalType: 'string', required: true })),
      ),
    ).toEqual(['field-added!:channel']);
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[1]!.required = true)),
      ),
    ).toEqual(['required-added!:status']);
    expect(
      kinds(
        changed((d) => (props(d)[1]!.required = true)),
        base(),
      ),
    ).toEqual(['required-removed:status']);
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[0]!.unique = true)),
      ),
    ).toEqual(['unique-added!:id']);
  });

  it('tells narrowed, widened and changed types apart', () => {
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[1]!.physicalType = 'varchar(10)')),
      ),
    ).toEqual(['type-narrowed!:status']);
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[1]!.physicalType = 'varchar(40)')),
      ),
    ).toEqual(['type-widened:status']);
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[0]!.physicalType = 'bigint')),
      ),
    ).toEqual(['type-widened:id']);
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[0]!.logicalType = 'number')),
      ),
    ).toEqual(['type-widened:id']);
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[0]!.logicalType = 'string')),
      ),
    ).toEqual(['type-changed!:id']);
    expect(
      kinds(
        base(),
        changed((d) => ((props(d)[1]!.logicalTypeOptions as Record<string, number>).maxLength = 10)),
      ),
    ).toEqual(['type-narrowed!:status']);
    expect(
      kinds(
        base(),
        changed((d) => ((props(d)[1]!.logicalTypeOptions as Record<string, unknown>).pattern = '^[a-z]+$')),
      ),
    ).toEqual(['type-narrowed!:status']);
    expect(comparePhysical('numeric(10,2)', 'numeric(12,2)')).toBe('wider');
    expect(comparePhysical('numeric(12,2)', 'numeric(12,4)')).toBe('wider');
    expect(comparePhysical('numeric(12,2)', 'numeric(14,1)')).toBe('changed');
    expect(comparePhysical('bigint', 'integer')).toBe('narrower');
    expect(comparePhysical('varchar(10)', 'text')).toBe('wider');
    expect(comparePhysical('VARCHAR(10)', 'varchar(10)')).toBe('same');
    expect(comparePhysical('integer', 'varchar(10)')).toBe('changed');
  });

  it('marks added and tightened quality rules as breaking; loosened and removed ones not', () => {
    const q = (f: (rule: Record<string, unknown>) => void) => changed((d) => f((props(d)[2]!.quality as Record<string, unknown>[])[0]!));
    expect(
      kinds(
        base(),
        q((r) => (r.mustBeLessThan = 5)),
      ),
    ).toEqual(['quality-tightened!:total']);
    expect(
      kinds(
        base(),
        q((r) => (r.mustBeLessThan = 20)),
      ),
    ).toEqual(['quality-loosened:total']);
    expect(
      kinds(
        base(),
        changed((d) => (props(d)[2]!.quality = [])),
      ),
    ).toEqual(['quality-removed:total']);
    expect(
      kinds(
        base(),
        changed((d) => (d.schema[0]!.quality as unknown[]).push({ rule: 'duplicateCount', mustBe: 0 })),
      ),
    ).toEqual(['quality-added!']);
    expect(
      kinds(
        base(),
        changed((d) => (d.schema[0]!.quality as unknown[]).push({ type: 'text', description: 'Looks fine' })),
      ),
    ).toEqual(['quality-added']);
    expect(
      kinds(
        base(),
        changed((d) => ((d.schema[0]!.quality as Record<string, unknown>[])[0]!.mustBeGreaterThan = 10)),
      ),
    ).toEqual(['quality-tightened!']);
    const between = (v: number[]) => changed((d) => ((d.schema[0]!.quality as Record<string, unknown>[])[0] = { rule: 'rowCount', mustBeBetween: v }));
    expect(kinds(between([0, 100]), between([10, 100]))).toEqual(['quality-tightened!']);
    expect(kinds(between([10, 100]), between([0, 200]))).toEqual(['quality-loosened']);
  });

  it('lists servers, status and version changes as compatible', () => {
    expect(
      kinds(
        base(),
        changed((d) => {
          d.version = '1.1.0';
          d.status = 'deprecated';
          d.servers.push({ server: 'staging', type: 'postgresql', host: 'h', port: 1, database: 'x', schema: 'y' });
        }),
      ),
    ).toEqual(['version-changed', 'status-changed', 'server-added:staging']);
  });
});

describe('drafts and tests', () => {
  it('maps SQL types to ODCS logical types', () => {
    expect(
      ['integer', 'bigint', 'numeric(10,2)', 'character varying(20)', 'timestamp with time zone', 'date', 'boolean', 'jsonb', 'uuid'].map(logicalOfSql),
    ).toEqual(['integer', 'integer', 'number', 'string', 'date', 'date', 'boolean', 'object', 'string']);
  });

  it('sends the tested server in the CLI headers of its DBMS', () => {
    const s = {
      dialect: 'sqlserver',
      host: 'sql.example.internal',
      port: 1433,
      database: 'sales',
      tls: { mode: 'verify' },
      limits: {},
      auth: 'password',
    } as never;
    expect(serverHeaders('sqlserver', s, { username: 'reader', password: 'pw-123456' })).toEqual({
      'datacontract-sqlserver-host': 'sql.example.internal',
      'datacontract-sqlserver-port': '1433',
      'datacontract-sqlserver-database': 'sales',
      // TLS "verify": encrypted, the certificate checked (the CLI's SQL Server options)
      'datacontract-sqlserver-encrypted-connection': 'true',
      'datacontract-sqlserver-trust-server-certificate': 'false',
      'datacontract-sqlserver-username': 'reader',
      'datacontract-sqlserver-password': 'pw-123456',
    });
    expect(Object.keys(serverHeaders('postgresql', { ...(s as object), dialect: 'postgresql', port: undefined } as never, {}))).toEqual([
      'datacontract-postgres-host',
      'datacontract-postgres-port',
      'datacontract-postgres-database',
    ]);
  });
});

describe('the example library', () => {
  it('validates the example contracts as data contracts', async () => {
    for (const f of ['shop-orders.odcs.yaml', 'shop-customers.odcs.yaml']) {
      const r = await validateFile(path.resolve(__dirname, '..', '..', 'examples', 'data-contracts', f));
      expect(r).toMatchObject({ kind: 'data contract', ok: true, count: 1, errors: [] });
    }
  });
});

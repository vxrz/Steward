import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { DATA_CONTRACT_LIMITS } from '@sm/shared';
import { lintContract, parseContract } from '../src/datacontracts/odcs.js';
import { diffContracts } from '../src/datacontracts/diff.js';
import { assertSqlRules, sqlRuleProblem, sqlRules, withoutPlaceholders } from '../src/datacontracts/sqlrules.js';
import { assertPathAllowed, deniedOwnCall, ownCall } from '../src/platforms/deniedPaths.js';
import { timeLimit } from './time.js';

/**
 * Regression tests of the 0.9.0 security review of data contracts (#221), without a server: lint and comparison in
 * linear time with hard caps (H1), what the comparison relies on refused on save (L1), SQL quality rules held to
 * Steward's statement check (M1) and the data contract service refused to everyone but Steward's own tests (M2).
 * Through the API: datacontracts-security.test.ts.
 */

const head = 'apiVersion: v3.0.2\nkind: DataContract\nid: x\nschema:\n  - name: t\n';
const rules = (n: number) => `${head}    quality: [${Array(n).fill('{}').join(',')}]\n`;
const small = parseContract(head).doc;
const timed = <T>(f: () => T): [T, number] => {
  const t = performance.now();
  const r = f();
  return [r, performance.now() - t];
};
/** Generous for a shared, slow machine – the quadratic code took 22 s and 5.5 s for these inputs */
const BUDGET_MS = timeLimit(3_000);

describe('H1: lint and compare in linear time, within caps', () => {
  it('refuses the reviewer’s 80,000 empty quality rules (240 KB) at once, by the cap', () => {
    const [p, ms] = timed(() => parseContract(rules(80_000)));
    expect(p.problems.map((x) => x.message)).toEqual([`More than ${DATA_CONTRACT_LIMITS.qualityRules} quality rules`]);
    expect(ms).toBeLessThan(BUDGET_MS);
    // a 1 MB body of them (340,000) too
    expect(parseContract(rules(340_000)).problems[0]!.message).toContain('quality rules');
  });

  it('lints and compares the reviewer’s 8,000 rules (24 KB) quickly', () => {
    const p = parseContract(rules(8_000));
    expect(p.problems).toEqual([]);
    const [lint, lintMs] = timed(() => lintContract(p.doc));
    expect(lint.length).toBe(DATA_CONTRACT_LIMITS.lintFindings);
    expect(lintMs).toBeLessThan(BUDGET_MS);
    const [d, diffMs] = timed(() => diffContracts(small, p.doc));
    expect(d.total).toBe(8_000);
    expect(diffMs).toBeLessThan(BUDGET_MS);
  });

  it('stays linear beyond the caps too (documents built in code, not read)', () => {
    const doc = (extra: Record<string, unknown>) => ({ apiVersion: 'v3.0.2', kind: 'DataContract', id: 'x', version: '1', status: 'active', ...extra });
    const fill = (n: number, v: () => unknown) => Array.from({ length: n }, v);
    for (const d of [
      doc({ schema: [{ name: 't', quality: fill(80_000, () => ({})) }] }),
      doc({ servers: fill(100_000, () => ({})) }),
      doc({ slaProperties: fill(100_000, () => ({})) }),
    ]) {
      const [f, ms] = timed(() => lintContract(d));
      expect(f.length).toBeGreaterThan(0);
      expect(ms).toBeLessThan(BUDGET_MS);
    }
    const [, ms] = timed(() => diffContracts(small, doc({ schema: [{ name: 't', quality: fill(80_000, () => ({})) }] })));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('compares 20,000 properties on both sides quickly (two-sided: 8.9 s before)', () => {
    const props = (prefix: string) =>
      `apiVersion: v3.0.2\nkind: DataContract\nid: x\nversion: "1"\nstatus: active\nschema:\n  - name: t\n    properties:\n${Array.from({ length: 19_999 }, (_, i) => `      - name: ${prefix}${i}\n`).join('')}`;
    const a = parseContract(props('a'));
    const b = parseContract(props('b'));
    expect(a.problems).toEqual([]);
    const [d, ms] = timed(() => diffContracts(a.doc, b.doc));
    expect(d.total).toBe(2 * 19_999);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('caps the values of a document', () => {
    const text = `${head}tags: [${Array(DATA_CONTRACT_LIMITS.nodes + 10)
      .fill('1')
      .join(',')}]\n`;
    expect(parseContract(text).problems[0]!.message).toBe(`The document has more than ${DATA_CONTRACT_LIMITS.nodes} values`);
  });

  it('still names duplicate rules apart (#2, #3 …)', () => {
    const q = [
      { rule: 'nullValues', mustBeLessThan: 1 },
      { rule: 'nullValues', mustBeLessThan: 2 },
      { rule: 'nullValues', mustBeLessThan: 3 },
    ];
    const d = diffContracts(small, { ...small, schema: [{ name: 't', quality: q }] });
    expect(d.changes.map((c) => c.rule)).toEqual(['library:nullValues', 'library:nullValues #2', 'library:nullValues #3']);
  });
});

const contract = (f: (d: any) => void = () => {}) => {
  const d: any = {
    apiVersion: 'v3.0.2',
    kind: 'DataContract',
    id: 'orders',
    version: '1.0.0',
    status: 'active',
    servers: [{ server: 'prod', type: 'postgresql', host: 'db.example.internal', port: 5432, database: 'shop' }],
    schema: [
      {
        name: 'orders',
        physicalName: 'public.orders',
        quality: [{ rule: 'rowCount', mustBeGreaterThan: 0 }],
        properties: [
          { name: 'id', logicalType: 'integer', required: true, physicalName: 'id' },
          { name: 'total', logicalType: 'number', logicalTypeOptions: { maximum: 1000 } },
        ],
      },
    ],
  };
  f(d);
  return d;
};
const problemsOf = (d: unknown) => parseContract(YAML.stringify(d)).problems.map((p) => `${p.path} ${p.message}`);

describe('L1: what the comparison relies on', () => {
  it('refuses duplicate names of servers, schema objects and properties on one level', () => {
    expect(problemsOf(contract())).toEqual([]);
    expect(problemsOf(contract((d) => d.schema.push({ name: 'orders' })))).toEqual([
      '/schema/1/name Two schema objects are named "orders" – names must be unique',
    ]);
    expect(problemsOf(contract((d) => d.servers.push({ server: 'prod', type: 'mysql' })))[0]).toContain('/servers/1/server Two servers');
    expect(problemsOf(contract((d) => d.schema[0].properties.push({ name: 'id', logicalType: 'string' })))[0]).toContain('/schema/0/properties/2/name');
    // the same name on another level is fine
    expect(problemsOf(contract((d) => (d.schema[0].properties[1] = { name: 'total', logicalType: 'object', properties: [{ name: 'id' }] })))).toEqual([]);
  });

  it('refuses values of the wrong type in compared fields: required "true", limits and thresholds as strings', () => {
    expect(problemsOf(contract((d) => (d.schema[0].properties[0].required = 'true')))).toEqual([
      '/schema/0/properties/0/required required must be true or false',
    ]);
    expect(problemsOf(contract((d) => (d.schema[0].properties[1].logicalTypeOptions.maximum = '5')))).toEqual([
      '/schema/0/properties/1/logicalTypeOptions/maximum maximum must be a number',
    ]);
    expect(problemsOf(contract((d) => (d.schema[0].quality[0].mustBeGreaterThan = '5')))).toEqual([
      '/schema/0/quality/0/mustBeGreaterThan mustBeGreaterThan must be a number',
    ]);
    expect(problemsOf(contract((d) => (d.schema[0].quality[0] = { rule: 'x', mustBeBetween: ['1', 2] })))).toEqual([
      '/schema/0/quality/0/mustBeBetween mustBeBetween must be two numbers',
    ]);
  });

  it('marks physicalName changes and servers that point elsewhere as breaking', () => {
    const kinds = (b: unknown) =>
      diffContracts(contract() as never, b as never).changes.map((c) => `${c.kind}${c.breaking ? '!' : ''}${c.field ? `:${c.field}` : ''}`);
    expect(kinds(contract((d) => (d.schema[0].physicalName = 'public.orders_old')))).toEqual(['physical-name-changed!']);
    expect(kinds(contract((d) => (d.schema[0].properties[0].physicalName = 'customer_id')))).toEqual(['physical-name-changed!:id']);
    expect(kinds(contract((d) => (d.servers[0].host = 'other.example.internal')))).toEqual(['server-changed!:prod']);
    expect(kinds(contract((d) => (d.servers[0].database = 'other')))).toEqual(['server-changed!:prod']);
  });

  it('never judges a threshold that is not a number as loosened (versions stored before the check)', () => {
    const d = diffContracts(contract() as never, contract((x) => (x.schema[0].quality[0].mustBeGreaterThan = '5')) as never);
    expect(d.changes[0]).toMatchObject({ kind: 'quality-changed', breaking: true });
  });
});

describe('M1: SQL quality rules', () => {
  const sql = (query: string, extra: Record<string, unknown> = {}) =>
    contract((d) => {
      d.schema[0].quality.push({ type: 'sql', query, mustBe: 0, ...extra });
      d.schema[0].properties[1].quality = [{ type: 'sql', name: 'no negative totals', query: 'SELECT COUNT(*) FROM {model} WHERE {column} < 0', mustBe: 0 }];
    });

  it('finds the SQL rules of schema objects and properties, all levels', () => {
    expect(sqlRules(sql('SELECT 1'))).toEqual([
      { path: '/schema/0/quality/1', name: 'orders quality #2', query: 'SELECT 1' },
      { path: '/schema/0/properties/1/quality/0', name: 'no negative totals', query: 'SELECT COUNT(*) FROM {model} WHERE {column} < 0' },
    ]);
    expect(sqlRules(contract())).toEqual([]);
  });

  it('reads the CLI’s placeholders as names, at the same positions; other ${…} are variables of the service: refused', () => {
    expect(withoutPlaceholders('SELECT x FROM "${model}" WHERE `{column}` > 0')).toEqual({ sql: 'SELECT x FROM xxxxxxxxxx WHERE xxxxxxxxxx > 0' });
    expect(withoutPlaceholders("SELECT '${DATACONTRACT_CLI_API_KEY}'").variable).toBe('${DATACONTRACT_CLI_API_KEY}');
    const p = sqlRuleProblem({ path: '/', name: 'x', query: "SELECT CASE WHEN '${SECRET}' LIKE 'a%' THEN 1 END" }, 'postgresql');
    expect(p).toMatchObject({ code: 'refusedWord', context: 'variable', word: '${SECRET}' });
  });

  it('refuses what is not one read-only SELECT: data-modifying CTEs, functions with effects, SELECT INTO, placeholders', () => {
    const refused = (q: string, d: 'postgresql' | 'mysql' | 'sqlserver' = 'postgresql') => sqlRuleProblem({ path: '/', name: 'r', query: q }, d)?.code ?? null;
    expect(refused('SELECT COUNT(*) FROM {model} WHERE {column} IS NULL')).toBeNull();
    expect(refused('WITH d AS (DELETE FROM t RETURNING 1) SELECT count(*) FROM d')).toBe('refusedWord');
    expect(refused('SELECT ascii(substr((SELECT secret FROM t LIMIT 1),1,1))')).toBeNull(); // a read: the "use" right decides who may
    expect(refused('SELECT pg_terminate_backend(1)')).toBe('refusedFunction');
    expect(refused("SELECT set_config('x', 'y', false)")).toBe('refusedFunction');
    expect(refused('SELECT 1; DROP TABLE t')).toBe('multipleStatements');
    expect(refused('SELECT * INTO copy FROM t', 'sqlserver')).toBe('refusedWord');
    expect(refused('SELECT $1')).toBe('placeholders');
    expect(refused('')).toBe('empty');
  });

  it('names the rule that is refused', () => {
    const doc = sql("SELECT lo_export(1, '/tmp/x')");
    expect(() => assertSqlRules(sqlRules(doc), ['postgresql'])).toThrow(/SQL quality rule "orders quality #2" \(\/schema\/0\/quality\/1\) is refused/);
    try {
      assertSqlRules(sqlRules(doc), ['postgresql']);
    } catch (e) {
      expect(e).toMatchObject({ statusCode: 400, code: 'DATA_CONTRACT_SQL_REFUSED', params: { rule: 'orders quality #2', path: '/schema/0/quality/1' } });
    }
  });
});

describe('M2: only Steward’s own code calls the data contract service', () => {
  const base = 'http://datacontract:4242';
  it('refuses /test, /lint and every changing method from anyone else', () => {
    expect(deniedOwnCall('datacontract', `${base}/test?server=prod`, 'POST')).toContain('POST');
    expect(deniedOwnCall('datacontract', `${base}/export`, 'POST')).toContain('POST');
    expect(deniedOwnCall('datacontract', `${base}/lint`, 'GET')).toContain('/lint');
    expect(deniedOwnCall('datacontract', `${base}/prefix/%54est`, 'HEAD')).toContain('/test');
    // the connection test reads the API description
    expect(deniedOwnCall('datacontract', `${base}/openapi.json`, 'GET')).toBeNull();
    // other kinds are not concerned
    expect(deniedOwnCall('generic', `${base}/test`, 'POST')).toBeNull();
    expect(() => assertPathAllowed('datacontract', `${base}/test`, 'POST')).toThrow(expect.objectContaining({ statusCode: 403, code: 'PLATFORM_PATH_DENIED' }));
  });

  it('lets Steward’s tests and lint through (ownCall), only for that kind', async () => {
    await ownCall('datacontract', async () => {
      expect(deniedOwnCall('datacontract', `${base}/test?server=prod`, 'POST')).toBeNull();
      expect(() => assertPathAllowed('datacontract', `${base}/lint`, 'POST')).not.toThrow();
    });
    await ownCall('other', async () => expect(deniedOwnCall('datacontract', `${base}/test`, 'POST')).not.toBeNull());
    // the marker does not outlive the call
    expect(deniedOwnCall('datacontract', `${base}/test`, 'POST')).not.toBeNull();
  });
});

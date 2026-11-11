import { beforeAll, describe, expect, it } from 'vitest';
import { checkPlatformKinds, checkSchema, definitionIssues, influxVersionOf, monitorDefinitionSchema } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';
import {
  InfluxQueryError,
  capSeries,
  fluxQuery,
  fluxString,
  influxQlIdent,
  influxQlStatements,
  influxQlString,
  lookbackSeconds,
  parseAnnotatedCsv,
  parseFlux,
  parseInfluxQl,
  parseInfluxTime,
  parseSql,
  sqlIdent,
  sqlQuery,
  sqlString,
  type InfluxReadSpec,
} from '../src/influx/query.js';

/**
 * InfluxDB as a source of the freshness check (0.18.0): the queries Steward writes per dialect (InfluxQL, Flux, SQL)
 * with every name and value quoted – injection attempts stay names and values –, the parsers of the answers (annotated
 * CSV, JSON, timestamps), the cap and the expected series; then against the mock in its three API styles: the worst
 * series counts, the authentication per version, the connection test, the outbound policy, Check now, YAML, the API.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const spec = (extra: Partial<InfluxReadSpec> = {}): InfluxReadSpec => ({
  version: '2',
  dialect: 'flux',
  database: 'plant',
  measurement: 'machine_data',
  fields: [],
  tags: {},
  lookbackSeconds: 86400,
  ...extra,
});

describe('quoting per dialect', () => {
  it('InfluxQL: identifiers in double quotes, strings in single quotes, backslash escapes', () => {
    expect(influxQlIdent('machine data')).toBe('"machine data"');
    expect(influxQlIdent('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(influxQlString("it's")).toBe("'it\\'s'");
    expect(influxQlString('back\\')).toBe("'back\\\\'");
  });
  it('Flux: strings with \\, " and ${ escaped', () => {
    expect(fluxString('plant')).toBe('"plant"');
    expect(fluxString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(fluxString('${secrets.get(key: "x")}')).toBe('"\\${secrets.get(key: \\"x\\")}"');
    expect(fluxString('$ alone')).toBe('"$ alone"');
  });
  it('SQL: quotes doubled, a backslash is an ordinary character', () => {
    expect(sqlIdent('Machine "A"')).toBe('"Machine ""A"""');
    expect(sqlString("o'clock")).toBe("'o''clock'");
    expect(sqlString('a\\b')).toBe("'a\\b'");
  });
  it('control characters and line breaks are refused, never passed on', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\tb', 'a b', 'a\u007fb'])
      for (const f of [influxQlIdent, influxQlString, fluxString, sqlIdent, sqlString]) expect(() => f(bad), JSON.stringify(bad)).toThrow(InfluxQueryError);
  });
});

describe('the queries', () => {
  it('InfluxQL 1.x: one statement per field with last(), GROUP BY the tag and SLIMIT; the retention policy qualifies the measurement', () => {
    const s = spec({
      version: '1',
      dialect: 'influxql',
      fields: ['temperature', 'pressure'],
      tags: { site: 'hall-2' },
      groupBy: 'device',
      retentionPolicy: 'autogen',
    });
    expect(influxQlStatements(s)).toEqual([
      `SELECT last("temperature") FROM "plant"."autogen"."machine_data" WHERE time > now() - 86400s AND "site" = 'hall-2' GROUP BY "device" SLIMIT 201`,
      `SELECT last("pressure") FROM "plant"."autogen"."machine_data" WHERE time > now() - 86400s AND "site" = 'hall-2' GROUP BY "device" SLIMIT 201`,
    ]);
    // no field: the newest point of any field, newest first
    expect(influxQlStatements(spec({ version: '1', dialect: 'influxql' }))).toEqual([
      'SELECT * FROM "machine_data" WHERE time > now() - 86400s ORDER BY time DESC LIMIT 1',
    ]);
    // InfluxDB 3 has no SLIMIT and no retention policy in the name
    expect(influxQlStatements(spec({ version: '3', dialect: 'influxql', groupBy: 'device', retentionPolicy: 'autogen' }))).toEqual([
      'SELECT * FROM "machine_data" WHERE time > now() - 86400s GROUP BY "device" ORDER BY time DESC LIMIT 1',
    ]);
  });

  it('Flux 2.x: filters, last() per series, the newest per group, one table capped', () => {
    expect(fluxQuery(spec({ fields: ['temperature'], tags: { site: 'hall-2' }, groupBy: 'device' }))).toBe(
      [
        'from(bucket: "plant")',
        '  |> range(start: -86400s)',
        '  |> filter(fn: (r) => r._measurement == "machine_data")',
        '  |> filter(fn: (r) => r["site"] == "hall-2")',
        '  |> filter(fn: (r) => r._field == "temperature")',
        '  |> last()',
        '  |> group(columns: ["device", "_field"])',
        '  |> sort(columns: ["_time"], desc: true)',
        '  |> limit(n: 1)',
        '  |> group()',
        '  |> keep(columns: ["_time", "device", "_field"])',
        '  |> limit(n: 201)',
      ].join('\n'),
    );
    expect(fluxQuery(spec())).toContain('|> group(columns: [])');
  });

  it('SQL 3.x: max(time) per group, per field the newest time it has a value', () => {
    expect(sqlQuery(spec({ version: '3', dialect: 'sql', fields: ['temperature', 'pressure'], tags: { site: 'hall-2' }, groupBy: 'device' }))).toBe(
      'SELECT "device" AS "steward_series", max(CASE WHEN "temperature" IS NOT NULL THEN time END) AS "steward_newest_0", ' +
        `max(CASE WHEN "pressure" IS NOT NULL THEN time END) AS "steward_newest_1" FROM "machine_data" WHERE time >= now() - INTERVAL '86400 seconds' ` +
        `AND "site" = 'hall-2' GROUP BY "device" ORDER BY "device" LIMIT 201`,
    );
    expect(sqlQuery(spec({ version: '3', dialect: 'sql' }))).toBe(
      `SELECT max(time) AS "steward_newest_0" FROM "machine_data" WHERE time >= now() - INTERVAL '86400 seconds'`,
    );
  });

  it('injection attempts stay names and values in every dialect', () => {
    const evil = {
      measurement: `m" OR 1=1; DROP MEASUREMENT "x`,
      tags: { [`site" = 'a' OR "x`]: `hall' OR '1'='1` },
      fields: [`f") |> yield() //`],
      groupBy: 'device',
    };
    const ql = influxQlStatements(spec({ version: '1', dialect: 'influxql', ...evil }))[0]!;
    expect(ql).toContain(`FROM "m\\" OR 1=1; DROP MEASUREMENT \\"x"`);
    expect(ql).toContain(`"site\\" = 'a' OR \\"x" = 'hall\\' OR \\'1\\'=\\'1'`);
    const flux = fluxQuery(spec(evil));
    expect(flux).toContain('r._measurement == "m\\" OR 1=1; DROP MEASUREMENT \\"x"');
    expect(flux).toContain('r._field == "f\\") |> yield() //"');
    const sql = sqlQuery(spec({ version: '3', dialect: 'sql', ...evil }));
    expect(sql).toContain(`FROM "m"" OR 1=1; DROP MEASUREMENT ""x"`);
    expect(sql).toContain(`"site"" = 'a' OR ""x" = 'hall'' OR ''1''=''1'`);
    // the look-back is an integer Steward computed, within 30 days
    expect(() => influxQlStatements(spec({ lookbackSeconds: 1.5 }))).toThrow(InfluxQueryError);
    expect(() => sqlQuery(spec({ lookbackSeconds: 31 * 86400 }))).toThrow(InfluxQueryError);
  });

  it('the look-back: 24 h by default, the freshness window and a half when longer, at most 30 days', () => {
    expect(lookbackSeconds(undefined, 600)).toBe(86400);
    expect(lookbackSeconds(undefined, 3 * 86400)).toBe(3 * 86400);
    expect(lookbackSeconds(2, 3 * 86400)).toBe(7200);
    expect(lookbackSeconds(undefined, 400 * 86400)).toBe(720 * 3600);
  });
});

describe('timestamps', () => {
  it('RFC 3339 with up to nanoseconds, zones, no zone (UTC) and epoch numbers by their size', () => {
    const ms = Date.UTC(2026, 10, 11, 8, 30, 15, 123);
    expect(parseInfluxTime('2026-11-11T08:30:15.123456789Z')).toBe(ms);
    expect(parseInfluxTime('2026-11-11T08:30:15.123456')).toBe(ms);
    expect(parseInfluxTime('2026-11-11 08:30:15.123')).toBe(ms);
    expect(parseInfluxTime('2026-11-11T09:30:15.123+01:00')).toBe(ms);
    expect(parseInfluxTime('2026-11-11T09:30:15.123+0100')).toBe(ms);
    expect(parseInfluxTime('2026-11-11T08:30:15Z')).toBe(ms - 123);
    expect(parseInfluxTime(ms)).toBe(ms);
    expect(parseInfluxTime(ms * 1e6)).toBe(ms);
    expect(parseInfluxTime(String(ms) + '456789')).toBe(ms);
    expect(parseInfluxTime(ms * 1e3)).toBe(ms);
    expect(parseInfluxTime(Math.floor(ms / 1000))).toBe(ms - 123);
    for (const bad of [null, undefined, '', 'yesterday', '2026-13-45T99:99:99Z', true, {}]) expect(parseInfluxTime(bad), String(bad)).toBeNull();
  });
});

describe('annotated CSV (Flux)', () => {
  const two = [
    '#datatype,string,long,dateTime:RFC3339Nano,string',
    '#group,false,false,false,false',
    '#default,_result,,,',
    ',result,table,_time,device',
    ',,0,2026-11-11T08:00:00.5Z,press-01',
    ',,0,2026-11-11T08:01:00Z,"press ""2"", hall 2"',
    '',
    '#datatype,string,long,dateTime:RFC3339,string',
    '#group,false,false,false,false',
    '#default,_result,,,',
    ',result,table,_time,device',
    ',,1,2026-11-11T08:02:00Z,"multi',
    'line"',
    '',
  ].join('\r\n');

  it('tables separated by an empty line, annotations skipped, quotes and line breaks in quotes', () => {
    const t = parseAnnotatedCsv(two);
    expect(t).toHaveLength(2);
    expect(t[0]!.columns).toEqual(['', 'result', 'table', '_time', 'device']);
    expect(t[0]!.rows.map((r) => r[4])).toEqual(['press-01', 'press "2", hall 2']);
    expect(t[1]!.rows[0]![4]).toBe('multi\r\nline');
    expect(parseFlux(two, { fields: [], groupBy: 'device' })).toEqual([
      { name: 'press-01', newest: Date.UTC(2026, 10, 11, 8, 0, 0, 500) },
      { name: 'press "2", hall 2', newest: Date.UTC(2026, 10, 11, 8, 1) },
      { name: 'multi\r\nline', newest: Date.UTC(2026, 10, 11, 8, 2) },
    ]);
    // without annotations (a plain CSV answer) and empty
    expect(parseFlux(',result,table,_time\n,_result,0,2026-11-11T08:00:00Z\n', { fields: [] })).toEqual([{ name: '', newest: Date.UTC(2026, 10, 11, 8) }]);
    expect(parseFlux('', { fields: [] })).toEqual([]);
    expect(parseFlux('\r\n', { fields: [] })).toEqual([]);
  });

  it('per field: the series is the group value and the field; an empty tag value is "(none)"', () => {
    const csv = ',result,table,_time,device,_field\n,,0,2026-11-11T08:00:00Z,press-01,temperature\n,,0,2026-11-11T07:00:00Z,,pressure\n';
    expect(parseFlux(csv, { fields: ['temperature', 'pressure'], groupBy: 'device' }).map((x) => x.name)).toEqual(['press-01/temperature', '(none)/pressure']);
  });

  it('strict: an error table throws its message, broken CSV throws', () => {
    expect(() => parseAnnotatedCsv('#datatype,string,long\n,error,reference\n,Failed to parse query,897\n')).toThrow('InfluxDB: Failed to parse query');
    // an error after partial results (HTTP 200)
    expect(() => parseFlux(`${two}\n,error,reference\n,"panic: runtime error",\n`, { fields: [] })).toThrow('panic: runtime error');
    expect(() => parseAnnotatedCsv(',a,b\n,"x,1\n')).toThrow('not closed');
    expect(() => parseAnnotatedCsv(',a,b\n,x"y,1\n')).toThrow('a quote inside');
    expect(() => parseAnnotatedCsv(',a,b\n,"x"y,1\n')).toThrow('after a closing quote');
    expect(() => parseAnnotatedCsv(',a,b\n,1\n')).toThrow('2 values for 3 columns');
    expect(() => parseFlux(',result,table,value\n,,0,1\n', { fields: [] })).toThrow('no _time column');
    expect(() => parseAnnotatedCsv('a\n'.repeat(30), 10)).toThrow('more than 10 lines');
  });
});

describe('JSON answers', () => {
  it('InfluxQL 1.x: result i is statement i (field i), the group value from the series tags', () => {
    const body = {
      results: [
        { statement_id: 0, series: [{ name: 'm', tags: { device: 'a' }, columns: ['time', 'last'], values: [[1762848000000, 1]] }] },
        { statement_id: 1, series: [{ name: 'm', tags: { device: 'a' }, columns: ['time', 'last'], values: [['2025-11-11T08:00:00Z', 1]] }] },
        { statement_id: 2 },
      ],
    };
    expect(parseInfluxQl(body, { fields: ['t', 'p', 'q'], groupBy: 'device' })).toEqual([
      { name: 'a/t', newest: 1762848000000 },
      { name: 'a/p', newest: Date.UTC(2025, 10, 11, 8) },
    ]);
    expect(() => parseInfluxQl({ results: [{ statement_id: 0, error: 'database not found: x' }] }, { fields: [] })).toThrow('database not found: x');
    expect(() => parseInfluxQl({ error: 'authorization failed' }, { fields: [] })).toThrow('authorization failed');
    expect(() => parseInfluxQl({ nothing: 1 }, { fields: [] })).toThrow('not an InfluxQL result');
  });

  it('InfluxDB 3: rows as a list, as JSON lines or in the results envelope', () => {
    const s = { fields: [], groupBy: 'device' };
    expect(parseSql([{ steward_series: 'a', steward_newest_0: '2026-11-11T08:00:00.123456' }], s)).toEqual([
      { name: 'a', newest: Date.UTC(2026, 10, 11, 8, 0, 0, 123) },
    ]);
    expect(parseSql('{"steward_series":"a","steward_newest_0":"2026-11-11T08:00:00"}\n{"steward_series":"b","steward_newest_0":null}\n', s)).toEqual([
      { name: 'a', newest: Date.UTC(2026, 10, 11, 8) },
      { name: 'b', newest: null },
    ]);
    expect(parseSql({ results: [{ series: [{ columns: ['steward_series', 'steward_newest_0'], values: [['a', '2026-11-11T08:00:00Z']] }] }] }, s)).toEqual([
      { name: 'a', newest: Date.UTC(2026, 10, 11, 8) },
    ]);
    expect(parseSql([], s)).toEqual([]);
    expect(() => parseSql({ error: 'table not found' }, s)).toThrow('table not found');
    // InfluxQL on InfluxDB 3: rows with the tag as a column
    expect(parseInfluxQl([{ 'iox::measurement': 'm', time: '2026-11-11T08:00:00', device: 'a', last: 1 }], { fields: ['t'], groupBy: 'device' })).toEqual([
      { name: 'a/t', newest: Date.UTC(2026, 10, 11, 8) },
    ]);
  });

  it('the cap: at most 200 series by name, the total told; expected values that are missing are series without data', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `d${String(i).padStart(3, '0')}`, newest: 1 }));
    const c = capSeries(many, { fields: [], groupBy: 'device' });
    expect(c).toMatchObject({ total: 250, truncated: true });
    expect(c.series).toHaveLength(200);
    expect(c.series.at(-1)!.name).toBe('d199');
    expect(capSeries([{ name: 'a', newest: 5 }], { fields: ['t'], groupBy: 'device' }, ['a', 'b']).series).toEqual([
      { name: 'a', newest: 5 },
      { name: 'a/t', newest: null },
      { name: 'b/t', newest: null },
    ]);
  });
});

describe('the check definition', () => {
  const issues = (extra: Record<string, unknown>) =>
    definitionIssues(
      monitorDefinitionSchema.parse({
        name: 'x',
        checks: [{ id: 'f', name: 'f', type: 'freshness', platform: 'p', mode: 'maxAge', maxAgeSeconds: 60, ...extra }],
      }),
    ).map((i) => `${i.path.split('.').pop()}: ${i.message}`);

  it('needs a measurement and a database or bucket; its fields only with the InfluxDB source', () => {
    expect(issues({ source: 'influxdb', bucket: 'plant', measurement: 'm', groupBy: 'device', expectedSeries: ['a'] })).toEqual([]);
    expect(issues({ source: 'influxdb' })).toEqual([
      'database: InfluxDB freshness needs the database (1.x, 3.x) or the bucket (2.x)',
      'measurement: InfluxDB freshness needs the measurement',
    ]);
    expect(issues({ source: 'influxdb', database: 'd', measurement: 'm', fields: ['a', 'a'], expectedSeries: ['x'] })).toEqual([
      'fields: each field only once',
      'expectedSeries: expected series need the tag the series are grouped by',
    ]);
    expect(issues({ source: 'influxdb', database: 'd', measurement: 'm', groupBy: 'site', tags: { site: 'a' } })).toEqual([
      'groupBy: the series cannot be grouped by a tag that is filtered to one value',
    ]);
    expect(issues({ source: 'platform', path: '/x', timestamp: 'ts', measurement: 'm' })).toEqual(['measurement: only the InfluxDB source reads this']);
  });

  it('the schema refuses control characters, too many fields, tags or expected series, and a look-back over 30 days', () => {
    const parse = (extra: Record<string, unknown>) => {
      const r = checkSchema.safeParse({ id: 'f', name: 'f', type: 'freshness', source: 'influxdb', platform: 'p', database: 'd', measurement: 'm', ...extra });
      return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };
    expect(parse({})).toEqual([]);
    expect(parse({ measurement: 'm\nDROP' })).toEqual(['measurement: no control characters or line breaks']);
    expect(parse({ tags: { 'a\u0000': 'b' } })).toEqual(['tags: "a\u0000" is not a valid tag key']);
    expect(parse({ tags: { a: 'b\r\nc' } })).toEqual(['tags.a: no control characters or line breaks']);
    expect(parse({ fields: Array.from({ length: 11 }, (_, i) => `f${i}`) })[0]).toMatch(/^fields: Too big/);
    expect(parse({ expectedSeries: Array.from({ length: 201 }, (_, i) => `d${i}`) })[0]).toMatch(/^expectedSeries: Too big/);
    expect(parse({ tags: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`t${i}`, 'v'])) })[0]).toMatch(/^tags: Too big/);
    expect(parse({ lookbackHours: 721 })[0]).toMatch(/^lookbackHours/);
    expect(parse({ language: 'flux' })[0]).toMatch(/^language/);
  });

  it('reads an InfluxDB platform; the version comes from the platform variable', () => {
    expect(checkPlatformKinds({ type: 'freshness', source: 'influxdb' })).toEqual(['influxdb']);
    expect(checkPlatformKinds({ type: 'freshness', source: 'insightsHub' })).toEqual(['insights-hub']);
    expect(checkPlatformKinds({ type: 'freshness' })).toEqual(['insights-hub']);
    expect(checkPlatformKinds({ type: 'freshness', source: 'platform' })).toEqual([]);
    expect(['1', '2.7', 'v3', '3.8.0', 'x', '', undefined].map((v) => influxVersionOf({ version: v }))).toEqual([
      '1',
      '2',
      '3',
      '3',
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('against the mock', () => {
  let s: TestServer;
  let mock: typeof import('../src/mock/mockInflux.js');
  let eng: typeof import('../src/monitors/engine.js');
  const ids: Record<'v1' | 'v2' | 'v3', string> = { v1: '', v2: '', v3: '' };

  const influxCheck = (id: string, platform: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    type: 'freshness',
    source: 'influxdb',
    platform,
    database: 'plant',
    measurement: 'machine_data',
    groupBy: 'device',
    mode: 'cadence',
    expectedIntervalSeconds: 60,
    ...extra,
  });
  const preview = (check: Record<string, unknown>) => s.api('POST', '/monitors/check-preview', { check });

  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    await s.api('POST', '/demo/setup', {});
    mock = await import('../src/mock/mockInflux.js');
    eng = await import('../src/monitors/engine.js');
    const demo = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'InfluxDB (demo)');
    ids.v2 = demo.id;
    const base = demo.baseUrl.replace(/\/influxdb2$/, '');
    ids.v1 = (
      await s.api('POST', '/platforms', {
        name: 'InfluxDB 1 (test)',
        kind: 'influxdb',
        baseUrl: `${base}/influxdb1`,
        config: { auth: { type: 'basic' }, variables: { version: '1' }, http: { proxy: 'none', retry: { maxRetries: 0 } } },
        secrets: { ...mock.DEMO_INFLUX.v1 },
      })
    ).id;
    ids.v3 = (
      await s.api('POST', '/platforms', {
        name: 'InfluxDB 3 (test)',
        kind: 'influxdb',
        baseUrl: `${base}/influxdb3`,
        config: { auth: { type: 'bearer' }, variables: { version: '3' }, http: { proxy: 'none', retry: { maxRetries: 0 } } },
        secrets: { token: mock.DEMO_INFLUX.v3.token },
      })
    ).id;
  });

  it('every version: one series per device, the stale press counts, with the right authentication', async () => {
    for (const [v, extra] of [
      ['v1', {}],
      ['v2', { database: undefined, bucket: 'plant' }],
      ['v3', {}],
      ['v3', { language: 'influxql' }],
    ] as const) {
      mock.resetInflux();
      const r = await preview(influxCheck('presses', ids[v], extra));
      expect(r.status, `${v} ${JSON.stringify(extra)}: ${r.message}`).toBe('down');
      expect(r.message).toMatch(/^1 of 4 series not fresh: Newest data of press-03 is 3\.0 h old, expected every 60 s \(1(79|80) intervals missed\)$/);
      expect(r.series.map((x: any) => [x.name, x.status])).toEqual([
        ['press-01', 'up'],
        ['press-02', 'up'],
        ['press-03', 'down'],
        ['press-04', 'up'],
      ]);
      expect(r.series[2].ageSeconds).toBeGreaterThanOrEqual(3 * 3600);
      expect(Date.parse(r.series[0].newest)).toBeGreaterThan(Date.now() - 60_000);
      const sent = mock.influxRequests.filter((x) => x.path !== '/ping' && x.path !== '/health');
      expect(sent).toHaveLength(1);
      const auth = sent[0]!.authorization;
      if (v === 'v1') expect(auth).toBe(`Basic ${Buffer.from(`${mock.DEMO_INFLUX.v1.username}:${mock.DEMO_INFLUX.v1.password}`).toString('base64')}`);
      if (v === 'v2') expect(auth).toBe(`Token ${mock.DEMO_INFLUX.v2.token}`);
      if (v === 'v3') expect(auth).toBe(`Bearer ${mock.DEMO_INFLUX.v3.token}`);
      if (v === 'v1') expect(sent[0]).toMatchObject({ method: 'GET', path: '/influxdb1/query', query: { db: 'plant', epoch: 'ms' } });
      if (v === 'v2') expect(sent[0]).toMatchObject({ method: 'POST', path: '/influxdb2/api/v2/query', query: { org: 'acme' }, body: { type: 'flux' } });
      if (v === 'v3') expect(sent[0]!.path).toBe(`/influxdb3/api/v3/query_${'language' in extra ? 'influxql' : 'sql'}`);
    }
  });

  it('fields and tag filters: a series per device and field; expected devices that are missing are down', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const r = await preview(
        influxCheck('temp', ids[v], {
          fields: ['temperature', 'pressure'],
          tags: { site: 'hall-2' },
          mode: 'maxAge',
          maxAgeSeconds: 600,
          expectedSeries: ['press-01', 'press-09'],
        }),
      );
      expect(
        r.series.map((x: any) => `${x.name}:${x.status}`),
        v,
      ).toEqual([
        'press-01/pressure:up',
        'press-01/temperature:up',
        'press-02/pressure:up',
        'press-02/temperature:up',
        'press-03/pressure:down',
        'press-03/temperature:down',
        'press-09/pressure:down',
        'press-09/temperature:down',
      ]);
      expect(r.message).toMatch(/^4 of 8 series not fresh: No data of press-09\/(pressure|temperature) within/);
    }
  });

  it('a short look-back hides the stale press; without grouping one series; no data at all is down', async () => {
    const fresh = await preview(influxCheck('short', ids.v2, { lookbackHours: 1 }));
    expect(fresh).toMatchObject({ status: 'up', message: expect.stringMatching(/^All 3 series are fresh \(oldest \d+ s\)$/) });
    const one = await preview(influxCheck('one', ids.v1, { groupBy: undefined }));
    expect(one).toMatchObject({ status: 'up', message: expect.stringMatching(/^Newest data is \d+ s old, expected every 60 s$/) });
    const none = await preview(influxCheck('none', ids.v3, { measurement: 'no_such_measurement' }));
    expect(none).toMatchObject({ status: 'down', message: 'No data within the last 4 min in no_such_measurement', series: [] });
  });

  it('more than 200 series: the first 200 by name are judged, the message tells', async () => {
    mock.setInfluxExtraSeries(
      Array.from({ length: 230 }, (_, i) => ({ site: 'hall-9', device: `zz-${String(i).padStart(3, '0')}`, fields: { temperature: 1000 } })),
    );
    try {
      const r = await preview(influxCheck('many', ids.v2));
      expect(r.series).toHaveLength(200);
      // Flux reads at most 201 rows: "201 of more" is what the check can know
      expect(r.message).toMatch(/ – only the first 200 of 201 series checked; narrow the query with tag filters$/);
      expect(r.status).toBe('down'); // press-03 is among the first 200
    } finally {
      mock.setInfluxExtraSeries([]);
    }
  });

  it('a name with quotes reaches InfluxDB as one name: nothing is found, nothing is injected', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      const r = await preview(influxCheck('evil', ids[v], { measurement: `machine_data" OR "1"="1`, tags: { site: `x' OR '1'='1` } }));
      expect(r.status, v).toBe('down');
      expect(r.message, v).toMatch(/^No data within/);
    }
    // a control character never reaches the platform: the check is refused when it is parsed
    await expect(preview(influxCheck('ctl', ids.v2, { measurement: 'machine_data\n|> drop()' }))).rejects.toMatchObject({ status: 400 });
  });

  it('wrong credentials, a missing bucket and a setting for another version: unknown with the reason, never down', async () => {
    const bad = await s.api('POST', '/platforms', {
      name: 'InfluxDB 2 (wrong token)',
      kind: 'influxdb',
      baseUrl: (await s.api('GET', `/platforms/${ids.v2}`)).baseUrl,
      config: { auth: { type: 'bearer' }, variables: { version: '2', org: 'acme' }, http: { proxy: 'none', retry: { maxRetries: 0 } } },
      secrets: { token: 'wrong-token-value' },
    });
    const r = await preview(influxCheck('auth', bad.id));
    expect(r.status).toBe('unknown');
    expect(r.message).toMatch(/^InfluxDB could not be read: InfluxDB answered HTTP 401 to the Flux query – The platform refused the credentials/);
    expect(r.message).not.toContain('wrong-token-value');
    const missing = await preview(influxCheck('bucket', ids.v2, { database: 'other' }));
    expect(missing).toMatchObject({ status: 'unknown', message: expect.stringContaining('could not find bucket "other"') });
    expect(await preview(influxCheck('rp', ids.v2, { retentionPolicy: 'autogen' }))).toMatchObject({
      status: 'unknown',
      message: expect.stringContaining('A retention policy is only for InfluxDB 1.x'),
    });
    expect(await preview(influxCheck('lang', ids.v1, { language: 'sql' }))).toMatchObject({
      status: 'unknown',
      message: expect.stringContaining('The query language is only for InfluxDB 3.x – 1.x reads InfluxQL'),
    });
    const noVersion = await s.api('POST', '/platforms', {
      name: 'InfluxDB (no version)',
      kind: 'influxdb',
      baseUrl: 'http://127.0.0.1:9/influx',
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
    });
    expect((await preview(influxCheck('nov', noVersion.id))).message).toContain('set its variable version to 1, 2 or 3');
  });

  it('saving refuses a platform of another kind; the check reads InfluxDB platforms only', async () => {
    const prom = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'prometheus');
    await expect(s.api('POST', '/monitors', { definition: { name: 'Influx on Prometheus', checks: [influxCheck('c', prom.id)] } })).rejects.toMatchObject({
      status: 400,
      body: { code: 'CHECK_PLATFORM_KIND' },
    });
  });

  it('the connection test of each version: ping or health, then a request with the credentials', async () => {
    for (const v of ['v1', 'v2', 'v3'] as const) {
      mock.resetInflux();
      const t = await s.api('POST', `/platforms/${ids[v]}/test`);
      expect(t.ok, `${v}: ${t.message}`).toBe(true);
      expect(mock.influxRequests.map((x) => `${x.method} ${x.path}`)).toEqual(
        v === 'v1'
          ? ['GET /influxdb1/ping', 'GET /influxdb1/query']
          : v === 'v2'
            ? ['GET /influxdb2/health', 'GET /influxdb2/api/v2/buckets']
            : ['GET /influxdb3/ping'],
      );
    }
    expect((await s.api('POST', `/platforms/${ids.v1}/test`)).message).toBe('GET /ping → HTTP 204, InfluxDB 1.11.8; the credentials work');
    expect((await s.api('POST', `/platforms/${ids.v2}/test`)).message).toBe('GET /health → pass, InfluxDB v2.7.12; the token works');
    expect((await s.api('POST', `/platforms/${ids.v3}/test`)).message).toBe('GET /ping → HTTP 200, InfluxDB 3.8.0 Core');
    const wrong = await s.api('POST', '/platforms', {
      name: 'InfluxDB 3 (wrong token)',
      kind: 'influxdb',
      baseUrl: (await s.api('GET', `/platforms/${ids.v3}`)).baseUrl,
      config: { auth: { type: 'bearer' }, variables: { version: '3' }, http: { proxy: 'none', retry: { maxRetries: 0 } } },
      secrets: { token: 'apiv3_wrong-token' },
    });
    const t = await s.api('POST', `/platforms/${wrong.id}/test`);
    expect(t.ok).toBe(false);
    expect(t.message).toMatch(/^InfluxDB answered HTTP 401 to GET \/ping/);
    expect(t.message).not.toContain('apiv3_wrong-token');
  });

  it('the outbound policy applies: a base URL outside the allow-list is not called', async () => {
    const before = await s.api('GET', '/settings');
    await s.api('PUT', '/settings', { outboundPolicy: 'allowList', outboundAllowList: [] });
    try {
      mock.resetInflux();
      const r = await preview(influxCheck('policy', ids.v2));
      expect(r.status).toBe('unknown');
      expect(r.message).toMatch(/Blocked by the outbound policy/);
      expect(mock.influxRequests).toHaveLength(0);
    } finally {
      await s.api('PUT', '/settings', { outboundPolicy: before.outboundPolicy, outboundAllowList: before.outboundAllowList ?? [] });
    }
  });

  it('a template fills the InfluxDB fields per instance; a duplicate keeps them', async () => {
    const yaml = [
      'kind: monitorTemplate',
      'key: influx-press-template',
      'name: "{{ params.press }} in InfluxDB"',
      'parameters:',
      '  - { name: press, label: Press }',
      '  - { name: site, label: Site, default: hall-2 }',
      'checks:',
      '  - id: press',
      '    name: "Data of {{ params.press }}"',
      '    type: freshness',
      '    source: influxdb',
      '    platform: InfluxDB (demo)',
      '    bucket: plant',
      '    measurement: machine_data',
      '    tags: { site: "{{ params.site }}", device: "{{ params.press }}" }',
      '    mode: maxAge',
      '    maxAgeSeconds: 600',
    ].join('\n');
    const t = await s.api('POST', '/monitors/import', { yaml });
    const made = await s.api('POST', `/monitors/${t.monitor.id}/instances`, { rows: [{ params: { press: 'press-03' }, key: 'influx-press-03' }] });
    const inst = (await s.api('GET', '/monitors')).find((m: any) => m.key === 'influx-press-03');
    expect(inst, JSON.stringify(made).slice(0, 300)).toBeTruthy();
    const def = (await s.api('GET', `/monitors/${inst.id}`)).definition;
    expect(def.checks[0]).toMatchObject({ source: 'influxdb', bucket: 'plant', tags: { site: 'hall-2', device: 'press-03' } });
    const r = await preview({ ...def.checks[0] });
    expect(r).toMatchObject({ status: 'down', message: expect.stringMatching(/^Newest data is 3\.0 h old \(maximum 10 min\)$/) });
    const copy = await s.api('POST', `/monitors/${inst.id}/duplicate`, { key: 'influx-press-03-copy' });
    expect((await s.api('GET', `/monitors/${copy.id}`)).definition.checks[0]).toMatchObject({ source: 'influxdb', tags: { device: 'press-03' } });
  });

  it('the demo monitor shows the stale press; observed delay is measured per series; YAML, the API and MCP carry the check', async () => {
    const list = await s.api('GET', '/monitors');
    const demo = list.find((m: any) => m.key === 'influxdb-machine-data');
    expect(demo).toBeTruthy();
    // down needs two failing results in a row (failuresBeforeDown); the second read also records the series it saw
    await eng.evaluateMonitorNow(demo.id);
    await eng.evaluateMonitorNow(demo.id);
    const m = await s.api('GET', `/monitors/${demo.id}`);
    const presses = m.checks.find((c: any) => c.checkId === 'presses');
    expect(presses.status, presses.last?.message).toBe('down');
    expect(presses.last.message).toContain('press-03');
    expect(m.checks.find((c: any) => c.checkId === 'hall-2-temperature').last.message).toMatch(
      /^1 of 3 series not fresh: Newest data of press-03\/temperature/,
    );
    const od = m.checks.find((c: any) => c.checkId === 'presses').observedDelay;
    expect(od.variables.map((x: any) => x.name).sort()).toEqual(['press-01', 'press-02', 'press-03', 'press-04']);
    // YAML export and import keep the source's fields
    const yaml = await s.api('GET', `/monitors/${demo.id}/export`);
    expect(yaml).toMatch(/source: influxdb/);
    expect(yaml).toMatch(/measurement: machine_data/);
    expect(yaml).toMatch(/expectedSeries:\n\s+- press-01/);
    expect(yaml).toMatch(/tags:\n\s+site: hall-2/);
    const copy = await s.api('POST', '/monitors/import', { yaml, key: 'influxdb-copy' });
    const def = (await s.api('GET', `/monitors/${copy.monitor.id}`)).definition;
    expect(def.checks[1]).toMatchObject({ source: 'influxdb', bucket: 'plant', fields: ['temperature'], tags: { site: 'hall-2' }, groupBy: 'device' });
    // the public API returns the definition as saved
    const { token } = await s.api('POST', '/me/tokens', { name: 'influx read', scope: 'read' });
    const v1 = await (await fetch(`${s.base}/api/v1/monitors/${demo.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(v1.definition.checks[0]).toMatchObject({ type: 'freshness', source: 'influxdb', measurement: 'machine_data', groupBy: 'device' });
    const status = await (await fetch(`${s.base}/api/v1/monitors/${demo.id}/status`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(status.checks[0].message).toContain('press-03');
    // MCP: the check's status and message
    await s.api('PUT', '/mcp-server', { enabled: true });
    const mcp = (await s.api('POST', '/me/tokens', { name: 'influx mcp', scope: 'mcp' })).token;
    // a modern MCP request (2026-07-28): the protocol version and client in _meta and in the headers
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
    };
    const res = await fetch(`${s.base}/api/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mcp}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'get_monitor',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_monitor', arguments: { monitor: 'influxdb-machine-data' }, _meta: meta },
      }),
    });
    const body = await res.json();
    expect(body.result, JSON.stringify(body).slice(0, 500)).toBeTruthy();
    const checks = body.result.structuredContent.checks;
    expect(checks.find((c: any) => c.checkId === 'presses')).toMatchObject({ type: 'freshness', status: 'down', message: expect.stringContaining('press-03') });
  });
});

import crypto from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fromMicros, toMicros } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Platform costs (#226, docs/COSTS.md): the decimals, the CSV reader, FOCUS file imports (preview, duplicates, replace
 * with corrections, mapping by tag), what readers see per scope (hidden scopes answer 404, amounts can be hidden from
 * viewers) and the push of FOCUS files from CI with a per-platform push token.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let platform: string;
let app: string;
let service: string;
let olivia: Client;
let vera: Client;
let audrey: Client;

const month = new Date().toISOString().slice(0, 7);
const prevMonth = (() => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
})();

const HEAD =
  'BillingPeriodStart,BillingPeriodEnd,ChargePeriodStart,ChargePeriodEnd,BilledCost,EffectiveCost,BillingCurrency,ProviderName,ServiceName,ServiceCategory,ResourceId,Tags,x_Custom';
const row = (day: string, billed: string, tags: string, service = 'Virtual Machines', resource = 'vm-1') =>
  [`${day.slice(0, 7)}-01T00:00:00Z`, '', `${day}T00:00:00Z`, `${day}T01:00:00Z`, billed, '', 'EUR', 'Azure', service, 'Compute', resource, tags, 'x'].join(
    ',',
  );
const tags = (o: Record<string, string>) => `"${JSON.stringify(o).replaceAll('"', '""')}"`;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  audrey = await s.as('audrey', PW);
  platform = (
    await s.api('POST', '/platforms', {
      name: 'Azure (exports)',
      kind: 'generic',
      baseUrl: 'https://management.example.com',
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
    })
  ).id;
  app = (await s.api('POST', '/applications', { name: 'Bakery app' })).id;
  service = (await s.api('POST', '/services', { name: 'Bakery service', owners: [] })).id;
  await s.api('PUT', `/services/${service}/applications/${app}`, {});
}, 120_000);
beforeEach(async () => {
  (await import('../src/costs/push.js')).resetCostPushState();
});

describe('decimals', () => {
  it('reads decimal text into whole millionths without floats, and writes it back', () => {
    expect(toMicros('1840.0000000000')).toBe(1_840_000_000);
    expect(toMicros('-12.5')).toBe(-12_500_000);
    expect(toMicros('1.2E-5')).toBe(12);
    expect(toMicros('0.0000005')).toBe(1);
    expect(toMicros('0.1')! + toMicros('0.2')!).toBe(toMicros('0.3'));
    expect(toMicros(' 3 ')).toBe(3_000_000);
    for (const bad of ['', 'abc', '1.2.3', '1e', '--1', '1,5', '9'.repeat(20), 'NaN', 'Infinity']) expect(toMicros(bad)).toBeNull();
    expect(fromMicros(1_840_000_000)).toBe('1840.00');
    expect(fromMicros(12)).toBe('0.000012');
    expect(fromMicros(-12_500_000)).toBe('-12.50');
  });
});

describe('CSV', () => {
  it('reads quoted cells, doubled quotes, line breaks in cells and every line end; refuses broken quotes and long cells', async () => {
    const { readCsv } = await import('../src/costs/csv.js');
    const rows: string[][] = [];
    const limits = { rows: 10, columns: 10, cellChars: 50 };
    readCsv('﻿a,b\r\n"x, ""y""","line\nbreak"\r3,4\n\n5,', limits, (c) => rows.push(c));
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, "y"', 'line\nbreak'],
      ['3', '4'],
      ['5', ''],
    ]);
    const semi: string[][] = [];
    readCsv('a;b\n1,5;2', limits, (c) => semi.push(c));
    expect(semi[1]).toEqual(['1,5', '2']);
    expect(() => readCsv('a\n"open', limits, () => {})).toThrow(/not closed/);
    expect(() => readCsv('a\nx"y', limits, () => {})).toThrow(/quote inside/);
    expect(() => readCsv(`a\n${'x'.repeat(51)}`, limits, () => {})).toThrow(/more than 50 characters/);
    expect(() => readCsv('a\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11', limits, () => {})).toThrow(/more than 10 rows/);
    // a long run of quotes and separators is read in one pass (no backtracking)
    const t0 = Date.now();
    expect(() => readCsv(`a\n${'"'.repeat(200_001)}`, { rows: 10, columns: 10, cellChars: 1_000_000 }, () => {})).toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('keeps tags without prototype keys', async () => {
    const { parseTags } = await import('../src/costs/focus.js');
    const t = parseTags('{"__proto__":{"polluted":"yes"},"constructor":"x","application":"Bakery app","n":3,"o":{"x":1}}')!;
    expect(t).toEqual({ application: 'Bakery app', n: '3' });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
    expect(parseTags('[1]')).toBeNull();
  });
});

describe('FOCUS imports', () => {
  const day1 = `${prevMonth}-03`;
  const day2 = `${prevMonth}-04`;
  const file = [
    HEAD,
    row(day1, '10.50', tags({ application: 'bakery app' })),
    row(day1, '0.25', tags({ application: 'bakery app' })),
    row(day2, '7', tags({ application: 'Bakery app' }), 'Storage', 'disk-1'),
    row(day2, '3.333333', tags({ team: 'x' }), 'Storage', 'disk-2'),
    row(day2, 'n/a', '{}'),
  ].join('\n');

  it('previews a file: columns, period, totals, mapping – nothing stored', async () => {
    await expect(olivia('POST', `/costs/platform/${platform}/imports/preview`, { csv: file })).rejects.toMatchObject({ status: 403 });
    await expect(vera('POST', `/costs/platform/${platform}/imports/preview`, { csv: file })).rejects.toMatchObject({ status: 404 });
    const p = await s.api('POST', `/costs/platform/${platform}/imports/preview`, { csv: file, fileName: 'azure.csv' });
    expect(p).toMatchObject({
      fileName: 'azure.csv',
      rows: 5,
      lines: 3,
      periodStart: `${day1}T00:00:00.000Z`,
      totals: [{ currency: 'EUR', billed: '21.083333', effective: '21.083333' }],
      providers: ['Azure'],
      assigned: 2,
      unassigned: 1,
      duplicateOf: null,
      replacesLines: 0,
    });
    expect(p.columns.ignored).toBe(1);
    expect(p.columns.found).toContain('Tags');
    expect(p.warnings[0]).toMatch(/^Line 6: BilledCost "n\/a" is not a number/);
    expect(p.sha256).toBe(crypto.createHash('sha256').update(file).digest('hex'));
    const { db } = await import('../src/db.js');
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_records WHERE source_platform_id = ?', platform)!.n).toBe(0);
  });

  it('refuses files that are not FOCUS', async () => {
    await expect(s.api('POST', `/costs/platform/${platform}/imports/preview`, { csv: 'a,b\n1,2' })).rejects.toMatchObject({
      status: 400,
      body: expect.objectContaining({ code: 'COST_IMPORT_COLUMNS' }),
    });
  });

  it('imports, refuses the same file twice, and replaces earlier lines of the same days as an audited correction', async () => {
    const r = await s.api('POST', `/costs/platform/${platform}/imports`, { csv: file, fileName: 'azure.csv' });
    expect(r).toMatchObject({ inserted: 3, replaced: 0, corrections: [] });
    await expect(s.api('POST', `/costs/platform/${platform}/imports`, { csv: file })).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ code: 'COST_IMPORT_DUPLICATE' }),
    });
    const [entry] = await s.api('GET', `/audit?action=cost.imported&entityId=${platform}`);
    expect(entry.details).toMatchObject({ sha256: r.import.sha256, rows: 5, lines: 3, mode: 'replace', totals: [{ currency: 'EUR', effective: '21.083333' }] });

    const d = await s.api('GET', `/costs/application/${app}`);
    const eur = d.currencies.find((c: { currency: string }) => c.currency === 'EUR');
    expect(eur.months.find((m: { month: string }) => m.month === prevMonth).amount).toBe('17.75');
    expect(eur.lastMonth).toBe('17.75');
    // the service covers its applications
    const sv = await s.api('GET', `/costs/service/${service}`);
    expect(sv.currencies[0].lastMonth).toBe('17.75');
    // the platform: everything, with what no application is linked to
    const pl = await s.api('GET', `/costs/platform/${platform}`);
    expect(pl.currencies[0].lastMonth).toBe('21.083333');
    expect(pl.unassigned).toEqual([{ currency: 'EUR', thisMonth: null, lastMonth: '3.333333' }]);
    expect(pl.parts.map((p: { kind: string; name: string }) => [p.kind, p.name])).toEqual([
      ['application', 'Bakery app'],
      ['unassigned', ''],
    ]);

    // a corrected file for the same days: the closed days' changes are corrections
    const corrected = [
      HEAD,
      row(day1, '12.75', tags({ application: 'Bakery app' })),
      row(day2, '7', tags({ application: 'Bakery app' }), 'Storage', 'disk-1'),
    ].join('\n');
    const pv = await s.api('POST', `/costs/platform/${platform}/imports/preview`, { csv: corrected });
    expect(pv.replacesLines).toBe(3);
    const c = await s.api('POST', `/costs/platform/${platform}/imports`, { csv: corrected, fileName: 'azure-v2.csv' });
    expect(c.replaced).toBe(3);
    expect(c.corrections).toEqual([{ month: prevMonth, currency: 'EUR', before: '21.083333', after: '0.00', lines: 3 }]);
    const [corr] = await s.api('GET', `/audit?action=cost.corrected&entityId=${platform}`);
    expect(corr.summary).toContain(`${prevMonth} EUR 21.083333 → 0.00`);
    expect((await s.api('GET', `/costs/application/${app}`)).currencies[0].lastMonth).toBe('19.75');
    expect((await s.api('GET', `/costs/platform/${platform}/imports`)).map((i: { fileName: string }) => i.fileName)).toEqual(['azure-v2.csv', 'azure.csv']);
  });

  it('adds a file without replacing in mode "add"', async () => {
    const other = [HEAD, row(`${prevMonth}-03`, '1', tags({ application: 'Bakery app' }), 'Network', 'lb-1')].join('\n');
    const r = await s.api('POST', `/costs/platform/${platform}/imports`, { csv: other, mode: 'add' });
    expect(r.replaced).toBe(0);
    expect((await s.api('GET', `/costs/application/${app}`)).currencies[0].lastMonth).toBe('20.75');
  });
});

describe('who sees costs', () => {
  it('answers 404 for scopes the reader may not see and hides amounts from viewers when the setting says so', async () => {
    // a viewer sees no platforms at all, but the service and the application of the whole instance
    await expect(vera('GET', `/costs/platform/${platform}`)).rejects.toMatchObject({ status: 404 });
    expect((await vera('GET', `/costs/application/${app}`)).currencies[0].lastMonth).toBe('20.75');
    expect((await vera('GET', '/costs?scope=platform')).rows).toEqual([]);
    // auditors see every platform's costs
    expect((await audrey('GET', `/costs/platform/${platform}`)).amountsVisible).toBe(true);

    await expect(olivia('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'EUR' })).rejects.toMatchObject({ status: 403 });
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: true, defaultCurrency: 'EUR' });
    const hidden = await vera('GET', `/costs/application/${app}`);
    expect(hidden.amountsVisible).toBe(false);
    expect(hidden.currencies[0].lastMonth).toBeNull();
    expect(JSON.stringify(hidden)).not.toContain('20.75');
    const row0 = (await vera('GET', '/costs?scope=service')).rows.find((r: { id: string }) => r.id === service);
    expect(row0).toMatchObject({ amountsVisible: false, lastMonth: null });
    // auditors and administrators still see them
    expect((await audrey('GET', `/costs/application/${app}`)).currencies[0].lastMonth).toBe('20.75');
    const [audit] = await s.api('GET', '/audit?action=cost.settings_changed');
    expect(audit.details.after).toEqual({ hideAmountsFromViewers: true, defaultCurrency: 'EUR' });
    await s.api('PUT', '/costs/settings', { hideAmountsFromViewers: false, defaultCurrency: 'USD' });
  });

  it('never names applications the reader may not see', async () => {
    const { db } = await import('../src/db.js');
    const team = (await s.api('POST', '/teams', { name: 'Secret team' })).id;
    const secret = (await s.api('POST', '/applications', { name: 'Secret app' })).id;
    db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('application', ?, ?, ?)", secret, team, new Date().toISOString());
    const f = [HEAD, row(`${prevMonth}-05`, '99', tags({ application: 'Secret app' }), 'Database', 'db-9')].join('\n');
    await s.api('POST', `/costs/platform/${platform}/imports`, { csv: f, mode: 'add' });
    expect((await s.api('GET', `/costs/platform/${platform}`)).parts.some((p: { name: string }) => p.name === 'Secret app')).toBe(true);
    await expect(audrey('GET', `/costs/application/${secret}`)).resolves.toBeTruthy();
    await expect(olivia('GET', `/costs/application/${secret}`)).rejects.toMatchObject({ status: 404 });
    const o = await olivia('GET', `/costs/platform/${platform}`);
    expect(JSON.stringify(o)).not.toContain('Secret app');
    expect(o.parts.some((p: { kind: string }) => p.kind === 'other')).toBe(true);
    expect((await olivia('GET', '/costs?scope=application')).rows.some((r: { id: string }) => r.id === secret)).toBe(false);
    // a service with the hidden application: its costs are neither named nor counted for olivia
    await s.api('PUT', `/services/${service}/applications/${secret}`, {});
    const full = await s.api('GET', `/costs/service/${service}`);
    expect(full.parts.map((p: { name: string }) => p.name)).toContain('Secret app');
    const mine = await olivia('GET', `/costs/service/${service}`);
    expect(JSON.stringify(mine)).not.toContain('Secret app');
    expect(mine.parts.some((p: { kind: string }) => p.kind === 'other')).toBe(false);
    expect(Number(mine.currencies[0].lastMonth)).toBe(Number(full.currencies[0].lastMonth) - 99);
    await s.api('DELETE', `/services/${service}/applications/${secret}`);
  });
});

describe('push from CI', () => {
  const push = async (token: string | null, body: string, headers: Record<string, string> = {}, target = platform, query = '') => {
    const res = await fetch(`${s.base}/api/hooks/costs/${target}${query}`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  const csv = (n: string) => [HEAD, row(`${prevMonth}-09`, n, tags({ application: 'Bakery app' }), 'Functions', `fn-${n}`)].join('\n');

  it('takes only the push token of the platform, stored as a hash and audited', async () => {
    await expect(olivia('POST', `/costs/platform/${platform}/push-tokens`, { name: 'ci' })).rejects.toMatchObject({ status: 403 });
    const t = await s.api('POST', `/costs/platform/${platform}/push-tokens`, { name: 'Pipeline', expiresInDays: 30 });
    expect(t.token).toMatch(/^scp_[A-Za-z0-9_-]{40,}$/);
    expect(t.path).toBe(`/api/hooks/costs/${platform}`);
    const { db } = await import('../src/db.js');
    expect(db().get<{ hash: string }>('SELECT hash FROM cost_push_tokens WHERE id = ?', t.id)!.hash).toBe(
      crypto.createHash('sha256').update(t.token).digest('hex'),
    );
    expect(JSON.stringify(await s.api('GET', '/audit?limit=300'))).not.toContain(t.token);

    expect((await push(null, csv('1'))).status).toBe(401);
    expect((await push('sm_abc', csv('1'))).json.code).toBe('COST_PUSH_API_TOKEN');
    expect((await push(`${t.token}x`, csv('1'))).json.code).toBe('COST_PUSH_TOKEN_INVALID');
    expect((await push(t.token, csv('1'), { cookie: 'sm_session=abc' })).json.code).toBe('COST_PUSH_SESSION');
    expect((await push(t.token, csv('1'), { 'content-type': 'application/json' })).status).toBe(415);
    // a token of another platform answers like a wrong one
    const other = (await s.api('GET', '/platforms')).find((p: { id: string; kind: string }) => p.id !== platform && p.kind === 'generic');
    expect((await push(t.token, csv('1'), {}, other.id)).json.code).toBe('COST_PUSH_TOKEN_INVALID');

    // the body limit of the push is the file limit
    const big = await fetch(`${s.base}/api/hooks/costs/${platform}`, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', authorization: `Bearer ${t.token}` },
      body: 'x'.repeat(26 * 1024 * 1024),
    });
    // the token is checked first; a file above 25 MB is refused
    expect(big.status).toBe(400);
    (await import('../src/costs/push.js')).resetCostPushState();
    const ok = await push(t.token, csv('2'), {}, platform, '?fileName=ci.csv&mode=add');
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ inserted: 1, import: { via: 'push', fileName: 'ci.csv', mode: 'add' } });
    const [entry] = await s.api('GET', `/audit?action=cost.imported&entityId=${platform}`);
    expect(entry.actor).toBe('push token "Pipeline"');
    expect(entry.details).toMatchObject({ via: 'push', tokenId: t.id });
    expect((await s.api('GET', `/costs/platform/${platform}/push-tokens`))[0].lastUsedAt).toBeTruthy();

    const rotated = await s.api('POST', `/costs/platform/${platform}/push-tokens/${t.id}/rotate`);
    expect((await push(t.token, csv('3'))).status).toBe(401);
    expect((await push(rotated.token, csv('3'), {}, platform, '?mode=add')).status).toBe(200);
    await s.api('DELETE', `/costs/platform/${platform}/push-tokens/${t.id}`);
    expect((await push(rotated.token, csv('4'))).status).toBe(401);
  });

  it('stops with a creator who may no longer manage the platform, and keeps to the rate limit', async () => {
    const dana = await s.as('dana', PW);
    // designers may use platforms but not manage them: the access list gives dana the manage right
    const { db } = await import('../src/db.js');
    db().run('UPDATE platforms SET acl = ? WHERE id = ?', JSON.stringify([{ subject: 'user:dana', permissions: ['use', 'manage'] }]), platform);
    const t = await dana('POST', `/costs/platform/${platform}/push-tokens`, { name: 'dana', rateLimitPerMinute: 1 });
    expect((await push(t.token, csv('5'), {}, platform, '?mode=add')).status).toBe(200);
    expect((await push(t.token, csv('6'), {}, platform, '?mode=add')).status).toBe(429);
    (await import('../src/costs/push.js')).resetCostPushState();
    db().run('UPDATE platforms SET acl = ? WHERE id = ?', '[]', platform);
    expect((await push(t.token, csv('7'), {}, platform, '?mode=add')).json.code).toBe('COST_PUSH_TOKEN_INVALID');
  });
});

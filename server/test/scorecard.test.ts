import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Availability objectives and the service scorecard (#86): the status of objectives per window (met, below target,
 * no data and why), hourly sampling and history, breach messages once per breach, each part of the scorecard
 * (duties from the stored periods, availability, documentation with the rules on the CIA rating, protection need),
 * the rollup, the daily snapshots and the trend, permissions (only what the reader may see counts and shows), the
 * start page tile, the report section and the public API.
 */

process.env.TZ = 'Europe/Berlin';
process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

// documents a reader may not read (as in service-documents.test.ts): per user name, record ids
const hidden = vi.hoisted(() => new Map<string, Set<string>>());
vi.mock('../src/records/access.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/records/access.js')>();
  return {
    ...m,
    canReadRecordRow: (u: { username: string } | null, r: { id?: string; type_id: string; fields: string; owner: string }) =>
      !(u && r.id && hidden.get(u.username)?.has(r.id)) && m.canReadRecordRow(u as never, r),
  };
});

const PW = 'Demo-password-1';
const HOUR = 3600000;
const DAY = 86400000;
let s: TestServer;
let dana: Client, olivia: Client, adam: Client, vera: Client, audrey: Client;
let gatusId = '';
let secretGatus = '';
let processId = '';
type Db = (typeof import('../src/db.js'))['db'];
let db: Db;
let jobs: typeof import('../src/scorecard/jobs.js');
let sc: typeof import('../src/scorecard/scorecard.js');

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: { body: { code?: string } }) => e.body?.code ?? '',
  );
const iso = (t: number) => new Date(t).toISOString();
const auditActions = async (entityId: string) => {
  const a = await s.api('GET', `/audit?entityId=${entityId}`);
  return ((a.items ?? a) as { action: string }[]).map((e) => e.action);
};

/** The Gatus figures Steward "has read" for a platform: source state and the uptime per endpoint (percent). */
function gatusData(
  platformId: string,
  o: { enabled?: boolean; uptimes?: boolean; at?: number | null },
  endpoints: Record<string, Partial<Record<string, number | null>>>,
) {
  const now = iso(Date.now());
  db().run(
    `INSERT INTO gatus_sources (platform_id, enabled, fetch_uptimes, owner, last_uptimes_at, created_at, updated_at, updated_by) VALUES (?, ?, ?, 'admin', ?, ?, ?, 'admin')
     ON CONFLICT (platform_id) DO UPDATE SET enabled = excluded.enabled, fetch_uptimes = excluded.fetch_uptimes, last_uptimes_at = excluded.last_uptimes_at`,
    platformId,
    o.enabled === false ? 0 : 1,
    o.uptimes === false ? 0 : 1,
    o.at === null ? null : iso(o.at ?? Date.now()),
    now,
    now,
  );
  for (const [key, up] of Object.entries(endpoints)) {
    const [group, name] = key.includes('_') ? key.split('_') : ['', key];
    db().run(
      `INSERT INTO gatus_endpoints (platform_id, key, group_name, name, type, first_seen_at, last_seen_at, gatus_uptime) VALUES (?, ?, ?, ?, 'HTTP', ?, ?, ?)
       ON CONFLICT (platform_id, key) DO UPDATE SET gatus_uptime = excluded.gatus_uptime`,
      platformId,
      key,
      group,
      name,
      now,
      now,
      JSON.stringify({ h1: null, h24: null, d7: null, d30: null, ...up }),
    );
  }
}

let n = 0;
const newService = (owners: string[] = []) => dana('POST', '/services', { name: `Scorecard service ${++n}`, owners });
const objective = (serviceId: string, over: Record<string, unknown> = {}) =>
  dana('POST', '/objectives', {
    serviceId,
    name: `Portal ${++n}`,
    platformId: gatusId,
    endpointKey: 'core_portal',
    targets: { h1: null, h24: 99, d7: null, d30: 99.5 },
    ...over,
  });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, vera, audrey] = await Promise.all(['dana', 'olivia', 'adam', 'vera', 'audrey'].map((u) => s.as(u, PW)));
  db = (await import('../src/db.js')).db;
  jobs = await import('../src/scorecard/jobs.js');
  sc = await import('../src/scorecard/scorecard.js');
  gatusId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Gatus (demo)').id;
  // a Gatus platform only the administrator may see
  secretGatus = (await s.api('POST', '/platforms', { name: 'Secret Gatus', kind: 'gatus', baseUrl: 'https://gatus.internal.example' })).id;
  (await import('../src/platforms/service.js')).setPlatformAccess(secretGatus, [{ subject: 'user:admin', permissions: ['manage'] }]);
  gatusData(gatusId, {}, { core_portal: { h1: 100, h24: 99.5, d7: 99.9, d30: 99.95 }, core_api: { h24: 97.25, d30: 99.2 }, core_quiet: {} });
  gatusData(secretGatus, {}, { core_vault: { h24: 100, d30: 100 } });
  processId = (await s.api('GET', '/processes'))[0].id;
});
afterAll(async () => {
  await s?.app.close();
});

// ---------- objectives ----------

describe('availability objectives', () => {
  it('judge each window with a target: met, below target, no data – from the figures Steward read from Gatus', async () => {
    const svc = await newService();
    const met = await objective(svc.id, { name: 'Portal' });
    expect(met.windows).toEqual([
      { window: 'h24', target: 99, value: 99.5, status: 'met' },
      { window: 'd30', target: 99.5, value: 99.95, status: 'met' },
    ]);
    expect(met).toMatchObject({
      status: 'met',
      noDataReason: null,
      platformVisible: true,
      platformId: gatusId,
      endpointKey: 'core_portal',
      endpointName: 'core/portal',
    });
    expect(met.targets).toEqual({ h1: null, h24: 99, d7: null, d30: 99.5 });
    // exactly on target is met; one hundredth below is below
    const exact = await objective(svc.id, { endpointKey: 'core_api', targets: { h1: null, h24: 97.25, d7: null, d30: 99.21 } });
    expect(exact.windows.map((w: any) => [w.window, w.status])).toEqual([
      ['h24', 'met'],
      ['d30', 'below'],
    ]);
    expect(exact.status).toBe('below');
    // a window Gatus has no value for: no data (and below wins over no data)
    const partial = await objective(svc.id, { endpointKey: 'core_api', targets: { h1: 99, h24: 90, d7: null, d30: null } });
    expect(partial.windows.map((w: any) => w.status)).toEqual(['noData', 'met']);
    expect(partial).toMatchObject({ status: 'noData', noDataReason: 'noValue' });
    const quiet = await objective(svc.id, { endpointKey: 'core_quiet' });
    expect(quiet).toMatchObject({ status: 'noData', noDataReason: 'noValue' });
  });

  it('say why there is no data: no source, uptime figures not read, stale figures, endpoint gone', async () => {
    const svc = await newService();
    const o = await objective(svc.id);
    const reason = async () => (await dana('GET', `/objectives/${o.id}`)).noDataReason;
    try {
      gatusData(gatusId, { uptimes: false }, {});
      expect(await reason()).toBe('uptimesOff');
      gatusData(gatusId, { at: Date.now() - 4 * HOUR }, {});
      expect(await reason()).toBe('stale');
      gatusData(gatusId, { enabled: false }, {});
      expect(await reason()).toBe('noSource');
      gatusData(gatusId, {}, {});
      db().run("UPDATE availability_objectives SET endpoint_key = 'core_removed' WHERE id = ?", o.id);
      expect(await reason()).toBe('noEndpoint');
    } finally {
      gatusData(gatusId, {}, {});
    }
  });

  it('validate: one target at least, percent with two decimals, an endpoint Gatus reports, an application of the service', async () => {
    const svc = await newService();
    expect(await status(objective(svc.id, { targets: { h1: null, h24: null, d7: null, d30: null } }))).toBe(400);
    expect(await status(objective(svc.id, { targets: { h1: 100.5, h24: null, d7: null, d30: null } }))).toBe(400);
    expect(await status(objective(svc.id, { targets: { h1: 99.999, h24: null, d7: null, d30: null } }))).toBe(400);
    expect(await code(objective(svc.id, { endpointKey: 'core_nope' }))).toBe('OBJECTIVE_ENDPOINT_UNKNOWN');
    expect(await code(objective(svc.id, { platformId: 'plt_nope' }))).toBe('OBJECTIVE_PLATFORM_UNKNOWN');
    expect(await code(objective(svc.id, { platformId: (await s.api('GET', '/platforms')).find((p: any) => p.kind !== 'gatus').id }))).toBe(
      'OBJECTIVE_PLATFORM_NOT_GATUS',
    );
    const app = await dana('POST', '/applications', { name: `Objective app ${++n}`, owners: [] });
    expect(await code(objective(svc.id, { applicationId: app.id }))).toBe('OBJECTIVE_APPLICATION_NOT_IN_SERVICE');
    await dana('PUT', `/services/${svc.id}/applications/${app.id}`, { role: 'primary' });
    expect((await objective(svc.id, { applicationId: app.id })).applicationName).toBe(app.name);
    expect((await dana('GET', `/objectives?applicationId=${app.id}`)).length).toBe(1);
  });

  it('permissions: service editors define them; the platform must be one the author may see; readers who may not see it get no platform details', async () => {
    const svc = await newService(['user:olivia']);
    // viewers and approvers may not; the service's owner (an operator) may
    expect(
      await status(vera('POST', '/objectives', { serviceId: svc.id, name: 'x', platformId: gatusId, endpointKey: 'core_portal', targets: { h24: 99 } })),
    ).toBe(403);
    expect(
      await status(adam('POST', '/objectives', { serviceId: svc.id, name: 'x', platformId: gatusId, endpointKey: 'core_portal', targets: { h24: 99 } })),
    ).toBe(403);
    const own = await olivia('POST', '/objectives', {
      serviceId: svc.id,
      name: 'Owned',
      platformId: gatusId,
      endpointKey: 'core_portal',
      targets: { h24: 99 },
    });
    expect(own.canEdit).toBe(true);
    // a platform dana may not see is "not found" for her – also on a change of the endpoint
    expect(await code(objective(svc.id, { platformId: secretGatus, endpointKey: 'core_vault' }))).toBe('OBJECTIVE_PLATFORM_UNKNOWN');
    const secret = await s.api('POST', '/objectives', {
      serviceId: svc.id,
      name: 'Vault availability',
      platformId: secretGatus,
      endpointKey: 'core_vault',
      targets: { h24: 99.9 },
    });
    expect(secret).toMatchObject({ platformVisible: true, platformName: 'Secret Gatus', status: 'met' });
    // dana reads it with its status and values, without the platform or the endpoint
    const seen = await dana('GET', `/objectives/${secret.id}`);
    expect(seen).toMatchObject({ platformVisible: false, platformId: null, platformName: null, endpointKey: null, endpointName: null, status: 'met' });
    expect(seen.windows).toEqual([{ window: 'h24', target: 99.9, value: 100, status: 'met' }]);
    expect(JSON.stringify(seen)).not.toContain('core_vault');
    expect(JSON.stringify(await vera('GET', `/objectives?serviceId=${svc.id}`))).not.toContain('Secret Gatus');
    // she may change the targets (the endpoint stays), but not move it to an endpoint she cannot see
    const changed = await dana('PUT', `/objectives/${secret.id}`, {
      name: 'Vault availability',
      platformId: secretGatus,
      endpointKey: 'core_vault',
      targets: { h24: 99.95, d30: 99.9 },
    });
    expect(changed.targets).toMatchObject({ h24: 99.95, d30: 99.9 });
    // the web form sends no platform when the editor may not see it: the endpoint stays
    const kept = await dana('PUT', `/objectives/${secret.id}`, { name: 'Vault availability', targets: { h24: 99.9 }, notify: true });
    expect(kept).toMatchObject({ notify: true, targets: { h24: 99.9, d30: null } });
    expect(db().get<any>('SELECT endpoint_key FROM availability_objectives WHERE id = ?', secret.id).endpoint_key).toBe('core_vault');
    expect(await code(dana('PUT', `/objectives/${own.id}`, { name: 'Owned', platformId: secretGatus, endpointKey: 'core_vault', targets: { h24: 99 } }))).toBe(
      'OBJECTIVE_PLATFORM_UNKNOWN',
    );
    // archive (never delete): editors only, audited
    expect(await status(vera('POST', `/objectives/${own.id}/archive`, { archived: true }))).toBe(403);
    expect(await olivia('POST', `/objectives/${own.id}/archive`, { archived: true })).toMatchObject({ archived: true, archivedBy: 'olivia' });
    expect(await status(dana('DELETE', `/objectives/${own.id}`))).toBe(404);
    expect((await dana('GET', `/objectives?serviceId=${svc.id}`)).map((o: any) => o.id)).not.toContain(own.id);
    expect((await dana('GET', `/objectives?serviceId=${svc.id}&archived=1`)).map((o: any) => o.id)).toContain(own.id);
    expect(await code(olivia('PUT', `/objectives/${own.id}`, { name: 'Owned', targets: { h24: 98 } }))).toBe('OBJECTIVE_ARCHIVED');
    const actions = await auditActions(secret.id);
    expect(actions).toEqual(expect.arrayContaining(['objective.created', 'objective.updated']));
    expect(await auditActions(own.id)).toContain('objective.archived');
  });
});

// ---------- sampling, history, breaches ----------

describe('sampling, history and breach messages', () => {
  it('samples once per hour, starts a breach below target and sends one message per breach', async () => {
    const svc = await newService(['user:olivia']);
    gatusData(gatusId, {}, { core_flaky: { h24: 99.5, d30: 99.9 } });
    const o = await objective(svc.id, { endpointKey: 'core_flaky', targets: { h1: null, h24: 99, d7: null, d30: null }, notify: true });
    const quietly = await objective(svc.id, { endpointKey: 'core_flaky', targets: { h1: null, h24: 99, d7: null, d30: null }, notify: false });
    const t0 = Math.floor(Date.now() / HOUR) * HOUR;
    const inbox = () => db().all<any>("SELECT * FROM notifications WHERE event = 'objective.breached' AND link = ?", `/services/${svc.id}`);
    const samples = () => db().all<any>('SELECT * FROM objective_samples WHERE objective_id = ? ORDER BY bucket', o.id);
    jobs.sampleObjectives(t0 + 60000);
    jobs.sampleObjectives(t0 + 120000); // the same hour: nothing new
    expect(samples().map((x) => [x.bucket, x.status, x.value_h24])).toEqual([[iso(t0), 'met', 9950]]);
    // below target: a breach, one message to the owner
    gatusData(gatusId, { at: t0 + HOUR }, { core_flaky: { h24: 98.4 } });
    jobs.sampleObjectives(t0 + HOUR + 60000);
    gatusData(gatusId, { at: t0 + 2 * HOUR }, {});
    jobs.sampleObjectives(t0 + 2 * HOUR + 60000); // still below: no second message
    expect(inbox().map((x) => x.user_id)).toEqual([(await s.api('GET', '/users')).find((u: any) => u.username === 'olivia').id]);
    expect(inbox()[0].title).toContain('Objective below target');
    expect(inbox()[0].body).toContain('24 h 98.4 % (target 99 %)');
    const detail = await dana('GET', `/objectives/${o.id}`);
    expect(detail.breach).toMatchObject({ endedAt: null, windows: ['h24'], notified: true });
    expect(detail.samples.map((x: any) => x.status)).toEqual(['below', 'below', 'met']);
    expect(detail.samples[0].values).toMatchObject({ h24: 98.4 });
    // "no data" neither ends nor starts a breach
    gatusData(gatusId, { uptimes: false }, {});
    jobs.sampleObjectives(t0 + 3 * HOUR + 60000);
    gatusData(gatusId, { at: t0 + 4 * HOUR }, { core_flaky: { h24: 99.2 } });
    jobs.sampleObjectives(t0 + 4 * HOUR + 60000);
    const recovered = await dana('GET', `/objectives/${o.id}`);
    expect(recovered.breach).toBeNull();
    expect(recovered.breaches).toHaveLength(1);
    expect(recovered.breaches[0].endedAt).toBe(iso(t0 + 4 * HOUR + 60000));
    // a new breach within a day: recorded, but no second message (the cooldown, see below)
    gatusData(gatusId, { at: t0 + 5 * HOUR }, { core_flaky: { h24: 90 } });
    jobs.sampleObjectives(t0 + 5 * HOUR + 60000);
    expect(inbox()).toHaveLength(1);
    expect((await dana('GET', `/objectives/${o.id}`)).breaches.map((b: any) => b.notified)).toEqual([false, true]);
    // the objective without "notify" had its breaches too, but no message
    const q = await dana('GET', `/objectives/${quietly.id}`);
    expect(q.breaches.map((b: any) => b.notified)).toEqual([false, false]);
    const audit = await auditActions(o.id);
    expect(audit.filter((a: string) => a === 'objective.breached')).toHaveLength(2);
    expect(audit).toContain('objective.recovered');
    // retention: samples after 90 days
    db().run(
      "INSERT INTO objective_samples (objective_id, bucket, status, sampled_at) VALUES (?, '2020-01-01T00:00:00.000Z', 'met', '2020-01-01T00:00:00.000Z')",
      o.id,
    );
    expect(jobs.pruneScorecardData(Date.now()).samples).toBeGreaterThanOrEqual(1);
    expect(samples().some((x) => x.bucket.startsWith('2020'))).toBe(false);
    gatusData(gatusId, {}, { core_flaky: { h24: 99.5 } });
  });
});

describe('no clean scorecard by archiving, no flood of messages, no silent "no data"', () => {
  it('a breach message at most once a day per objective, while every breach is recorded (flapping)', async () => {
    const svc = await newService(['user:olivia']);
    gatusData(gatusId, {}, { core_flap: { h24: 99.5 } });
    const o = await objective(svc.id, { endpointKey: 'core_flap', targets: { h1: null, h24: 99, d7: null, d30: null }, notify: true });
    const t0 = Math.floor(Date.now() / HOUR) * HOUR + 10 * HOUR;
    const at = (h: number, v: number) => {
      gatusData(gatusId, { at: t0 + h * HOUR }, { core_flap: { h24: v } });
      jobs.sampleObjectives(t0 + h * HOUR + 60000);
    };
    const inbox = () => db().all<any>("SELECT * FROM notifications WHERE event = 'objective.breached' AND link = ?", `/services/${svc.id}`);
    at(0, 98); // breach 1: message
    at(1, 99.5);
    at(2, 98); // breach 2 within 24 h: recorded, no message
    at(3, 99.5);
    at(30, 98); // breach 3 a day later: message
    const breaches = (await dana('GET', `/objectives/${o.id}`)).breaches;
    expect(breaches.map((b: any) => b.notified)).toEqual([true, false, true]);
    expect(inbox()).toHaveLength(2);
    gatusData(gatusId, {}, { core_flap: { h24: 99.5 } });
  });

  it('an archived objective keeps its samples and breaches and counts with its last status until its longest window has passed', async () => {
    const svc = await newService();
    gatusData(gatusId, {}, { core_down: { h24: 90 } });
    const o = await objective(svc.id, { endpointKey: 'core_down', targets: { h1: null, h24: 99, d7: 99, d30: null } });
    jobs.sampleObjectives(Date.now());
    expect((await card(vera, svc.id)).availability).toMatchObject({ status: 'attention', below: 1 });
    await dana('POST', `/objectives/${o.id}/archive`, { archived: true });
    gatusData(gatusId, {}, { core_down: { h24: 100 } });
    // still counted, with the status of its last sample (not the new figures) – and not sampled any more
    const c = await card(vera, svc.id);
    expect(c.availability).toMatchObject({ status: 'attention', below: 1 });
    expect(c.availability.objectives[0]).toMatchObject({ id: o.id, status: 'below', archivedAt: expect.any(String) });
    const before = db().get<any>('SELECT COUNT(*) AS n FROM objective_samples WHERE objective_id = ?', o.id).n;
    jobs.sampleObjectives(Date.now() + 2 * HOUR);
    expect(db().get<any>('SELECT COUNT(*) AS n FROM objective_samples WHERE objective_id = ?', o.id).n).toBe(before);
    expect((await dana('GET', `/objectives/${o.id}`)).breaches).toHaveLength(1);
    // after its longest window (7 days) it no longer counts
    const later = sc.computeScorecards([svc.id], null, Date.now() + 8 * DAY)[0]!.card;
    expect(later.availability).toMatchObject({ status: 'none', total: 0 });
    gatusData(gatusId, {}, { core_down: { h24: 100 } });
  });

  it('a duty archived during its current period counts until that period ends, with its last status', async () => {
    const svc = await newService();
    const d = await duty(svc.id, 'mandatory');
    closedPeriod(d.id, svc.id, '2026-01', 'missed');
    expect((await card(vera, svc.id)).duties).toMatchObject({ status: 'attention', archivedThisPeriod: 0 });
    await s.api('POST', `/duties/${d.id}/archive`, { archived: true });
    const c = await card(vera, svc.id);
    expect(c.duties).toMatchObject({ status: 'attention', archivedThisPeriod: 1, mandatory: { notMet: 1 } });
    expect(c.duties.items[0]).toMatchObject({ dutyId: d.id, archivedAt: expect.any(String), result: 'notMet' });
    // the next month: gone
    const next = sc.computeScorecards([svc.id], null, Date.now() + 32 * DAY)[0]!.card;
    expect(next.duties).toMatchObject({ status: 'none', archivedThisPeriod: 0 });
  });

  it('"no data" for more than a day needs attention, with the reason; shorter is open', async () => {
    const svc = await newService();
    const o = await objective(svc.id, { endpointKey: 'core_quiet' });
    let c = await card(vera, svc.id);
    expect(c.availability).toMatchObject({ status: 'pending', noData: 1, noDataTooLong: 0 });
    expect(c.availability.objectives[0]).toMatchObject({ noDataReason: 'noValue', noDataTooLong: false, source: null });
    expect((await dana('GET', `/scorecard/services/${svc.id}`)).availability.objectives[0].source).toBe('Gatus (demo) · core/quiet');
    const defined = iso(Date.now() - 2 * DAY);
    db().run('UPDATE availability_objectives SET created_at = ? WHERE id = ?', defined, o.id);
    c = await card(vera, svc.id);
    expect(c.availability).toMatchObject({ status: 'attention', noDataTooLong: 1 });
    expect(c.attention).toBe(true);
    const detail = await dana('GET', `/objectives/${o.id}`);
    expect(detail).toMatchObject({ noDataTooLong: true, noDataReason: 'noValue', noDataSince: defined });
    // a sample with data within the last day: open again
    db().run(
      "INSERT INTO objective_samples (objective_id, bucket, value_h24, status, sampled_at) VALUES (?, ?, 9990, 'met', ?)",
      o.id,
      iso(Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR),
      iso(Date.now()),
    );
    expect((await card(vera, svc.id)).availability).toMatchObject({ status: 'pending', noDataTooLong: 0 });
  });

  it('a migration package with out-of-range scorecard rows is refused in the dry run', async () => {
    const { scorecardRowProblems, scorecardTableChecker } = await import('../src/scorecard/import-checks.js');
    expect(
      scorecardRowProblems('availability_objectives', { target_h1: null, target_h24: 9950, target_d7: null, target_d30: null, notify: 1, archived_at: null }),
    ).toEqual([]);
    expect(scorecardRowProblems('availability_objectives', { target_h1: 20000, target_h24: -1, target_d7: 99.5, target_d30: null, notify: 2 })).toHaveLength(4);
    expect(scorecardRowProblems('objective_samples', { bucket: '2026-01-01T00:00:00.000Z', status: 'great', value_h24: 10001 })).toEqual([
      'status "great" is unknown',
      'value_h24 is not 0–10000 hundredths of a percent',
    ]);
    expect(
      scorecardRowProblems('scorecard_snapshots', {
        day: '2026/01/01',
        duties: 'ok',
        availability: 'ok',
        documentation: 'x',
        protection: 'ok',
        attention: 0,
        document_ids: '[]',
        owners: '[1]',
      }),
    ).toEqual(['day "2026/01/01" is not YYYY-MM-DD', 'documentation "x" is not a status', 'owners is not a list of subjects']);
    expect(scorecardRowProblems('scorecard_rules', { dimension: 'beauty', min_level: 'High!', enabled: 1 })).toHaveLength(2);
    const check = scorecardTableChecker('objective_samples', 2);
    for (let i = 0; i < 4; i++) check.add({ bucket: 'x', status: 'met' });
    expect(check.result()).toEqual([
      'objective_samples, row 1: bucket is not a timestamp',
      'objective_samples, row 2: bucket is not a timestamp',
      'objective_samples: 2 more rows with problems',
    ]);
  });
});

// ---------- the scorecard ----------

async function app(serviceId: string, rating?: Partial<Record<'confidentiality' | 'integrity' | 'availability', string>>) {
  const a = await dana('POST', '/applications', { name: `Scorecard app ${++n}`, owners: [] });
  await dana('PUT', `/services/${serviceId}/applications/${a.id}`, { role: 'primary' });
  if (rating)
    await dana(
      'PUT',
      `/applications/${a.id}/rating`,
      Object.fromEntries(Object.entries(rating).map(([d, level]) => [d, { level, justification: 'Assessment 2026' }])),
    );
  return a;
}
const fullRating = { confidentiality: 'high', integrity: 'normal', availability: 'normal' } as const;
async function releasedDoc(title: string, o: { serviceId?: string; type?: string; applicationIds?: string[] } = {}) {
  const doc = await dana('POST', '/records', {
    type: o.type ?? 'DOC',
    title,
    ...(o.serviceId ? { links: [{ kind: 'service', id: o.serviceId, note: '' }] } : {}),
  });
  if (o.applicationIds) await dana('PUT', `/records/${doc.id}/applications`, { applicationIds: o.applicationIds });
  await dana('POST', `/records/${doc.id}/transition`, { action: 'submit', changeSummary: 'First edition' });
  await adam('POST', `/records/${doc.id}/transition`, { action: 'approve' });
  return doc;
}
const card = async (c: Client, serviceId: string) => c('GET', `/scorecard/services/${serviceId}`);

let dutyNo = 0;
async function duty(serviceId: string, level: string) {
  return s.api('POST', '/duties', { serviceId, name: `Scorecard duty ${++dutyNo}`, processId, interval: 'monthly', level });
}
function closedPeriod(dutyId: string, serviceId: string, key: string, status: string) {
  db().run(
    `INSERT INTO duty_periods (duty_id, period_key, period_start, period_end, grace_end, status, failed_runs, service_id, duty_name, process_id, process_name, level,
       interval_kind, grace_days, time_zone, evaluated_at, closed_at)
     VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, ?, ?, 0, ?, 'x', ?, 'x', 'mandatory', 'monthly', 0, 'Europe/Berlin', ?, ?)`,
    dutyId,
    key,
    `${key}-28T00:00:00.000Z`,
    `${key}-28T00:00:00.000Z`,
    status,
    serviceId,
    processId,
    `${key}-28T00:00:00.000Z`,
    `${key}-28T00:00:00.000Z`,
  );
}
function openPeriod(dutyId: string, serviceId: string, key: string, status: string) {
  db().run(
    `INSERT INTO duty_periods (duty_id, period_key, period_start, period_end, grace_end, status, failed_runs, service_id, duty_name, process_id, process_name, level,
       interval_kind, grace_days, time_zone, evaluated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'x', ?, 'x', 'mandatory', 'monthly', 0, 'Europe/Berlin', ?, NULL)`,
    dutyId,
    key,
    iso(Date.now() - DAY),
    iso(Date.now() + DAY),
    iso(Date.now() + DAY),
    status,
    serviceId,
    processId,
    iso(Date.now()),
  );
}
const currentKey = () => {
  const d = new Date(Date.now());
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(d);
  return `${p.find((x) => x.type === 'year')!.value}-${p.find((x) => x.type === 'month')!.value}`;
};

describe('the scorecard parts', () => {
  it('duties: mandatory met in the last closed period and now; recommended separately; optional shown only – from the stored periods', async () => {
    const svc = await newService();
    expect((await card(vera, svc.id)).duties).toMatchObject({ status: 'none', mandatory: { total: 0 } });
    const a = await duty(svc.id, 'mandatory');
    const b = await duty(svc.id, 'mandatory');
    const r = await duty(svc.id, 'recommended');
    await duty(svc.id, 'optional');
    // a: last period done, this one done → met; b: nothing stored → open (pending)
    closedPeriod(a.id, svc.id, '2026-01', 'done');
    openPeriod(a.id, svc.id, currentKey(), 'done');
    let c = await card(vera, svc.id);
    expect(c.duties.items.map((i: any) => [i.name, i.result])).toEqual([
      [a.name, 'met'],
      [b.name, 'open'],
      [r.name, 'open'],
      [expect.any(String), 'open'],
    ]);
    expect(c.duties).toMatchObject({ status: 'pending', mandatory: { total: 2, met: 1, open: 1, notMet: 0 }, optional: { total: 1 } });
    expect(c.duties.items[0]).toMatchObject({ lastClosed: { key: '2026-01', status: 'done' }, current: { key: currentKey(), status: 'done' } });
    // a recommended duty missed: shown, never attention
    closedPeriod(r.id, svc.id, '2026-01', 'missed');
    c = await card(vera, svc.id);
    expect(c.duties.recommended).toMatchObject({ notMet: 1, status: 'pending' });
    expect(c.duties.status).toBe('pending');
    // a mandatory duty whose last closed period was missed: attention, also when the current period is done
    closedPeriod(b.id, svc.id, '2026-01', 'missed');
    openPeriod(b.id, svc.id, currentKey(), 'done');
    c = await card(vera, svc.id);
    expect(c.duties).toMatchObject({ status: 'attention', mandatory: { notMet: 1 } });
    expect(c.attention).toBe(true);
    // skipped counts as met
    closedPeriod(b.id, svc.id, '2026-02', 'skipped');
    expect((await card(vera, svc.id)).duties.mandatory).toMatchObject({ met: 2, notMet: 0 });
  });

  it('availability: attention below target, pending without data, ok when every objective is met', async () => {
    const svc = await newService();
    expect((await card(vera, svc.id)).availability.status).toBe('none');
    await objective(svc.id);
    expect((await card(vera, svc.id)).availability).toMatchObject({ status: 'ok', total: 1, met: 1 });
    const quiet = await objective(svc.id, { endpointKey: 'core_quiet' });
    expect((await card(vera, svc.id)).availability).toMatchObject({ status: 'pending', noData: 1 });
    await objective(svc.id, { endpointKey: 'core_api' });
    const c = await card(vera, svc.id);
    expect(c.availability).toMatchObject({ status: 'attention', below: 1 });
    expect(c.availability.objectives.find((o: any) => o.id === quiet.id).status).toBe('noData');
    expect(c.attention).toBe(true);
  });

  it('protection need: rated or not – no applications, unrated members, members to re-rate', async () => {
    const svc = await newService();
    let c = await card(vera, svc.id);
    expect(c.protection).toMatchObject({ status: 'attention', applications: 0 });
    const a = await app(svc.id, fullRating);
    c = await card(vera, svc.id);
    expect(c.protection.status).toBe('ok');
    expect(c.protection.dimensions.map((d: any) => [d.dimension, d.effective, d.ok])).toEqual([
      ['confidentiality', 'high', true],
      ['integrity', 'normal', true],
      ['availability', 'normal', true],
    ]);
    // a second application without a rating: the maximum is not reliable
    const b = await app(svc.id);
    c = await card(vera, svc.id);
    expect(c.protection.status).toBe('attention');
    expect(c.protection.dimensions[0]).toMatchObject({ rated: 1, total: 2, ok: false });
    await dana('PUT', `/applications/${b.id}/rating`, Object.fromEntries(Object.entries(fullRating).map(([d, level]) => [d, { level, justification: 'x' }])));
    expect((await card(vera, svc.id)).protection.status).toBe('ok');
    // a rating flagged for re-rating does not count
    db().run("UPDATE application_ratings SET needs_rerating = 1 WHERE application_id = ? AND dimension = 'integrity'", a.id);
    c = await card(vera, svc.id);
    expect(c.protection.dimensions[1]).toMatchObject({ dimension: 'integrity', needsRerating: 1, ok: false });
    expect(c.protection.status).toBe('attention');
    db().run('UPDATE application_ratings SET needs_rerating = 0 WHERE application_id = ?', a.id);
  });

  it('documentation: released documents, reviews current, and documents expected by a rule on the CIA rating', async () => {
    const svc = await newService();
    const a = await app(svc.id, fullRating);
    let c = await card(vera, svc.id);
    expect(c.documentation).toMatchObject({ status: 'attention', documents: 0, released: 0 });
    // a draft does not count as present
    await dana('POST', '/records', { type: 'DOC', title: 'Draft manual', links: [{ kind: 'service', id: svc.id, note: '' }] });
    expect((await card(vera, svc.id)).documentation).toMatchObject({ status: 'attention', documents: 1, released: 0 });
    const manual = await releasedDoc('Operations manual', { serviceId: svc.id });
    c = await card(vera, svc.id);
    expect(c.documentation).toMatchObject({ status: 'ok', documents: 2, released: 1, overdue: 0 });
    // an overdue review
    db().run('UPDATE record_documents SET next_review_override = ? WHERE record_id = ?', iso(Date.now() - DAY), manual.id);
    expect((await card(vera, svc.id)).documentation).toMatchObject({ status: 'attention', overdue: 1 });
    db().run('UPDATE record_documents SET next_review_override = NULL WHERE record_id = ?', manual.id);

    // rules: administrators only; an authorization concept for confidentiality ≥ high
    await s.api('POST', '/record-types', { key: 'AUTHZ', name: 'Authorization concept', workflow: 'document' });
    const rule = { typeKey: 'AUTHZ', dimension: 'confidentiality', minLevel: 'high', note: 'BSI ORP.4' };
    expect(await status(dana('POST', '/scorecard/rules', rule))).toBe(403);
    expect(await code(s.api('POST', '/scorecard/rules', { ...rule, typeKey: 'CR' }))).toBe('SCORECARD_RULE_NOT_DOCUMENT');
    expect(await code(s.api('POST', '/scorecard/rules', { ...rule, minLevel: 'extreme' }))).toBe('CIA_LEVEL_UNKNOWN');
    const rules = await s.api('POST', '/scorecard/rules', rule);
    expect(rules).toEqual([
      expect.objectContaining({
        typeKey: 'AUTHZ',
        typeName: 'Authorization concept',
        dimension: 'confidentiality',
        minLevel: 'high',
        enabled: true,
        valid: true,
      }),
    ]);
    expect(await vera('GET', '/scorecard/rules')).toHaveLength(1);
    expect(await code(s.api('POST', '/scorecard/rules', rule))).toBe('SCORECARD_RULE_EXISTS');
    c = await card(vera, svc.id);
    expect(c.documentation).toMatchObject({ status: 'attention', missing: 1 });
    expect(c.documentation.expected).toEqual([
      expect.objectContaining({ typeKey: 'AUTHZ', applicationId: a.id, level: 'high', minLevel: 'high', satisfiedBy: [] }),
    ]);
    // an application rated "normal" in confidentiality expects nothing
    const low = await app(svc.id, { confidentiality: 'normal', integrity: 'normal', availability: 'normal' });
    expect((await card(vera, svc.id)).documentation.expected.map((e: any) => e.applicationId)).toEqual([a.id]);
    // a released authorization concept that applies to the application satisfies it; one for another application does not
    await releasedDoc('Authorization concept (other)', { type: 'AUTHZ', applicationIds: [low.id] });
    expect((await card(vera, svc.id)).documentation.missing).toBe(1);
    const authz = await releasedDoc('Authorization concept', { type: 'AUTHZ', applicationIds: [a.id] });
    c = await card(vera, svc.id);
    expect(c.documentation).toMatchObject({ status: 'ok', missing: 0 });
    expect(c.documentation.expected[0].satisfiedBy).toEqual([expect.objectContaining({ id: authz.id })]);
    // a rule turned off is not applied
    await s.api('PUT', `/scorecard/rules/${rules[0].id}`, { ...rule, minLevel: 'normal', enabled: false });
    expect((await card(vera, svc.id)).documentation.expected).toEqual([]);
    expect(await status(dana('DELETE', `/scorecard/rules/${rules[0].id}`))).toBe(403);
    expect(await s.api('DELETE', `/scorecard/rules/${rules[0].id}`)).toEqual([]);
    const audit = await auditActions(rules[0].id);
    expect(audit).toEqual(expect.arrayContaining(['scorecard.rule_created', 'scorecard.rule_updated', 'scorecard.rule_deleted']));
  });

  it('only what the reader may see counts and shows: documents they may not read are neither listed nor counted', async () => {
    const svc = await newService();
    const doc = await releasedDoc('Secret manual', { serviceId: svc.id });
    expect((await card(dana, svc.id)).documentation).toMatchObject({ released: 1, status: 'ok' });
    hidden.set('vera', new Set([doc.id]));
    try {
      const c = await card(vera, svc.id);
      expect(c.documentation).toMatchObject({ documents: 0, released: 0, status: 'attention' });
      expect(JSON.stringify(c)).not.toContain('Secret manual');
    } finally {
      hidden.delete('vera');
    }
  });
});

describe('overview, rollup, snapshots and trend', () => {
  it('rolls up overall and per owner; attention when any part needs attention', async () => {
    const svc = await newService(['user:olivia', 'team:operations']);
    const o = await vera('GET', '/scorecard');
    const mine = o.services.find((c: any) => c.serviceId === svc.id);
    expect(mine).toBeTruthy();
    expect(o.rollup.overall.services).toBe(o.services.length);
    expect(o.rollup.overall.attention).toBe(o.services.filter((c: any) => c.attention).length);
    const olivias = o.rollup.owners.find((g: any) => g.owner === 'user:olivia');
    const team = o.rollup.owners.find((g: any) => g.owner === 'team:operations');
    expect(olivias.services).toBeGreaterThanOrEqual(1);
    expect(team.services).toBe(1);
    expect(o.rollup.owners.find((g: any) => g.key === 'none').services).toBe(o.services.filter((c: any) => !c.owners.length).length);
    for (const part of ['duties', 'availability', 'documentation', 'protection'])
      expect(Object.values(o.rollup.overall.parts[part]).reduce((a: number, b: any) => a + b, 0)).toBe(o.services.length);
  });

  it('stores one snapshot per service and day; a stored day never changes; the trend reads the snapshots', async () => {
    const svc = await newService(['user:olivia']);
    const day1 = Date.parse('2026-03-10T10:00:00Z');
    expect(jobs.snapshotScorecards(day1)).toBeGreaterThan(0);
    expect(jobs.snapshotScorecards(day1 + 60000)).toBeNull(); // the same hour
    const row1 = () => db().get<any>("SELECT * FROM scorecard_snapshots WHERE day = '2026-03-10' AND service_id = ?", svc.id);
    expect(row1()).toMatchObject({ protection: 'attention', attention: 1 });
    // the service gets rated: the next day shows it, the stored day stays as it was
    await app(svc.id, fullRating);
    jobs.snapshotScorecards(day1 + DAY);
    expect(row1()).toMatchObject({ protection: 'attention' });
    expect(db().get<any>("SELECT * FROM scorecard_snapshots WHERE day = '2026-03-11' AND service_id = ?", svc.id)).toMatchObject({ protection: 'ok' });
  });

  it('the trend and the service history over HTTP: per owner, and hidden documentation for readers who may not read a counted document', async () => {
    const svc = await newService(['team:night-shift']);
    const doc = await releasedDoc('Night manual', { serviceId: svc.id });
    jobs.snapshotScorecards(Date.now(), true);
    const today = sc.dayOf(Date.now());
    const trend = await vera('GET', '/scorecard/trend?days=30&owner=team:night-shift');
    expect(trend.map((p: any) => [p.day, p.services])).toContainEqual([today, 1]);
    const point = trend.find((p: any) => p.day === today);
    expect(point.parts.documentation.ok).toBe(1);
    expect((await vera('GET', `/scorecard/services/${svc.id}`)).history.at(-1)).toMatchObject({ day: today, parts: { documentation: 'ok' } });
    hidden.set('vera', new Set([doc.id]));
    try {
      const h = (await vera('GET', `/scorecard/services/${svc.id}`)).history.at(-1);
      expect(h.parts.documentation).toBe('hidden');
      expect((await vera('GET', '/scorecard/trend?days=30&owner=team:night-shift')).find((p: any) => p.day === today).parts.documentation.hidden).toBe(1);
    } finally {
      hidden.delete('vera');
    }
    expect(await status(vera('GET', '/scorecard/trend?days=9999'))).toBe(400);
  });

  it('the start page tile: every service for editors and auditors, the own ones for others, none for those without', async () => {
    const att = async (c: Client) => (await c('GET', '/dashboard')).attention.scorecard;
    jobs.snapshotScorecards(Date.now(), true);
    const all = await att(audrey);
    expect(all.services).toBe((await vera('GET', '/scorecard')).services.length);
    expect(await att(adam)).toBeUndefined();
    const svc = await newService(['user:adam']);
    // read from the stored snapshot, not computed on every load: the new service shows with the next snapshot
    expect(await att(adam)).toEqual({ services: 0, attention: 0 });
    jobs.snapshotScorecards(Date.now(), true);
    expect(await att(adam)).toEqual({ services: 1, attention: 1 });
    expect((await dana('GET', '/dashboard')).attention.scorecard.services).toBe(all.services + 1);
    // the reader's documentation adjustment of the history view: a part that relied on a document the reader may not
    // read does not count for them
    await s.api('POST', `/services/${svc.id}/archive`, { archived: true });
    const rated = await newService(['user:adam']);
    await app(rated.id, { confidentiality: 'normal', integrity: 'normal', availability: 'normal' });
    const doc = await releasedDoc('Tile manual', { serviceId: rated.id });
    db().run('UPDATE record_documents SET next_review_override = ? WHERE record_id = ?', iso(Date.now() - DAY), doc.id);
    jobs.snapshotScorecards(Date.now(), true);
    expect(await att(adam)).toEqual({ services: 1, attention: 1 });
    hidden.set('adam', new Set([doc.id]));
    try {
      expect(await att(adam)).toEqual({ services: 1, attention: 0 });
    } finally {
      hidden.delete('adam');
    }
  });
});

describe('report section and public API', () => {
  it('the "scorecard" report section: services with their parts, the trend, objectives with breaches; a stored day for an ended period', async () => {
    const svc = await newService();
    await objective(svc.id, { name: 'Report objective' });
    const { reportSection } = await import('../src/reports/sections.js');
    await import('../src/reports/schedules.js');
    const { runAs } = await import('../src/auth/context.js');
    const { getUser, toAuthUser } = await import('../src/auth/users.js');
    const users = await s.api('GET', '/users');
    const sec = reportSection('scorecard')!;
    const cfg = sec.schema.parse({ serviceIds: [svc.id] });
    const audreyUser = toAuthUser(getUser(users.find((u: any) => u.username === 'audrey').id));
    const live = runAs(audreyUser, () => sec.build(cfg, { from: Date.now() - DAY, to: Date.now() + DAY, now: Date.now(), lang: 'en' })) as any;
    expect(live.asOf).toBeNull();
    expect(live.services).toEqual([expect.objectContaining({ service: svc.name, attention: true })]);
    expect(live.objectives).toEqual([expect.objectContaining({ objective: 'Report objective', targets: { h24: 99, d30: 99.5 } })]);
    // an ended period with a stored snapshot on its last day: the stored day
    jobs.snapshotScorecards(Date.parse('2026-02-27T10:00:00Z'), true);
    const stored = runAs(
      audreyUser,
      () => sec.build(cfg, { from: Date.parse('2026-02-01T00:00:00Z'), to: Date.parse('2026-02-27T23:00:00Z'), now: Date.now(), lang: 'en' }), // midnight in Berlin
    ) as any;
    expect(stored.asOf).toBe('2026-02-27');
    expect(stored.services.map((x: any) => x.service)).toEqual([svc.name]);
    expect(stored.trend).toEqual([{ day: '2026-02-27', services: 1, attention: 1 }]);
    // the PDF of a schedule with the section
    const schedule = (sections: unknown) => ({
      name: 'Scorecard report',
      preset: 'custom',
      cron: '0 6 * * 1',
      timezone: 'Europe/Berlin',
      periodDays: 7,
      lang: 'en',
      title: 'Scorecard report',
      sections,
      recipients: { users: [], teams: [], emails: [] },
    });
    const sched = await dana('POST', '/report-schedules', schedule({ scorecard: { serviceIds: [svc.id] } }));
    const schedules = await import('../src/reports/schedules.js');
    const rec = await schedules.runReportSchedule(sched.id, { actor: 'dana', compress: false });
    const text = rec.texts.join('\n');
    for (const fact of ['Service scorecard', svc.name, 'Protection need', 'Availability objectives', 'Report objective']) expect(text).toContain(fact);
    expect(await status(dana('POST', '/report-schedules', schedule({ scorecard: { serviceIds: ['svc_nope'] } })))).toBe(400);
  });

  it('the public API: scorecard, trend, service scorecard, objectives and samples; platform details only for those who may see the platform', async () => {
    const svc = await newService();
    const o = await s.api('POST', '/objectives', {
      serviceId: svc.id,
      name: 'API vault',
      platformId: secretGatus,
      endpointKey: 'core_vault',
      targets: { h24: 99 },
    });
    jobs.sampleObjectives(Date.now());
    const token = (await vera('POST', '/me/tokens', { name: 'scorecard', scope: 'read' })).token;
    const v1 = async (url: string) => {
      const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    };
    const sc1 = await v1('/scorecard');
    expect(sc1.status).toBe(200);
    expect(sc1.body.services.some((c: any) => c.serviceId === svc.id)).toBe(true);
    expect((await v1('/scorecard/trend?days=7')).status).toBe(200);
    const one = await v1(`/services/${svc.id}/scorecard`);
    expect(one.body).toMatchObject({ serviceId: svc.id, availability: { total: 1, met: 1 } });
    expect((await v1('/services/svc_nope/scorecard')).status).toBe(404);
    const list = await v1(`/objectives?serviceId=${svc.id}`);
    expect(list.body.items).toEqual([expect.objectContaining({ id: o.id, platformVisible: false, platformId: null, endpointKey: null, status: 'met' })]);
    const samples = await v1(`/objectives/${o.id}/samples?limit=5`);
    expect(samples.body.items[0]).toMatchObject({ status: 'met', values: { h24: 100 } });
    expect((await v1('/objectives/obj_nope/samples')).status).toBe(404);
  });
});

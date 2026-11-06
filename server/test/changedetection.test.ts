import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * changedetection.io (#242) against the demo: the preset and its connection test, the watches as components of the
 * platform (metadata only, tags carried over, links to applications, services and vendors, backlinks), the read-only
 * rules of the kind (no writes, no page contents, no state-changing parameters, credentials stripped from a watch),
 * the monitor check "Page watch", the background read, and the example webhook trigger with its process.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const W = (n: number) => `7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e0${n}`;
const TERMS = W(1);
const PRICING = W(2);
const STATUS = W(4);
const PAUSED = W(5);

let s: TestServer;
let cd: string;
let olivia: Client, vera: Client;
const logged: string[] = [];

const code = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number; body?: { code?: string } }) => e.body?.code ?? e.status,
  );
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup');
  cd = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'changedetection').id;
  [olivia, vera] = await Promise.all(['olivia', 'vera'].map((u) => s.as(u, PW)));
  const { logger } = await import('../src/log.js');
  for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
    const orig = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (orig as (...a: unknown[]) => void)(...args);
    }) as never);
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await s?.app.close();
});

describe('changedetection.io platform', () => {
  it('has a preset with the API key in x-api-key and tests the connection', async () => {
    const presets = await s.api('GET', '/platform-presets');
    const preset = presets.find((p: any) => p.kind === 'changedetection');
    expect(preset.config).toMatchObject({ auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, testPath: '/api/v1/systeminfo' });
    expect(preset.secretFields.map((f: any) => f.key)).toEqual(['apiKey']);
    expect(await s.api('POST', `/platforms/${cd}/test`, {})).toMatchObject({ ok: true, status: 200 });
    // the API description of the read endpoints only
    const ops = await s.api('GET', `/platforms/${cd}/operations`);
    expect(ops.map((o: any) => `${o.method.toUpperCase()} ${o.path}`).sort()).toEqual(
      [
        'GET /api/v1/search',
        'GET /api/v1/systeminfo',
        'GET /api/v1/tags',
        'GET /api/v1/watch',
        'GET /api/v1/watch/{uuid}',
        'GET /api/v1/watch/{uuid}/history',
      ].sort(),
    );
  });

  it('lists the watches the demo read as components: metadata, tags, states, diff links and links', async () => {
    const list = await s.api('GET', `/changedetection/${cd}/watches`);
    expect(list).toMatchObject({ platform: { id: cd }, total: 6, error: null, canRead: true, canLink: true, readBy: 'admin' });
    expect(list.uiUrl).toMatch(/\/mock\/changedetection$/);
    expect(list.tags).toEqual(['docs', 'pricing', 'release-notes', 'status-page', 'vendor-terms']);
    const by = Object.fromEntries(list.watches.map((w: any) => [w.uuid, w]));
    expect(by[TERMS]).toMatchObject({
      title: 'Zentrova Cloud – Terms of service',
      url: 'https://zentrova.example.com/legal/terms',
      tags: ['vendor-terms'],
      state: 'ok',
      lastError: null,
      diffUrl: `${list.uiUrl}/diff/${TERMS}`,
      application: { label: 'Webshop (demo)', visible: true },
      service: null,
      vendor: 'Zentrova Cloud',
    });
    expect(Date.now() - Date.parse(by[TERMS].lastChangedAt)).toBeLessThan(4 * 3_600_000);
    expect(by[W(3)].tags).toEqual(['docs', 'release-notes']);
    expect(by[STATUS]).toMatchObject({ state: 'failing', lastError: expect.stringMatching(/HTTP 503/), vendor: 'Paylumen', application: null });
    expect(by[PAUSED]).toMatchObject({ state: 'paused', paused: true });
    // a watch with only its first snapshot has not changed
    expect(by[W(6)].lastChangedAt).toBeNull();
    // nothing of a page's content or a watch's settings is stored
    const { db } = await import('../src/db.js');
    const cols = Object.keys(db().get<Record<string, unknown>>('SELECT * FROM cd_watches LIMIT 1')!);
    expect(cols.sort()).toEqual(
      [
        'application_id',
        'last_changed_at',
        'last_checked_at',
        'last_error',
        'linked_at',
        'linked_by',
        'paused',
        'platform_id',
        'removed_at',
        'seen_at',
        'service_id',
        'tags',
        'title',
        'url',
        'uuid',
        'vendor',
      ].sort(),
    );
  });

  it('uses the variable uiUrl for the diff links when changedetection.io is reached by another address', async () => {
    const p = await s.api('GET', `/platforms/${cd}`);
    await s.api('PUT', `/platforms/${cd}`, { config: { ...p.config, variables: { ...p.config.variables, uiUrl: 'https://changes.example.com/' } } });
    try {
      const list = await s.api('GET', `/changedetection/${cd}/watches`);
      expect(list.uiUrl).toBe('https://changes.example.com');
      expect(list.watches.find((w: any) => w.uuid === TERMS).diffUrl).toBe(`https://changes.example.com/diff/${TERMS}`);
    } finally {
      await s.api('PUT', `/platforms/${cd}`, { config: p.config });
    }
  });

  it('reads again: new errors, vanished watches deleted unless linked, the failure of a read kept on the platform', async () => {
    const mock = await import('../src/mock/mockChangedetection.js');
    mock.resetChangedetection();
    try {
      mock.setDemoWatch(W(3), { error: 'Element not found: #release-list' });
      mock.removeDemoWatch(W(6)); // linked to CRM (demo)
      mock.removeDemoWatch(PAUSED); // not linked
      const r = await s.api('POST', `/changedetection/${cd}/watches/read`);
      expect(r).toMatchObject({ ok: true, total: 4, kept: 4, failing: 2 });
      const by = Object.fromEntries((await s.api('GET', `/changedetection/${cd}/watches`)).watches.map((w: any) => [w.uuid, w]));
      expect(by[W(3)]).toMatchObject({ state: 'failing', lastError: 'Element not found: #release-list' });
      expect(by[W(6)]).toMatchObject({ state: 'removed', application: { label: 'CRM (demo)' } });
      expect(by[PAUSED]).toBeUndefined();
      // unlinking a removed watch forgets it
      await s.api('PUT', `/changedetection/${cd}/watches/${W(6)}/link`, { applicationId: null, vendor: '' });
      expect((await s.api('GET', `/changedetection/${cd}/watches`)).watches.some((w: any) => w.uuid === W(6))).toBe(false);
      // a wrong API key: the read fails, the reason is shown with the list, the key is never in it
      const secretsBefore = { apiKey: 'demo-changedetection-api-key' };
      await s.api('PUT', `/platforms/${cd}/secrets`, { apiKey: 'wrong-key-1234567890' });
      const bad = await s.api('POST', `/changedetection/${cd}/watches/read`);
      expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/HTTP 403.*API key/) });
      const list = await s.api('GET', `/changedetection/${cd}/watches`);
      expect(list.error).toMatch(/HTTP 403/);
      expect(list.watches.length).toBe(4);
      expect(JSON.stringify(list)).not.toContain('wrong-key-1234567890');
      await s.api('PUT', `/platforms/${cd}/secrets`, secretsBefore);
    } finally {
      mock.resetChangedetection();
      await s.api('POST', `/changedetection/${cd}/watches/read`);
    }
    expect((await s.api('GET', `/changedetection/${cd}/watches`)).error).toBeNull();
  });

  it('reads the snapshot times of a watch, not the snapshots', async () => {
    const h = await s.api('GET', `/changedetection/${cd}/watches/${TERMS}/history`);
    expect(h).toMatchObject({ uuid: TERMS, count: 3, diffUrl: expect.stringContaining(`/diff/${TERMS}`) });
    expect(h.diffUrl.endsWith(`/diff/${TERMS}`)).toBe(true);
    expect(h.snapshots).toHaveLength(3);
    expect(Date.parse(h.snapshots[0])).toBeGreaterThan(Date.parse(h.snapshots[1]));
    expect(JSON.stringify(h)).not.toContain('/datastore/');
    expect(await code(s.api('GET', `/changedetection/${cd}/watches/7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5eff/history`))).toBe('PAGE_WATCH_NOT_FOUND');
    expect(await code(s.api('GET', `/changedetection/${cd}/watches/not-a-uuid/history`))).toBe('PAGE_WATCH_NOT_FOUND');
  });

  it('links watches to applications, services and vendors: managers only, visible targets only, audited, shown as backlinks', async () => {
    const svc = await s.api('POST', '/services', { name: 'Vendor billing', owners: [] });
    const w = await s.api('PUT', `/changedetection/${cd}/watches/${PRICING}/link`, { serviceId: svc.id, vendor: 'Zentrova Cloud' });
    expect(w).toMatchObject({
      service: { id: svc.id, label: 'Vendor billing', visible: true },
      application: { label: 'Webshop (demo)' },
      vendor: 'Zentrova Cloud',
    });
    const audit = await s.api('GET', `/audit?entityType=platform&entityId=${cd}`);
    expect(audit.find((e: any) => e.action === 'changedetection.watch_linked' && e.details?.uuid === PRICING).summary).toMatch(
      /Page watch "Zentrova Cloud – Pricing" of "changedetection.io \(demo\)" linked to application "Webshop \(demo\)", service "Vendor billing", vendor "Zentrova Cloud"/,
    );
    // the service and the application show the watch among their backlinks
    const detail = await s.api('GET', `/services/${svc.id}`);
    expect(detail.backlinks).toContainEqual(
      expect.objectContaining({
        kind: 'page-watch',
        id: PRICING,
        label: 'Zentrova Cloud – Pricing',
        note: 'Zentrova Cloud',
        path: `/platforms/${cd}?tab=watches&watch=${PRICING}`,
      }),
    );
    const apps = await s.api('GET', '/applications');
    const shop = apps.find((a: any) => a.name === 'Webshop (demo)');
    expect((await s.api('GET', `/applications/${shop.id}`)).backlinks.filter((b: any) => b.kind === 'page-watch').map((b: any) => b.id)).toEqual(
      expect.arrayContaining([TERMS, PRICING]),
    );
    // a viewer sees the application but not the platform: no page watch among its backlinks
    expect((await vera('GET', `/applications/${shop.id}`)).backlinks.some((b: any) => b.kind === 'page-watch')).toBe(false);
    // an operator may read the watches but not link them; a viewer does not see the platform at all
    expect(await status(olivia('GET', `/changedetection/${cd}/watches`))).toBe(200);
    expect(await status(olivia('PUT', `/changedetection/${cd}/watches/${PRICING}/link`, { vendor: 'x' }))).toBe(403);
    expect(await status(vera('GET', `/changedetection/${cd}/watches`))).toBe(404);
    // a hidden or missing application reads alike; unknown fields are refused; another platform kind is not one
    expect(await code(s.api('PUT', `/changedetection/${cd}/watches/${PRICING}/link`, { applicationId: 'app_missing' }))).toBe('APPLICATION_NOT_FOUND');
    expect(await status(s.api('PUT', `/changedetection/${cd}/watches/${PRICING}/link`, { platformId: 'x' }))).toBe(400);
    const dt = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'dependency-track').id;
    expect(await code(s.api('GET', `/changedetection/${dt}/watches`))).toBe('CHANGEDETECTION_PLATFORM_REQUIRED');
    // removing the links
    const off = await s.api('PUT', `/changedetection/${cd}/watches/${PRICING}/link`, { serviceId: null });
    expect(off.service).toBeNull();
    expect((await s.api('GET', `/services/${svc.id}`)).backlinks.some((b: any) => b.kind === 'page-watch')).toBe(false);
  });

  it('is read-only and never reads page contents: writes, snapshots, diffs, state-changing parameters and pages are refused', async () => {
    const req = (method: string, p: string) => s.api('POST', `/platforms/${cd}/request`, { method, path: p });
    expect((await req('GET', '/api/v1/watch')).status).toBe(200);
    expect((await req('GET', `/api/v1/watch/${TERMS}/history`)).status).toBe(200);
    for (const [method, p] of [
      ['GET', `/api/v1/watch/${TERMS}/history/1762333200`],
      ['GET', `/api/v1/watch/${TERMS}/difference/1761901200/1762333200`],
      ['GET', '/api/v1/changes'],
      ['GET', '/api/v1/notifications'],
      ['GET', `/api/v1/watch/${TERMS}?recheck=1`],
      ['GET', `/api/v1/watch/${TERMS}?paused=paused`],
      ['GET', '/api/v1/watch?recheck_all=1'],
      ['GET', `/diff/${TERMS}`],
      ['GET', `/preview/${TERMS}`],
      ['GET', '/api/v1/watch/../../preview'],
      ['GET', `/api/v1/watch/${TERMS}%2Fhistory%2F1762333200`],
    ] as const)
      expect(await code(req(method, p)), `${method} ${p}`).toBe('PLATFORM_PATH_DENIED');
    // writes: refused for the read-only kinds by one rule (Kafka Connect alike), whatever the path
    for (const [method, p] of [
      ['DELETE', `/api/v1/watch/${TERMS}`],
      ['POST', '/api/v1/watch'],
      ['PUT', `/api/v1/watch/${TERMS}`],
      ['PATCH', `/api/v1/watch/${TERMS}`],
      ['DELETE', `/api/v1/watch/${TERMS}/history`],
    ] as const)
      expect(await code(req(method, p)), `${method} ${p}`).toBe('PLATFORM_METHOD_DENIED');
    // a watch's settings: the notification URL (a Steward secret) and the request headers of the watched site are removed
    const one = await req('GET', `/api/v1/watch/${TERMS}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ title: 'Zentrova Cloud – Terms of service', history_n: 3 });
    expect(one.body).not.toHaveProperty('notification_urls');
    expect(one.body).not.toHaveProperty('headers');
    expect(JSON.stringify(one)).not.toMatch(/demo-not-a-real-secret|demo-watched-site-token/);
  });

  it('never logs or returns the API key', async () => {
    await s.api('POST', `/changedetection/${cd}/watches/read`);
    await s.api('GET', `/changedetection/${cd}/watches/${TERMS}/history`);
    const p = await s.api('GET', `/platforms/${cd}`);
    expect(JSON.stringify(p)).not.toContain('demo-changedetection-api-key');
    expect(JSON.stringify(await s.api('GET', `/changedetection/${cd}/watches`))).not.toContain('demo-changedetection-api-key');
    expect(logged.join('\n')).not.toContain('demo-changedetection-api-key');
  });

  it('reads again in the background every hour, as the person who read it last', async () => {
    const { runChangedetectionJob } = await import('../src/changedetection/service.js');
    expect(await runChangedetectionJob(Date.now())).toBe(0);
    expect(await runChangedetectionJob(Date.now() + 2 * 3_600_000)).toBe(1);
  });
});

describe('the monitor check "Page watch"', () => {
  it('judges changed, failing, unchecked and paused watches', async () => {
    const mock = await import('../src/mock/mockChangedetection.js');
    mock.resetChangedetection();
    const eng = await import('../src/monitors/engine.js');
    const check = (id: string, extra: Record<string, unknown>) => ({ id, name: id, type: 'page-watch', platform: 'changedetection.io (demo)', ...extra });
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Vendor pages',
        failuresBeforeDown: 1,
        checks: [
          check('terms', { tag: 'Vendor-Terms', changedAs: 'degraded' }),
          check('terms-info', { tag: 'vendor-terms' }),
          check('pricing-48h', { watch: PRICING, changedWithinHours: 48 }),
          check('status', { watch: STATUS, failingAs: 'down' }),
          check('all', { maxCheckAgeHours: 48 }),
          check('docs-paused', { tag: 'docs', pausedAs: 'degraded' }),
          check('docs', { tag: 'docs' }),
          check('missing', { watch: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5eff' }),
          check('no-tag', { tag: 'nothing-here' }),
        ],
      },
    });
    await eng.evaluateMonitorNow(monitor.id);
    const st = await s.api('GET', `/monitors/${monitor.id}`);
    const by = Object.fromEntries(st.checks.map((c: any) => [c.checkId, { status: c.status, message: c.last?.message ?? '', value: c.last?.value }]));
    expect(by.terms).toMatchObject({
      status: 'degraded',
      message: expect.stringMatching(/tag "Vendor-Terms" – 1 changed in the last 24 h: Zentrova Cloud – Terms of service \(3\.0 h ago\)/),
    });
    expect(by['terms-info']).toMatchObject({ status: 'up', message: expect.stringMatching(/2 without errors; 1 changed in the last 24 h/) });
    expect(by['pricing-48h']).toMatchObject({ status: 'up', message: expect.stringMatching(/"Zentrova Cloud – Pricing" – no change in the last 48 h/) });
    expect(by.status).toMatchObject({ status: 'down', message: expect.stringMatching(/1 failing: Paylumen – Status page \(Received HTTP 503/) });
    expect(by.all.status).toBe('degraded');
    expect(by.all.value).toMatchObject({ watches: 6, failing: 1, paused: 1 });
    expect(by['docs-paused']).toMatchObject({ status: 'degraded', message: expect.stringMatching(/1 paused \(they notice no change\): Corvana Maps/) });
    expect(by.docs).toMatchObject({ status: 'up', message: expect.stringMatching(/1 paused/) });
    expect(by.missing).toMatchObject({ status: 'unknown', message: expect.stringMatching(/no watch 7d3c1a90/) });
    expect(by['no-tag']).toMatchObject({ status: 'unknown', message: expect.stringMatching(/no watch with the tag "nothing-here"/) });
    // a watch that stopped checking (the list is shared for a minute: read a minute later)
    mock.setDemoWatch(W(6), { checkedHoursAgo: 72 });
    const checks = await import('../src/monitors/checks.js');
    const stale = await checks.runActiveCheck(
      {
        ...check('stale', { tag: 'vendor-terms', maxCheckAgeHours: 48, changedWithinHours: 24, changedAs: 'up', failingAs: 'degraded', pausedAs: 'ignore' }),
        platform: cd,
      } as never,
      { owner: 'admin', signal: new AbortController().signal, timeoutMs: 10_000, now: () => Date.now() + 61_000 },
    );
    expect(stale).toMatchObject({
      status: 'degraded',
      message: expect.stringMatching(/1 not checked for more than 48 h: Mailbrook – Data processing agreement \(last 3 days ago\)/),
    });
    mock.resetChangedetection();
  });

  it('validates the check: a UUID for the watch; another platform kind cannot run it', async () => {
    const bad = await code(
      s.api('POST', '/monitors', {
        definition: { name: 'Bad', checks: [{ id: 'x', name: 'x', type: 'page-watch', platform: 'changedetection.io (demo)', watch: 'not-a-uuid' }] },
      }),
    );
    expect(bad).not.toBe(200);
    // another platform kind: the check cannot run
    const checks = await import('../src/monitors/checks.js');
    const dt = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'dependency-track').id;
    const r = await checks.runActiveCheck(
      { id: 'x', name: 'x', type: 'page-watch', platform: dt, changedWithinHours: 24, changedAs: 'up', failingAs: 'degraded', pausedAs: 'ignore' } as never,
      { owner: 'admin', signal: new AbortController().signal, timeoutMs: 10_000, now: () => Date.now() },
    );
    expect(r).toMatchObject({ status: 'unknown', message: expect.stringMatching(/is not a changedetection.io platform/) });
  });
});

describe('the example webhook trigger', () => {
  const hook = async (id: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${s.base}/api/hooks/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('is listed with its process and passes the validator', async () => {
    const ex = await s.api('GET', '/triggers/examples');
    const e = ex.find((x: any) => x.id === '10-changedetection-review');
    expect(e).toMatchObject({
      process: '76-changedetection-review-change',
      processName: 'changedetection.io – Review a changed page (from a notification)',
      authMode: 'token',
      inputMapping: { watchUuid: 'body.watch_uuid', diffUrl: 'body.diff_url' },
      sender: { name: 'changedetection.io', url: '{post}://{hostPath}?+X-Steward-Token={secret}' },
    });
    const { validateFile } = await import('../src/cli/validate.js');
    const root = path.resolve(import.meta.dirname, '../../examples');
    expect(await validateFile(path.join(root, 'triggers/10-changedetection-review.yaml'))).toMatchObject({ ok: true, kind: 'webhook trigger', count: 5 });
    expect(await validateFile(path.join(root, 'processes/76-changedetection-review-change.yaml'))).toMatchObject({ ok: true, kind: 'process' });
    expect(await validateFile(path.join(root, 'monitors/64-vendor-page-watches.yaml'))).toMatchObject({ ok: true, kind: 'monitor', count: 2 });
  });

  it('a notification starts the review with the diff link; untrusted payloads are checked and limited', async () => {
    const ex = (await s.api('GET', '/triggers/examples')).find((x: any) => x.id === '10-changedetection-review');
    const created = await s.api('POST', '/triggers', {
      name: 'changedetection.io notification',
      processId: 'changedetection-review-change',
      bindings: { changedetection: cd },
      inputMapping: ex.inputMapping,
      authMode: ex.authMode,
      dedupeSeconds: ex.dedupeSeconds,
      skipIfRunning: ex.skipIfRunning,
    });
    const id = created.trigger.id;
    const token = { 'x-steward-token': created.secret };
    const ui = (await s.api('GET', `/changedetection/${cd}/watches`)).uiUrl;
    // the payload's diff link is used when it is this changedetection.io's diff page of the watch
    const okLink = `${ui}/diff/${TERMS}?from_version=1&to_version=2`;
    const r = await hook(id, { ...ex.samplePayload, diff_url: okLink }, token);
    expect(r.status).toBe(202);
    const run = await s.waitRun(r.body.runId);
    expect(run.status).toBe('waiting');
    const task = run.tasks.find((t: any) => t.status === 'open');
    expect(task.title).toBe('Zentrova Cloud – Terms of service changed');
    expect(task.instructions).toContain(okLink);
    expect(task.instructions).toContain('https://zentrova.example.com/legal/terms');
    // a diff link elsewhere is replaced by the platform's own; the protocol never holds the watch's credentials
    const evil = await hook(id, { ...ex.samplePayload, watch_title: 'x', diff_url: 'https://evil.example.net/diff' }, token);
    const run2 = await s.waitRun(evil.body.runId);
    const task2 = run2.tasks.find((t: any) => t.status === 'open');
    expect(task2.instructions).toContain(`${ui}/diff/${TERMS}`);
    expect(task2.instructions).not.toContain('evil.example.net');
    expect(JSON.stringify(run2)).not.toMatch(/demo-not-a-real-secret|demo-watched-site-token/);
    // a watch this changedetection.io does not have: the run fails without a task
    const unknown = await hook(id, { ...ex.samplePayload, watch_uuid: '7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5eff' }, token);
    const run3 = await s.waitRun(unknown.body.runId);
    expect(run3.status).toBe('failed');
    expect(run3.tasks.filter((t: any) => t.status === 'open')).toHaveLength(0);
    const notUuid = await hook(id, { ...ex.samplePayload, watch_uuid: '../../api/v1/notifications' }, token);
    expect((await s.waitRun(notUuid.body.runId)).status).toBe('failed');
    // the hook's own limits: the secret, JSON only, 64 KB
    expect((await hook(id, ex.samplePayload)).status).toBe(401);
    expect((await hook(id, ex.samplePayload, { 'x-steward-token': 'whs_wrong' })).status).toBe(401);
    expect((await hook(id, 'not json', token)).status).toBe(400);
    expect((await hook(id, { ...ex.samplePayload, watch_title: 'x'.repeat(70_000) }, token)).status).toBe(413);
    // a repeat of the same notification within the de-duplication window is skipped
    expect((await hook(id, { ...ex.samplePayload, diff_url: okLink }, token)).body).toEqual({ skipped: 'duplicate' });
    for (const t of [...run.tasks, ...run2.tasks]) if (t.status === 'open') await s.api('POST', `/runs/${t.runId}/cancel`).catch(() => undefined);
    await s.api('DELETE', `/triggers/${id}`);
  });
});

describe('platform deletion', () => {
  it('removes the watches and their links with the platform', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'changedetection.io (to delete)',
      kind: 'changedetection',
      baseUrl: (await s.api('GET', `/platforms/${cd}`)).baseUrl,
      config: { auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' }, variables: {}, http: { proxy: 'none' } },
      secrets: { apiKey: 'demo-changedetection-api-key' },
    });
    await s.api('POST', `/changedetection/${p.id}/watches/read`);
    await s.api('PUT', `/changedetection/${p.id}/watches/${TERMS}/link`, { vendor: 'Zentrova Cloud' });
    const { db } = await import('../src/db.js');
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cd_watches WHERE platform_id = ?', p.id)!.n).toBe(6);
    await s.api('DELETE', `/platforms/${p.id}`);
    expect(Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cd_watches WHERE platform_id = ?', p.id)!.n)).toBe(0);
    expect(db().get('SELECT 1 FROM cd_reads WHERE platform_id = ?', p.id)).toBeUndefined();
  });
});

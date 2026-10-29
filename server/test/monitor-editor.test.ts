import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { definitionIssues, issueLabel, monitorDefinitionSchema } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The monitor editor's server side (#141): problems name the card instead of `checks.1`, with one issue per missing
 * field and the paths for the editor; a single card can be tried before saving, with the rights of the monitor.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const fail = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { status: number; body?: { code?: string; error?: string; issues?: { path: string; message: string }[] } }) => ({ status: e.status, ...e.body }),
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
});
afterAll(async () => {
  await s?.app.close();
});

describe('monitor editor: problems and trying a card', () => {
  it('names the card and the field of a problem; one issue per missing freshness field', () => {
    const def = monitorDefinitionSchema.parse({
      name: 'M',
      checks: [
        { id: 'tcp', name: 'Reachable', type: 'tcp', host: 'h', port: 1 },
        { id: 'fresh', name: 'Power Meter – Insights Hub', type: 'freshness', platform: 'p', assetId: 'a', expectedIntervalSeconds: 60 },
      ],
    });
    const issues = definitionIssues(def);
    expect(issues.map((i) => i.path)).toEqual(['checks.1.aspect', 'checks.1.variables']);
    expect(issueLabel(def, issues[1]!.path)).toBe('Check "Power Meter – Insights Hub" (fresh) – variables');
    expect(issueLabel(def, 'checks.0')).toBe('Check "Reachable" (tcp)');
    expect(issueLabel({ checks: [{ id: 'x', name: '' }] }, 'checks.0.name')).toBe('Check #1 (x) – name');
    expect(issueLabel(def, 'name')).toBe('name');
  });

  it('a save names the card in the message and keeps the paths for the editor', async () => {
    const r = await fail(
      s.api('POST', '/monitors', {
        definition: {
          name: 'Editor test',
          checks: [
            { id: 'a', name: 'First', type: 'tcp', host: 'h', port: 1 },
            { id: 'a', name: 'Second', type: 'tcp', host: 'h', port: 2 },
          ],
        },
      }),
    );
    expect(r).toMatchObject({ status: 400, code: 'MONITOR_INVALID' });
    expect(r!.error).toContain('Check "Second" (a) – id: duplicate check id "a"');
    expect(r!.error).not.toContain('checks.1');
    expect(r!.issues).toEqual([{ path: 'checks.1.id', message: 'duplicate check id "a"' }]);
    // schema problems too
    const bad = await fail(
      s.api('POST', '/monitors', { definition: { name: 'Editor test', checks: [{ id: 'p', name: 'Port', type: 'tcp', host: 'h', port: 0 }] } }),
    );
    expect(bad!.error).toContain('Check "Port" (p) – port');
    expect(bad!.issues?.[0]?.path).toBe('checks.0.port');
  });

  it('tries one card before saving, stores nothing, audits it', async () => {
    // nothing listens on port 9 of the loopback address
    const r = await s.api('POST', '/monitors/check-preview', { check: { id: 'tcp', name: 'Closed port', type: 'tcp', host: '127.0.0.1', port: 9 } });
    expect(r.status).toBe('down');
    expect(r.message).toContain('127.0.0.1:9');
    const audit = await s.api('GET', '/audit?action=monitor.check_previewed&limit=1');
    expect(audit[0].summary).toContain('"Closed port" (tcp) tried in the editor: down');
    expect((await s.api('GET', '/monitors')).some((m: any) => m.name === 'Closed port')).toBe(false);

    // a check that makes no call, and an invalid card
    expect(
      await fail(s.api('POST', '/monitors/check-preview', { check: { id: 'hb', name: 'HB', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 60 } })),
    ).toMatchObject({
      status: 409,
      code: 'CHECK_PREVIEW_UNSUPPORTED',
    });
    const invalid = await fail(s.api('POST', '/monitors/check-preview', { check: { id: 'x', name: 'Bad', type: 'tcp', host: '', port: 1 } }));
    expect(invalid).toMatchObject({ status: 400, code: 'MONITOR_INVALID' });
    expect(invalid!.issues?.[0]?.path).toBe('checks.0.host');
  });

  it('needs the right to create monitors, or to edit the given one', async () => {
    const vera = await s.as('vera', 'Demo-password-1');
    const check = { id: 'tcp', name: 'Closed port', type: 'tcp', host: '127.0.0.1', port: 9 };
    expect(await fail(vera('POST', '/monitors/check-preview', { check }))).toMatchObject({ status: 403 });
    const { monitor } = await s.api('POST', '/monitors', { definition: { name: 'Owned by admin', checks: [check] } });
    expect(await fail(vera('POST', '/monitors/check-preview', { monitorId: monitor.id, check }))).toMatchObject({ status: 403 });
    expect((await s.api('POST', '/monitors/check-preview', { monitorId: monitor.id, check })).status).toBe('down');
  });
});

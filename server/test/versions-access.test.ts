import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Version watch and the tech stack parts of the scorecard with the reader's rights (#241, #104, security review of
 * 0.9.0): a system the reader may not see is neither named nor counted – in the monitor check "Version behind", the
 * scorecard parts "Up to date" and "Tech stack" –, and the version watch settings (mirror addresses, platforms) are for
 * administrators.
 *
 * Setup: the system "Secret DB host" belongs to team "Secret team", so olivia (operator) and vera (viewer) may not see
 * it; it runs "Visible app" (owner olivia) of "Mixed service" (owner olivia).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
let s: TestServer;
let olivia: Client;
let vera: Client;
let visible: string;
let service: string;
let system: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  const dana = await s.as('dana', PW);
  const { db } = await import('../src/db.js');
  const team = (await s.api('POST', '/teams', { name: 'Secret team' })).id;
  visible = (await s.api('POST', '/applications', { name: 'Visible app', owners: ['user:olivia'] })).id;
  service = (await s.api('POST', '/services', { name: 'Mixed service', owners: ['user:olivia'] })).id;
  await s.api('PUT', `/services/${service}/applications/${visible}`, {});
  system = (await dana('POST', '/systems', { name: 'Secret DB host', kind: 'vm', owners: [], stack: [{ product: 'ubuntu', version: '20.04' }] })).id;
  db().run("INSERT INTO resource_teams (kind, resource_id, team_id, created_at) VALUES ('system', ?, ?, ?)", system, team, new Date().toISOString());
  await s.api('POST', `/applications/${visible}/systems`, { systemId: system, environment: 'prod' });
  await dana('POST', '/catalogue/lifecycle/refresh');
  const before = await s.api('GET', '/catalogue/versions');
  await s.api('PUT', '/catalogue/versions', { ...before.settings, scorecard: true });
  const lc = await s.api('GET', '/catalogue/lifecycle');
  await s.api('PUT', '/catalogue/lifecycle', { ...lc.settings, scorecard: true });
}, 240_000);

describe('hidden systems', () => {
  it('are hidden from olivia and vera', async () => {
    await expect(olivia('GET', `/systems/${system}`)).rejects.toMatchObject({ status: 404 });
    await expect(vera('GET', `/systems/${system}`)).rejects.toMatchObject({ status: 404 });
    expect(JSON.stringify(await olivia('GET', `/applications/${visible}`))).not.toContain('Secret DB host');
  });

  it('are neither named nor counted by the check "Version behind" of an owner who may not see them', async () => {
    const { versionBehindCheck } = await import('../src/versions/check.js');
    const c = { id: 'v', name: 'V', type: 'version-behind', application: 'Visible app', majorAs: 'down', eolAs: 'down', maxMinors: 2 } as never;
    // as the monitor engine calls it: no request
    const r = versionBehindCheck(c, { owner: 'olivia', now: () => Date.now() });
    expect(JSON.stringify(r)).not.toContain('Secret DB host');
    expect(JSON.stringify(r)).not.toMatch(/ubuntu/i);
    expect(r.status).toBe('unknown');
    // the administrator's check names it
    const a = versionBehindCheck(c, { owner: 'admin', now: () => Date.now() });
    expect(a.message).toContain('Secret DB host (prod)');
    expect(a.message).toMatch(/^1 of 1 stack entries/);
  });

  it('are neither named nor counted by the scorecard parts "Up to date" and "Tech stack"', async () => {
    for (const c of [olivia, vera]) {
      const card = await c('GET', `/scorecard/services/${service}`);
      expect(JSON.stringify(card)).not.toContain('Secret DB host');
      expect(card.upToDate).toMatchObject({ enabled: true, entries: 0, items: [] });
      expect(card.lifecycle).toMatchObject({ enabled: true, entries: 0, items: [] });
    }
    const card = await s.api('GET', `/scorecard/services/${service}`);
    expect(card.upToDate.entries).toBe(1);
    expect(card.upToDate.items[0]).toMatchObject({ componentName: 'Secret DB host', holder: 'system' });
    expect(card.lifecycle.entries).toBe(1);
    expect(card.lifecycle.items[0]).toMatchObject({ componentName: 'Secret DB host', holder: 'system' });
  });
});

describe('the version watch settings', () => {
  it('are for administrators: others get what they need to read the status', async () => {
    const admin = await s.api('GET', '/catalogue/versions');
    expect(admin.settings).toHaveProperty('registries');
    expect(admin.settings).toHaveProperty('ociPlatformIds');
    expect(admin.settings).toHaveProperty('gitPlatformId');
    for (const c of [olivia, vera]) {
      const st = await c('GET', '/catalogue/versions');
      expect(st.canEdit).toBe(false);
      expect(st.settings).not.toHaveProperty('registries');
      expect(st.settings).not.toHaveProperty('ociPlatformIds');
      expect(st.settings).not.toHaveProperty('gitPlatformId');
      expect(st.settings).toMatchObject({ order: admin.settings.order, scorecard: true, notify: admin.settings.notify });
    }
  });
});

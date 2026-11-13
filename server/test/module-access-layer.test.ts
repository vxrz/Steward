import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModuleId } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The module layer of access (0.21.0, ADR 0034 part 7, #295) where access is explained and evidenced: _Why do I have
 * access?_, person access reviews, the test sign-in, the assurance report and evidence packs; the report schedule form's
 * preview of recipients who get a report without a module's sections; and a monitor's check of a module the viewer
 * does not use (its status, not what it found).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let vera: Client, dana: Client, olivia: Client;
let svcId: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [vera, dana, olivia] = await Promise.all(['vera', 'dana', 'olivia'].map((u) => s.as(u, PW)));
  // a service of the whole instance (no owning team): everyone sees it
  svcId = (await s.api('POST', '/services', { name: 'Invented module layer service' })).id;
  await s.api('PUT', `/owning-teams/service/${svcId}`, { teamIds: [] });
}, 180_000);
afterAll(async () => {
  await s?.app.close();
});

const restrict = (id: ModuleId, subjects: string[]) =>
  s.api('PUT', `/settings/modules/${id}/access`, { mode: 'selected', grants: subjects.map((subject) => ({ subject })) });
const open = (id: ModuleId) => s.api('PUT', `/settings/modules/${id}/access`, { mode: 'everyone', grants: [] });

describe('Why do I have access? names the module layer', () => {
  it('for an item of a module: through which team the person uses it, or that they do not (and so have no rights)', async () => {
    const contract = (await s.api('GET', '/data-contracts')) as { items?: { id: string }[] } | { id: string }[] as unknown;
    const list = (Array.isArray(contract) ? contract : ((contract as { items: { id: string }[] }).items ?? [])) as { id: string }[];
    expect(list.length).toBeGreaterThan(0);
    const id = list[0]!.id;
    const team = await s.api('POST', '/teams', { name: 'Invented data office', members: ['dana'] });
    await restrict('dataContracts', ['team:invented data office']);
    try {
      const forDana = await s.api('GET', `/access/explain?kind=contract&id=${id}&user=dana`);
      expect(forDana.module).toEqual({
        module: 'dataContracts',
        enabled: true,
        restricted: true,
        uses: true,
        through: [{ source: 'team', team: 'invented data office' }],
      });
      const forVera = await s.api('GET', `/access/explain?kind=contract&id=${id}&user=vera`);
      expect(forVera.module).toMatchObject({ module: 'dataContracts', restricted: true, uses: false, through: [] });
      expect(forVera.permissions).toEqual([]);
      const forAdmin = await s.api('GET', `/access/explain?kind=contract&id=${id}`);
      expect(forAdmin.module).toMatchObject({ uses: true, through: [{ source: 'admin' }] });
    } finally {
      await open('dataContracts');
      await s.api('DELETE', `/teams/${team.id}`);
    }
    // open to everyone: said so; a core item has no module layer
    expect((await s.api('GET', `/access/explain?kind=contract&id=${id}&user=vera`)).module).toMatchObject({
      restricted: false,
      uses: true,
      through: [{ source: 'everyone' }],
    });
    expect((await s.api('GET', `/access/explain?kind=service&id=${svcId}`)).module).toBeUndefined();
  });

  it('the access preview names the teams that own data contracts but would not use the module', async () => {
    const list = (await s.api('GET', '/data-contracts')) as unknown;
    const id = ((Array.isArray(list) ? list : (list as { items: { id: string }[] }).items) as { id: string }[])[0]!.id;
    const team = await s.api('POST', '/teams', { name: 'Invented contract owners', members: [] });
    await s.api('PUT', `/owning-teams/contract/${id}`, { teamIds: [team.id] });
    try {
      const p = await s.api('POST', '/settings/modules/dataContracts/access/preview', { mode: 'selected', grants: [] });
      expect(p.owningTeamsWithout).toContain('Invented contract owners');
      // status viewers reach the status pages only: they neither gain nor lose a module
      expect(p.loses.map((u: { username: string }) => u.username)).toContain('vera');
      expect(p.loses.map((u: { username: string }) => u.username)).not.toContain('stella');
      const with_ = await s.api('POST', '/settings/modules/dataContracts/access/preview', {
        mode: 'selected',
        grants: [{ subject: 'team:invented contract owners' }],
      });
      expect(with_.owningTeamsWithout).not.toContain('Invented contract owners');
    } finally {
      await s.api('PUT', `/owning-teams/contract/${id}`, { teamIds: [] });
      await s.api('DELETE', `/teams/${team.id}`);
    }
  });
});

describe('person access reviews', () => {
  it('show the restricted modules a Steward user uses, read now', async () => {
    const platforms = (await s.api('GET', '/platforms')) as { id: string; kind: string }[];
    const aws = platforms.find((p) => p.kind === 'aws')!.id;
    const check = (await s.api('POST', '/compliance/access-checks', { name: 'AWS IAM (modules)', platformId: aws, source: 'aws' })).id;
    const r = await s.api('POST', '/compliance/person-reviews', {
      title: 'Leaver: vera',
      personUser: 'vera',
      personName: 'Vera Viewer',
      identifiers: ['vera'],
      checkIds: [check],
    });
    expect(r.modules).toBeUndefined();
    await restrict('costs', ['user:vera']);
    await restrict('plant', []);
    try {
      const again = await s.api('GET', `/compliance/person-reviews/${r.id}`);
      expect(again.modules).toEqual([
        // the costs module declares the manager role (0.23.0): vera, a viewer, has none
        { module: 'costs', enabled: true, restricted: true, uses: true, through: [{ source: 'user' }], role: null, roleThrough: [] },
        expect.objectContaining({ module: 'plant', restricted: true, uses: false, through: [], role: null }),
      ]);
    } finally {
      await open('costs');
      await open('plant');
    }
  });

  it('the test sign-in reads the same layer for the roles and teams a mapping gives', async () => {
    const { restrictedModuleUses } = await import('../src/modules/access.js');
    const team = await s.api('POST', '/teams', { name: 'Invented plant engineering', members: [] });
    await restrict('plant', ['team:invented plant engineering']);
    try {
      expect(restrictedModuleUses({ id: '', username: 'new-person', roles: ['viewer'], teams: ['Invented plant engineering'] })).toEqual([
        {
          module: 'plant',
          enabled: expect.any(Boolean),
          restricted: true,
          uses: true,
          through: [{ source: 'team', team: 'invented plant engineering' }],
          // a viewer's core role gives the plant registry's viewer role (0.23.0)
          role: 'viewer',
          roleThrough: [{ source: 'coreRole', role: 'viewer', coreRole: 'viewer' }],
        },
      ]);
      expect(restrictedModuleUses({ id: '', username: 'new-person', roles: ['viewer'], teams: [] })[0]).toMatchObject({ uses: false });
    } finally {
      await open('plant');
      await s.api('DELETE', `/teams/${team.id}`);
    }
  });
});

describe('the report schedule form', () => {
  it('names the recipients who get the report without the sections of a module they do not use', async () => {
    const body = {
      sections: ['runs', 'scorecard'],
      recipients: { users: ['vera', 'dana'], teams: ['Invented report readers'], emails: ['someone@example.com'] },
    };
    const team = await s.api('POST', '/teams', { name: 'Invented report readers', members: [] });
    try {
      expect(await dana('POST', '/report-schedules/recipients-preview', body)).toEqual({ modules: [] });
      await restrict('scorecard', ['user:dana']);
      const p = await dana('POST', '/report-schedules/recipients-preview', body);
      expect(p).toEqual({
        modules: [{ module: 'scorecard', ownerUses: true, users: ['vera'], teams: ['Invented report readers'], emails: 1 }],
      });
      // the owner who does not use it: the sections are left out for everyone
      expect((await olivia('POST', '/report-schedules/recipients-preview', body)).modules[0]).toMatchObject({ ownerUses: false });
      // read-only accounts make no schedules
      await expect(vera('POST', '/report-schedules/recipients-preview', body)).rejects.toThrow(/403/);
      // a schedule of someone else: only its owner or an administrator asks
      const sch = await dana('POST', '/report-schedules', { name: 'Modules preview', preset: 'weekly', sections: { runs: true }, enabled: false });
      await expect(olivia('POST', '/report-schedules/recipients-preview', { ...body, id: sch.id })).rejects.toThrow(/404/);
      expect((await s.api('POST', '/report-schedules/recipients-preview', { ...body, id: sch.id })).modules[0]).toMatchObject({ ownerUses: true });
      await expect(dana('POST', '/report-schedules/recipients-preview', { ...body, sections: Array.from({ length: 101 }, (_, i) => `s${i}`) })).rejects.toThrow(
        /400/,
      );
    } finally {
      await open('scorecard');
      await s.api('DELETE', `/teams/${team.id}`);
    }
  });
});

describe('a monitor check of a module the viewer does not use', () => {
  it('shows its status, not what it found – in the detail, the results and the history', async () => {
    const m = await s.api('POST', '/monitors', {
      definition: {
        name: 'Invented costs watch (modules)',
        checks: [
          {
            id: 'cost',
            name: 'Costs not rising',
            type: 'cost',
            scope: 'service',
            target: svcId,
            period: 'month',
            maxIncreasePct: 20,
            failAs: 'degraded',
            noData: 'unknown',
          },
        ],
      },
    });
    const id = (m.monitor ?? m).id as string;
    // the monitor of the whole instance: everyone may view it
    await s.api('PUT', `/owning-teams/monitor/${id}`, { teamIds: [] });
    await s.api('POST', `/monitors/${id}/run`, {});
    const { db } = await import('../src/db.js');
    db().run(
      "UPDATE monitor_checks SET last_result = ? WHERE monitor_id = ? AND check_id = 'cost'",
      JSON.stringify({ ts: new Date().toISOString(), status: 'degraded', message: 'Service "Invented secret service" rose by 40 %', value: { changePct: 40 } }),
      id,
    );
    db().run(
      "INSERT INTO monitor_history (monitor_id, ts, check_id, status, previous, message, caused_by) VALUES (?, ?, 'cost', 'degraded', 'up', ?, '[]')",
      id,
      new Date().toISOString(),
      'Service "Invented secret service" rose by 40 %',
    );
    const read = async (c: Client) => {
      const d = await c('GET', `/monitors/${id}`);
      const check = (d.checks as { checkId: string; last: { message: string; value?: unknown } | null }[]).find((x) => x.checkId === 'cost')!;
      const history = (await c('GET', `/monitors/${id}/history`)) as
        { checkId: string | null; message: string }[] | { items: { checkId: string | null; message: string }[] };
      const items = Array.isArray(history) ? history : history.items;
      return { check, history: items.filter((h) => h.checkId === 'cost').map((h) => h.message) };
    };
    expect((await read(vera)).check.last?.message).toContain('Invented secret service');
    await restrict('costs', ['user:dana']);
    try {
      const v = await read(vera);
      expect(v.check.last).toMatchObject({ status: 'degraded', message: 'A check of a module you do not use' });
      expect(v.check.last).not.toHaveProperty('value');
      expect(v.history.length).toBeGreaterThan(0);
      expect(v.history.every((x) => x === 'A check of a module you do not use')).toBe(true);
      const results = (await vera('GET', `/monitors/${id}/checks/cost/results`)) as { message: string }[];
      expect(JSON.stringify(results)).not.toContain('Invented secret service');
      expect((await read(dana)).check.last?.message).toContain('Invented secret service');
    } finally {
      await open('costs');
    }
  });
});

describe('a monitor notification about a check of a module the recipient does not use', () => {
  it('names its status, not what it found', async () => {
    const m = await s.api('POST', '/monitors', {
      definition: {
        name: 'Invented costs alerts (modules)',
        checks: [{ id: 'cost', name: 'Costs not rising', type: 'cost', scope: 'service', target: svcId, period: 'month', maxIncreasePct: 20 }],
        outputs: [{ id: 'notify', type: 'notification', subscribers: ['user:vera', 'user:dana'], holdSeconds: 0, include: 'checks' }],
      },
    });
    const id = (m.monitor ?? m).id as string;
    await s.api('PUT', `/owning-teams/monitor/${id}`, { teamIds: [] });
    const { db } = await import('../src/db.js');
    const { loadMonitor } = await import('../src/monitors/model.js');
    const { dispatchOutputs } = await import('../src/monitors/outputs.js');
    const monitor = loadMonitor(db().get('SELECT * FROM monitors WHERE id = ?', id)!);
    const secret = 'Service "Invented secret service" rose by 40 %';
    await restrict('costs', ['user:dana']);
    try {
      await dispatchOutputs({
        monitor,
        subjects: [
          {
            dependent: false,
            event: {
              subject: 'cost',
              level: 'check',
              status: 'down',
              since: new Date().toISOString(),
              message: secret,
              causedBy: [],
              ts: new Date().toISOString(),
              monitor: { id, key: monitor.key, name: monitor.name, status: 'down' },
              check: { id: 'cost', key: 'cost', name: 'Costs not rising', type: 'cost' },
            },
          },
        ],
        maintenance: false,
        acknowledged: false,
        now: Date.now(),
      });
      const body = async (c: Client) =>
        ((await c('GET', '/notifications?limit=100')).items as { event: string; link: string; body: string }[]).find(
          (n) => n.event === 'monitor.status' && n.link.startsWith(`/monitors/${id}`),
        )?.body;
      expect(await body(dana)).toContain('Invented secret service');
      const forVera = await body(vera);
      expect(forVera).toBeDefined();
      expect(forVera).not.toContain('Invented secret service');
      expect(forVera).toContain('A check of a module you do not use');
      // the monitor's own event carries its root cause's message: the same for them
      await dispatchOutputs({
        monitor: { ...monitor, def: { ...monitor.def, outputs: [{ ...monitor.def.outputs[0]!, id: 'notify-monitor', include: 'monitor' }] } },
        subjects: [
          {
            dependent: false,
            event: {
              subject: '',
              level: 'monitor',
              status: 'down',
              since: new Date().toISOString(),
              message: secret,
              causedBy: [{ monitorId: id, monitorKey: monitor.key, monitorName: monitor.name, checkId: 'cost', checkName: 'Costs not rising' }],
              ts: new Date().toISOString(),
              monitor: { id, key: monitor.key, name: monitor.name, status: 'down' },
            },
          },
        ],
        maintenance: false,
        acknowledged: false,
        now: Date.now(),
      });
      const bodies = async (c: Client) =>
        ((await c('GET', '/notifications?limit=100')).items as { event: string; link: string; body: string }[])
          .filter((n) => n.event === 'monitor.status' && n.link === `/monitors/${id}`)
          .map((n) => n.body);
      expect((await bodies(dana)).join(' ')).toContain('Invented secret service');
      expect(await bodies(vera)).toHaveLength(1);
      expect((await bodies(vera)).join(' ')).not.toContain('Invented secret service');
    } finally {
      await open('costs');
    }
  });
});

describe('the assurance report and evidence packs', () => {
  it('hold who uses each restricted module and the changes of module access in the period', async () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    await restrict('libraries', ['user:dana']);
    await open('libraries');
    await restrict('ai', ['user:dana']);
    try {
      const to = new Date(Date.now() + 60_000).toISOString();
      const { collectAssuranceReport } = await import('../src/compliance/assurance-report.js');
      const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
      const admin = toAuthUser(findUserByName('admin')!);
      const { model } = collectAssuranceReport({ from, to, lang: 'en' }, admin);
      expect(model.moduleAccess?.current).toEqual([expect.objectContaining({ module: 'ai', subjects: ['user:dana'], updatedBy: 'admin' })]);
      const changes = model.moduleAccess!.changes.filter((c) => c.module === 'libraries' || c.module === 'ai');
      expect(changes.map((c) => [c.module, c.before, c.after, c.confirmed])).toEqual([
        ['libraries', 'everyone', 'selected', false],
        ['libraries', 'selected', 'everyone', true],
        ['ai', 'everyone', 'selected', false],
      ]);
      expect(changes[0]).toMatchObject({ granted: ['user:dana'], removed: [], actor: 'admin' });
      // the PDF draws it (German too)
      const { renderAssurancePdf } = await import('../src/compliance/assurance-report.js');
      expect((await renderAssurancePdf(model, { compress: false })).subarray(0, 5).toString()).toBe('%PDF-');
      const de = collectAssuranceReport({ from, to, lang: 'de' }, admin);
      expect((await renderAssurancePdf(de.model, { compress: false })).length).toBeGreaterThan(1000);

      const { moduleAccessEvidence } = await import('../src/modules/access-evidence.js');
      const ev = moduleAccessEvidence(from, to);
      expect(ev.current.map((c) => c.module)).toEqual(['ai']);
      expect(ev.rejected).toBe(0);
    } finally {
      await open('ai');
    }
  });
});

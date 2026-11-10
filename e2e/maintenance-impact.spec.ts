import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { appHref, authFile } from './support/env';
import { expectAccessible, settle } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * Impact before maintenance (0.14): a designer plans a window for an edge gateway (an asset of the plant registry) from
 * its page, sees before saving what it affects – the machine behind it, its data path and collection, the KPI job, the
 * monitor that goes Off rather than down – and on the window's page adds planned downtime for that monitor in one click.
 * On a phone the impact fits the screen. Invented names only; everything is made per test and removed again.
 */

const SETTINGS = { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} };

async function plantOn(api: APIRequestContext) {
  const res = await api.put('/api/settings/plant', { data: SETTINGS });
  expect(res.ok(), await res.text()).toBe(true);
}

const ok = async (p: Promise<Awaited<ReturnType<APIRequestContext['get']>>>) => {
  const r = await p;
  expect(r.ok(), await r.text()).toBe(true);
  return r;
};

/** An edge gateway, a machine behind it (its PC on the gateway's switch port), its data path, collection, KPI job and monitor. */
async function gatewayScene(admin: APIRequestContext) {
  const n = uniq('e2e')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const gw = `${n}-gw`;
  const mill = `${n}-mill`;
  await plantOn(admin);
  // a site of its own: nothing of the shared demo sites changes (other tests count their assets and live status)
  const site = `${n}-site`;
  await ok(admin.post('/api/plant/sites', { data: { id: site, name: `Works ${n}` } }));
  await ok(admin.post('/api/plant/assets', { data: { id: gw, siteId: site, name: `Edge gateway ${n}` } }));
  await ok(admin.post(`/api/plant/assets/${gw}/devices`, { data: { id: gw, hostname: gw, purpose: 'Edge gateway' } }));
  await ok(admin.post('/api/plant/assets', { data: { id: mill, siteId: site, name: `Milling centre ${n}` } }));
  await ok(admin.post(`/api/plant/assets/${mill}/devices`, { data: { id: `${mill}-pc`, hostname: `${mill}-pc`, switch: gw, switchPort: 'eth1' } }));
  await ok(
    admin.put(`/api/plant/assets/${mill}/assignment`, {
      data: {
        profileId: 'example-controls-c80',
        interfaces: [{ interface: 'opc-ua', active: true, endpoint: `opc.tcp://${mill}-pc:4840` }],
        kpis: [{ kpi: 'machine-state-time', job: `${mill}-state`, params: { offline_timeout_ms: 60000 }, dataset: `plant.${n}` }],
      },
    }),
  );
  await ok(
    admin.post(`/api/plant/assets/${mill}/paths`, {
      data: { id: 'state', subject: `Machine state of ${n}`, devices: [`${mill}-pc`], collector: { kind: 'job', ref: `${n}-collector` } },
    }),
  );
  await ok(
    admin.post(`/api/plant/assets/${mill}/collections`, {
      data: {
        id: 'state',
        name: `State collection ${n}`,
        collector: { kind: 'job', ref: `${n}-collector` },
        dataPathId: 'state',
        interfaceId: 'opc-ua',
        items: [{ address: 'ns=2;s=ProgramStatus', outputName: 'ProgStatus', dataPoint: 'program_status' }],
      },
    }),
  );
  const monitor = await json<{ monitor: { id: string } }>(
    await ok(
      admin.post('/api/monitors', {
        data: {
          key: `${n}-machine`,
          definition: {
            name: `Machine data ${n}`,
            checks: [
              { id: 'pc', name: 'Machine PC reachable', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 },
              { id: 'data', name: 'Machine data', type: 'heartbeat', mode: 'maxAge', maxAgeSeconds: 600 },
            ],
            states: {
              cases: [
                { id: 'running', name: 'Running', when: { pc: 'up' }, expect: { data: 'up' } },
                { id: 'off', name: 'Off', status: 'off', when: { pc: 'down' }, expect: { data: 'down' } },
              ],
            },
          },
        },
      }),
    ),
  );
  await ok(admin.post(`/api/plant/assets/${mill}/links`, { data: { kind: 'monitor', id: monitor.monitor.id } }));
  const cleanup = async () => {
    for (const w of (await json<{ windows: { id: string }[] }>(await admin.get(`/api/maintenance-windows?target=monitor:${monitor.monitor.id}`))).windows)
      await admin.post(`/api/maintenance-windows/${w.id}/cancel`, { data: {} });
    for (const w of (await json<{ windows: { id: string }[] }>(await admin.get(`/api/maintenance-windows?target=asset:${gw}`))).windows)
      await admin.post(`/api/maintenance-windows/${w.id}/cancel`, { data: {} });
    await admin.delete(`/api/monitors/${monitor.monitor.id}`);
    await admin.delete(`/api/plant/assets/${mill}`);
    await admin.delete(`/api/plant/assets/${gw}`);
    await admin.delete(`/api/plant/sites/${site}`);
  };
  return { n, gw, mill, monitorId: monitor.monitor.id, cleanup };
}

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('plans a window on a gateway, sees what it affects before saving, adds planned downtime for the monitor', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const scene = await gatewayScene(admin);
    const title = uniq('Gateway firmware');
    try {
      await page.goto(`/plant/assets/${scene.gw}`);
      const panel = page.getByTestId('maintenance-panel');
      await panel.getByRole('button', { name: 'Plan maintenance' }).click();
      const form = page.getByRole('dialog', { name: 'Plan maintenance' });
      await form.getByRole('textbox', { name: 'Title' }).fill(title);
      await expect(form.getByText(`Edge gateway ${scene.n}`).first()).toBeVisible();

      // before saving: what it affects
      const impact = form.getByTestId('maintenance-impact');
      await expect(impact).toContainText('1 data path');
      await impact.getByTestId('maintenance-impact-toggle').click();
      await expect(impact.getByTestId('impact-devices')).toContainText(`${scene.mill}-pc`);
      await expect(impact.getByTestId('impact-devices')).toContainText('Behind the switch');
      await expect(impact.getByTestId('impact-dataPaths')).toContainText(`Machine state of ${scene.n}`);
      await expect(impact.getByTestId('impact-collections')).toContainText(`State collection ${scene.n}`);
      await expect(impact.getByTestId('impact-kpis')).toContainText(`${scene.mill}-state`);
      const monitors = impact.getByTestId('impact-monitors');
      await expect(monitors).toContainText(`Machine data ${scene.n}`);
      // a monitor with an Off state goes Off, not down
      await expect(monitors.getByTestId('impact-expect-off')).toHaveText('Goes off');
      await expect(impact.getByRole('link', { name: `Machine data ${scene.n}` })).toHaveAttribute('href', appHref(`/monitors/${scene.monitorId}`));
      await expectAccessible(page, 'maintenance form with its impact');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(form).toBeHidden();

      // on the window's page: planned downtime for the monitor in one click
      await panel.getByText(`Next: ${title}`).click();
      const detail = page.getByRole('dialog', { name: title });
      const onPage = detail.getByTestId('maintenance-impact');
      await expect(onPage.getByTestId('impact-monitors')).toContainText(`Machine data ${scene.n}`);
      await expectAccessible(page, 'maintenance details with their impact');
      await onPage.getByTestId('impact-add-downtime').click();
      await expect(page.getByText('Planned downtime added for 1 monitor.')).toBeVisible();
      // the planned downtime opens: it lists the monitor
      const downtime = page.getByRole('dialog', { name: title });
      await expect(downtime.getByTestId('maintenance-downtime-badge')).toBeVisible();
      await expect(downtime.getByRole('link', { name: `Machine data ${scene.n}` }).first()).toBeVisible();
      const list = await json<{ windows: { kind: string; targets: { id: string }[] }[] }>(
        await admin.get(`/api/maintenance-windows?target=monitor:${scene.monitorId}`),
      );
      expect(list.windows.some((w) => w.kind === 'downtime' && w.targets.some((t) => t.id === scene.monitorId))).toBe(true);
    } finally {
      await scene.cleanup();
    }
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });

  test('the impact of a window fits the screen @mobile', async ({ page, apiAs }) => {
    const admin = await apiAs('admin');
    const scene = await gatewayScene(admin);
    try {
      const w = await json<{ id: string; title: string }>(
        await ok(
          admin.post('/api/maintenance-windows', {
            data: {
              title: uniq('Switch swap'),
              startsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
              endsAt: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString(),
              targets: [{ kind: 'device', id: `${scene.gw}/${scene.gw}` }],
            },
          }),
        ),
      );
      await page.goto(`/maintenance?open=${w.id}`);
      const impact = page.getByRole('dialog', { name: w.title }).getByTestId('maintenance-impact');
      await expect(impact.getByTestId('impact-monitor-summary')).toContainText('1 monitor: 0 would go down, 1 go Off.');
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'maintenance impact on a phone');
    } finally {
      await scene.cleanup();
    }
  });
});

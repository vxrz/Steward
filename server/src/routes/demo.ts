import { config } from '../config.js';
import { logger } from '../log.js';
import { db } from '../db.js';
import { addSpec, createPlatform } from '../platforms/service.js';
import { mockIdentitySpec } from '../mock/mockSpec.js';
import { DEMO_OIDC } from '../mock/mockOidc.js';
import { listProviders, saveProvider } from '../auth/sso.js';
import { createFromTemplate, listTemplates } from '../processes/service.js';
import { DEMO_CREDENTIALS } from '../mock/mockPlatform.js';
import { DEMO_GATUS } from '../mock/mockGatus.js';
import { gatusOpenApiSpec } from '../platforms/gatusSpec.js';
import { audit } from '../audit.js';
import { createUser, findUserByName, saveTeam } from '../auth/users.js';
import type { Role } from '@sm/shared';
import { createDashboard, listDashboardTemplates } from '../dashboards/service.js';
import { listSchedules, saveSchedule } from '../scheduler.js';
import { startRun } from '../engine/runner.js';
import { getProcess } from '../processes/service.js';
import { setupMonitorDemo } from '../monitors/demo.js';
import { getSettings, updateSettings } from '../settings.js';

/** Creates demo platforms (pointing to the built-in mock) and imports all templates. */
export const DEMO_USER_PASSWORD = 'Demo-password-1';
const DEMO_USERS: { username: string; displayName: string; roles: Role[] }[] = [
  { username: 'dana', displayName: 'Dana Designer', roles: ['designer'] },
  { username: 'olivia', displayName: 'Olivia Operator', roles: ['operator'] },
  { username: 'adam', displayName: 'Adam Approver', roles: ['approver'] },
  { username: 'audrey', displayName: 'Audrey Auditor', roles: ['auditor'] },
  { username: 'vera', displayName: 'Vera Viewer', roles: ['viewer'] },
];

/**
 * Read-only "feeder" processes that publish dashboard datasets: scheduled in
 * demo mode and run once right away so the example dashboards show data.
 */
const FEEDERS: { process: string; cron: string }[] = [
  { process: 'ih-inventory-snapshot', cron: '5 * * * *' },
  { process: 'ih-data-freshness-monitor', cron: '20 * * * *' },
  { process: 'iem-inventory-snapshot', cron: '35 * * * *' },
  { process: 'ih-health-check', cron: '*/15 * * * *' },
  { process: 'ih-asset-attribute-optimization', cron: '10 6 * * *' },
  { process: 'iem-firmware-compliance', cron: '15 6 * * *' },
  { process: 'iem-app-version-compliance', cron: '20 6 * * *' },
  { process: 'ih-group-hygiene', cron: '30 6 * * 1' },
  { process: 'weekly-service-report', cron: '45 6 * * 1' },
  { process: 'gatus-uptime-overview', cron: '*/10 * * * *' },
];

export async function setupDemo(): Promise<{
  platforms: number;
  processes: number;
  users: string[];
  password: string;
  dashboards: number;
  schedules: number;
  runs: number;
  monitors: number;
}> {
  const base = `http://127.0.0.1:${config.port}/mock`;
  const existing = new Set(
    db()
      .all<{ name: string }>('SELECT name FROM platforms')
      .map((r) => r.name),
  );
  let platforms = 0;
  if (!existing.has('Insights Hub (demo)')) {
    const ih = createPlatform({
      name: 'Insights Hub (demo)',
      kind: 'insights-hub',
      environment: 'demo',
      description: 'Simulated Insights Hub tenant served by the built-in mock.',
      baseUrl: `${base}/ih`,
      config: {
        auth: { type: 'oauth2_client_credentials', tokenUrl: `${base}/ih/oauth/token`, clientAuth: 'basic' },
        variables: {
          tenant: 'demotenant',
          region: 'eu1',
          idmPath: '/api/identitymanagement/v3',
          assetPath: '/api/assetmanagement/v3',
          tsPath: '/api/iottimeseries/v3',
        },
        http: { proxy: 'none' },
        testPath: '/api/identitymanagement/v3/Users?count=1',
      },
      secrets: { clientId: DEMO_CREDENTIALS.client.id, clientSecret: DEMO_CREDENTIALS.client.secret },
    });
    addSpec(ih.id, 'Identity Management (demo)', JSON.stringify(mockIdentitySpec(), null, 2));
    platforms++;
  }
  if (!existing.has('Industrial Edge Management (demo)')) {
    createPlatform({
      name: 'Industrial Edge Management (demo)',
      kind: 'industrial-edge-management',
      environment: 'demo',
      description: 'Simulated IEM served by the built-in mock. Also hosts a small web portal for the browser demo.',
      baseUrl: `${base}/iem`,
      config: {
        auth: {
          type: 'token_request',
          request: {
            method: 'POST',
            url: '/portal/api/v1/login/direct',
            body: { username: '{{ secrets.username }}', password: '{{ secrets.password }}' },
            bodyType: 'json',
          },
          tokenPath: 'data.access_token',
          headerName: 'Authorization',
          headerValue: 'Bearer {{ token }}',
        },
        variables: {},
        http: { proxy: 'none' },
        testPath: '/portal/api/v1/devices',
        portalUrl: `${base}/portal`,
      },
      secrets: { username: DEMO_CREDENTIALS.iem.username, password: DEMO_CREDENTIALS.iem.password },
    });
    platforms++;
  }
  if (!existing.has('Gatus (demo)')) {
    const g = createPlatform({
      name: 'Gatus (demo)',
      kind: 'gatus',
      environment: 'demo',
      description: 'Simulated Gatus status page (basic auth) served by the built-in mock. See docs/GATUS.md for a real instance.',
      baseUrl: `${base}/gatus`,
      config: { auth: { type: 'basic' }, variables: {}, http: { proxy: 'none' }, testPath: '/api/v1/endpoints/statuses?pageSize=1' },
      secrets: { username: DEMO_GATUS.username, password: DEMO_GATUS.password, externalToken: DEMO_GATUS.externalToken },
    });
    addSpec(g.id, 'Gatus API', JSON.stringify(gatusOpenApiSpec(), null, 2));
    platforms++;
  }
  if (!existing.has('Web probe (demo)')) {
    createPlatform({
      name: 'Web probe (demo)',
      kind: 'generic',
      environment: 'demo',
      description:
        'Plain HTTP access without credentials to the demo applications that Gatus watches. Used by "Diagnose endpoint outage" to probe a failing URL.',
      baseUrl: base,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' }, testPath: '/gatus-apps/mes' },
    });
    platforms++;
  }
  const have = new Set(
    db()
      .all<{ id: string }>('SELECT id FROM processes WHERE archived = 0')
      .map((r) => r.id),
  );
  let processes = 0;
  for (const t of listTemplates()) {
    if (have.has(t.id.replace(/^\d+-/, ''))) continue;
    createFromTemplate(t.id);
    processes++;
  }
  const created: string[] = [];
  for (const u of DEMO_USERS) {
    if (findUserByName(u.username)) continue;
    createUser({ ...u, password: DEMO_USER_PASSWORD });
    created.push(u.username);
  }
  if (created.length) saveTeam({ name: 'Service Desk', description: 'Demo team', members: ['olivia', 'adam'] });
  if (!listProviders().some((p) => p.issuer.includes('/mock/oidc'))) {
    saveProvider({
      displayName: 'Microsoft Entra ID (simulated)',
      type: 'entra',
      issuer: `${base}/oidc`,
      clientId: DEMO_OIDC.clientId,
      clientSecret: DEMO_OIDC.clientSecret,
      clientAuth: 'client_secret_post',
      scopes: 'openid profile email',
      usernameClaim: 'preferred_username',
      displayNameClaim: 'name',
      emailClaim: 'email',
      groupsClaim: 'roles',
      mappings: [
        { claimValue: 'SM.Admins', roles: ['admin'], teams: [] },
        { claimValue: 'SM.Designers', roles: ['designer'], teams: [] },
        { claimValue: 'SM.Operators', roles: ['operator'], teams: ['Service Desk'] },
        { claimValue: 'SM.Approvers', roles: ['approver'], teams: ['Service Desk'] },
      ],
      defaultRoles: [],
      autoProvision: true,
      syncRoles: true,
      requireMapping: true,
      enabled: true,
    });
  }
  // ---- dashboards from examples/dashboards ----
  const haveDash = new Set(
    db()
      .all<{ id: string }>('SELECT id FROM dashboards')
      .map((r) => r.id),
  );
  let dashboards = 0;
  for (const t of listDashboardTemplates()) {
    const id = t.id.replace(/^\d+-/, '');
    if (haveDash.has(id)) continue;
    createDashboard(t.definition, { id });
    dashboards++;
  }

  // ---- schedules + first run of the feeder processes ----
  const platformByKind = new Map(
    db()
      .all<{ id: string; kind: string; name: string }>('SELECT id, kind, name FROM platforms')
      .filter((p) => p.name.endsWith('(demo)'))
      .map((p) => [p.kind, p.id]),
  );
  const scheduleNames = new Set(listSchedules().map((x) => x.name));
  let schedules = 0;
  let runs = 0;
  for (const f of FEEDERS) {
    let def;
    try {
      def = getProcess(f.process).definition;
    } catch {
      continue; // template not imported
    }
    const bindings: Record<string, string> = {};
    for (const c of def.connections) {
      const pid = c.kind ? platformByKind.get(c.kind) : undefined;
      if (pid) bindings[c.slot] = pid;
    }
    if (Object.keys(bindings).length !== def.connections.length) continue;
    const name = `Demo: ${def.name}`;
    if (!scheduleNames.has(name)) {
      saveSchedule({ name, processId: f.process, cron: f.cron, inputs: {}, bindings, dryRun: false, enabled: true, allowOverlap: false });
      schedules++;
    }
    const ran = db().get('SELECT 1 FROM runs WHERE process_id = ? LIMIT 1', f.process);
    if (!ran) {
      await startRun({ processId: f.process, bindings, inputs: {}, dryRun: false });
      runs++;
    }
  }

  // ---- example monitors (machines with PowerMeters) and the IoT gateway simulator ----
  // The demo's simulated plant devices live on loopback (the examples' 10.20.x.x
  // PowerMeter IPs are mapped to 127.0.0.1 here). Allow loopback so their monitor
  // checks run, mirroring how an admin allow-lists the real plant IPs/CIDRs under
  // Settings → Outbound access. The outbound policy still blocks metadata and the API.
  try {
    const current = getSettings().outboundAllowList ?? [];
    const additions = ['127.0.0.1', 'localhost', '[::1]'].filter((h) => !current.includes(h));
    if (additions.length) updateSettings({ outboundAllowList: [...current, ...additions] });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'could not allow loopback for the demo monitors');
  }
  let monitors = 0;
  try {
    monitors = await setupMonitorDemo();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo monitors not created');
  }

  audit({
    action: 'demo.setup',
    entityType: 'settings',
    summary: `Demo data loaded (${platforms} platforms, ${processes} processes, ${created.length} users, ${dashboards} dashboards, ${schedules} schedules, ${runs} feeder runs started, ${monitors} monitors)`,
  });
  return { platforms, processes, users: DEMO_USERS.map((u) => u.username), password: DEMO_USER_PASSWORD, dashboards, schedules, runs, monitors };
}

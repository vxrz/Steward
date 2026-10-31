import crypto from 'node:crypto';
import { loopbackUrl } from '../config.js';
import { logger } from '../log.js';
import { db } from '../db.js';
import { addSpec, createPlatform } from '../platforms/service.js';
import { mockIdentitySpec } from '../mock/mockSpec.js';
import { DEMO_OIDC } from '../mock/mockOidc.js';
import { listProviders, saveProvider } from '../auth/sso.js';
import { createFromTemplate, listTemplates } from '../processes/service.js';
import { DEMO_CREDENTIALS } from '../mock/mockPlatform.js';
import { DEMO_CHECKMK } from '../mock/mockCheckmk.js';
import { DEMO_KUBERNETES } from '../mock/mockKubernetes.js';
import { DEMO_GIT_PLATFORMS } from '../mock/mockGitPlatforms.js';
import { DEMO_KAFKA } from '../mock/mockKafka.js';
import { DEMO_MQTT, startMqttSimulator } from '../mock/mockMqtt.js';
import { DEMO_KAFKA_BOOTSTRAP } from '../kafka/client.js';
import { DEMO_GATUS } from '../mock/mockGatus.js';
import { MOCK_UTS_PROVIDER } from '../mock/mockUsage.js';
import { gatusOpenApiSpec } from '../platforms/gatusSpec.js';
import { PRESET_SPECS } from '../platforms/presets.js';
import { audit } from '../audit.js';
import { createUser, findUserByName, saveTeam } from '../auth/users.js';
import type { Role } from '@sm/shared';
import { createDashboard, listDashboardTemplates } from '../dashboards/service.js';
import { listSchedules, saveSchedule } from '../scheduler.js';
import { startRun } from '../engine/runner.js';
import { getProcess } from '../processes/service.js';
import { setupMonitorDemo } from '../monitors/demo.js';
import { getSettings, updateSettings } from '../settings.js';
import { setupComplianceDemo } from '../compliance/demo.js';
import { DEMO_AWS } from '../mock/mockAws.js';
import { DEMO_DTRACK } from '../mock/mockDtrack.js';
import { DEMO_SNOWFLAKE, setSnowflakePublicKey } from '../mock/mockSnowflake.js';

/** Creates demo platforms (pointing to the built-in mock) and imports all templates. */
export const DEMO_USER_PASSWORD = 'Demo-password-1';
const DEMO_USERS: { username: string; displayName: string; roles: Role[] }[] = [
  { username: 'dana', displayName: 'Dana Designer', roles: ['designer'] },
  { username: 'olivia', displayName: 'Olivia Operator', roles: ['operator'] },
  { username: 'adam', displayName: 'Adam Approver', roles: ['approver'] },
  { username: 'audrey', displayName: 'Audrey Auditor', roles: ['auditor'] },
  { username: 'vera', displayName: 'Vera Viewer', roles: ['viewer'] },
  { username: 'stella', displayName: 'Stella Status', roles: ['status'] },
];

/**
 * Read-only "feeder" processes that publish dashboard datasets: scheduled in
 * demo mode and run once right away so the example dashboards show data.
 */
const FEEDERS: { process: string; cron: string; inputs?: Record<string, unknown> }[] = [
  { process: 'ih-inventory-snapshot', cron: '5 * * * *' },
  { process: 'ih-data-freshness-monitor', cron: '20 * * * *' },
  { process: 'iem-inventory-snapshot', cron: '35 * * * *' },
  { process: 'ih-health-check', cron: '*/15 * * * *' },
  { process: 'ih-asset-attribute-optimization', cron: '10 6 * * *' },
  { process: 'iem-firmware-compliance', cron: '15 6 * * *' },
  { process: 'iem-app-version-compliance', cron: '20 6 * * *' },
  {
    process: 'ih-tenant-usage',
    cron: '25 6 * * *',
    // the licence of the simulated tenant and a KPI of the simulated usage service
    inputs: {
      userLimit: 25,
      assetLimit: 15,
      agentLimit: 10,
      attributeLimit: 500,
      utsProvider: MOCK_UTS_PROVIDER,
      utsApplication: 'steward-demo',
      utsKpi: 'monthly-credits',
      utsKpiLimit: 10000,
    },
  },
  { process: 'ih-group-hygiene', cron: '30 6 * * 1' },
  { process: 'weekly-service-report', cron: '45 6 * * 1' },
  { process: 'gatus-uptime-overview', cron: '*/10 * * * *' },
  { process: 'gatus-uptime-overview-from-metrics', cron: '*/10 * * * *' },
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
  const base = `${loopbackUrl()}/mock`;
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
  if (!existing.has('CheckMk (demo)')) {
    // CheckMk (#130): host and service states for monitors, metric history for the trend summary example
    createPlatform({
      name: 'CheckMk (demo)',
      kind: 'checkmk',
      environment: 'demo',
      description: 'Simulated CheckMk site (REST API 1.0) served by the built-in mock: four hosts and services, metric history. See docs/CHECKMK.md.',
      baseUrl: `${base}/checkmk/demo/check_mk/api/1.0`,
      config: { auth: { type: 'bearer' }, variables: { site: 'demo' }, http: { proxy: 'none' }, testPath: '/version' },
      secrets: { token: `${DEMO_CHECKMK.user} ${DEMO_CHECKMK.secret}` },
    });
    platforms++;
  }
  if (!existing.has('Prometheus (demo)')) {
    // Prometheus (#110): PromQL checks and an availability objective from a query
    createPlatform({
      name: 'Prometheus (demo)',
      kind: 'prometheus',
      environment: 'demo',
      description: 'Simulated Prometheus HTTP API served by the built-in mock (a few fixed queries). See docs/MONITORS.md.',
      baseUrl: `${base}/prometheus`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' }, testPath: '/api/v1/status/buildinfo' },
    });
    platforms++;
  }
  if (!existing.has('Kubernetes (demo)')) {
    // Kubernetes (#111): namespaces shop-prod and shop-test with deployments, pods and cert-manager certificates
    createPlatform({
      name: 'Kubernetes (demo)',
      kind: 'kubernetes',
      environment: 'demo',
      description: 'Simulated Kubernetes API server (read-only service account) served by the built-in mock. See docs/KUBERNETES.md.',
      baseUrl: `${base}/kubernetes`,
      config: { auth: { type: 'bearer' }, variables: {}, http: { proxy: 'none' }, testPath: '/version' },
      secrets: { token: DEMO_KUBERNETES.token },
    });
    platforms++;
  }
  // Git platforms (#107): the organisation acme with shop-web and shop-api on each host
  for (const g of [
    { name: 'GitHub (demo)', kind: 'github', path: '/gitplat/github', test: '/rate_limit' },
    { name: 'GitLab (demo)', kind: 'gitlab', path: '/gitplat/gitlab/api/v4', test: '/version' },
    { name: 'Forgejo (demo)', kind: 'forgejo', path: '/gitplat/forgejo/api/v1', test: '/version' },
  ]) {
    if (existing.has(g.name)) continue;
    const p = createPlatform({
      name: g.name,
      kind: g.kind,
      environment: 'demo',
      description: 'Simulated Git host API (read-only token) served by the built-in mock. See docs/GIT-PLATFORMS.md.',
      baseUrl: `${base}${g.path}`,
      config: { auth: { type: 'bearer' }, variables: {}, http: { proxy: 'none' }, testPath: g.test },
      secrets: { token: DEMO_GIT_PLATFORMS.token },
    });
    for (const s of PRESET_SPECS[g.kind]?.() ?? []) addSpec(p.id, s.name, s.content);
    platforms++;
  }
  if (!existing.has('Kafka (demo)')) {
    // Kafka (#112): a simulated cluster (orders, payments, shop-events) and Schema Registry; peek is on in the demo
    createPlatform({
      name: 'Kafka (demo)',
      kind: 'kafka',
      environment: 'demo',
      description: 'Simulated Kafka cluster and Schema Registry served by the built-in mock (reading messages is on for the demo). See docs/KAFKA.md.',
      baseUrl: `${base}/schema-registry`,
      config: {
        auth: { type: 'basic' },
        variables: { bootstrap: DEMO_KAFKA_BOOTSTRAP, sasl: 'plain', tls: 'true', peek: 'on' },
        http: { proxy: 'none' },
        testPath: '/subjects',
      },
      secrets: { ...DEMO_KAFKA },
    });
    platforms++;
  }
  if (!existing.has('MQTT (demo)')) {
    // MQTT (#113): the built-in broker over WebSocket; presses 1–3 report every 20 s, press 4 went silent an hour ago
    const p = createPlatform({
      name: 'MQTT (demo)',
      kind: 'mqtt',
      environment: 'demo',
      description:
        'Simulated MQTT broker (WebSocket) served by the built-in mock: plant/press-1..4/status and $SYS/broker/clients/connected. See docs/MQTT.md.',
      baseUrl: '',
      config: { auth: { type: 'none' }, variables: { url: `${base.replace(/^http/, 'ws')}/mqtt` }, http: { proxy: 'none' } },
      secrets: { ...DEMO_MQTT },
    });
    db().run(
      'INSERT INTO mqtt_topics (platform_id, topic, last_at, messages) VALUES (?, ?, ?, ?) ON CONFLICT(platform_id, topic) DO NOTHING',
      p.id,
      'plant/press-4/status',
      new Date(Date.now() - 3_600_000).toISOString(),
      120,
    );
    platforms++;
  }
  startMqttSimulator();
  if (!existing.has('Dependency-Track (demo)')) {
    // Dependency-Track (#119): projects shop-web 2.4.1 / 2.5.0 and crm-api 1.0.0 with findings and policy violations
    createPlatform({
      name: 'Dependency-Track (demo)',
      kind: 'dependency-track',
      environment: 'demo',
      description: 'Simulated Dependency-Track served by the built-in mock: projects shop-web (2.4.1, 2.5.0) and crm-api. See docs/DEPENDENCY-TRACK.md.',
      baseUrl: `${base}/dtrack`,
      config: {
        auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'X-Api-Key' },
        variables: {},
        http: { proxy: 'none' },
        testPath: '/api/v1/project?pageNumber=1&pageSize=1',
      },
      secrets: { apiKey: DEMO_DTRACK.apiKey },
    });
    platforms++;
  }
  if (!existing.has('Snowflake (demo)')) {
    // Snowflake (#115): a key pair for the demo user – the mock knows the public key, Steward keeps the private one
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    setSnowflakePublicKey(keys.publicKey.export({ type: 'spki', format: 'pem' }) as string);
    createPlatform({
      name: 'Snowflake (demo)',
      kind: 'snowflake',
      environment: 'demo',
      description:
        'Simulated Snowflake account DEMO12345 served by the built-in mock: databases SHOP and CRM, a failing task, two warehouses. See docs/SNOWFLAKE.md.',
      baseUrl: `${base}/snowflake`,
      config: {
        auth: {
          type: 'jwt',
          jwt: {
            alg: 'RS256',
            lifetimeSeconds: 3600,
            claims: {
              iss: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) & '.' & publicKeyFingerprint }}",
              sub: "{{ $uppercase(vars.account) & '.' & $uppercase(vars.user) }}",
            },
          },
        },
        variables: { ...DEMO_SNOWFLAKE },
        http: { proxy: 'none', defaultHeaders: { 'X-Snowflake-Authorization-Token-Type': 'KEYPAIR_JWT' } },
      },
      secrets: { privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string },
    });
    platforms++;
  }
  if (!existing.has('AWS (demo)')) {
    // AWS (#116): a demo account – resources tagged application=shop / crm in two regions, costs, IAM users
    createPlatform({
      name: 'AWS (demo)',
      kind: 'aws',
      environment: 'demo',
      description: 'Simulated AWS account 123456789012 served by the built-in mock (STS, tagging, Cost Explorer, IAM). See docs/AWS.md.',
      baseUrl: `${base}/aws-api`,
      config: {
        auth: { type: 'aws_sigv4', aws: { region: DEMO_AWS.region, service: 'sts' } },
        variables: { regions: 'eu-central-1, eu-west-1', tagKey: 'application' },
        http: { proxy: 'none' },
      },
      secrets: { accessKeyId: DEMO_AWS.accessKeyId, secretAccessKey: DEMO_AWS.secretAccessKey },
    });
    platforms++;
  }
  if (!existing.has('endoflife.date (demo)')) {
    // end-of-life dates of the tech stacks (#104): the built-in mock with the real API's shape
    const e = createPlatform({
      name: 'endoflife.date (demo)',
      kind: 'endoflife-date',
      environment: 'demo',
      description:
        'Simulated endoflife.date API (made-up dates relative to today) served by the built-in mock. A real installation uses https://endoflife.date.',
      baseUrl: `${base}/endoflife`,
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' }, testPath: '/api/v1/products/nodejs' },
    });
    for (const s of PRESET_SPECS['endoflife-date']!()) addSpec(e.id, s.name, s.content);
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
      saveSchedule({ name, processId: f.process, cron: f.cron, inputs: f.inputs ?? {}, bindings, dryRun: false, enabled: true, allowOverlap: false });
      schedules++;
    }
    const ran = db().get('SELECT 1 FROM runs WHERE process_id = ? LIMIT 1', f.process);
    if (!ran) {
      await startRun({ processId: f.process, bindings, inputs: f.inputs ?? {}, dryRun: false });
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

  // ---- access reconciliation of the simulated Insights Hub (baseline snapshot) ----
  await setupComplianceDemo(platformByKind.get('insights-hub'));

  audit({
    action: 'demo.setup',
    entityType: 'settings',
    summary: `Demo data loaded (${platforms} platforms, ${processes} processes, ${created.length} users, ${dashboards} dashboards, ${schedules} schedules, ${runs} feeder runs started, ${monitors} monitors)`,
  });
  return { platforms, processes, users: DEMO_USERS.map((u) => u.username), password: DEMO_USER_PASSWORD, dashboards, schedules, runs, monitors };
}

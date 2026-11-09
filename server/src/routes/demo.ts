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
import { DEMO_KAFKA_CONNECT } from '../mock/mockKafkaConnect.js';
import { DEMO_MQTT, startMqttSimulator } from '../mock/mockMqtt.js';
import { DEMO_KAFKA_BOOTSTRAP } from '../kafka/client.js';
import { DEMO_GATUS } from '../mock/mockGatus.js';
import { MOCK_UTS_PROVIDER } from '../mock/mockUsage.js';
import { gatusOpenApiSpec } from '../platforms/gatusSpec.js';
import { PRESETS, PRESET_SPECS } from '../platforms/presets.js';
import { audit } from '../audit.js';
import { createUser, findUserByName, saveTeam } from '../auth/users.js';
import {
  CHANGEDETECTION_KIND,
  CONTAINER_REGISTRY_KIND,
  DATABASE_KIND,
  KAFKA_CONNECT_KIND,
  LLM_GATEWAY_KIND,
  PVAULT_KIND,
  type AiGatewaySettings,
  type ComponentType,
  type Role,
} from '@sm/shared';
import { DEMO_DB, DEMO_DB_HOST } from '../dbms/demo.js';
import { createDashboard, listDashboardTemplates } from '../dashboards/service.js';
import { listSchedules, saveSchedule } from '../scheduler.js';
import { engine } from '../engine/index.js';
import { authorizeStart } from '../engine/commands.js';
import { getProcess } from '../processes/service.js';
import { setupMonitorDemo } from '../monitors/demo.js';
import { getSettings, updateSettings } from '../settings.js';
import { setupAccessSourcesDemo, setupComplianceDemo } from '../compliance/demo.js';
import { applicationInput, canEditApplication, createApplication } from '../catalogue/applications.js';
import { addComponent, componentInput } from '../catalogue/components.js';
import { refreshLifecycle } from '../catalogue/lifecycle.js';
import { currentActor } from '../auth/context.js';
import { DEMO_AWS } from '../mock/mockAws.js';
import { DEMO_DTRACK } from '../mock/mockDtrack.js';
import { DEMO_CHANGEDETECTION } from '../mock/mockChangedetection.js';
import { DEMO_SNOWFLAKE, setSnowflakePublicKey } from '../mock/mockSnowflake.js';
import { DEMO_GRAPH } from '../mock/mockGraph.js';
import { seedPlantDemo } from '../plant/demo.js';
import { DEMO_PVAULT } from '../mock/mockPrivilegeVault.js';
import { seedContractDemo } from '../datacontracts/demo.js';
import { DEMO_LLM } from '../mock/mockLlmGateway.js';
import { DEMO_CONFLUENT } from '../mock/mockConfluent.js';

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
 * `bind` names the platform kind of a slot that takes several kinds; `label`
 * tells two schedules of one process apart (one per Git host); `apps` feeders
 * read the sample applications and are left out without them.
 */
const FEEDERS: { process: string; cron: string; inputs?: Record<string, unknown>; bind?: Record<string, string>; label?: string; apps?: true }[] = [
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
  // the platforms of 0.2.6 to 0.3.1: CheckMk, Kubernetes, Git hosts, Dependency-Track, Snowflake, Prometheus
  { process: 'checkmk-trend-summary', cron: '0 7 * * *' },
  { process: 'kubernetes-namespace-health', cron: '*/15 * * * *' },
  { process: 'github-repository-health', cron: '0 * * * *', bind: { github: 'github' }, label: 'GitHub' },
  {
    process: 'github-repository-health',
    cron: '10 * * * *',
    bind: { github: 'gitlab' },
    label: 'GitLab',
    inputs: { repositories: ['acme/shop/web', 'acme/shop/api'] },
  },
  { process: 'github-repository-health', cron: '20 * * * *', bind: { github: 'forgejo' }, label: 'Forgejo' },
  { process: 'dependency-track-vulnerabilities', cron: '0 */6 * * *' },
  { process: 'snowflake-account-hygiene', cron: '15 6 * * *' },
  // database platforms (0.7.0): the demo database answers the catalog queries and the examples' statements
  { process: 'database-account-hygiene', cron: '25 6 * * *' },
  { process: 'database-table-sizes', cron: '35 6 * * *' },
  { process: 'postgresql-connections', cron: '*/15 * * * *' },
  { process: 'prometheus-slo-report', cron: '0 7 * * 1' },
  // from the sample applications (their components' readouts and tech stacks)
  { process: 'end-of-life-overview', cron: '0 7 * * 1', apps: true },
  { process: 'kafka-topic-standards', cron: '30 7 * * *', apps: true },
  { process: 'aws-iam-key-age', cron: '40 6 * * *', apps: true },
  { process: 'aws-costs-per-application', cron: '0 7 3 * *', apps: true },
];

/** Sample applications (#103…#119): their components point to the demo platforms and are read once at setup. */
const DEMO_APPLICATIONS: { name: string; description: string; components: { type: ComponentType; name: string; kind: string }[] }[] = [
  {
    name: 'Webshop (demo)',
    description: 'The shop: web front end and API on GitHub and Kubernetes, events on Kafka, data in Snowflake, runs in AWS (tag application=shop).',
    components: [
      { type: 'repository', name: 'acme/shop-web', kind: 'github' },
      { type: 'kubernetes-namespace', name: 'shop-prod', kind: 'kubernetes' },
      { type: 'kafka-topic', name: 'orders', kind: 'kafka' },
      { type: 'kafka-topic', name: 'payments', kind: 'kafka' },
      { type: 'kafka-topic', name: 'shop-events', kind: 'kafka' },
      { type: 'snowflake-database', name: 'SHOP', kind: 'snowflake' },
      { type: 'cloud-account', name: 'shop', kind: 'aws' },
    ],
  },
  {
    name: 'CRM (demo)',
    description: 'Customer data: contacts in Snowflake, the sync function and the API in AWS (tag application=crm).',
    components: [
      { type: 'snowflake-database', name: 'CRM', kind: 'snowflake' },
      { type: 'cloud-account', name: 'crm', kind: 'aws' },
    ],
  },
];

async function setupDemoApplications(platformByKind: Map<string, string>, actor: string): Promise<number> {
  let created = 0;
  const reads: Promise<unknown>[] = [];
  for (const a of DEMO_APPLICATIONS) {
    if (db().get('SELECT 1 FROM applications WHERE lower(name) = lower(?)', a.name)) continue;
    const app = createApplication(applicationInput.parse({ name: a.name, description: a.description, tags: ['demo'] }));
    created++;
    for (const c of a.components) {
      const platformId = platformByKind.get(c.kind);
      if (!platformId) continue;
      const comp = addComponent(app.id, componentInput.parse({ type: c.type, name: c.name, platformId }), canEditApplication);
      // read every component once now (the background jobs read them again every 6 hours)
      const read =
        c.type === 'repository'
          ? import('../catalogue/repositories.js').then((m) => m.refreshRepository(comp.id, actor))
          : c.type === 'kubernetes-namespace'
            ? import('../catalogue/kubernetes.js').then((m) => m.refreshNamespace(comp.id, actor))
            : c.type === 'kafka-topic'
              ? import('../kafka/service.js').then((m) => m.refreshTopic(comp.id, actor))
              : c.type === 'snowflake-database'
                ? import('../snowflake/service.js').then((m) => m.refreshSnowflakeComponent(comp.id, actor))
                : import('../aws/service.js').then((m) => m.refreshAwsComponent(comp.id, actor, { force: true }));
      reads.push(read.catch((err) => logger.warn({ err: (err as Error).message, component: c.name }, 'demo component not read')));
    }
  }
  await Promise.all(reads);
  // the end of life of the stacks read from the repository and the namespace (endoflife.date demo)
  if (created) await refreshLifecycle().catch((err) => logger.warn({ err: (err as Error).message }, 'demo end-of-life data not read'));
  // their newest versions (#241): the simulated registries
  if (created)
    await import('../versions/service.js')
      .then((m) => m.refreshVersions({ force: true }))
      .catch((err) => logger.warn({ err: (err as Error).message }, 'demo version watch not read'));
  return created;
}

/** Reads the demo changedetection.io once and links three watches (#242); the background job reads it again every hour. */
async function setupChangedetectionDemo(platformId: string | undefined, actor: string): Promise<void> {
  if (!platformId || db().get('SELECT 1 FROM cd_reads WHERE platform_id = ?', platformId)) return;
  try {
    const { refreshWatches, setWatchLink } = await import('../changedetection/service.js');
    await refreshWatches(platformId, actor);
    const app = (name: string) => db().get<{ id: string }>('SELECT id FROM applications WHERE name = ?', name)?.id ?? null;
    const links: [string, string | null, string][] = [
      ['7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e01', app('Webshop (demo)'), 'Zentrova Cloud'],
      ['7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e02', app('Webshop (demo)'), 'Zentrova Cloud'],
      ['7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e06', app('CRM (demo)'), 'Mailbrook'],
      ['7d3c1a90-5b2e-4f61-8c47-1a2b3c4d5e04', null, 'Paylumen'],
    ];
    for (const [uuid, applicationId, vendor] of links) setWatchLink(platformId, uuid, { ...(applicationId ? { applicationId } : {}), vendor }, actor);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo page watches not read');
  }
}

export async function setupDemo(opts: { applications?: boolean; services?: boolean } = {}): Promise<{
  platforms: number;
  processes: number;
  users: string[];
  password: string;
  dashboards: number;
  schedules: number;
  runs: number;
  monitors: number;
  applications: number;
  services: number;
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
        variables: { bootstrap: DEMO_KAFKA_BOOTSTRAP, sasl: 'plain', tls: 'true', peek: 'on', confluentClusterId: DEMO_CONFLUENT.cluster },
        http: { proxy: 'none' },
        testPath: '/subjects',
      },
      secrets: { ...DEMO_KAFKA },
    });
    platforms++;
  }
  if (!existing.has('Kafka Connect (demo)')) {
    // Kafka Connect (#223): a Debezium PostgreSQL source of the shop database and a sink of the topic orders, one task failed
    const preset = PRESETS.find((x) => x.kind === KAFKA_CONNECT_KIND)!;
    const kc = createPlatform({
      name: 'Kafka Connect (demo)',
      kind: KAFKA_CONNECT_KIND,
      environment: 'demo',
      description:
        'Simulated Kafka Connect REST API served by the built-in mock: the Debezium connector shop-cdc reads the shop database, the sink orders-archive reads the topic orders (one task failed). Read-only. See docs/KAFKA.md.',
      baseUrl: `${base}/kafka-connect`,
      config: { auth: { type: 'basic' }, variables: { kafkaPlatform: 'Kafka (demo)' }, http: { proxy: 'none' }, testPath: preset.config.testPath },
      secrets: { ...DEMO_KAFKA_CONNECT },
    });
    for (const sp of PRESET_SPECS[KAFKA_CONNECT_KIND]!()) addSpec(kc.id, sp.name, sp.content);
    await import('../kafkaconnect/service.js')
      .then((m) => m.refreshConnect(kc.id, currentActor()))
      .catch((err) => logger.warn({ err: (err as Error).message }, 'demo Kafka Connect not read'));
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
  if (!existing.has('changedetection.io (demo)')) {
    // changedetection.io (#242): vendor terms, pricing, release notes, a failing status page and a paused watch
    const cd = createPlatform({
      name: 'changedetection.io (demo)',
      kind: CHANGEDETECTION_KIND,
      environment: 'demo',
      description:
        'Simulated changedetection.io served by the built-in mock: six watches of invented vendor pages – terms, pricing, release notes, a failing status page, a paused one. See docs/CHANGEDETECTION.md.',
      baseUrl: `${base}/changedetection`,
      config: {
        auth: { type: 'apiKey', apiKeyIn: 'header', apiKeyName: 'x-api-key' },
        variables: { uiUrl: '' },
        http: { proxy: 'none' },
        testPath: '/api/v1/systeminfo',
      },
      secrets: { apiKey: DEMO_CHANGEDETECTION.apiKey },
    });
    for (const sp of PRESET_SPECS[CHANGEDETECTION_KIND]!()) addSpec(cd.id, sp.name, sp.content);
    platforms++;
  }
  if (!existing.has('IBM Verify Privilege Vault (demo)')) {
    // IBM Verify Privilege Vault (#205): six secrets with every hygiene finding, folders, groups, roles, audits
    const preset = PRESETS.find((x) => x.kind === PVAULT_KIND)!;
    const v = createPlatform({
      name: 'IBM Verify Privilege Vault (demo)',
      kind: PVAULT_KIND,
      environment: 'demo',
      description:
        'Simulated IBM Verify Privilege Vault 12 (Secret Server REST API) served by the built-in mock: folders \\IT, \\Privileged and \\Shared, six secrets, groups, roles and audits. Steward never reads secret values. See docs/IBM-PAM.md.',
      baseUrl: `${base}/pvault/SecretServer`,
      config: { ...preset.config, variables: { ...preset.config.variables, privilegedFolders: '\\Privileged' }, http: { proxy: 'none' } },
      secrets: { username: DEMO_PVAULT.username, password: DEMO_PVAULT.password },
    });
    for (const sp of PRESET_SPECS[PVAULT_KIND]!()) addSpec(v.id, sp.name, sp.content);
    platforms++;
  }
  if (!existing.has('LLM gateway (demo)')) {
    // LLM gateway (#216): the simulated multi-format gateway with one model per format; it may be sent CheckMk data
    // and the CheckMk datasets – nothing else, as an administrator would set it up
    const preset = PRESETS.find((x) => x.kind === LLM_GATEWAY_KIND)!;
    const checkmk = db().get<{ id: string }>("SELECT id FROM platforms WHERE name = 'CheckMk (demo)'");
    const window = { contextTokens: 32_000, maxOutputTokens: 1_000 };
    const ai: AiGatewaySettings = {
      models: [
        { id: 'demo-chat-small', label: 'Demo chat (small)', format: 'chat-completions', ...window, priceInputPer1k: 0.0005, priceOutputPer1k: 0.0015 },
        { id: 'demo-responses-small', label: 'Demo responses (small)', format: 'responses', ...window },
        {
          id: 'demo-messages-small',
          label: 'Demo messages (small)',
          format: 'anthropic-messages',
          ...window,
          priceInputPer1k: 0.0008,
          priceOutputPer1k: 0.004,
        },
        { id: 'demo.converse-small-v1:0', label: 'Demo converse (small)', format: 'bedrock-converse', ...window },
      ],
      allowedData: { platforms: checkmk ? [checkmk.id] : [], datasets: ['checkmk.*'], inputs: false },
    };
    createPlatform({
      name: 'LLM gateway (demo)',
      kind: LLM_GATEWAY_KIND,
      environment: 'demo',
      description:
        'Simulated multi-format LLM gateway served by the built-in mock: Chat Completions, Responses, Messages and Converse on one base URL, an API key in x-api-key. Its answers are made up from the question – no real model is asked. See docs/AI.md.',
      baseUrl: `${base}/llm`,
      config: { ...preset.config, http: { ...preset.config.http, proxy: 'none' }, ai },
      secrets: { apiKey: DEMO_LLM.apiKey },
    });
    platforms++;
  }
  if (!existing.has('Confluent Cloud (demo)')) {
    // Confluent Cloud (#226, #123): the simulated Cloud API – role bindings for access reviews, the Costs API and the
    // readout (environments, clusters, keys, connectors); the costs of its cluster lkc-demo1 belong to "Kafka (demo)"
    // (variable confluentClusterId there), and its Schema Registry is the one of "Kafka (demo)" (the same mock)
    const preset = PRESETS.find((x) => x.kind === 'confluent-cloud')!;
    const cc = createPlatform({
      name: 'Confluent Cloud (demo)',
      kind: 'confluent-cloud',
      environment: 'demo',
      description:
        'Simulated Confluent Cloud API served by the built-in mock: environments, Kafka clusters, managed connectors, service accounts, API keys, the Schema Registry, role bindings and the Costs API. See docs/CONFLUENT.md and docs/COSTS.md.',
      baseUrl: `${base}/confluent`,
      config: {
        ...preset.config,
        variables: { ...preset.config.variables, schemaRegistryUrl: `${base}/schema-registry` },
        http: { ...preset.config.http, proxy: 'none' },
      },
      secrets: {
        username: DEMO_CONFLUENT.cloudKey,
        password: DEMO_CONFLUENT.cloudSecret,
        registryKey: DEMO_KAFKA.registryKey,
        registrySecret: DEMO_KAFKA.registrySecret,
      },
    });
    await import('../confluent/service.js')
      .then((m) => m.refreshConfluent(cc.id, currentActor()))
      .catch((err) => logger.warn({ err: (err as Error).message }, 'demo Confluent Cloud not read'));
    platforms++;
  }
  if (!existing.has('Shop database (demo)')) {
    // a database platform (#203): a fake PostgreSQL that answers the catalog queries with canned rows – it never reads
    // Steward's own database (ADR 0008)
    createPlatform({
      name: 'Shop database (demo)',
      kind: DATABASE_KIND,
      environment: 'demo',
      description:
        'Simulated PostgreSQL database "shop" served by the built-in demo driver: accounts, roles, grants, replication and tables with canned rows (no real data). See docs/DATABASES.md.',
      baseUrl: '',
      config: {
        auth: { type: 'none' },
        variables: {},
        http: {},
        database: { dialect: 'postgresql', host: DEMO_DB_HOST, port: 5432, database: DEMO_DB.database, tls: { mode: 'verify' }, limits: {}, auth: 'password' },
      },
      secrets: { username: DEMO_DB.username, password: DEMO_DB.password },
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
  if (!existing.has('Microsoft Graph (demo)')) {
    // Entra ID (v0.5.0): a simulated tenant – guests, a stale and a disabled account, nested groups, PIM, app credentials
    const preset = PRESETS.find((x) => x.kind === 'microsoft-graph')!;
    const g = createPlatform({
      name: 'Microsoft Graph (demo)',
      kind: 'microsoft-graph',
      environment: 'demo',
      description:
        'Simulated Entra ID tenant "Contoso (demo)" served by the built-in mock (Microsoft Graph and its sign-in): users and guests, nested groups, directory roles with PIM, app registrations whose secrets expire. See docs/ENTRA.md.',
      baseUrl: `${base}/graph`,
      config: {
        ...preset.config,
        variables: { tenantId: DEMO_GRAPH.tenantId, loginUrl: `${base}/graph/login` },
        http: { ...preset.config.http, proxy: 'none' },
      },
      secrets: { clientId: DEMO_GRAPH.clientId, clientSecret: DEMO_GRAPH.clientSecret },
    });
    for (const s of PRESET_SPECS['microsoft-graph']!()) addSpec(g.id, s.name, s.content);
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
  if (!existing.has('Container registry (demo)')) {
    // the version watch (#241): image tags from a simulated OCI registry (Docker Hub's token flow), for docker.io images
    createPlatform({
      name: 'Container registry (demo)',
      kind: CONTAINER_REGISTRY_KIND,
      environment: 'demo',
      description:
        'Simulated container registry (OCI distribution API with a token service) served by the built-in mock: tags of nginx, postgres, node and alpine for the version watch. A real installation uses Docker Hub, GHCR, Harbor …',
      baseUrl: `${base}/registry`,
      config: { auth: { type: 'none' }, variables: { registry: 'docker.io', testImage: 'library/alpine' }, http: { proxy: 'none' } },
    });
    platforms++;
  }
  // the version watch reads the simulated package registries (set once; an administrator's own choice stays)
  const { readSetting, writeSetting } = await import('../settings.js');
  if (readSetting<unknown>('catalogue.versions', null) === null) {
    const registry = db().get<{ id: string }>("SELECT id FROM platforms WHERE name = 'Container registry (demo)'");
    const { DEFAULT_VERSION_SETTINGS, PACKAGE_ECOSYSTEMS } = await import('@sm/shared');
    writeSetting('catalogue.versions', {
      ...DEFAULT_VERSION_SETTINGS,
      registries: Object.fromEntries(PACKAGE_ECOSYSTEMS.map((e) => [e, `${base}/registries/${e}`])),
      ociPlatformIds: registry ? [registry.id] : [],
    });
  }
  if (!existing.has('Web probe (demo)')) {
    createPlatform({
      name: 'Web probe (demo)',
      kind: 'generic',
      environment: 'demo',
      description:
        'Plain HTTP access without credentials to the demo applications that Gatus watches. Used by "Gatus – Diagnose an endpoint outage" to probe a failing URL.',
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
  // ---- sample applications (components read once, end-of-life data), unless switched off ----
  const applications = opts.applications === false ? 0 : await setupDemoApplications(platformByKind, currentActor());
  // ---- the watches of the simulated changedetection.io, read once and linked to the sample applications and vendors ----
  await setupChangedetectionDemo(platformByKind.get(CHANGEDETECTION_KIND), currentActor());

  const scheduleNames = new Set(listSchedules().map((x) => x.name));
  let schedules = 0;
  let runs = 0;
  for (const f of FEEDERS) {
    if (f.apps && opts.applications === false) continue;
    let def;
    try {
      def = getProcess(f.process).definition;
    } catch {
      continue; // template not imported
    }
    const bindings: Record<string, string> = {};
    for (const c of def.connections) {
      const kind = f.bind?.[c.slot] ?? c.kind;
      const pid = kind ? platformByKind.get(kind) : undefined;
      if (pid) bindings[c.slot] = pid;
    }
    if (Object.keys(bindings).length !== def.connections.length) continue;
    const name = `Demo: ${def.name}${f.label ? ` – ${f.label}` : ''}`;
    let createdNow = false;
    if (!scheduleNames.has(name)) {
      saveSchedule({ name, processId: f.process, cron: f.cron, inputs: f.inputs ?? {}, bindings, dryRun: false, enabled: true, allowOverlap: false });
      schedules++;
      createdNow = true;
    }
    // once per feeder schedule (a process with several schedules runs once per host)
    const ran = !createdNow && db().get('SELECT 1 FROM runs WHERE process_id = ? AND debug IS NULL LIMIT 1', f.process);
    if (!ran) {
      // the command layer's start check (ADR 0011): the administrator setting up the demo
      authorizeStart(undefined, { processId: f.process, bindings });
      await engine().start({ processId: f.process, bindings, inputs: f.inputs ?? {}, mode: 'live', actor: currentActor(), origin: { trigger: 'manual' } });
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

  // ---- platform costs (#226): the connectors of the demo platforms read once ----
  try {
    await (await import('../costs/demo.js')).setupCostDemo(currentActor());
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo costs not read');
  }

  // ---- access reconciliation of the simulated Insights Hub (baseline snapshot) ----
  await setupComplianceDemo(platformByKind.get('insights-hub'));
  // ---- access checks of Snowflake, AWS and GitHub, so person reviews span several platforms ----
  await setupAccessSourcesDemo(platformByKind);
  // ---- data contracts (#221): the simulated data contract service and two contracts of the shop database ----
  try {
    await seedContractDemo(base);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'data contract demo data not loaded');
  }
  // ---- the service half (U5): services from the sample applications with monitors, documents, duties, credentials …
  // A second step on request ({ services: true }: the Home page's "Load demo" and the UI tests): the server tests
  // load the demo for its platforms and processes and expect an empty catalogue and empty registers. ----
  let services = 0;
  if (opts.services && opts.applications !== false) {
    try {
      services = await (await import('../catalogue/demo.js')).setupServiceDemo();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'demo services not created');
    }
  }
  // ---- the plant registry's invented enterprise, when the module is on (plant/demo.ts) ----
  try {
    seedPlantDemo();
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'plant registry demo data not loaded');
  }

  audit({
    action: 'demo.setup',
    entityType: 'settings',
    summary: `Demo data loaded (${platforms} platforms, ${processes} processes, ${created.length} users, ${dashboards} dashboards, ${applications} applications, ${schedules} schedules, ${runs} feeder runs started, ${monitors} monitors, ${services} services)`,
  });
  return {
    platforms,
    processes,
    users: DEMO_USERS.map((u) => u.username),
    password: DEMO_USER_PASSWORD,
    dashboards,
    schedules,
    runs,
    monitors,
    applications,
    services,
  };
}

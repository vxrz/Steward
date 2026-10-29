import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Systems (#129): shared systems that applications run on, with their own tech stack and SBOM import, an optional
 * Steward platform, "runs on" links per environment, the environment of components, the configurable environment
 * list, end of life (messages and scorecard) across components and systems, the process input type application, the
 * audit trail and the public API.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => ((typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { code?: string }).code,
  );
const auditOf = (type: string, id: string) => s.api('GET', `/audit?entityType=${type}&entityId=${id}&limit=50`);

let orders: any, billing: any;
let db01: any, k8s: any;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  orders = await dana('POST', '/applications', { name: 'Orders (sys)', owners: ['user:olivia'] });
  billing = await dana('POST', '/applications', { name: 'Billing (sys)', owners: [] });
});

/** Reads the end-of-life data of the products in use from the demo's endoflife.date mock (newest cycle supported, the second ending, older ones past). */
const refresh = () => dana('POST', '/catalogue/lifecycle/refresh');
afterAll(async () => {
  await s?.app.close();
});

describe('systems', () => {
  it('designers create systems, owners change them, everyone reads them', async () => {
    expect(await status(vera('POST', '/systems', { name: 'x', kind: 'server' }))).toBe(403);
    expect(await status(olivia('POST', '/systems', { name: 'x', kind: 'server' }))).toBe(403);
    db01 = await dana('POST', '/systems', {
      name: 'db01',
      kind: 'vm',
      vendor: 'On-premises',
      cmdbUrl: 'https://cmdb.example.com/ci/db01',
      owners: ['user:olivia'],
      stack: [
        { product: 'ubuntu', version: '25.10' },
        { product: 'postgresql', version: '17.4' },
      ],
    });
    expect(db01).toMatchObject({ name: 'db01', kind: 'vm', vendor: 'On-premises', owners: ['user:olivia'], canEdit: true, applicationCount: 0 });
    await refresh();
    db01 = await dana('GET', `/systems/${db01.id}`);
    expect(Object.fromEntries(db01.stack.map((x: any) => [x.product, x.lifecycle.state]))).toEqual({ ubuntu: 'eol', postgresql: 'ending' });
    expect(db01).toMatchObject({ eol: 1, ending: 1 });
    // the owner changes it; a viewer reads it and may not
    const changed = await olivia('PUT', `/systems/${db01.id}`, {
      name: 'db01',
      kind: 'vm',
      vendor: 'On-premises',
      owners: ['user:olivia'],
      note: 'Primary database',
    });
    expect(changed.note).toBe('Primary database');
    expect(changed.stack).toHaveLength(2); // no stack given: unchanged
    expect((await vera('GET', `/systems/${db01.id}`)).canEdit).toBe(false);
    expect(await status(vera('PUT', `/systems/${db01.id}`, { name: 'db01', kind: 'vm' }))).toBe(403);
    expect(await code(dana('POST', '/systems', { name: 'DB01', kind: 'server' }))).toBe('SYSTEM_EXISTS');
    expect(await code(dana('POST', '/systems', { name: 'y', kind: 'server', stack: [{ product: 'no-such-product' }] }))).toBe('STACK_PRODUCT_UNKNOWN');
    expect(await status(dana('POST', '/systems', { name: 'y', kind: 'mainframe' }))).toBe(400);
    expect((await vera('GET', '/systems')).map((x: any) => x.name)).toContain('db01');
    const actions = (await auditOf('system', db01.id)).map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['system.created', 'system.changed']));
  });

  it('names the Steward platform it is; readers who may not see the platform see that there is one', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Kubernetes (prod)',
      kind: 'generic',
      environment: 'prod',
      baseUrl: 'http://127.0.0.1:9/api',
      config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
      secrets: {},
    });
    k8s = await dana('POST', '/systems', {
      name: 'aks-prod',
      kind: 'cluster',
      vendor: 'Azure',
      platformId: p.id,
      stack: [{ product: 'kubernetes', version: '1.36.2' }],
    });
    expect(k8s.platform).toMatchObject({ id: p.id, name: 'Kubernetes (prod)', environment: 'prod' });
    await s.api('PUT', `/platforms/${p.id}/access`, { acl: [{ subject: 'role:admin', permissions: ['use', 'manage'] }] });
    const seen = await vera('GET', `/systems/${k8s.id}`);
    expect(seen).toMatchObject({ platform: null, platformHidden: true });
    // a reader who may not see the platform keeps it when saving without it (missing: unchanged)
    await s.api('PUT', `/systems/${k8s.id}`, { name: 'aks-prod', kind: 'cluster', vendor: 'Azure', owners: ['user:dana'] });
    await dana('PUT', `/systems/${k8s.id}`, { name: 'aks-prod', kind: 'cluster', vendor: 'Azure', owners: ['user:dana'] });
    expect((await s.api('GET', `/systems/${k8s.id}`)).platform?.id).toBe(p.id);
    // choosing a platform needs to see it
    expect(await code(dana('PUT', `/systems/${k8s.id}`, { name: 'aks-prod', kind: 'cluster', platformId: 'plt_nope' }))).toBe('PLATFORM_NOT_FOUND');
  });

  it('applications run on systems per environment; the application groups them, the system lists its applications', async () => {
    expect(await status(vera('POST', `/applications/${orders.id}/systems`, { systemId: db01.id, environment: 'prod' }))).toBe(403);
    await olivia('POST', `/applications/${orders.id}/systems`, { systemId: db01.id, environment: 'prod', note: 'primary' });
    await olivia('POST', `/applications/${orders.id}/systems`, { systemId: db01.id, environment: 'test' });
    let a = await olivia('POST', `/applications/${orders.id}/systems`, { systemId: k8s.id, environment: 'prod' });
    // in the order of the environment list (dev, test, prod), then by name
    expect(a.systems.map((x: any) => [x.name, x.environment])).toEqual([
      ['db01', 'test'],
      ['aks-prod', 'prod'],
      ['db01', 'prod'],
    ]);
    expect(a.systemCount).toBe(3);
    expect(await code(olivia('POST', `/applications/${orders.id}/systems`, { systemId: db01.id, environment: 'prod' }))).toBe('SYSTEM_LINK_EXISTS');
    expect(await code(olivia('POST', `/applications/${orders.id}/systems`, { systemId: 'sys_nope', environment: 'prod' }))).toBe('SYSTEM_NOT_FOUND');
    // a shared box: Billing runs on db01 in dev
    await dana('POST', `/applications/${billing.id}/systems`, { systemId: db01.id, environment: 'dev' });
    const sys = await vera('GET', `/systems/${db01.id}`);
    expect(sys.applicationCount).toBe(2);
    expect(sys.environments).toEqual(['dev', 'test', 'prod']);
    expect(sys.applications.map((x: any) => [x.applicationName, x.environment])).toEqual([
      ['Billing (sys)', 'dev'],
      ['Orders (sys)', 'test'],
      ['Orders (sys)', 'prod'],
    ]);
    // change the environment of a link
    const link = a.systems.find((x: any) => x.name === 'db01' && x.environment === 'test');
    a = await olivia('PUT', `/applications/${orders.id}/systems/${link.id}`, { environment: 'staging', note: 'shared test box' });
    expect(a.systems.find((x: any) => x.id === link.id)).toMatchObject({ environment: 'staging', note: 'shared test box' });
    // the stack of the application includes its systems, with their environments; production marked
    const ubuntu = a.stack.find((x: any) => x.product === 'ubuntu');
    expect(ubuntu).toMatchObject({ version: '25.10', production: true, components: [] });
    expect(ubuntu.systems.map((x: any) => x.environment)).toEqual(['prod', 'staging']);
    expect(ubuntu.environments).toEqual(['prod', 'staging']);
    const actions = (await auditOf('application', orders.id)).map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['application.system_linked', 'application.system_link_changed']));
  });

  it('components have an environment; empty means all environments', async () => {
    await olivia('POST', `/applications/${orders.id}/components`, { type: 'repository', name: 'acme/orders' });
    for (const env of ['dev', 'prod'])
      await olivia('POST', `/applications/${orders.id}/components`, {
        type: 'snowflake-database',
        name: `ORDERS_${env.toUpperCase()}`,
        environment: env,
        stack: env === 'prod' ? [{ product: 'nodejs', version: '24.1.0' }] : [],
      });
    // the same name in another environment is another component
    await olivia('POST', `/applications/${orders.id}/components`, { type: 'kafka-topic', name: 'orders.v1', environment: 'dev' });
    const a = await olivia('POST', `/applications/${orders.id}/components`, { type: 'kafka-topic', name: 'orders.v1', environment: 'prod' });
    expect(await code(olivia('POST', `/applications/${orders.id}/components`, { type: 'kafka-topic', name: 'orders.v1', environment: 'prod' }))).toBe(
      'COMPONENT_EXISTS',
    );
    expect(a.components.find((c: any) => c.name === 'acme/orders').environment).toBe('');
    expect(a.components.filter((c: any) => c.name === 'orders.v1').map((c: any) => c.environment)).toEqual(['dev', 'prod']);
    expect(a.stack.find((x: any) => x.product === 'nodejs')).toMatchObject({ production: true, environments: ['prod'] });
  });

  it('the environment list: administrators change it, values in use but not listed can be adopted', async () => {
    const st = await vera('GET', '/catalogue/environments');
    expect(st.environments.map((e: any) => e.name)).toEqual(['dev', 'test', 'prod']);
    expect(st.canEdit).toBe(false);
    // "staging" is in use on a link but not on the list
    expect(st.unlisted).toContainEqual({ name: 'staging', count: 1 });
    expect(await status(dana('PUT', '/catalogue/environments', { environments: [] }))).toBe(403);
    expect(await code(s.api('PUT', '/catalogue/environments', { environments: [{ name: 'dev' }, { name: 'DEV' }] }))).toBe('ENVIRONMENT_TWICE');
    const next = await s.api('PUT', '/catalogue/environments', {
      environments: [{ name: 'dev', color: 'blue' }, { name: 'staging', color: 'yellow' }, { name: 'test' }, { name: 'prod', color: 'red', production: true }],
    });
    expect(next.unlisted.map((x: any) => x.name)).not.toContain('staging');
    // the new order applies at once
    const a = await vera('GET', `/applications/${orders.id}`);
    expect(a.systems.map((x: any) => x.environment)).toEqual(['staging', 'prod', 'prod']);
    const e = (await s.api('GET', '/audit?action=catalogue.environments_changed&limit=5'))[0];
    expect(e.summary).toContain('prod (production)');
  });

  it('imports an SBOM into a system', async () => {
    const sbom = {
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      metadata: { component: { type: 'operating-system', name: 'db01' } },
      components: [
        { type: 'operating-system', name: 'ubuntu', version: '26.04' },
        { type: 'library', name: 'left-pad', version: '1.3.0', purl: 'pkg:npm/left-pad@1.3.0' },
      ],
    };
    expect(await status(vera('POST', `/systems/${db01.id}/sbom/preview`, { sbom }))).toBe(403);
    const preview = await olivia('POST', `/systems/${db01.id}/sbom/preview`, { sbom });
    // ubuntu was entered by hand: it stays, the SBOM's version is shown
    expect(preview.changes).toContainEqual(expect.objectContaining({ product: 'ubuntu', action: 'manual', version: '25.10', other: '26.04' }));
    const r = await olivia('POST', `/systems/${db01.id}/sbom`, { sbom });
    expect(r.system.sbom).toMatchObject({ format: 'cyclonedx', name: 'db01', importedBy: 'olivia' });
    expect((await auditOf('system', db01.id)).map((x: any) => x.action)).toContain('system.sbom_imported');
  });

  it('end of life: messages name the systems with their environment, production first; the scorecard lists systems too', async () => {
    const { checkLifecycleNotices } = await import('../src/catalogue/lifecycle.js');
    const { flushNotifications } = await import('../src/notifications/service.js');
    await refresh();
    await checkLifecycleNotices();
    await new Promise((r) => setImmediate(r));
    await flushNotifications();
    const inbox = (await olivia('GET', '/notifications?limit=100')).items.filter((n: any) => n.event === 'stack.eol');
    const ubuntu = inbox.find((n: any) => n.title.includes('Ubuntu') && n.title.includes('Orders (sys)'));
    expect(ubuntu.body).toContain('db01 (prod)');
    expect(ubuntu.body).toContain('db01 (staging)');

    const svc = await dana('POST', '/services', { name: 'Orders service (sys)', owners: [] });
    await dana('PUT', `/services/${svc.id}/applications/${orders.id}`, { role: 'primary' });
    const st = await s.api('GET', '/catalogue/lifecycle');
    await s.api('PUT', '/catalogue/lifecycle', { ...st.settings, scorecard: true });
    const card = (await dana('GET', '/scorecard')).services.find((x: any) => x.serviceId === svc.id);
    const eol = card.lifecycle.items.filter((i: any) => i.state === 'eol');
    // past the end of life: production before staging
    expect(eol.filter((i: any) => i.product === 'ubuntu').map((i: any) => [i.componentName, i.holder, i.environment, i.production])).toEqual([
      ['db01', 'system', 'prod', true],
      ['db01', 'system', 'staging', false],
    ]);
    expect(card.lifecycle.items).toContainEqual(
      expect.objectContaining({ componentName: 'ORDERS_PROD', holder: 'component', environment: 'prod', production: true }),
    );
    await s.api('PUT', '/catalogue/lifecycle', { ...st.settings, scorecard: false });
  });

  it('gives processes the systems with their environment and the environment of each component', async () => {
    const p = await s.api('POST', '/processes', {
      definition: {
        name: 'Systems of an application',
        connections: [],
        inputs: [{ name: 'app', type: 'application', required: true }],
        outputs: {
          prodSystems: 'inputs.app.systems[environment="prod"].name',
          prodDb: 'inputs.app.components[type="snowflake-database" and environment="prod"].name',
          production: 'inputs.app.systems[production].environment',
        },
        nodes: [
          { id: 'start', type: 'start', x: 0, y: 0 },
          { id: 'show', type: 'log', x: 0, y: 0, message: '{{ inputs.app.name }}' },
        ],
        wires: [{ from: 'start', port: 'out', to: 'show' }],
      },
    });
    const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: {}, inputs: { app: orders.id } });
    const r = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    expect(r.status).toBe('succeeded');
    expect(r.outputs).toEqual({ prodSystems: ['aks-prod', 'db01'], prodDb: 'ORDERS_PROD', production: ['prod', 'prod'] });
    expect(r.inputs.app.systems[0]).toMatchObject({ name: 'db01', kind: 'vm', environment: 'staging', production: false });
    expect(r.inputs.app.systems[0].stack.map((x: any) => x.product).sort()).toEqual(['postgresql', 'ubuntu']);
  });

  it('shows systems and environments in the public API', async () => {
    const token = (await vera('POST', '/me/tokens', { name: 'systems', scope: 'read' })).token;
    const get = async (path: string) => (await fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
    const list = await get('/systems');
    expect(list.items.map((x: any) => x.name)).toEqual(['aks-prod', 'db01']);
    expect((await get('/systems?environment=dev')).items.map((x: any) => x.name)).toEqual(['db01']);
    const one = await get(`/systems/${db01.id}`);
    expect(one).toMatchObject({ name: 'db01', kind: 'vm', applicationCount: 2 });
    expect(one.canEdit).toBeUndefined();
    const app = await get(`/applications/${orders.id}`);
    expect(app.systemCount).toBe(3);
    expect(app.systems.map((x: any) => x.name)).toContain('aks-prod');
    expect(app.components.find((c: any) => c.name === 'ORDERS_PROD').environment).toBe('prod');
    expect((await get('/environments')).map((e: any) => e.name)).toEqual(['dev', 'staging', 'test', 'prod']);
  });

  it('a system is deleted only when no application runs on it', async () => {
    expect(await code(dana('DELETE', `/systems/${db01.id}`))).toBe('SYSTEM_IN_USE');
    const b = await dana('GET', `/applications/${billing.id}`);
    await dana('DELETE', `/applications/${billing.id}/systems/${b.systems[0].id}`);
    for (const l of (await olivia('GET', `/applications/${orders.id}`)).systems.filter((x: any) => x.systemId === db01.id))
      await olivia('DELETE', `/applications/${orders.id}/systems/${l.id}`);
    expect(await status(vera('DELETE', `/systems/${db01.id}`))).toBe(403);
    await olivia('DELETE', `/systems/${db01.id}`);
    expect(await code(vera('GET', `/systems/${db01.id}`))).toBe('SYSTEM_NOT_FOUND');
    expect((await auditOf('system', db01.id)).map((x: any) => x.action)).toContain('system.deleted');
    expect((await auditOf('application', billing.id)).map((x: any) => x.action)).toContain('application.system_unlinked');
  });
});

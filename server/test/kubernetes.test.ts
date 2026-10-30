import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { imageProduct, splitImage, tagVersion } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Kubernetes (#111): images → products, a namespace component that names its cluster and is read from the mock API
 * server (deployments, images into the tech stack, unwell pods, cert-manager certificates), own image rules, and the
 * monitor check type `kubernetes`.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let k8sId: string;
let mock: typeof import('../src/mock/mockKubernetes.js');
let eng: typeof import('../src/monitors/engine.js');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  k8sId = (await s.api('GET', '/platforms')).find((p: any) => p.name === 'Kubernetes (demo)').id;
  mock = await import('../src/mock/mockKubernetes.js');
  eng = await import('../src/monitors/engine.js');
});
afterAll(async () => {
  await s?.app.close();
});

describe('images and products', () => {
  it('reads repository and version from an image reference', () => {
    expect(splitImage('registry.example.com:5000/team/app:1.2.3@sha256:abc')).toEqual({ repository: 'registry.example.com:5000/team/app', tag: '1.2.3' });
    expect(splitImage('registry.example.com:5000/team/app')).toEqual({ repository: 'registry.example.com:5000/team/app', tag: 'latest' });
    expect(tagVersion('16.4-alpine')).toBe('16.4');
    expect(tagVersion('v2.4.1')).toBe('2.4.1');
    expect(tagVersion('latest')).toBeNull();
    expect(imageProduct('docker.io/library/postgres:16.4')).toMatchObject({ product: 'postgresql', version: '16.4' });
    expect(imageProduct('node:24-alpine')).toMatchObject({ product: 'nodejs', version: '24' });
    expect(imageProduct('grafana/grafana:11.3.0')).toMatchObject({ product: 'grafana', version: '11.3.0' });
    // the built-in list is not guessed onto other images
    expect(imageProduct('ghcr.io/acme/postgres-backup:1.0')).toBeNull();
    expect(imageProduct('ghcr.io/acme/shop-web:2.4.1')).toBeNull();
    // own rules first
    expect(imageProduct('ghcr.io/acme/shop-web:2.4.1', [{ image: 'ghcr.io/acme/shop-web', product: 'nodejs' }])).toMatchObject({
      product: 'nodejs',
      version: '2.4.1',
    });
  });
});

describe('Kubernetes namespace of an application', () => {
  it('names its cluster, reads deployments, images, pods and certificates, and fills the tech stack', async () => {
    mock.resetKubernetes();
    const app = await s.api('POST', '/applications', { name: 'Shop on Kubernetes', owners: [] });
    // a cluster must be a Kubernetes platform
    const gatus = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'gatus').id;
    await expect(
      s.api('POST', `/applications/${app.id}/components`, { type: 'kubernetes-namespace', name: 'shop-prod', environment: 'prod', platformId: gatus }),
    ).rejects.toThrow(/Kubernetes platform/);
    let a = await s.api('POST', `/applications/${app.id}/components`, {
      type: 'kubernetes-namespace',
      name: 'shop-prod',
      environment: 'prod',
      platformId: k8sId,
    });
    const cmp = a.components.find((c: any) => c.name === 'shop-prod');
    expect(cmp).toMatchObject({ platformId: k8sId, cluster: null });
    a = await s.api('POST', `/applications/${app.id}/components/${cmp.id}/cluster`, {});
    const c = a.components.find((x: any) => x.id === cmp.id);
    expect(c.cluster.error).toBeNull();
    expect(c.cluster.deployments).toEqual([
      { name: 'web', desired: 3, ready: 3, images: ['ghcr.io/acme/shop-web:2.4.1', 'nginx:1.27.3-alpine'] },
      { name: 'db', desired: 1, ready: 1, images: ['docker.io/library/postgres:16.4'] },
      { name: 'worker', desired: 2, ready: 1, images: ['node:24-alpine'] },
    ]);
    expect(c.cluster.unhealthyPods).toEqual([{ name: 'worker-5d4b-y2', reason: 'CrashLoopBackOff', restarts: 14 }]);
    expect(c.cluster.certificates.map((x: any) => [x.name, x.ready])).toEqual([
      ['shop-tls', true],
      ['api-tls', true],
    ]);
    expect(c.cluster.unmapped).toEqual(['ghcr.io/acme/shop-web:2.4.1']);
    expect(c.stack.map((x: any) => [x.product, x.version, x.source])).toEqual([
      ['nginx', '1.27.3', 'cluster'],
      ['nodejs', '24', 'cluster'],
      ['postgresql', '16.4', 'cluster'],
    ]);
    // a new image version follows; an entry entered by hand stays; an image that is gone leaves the stack
    mock.setDeployment('shop-prod', 'db', { images: ['postgres:17.2'] });
    mock.setDeployment('shop-prod', 'worker', { images: ['busybox:1.36'] });
    await s.api('PUT', `/applications/${app.id}/components/${cmp.id}`, {
      type: 'kubernetes-namespace',
      name: 'shop-prod',
      environment: 'prod',
      stack: [
        { product: 'nginx', version: '1.26' },
        { product: 'nodejs', version: '24' },
        { product: 'postgresql', version: '16.4' },
      ],
    });
    a = await s.api('POST', `/applications/${app.id}/components/${cmp.id}/cluster`, {});
    const after = a.components.find((x: any) => x.id === cmp.id);
    expect(after.stack.map((x: any) => [x.product, x.version, x.source])).toEqual([
      ['nginx', '1.26', 'manual'],
      ['postgresql', '17.2', 'cluster'],
    ]);
    expect(after.platformId).toBe(k8sId);
    const audit = await s.api('GET', `/audit?entityType=application&entityId=${app.id}&limit=50`);
    expect(audit.some((e: any) => e.action === 'application.component_cluster_read' && /postgresql|PostgreSQL/.test(e.summary))).toBe(true);
  });

  it('records why a read failed, says when cert-manager is missing, and takes own image rules', async () => {
    mock.resetKubernetes();
    const app = await s.api('POST', '/applications', { name: 'Shop test on Kubernetes', owners: [] });
    let a = await s.api('POST', `/applications/${app.id}/components`, { type: 'kubernetes-namespace', name: 'forbidden', platformId: k8sId });
    const bad = a.components[0];
    a = await s.api('POST', `/applications/${app.id}/components/${bad.id}/cluster`, {});
    expect(a.components[0].cluster.error).toMatch(/^no permission \(403\)/);
    // own rules: the shop's own image runs Node.js
    const st = await s.api('GET', '/catalogue/lifecycle');
    await s.api('PUT', '/catalogue/lifecycle', { ...st.settings, imageMap: [{ image: 'ghcr.io/acme/shop-web', product: 'nodejs' }] });
    await expect(s.api('PUT', '/catalogue/lifecycle', { ...st.settings, imageMap: [{ image: 'x', product: 'no-such-product' }] })).rejects.toThrow(
      /endoflife\.date/,
    );
    mock.setCertManager(false);
    a = await s.api('POST', `/applications/${app.id}/components`, { type: 'kubernetes-namespace', name: 'shop-test', environment: 'test', platformId: k8sId });
    const ok = a.components.find((c: any) => c.name === 'shop-test');
    a = await s.api('POST', `/applications/${app.id}/components/${ok.id}/cluster`, {});
    const c = a.components.find((x: any) => x.id === ok.id);
    expect(c.cluster.certificates).toBeNull();
    expect(c.cluster.unmapped).toEqual([]);
    expect(c.stack.map((x: any) => [x.product, x.version])).toEqual([
      ['nodejs', '2.5.0'],
      ['postgresql', '15.8'],
    ]);
    await s.api('PUT', '/catalogue/lifecycle', { ...st.settings, imageMap: [] });
  });

  it('the job reads namespaces not read for 6 hours', async () => {
    const { runKubernetesJob } = await import('../src/catalogue/kubernetes.js');
    expect(await runKubernetesJob(Date.now())).toBe(0);
    expect(await runKubernetesJob(Date.now() + 7 * 3_600_000)).toBeGreaterThanOrEqual(2);
  });
});

describe('monitor check kubernetes', () => {
  it('ready deployments are up, fewer ready or crash-looping pods degraded, none ready down', async () => {
    mock.resetKubernetes();
    const k = (id: string, extra: Record<string, unknown>) => ({
      id,
      name: id,
      type: 'kubernetes',
      platform: 'Kubernetes (demo)',
      namespace: 'shop-prod',
      ...extra,
    });
    mock.setDeployment('shop-prod', 'db', { ready: 0 });
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Shop on Kubernetes',
        failuresBeforeDown: 1,
        checks: [
          k('web', { deployment: 'web' }),
          k('worker', { deployment: 'worker' }),
          k('db', { deployment: 'db' }),
          k('all', {}),
          k('gone', { deployment: 'nope' }),
        ],
      },
    });
    await eng.evaluateMonitorNow(monitor.id);
    const m = await s.api('GET', `/monitors/${monitor.id}`);
    const st = Object.fromEntries(m.checks.map((c: any) => [c.checkId, [c.status, c.last?.message]]));
    expect(st.web).toEqual(['up', 'Kubernetes: shop-prod/web – 3/3 ready']);
    expect(st.worker).toEqual(['degraded', 'Kubernetes: shop-prod/worker – worker 1/2 ready, pod worker-5d4b-y2 CrashLoopBackOff (14 restarts)']);
    expect(st.db).toEqual(['down', 'Kubernetes: shop-prod/db – db 0/1 ready']);
    expect(st.all[0]).toBe('down');
    expect(st.gone).toEqual(['unknown', 'Kubernetes: no deployment "nope" in shop-prod']);
  });
});

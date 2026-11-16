import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * A Kubernetes namespace of an application read from a cluster whose platform turns cert-manager off (0.26.1,
 * docs/KUBERNETES.md#certificates-cert-manager), against the simulated API server (server/src/mock/mockKubernetes.ts):
 * the deployments are read, and the line says why there are no certificates.
 */
test('a namespace on a cluster without cert-manager is read, and says why there are no certificates', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const platform = await json<{ id: string }>(
    await api.post('/api/platforms', {
      data: {
        name: uniq('E2E cluster without cert-manager'),
        kind: 'kubernetes',
        baseUrl: `${baseURL()}/mock/kubernetes`,
        config: { auth: { type: 'bearer' }, variables: { certManager: 'off' }, http: { proxy: 'none' }, testPath: '/version' },
        // the simulated cluster's invented token (DEMO_KUBERNETES)
        secrets: { token: 'demo-k8s-service-account-token' },
      },
    }),
  );
  const app = await json<{ id: string }>(await api.post('/api/applications', { data: { name: uniq('E2E Shop on Kubernetes'), owners: [] } }));
  try {
    await json(
      await api.post(`/api/applications/${app.id}/components`, {
        data: { type: 'kubernetes-namespace', name: 'shop-prod', environment: 'prod', platformId: platform.id },
      }),
    );
    await page.goto(`/applications/${app.id}`);
    const panel = page.getByTestId('application-components');
    const toggle = panel.getByTestId('application-components-toggle');
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await panel.getByRole('button', { name: 'Read the namespace shop-prod from the cluster now' }).click();
    const readout = panel.getByTestId('cluster-readout');
    await expect(readout).toContainText('web 3/3, db 1/1, worker 1/2');
    await expect(readout.getByTestId('cluster-certificates')).toHaveText(
      'Certificates are not read: turned off for this cluster (platform variable certManager)',
    );
  } finally {
    await api.post(`/api/applications/${app.id}/archive`, { data: { archived: true } });
    await api.delete(`/api/platforms/${platform.id}`);
  }
});

import { test, expect } from './support/fixtures';
import { json, uniq } from './support/helpers';

/** Service status pages (#26): what a status viewer sees, and the link without sign-in. */

test('a status viewer sees only the status pages; the link works without signing in', async ({ apiAs, loginAs, browser }) => {
  const dana = await apiAs('dana');
  const services = await json<{ id: string; name: string }[]>(await dana.get('/api/services'));
  const title = uniq('Plant status');
  const page = await json<{ id: string }>(await dana.post('/api/status-pages', { data: { title, serviceIds: [services[0]!.id], notice: 'All lines run.' } }));

  const stella = await loginAs('stella');
  await expect(stella.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(stella.getByRole('button', { name: 'Sign out' })).toBeVisible();
  // no navigation, no other pages
  await expect(stella.getByRole('navigation')).toHaveCount(0);
  const refused = await stella.request.get('/api/services');
  expect(refused.status()).toBe(403);

  const { token } = await json<{ token: string }>(await dana.post(`/api/status-pages/${page.id}/link`));
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const p = await anonymous.newPage();
    await p.goto(`/status#t=${token}`);
    await expect(p.getByRole('heading', { name: title })).toBeVisible();
    await expect(p.getByText('All lines run.')).toBeVisible();
    await dana.delete(`/api/status-pages/${page.id}/link`);
    await p.reload();
    await expect(p.getByText(/not valid/)).toBeVisible();
  } finally {
    await anonymous.close();
    await dana.delete(`/api/status-pages/${page.id}`);
  }
});

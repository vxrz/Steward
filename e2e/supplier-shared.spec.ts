import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { expectAccessible } from './support/axe';
import { chooseOption, expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/**
 * Suppliers shared by services (ADR 0031, docs/SUPPLIERS.md#contracts-and-the-services-they-cover): two teams add their
 * contracts to one shared supplier and each sees only its own; a proposed service confirmed on the service page; a
 * contact scoped to a contract; a suggested pair merged by an administrator with the preview – on a desktop and on a
 * phone, with axe.
 */

interface Fixture {
  supplier: { id: string; name: string };
  shop: { id: string; name: string };
  care: { id: string; name: string };
  hosting: string;
  licences: string;
  teams: string[];
}

async function fixture(api: APIRequestContext): Promise<Fixture> {
  const team = async (name: string, members: string[]) =>
    json<{ id: string; name: string }>(await api.post('/api/teams', { data: { name: uniq(name), members } }));
  const shopTeam = await team('Shop e2e team', ['olivia']);
  const careTeam = await team('Care e2e team', ['adam']);
  const shop = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Shop e2e service'), owners: ['user:olivia'] } }));
  const care = await json<{ id: string; name: string }>(await api.post('/api/services', { data: { name: uniq('Care e2e service'), owners: ['user:adam'] } }));
  expect((await api.put(`/api/owning-teams/service/${shop.id}`, { data: { teamIds: [shopTeam.id] } })).ok()).toBe(true);
  expect((await api.put(`/api/owning-teams/service/${care.id}`, { data: { teamIds: [careTeam.id] } })).ok()).toBe(true);
  const supplier = await json<{ id: string; name: string }>(
    await api.post('/api/suppliers', { data: { name: uniq('Invented Shared Hosting AG'), type: 'managedPlatform' } }),
  );
  await json<{ contracts: { id: string; title: string }[] }>(
    await api.post(`/api/suppliers/${supplier.id}/contracts`, {
      data: {
        title: 'Shop hosting',
        owners: [`team:${shopTeam.name.toLowerCase()}`],
        services: [{ serviceId: shop.id, purpose: 'Hosting of the shop’s clusters' }],
      },
    }),
  );
  const d = await json<{ contracts: { id: string; title: string }[] }>(
    await api.post(`/api/suppliers/${supplier.id}/contracts`, {
      data: { title: 'Care licences', owners: [`team:${careTeam.name.toLowerCase()}`], services: [{ serviceId: care.id, purpose: 'Licences for 40 agents' }] },
    }),
  );
  const hosting = d.contracts.find((c) => c.title === 'Shop hosting')!.id;
  const licences = d.contracts.find((c) => c.title === 'Care licences')!.id;
  return { supplier, shop, care, hosting, licences, teams: [shopTeam.id, careTeam.id] };
}

async function cleanup(api: APIRequestContext, f: Fixture) {
  for (const c of [f.hosting, f.licences]) await api.delete(`/api/suppliers/${f.supplier.id}/contracts/${c}`);
  await api.post(`/api/suppliers/${f.supplier.id}/archive`, { data: { archived: true } });
  for (const s of [f.shop, f.care]) await api.post(`/api/services/${s.id}/archive`, { data: { archived: true } });
  for (const t of f.teams) await api.delete(`/api/teams/${t}`);
}

test('two teams on one shared supplier: each sees its own contract, a scoped contact', async ({ browser, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    // olivia (shop team) sees the shop's contract, not the care team's
    const olivia = await browser.newContext({ storageState: authFile('olivia') });
    try {
      const p = await olivia.newPage();
      await p.goto(`/suppliers/${f.supplier.id}?tab=contracts`);
      const contracts = p.getByTestId('supplier-contracts');
      await expect(contracts).toContainText('Shop hosting');
      await expect(contracts).toContainText('Hosting of the shop’s clusters');
      await expect(contracts).not.toContainText('Care licences');
      await expectAccessible(p, 'shared supplier: contracts of one team');
      // the contract page says who sees it and why
      await p.getByRole('link', { name: 'Shop hosting' }).click();
      await expect(p.getByTestId('contract-visibility')).toContainText('You see it as one of its owners.');
      // a contact scoped to her contract
      await p.getByTestId('contact-add').click();
      const dialog = p.getByRole('dialog', { name: 'Add contact' });
      await dialog.getByRole('textbox', { name: 'Name' }).fill('Hosting account manager');
      await dialog.getByRole('textbox', { name: 'E-mail' }).fill('am@hosting.example');
      await expectAccessible(p, 'shared supplier: scoped contact');
      await dialog.getByTestId('contact-save').click();
      await expect(dialog).toBeHidden();
      await expect(p.getByTestId('supplier-contacts')).toContainText('Hosting account manager');
      await expect(p.getByTestId('supplier-contacts')).toContainText('Contract: Shop hosting');
    } finally {
      await olivia.close();
    }
    // adam (care team) sees neither the shop's contract nor its contact
    const adam = await browser.newContext({ storageState: authFile('adam') });
    try {
      const p = await adam.newPage();
      await p.goto(`/suppliers/${f.supplier.id}?tab=contracts`);
      await expect(p.getByTestId('supplier-contracts')).toContainText('Care licences');
      await expect(p.getByTestId('supplier-contracts')).not.toContainText('Shop hosting');
      await p.getByTestId('supplier-tab-contacts').click();
      await expect(p.getByTestId('supplier-contacts')).not.toContainText('Hosting account manager');
      expect((await (await apiAs('adam')).get(`/api/suppliers/${f.supplier.id}/contracts/${f.hosting}`)).status()).toBe(404);
    } finally {
      await adam.close();
    }
  } finally {
    await cleanup(api, f);
  }
});

test('the service page confirms a proposed service and lists its contracts', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    // as the update proposes it: the shop is proposed for the care contract (a plan line named it)
    expect((await api.put(`/api/suppliers/${f.supplier.id}/contracts/${f.licences}/services/${f.shop.id}`, { data: { purpose: 'Chat licences' } })).ok()).toBe(
      true,
    );
    await page.goto(`/services/${f.shop.id}`);
    const section = page.getByTestId('service-suppliers');
    await expect(section).toContainText('Shop hosting');
    await expect(section).toContainText('Care licences');
    await expect(section).toContainText('Chat licences');
    await expectAccessible(page, 'service: suppliers section');
    // leave the care contract
    await section.getByTestId(`service-leave-${f.licences}`).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Leave contract' }).click();
    await expect(page.getByText('Service left the contract')).toBeVisible();
    await expect(section).not.toContainText('Care licences');
  } finally {
    await cleanup(api, f);
  }
});

test('an administrator merges a pair split by team, with the preview', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const name = uniq('Invented Pair Mail');
  const team = (await json<{ id: string }>(await api.post('/api/teams', { data: { name: uniq('Pair e2e team'), members: ['olivia'] } }))).id;
  const open = await json<{ id: string }>(await api.post('/api/suppliers', { data: { name } }));
  const scoped = await json<{ id: string }>(await api.post('/api/suppliers', { data: { name: `${name} GmbH` } }));
  expect((await api.put(`/api/owning-teams/supplier/${scoped.id}`, { data: { teamIds: [team] } })).ok()).toBe(true);
  await api.post(`/api/suppliers/${scoped.id}/contracts`, { data: { title: 'Team mail relay', owners: [] } });
  try {
    await page.goto('/suppliers?status=unconfirmed');
    const group = page.getByTestId('shared-group').filter({ hasText: `${name} GmbH` });
    await expect(group).toBeVisible();
    await expectAccessible(page, 'suppliers: same supplier in several teams');
    await group.getByTestId('shared-merge').click();
    const preview = page.getByTestId('merge-preview');
    await expect(preview).toContainText('Team mail relay');
    await expect(preview).toContainText('Gain sight of the company record');
    await expectAccessible(page, 'suppliers: merge preview');
    await page.getByTestId('merge-confirm').click();
    await expect(page.getByText('Supplier merged')).toBeVisible();
    const d = await json<{ aliases: string[]; contracts: { title: string; owners: string[] }[] }>(await api.get(`/api/suppliers/${open.id}`));
    expect(d.aliases).toContain(`${name} GmbH`);
    expect(d.contracts.find((c) => c.title === 'Team mail relay')!.owners.some((o) => o.startsWith('team:'))).toBe(true);
  } finally {
    await api.post(`/api/suppliers/${open.id}/archive`, { data: { archived: true } });
    await api.delete(`/api/teams/${team}`);
  }
});

test('the duty form offers the contracts covering the service', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  const processName = uniq('E2E supplier review');
  await json(await api.post('/api/processes', { data: { definition: { name: processName, nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }] } } }));
  const dutyName = uniq('Review of the hosting contract');
  try {
    await page.goto(`/services/${f.shop.id}/duties`);
    await page.getByTestId('duties-panel').getByRole('button', { name: 'Add duty' }).click();
    const form = page.getByRole('dialog', { name: 'Add duty' });
    await form.getByRole('textbox', { name: 'Name' }).fill(dutyName);
    await chooseOption(page, /^Process/, processName);
    await chooseOption(page, /^Supplier/, f.supplier.name);
    await chooseOption(page, /^Contract/, 'Shop hosting');
    await expectAccessible(page, 'duty form with a contract');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();
    const list = await json<{ name: string; supplierContract: { id: string } | null }[]>(await api.get(`/api/duties?serviceId=${f.shop.id}`));
    expect(list.find((d) => d.name === dutyName)?.supplierContract?.id).toBe(f.hosting);
  } finally {
    const list = await json<{ id: string; name: string }[]>(await api.get(`/api/duties?serviceId=${f.shop.id}`));
    for (const d of list.filter((x) => x.name === dutyName)) await api.delete(`/api/duties/${d.id}`);
    await cleanup(api, f);
  }
});

test('a finding naming a contract proposes its owners for the first action', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    const finding = await json<{ id: string }>(
      await api.post('/api/compliance/corrective-actions', {
        data: {
          title: uniq('Hosting SLA report missing'),
          source: 'supplierReview',
          serviceId: f.shop.id,
          supplierId: f.supplier.id,
          supplierContractId: f.hosting,
        },
      }),
    );
    const owners = (await json<{ contract: { owners: string[] } }>(await api.get(`/api/suppliers/${f.supplier.id}/contracts/${f.hosting}`))).contract.owners;
    await page.goto(`/compliance/corrective-actions/${finding.id}`);
    await page.getByTestId('ca-add-action').click();
    const action = page.getByTestId('ca-action-form');
    await expect(action).toContainText('Proposed: the owners of the contract “Shop hosting”');
    await action.getByRole('textbox', { name: 'Action' }).fill('Ask the provider for the missing report');
    await action.getByRole('button', { name: 'Save' }).click();
    await expect(action).toBeHidden();
    const saved = await json<{ actions: { owners: string[] }[] }>(await api.get(`/api/compliance/corrective-actions/${finding.id}`));
    expect(saved.actions[0]!.owners.sort()).toEqual([...owners].sort());
  } finally {
    await cleanup(api, f);
  }
});

test('a shared supplier on a phone @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  const f = await fixture(api);
  try {
    await page.goto(`/suppliers/${f.supplier.id}?tab=contracts`);
    await expect(page.getByTestId('supplier-contracts')).toContainText('Shop hosting');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'shared supplier on a phone');
    await page.goto(`/suppliers/${f.supplier.id}/contracts/${f.hosting}`);
    await expect(page.getByTestId('contract-services-section')).toContainText('Hosting of the shop’s clusters');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'supplier contract on a phone');
  } finally {
    await cleanup(api, f);
  }
});

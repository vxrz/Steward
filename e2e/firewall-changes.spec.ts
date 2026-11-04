import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { animationsDone, expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * Firewall changes (#208): a designer creates a network segment with its attributes and puts a provider-managed
 * server into it with its address, writes a firewall change with rule lines from the server's "Firewall & network"
 * panel, takes it through approval (four-eyes), implementation with evidence and verification to the close, and the
 * panel shows the approved rules once an approver confirmed the edition.
 */

const RULE = {
  change: 'add',
  source: '10.20.30.0/24',
  destination: 'srv-mes01',
  service: 'tcp/443',
  action: 'allow',
  enforcedAt: 'perimeter',
  purpose: 'MES clients',
  expiry: '',
};

test.describe('as a designer', () => {
  test.use({ storageState: authFile('dana') });

  test('a segment, a provider server in it and a firewall change through approval', async ({ page, apiAs }) => {
    test.setTimeout(120_000);
    const api = await apiAs('dana');
    const adam = await apiAs('adam');
    const olivia = await apiAs('olivia');
    const segName = uniq('E2E IoT Hall');
    const srvName = uniq('e2e-mes');
    let segmentId = '';
    let serverId = '';
    let linkId = '';
    try {
      // the segment, created on the Systems page with its attributes
      await page.goto('/systems');
      await page.getByRole('button', { name: 'New system' }).first().click();
      const form = page.getByRole('dialog', { name: 'New system' });
      await form.getByRole('textbox', { name: 'Name' }).fill(segName);
      await form.getByRole('combobox', { name: 'Kind' }).click();
      await animationsDone(page);
      await page.getByRole('option', { name: 'Network segment' }).click();
      const fields = form.getByTestId('network-fields');
      await fields.getByRole('textbox', { name: 'VLAN ID' }).fill('310');
      await fields.getByLabel('Subnets').fill('10.20.30.0/24');
      await fields.getByLabel('Subnets').press('Enter');
      await fields.getByRole('textbox', { name: 'Zone or security level' }).fill('Zone 2 – cell');
      await expectAccessible(page, 'segment dialog');
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page).toHaveURL(/\/systems\/sys_/);
      segmentId = page.url().split('/').pop()!;
      await expect(page.getByRole('heading', { name: segName })).toBeVisible();
      await expect(page.getByText('10.20.30.0/24')).toBeVisible();
      await expect(page.getByTestId('segment-members')).toContainText('No system is in this segment yet.');

      // the provider's server, put into the segment on its page
      serverId = (await json<{ id: string }>(await api.post('/api/systems', { data: { name: srvName, kind: 'server', vendor: 'NetOps GmbH (managed)' } }))).id;
      await page.goto(`/systems/${serverId}`);
      const panel = page.getByTestId('firewall-panel');
      await panel.getByRole('button', { name: 'Add to segment' }).click();
      const add = page.getByRole('dialog', { name: 'Add to segment' });
      await add.getByRole('combobox', { name: 'Network segment' }).click();
      await page.getByRole('option', { name: segName }).click();
      await add.getByRole('textbox', { name: 'Address' }).fill('10.20.30.15');
      await add.getByRole('button', { name: 'Save' }).click();
      await expect(add).toBeHidden();
      await expect(panel.getByTestId('system-segments').getByRole('row', { name: new RegExp(segName) })).toContainText('10.20.30.15');
      await expect(panel.getByTestId('approved-rules')).toContainText('No approved rules yet.');
      await expectAccessible(page, 'firewall panel');

      // a firewall change from the panel: it names the server as affected
      await panel.getByRole('button', { name: 'New firewall change' }).click();
      const create = page.getByRole('dialog', { name: `New firewall change for ${srvName}` });
      await create.getByRole('textbox', { name: 'Title' }).fill('HTTPS from Hall 3 to the MES server');
      await create.getByRole('button', { name: 'Create' }).click();
      await expect(page).toHaveURL(/\/records\/rec_[^/]+\/edit/);
      const recordId = page.url().split('/').at(-2)!;
      await page.getByRole('textbox', { name: 'Reason' }).fill('The new MES release needs HTTPS from the shopfloor clients');
      await page.getByRole('combobox', { name: 'Risk' }).click();
      await page.getByRole('option', { name: 'low' }).click();
      await page.getByRole('combobox', { name: 'Implemented by' }).click();
      await page.getByRole('option', { name: 'provider' }).click();
      await page.getByRole('textbox', { name: 'Provider ticket' }).fill('CHG-4711');
      const rules = page.getByTestId('table-field-rules');
      await rules.getByRole('button', { name: 'Add row' }).click();
      await rules.getByRole('combobox', { name: 'Change, row 1' }).click();
      await page.getByRole('option', { name: 'add', exact: true }).click();
      await rules.getByRole('textbox', { name: 'Source, row 1' }).fill(RULE.source);
      await rules.getByRole('textbox', { name: 'Destination, row 1' }).fill(RULE.destination);
      await rules.getByRole('textbox', { name: 'Protocol/port, row 1' }).fill(RULE.service);
      await rules.getByRole('combobox', { name: 'Action, row 1' }).click();
      await page.getByRole('option', { name: 'allow' }).click();
      await rules.getByRole('combobox', { name: 'Enforced at, row 1' }).click();
      await page.getByRole('option', { name: 'perimeter firewall' }).click();
      await rules.getByRole('textbox', { name: 'Purpose, row 1' }).fill(RULE.purpose);
      await expectAccessible(page, 'firewall change editor');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/records/${recordId}$`));
      const table = page.getByTestId('record-table-rules');
      await expect(table.getByRole('row', { name: /tcp\/443/ })).toContainText('perimeter firewall');
      await expect(page.getByTestId('firewall-context')).toContainText('new rule');
      await expectAccessible(page, 'firewall change');

      // requested → approved (four-eyes) → implemented with evidence → verified → closed
      await page.getByRole('button', { name: 'Submit', exact: true }).click();
      await page
        .getByRole('dialog', { name: /^Submit: FWC-/ })
        .getByRole('button', { name: 'Submit', exact: true })
        .click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Submitted');
      await json(await adam.post(`/api/records/${recordId}/transition`, { data: { action: 'approve', comment: 'Go ahead' } }));
      await json(await olivia.post(`/api/records/${recordId}/transition`, { data: { action: 'implement', comment: 'Provider: done in CHG-4711' } }));
      await json(
        await olivia.post(`/api/records/${recordId}/evidence`, {
          multipart: { file: { name: 'provider-confirmation.txt', mimeType: 'text/plain', buffer: Buffer.from('CHG-4711 implemented') } },
        }),
      );
      await page.reload();
      await page.getByRole('tab', { name: /Attachments/ }).click();
      await expect(page.getByTestId('record-evidence')).toContainText('provider-confirmation.txt');
      await page.getByRole('button', { name: 'Verify', exact: true }).click();
      const verify = page.getByRole('dialog', { name: /^Verify: FWC-/ });
      await verify.getByRole('textbox', { name: 'Comment' }).fill('curl from a Hall 3 client works');
      await verify.getByRole('button', { name: 'Verify', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Verified');
      await page.getByRole('button', { name: 'Close', exact: true }).first().click();
      await page
        .getByRole('dialog', { name: /^Close: FWC-/ })
        .getByRole('button', { name: 'Close', exact: true })
        .last()
        .click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Closed');

      // the approved rules: drafted by the close, confirmed by an approver
      await page.goto(`/systems/${serverId}`);
      const approved = page.getByTestId('approved-rules');
      await expect(approved).toContainText('next edition pending');
      const sys = await json<{ firewall: { documents: { id: string }[] } }>(await api.get(`/api/systems/${serverId}`));
      await json(await adam.post(`/api/records/${sys.firewall.documents[0]!.id}/transition`, { data: { action: 'approve' } }));
      await page.reload();
      await expect(approved).toContainText('Edition 1.0');
      await expect(approved.getByRole('row', { name: /tcp\/443/ })).toContainText('allow');
      await expect(page.getByTestId('firewall-changes')).toContainText('Closed');
      await expectAccessible(page, 'firewall panel with approved rules');
      linkId = (await json<{ segments: { id: string }[] }>(await api.get(`/api/systems/${serverId}`))).segments[0]?.id ?? '';
    } finally {
      if (serverId && linkId) await api.delete(`/api/systems/${serverId}/segments/${linkId}`);
      // the server stays (records link to it); an empty segment goes
      if (segmentId && linkId) await api.delete(`/api/systems/${segmentId}`);
    }
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });

  test('the firewall & network panel fits the screen @mobile', async ({ page, apiAs }) => {
    const api = await apiAs('dana');
    const seg = await json<{ id: string; name: string }>(
      await api.post('/api/systems', {
        data: { name: uniq('E2E IoT phone'), kind: 'network', attributes: { vlanId: 42, subnets: ['10.42.0.0/16', '2001:db8:42::/48'], zone: 'Zone 1' } },
      }),
    );
    const srv = await json<{ id: string }>(await api.post('/api/systems', { data: { name: uniq('e2e-phone-srv'), kind: 'server' } }));
    const links = await json<{ id: string }[]>(
      await api.post(`/api/systems/${srv.id}/segments`, { data: { segmentId: seg.id, address: 'srv-phone.hall3.example.com' } }),
    );
    try {
      await page.goto(`/systems/${srv.id}`);
      const panel = page.getByTestId('firewall-panel');
      await expect(panel.getByTestId('system-segments')).toContainText(seg.name);
      await expect(panel.getByRole('button', { name: 'New firewall change' })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.goto(`/systems/${seg.id}`);
      await expect(page.getByTestId('segment-members')).toContainText('srv-phone.hall3.example.com');
      await expectNoHorizontalScroll(page);
      await expectAccessible(page, 'segment on a phone');
    } finally {
      await api.delete(`/api/systems/${srv.id}/segments/${links[0]!.id}`);
      await api.delete(`/api/systems/${srv.id}`);
      await api.delete(`/api/systems/${seg.id}`);
    }
  });
});

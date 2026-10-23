import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { uniq } from './support/helpers';
import { selfSignedCertificate } from './support/selfsigned';

test.use({ storageState: authFile('dana') });

test('a designer documents an agent certificate by uploading it and sees it as due soon', async ({ page }) => {
  const name = uniq('E2E IoT2050 agent');
  const cert = selfSignedCertificate({ commonName: 'iot2050-hall3.plant.example', notAfter: new Date(Date.now() + 10 * 86400000) });
  await page.goto('/credentials');
  await expect(page.getByText('Do not enter passwords or keys')).toBeVisible();
  await page.getByRole('button', { name: 'New entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'New entry' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Type' }).click();
  await page.getByRole('option', { name: 'Agent / device certificate' }).click();
  await dialog.getByRole('textbox', { name: 'Platform (free text)' }).fill('Insights Hub');
  await dialog.getByRole('textbox', { name: 'Where it is kept' }).fill('KeePass: IT-Ops.kdbx → Insights Hub/Agents/IoT2050-hall3');
  await dialog.getByRole('textbox', { name: 'Link or path' }).fill('keepass://IT-Ops.kdbx');
  await dialog.getByRole('button', { name: 'Add owner e-mail' }).click();
  // addresses outside the allowed domains are refused with a message that names the setting
  await dialog.getByRole('textbox', { name: 'Owner e-mail' }).fill('plant.manager@outside.example');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/Allowed e-mail domains for addresses outside Steward/)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Owner e-mail' }).fill('plant.manager@example.com');

  // the certificate fills the expiry; only its metadata is kept
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'agent.pem', mimeType: 'application/x-pem-file', buffer: Buffer.from(cert.pem) });
  const preview = dialog.getByTestId('certificate-preview');
  await expect(preview).toContainText('CN=iot2050-hall3.plant.example');
  await expect(dialog.getByText('From the certificate (the earliest expiry of the chain)')).toBeVisible();

  // a secret in the notes is refused with a clear message
  await dialog.getByRole('textbox', { name: 'Notes' }).fill('password: Summer2024!');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(/looks like it contains a password or key value/)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Notes' }).fill('Renewed by the vendor portal.');
  await dialog.getByRole('button', { name: 'Save' }).click();

  // the detail drawer opens: due soon, certificate details, KeePass path shown as copyable text
  const drawer = page.getByRole('dialog', { name });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Due soon').first()).toBeVisible();
  await expect(drawer.getByText('CN=iot2050-hall3.plant.example').first()).toBeVisible();
  await expect(drawer.getByText('keepass://IT-Ops.kdbx')).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'keepass://IT-Ops.kdbx' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Mark reviewed' }).click();
  await drawer.getByRole('textbox', { name: 'Comment' }).fill('Still used by the hall 3 gateway');
  await drawer.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Review recorded')).toBeVisible();
  await expect(drawer.getByText('Still used by the hall 3 gateway')).toBeVisible();
  await page.keyboard.press('Escape');

  // the list shows the badge, and the status filter finds it
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row.getByText('Due soon')).toBeVisible();
  await page.getByRole('textbox', { name: 'Search' }).fill(name);
  await expect(page.getByRole('row').filter({ hasText: name })).toHaveCount(1);

  // and the home page lists it under "Credentials due"
  await page.goto('/');
  await expect(page.getByTestId('credentials-due').getByRole('link', { name })).toBeVisible();
});

test('a report schedule is created and generated now', async ({ page }) => {
  const name = uniq('E2E weekly service report');
  await page.goto('/reports');
  await page.getByRole('button', { name: 'New report schedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New report schedule' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByText('Weekly', { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Availability of monitors' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Credentials register' })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Runs' }).check();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Report schedule saved')).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toContainText('Weekly');
  await expect(row).toContainText('0 6 * * 1');
  await row.getByRole('button', { name: `Generate "${name}" now` }).click();
  await expect(page.getByText(`"${name}" generated`)).toBeVisible({ timeout: 30_000 });

  const generated = page.getByRole('table', { name: 'Generated reports' }).getByRole('row').filter({ hasText: name });
  await expect(generated.first()).toBeVisible();
  const link = generated.first().getByRole('link', { name: /PDF/ });
  const href = await link.getAttribute('href');
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');
  expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

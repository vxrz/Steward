import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

/**
 * Corrective actions (ADR 0029 part 3, docs/COMPLIANCE.md#corrective-actions): an accepted major incident review is
 * suggested, an administrator confirms it as a finding, adds an action (a measure of the review), marks it done and
 * the finding implemented; a second person (an approver) checks the effectiveness and the finding is closed. On a
 * phone: the register and recording a finding of an audit, with axe.
 */

/** An accepted incident review of severity major, linked to a new service; returns the review's title and the service. */
async function acceptedReview(dana: APIRequestContext, adam: APIRequestContext) {
  const service = await json<{ id: string; name: string }>(await dana.post('/api/services', { data: { name: uniq('E2E corrective service'), owners: [] } }));
  const title = uniq('Payment outage');
  const rec = await json<{ id: string; version: number }>(
    await dana.post('/api/records', { data: { type: 'PIR', title, links: [{ kind: 'service', id: service.id, note: '' }] } }),
  );
  expect(
    (
      await dana.put(`/api/records/${rec.id}`, {
        data: { fields: { incidentStart: new Date().toISOString(), severity: 'major', impact: 'Payments failed for 30 minutes' }, baseVersion: rec.version },
      })
    ).ok(),
  ).toBe(true);
  expect((await dana.post(`/api/records/${rec.id}/transition`, { data: { action: 'propose' } })).ok()).toBe(true);
  expect((await adam.post(`/api/records/${rec.id}/transition`, { data: { action: 'accept' } })).ok()).toBe(true);
  return { service, title, recordId: rec.id };
}

/** Switching a source collects the suggestions at once (instead of at the job's next hour). */
async function collectSuggestions(admin: APIRequestContext) {
  expect((await admin.put('/api/compliance/corrective-settings', { data: { sources: { incidentMinor: true } } })).ok()).toBe(true);
  expect((await admin.put('/api/compliance/corrective-settings', { data: { sources: { incidentMinor: false } } })).ok()).toBe(true);
}

test.describe('as an administrator', () => {
  test.use({ storageState: authFile('admin') });

  test('confirms a suggestion, keeps its action and has the fix checked by a second person', async ({ page, apiAs, browser }) => {
    const admin = await apiAs('admin');
    const review = await acceptedReview(await apiAs('dana'), await apiAs('adam'));
    await collectSuggestions(admin);

    // the suggestion, pre-filled from the incident review
    await page.goto('/compliance/corrective-actions/suggestions');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Corrective actions');
    const card = page.getByTestId('ca-suggestion').filter({ hasText: review.title });
    await expect(card).toContainText('Incident review');
    await expect(card).toContainText(review.service.name);
    await expectAccessible(page, 'corrective actions: suggestions');
    await card.getByTestId('ca-confirm').click();
    const form = page.getByRole('dialog', { name: 'Confirm as a finding' });
    await expect(form.getByRole('textbox', { name: 'Title' })).toHaveValue(new RegExp(review.title));
    await expect(form.getByRole('combobox', { name: 'Service' })).toHaveValue(review.service.name);
    await form.getByRole('textbox', { name: 'Cause' }).fill('The payment provider changed its certificate chain');
    await expectAccessible(page, 'corrective actions: confirm dialog');
    await form.getByRole('button', { name: 'Confirm' }).click();
    await expect(form).toBeHidden();
    await expect(page).toHaveURL(/\/compliance\/corrective-actions\/caf_/);
    await expect(page.getByTestId('ca-status').first()).toHaveText('Open');
    await expect(page.getByTestId('ca-actions')).toContainText('measures of its incident review');

    // an action – a measure of the review – owned by Olivia
    await page.getByTestId('ca-add-action').click();
    const action = page.getByRole('dialog', { name: 'Add an action' });
    await action.getByRole('textbox', { name: 'Action' }).fill('Monitor the certificate chain of the provider');
    await action.getByTestId('subjects-input').click();
    await page
      .getByRole('option', { name: /Olivia/ })
      .first()
      .click();
    await page.keyboard.press('Escape');
    await expectAccessible(page, 'corrective actions: action dialog');
    await action.getByRole('button', { name: 'Save' }).click();
    await expect(action).toBeHidden();
    const actions = page.getByTestId('ca-actions');
    await expect(actions).toContainText('Monitor the certificate chain of the provider');
    await expect(actions).toContainText('Measure of the review');
    await expect(page.getByTestId('ca-status').first()).toHaveText('In progress');
    // the measure is in the review too
    const measures = await json<{ items: { title: string }[] }>(await admin.get(`/api/records/${review.recordId}/measures`));
    expect(measures.items.map((m) => m.title)).toContain('Monitor the certificate chain of the provider');

    // done, implemented – and whoever marked it done does not check it
    // a controlled checkbox: its state follows the saved finding
    await actions.getByRole('checkbox', { name: 'Mark “Monitor the certificate chain of the provider” as done' }).click();
    await expect(actions.getByRole('checkbox', { name: 'Mark “Monitor the certificate chain of the provider” as not done' })).toBeChecked();
    await page.getByTestId('ca-implemented').click();
    await expect(page.getByTestId('ca-status').first()).toHaveText('Implemented');
    await expect(page.getByTestId('ca-check')).toHaveCount(0);
    await expect(page.getByTestId('ca-effectiveness')).toContainText('a second person checks it');
    await expectAccessible(page, 'corrective actions: finding');
    const url = page.url();

    // the approver checks the effectiveness
    const ctx = await browser.newContext({ storageState: authFile('adam'), baseURL: baseURL() });
    try {
      const ap = await ctx.newPage();
      await ap.goto(url);
      await ap.getByTestId('ca-check').click();
      const check = ap.getByRole('dialog', { name: /^Check effectiveness of CA-/ });
      await check.getByRole('textbox', { name: 'How you checked it' }).fill('Replayed the certificate change on the test system: the alert fired');
      await expectAccessible(ap, 'corrective actions: effectiveness dialog');
      await check.getByRole('button', { name: 'Record the check' }).click();
      await expect(check).toBeHidden();
      await expect(ap.getByTestId('ca-status').first()).toHaveText('Closed');
      await expect(ap.getByTestId('ca-effectiveness')).toContainText('Effective – checked by adam');
    } finally {
      await ctx.close();
    }

    // the register lists it as closed
    await page.goto('/compliance/corrective-actions');
    await expectAccessible(page, 'corrective actions: register');
    const closed = await json<{ items: { title: string; status: string }[] }>(await admin.get('/api/compliance/corrective-actions?state=closed'));
    expect(closed.items.find((f) => f.title.includes(review.title))?.status).toBe('closed');
  });
});

test.describe('on a phone', () => {
  test.use({ storageState: authFile('dana') });

  test('records a finding of an audit @mobile', async ({ page }) => {
    const title = uniq('Leavers keep VPN access');
    await page.goto('/compliance/corrective-actions');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Corrective actions');
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'corrective actions on a phone');
    await page.getByTestId('ca-new').click();
    const form = page.getByRole('dialog', { name: 'Record a finding' });
    await form.getByRole('textbox', { name: 'Title' }).fill(title);
    await form.getByRole('textbox', { name: 'What it came from' }).fill('External ISMS audit 2026, finding 7');
    await form.getByRole('textbox', { name: 'GRC reference' }).fill('RISK-ACC-12');
    await expectAccessible(page, 'record a finding on a phone');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();
    await expect(page).toHaveURL(/\/compliance\/corrective-actions\/caf_/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expectNoHorizontalScroll(page);
    await expectAccessible(page, 'a finding on a phone');
  });
});

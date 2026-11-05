import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { authFile, baseURL } from './support/env';
import { expectAccessible } from './support/axe';
import { expectNoHorizontalScroll, json, uniq } from './support/helpers';

test.use({ storageState: authFile('admin') });

/** The simulated multi-format LLM gateway (server/src/mock/mockLlmGateway.ts). */
const KEY = 'demo-llm-key';

/**
 * AI models (#216, docs/AI.md): an LLM gateway set up with the wizard (a wrong key, fixed), its models read from the
 * gateway, the allowed data; the step "Ask an AI model" in the process editor; budgets and use on the gateway's
 * AI usage tab – on a desktop and a phone.
 */
async function addGateway(page: Page, api: APIRequestContext, mobile: boolean) {
  const name = uniq('LLM gateway');
  await page.goto('/platforms');
  await page.getByRole('button', { name: 'Add platform' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a platform' });
  await expect(dialog.getByRole('region', { name: 'AI models' })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Search connectors' }).fill('llm');
  const connector = dialog.getByTestId('wizard-connector').filter({ hasText: 'LLM gateway (AI models)' });
  await expect(connector).toHaveCount(1);
  await connector.click();
  await dialog.getByRole('textbox', { name: 'Name' }).first().fill(name);
  await dialog.getByRole('textbox', { name: 'Base URL' }).fill(`${baseURL()}/mock/llm`);
  await dialog.getByLabel('API key', { exact: true }).fill('wrong-key');
  await dialog.getByTestId('wizard-create').click();
  const result = dialog.getByTestId('wizard-test-result');
  await expect(result).toContainText('Connection failed');
  await expect(result).toContainText('HTTP 401: Missing or invalid API key');
  await expectAccessible(page, 'llm wizard: wrong key');
  if (mobile) await expectNoHorizontalScroll(page);

  await dialog.getByRole('button', { name: 'Change the settings' }).click();
  await dialog.getByLabel('API key', { exact: true }).fill(KEY);
  await dialog.getByTestId('wizard-create').click();
  await expect(result).toContainText('Connection works');
  await expect(result).toContainText('lists 4 model(s) – add the models processes may use under AI models');
  await dialog.getByTestId('wizard-continue').click();
  await expect(dialog.getByTestId('platform-get-started')).toBeVisible();
  await expect(dialog.getByTestId('platform-get-started').getByText('CheckMk – AI summary of the trends')).toBeVisible();
  await expectAccessible(page, 'llm wizard: what next');
  await page.keyboard.press('Escape');

  const p = (await json<{ id: string; name: string; config: { auth: { type: string; apiKeyName?: string } } }[]>(await api.get('/api/platforms'))).find(
    (x) => x.name === name,
  )!;
  expect(p.config.auth).toMatchObject({ type: 'apiKey', apiKeyName: 'x-api-key' });

  // AI models: nothing set up, nothing allowed; read the gateway's list and set one model up
  await page.goto(`/platforms/${p.id}?tab=ai`);
  const tab = page.getByTestId('ai-models-tab');
  await expect(tab.getByText('No model set up yet')).toBeVisible();
  await expect(tab.getByTestId('ai-allowed-data')).toContainText('Nothing may be sent yet');
  await expectAccessible(page, 'ai models: empty');
  if (mobile) await expectNoHorizontalScroll(page);
  await tab.getByRole('button', { name: 'Read models from the gateway' }).click();
  const discover = page.getByRole('dialog', { name: 'Models of the gateway' });
  await expect(discover.getByTestId('ai-discovered')).toContainText('demo.converse-small-v1:0');
  await expectAccessible(page, 'ai models: discovered');
  await discover.getByRole('button', { name: 'Set up demo-messages-small' }).click();
  const model = page.getByRole('dialog', { name: 'Add model' });
  await expect(model.getByRole('textbox', { name: 'Model id' })).toHaveValue('demo-messages-small');
  await model
    .getByRole('textbox', { name: 'Request format' })
    .or(model.getByRole('combobox', { name: 'Request format' }))
    .click();
  await page.getByRole('option', { name: /^Messages \(Anthropic\)/ }).click();
  await model.getByRole('textbox', { name: 'Context window (tokens)' }).fill('32000');
  await model.getByRole('textbox', { name: 'Most output (tokens)' }).fill('1000');
  await model.getByRole('textbox', { name: 'Price per 1,000 input tokens' }).fill('0.5');
  await expectAccessible(page, 'ai models: model form');
  if (mobile) await expectNoHorizontalScroll(page);
  await model.getByRole('button', { name: 'Save' }).click();
  await expect(model).toBeHidden();
  await expect(tab.getByTestId('ai-models')).toContainText('demo-messages-small');
  await expect(tab.getByTestId('ai-models')).toContainText('Messages (Anthropic)');

  // allow the datasets of CheckMk
  const allowed = tab.getByTestId('ai-allowed-data');
  await allowed.getByRole('combobox', { name: 'Datasets' }).fill('checkmk.*');
  await allowed.getByRole('combobox', { name: 'Datasets' }).press('Enter');
  await allowed.getByRole('button', { name: 'Save allowed data' }).click();
  await expect(page.getByText('Allowed data saved')).toBeVisible();
  await expectAccessible(page, 'ai models: one model');
  if (mobile) await expectNoHorizontalScroll(page);
  const saved = await json<{ config: { ai: { models: { id: string; format: string; priceInputPer1k?: number }[]; allowedData: { datasets: string[] } } } }>(
    await api.get(`/api/platforms/${p.id}`),
  );
  expect(saved.config.ai.models).toEqual([expect.objectContaining({ id: 'demo-messages-small', format: 'anthropic-messages', priceInputPer1k: 0.5 })]);
  expect(saved.config.ai.allowedData.datasets).toEqual(['checkmk.*']);
  await api.delete(`/api/platforms/${p.id}`);
}

async function stepEditor(page: Page, mobile: boolean) {
  await page.goto('/processes/checkmk-ai-summary');
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText('CheckMk – AI summary of the trends');
  // on a phone the flow is view-only: tapping a step shows its settings
  await page.locator('.react-flow__node[data-id="summary"]').click();
  await expect(page.getByText('Ask an AI model').first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: /^Model/ })).toHaveValue('demo-chat-small');
  await expect(page.getByText('LLM gateway (demo): Chat Completions · 32,000 tokens context · at most 1,000 output')).toBeVisible();
  await expect(page.getByText('Placeholders: {{ trends }}', { exact: true })).toBeVisible();
  const ctx = page.getByTestId('ai-context');
  await expect(ctx).toHaveCount(1);
  await expect(ctx.getByRole('combobox', { name: 'Dataset key' })).toHaveValue('checkmk.trends');
  await expectAccessible(page, 'ai step editor');
  if (mobile) {
    await expectNoHorizontalScroll(page);
    return;
  }
  // a placeholder that is no context source is shown at once
  const question = page.getByRole('textbox', { name: /^Question \(user part\)/ });
  await question.fill('What about {{ other }}?');
  await expect(page.getByText('Not a context source: other.')).toBeVisible();
}

async function usageTab(page: Page, api: APIRequestContext, mobile: boolean) {
  const gw = (await json<{ id: string; name: string }[]>(await api.get('/api/platforms'))).find((x) => x.name === 'LLM gateway (demo)')!;
  // the connection test asks every model once: four calls in the usage log
  expect((await json<{ ok: boolean }>(await api.post(`/api/platforms/${gw.id}/test`))).ok).toBe(true);
  await page.goto(`/platforms/${gw.id}?tab=ai-usage`);
  const tab = page.getByTestId('ai-usage-tab');
  await expect(tab.getByTestId('ai-budget')).toHaveCount(2);
  await expect(tab.getByTestId('ai-budget').first()).toContainText('The whole installation');
  await expect(tab.getByTestId('ai-recent')).toContainText('demo.converse-small-v1:0');
  await expect(tab.getByTestId('ai-top-processes')).toContainText('Connection tests');
  await expectAccessible(page, 'ai usage');
  if (mobile) await expectNoHorizontalScroll(page);

  // the gateway's budget: 1,000,000 tokens a month, then removed again (a raise: the admin confirms it is them)
  await tab.getByRole('button', { name: /^Change the budget of This gateway/ }).click();
  const modal = page.getByRole('dialog', { name: /^Budget: This gateway/ });
  await modal.getByRole('textbox', { name: 'Tokens per month' }).fill('1000000');
  await expectAccessible(page, 'ai usage: budget form');
  await modal.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Budget saved')).toBeVisible();
  await expect(tab.getByTestId('ai-budget').nth(1)).toContainText('of 1,000,000');
  await api.put('/api/ai/budgets', { data: { scope: 'platform', scopeId: gw.id, tokensPerDay: 100000, tokensPerMonth: 1000000 } });
  await page.reload();
  await expect(tab.getByTestId('ai-budget').nth(1)).toContainText('Per day');
  await expect(tab.getByTestId('ai-process-budgets')).toBeVisible();
  if (mobile) await expectNoHorizontalScroll(page);
}

test('sets up an LLM gateway with the wizard, reads its models and allows data', async ({ page, apiAs }) => {
  await addGateway(page, await apiAs('admin'), false);
});

test('the step "Ask an AI model" in the process editor', async ({ page }) => {
  await stepEditor(page, false);
});

test('budgets and use on the AI usage tab', async ({ page, apiAs }) => {
  await usageTab(page, await apiAs('admin'), false);
});

test('AI models on a phone: the wizard, the step and the usage @mobile', async ({ page, apiAs }) => {
  const api = await apiAs('admin');
  await addGateway(page, api, true);
  await stepEditor(page, true);
  await usageTab(page, api, true);
});

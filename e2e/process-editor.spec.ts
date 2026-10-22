import fs from 'node:fs';
import { test, expect } from './support/fixtures';
import { authFile } from './support/env';
import { json, startRunFromDialog, uniq, waitForRun } from './support/helpers';

test.use({ storageState: authFile('dana') });

const HEALTH = 'Insights Hub – Platform health check';

test.describe('process editor (designer)', () => {
  test('template → edit → dry run → add node with expression help → wire → undo/redo → save → diff', async ({ page, apiAs }) => {
    test.slow();
    const name = uniq('E2E health check');

    // create from a template
    await page.goto('/processes');
    await page.getByRole('button', { name: 'From template' }).click();
    await page
      .getByRole('dialog', { name: 'Start from a template' })
      .getByRole('button', { name: `Use template ${HEALTH}` })
      .click();
    await expect(page).toHaveURL(/\/processes\/[^/]+$/);
    const processId = page.url().split('/').pop()!;
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('v1');

    // rename in the Settings tab and save v2
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('textbox', { name: /^Name/ }).first().fill(name); // the process name is the first field
    await expect(page.getByText('unsaved changes')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const save = page.getByRole('dialog', { name: 'Save new version' });
    await save.getByLabel('Change comment (optional)').fill('renamed by the UI test');
    await save.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved as version v2')).toBeVisible();
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText(name);

    // a dry run gives the editor data for the live preview
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    const runId = await startRunFromDialog(page, { dryRun: true });
    await waitForRun(await apiAs('dana'), runId, ['succeeded']);
    await page.goto(`/processes/${processId}`);

    // add a node from the palette; undo / redo
    const nodes = page.locator('.react-flow__node');
    await expect(nodes.first()).toBeVisible();
    const before = await nodes.count();
    await page.getByRole('button', { name: 'Log message' }).click();
    await expect(nodes).toHaveCount(before + 1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(nodes).toHaveCount(before);
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(nodes).toHaveCount(before + 1);

    // the redone node is not selected any more – select it on the canvas
    const logNode = nodes.filter({ hasText: 'Log message' }).last();
    await logNode.click();
    const nodeId = await page.getByRole('textbox', { name: 'Node id' }).inputValue();
    expect(nodeId).toBeTruthy();

    // expression assistant + live preview
    const message = page.getByRole('textbox', { name: /^Message/ });
    await message.click();
    await message.pressSequentially('{{ vars.');
    const suggestions = page.getByRole('listbox', { name: 'Suggestions' });
    await expect(suggestions).toBeVisible();
    await expect(suggestions.getByRole('option', { name: /idm/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await message.fill('Users: {{ vars.idm.status }}');
    const preview = page.getByTestId('expr-preview');
    await expect(preview).toContainText('Users: 200');
    await expect(preview).toContainText(`Using data of run ${runId}`);

    // wire Start → new node by dragging between the handles
    const source = page.locator('.react-flow__node[data-id="start"] .react-flow__handle.source');
    const target = page.locator(`.react-flow__node[data-id="${nodeId}"] .react-flow__handle.target`);
    await source.hover();
    await page.mouse.down();
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();

    // save v3
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('dialog', { name: 'Save new version' }).getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved as version v3')).toBeVisible();
    const saved = await json(await (await apiAs('dana')).get(`/api/processes/${processId}`));
    expect(saved.definition.nodes.find((n: { id: string }) => n.id === nodeId)?.message).toBe('Users: {{ vars.idm.status }}');
    expect(saved.definition.wires).toContainEqual(expect.objectContaining({ from: 'start', to: nodeId }));

    // version diff v2 → v3
    await page.getByRole('tab', { name: 'Versions' }).click();
    await expect(page.getByText('1 added')).toBeVisible();
    await expect(page.getByText('wires +1 −0')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'renamed by the UI test' })).toBeVisible();
    await expect(page.getByText(/message: .Users: \{\{ vars\.idm\.status \}\}/).first()).toBeVisible();
  });

  test('export YAML and import it as a new process', async ({ page }) => {
    await page.goto('/processes/ih-health-check');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export YAML' }).click()]);
    expect(download.suggestedFilename()).toBe('ih-health-check.yaml');
    const yaml = fs.readFileSync((await download.path())!, 'utf8');
    expect(yaml).toContain(`name: ${HEALTH}`);

    const name = uniq('E2E imported');
    await page.goto('/processes');
    await page.getByRole('button', { name: 'Import YAML' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import process (YAML or JSON)' });
    await dialog.getByRole('textbox').fill(yaml.replace(`name: ${HEALTH}`, `name: ${name}`));
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page).toHaveURL(/\/processes\/[^/]+$/);
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText(name);
    await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toContainText('v1');
  });
});

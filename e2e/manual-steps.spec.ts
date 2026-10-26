import { test, expect } from './support/fixtures';
import { expectAccessible } from './support/axe';
import { json, taskRegion, uniq, waitForRun } from './support/helpers';

/** A tiny valid PNG (1 × 1, transparent). */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64');

test.describe('manual steps', () => {
  test('olivia completes a manual step with a checklist, a field and an evidence file; adam verifies it', async ({ loginAs, apiAs }) => {
    // --- a process with one manual step that a second person (an approver) verifies
    const admin = await apiAs('admin');
    const name = uniq('Gateway swap');
    const proc = await json<{ id: string }>(
      await admin.post('/api/processes', {
        data: {
          definition: {
            name,
            steps: [
              {
                id: 'swap',
                type: 'userTask',
                mode: 'manual',
                title: 'Swap the gateway',
                instructions: '## On site\n\nSwitch the line to **manual mode** first.',
                checklist: ['Line switched to manual mode', 'Gateway swapped'],
                checklistAllRequired: true,
                fields: [{ id: 'serial', type: 'text', label: 'Serial number of the new gateway', use: 'required' }],
                evidence: 'optional',
                verification: { required: true, verifiers: ['role:approver'] },
              },
            ],
          },
        },
      }),
    );
    const olivia = await loginAs('olivia');
    const api = await apiAs('olivia');
    const { id: runId } = await json<{ id: string }>(await api.post('/api/runs', { data: { processId: proc.id, bindings: {} } }));
    await waitForRun(api, runId, ['waiting']);

    // --- olivia does the work
    await olivia.goto('/tasks');
    const task = taskRegion(olivia, { runId });
    await expect(task).toBeVisible();
    await expect(task.getByRole('heading', { name: 'On site' })).toBeVisible();
    await expect(task.getByText('second person verifies')).toBeVisible();
    await task.getByRole('checkbox', { name: 'Line switched to manual mode' }).check();
    await task.getByRole('checkbox', { name: 'Gateway swapped' }).check();
    await task.getByRole('textbox', { name: 'Serial number of the new gateway' }).fill('GW-2026-0042');
    await task.locator('input[type="file"]').setInputFiles({ name: 'type-label.png', mimeType: 'image/png', buffer: PNG });
    await expect(task.getByRole('link', { name: 'type-label.png' })).toBeVisible();
    await expect(task.getByText('After you complete this step, a second person must verify it')).toBeVisible();
    await expectAccessible(olivia, 'manual step (work)');
    await task.getByRole('button', { name: 'Complete step' }).click();
    await expect(olivia.getByText('Step completed – a second person verifies it now')).toBeVisible();
    // no longer hers to decide: it leaves "Mine"
    await expect(task).toBeHidden();
    expect((await waitForRun(api, runId, ['waiting'])).tasks[0].manual.stage).toBe('verify');

    // --- adam (approver) verifies
    const adam = await loginAs('adam');
    await adam.goto('/tasks');
    const check = taskRegion(adam, { runId });
    await expect(check).toBeVisible();
    await expect(check.getByText('Your verification is needed')).toBeVisible();
    await expect(check.getByText('GW-2026-0042')).toBeVisible();
    await expect(check.getByRole('list', { name: 'Checklist' }).getByRole('listitem')).toHaveCount(2);
    await expect(check.getByRole('link', { name: 'type-label.png' })).toBeVisible();
    await expect(check.getByRole('button', { name: 'Send back' })).toBeDisabled();
    await expectAccessible(adam, 'manual step (verify)');
    await check.getByLabel('Verification comment').fill('Serial matches the label');
    await check.getByRole('button', { name: 'Confirm verification' }).click();
    await expect(adam.getByText('Step verified')).toBeVisible();
    await expect(check).toBeHidden();

    // --- the run continues and records both people
    const run = await waitForRun(api, runId, ['succeeded', 'failed']);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.tasks[0].manual).toMatchObject({
      stage: 'done',
      submission: { completedBy: 'olivia', checked: [0, 1] },
      verification: { by: 'adam', approved: true, comment: 'Serial matches the label' },
    });
    await olivia.goto(`/runs/${runId}`);
    await olivia.getByRole('tab', { name: 'Decisions (1)' }).click();
    await expect(olivia.getByText(/Completed by olivia, verified by adam/)).toBeVisible();
  });

  test('the process editor starts a manual procedure and edits its steps', async ({ loginAs }) => {
    const dana = await loginAs('dana');
    await dana.goto('/processes');
    await dana.getByRole('button', { name: 'New manual procedure' }).click();
    await expect(dana).toHaveURL(/\/processes\/[^/]+$/);
    const nodes = dana.locator('.react-flow__node');
    await expect(nodes).toHaveCount(4);
    await nodes.filter({ hasText: 'Carry out the work' }).click();
    await expect(dana.getByRole('textbox', { name: 'Checklist item 1' })).toHaveValue('Work done as described');
    await expect(dana.getByRole('switch', { name: 'Verified by a second person' })).toBeChecked();
    await expect(dana.getByRole('textbox', { name: 'Label' }).first()).toHaveValue('Change ticket');
    // add a checklist item and a field
    await dana.getByRole('button', { name: 'Add item' }).click();
    await expect(dana.getByRole('textbox', { name: 'Checklist item 2' })).toHaveValue('New item');
    await dana.getByRole('button', { name: 'Add field' }).click();
    await expect(dana.getByRole('textbox', { name: 'Label' })).toHaveCount(2);
    await expect(dana.getByText('unsaved changes')).toBeVisible();
  });
});

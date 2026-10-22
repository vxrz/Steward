import { test, expect } from './support/fixtures';
import { PROCESS } from './support/env';
import { json, startRunFromDialog, taskRegion, waitForRun } from './support/helpers';

const ACCESS_REVIEW_1 = 'Insights Hub – Access review 1: flag inactive users';

test.describe('human in the loop', () => {
  test('operator starts a dry run, approver decides, auditor sees the decision', async ({ loginAs, apiAs }) => {
    // --- olivia (operator) starts "Access review 1" as a dry run
    const olivia = await loginAs('olivia');
    await olivia.goto('/processes');
    await olivia.getByRole('button', { name: `Run ${ACCESS_REVIEW_1}` }).click();
    const runId = await startRunFromDialog(olivia, { dryRun: true });
    await expect(olivia.getByRole('main').getByRole('heading', { level: 2 })).toContainText('dry run');
    const task = taskRegion(olivia, { title: /^Task: Flag \d+ inactive user\(s\)/ });
    await expect(task).toBeVisible();
    await expect(olivia.getByRole('main').getByRole('heading', { level: 2 })).toContainText('waiting');

    // --- adam (approver) gets a notification and finds the task in My tasks
    const adam = await loginAs('adam');
    await adam.goto('/tasks');
    await adam.getByRole('button', { name: /^Notifications \(\d+ unread\)/ }).click();
    const drawer = adam.getByRole('dialog', { name: /Notifications/ });
    await expect(drawer.getByRole('button', { name: /^Unread: Decision needed: Flag \d+ inactive user/ }).first()).toBeVisible();
    await adam.keyboard.press('Escape');
    await expect(drawer).toBeHidden();

    const mine = taskRegion(adam, { runId });
    await expect(mine).toBeVisible();
    await expect(mine.getByText('dry run', { exact: true })).toBeVisible();
    const count = await mine.getByRole('checkbox', { name: /^Select .+@example\.com$/ }).count();
    expect(count).toBeGreaterThan(0);
    await mine.getByLabel('Comment (stored in the protocol)').fill('checked with the team leads');
    await mine.getByRole('button', { name: `Submit selection (${count})` }).click();
    await expect(adam.getByText(`Submitted: ${count} selected`)).toBeVisible();
    await expect(mine).toBeHidden();

    // --- olivia's run page follows: succeeded, decision and report recorded
    await expect(olivia.getByRole('main').getByRole('heading', { level: 2 })).toContainText('succeeded', { timeout: 20_000 });
    await expect(olivia.getByRole('tab', { name: 'Decisions (1)' })).toBeVisible();
    await olivia.getByRole('tab', { name: 'Reports (1)' }).click();
    await expect(olivia.getByText('Users flagged for access review')).toBeVisible();
    await expect(olivia.getByText(/dry run – nothing changed/)).toBeVisible();
    await olivia.getByRole('tab', { name: 'Decisions (1)' }).click();
    await expect(olivia.getByText(`${count} item(s) selected by`)).toContainText('adam');

    // protocol (HTML) opens in a new tab and contains the decision
    await olivia.getByRole('button', { name: 'Protocol' }).click();
    const [protocol] = await Promise.all([olivia.context().waitForEvent('page'), olivia.getByRole('menuitem', { name: 'Open HTML protocol' }).click()]);
    await protocol.waitForLoadState();
    await expect(protocol.locator('body')).toContainText(ACCESS_REVIEW_1);
    await expect(protocol.locator('body')).toContainText('adam');
    await protocol.close();
    const pdf = await olivia.request.get(`/api/runs/${runId}/report.json`);
    expect(pdf.ok()).toBeTruthy();

    // --- audrey (auditor) finds the decision in the audit log; the chain is intact
    const audrey = await loginAs('audrey');
    await audrey.goto('/audit');
    const row = audrey.getByRole('row').filter({ has: audrey.locator(`a[href="/runs/${runId}"]`) }).filter({ hasText: 'task.completed' });
    await expect(row).toBeVisible();
    await expect(row).toContainText('adam');
    await expect(row).toContainText(`${count} of ${count} items selected`);
    await audrey.getByRole('button', { name: 'Verify chain' }).click();
    await expect(audrey.getByRole('alert').filter({ hasText: 'Audit chain intact' })).toBeVisible();

    // server view agrees
    const run = await json(await (await apiAs('audrey')).get(`/api/runs/${runId}`));
    expect(run.status).toBe('succeeded');
    expect(run.stats.writes).toBe(0);
    expect(run.stats.skippedWrites).toBe(count);
  });

  test('real run changes exactly what the approver selected', async ({ loginAs, apiAs }) => {
    const olivia = await loginAs('olivia');
    await olivia.goto(`/processes/${PROCESS.accessReview1}`);
    await olivia.getByRole('button', { name: 'Run', exact: true }).click();
    const dialog = olivia.getByRole('dialog', { name: /^Run: / });
    // an empty demo group, so other tests that use the default review group are not affected
    await dialog.getByLabel('Review group (display name)').fill('mdsp_usergroup:LegacyProjects');
    await dialog.getByText('Dry run – simulate all changes').click();
    await expect(dialog.getByText('This run will change data')).toBeVisible();
    const runId = await startRunFromDialog(olivia, { dryRun: false });
    await expect(olivia.getByRole('main').getByRole('heading', { level: 2 })).not.toContainText('dry run');

    const adam = await loginAs('adam');
    await adam.goto('/tasks');
    const task = taskRegion(adam, { runId });
    await expect(task).toBeVisible();
    // untick everybody, then tick exactly one user
    await task.getByRole('checkbox', { name: 'Select all' }).click();
    await expect(task.getByRole('button', { name: 'Submit selection (0)' })).toBeVisible();
    const first = task.getByRole('row').filter({ has: adam.getByRole('checkbox', { name: /^Select .+@example\.com$/ }) }).first();
    const userName = (await first.getByRole('cell').nth(1).innerText()).trim();
    await first.click();
    await task.getByRole('button', { name: 'Submit selection (1)' }).click();
    await expect(task).toBeHidden();

    const api = await apiAs('olivia');
    const run = await waitForRun(api, runId, ['succeeded', 'failed']);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.stats.writes).toBe(1);
    await expect(olivia.getByRole('main').getByRole('heading', { level: 2 })).toContainText('succeeded', { timeout: 20_000 });
    await olivia.getByRole('tab', { name: 'Reports (1)' }).click();
    await expect(olivia.getByText('Users flagged for access review')).toBeVisible();
    await expect(olivia.getByRole('tabpanel').getByRole('cell', { name: userName })).toBeVisible();
  });

  test('four-eyes: the starter may not confirm the removal', async ({ loginAs, apiAs }) => {
    const olivia = await loginAs('olivia');
    await olivia.goto(`/processes/${PROCESS.privilegedReview}`);
    await olivia.getByRole('button', { name: 'Run', exact: true }).click();
    const runId = await startRunFromDialog(olivia, { dryRun: true });

    // step 1: olivia attests (stale admins are not preselected → they will be removed)
    const attest = taskRegion(olivia, { title: /^Task: Privileged access review/ });
    await expect(attest).toBeVisible();
    await attest.getByRole('button', { name: /^Submit selection/ }).click();

    // step 2: approval with four-eyes – olivia must wait for someone else
    const confirm = taskRegion(olivia, { title: /^Task: Remove \d+ privileged assignment/ });
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText('four-eyes', { exact: true })).toBeVisible();
    await expect(confirm.getByText(/^Waiting for someone else/)).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Approve' })).toHaveCount(0);

    const adam = await loginAs('adam');
    await adam.goto(`/runs/${runId}`);
    const adamTask = taskRegion(adam, { title: /^Task: Remove \d+ privileged assignment/ });
    await adamTask.getByRole('button', { name: 'Approve' }).click();
    await expect(adam.getByText('Approved', { exact: true }).first()).toBeVisible();

    const run = await waitForRun(await apiAs('olivia'), runId, ['succeeded', 'failed']);
    expect(run.status, run.error).toBe('succeeded');
    const decided = Object.fromEntries(run.tasks.map((t: { mode: string; decidedBy: string }) => [t.mode, t.decidedBy]));
    expect(decided).toEqual({ select: 'olivia', approve: 'adam' });
    expect(run.stats.skippedWrites).toBeGreaterThan(0);
  });
});

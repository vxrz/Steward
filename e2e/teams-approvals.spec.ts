import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './support/fixtures';
import { expectAccessible, settle } from './support/axe';
import { json, uniq } from './support/helpers';

/**
 * Approvals from Microsoft Teams, stage 1 (ADR 0013): a card's Approve / Reject button opens the run with
 * `?task=…&decide=…`. The dialog opens with that choice; nothing is decided until the person confirms.
 */

async function waitingRun(admin: APIRequestContext): Promise<{ processId: string; runId: string; taskId: string; title: string }> {
  const title = uniq('Open port 443');
  const proc = await json<{ id: string }>(
    await admin.post('/api/processes', {
      data: {
        definition: {
          name: uniq('E2E card approval'),
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'ok', type: 'userTask', mode: 'approve', title, assignees: ['role:approver'], x: 1, y: 0 },
          ],
          wires: [{ from: 'start', port: 'out', to: 'ok' }],
        },
      },
    }),
  );
  const run = await json<{ id: string }>(await admin.post('/api/runs', { data: { processId: proc.id } }));
  for (let i = 0; i < 50; i++) {
    const r = await json<{ status: string; tasks: { id: string }[] }>(await admin.get(`/api/runs/${run.id}`));
    if (r.status === 'waiting' && r.tasks[0]) return { processId: proc.id, runId: run.id, taskId: r.tasks[0].id, title };
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('the run did not wait for its decision');
}

test('a link from a card opens the decision pre-selected; confirming decides, a second visit says it is decided', async ({ loginAs, apiAs }) => {
  const admin = await apiAs('admin');
  const w = await waitingRun(admin);
  try {
    const adam = await loginAs('adam');
    await adam.goto(`/runs/${w.runId}?task=${w.taskId}&decide=reject`);
    await settle(adam);
    const dialog = adam.getByRole('dialog', { name: `Reject “${w.title}”?` });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Nothing is decided until you confirm here.');
    // nothing decided by opening the link
    expect((await json<{ status: string }>(await admin.get(`/api/tasks/${w.taskId}`))).status).toBe('open');
    await expectAccessible(adam, 'decision from a card link');
    // the person may change their mind in the dialog
    await dialog.getByRole('button', { name: 'Approve instead' }).click();
    await expect(adam.getByRole('dialog', { name: `Approve “${w.title}”?` })).toBeVisible();
    await adam.getByRole('dialog').getByLabel('Comment (stored in the protocol)').fill('checked in the ticket');
    await adam.getByRole('dialog').getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(adam.getByText('Approved', { exact: true }).first()).toBeVisible();
    await expect(adam).toHaveURL((url) => url.pathname.endsWith(`/runs/${w.runId}`));
    const task = await json<{ status: string; decidedBy: string; decision: { approved: boolean; comment: string } }>(await admin.get(`/api/tasks/${w.taskId}`));
    expect(task).toMatchObject({ status: 'completed', decidedBy: 'adam', decision: { approved: true, comment: 'checked in the ticket' } });

    // the same link again: decided already
    await adam.goto(`/runs/${w.runId}?task=${w.taskId}&decide=approve`);
    await settle(adam);
    await expect(adam.getByTestId('decide-not-possible')).toBeVisible();
    await expect(adam.getByRole('dialog')).toHaveCount(0);
  } finally {
    await admin.delete(`/api/processes/${w.processId}`);
  }
});

test('a card link on a phone @mobile', async ({ loginAs, apiAs }) => {
  const admin = await apiAs('admin');
  const w = await waitingRun(admin);
  try {
    const adam = await loginAs('adam');
    await adam.goto(`/runs/${w.runId}?task=${w.taskId}&decide=approve`);
    await settle(adam);
    await expect(adam.getByRole('dialog', { name: `Approve “${w.title}”?` })).toBeVisible();
    await expectAccessible(adam, 'decision from a card link (phone)');
    await adam.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(adam.getByRole('dialog')).toHaveCount(0);
    expect((await json<{ status: string }>(await admin.get(`/api/tasks/${w.taskId}`))).status).toBe('open');
  } finally {
    await admin.post(`/api/runs/${w.runId}/cancel`, { data: {} });
    await admin.delete(`/api/processes/${w.processId}`);
  }
});

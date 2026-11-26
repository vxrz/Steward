import { beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/** The instance setting `newItemVisibility` (ADR 0042): "everyone" widens access and asks for the step-up; both ways are audited. */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let strict: Client; // administrator, confirms by hand

const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'error',
  );
const entries = async () => (await s.api('GET', '/audit?action=access.new_item_visibility_changed&limit=20')) as { details?: Record<string, unknown> }[];
const current = async () => ((await s.api('GET', '/settings/instance')) as { newItemVisibility: string }).newItemVisibility;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s, { newItemVisibility: 'owningTeams' });
  strict = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
});

describe('newItemVisibility', () => {
  it('"everyone" is refused without the step-up and nothing changes', async () => {
    await strict('DELETE', '/auth/step-up');
    expect(await current()).toBe('owningTeams');
    expect(await code(strict('PUT', '/settings/instance', { newItemVisibility: 'everyone' }))).toBe('STEP_UP_REQUIRED');
    expect(await current()).toBe('owningTeams');
    expect(await entries()).toHaveLength(0);
  });

  it('confirmed, it changes and is audited in the access family', async () => {
    await s.api('PUT', '/settings/instance', { newItemVisibility: 'everyone' });
    expect(await current()).toBe('everyone');
    const e = await entries();
    expect(e).toHaveLength(1);
    expect(e[0]!.details).toMatchObject({ before: 'owningTeams', after: 'everyone' });
  });

  it('"owning teams only" narrows: no step-up, but audited', async () => {
    await strict('DELETE', '/auth/step-up');
    expect(await code(strict('PUT', '/settings/instance', { newItemVisibility: 'owningTeams' }))).toBe('ok');
    expect(await current()).toBe('owningTeams');
    expect(await entries()).toHaveLength(2);
  });

  it('keeping the value changes nothing and writes no entry', async () => {
    await strict('DELETE', '/auth/step-up');
    expect(await code(strict('PUT', '/settings/instance', { newItemVisibility: 'owningTeams' }))).toBe('ok');
    expect(await entries()).toHaveLength(2);
  });
});

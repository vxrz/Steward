import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The integration templates of the example library (Snowflake, Git, AWS, Prometheus) end to end against the
 * built-in mocks: what they publish, what the reviewers see and what they document. examples.test.ts runs every
 * template once; this file looks at the results.
 */

let s: TestServer;
let adam: Client;
const platformByKind: Record<string, string> = {};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const demo = await s.api('POST', '/demo/setup', {});
  adam = await s.as('adam', demo.password);
  for (const p of await s.api('GET', '/platforms')) if (p.name.endsWith('(demo)')) platformByKind[p.kind] = p.id;
});
afterAll(async () => {
  await s?.app.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive a run to its end. `select` chooses the keys of a select task (default: the preselected ones); four-eyes
 * tasks and verifications are decided by Adam.
 */
async function finish(runId: string, select?: (items: any[]) => string[]): Promise<any> {
  for (let i = 0; i < 600; i++) {
    const r = await s.api('GET', `/runs/${runId}`);
    if (['succeeded', 'failed', 'cancelled'].includes(r.status)) return r;
    for (const t of r.tasks.filter((x: any) => x.status === 'open')) {
      const client = t.canDecide ? s.api : adam;
      if (t.mode === 'manual') {
        if (t.manual.stage === 'verify') await client('POST', `/tasks/${t.id}/verify`, { approved: true, comment: 'checked' });
        else
          await client('POST', `/tasks/${t.id}/complete`, {
            checked: t.manual.spec.checklist.map((_: string, n: number) => n),
            fields: t.manual.spec.fields.filter((f: any) => f.type === 'ticket').map((f: any) => ({ id: f.id, value: 'CHG0000042' })),
            notAvailable: [],
            comment: 'done in Snowflake',
          });
        continue;
      }
      const keys = t.mode === 'select' && select ? select(t.items) : t.items.filter((x: any) => x.preselected).map((x: any) => x.key);
      await client('POST', `/tasks/${t.id}/complete`, { approved: true, selectedKeys: keys, comment: 'automated test' });
    }
    await sleep(100);
  }
  throw new Error(`run ${runId} did not finish`);
}

const start = async (processId: string, bindings: Record<string, string>, inputs: Record<string, unknown> = {}, dryRun = false) =>
  (await s.api('POST', '/runs', { processId, bindings, inputs, dryRun })).id as string;

describe('Snowflake – project access review', () => {
  it('follows nested roles to the users, marks technical users and documents the revocations', async () => {
    let seen: any[] = [];
    const runId = await start('snowflake-project-access-review', { snowflake: platformByKind.snowflake! });
    const r = await finish(runId, (items) => {
      seen = items;
      // the owner keeps what is preselected; the rest is revoked
      return items.filter((x) => x.preselected).map((x) => x.key);
    });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    const keys = seen.map((x) => x.key).sort();
    expect(keys).toEqual(
      [
        'PRD_SDC_OPQ_PBI_DEV|PBI_REPORTING|Z003ABCD',
        'PRD_SDC_OPQ_PBI_DEV|PBI_REPORTING|Z006MNOP',
        'PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READONLY|SVC_PBI_GATEWAY',
        'PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READONLY|Z003ABCD',
        'PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READONLY|Z004EFGH',
        'PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READWRITE|SVC_PBI_ETL',
        'PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READWRITE|Z005IJKL',
        'PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READWRITE|Z007QRST',
      ].sort(),
    );
    // recently active people and technical users are preselected; the inactive, the disabled and the never active are not
    const pre = Object.fromEntries(seen.map((x) => [x.key.split('|').slice(1).join('|'), x.preselected]));
    expect(pre).toMatchObject({
      'PRD_SDC_OPQ_PBI_DEV_READONLY|Z003ABCD': true,
      'PRD_SDC_OPQ_PBI_DEV_READONLY|SVC_PBI_GATEWAY': true,
      'PRD_SDC_OPQ_PBI_DEV_READWRITE|SVC_PBI_ETL': true,
      'PRD_SDC_OPQ_PBI_DEV_READONLY|Z004EFGH': false, // 200 days
      'PRD_SDC_OPQ_PBI_DEV_READWRITE|Z005IJKL': false, // disabled
      'PBI_REPORTING|Z006MNOP': false, // 91 days
    });

    // the data set: paths through the nested roles, the type, the review result
    const d = await s.api('GET', '/datasets/snowflake.project-access');
    const by = Object.fromEntries(d.rows.map((x: any) => [x._key, x]));
    expect(by['PRD_SDC_OPQ_PBI_DEV|PBI_REPORTING|Z006MNOP']).toMatchObject({
      Path: 'PRD_SDC_OPQ_PBI_DEV_READONLY ← PBI_REPORTING ← Z006MNOP',
      'Database role': 'PRD_SDC_OPQ_PBI_DEV_READONLY',
      Privileges: 'USAGE, MONITOR',
      Name: 'Mia Neumann',
      'E-mail': 'mia.neumann@example.com',
      Type: 'person',
      Days: 91,
      Review: 'revoked',
      _status: 'warning',
    });
    expect(by['PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READWRITE|Z005IJKL']).toMatchObject({ Type: 'disabled', Review: 'revoked', _status: 'critical' });
    expect(by['PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READWRITE|SVC_PBI_ETL']).toMatchObject({
      Type: 'technical',
      'Sign-in': 'password, no MFA',
      Review: 'kept',
      _status: 'warning',
    });
    expect(by['PRD_SDC_OPQ_PBI_DEV|PRD_SDC_OPQ_PBI_DEV_READONLY|SVC_PBI_GATEWAY']).toMatchObject({ Type: 'technical', 'Sign-in': 'key pair' });
    expect(d.metrics).toMatchObject({ grants: 8, users: 7, people: 4, technical: 2, disabled: 1, inactive: 2, revoked: 3 });

    // four-eyes by Adam, the REVOKE statements in the manual step (quoted identifiers), verified by a second person
    const confirm = r.tasks.find((t: any) => t.mode === 'approve');
    expect(confirm).toMatchObject({ decidedBy: 'adam', fourEyes: true });
    const manual = r.tasks.find((t: any) => t.mode === 'manual');
    expect(manual.instructions).toContain('REVOKE ROLE "PRD_SDC_OPQ_PBI_DEV_READWRITE" FROM USER "Z005IJKL";');
    expect(manual.instructions).toContain('REVOKE ROLE "PBI_REPORTING" FROM USER "Z006MNOP";');
    expect(manual.instructions).toContain('REVOKE ROLE "PRD_SDC_OPQ_PBI_DEV_READONLY" FROM USER "Z004EFGH";');
    // SYSADMIN (through the owner role) is account administration: named, not followed
    expect(manual.instructions).not.toContain('BOB');
    // the entries are created once the run's protocol is archived
    let list: any[] = [];
    for (let i = 0; i < 100 && list.length < 3; i++) {
      list = (await s.api('GET', `/compliance/access-changes?platformId=${platformByKind.snowflake}`)).filter((e: any) => e.runId === runId);
      if (list.length < 3) await sleep(200);
    }
    expect(list.map((e: any) => [e.subjectId, e.kind, e.revoked]).sort()).toEqual([
      ['Z004EFGH', 'revoke', ['role:PRD_SDC_OPQ_PBI_DEV_READONLY']],
      ['Z005IJKL', 'revoke', ['role:PRD_SDC_OPQ_PBI_DEV_READWRITE']],
      ['Z006MNOP', 'revoke', ['role:PBI_REPORTING']],
    ]);
  });

  it('refuses database names that are no Snowflake identifiers', async () => {
    const r = await finish(
      await start('snowflake-project-access-review', { snowflake: platformByKind.snowflake! }, { databases: ['SHOP"; DROP DATABASE X; --'] }),
    );
    expect(r.status).toBe('failed');
    expect(r.steps.find((x: any) => x.stepId === 'valid').status).toBe('failed');
    // nothing was sent to Snowflake
    expect(r.steps.some((x: any) => x.stepId === 'show')).toBe(false);
  });
});

describe('Snowflake – account hygiene and usage', () => {
  it('finds inactive people, passwords without MFA, technical users with passwords, admins, disabled users with roles and failed tasks', async () => {
    const r = await finish(await start('snowflake-account-hygiene', { snowflake: platformByKind.snowflake! }, { maxCredits7d: 20 }));
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    const checks = Object.fromEntries(r.steps.filter((x: any) => x.type === 'check').map((x: any) => [x.stepId, x.status]));
    expect(checks).toEqual({
      noInactive: 'failed',
      mfa: 'failed',
      servicePasswords: 'failed',
      admins: 'succeeded',
      disabled: 'failed',
      tasksOk: 'failed',
      creditsOk: 'failed',
    });
    const users = await s.api('GET', '/datasets/snowflake.users');
    const by = Object.fromEntries(users.rows.map((x: any) => [x._key, x]));
    expect(by.Z004EFGH).toMatchObject({ Type: 'person', 'Sign-in': 'password, no MFA', _status: 'warning' });
    expect(by.Z004EFGH.Findings).toBe('no login for 200 days; password without MFA');
    expect(by.Z005IJKL).toMatchObject({ Type: 'disabled', Roles: 'PRD_SDC_OPQ_PBI_DEV_READWRITE', _status: 'critical' });
    expect(by.SVC_PBI_ETL).toMatchObject({ Type: 'technical', Findings: 'technical user with a password' });
    expect(by.SVC_PBI_GATEWAY).toMatchObject({ Type: 'technical', 'Sign-in': 'key pair', Findings: '–', _status: 'good' });
    expect(by.BREAKGLASS_ADMIN).toMatchObject({ Type: 'person', 'Last login': 'never' });
    expect(users.metrics).toMatchObject({
      users: 12,
      inactive: 3, // Hans Ilg (200 days), Mia Neumann (91), BREAKGLASS_ADMIN (never); Karla Lang is disabled
      passwordNoMfa: 1,
      servicePasswords: 1, // OLD_BI is disabled
      disabledWithRoles: 2, // OLD_BI and Karla Lang
      accountAdmins: 2,
      securityAdmins: 1,
    });
    const credits = await s.api('GET', '/datasets/snowflake.credits');
    expect(credits.metrics).toMatchObject({ warehouses: 4, credits7d: 47.25, credits30d: 182.25, failedTasks: 1 });
    expect(credits.rows.find((x: any) => x._key === 'TRANSFORM_WH')).toMatchObject({ 'Credits (7 days)': 31.25, _status: 'warning' });
    const tasks = await s.api('GET', '/datasets/snowflake.tasks');
    expect(tasks.rows).toEqual([expect.objectContaining({ Task: 'SHOP.STAGING.LOAD_EVENTS', _status: 'critical' })]);
  });
});

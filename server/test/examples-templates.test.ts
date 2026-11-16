import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { timeLimit } from './time.js';

/**
 * The integration templates of the example library (Snowflake, Git, AWS, Prometheus) end to end against the
 * built-in mocks: what they publish, what the reviewers see and what they document. examples.test.ts runs every
 * template once; this file looks at the results.
 */

// the time limit of one expression is wall-clock time: on a loaded machine the demo's Checkmk trend summary took longer
// than its 5 s and its dataset stayed empty – the limit is not what these tests look at (expr-guard.test.ts does)
process.env.SM_EXPR_TIMEOUT_MS ??= String(timeLimit(15_000));

let s: TestServer;
let adam: Client;
const platformByKind: Record<string, string> = {};
/** The feeder runs the demo started (they publish the datasets of its dashboards) */
let feederRuns: string[] = [];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const demo = await s.api('POST', '/demo/setup', {});
  // every feeder run is started (queued) before the demo's setup answers
  feederRuns = ((await s.api('GET', '/runs?limit=200')) as { id: string }[]).map((r) => r.id);
  expect(feederRuns.length).toBeGreaterThanOrEqual(demo.runs);
  adam = await s.as('adam', demo.password);
  for (const p of await s.api('GET', '/platforms')) if (p.name.endsWith('(demo)')) platformByKind[p.kind] = p.id;
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

describe('demo data', () => {
  it('fills the dashboards of every example from the sample applications and the simulated platforms', async () => {
    // until each feeder run has ended – however long a loaded machine takes (within the test's time limit) – not a
    // fixed time: a dataset exists once its run has published it
    for (let open = feederRuns; open.length; await sleep(200)) {
      const ended = new Set(
        ((await s.api('GET', '/runs?limit=200')) as { id: string; status: string }[])
          .filter((r) => ['succeeded', 'failed', 'cancelled'].includes(r.status))
          .map((r) => r.id),
      );
      open = open.filter((id) => !ended.has(id));
    }
    const apps = (await s.api('GET', '/applications')).map((a: any) => a.name);
    expect(apps).toEqual(expect.arrayContaining(['Webshop (demo)', 'CRM (demo)']));
    const empty: string[] = [];
    for (const key of [
      'eol-overview',
      'kafka.topics',
      'aws.iam-keys',
      'aws.costs',
      'snowflake.users',
      'snowflake.credits',
      'snowflake.cost-services',
      'snowflake.cost-warehouses',
      'snowflake.cost-storage',
      'snowflake.waste',
      'prom.slo',
      'k8s.health',
      'checkmk.trends',
      'dt.vulnerabilities',
      'git.repositories',
    ])
      if (!((await s.api('GET', `/datasets/${key}`).catch(() => null))?.rowCount > 0)) empty.push(key);
    // when a dataset stays empty, say which demo runs did not succeed and why (a failure on a busy CI runner)
    const unfinished = empty.length
      ? ((await s.api('GET', '/runs?limit=200')) as { id: string; processName: string; status: string; error?: string | null }[])
          .filter((r) => feederRuns.includes(r.id) && r.status !== 'succeeded')
          .map((r) => `${r.processName}: ${r.status}${r.error ? ` – ${r.error}` : ''}`)
      : [];
    expect(empty, unfinished.join('\n')).toEqual([]);
    const repos = await s.api('GET', '/datasets/git.repositories');
    expect(new Set(repos.rows.map((r: any) => r.Host))).toEqual(new Set(['GitHub', 'GitLab', 'Forgejo']));
    // the end of life of the stacks read from the repository and the namespace
    const eol = await s.api('GET', '/datasets/eol-overview');
    expect(eol.rows.some((r: any) => r.Application === 'Webshop (demo)' && r._status !== 'unknown')).toBe(true);
    // (a run a demo schedule started meanwhile may still be running: the demo's own runs are the ones that count)
    const runs = (await s.api('GET', '/runs?limit=200')).filter((r: any) => feederRuns.includes(r.id) && r.status !== 'succeeded');
    expect(runs.map((r: any) => `${r.processName}: ${r.status} ${r.error ?? ''}`)).toEqual([]);
  }, 600_000);

  it('person reviews find a person on several platforms of the demo', async () => {
    const checks = (await s.api('GET', '/compliance/access-checks')) as any[];
    // the Insights Hub check stays the first one
    expect(checks[0].source).toBe('insights-hub');
    const id = (source: string) => checks.find((c) => c.source === source).id;
    const karla = await s.api('POST', '/compliance/person-reviews', {
      title: 'Leaver Karla Lang',
      personName: 'Karla Lang',
      identifiers: ['karla.lang@example.com'],
      checkIds: [id('insights-hub'), id('snowflake')],
    });
    expect(karla.sources.map((x: any) => [x.source, x.matched])).toEqual([
      ['insights-hub', 1],
      ['snowflake', 1],
    ]);
    const bob = await s.api('POST', '/compliance/person-reviews', {
      title: 'Review Bob',
      personName: 'Bob',
      identifiers: ['bob@example.com', 'bob'],
      checkIds: [id('snowflake'), id('git'), id('aws')],
    });
    expect(bob.sources.map((x: any) => [x.source, x.matched])).toEqual([
      ['snowflake', 1],
      ['git', 1],
      ['aws', 0],
    ]);
  });
});

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
        'PRJ_SALES_INSIGHTS_DEV|PBI_REPORTING|EMP10003',
        'PRJ_SALES_INSIGHTS_DEV|PBI_REPORTING|EMP10006',
        'PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READONLY|SVC_PBI_GATEWAY',
        'PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READONLY|EMP10003',
        'PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READONLY|EMP10004',
        'PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READWRITE|SVC_PBI_ETL',
        'PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READWRITE|EMP10005',
        'PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READWRITE|EMP10007',
      ].sort(),
    );
    // recently active people and technical users are preselected; the inactive, the disabled and the never active are not
    const pre = Object.fromEntries(seen.map((x) => [x.key.split('|').slice(1).join('|'), x.preselected]));
    expect(pre).toMatchObject({
      'PRJ_SALES_INSIGHTS_DEV_READONLY|EMP10003': true,
      'PRJ_SALES_INSIGHTS_DEV_READONLY|SVC_PBI_GATEWAY': true,
      'PRJ_SALES_INSIGHTS_DEV_READWRITE|SVC_PBI_ETL': true,
      'PRJ_SALES_INSIGHTS_DEV_READONLY|EMP10004': false, // 200 days
      'PRJ_SALES_INSIGHTS_DEV_READWRITE|EMP10005': false, // disabled
      'PBI_REPORTING|EMP10006': false, // 91 days
    });

    // the data set: paths through the nested roles, the type, the review result
    const d = await s.api('GET', '/datasets/snowflake.project-access');
    const by = Object.fromEntries(d.rows.map((x: any) => [x._key, x]));
    expect(by['PRJ_SALES_INSIGHTS_DEV|PBI_REPORTING|EMP10006']).toMatchObject({
      Path: 'PRJ_SALES_INSIGHTS_DEV_READONLY ← PBI_REPORTING ← EMP10006',
      'Database role': 'PRJ_SALES_INSIGHTS_DEV_READONLY',
      Privileges: 'USAGE, MONITOR',
      Name: 'Mia Neumann',
      'E-mail': 'mia.neumann@example.com',
      Type: 'person',
      Days: 91,
      Review: 'revoked',
      _status: 'warning',
    });
    expect(by['PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READWRITE|EMP10005']).toMatchObject({ Type: 'disabled', Review: 'revoked', _status: 'critical' });
    expect(by['PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READWRITE|SVC_PBI_ETL']).toMatchObject({
      Type: 'technical',
      'Sign-in': 'password, no MFA',
      Review: 'kept',
      _status: 'warning',
    });
    expect(by['PRJ_SALES_INSIGHTS_DEV|PRJ_SALES_INSIGHTS_DEV_READONLY|SVC_PBI_GATEWAY']).toMatchObject({ Type: 'technical', 'Sign-in': 'key pair' });
    expect(d.metrics).toMatchObject({ grants: 8, users: 7, people: 4, technical: 2, disabled: 1, inactive: 2, revoked: 3 });

    // four-eyes by Adam, the REVOKE statements in the manual step (quoted identifiers), verified by a second person
    const confirm = r.tasks.find((t: any) => t.mode === 'approve');
    expect(confirm).toMatchObject({ decidedBy: 'adam', fourEyes: true });
    const manual = r.tasks.find((t: any) => t.mode === 'manual');
    expect(manual.instructions).toContain('REVOKE ROLE "PRJ_SALES_INSIGHTS_DEV_READWRITE" FROM USER "EMP10005";');
    expect(manual.instructions).toContain('REVOKE ROLE "PBI_REPORTING" FROM USER "EMP10006";');
    expect(manual.instructions).toContain('REVOKE ROLE "PRJ_SALES_INSIGHTS_DEV_READONLY" FROM USER "EMP10004";');
    // SYSADMIN (through the owner role) is account administration: named, not followed
    expect(manual.instructions).not.toContain('BOB');
    // the entries are created once the run's protocol is archived
    let list: any[] = [];
    for (let i = 0; i < 100 && list.length < 3; i++) {
      list = (await s.api('GET', `/compliance/access-changes?platformId=${platformByKind.snowflake}`)).filter((e: any) => e.runId === runId);
      if (list.length < 3) await sleep(200);
    }
    expect(list.map((e: any) => [e.subjectId, e.kind, e.revoked]).sort()).toEqual([
      ['EMP10004', 'revoke', ['role:PRJ_SALES_INSIGHTS_DEV_READONLY']],
      ['EMP10005', 'revoke', ['role:PRJ_SALES_INSIGHTS_DEV_READWRITE']],
      ['EMP10006', 'revoke', ['role:PBI_REPORTING']],
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
    expect(by.EMP10004).toMatchObject({ Type: 'person', 'Sign-in': 'password, no MFA', _status: 'warning' });
    expect(by.EMP10004.Findings).toBe('no login for 200 days; password without MFA');
    expect(by.EMP10005).toMatchObject({ Type: 'disabled', Roles: 'PRJ_SALES_INSIGHTS_DEV_READWRITE', _status: 'critical' });
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

describe('Snowflake – cost estimate and trend', () => {
  const checksOf = (r: any) => Object.fromEntries(r.steps.filter((x: any) => x.type === 'check').map((x: any) => [x.stepId, x.status]));
  const near = (a: number, b: number, eps = 0.05) => expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThanOrEqual(eps);

  it('publishes the month so far, the projection and the previous month per service type, warehouse, database and query tag', async () => {
    const inputs = { monthlyBudget: 100, growthPercent: 5, minGrowthCost: 0, pricePerCredit: 2.5, currency: 'EUR' };
    const r = await finish(await start('snowflake-cost-estimate', { snowflake: platformByKind.snowflake! }, inputs));
    expect([r.status, r.error]).toEqual(['succeeded', null]);

    const services = await s.api('GET', '/datasets/snowflake.cost-services');
    const m = services.metrics;
    expect(services.rows.map((x: any) => x.Service)).toEqual(
      expect.arrayContaining(['Warehouses', 'Serverless tasks', 'Snowpipe', 'Automatic clustering', 'Materialised views', 'Search optimisation', 'Storage']),
    );
    // the account total is the sum of the service types and storage; credits × the price per credit
    near(
      m.projectedCost,
      services.rows.reduce((n: number, x: any) => n + x['Projected cost'], 0),
    );
    near(m.computeProjectedCost + m.serverlessProjectedCost + m.storageProjectedCost, m.projectedCost);
    const pipe = services.rows.find((x: any) => x._key === 'PIPE');
    near(pipe['Cost this month'], pipe['Credits this month'] * 2.5);
    expect(pipe.Currency).toBe('EUR');
    // the warehouses' cloud services above 10 % of their compute are billed, the rest is the adjustment
    expect(services.rows.find((x: any) => x._key === 'WAREHOUSE_METERING')['Cloud services adjustment']).toBeLessThanOrEqual(0);
    expect(m.budget).toBe(100);

    const wh = await s.api('GET', '/datasets/snowflake.cost-warehouses');
    const by = Object.fromEntries(wh.rows.map((x: any) => [x._key, x]));
    expect(Object.keys(by).sort()).toEqual(['BI_WH', 'PBI_WH', 'TRANSFORM_WH', 'UNUSED_WH']);
    for (const x of wh.rows) {
      // projected = the complete days so far + the daily average of the last 7 days × the days left (today included)
      near(x['Projected credits'], x['Credits this month'] + x['Credits per day (run rate)'] * m.daysLeft, 0.2);
      near(x['Credits this month'], x['Compute credits this month'] + x['Cloud services credits this month']);
      // warns when the projection grows by more than 5 % against last month (no minimum cost)
      expect(x._status, x._key).toBe(x['Change (%)'] > 5 ? 'warning' : 'good');
    }
    // PBI_WH runs twice as much as before (whatever the month), UNUSED_WH has stopped
    expect(by.PBI_WH._status).toBe('warning');
    expect(by.UNUSED_WH).toMatchObject({ 'Credits per day (run rate)': 0, _status: 'good' });

    const storage = await s.api('GET', '/datasets/snowflake.cost-storage');
    const st = Object.fromEntries(storage.rows.map((x: any) => [x._key, x]));
    expect(Object.keys(st).sort()).toEqual(['(stages)', 'CRM', 'PRJ_SALES_INSIGHTS_DEV', 'SHOP']);
    expect(st.SHOP).toMatchObject({ 'Size (TB)': 2.395, 'Fail-safe (TB)': 0.299 });
    expect(storage.metrics).toMatchObject({ databases: 3 });
    near(
      m.storageProjectedCost,
      storage.rows.reduce((n: number, x: any) => n + x['Projected cost'], 0),
    );

    const attribution = await s.api('GET', '/datasets/snowflake.cost-attribution');
    expect(attribution.metrics).toMatchObject({ available: 1, users: 5, tags: 4 });
    expect(attribution.rows.map((x: any) => x._key)).toEqual(expect.arrayContaining(['dbt_nightly|ETL_SVC', '(no tag)|ALICE', 'powerbi|SVC_PBI_GATEWAY']));
    // the nightly dbt runs spend 55 % of the transformation warehouse's compute
    near(attribution.rows.find((x: any) => x._key === 'dbt_nightly|ETL_SVC')['Credits this month'], by.TRANSFORM_WH['Compute credits this month'] * 0.55);

    const checks = checksOf(r);
    expect(checks.budget).toBe('failed');
    expect(checks.rowsGrowth).toBe('failed');
    expect(checks.growth).toBe(m.changePct > 5 ? 'failed' : 'succeeded');
    const budget = r.steps.find((x: any) => x.stepId === 'budget');
    expect(budget.summary).toMatch(
      /^✘ Projected [\d.]+ EUR for the month \(budget 100 EUR, [\d.]+ EUR so far, \d+ days left, budget (already used up|used up around \d+ \w+)/,
    );
  });

  it('a budget above the projection and a generous threshold pass; without a budget the budget check is skipped', async () => {
    const r = await finish(await start('snowflake-cost-estimate', { snowflake: platformByKind.snowflake! }, { monthlyBudget: 1_000_000, growthPercent: 1000 }));
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(checksOf(r)).toEqual({ budget: 'succeeded', growth: 'succeeded', rowsGrowth: 'succeeded' });
    const plain = await finish(await start('snowflake-cost-estimate', { snowflake: platformByKind.snowflake! }, { growthPercent: 1000 }));
    expect(checksOf(plain).budget).toBe('skipped');
  });
});

describe('Snowflake – waste check', () => {
  const checksOf = (r: any) => Object.fromEntries(r.steps.filter((x: any) => x.type === 'check').map((x: any) => [x.stepId, x.status]));

  it('finds idle, late-suspending and oversized warehouses, unread tables, time travel, failing tasks and pipes, unread serverless objects and long failed queries', async () => {
    const r = await finish(await start('snowflake-waste-check', { snowflake: platformByKind.snowflake! }));
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(checksOf(r)).toEqual({
      idleOk: 'failed',
      autoSuspendOk: 'failed',
      sizeOk: 'failed',
      tablesRead: 'failed',
      retentionOk: 'failed',
      failingOk: 'failed',
      featuresOk: 'failed',
      longQueriesOk: 'failed',
      accessHistory: 'succeeded',
    });
    const d = await s.api('GET', '/datasets/snowflake.waste');
    const by = Object.fromEntries(d.rows.map((x: any) => [x._key, x]));
    expect(by['Idle warehouse|UNUSED_WH']).toMatchObject({ 'Saving per month (credits)': 3, 'Saving per month': 9, _status: 'warning' });
    // 1800 s: two thirds of its metered hours ran no query, 60 s would save all but 60/1800 of that
    expect(by['Auto-suspend|BI_WH']).toMatchObject({
      'Saving per month (credits)': 25.78,
      'SQL to consider': 'ALTER WAREHOUSE "BI_WH" SET AUTO_SUSPEND = 60;',
    });
    expect(by['Auto-suspend|PBI_WH'].Reason).toMatch(/^auto-suspend is off/);
    expect(by['Oversized warehouse|BI_WH']).toMatchObject({
      'Saving per month (credits)': 20,
      'SQL to consider': `ALTER WAREHOUSE "BI_WH" SET WAREHOUSE_SIZE = 'MEDIUM';`,
    });
    expect(by['Oversized warehouse|PBI_WH']['SQL to consider']).toContain("WAREHOUSE_SIZE = 'XSMALL'");
    // TRANSFORM_WH spills and runs long queries: right-sized
    expect(Object.keys(by).filter((k) => k.endsWith('|TRANSFORM_WH'))).toEqual([]);
    expect(by['Table not read|SHOP.STAGING.RAW_EVENTS_2024']).toMatchObject({ 'Saving per month (credits)': '–', 'Saving per month': 11.04 });
    expect(by['Table not read|CRM.CORE.CONTACTS_BACKUP_2025']).toBeTruthy();
    expect(by['Table not read|SHOP.SALES.ORDERS']).toBeUndefined();
    expect(by['Time travel and fail-safe|SHOP.STAGING.RAW_EVENTS']['SQL to consider']).toBe(
      'ALTER TABLE "SHOP"."STAGING"."RAW_EVENTS" SET DATA_RETENTION_TIME_IN_DAYS = 1;',
    );
    expect(by['Failing task|SHOP.STAGING.LOAD_EVENTS']).toMatchObject({ 'Saving per month (credits)': 9 });
    // a task on a warehouse: its credits are the warehouse's, no saving of its own
    expect(by['Failing task|CRM.CORE.SYNC_CONTACTS']).toMatchObject({ 'Saving per month (credits)': '–', 'Saving per month': '–' });
    expect(by['Failing pipe|SHOP.STAGING.EVENTS_PIPE']).toMatchObject({ 'Saving per month (credits)': 3.38 });
    expect(by['Serverless feature, rarely read|SHOP.REPORTING.ORDER_FACTS']['SQL to consider']).toContain('SUSPEND RECLUSTER');
    expect(by['Serverless feature, rarely read|SHOP.REPORTING.DAILY_REVENUE_MV']).toBeTruthy();
    // search optimisation on ORDERS serves thousands of queries
    expect(by['Serverless feature, rarely read|SHOP.SALES.ORDERS']).toBeUndefined();
    expect(by['Long failed queries|EMP10004 on BI_WH']).toMatchObject({ 'Saving per month (credits)': 28 });
    expect(d.metrics).toMatchObject({
      findings: 15,
      idleWarehouses: 1,
      autoSuspend: 2,
      oversized: 2,
      unusedTables: 2,
      retention: 1,
      failing: 3,
      serverless: 2,
      longQueries: 2,
      accessHistory: 1,
      // each object once, with its largest saving (BI_WH: auto-suspend 77.34 rather than its size 60)
      saving: 473.23,
      savingCredits: 146.52,
    });
  });

  it('without ACCESS_HISTORY and QUERY_ATTRIBUTION_HISTORY both go on and say what they could not check', async () => {
    const { setSnowflakeUnavailableViews } = await import('../src/mock/mockSnowflakeUsage.js');
    setSnowflakeUnavailableViews(['ACCESS_HISTORY', 'QUERY_ATTRIBUTION_HISTORY']);
    try {
      const waste = await finish(await start('snowflake-waste-check', { snowflake: platformByKind.snowflake! }));
      expect([waste.status, waste.error]).toEqual(['succeeded', null]);
      expect(checksOf(waste)).toMatchObject({ tablesRead: 'skipped', featuresOk: 'skipped', accessHistory: 'failed', idleOk: 'failed' });
      expect(waste.steps.find((x: any) => x.stepId === 'accessHistory').summary).toContain('ACCESS_HISTORY cannot be read');
      expect((await s.api('GET', '/datasets/snowflake.waste')).metrics).toMatchObject({ findings: 11, unusedTables: 0, serverless: 0, accessHistory: 0 });

      const cost = await finish(await start('snowflake-cost-estimate', { snowflake: platformByKind.snowflake! }));
      expect([cost.status, cost.error]).toEqual(['succeeded', null]);
      expect(JSON.stringify(cost.logs)).toContain('QUERY_ATTRIBUTION_HISTORY could not be read');
      const attribution = await s.api('GET', '/datasets/snowflake.cost-attribution');
      expect([attribution.rowCount, attribution.metrics.available]).toEqual([0, 0]);
      expect((await s.api('GET', '/datasets/snowflake.cost-services')).rowCount).toBeGreaterThan(0);
    } finally {
      setSnowflakeUnavailableViews([]);
    }
  });

  it('both only read: every statement is a SELECT or SHOW, every call marked as not mutating', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const YAML = (await import('yaml')).default;
    for (const f of ['621-snowflake-cost-estimate.yaml', '622-snowflake-waste-check.yaml']) {
      const def = YAML.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'examples', 'processes', f), 'utf8'));
      const calls = def.steps.filter((x: any) => x.type === 'http');
      expect(calls.length, f).toBeGreaterThan(4);
      for (const c of calls) {
        expect([c.mutating, c.method, c.path], `${f} ${c.id}`).toEqual([false, 'POST', '/api/v2/statements']);
        expect(c.body.statement, `${f} ${c.id}`).toMatch(/^(SELECT|SHOW) /);
        expect(c.body.statement, `${f} ${c.id}`).not.toMatch(/\b(ALTER|DROP|CREATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|CALL|EXECUTE)\b/i);
      }
    }
  });
});

describe('Git – member review', () => {
  const review = async (kind: string, inputs: Record<string, unknown> = {}) => {
    let items: any[] = [];
    const runId = await start('git-member-review', { git: platformByKind[kind]! }, inputs);
    const r = await finish(runId, (x) => {
      items = x;
      return x.filter((i) => i.preselected).map((i) => i.key);
    });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(r.tasks.find((t: any) => t.mode === 'approve')).toMatchObject({ decidedBy: 'adam', fourEyes: true });
    const d = await s.api('GET', '/datasets/git.members');
    const rows = d.rows.filter((x: any) => x._key.startsWith(`${kind}|`));
    return {
      r,
      pre: Object.fromEntries(items.map((i) => [i.key.split('|').slice(1).join('|'), i.preselected])),
      by: Object.fromEntries(rows.map((x: any) => [x._key, x])),
      manual: r.tasks.find((t: any) => t.mode === 'manual').instructions as string,
    };
  };

  it('GitHub: owners, members, outside collaborators and who has no 2FA', async () => {
    const { pre, by, manual } = await review('github');
    expect(pre).toEqual({ 'acme|alice': true, 'acme|bob': false, 'acme|dave': true, 'acme|carol-ext': false });
    expect(manual).toContain('gh api -X DELETE /orgs/acme/outside_collaborators/carol-ext');
    expect(manual).toContain('gh api -X DELETE /orgs/acme/memberships/bob');
    expect(by['github|acme|bob']).toMatchObject({ Role: 'member', '2FA': 'disabled', Review: 'removed', _status: 'critical' });
    expect(by['github|acme|alice']).toMatchObject({ Role: 'owner', '2FA': 'enabled', Review: 'kept', _status: 'good' });
    expect(by['github|acme|carol-ext']).toMatchObject({ Role: 'outside collaborator', Review: 'removed' });
  });

  it('GitLab: inherited roles, last activity, 2FA and project members outside the group', async () => {
    const { pre, by, manual } = await review('gitlab', { projects: ['acme/shop/web'] });
    expect(pre).toEqual({ 'acme|alice': true, 'acme|bob': false, 'acme|dave': true, 'acme/shop/web|carol-ext': false });
    expect(manual).toContain('api/v4/projects/acme%2Fshop%2Fweb/members/103"   # carol-ext');
    expect(by['gitlab|acme|bob']).toMatchObject({ Role: 'developer', '2FA': 'disabled', _status: 'critical' });
    expect(by['gitlab|acme/shop/web|carol-ext']).toMatchObject({ Role: 'outside: reporter', _status: 'critical' });
    expect(by['gitlab|acme|dave']).toMatchObject({ Role: 'developer', '2FA': 'enabled', _status: 'good' });
  });

  it('Forgejo: team members with their last login and outside collaborators', async () => {
    const { pre, by, manual } = await review('forgejo', { projects: ['acme/shop-web'] });
    expect(pre).toEqual({ 'acme|alice': true, 'acme|bob': false, 'acme|dave': true, 'acme|carol-ext': false });
    expect(manual).toContain('api/v1/repos/acme/shop-web/collaborators/carol-ext');
    expect(by['forgejo|acme|alice']).toMatchObject({ Role: 'owner', _status: 'good' });
    expect(by['forgejo|acme|bob']).toMatchObject({ Role: 'teams: developers', _status: 'warning' });
    expect(by['forgejo|acme|carol-ext']).toMatchObject({ Role: 'outside collaborator: acme/shop-web', Review: 'removed' });
    // one dataset, one part per host
    const d = await s.api('GET', '/datasets/git.members');
    expect(new Set(d.rows.map((x: any) => x.Host))).toEqual(new Set(['GitHub', 'GitLab', 'Forgejo']));
  });

  it('documents the removals in the rights the Git access source reads', async () => {
    const entries = (await s.api('GET', `/compliance/access-changes?platformId=${platformByKind.github}`)).filter((e: any) => e.subjectId === 'bob');
    for (let i = 0; i < 50 && !entries.length; i++) {
      await sleep(200);
      entries.push(...(await s.api('GET', `/compliance/access-changes?platformId=${platformByKind.github}`)).filter((e: any) => e.subjectId === 'bob'));
    }
    expect(entries[0]).toMatchObject({ kind: 'revoke', revoked: ['member'], approvedBy: 'adam' });
  });
});

describe('Git – repository health on GitLab and Forgejo', () => {
  it('reads pipelines, branch protection, releases and expiring tokens into the same dataset as GitHub', async () => {
    const gh = await finish(await start('github-repository-health', { github: platformByKind.github! }));
    expect(gh.status).toBe('succeeded');
    const gl = await finish(await start('github-repository-health', { github: platformByKind.gitlab! }, { repositories: ['acme/shop/web', 'acme/shop/api'] }));
    expect([gl.status, gl.error]).toEqual(['succeeded', null]);
    const fj = await finish(await start('github-repository-health', { github: platformByKind.forgejo! }));
    expect([fj.status, fj.error]).toEqual(['succeeded', null]);
    const d = await s.api('GET', '/datasets/git.repositories');
    const by = Object.fromEntries(d.rows.map((x: any) => [`${x.Host} ${x.Repository}`, x]));
    expect(by['GitHub acme/shop-web']).toMatchObject({
      Protected: 'yes',
      Pipeline: 'passed',
      'Open alerts': '0 critical, 1 high, 2 other',
      _status: 'warning',
    });
    expect(by['GitHub acme/shop-api']).toMatchObject({ Protected: 'no', Pipeline: 'failed: CI', _status: 'critical' });
    expect(by['GitLab acme/shop/web']).toMatchObject({
      Protected: 'yes',
      Pipeline: 'passed',
      'Latest release': 'v2.4.1',
      'Tokens expiring': 'access token renovate (in 20 days)',
      _status: 'warning',
    });
    expect(by['GitLab acme/shop/api']).toMatchObject({ Protected: 'no', Pipeline: 'failed: pipeline 9000', 'Latest release': '–', _status: 'critical' });
    expect(by['Forgejo acme/shop-web']).toMatchObject({ Protected: 'yes', Pipeline: 'passed', 'Latest release': 'v2.4.1', _status: 'good' });
    expect(by['Forgejo acme/shop-api']).toMatchObject({ Protected: 'no', Pipeline: 'failed: ci/woodpecker/push/build', _status: 'critical' });
    const checks = Object.fromEntries(gl.steps.filter((x: any) => x.type === 'check').map((x: any) => [x.stepId, x.status]));
    expect(checks).toEqual({ pipelinesPass: 'failed', noSevereAlerts: 'succeeded', branchesProtected: 'failed', tokensValid: 'failed' });
  });
});

describe('AWS – keys and costs from the cloud accounts of applications', () => {
  it('finds old, unused and inactive keys and the costs per month', async () => {
    const aws = platformByKind.aws!;
    const ids: string[] = [];
    for (const name of ['shop', 'crm']) {
      const app = await s.api('POST', '/applications', { name: `Cloud ${name}`, owners: [] });
      const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'cloud-account', name, platformId: aws });
      await s.api('POST', `/applications/${app.id}/components/${a.components.find((c: any) => c.name === name).id}/aws`, {});
      ids.push(app.id);
    }
    const keys = await finish(await start('aws-iam-key-age', {}, { apps: ids }));
    expect([keys.status, keys.error]).toEqual(['succeeded', null]);
    const d = await s.api('GET', '/datasets/aws.iam-keys');
    const by = Object.fromEntries(d.rows.map((x: any) => [x['IAM user'], x]));
    // ci-deploy (application=shop): an active key of 410 days, used yesterday
    expect(by['ci-deploy']).toMatchObject({ Application: 'Cloud shop', 'Access key': '…Y001', State: 'Active', 'Age (days)': 410, _status: 'critical' });
    expect(by['ci-deploy'].Findings).toBe('active key 410 days old – rotate');
    // old-intern (application=crm): an inactive key never used, a console password unused for 700 days
    expect(by['old-intern'].Findings).toBe('inactive key – delete it; console password unused for 700 days');
    expect(d.metrics).toMatchObject({ keys: 2, users: 2, oldKeys: 1, unusedKeys: 0, inactiveKeys: 1, unusedPasswords: 1 });

    const costs = await finish(await start('aws-costs-per-application', {}, { apps: ids, maxGrowthPercent: 2 }));
    expect([costs.status, costs.error]).toEqual(['succeeded', null]);
    const c = await s.api('GET', '/datasets/aws.costs');
    const shop = c.rows.find((x: any) => x.Application === 'Cloud shop');
    // the mock: 1840 USD a month for shop, 3 % more every month, the current month half through
    expect(shop.Currency).toBe('USD');
    expect(shop['Change (%)']).toBeGreaterThan(2);
    expect(shop['Change (%)']).toBeLessThan(4);
    expect(shop.Costs).toBeGreaterThan(1840);
    expect(shop._status).toBe('warning');
    expect(c.metrics).toMatchObject({ applications: 2, growing: 2 });
    expect(costs.steps.find((x: any) => x.stepId === 'growth').status).toBe('failed');
  });
});

describe('Entra ID – reviews and reports on the simulated tenant', () => {
  const graph = () => platformByKind['microsoft-graph']!;
  const review = async (processId: string, inputs: Record<string, unknown> = {}) => {
    let items: any[] = [];
    const r = await finish(await start(processId, { graph: graph() }, inputs), (x) => {
      items = x;
      return x.filter((i) => i.preselected).map((i) => i.key);
    });
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    return { r, items, manual: r.tasks.find((t: any) => t.mode === 'manual')?.instructions as string | undefined };
  };
  /** The access change entries of the Graph platform that match (they are written when the run ends) */
  const changes = async (match: (e: any) => boolean, n: number) => {
    let found: any[] = [];
    for (let i = 0; i < 50; i++) {
      found = (await s.api('GET', `/compliance/access-changes?platformId=${graph()}`)).filter(match);
      if (found.length >= n) break;
      await sleep(200);
    }
    return found;
  };

  it('guest review: invitation state, last sign-in and groups; stale guests deleted after four-eyes and documented', async () => {
    const { r, items, manual } = await review('entra-guest-review');
    const pre = Object.fromEntries(items.map((i) => [i.cells[0].split(' <')[0], i.preselected]));
    expect(pre).toEqual({ 'Paula Partner': true, 'Gary Guest': false, 'Ingrid Invited': false });
    expect(r.tasks.find((t: any) => t.mode === 'approve')).toMatchObject({ decidedBy: 'adam', fourEyes: true });
    expect(manual).toContain('Gary Guest – gary_old-partner.example#EXT#@example.onmicrosoft.com');
    const d = await s.api('GET', '/datasets/entra.guests');
    const by = Object.fromEntries(d.rows.map((x: any) => [x.Guest, x]));
    expect(by['Paula Partner']).toMatchObject({
      'E-mail': 'paula@fabrikam.example',
      Groups: 'Contractors, Developers, Partner Portal Users',
      Review: 'kept',
      _status: 'good',
    });
    expect(by['Gary Guest']).toMatchObject({ Days: 400, Review: 'deleted', _status: 'critical' });
    expect(by['Ingrid Invited']).toMatchObject({ Invitation: 'PendingAcceptance', 'Last sign-in': 'never', _status: 'warning' });
    expect(d.metrics).toMatchObject({ guests: 3, stale: 1, neverSignedIn: 1, pendingInvitations: 1, removed: 2 });
    // the deletions are documented as offboardings of the UPN the Entra ID access source uses
    const entries = await changes((e) => e.kind === 'offboarding', 2);
    expect(entries.map((e: any) => e.subjectId).sort()).toEqual([
      'gary_old-partner.example#EXT#@example.onmicrosoft.com',
      'ingrid_invited.example#EXT#@example.onmicrosoft.com',
    ]);
  });

  it('privileged role review: active and eligible assignments with the rights the access source uses', async () => {
    const { items, manual } = await review('entra-privileged-role-review');
    const rows = items.map((i) => `${i.cells[3].split(' <')[0]}: ${i.cells[0]} (${i.cells[1]}) ${i.preselected ? 'kept' : 'removed'}`).sort();
    expect(rows).toEqual([
      'Alice Admin: Global Administrator (active) kept',
      'Bob Builder: Application Administrator (eligible) kept',
      'HR Sync: User Administrator (active) kept',
      'IT Admins: User Administrator (active) kept',
    ]);
    expect(manual).toBeUndefined();
    const d = await s.api('GET', '/datasets/entra.privileged-roles');
    expect(d.metrics).toMatchObject({ assignments: 4, active: 3, eligible: 1, globalAdmins: 1, inactive: 0 });
    const hr = d.rows.find((x: any) => x.Principal === 'HR Sync');
    expect(hr).toMatchObject({ Type: 'service principal', Scope: expect.stringMatching(/^\/administrativeUnits\//), 'Last sign-in': '–' });
  });

  it('stale accounts: no sign-in for N days, never signed in, disabled accounts still in groups', async () => {
    const { r } = await review('entra-stale-accounts');
    const d = await s.api('GET', '/datasets/entra.stale-accounts');
    expect(Object.fromEntries(d.rows.map((x: any) => [x.Account, x.Finding]))).toEqual({
      'Max Stale': 'no sign-in for 200 days',
      'Nora Never': 'never signed in (created 120 days ago)',
      'Carl Disabled': 'disabled, still in 1 group(s)',
      'Gary Guest': 'no sign-in for 400 days',
      'Ingrid Invited': 'never signed in (created 45 days ago)',
    });
    expect(d.metrics).toMatchObject({ accounts: 9, stale: 2, neverSignedIn: 2, disabledInGroups: 1 });
    expect(r.steps.find((x: any) => x.stepId === 'staleCheck').status).toBe('failed');
  });

  it('group review: direct and nested members, owners, guests and disabled accounts', async () => {
    const { items, manual } = await review('entra-group-review');
    expect(Object.fromEntries(items.map((i) => [`${i.cells[0]}|${i.cells[1].split(' <')[0]}`, i.preselected]))).toEqual({
      'Developers|Bob Builder': true,
      'Developers|Max Stale': false,
      'Developers|Carl Disabled': false,
      'Developers|Gary Guest': false,
      'Partner Portal Users|Paula Partner': true,
      'Partner Portal Users|Ingrid Invited': false,
    });
    expect(manual).toContain('Developers: Carl Disabled <carl.disabled@example.com>');
    const d = await s.api('GET', '/datasets/entra.group-members');
    const paula = d.rows.find((x: any) => x.Group === 'Developers' && x.Member === 'Paula Partner');
    expect(paula).toMatchObject({ Via: 'nested group', Review: 'in the nested group', _status: 'warning' });
    expect(d.metrics).toMatchObject({ groups: 2, memberships: 7, ownerless: 1, disabled: 1 });
    const entries = await changes((e) => e.subjectId === 'max.stale@example.com', 1);
    expect(entries[0]).toMatchObject({ kind: 'revoke', revoked: ['group:Developers'], approvedBy: 'adam' });
  });

  it('expiring app credentials: expired, ending soon, replaced and left over', async () => {
    const { r } = await review('entra-app-credentials');
    const d = await s.api('GET', '/datasets/entra.app-credentials');
    const by = Object.fromEntries(d.rows.map((x: any) => [`${x.Application} ${x.Type} ${x.Name}`, x]));
    expect(by['Legacy Reports certificate CN=legacy-reports']).toMatchObject({
      Finding: expect.stringMatching(/^ends in [23] day\(s\)$/),
      _status: 'critical',
    });
    expect(by['Payroll secret prod']._status).toBe('warning');
    expect(by['HR Sync secret old']).toMatchObject({ Finding: 'expired, replaced – delete it', _status: 'warning' });
    expect(by['HR Sync secret rotation 2026']._status).toBe('good');
    expect(d.metrics).toMatchObject({ credentials: 6, expired: 0, expiring: 2, leftover: 1, applications: 4 });
    expect(JSON.stringify(d.rows)).not.toContain('dmo');
    expect(r.steps.find((x: any) => x.stepId === 'expiringCheck').status).toBe('failed');
  });
});

describe('Prometheus – SLO and error-budget report', () => {
  it('computes the availability, the budget left and the burn rates per service', async () => {
    const r = await finish(await start('prometheus-slo-report', { prometheus: platformByKind.prometheus! }));
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    const d = await s.api('GET', '/datasets/prom.slo');
    const by = Object.fromEntries(d.rows.map((x: any) => [x.Service, x]));
    expect(by['shop-web']).toMatchObject({ 'Availability (%)': 99.95, 'Error budget left (%)': 50, 'Burn rate 1 h': 1, _status: 'good' });
    expect(by['shop-api']).toMatchObject({
      'Availability (%)': 99.82,
      'Error budget left (%)': -80,
      'Burn rate 1 h': 15,
      'Burn rate 6 h': 10,
      _status: 'critical',
    });
    expect(by['shop-api']._statusText).toBe('burning fast: 15× over 1 h, 10× over 6 h');
    expect(by.checkout).toMatchObject({ 'Error budget left (%)': 20, _status: 'warning' });
    expect(d.metrics).toMatchObject({ services: 3, belowObjective: 1, budgetExhausted: 1, fastBurn: 1, lowestAvailability: 99.82, lowestBudget: -80 });
  });

  it('the burn-rate monitor of the example library reads the same metric', async () => {
    const m = (await s.api('GET', '/monitors')).find((x: any) => x.key === 'error-budget-burn-rate');
    expect(m).toBeTruthy();
    const def = (await s.api('GET', `/monitors/${m.id}`)).definition;
    expect(def.checks.map((c: any) => c.platform)).toEqual([platformByKind.prometheus, platformByKind.prometheus]);
  });
});

describe('Snowflake – project templates without ACCOUNT_USAGE (0.26.2)', () => {
  const checksOf = (r: any) => Object.fromEntries(r.steps.filter((x: any) => x.type === 'check').map((x: any) => [x.stepId, x.status]));
  const DB = 'PRJ_SALES_INSIGHTS_DEV';

  it('task health: failed, slow, skipped, suspended and missed runs from TASK_HISTORY and SHOW TASKS', async () => {
    const { resetSnowflakeStatements, snowflakeStatements } = await import('../src/mock/mockSnowflake.js');
    resetSnowflakeStatements();
    const r = await finish(await start('snowflake-task-health', { snowflake: platformByKind.snowflake! }));
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(checksOf(r)).toEqual({
      valid: 'succeeded',
      readable: 'succeeded',
      historyVisible: 'succeeded',
      failuresOk: 'failed',
      suspendedOk: 'failed',
      ranOk: 'failed',
      speedOk: 'failed',
    });
    const d = await s.api('GET', '/datasets/snowflake.project-tasks');
    const by = Object.fromEntries(d.rows.map((x: any) => [x._key, x]));
    expect(Object.keys(by).sort()).toEqual(
      ['ETL.ARCHIVE_EVENTS', 'ETL.BUILD_CUSTOMER_FACTS', 'ETL.LOAD_ORDERS', 'MART.EXPORT_FORECAST', 'MART.REFRESH_KPIS'].map((k) => `${DB}.${k}`),
    );
    expect(by[`${DB}.ETL.LOAD_ORDERS`]).toMatchObject({
      State: 'started',
      Runs: 24,
      Failed: 3,
      'Last state': 'FAILED',
      'Last error': "100038: Numeric value 'n/a' is not recognized (file orders_2026-11.csv, line 1207)",
      'Slow runs': 0,
      _status: 'critical',
    });
    // usually 45 s: 300 s and 420 s are more than twice the median and longer than a minute
    expect(by[`${DB}.ETL.BUILD_CUSTOMER_FACTS`]).toMatchObject({
      Runs: 24,
      Skipped: 1,
      'Median (s)': 45,
      'Longest (s)': 420,
      'Slow runs': 2,
      _status: 'warning',
    });
    expect(by[`${DB}.ETL.BUILD_CUSTOMER_FACTS`].Findings).toBe('2 run(s) slower than 2 × the median of 45 s (longest 420 s); 1 skipped, 0 cancelled');
    expect(by[`${DB}.MART.REFRESH_KPIS`]).toMatchObject({ Runs: 1, Findings: '–', _status: 'good' });
    expect(by[`${DB}.MART.EXPORT_FORECAST`]).toMatchObject({ State: 'suspended', Runs: 0, Findings: 'suspended', _status: 'warning' });
    expect(by[`${DB}.ETL.ARCHIVE_EVENTS`]).toMatchObject({
      State: 'started',
      Runs: 0,
      Findings: 'no run in 24 h although started with schedule 30 MINUTE',
      _status: 'warning',
    });
    expect(d.metrics).toMatchObject({
      databases: 1,
      tasks: 5,
      failed: 1,
      failedRuns: 3,
      suspended: 1,
      notRun: 1,
      slow: 1,
      skippedOrCancelled: 1,
      unreadable: 0,
    });
    // only the project database's own INFORMATION_SCHEMA and SHOW, the database as a quoted identifier
    const sent = snowflakeStatements().filter((x) => x.sql.includes(DB));
    expect(sent.map((x) => x.sql.split(/\s+/).slice(0, 2).join(' ')).sort()).toEqual(['SELECT DATABASE_NAME,', 'SHOW TASKS']);
    expect(sent.find((x) => x.sql.startsWith('SHOW'))!.sql).toBe(`SHOW TASKS IN DATABASE "${DB}"`);
    expect(sent.find((x) => x.sql.startsWith('SELECT'))!.sql).toContain(`FROM TABLE("${DB}".INFORMATION_SCHEMA.TASK_HISTORY(`);
    expect(sent.find((x) => x.sql.startsWith('SELECT'))!.bindings).toEqual(['2', '60', '-24']);
    expect(sent.some((x) => /ACCOUNT_USAGE/i.test(x.sql))).toBe(false);
  });

  it('task health: a short period expects only the frequent schedules, a large factor finds no slow run, a missing database is named', async () => {
    const r = await finish(
      await start(
        'snowflake-task-health',
        { snowflake: platformByKind.snowflake! },
        { databases: ['prj_sales_insights_dev', 'NO_SUCH_DB'], hours: 1, slowFactor: 10 },
      ),
    );
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(checksOf(r)).toMatchObject({ readable: 'failed', ranOk: 'failed', speedOk: 'succeeded' });
    const d = await s.api('GET', '/datasets/snowflake.project-tasks');
    const by = Object.fromEntries(d.rows.map((x: any) => [x._key, x]));
    // daily at 05:30 is not due within an hour; every 30 minutes is
    expect(by[`${DB}.MART.REFRESH_KPIS`]).toMatchObject({ Runs: 0, _status: 'good' });
    expect(by[`${DB}.ETL.ARCHIVE_EVENTS`].Findings).toBe('no run in 1 h although started with schedule 30 MINUTE');
    expect(by[`${DB}.ETL.LOAD_ORDERS`]).toMatchObject({ Runs: 1, Failed: 1 });
    expect(d.metrics).toMatchObject({ databases: 2, slow: 0, notRun: 1, unreadable: 2 });
    const readable = r.steps.find((x: any) => x.stepId === 'readable');
    expect(readable.summary).toContain("NO_SUCH_DB: SHOW TASKS failed – SQL compilation error:\nDatabase 'NO_SUCH_DB' does not exist or not authorized.");
  });

  it('dynamic tables and streams: failed refreshes, lag above target, suspended, stale and soon stale streams', async () => {
    const r = await finish(await start('snowflake-dynamic-tables-and-streams', { snowflake: platformByKind.snowflake! }));
    expect([r.status, r.error]).toEqual(['succeeded', null]);
    expect(checksOf(r)).toEqual({
      valid: 'succeeded',
      readable: 'succeeded',
      refreshOk: 'failed',
      lagOk: 'failed',
      suspendedOk: 'failed',
      streamsOk: 'failed',
    });
    const d = await s.api('GET', '/datasets/snowflake.project-pipelines');
    const by = Object.fromEntries(d.rows.map((x: any) => [x._key, x]));
    expect(by[`${DB}.MART.SALES_DAILY_DT`]).toMatchObject({
      Kind: 'dynamic table',
      State: 'running',
      'Target lag': '1 hour',
      Lag: '20 min',
      Refreshes: 24,
      _status: 'good',
    });
    expect(by[`${DB}.MART.CUSTOMER_SEGMENTS_DT`]).toMatchObject({
      State: 'running',
      'Target lag': '30 minutes',
      Lag: '5 h',
      Refreshes: 12,
      'Failed refreshes': 5,
      'Last refresh': 'FAILED',
      'Last error': `002003: SQL compilation error: Object '${DB}.ETL.CRM_CONTACTS_V' does not exist or not authorized.`,
      _status: 'critical',
    });
    expect(by[`${DB}.MART.CUSTOMER_SEGMENTS_DT`].Findings).toMatch(
      /^5 failed refresh\(es\), last .*; lag 5 h \(up to 20 min after a refresh\), target 30 minutes$/,
    );
    // suspended: a finding of its own, its lag is not counted again
    expect(by[`${DB}.ETL.ORDERS_ENRICHED_DT`]).toMatchObject({ State: 'suspended', Findings: 'suspended', _status: 'warning' });
    expect(by[`${DB}.ETL.ORDERS_CHANGES`]).toMatchObject({ Kind: 'stream', State: 'ok', _status: 'good' });
    expect(by[`${DB}.ETL.CONTACTS_CHANGES`]).toMatchObject({ Kind: 'stream', State: 'stale', _status: 'critical' });
    expect(by[`${DB}.ETL.EVENTS_CHANGES`]).toMatchObject({ State: 'ok', _status: 'warning' });
    expect(by[`${DB}.ETL.EVENTS_CHANGES`].Findings).toMatch(/^goes stale on \d{4}-\d{2}-\d{2} \(in 2 days\) unless it is read$/);
    expect(d.metrics).toMatchObject({
      databases: 1,
      dynamicTables: 3,
      streams: 3,
      refreshFailures: 1,
      failedRefreshes: 5,
      lagging: 1,
      suspended: 1,
      staleStreams: 1,
      soonStale: 1,
      unreadable: 0,
    });
    // a stream that goes stale in two days is fine when only the next day counts
    const r2 = await finish(
      await start('snowflake-dynamic-tables-and-streams', { snowflake: platformByKind.snowflake! }, { staleWithinDays: 1, lagFactor: 20 }),
    );
    expect(checksOf(r2)).toMatchObject({ lagOk: 'succeeded', streamsOk: 'failed' });
    expect((await s.api('GET', '/datasets/snowflake.project-pipelines')).metrics).toMatchObject({ lagging: 0, staleStreams: 1, soonStale: 0 });
  });

  it('both refuse database names that are no plain identifiers before anything is sent', async () => {
    const { resetSnowflakeStatements, snowflakeStatements } = await import('../src/mock/mockSnowflake.js');
    resetSnowflakeStatements();
    for (const processId of ['snowflake-task-health', 'snowflake-dynamic-tables-and-streams'])
      for (const bad of ['X; DROP TABLE Y', 'a.b', '"PRJ_SALES_INSIGHTS_DEV"', "PRJ'X", 'PRJ X', '1PRJ']) {
        const r = await finish(await start(processId, { snowflake: platformByKind.snowflake! }, { databases: [DB, bad] }));
        expect([processId, bad, r.status]).toEqual([processId, bad, 'failed']);
        expect(r.steps.find((x: any) => x.stepId === 'valid').status).toBe('failed');
        expect(r.steps.some((x: any) => x.stepId === 'perDatabase')).toBe(false);
        expect(snowflakeStatements().filter((x) => x.sql.includes(bad))).toEqual([]);
      }
    expect(snowflakeStatements().filter((x) => /DROP TABLE/i.test(x.sql))).toEqual([]);
  });

  it('both only read and never touch ACCOUNT_USAGE: SELECT or SHOW, every call marked as not mutating', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const YAML = (await import('yaml')).default;
    for (const f of ['623-snowflake-task-health.yaml', '624-snowflake-dynamic-tables-and-streams.yaml']) {
      const text = fs.readFileSync(path.resolve(__dirname, '..', '..', 'examples', 'processes', f), 'utf8');
      const def = YAML.parse(text);
      const calls = def.steps.flatMap((x: any) => (x.type === 'forEach' ? x.steps : [x])).filter((x: any) => x.type === 'http');
      expect(calls.length, f).toBeGreaterThanOrEqual(2);
      for (const c of calls) {
        expect([c.mutating, c.method, c.path], `${f} ${c.id}`).toEqual([false, 'POST', '/api/v2/statements']);
        expect(c.body.statement, `${f} ${c.id}`).toMatch(
          /^\{\{ ('SHOW (TASKS|DYNAMIC TABLES|STREAMS) IN DATABASE ' & vars\.dbIdent|\$replace\(\$const\.\w+, '<DB>', vars\.dbIdent\)) \}\}$/,
        );
      }
      for (const sql of Object.values(def.constants) as string[]) {
        expect(sql).toMatch(/^SELECT /);
        expect(sql).not.toMatch(/\b(ALTER|DROP|CREATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|CALL|EXECUTE)\b/i);
        expect(sql).toMatch(/FROM TABLE\(<DB>\.INFORMATION_SCHEMA\.[A-Z_]+\(/);
      }
      expect(text, f).not.toMatch(/SNOWFLAKE\.ACCOUNT_USAGE\.|FROM ACCOUNT_USAGE/);
    }
  });
});

describe('monitor examples', () => {
  it('every example monitor imports in the demo with generic platform names (no "(demo)" in the files)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '..', '..', 'examples', 'monitors');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    for (const f of files) expect(fs.readFileSync(path.join(dir, f), 'utf8'), f).not.toMatch(/platform: .*\(demo\)/);
    const examples = (await s.api('GET', '/monitors/examples')) as { file: string; key: string | null }[];
    const have = new Set([...(await s.api('GET', '/monitors')), ...(await s.api('GET', '/monitors?templates=true'))].map((m: { key: string }) => m.key));
    expect(examples.filter((e) => e.key && !have.has(e.key)).map((e) => e.file)).toEqual([]);
    // each check type of the examples resolves to the demo platform of its kind
    for (const key of [
      'snowflake-account',
      'kubernetes-namespace',
      'repository-pipelines',
      'kafka-orders',
      'mqtt-presses',
      'checkmk-database-host',
      'new-critical-vulnerabilities',
      'entra-app-credentials',
      'crm-contacts-dynamodb',
      'kafka-connect-shop',
    ]) {
      const m = ((await s.api('GET', '/monitors')) as any[]).find((x) => x.key === key);
      const def = (await s.api('GET', `/monitors/${m.id}`)).definition;
      for (const c of def.checks) expect(Object.values(platformByKind), `${key}/${c.id}`).toContain(c.platform);
    }
  });
});

describe('template metadata for the gallery', () => {
  it('lists the platforms a template needs, its recommended schedule, its datasets and the dashboards it feeds', async () => {
    const list = (await s.api('GET', '/templates')) as any[];
    const by = Object.fromEntries(list.map((t) => [t.id, t]));
    expect(by['61-snowflake-project-access-review']).toMatchObject({
      connections: [{ slot: 'snowflake', kinds: ['snowflake'], description: expect.stringContaining('Snowflake') }],
      connectionKinds: ['snowflake'],
      recommendedSchedule: { cron: '0 7 1 1,4,7,10 *', text: expect.stringMatching(/^quarterly/) },
      datasets: ['snowflake.project-access'],
      dashboards: [
        { id: '20-access-governance', name: 'Access governance' },
        { id: '61-snowflake-account', name: 'Snowflake account' },
      ],
      minVersion: '0.2.8',
      tags: expect.arrayContaining(['access-review']),
    });
    expect(by['621-snowflake-cost-estimate']).toMatchObject({
      connectionKinds: ['snowflake'],
      recommendedSchedule: { cron: '20 9 * * *', text: expect.stringMatching(/^daily/) },
      datasets: ['snowflake.cost-attribution', 'snowflake.cost-services', 'snowflake.cost-storage', 'snowflake.cost-warehouses'],
      dashboards: [{ id: '62-snowflake-costs', name: 'Snowflake costs' }],
      minVersion: '0.21.0',
      tags: expect.arrayContaining(['costs', 'snowflake']),
    });
    expect(by['622-snowflake-waste-check']).toMatchObject({
      recommendedSchedule: { cron: '30 7 * * 1', text: expect.stringMatching(/^weekly/) },
      datasets: ['snowflake.waste'],
      dashboards: [{ id: '62-snowflake-costs', name: 'Snowflake costs' }],
      minVersion: '0.21.0',
    });
    expect(by['623-snowflake-task-health']).toMatchObject({
      recommendedSchedule: { cron: '10 * * * *', text: expect.stringMatching(/^hourly/) },
      datasets: ['snowflake.project-tasks'],
      dashboards: [{ id: '64-snowflake-project-pipelines', name: 'Snowflake project pipelines' }],
      minVersion: '0.21.0',
    });
    expect(by['624-snowflake-dynamic-tables-and-streams']).toMatchObject({
      connectionKinds: ['snowflake'],
      datasets: ['snowflake.project-pipelines'],
      dashboards: [{ id: '64-snowflake-project-pipelines', name: 'Snowflake project pipelines' }],
    });
    // a slot that takes several kinds
    expect(by['82-github-repository-health']).toMatchObject({
      connectionKinds: ['forgejo', 'github', 'gitlab'],
      datasets: ['git.repositories'],
      dashboards: [{ id: '82-repositories', name: 'Repositories' }],
    });
    // the schedule from the description only, cron in backticks
    expect(by['15-ih-inventory-snapshot'].recommendedSchedule).toBeTruthy();
    expect(by['16-ih-access-snapshot']).toMatchObject({ recommendedSchedule: { cron: null, text: expect.stringMatching(/^daily/) }, minVersion: null });
    // no connection: nothing needed
    expect(by['77-end-of-life-overview']).toMatchObject({ connections: [], connectionKinds: [], dashboards: [{ id: '60-end-of-life', name: 'End of life' }] });
    // "e.g." does not end the sentence
    expect(by['72-gatus-report-check'].recommendedSchedule.cron).toBe('*/5 * * * *');
    expect(by['77-end-of-life-overview']).toMatchObject({ recommendedSchedule: { cron: '0 7 * * 1' }, minVersion: '0.2.6' });
    // every template says when to run it
    expect(list.filter((t) => !t.recommendedSchedule).map((t) => t.id)).toEqual([]);
  });
});

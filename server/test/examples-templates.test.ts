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

describe('demo data', () => {
  it('fills the dashboards of every example from the sample applications and the simulated platforms', async () => {
    for (let i = 0; i < 600; i++) {
      if (!(await s.api('GET', '/runs?status=queued,running')).length) break;
      await sleep(100);
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
      'prom.slo',
      'k8s.health',
      'checkmk.trends',
      'dt.vulnerabilities',
      'git.repositories',
    ])
      if (!((await s.api('GET', `/datasets/${key}`)).rowCount > 0)) empty.push(key);
    expect(empty).toEqual([]);
    const repos = await s.api('GET', '/datasets/git.repositories');
    expect(new Set(repos.rows.map((r: any) => r.Host))).toEqual(new Set(['GitHub', 'GitLab', 'Forgejo']));
    // the end of life of the stacks read from the repository and the namespace
    const eol = await s.api('GET', '/datasets/eol-overview');
    expect(eol.rows.some((r: any) => r.Application === 'Webshop (demo)' && r._status !== 'unknown')).toBe(true);
    const runs = (await s.api('GET', '/runs?limit=100')).filter((r: any) => r.status !== 'succeeded');
    expect(runs.map((r: any) => `${r.processName}: ${r.status} ${r.error ?? ''}`)).toEqual([]);
  });

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

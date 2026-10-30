import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Person access reviews (#118) against the demo AWS account and Snowflake: one person's rights on two platforms,
 * decided, approved by a second person, sealed, and the removals checked again. Also the AWS IAM access source.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Own-password-123';
let s: TestServer;
let paula: Client;
let oscar: Client;
let awsCheck: string;
let sfCheck: string;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup');
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'paula', roles: ['approver'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'oscar', roles: ['operator'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'olga', email: 'old-intern@example.com', roles: ['operator'], password: PW, mustChangePassword: false });
  [paula, oscar] = await Promise.all(['paula', 'oscar'].map((u) => s.as(u, PW)));
  const platforms = await s.api('GET', '/platforms');
  const aws = platforms.find((p: any) => p.kind === 'aws').id;
  const sf = platforms.find((p: any) => p.kind === 'snowflake').id;
  awsCheck = (await s.api('POST', '/compliance/access-checks', { name: 'AWS IAM', platformId: aws, source: 'aws' })).id;
  sfCheck = (await s.api('POST', '/compliance/access-checks', { name: 'Snowflake roles', platformId: sf, source: 'snowflake', scope: '' })).id;
});
afterAll(async () => {
  await s?.app.close();
});

describe('AWS IAM access source', () => {
  it('reads users with their groups and policies, technical users marked', async () => {
    const r = await s.api('POST', `/compliance/access-checks/${awsCheck}/run`, {});
    const snap = await s.api('GET', `/compliance/access-checks/${awsCheck}/snapshots/${r.snapshot.id}`);
    const by = Object.fromEntries(snap.data.map((x: any) => [x.id, { type: x.type, rights: x.rights }]));
    expect(by).toEqual({
      'ci-deploy': { type: 'technical', rights: ['group:deployers', 'policy:AmazonECS_FullAccess'] },
      'backup-writer': { type: 'technical', rights: ['inline:backup-bucket-only', 'policy:AmazonS3FullAccess'] },
      'old-intern': { type: 'user', rights: ['group:developers', 'group:readonly'] },
    });
  });
});

describe('person access reviews', () => {
  let id: string;

  it('suggests the identities of a Steward user and refuses reviewing oneself', async () => {
    expect(await s.api('GET', '/compliance/person-reviews/suggest?user=olga')).toEqual({ personName: 'olga', identifiers: ['olga', 'old-intern@example.com'] });
    await expect(
      s.api('POST', '/compliance/person-reviews', { title: 'Me', personName: 'Admin', identifiers: ['admin'], checkIds: [awsCheck] }),
    ).rejects.toThrow(/own access/);
    await expect(oscar('POST', '/compliance/person-reviews', { title: 'x', personName: 'x', identifiers: ['x'], checkIds: [awsCheck] })).rejects.toThrow(/403/);
  });

  it('collects the person’s rights from every source and freezes them', async () => {
    const r = await s.api('POST', '/compliance/person-reviews', {
      title: 'Leaver: Olga (intern)',
      personUser: 'olga',
      personName: 'Olga Intern',
      identifiers: ['old-intern', 'OLD_BI', 'old-intern@example.com'],
      checkIds: [awsCheck, sfCheck],
      fourEyes: true,
    });
    id = r.id;
    expect(r).toMatchObject({ status: 'open', fourEyes: true, counts: { rights: 3, open: 3 }, canDecide: true, canApprove: false });
    expect(r.sources.map((x: any) => [x.source, x.origin, x.matched])).toEqual([
      ['aws', 'live', 1],
      ['snowflake', 'live', 1],
    ]);
    expect(r.items.map((i: any) => `${i.subjectId}: ${i.right}`)).toEqual([
      'old-intern: group:developers',
      'old-intern: group:readonly',
      'OLD_BI: role:REPORTER',
    ]);
    // others do not see it; an operator without rights gets a 404
    await expect(oscar('GET', `/compliance/person-reviews/${id}`)).rejects.toThrow(/404/);
    expect((await paula('GET', '/compliance/person-reviews')).map((x: any) => x.id)).toContain(id);
  });

  it('decides per right, needs a reason to remove, and a second person to approve', async () => {
    const r = await s.api('GET', `/compliance/person-reviews/${id}`);
    const [dev, ro, rep] = r.items;
    await expect(s.api('POST', `/compliance/person-reviews/${id}/submit`, {})).rejects.toThrow(/not decided/);
    await expect(s.api('PUT', `/compliance/person-reviews/${id}/decisions`, { decisions: [{ itemId: ro.id, decision: 'remove' }] })).rejects.toThrow(
      /why a right is to be removed/,
    );
    const d = await s.api('PUT', `/compliance/person-reviews/${id}/decisions`, {
      decisions: [
        { itemId: dev.id, decision: 'keep', comment: 'still on the team until the end of the month' },
        { itemId: ro.id, decision: 'remove', comment: 'leaves the company' },
        { itemId: rep.id, decision: 'remove', comment: 'leaves the company' },
      ],
    });
    expect(d.counts).toMatchObject({ keep: 1, remove: 2, open: 0 });
    const sub = await s.api('POST', `/compliance/person-reviews/${id}/submit`, {});
    expect(sub).toMatchObject({ status: 'submitted', submittedBy: 'admin', canDecide: false });
    // the reviewer does not approve their own review
    await expect(s.api('POST', `/compliance/person-reviews/${id}/approval`, { approve: true })).rejects.toThrow(/other than the reviewer/);
    const ok = await paula('POST', `/compliance/person-reviews/${id}/approval`, { approve: true, comment: 'agreed' });
    expect(ok).toMatchObject({ status: 'approved', approvedBy: 'paula', sealHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await s.api('GET', `/compliance/person-reviews/${id}/seal`)).toMatchObject({ ok: true });
    // sealed: decisions no longer change
    await expect(
      s.api('PUT', `/compliance/person-reviews/${id}/decisions`, { decisions: [{ itemId: dev.id, decision: 'remove', comment: 'x' }] }),
    ).rejects.toThrow(/no longer open/);
    // a change in the database breaks the seal
    const { db } = await import('../src/db.js');
    db().run("UPDATE person_review_items SET decision = 'keep' WHERE id = ?", ro.id);
    expect((await s.api('GET', `/compliance/person-reviews/${id}/seal`)).ok).toBe(false);
    db().run("UPDATE person_review_items SET decision = 'remove' WHERE id = ?", ro.id);
    expect((await s.api('GET', `/compliance/person-reviews/${id}/seal`)).ok).toBe(true);
  });

  it('checks the removals again and closes the review when every right to remove is gone', async () => {
    const { setIamGroups } = await import('../src/mock/mockAws.js');
    const { setSnowflakeUserRoles } = await import('../src/mock/mockSnowflake.js');
    setIamGroups('old-intern', ['developers']);
    const r1 = await s.api('POST', `/compliance/person-reviews/${id}/recheck`, {});
    expect(r1).toMatchObject({ status: 'approved', counts: { gone: 1, present: 1 } });
    setSnowflakeUserRoles('OLD_BI', []);
    const r2 = await s.api('POST', `/compliance/person-reviews/${id}/recheck`, {});
    expect(r2).toMatchObject({ status: 'closed', counts: { gone: 2, present: 0 }, closedAt: expect.any(String) });
    // kept rights are not rechecked
    expect(r2.items.find((i: any) => i.right === 'group:developers').recheck).toBeNull();
    const audit = await s.api('GET', `/audit?entityType=person_review&entityId=${id}`);
    expect(audit.map((e: any) => e.action)).toEqual(
      expect.arrayContaining([
        'compliance.person_review_started',
        'compliance.person_review_submitted',
        'compliance.person_review_approved',
        'compliance.person_review_rechecked',
      ]),
    );
  });

  it('seals at once without four-eyes, and a second person can send a review back', async () => {
    const a = await s.api('POST', '/compliance/person-reviews', {
      title: 'Quick',
      personName: 'CI deploy user',
      identifiers: ['ci-deploy'],
      checkIds: [awsCheck],
      fourEyes: false,
    });
    await s.api('PUT', `/compliance/person-reviews/${a.id}/decisions`, {
      decisions: a.items.map((i: any) => ({ itemId: i.id, decision: 'keep', comment: '' })),
    });
    expect(await s.api('POST', `/compliance/person-reviews/${a.id}/submit`, {})).toMatchObject({ status: 'approved', approvedBy: 'admin' });
    const b = await s.api('POST', '/compliance/person-reviews', { title: 'Back', personName: 'Backup', identifiers: ['backup-writer'], checkIds: [awsCheck] });
    await s.api('PUT', `/compliance/person-reviews/${b.id}/decisions`, {
      decisions: b.items.map((i: any) => ({ itemId: i.id, decision: 'keep', comment: '' })),
    });
    await s.api('POST', `/compliance/person-reviews/${b.id}/submit`, {});
    await expect(paula('POST', `/compliance/person-reviews/${b.id}/approval`, { approve: false })).rejects.toThrow(/why the review goes back/);
    expect(await paula('POST', `/compliance/person-reviews/${b.id}/approval`, { approve: false, comment: 'S3 full access is too much' })).toMatchObject({
      status: 'open',
    });
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
let dana: Client, olivia: Client;
const PW = 'Demo-password-1';
const TOKEN = 'mock-git-token-0123456789';

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: Error) => e.message,
  );

/** Creates (or adds a commit to) a repository of the mock Git host. */
async function commit(
  repo: string,
  files: Record<string, string | null>,
  opts: { signed?: boolean; branch?: string; private?: boolean; signer?: string; email?: string; objectFormat?: 'sha256' } = {},
) {
  const res = await fetch(`${s.base}/mock/git/_commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...opts, repo, files, signed: opts.signed ?? true }),
  });
  return ((await res.json()) as { sha: string }).sha;
}

const proc = (name: string, extra = '') => `name: "${name}"
description: from git
steps:
  - id: hello
    type: log
    message: "hello ${extra}"
`;

let n = 0;
const uniqueRepo = () => `team/lib-${Date.now().toString(36)}-${n++}`;

async function source(repo: string, body: Record<string, unknown> = {}) {
  const r = await s.api('POST', '/sync-sources', {
    name: `Library ${repo}`,
    provider: 'forgejo',
    repoUrl: `${s.base}/mock/git/${repo}`,
    branch: 'main',
    folder: 'steward',
    kinds: ['process', 'dashboard', 'monitor', 'recordType'],
    ...body,
  });
  return r as { source: any; webhookSecret: string };
}
const pending = async (sourceId: string) => (await s.api('GET', `/sync-updates?sourceId=${sourceId}&status=pending`)) as any[];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
}, 120_000);
afterAll(async () => {
  await s?.app.close();
  if (s) fs.rmSync(s.dataDir, { recursive: true, force: true });
});

describe('Git sync sources', () => {
  it('are managed by administrators only; the token is write-only and the webhook secret shown once', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/a.yaml': proc('Sources test') });
    const { source: src, webhookSecret } = await source(repo, { token: TOKEN, webhookEnabled: true });
    expect(webhookSecret).toMatch(/^gsw_/);
    expect(src).toMatchObject({
      hasToken: true,
      webhookEnabled: true,
      webhookPath: `/api/hooks/sync/${src.id}`,
      kinds: ['process', 'dashboard', 'monitor', 'recordType'],
    });
    const listed = JSON.stringify(await s.api('GET', '/sync-sources'));
    expect(listed).not.toContain(TOKEN);
    expect(listed).not.toContain(webhookSecret);
    expect(await status(dana('GET', '/sync-sources'))).toBe(403);
    expect(await status(dana('POST', '/sync-sources', { name: 'x', provider: 'forgejo', repoUrl: `${s.base}/mock/git/${repo}`, kinds: ['process'] }))).toBe(
      403,
    );
    // keep the token when it is not sent, remove it with ''
    const kept = await s.api('PUT', `/sync-sources/${src.id}`, { ...src, token: undefined });
    expect(kept.hasToken).toBe(true);
    const removed = await s.api('PUT', `/sync-sources/${src.id}`, { ...src, token: '' });
    expect(removed.hasToken).toBe(false);
    const audit = JSON.stringify(await s.api('GET', '/audit?entityType=sync_source&limit=50'));
    expect(audit).toContain('sync.source_created');
    expect(audit).not.toContain(TOKEN);
    expect(audit).not.toContain(webhookSecret);
    await s.api('DELETE', `/sync-sources/${src.id}`);
    expect(await status(s.api('GET', `/sync-sources/${src.id}`))).toBe(404);
  });

  it('refuses unsafe repository settings', async () => {
    const base = { name: 'x', provider: 'forgejo', kinds: ['process'] };
    expect(await errorOf(s.api('POST', '/sync-sources', { ...base, repoUrl: 'http://git.example.com/a/b' }))).toContain('only https://');
    expect(await errorOf(s.api('POST', '/sync-sources', { ...base, repoUrl: 'https://me:secret@git.example.com/a/b' }))).toContain('token field');
    expect(await errorOf(s.api('POST', '/sync-sources', { ...base, repoUrl: 'https://git.example.com/a' }))).toContain('owner');
    expect(await status(s.api('POST', '/sync-sources', { ...base, repoUrl: 'https://git.example.com/a/b', folder: '../etc' }))).toBe(400);
    expect(await status(s.api('POST', '/sync-sources', { ...base, repoUrl: 'https://git.example.com/a/b', branch: '../main' }))).toBe(400);
    expect(await status(s.api('POST', '/sync-sources', { ...base, repoUrl: 'https://git.example.com/a/b', intervalMinutes: 1 }))).toBe(400);
  });

  it('blocks repository hosts the outbound policy does not allow', async () => {
    const { source: src } = await source('x/y', { repoUrl: 'https://git.blocked.invalid/team/library' });
    expect(await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`))).toContain('outbound policy');
    expect((await s.api('GET', `/sync-sources/${src.id}`)).lastStatus).toBe('error');
    await s.api('DELETE', `/sync-sources/${src.id}`);
  });
});

describe('fetching and staging', () => {
  it('stages every valid file of the folder as a pending update and applies nothing', async () => {
    const { source: src } = await source('steward/library');
    const r = await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(r).toMatchObject({ files: 4, staged: 4, invalid: 0, verified: true });
    const list = await pending(src.id);
    expect(list.map((u) => u.kind).sort()).toEqual(['dashboard', 'monitor', 'process', 'recordType']);
    expect(list.every((u) => u.action === 'create' && u.webUrl.includes('/src/commit/'))).toBe(true);
    // nothing applied yet
    expect(await status(s.api('GET', '/processes/git-user-count'))).toBe(404);
    // a second fetch stages nothing new
    const again = await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(again).toMatchObject({ staged: 0, unchanged: 4 });
    expect((await pending(src.id)).length).toBe(4);
    // the detail carries the incoming definition for the diff
    const d = await s.api('GET', `/sync-updates/${list.find((u) => u.kind === 'process').id}`);
    expect(d.incomingText).toContain('Git demo – Insights Hub user count');
    expect(d.currentText).toBeNull();

    // accept everything as an administrator: real items with their origin
    for (const u of list) await s.api('POST', `/sync-updates/${u.id}/accept`, {});
    const p = await s.api('GET', '/processes/git-user-count');
    expect(p.currentVersion).toBe(1);
    expect((await s.api('GET', '/processes/git-user-count/versions'))[0].comment).toMatch(
      /^From Git: Library steward\/library steward\/processes\/git-user-count\.yaml @ [0-9a-f]{10}/,
    );
    expect((await s.api('GET', '/record-types')).some((t: any) => t.key === 'RCA')).toBe(true);
    const mon = (await s.api('GET', '/monitors')).find((m: any) => m.key === 'git-ih-api');
    expect(mon).toBeTruthy();
    expect((await s.api('GET', '/dashboards/git-overview')).name).toBe('Git demo overview');
    const origins = await olivia('GET', '/sync-origins');
    expect(origins.map((o: any) => o.kind).sort()).toEqual(['dashboard', 'monitor', 'process', 'recordType']);
    expect(origins.find((o: any) => o.kind === 'process')).toMatchObject({
      entityId: 'git-user-count',
      sourceName: 'Library steward/library',
      path: 'steward/processes/git-user-count.yaml',
    });
    const audit = JSON.stringify(await s.api('GET', '/audit?limit=200'));
    for (const a of ['sync.fetched', 'sync.update_accepted']) expect(audit).toContain(a);
  });

  it('turns a change in Git into a new process version after review, and shows conflicts with local edits', async () => {
    const repo = uniqueRepo();
    const file = 'steward/flows/versioned.yaml';
    await commit(repo, { [file]: proc('Versioned from Git', 'v1') });
    const { source: src } = await source(repo);
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const [first] = await pending(src.id);
    // designers review and decide processes
    await dana('POST', `/sync-updates/${first.id}/accept`, {});
    expect((await s.api('GET', '/processes/versioned')).currentVersion).toBe(1);

    await commit(repo, { [file]: proc('Versioned from Git', 'v2') });
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const [upd] = await pending(src.id);
    expect(upd).toMatchObject({ action: 'update', entityId: 'versioned', conflict: false, canDecide: true });
    const d = await dana('GET', `/sync-updates/${upd.id}`);
    expect(d.currentText).toContain('hello v1');
    expect(d.incomingText).toContain('hello v2');
    expect(d.currentDefinition.nodes).toBeTruthy();
    const accepted = await dana('POST', `/sync-updates/${upd.id}/accept`, { comment: 'reviewed' });
    expect(accepted).toMatchObject({ status: 'accepted', resultVersion: 2, decidedBy: 'dana' });
    expect((await s.api('GET', '/processes/versioned')).definition.nodes.some((x: any) => x.message === 'hello v2')).toBe(true);

    // a local edit, then another change in Git → conflict instead of overwriting
    const cur = await s.api('GET', '/processes/versioned');
    await s.api('PUT', '/processes/versioned', { definition: { ...cur.definition, description: 'edited in Steward' }, comment: 'local' });
    await commit(repo, { [file]: proc('Versioned from Git', 'v3') });
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const [c] = await pending(src.id);
    expect(c).toMatchObject({ conflict: true, conflictReason: 'changedLocally' });
    const refused = await errorOf(dana('POST', `/sync-updates/${c.id}/accept`, {}));
    expect(refused).toContain('409');
    expect(refused).toContain('SYNC_CONFLICT');
    expect((await s.api('GET', '/processes/versioned')).currentVersion).toBe(3);
    const forced = await dana('POST', `/sync-updates/${c.id}/accept`, { force: true });
    expect(forced.resultVersion).toBe(4);
    expect(await status(dana('POST', `/sync-updates/${c.id}/accept`, {}))).toBe(409);
  });

  it('keeps rejected changes rejected until Git changes again', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/rejected.yaml': proc('Rejected from Git') });
    const { source: src } = await source(repo);
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const [u] = await pending(src.id);
    expect(await status(olivia('POST', `/sync-updates/${u.id}/reject`, {}))).toBe(403);
    expect(await status(olivia('GET', '/sync-updates'))).toBe(403);
    const r = await dana('POST', `/sync-updates/${u.id}/reject`, { comment: 'not wanted' });
    expect(r).toMatchObject({ status: 'rejected', decidedBy: 'dana', comment: 'not wanted' });
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(0);
    await commit(repo, { 'steward/rejected.yaml': proc('Rejected from Git', 'again') });
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(1);
    expect(await status(s.api('GET', '/processes/rejected'))).toBe(404);
    expect(JSON.stringify(await s.api('GET', '/audit?limit=100'))).toContain('sync.update_rejected');
  });

  it('marks invalid files, files with secrets and oversized files – and ignores files outside the folder', async () => {
    const repo = uniqueRepo();
    await commit(repo, {
      'steward/broken.yaml': 'name: Broken\nsteps:\n  - id: x\n    type: nosuchnode\n',
      'steward/leaky.yaml': proc('Leaky').replace('description: from git', 'description: "token: ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"'),
      'steward/mon.yaml':
        'kind: monitor\nkey: git-unknown-platform\nname: Unknown platform\nchecks:\n  - { id: a, name: A, type: platform, platform: No such platform, path: / }\n',
      'steward/big.yaml': `name: Big\ndescription: "${'x'.repeat(300 * 1024)}"\nsteps: []\n`,
      'steward/bundle.json': JSON.stringify({ format: 'steward-bundle', version: 1, processes: [], dashboards: [] }),
      'steward/tags.yaml': 'name: !!js/function "function () {}"\nsteps: []\n',
      'other/outside.yaml': proc('Outside'),
      'steward/notes.md': '# not a definition',
    });
    const { source: src } = await source(repo);
    const r = await s.api('POST', `/sync-sources/${src.id}/fetch`);
    // a monitor naming a platform that is not there is no longer invalid: the reviewer chooses the platform when accepting
    expect(r).toMatchObject({ files: 6, staged: 1, invalid: 5 });
    const list = await s.api('GET', `/sync-updates?sourceId=${src.id}&status=invalid`);
    const err = (file: string) => list.find((u: any) => u.path === `steward/${file}`).errors.join(' ');
    expect(err('broken.yaml')).toMatch(/nosuchnode|type/i);
    expect(err('leaky.yaml')).toContain('GitHub token');
    expect(err('leaky.yaml')).not.toContain('ghp_');
    const [mon] = (await s.api('GET', `/sync-updates?sourceId=${src.id}&status=pending`)) as any[];
    expect(mon.path).toBe('steward/mon.yaml');
    expect((await s.api('GET', `/sync-updates/${mon.id}`)).platforms[0]).toMatchObject({ ref: 'No such platform', resolved: null });
    expect(await status(s.api('POST', `/sync-updates/${mon.id}/accept`, {}))).toBe(400);
    expect(err('big.yaml')).toContain('limit');
    expect(err('bundle.json')).toContain('Bundles');
    expect(err('tags.yaml')).toMatch(/tag/i);
    expect(list.some((u: any) => u.path.startsWith('other/'))).toBe(false);
    expect(await status(s.api('POST', `/sync-updates/${list[0].id}/accept`, {}))).toBe(409);
    // the same invalid content is not reported twice
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).invalid).toBe(0);
  });

  it('refuses unsigned head commits when signed commits are required', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/s.yaml': proc('Signed only') }, { signed: false });
    const { source: src } = await source(repo, { requireSignedCommits: true });
    expect(await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`))).toContain('not signed');
    expect((await pending(src.id)).length).toBe(0);
    await commit(repo, { 'steward/s.yaml': proc('Signed only', 'signed') }, { signed: true });
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(1);
  });

  it.each([
    ['forgejo', (_repo: string) => ({})],
    ['github', (repo: string) => ({ repoUrl: `${s.base}/mock/github/${repo}` })],
    ['gitlab', (repo: string) => ({ repoUrl: `${s.base}/mock/gitlab/${repo}`, apiUrl: `${s.base}/mock/gitlab/api/v4` })],
  ] as const)('refuses unsigned commits below a signed head when signed commits are required (%s)', async (provider, urls) => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/h.yaml': proc('History', 'v1') });
    const { source: src } = await source(repo, { provider, ...urls(repo), token: TOKEN, requireSignedCommits: true });
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(1);
    const sneaky = await commit(repo, { 'steward/h.yaml': proc('History', 'unsigned change') }, { signed: false });
    await commit(repo, { 'steward/other.yaml': proc('Other history') }, { signed: true });
    const err = await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`));
    expect(err).toContain('409');
    expect(err).toContain('GIT_COMMIT_UNSIGNED');
    expect(err).toContain(sneaky.slice(0, 10));
    // nothing staged: only the first version waits for review
    const list = await pending(src.id);
    expect(list.length).toBe(1);
    expect((await s.api('GET', `/sync-updates/${list[0].id}`)).incomingText).toContain('hello v1');
    expect((await s.api('GET', `/sync-sources/${src.id}`)).lastStatus).toBe('error');
    const failed = await s.api('GET', `/audit?action=sync.fetch_failed&entityId=${src.id}&limit=10`);
    expect(JSON.stringify(failed)).toContain(sneaky.slice(0, 10));
    // a newer signed commit does not hide the unsigned one
    await commit(repo, { 'steward/third.yaml': proc('Third history') }, { signed: true });
    expect(await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`))).toContain('GIT_COMMIT_UNSIGNED');
    expect((await pending(src.id)).length).toBe(1);
  });

  it('refuses the fetch when the commits since the last fetched one cannot be listed', async () => {
    const { db } = await import('../src/db.js');
    const repo = uniqueRepo();
    await commit(repo, { 'steward/rewritten.yaml': proc('Rewritten history') });
    const { source: src } = await source(repo, { requireSignedCommits: true });
    // the last fetched commit is gone from the host (force push and garbage collection)
    db().run('UPDATE sync_sources SET last_commit = ? WHERE id = ?', 'ab'.repeat(20), src.id);
    const err = await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`));
    expect(err).toContain('GIT_HISTORY_UNKNOWN');
    expect((await pending(src.id)).length).toBe(0);
  });

  it('accepts only commits of allowed signers when the source names them (login or e-mail)', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/allowed.yaml': proc('Allowed signer', 'v1') }, { signer: 'alice' });
    const { source: src } = await source(repo, { requireSignedCommits: true, allowedSigners: [' Alice ', 'carol@example.org', 'alice'] });
    expect(src.allowedSigners).toEqual(['alice', 'carol@example.org']);
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(1);
    const bob = await commit(repo, { 'steward/allowed.yaml': proc('Allowed signer', 'v2') }, { signer: 'bob' });
    await commit(repo, { 'steward/allowed.yaml': proc('Allowed signer', 'v3') }, { signer: 'alice' });
    const err = await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`));
    expect(err).toContain('GIT_SIGNER_NOT_ALLOWED');
    expect(err).toContain(bob.slice(0, 10));
    expect((await s.api('GET', `/sync-updates/${(await pending(src.id))[0].id}`)).incomingText).toContain('hello v1');

    // the first fetch checks the head commit; an e-mail address matches too
    const other = uniqueRepo();
    await commit(other, { 'steward/carol.yaml': proc('Carol signed') }, { signer: 'carol', email: 'Carol@Example.org' });
    const { source: second } = await source(other, { requireSignedCommits: true, allowedSigners: ['carol@example.org'] });
    expect((await s.api('POST', `/sync-sources/${second.id}/fetch`)).staged).toBe(1);
    const third = uniqueRepo();
    await commit(third, { 'steward/dave.yaml': proc('Dave signed') }, { signer: 'dave' });
    const { source: refused } = await source(third, { requireSignedCommits: true, allowedSigners: ['alice'] });
    expect(await errorOf(s.api('POST', `/sync-sources/${refused.id}/fetch`))).toContain('GIT_SIGNER_NOT_ALLOWED');
    expect((await pending(refused.id)).length).toBe(0);
    // entries are logins or e-mail addresses
    expect(await status(source(uniqueRepo(), { allowedSigners: ['two words'] }))).toBe(400);
  });

  it('checks file contents against SHA-256 object ids', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/sha256.yaml': proc('SHA-256 repository', 'v1') }, { objectFormat: 'sha256' });
    const { source: src } = await source(repo);
    const first = await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(first).toMatchObject({ staged: 1 });
    expect(first.commit).toMatch(/^[0-9a-f]{64}$/);
    await commit(repo, { 'steward/sha256.yaml': proc('SHA-256 repository', 'v2') });
    await fetch(`${s.base}/mock/git/_tamper`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo, path: 'steward/sha256.yaml', content: proc('SHA-256 repository', 'tampered') }),
    });
    expect(await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`))).toContain('does not match its Git object id');
    const list = await pending(src.id);
    expect(list.length).toBe(1);
    expect((await s.api('GET', `/sync-updates/${list[0].id}`)).incomingText).toContain('hello v1');
  });

  it('reads private repositories with the token and sends it to the API only', async () => {
    const { source: src } = await source('steward/private', { kinds: ['process'] });
    expect(await errorOf(s.api('POST', `/sync-sources/${src.id}/fetch`))).toContain('not found');
    await s.api('PUT', `/sync-sources/${src.id}`, { ...src, token: TOKEN });
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(1);
    const calls = (await (await fetch(`${s.base}/mock/git/_calls?repo=steward/private`)).json()) as any[];
    expect(calls.filter((c) => c.token).every((c) => c.tokenOk && c.path.startsWith('/mock/git/api/v1/repos/steward/private/'))).toBe(true);
    const everything = JSON.stringify([
      await s.api('GET', '/sync-sources'),
      await s.api('GET', '/sync-updates?status=pending,invalid,accepted'),
      await s.api('GET', '/audit?limit=200'),
    ]);
    expect(everything).not.toContain(TOKEN);
  });

  it.each([
    ['github', (repo: string) => ({ repoUrl: `${s.base}/mock/github/${repo}` }), '/blob/'],
    ['gitlab', (repo: string) => ({ repoUrl: `${s.base}/mock/gitlab/${repo}`, apiUrl: `${s.base}/mock/gitlab/api/v4` }), '/-/blob/'],
  ] as const)('works with the %s API', async (provider, urls, web) => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/p.yaml': proc(`From ${provider}`), 'steward/sub/d.yaml': 'name: D\nwidgets: []\n' });
    const { source: src } = await source(repo, { provider, ...urls(repo), token: TOKEN });
    const r = await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(r).toMatchObject({ files: 2, staged: 2, verified: true });
    expect((await pending(src.id))[0].webUrl).toContain(web);
  });

  it('auto-accepts new items when the source allows it (monitors disabled), changes still wait for review', async () => {
    const repo = uniqueRepo();
    await commit(repo, {
      'steward/auto.yaml': proc('Auto from Git'),
      'steward/auto-mon.yaml':
        'kind: monitor\nkey: git-auto-mon\nname: Auto monitor\nenabled: true\nchecks:\n  - { id: a, name: A, type: platform, platform: Insights Hub (demo), path: / }\n',
    });
    const { source: src } = await source(repo, { autoAcceptNew: true });
    const r = await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(r.autoAccepted).toBe(2);
    expect((await s.api('GET', '/processes/auto')).currentVersion).toBe(1);
    expect((await s.api('GET', '/monitors')).find((m: any) => m.key === 'git-auto-mon').enabled).toBe(false);
    await commit(repo, { 'steward/auto.yaml': proc('Auto from Git', 'changed') });
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect((await pending(src.id)).map((u) => u.action)).toEqual(['update']);
  });

  it('links identical local items instead of staging them', async () => {
    const repo = uniqueRepo();
    const text = proc('Identical twin');
    await s.api('POST', '/processes', { text });
    await commit(repo, { 'steward/identical-twin.yaml': text });
    const { source: src } = await source(repo);
    expect(await s.api('POST', `/sync-sources/${src.id}/fetch`)).toMatchObject({ staged: 0, unchanged: 1 });
    expect((await s.api('GET', '/sync-origins?kind=process')).some((o: any) => o.entityId === 'identical-twin')).toBe(true);
  });

  it('stages an existing local item that never came from Git as a conflict', async () => {
    const repo = uniqueRepo();
    await s.api('POST', '/processes', { text: proc('Local first') });
    await commit(repo, { 'steward/local-first.yaml': proc('Local first', 'from git') });
    const { source: src } = await source(repo);
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const [u] = await pending(src.id);
    expect(u).toMatchObject({ action: 'update', entityId: 'local-first', conflict: true });
  });

  it('a "new" item created in Steward after the fetch is updated, not copied', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/created-later.yaml': proc('Created later', 'from git') });
    const { source: src } = await source(repo);
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const [u] = await pending(src.id);
    expect(u).toMatchObject({ action: 'create' });
    // the same process is created in Steward afterwards (e.g. from the built-in template)
    await s.api('POST', '/processes', { text: proc('Created later') });
    // shown as a change of the existing process, which never came from Git
    expect(await s.api('GET', `/sync-updates/${u.id}`)).toMatchObject({
      action: 'update',
      entityId: 'created-later',
      conflict: true,
      conflictReason: 'notFromGit',
    });
    // accepting must not create "created-later-2": it is a change of the existing process, which never came from Git
    expect(await errorOf(s.api('POST', `/sync-updates/${u.id}/accept`, {}))).toContain('accept anyway');
    await s.api('POST', `/sync-updates/${u.id}/accept`, { force: true });
    const ids = ((await s.api('GET', '/processes')) as any[]).map((p) => p.id).filter((id: string) => id.startsWith('created-later'));
    expect(ids).toEqual(['created-later']);
    expect((await s.api('GET', '/processes/created-later')).currentVersion).toBe(2);
  });

  it('a fetch drops a "new" item that now exists identically in Steward', async () => {
    const repo = uniqueRepo();
    const text = proc('Same later');
    await commit(repo, { 'steward/same-later.yaml': text });
    const { source: src } = await source(repo);
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(await pending(src.id)).toHaveLength(1);
    await s.api('POST', '/processes', { text });
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(await pending(src.id)).toHaveLength(0);
    expect((await s.api('GET', '/sync-origins?kind=process')).some((o: any) => o.entityId === 'same-later')).toBe(true);
  });
});

describe('visibility and retention', () => {
  it('hides updates of items the reviewer cannot see', async () => {
    const repo = uniqueRepo();
    await s.api('POST', '/processes', { text: proc('Hidden local process') });
    await s.api('PUT', '/processes/hidden-local-process/access', { acl: [{ subject: 'user:admin', permissions: ['view', 'edit'] }] });
    const monitorFile = (name: string) =>
      `kind: monitor\nkey: git-hidden-mon\nname: ${name}\nchecks:\n  - { id: a, name: A, type: platform, platform: Insights Hub (demo), path: / }\n`;
    await commit(repo, { 'steward/mon.yaml': monitorFile('Hidden monitor name') });
    const { source: src } = await source(repo);
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    await s.api('POST', `/sync-updates/${(await pending(src.id))[0].id}/accept`, {});
    const mon = (await s.api('GET', '/monitors')).find((m: any) => m.key === 'git-hidden-mon');
    await s.api('PUT', `/monitors/${mon.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['manage'] }] });

    await commit(repo, {
      'steward/hidden-local-process.yaml': proc('Renamed in Git'),
      'steward/mon.yaml': monitorFile('Renamed monitor'),
    });
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const all = await pending(src.id);
    expect(all.map((u) => u.entityName).sort()).toEqual(['Hidden local process', 'Hidden monitor name']);
    const asAdmin = await s.api('GET', `/sync-updates/${all.find((u) => u.kind === 'process').id}`);
    expect(asAdmin.currentText).toContain('Hidden local process');

    // dana (designer) has no view right on either item
    const listed = JSON.stringify(await dana('GET', `/sync-updates?sourceId=${src.id}&status=pending,accepted`));
    expect(listed).not.toContain('Hidden local process');
    expect(listed).not.toContain('Hidden monitor name');
    expect(listed).not.toContain('hidden-local-process');
    for (const u of all) {
      expect(await status(dana('GET', `/sync-updates/${u.id}`))).toBe(404);
      expect(await status(dana('POST', `/sync-updates/${u.id}/accept`, { force: true }))).toBe(404);
      expect(await status(dana('POST', `/sync-updates/${u.id}/reject`, {}))).toBe(404);
    }
    expect((await s.api('GET', '/processes/hidden-local-process')).currentVersion).toBe(1);
  });

  it('writes one audit entry per fetch and prunes old superseded and rejected updates', async () => {
    const { db } = await import('../src/db.js');
    const repo = uniqueRepo();
    await commit(repo, { 'steward/keep-one.yaml': proc('Retention one'), 'steward/keep-two.yaml': proc('Retention two') });
    const { source: src } = await source(repo);
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(2);
    const fetched = await s.api('GET', `/audit?action=sync.fetched&entityId=${src.id}&limit=10`);
    expect(fetched.length).toBe(1);
    expect(fetched[0].details.staged.map((x: any) => x.path).sort()).toEqual(['steward/keep-one.yaml', 'steward/keep-two.yaml']);
    const ids = (await pending(src.id)).map((u) => u.id);
    for (const id of ids) expect(await s.api('GET', `/audit?entityId=${id}&limit=10`)).toEqual([]);

    const one = (await pending(src.id)).find((u) => u.path.endsWith('keep-one.yaml'));
    await s.api('POST', `/sync-updates/${one.id}/reject`, { comment: 'no' });
    await commit(repo, { 'steward/keep-two.yaml': proc('Retention two', 'v2') });
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    const superseded = await s.api('GET', `/sync-updates?sourceId=${src.id}&status=superseded`);
    expect(superseded.length).toBe(1);

    // 31 days later
    const old = new Date(Date.now() - 31 * 86400_000).toISOString();
    db().run('UPDATE sync_updates SET created_at = ?, decided_at = CASE WHEN decided_at IS NULL THEN NULL ELSE ? END WHERE source_id = ?', old, old, src.id);
    await s.api('POST', `/sync-sources/${src.id}/fetch`);
    expect(await s.api('GET', `/sync-updates?sourceId=${src.id}&status=superseded`)).toEqual([]);
    const rejected = await s.api('GET', `/sync-updates/${one.id}`);
    expect(rejected).toMatchObject({ status: 'rejected', comment: 'no', contentRemoved: true, incomingText: '' });
    expect(db().get<{ content: string | null }>('SELECT content FROM sync_updates WHERE id = ?', one.id)!.content).toBeNull();
    // still rejected until Git changes again; the open update keeps its content
    expect((await s.api('POST', `/sync-sources/${src.id}/fetch`)).staged).toBe(0);
    const open = (await pending(src.id))[0];
    expect((await s.api('GET', `/sync-updates/${open.id}`)).incomingText).toContain('hello v2');
  });
});

describe('Git sync webhook', () => {
  const hook = async (id: string, body: string, headers: Record<string, string>) => {
    const res = await fetch(`${s.base}/api/hooks/sync/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    return { status: res.status, body: await res.json() };
  };
  const sign = (secret: string, raw: string) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const waitFetched = async (id: string, since: string | null) => {
    for (let i = 0; i < 100; i++) {
      const src = await s.api('GET', `/sync-sources/${id}`);
      if (src.lastFetchAt && src.lastFetchAt !== since) return src;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('no fetch');
  };

  it('fetches on a signed push event and refuses everything else', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/hooked.yaml': proc('Hooked') });
    const { source: src, webhookSecret } = await source(repo, { webhookEnabled: true });
    const push = JSON.stringify({ ref: 'refs/heads/main' });
    expect((await hook(src.id, push, { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    expect((await hook(src.id, push, {})).status).toBe(401);
    expect(
      (await hook(src.id, JSON.stringify({ ref: 'refs/heads/dev' }), { 'x-forgejo-signature': sign(webhookSecret, JSON.stringify({ ref: 'refs/heads/dev' })) }))
        .body,
    ).toEqual({
      skipped: 'other branch',
    });
    const ok = await hook(src.id, push, { 'x-hub-signature-256': `sha256=${sign(webhookSecret, push)}` });
    expect(ok).toEqual({ status: 202, body: { fetching: true } });
    await waitFetched(src.id, null);
    expect((await pending(src.id)).length).toBe(1);
    // GitLab sends the secret itself
    expect((await hook(src.id, push, { 'x-gitlab-token': webhookSecret })).status).toBe(202);
    expect((await hook(src.id, push, { 'x-gitlab-token': 'wrong' })).status).toBe(401);
    // unknown sources and sources without webhook look the same
    expect((await hook('gsr_doesnotexist1', push, {})).status).toBe(404);
    await s.api('PUT', `/sync-sources/${src.id}`, { ...src, webhookEnabled: false });
    expect((await hook(src.id, push, { 'x-hub-signature-256': `sha256=${sign(webhookSecret, push)}` })).status).toBe(404);
    // rotation: the old secret stops working
    await s.api('PUT', `/sync-sources/${src.id}`, { ...src, webhookEnabled: true });
    const rotated = await s.api('POST', `/sync-sources/${src.id}/rotate-webhook-secret`);
    expect(rotated.webhookSecret).not.toBe(webhookSecret);
    expect((await hook(src.id, push, { 'x-gitlab-token': webhookSecret })).status).toBe(401);
    expect(JSON.stringify(await s.api('GET', '/audit?limit=100'))).toContain('sync.webhook_rejected');
  });

  it('rate-limits webhook calls per source', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/rl.yaml': proc('Rate limited') });
    const { source: src, webhookSecret } = await source(repo, { webhookEnabled: true });
    const body = '{}';
    const h = { 'x-gitea-signature': sign(webhookSecret, body) };
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await hook(src.id, body, h)).status);
    expect(statuses.filter((x) => x === 202).length).toBe(12);
    expect(statuses.at(-1)).toBe(429);
  });
});

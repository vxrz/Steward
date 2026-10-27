import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

// Git sync 0.2.1: sources follow a branch or a tag (also `v{version}`), files can name the Steward
// version they need, and Steward's own example library is offered as a disabled source.
let s: TestServer;
let version = '';
const TOKEN = 'mock-git-token-0123456789';
const EXAMPLES = 'gsr_steward-examples';

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => '',
    (e: Error) => e.message,
  );

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${s.base}/mock/git/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, path).toBe(200);
  return (await res.json()) as { sha: string };
};
const commit = async (repo: string, files: Record<string, string | null>) => (await post('_commit', { repo, files, signed: true })).sha;
const tag = (repo: string, name: string, o: { annotated?: boolean; sha?: string } = {}) => post('_tag', { repo, tag: name, ...o });

const proc = (name: string, extra = '', header = '') => `${header}name: "${name}"
description: from git
steps:
  - id: hello
    type: log
    message: "hello ${extra}"
`;

let n = 0;
const uniqueRepo = () => `team/refs-${Date.now().toString(36)}-${n++}`;

async function source(repo: string, body: Record<string, unknown> = {}) {
  return (
    (await s.api('POST', '/sync-sources', {
      name: `Refs ${repo}`,
      provider: 'forgejo',
      repoUrl: `${s.base}/mock/git/${repo}`,
      branch: 'main',
      folder: 'steward',
      kinds: ['process', 'dashboard'],
      ...body,
    })) as { source: any }
  ).source;
}
const fetchNow = (id: string) => s.api('POST', `/sync-sources/${id}/fetch`);
const updates = async (id: string, status = 'pending') => (await s.api('GET', `/sync-updates?sourceId=${id}&status=${status}`)) as any[];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  // the demo platforms point at this server, so the outbound policy allows the mock Git host
  await s.api('POST', '/demo/setup', {});
  version = (await import('../src/config.js')).config.version;
}, 120_000);
afterAll(async () => {
  await s?.app.close();
  if (s) fs.rmSync(s.dataDir, { recursive: true, force: true });
});

describe('following a tag', () => {
  it('fetches the commit a tag points to, lightweight or annotated, and sees a moved tag as a change', async () => {
    const repo = uniqueRepo();
    const first = await commit(repo, { 'steward/t.yaml': proc('Tagged', 'v1') });
    await tag(repo, 'release-1');
    const src = await source(repo, { refType: 'tag', branch: 'release-1' });
    expect(src).toMatchObject({ refType: 'tag', branch: 'release-1', resolvedRef: 'release-1', builtIn: false });
    expect(await fetchNow(src.id)).toMatchObject({ ref: 'release-1', commit: first, files: 1, staged: 1 });
    expect((await s.api('GET', `/sync-sources/${src.id}`)).lastRef).toBe('release-1');
    // new commits on the branch don't matter while the tag stays
    const second = await commit(repo, { 'steward/t.yaml': proc('Tagged', 'v2') });
    expect(await fetchNow(src.id)).toMatchObject({ commit: first, staged: 0, unchanged: 1 });
    // the tag moves (now as an annotated tag): its new commit is staged
    await tag(repo, 'release-1', { annotated: true, sha: second });
    expect(await fetchNow(src.id)).toMatchObject({ commit: second, staged: 1 });
    expect(await errorOf(s.api('PUT', `/sync-sources/${src.id}`, { ...src, branch: 'no-such-tag' }).then(() => fetchNow(src.id)))).toContain('not found');
    const audit = JSON.stringify(await s.api('GET', `/audit?entityType=sync_source&entityId=${src.id}&limit=20`));
    expect(audit).toContain('fetched tag release-1@');
  });

  it.each([
    ['github', (repo: string) => ({ repoUrl: `${s.base}/mock/github/${repo}` })],
    ['gitlab', (repo: string) => ({ repoUrl: `${s.base}/mock/gitlab/${repo}`, apiUrl: `${s.base}/mock/gitlab/api/v4` })],
  ] as const)('works with the %s API (annotated tags too)', async (provider, urls) => {
    const repo = uniqueRepo();
    const sha = await commit(repo, { 'steward/p.yaml': proc(`Tag from ${provider}`) });
    await tag(repo, 'r1', { annotated: true });
    await commit(repo, { 'steward/p.yaml': proc(`Tag from ${provider}`, 'later') });
    const src = await source(repo, { provider, ...urls(repo), token: TOKEN, refType: 'tag', branch: 'r1', requireSignedCommits: true });
    expect(await fetchNow(src.id)).toMatchObject({ ref: 'r1', commit: sha, staged: 1, verified: true });
  });

  it('resolves {version} to this installation’s version at every fetch', async () => {
    const repo = uniqueRepo();
    const sha = await commit(repo, { 'steward/v.yaml': proc('Versioned tag') });
    await tag(repo, `v${version}`);
    const src = await source(repo, { refType: 'tag', branch: 'v{version}' });
    expect(src.resolvedRef).toBe(`v${version}`);
    expect(await fetchNow(src.id)).toMatchObject({ ref: `v${version}`, commit: sha, staged: 1 });
  });

  it('accepts only branch and tag names Git allows, with {version} as the only placeholder', async () => {
    const repo = uniqueRepo();
    for (const bad of ['v{ver}', '{version', '../v{version}', 'a b']) {
      expect(await errorOf(source(repo, { refType: 'tag', branch: bad })), bad).toMatch(/branch or tag name/i);
    }
    expect(await errorOf(source(repo, { refType: 'commit', branch: 'main' }))).not.toBe('');
    const ok = await source(repo, { refType: 'tag', branch: 'release/{version}' });
    expect(ok.resolvedRef).toBe(`release/${version}`);
    await s.api('DELETE', `/sync-sources/${ok.id}`);
  });
});

describe('minimum Steward version per file', () => {
  it('lists files that need a newer Steward instead of staging them, and stages them after the upgrade', async () => {
    const repo = uniqueRepo();
    await commit(repo, {
      'steward/new.yaml': proc('Needs a newer Steward', '', '# Needs a function of 99.0\n# steward-min-version: 99.0.0\n'),
      'steward/old.yaml': proc('Works today', '', '# steward-min-version: 0.0.1\n'),
    });
    const src = await source(repo);
    expect(await fetchNow(src.id)).toMatchObject({ files: 2, staged: 1, invalid: 1 });
    expect((await updates(src.id)).map((u) => u.path)).toEqual(['steward/old.yaml']);
    const [waiting] = await updates(src.id, 'invalid');
    expect(waiting).toMatchObject({ path: 'steward/new.yaml', minVersion: '99.0.0' });
    expect(waiting.errors[0]).toContain(`Needs Steward 99.0.0 or newer – this installation runs ${version}`);
    // the same file stays where it is while the version is too old
    expect(await fetchNow(src.id)).toMatchObject({ staged: 0, unchanged: 2 });
    // after an "upgrade" the unchanged file is staged
    const { config } = await import('../src/config.js');
    config.version = '99.0.0';
    try {
      expect(await fetchNow(src.id)).toMatchObject({ staged: 1 });
    } finally {
      config.version = version;
    }
    expect((await updates(src.id)).map((u) => u.path).sort()).toEqual(['steward/new.yaml', 'steward/old.yaml']);
  });

  it('reads the marker from the comment lines at the top of YAML files only', async () => {
    const { minVersionOf, newerThan } = await import('../src/sync/items.js');
    expect(minVersionOf('a.yaml', '---\n# steward-min-version: v0.2.1\nname: x\n')).toBe('0.2.1');
    expect(minVersionOf('a.yml', '#steward-min-version:0.3.0\n')).toBe('0.3.0');
    expect(minVersionOf('a.yaml', 'name: x\n# steward-min-version: 0.3.0\n')).toBeNull();
    expect(minVersionOf('a.json', '# steward-min-version: 0.3.0\n')).toBeNull();
    expect(minVersionOf('a.yaml', '# steward-min-version: 0.3\n')).toBeNull();
    expect(newerThan('0.2.1', '0.2.0')).toBe(true);
    expect(newerThan('0.10.0', '0.9.9')).toBe(true);
    expect(newerThan('0.2.0', '0.2.0')).toBe(false);
    expect(newerThan('0.2.0', '0.2.1-rc.1')).toBe(false);
    expect(newerThan('1.0.0', 'dev')).toBe(false);
  });
});

describe("Steward's example library", () => {
  it('is offered once as a disabled source without a token, and not brought back after it was deleted', async () => {
    const src = await s.api('GET', `/sync-sources/${EXAMPLES}`);
    expect(src).toMatchObject({
      name: 'Steward example library',
      provider: 'github',
      repoUrl: 'https://github.com/vxrz/Steward',
      refType: 'tag',
      branch: 'v{version}',
      resolvedRef: `v${version}`,
      folder: 'examples',
      kinds: ['process', 'dashboard', 'monitor'],
      enabled: false,
      autoAcceptNew: false,
      hasToken: false,
      webhookEnabled: false,
      intervalMinutes: 0,
      builtIn: true,
      createdBy: 'system',
      lastFetchAt: null,
    });
    const audit = await s.api('GET', `/audit?entityType=sync_source&entityId=${EXAMPLES}&limit=10`);
    expect(audit.filter((a: any) => a.action === 'sync.source_created')).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: 'system' });

    const { seedExamplesSource } = await import('../src/sync/service.js');
    expect(seedExamplesSource()).toBe(false);
    // an administrator's changes stay
    await s.api('PUT', `/sync-sources/${EXAMPLES}`, { ...src, intervalMinutes: 60 });
    expect(seedExamplesSource()).toBe(false);
    expect((await s.api('GET', `/sync-sources/${EXAMPLES}`)).intervalMinutes).toBe(60);
    await s.api('DELETE', `/sync-sources/${EXAMPLES}`);
    expect(seedExamplesSource()).toBe(false);
    expect((await s.api('GET', '/sync-sources')).some((x: any) => x.id === EXAMPLES)).toBe(false);
  });
});

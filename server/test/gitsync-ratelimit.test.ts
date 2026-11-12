import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

// Git sync 0.20.0: a Git host's rate limit is told apart from "access denied", a fetch that stops midway stages
// nothing, and file contents Steward already knows (the shipped examples, recent downloads) are not downloaded again.
let s: TestServer;
const TOKEN = 'mock-git-token-0123456789';

const errorBody = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: { code: string; params?: Record<string, unknown>; error: string } }) => e.body,
  );
const mock = async (what: string, body: unknown) => {
  const res = await fetch(`${s.base}/mock/git/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, what).toBe(200);
  return (await res.json()) as { sha: string };
};
const commit = (repo: string, files: Record<string, string>) => mock('_commit', { repo, files, signed: true });
const limit = (repo: string, after: number | null, o: { status?: number; headers?: Record<string, string>; message?: string } = {}) =>
  mock('_limit', { repo, after, ...o });
const calls = async (repo: string) => (await (await fetch(`${s.base}/mock/git/_calls?repo=${repo}`)).json()) as { path: string }[];
const blobCalls = async (repo: string) => (await calls(repo)).filter((c) => /\/git\/blobs\/|\/repository\/blobs\//.test(c.path)).length;

const proc = (name: string) => `name: "${name}"
description: from git
steps:
  - id: hello
    type: log
    message: "hello ${name}"
`;

let n = 0;
const uniqueRepo = () => `team/limit-${Date.now().toString(36)}-${n++}`;
const github = (repo: string, body: Record<string, unknown> = {}) =>
  s
    .api('POST', '/sync-sources', {
      name: `Rate limit ${repo}`,
      provider: 'github',
      repoUrl: `${s.base}/mock/github/${repo}`,
      branch: 'main',
      folder: 'steward',
      kinds: ['process', 'dashboard', 'monitor'],
      ...body,
    })
    .then((r: { source: { id: string } }) => r.source);
const fetchNow = (id: string) => s.api('POST', `/sync-sources/${id}/fetch`);
const pending = async (id: string) => (await s.api('GET', `/sync-updates?sourceId=${id}&status=pending,invalid`)) as unknown[];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  // the demo platforms point at this server, so the outbound policy allows the mock Git host
  await s.api('POST', '/demo/setup', {});
}, 120_000);
beforeEach(async () => {
  (await import('../src/sync/blobCache.js')).resetBlobCache();
});

describe('rate limits of the Git hosts', () => {
  it('are recognised from the status, the headers and the message', async () => {
    const { rateLimitOf } = await import('../src/sync/providers.js');
    const now = Date.parse('2026-11-12T10:00:00Z');
    const h = (o: Record<string, string>) => new Headers(o);
    // GitHub, primary limit used up: 403 with x-ratelimit-remaining 0 and the reset time in epoch seconds
    expect(rateLimitOf(403, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 1800) }), '', now)).toEqual({
      retryAt: new Date('2026-11-12T10:30:00Z'),
    });
    // GitHub, secondary limit: 403 or 429 with retry-after seconds
    expect(rateLimitOf(403, h({ 'retry-after': '60' }), 'You have exceeded a secondary rate limit', now)?.retryAt).toEqual(new Date('2026-11-12T10:01:00Z'));
    expect(rateLimitOf(429, h({ 'retry-after': '120' }), '', now)?.retryAt).toEqual(new Date('2026-11-12T10:02:00Z'));
    // the message alone
    expect(rateLimitOf(403, h({}), '{"message":"API rate limit exceeded for 192.0.2.1."}', now)).toEqual({ retryAt: null });
    // GitLab: 429 with RateLimit-Reset; Forgejo/Gitea: 429 with retry-after as an HTTP date
    expect(rateLimitOf(429, h({ 'ratelimit-remaining': '0', 'ratelimit-reset': String(now / 1000 + 90) }), '', now)?.retryAt).toEqual(
      new Date('2026-11-12T10:01:30Z'),
    );
    expect(rateLimitOf(429, h({ 'retry-after': 'Thu, 12 Nov 2026 10:05:00 GMT' }), '', now)?.retryAt).toEqual(new Date('2026-11-12T10:05:00Z'));
    // a 429 without any hint, and implausible times: limited, no time
    expect(rateLimitOf(429, h({}), '', now)).toEqual({ retryAt: null });
    expect(rateLimitOf(429, h({ 'x-ratelimit-reset': String(now / 1000 - 60) }), '', now)).toEqual({ retryAt: null });
    expect(rateLimitOf(429, h({ 'retry-after': String(30 * 86400) }), '', now)).toEqual({ retryAt: null });
    // a real "access denied" stays one
    expect(rateLimitOf(403, h({ 'x-ratelimit-remaining': '4999' }), '{"message":"Resource not accessible by personal access token"}', now)).toBeNull();
    expect(rateLimitOf(401, h({ 'x-ratelimit-remaining': '0' }), '', now)).toBeNull();
  });

  it('GitHub: a used-up limit midway through a fetch is reported as such, stages nothing and the next fetch goes on where it stopped', async () => {
    const repo = uniqueRepo();
    await commit(repo, Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`steward/processes/limit-${i}.yaml`, proc(`Limit ${repo} ${i}`)])));
    const src = await github(repo);
    // branch + tree + two files, then GitHub's answer to a used-up limit (403, remaining 0, reset in epoch seconds)
    const reset = Math.ceil(Date.now() / 1000) + 1200;
    await limit(repo, 4, { headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    const err = await errorBody(fetchNow(src.id));
    expect(err).toMatchObject({ code: 'GIT_RATE_LIMITED', params: { status: 403, retryAt: new Date(reset * 1000).toISOString(), context: 'retryNoToken' } });
    expect(err!.error).toContain('rate limit');
    expect(err!.error).toContain('5,000 calls an hour');
    expect(err!.error).not.toContain('192.0.2.1'); // GitHub's message (with the caller's address) is not repeated
    expect(await pending(src.id)).toHaveLength(0);
    const failed = await s.api('GET', `/sync-sources/${src.id}`);
    expect(failed).toMatchObject({
      lastStatus: 'error',
      lastCommit: null,
      lastErrorCode: 'GIT_RATE_LIMITED',
      lastErrorParams: { context: 'retryNoToken', retryAt: new Date(reset * 1000).toISOString() },
    });
    const audit = (await s.api('GET', `/audit?entityType=sync_source&entityId=${src.id}&limit=10`)) as { action: string }[];
    expect(audit.map((a) => a.action)).toContain('sync.fetch_failed');
    expect(audit.map((a) => a.action)).not.toContain('sync.fetched');

    // the limit is reset: the two files read before are not downloaded again
    await limit(repo, null);
    const before = await blobCalls(repo);
    expect(await fetchNow(src.id)).toMatchObject({ files: 5, staged: 5 });
    expect((await blobCalls(repo)) - before).toBe(3);
    expect(await s.api('GET', `/sync-sources/${src.id}`)).toMatchObject({ lastStatus: 'ok', lastError: null, lastErrorCode: null, lastErrorParams: null });
  });

  it('a scheduled fetch waits until the time the rate limit named', async () => {
    const { dueSources } = await import('../src/sync/engine.js');
    const { db } = await import('../src/db.js');
    const repo = uniqueRepo();
    await commit(repo, { 'steward/processes/scheduled.yaml': proc(`Scheduled ${repo}`) });
    const src = await github(repo, { intervalMinutes: 5 });
    const reset = Math.ceil(Date.now() / 1000) + 3600;
    await limit(repo, 0, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } });
    expect(await errorBody(fetchNow(src.id))).toMatchObject({ code: 'GIT_RATE_LIMITED' });
    const later = Date.now() + 10 * 60000;
    expect(dueSources(later)).not.toContain(src.id);
    expect(dueSources(reset * 1000 + 1000)).toContain(src.id);
    // other errors keep the schedule
    db().run('UPDATE sync_sources SET last_error_detail = ? WHERE id = ?', JSON.stringify({ code: 'GIT_UNREACHABLE' }), src.id);
    expect(dueSources(later)).toContain(src.id);
    await limit(repo, null);
  });

  it('GitHub: a secondary limit names when to try again; with a token there is no advice to add one', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/processes/second.yaml': proc(`Secondary ${repo}`) });
    const src = await github(repo, { token: TOKEN });
    await limit(repo, 0, { status: 429, headers: { 'retry-after': '60' }, message: 'You have exceeded a secondary rate limit' });
    const err = await errorBody(fetchNow(src.id));
    expect(err).toMatchObject({ code: 'GIT_RATE_LIMITED', params: { status: 429, context: 'retry' } });
    expect(err!.error).not.toContain('add a read-only access token');
  });

  it('a 403 without the signs of a rate limit is still "access denied" (naming the token only when there is one)', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/processes/denied.yaml': proc(`Denied ${repo}`) });
    const anonymous = await github(repo);
    await limit(repo, 0, { status: 403, headers: { 'x-ratelimit-remaining': '42' }, message: 'Resource not accessible by integration' });
    expect(await errorBody(fetchNow(anonymous.id))).toMatchObject({ code: 'GIT_ACCESS_DENIED', params: { status: 403, context: 'noToken' } });
    const withToken = await github(repo, { token: TOKEN });
    const err = await errorBody(fetchNow(withToken.id));
    expect(err).toMatchObject({ code: 'GIT_ACCESS_DENIED', params: { status: 403 } });
    expect(err!.params).not.toHaveProperty('context');
  });

  it('GitLab and Forgejo: 429 is a rate limit', async () => {
    const repo = uniqueRepo();
    await commit(repo, { 'steward/processes/gl.yaml': proc(`GitLab ${repo}`) });
    const gl = await github(repo, { provider: 'gitlab', repoUrl: `${s.base}/mock/gitlab/${repo}`, apiUrl: `${s.base}/mock/gitlab/api/v4` });
    const reset = Math.ceil(Date.now() / 1000) + 300;
    await limit(repo, 0, { status: 429, headers: { 'ratelimit-remaining': '0', 'ratelimit-reset': String(reset) }, message: 'Retry later' });
    expect(await errorBody(fetchNow(gl.id))).toMatchObject({
      code: 'GIT_RATE_LIMITED',
      params: { status: 429, retryAt: new Date(reset * 1000).toISOString(), context: 'retryNoToken' },
    });
    const fj = await github(repo, { provider: 'forgejo', repoUrl: `${s.base}/mock/git/${repo}` });
    await limit(repo, 0, { status: 429, headers: {}, message: 'Too Many Requests' });
    expect(await errorBody(fetchNow(fj.id))).toMatchObject({ code: 'GIT_RATE_LIMITED', params: { status: 429, context: 'noToken' } });
  });
});

describe('known file contents', () => {
  it("Steward's example files shipped with this installation are not downloaded (only files that differ are)", async () => {
    const { config } = await import('../src/config.js');
    const shipped = ['processes', 'dashboards']
      .map((dir) => {
        const file = fs.readdirSync(path.join(config.examplesDir, dir)).find((f) => f.endsWith('.yaml'))!;
        return [`examples/${dir}/${file}`, fs.readFileSync(path.join(config.examplesDir, dir, file), 'utf8')] as const;
      })
      .filter(([, text]) => !/steward-min-version/.test(text));
    expect(shipped.length).toBeGreaterThan(0);
    const repo = uniqueRepo();
    await commit(repo, { ...Object.fromEntries(shipped), 'examples/processes/changed-upstream.yaml': proc(`Changed ${repo}`) });
    const src = await github(repo, { folder: 'examples' });
    const r = await fetchNow(src.id);
    expect(r.files).toBe(shipped.length + 1);
    expect(await blobCalls(repo)).toBe(1);
  });

  it('a downloaded content is used only for the object id it matches', async () => {
    const { knownBlob, rememberBlob } = await import('../src/sync/blobCache.js');
    const { gitBlobSha } = await import('../src/sync/providers.js');
    const content = Buffer.from(proc('Cached'));
    const sha = gitBlobSha(content);
    rememberBlob(sha, content);
    expect(knownBlob(sha, 1024 * 1024)?.toString()).toBe(content.toString());
    expect(knownBlob(sha, 10)).toBeUndefined(); // over the caller's limit
    // a content under another id is not remembered
    const other = 'ab'.repeat(20);
    rememberBlob(other, content);
    expect(knownBlob(other, 1024 * 1024)).toBeUndefined();
  });
});

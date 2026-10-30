import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerfileImages, rangeVersion, stackHints } from '@sm/shared';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Git platforms (#107): GitHub, GitLab and Forgejo as connectors – a repository component read from the mock hosts
 * (branch, pipeline, release, alerts, packages, keys, tech stack from files), the monitor check type `git`, and the
 * access check source `git`.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let ids: Record<'github' | 'gitlab' | 'forgejo', string>;
let mock: typeof import('../src/mock/mockGitPlatforms.js');
let eng: typeof import('../src/monitors/engine.js');

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const ps = await s.api('GET', '/platforms');
  const id = (n: string) => ps.find((p: any) => p.name === n).id;
  ids = { github: id('GitHub (demo)'), gitlab: id('GitLab (demo)'), forgejo: id('Forgejo (demo)') };
  mock = await import('../src/mock/mockGitPlatforms.js');
  eng = await import('../src/monitors/engine.js');
});
afterAll(async () => {
  await s?.app.close();
});

describe('tech stack from repository files', () => {
  it('reads Dockerfiles, package.json, version files, go.mod, global.json, composer.json and pom.xml', () => {
    expect(rangeVersion('^18.2.0')).toBe('18.2.0');
    expect(rangeVersion('>=20')).toBe('20');
    expect(rangeVersion('22.x')).toBe('22');
    expect(rangeVersion('lts/*')).toBe('');
    // a scan in linear time, also on long runs of digits (CodeQL: no polynomial regular expression)
    expect(rangeVersion(`v${'0'.repeat(100_000)}.1`)).toBe('0'.repeat(200 - 1));
    expect(rangeVersion('1.2.3.4-beta')).toBe('1.2.3');
    expect(
      dockerfileImages(
        'ARG NODE=22\nARG BASE\nFROM --platform=$BUILDPLATFORM node:${NODE}-alpine AS build\nFROM build AS test\nFROM ${BASE:-debian:12-slim}\nFROM scratch\nFROM \\\n  nginx:1.27\n# FROM python:2\n',
      ),
    ).toEqual(['node:22-alpine', 'debian:12-slim', 'nginx:1.27']);
    const hints = stackHints({
      'package.json': JSON.stringify({ engines: { node: '^20.11' }, dependencies: { react: '~18.3.1', left: '*' }, devDependencies: { vite: '6' } }),
      '.python-version': '3.12.4\n',
      '.tool-versions': 'nodejs 20.11.1\ngolang 1.23.2\nterraform 1.9\n',
      'go.mod': 'module x\n\ngo 1.23.2\n',
      'global.json': JSON.stringify({ sdk: { version: '8.0.403' } }),
      'composer.json': JSON.stringify({ require: { php: '^8.2', 'laravel/framework': '^11.9', 'ext-json': '*' } }),
      'pom.xml':
        '<project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.4</version></parent><properties><java.version>21</java.version></properties></project>',
      'broken/package.json': '{ not json',
    });
    const show = hints.map((h) => (h.kind === 'product' ? `${h.product} ${h.version}` : h.kind === 'package' ? `${h.purl} ${h.version}` : h.image));
    expect(show).toEqual([
      'nodejs 20.11',
      'pkg:npm/vite 6',
      'pkg:npm/react 18.3.1',
      'pkg:npm/left ',
      'python 3.12.4',
      'nodejs 20.11.1',
      'go 1.23.2',
      'go 1.23',
      'dotnet 8.0',
      'php 8.2',
      'pkg:composer/laravel/framework 11.9',
      'pkg:maven/org.springframework.boot/spring-boot 3.3.4',
      'eclipse-temurin 21',
    ]);
    // an unclosed <parent> is read in linear time (no backtracking regular expression)
    const t0 = Date.now();
    stackHints({ 'pom.xml': '<parent>'.repeat(30_000) });
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('repositories of an application', () => {
  const read = async (appId: string, cmpId: string) =>
    (await s.api('POST', `/applications/${appId}/components/${cmpId}/repository`, {})).components.find((c: any) => c.id === cmpId);

  it('reads a GitHub repository: workflows, release, Dependabot alerts, package, deploy keys, tech stack', async () => {
    mock.resetGitPlatforms();
    const app = await s.api('POST', '/applications', { name: 'Shop on GitHub', owners: [] });
    // a repository is read from a Git platform only, with a repository path
    const k8s = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'kubernetes').id;
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'acme/shop-web', platformId: k8s })).rejects.toThrow(
      /GitHub, GitLab or Forgejo/,
    );
    await expect(s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'shop web', platformId: ids.github })).rejects.toThrow(
      /owner\/repository/,
    );
    // without a platform, a repository stays a plain entry (as before)
    await s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'Old SVN repo' });
    const a = await s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'acme/shop-web', platformId: ids.github });
    const cmp = a.components.find((c: any) => c.name === 'acme/shop-web');
    expect(cmp).toMatchObject({ platformId: ids.github, repository: null });
    const c = await read(app.id, cmp.id);
    expect(c.repository).toMatchObject({
      error: null,
      webUrl: 'https://github.example.com/acme/shop-web',
      defaultBranch: 'main',
      head: { sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', message: 'Merge pull request #42' },
      release: { tag: 'v2.4.1' },
      alerts: { critical: 0, high: 1, medium: 2, low: 0, url: 'https://github.example.com/acme/shop-web/security/dependabot' },
      packages: [{ name: 'shop-web', type: 'container' }],
      stackFiles: ['Dockerfile', 'package.json', '.nvmrc'],
      unmapped: [],
    });
    // the newest run per workflow counts; a cancelled one is skipped
    expect(c.repository.pipeline).toMatchObject({
      state: 'success',
      runs: [
        { name: 'CI', state: 'success' },
        { name: 'CodeQL', state: 'success' },
      ],
    });
    expect(c.repository.keys.map((k: any) => [k.kind, k.title, k.write])).toEqual([
      ['deploy-key', 'argocd (read-only)', false],
      ['deploy-key', 'release bot', true],
    ]);
    expect(c.stack.map((x: any) => [x.product, x.version, x.source])).toEqual([
      ['express', '4.21.2', 'repository'],
      ['nginx', '1.27.3', 'repository'],
      ['nodejs', '22', 'repository'],
      ['react', '18.3.1', 'repository'],
    ]);
    // the files change: the stack follows, an entry changed by hand stays
    mock.setGitFile('shop-web', 'Dockerfile', 'FROM node:24-alpine\n');
    mock.setGitFile('shop-web', '.nvmrc', null);
    mock.setGitFile('shop-web', 'package.json', JSON.stringify({ engines: { node: '>=24' }, dependencies: { react: '^19.0.0' } }));
    await s.api('PUT', `/applications/${app.id}/components/${cmp.id}`, {
      type: 'repository',
      name: 'acme/shop-web',
      stack: [
        { product: 'express', version: '4.21.2' },
        { product: 'nginx', version: '1.26' },
        { product: 'nodejs', version: '22' },
        { product: 'react', version: '18.3.1' },
      ],
    });
    const after = await read(app.id, cmp.id);
    // express left package.json: its entry leaves the stack
    expect(after.stack.map((x: any) => [x.product, x.version, x.source])).toEqual([
      ['nginx', '1.26', 'manual'],
      ['nodejs', '24', 'repository'],
      ['react', '19.0.0', 'repository'],
    ]);
    const audit = await s.api('GET', `/audit?entityType=application&entityId=${app.id}&limit=50`);
    expect(audit.some((e: any) => e.action === 'application.component_repository_read' && /React|react/.test(e.summary))).toBe(true);
  });

  it('reads GitLab (pipeline, release, registry, deploy and access tokens) and Forgejo (commit status), records a failed read', async () => {
    mock.resetGitPlatforms();
    const app = await s.api('POST', '/applications', { name: 'Shop elsewhere', owners: [] });
    let a = await s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'acme/shop/web', platformId: ids.gitlab });
    const gl = await read(app.id, a.components.find((c: any) => c.name === 'acme/shop/web').id);
    expect(gl.repository).toMatchObject({
      error: null,
      webUrl: 'https://gitlab.example.com/acme/shop/web',
      pipeline: { state: 'success', runs: [{ name: 'Pipeline #76', state: 'success' }] },
      release: { tag: 'v2.4.1' },
      alerts: null,
      packages: [{ name: 'acme/shop/shop-web', type: 'container' }],
    });
    expect(gl.repository.keys.map((k: any) => [k.kind, k.title, k.write])).toEqual([
      ['deploy-key', 'argocd (read-only)', false],
      ['deploy-key', 'release bot', true],
      ['deploy-token', 'registry pull', false],
      ['access-token', 'renovate', true],
    ]);
    a = await s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'acme/shop-api', platformId: ids.forgejo });
    const fj = await read(app.id, a.components.find((c: any) => c.name === 'acme/shop-api').id);
    expect(fj.repository.pipeline).toMatchObject({ state: 'failed', runs: [{ name: 'ci/woodpecker/push/build', state: 'failed' }, { state: 'success' }] });
    expect(fj.repository.release).toBeNull();
    // golang image and go.mod: the oldest version counts; distroless is not mapped
    expect(fj.stack.map((x: any) => [x.product, x.version])).toEqual([['go', '1.22']]);
    expect(fj.repository.unmapped).toEqual(['gcr.io/distroless/static-debian12']);
    a = await s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'acme/secret', platformId: ids.github });
    const bad = await read(app.id, a.components.find((c: any) => c.name === 'acme/secret').id);
    expect(bad.repository.error).toMatch(/^no permission \(403\)/);
    a = await s.api('POST', `/applications/${app.id}/components`, { type: 'repository', name: 'acme/nope', platformId: ids.github });
    const gone = await read(app.id, a.components.find((c: any) => c.name === 'acme/nope').id);
    expect(gone.repository.error).toMatch(/no repository "acme\/nope"/);
  });

  it('the job reads repositories not read for 6 hours', async () => {
    const { runRepositoryJob } = await import('../src/catalogue/repositories.js');
    expect(await runRepositoryJob(Date.now())).toBe(0);
    expect(await runRepositoryJob(Date.now() + 7 * 3_600_000)).toBeGreaterThanOrEqual(4);
  });
});

describe('monitor check git', () => {
  it('passed pipeline up, failed down (or degraded), too many alerts degraded, unknown branch unknown', async () => {
    mock.resetGitPlatforms();
    const g = (id: string, platform: string, repository: string, extra: Record<string, unknown> = {}) => ({
      id,
      name: id,
      type: 'git',
      platform,
      repository,
      ...extra,
    });
    await expect(
      s.api('POST', '/monitors', { definition: { name: 'Not a Git platform', checks: [g('x', 'Kubernetes (demo)', 'acme/shop-web')] } }),
    ).rejects.toThrow(/not a GitHub, GitLab or Forgejo/);
    const { monitor } = await s.api('POST', '/monitors', {
      definition: {
        name: 'Shop pipelines',
        failuresBeforeDown: 1,
        checks: [
          g('web', 'GitHub (demo)', 'acme/shop-web'),
          g('api', 'GitHub (demo)', 'acme/shop-api'),
          g('api-soft', 'Forgejo (demo)', 'acme/shop-api', { failedAs: 'degraded' }),
          g('alerts', 'GitHub (demo)', 'acme/shop-web', { maxHigh: 0 }),
          g('gitlab', 'GitLab (demo)', 'acme/shop/web', { branch: 'main' }),
          g('branch', 'Forgejo (demo)', 'acme/shop-web', { branch: 'nope' }),
        ],
      },
    });
    mock.setGitPipeline('shop-web', 'success');
    await eng.evaluateMonitorNow(monitor.id);
    const m = await s.api('GET', `/monitors/${monitor.id}`);
    const st = Object.fromEntries(m.checks.map((c: any) => [c.checkId, [c.status, c.last?.message]]));
    expect(st.web).toEqual(['up', 'Git: acme/shop-web@main – pipeline passed']);
    expect(st.api).toEqual(['down', 'Git: acme/shop-api@main – pipeline failed (CI)']);
    expect(st['api-soft']).toEqual(['degraded', 'Git: acme/shop-api@main – pipeline failed (ci/woodpecker/push/build)']);
    expect(st.alerts).toEqual(['degraded', 'Git: acme/shop-web@main – 1 critical or high alerts (at most 0)']);
    expect(st.gitlab[0]).toBe('up');
    expect(st.branch[0]).toBe('unknown');
  });
});

describe('access check source git', () => {
  const run = async (platformId: string, scope: string) => {
    const c = await s.api('POST', '/compliance/access-checks', { name: `Git ${scope} ${platformId}`, platformId, source: 'git', scope });
    expect(c).toMatchObject({ source: 'git', scope, datasetKey: null });
    const r = await s.api('POST', `/compliance/access-checks/${c.id}/run`, {});
    expect(r.baseline).toBe(true);
    const snap = await s.api('GET', `/compliance/access-checks/${c.id}/snapshots/${r.snapshot.id}`);
    return Object.fromEntries(snap.data.map((x: any) => [x.id, x.rights]));
  };

  it('needs a scope and a Git platform', async () => {
    await expect(s.api('POST', '/compliance/access-checks', { name: 'no scope', platformId: ids.github, source: 'git' })).rejects.toThrow(/organisation/);
    const k8s = (await s.api('GET', '/platforms')).find((p: any) => p.kind === 'kubernetes').id;
    await expect(s.api('POST', '/compliance/access-checks', { name: 'wrong', platformId: k8s, source: 'git', scope: 'acme' })).rejects.toThrow(/Git source/);
  });

  it('reads organisation members, repository collaborators, GitLab members and Forgejo teams', async () => {
    expect(await run(ids.github, 'acme')).toEqual({ alice: ['owner'], bob: ['member'], 'carol-ext': ['outside-collaborator'], dave: ['member'] });
    expect(await run(ids.github, 'acme/shop-web')).toEqual({ alice: ['admin'], bob: ['write'], 'carol-ext': ['outside-collaborator', 'read'] });
    expect(await run(ids.gitlab, 'acme/shop/api')).toEqual({ alice: ['owner'], dave: ['maintainer'] });
    expect(await run(ids.gitlab, 'acme')).toEqual({ alice: ['owner'], bob: ['developer'], dave: ['developer'] });
    expect(await run(ids.forgejo, 'acme')).toEqual({ alice: ['owner'], bob: ['team:developers'], dave: ['team:developers'] });
    expect(await run(ids.forgejo, 'acme/shop-api')).toEqual({ alice: ['admin'], dave: ['maintain'] });
  });
});

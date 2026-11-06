import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Version watch (#241): the newest version of every tech stack entry from structured sources – package registries by
 * package URL (the demo's recorded npm, PyPI, Maven, NuGet, Go and crates.io answers), image tags on a container
 * registry platform (OCI distribution API with a token service), releases and tags of a Git platform, Dependency-Track's
 * latest version and endoflife.date –, the first source that answers wins; how far behind the installed version is;
 * settings per entry; the outbound policy; visibility; messages on a new major release.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
let app: any;
let platforms: any[];
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { body: unknown }) => ((typeof e.body === 'string' ? JSON.parse(e.body) : e.body) as { code?: string }).code,
  );
const platform = (kind: string) => platforms.find((p) => p.kind === kind && p.name.endsWith('(demo)'));
const entry = (a: any, component: string, product: string) => a.components.find((c: any) => c.name === component).stack.find((x: any) => x.product === product);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', { applications: false });
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  platforms = await s.api('GET', '/platforms');
  app = await dana('POST', '/applications', { name: 'Shop (versions)', owners: ['user:olivia'] });
  await olivia('POST', `/applications/${app.id}/components`, {
    type: 'container-image',
    name: 'web',
    stack: [
      { product: 'react', version: '18.3.1' },
      { product: 'django', version: '5.2' },
      { product: 'spring-boot', version: '3.5.0' },
      { product: 'nodejs', version: '24.11.0' },
      { product: 'dotnet', version: '10.0.1' },
      { product: 'deno', version: '1.40.0' },
    ],
  });
  // a namespace: nginx, postgres and node images from the cluster
  await olivia('POST', `/applications/${app.id}/components`, { type: 'kubernetes-namespace', name: 'shop-prod', platformId: platform('kubernetes').id });
  const a = await dana('GET', `/applications/${app.id}`);
  await olivia('POST', `/applications/${app.id}/components/${a.components.find((c: any) => c.name === 'shop-prod').id}/cluster`, {});
  await dana('POST', '/catalogue/lifecycle/refresh');
});
afterAll(async () => {
  await s?.app.close();
});

describe('version watch', () => {
  it('has nothing before the first read; the status counts the entries', async () => {
    const st = await vera('GET', '/catalogue/versions');
    expect(st).toMatchObject({ canEdit: false, canRefresh: false, withNewest: expect.any(Number) });
    expect(st.entries).toBeGreaterThanOrEqual(9);
    expect(st.settings.order).toEqual(['dtrack', 'registry', 'oci', 'git', 'endoflife']);
    const a = await vera('GET', `/applications/${app.id}`);
    // endoflife.date was read already: its answer counts at once, the registries not yet
    expect(entry(a, 'web', 'react').watch).toMatchObject({ source: 'endoflife' });
  });

  it('reads the registries, the container registry and endoflife.date – the first source that answers wins', async () => {
    expect(await status(vera('POST', '/catalogue/versions/refresh'))).toBe(403);
    const st = await dana('POST', '/catalogue/versions/refresh');
    expect(st.errors).toEqual([]);
    expect(st.sources.find((x: any) => x.source === 'registry').lookups).toBeGreaterThanOrEqual(5);
    const a = await vera('GET', `/applications/${app.id}`);
    // npm: the canary release is a pre-release; 19.0.0 came out 700 days ago
    expect(entry(a, 'web', 'react').watch).toMatchObject({
      source: 'registry',
      where: 'npm',
      ref: 'pkg:npm/react',
      newest: '19.2.0',
      lag: 'major',
      behind: { major: 1, minor: 0, patch: 0 },
      prereleases: false,
    });
    expect(entry(a, 'web', 'react').watch.daysBehind).toBeGreaterThanOrEqual(699);
    // PyPI (PEP 440): 6.1a1 is a pre-release, 6.0.2 was yanked, 7.0 has no files
    expect(entry(a, 'web', 'django').watch).toMatchObject({ source: 'registry', where: 'PyPI', newest: '6.0.1', lag: 'major' });
    // Maven Central: milestones and release candidates are pre-releases
    expect(entry(a, 'web', 'spring-boot').watch).toMatchObject({ source: 'registry', where: 'Maven Central', newest: '4.0.1', lag: 'major' });
    // NuGet: up to date
    expect(entry(a, 'web', 'dotnet').watch).toMatchObject({ source: 'registry', where: 'NuGet', newest: '10.0.1', lag: 'current', daysBehind: null });
    // crates.io (the first package URL of the product list), a yanked version left out
    expect(entry(a, 'web', 'deno').watch).toMatchObject({ source: 'registry', where: 'crates.io', newest: '2.4.5', lag: 'major' });
    // no package URL of a registry: endoflife.date (newest cycle 26, latest 26.4)
    expect(entry(a, 'web', 'nodejs').watch).toMatchObject({ source: 'endoflife', newest: '26.4', lag: 'major', behind: { major: 2, minor: 0, patch: 0 } });
    // images from the cluster: tags with the installed tag's shape ("-alpine" kept), the token flow of the registry
    expect(entry(a, 'shop-prod', 'nginx').watch).toMatchObject({
      source: 'oci',
      where: 'Container registry (demo)',
      ref: 'library/nginx',
      newest: '1.28.0-alpine',
      lag: 'minor',
      behind: { major: 0, minor: 1, patch: 0 },
    });
    expect(entry(a, 'shop-prod', 'postgresql').watch).toMatchObject({ source: 'oci', newest: '18.1', lag: 'major' });
    // the installed tag's shape: 19beta1 is a pre-release, 18.1-alpine has another suffix
    // node:24-alpine → 24 matches any 24.x; 26.1.0-alpine is the newest
    expect(entry(a, 'shop-prod', 'nodejs').watch).toMatchObject({ source: 'oci', newest: '26.1.0-alpine', lag: 'major' });
    const audit = await s.api('GET', '/audit?action=catalogue.versions_refreshed&limit=5');
    expect(audit[0]).toMatchObject({ actor: 'dana' });
  });

  it('shows one entry with what each source said', async () => {
    const a = await dana('GET', `/applications/${app.id}`);
    const web = a.components.find((c: any) => c.name === 'web');
    const d = await vera('GET', `/catalogue/versions/entry?holder=component&id=${web.id}&product=nodejs`);
    expect(d).toMatchObject({ holderName: 'web', label: 'Node.js', version: '24.11.0', canEdit: false, vulnerabilities: null, config: { source: 'auto' } });
    expect(d.tried.map((x: any) => x.source)).toEqual(['dtrack', 'registry', 'oci', 'git', 'endoflife']);
    expect(d.tried[0].note).toMatch(/Dependency-Track/);
    expect(d.tried.at(-1)).toMatchObject({ source: 'endoflife', newest: '26.4', note: null });
    expect((await olivia('GET', `/catalogue/versions/entry?holder=component&id=${web.id}&product=nodejs`)).canEdit).toBe(true);
    expect(await code(vera('GET', `/catalogue/versions/entry?holder=component&id=${web.id}&product=nope`))).toBe('STACK_ENTRY_NOT_FOUND');
    expect(await code(vera('GET', `/catalogue/versions/entry?holder=component&id=cmp_nope&product=nodejs`))).toBe('COMPONENT_NOT_FOUND');
  });

  it('per entry: a Git platform with releases or tags, pre-releases, a tag pattern – checked and audited', async () => {
    const a = await dana('GET', `/applications/${app.id}`);
    const web = a.components.find((c: any) => c.name === 'web');
    const gh = platform('github');
    const ref = { holder: 'component', id: web.id, product: 'react' };
    const cfg = { source: 'git', platformId: gh.id, name: 'acme/shop-web' };
    expect(await status(vera('PUT', '/catalogue/versions/entry', { ...ref, config: cfg }))).toBe(403);
    expect(await code(olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { ...cfg, name: '../x' } }))).toBe('VERSIONS_NAME');
    expect(await code(olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { ...cfg, platformId: platform('kubernetes').id } }))).toBe(
      'VERSIONS_PLATFORM',
    );
    expect(await code(olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { ...cfg, tagPattern: 'v*' } }))).toBe('VERSIONS_TAG_PATTERN');
    expect(await code(olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { source: 'registry', purl: 'npm/react' } }))).toBe('VERSIONS_PURL');
    // releases: v2.5.0-rc1 is marked as a pre-release
    let d = await olivia('PUT', '/catalogue/versions/entry', { ...ref, config: cfg });
    expect(d.config).toMatchObject({ source: 'git', name: 'acme/shop-web', gitRefs: 'releases' });
    expect(d.watch).toMatchObject({ source: 'git', where: gh.name, ref: 'acme/shop-web', newest: 'v2.4.1', configured: true });
    d = await olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { ...cfg, prereleases: true } });
    expect(d.watch).toMatchObject({ newest: 'v2.5.0-rc1', prereleases: true });
    // tags, only those of the pattern
    d = await olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { ...cfg, gitRefs: 'tags', tagPattern: 'v{version}' } });
    expect(d.watch).toMatchObject({ newest: 'v2.4.1' });
    expect(d.tried).toHaveLength(1);
    const audit = await s.api('GET', '/audit?action=application.version_watch_changed&limit=5');
    expect(audit[0]).toMatchObject({ actor: 'olivia', entityId: app.id });
    // off: not watched; automatic again: no setting stored
    d = await olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { source: 'off' } });
    expect(d.watch).toBeNull();
    expect(entry(await vera('GET', `/applications/${app.id}`), 'web', 'react').watch).toBeNull();
    d = await olivia('PUT', '/catalogue/versions/entry', { ...ref, config: { source: 'auto' } });
    expect(d.watch).toMatchObject({ source: 'registry', configured: false });
  });

  it('per entry: an image on the container registry with its own tag pattern', async () => {
    const a = await dana('GET', `/applications/${app.id}`);
    const ns = a.components.find((c: any) => c.name === 'shop-prod');
    const reg = platform('container-registry');
    const d = await olivia('PUT', '/catalogue/versions/entry', {
      holder: 'component',
      id: ns.id,
      product: 'postgresql',
      config: { source: 'oci', platformId: reg.id, name: 'library/postgres', tagPattern: '{version}-alpine' },
    });
    expect(d.watch).toMatchObject({ source: 'oci', newest: '18.1-alpine', lag: 'major' });
    expect(
      await code(
        olivia('PUT', '/catalogue/versions/entry', {
          holder: 'component',
          id: ns.id,
          product: 'postgresql',
          config: { source: 'oci', platformId: reg.id, name: 'Library/../x' },
        }),
      ),
    ).toBe('VERSIONS_NAME');
  });

  it('Dependency-Track: the latest version of the package and its findings next to it', async () => {
    const dt = platform('dependency-track');
    const comp = (
      await olivia('POST', `/applications/${app.id}/components`, {
        type: 'repository',
        name: 'acme/legacy',
        stack: [{ product: 'log4j', version: '2.14.1' }],
        dependencyTrack: { platformId: dt.id, project: 'shop-web@2.4.1' },
      })
    ).components.find((c: any) => c.name === 'acme/legacy');
    await olivia('POST', `/applications/${app.id}/components/${comp.id}/dependency-track`, {});
    await dana('POST', '/catalogue/versions/refresh');
    const d = await vera('GET', `/catalogue/versions/entry?holder=component&id=${comp.id}&product=log4j`);
    expect(d.watch).toMatchObject({ source: 'dtrack', where: dt.name, ref: 'pkg:maven/org.apache.logging.log4j/log4j-core', newest: '2.25.0', lag: 'minor' });
    expect(d.vulnerabilities).toMatchObject({ project: 'shop-web@2.4.1', counts: { critical: 1 } });
    expect(d.vulnerabilities.findings).toEqual([expect.objectContaining({ vulnId: 'CVE-2021-44228', component: 'org.apache.logging.log4j/log4j-core' })]);
  });

  it('respects the outbound policy: a blocked registry is skipped, the next source answers', async () => {
    const before = await s.api('GET', '/catalogue/versions');
    expect(await status(dana('PUT', '/catalogue/versions', before.settings))).toBe(403);
    expect(await code(s.api('PUT', '/catalogue/versions', { ...before.settings, ociPlatformIds: [platform('github').id] }))).toBe('VERSIONS_OCI_PLATFORM');
    expect(await status(s.api('PUT', '/catalogue/versions', { ...before.settings, registries: { ...before.settings.registries, npm: 'ftp://x' } }))).toBe(400);
    await s.api('PUT', '/catalogue/versions', { ...before.settings, registries: { ...before.settings.registries, npm: 'https://registry.npm.invalid' } });
    const st = await dana('POST', '/catalogue/versions/refresh');
    expect(st.errors).toEqual([
      expect.objectContaining({ source: 'registry', ref: 'pkg:npm/react', error: expect.stringMatching(/blocked by the outbound policy/) }),
    ]);
    const a = await vera('GET', `/applications/${app.id}`);
    expect(entry(a, 'web', 'react').watch).toMatchObject({ source: 'endoflife' });
    // turned off: not asked at all
    await s.api('PUT', '/catalogue/versions', { ...before.settings, registries: { ...before.settings.registries, npm: '' } });
    const d = await vera(
      'GET',
      `/catalogue/versions/entry?holder=component&id=${entry(a, 'web', 'react') && a.components.find((c: any) => c.name === 'web').id}&product=react`,
    );
    expect(d.tried.find((x: any) => x.source === 'registry').note).toMatch(/turned off/);
    await s.api('PUT', '/catalogue/versions', before.settings);
    await dana('POST', '/catalogue/versions/refresh');
    const audit = await s.api('GET', '/audit?action=catalogue.versions_settings_changed&limit=5');
    expect(audit[0].summary).toMatch(/Version watch settings changed/);
  });

  it('hides entries of applications the caller may not see', async () => {
    const team = (await s.api('POST', '/teams', { name: 'Payments', members: ['olivia'] })).id;
    const hidden = await s.api('POST', '/applications', { name: 'Payments (versions)', owners: [] });
    const c = (await s.api('POST', `/applications/${hidden.id}/components`, { type: 'other', name: 'core', stack: [{ product: 'nodejs', version: '24' }] }))
      .components[0];
    await s.api('PUT', `/owning-teams/application/${hidden.id}`, { teamIds: [team] });
    expect(await status(vera('GET', `/catalogue/versions/entry?holder=component&id=${c.id}&product=nodejs`))).toBe(404);
    expect(await status(vera('PUT', '/catalogue/versions/entry', { holder: 'component', id: c.id, product: 'nodejs', config: { source: 'off' } }))).toBe(404);
    expect((await olivia('GET', `/catalogue/versions/entry?holder=component&id=${c.id}&product=nodejs`)).holderName).toBe('core');
  });

  it('messages the owners once when a new major release appears (not for what was known at first sight)', async () => {
    const { checkMajorReleaseNotices } = await import('../src/versions/service.js');
    const { db } = await import('../src/db.js');
    const inbox = async () => (await olivia('GET', '/notifications?limit=100')).items.filter((n: any) => n.event === 'stack.release');
    // the first run records what is known as the starting point
    await checkMajorReleaseNotices();
    expect(await inbox()).toEqual([]);
    // pretend React 18 was the newest major when the watch started
    db().run("UPDATE version_notices SET major = '18' WHERE target_id = ? AND product = 'react'", app.id);
    expect(await checkMajorReleaseNotices()).toBeGreaterThanOrEqual(1);
    const msgs = await inbox();
    expect(msgs.map((n: any) => n.title)).toContain('New major release: React 19.2.0 (Shop (versions))');
    expect(msgs.find((n: any) => n.title.includes('React')).body).toContain('18.3.1');
    // once
    await checkMajorReleaseNotices();
    expect((await inbox()).filter((n: any) => n.title.includes('React'))).toHaveLength(1);
    const audit = await s.api('GET', '/audit?action=application.major_release_notice_sent&limit=5');
    expect(audit[0]).toMatchObject({ actor: 'system', entityId: app.id });
  });

  it('the monitor check "Version behind": thresholds per check, the application as the owner sees it', async () => {
    const preview = (check: Record<string, unknown>, as: Client = s.api) =>
      as('POST', '/monitors/check-preview', { check: { id: 'v', name: 'Versions', type: 'version-behind', application: 'Shop (versions)', ...check } });
    // React, Django, Spring Boot … a major behind; Node.js 24 past its end of life
    let r = await preview({});
    expect(r.status).toBe('down');
    expect(r.message).toMatch(/stack entries of "Shop \(versions\)"/);
    // only nginx (its cycle 1.27 is past its end of life in the demo data: down, unless ignored)
    r = await preview({ products: ['nginx'] });
    expect(r.status).toBe('down');
    expect(r.message).toContain('end of life');
    // one minor release behind: up with the default limit (2), degraded with 0
    r = await preview({ products: ['nginx'], eolAs: 'ignore' });
    expect(r.status).toBe('up');
    r = await preview({ products: ['nginx'], eolAs: 'ignore', maxMinors: 0 });
    expect(r).toMatchObject({ status: 'degraded' });
    expect(r.message).toContain('nginx 1.27.3 → 1.28.0-alpine (1 minor releases behind');
    // a major release behind counts as degraded when asked; days behind
    r = await preview({ products: ['react'], majorAs: 'degraded' });
    expect(r.status).toBe('degraded');
    r = await preview({ products: ['dotnet'], maxDays: 1 });
    expect(r.status).toBe('up');
    // end of life: down, or ignored
    r = await preview({ products: ['nodejs'], eolAs: 'ignore', majorAs: 'degraded' });
    expect(r.status).toBe('degraded');
    expect(await code(preview({ application: 'Payments (versions)' }, dana))).toBe('APPLICATION_NOT_FOUND');
    expect(await code(preview({ application: 'nope' }))).toBe('APPLICATION_NOT_FOUND');
  });

  it('the scorecard part "Up to date": counted when turned on, snapshots keep it', async () => {
    const svc = await s.api('POST', '/services', { name: 'Shop service (versions)', owners: [] });
    await s.api('PUT', `/services/${svc.id}/applications/${app.id}`, { role: 'primary' });
    const card = async () => (await vera('GET', '/scorecard')).services.find((c: any) => c.serviceId === svc.id);
    expect((await card()).upToDate).toEqual({ status: 'none', enabled: false, entries: 0, major: 0, behind: 0, items: [] });
    const before = await s.api('GET', '/catalogue/versions');
    await s.api('PUT', '/catalogue/versions', { ...before.settings, scorecard: true });
    const u = (await card()).upToDate;
    expect(u).toMatchObject({ status: 'attention', enabled: true });
    expect(u.entries).toBeGreaterThanOrEqual(8);
    expect(u.items[0]).toMatchObject({ lag: 'major', applicationName: 'Shop (versions)' });
    expect(u.items.map((i: any) => i.product)).toEqual(expect.arrayContaining(['react', 'django', 'postgresql']));
    expect((await card()).attention).toBe(true);
    const { snapshotScorecards } = await import('../src/scorecard/jobs.js');
    const { db } = await import('../src/db.js');
    snapshotScorecards(Date.now(), true);
    expect(db().get<any>('SELECT up_to_date FROM scorecard_snapshots WHERE service_id = ? ORDER BY day DESC', svc.id)).toEqual({ up_to_date: 'attention' });
    await s.api('PUT', '/catalogue/versions', before.settings);
  });

  it('the dataset "Component versions": a row per entry, for administrators and auditors', async () => {
    const audrey = await s.as('audrey', PW);
    const ds = await audrey('GET', '/datasets/catalogue.versions');
    expect(ds.metrics.entries).toBeGreaterThanOrEqual(10);
    expect(ds.metrics.major).toBeGreaterThanOrEqual(5);
    const row = ds.rows.find((r: any) => r.Product === 'React' && r.Application === 'Shop (versions)');
    expect(row).toMatchObject({
      Component: 'web',
      Kind: 'component',
      Installed: '18.3.1',
      Newest: '19.2.0',
      Behind: '1 major',
      Source: 'npm',
      _status: 'serious',
    });
    expect(ds.rows.find((r: any) => r.Product === 'nginx')).toMatchObject({ Newest: '1.28.0-alpine', Behind: '1 minor', 'End of life': 'eol' });
    // it names every application: not for everyone
    expect(await status(vera('GET', '/datasets/catalogue.versions'))).not.toBe(200);
    expect((await vera('GET', '/datasets')).map((d: any) => d.key)).not.toContain('catalogue.versions');
  });

  it('removes the settings of entries that left the stack, and lookups nobody needs', async () => {
    const { runVersionJob } = await import('../src/versions/service.js');
    const { db } = await import('../src/db.js');
    const a = await dana('GET', `/applications/${app.id}`);
    const ns = a.components.find((c: any) => c.name === 'shop-prod');
    expect(db().get("SELECT 1 FROM stack_version_watch WHERE holder_id = ? AND product = 'postgresql'", ns.id)).toBeTruthy();
    db().run("DELETE FROM component_stack WHERE component_id = ? AND product = 'postgresql'", ns.id);
    await runVersionJob();
    expect(db().get("SELECT 1 FROM stack_version_watch WHERE holder_id = ? AND product = 'postgresql'", ns.id)).toBeFalsy();
    expect(db().get("SELECT 1 FROM version_lookups WHERE key LIKE 'oci:%:library/postgres'")).toBeFalsy();
  });
});

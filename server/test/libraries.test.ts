import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIBRARY_RELEASE_FILE, LIBRARY_SIGNATURE_FILE } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { APP_CREDENTIALS, buildFolder, GUEST_REVIEW, NOTIFY_OWNER, sign, signedRelease, testKey, uploadBody, type TestKey } from './library-helpers.js';
import type { FileSet } from '../src/libraries/releases.js';
import type { TrustedKey } from '../src/libraries/trust.js';
import { parsePublicKeyLine } from '../src/libraries/sshsig.js';

/**
 * Shared procedure libraries (ADR 0014): verification of a release (signature, keys, files, items), staging,
 * the review, the all-or-nothing install with provenance, updates with conflicts, rollback, downgrades, the
 * publisher binding, revoked keys and Hold, four-eyes on install, the Git source in library mode.
 */

let s: TestServer;
let dana: Client, olivia: Client, vera: Client;
const PW = 'Demo-password-1';

const fail = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: '' }),
    (e: { status: number; message?: string; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code ?? '', message: e.message ?? '' }),
  );

const trusted = (k: TestKey, o: Partial<TrustedKey> = {}): TrustedKey => ({
  id: 'k',
  publisherId: 'test-publisher',
  publisherName: 'Test publisher',
  libraries: [],
  blob: parsePublicKeyLine(k.line).blob,
  fingerprint: k.fingerprint,
  state: 'active',
  expiresAt: null,
  builtIn: false,
  ...o,
});

// loaded after the server started (they read the configuration)
const verifyRelease = async (...a: Parameters<typeof import('../src/libraries/releases.js').verifyRelease>) =>
  (await import('../src/libraries/releases.js')).verifyRelease(...a);
const buildRelease = async (files: FileSet) => (await import('../src/libraries/build.js')).buildRelease(files);

const refusedWith = async (files: FileSet, keys: TrustedKey[], code: string) => {
  const e = await verifyRelease(files, { keys }).then(
    () => null,
    (x: { code?: string; message: string }) => x,
  );
  expect(e?.code, e?.message).toBe(code);
  return e!;
};

let graphId = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  graphId = ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((p) => p.kind === 'microsoft-graph')!.id;
}, 120_000);
afterAll(async () => {
  await s?.app.close();
  if (s) fs.rmSync(s.dataDir, { recursive: true, force: true });
});

describe('verifying a release', () => {
  const key = testKey();
  it('accepts a release signed by a trusted key of its publisher', async () => {
    const v = await verifyRelease(await signedRelease(key), { keys: [trusted(key)] });
    expect(v.release).toMatchObject({ library: 'test-access-reviews', release: '1.0.0' });
    expect(v.key.fingerprint).toBe(key.fingerprint);
    expect(v.items.map((i) => `${i.kind}:${i.identity}`).sort()).toEqual([
      'monitor:library-app-credentials',
      'process:guest-review',
      'process:notify-owner',
      'recordType:AEX',
    ]);
  });

  it('refuses a missing or broken signature, another namespace and an unknown key', async () => {
    const files = await buildFolder();
    await refusedWith(files, [trusted(key)], 'LIBRARY_SIGNATURE_INVALID');
    await refusedWith(sign(files, key, { namespace: 'git' }), [trusted(key)], 'LIBRARY_SIGNATURE_INVALID');
    const other = testKey();
    await refusedWith(sign(files, other), [trusted(key)], 'LIBRARY_KEY_UNKNOWN');
    // release.json changed after signing
    const signed = sign(files, key);
    const changed = new Map(signed);
    changed.set(LIBRARY_RELEASE_FILE, Buffer.from(signed.get(LIBRARY_RELEASE_FILE)!.toString().replace('1.0.0', '1.0.1')));
    await refusedWith(changed, [trusted(key)], 'LIBRARY_SIGNATURE_INVALID');
    changed.set(LIBRARY_SIGNATURE_FILE, Buffer.from('-----BEGIN SSH SIGNATURE-----\nAAAA\n-----END SSH SIGNATURE-----\n'));
    await refusedWith(changed, [trusted(key)], 'LIBRARY_SIGNATURE_INVALID');
  });

  it('refuses a changed, an extra and a missing file (mix and match)', async () => {
    const files = await signedRelease(key);
    const changed = new Map(files);
    changed.set('processes/notify-owner.yaml', Buffer.from(NOTIFY_OWNER.replace('The review is done.', 'Done!')));
    expect((await refusedWith(changed, [trusted(key)], 'LIBRARY_FILE_MISMATCH')).message).toContain('notify-owner.yaml');
    const extra = new Map(files);
    extra.set('processes/extra.yaml', Buffer.from(NOTIFY_OWNER.replace('notify-owner', 'extra')));
    expect((await refusedWith(extra, [trusted(key)], 'LIBRARY_FILE_MISMATCH')).message).toContain('not listed');
    const missing = new Map(files);
    missing.delete('record-types/access-exception.yaml');
    expect((await refusedWith(missing, [trusted(key)], 'LIBRARY_FILE_MISMATCH')).message).toContain('missing');
  });

  it("refuses another publisher's key, revoked, retired and expired keys and libraries the publisher may not publish", async () => {
    const files = await signedRelease(key);
    await refusedWith(files, [trusted(key, { publisherId: 'someone-else' })], 'LIBRARY_KEY_UNKNOWN');
    await refusedWith(files, [trusted(key, { state: 'revoked' })], 'LIBRARY_KEY_REVOKED');
    await refusedWith(files, [trusted(key, { state: 'retired' })], 'LIBRARY_KEY_RETIRED');
    await refusedWith(files, [trusted(key, { expiresAt: '2020-01-01' })], 'LIBRARY_KEY_EXPIRED');
    await refusedWith(files, [trusted(key, { libraries: ['other-library'] })], 'LIBRARY_NOT_ALLOWED');
    // Steward's stored copy of a release staged before the rotation stays valid; a revoked key never does
    expect((await verifyRelease(files, { keys: [trusted(key, { state: 'retired' })], allowRetired: true })).release.release).toBe('1.0.0');
    await expect(verifyRelease(files, { keys: [trusted(key, { state: 'revoked' })], allowRetired: true })).rejects.toMatchObject({
      code: 'LIBRARY_KEY_REVOKED',
    });
  });

  it('accepts hardware keys only with the user-presence flag', async () => {
    const hw = testKey({ hardware: true });
    const files = await buildFolder();
    expect((await verifyRelease(sign(files, hw), { keys: [trusted(hw)] })).key.fingerprint).toBe(hw.fingerprint);
    await refusedWith(sign(files, hw, { flags: 0 }), [trusted(hw)], 'LIBRARY_SIGNATURE_INVALID');
  });

  it('refuses secrets, version pins, duplicate ids and a manifest that disagrees with release.json', async () => {
    const secret = buildFolder({ items: { 'processes/a.yaml': `${NOTIFY_OWNER}\n# password: "S3cr3t-Pa55w0rd-Value-1234"\n` } });
    await expect(secret).rejects.toMatchObject({ code: 'LIBRARY_INVALID' });
    await expect(secret).rejects.toThrow(/credentials/);
    await expect(
      buildFolder({
        items: { 'processes/a.yaml': GUEST_REVIEW.replace('process: notify-owner', 'process: notify-owner\n    version: 2'), 'processes/b.yaml': NOTIFY_OWNER },
      }),
    ).rejects.toThrow(/pin a version/);
    await expect(buildFolder({ items: { 'processes/a.yaml': NOTIFY_OWNER, 'processes/b.yaml': NOTIFY_OWNER } })).rejects.toThrow(/same process/);
    // a manifest edited after the build
    const files = await signedRelease(key);
    const m = new Map(files);
    m.set('steward-library.yaml', Buffer.from(files.get('steward-library.yaml')!.toString().replace('release: 1.0.0', 'release: 2.0.0')));
    await refusedWith(m, [trusted(key)], 'LIBRARY_FILE_MISMATCH');
    // hidden files and symbolic links are not part of a release; build refuses paths outside the rules
    await expect(buildRelease(new Map([...(await buildFolder()), ['../x.yaml', Buffer.from('x')]]))).rejects.toThrow(/segment/);
  });
});

/** Trust the test publisher's key on the server (administrator, step-up done by the client). */
async function trust(key: TestKey, publisher = 'test-publisher', libraries: string[] = []) {
  const existing = ((await s.api('GET', '/library-publishers')) as { id: string }[]).find((p) => p.id === publisher);
  if (!existing) await s.api('POST', '/library-publishers', { id: publisher, name: `Publisher ${publisher}`, contact: 'ops@example.com', libraries });
  return (await s.api('POST', `/library-publishers/${publisher}/keys`, { key: key.line })) as { id: string; fingerprint: string };
}
const upload = async (c: Client, files: FileSet) => (await c('POST', '/library-releases/upload', await uploadBody(files))) as { id: string; state: string };

describe('trusted publishers', () => {
  it('are managed by administrators only; keys are sealed and shown with the OpenSSH fingerprint', async () => {
    expect((await fail(dana('GET', '/library-publishers'))).status).toBe(403);
    expect((await fail(dana('POST', '/library-publishers', { id: 'x-pub', name: 'X' }))).status).toBe(403);
    const k = testKey();
    const added = await trust(k, 'seal-publisher');
    expect(added.fingerprint).toBe(k.fingerprint);
    const pubs = (await s.api('GET', '/library-publishers')) as { id: string; keys: { fingerprint: string; integrity: string; state: string }[] }[];
    expect(pubs.find((p) => p.id === 'seal-publisher')!.keys[0]).toMatchObject({ fingerprint: k.fingerprint, integrity: 'ok', state: 'active' });
    // a key written into the database directly is not trusted
    const { db } = await import('../src/db.js');
    const k2 = testKey();
    db().run(
      "INSERT INTO library_keys (id, publisher_id, key_line, fingerprint, comment, state, created_by, created_at) VALUES ('lky_injected01', 'seal-publisher', ?, ?, '', 'active', 'x', '2026-01-01')",
      k2.line.split(' ').slice(0, 2).join(' '),
      k2.fingerprint,
    );
    const { trustedKeys } = await import('../src/libraries/trust.js');
    expect(trustedKeys().some((t) => t.fingerprint === k2.fingerprint)).toBe(false);
    expect(trustedKeys().some((t) => t.fingerprint === k.fingerprint)).toBe(true);
    db().run("DELETE FROM library_keys WHERE id = 'lky_injected01'");
    // a key belongs to one publisher
    expect((await fail(s.api('POST', '/library-publishers/test-other/keys', { key: k.line }))).status).toBe(404);
    expect((await fail(s.api('POST', '/library-publishers/seal-publisher/keys', { key: k.line }))).code).toBe('LIBRARY_KEY_EXISTS');
    expect((await fail(s.api('POST', '/library-publishers/seal-publisher/keys', { key: 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ x' }))).code).toBe(
      'LIBRARY_KEY_INVALID',
    );
  });
});

describe('install, update, rollback', () => {
  const key = testKey();
  let rel1: { id: string; state: string };
  beforeAll(async () => {
    await trust(key);
  });

  it('stages an uploaded release and shows the whole of it for review', async () => {
    expect((await fail(vera('GET', '/libraries'))).status).toBe(403);
    expect((await fail(olivia('POST', '/library-releases/upload', await uploadBody(await signedRelease(key))))).status).toBe(403);
    rel1 = await upload(dana, await signedRelease(key));
    expect(rel1.state).toBe('staged');
    const review = (await dana('GET', `/library-releases/${rel1.id}/review`)) as any;
    expect(review.release).toMatchObject({ library: 'test-access-reviews', release: '1.0.0', keyFingerprint: key.fingerprint, keyState: 'active' });
    expect(review.items.map((i: any) => [i.identity, i.status])).toEqual(
      expect.arrayContaining([
        ['guest-review', 'new'],
        ['notify-owner', 'new'],
        ['library-app-credentials', 'new'],
        ['AEX', 'new'],
      ]),
    );
    const guest = review.items.find((i: any) => i.identity === 'guest-review');
    // what it can do – from the steps, not from the publisher's words
    expect(guest.abilities).toMatchObject({
      slots: [{ slot: 'graph', kind: 'microsoft-graph' }],
      writes: 0,
      subprocesses: ['notify-owner'],
      datasets: ['library.guests'],
    });
    // the only Microsoft Graph platform is proposed for "idp" (as for monitors from Git, #102)
    expect(review.references.platforms).toEqual([expect.objectContaining({ ref: 'idp', kind: 'microsoft-graph', mapped: graphId })]);
    // a designer may not create record types: the review says so before anything is tried
    expect(review.canInstall).toBe(false);
    expect(review.blockers).toEqual(['rights']);
    expect(review.items.find((i: any) => i.kind === 'recordType').canDecide).toBe(false);
    expect(((await s.api('GET', `/library-releases/${rel1.id}/review`)) as any).canInstall).toBe(true);
    const lists = (await dana('GET', '/libraries')) as any;
    expect(lists.staged.map((r: any) => r.id)).toContain(rel1.id);
  });

  it('installs all of it in one transaction – or nothing', async () => {
    // a designer may not create record types: the whole install is refused before anything is written
    expect((await fail(dana('POST', `/library-releases/${rel1.id}/install`, { platforms: { idp: graphId } }))).status).toBe(403);
    // a platform the reviewer chose that does not exist
    expect((await fail(s.api('POST', `/library-releases/${rel1.id}/install`, { platforms: { idp: 'plt_missing' } }))).code).toBe('PLATFORM_CHOICE_NOT_FOUND');
    expect(((await s.api('GET', '/processes')) as { id: string }[]).some((p) => p.id === 'guest-review')).toBe(false);
    const res = (await s.api('POST', `/library-releases/${rel1.id}/install`, { platforms: { idp: graphId } })) as any;
    expect(res.status).toBe('installed');
    expect(res.library).toMatchObject({ library: 'test-access-reviews', publisherId: 'test-publisher', held: false, revoked: false });
    const p = (await s.api('GET', '/processes/guest-review')) as any;
    // the library's own child is pinned to the version this install created
    const sub = p.definition.nodes.find((n: any) => n.type === 'subprocess');
    expect(sub).toMatchObject({ process: 'notify-owner', version: 1 });
    const versions = (await s.api('GET', '/processes/guest-review/versions')) as any[];
    expect(versions[0].comment).toContain(`From library test-access-reviews 1.0.0 (test-publisher, ${key.fingerprint})`);
    const { versionOrigin } = await import('../src/libraries/install.js');
    expect(versionOrigin('guest-review', 1)).toMatchObject({
      library: 'test-access-reviews',
      release: '1.0.0',
      keyFingerprint: key.fingerprint,
      keyRevoked: false,
    });
    // monitors start disabled
    const mons = (await s.api('GET', '/monitors')) as any;
    const mon = (mons.items ?? mons).find((m: any) => m.key === 'library-app-credentials');
    expect(mon.enabled).toBe(false);
    const origins = (await vera('GET', '/library-origins?kind=process')) as any[];
    expect(origins.find((o) => o.entityId === 'guest-review')).toMatchObject({ library: 'test-access-reviews', release: '1.0.0', changedLocally: false });
    const audit = (await s.api('GET', '/audit?action=library.installed&limit=5')) as any[];
    expect(audit[0].details).toMatchObject({ releaseSha256: expect.stringMatching(/^[0-9a-f]{64}$/), keyFingerprint: key.fingerprint });
    // runs, their report and the version history name the release
    const runId = ((await s.api('POST', '/runs', { processId: 'notify-owner', dryRun: true })) as any).id;
    const run = await s.waitRun(runId, ['succeeded', 'failed']);
    expect(run.libraryOrigin).toMatchObject({ library: 'test-access-reviews', release: '1.0.0', publisher: 'test-publisher', keyFingerprint: key.fingerprint });
    const html = (await s.api('GET', `/runs/${runId}/report.html`)) as string;
    expect(html).toContain('From library');
    expect(html).toContain(key.fingerprint);
    const { buildRunModel } = await import('../src/reports/model.js');
    expect(buildRunModel(runId, { lang: 'en' } as never).process.library).toMatchObject({ library: 'test-access-reviews', keyRevoked: false });
    expect(((await s.api('GET', '/processes/notify-owner/versions')) as any[])[0].origin).toMatchObject({ library: 'test-access-reviews', release: '1.0.0' });
  });

  it('refuses downgrades, replays and other content under a known version', async () => {
    // the same release again: nothing new
    expect((await upload(dana, await signedRelease(key))).id).toBe(rel1.id);
    expect((await fail(upload(dana, await signedRelease(key, { release: '0.9.0' })))).code).toBe('LIBRARY_DOWNGRADE');
    expect((await fail(upload(dana, await signedRelease(key, { extra: { 'README.md': '# other' } })))).code).toBe('LIBRARY_FILE_MISMATCH');
    const refused = (await s.api('GET', '/audit?action=library.release_refused&limit=5')) as any[];
    expect(refused.length).toBeGreaterThan(0);
  });

  it('binds a library to its publisher on first install', async () => {
    const other = testKey();
    await trust(other, 'other-publisher');
    const e = await fail(upload(dana, await signedRelease(other, { publisher: 'other-publisher', release: '2.0.0' })));
    expect(e.code).toBe('LIBRARY_PUBLISHER_CHANGED');
  });

  it('shows changes, new abilities and local edits as conflicts on update', async () => {
    // a local edit of the child
    const child = (await s.api('GET', '/processes/notify-owner')) as any;
    await s.api('PUT', '/processes/notify-owner', { definition: { ...child.definition, description: 'edited here' }, comment: 'local' });
    const writes = GUEST_REVIEW.replace(
      '  - id: publish',
      `  - id: remove
    type: http
    name: Remove a guest
    connection: graph
    method: DELETE
    path: /v1.0/users/x
  - id: publish`,
    );
    const v2 = await upload(
      dana,
      await signedRelease(key, {
        release: '1.1.0',
        items: {
          'processes/guest-review.yaml': writes,
          'processes/notify-owner.yaml': NOTIFY_OWNER.replace('done.', 'finished.'),
          'monitors/app-credentials.yaml': APP_CREDENTIALS,
        },
      }),
    );
    const review = (await dana('GET', `/library-releases/${v2.id}/review`)) as any;
    const st = Object.fromEntries(review.items.map((i: any) => [i.identity, [i.status, i.conflictReason]]));
    expect(st['guest-review']).toEqual(['changed', null]);
    expect(st['notify-owner']).toEqual(['conflict', 'changedLocally']);
    expect(st['library-app-credentials']).toEqual(['unchanged', null]);
    // the record type is no longer in the library
    expect(review.items.find((i: any) => i.status === 'removed')).toMatchObject({ kind: 'recordType' });
    expect(review.items.find((i: any) => i.identity === 'guest-review').newAbilities).toEqual(['writes']);
    expect(review.installed).toMatchObject({ id: rel1.id, release: '1.0.0' });
    // the conflict must be decided
    expect((await fail(s.api('POST', `/library-releases/${v2.id}/install`, { platforms: { idp: graphId } }))).code).toBe('LIBRARY_CONFLICT_UNDECIDED');
    const res = (await s.api('POST', `/library-releases/${v2.id}/install`, { platforms: { idp: graphId }, keepLocal: ['processes/notify-owner.yaml'] })) as any;
    expect(res.library).toMatchObject({ release: expect.objectContaining({ release: '1.1.0' }), previous: { id: rel1.id, release: '1.0.0' } });
    expect(((await s.api('GET', '/processes/notify-owner')) as any).definition.description).toBe('edited here');
    // the record type stays as a local item, detached
    const types = (await s.api('GET', '/library-origins?kind=recordType')) as any[];
    expect(types).toEqual([]);
  });

  it('rolls back to the release installed before, from the stored copy; older ones are downgrades', async () => {
    const lib = (await dana('GET', '/libraries/test-access-reviews')) as any;
    expect(lib.previous).toMatchObject({ release: '1.0.0' });
    const res = (await s.api('POST', '/libraries/test-access-reviews/rollback', { keepLocal: ['processes/notify-owner.yaml'] })) as any;
    expect(res.library.release.release).toBe('1.0.0');
    const p = (await s.api('GET', '/processes/guest-review')) as any;
    expect(p.definition.nodes.some((n: any) => n.method === 'DELETE')).toBe(false);
    // the history keeps everything
    expect(((await s.api('GET', '/processes/guest-review/versions')) as any[]).length).toBe(3);
    // no second rollback (there is no release before 1.0.0); 1.1.0 waits again as staged
    expect((await fail(s.api('POST', '/libraries/test-access-reviews/rollback', {}))).code).toBe('LIBRARY_DOWNGRADE');
    expect(((await dana('GET', '/libraries')) as any).installed[0].update).toMatchObject({ release: '1.1.0' });
    const audit = (await s.api('GET', '/audit?action=library.rolled_back&limit=1')) as any[];
    expect(audit[0].summary).toContain('rolled back');
  });

  it('flags releases of a revoked key, refuses its new releases and holds on one action', async () => {
    const pubs = (await s.api('GET', '/library-publishers')) as any[];
    const k = pubs.find((p) => p.id === 'test-publisher').keys.find((x: any) => x.fingerprint === key.fingerprint);
    // a schedule of a library process
    const sched = (await s.api('POST', '/schedules', {
      name: 'Library schedule',
      processId: 'guest-review',
      cron: '0 3 * * *',
      bindings: { graph: graphId },
      enabled: true,
    })) as any;
    expect((await fail(dana('POST', `/library-keys/${k.id}/revoke`, { reason: 'stolen laptop' }))).status).toBe(403);
    await s.api('POST', `/library-keys/${k.id}/revoke`, { reason: 'stolen laptop' });
    const lib = (await dana('GET', '/libraries/test-access-reviews')) as any;
    expect(lib).toMatchObject({ revoked: true, held: false });
    expect(((await vera('GET', '/library-origins?kind=process')) as any[]).find((o) => o.entityId === 'guest-review')).toMatchObject({ revoked: true });
    // its releases are refused now (also the one staged before)
    expect((await fail(upload(dana, await signedRelease(key, { release: '1.2.0' })))).code).toBe('LIBRARY_KEY_REVOKED');
    expect(
      (await fail(s.api('POST', `/library-releases/${lib.update.id}/install`, { platforms: { idp: graphId }, keepLocal: ['processes/notify-owner.yaml'] })))
        .code,
    ).toBe('LIBRARY_KEY_REVOKED');
    // the revoked key stays while its release is installed (removing it would drop the flag)
    expect((await fail(s.api('DELETE', `/library-keys/${k.id}`))).code).toBe('LIBRARY_KEY_IN_USE');
    // Hold: administrators; pauses the schedule, refuses runs
    expect((await fail(dana('POST', '/libraries/test-access-reviews/hold', { held: true }))).status).toBe(403);
    const held = (await s.api('POST', '/libraries/test-access-reviews/hold', { held: true, reason: 'key revoked' })) as any;
    expect(held.held).toBe(true);
    const schedOf = async () => ((await s.api('GET', '/schedules')) as any[]).find((x) => x.id === sched.id);
    expect((await schedOf()).enabled).toBe(false);
    expect((await fail(s.api('POST', '/runs', { processId: 'guest-review', dryRun: true, bindings: { graph: graphId } }))).code).toBe('LIBRARY_HELD');
    // lifting turns on again exactly what the hold turned off
    await s.api('POST', '/libraries/test-access-reviews/hold', { held: false });
    expect((await schedOf()).enabled).toBe(true);
    await s.api('DELETE', `/schedules/${sched.id}`);
  });

  it('a new key of the publisher replaces the release; uninstall detaches the items', async () => {
    const fresh = testKey();
    await trust(fresh);
    const v3 = await upload(dana, await signedRelease(fresh, { release: '1.3.0' }));
    const review = (await dana('GET', `/library-releases/${v3.id}/review`)) as any;
    expect(review.release.keyState).toBe('active');
    const conflicts = review.items.filter((i: any) => i.status === 'conflict').map((i: any) => i.path);
    await s.api('POST', `/library-releases/${v3.id}/install`, { platforms: { idp: graphId }, takeLibrary: conflicts });
    expect(((await dana('GET', '/libraries/test-access-reviews')) as any).revoked).toBe(false);
    await s.api('POST', '/libraries/test-access-reviews/uninstall', {});
    expect(((await vera('GET', '/library-origins')) as any[]).filter((o) => o.library === 'test-access-reviews')).toEqual([]);
    expect(((await s.api('GET', '/processes')) as any[]).some((p) => p.id === 'guest-review')).toBe(true);
  });
});

describe('item ids that exist locally', () => {
  it('are a conflict in the review and never overwritten silently', async () => {
    const key = testKey();
    await trust(key, 'clash-publisher');
    const local = (await s.api('POST', '/processes', { definition: { name: 'Local clash', steps: [{ id: 'a', type: 'log', message: 'local' }] } })) as any;
    const files = await signedRelease(key, {
      library: 'clash-library',
      publisher: 'clash-publisher',
      items: { 'processes/clash.yaml': NOTIFY_OWNER.replace('id: notify-owner', `id: ${local.id}`) },
      references: { platforms: [] },
    });
    const rel = await upload(s.api, files);
    const review = (await s.api('GET', `/library-releases/${rel.id}/review`)) as any;
    expect(review.items[0]).toMatchObject({ status: 'conflict', conflictReason: 'notFromLibrary', entityId: local.id });
    expect((await fail(s.api('POST', `/library-releases/${rel.id}/install`, {}))).code).toBe('LIBRARY_CONFLICT_UNDECIDED');
    await s.api('POST', `/library-releases/${rel.id}/install`, { keepLocal: ['processes/clash.yaml'] });
    expect(((await s.api('GET', `/processes/${local.id}`)) as any).name).toBe('Local clash');
  });
});

describe('Git sync in library mode', () => {
  const commit = async (repo: string, files: Record<string, string>) =>
    (
      (await (
        await fetch(`${s.base}/mock/git/_commit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ repo, files, signed: true }),
        })
      ).json()) as { sha: string }
    ).sha;
  const tag = (repo: string, t: string) =>
    fetch(`${s.base}/mock/git/_tag`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, tag: t }) });
  const folder = (files: FileSet, prefix: string) => Object.fromEntries([...files].map(([p, b]) => [`${prefix}/${p}`, b.toString('utf8')]));

  it('follows the version tags, verifies and stages the newest release; the tag must match release.json', async () => {
    const key = testKey();
    await trust(key, 'git-publisher');
    const spec = {
      library: 'git-library',
      publisher: 'git-publisher',
      items: { 'processes/n.yaml': NOTIFY_OWNER.replace('notify-owner', 'git-notify') },
      references: { platforms: [] },
    };
    const repo = `team/libs-${Date.now().toString(36)}`;
    await commit(repo, { ...folder(await signedRelease(key, spec), 'lib'), 'other/readme.md': 'x' });
    await tag(repo, 'v1.0.0');
    const { source } = (await s.api('POST', '/sync-sources', {
      name: 'Git library',
      provider: 'forgejo',
      mode: 'library',
      repoUrl: `${s.base}/mock/git/${repo}`,
      branch: 'v{version}',
      folder: 'lib',
      kinds: ['process'],
      autoAcceptNew: true,
    })) as any;
    expect(source).toMatchObject({ mode: 'library', refType: 'tag', autoAcceptNew: false });
    const r1 = (await s.api('POST', `/sync-sources/${source.id}/fetch`)) as any;
    expect(r1).toMatchObject({ ref: 'v1.0.0', staged: 1, library: { library: 'git-library', release: '1.0.0', staged: true } });
    const rel = (await dana('GET', `/library-releases/${r1.library.releaseId}`)) as any;
    expect(rel.source).toMatchObject({ type: 'git', tag: 'v1.0.0', sourceId: source.id });
    // again: nothing new
    expect(((await s.api('POST', `/sync-sources/${source.id}/fetch`)) as any).upToDate).toBe(true);
    // a tag that names another version than release.json
    await commit(repo, folder(await signedRelease(key, { ...spec, release: '1.1.0' }), 'lib'));
    await tag(repo, 'v1.2.0');
    const e = await fail(s.api('POST', `/sync-sources/${source.id}/fetch`));
    expect(e.code).toBe('LIBRARY_TAG_MISMATCH');
    // pre-releases only when the source allows them; a pattern needs {version} once
    expect((await fail(s.api('PUT', `/sync-sources/${source.id}`, { ...source, branch: 'main' }))).status).toBe(400);
  });

  it('item mode leaves library folders alone', async () => {
    const key = testKey();
    const repo = `team/items-${Date.now().toString(36)}`;
    await commit(repo, {
      ...folder(await signedRelease(key, { library: 'x-lib' }), 'steward/lib'),
      'steward/p.yaml': NOTIFY_OWNER.replace('notify-owner', 'item-mode-proc'),
    });
    const { source } = (await s.api('POST', '/sync-sources', {
      name: 'Items',
      provider: 'forgejo',
      repoUrl: `${s.base}/mock/git/${repo}`,
      branch: 'main',
      folder: 'steward',
      kinds: ['process', 'monitor', 'recordType'],
    })) as any;
    const r = (await s.api('POST', `/sync-sources/${source.id}/fetch`)) as any;
    expect(r).toMatchObject({ files: 1, staged: 1, invalid: 0 });
  });
});

describe('the example library (examples/libraries)', () => {
  it('installs on an installation that trusts the test key (and only then)', async () => {
    const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '../../examples/libraries');
    const { readFolder } = await import('../src/libraries/releases.js');
    const files = readFolder(path.join(root, 'example-access-reviews'));
    expect((await fail(upload(dana, files))).code).toBe('LIBRARY_KEY_UNKNOWN');
    const line = fs
      .readFileSync(path.join(root, 'TEST-PUBLISHER-KEY.pub'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('ssh-'))!;
    await s.api('POST', '/library-publishers', { id: 'example-publisher', name: 'Example publisher (test key)' });
    await s.api('POST', '/library-publishers/example-publisher/keys', { key: line });
    const rel = await upload(dana, files);
    // it needs Steward 0.10.0: listed as "Needs Steward 0.10.0" on an older version, installable from 0.10.0 on
    const { config } = await import('../src/config.js');
    const running = config.version;
    config.version = '0.9.9';
    expect(((await dana('GET', `/library-releases/${rel.id}`)) as any).needsVersion).toBe('0.10.0');
    expect((await fail(s.api('POST', `/library-releases/${rel.id}/install`, { platforms: { idp: graphId } }))).code).toBe('LIBRARY_NEEDS_VERSION');
    config.version = '0.10.0';
    // earlier tests left local items with the same ids (guest-review, AEX): taken over on purpose here
    const conflicts = ((await s.api('GET', `/library-releases/${rel.id}/review`)) as any).items
      .filter((i: any) => i.status === 'conflict')
      .map((i: any) => i.path);
    const res = (await s.api('POST', `/library-releases/${rel.id}/install`, { platforms: { idp: graphId }, takeLibrary: conflicts }).finally(() => {
      config.version = running;
    })) as any;
    expect(res.library).toMatchObject({ library: 'example-access-reviews', release: expect.objectContaining({ release: '1.0.0' }) });
    expect(((await s.api('GET', '/processes/guest-review')) as any).definition.nodes.find((n: any) => n.type === 'subprocess')).toMatchObject({
      process: 'review-follow-up',
    });
  });
});

// last: it turns four-eyes on for the rest of the file
describe('four-eyes on install (control point library.install)', () => {
  it('waits for a second person who is not the requester', async () => {
    const key = testKey();
    await trust(key, 'fe-publisher');
    const policy = (await s.api('GET', '/assurance/policy')) as any;
    await s.api('PUT', '/assurance/policy', { points: { ...policy.policy.points, 'library.install': { fourEyes: 'required' } }, mfa: policy.policy.mfa });
    const rel = await upload(
      dana,
      await signedRelease(key, {
        library: 'fe-library',
        publisher: 'fe-publisher',
        items: { 'processes/n.yaml': NOTIFY_OWNER.replace('notify-owner', 'fe-notify') },
        references: { platforms: [] },
      }),
    );
    const asked = (await dana('POST', `/library-releases/${rel.id}/install`, {})) as any;
    expect(asked).toMatchObject({ status: 'requested', release: { installRequest: { by: 'dana' } } });
    expect(((await s.api('GET', '/processes')) as any[]).some((p) => p.id === 'fe-notify')).toBe(false);
    expect((await fail(dana('POST', `/library-releases/${rel.id}/approve`, {}))).code).toBe('FOUR_EYES_REQUIRED');
    const done = (await s.api('POST', `/library-releases/${rel.id}/approve`, {})) as any;
    expect(done.status).toBe('installed');
    expect(((await s.api('GET', '/processes')) as any[]).some((p) => p.id === 'fe-notify')).toBe(true);
  });
});

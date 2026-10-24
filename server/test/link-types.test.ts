import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_LINK_TYPES } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Types of external links (runbook, repository, …): the built-in ones, administrators' own (name and icon
 * from a fixed set, renamed and archived but never deleted), validation on links of records and services,
 * the audit trail, /api/v1 – and that links from before the migration stay unchanged.
 */

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, adam: Client, vera: Client;

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: '' }),
    (e: { status: number; message: string }) => ({ status: e.status, code: /"code":"([A-Z_]+)"/.exec(e.message)?.[1] ?? '' }),
  );
const status = async (p: Promise<unknown>) => (await errorOf(p)).status;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, vera] = await Promise.all(['dana', 'olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

const auditOf = async (entityId: string, action: string) => {
  const res = await s.api('GET', `/audit?entityId=${encodeURIComponent(entityId)}&action=${encodeURIComponent(action)}`);
  return (res.items ?? res) as { action: string; summary: string; details: Record<string, unknown> }[];
};

describe('link types', () => {
  it('everyone reads the built-in types, in their fixed order', async () => {
    const list = await vera('GET', '/link-types');
    expect(list.filter((t: { builtin: boolean }) => t.builtin).map((t: { key: string }) => t.key)).toEqual(BUILTIN_LINK_TYPES.map((t) => t.key));
    expect(list[0]).toMatchObject({ key: 'runbook', name: 'Runbook', icon: 'book', builtin: true, archived: false });
  });

  it('only administrators add, rename and archive types; built-ins cannot change', async () => {
    for (const c of [dana, olivia, adam, vera]) {
      expect(await status(c('POST', '/link-types', { name: 'Wiki', icon: 'book' }))).toBe(403);
      expect(await status(c('PUT', '/link-types/runbook', { name: 'Wiki', icon: 'book' }))).toBe(403);
      // no probing which keys exist
      expect(await status(c('PUT', '/link-types/nothing-here', { name: 'Wiki', icon: 'book' }))).toBe(403);
    }
    const wiki = await s.api('POST', '/link-types', { name: 'Team wiki', icon: 'book' });
    expect(wiki).toMatchObject({ key: 'team-wiki', name: 'Team wiki', icon: 'book', builtin: false, archived: false, createdBy: 'admin' });
    // a second one with a similar name gets the next free key; names are unique (also against the built-ins)
    const wiki2 = await s.api('POST', '/link-types', { name: 'Team-Wiki!', icon: 'folder' });
    expect(wiki2.key).toBe('team-wiki-2');
    expect(await errorOf(s.api('POST', '/link-types', { name: 'team wiki', icon: 'book' }))).toEqual({ status: 409, code: 'LINK_TYPE_EXISTS' });
    expect(await errorOf(s.api('POST', '/link-types', { name: 'RUNBOOK', icon: 'book' }))).toEqual({ status: 409, code: 'LINK_TYPE_EXISTS' });
    expect(await errorOf(s.api('POST', '/link-types', { key: 'runbook', name: 'Playbook', icon: 'book' }))).toEqual({
      status: 409,
      code: 'LINK_TYPE_KEY_TAKEN',
    });
    const own = await s.api('POST', '/link-types', { key: 'sbom', name: 'SBOM', icon: 'shield' });
    expect(own.key).toBe('sbom');
    // icons only from the fixed set; no unknown fields; no markup as a key
    expect(await status(s.api('POST', '/link-types', { name: 'Svg', icon: '<svg onload=alert(1)>' }))).toBe(400);
    expect(await status(s.api('POST', '/link-types', { name: 'Extra', icon: 'book', color: 'red' }))).toBe(400);
    expect(await status(s.api('POST', '/link-types', { key: 'Bad Key', name: 'Bad', icon: 'book' }))).toBe(400);
    expect(await status(s.api('POST', '/link-types', { name: 'x'.repeat(61), icon: 'book' }))).toBe(400);
    expect(await status(s.api('POST', '/link-types', { name: '   ', icon: 'book' }))).toBe(400);
    // a name without letters still gets a valid key
    expect((await s.api('POST', '/link-types', { name: '2nd line', icon: 'users' })).key).toMatch(/^[a-z][a-z0-9-]+$/);

    expect(await errorOf(s.api('PUT', '/link-types/runbook', { name: 'Playbook', icon: 'book' }))).toEqual({ status: 400, code: 'LINK_TYPE_BUILTIN' });
    expect(await errorOf(s.api('PUT', '/link-types/nothing-here', { name: 'X', icon: 'book' }))).toEqual({ status: 404, code: 'LINK_TYPE_NOT_FOUND' });
    expect(await errorOf(s.api('PUT', `/link-types/${wiki2.key}`, { name: 'Team wiki', icon: 'book' }))).toEqual({ status: 409, code: 'LINK_TYPE_EXISTS' });
    const renamed = await s.api('PUT', `/link-types/${wiki.key}`, { name: 'Wiki', icon: 'world' });
    expect(renamed).toMatchObject({ key: 'team-wiki', name: 'Wiki', icon: 'world' });

    const created = await auditOf('team-wiki', 'link_type.created');
    expect(created[0]!.details).toMatchObject({ key: 'team-wiki', name: 'Team wiki', icon: 'book' });
    const updated = await auditOf('team-wiki', 'link_type.updated');
    expect(updated[0]!.details).toMatchObject({ changes: ['name', 'icon'], previousName: 'Team wiki', name: 'Wiki' });
  });

  it('typed external links on records and services; validation; archived types stay on existing links', async () => {
    const svc = await dana('POST', '/services', { name: 'Link types service', owners: [] });
    const runbook = await dana('POST', `/services/${svc.id}/links`, { url: 'https://wiki.example.com/runbook', label: 'Runbook', linkType: 'runbook' });
    expect(runbook).toMatchObject({ kind: null, url: 'https://wiki.example.com/runbook', linkType: 'runbook' });
    const untyped = await dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/plain', label: 'Plain' });
    expect(untyped.linkType).toBeNull();
    const nullTyped = await dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/null', linkType: null });
    expect(nullTyped.linkType).toBeNull();

    expect(await errorOf(dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/a', linkType: 'nope' }))).toEqual({
      status: 400,
      code: 'LINK_TYPE_UNKNOWN',
    });
    expect(await status(dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/b', linkType: 'Runbook <b>' }))).toBe(400);
    expect(await status(dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/c', linkType: 'x'.repeat(41) }))).toBe(400);
    // internal links have no type
    const rec = await dana('POST', '/records', { type: 'DOC', title: 'Link types document' });
    expect(await status(dana('POST', `/services/${svc.id}/links`, { kind: 'record', id: rec.id, note: '', linkType: 'runbook' }))).toBe(400);
    // only who may change the links
    expect(await status(vera('POST', `/services/${svc.id}/links`, { url: 'https://example.com/d', linkType: 'runbook' }))).toBe(403);

    // records too, with an administrator's own type
    const sop = await s.api('POST', '/link-types', { name: 'Standard procedure', icon: 'tool' });
    const recLink = await dana('POST', `/records/${rec.id}/links`, { url: 'https://wiki.example.com/sop', label: 'SOP', linkType: sop.key });
    expect(recLink.linkType).toBe(sop.key);
    const added = await auditOf(rec.id, 'record.link_added');
    expect(added.find((e) => e.details.linkId === recLink.id)).toMatchObject({
      summary: expect.stringContaining('(Standard procedure)'),
      details: { linkType: sop.key, url: 'https://wiki.example.com/sop' },
    });

    // archived: no new links, existing ones keep the type; restoring makes it available again
    await s.api('PUT', `/link-types/${sop.key}`, { name: 'Standard procedure', icon: 'tool', archived: true });
    expect((await auditOf(sop.key, 'link_type.archived')).length).toBe(1);
    expect(await errorOf(dana('POST', `/records/${rec.id}/links`, { url: 'https://wiki.example.com/sop2', linkType: sop.key }))).toEqual({
      status: 400,
      code: 'LINK_TYPE_ARCHIVED',
    });
    const detail = await vera('GET', `/records/${rec.id}`);
    expect(detail.links.find((l: { id: string }) => l.id === recLink.id).linkType).toBe(sop.key);
    expect((await vera('GET', '/link-types')).find((t: { key: string }) => t.key === sop.key)).toMatchObject({ archived: true });
    await s.api('PUT', `/link-types/${sop.key}`, { name: 'Standard procedure', icon: 'tool', archived: false });
    expect((await auditOf(sop.key, 'link_type.restored')).length).toBe(1);
    await dana('POST', `/records/${rec.id}/links`, { url: 'https://wiki.example.com/sop2', linkType: sop.key });

    // removing a typed link: the audit entry names the type
    await dana('DELETE', `/services/${svc.id}/links/${runbook.id}`);
    const removed = await auditOf(svc.id, 'service.link_removed');
    expect(removed[0]!.details).toMatchObject({ linkId: runbook.id, linkType: 'runbook' });

    // the public API shows key and name
    const token = (await vera('POST', '/me/tokens', { name: 'link types', scope: 'read' })).token;
    const res = await fetch(`${s.base}/api/v1/records/${rec.id}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json();
    expect(body.links.find((l: { url: string }) => l.url === 'https://wiki.example.com/sop')).toMatchObject({
      linkType: sop.key,
      linkTypeName: 'Standard procedure',
    });
    await dana('POST', `/records/${rec.id}/links`, { url: 'https://git.example.com/repo', linkType: 'repository' });
    const again = await (await fetch(`${s.base}/api/v1/records/${rec.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(again.links.find((l: { url: string }) => l.url === 'https://git.example.com/repo')).toMatchObject({
      linkType: 'repository',
      linkTypeName: 'Repository',
    });
    expect(again.links.filter((l: { kind: string | null }) => l.kind !== null).every((l: { linkType: unknown }) => l.linkType === null)).toBe(true);
  });

  it('the record PDF names the type of external links', async () => {
    const rec = await dana('POST', '/records', { type: 'DOC', title: 'PDF link types' });
    await dana('POST', `/records/${rec.id}/links`, { url: 'https://status.example.com', label: 'Status page', linkType: 'monitoring' });
    const { generateRecordPdf } = await import('../src/records/pdf.js');
    const { runAs } = await import('../src/auth/context.js');
    const run = (lang: 'en' | 'de') =>
      runAs({ id: 'u', username: 'dana', displayName: 'Dana Designer', roles: ['designer'], teams: [] }, () =>
        generateRecordPdf(rec.id, { signers: [], lang }),
      );
    const en = await run('en');
    expect(en.texts.join('\n')).toContain('external · Monitoring');
    const de = await run('de');
    expect(de.texts.join('\n')).toContain('extern · Monitoring');
  });
});

describe('records-004-link-types on an existing database', () => {
  it('keeps existing links unchanged; they have no type', async () => {
    const { db, namedMigrations } = await import('../src/db.js');
    const svc = await dana('POST', '/services', { name: 'Migration links service', owners: [] });
    const rec = await dana('POST', '/records', { type: 'DOC', title: 'Migration links document' });
    await dana('POST', `/services/${svc.id}/links`, { url: 'https://cmdb.example.com/old', label: 'Old CMDB page', note: 'kept' });
    await dana('POST', `/records/${rec.id}/links`, { kind: 'service', id: svc.id, note: 'affected' });
    const snapshot = () => db().all('SELECT id, from_kind, from_id, to_kind, to_id, url, label, note, created_at, created_by FROM item_links ORDER BY id');
    const before = snapshot();
    const linksBefore = (await vera('GET', `/services/${svc.id}`)).links;

    // back to the schema before the migration, then the update
    db().exec('ALTER TABLE item_links DROP COLUMN link_type; DROP TABLE link_types;');
    db().run("DELETE FROM schema_migrations WHERE name = 'records-004-link-types'");
    const m = namedMigrations(db().dialect).find((x) => x.name === 'records-004-link-types')!;
    db().tx(() => {
      db().exec(m.sql);
      db().run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', m.name, new Date().toISOString());
    });

    expect(snapshot()).toEqual(before);
    expect(
      db()
        .all<{ link_type: string | null }>('SELECT link_type FROM item_links')
        .every((r) => r.link_type === null),
    ).toBe(true);
    const after = (await vera('GET', `/services/${svc.id}`)).links;
    expect(after).toEqual(linksBefore.map((l: Record<string, unknown>) => ({ ...l, linkType: null })));
    expect(after[0]).toMatchObject({ url: 'https://cmdb.example.com/old', label: 'Old CMDB page', note: 'kept', linkType: null });
    // and the new column works right away
    const typed = await dana('POST', `/services/${svc.id}/links`, { url: 'https://git.example.com/new', linkType: 'repository' });
    expect(typed.linkType).toBe('repository');
  });
});

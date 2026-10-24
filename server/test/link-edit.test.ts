import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Editing an existing link (#68): label, type and note of external links, the note of internal links –
 * on records and services, with the same permissions as adding and removing links, the same validation
 * as for new links (archived types may be kept, not newly chosen) and one audit entry with old and new values.
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

type AuditEntry = { action: string; actor: string; summary: string; details: Record<string, unknown> };
const auditOf = async (entityId: string, action: string): Promise<AuditEntry[]> => {
  const res = await s.api('GET', `/audit?entityId=${encodeURIComponent(entityId)}&action=${encodeURIComponent(action)}`);
  return (res.items ?? res) as AuditEntry[];
};
const CR = { type: 'CR', fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } };

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, vera] = await Promise.all(['dana', 'olivia', 'adam', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

describe('editing links of a service', () => {
  it('changes type, label and note of an external link; keeps who added it; one audit entry with old and new values', async () => {
    const svc = await dana('POST', '/services', { name: 'Link edit service', owners: [] });
    const link = await dana('POST', `/services/${svc.id}/links`, { url: 'https://wiki.example.com/restart', label: 'Restart', note: 'old note' });
    expect(link.linkType).toBeNull();

    const changed = await s.api('PATCH', `/services/${svc.id}/links/${link.id}`, { linkType: 'runbook', label: 'Restart runbook', note: 'checked' });
    expect(changed).toMatchObject({
      id: link.id,
      url: 'https://wiki.example.com/restart',
      linkType: 'runbook',
      label: 'Restart runbook',
      note: 'checked',
      createdBy: 'dana',
      createdAt: link.createdAt,
    });
    expect((await vera('GET', `/services/${svc.id}`)).links.find((l: { id: string }) => l.id === link.id)).toMatchObject({ linkType: 'runbook' });

    const entries = await auditOf(svc.id, 'service.link_updated');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: 'admin',
      summary: expect.stringContaining('none → Runbook'),
      details: {
        linkId: link.id,
        url: 'https://wiki.example.com/restart',
        changes: ['label', 'note', 'linkType'],
        old: { label: 'Restart', note: 'old note', linkType: null },
        new: { label: 'Restart runbook', note: 'checked', linkType: 'runbook' },
      },
    });

    // only the changed fields; missing fields stay as they are
    await dana('PATCH', `/services/${svc.id}/links/${link.id}`, { note: '' });
    const second = (await auditOf(svc.id, 'service.link_updated'))[0]!;
    expect(second.details).toMatchObject({ changes: ['note'], old: { note: 'checked' }, new: { note: '' } });
    expect(second.details.old).not.toHaveProperty('label');
    const now = (await dana('GET', `/services/${svc.id}`)).links.find((l: { id: string }) => l.id === link.id);
    expect(now).toMatchObject({ label: 'Restart runbook', note: '', linkType: 'runbook' });

    // back to no type ("Other")
    expect((await dana('PATCH', `/services/${svc.id}/links/${link.id}`, { linkType: null })).linkType).toBeNull();
    expect((await auditOf(svc.id, 'service.link_updated'))[0]!.details).toMatchObject({ old: { linkType: 'runbook' }, new: { linkType: null } });

    // an edit that changes nothing writes nothing (the values are trimmed as for new links)
    const before = (await auditOf(svc.id, 'service.link_updated')).length;
    const same = await dana('PATCH', `/services/${svc.id}/links/${link.id}`, { label: '  Restart runbook ', note: '', linkType: null });
    expect(same).toMatchObject({ label: 'Restart runbook', linkType: null });
    await dana('PATCH', `/services/${svc.id}/links/${link.id}`, {});
    expect((await auditOf(svc.id, 'service.link_updated')).length).toBe(before);
  });

  it('only who may change the links of the service', async () => {
    const svc = await dana('POST', '/services', { name: 'Link edit permissions', owners: [] });
    const link = await dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/p', label: 'P' });
    for (const c of [olivia, adam, vera]) expect(await status(c('PATCH', `/services/${svc.id}/links/${link.id}`, { note: 'x' }))).toBe(403);
    // read-only tokens never change anything
    const token = (await dana('POST', '/me/tokens', { name: 'read only', scope: 'read' })).token;
    const res = await fetch(`${s.base}/api/services/${svc.id}/links/${link.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-sm-client': '1' },
      body: JSON.stringify({ note: 'x' }),
    });
    expect(res.status).toBe(403);
    // the people named as responsible on the service may
    await dana('PUT', `/services/${svc.id}`, { name: 'Link edit permissions', owners: ['user:olivia'] });
    expect((await olivia('PATCH', `/services/${svc.id}/links/${link.id}`, { note: 'by the owner' })).note).toBe('by the owner');
    expect((await auditOf(svc.id, 'service.link_updated')).length).toBe(1);
    // unknown services and links; a link of another item is not found under this one
    expect(await errorOf(dana('PATCH', `/services/svc_nothing/links/${link.id}`, { note: 'x' }))).toMatchObject({ status: 404 });
    expect(await errorOf(dana('PATCH', `/services/${svc.id}/links/lnk_nothing`, { note: 'x' }))).toEqual({ status: 404, code: 'LINK_NOT_FOUND' });
    const other = await dana('POST', '/services', { name: 'Link edit other service', owners: [] });
    expect(await errorOf(dana('PATCH', `/services/${other.id}/links/${link.id}`, { note: 'x' }))).toEqual({ status: 404, code: 'LINK_NOT_FOUND' });
    expect((await dana('GET', `/services/${svc.id}`)).links[0].note).toBe('by the owner');
  });

  it('validation as for new links', async () => {
    const svc = await dana('POST', '/services', { name: 'Link edit validation', owners: [] });
    const link = await dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/v', label: 'V' });
    const patch = (body: unknown) => errorOf(dana('PATCH', `/services/${svc.id}/links/${link.id}`, body));
    expect(await patch({ linkType: 'nope' })).toEqual({ status: 400, code: 'LINK_TYPE_UNKNOWN' });
    expect((await patch({ linkType: 'Runbook <b>' })).status).toBe(400);
    expect((await patch({ linkType: '' })).status).toBe(400);
    expect((await patch({ label: 'x'.repeat(201) })).status).toBe(400);
    expect((await patch({ note: 'x'.repeat(201) })).status).toBe(400);
    expect((await patch({ note: 5 })).status).toBe(400);
    // the target does not change (that is a new link); no unknown fields
    expect((await patch({ url: 'https://evil.example.com' })).status).toBe(400);
    expect((await patch({ kind: 'process', id: 'x' })).status).toBe(400);
    expect((await dana('GET', `/services/${svc.id}`)).links[0]).toMatchObject({ url: 'https://example.com/v', label: 'V', linkType: null });
    expect(await auditOf(svc.id, 'service.link_updated')).toHaveLength(0);
    // limits: 200 characters are fine
    expect((await dana('PATCH', `/services/${svc.id}/links/${link.id}`, { label: 'l'.repeat(200), note: 'n'.repeat(200) })).note).toHaveLength(200);
  });
});

describe('editing links of a record', () => {
  it('internal links: only the note; links to items the user cannot see are not editable', async () => {
    const svc = await dana('POST', '/services', { name: 'Link edit target', owners: [] });
    const rec = await dana('POST', '/records', { ...CR, title: 'Link edit record' });
    const link = await dana('POST', `/records/${rec.id}/links`, { kind: 'service', id: svc.id, note: 'affected' });
    const changed = await olivia('PATCH', `/records/${rec.id}/links/${link.id}`, { note: 'implements' });
    expect(changed).toMatchObject({ id: link.id, kind: 'service', targetId: svc.id, note: 'implements', linkType: null, createdBy: 'dana' });
    const [entry] = await auditOf(rec.id, 'record.link_updated');
    expect(entry).toMatchObject({
      actor: 'olivia',
      summary: expect.stringContaining('Link edit target'),
      details: { linkId: link.id, kind: 'service', targetId: svc.id, changes: ['note'], old: { note: 'affected' }, new: { note: 'implements' } },
    });
    // a type or a label on an internal link: 400 (also "no type")
    for (const body of [{ linkType: 'runbook' }, { linkType: null }, { label: 'x' }, { note: 'x', linkType: 'runbook' }]) {
      expect(await errorOf(dana('PATCH', `/records/${rec.id}/links/${link.id}`, body))).toEqual({ status: 400, code: 'LINK_INTERNAL_FIELDS' });
    }
    expect((await dana('GET', `/records/${rec.id}`)).links[0]).toMatchObject({ note: 'implements', linkType: null });

    // a link to a process Olivia may not see: listed as not visible; editing answers 404 without naming it
    const def = { name: 'Hidden link edit process', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], wires: [] };
    const p = await s.api('POST', '/processes', { definition: def });
    await s.api('PUT', `/processes/${p.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['view'] }] });
    const hidden = await s.api('POST', `/records/${rec.id}/links`, { kind: 'process', id: p.id, note: 'secret' });
    const res = await errorOf(olivia('PATCH', `/records/${rec.id}/links/${hidden.id}`, { note: 'changed' }));
    expect(res).toEqual({ status: 404, code: 'LINK_NOT_FOUND' });
    const err = await olivia('PATCH', `/records/${rec.id}/links/${hidden.id}`, { note: 'changed' }).catch((e: Error) => e);
    expect(String(err)).not.toContain(p.id);
    // the administrator sees it and may edit it
    expect((await s.api('PATCH', `/records/${rec.id}/links/${hidden.id}`, { note: 'changed' })).note).toBe('changed');
  });

  it('permissions, archived types, approved and closed records', async () => {
    const rec = await dana('POST', '/records', { ...CR, title: 'Link edit lifecycle' });
    const link = await dana('POST', `/records/${rec.id}/links`, { url: 'https://wiki.example.com/sop', label: 'SOP' });
    // no edit right: approver (not the owner) and viewer
    for (const c of [adam, vera]) expect(await status(c('PATCH', `/records/${rec.id}/links/${link.id}`, { note: 'x' }))).toBe(403);
    expect(await status(adam('PATCH', `/records/rec_nothing/links/${link.id}`, { note: 'x' }))).toBe(404);

    // archived types: kept on the link, not newly chosen
    const sop = await s.api('POST', '/link-types', { name: 'Link edit SOP', icon: 'tool' });
    await dana('PATCH', `/records/${rec.id}/links/${link.id}`, { linkType: sop.key });
    await s.api('PUT', `/link-types/${sop.key}`, { name: 'Link edit SOP', icon: 'tool', archived: true });
    // keeping it while changing the label and note is fine
    const kept = await dana('PATCH', `/records/${rec.id}/links/${link.id}`, { linkType: sop.key, label: 'SOP v2', note: 'kept' });
    expect(kept).toMatchObject({ linkType: sop.key, label: 'SOP v2', note: 'kept' });
    expect((await auditOf(rec.id, 'record.link_updated'))[0]!.details).toMatchObject({ changes: ['label', 'note'] });
    // another link cannot get it
    const other = await dana('POST', `/records/${rec.id}/links`, { url: 'https://wiki.example.com/other', linkType: 'documentation' });
    expect(await errorOf(dana('PATCH', `/records/${rec.id}/links/${other.id}`, { linkType: sop.key }))).toEqual({ status: 400, code: 'LINK_TYPE_ARCHIVED' });
    // once changed to another type, the archived one cannot come back
    await dana('PATCH', `/records/${rec.id}/links/${link.id}`, { linkType: 'runbook' });
    expect(await errorOf(dana('PATCH', `/records/${rec.id}/links/${link.id}`, { linkType: sop.key }))).toEqual({ status: 400, code: 'LINK_TYPE_ARCHIVED' });
    expect((await dana('GET', `/records/${rec.id}`)).links.find((l: { id: string }) => l.id === link.id).linkType).toBe('runbook');

    // approved (frozen) records: links can change, as adding them; the record's content hash stays the same
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    const approved = await adam('POST', `/records/${rec.id}/transition`, { action: 'approve' });
    expect(approved.status).toBe('approved');
    expect((await olivia('PATCH', `/records/${rec.id}/links/${link.id}`, { note: 'after approval' })).note).toBe('after approval');
    const after = await dana('GET', `/records/${rec.id}`);
    expect(approved.frozenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(after).toMatchObject({ frozenHash: approved.frozenHash, tampered: false });
    expect(after.updatedBy).toBe('olivia');

    // closed records: no changes any more
    await dana('POST', `/records/${rec.id}/transition`, { action: 'implement' });
    await dana('POST', `/records/${rec.id}/transition`, { action: 'close' });
    expect(await errorOf(dana('PATCH', `/records/${rec.id}/links/${link.id}`, { note: 'too late' }))).toEqual({ status: 409, code: 'RECORD_CLOSED' });
    expect((await dana('GET', `/records/${rec.id}`)).links.find((l: { id: string }) => l.id === link.id).note).toBe('after approval');
  });

  it('a link of a record is not found under a service (and the other way round)', async () => {
    const rec = await dana('POST', '/records', { ...CR, title: 'Link edit cross' });
    const svc = await dana('POST', '/services', { name: 'Link edit cross service', owners: [] });
    const recLink = await dana('POST', `/records/${rec.id}/links`, { url: 'https://example.com/r' });
    const svcLink = await dana('POST', `/services/${svc.id}/links`, { url: 'https://example.com/s' });
    expect(await errorOf(dana('PATCH', `/services/${svc.id}/links/${recLink.id}`, { note: 'x' }))).toEqual({ status: 404, code: 'LINK_NOT_FOUND' });
    expect(await errorOf(dana('PATCH', `/records/${rec.id}/links/${svcLink.id}`, { note: 'x' }))).toEqual({ status: 404, code: 'LINK_NOT_FOUND' });
  });
});

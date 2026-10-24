import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The documentation of a service: living documents linked to it either way, with edition and review status,
 * "new document for this service", the overdue indicator of the service list and /api/v1 – and that
 * documents a reader may not read are neither listed nor counted.
 */

// Today every signed-in user reads documents; the read rule (canReadRecordRow) is replaced so the test can hide
// chosen records from chosen users and check that every view of a service applies it.
const hidden = vi.hoisted(() => new Map<string, Set<string>>());
vi.mock('../src/records/access.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/records/access.js')>();
  return {
    ...m,
    canReadRecordRow: (u: { username: string } | null, r: { id?: string; type_id: string; fields: string; owner: string }) =>
      !(u && r.id && hidden.get(u.username)?.has(r.id)) && m.canReadRecordRow(u as never, r),
  };
});

let s: TestServer;
const PW = 'Demo-password-1';
const DAY = 86400000;
let dana: Client, adam: Client, vera: Client;

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, adam, vera] = await Promise.all(['dana', 'adam', 'vera'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

async function makeOverdue(recordId: string) {
  const { db } = await import('../src/db.js');
  db().run('UPDATE record_documents SET next_review_override = ? WHERE record_id = ?', new Date(Date.now() - DAY).toISOString(), recordId);
}

const newService = (name: string) => dana('POST', '/services', { name, owners: [] });
const newDoc = (title: string, serviceId?: string) =>
  dana('POST', '/records', { type: 'DOC', title, ...(serviceId ? { links: [{ kind: 'service', id: serviceId, note: '' }] } : {}) });
async function approve(id: string) {
  await dana('POST', `/records/${id}/transition`, { action: 'submit', changeSummary: 'First edition' });
  return adam('POST', `/records/${id}/transition`, { action: 'approve' });
}

describe('new document for a service', () => {
  it('creates the document with the link to the service in one step', async () => {
    const svc = await newService('Docs: plant gateway');
    const doc = await newDoc('Gateway operations manual', svc.id);
    expect(doc.status).toBe('draft');
    expect(doc.links).toEqual([expect.objectContaining({ kind: 'service', targetId: svc.id, visible: true })]);
    const detail = await vera('GET', `/services/${svc.id}`);
    expect(detail.documents).toEqual([
      expect.objectContaining({
        id: doc.id,
        number: doc.number,
        title: 'Gateway operations manual',
        typeKey: 'DOC',
        status: 'draft',
        edition: null,
        reviewStatus: 'none',
        nextReviewAt: null,
        linkedFrom: ['record'],
      }),
    ]);
    // the link is audited like one added later
    const audit = await s.api('GET', `/audit?entityId=${doc.id}`);
    const actions = (audit.items ?? audit).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['record.created', 'record.link_added']));
  });

  it('refuses links to unknown items, too many links and users who cannot create records – and creates nothing then', async () => {
    const before = (await dana('GET', '/records?workflow=document')).length;
    expect(await status(newDoc('Orphan', 'svc_does_not_exist'))).toBe(404);
    expect(await status(dana('POST', '/records', { type: 'DOC', title: 'Self', links: [{ url: 'javascript:alert(1)' }] }))).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => ({ url: `https://wiki.example.com/${i}` }));
    expect(await status(dana('POST', '/records', { type: 'DOC', title: 'Many', links: many }))).toBe(400);
    const svc = await newService('Docs: refused');
    expect(await status(vera('POST', '/records', { type: 'DOC', title: 'By a viewer', links: [{ kind: 'service', id: svc.id }] }))).toBe(403);
    expect((await dana('GET', '/records?workflow=document')).length).toBe(before);
    expect((await dana('GET', `/services/${svc.id}`)).documents).toEqual([]);
  });
});

describe('the documentation section', () => {
  it('lists documents linked either way with edition and review status, and only documents', async () => {
    const svc = await newService('Docs: historian');
    const manual = await newDoc('Historian manual', svc.id);
    await approve(manual.id);
    // the service links to a concept; a second concept links both ways
    const concept = await newDoc('Historian IAM concept');
    await dana('POST', `/services/${svc.id}/links`, { kind: 'record', id: concept.id, note: '' });
    const both = await newDoc('Historian authorization concept', svc.id);
    await dana('POST', `/services/${svc.id}/links`, { kind: 'record', id: both.id, note: '' });
    // a change request linked to the service is not documentation
    const cr = await dana('POST', '/records', { type: 'CR', title: 'Historian change', fields: { reason: 'r', risk: 'low', rollbackPlan: 'p' } });
    await dana('POST', `/records/${cr.id}/links`, { kind: 'service', id: svc.id, note: '' });

    const docs = (await vera('GET', `/services/${svc.id}`)).documents;
    expect(docs.map((d: { id: string }) => d.id).sort()).toEqual([manual.id, concept.id, both.id].sort());
    const byId = new Map<string, any>(docs.map((d: { id: string }) => [d.id, d]));
    expect(byId.get(manual.id)).toMatchObject({ status: 'published', edition: '1.0', reviewStatus: 'current', linkedFrom: ['record'] });
    expect(byId.get(manual.id).nextReviewAt).toBeTruthy();
    expect(byId.get(manual.id).daysLeft).toBeGreaterThan(300);
    expect(byId.get(concept.id)).toMatchObject({ edition: null, linkedFrom: ['service'] });
    expect(byId.get(both.id).linkedFrom).toEqual(['record', 'service']);
    // ordered by number
    expect(docs.map((d: { number: string }) => d.number)).toEqual([...docs.map((d: { number: string }) => d.number)].sort());
  });

  it('the service list flags overdue reviews; hidden documents are neither listed nor counted', async () => {
    const svc = await newService('Docs: overdue');
    const shown = await newDoc('Overdue manual', svc.id);
    await approve(shown.id);
    const secret = await newDoc('Hidden overdue concept', svc.id);
    await approve(secret.id);
    await makeOverdue(shown.id);
    await makeOverdue(secret.id);

    const count = async (c: Client) => (await c('GET', '/services')).find((x: { id: string }) => x.id === svc.id).overdueDocuments;
    expect(await count(dana)).toBe(2);
    expect((await dana('GET', `/services/${svc.id}`)).overdueDocuments).toBe(2);

    hidden.set('vera', new Set([secret.id]));
    try {
      expect(await count(vera)).toBe(1);
      const detail = await vera('GET', `/services/${svc.id}`);
      expect(detail.overdueDocuments).toBe(1);
      expect(detail.documents.map((d: { id: string }) => d.id)).toEqual([shown.id]);
      expect(JSON.stringify(detail)).not.toContain(secret.number);
      expect(JSON.stringify(detail)).not.toContain('Hidden overdue concept');
      // all hidden: no indicator at all
      hidden.set('vera', new Set([secret.id, shown.id]));
      expect(await count(vera)).toBe(0);
      expect((await vera('GET', `/services/${svc.id}`)).documents).toEqual([]);
      // the others still see both
      expect(await count(dana)).toBe(2);
    } finally {
      hidden.clear();
    }
  });

  it('unknown services answer 404, signed-out requests 401', async () => {
    expect(await status(vera('GET', '/services/svc_nope'))).toBe(404);
    const res = await fetch(`${s.base}/api/services`, { headers: { 'x-sm-client': '1' } });
    expect(res.status).toBe(401);
  });
});

describe('/api/v1', () => {
  it('lists the documents of a service with edition and review status, for what the token owner may read', async () => {
    const svc = await newService('Docs: API');
    const a = await newDoc('API manual', svc.id);
    await approve(a.id);
    const b = await newDoc('API hidden concept', svc.id);
    const token = (await vera('POST', '/me/tokens', { name: 'docs', scope: 'read' })).token;
    const call = (url: string) => fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });

    let res = await call(`/services/${svc.id}/documents`);
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.nextCursor).toBeNull();
    expect(body.items).toEqual([
      expect.objectContaining({ id: a.id, number: a.number, edition: '1.0', reviewStatus: 'current', status: 'published', linkedFrom: ['record'] }),
      expect.objectContaining({ id: b.id, edition: null, reviewStatus: 'none', status: 'draft' }),
    ]);

    // paging
    res = await call(`/services/${svc.id}/documents?limit=1`);
    body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBeTruthy();

    hidden.set('vera', new Set([b.id]));
    try {
      body = await (await call(`/services/${svc.id}/documents`)).json();
      expect(body.items.map((d: { id: string }) => d.id)).toEqual([a.id]);
    } finally {
      hidden.clear();
    }

    res = await call('/services/svc_nope/documents');
    expect(res.status).toBe(404);
    expect((await fetch(`${s.base}/api/v1/services/${svc.id}/documents`)).status).toBe(401);
  });
});

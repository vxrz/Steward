/**
 * Regression tests for the records security review (R1, R3–R11): each block
 * reproduces a finding and checks that it no longer works. The denial of
 * service findings without a server (parser, engine, scans) are in
 * records-dos.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN, authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, adam: Client, vera: Client;
const cookies: Record<string, string> = {};

const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, text: '' }),
    (e: { status: number; message: string }) => ({ status: e.status, text: e.message }),
  );
const status = async (p: Promise<unknown>) => (await errorOf(p)).status;

async function upload(user: string, url: string, filename: string, data: Buffer | string): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), filename);
  const res = await fetch(s.base + '/api' + url, { method: 'POST', headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
async function download(user: string, url: string): Promise<Buffer> {
  const res = await fetch(s.base + '/api' + url, { headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' } });
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

const CR_FIELDS = { reason: 'Certificate expires', risk: 'low', rollbackPlan: 'Restore the old certificate' };
const newCr = (c: Client, title: string) => c('POST', '/records', { type: 'CR', title, fields: CR_FIELDS, body: '## Description\n\nText.\n' });
const act = (c: Client, id: string, action: string, comment?: string) => c('POST', `/records/${id}/transition`, { action, ...(comment ? { comment } : {}) });

/** An incremental update with a signature dictionary (as a signing tool appends it); `mangle` breaks it on purpose. */
function signLike(pdf: Buffer, mangle?: (update: string) => string): Buffer {
  const hex = '0'.repeat(128);
  const pad = (n: number) => String(n).padStart(10, ' ');
  const build = (b: number, c: number, d: number) =>
    `\n100 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Erika Mustermann) /M (D:20261022101500+02'00') /ByteRange [0 ${pad(b)} ${pad(c)} ${pad(d)}] /Contents <${hex}> >>\nendobj\n` +
    `101 0 obj\n<< /FT /Sig /T (Signature_1) /V 100 0 R >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 102 >>\nstartxref\n0\n%%EOF\n`;
  const draft = build(0, 0, 0);
  const b = pdf.length + draft.indexOf('/Contents <') + '/Contents '.length;
  const c = b + hex.length + 2;
  const update = build(b, c, pdf.length + draft.length - c);
  return Buffer.concat([pdf, Buffer.from(mangle ? mangle(update) : update, 'latin1')]);
}
async function pdfOf(id: string): Promise<Buffer> {
  const att = await dana('POST', `/records/${id}/pdf`, { signers: [{ name: 'Erika Mustermann' }] });
  return download('dana', `/records/${id}/attachments/${att.id}/download`);
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, adam, vera] = await Promise.all(['dana', 'adam', 'vera'].map((u) => s.as(u, PW)));
  cookies.admin = await loginCookie(s.base, ADMIN.username, ADMIN.password);
  cookies.dana = await loginCookie(s.base, 'dana', PW);
});
afterAll(async () => {
  await s?.app.close();
});

describe('R1: record PDFs with long words', () => {
  for (const [name, body] of [
    ['a 20 000-character word', 'a'.repeat(20000)],
    ['50 000 brackets', '['.repeat(50000)],
    ['long inline and fenced code', '`' + 'c'.repeat(20000) + '`\n\n```\n' + 'd'.repeat(20000) + '\n```\n'],
  ]) {
    it(`generates the PDF of a record with ${name} in a second or two`, async () => {
      const rec = await newCr(dana, 'Long words');
      await dana('PUT', `/records/${rec.id}`, { body, fields: { ...CR_FIELDS, impact: 'i'.repeat(5000) } });
      const t = performance.now();
      const att = await dana('POST', `/records/${rec.id}/pdf`, {});
      expect(performance.now() - t).toBeLessThan(10000); // was minutes; generous so a loaded CI runner does not flake
      expect(att.kind).toBe('generated');
    });
  }
});

describe('R3/R4: four-eyes covers files and earlier revisions', () => {
  it('who attached a file cannot approve', async () => {
    const rec = await newCr(dana, 'File by the admin');
    expect((await upload('admin', `/records/${rec.id}/attachments`, 'plan.txt', 'the plan')).status).toBe(200);
    await act(dana, rec.id, 'submit');
    const e = await errorOf(act(s.api, rec.id, 'approve'));
    expect(e.status).toBe(403);
    expect(e.text).toContain('FOUR_EYES');
    expect((await act(adam, rec.id, 'approve')).status).toBe('approved');
  });

  it('who removed a file cannot approve', async () => {
    const rec = await newCr(dana, 'File removed by the admin');
    const f = await upload('dana', `/records/${rec.id}/attachments`, 'offer.txt', 'offer');
    await s.api('DELETE', `/records/${rec.id}/attachments/${f.body.id}`);
    await act(dana, rec.id, 'submit');
    expect(await status(act(s.api, rec.id, 'approve'))).toBe(403);
  });

  it('a new revision does not launder the authors of the copied content', async () => {
    const rec = await newCr(dana, 'Written by the admin, revised by Dana');
    await s.api('PUT', `/records/${rec.id}`, { body: '## Description\n\nWritten by the administrator.\n' });
    await act(dana, rec.id, 'submit');
    await dana('POST', `/records/${rec.id}/revise`, { comment: 'Rework' });
    await act(dana, rec.id, 'submit');
    const seen = await s.api('GET', `/records/${rec.id}`);
    expect(seen.revision).toBe(2);
    expect(seen.actions.find((a: any) => a.action === 'approve')).toMatchObject({ allowed: false, reason: expect.stringMatching(/author of the content/) });
    expect(await status(act(s.api, rec.id, 'approve'))).toBe(403);
    expect((await act(adam, rec.id, 'approve')).status).toBe('approved');
  });
});

describe('R5: tamper check against the audit log', () => {
  it('refuses frozen content whose hash was recomputed in the database', async () => {
    const rec = await newCr(dana, 'Integrity');
    await act(dana, rec.id, 'submit');
    const { db } = await import('../src/db.js');
    const { contentHash } = await import('../src/records/model.js');
    const row = db().get<any>('SELECT * FROM records WHERE id = ?', rec.id);
    const files = db().all<any>("SELECT filename, sha256, size FROM record_attachments WHERE record_id = ? AND kind = 'file'", rec.id);
    const forged = { ...row, body: 'Changed behind Steward\n' };
    const forgedHash = contentHash(forged, 'CR', files);
    db().run('UPDATE records SET body = ?, frozen_hash = ? WHERE id = ?', forged.body, forgedHash, rec.id);
    // a forged audit entry (no valid HMAC) does not help either
    const seq = Number(db().get<{ n: number }>('SELECT MAX(seq) AS n FROM audit_log')!.n) + 1;
    db().run(
      "INSERT INTO audit_log (seq, ts, actor, action, entity_type, entity_id, run_id, summary, details, prev_hash, hash) VALUES (?, ?, 'dana', 'record.submit', 'record', ?, NULL, 'forged', ?, 'x', 'y')",
      seq,
      new Date().toISOString(),
      rec.id,
      JSON.stringify({ frozen: true, revision: 1, contentHash: forgedHash }),
    );
    try {
      const seen = await adam('GET', `/records/${rec.id}`);
      expect(seen.contentHash).toBe(seen.frozenHash);
      expect(seen.tampered).toBe(true);
      const e = await errorOf(act(adam, rec.id, 'approve'));
      expect(e.status).toBe(409);
      expect(e.text).toContain('RECORD_TAMPERED');
    } finally {
      db().run('DELETE FROM audit_log WHERE seq = ?', seq);
    }
    // untouched records are not affected
    const ok = await newCr(dana, 'Integrity (untouched)');
    await act(dana, ok.id, 'submit');
    expect((await adam('GET', `/records/${ok.id}`)).tampered).toBe(false);
    expect((await act(adam, ok.id, 'approve')).status).toBe('approved');
  });
});

describe('R6: the key of a type with records', () => {
  it('cannot change (frozen hashes contain it); the name can', async () => {
    const base = { key: 'KEYA', name: 'Key test', workflow: 'decision', template: '', fields: [] };
    const t = await s.api('POST', '/record-types', base);
    await s.api('PUT', `/record-types/${t.id}`, { ...base, key: 'KEYB' }); // no records yet: fine
    const rec = await dana('POST', '/records', { type: 'KEYB', title: 'Keyed' });
    await act(dana, rec.id, 'propose');
    const e = await errorOf(s.api('PUT', `/record-types/${t.id}`, { ...base, key: 'KEYC' }));
    expect(e.status).toBe(409);
    expect(e.text).toContain('TYPE_KEY_LOCKED');
    expect((await s.api('PUT', `/record-types/${t.id}`, { ...base, key: 'KEYB', name: 'Key test (renamed)' })).name).toBe('Key test (renamed)');
    expect((await act(adam, rec.id, 'accept')).status).toBe('accepted');
  });
});

describe('R7: links to items the reader cannot see', () => {
  it('do not disclose the target id; backlinks of hidden items are not served', async () => {
    const def = { name: 'Hidden maintenance window', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], wires: [] };
    const p = await s.api('POST', '/processes', { definition: def });
    await s.api('PUT', `/processes/${p.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['view'] }] });
    const rec = await newCr(dana, 'Links to hidden things');
    await s.api('POST', `/records/${rec.id}/links`, { kind: 'process', id: p.id });
    const seen = await vera('GET', `/records/${rec.id}`);
    expect(seen.links[0]).toMatchObject({ kind: 'process', targetId: null, visible: false, label: '' });
    expect(JSON.stringify(seen)).not.toContain(p.id);
    expect((await s.api('GET', `/records/${rec.id}`)).links[0].targetId).toBe(p.id);
    expect(await status(vera('GET', `/backlinks?kind=process&id=${encodeURIComponent(p.id)}`))).toBe(404);
    expect((await s.api('GET', `/backlinks?kind=process&id=${encodeURIComponent(p.id)}`)).some((b: any) => b.id === rec.id)).toBe(true);
    // nor in the PDF someone without access generates
    const { generateRecordPdf } = await import('../src/records/pdf.js');
    const { runAs } = await import('../src/auth/context.js');
    const r = await runAs({ id: 'u', username: 'dana', displayName: 'Dana', roles: ['designer'], teams: [] }, () => generateRecordPdf(rec.id, { signers: [] }));
    expect(r.texts.join('\n')).not.toContain(p.id);
  });
});

describe('R8: signed PDFs', () => {
  it('only for the current, frozen revision', async () => {
    const draft = await newCr(dana, 'Signed draft');
    const res = await upload('dana', `/records/${draft.id}/signed`, 'signed.pdf', signLike(await pdfOf(draft.id)));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PDF_NOT_CURRENT');

    const rec = await newCr(dana, 'Signed after a new revision');
    await act(dana, rec.id, 'submit');
    const first = await pdfOf(rec.id);
    await dana('POST', `/records/${rec.id}/revise`, { comment: 'Rework' });
    await act(dana, rec.id, 'submit');
    const old = await upload('dana', `/records/${rec.id}/signed`, 'old.pdf', signLike(first));
    expect(old.status).toBe(422);
    expect(old.body.code).toBe('PDF_NOT_CURRENT');
    const ok = await upload('dana', `/records/${rec.id}/signed`, 'current.pdf', signLike(await pdfOf(rec.id)));
    expect(ok.status).toBe(200);
    const audit = (await s.api('GET', `/audit?entityType=record&entityId=${rec.id}&action=record.signed_pdf_uploaded`))[0];
    expect(audit.summary).toContain('claimed signers: Erika Mustermann');
  });

  it('every signature needs a signature value and a consistent byte range', async () => {
    const rec = await newCr(dana, 'Signature structure');
    await act(dana, rec.id, 'submit');
    const pdf = await pdfOf(rec.id);
    const noValue = await upload(
      'dana',
      `/records/${rec.id}/signed`,
      'no-value.pdf',
      signLike(pdf, (u) => u.replace('/Contents <', '/Contentz <')),
    );
    expect(noValue.status).toBe(422);
    expect(noValue.body.code).toBe('PDF_BAD_SIGNATURE');
    const badRange = await upload(
      'dana',
      `/records/${rec.id}/signed`,
      'bad-range.pdf',
      signLike(pdf, (u) => u.replace(/\/ByteRange \[0 [^\]]*\]/, '/ByteRange [0 10 20 30]')),
    );
    expect(badRange.status).toBe(422);
    expect(badRange.body.code).toBe('PDF_BAD_SIGNATURE');
    expect((await upload('dana', `/records/${rec.id}/signed`, 'fine.pdf', signLike(pdf))).status).toBe(200);
  });
});

describe('R9: stored PDFs per record', () => {
  it('limits generated and signed PDFs', async () => {
    const { PDF_LIMITS } = await import('../src/records/signed.js');
    const saved = { ...PDF_LIMITS };
    try {
      PDF_LIMITS.generated = 2;
      PDF_LIMITS.signed = 1;
      const rec = await newCr(dana, 'Many PDFs');
      await act(dana, rec.id, 'submit');
      const pdf = await pdfOf(rec.id);
      await dana('POST', `/records/${rec.id}/pdf`, {});
      const e = await errorOf(dana('POST', `/records/${rec.id}/pdf`, {}));
      expect(e.status).toBe(409);
      expect(e.text).toContain('PDF_LIMIT');
      expect((await upload('dana', `/records/${rec.id}/signed`, 'one.pdf', signLike(pdf))).status).toBe(200);
      const second = await upload(
        'dana',
        `/records/${rec.id}/signed`,
        'two.pdf',
        signLike(pdf, (u) => u.replace('Erika', 'Erik ')),
      );
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('PDF_LIMIT');
    } finally {
      Object.assign(PDF_LIMITS, saved);
    }
  });
});

describe('R10: links of closed records', () => {
  it('cannot change any more', async () => {
    const rec = await newCr(dana, 'Closed change');
    const link = await dana('POST', `/records/${rec.id}/links`, { url: 'https://cmdb.example.com/ci/1' });
    await act(dana, rec.id, 'submit');
    await act(adam, rec.id, 'approve');
    await act(dana, rec.id, 'implement');
    const closed = await act(dana, rec.id, 'close');
    expect(closed.permissions.link).toBe(false);
    const e = await errorOf(dana('POST', `/records/${rec.id}/links`, { url: 'https://cmdb.example.com/ci/2' }));
    expect(e.status).toBe(409);
    expect(e.text).toContain('RECORD_CLOSED');
    expect(await status(dana('DELETE', `/records/${rec.id}/links/${link.id}`))).toBe(409);
    expect((await dana('GET', `/records/${rec.id}`)).links).toHaveLength(1);
  });
});

describe('R11: field definitions of frozen content', () => {
  it('are kept as they were when the content was frozen', async () => {
    const field = { key: 'impact', label: 'Impact', kind: 'select', options: ['low', 'high'] };
    const base = { key: 'FLD', name: 'Field test', workflow: 'decision', template: '', fields: [field] };
    const t = await s.api('POST', '/record-types', base);
    const rec = await dana('POST', '/records', { type: 'FLD', title: 'Frozen fields', fields: { impact: 'high' } });
    const draft = await dana('POST', '/records', { type: 'FLD', title: 'Draft fields', fields: { impact: 'low' } });
    await act(dana, rec.id, 'propose');
    await s.api('PUT', `/record-types/${t.id}`, { ...base, fields: [{ ...field, label: 'Business impact', options: ['minor', 'major'] }] });
    const seen = await vera('GET', `/records/${rec.id}`);
    expect(seen.fieldDefs).toEqual([field]);
    expect((await vera('GET', `/records/${rec.id}/versions`))[0].fieldDefs).toEqual([field]);
    expect((await vera('GET', `/records/${draft.id}`)).fieldDefs[0].label).toBe('Business impact');
    // the definition removed: the frozen record still shows it, the draft shows the stored value by its key
    await s.api('PUT', `/record-types/${t.id}`, { ...base, fields: [] });
    expect((await vera('GET', `/records/${rec.id}`)).fieldDefs).toEqual([field]);
    expect((await vera('GET', `/records/${draft.id}`)).fieldDefs).toEqual([{ key: 'impact', label: 'impact', kind: 'textarea' }]);
    const { generateRecordPdf } = await import('../src/records/pdf.js');
    const { runAs } = await import('../src/auth/context.js');
    const r = await runAs({ id: 'u', username: 'dana', displayName: 'Dana', roles: ['designer'], teams: [] }, () => generateRecordPdf(rec.id, { signers: [] }));
    expect(r.texts).toContain('IMPACT');
    expect(r.texts).toContain('high');
    expect(r.texts).not.toContain('BUSINESS IMPACT');
  });
});

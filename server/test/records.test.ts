import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RECORD_TYPES, LINK_KINDS, RECORD_ACTIONS, RECORD_STATUSES, parseMarkdown, inlineText } from '@sm/shared';
import { authHeaders, loginCookie, setup, startTestServer, ADMIN, type Client, type TestServer } from './helpers.js';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;
const cookies: Record<string, string> = {};
const year = new Date().getUTCFullYear();
/** Set SM_REPORT_SAMPLES=/some/dir to keep copies of the generated PDFs (visual checks). */
const SAMPLES = process.env.SM_REPORT_SAMPLES;
function keep(name: string, pdf: Buffer): void {
  if (!SAMPLES) return;
  fs.mkdirSync(SAMPLES, { recursive: true });
  fs.writeFileSync(path.join(SAMPLES, name), pdf);
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, text: '' }),
    (e: { status: number; message: string }) => ({ status: e.status, text: e.message }),
  );
const hasTool = (bin: string) => spawnSync(bin, ['-v'], { stdio: 'ignore' }).error === undefined;

async function upload(
  user: string,
  url: string,
  filename: string,
  data: Buffer | string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), filename);
  const res = await fetch(s.base + '/api' + url, { method: 'POST', headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function download(user: string, url: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(s.base + '/api' + url, { headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' } });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

const CR_FIELDS = {
  reason: 'Certificate expires',
  risk: 'low',
  rollbackPlan: 'Restore the old certificate',
  plannedStart: '2026-11-03T18:00',
  plannedEnd: '2026-11-03T19:00',
};

async function newCr(c: Client = dana, title = 'Renew the TLS certificate', fields: Record<string, string> = CR_FIELDS) {
  return c('POST', '/records', { type: 'CR', title, fields, body: '## Description\n\nReplace the **certificate** on the gateway.\n' });
}

/** An incremental update with a signature dictionary (what Acrobat appends when signing), with a consistent /ByteRange. */
function signLike(pdf: Buffer, o: { name?: string; field?: string } = {}): Buffer {
  const hex = '0'.repeat(128);
  const pad = (n: number) => String(n).padStart(10, ' ');
  const build = (b: number, c: number, d: number) =>
    `\n100 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (${o.name ?? 'Erika Mustermann'}) /M (D:20261022101500+02'00') /Reason (Approved \\(as business owner\\)) /Location <FEFF004D00FC006E006300680065006E> /ByteRange [0 ${pad(b)} ${pad(c)} ${pad(d)}] /Contents <${hex}> >>\nendobj\n` +
    `101 0 obj\n<< /FT /Sig /T (${o.field ?? 'Signature_1_Business_owner'}) /V 100 0 R >>\nendobj\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 102 >>\nstartxref\n0\n%%EOF\n`;
  const draft = build(0, 0, 0);
  const b = pdf.length + draft.indexOf('/Contents <') + '/Contents '.length;
  const c = b + hex.length + 2;
  const total = pdf.length + draft.length;
  return Buffer.concat([pdf, Buffer.from(build(b, c, total - c), 'latin1')]);
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  cookies.admin = await loginCookie(s.base, ADMIN.username, ADMIN.password);
  for (const u of ['dana', 'olivia', 'adam', 'vera']) cookies[u] = await loginCookie(s.base, u, PW);
});
afterAll(async () => {
  await s?.app.close();
});

describe('record types', () => {
  it('has editable defaults for change requests and decision records', async () => {
    const types = await vera('GET', '/record-types');
    expect(types.map((t: any) => t.key)).toEqual(['ADR', 'CR', 'DR', 'SDR']);
    const cr = types.find((t: any) => t.key === 'CR');
    expect(cr).toMatchObject({ name: 'Change request', workflow: 'change', builtin: true });
    expect(cr.fields.map((f: any) => f.key)).toEqual(['reason', 'risk', 'impact', 'rollbackPlan', 'plannedStart', 'plannedEnd']);
    expect(cr.template).toContain('## Implementation plan');
    expect(types.find((t: any) => t.key === 'SDR')).toMatchObject({ name: 'Security decision record', workflow: 'decision' });
  });

  it('only administrators manage types', async () => {
    const t = { key: 'RFC', name: 'Request for comments', workflow: 'decision', template: '## Proposal\n', fields: [] };
    expect(await status(dana('POST', '/record-types', t))).toBe(403);
    expect(await status(adam('POST', '/record-types', t))).toBe(403);
    const created = await s.api('POST', '/record-types', t);
    expect(created).toMatchObject({ key: 'RFC', builtin: false, recordCount: 0 });
    expect(await status(s.api('POST', '/record-types', t))).toBe(409);
    expect(await status(s.api('POST', '/record-types', { ...t, key: 'r!' }))).toBe(400);
    expect(await status(s.api('POST', '/record-types', { ...t, key: 'SEL', fields: [{ key: 'level', label: 'Level', kind: 'select' }] }))).toBe(400);
    expect(await status(dana('PUT', `/record-types/${created.id}`, { ...t, name: 'RFC' }))).toBe(403);
    const updated = await s.api('PUT', `/record-types/${created.id}`, {
      ...t,
      name: 'RFC (team)',
      fields: [{ key: 'audience', label: 'Audience', kind: 'text' }],
    });
    expect(updated).toMatchObject({ name: 'RFC (team)' });
    const rec = await dana('POST', '/records', { type: 'RFC', title: 'Use RFCs', fields: { audience: 'all' } });
    expect(rec.number).toBe(`RFC-${year}-0001`);
    // the workflow of a type that has records is fixed
    expect(await status(s.api('PUT', `/record-types/${created.id}`, { ...t, workflow: 'change' }))).toBe(409);
    // archived types accept no new records
    await s.api('PUT', `/record-types/${created.id}`, { ...t, archived: true });
    expect(await status(dana('POST', '/records', { type: 'RFC', title: 'Another' }))).toBe(409);
    expect((await vera('GET', '/record-types')).map((x: any) => x.key)).not.toContain('RFC');
    expect((await vera('GET', '/record-types?archived=1')).map((x: any) => x.key)).toContain('RFC');
    const audit = await s.api('GET', `/audit?entityType=record_type&entityId=${created.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['record_type.created', 'record_type.updated']));
  });
});

describe('numbering', () => {
  it('numbers records per type and year', async () => {
    const a = await newCr();
    const b = await newCr();
    const adr = await dana('POST', '/records', { type: 'ADR', title: 'Use PostgreSQL' });
    const [na, nb] = [a.number, b.number].map((n: string) => Number(n.split('-')[2]));
    expect(a.number).toMatch(new RegExp(`^CR-${year}-\\d{4}$`));
    expect(nb).toBe(na + 1);
    expect(adr.number).toMatch(new RegExp(`^ADR-${year}-\\d{4}$`));
    // a record can be fetched by its number
    expect((await vera('GET', `/records/${a.number}`)).id).toBe(a.id);
    // the template is the default text
    expect(adr.body).toContain('## Context and problem statement');
    expect(adr.status).toBe('draft');
  });
});

describe('permissions', () => {
  let rec: any;
  beforeAll(async () => {
    rec = await newCr(olivia, 'Operator change');
  });
  it('everyone who can sign in reads records', async () => {
    for (const c of [vera, audrey, adam]) {
      expect((await c('GET', '/records')).some((r: any) => r.id === rec.id)).toBe(true);
      expect((await c('GET', `/records/${rec.id}`)).number).toBe(rec.number);
      expect((await c('GET', `/records/${rec.id}/versions`)).length).toBe(1);
    }
    expect(await vera('GET', '/records/meta')).toMatchObject({ canCreate: false, canApprove: false, canManageTypes: false });
    expect(await adam('GET', '/records/meta')).toMatchObject({ canCreate: false, canApprove: true });
    expect(await dana('GET', '/records/meta')).toMatchObject({ canCreate: true, canApprove: false });
  });
  it('viewers, auditors and approvers cannot create or edit', async () => {
    for (const c of [vera, audrey, adam]) {
      expect(await status(c('POST', '/records', { type: 'CR', title: 'x' }))).toBe(403);
      expect(await status(c('PUT', `/records/${rec.id}`, { title: 'changed' }))).toBe(403);
      expect(await status(c('POST', `/records/${rec.id}/transition`, { action: 'submit' }))).toBe(403);
      expect(await status(c('POST', `/records/${rec.id}/links`, { url: 'https://example.com' }))).toBe(403);
      expect((await upload(c === vera ? 'vera' : 'adam', `/records/${rec.id}/attachments`, 'a.txt', 'hello')).status).toBe(403);
    }
    expect(await status(vera('POST', `/records/${rec.id}/comments`, { text: 'hi' }))).toBe(403);
    expect(await status(audrey('POST', `/records/${rec.id}/comments`, { text: 'hi' }))).toBe(403);
    expect(await status(vera('POST', `/records/${rec.id}/pdf`, {}))).toBe(403);
    expect(await status(vera('POST', '/records/import', { files: [{ filename: 'a.md', content: '# A' }] }))).toBe(403);
  });
  it('designers, operators and administrators edit drafts; approvers comment', async () => {
    expect((await dana('PUT', `/records/${rec.id}`, { title: 'Operator change (reviewed)' })).title).toBe('Operator change (reviewed)');
    expect((await s.api('PUT', `/records/${rec.id}`, { tags: ['Network', 'gateway'] })).tags).toEqual(['gateway', 'network']);
    expect((await adam('POST', `/records/${rec.id}/comments`, { text: 'Please add the window' })).events.at(-1)).toMatchObject({
      kind: 'comment',
      actor: 'adam',
    });
    expect(await status(adam('POST', `/records/${rec.id}/comments`, { text: '' }))).toBe(400);
  });
  it('only the owner or an administrator hands a record over', async () => {
    expect(await status(dana('PUT', `/records/${rec.id}`, { owner: 'dana' }))).toBe(403);
    expect((await olivia('PUT', `/records/${rec.id}`, { owner: 'dana' })).owner).toBe('dana');
    expect(await status(s.api('PUT', `/records/${rec.id}`, { owner: 'nobody-here' }))).toBe(400);
    expect((await s.api('PUT', `/records/${rec.id}`, { owner: 'olivia' })).owner).toBe('olivia');
  });
});

describe('workflow: change requests', () => {
  it('submit, four-eyes approval, implement, close', async () => {
    const rec = await newCr(dana, 'Firewall rule', { reason: 'New partner', risk: 'medium', rollbackPlan: 'Remove rule' });
    expect(rec.actions.map((a: any) => a.action)).toEqual(['submit', 'cancel']);
    const sub = await dana('POST', `/records/${rec.id}/transition`, { action: 'submit', comment: 'Ready' });
    expect(sub).toMatchObject({ status: 'submitted', frozen: true, submittedBy: 'dana' });
    expect(sub.frozenHash).toBe(sub.contentHash);
    expect(sub.permissions.edit).toBe(false);
    // frozen: no content changes, tags still allowed
    const frozen = await errorOf(dana('PUT', `/records/${rec.id}`, { body: 'changed' }));
    expect(frozen.status).toBe(409);
    expect(frozen.text).toContain('RECORD_FROZEN');
    expect((await dana('PUT', `/records/${rec.id}`, { tags: ['firewall'] })).tags).toEqual(['firewall']);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'plan.txt', 'plan')).status).toBe(409);
    // four-eyes: the submitter cannot approve – and needs the approver role anyway
    const own = await dana('GET', `/records/${rec.id}`);
    expect(own.actions.find((a: any) => a.action === 'approve')).toMatchObject({ allowed: false });
    expect(await status(dana('POST', `/records/${rec.id}/transition`, { action: 'approve' }))).toBe(403);
    // an approver may; rejecting needs a comment
    expect((await adam('GET', `/records/${rec.id}`)).actions.find((a: any) => a.action === 'approve')).toMatchObject({ allowed: true });
    expect(await status(adam('POST', `/records/${rec.id}/transition`, { action: 'reject' }))).toBe(400);
    // a transition that is not allowed from here
    const bad = await errorOf(dana('POST', `/records/${rec.id}/transition`, { action: 'implement' }));
    expect(bad.status).toBe(409);
    expect(bad.text).toContain('INVALID_TRANSITION');
    expect(await status(dana('POST', `/records/${rec.id}/transition`, { action: 'fly' }))).toBe(400);
    const ok = await adam('POST', `/records/${rec.id}/transition`, { action: 'approve', comment: 'Looks good' });
    expect(ok.status).toBe('approved');
    expect(ok.frozenHash).toBe(sub.frozenHash);
    // approved content is immutable: no new revision
    expect(await status(dana('POST', `/records/${rec.id}/revise`, { comment: 'oops' }))).toBe(409);
    expect((await dana('POST', `/records/${rec.id}/transition`, { action: 'implement' })).status).toBe('implemented');
    expect(await status(vera('POST', `/records/${rec.id}/transition`, { action: 'close' }))).toBe(403);
    const closed = await dana('POST', `/records/${rec.id}/transition`, { action: 'close' });
    expect(closed.status).toBe('closed');
    expect(closed.actions).toEqual([]);
    expect(await status(dana('POST', `/records/${rec.id}/transition`, { action: 'cancel' }))).toBe(409);
    // every transition is audited with the content hash
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${rec.id}`);
    const approve = audit.find((a: any) => a.action === 'record.approve');
    expect(approve).toMatchObject({ actor: 'adam' });
    expect(approve.details).toMatchObject({ from: 'submitted', to: 'approved', contentHash: sub.frozenHash, fourEyes: true });
    expect(audit.find((a: any) => a.action === 'record.submit').details).toMatchObject({ frozen: true, contentHash: sub.frozenHash });
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['record.created', 'record.implement', 'record.close']));
    const events = closed.events.filter((e: any) => e.kind === 'transition');
    expect(events.map((e: any) => `${e.action}:${e.actor}`)).toEqual(['submit:dana', 'approve:adam', 'implement:dana', 'close:dana']);
    expect((await s.api('GET', '/audit/verify')).ok).toBe(true);
  });

  it('checks required fields before submitting', async () => {
    const rec = await dana('POST', '/records', { type: 'CR', title: 'Incomplete' });
    const e = await errorOf(dana('POST', `/records/${rec.id}/transition`, { action: 'submit' }));
    expect(e.status).toBe(400);
    expect(e.text).toContain('Reason');
    // cancelling a draft needs no fields
    expect((await dana('POST', `/records/${rec.id}/transition`, { action: 'cancel' })).status).toBe('cancelled');
  });

  it('validates fields by kind', async () => {
    expect(await status(newCr(dana, 'x', { ...CR_FIELDS, risk: 'extreme' }))).toBe(400);
    expect(await status(newCr(dana, 'x', { ...CR_FIELDS, plannedStart: 'tomorrow' }))).toBe(400);
    expect(await status(newCr(dana, 'x', { ...CR_FIELDS, unknownField: 'x' } as any))).toBe(400);
    expect(await status(dana('POST', '/records', { type: 'CR', title: '' }))).toBe(400);
    expect(await status(dana('POST', '/records', { type: 'NOPE', title: 'x' }))).toBe(404);
  });

  it('rejected records go back to draft as a new revision (audited)', async () => {
    const rec = await newCr(dana, 'Patch the gateway');
    const sub = await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    await adam('POST', `/records/${rec.id}/transition`, { action: 'reject', comment: 'Rollback plan missing details' });
    expect(await status(dana('POST', `/records/${rec.id}/revise`, { comment: '' }))).toBe(400);
    expect(await status(vera('POST', `/records/${rec.id}/revise`, { comment: 'x' }))).toBe(403);
    const rev = await dana('POST', `/records/${rec.id}/revise`, { comment: 'Add rollback details' });
    expect(rev).toMatchObject({ status: 'draft', revision: 2, frozen: false, frozenHash: null, submittedBy: null });
    expect(rev.contentHash).not.toBe(sub.frozenHash); // the revision is part of the hash
    const edited = await olivia('PUT', `/records/${rec.id}`, {
      fields: { ...CR_FIELDS, rollbackPlan: 'Restore snapshot taken before' },
      comment: 'more detail',
      baseVersion: rev.version,
    });
    expect(edited.version).toBe(rev.version + 1);
    // optimistic concurrency
    expect(await status(dana('PUT', `/records/${rec.id}`, { body: 'x', baseVersion: rev.version }))).toBe(409);
    const versions = await vera('GET', `/records/${rec.id}/versions`);
    expect(versions.map((v: any) => [v.version, v.revision])).toEqual([
      [3, 2],
      [2, 2],
      [1, 1],
    ]);
    expect(versions[0]).toMatchObject({ author: 'olivia', comment: 'more detail' });
    expect((await vera('GET', `/records/${rec.id}/versions/1`)).fields.rollbackPlan).toBe(CR_FIELDS.rollbackPlan);
    expect(await status(vera('GET', `/records/${rec.id}/versions/99`))).toBe(404);
    // the frozen content of revision 1 stays in the audit log
    const revised = (await s.api('GET', `/audit?entityType=record&entityId=${rec.id}&action=record.revised`))[0];
    expect(revised.details).toMatchObject({ revision: 2, previousContentHash: sub.frozenHash });
    // submitting again; adam (who rejected, but did not write) may approve now
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    expect((await adam('POST', `/records/${rec.id}/transition`, { action: 'approve' })).status).toBe('approved');
  });

  it('four-eyes also covers the owner and authors of the revision', async () => {
    // an administrator who wrote the record cannot approve it
    const own = await s.api('POST', '/records', { type: 'CR', title: 'Admin change', fields: CR_FIELDS });
    await s.api('POST', `/records/${own.id}/transition`, { action: 'submit' });
    const e = await errorOf(s.api('POST', `/records/${own.id}/transition`, { action: 'approve' }));
    expect(e.status).toBe(403);
    expect(e.text).toContain('FOUR_EYES');
    // an administrator who only edited the current revision cannot approve either
    const rec = await newCr(dana, 'Edited by admin');
    await s.api('PUT', `/records/${rec.id}`, { body: 'admin edit' });
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    expect((await s.api('GET', `/records/${rec.id}`)).actions.find((a: any) => a.action === 'approve').reason).toMatch(/author of the content/);
    expect(await status(s.api('POST', `/records/${rec.id}/transition`, { action: 'approve' }))).toBe(403);
    // an administrator who did not write it may
    const other = await newCr(dana, 'Approved by admin');
    await dana('POST', `/records/${other.id}/transition`, { action: 'submit' });
    expect((await s.api('POST', `/records/${other.id}/transition`, { action: 'approve' })).status).toBe('approved');
  });

  it('does not create a version when nothing changed', async () => {
    const rec = await newCr();
    const same = await dana('PUT', `/records/${rec.id}`, { title: rec.title, body: rec.body, fields: rec.fields });
    expect(same.version).toBe(1);
    const changed = await dana('PUT', `/records/${rec.id}`, { body: rec.body + '\nMore.\n' });
    expect(changed.version).toBe(2);
    expect((await vera('GET', `/records/${rec.id}/versions`)).length).toBe(2);
  });
});

describe('workflow: decision records', () => {
  it('propose, accept, supersede with a link, deprecate', async () => {
    const a = await dana('POST', '/records', { type: 'ADR', title: 'Use SQLite', fields: { deciders: 'Dana, Olivia', decisionDate: '2026-10-01' } });
    expect(a.actions.map((x: any) => x.action)).toEqual(['propose']);
    await dana('POST', `/records/${a.id}/transition`, { action: 'propose' });
    expect((await adam('POST', `/records/${a.id}/transition`, { action: 'accept' })).status).toBe('accepted');
    const b = await dana('POST', '/records', { type: 'ADR', title: 'Use PostgreSQL' });
    expect(await status(dana('POST', `/records/${a.id}/transition`, { action: 'supersede' }))).toBe(400);
    expect(await status(dana('POST', `/records/${a.id}/transition`, { action: 'supersede', supersededBy: a.id }))).toBe(400);
    const sup = await dana('POST', `/records/${a.id}/transition`, { action: 'supersede', supersededBy: b.number });
    expect(sup).toMatchObject({ status: 'superseded', supersededBy: { id: b.id, number: b.number } });
    expect(sup.links).toEqual([expect.objectContaining({ kind: 'record', targetId: b.id, note: 'superseded by', visible: true })]);
    expect((await vera('GET', `/records/${b.id}`)).backlinks).toEqual([expect.objectContaining({ kind: 'record', id: a.id, note: 'superseded by' })]);
    const c = await dana('POST', '/records', { type: 'DR', title: 'Weekly patch day' });
    await dana('POST', `/records/${c.id}/transition`, { action: 'propose' });
    await adam('POST', `/records/${c.id}/transition`, { action: 'accept' });
    expect((await dana('POST', `/records/${c.id}/transition`, { action: 'deprecate' })).status).toBe('deprecated');
  });
});

describe('links', () => {
  it('links records to internal items and external URLs, with backlinks', async () => {
    const rec = await newCr();
    const proc = await dana('POST', `/records/${rec.id}/links`, { kind: 'process', id: 'ih-health-check', note: 'affected' });
    expect(proc).toMatchObject({ kind: 'process', targetId: 'ih-health-check', visible: true, path: '/processes/ih-health-check' });
    expect(proc.label).toBeTruthy();
    const ext = await dana('POST', `/records/${rec.id}/links`, { url: 'https://cmdb.example.com/change/CHG0042', label: 'ServiceNow CHG0042' });
    expect(ext).toMatchObject({ kind: null, url: 'https://cmdb.example.com/change/CHG0042', label: 'ServiceNow CHG0042' });
    expect(await status(dana('POST', `/records/${rec.id}/links`, { url: 'javascript:alert(1)' }))).toBe(400);
    expect(await status(dana('POST', `/records/${rec.id}/links`, { url: 'ftp://example.com/x' }))).toBe(400);
    expect(await status(dana('POST', `/records/${rec.id}/links`, { kind: 'process', id: 'does-not-exist' }))).toBe(404);
    expect(await status(dana('POST', `/records/${rec.id}/links`, { kind: 'process', id: 'ih-health-check' }))).toBe(409);
    expect(await status(dana('POST', `/records/${rec.id}/links`, { kind: 'record', id: rec.id }))).toBe(400);
    expect(await status(dana('POST', `/records/${rec.id}/links`, { kind: 'credential', id: 'x' }))).toBe(400);
    // backlinks of any item
    expect((await vera('GET', '/backlinks?kind=process&id=ih-health-check')).some((b: any) => b.id === rec.id)).toBe(true);
    // picker
    const targets = await dana('GET', '/link-targets?kind=process&q=health');
    expect(targets.some((t: any) => t.id === 'ih-health-check')).toBe(true);
    // links can change after approval (they are navigation, not content)
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    const detail = await dana('GET', `/records/${rec.id}`);
    expect(detail.permissions.link).toBe(true);
    await dana('DELETE', `/records/${rec.id}/links/${ext.id}`);
    expect((await dana('GET', `/records/${rec.id}`)).links.map((l: any) => l.id)).toEqual([proc.id]);
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${rec.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['record.link_added', 'record.link_removed']));
  });

  it('never shows the name of a target the reader may not see', async () => {
    // a process restricted to admins
    const def = { name: 'Secret process', nodes: [{ id: 'start', type: 'start', x: 0, y: 0 }], wires: [] };
    const p = await s.api('POST', '/processes', { definition: def });
    await s.api('PUT', `/processes/${p.id}/access`, { acl: [{ subject: 'user:admin', permissions: ['view'] }] });
    const rec = await newCr();
    expect(await status(dana('POST', `/records/${rec.id}/links`, { kind: 'process', id: p.id }))).toBe(404);
    await s.api('POST', `/records/${rec.id}/links`, { kind: 'process', id: p.id });
    const seen = (await vera('GET', `/records/${rec.id}`)).links[0];
    expect(seen).toMatchObject({ kind: 'process', targetId: null, visible: false, label: '', path: null });
    expect(JSON.stringify(seen)).not.toContain('Secret process');
    expect((await s.api('GET', `/records/${rec.id}`)).links[0].label).toBe('Secret process');
  });
});

describe('attachments', () => {
  let rec: any;
  beforeAll(async () => {
    rec = await newCr();
  });
  it('stores files with their SHA-256 and includes them in the content hash', async () => {
    const before = (await dana('GET', `/records/${rec.id}`)).contentHash;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
    const res = await upload('dana', `/records/${rec.id}/attachments`, 'offer.pdf', pdf);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: 'file', filename: 'offer.pdf', mime: 'application/pdf', size: pdf.length, sha256: sha(pdf) });
    const after = await dana('GET', `/records/${rec.id}`);
    expect(after.contentHash).not.toBe(before);
    const eml = 'From: Max <max@example.com>\r\nTo: team@example.com\r\nSubject: Approval\r\nDate: Thu, 22 Oct 2026 10:00:00 +0200\r\n\r\nOK from my side.\r\n';
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'approval.eml', eml)).body).toMatchObject({ mime: 'message/rfc822' });
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'mail.msg', ole)).body).toMatchObject({ mime: 'application/vnd.ms-outlook' });
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'plan.docx', zip)).status).toBe(200);
    // download: always an attachment, sandboxed, the original bytes
    const dl = await download('vera', `/records/${rec.id}/attachments/${res.body.id}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="offer.pdf"/);
    expect(dl.headers.get('content-security-policy')).toContain('sandbox');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(sha(dl.body)).toBe(sha(pdf));
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${rec.id}&action=record.attachment_added`);
    expect(audit.find((a: any) => a.details.filename === 'offer.pdf').details.sha256).toBe(sha(pdf));
  });
  it('checks the content against the extension', async () => {
    const fake = await upload('dana', `/records/${rec.id}/attachments`, 'invoice.pdf', '<html><script>alert(1)</script></html>');
    expect(fake.status).toBe(415);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'tool.exe', Buffer.from('MZ\x90\x00'))).status).toBe(415);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'page.html', '<p>x</p>')).status).toBe(415);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'mail.eml', 'just some text')).status).toBe(415);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'notes.txt', Buffer.from([0x41, 0x00, 0x42]))).status).toBe(415);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'image.png', 'not a png')).status).toBe(415);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'empty.txt', '')).status).toBe(400);
  });
  it('sanitizes file names and limits the size', async () => {
    const res = await upload('dana', `/records/${rec.id}/attachments`, '../../etc/pa:ss|wd.txt', 'x');
    expect(res.status).toBe(200);
    expect(res.body.filename).toBe('pa_ss_wd.txt');
    const big = Buffer.alloc(20 * 1024 * 1024 + 10, 0x41);
    expect((await upload('dana', `/records/${rec.id}/attachments`, 'big.txt', big)).status).toBe(413);
  });
  it('removes files from drafts only; generated PDFs stay', async () => {
    const res = await upload('dana', `/records/${rec.id}/attachments`, 'remove-me.txt', 'bye');
    expect(await status(vera('DELETE', `/records/${rec.id}/attachments/${res.body.id}`))).toBe(403);
    await dana('DELETE', `/records/${rec.id}/attachments/${res.body.id}`);
    expect((await dana('GET', `/records/${rec.id}`)).attachments.some((a: any) => a.id === res.body.id)).toBe(false);
    const pdf = await dana('POST', `/records/${rec.id}/pdf`, {});
    expect(await status(dana('DELETE', `/records/${rec.id}/attachments/${pdf.id}`))).toBe(409);
  });
});

describe('Markdown import and export', () => {
  const MADR = `---
status: accepted
date: 2024-05-14
deciders: [Dana Designer, Olivia Operator]
consulted: Security team
informed: everyone
tags: [database]
---

# Use PostgreSQL for the shared instance

## Context and Problem Statement

We need a database that several app instances can share.

## Considered Options

* SQLite
* PostgreSQL

## Decision Outcome

Chosen option: "PostgreSQL", because it supports concurrent writers.
`;
  const NYGARD = `# 1. Record architecture decisions

Date: 2024-02-01

## Status

Accepted

## Context

We need to record the architectural decisions made on this project.

## Decision

We will use Architecture Decision Records, as described by Michael Nygard.

## Consequences

See Michael Nygard's article.
`;
  const MADR2 = `# Use Markdown Architectural Decision Records

* Status: proposed
* Deciders: Dana
* Date: 2018-09-18

Technical Story: none

## Context and Problem Statement

We want to record decisions.
`;

  it('previews without creating anything', async () => {
    const before = (await vera('GET', '/records?type=ADR')).length;
    const items = await dana('POST', '/records/import', { dryRun: true, files: [{ filename: 'madr.md', content: MADR }] });
    expect(items[0]).toMatchObject({
      ok: true,
      title: 'Use PostgreSQL for the shared instance',
      typeKey: 'ADR',
      status: 'draft',
      originalStatus: 'accepted',
      format: 'madr',
    });
    expect(items[0].record).toBeUndefined();
    expect((await vera('GET', '/records?type=ADR')).length).toBe(before);
  });

  it('imports MADR, Nygard and MADR 2 files in one go', async () => {
    const items = await dana('POST', '/records/import', {
      files: [
        { filename: '0002-use-postgresql.md', content: MADR },
        { filename: '0001-record-architecture-decisions.md', content: NYGARD },
        { filename: 'madr2.md', content: MADR2 },
      ],
    });
    expect(items.map((i: any) => i.ok)).toEqual([true, true, true]);
    const madr = await vera('GET', `/records/${items[0].record.id}`);
    expect(madr).toMatchObject({ typeKey: 'ADR', status: 'draft', title: 'Use PostgreSQL for the shared instance' });
    expect(madr.fields).toEqual({ decisionDate: '2024-05-14', deciders: 'Dana Designer, Olivia Operator', consulted: 'Security team', informed: 'everyone' });
    expect(madr.tags).toEqual(['database', 'status:accepted']);
    expect(madr.importMeta).toMatchObject({ filename: '0002-use-postgresql.md', format: 'madr', originalStatus: 'accepted' });
    expect(madr.body.startsWith('## Context and Problem Statement')).toBe(true);
    expect(madr.events[0]).toMatchObject({ kind: 'imported' });

    const ny = await vera('GET', `/records/${items[1].record.id}`);
    expect(ny).toMatchObject({ title: 'Record architecture decisions', status: 'draft' });
    expect(ny.fields.decisionDate).toBe('2024-02-01');
    expect(ny.importMeta).toMatchObject({ format: 'nygard', adrNumber: 1, originalStatus: 'Accepted' });
    expect(ny.body).not.toMatch(/## Status/);
    expect(ny.body).not.toMatch(/^Date:/m);
    expect(ny.body).toContain('## Decision');

    const m2 = await vera('GET', `/records/${items[2].record.id}`);
    expect(m2).toMatchObject({ title: 'Use Markdown Architectural Decision Records' });
    expect(m2.fields).toMatchObject({ deciders: 'Dana', decisionDate: '2018-09-18' });
    expect(m2.tags).toContain('status:proposed');
    expect(m2.body).not.toContain('* Status');
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${madr.id}&action=record.imported`);
    expect(audit).toHaveLength(1);
  });

  it('maps frontmatter onto the fields of the type it names', async () => {
    const md = `---\ntitle: Upgrade the broker\ntype: CR\nstatus: draft\nrisk: High\nreason: End of support\nrollbackPlan: Downgrade\nplannedStart: 2026-12-01T20:00\nticket: CHG0099\n---\nSteps follow.\n`;
    const [item] = await dana('POST', '/records/import', { type: 'ADR', files: [{ filename: 'cr.md', content: md }] });
    expect(item).toMatchObject({
      ok: true,
      typeKey: 'CR',
      title: 'Upgrade the broker',
      originalStatus: null,
      fields: { risk: 'high', reason: 'End of support', rollbackPlan: 'Downgrade', plannedStart: '2026-12-01T20:00' },
    });
    const rec = await vera('GET', `/records/${item.record.id}`);
    expect(rec.tags).toEqual([]);
    expect(rec.importMeta.values).toEqual({ ticket: 'CHG0099' });
    expect(rec.body).toBe('Steps follow.\n');
  });

  it('reports bad files per file and enforces limits', async () => {
    const items = await dana('POST', '/records/import', {
      type: 'DR',
      files: [
        { filename: 'bad-yaml.md', content: '---\ntitle: [unclosed\n---\n# x\n' },
        { filename: 'custom-tag.md', content: '---\ntitle: !!js/function "function () { return 1 }"\n---\n# x\n' },
        { filename: 'unclosed.md', content: '---\ntitle: x\n# no end\n' },
        { filename: 'huge.md', content: '# Huge\n' + 'x'.repeat(300 * 1024) },
        { filename: 'tool.sh', content: '#!/bin/sh\n' },
        { filename: 'unknown-type.md', content: '---\ntype: NOPE\n---\n# x\n' },
        {
          filename: 'alias-bomb.md',
          content:
            '---\na: &a [x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c, *c, *c, *c, *c]\n---\n# x\n',
        },
        { filename: 'fine.md', content: '# Just a decision\n\nText.\n' },
      ],
    });
    const byName = Object.fromEntries(items.map((i: any) => [i.filename, i]));
    expect(byName['bad-yaml.md']).toMatchObject({ ok: false, error: expect.stringContaining('Invalid YAML') });
    expect(byName['custom-tag.md']).toMatchObject({ ok: false, error: expect.stringContaining('custom tags') });
    expect(byName['unclosed.md']).toMatchObject({ ok: false, error: expect.stringContaining('not closed') });
    expect(byName['huge.md']).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    expect(byName['tool.sh']).toMatchObject({ ok: false, error: expect.stringContaining('Markdown') });
    expect(byName['unknown-type.md']).toMatchObject({ ok: false, error: expect.stringContaining('NOPE') });
    expect(byName['alias-bomb.md'].ok).toBe(false);
    expect(byName['fine.md']).toMatchObject({ ok: true, typeKey: 'DR', title: 'Just a decision' });
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ filename: `${i}.md`, content: '# x' }));
    expect(await status(dana('POST', '/records/import', { files: tooMany }))).toBe(400);
    // without a type in the file or the request, plain Markdown cannot be placed
    const [plain] = await dana('POST', '/records/import', { files: [{ filename: 'p.md', content: 'Some text' }] });
    expect(plain).toMatchObject({ ok: false, error: expect.stringContaining('record type') });
  });

  it('exports Markdown with frontmatter that imports again (round trip)', async () => {
    const rec = await newCr(dana, 'Round trip: "quotes" & colons: yes');
    await dana('PUT', `/records/${rec.id}`, { tags: ['roundtrip'], body: '## Description\n\n- one\n- two\n\n```sh\necho hi\n```\n' });
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    const dl = await download('vera', `/records/${rec.id}/export`);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toContain('text/markdown');
    expect(dl.headers.get('content-disposition')).toContain(`${rec.number}.md`);
    const text = dl.body.toString('utf8');
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain(`number: ${rec.number}`);
    expect(text).toContain('contentHash:');
    const [item] = await dana('POST', '/records/import', { files: [{ filename: `${rec.number}.md`, content: text }] });
    expect(item).toMatchObject({ ok: true, format: 'steward', typeKey: 'CR', originalStatus: 'submitted' });
    const copy = await vera('GET', `/records/${item.record.id}`);
    const orig = await vera('GET', `/records/${rec.id}`);
    expect(copy.title).toBe(orig.title);
    expect(copy.body.trim()).toBe(orig.body.trim());
    expect(copy.fields).toEqual(orig.fields);
    expect(copy.tags).toEqual(['roundtrip', 'status:submitted']);
    expect(copy.importMeta).toMatchObject({ 'steward.number': rec.number, originalNumber: rec.number });
  });
});

describe('PDF', () => {
  let rec: any;
  let att: any;
  let pdf: Buffer;
  beforeAll(async () => {
    rec = await newCr(dana, 'Replace the core switch');
    await dana('PUT', `/records/${rec.id}`, {
      body: '## Description\n\nReplace switch **SW-01**.\n\n| Step | Owner |\n| --- | --- |\n| Prepare | Dana |\n| Swap | Olivia |\n\n```\nconfigure terminal\n```\n\n1. First\n2. Second\n   - nested\n\n> Note: <script>alert(1)</script>\n',
    });
    await upload('dana', `/records/${rec.id}/attachments`, 'quote.txt', 'quote');
    await dana('POST', `/records/${rec.id}/links`, { url: 'https://cmdb.example.com/ci/SW-01', label: 'CMDB SW-01' });
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    await adam('POST', `/records/${rec.id}/transition`, { action: 'approve', comment: 'Go ahead' });
  });

  it('generates a PDF/A-2b document with empty signature fields for the signers', async () => {
    att = await adam('POST', `/records/${rec.id}/pdf`, {
      lang: 'en',
      signers: [
        { name: 'Erika Mustermann', role: 'Business owner', email: 'erika@example.com' },
        { name: 'Max Requester', role: 'Requester' },
      ],
    });
    expect(att).toMatchObject({ kind: 'generated', mime: 'application/pdf' });
    expect(att.details).toMatchObject({ lang: 'en', status: 'approved', revision: 1, signers: [{ name: 'Erika Mustermann' }, { name: 'Max Requester' }] });
    const dl = await download('vera', `/records/${rec.id}/attachments/${att.id}/download`);
    pdf = dl.body;
    keep('record-cr-en.pdf', pdf);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(sha(pdf)).toBe(att.sha256);
    expect(pdf.subarray(0, 8).toString('latin1')).toBe('%PDF-1.7');
    const raw = pdf.toString('latin1');
    expect(raw.match(/\/FT \/Sig/g)).toHaveLength(2);
    expect(raw).toContain('/T (Signature_1_Business_owner)');
    expect(raw).toContain('/T (Signature_2_Requester)');
    expect(raw).toContain('/SigFlags 1');
    expect(raw).not.toContain('/NeedAppearances');
    expect(raw).toContain('/OutputIntents');
    expect(raw).not.toMatch(/\/BaseFont \/(Helvetica|Times|Courier)/);
    const t = pdf.toString('utf8');
    const meta = t.slice(t.indexOf('<x:xmpmeta'), t.indexOf('</x:xmpmeta>'));
    expect(meta).toContain('<pdfaid:part>2</pdfaid:part>');
    expect(meta).toContain('<pdfaid:conformance>B</pdfaid:conformance>');
    expect(meta).toContain(`<stw:recordNumber>${rec.number}</stw:recordNumber>`);
    const approved = await vera('GET', `/records/${rec.id}`);
    expect(meta).toContain(`<stw:contentHash>${approved.frozenHash}</stw:contentHash>`);
    const audit = (await s.api('GET', `/audit?entityType=record&entityId=${rec.id}&action=record.pdf_generated`))[0];
    expect(audit.details).toMatchObject({ sha256: att.sha256, size: pdf.length, pdfId: att.id });
  });

  it('contains the content, history and signature blocks', async () => {
    const { generateRecordPdf } = await import('../src/records/pdf.js');
    const { runAs } = await import('../src/auth/context.js');
    const r = await runAs({ id: 'u', username: 'adam', displayName: 'Adam Approver', roles: ['approver'], teams: [] }, () =>
      generateRecordPdf(rec.id, { lang: 'de', signers: [{ name: 'Erika Mustermann', role: 'Fachverantwortliche' }] }),
    );
    keep('record-cr-de.pdf', (await download('adam', `/records/${rec.id}/attachments/${r.id}/download`)).body);
    const text = r.texts.join('\n');
    for (const fact of [
      rec.number,
      'Replace the core switch',
      'SW-01',
      'configure terminal',
      'nested',
      'quote.txt',
      'CMDB SW-01',
      'Go ahead',
      'Unterschriften',
      'Erika Mustermann',
      'Freigegeben',
      '<script>alert(1)</script>',
    ]) {
      expect(text, fact).toContain(fact);
    }
    if (hasTool('pdftotext')) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-pdf-'));
      fs.writeFileSync(path.join(dir, 'r.pdf'), pdf);
      const out = spawnSync('pdftotext', ['-layout', path.join(dir, 'r.pdf'), '-'], { encoding: 'utf8' }).stdout;
      expect(out).toContain('Replace the core switch');
      expect(out).toContain('Erika Mustermann');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks a draft as such', async () => {
    const draft = await newCr();
    const a = await dana('POST', `/records/${draft.id}/pdf`, { signers: [] });
    const dl = await download('dana', `/records/${draft.id}/attachments/${a.id}/download`);
    expect(dl.body.toString('latin1')).not.toContain('/FT /Sig');
    expect(dl.body.toString('utf8')).toContain('<stw:contentFrozen>false</stw:contentFrozen>');
    expect(await status(dana('POST', `/records/${draft.id}/pdf`, { signers: [{ name: '' }] }))).toBe(400);
    expect(await status(dana('POST', `/records/${draft.id}/pdf`, { signers: Array.from({ length: 9 }, () => ({ name: 'x' })) }))).toBe(400);
  });

  it('passes veraPDF (PDF/A-2b) when SM_VERAPDF is set', async () => {
    const cmd = process.env.SM_VERAPDF; // e.g. "java -cp '/opt/verapdf/lib/*' org.verapdf.apps.GreenfieldCliWrapper"
    if (!cmd) return;
    const dir = path.join(s.dataDir, 'records', rec.id);
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.pdf'))
      .map((f) => path.join(dir, f));
    const out = spawnSync(`${cmd} --flavour 2b --format text ${files.map((f) => `'${f}'`).join(' ')}`, { shell: true, encoding: 'utf8' });
    expect(out.stdout).not.toContain('FAIL');
    expect(out.stdout.match(/^PASS /gm)?.length).toBe(files.length);
  });

  describe('signed upload', () => {
    it('accepts a signed copy (incremental update with a signature dictionary)', async () => {
      const signed = signLike(pdf);
      const res = await upload('dana', `/records/${rec.id}/signed`, 'signed.pdf', signed);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: 'signed', sha256: sha(signed), size: signed.length });
      expect(res.body.details).toMatchObject({ derivedFrom: att.id, originalSha256: att.sha256, originalSize: pdf.length, validation: 'structure' });
      expect(res.body.details.signatures).toEqual([
        {
          name: 'Erika Mustermann',
          signedAt: '2026-10-22T08:15:00.000Z',
          reason: 'Approved (as business owner)',
          location: 'München',
          subFilter: 'adbe.pkcs7.detached',
          field: 'Signature_1_Business_owner',
          byteRangeOk: true,
        },
      ]);
      const audit = (await s.api('GET', `/audit?entityType=record&entityId=${rec.id}&action=record.signed_pdf_uploaded`))[0];
      expect(audit.summary).toContain('not cryptographically validated');
      expect(audit.details.sha256).toBe(sha(signed));
      // stored and downloadable unchanged
      const dl = await download('vera', `/records/${rec.id}/attachments/${res.body.id}/download`);
      expect(sha(dl.body)).toBe(sha(signed));
      expect(await upload('dana', `/records/${rec.id}/signed`, 'again.pdf', signed).then((r) => r.status)).toBe(409);
      // a second signature on top of the first
      const twice = signLike(signed, { name: 'Max Requester', field: 'Signature_2_Requester' });
      const res2 = await upload('adam', `/records/${rec.id}/signed`, 'signed-twice.pdf', twice);
      expect(res2.status).toBe(200);
      expect(res2.body.details.signatures.map((x: any) => x.name)).toEqual(['Erika Mustermann', 'Max Requester']);
    });

    it('accepts a PDF really signed with poppler pdfsig (when pdfsig, certutil and openssl are installed)', async () => {
      if (!['pdfsig', 'certutil', 'pk12util', 'openssl'].every((b) => spawnSync('which', [b], { stdio: 'ignore' }).status === 0)) return;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-sign-'));
      const run = (cmd: string, args: string[]) => {
        const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
      };
      try {
        fs.mkdirSync(path.join(dir, 'nss'));
        run('certutil', ['-N', '-d', 'sql:nss', '--empty-password']);
        run('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          'key.pem',
          '-out',
          'cert.pem',
          '-days',
          '2',
          '-subj',
          '/CN=Erika Mustermann',
        ]);
        run('openssl', ['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-out', 'id.p12', '-passout', 'pass:x', '-name', 'erika']);
        run('pk12util', ['-i', 'id.p12', '-d', 'sql:nss', '-W', 'x']);
        fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
        run('pdfsig', ['-nssdir', 'sql:nss', '-sign', 'Signature_2_Requester', '-nick', 'erika', '-reason', 'Requested', 'in.pdf', 'out.pdf']);
        const res = await upload('dana', `/records/${rec.id}/signed`, 'pdfsig.pdf', fs.readFileSync(path.join(dir, 'out.pdf')));
        expect(res.status).toBe(200);
        expect(res.body.details.signatures).toEqual([
          expect.objectContaining({
            name: 'Erika Mustermann',
            field: 'Signature_2_Requester',
            reason: 'Requested',
            subFilter: 'adbe.pkcs7.detached',
            byteRangeOk: true,
          }),
        ]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('rejects files that are not derived from a generated PDF of the record', async () => {
      // the unsigned file itself
      expect((await upload('dana', `/records/${rec.id}/signed`, 'same.pdf', pdf)).body.error).toContain('sign it first');
      // a PDF generated for another record
      const other = await newCr();
      const otherPdf = await dana('POST', `/records/${other.id}/pdf`, { signers: [{ name: 'X' }] });
      const otherBytes = (await download('dana', `/records/${other.id}/attachments/${otherPdf.id}/download`)).body;
      const foreign = await upload('dana', `/records/${rec.id}/signed`, 'foreign.pdf', signLike(otherBytes));
      expect(foreign.status).toBe(422);
      expect(foreign.body.code).toBe('PDF_NOT_DERIVED');
      // a modified original (one byte changed) signed afterwards
      const tampered = Buffer.from(pdf);
      tampered[2000] = tampered[2000]! ^ 1;
      expect((await upload('dana', `/records/${rec.id}/signed`, 'tampered.pdf', signLike(tampered))).body.code).toBe('PDF_NOT_DERIVED');
      // an update without a signature
      const noSig = Buffer.concat([pdf, Buffer.from('\n102 0 obj\n<< /FT /Tx /V (filled) >>\nendobj\n%%EOF\n')]);
      expect((await upload('dana', `/records/${rec.id}/signed`, 'nosig.pdf', noSig)).body.code).toBe('PDF_NO_SIGNATURE');
      // not a PDF at all
      expect((await upload('dana', `/records/${rec.id}/signed`, 'x.pdf', 'hello')).status).toBe(422);
      // viewers cannot upload
      expect((await upload('vera', `/records/${rec.id}/signed`, 'signed.pdf', signLike(pdf, { name: 'V' }))).status).toBe(403);
    });

    it('lets administrators attach an unverified PDF explicitly', async () => {
      const scan = Buffer.from('%PDF-1.4\n% scanned paper signature\n%%EOF\n');
      expect((await upload('dana', `/records/${rec.id}/signed?plain=1`, 'scan.pdf', scan)).status).toBe(403);
      const res = await upload('admin', `/records/${rec.id}/signed?plain=1`, 'scan.pdf', scan);
      expect(res.status).toBe(200);
      expect(res.body.details).toMatchObject({ plain: true, validation: 'none' });
      const audit = (await s.api('GET', `/audit?entityType=record&entityId=${rec.id}&action=record.unverified_pdf_attached`))[0];
      expect(audit.actor).toBe('admin');
    });
  });
});

describe('integrity', () => {
  it('refuses to approve frozen content that was changed in the database', async () => {
    const rec = await newCr();
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    const { db } = await import('../src/db.js');
    db().run('UPDATE records SET body = ? WHERE id = ?', 'tampered', rec.id);
    const seen = await adam('GET', `/records/${rec.id}`);
    expect(seen.contentHash).not.toBe(seen.frozenHash);
    const e = await errorOf(adam('POST', `/records/${rec.id}/transition`, { action: 'approve' }));
    expect(e.status).toBe(409);
    expect(e.text).toContain('RECORD_TAMPERED');
  });
});

describe('list filters', () => {
  it('filters by type, status, tag and text', async () => {
    const a = await newCr(dana, 'Filter needle alpha');
    await dana('PUT', `/records/${a.id}`, { tags: ['needle-tag'] });
    await dana('POST', `/records/${a.id}/transition`, { action: 'submit' });
    const list = await vera('GET', '/records?type=CR&status=submitted&tag=needle-tag&q=NEEDLE');
    expect(list.map((r: any) => r.id)).toEqual([a.id]);
    expect(await vera('GET', '/records?type=ADR&q=needle alpha')).toEqual([]);
    expect(await status(vera('GET', '/records?status=bogus'))).toBe(400);
    expect((await vera('GET', '/records?q=%25')).length).toBe(0); // LIKE wildcards are literal
  });
});

describe('Markdown parser', () => {
  it('produces a tree without HTML and keeps only safe links', () => {
    const blocks = parseMarkdown(
      '# Title\n\nText with <b>html</b> and [ok](https://example.com) and [bad](javascript:alert(1)).\n\n- [x] done\n- [ ] open\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n',
    );
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'paragraph', 'list', 'table']);
    const para = blocks[1] as any;
    expect(inlineText(para.c)).toBe('Text with <b>html</b> and ok and bad.');
    expect(para.c.filter((n: any) => n.t === 'link').map((n: any) => n.href)).toEqual(['https://example.com']);
    expect((blocks[2] as any).items.map((i: any) => i.checked)).toEqual([true, false]);
    expect((blocks[3] as any).align).toEqual([null, 'right']);
  });
});

describe('public API v1', () => {
  async function v1(token: string | null, url: string) {
    const res = await fetch(s.base + '/api/v1' + url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  }
  it('lists records, gets one and its versions (read-only, with a token)', async () => {
    const token = (await vera('POST', '/me/tokens', { name: 'records-api', scope: 'read' })).token;
    const rec = await newCr(dana, 'API visible change');
    await dana('PUT', `/records/${rec.id}`, { body: 'v2\n' });
    expect((await v1(null, '/records')).status).toBe(401);
    const list = await v1(token, '/records?type=CR&limit=2');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.nextCursor).toBeTruthy();
    expect(list.headers.get('link')).toContain('rel="next"');
    const next = await v1(token, `/records?type=CR&limit=2&cursor=${encodeURIComponent(list.body.nextCursor)}`);
    expect(next.body.items[0].number > list.body.items[1].number).toBe(true);
    const found = await v1(token, `/records?q=${encodeURIComponent('API visible')}`);
    expect(found.body.items.map((r: any) => r.id)).toEqual([rec.id]);
    expect(Object.keys(found.body.items[0]).sort()).toEqual([
      'createdAt',
      'createdBy',
      'id',
      'number',
      'owner',
      'revision',
      'status',
      'tags',
      'title',
      'typeKey',
      'typeName',
      'updatedAt',
      'updatedBy',
      'version',
      'workflow',
    ]);
    const one = await v1(token, `/records/${rec.number}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ id: rec.id, body: 'v2\n', frozen: false, frozenHash: null });
    expect(one.body).not.toHaveProperty('permissions');
    expect(one.body).not.toHaveProperty('actions');
    const versions = await v1(token, `/records/${rec.id}/versions`);
    expect(versions.body.items.map((v: any) => v.version)).toEqual([2, 1]);
    expect((await v1(token, '/records/rec_nope')).status).toBe(404);
    expect((await v1(token, '/records/rec_nope/versions')).status).toBe(404);
    const post = await fetch(s.base + '/api/v1/records', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(post.status).toBe(405);
  });
  it('documents the endpoints in the OpenAPI description', async () => {
    const token = (await vera('POST', '/me/tokens', { name: 'records-api-doc', scope: 'read' })).token;
    const doc = (await v1(token, '/openapi.json')).body;
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/records', '/records/{recordId}', '/records/{recordId}/versions']));
    expect(doc.components.schemas.RecordDetail).toBeTruthy();
  });
});

describe('web texts', () => {
  it('cover every status, action, link kind and built-in type', () => {
    const load = (lang: string) => JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../web/src/locales/${lang}/records.json`), 'utf8'));
    const en = load('en');
    for (const st of RECORD_STATUSES) expect(en.status[st], st).toBeTypeOf('string');
    for (const a of RECORD_ACTIONS) expect(en.actions[a], a).toBeTypeOf('string');
    for (const k of LINK_KINDS) expect(en.links.kinds[k], k).toBeTypeOf('string');
    for (const t of DEFAULT_RECORD_TYPES) expect(en.builtinTypes[t.key], t.key).toBe(t.name);
  });
});

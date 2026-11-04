import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { isCidr, isHostName, isIpAddress, isIpv6, isNetworkAddress, FIREWALL_RULES_TYPE_ID, FIREWALL_TYPE_ID, TABLE_LIMITS, tableRows } from '@sm/shared';

/**
 * Audit-proof firewall changes (#208): network segments (systems of kind "network") and their attributes, systems in
 * segments with an address, systems as a link kind (and who sees those links), the table field kind, the record type
 * "Firewall change" through approval, implementation, evidence, verification and closing, and the "Approved firewall
 * rules" documents that closing a change drafts and an approver confirms.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, adam: Client, vera: Client, tara: Client, vic: Client;
const cookies: Record<string, string> = {};
const errOf = (p: Promise<unknown>) =>
  p.then(
    () => ({ status: 200, code: null as string | null }),
    (e: { status: number; body: unknown }) => ({
      status: e.status,
      code: ((typeof e.body === 'string' ? safeJson(e.body) : e.body) as { code?: string } | null)?.code ?? null,
    }),
  );
const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const auditOf = (type: string, id: string) => s.api('GET', `/audit?entityType=${type}&entityId=${id}&limit=100`);

async function upload(user: string, url: string, filename: string, data: string): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append('file', new Blob([data]), filename);
  const res = await fetch(s.base + '/api' + url, { method: 'POST', headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const RULE = (over: Record<string, string> = {}) => ({
  change: 'add',
  source: '10.20.30.0/24',
  destination: 'srv-mes01',
  service: 'tcp/443',
  action: 'allow',
  enforcedAt: 'perimeter',
  purpose: 'MES clients to the MES server',
  expiry: '',
  ...over,
});
const FWC_FIELDS = (rules: Record<string, string>[]) => ({
  reason: 'New MES release needs HTTPS from the shopfloor',
  risk: 'low',
  implementer: 'provider',
  provider: 'NetOps GmbH',
  providerTicket: 'CHG-4711',
  rules: JSON.stringify(rules),
});

let segment: any, server: any;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'tara', roles: ['designer'], password: PW, mustChangePassword: false });
  users.createUser({ username: 'vic', roles: ['viewer'], password: PW, mustChangePassword: false });
  [dana, olivia, adam, vera, tara, vic] = await Promise.all(['dana', 'olivia', 'adam', 'vera', 'tara', 'vic'].map((u) => s.as(u, PW)));
  for (const u of ['dana', 'olivia', 'adam']) cookies[u] = await loginCookie(s.base, u, PW);
});

afterAll(async () => {
  await s?.app.close();
});

describe('format checks', () => {
  it('know CIDR subnets, IP addresses and host names (no lookups)', () => {
    for (const ok of ['10.20.30.0/24', '0.0.0.0/0', '192.168.1.7/32', '2001:db8::/48', '::/0', 'fe80::1/128', '::ffff:10.0.0.1/128'])
      expect(isCidr(ok), ok).toBe(true);
    for (const bad of ['10.20.30.0', '10.20.30.0/33', '256.1.1.1/24', '2001:db8::/129', '10.0.0.0/024', 'abc/24', '2001:db8:::/48', '10.0.0.0/ 24'])
      expect(isCidr(bad), bad).toBe(false);
    expect(isIpv6('2001:0db8:0000:0000:0000:ff00:0042:8329')).toBe(true);
    expect(isIpv6('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(isIpAddress('10.0.0.1')).toBe(true);
    expect(isHostName('srv-mes01.plant.example.com')).toBe(true);
    expect(isHostName('-bad.example.com')).toBe(false);
    expect(isHostName('10.0.0.300')).toBe(false);
    expect(isNetworkAddress('srv_mes01')).toBe(false);
  });
});

describe('network segments', () => {
  it('are systems of kind "network" with attributes checked by kind', async () => {
    const bad = (attributes: unknown) => errOf(dana('POST', '/systems', { name: 'Bad segment', kind: 'network', attributes }));
    expect(await bad({ vlanId: 4095 })).toMatchObject({ status: 400, code: 'SYSTEM_ATTRIBUTE_INVALID' });
    expect(await bad({ subnets: ['10.20.30.0'] })).toMatchObject({ status: 400, code: 'SYSTEM_ATTRIBUTE_INVALID' });
    expect(await bad({ firewallManagedBy: 'somebody' })).toMatchObject({ status: 400, code: 'SYSTEM_ATTRIBUTE_INVALID' });
    expect(await bad({ unknown: 1 })).toMatchObject({ status: 400, code: 'SYSTEM_ATTRIBUTE_INVALID' });
    // other kinds have no attributes
    expect(await errOf(dana('POST', '/systems', { name: 'srv-x', kind: 'server', attributes: { vlanId: 10 } }))).toMatchObject({
      status: 400,
      code: 'SYSTEM_ATTRIBUTES_KIND',
    });
    segment = await dana('POST', '/systems', {
      name: 'Shopfloor IoT – Hall 3',
      kind: 'network',
      vendor: 'Plant network',
      attributes: {
        vlanId: 310,
        subnets: ['10.20.30.0/24', '2001:db8:30::/48', '10.20.30.0/24'],
        zone: 'IEC 62443 zone 2 – cell',
        site: 'Hall 3',
        firewallManagedBy: 'team',
        firewallProvider: 'ignored unless a provider',
      },
    });
    expect(segment.attributes).toEqual({
      vlanId: 310,
      subnets: ['10.20.30.0/24', '2001:db8:30::/48'],
      zone: 'IEC 62443 zone 2 – cell',
      site: 'Hall 3',
      firewallManagedBy: 'team',
      firewallProvider: '',
    });
    // a change without attributes keeps them; a change of the attributes is audited with old and new values
    const same = await dana('PUT', `/systems/${segment.id}`, { name: segment.name, kind: 'network', vendor: 'Plant network' });
    expect(same.attributes.vlanId).toBe(310);
    const changed = await dana('PUT', `/systems/${segment.id}`, {
      name: segment.name,
      kind: 'network',
      vendor: 'Plant network',
      attributes: { ...segment.attributes, vlanId: 311, firewallManagedBy: 'provider', firewallProvider: 'NetOps GmbH' },
    });
    expect(changed.attributes).toMatchObject({ vlanId: 311, firewallManagedBy: 'provider', firewallProvider: 'NetOps GmbH' });
    const entry = (await auditOf('system', segment.id)).find((e: any) => e.action === 'system.changed');
    expect(entry.details.attributes).toMatchObject({
      changed: ['firewallManagedBy', 'firewallProvider', 'vlanId'],
      old: { vlanId: 310, firewallManagedBy: 'team' },
      new: { vlanId: 311, firewallManagedBy: 'provider', firewallProvider: 'NetOps GmbH' },
    });
    segment = changed;
    // other systems show no attributes; the public API lists them
    const plain = await dana('POST', '/systems', { name: 'srv-plain', kind: 'server' });
    expect(plain.attributes).toEqual({});
    const token = (await vera('POST', '/me/tokens', { name: 'segments', scope: 'read' })).token;
    const v1 = await (await fetch(`${s.base}/api/v1/systems/${segment.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(v1.attributes.subnets).toEqual(['10.20.30.0/24', '2001:db8:30::/48']);
    expect(v1).not.toHaveProperty('firewall');
  });

  it('take systems with an address; who may change the system decides', async () => {
    server = await dana('POST', '/systems', { name: 'srv-mes01', kind: 'server', vendor: 'NetOps GmbH (managed)', owners: ['user:olivia'] });
    const add = (c: Client, body: unknown) => errOf(c(`POST`, `/systems/${server.id}/segments`, body));
    expect(await add(vera, { segmentId: segment.id })).toMatchObject({ status: 403 });
    expect(await add(dana, { segmentId: segment.id, address: 'not an address!' })).toMatchObject({ status: 400 });
    const other = await dana('POST', '/systems', { name: 'srv-other', kind: 'server' });
    expect(await add(dana, { segmentId: other.id })).toMatchObject({ status: 400, code: 'NOT_A_SEGMENT' });
    expect(await errOf(dana('POST', `/systems/${segment.id}/segments`, { segmentId: segment.id }))).toMatchObject({ code: 'SEGMENT_SELF' });
    // the system's owner (an operator) adds it
    const list = await olivia('POST', `/systems/${server.id}/segments`, { segmentId: segment.id, address: '10.20.30.15', note: 'MES server' });
    expect(list).toMatchObject([{ segmentId: segment.id, segmentName: segment.name, address: '10.20.30.15', vlanId: 311, zone: 'IEC 62443 zone 2 – cell' }]);
    expect(await add(dana, { segmentId: segment.id })).toMatchObject({ status: 409, code: 'SEGMENT_LINK_EXISTS' });
    const changed = await olivia('PUT', `/systems/${server.id}/segments/${list[0].id}`, { address: 'srv-mes01.hall3.example.com', note: 'MES server' });
    expect(changed[0].address).toBe('srv-mes01.hall3.example.com');
    expect((await dana('GET', `/systems/${segment.id}`)).members).toMatchObject([{ systemId: server.id, address: 'srv-mes01.hall3.example.com' }]);
    expect((await auditOf('system', server.id)).map((e: any) => e.action)).toEqual(expect.arrayContaining(['system.segment_added', 'system.segment_changed']));
    // a segment with systems in it is neither deleted nor turned into another kind
    expect(await errOf(dana('DELETE', `/systems/${segment.id}`))).toMatchObject({ status: 409, code: 'SEGMENT_IN_USE' });
    expect(await errOf(dana('PUT', `/systems/${segment.id}`, { name: segment.name, kind: 'server' }))).toMatchObject({ code: 'SEGMENT_IN_USE' });
  });

  it('are duplicated with their attributes; a copied system is in the same segments without addresses', async () => {
    const seg = await dana('POST', `/systems/${segment.id}/duplicate`, { name: 'Shopfloor IoT – Hall 4' });
    const copy = await dana('GET', `/systems/${seg.id}`);
    expect(copy.attributes).toEqual(segment.attributes);
    expect(copy.members).toEqual([]);
    const srv = await dana('POST', `/systems/${server.id}/duplicate`, { name: 'srv-mes02' });
    const srvCopy = await dana('GET', `/systems/${srv.id}`);
    expect(srvCopy.segments).toMatchObject([{ segmentId: segment.id, address: '', note: 'MES server' }]);
    expect(srvCopy.attributes).toEqual({});
    expect(srvCopy.owners).toEqual([]);
    // the original keeps its address
    expect((await dana('GET', `/systems/${server.id}`)).segments[0].address).toBe('srv-mes01.hall3.example.com');
    const seg2 = srvCopy.segments[0];
    await dana('DELETE', `/systems/${srv.id}/segments/${seg2.id}`);
    await dana('DELETE', `/systems/${srv.id}`);
    await dana('DELETE', `/systems/${seg.id}`);
  });
});

describe('table fields', () => {
  it('are defined with columns and checked by column', async () => {
    const bad = (fields: unknown[]) => errOf(s.api('POST', '/record-types', { key: 'TBL', name: 'Table test', workflow: 'decision', fields }));
    expect((await bad([{ key: 'rows', label: 'Rows', kind: 'table' }])).status).toBe(400);
    expect((await bad([{ key: 'rows', label: 'Rows', kind: 'table', columns: [{ key: 'a', label: 'A', kind: 'select' }] }])).status).toBe(400);
    expect((await bad([{ key: 'note', label: 'Note', kind: 'text', columns: [{ key: 'a', label: 'A', kind: 'text' }] }])).status).toBe(400);
    const type = await s.api('POST', '/record-types', {
      key: 'TBL',
      name: 'Table test',
      workflow: 'decision',
      fields: [
        {
          key: 'items',
          label: 'Items',
          kind: 'table',
          columns: [
            { key: 'what', label: 'What', kind: 'text', required: true },
            { key: 'level', label: 'Level', kind: 'select', options: ['a', 'b'] },
            { key: 'until', label: 'Until', kind: 'date' },
          ],
        },
      ],
    });
    expect(type.fields[0].columns).toHaveLength(3);
    const rec = await dana('POST', '/records', { type: 'TBL', title: 'Tables' });
    const put = (items: unknown) => errOf(dana('PUT', `/records/${rec.id}`, { fields: { items: typeof items === 'string' ? items : JSON.stringify(items) } }));
    expect(await put('not json')).toMatchObject({ status: 400, code: 'RECORD_TABLE_INVALID' });
    expect(await put({ what: 'x' })).toMatchObject({ status: 400, code: 'RECORD_TABLE_INVALID' });
    expect(await put([{ what: 'x', other: 'y' }])).toMatchObject({ code: 'RECORD_TABLE_COLUMN_UNKNOWN' });
    expect(await put([{ level: 'a' }])).toMatchObject({ code: 'RECORD_TABLE_CELL_REQUIRED' });
    expect(await put([{ what: 'x', level: 'c' }])).toMatchObject({ code: 'RECORD_TABLE_CELL_OPTION' });
    expect(await put([{ what: 'x', until: '31.12.2026' }])).toMatchObject({ code: 'RECORD_TABLE_CELL_DATE' });
    expect(await put([{ what: 'x'.repeat(TABLE_LIMITS.cell + 1) }])).toMatchObject({ code: 'RECORD_TABLE_CELL_TOO_LONG' });
    expect(await put([{ what: 'two\nlines' }])).toMatchObject({ code: 'RECORD_TABLE_CELL_LINE' });
    expect(await put(Array.from({ length: TABLE_LIMITS.rows + 1 }, (_, i) => ({ what: `r${i}` })))).toMatchObject({ code: 'RECORD_TABLE_ROWS' });
    // stored in column order, empty rows dropped, cells trimmed
    const ok = await dana('PUT', `/records/${rec.id}`, {
      fields: { items: JSON.stringify([{ until: '2026-12-31', what: ' first ' }, { what: '' }, { what: 'second', level: 'b' }]) },
    });
    expect(ok.fields.items).toBe(
      JSON.stringify([
        { what: 'first', level: '', until: '2026-12-31' },
        { what: 'second', level: 'b', until: '' },
      ]),
    );
    expect(tableRows(ok.fields.items)).toHaveLength(2);
    // an empty table is no value
    expect((await dana('PUT', `/records/${rec.id}`, { fields: { items: '[]' } })).fields).toEqual({});
  });
});

describe('verifying a change', () => {
  it('is optional for change requests: close works from implemented, verify needs someone other than the implementer', async () => {
    const fields = { reason: 'r', risk: 'low', rollbackPlan: 'back' };
    const run = async () => {
      const cr = await dana('POST', '/records', { type: 'CR', title: 'Plain change', fields });
      await dana('POST', `/records/${cr.id}/transition`, { action: 'submit' });
      await adam('POST', `/records/${cr.id}/transition`, { action: 'approve' });
      await olivia('POST', `/records/${cr.id}/transition`, { action: 'implement' });
      return cr;
    };
    const a = await run();
    expect((await olivia('POST', `/records/${a.id}/transition`, { action: 'close' })).status).toBe('closed');
    const b = await run();
    expect(await errOf(olivia('POST', `/records/${b.id}/transition`, { action: 'verify' }))).toMatchObject({ status: 403, code: 'FOUR_EYES_IMPLEMENTER' });
    expect(await errOf(vera('POST', `/records/${b.id}/transition`, { action: 'verify' }))).toMatchObject({ status: 403 });
    expect((await adam('POST', `/records/${b.id}/transition`, { action: 'verify', comment: 'Checked' })).status).toBe('verified');
    expect((await olivia('POST', `/records/${b.id}/transition`, { action: 'close' })).status).toBe('closed');
  });
});

describe('firewall changes', () => {
  let fwc: any, doc: any;

  it('is a built-in type, also in installations seeded before it existed (their own types stay)', async () => {
    const types = await vera('GET', '/record-types');
    expect(types.find((t: any) => t.key === 'FWC')).toMatchObject({ id: FIREWALL_TYPE_ID, workflow: 'change', builtin: true });
    expect(types.find((t: any) => t.key === 'FWR')).toMatchObject({ id: FIREWALL_RULES_TYPE_ID, workflow: 'document', reviewIntervalMonths: 12 });
    // an installation seeded before 0.5.0, with its own type FWC: the built-in one gets another key
    const { db } = await import('../src/db.js');
    const types2 = await import('../src/records/types.js');
    db().run("DELETE FROM record_types WHERE id IN ('rty_fwc', 'rty_fwr')");
    db().run(
      "INSERT INTO record_types (id, key, name, description, workflow, template, fields, builtin, archived, created_at, updated_at, updated_by) VALUES ('rty_own', 'FWC', 'Our firewall changes', '', 'change', '', '[]', 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'admin')",
    );
    types2.resetTypeSeed();
    const after = await vera('GET', '/record-types');
    expect(after.find((t: any) => t.id === 'rty_own')).toMatchObject({ key: 'FWC', name: 'Our firewall changes', builtin: false });
    expect(after.find((t: any) => t.id === FIREWALL_TYPE_ID)).toMatchObject({ key: 'FWCH', name: 'Firewall change' });
    expect(after.find((t: any) => t.id === FIREWALL_RULES_TYPE_ID)).toMatchObject({ key: 'FWR' });
    // back to the state of a new installation for the tests below
    db().run("DELETE FROM record_types WHERE id IN ('rty_own', 'rty_fwc')");
    types2.resetTypeSeed();
    expect((await vera('GET', '/record-types')).find((t: any) => t.id === FIREWALL_TYPE_ID).key).toBe('FWC');
  });

  it('names the affected systems; links to systems show only to who may see them', async () => {
    fwc = await dana('POST', '/records', { type: 'FWC', title: 'HTTPS from Hall 3 to the MES server', fields: FWC_FIELDS([RULE()]) });
    expect(tableRows(fwc.fields.rules)).toHaveLength(1);
    expect(fwc.actions.find((a: any) => a.action === 'submit')).toMatchObject({ allowed: false, reasonCode: 'FWC_AFFECTED_REQUIRED' });
    await dana('POST', `/records/${fwc.id}/links`, { kind: 'system', id: server.id, note: 'affected' });
    const link = (await dana('GET', `/records/${fwc.id}`)).links.find((l: any) => l.kind === 'system');
    expect(link).toMatchObject({ visible: true, targetId: server.id, label: 'srv-mes01', path: `/systems/${server.id}` });
    expect((await dana('GET', `/systems/${server.id}`)).backlinks).toMatchObject([{ kind: 'record', id: fwc.id }]);
    expect(await dana('GET', '/link-targets?kind=system&q=mes01')).toMatchObject([{ kind: 'system', id: server.id }]);
    // a team-owned system: outside the team it is unknown, its links show as not visible
    const team = (await s.api('POST', '/teams', { name: 'Plant OT', members: ['tara'], memberRoles: { tara: ['designer'] } })).id;
    const hidden = await s.api('POST', '/systems', { name: 'plc-gw-07', kind: 'appliance' });
    await s.api('PUT', `/owning-teams/system/${hidden.id}`, { teamIds: [team] });
    expect(await errOf(vic('GET', `/systems/${hidden.id}`))).toMatchObject({ status: 404 });
    await tara('POST', `/records/${fwc.id}/links`, { kind: 'system', id: hidden.id, note: 'affected' });
    // tara (team member, designer) may link it; dana may not see it, so she cannot link it either
    expect(await errOf(dana('POST', `/records/${fwc.id}/links`, { kind: 'system', id: hidden.id, note: 'affected' }))).toMatchObject({ status: 404 });
    const asTara = (await tara('GET', `/records/${fwc.id}`)).links.find((l: any) => l.kind === 'system' && l.targetId === hidden.id);
    expect(asTara).toMatchObject({ visible: true, label: 'plc-gw-07' });
    const asVic = (await vic('GET', `/records/${fwc.id}`)).links.filter((l: any) => l.kind === 'system');
    expect(asVic.find((l: any) => l.targetId === server.id)).toBeTruthy();
    expect(asVic.filter((l: any) => !l.visible)).toEqual([expect.objectContaining({ targetId: null, label: '', path: null })]);
    expect(await vic('GET', '/link-targets?kind=system&q=plc')).toEqual([]);
    expect(await vic('GET', `/ticket-references?link=system:${hidden.id}`)).toMatchObject({ items: [] });
    // the hidden system's link goes again (it would stop dana from closing the change)
    const l = (await tara('GET', `/records/${fwc.id}`)).links.find((x: any) => x.targetId === hidden.id);
    await tara('DELETE', `/records/${fwc.id}/links/${l.id}`);
  });

  it('is approved, implemented with evidence, verified by a second person and closed', async () => {
    await dana('POST', `/records/${fwc.id}/transition`, { action: 'submit' });
    // four-eyes: the author does not approve
    expect(await errOf(dana('POST', `/records/${fwc.id}/transition`, { action: 'approve' }))).toMatchObject({ status: 403 });
    await adam('POST', `/records/${fwc.id}/transition`, { action: 'approve', comment: 'Go ahead' });
    // evidence: after the approval, not content (the frozen hash stays), never before
    const before = await olivia('GET', `/records/${fwc.id}`);
    expect(before.permissions.attachEvidence).toBe(true);
    expect((await vera('GET', `/records/${fwc.id}`)).permissions.attachEvidence).toBe(false);
    await olivia('POST', `/records/${fwc.id}/transition`, { action: 'implement', comment: 'Provider implemented it in CHG-4711' });
    let r = await dana('GET', `/records/${fwc.id}`);
    expect(r.actions.find((a: any) => a.action === 'verify')).toMatchObject({ allowed: false, reasonCode: 'FWC_EVIDENCE_REQUIRED' });
    expect(r.actions.find((a: any) => a.action === 'close')).toMatchObject({ allowed: false, reasonCode: 'FWC_VERIFY_FIRST' });
    const ev = await upload('olivia', `/records/${fwc.id}/evidence`, 'provider-confirmation.txt', 'CHG-4711 done: rule 1 added');
    expect(ev.status).toBe(200);
    expect(ev.body).toMatchObject({ kind: 'evidence', filename: 'provider-confirmation.txt' });
    r = await olivia('GET', `/records/${fwc.id}`);
    expect(r.tampered).toBe(false);
    expect(r.contentHash).toBe(before.contentHash);
    expect((await auditOf('record', fwc.id)).find((e: any) => e.action === 'record.evidence_added').details).toMatchObject({ sha256: ev.body.sha256 });
    // the implementer does not verify it (four-eyes)
    expect(r.actions.find((a: any) => a.action === 'verify')).toMatchObject({ allowed: false, reasonCode: 'FOUR_EYES_IMPLEMENTER' });
    await dana('POST', `/records/${fwc.id}/transition`, { action: 'verify', comment: 'curl from a Hall 3 client works' });
    // before closing: against the approved rules of the server (none yet)
    const ctx = await vera('GET', `/records/${fwc.id}/firewall`);
    expect(ctx.items).toMatchObject([{ system: { id: server.id }, document: null, comparison: ['new'] }]);
    const closed = await dana('POST', `/records/${fwc.id}/transition`, { action: 'close' });
    expect(closed.status).toBe('closed');
    expect((await upload('olivia', `/records/${fwc.id}/evidence`, 'late.txt', 'too late')).status).toBe(409);
    const actions = (await auditOf('record', fwc.id)).map((e: any) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining(['record.submit', 'record.approve', 'record.implement', 'record.evidence_added', 'record.verify', 'record.close']),
    );
  });

  it('drafts the approved rules of what it affects; an approver confirms the edition', async () => {
    const sys = await dana('GET', `/systems/${server.id}`);
    expect(sys.firewall.changes).toMatchObject([
      { id: fwc.id, status: 'closed', done: true, implementer: 'provider', providerTicket: 'CHG-4711', ruleCount: 1 },
    ]);
    expect(sys.firewall.documents).toHaveLength(1);
    doc = sys.firewall.documents[0];
    expect(doc).toMatchObject({ status: 'in_review', edition: null, pending: true });
    expect(doc.rules).toMatchObject([{ source: '10.20.30.0/24', service: 'tcp/443', action: 'allow', approvedBy: fwc.number }]);
    // the person who closed the change submitted it: someone else approves
    expect(await errOf(dana('POST', `/records/${doc.id}/transition`, { action: 'approve' }))).toMatchObject({ status: 403 });
    const approved = await adam('POST', `/records/${doc.id}/transition`, { action: 'approve' });
    expect(approved).toMatchObject({ status: 'published', document: { currentEdition: '1.0', review: { intervalMonths: 12 } } });
    expect((await dana('GET', `/systems/${server.id}`)).firewall.documents[0]).toMatchObject({ edition: '1.0', reviewStatus: 'current', pending: false });
  });

  it('applies the next change to the current edition: removes, changes and adds rules', async () => {
    const next = await dana('POST', '/records', {
      type: 'FWC',
      title: 'Replace HTTPS by MQTT over TLS',
      fields: FWC_FIELDS([RULE({ change: 'remove' }), RULE({ service: 'tcp/8883', purpose: 'MQTT over TLS' }), RULE({ change: 'remove', service: 'udp/161' })]),
      links: [{ kind: 'system', id: server.id, note: 'affected' }],
    });
    expect((await vera('GET', `/records/${next.id}/firewall`)).items[0]).toMatchObject({
      document: { id: doc.id, edition: '1.0' },
      comparison: ['removes', 'new', 'notFound'],
    });
    await dana('POST', `/records/${next.id}/transition`, { action: 'submit' });
    await adam('POST', `/records/${next.id}/transition`, { action: 'approve' });
    await olivia('POST', `/records/${next.id}/transition`, { action: 'implement' });
    expect((await upload('olivia', `/records/${next.id}/evidence`, 'export.csv', 'src,dst,svc\n10.20.30.0/24,srv-mes01,tcp/8883\n')).status).toBe(200);
    await adam('POST', `/records/${next.id}/transition`, { action: 'verify' });
    await olivia('POST', `/records/${next.id}/transition`, { action: 'close' });
    const d = await dana('GET', `/records/${doc.id}`);
    expect(d).toMatchObject({ status: 'in_review', document: { currentEdition: '1.0', pending: { kind: 'minor', edition: '1.1' } } });
    expect(tableRows(d.fields.approvedRules)).toMatchObject([{ service: 'tcp/8883', purpose: 'MQTT over TLS', approvedBy: next.number }]);
    // the panel shows the approved edition until the next one is approved
    expect((await dana('GET', `/systems/${server.id}`)).firewall.documents[0]).toMatchObject({
      edition: '1.0',
      pending: true,
      rules: [{ service: 'tcp/443' }],
    });

    // a third change cannot be closed while that edition waits for approval
    const third = await dana('POST', '/records', {
      type: 'FWC',
      title: 'SSH for the provider',
      fields: FWC_FIELDS([RULE({ source: '192.0.2.10', service: 'tcp/22', purpose: 'Provider jump host' })]),
      links: [{ kind: 'system', id: server.id, note: 'affected' }],
    });
    await dana('POST', `/records/${third.id}/transition`, { action: 'submit' });
    await adam('POST', `/records/${third.id}/transition`, { action: 'approve' });
    await olivia('POST', `/records/${third.id}/transition`, { action: 'implement' });
    await upload('olivia', `/records/${third.id}/evidence`, 'ok.txt', 'done');
    await dana('POST', `/records/${third.id}/transition`, { action: 'verify' });
    expect(await errOf(dana('POST', `/records/${third.id}/transition`, { action: 'close' }))).toMatchObject({ status: 409, code: 'FWC_RULES_IN_REVIEW' });
    expect((await dana('GET', `/records/${third.id}`)).status).toBe('verified');
    await adam('POST', `/records/${doc.id}/transition`, { action: 'approve' });
    await dana('POST', `/records/${third.id}/transition`, { action: 'close' });
    const d3 = await dana('GET', `/records/${doc.id}`);
    expect(tableRows(d3.fields.approvedRules).map((x) => x.service)).toEqual(['tcp/8883', 'tcp/22']);
  });

  it('prints its rule lines and evidence in the PDF', async () => {
    const { generateRecordPdf } = await import('../src/records/pdf.js');
    const { runAs } = await import('../src/auth/context.js');
    const r = await runAs({ id: 'u', username: 'adam', displayName: 'Adam Approver', roles: ['approver'], teams: [] }, () =>
      generateRecordPdf(fwc.id, { lang: 'de', signers: [] }),
    );
    const text = r.texts.join('\n');
    for (const fact of ['Regeln', 'Quelle', 'Protokoll/Port', 'tcp/443', 'erlauben', 'Perimeter-Firewall', 'Nachweise', 'provider-confirmation.txt'])
      expect(text, fact).toContain(fact);
  });
});

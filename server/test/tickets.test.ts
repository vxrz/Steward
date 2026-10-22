import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

process.env.SM_GATUS_AUTOSTART = '0';

// Capture e-mails instead of talking to an SMTP server.
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string; html: string }[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: { to: string; subject: string; text: string; html: string }) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

let s: TestServer;
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;
const PW = 'Demo-password-1';
const DAY = 86400000;
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
let service: { id: string; name: string };
let hidden: { id: string; name: string };

const ticket = (over: Record<string, unknown> = {}) => ({
  source: 'vendor',
  externalNumber: uniq('CS'),
  externalUrl: 'https://support.vendor.example/cases/4711',
  title: 'Agent upload stalls on tenant plantprod',
  note: '**Opened** with vendor support. See [case](https://support.vendor.example/cases/4711).',
  vendor: 'Siemens',
  responsible: ['user:olivia'],
  links: [{ kind: 'service', id: service.id }],
  ...over,
});

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  service = await s.api('POST', '/services', { name: uniq('Insights Hub plant data'), owners: [] });
  const platforms = await s.api('GET', '/platforms');
  // a platform only administrators and dana may see
  hidden = platforms[1];
  await s.api('PUT', `/platforms/${hidden.id}/access`, { acl: [{ subject: 'user:dana', permissions: ['use'] }] });
});
afterAll(async () => {
  await s?.app.close();
});

describe('ticket references: permissions', () => {
  it('operators, designers and admins create; everyone reads; others are refused', async () => {
    const t = await olivia('POST', '/ticket-references', ticket());
    expect(t).toMatchObject({ status: 'open', vendorSource: true, sourceLabel: 'Vendor ticket', responsible: ['user:olivia'], resolvedAt: null });
    expect(t.links).toEqual([expect.objectContaining({ kind: 'service', targetId: service.id, label: service.name, visible: true })]);
    expect(t.events.map((e: any) => e.kind)).toEqual(['created']);
    expect(await status(dana('POST', '/ticket-references', ticket()))).toBe(200);
    for (const c of [adam, audrey, vera]) expect(await status(c('POST', '/ticket-references', ticket()))).toBe(403);
    for (const c of [adam, audrey, vera]) expect((await c('GET', `/ticket-references/${t.id}`)).title).toBe(t.title);
    expect((await vera('GET', `/ticket-references/${t.id}`)).permissions).toEqual([]);
    expect((await s.api('GET', `/ticket-references/${t.id}`)).permissions).toEqual(['edit', 'delete']);
  });

  it('responsible people edit (also through a team) but cannot remove themselves; only admins delete', async () => {
    const t = await dana('POST', '/ticket-references', ticket({ responsible: ['user:adam'] }));
    // adam (approver) is responsible: he may change it and set the status
    const edited = await adam('PUT', `/ticket-references/${t.id}`, ticket({ ...pick(t), title: 'Changed by adam', responsible: ['user:adam'] }));
    expect(edited.title).toBe('Changed by adam');
    expect((await adam('POST', `/ticket-references/${t.id}/status`, { status: 'waitingVendor', comment: 'Sent logs' })).status).toBe('waitingVendor');
    // …but not edit himself out of the list
    const current = await adam('GET', `/ticket-references/${t.id}`);
    const e = await adam('PUT', `/ticket-references/${t.id}`, ticket({ ...pick(current), responsible: ['user:olivia'] })).catch((x) => x);
    expect(e.status).toBe(400);
    expect(e.message).toContain('TICKET_RESPONSIBLE_REQUIRED');
    // audrey is not responsible
    expect(await status(audrey('POST', `/ticket-references/${t.id}/checked`, {}))).toBe(403);
    // the team "Service Desk" (olivia, adam)
    const team = await dana('POST', '/ticket-references', ticket({ responsible: ['team:service desk'] }));
    expect((await adam('POST', `/ticket-references/${team.id}/checked`, { comment: 'Still open at the vendor' })).lastCheckedAt).toBeTruthy();
    expect(await status(dana('POST', '/ticket-references', ticket({ responsible: ['user:nobody-here'] })))).toBe(400);
    // delete: administrators only
    for (const c of [dana, olivia, adam]) expect(await status(c('DELETE', `/ticket-references/${t.id}`))).toBe(403);
    await s.api('DELETE', `/ticket-references/${t.id}`);
    expect(await status(s.api('GET', `/ticket-references/${t.id}`))).toBe(404);
    const audit = await s.api('GET', `/audit?entityType=ticket&entityId=${t.id}`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['ticket.created', 'ticket.updated', 'ticket.status_changed', 'ticket.deleted']));
  });
});

/** The editable fields of a stored entry (for PUT). */
function pick(t: any) {
  return {
    source: t.source,
    externalNumber: t.externalNumber,
    externalUrl: t.externalUrl,
    title: t.title,
    note: t.note,
    vendor: t.vendor,
    responsible: t.responsible,
    status: t.status,
    links: t.links.filter((l: any) => l.visible).map((l: any) => ({ kind: l.kind, id: l.targetId })),
    version: t.version,
  };
}

describe('ticket references: validation and status', () => {
  it('accepts http(s) links only and refuses duplicates and unknown sources', async () => {
    for (const url of ['javascript:alert(1)', 'ftp://vendor.example/x', 'data:text/html,hi', 'not a url'])
      expect(await status(olivia('POST', '/ticket-references', ticket({ externalUrl: url }))), url).toBe(400);
    const t = await olivia('POST', '/ticket-references', ticket({ externalUrl: '' }));
    expect(t.externalUrl).toBeNull();
    const dup = await olivia('POST', '/ticket-references', ticket({ externalNumber: t.externalNumber.toUpperCase() })).catch((x) => x);
    expect(dup.status).toBe(409);
    expect(await status(olivia('POST', '/ticket-references', ticket({ source: 'jira' })))).toBe(400);
    expect(await status(olivia('POST', '/ticket-references', ticket({ note: 'x'.repeat(20001) })))).toBe(400);
    expect(await status(olivia('POST', '/ticket-references', ticket({ openedAt: new Date(Date.now() + 5 * DAY).toISOString() })))).toBe(400);
  });

  it('keeps the transitions free and tracks resolved and checked dates with a history', async () => {
    const t = await olivia('POST', '/ticket-references', ticket({ openedAt: '2026-01-05' }));
    expect(t.openedAt).toBe('2026-01-05T00:00:00.000Z');
    const resolved = await olivia('POST', `/ticket-references/${t.id}/status`, { status: 'resolved', comment: 'Vendor shipped a fix' });
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.lastCheckedAt).toBeTruthy();
    const closed = await olivia('POST', `/ticket-references/${t.id}/status`, { status: 'closed' });
    expect(closed.resolvedAt).toBe(resolved.resolvedAt);
    // straight back to "waiting for us": no workflow
    const reopened = await olivia('POST', `/ticket-references/${t.id}/status`, { status: 'waitingUs' });
    expect(reopened.resolvedAt).toBeNull();
    expect(reopened.events.filter((e: any) => e.kind === 'status').map((e: any) => [e.fromStatus, e.toStatus])).toEqual([
      ['closed', 'waitingUs'],
      ['resolved', 'closed'],
      ['open', 'resolved'],
    ]);
    expect(reopened.events.find((e: any) => e.toStatus === 'resolved').comment).toBe('Vendor shipped a fix');
    // optimistic locking on PUT
    const stale = await olivia('PUT', `/ticket-references/${t.id}`, ticket({ ...pick(t), version: 1 })).catch((x) => x);
    expect(stale.status).toBe(409);
  });
});

describe('ticket references: affected items and visibility', () => {
  it('names hidden items to nobody who may not see them and keeps them on edits', async () => {
    const t = await dana(
      'POST',
      '/ticket-references',
      ticket({
        links: [
          { kind: 'platform', id: hidden.id },
          { kind: 'service', id: service.id },
        ],
      }),
    );
    // olivia cannot see the platform: the link is shown without name or id
    const seen = await olivia('GET', `/ticket-references/${t.id}`);
    const link = seen.links.find((l: any) => l.kind === 'platform');
    expect(link).toMatchObject({ visible: false, targetId: null, label: '' });
    expect(JSON.stringify(seen)).not.toContain(hidden.name);
    // she cannot link it herself (404 like a missing item) …
    expect(await status(olivia('POST', '/ticket-references', ticket({ links: [{ kind: 'platform', id: hidden.id }] })))).toBe(404);
    // … and her edit does not remove it
    const after = await olivia('PUT', `/ticket-references/${t.id}`, ticket({ ...pick(seen), links: [] }));
    expect(after.links.map((l: any) => l.kind)).toEqual(['platform']);
    expect((await dana('GET', `/ticket-references/${t.id}`)).links[0]).toMatchObject({ kind: 'platform', targetId: hidden.id, visible: true });
    // the item filter does not answer for hidden items
    expect((await olivia('GET', `/ticket-references?link=platform:${hidden.id}`)).items).toEqual([]);
    expect((await dana('GET', `/ticket-references?link=platform:${hidden.id}`)).items.map((x: any) => x.id)).toEqual([t.id]);
  });

  it('filters by status, source, vendor, item, responsible and age; counts open vendor tickets per service', async () => {
    const svc = await s.api('POST', '/services', { name: uniq('Edge fleet'), owners: [] });
    const vendor = uniq('Vendor');
    const a = await olivia(
      'POST',
      '/ticket-references',
      ticket({ vendor, links: [{ kind: 'service', id: svc.id }], openedAt: new Date(Date.now() - 40 * DAY).toISOString() }),
    );
    const b = await olivia(
      'POST',
      '/ticket-references',
      ticket({ vendor, links: [{ kind: 'service', id: svc.id }], status: 'waitingVendor', responsible: ['user:dana'] }),
    );
    await olivia('POST', '/ticket-references', ticket({ source: 'servicenow-incident', vendor: '', links: [{ kind: 'service', id: svc.id }] }));
    await olivia('POST', '/ticket-references', ticket({ vendor, links: [{ kind: 'service', id: svc.id }], status: 'closed' }));
    const ids = async (q: string) => (await vera('GET', `/ticket-references?${q}`)).items.map((x: any) => x.id).sort();
    expect(await ids(`vendor=${vendor}&state=open`)).toEqual([a.id, b.id].sort());
    expect(await ids(`vendor=${vendor.toLowerCase()}&status=waitingVendor`)).toEqual([b.id]);
    expect((await ids(`link=service:${svc.id}`)).length).toBe(4);
    expect((await ids(`link=service:${svc.id}&source=servicenow-incident`)).length).toBe(1);
    expect(await ids(`link=service:${svc.id}&minAgeDays=30`)).toEqual([a.id]);
    expect(await ids(`link=service:${svc.id}&responsible=user:dana`)).toEqual([b.id]);
    expect((await dana('GET', `/ticket-references?link=service:${svc.id}&responsible=me`)).items.map((x: any) => x.id)).toEqual([b.id]);
    expect((await vera('GET', '/ticket-references/open-counts?kind=service&vendorOnly=1'))[svc.id]).toBe(2);
    expect((await vera('GET', '/ticket-references/open-counts?kind=service'))[svc.id]).toBe(3);
    expect(await vera('GET', '/ticket-references/vendors')).toContain(vendor);
    expect(await status(vera('GET', '/ticket-references?status=bogus'))).toBe(400);
  });
});

describe('ticket references: settings and reminders', () => {
  it('administrators manage the sources (used ones stay) and the reminder default', async () => {
    const cur = await vera('GET', '/ticket-references/settings');
    expect(cur.sources.map((x: any) => x.key)).toEqual(['servicenow-incident', 'servicenow-other', 'vendor', 'other']);
    expect(cur.reminderDays).toBeNull();
    expect(await status(dana('PUT', '/ticket-references/settings', cur))).toBe(403);
    const removed = await s.api('PUT', '/ticket-references/settings', { ...cur, sources: cur.sources.filter((x: any) => x.key !== 'vendor') }).catch((x) => x);
    expect(removed.status).toBe(409);
    const next = await s.api('PUT', '/ticket-references/settings', {
      reminderDays: null,
      sources: [...cur.sources, { key: 'vendor-edge', label: 'Industrial Edge support', vendor: true }],
    });
    expect(next.sources).toHaveLength(5);
    const t = await olivia('POST', '/ticket-references', ticket({ source: 'vendor-edge' }));
    expect(t).toMatchObject({ sourceLabel: 'Industrial Edge support', vendorSource: true });
  });

  it('reminds the responsible people once per period without a check (fake clock)', async () => {
    const { checkTicketReminders } = await import('../src/tickets/reminders.js');
    const { db } = await import('../src/db.js');
    const notif = await s.api('GET', '/settings/notifications');
    await s.api('PUT', '/settings/notifications', {
      ...notif,
      email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
      allowedEmailDomains: ['example.com'],
    });
    await olivia('PATCH', '/me', { email: 'olivia@example.com', emailNotifications: true });
    const off = await dana('POST', '/ticket-references', ticket({ responsible: ['user:olivia'] }));
    const t = await dana('POST', '/ticket-references', ticket({ responsible: ['user:olivia'], reminderDays: 3, title: 'Reminder test ticket' }));
    const now = Date.now();
    const sentFor = () => db().get<{ n: number }>('SELECT COUNT(*) AS n FROM ticket_ref_reminders WHERE ticket_id = ?', t.id)!.n;
    mails.length = 0;
    expect(checkTicketReminders(now + 2 * DAY)).toBe(0);
    expect(checkTicketReminders(now + 3 * DAY + 60000)).toBeGreaterThanOrEqual(1);
    expect(sentFor()).toBe(1);
    checkTicketReminders(now + 3 * DAY + 120000);
    expect(sentFor()).toBe(1); // idempotent
    checkTicketReminders(now + 6 * DAY + 60000);
    expect(sentFor()).toBe(2); // every N days until checked
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM ticket_ref_reminders WHERE ticket_id = ?', off.id)!.n).toBe(0); // default: off
    await new Promise((r) => setTimeout(r, 50));
    const { flushNotifications } = await import('../src/notifications/service.js');
    await flushNotifications();
    expect(mails.filter((m) => m.subject.includes(t.externalNumber)).map((m) => m.to)).toEqual(['olivia@example.com', 'olivia@example.com']);
    expect(mails.find((m) => m.subject.includes(t.externalNumber))!.subject).toBe(`[Steward] Ticket ${t.externalNumber} not checked for 3 days`);
    const inbox = await olivia('GET', '/notifications');
    expect(inbox.items.filter((n: any) => n.title.startsWith(`Ticket ${t.externalNumber} not checked for`))).toHaveLength(2);
    // a check re-arms the clock
    await olivia('POST', `/ticket-references/${t.id}/checked`, {});
    checkTicketReminders(Date.now() + 2 * DAY);
    expect(sentFor()).toBe(2);
    checkTicketReminders(Date.now() + 3 * DAY + 60000);
    expect(sentFor()).toBe(3);
    // resolved tickets are not reminded
    await olivia('POST', `/ticket-references/${t.id}/status`, { status: 'resolved' });
    checkTicketReminders(now + 60 * DAY);
    expect(sentFor()).toBe(3);
    expect((await olivia('GET', `/ticket-references/${t.id}`)).events.filter((e: any) => e.kind === 'reminded')).toHaveLength(3);
  });
});

describe('ticket references: API, MCP and report section', () => {
  it('serves them in the public API v1 and the MCP tool with the reader’s visibility', async () => {
    const t = await dana(
      'POST',
      '/ticket-references',
      ticket({
        links: [
          { kind: 'platform', id: hidden.id },
          { kind: 'service', id: service.id },
        ],
      }),
    );
    const tokenOf = async (c: Client, scope: string) => (await c('POST', '/me/tokens', { name: uniq('t'), scope })).token;
    const veraRead = await tokenOf(vera, 'read');
    const get = (tok: string, path: string) => fetch(`${s.base}/api/v1${path}`, { headers: { authorization: `Bearer ${tok}` } });
    const one = await (await get(veraRead, `/ticket-references/${t.id}`)).json();
    expect(one).toMatchObject({ id: t.id, externalNumber: t.externalNumber, status: 'open' });
    expect(one.affected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'platform', targetId: null, visible: false }),
        expect.objectContaining({ kind: 'service', targetId: service.id }),
      ]),
    );
    expect(JSON.stringify(one)).not.toContain(hidden.name);
    const page = await (await get(veraRead, `/ticket-references?affected=service:${service.id}&limit=2`)).json();
    expect(page.items.length).toBe(2);
    expect(page.nextCursor).toBeTruthy();
    expect((await get(veraRead, '/ticket-references/tkt_nope')).status).toBe(404);

    await s.api('PUT', '/mcp-server', { enabled: true });
    const mcp = async (tok: string, args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tok}`,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'list_ticket_references',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'list_ticket_references',
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            },
          },
        }),
      });
      const body = await res.json();
      return body.result;
    };
    const veraMcp = await tokenOf(vera, 'mcp');
    const danaMcp = await tokenOf(dana, 'mcp');
    const vr = await mcp(veraMcp, { affectedKind: 'service', affectedId: service.id, limit: 100 });
    const mine = vr.structuredContent.items.find((x: any) => x.id === t.id);
    expect(mine.affected).toEqual([expect.objectContaining({ kind: 'service', id: service.id })]);
    expect(JSON.stringify(vr)).not.toContain(hidden.name);
    expect((await mcp(veraMcp, { affectedKind: 'platform', affectedId: hidden.id })).structuredContent.items).toEqual([]);
    expect((await mcp(danaMcp, { affectedKind: 'platform', affectedId: hidden.id })).structuredContent.items.map((x: any) => x.id)).toContain(t.id);
    expect((await mcp(veraMcp, { affectedKind: 'service' })).isError).toBe(true);
  });

  it('report section: open per service and vendor, opened and resolved in the period, MTTR per vendor', async () => {
    const { reportSection } = await import('../src/reports/sections.js');
    await import('../src/tickets/report-section.js');
    const { runAs } = await import('../src/auth/context.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const vendor = uniq('MTTR vendor');
    const from = Date.parse('2026-03-01T00:00:00Z');
    const to = Date.parse('2026-04-01T00:00:00Z');
    await olivia('POST', '/ticket-references', ticket({ vendor, openedAt: '2026-02-20', status: 'resolved', resolvedAt: '2026-03-02T00:00:00Z' }));
    await olivia('POST', '/ticket-references', ticket({ vendor, openedAt: '2026-03-10', status: 'closed', resolvedAt: '2026-03-12T00:00:00Z' }));
    await olivia('POST', '/ticket-references', ticket({ vendor, openedAt: '2026-03-20' }));
    await olivia('POST', '/ticket-references', ticket({ vendor, openedAt: '2026-04-05' })); // after the period
    const sec = reportSection('tickets')!;
    const data = runAs(toAuthUser(findUserByName('dana')!), () =>
      sec.build(sec.schema.parse({}), { from, to, now: Date.parse('2026-06-01T00:00:00Z'), lang: 'en' }),
    ) as any;
    const mtt = data.mttrPerVendor.find((x: any) => x.name === vendor);
    expect(mtt).toEqual({ name: vendor, resolved: 2, mttrHours: (10 * 24 + 2 * 24) / 2 });
    expect(data.perVendor.find((x: any) => x.name === vendor)).toMatchObject({ count: 1, oldestDays: 12 });
    expect(data.open.filter((x: any) => x.vendor === vendor).map((x: any) => x.status)).toEqual(['open']);
    expect(data.perService.find((x: any) => x.name === service.name).count).toBeGreaterThanOrEqual(1);
    expect(() => sec.validate!(sec.schema.parse({ sources: ['nope'] }))).toThrow(/not found/);
  });
});

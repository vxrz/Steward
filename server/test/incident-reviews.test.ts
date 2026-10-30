import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Incident reviews (#109): the built-in type on the decision workflow, its measures (who may keep them, owners mark
 * them done, overdue, by service, reminders), the timeline candidates of a time window (only what the author may
 * see) copied into the text, starting a review from a closed ticket reference or a monitor outage, the public API.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, vera: Client;
const DAY = 86_400_000;
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
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();

let svc: any;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, vera] = await Promise.all(['dana', 'olivia', 'vera'].map((u) => s.as(u, PW)));
  svc = await dana('POST', '/services', { name: 'Reviewed service', owners: ['user:olivia'] });
});
afterAll(async () => {
  await s?.app.close();
});

describe('incident reviews', () => {
  it('is a built-in type on the decision workflow; proposing needs the incident fields', async () => {
    const types = await s.api('GET', '/record-types');
    const pir = types.find((x: any) => x.id === 'rty_pir');
    expect(pir).toMatchObject({ key: 'PIR', workflow: 'decision', builtin: true, archived: false });
    const r = await dana('POST', '/records', { type: 'PIR', title: 'Checkout down' });
    expect(r.body).toContain('## Timeline');
    expect(await code(dana('POST', `/records/${r.id}/transition`, { action: 'propose' }))).toBe('RECORD_INCOMPLETE');
    await dana('PUT', `/records/${r.id}`, {
      fields: { incidentStart: new Date().toISOString(), severity: 'major', impact: 'Checkout failed for 20 minutes' },
      baseVersion: r.version,
    });
    const proposed = await dana('POST', `/records/${r.id}/transition`, { action: 'propose' });
    expect(proposed.status).toBe('proposed');
  });

  it('keeps measures: the author adds them, owners mark them done, overdue ones show on the service', async () => {
    const r = await dana('POST', '/records', { type: 'PIR', title: 'Database full', links: [{ kind: 'service', id: svc.id, note: '' }] });
    expect(await status(vera('POST', `/records/${r.id}/measures`, { title: 'x', owners: ['user:olivia'], dueDate: day(5) }))).toBe(403);
    expect(await code(dana('POST', `/records/${r.id}/measures`, { title: 'x', owners: ['user:nobody'], dueDate: day(5) }))).toBe('USER_UNKNOWN');
    await dana('POST', `/records/${r.id}/measures`, { title: 'Alert on disk usage', owners: ['user:olivia'], dueDate: day(-2) });
    const list = await dana('POST', `/records/${r.id}/measures`, { title: 'Grow the volume', owners: ['user:dana'], dueDate: day(10) });
    expect(list.canEdit).toBe(true);
    expect(list.items.map((m: any) => [m.title, m.overdue])).toEqual([
      ['Alert on disk usage', true],
      ['Grow the volume', false],
    ]);
    const alert = list.items[0];
    // olivia owns the first: she may mark it done, but not rename it; she may not touch the second
    expect(await status(olivia('PUT', `/records/${r.id}/measures/${alert.id}`, { title: 'renamed' }))).toBe(403);
    expect(await status(olivia('PUT', `/records/${r.id}/measures/${list.items[1].id}`, { done: true }))).toBe(403);
    const before = await vera('GET', `/measures?serviceId=${svc.id}&state=overdue`);
    expect(before.map((m: any) => m.title)).toEqual(['Alert on disk usage']);
    expect(before[0]).toMatchObject({ recordNumber: r.number, recordTitle: 'Database full' });
    const done = await olivia('PUT', `/records/${r.id}/measures/${alert.id}`, { done: true, note: 'Alert in place' });
    expect(done.items[0]).toMatchObject({ doneBy: 'olivia', overdue: false, note: 'Alert in place' });
    expect(await vera('GET', `/measures?serviceId=${svc.id}&state=overdue`)).toEqual([]);
    expect((await vera('GET', `/measures?serviceId=${svc.id}`)).map((m: any) => m.title)).toEqual(['Grow the volume']);
    // measures stay editable after the review was accepted
    const audit = await s.api('GET', `/audit?entityType=record&entityId=${r.id}&limit=20`);
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['record.measure_added', 'record.measure_done']));
    expect(await code(dana('GET', `/records/${(await dana('POST', '/records', { type: 'DR', title: 'Not a review' })).id}/measures`))).toBe(
      'NOT_AN_INCIDENT_REVIEW',
    );
  });

  it('reminds the owners before the due date, on it and weekly while overdue (once each)', async () => {
    const m = await import('../src/records/reviews.js');
    const { db } = await import('../src/db.js');
    const r = await dana('POST', '/records', { type: 'PIR', title: 'Reminders' });
    const list = await dana('POST', `/records/${r.id}/measures`, { title: 'Patch the gateway', owners: ['user:olivia'], dueDate: day(2) });
    const id = list.items[0].id;
    await m.runMeasureJob();
    await m.runMeasureJob();
    await m.runMeasureJob(Date.now() + 2 * DAY);
    await m.runMeasureJob(Date.now() + 4 * DAY);
    await m.runMeasureJob(Date.now() + 5 * DAY);
    await flush();
    const keys = db()
      .all<{ reminder_key: string }>('SELECT reminder_key FROM record_measure_reminders WHERE measure_id = ? ORDER BY sent_at', id)
      .map((x) => x.reminder_key);
    expect(keys.sort()).toEqual(['due', 'overdue:0', 'soon']);
    const inbox = ((await olivia('GET', '/notifications?limit=200')) as { items: any[] }).items.filter((n) => n.link === `/records/${r.id}`);
    expect(inbox.map((n) => n.title)).toEqual(expect.arrayContaining([expect.stringContaining('Patch the gateway')]));
    expect(inbox).toHaveLength(3);
  });

  it('offers what Steward saw in the window – only what the author may see – and copies the chosen entries', async () => {
    const { db } = await import('../src/db.js');
    const from = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date().toISOString();
    const mon = db().get<{ id: string; name: string }>('SELECT id, name FROM monitors WHERE is_template = 0 LIMIT 1')!;
    db().run(
      "INSERT INTO monitor_history (monitor_id, check_id, ts, status, previous, message, caused_by) VALUES (?, '', ?, 'down', 'up', 'timeout', '[]')",
      mon.id,
      at,
    );
    const proc = db().get<{ id: string; name: string }>('SELECT id, name FROM processes LIMIT 1')!;
    db().run(
      `INSERT INTO runs (id, process_id, process_name, process_version, definition_hash, status, dry_run, trigger, actor, inputs, bindings, started_at, finished_at, error, stats)
       VALUES ('run_pir', ?, ?, 1, 'x', 'failed', 0, 'manual', 'dana', '{}', '{}', ?, ?, 'HTTP 503', '{}')`,
      proc.id,
      proc.name,
      at,
      at,
    );
    const r = await dana('POST', '/records', { type: 'PIR', title: 'Timeline' });
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const c = await dana('GET', `/records/${r.id}/timeline?${q}`);
    const sources = new Set(c.items.map((i: any) => i.source));
    expect(sources.has('monitor')).toBe(true);
    expect(sources.has('run')).toBe(true);
    // designers do not read the audit log; administrators do
    expect(sources.has('audit')).toBe(false);
    expect((await s.api('GET', `/records/${r.id}/timeline?${q}`)).items.some((i: any) => i.source === 'audit')).toBe(true);
    // a process with an access list without vera: its run is not offered to her
    db().run('UPDATE processes SET acl = ? WHERE id = ?', JSON.stringify([{ subject: 'user:dana', permissions: ['view'] }]), proc.id);
    expect((await vera('GET', `/records/${r.id}/timeline?${q}`)).items.some((i: any) => i.key === 'run:run_pir')).toBe(false);
    expect(await code(dana('GET', `/records/${r.id}/timeline?from=${encodeURIComponent(from)}&to=${encodeURIComponent(from)}`))).toBe('TIMELINE_RANGE');
    const keys = c.items.filter((i: any) => i.source !== 'ticket').map((i: any) => i.key);
    const updated = await dana('POST', `/records/${r.id}/timeline`, { from, to, keys });
    const section = updated.body.slice(updated.body.indexOf('## Timeline'), updated.body.indexOf('## What went well'));
    expect(section).toContain(`${mon.name}: up → down – timeout`);
    expect(section).toContain(`Run of "${proc.name}" failed: HTTP 503`);
    expect(updated.body.indexOf('## What went well')).toBeGreaterThan(updated.body.indexOf('## Timeline'));
    expect(await code(dana('POST', `/records/${r.id}/timeline`, { from, to, keys: ['run:nope'] }))).toBe('TIMELINE_EMPTY');
    db().run("DELETE FROM runs WHERE id = 'run_pir'");
    db().run("UPDATE processes SET acl = '[]' WHERE id = ?", proc.id);
  });

  it('starts from a closed ticket reference (its time, title and services) or a monitor outage', async () => {
    const opened = new Date(Date.now() - 5 * 3_600_000).toISOString();
    const tk = await dana('POST', '/ticket-references', {
      source: 'vendor',
      externalNumber: 'INC-4711',
      title: 'Payment provider down',
      vendor: 'PayCo',
      openedAt: opened,
      links: [{ kind: 'service', id: svc.id }],
    });
    expect(await code(dana('POST', '/incident-reviews', { source: 'ticket', ticketId: tk.id }))).toBe('INCIDENT_TICKET_OPEN');
    await dana('POST', `/ticket-references/${tk.id}/status`, { status: 'resolved' });
    expect(await status(vera('POST', '/incident-reviews', { source: 'ticket', ticketId: tk.id }))).toBe(403);
    const r = await dana('POST', '/incident-reviews', { source: 'ticket', ticketId: tk.id });
    expect(r).toMatchObject({ typeKey: 'PIR', title: 'INC-4711 Payment provider down', status: 'draft' });
    expect(r.fields.incidentStart).toBe(opened);
    expect(r.fields.incidentEnd).toBeTruthy();
    expect(r.links.map((l: any) => [l.kind, l.targetId])).toEqual([['service', svc.id]]);
    const ticket = await dana('GET', `/ticket-references/${tk.id}`);
    expect(ticket.links.some((l: any) => l.kind === 'record' && l.targetId === r.id)).toBe(true);

    const { db } = await import('../src/db.js');
    const mon = db().get<{ id: string; name: string }>('SELECT id, name FROM monitors WHERE is_template = 0 LIMIT 1')!;
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date().toISOString();
    const m = await dana('POST', '/incident-reviews', { source: 'monitor', monitorId: mon.id, from, to });
    expect(m).toMatchObject({ title: `${mon.name}: outage`, fields: { incidentStart: from, incidentEnd: to } });
    expect(m.links.map((l: any) => [l.kind, l.targetId])).toEqual([['monitor', mon.id]]);
  });

  it('lists measures in the public API', async () => {
    const r = await dana('POST', '/records', { type: 'PIR', title: 'Public', links: [{ kind: 'service', id: svc.id, note: '' }] });
    await dana('POST', `/records/${r.id}/measures`, { title: 'Write the runbook', owners: ['user:dana'], dueDate: day(20) });
    const token = (await vera('POST', '/me/tokens', { name: 'measures', scope: 'read' })).token;
    const res = await (await fetch(`${s.base}/api/v1/measures?serviceId=${svc.id}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(res.items.map((m: any) => m.title)).toContain('Write the runbook');
    expect(res.items.find((m: any) => m.title === 'Write the runbook')).toMatchObject({ recordNumber: r.number, owners: ['user:dana'], overdue: false });
  });
});

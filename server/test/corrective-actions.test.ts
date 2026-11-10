import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { instanceRule, controlPoint } from '@sm/shared';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Corrective actions (ISO/IEC 27001 clause 10.2, ADR 0029 part 3): the register (numbers, rights, limits, audit),
 * actions with owners and reminders, the status workflow, the effectiveness check by a second person
 * (correctiveAction.verify), cancelling, the suggestion sources with their defaults, keys and the settings switch,
 * confirming and dismissing, incident review measures read through as actions, the public API, MCP, the dataset and
 * evidence packs.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
const OWN = 'Own-password-123';
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client, otto: Client;
let svcA: string, svcB: string;
let c518: string, c813: string;
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
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
const auditOf = async (entityId: string) =>
  (await s.api('GET', `/audit?entityId=${encodeURIComponent(entityId)}&limit=100`)).map((a: { action: string }) => a.action) as string[];

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  const users = await import('../src/auth/users.js');
  users.createUser({ username: 'otto', roles: ['operator'], password: OWN, mustChangePassword: false });
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  otto = await s.as('otto', OWN);
  svcA = (await dana('POST', '/services', { name: 'Payroll (corrective)', owners: ['user:olivia'] })).id;
  svcB = (await dana('POST', '/services', { name: 'Archive (corrective)' })).id;
  const controls = await s.api('GET', '/compliance/controls?catalogue=ISO27001');
  c518 = controls.find((c: any) => c.ref === '5.18').id;
  c813 = controls.find((c: any) => c.ref === '8.13').id;
});

describe('the register', () => {
  let id: string;

  it('records a finding from an audit with a number, controls, a service and a GRC reference', async () => {
    const f = await s.api('POST', '/compliance/corrective-actions', {
      title: 'Leavers keep database access',
      description: 'Two of five sampled leavers kept their roles for more than a week.',
      source: 'externalAudit',
      sourceLabel: 'External audit 2026, finding 4',
      sourceUrl: 'https://audit.example.com/2026/4',
      severity: 'major',
      serviceId: svcA,
      controlIds: [c518],
      owner: 'olivia',
      dueDate: day(30),
      grcRef: 'RISK-7',
      grcUrl: 'https://grc.example.com/risks/7',
    });
    id = f.id;
    expect(f.number).toMatch(/^CA-\d{4}-\d{4}$/);
    expect(f).toMatchObject({
      status: 'open',
      severity: 'major',
      serviceName: 'Payroll (corrective)',
      owner: 'olivia',
      grcRef: 'RISK-7',
      controls: [{ ref: '5.18', catalogueKey: 'ISO27001' }],
      sourceRef: { kind: 'url', label: 'External audit 2026, finding 4', path: 'https://audit.example.com/2026/4' },
      actions: [],
    });
    const next = await s.api('POST', '/compliance/corrective-actions', { title: 'Second', source: 'internalAudit' });
    expect(Number(next.number.slice(-4))).toBe(Number(f.number.slice(-4)) + 1);
    expect(await auditOf(id)).toContain('corrective.finding_created');
  });

  it('validates the input', async () => {
    expect(await code(s.api('POST', '/compliance/corrective-actions', { title: 'x', source: 'internalAudit', controlIds: ['ctl_missing'] }))).toBe(
      'CA_CONTROL_UNKNOWN',
    );
    expect(await code(s.api('POST', '/compliance/corrective-actions', { title: 'x', source: 'internalAudit', serviceId: 'svc_missing' }))).toBe(
      'CA_SERVICE_UNKNOWN',
    );
    expect(await code(s.api('POST', '/compliance/corrective-actions', { title: 'x', source: 'internalAudit', owner: 'nobody' }))).toBe('USER_UNKNOWN');
    expect(await status(s.api('POST', '/compliance/corrective-actions', { title: 'x', source: 'internalAudit', grcUrl: 'javascript:alert(1)' }))).toBe(400);
    expect(await status(s.api('POST', '/compliance/corrective-actions', { title: 'x', source: 'duty' }))).toBe(400);
    expect(await status(s.api('POST', '/compliance/corrective-actions', { title: 'x', source: 'internalAudit', dueDate: '2026-02-30' }))).toBe(400);
  });

  it('lets designers, administrators and the editors of the service record findings', async () => {
    // olivia owns service A: she records findings there, not for service B or without a service
    const own = await olivia('POST', '/compliance/corrective-actions', { title: 'Own service', source: 'other', serviceId: svcA });
    expect(own.permissions.edit).toBe(true);
    expect(await status(olivia('POST', '/compliance/corrective-actions', { title: 'Other', source: 'other', serviceId: svcB }))).toBe(403);
    expect(await status(olivia('POST', '/compliance/corrective-actions', { title: 'None', source: 'other' }))).toBe(403);
    expect(await status(otto('POST', '/compliance/corrective-actions', { title: 'x', source: 'other', serviceId: svcA }))).toBe(403);
    expect((await dana('POST', '/compliance/corrective-actions', { title: 'Designer', source: 'other', serviceId: svcB })).status).toBe('open');
    expect((await olivia('GET', '/compliance/corrective-actions')).canCreate).toBe(true);
    expect((await otto('GET', '/compliance/corrective-actions')).canCreate).toBe(false);
  });

  it('shows findings to the roles that read the register, owners and the editors of the service only', async () => {
    const numbers = async (c: Client) => (await c('GET', '/compliance/corrective-actions')).items.map((x: any) => x.id);
    expect(await numbers(audrey)).toContain(id);
    expect(await numbers(adam)).toContain(id);
    expect(await numbers(olivia)).toContain(id);
    expect(await numbers(otto)).not.toContain(id);
    expect(await numbers(vera)).toEqual([]);
    // the sidebar: the viewer has nothing there, and is told that findings exist she may not see
    expect((await vera('GET', '/me/visibility')).areas.correctiveActions).toEqual({ show: false, hiddenByPermissions: true });
    expect((await olivia('GET', '/me/visibility')).areas.correctiveActions.show).toBe(true);
    expect(await status(otto('GET', `/compliance/corrective-actions/${id}`))).toBe(404);
    expect(await status(vera('GET', `/compliance/corrective-actions/${id}`))).toBe(404);
    // by number too
    const f = await s.api('GET', `/compliance/corrective-actions/${id}`);
    expect((await audrey('GET', `/compliance/corrective-actions/${f.number}`)).id).toBe(id);
    expect((await audrey('GET', `/compliance/corrective-actions/${id}`)).permissions).toMatchObject({ edit: false, cancel: false });
    // filters
    expect((await s.api('GET', `/compliance/corrective-actions?controlId=${c518}`)).items.map((x: any) => x.id)).toEqual([id]);
    expect((await s.api('GET', '/compliance/corrective-actions?severity=major&source=externalAudit')).items.map((x: any) => x.id)).toEqual([id]);
    expect((await s.api('GET', '/compliance/corrective-actions?state=closed')).items).toEqual([]);
  });

  it('changes a finding (editors only) and audits what changed', async () => {
    expect(await status(audrey('PUT', `/compliance/corrective-actions/${id}`, { title: 'x' }))).toBe(403);
    expect(await status(adam('PUT', `/compliance/corrective-actions/${id}`, { title: 'x' }))).toBe(403);
    const f = await olivia('PUT', `/compliance/corrective-actions/${id}`, { cause: 'Leavers reported by e-mail only', controlIds: [c518, c813] });
    expect(f.cause).toBe('Leavers reported by e-mail only');
    expect(f.controls.map((c: any) => c.ref)).toEqual(['5.18', '8.13']);
    // olivia may not move it to a service she does not edit
    expect(await status(olivia('PUT', `/compliance/corrective-actions/${id}`, { serviceId: svcB }))).toBe(403);
    const audit = await s.api('GET', `/audit?entityId=${id}&action=corrective.finding_changed&limit=5`);
    expect(audit[0].details).toMatchObject({ fields: ['cause', 'controlIds'] });
  });

  it('refuses changes with an API token: decisions are taken in the app', async () => {
    const token = (await s.api('POST', '/me/tokens', { name: 'ca-write', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/compliance/corrective-actions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'by token', source: 'other' }),
    });
    expect(res.status).toBe(403);
    const read = await fetch(`${s.base}/api/compliance/corrective-actions`, { headers: { authorization: `Bearer ${token}` } });
    expect(read.status).toBe(200);
  });
});

describe('actions, the status workflow and the effectiveness check', () => {
  let id: string;
  let action: string;

  it('is implemented only with actions, all of them done', async () => {
    id = (await s.api('POST', '/compliance/corrective-actions', { title: 'Backups untested', source: 'internalAudit', serviceId: svcA, owner: 'adam' })).id;
    expect(await code(olivia('PUT', `/compliance/corrective-actions/${id}`, { status: 'implemented' }))).toBe('CA_NO_ACTIONS');
    expect(await code(olivia('POST', `/compliance/corrective-actions/${id}/actions`, { title: 'x', owners: ['user:nobody'], dueDate: day(5) }))).toBe(
      'USER_UNKNOWN',
    );
    const f = await olivia('POST', `/compliance/corrective-actions/${id}/actions`, { title: 'Run a restore test', owners: ['user:otto'], dueDate: day(5) });
    action = f.actions[0].id;
    // adding an action starts the work
    expect(f.status).toBe('inProgress');
    expect(f.actionsOpen).toBe(1);
    expect(await code(olivia('PUT', `/compliance/corrective-actions/${id}`, { status: 'implemented' }))).toBe('CA_ACTIONS_OPEN');
  });

  it('lets the owners of an action see the finding and mark the action done, nothing else', async () => {
    const seen = await otto('GET', `/compliance/corrective-actions/${id}`);
    expect(seen.actions[0]).toMatchObject({ canEdit: false, canMarkDone: true });
    expect(await status(otto('PUT', `/compliance/corrective-actions/${id}/actions/${action}`, { title: 'renamed' }))).toBe(403);
    expect(await status(otto('PUT', `/compliance/corrective-actions/${id}`, { title: 'renamed' }))).toBe(403);
    const done = await otto('PUT', `/compliance/corrective-actions/${id}/actions/${action}`, { done: true, note: 'Restored to the test system' });
    expect(done.actions[0]).toMatchObject({ doneBy: 'otto', note: 'Restored to the test system' });
    const f = await olivia('PUT', `/compliance/corrective-actions/${id}`, { status: 'implemented' });
    expect(f.status).toBe('implemented');
    expect(await auditOf(id)).toEqual(expect.arrayContaining(['corrective.action_added', 'corrective.action_done', 'corrective.finding_changed']));
  });

  it('is checked by a second person: not the owner, an action owner or who marked an action done', async () => {
    expect(await status(olivia('POST', `/compliance/corrective-actions/${id}/effectiveness`, { method: 'x', result: 'effective' }))).toBe(403);
    expect(await status(otto('POST', `/compliance/corrective-actions/${id}/effectiveness`, { method: 'x', result: 'effective' }))).toBe(403);
    // adam owns the finding
    expect((await adam('GET', `/compliance/corrective-actions/${id}`)).permissions).toMatchObject({ verify: false, verifyBlocked: 'ownPart', fourEyes: true });
    expect(await code(adam('POST', `/compliance/corrective-actions/${id}/effectiveness`, { method: 'Sample', result: 'effective' }))).toBe('CA_FOUR_EYES');
    // not effective: back to work
    const back = await dana('POST', `/compliance/corrective-actions/${id}/effectiveness`, { method: 'Restore of last week', result: 'notEffective' });
    expect(back).toMatchObject({ status: 'inProgress', effectiveness: { result: 'notEffective', checkedBy: 'dana' } });
    expect(await code(dana('POST', `/compliance/corrective-actions/${id}/effectiveness`, { method: 'x', result: 'effective' }))).toBe('CA_NOT_IMPLEMENTED');
    // reopening and redoing the work; a reopened action after "implemented" sends it back too
    await olivia('PUT', `/compliance/corrective-actions/${id}`, { status: 'implemented' });
    expect((await olivia('PUT', `/compliance/corrective-actions/${id}/actions/${action}`, { done: false })).status).toBe('inProgress');
    await olivia('PUT', `/compliance/corrective-actions/${id}/actions/${action}`, { done: true });
    await olivia('PUT', `/compliance/corrective-actions/${id}`, { status: 'implemented' });
    // olivia marked it done now: she may not check it (and is no checker anyway); dana did check before and may again
    const closed = await s.api('POST', `/compliance/corrective-actions/${id}/effectiveness`, {
      method: 'Restore test of a full day',
      result: 'effective',
      note: 'ok',
    });
    expect(closed).toMatchObject({ status: 'closed', closedBy: 'admin', effectiveness: { result: 'effective', checkedBy: 'admin' } });
    expect(await auditOf(id)).toEqual(expect.arrayContaining(['corrective.effectiveness_checked', 'corrective.finding_closed']));
    // closed is final
    expect(await code(s.api('PUT', `/compliance/corrective-actions/${id}`, { title: 'x' }))).toBe('CA_FINDING_FINAL');
    expect(await code(s.api('POST', `/compliance/corrective-actions/${id}/actions`, { title: 'x', owners: ['user:dana'], dueDate: day(1) }))).toBe(
      'CA_FINDING_FINAL',
    );
  });

  it('has the four-eyes rule of correctiveAction.verify: required by default, may be set off', () => {
    const p = controlPoint('correctiveAction.verify')!;
    expect(instanceRule(p, { points: {} })).toMatchObject({ fourEyes: 'required', stepUp: false });
    expect(instanceRule(p, { points: { 'correctiveAction.verify': { fourEyes: 'off' } } }).fourEyes).toBe('off');
  });

  it('is cancelled by administrators only, with a reason', async () => {
    const f = await dana('POST', '/compliance/corrective-actions', { title: 'Duplicate', source: 'other', serviceId: svcB });
    expect(await status(dana('POST', `/compliance/corrective-actions/${f.id}/cancel`, { reason: 'dup' }))).toBe(403);
    expect(await status(s.api('POST', `/compliance/corrective-actions/${f.id}/cancel`, { reason: '' }))).toBe(400);
    const c = await s.api('POST', `/compliance/corrective-actions/${f.id}/cancel`, { reason: 'Recorded twice' });
    expect(c).toMatchObject({ status: 'cancelled', cancelReason: 'Recorded twice' });
    expect(await auditOf(f.id)).toContain('corrective.finding_cancelled');
  });

  it('keeps at most 50 actions per finding', async () => {
    const { db } = await import('../src/db.js');
    const f = await s.api('POST', '/compliance/corrective-actions', { title: 'Many actions', source: 'other' });
    for (let i = 0; i < 50; i++)
      db().run(
        `INSERT INTO ca_actions (id, finding_id, title, owners, due_date, note, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, '["user:dana"]', ?, '', ?, 'admin', ?, 'admin')`,
        `caa_limit_${i}`,
        f.id,
        `Action ${i}`,
        day(10),
        new Date().toISOString(),
        new Date().toISOString(),
      );
    expect(await code(s.api('POST', `/compliance/corrective-actions/${f.id}/actions`, { title: 'one more', owners: ['user:dana'], dueDate: day(1) }))).toBe(
      'CA_ACTION_LIMIT',
    );
    const ca = await import('../src/compliance/corrective.js');
    const { CA_LIMITS } = await import('@sm/shared');
    expect(CA_LIMITS).toMatchObject({ findings: 20_000, actionsPerFinding: 50, pendingSuggestions: 1000 });
    expect(typeof ca.insertFinding).toBe('function');
  });
});

describe('reminders', () => {
  it('reminds the owners before the due date, on it and weekly while overdue (once each)', async () => {
    const jobs = await import('../src/compliance/corrective-jobs.js');
    const { db } = await import('../src/db.js');
    const f = await dana('POST', '/compliance/corrective-actions', { title: 'Reminded', source: 'other', serviceId: svcB });
    const a = (await dana('POST', `/compliance/corrective-actions/${f.id}/actions`, { title: 'Rotate the key', owners: ['user:otto'], dueDate: day(2) }))
      .actions[0].id;
    await jobs.remindActions();
    await jobs.remindActions();
    await jobs.remindActions(Date.now() + 2 * DAY);
    await jobs.remindActions(Date.now() + 4 * DAY);
    await jobs.remindActions(Date.now() + 5 * DAY);
    await jobs.remindActions(Date.now() + 10 * DAY);
    await (await import('../src/notifications/service.js')).flushNotifications();
    const keys = db()
      .all<{ reminder_key: string }>('SELECT reminder_key FROM ca_action_reminders WHERE action_id = ? ORDER BY sent_at', a)
      .map((r) => r.reminder_key);
    expect(keys).toEqual(['soon', 'due', 'overdue:0', 'overdue:1']);
    const inbox = await otto('GET', '/notifications');
    const mine = (inbox.items ?? inbox).filter((n: any) => n.event === 'corrective.action_due');
    expect(mine.length).toBe(4);
    expect(mine[0].link).toBe(`/compliance/corrective-actions/${f.id}`);
    // a done action is not reminded
    await dana('PUT', `/compliance/corrective-actions/${f.id}/actions/${a}`, { done: true });
    await jobs.remindActions(Date.now() + 20 * DAY);
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM ca_action_reminders WHERE action_id = ?', a)!.n).toBe(4);
  });
});

describe('suggestions', () => {
  let dutyId: string;
  const insertPeriod = async (level: string, key: string, st: string, daysAgo = 2) => {
    const { db } = await import('../src/db.js');
    const end = new Date(Date.now() - daysAgo * DAY).toISOString();
    db().run(
      `INSERT INTO duty_periods (duty_id, period_key, period_start, period_end, grace_end, status, service_id, duty_name, process_id, process_name, level,
         interval_kind, grace_days, time_zone, evaluated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aws-iam-key-age', 'AWS IAM key age', ?, 'monthly', 0, 'UTC', ?, ?)`,
      dutyId,
      key,
      new Date(Date.now() - (daysAgo + 30) * DAY).toISOString(),
      end,
      end,
      st,
      svcA,
      'Key review',
      level,
      end,
      end,
    );
  };
  const scan = async () => (await import('../src/compliance/corrective-sources.js')).scanSuggestions(Date.now(), true);
  const pending = async (c: Client = s.api) => (await c('GET', '/compliance/corrective-suggestions')).items as any[];

  beforeAll(async () => {
    const { db } = await import('../src/db.js');
    dutyId = 'dty_corrective_test';
    const now = new Date().toISOString();
    db().run(
      `INSERT INTO service_duties (id, service_id, name, description, process_id, interval_kind, level, owners, active_from, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, 'Key review', '', 'aws-iam-key-age', 'monthly', 'mandatory', '[]', ?, ?, 'admin', ?, 'admin')`,
      dutyId,
      svcA,
      now,
      now,
      now,
    );
  });

  it('has the defaults of ADR 0029: few, clear signals on', async () => {
    const st = await s.api('GET', '/compliance/corrective-settings');
    expect(st.sources).toEqual({
      dutyMandatory: true,
      dutyRecommended: false,
      incidentMajor: true,
      incidentMinor: false,
      personReview: true,
      reconciliation: false,
    });
    expect(st.canEdit).toBe(true);
    expect((await dana('GET', '/compliance/corrective-settings')).canEdit).toBe(false);
    expect(await status(dana('PUT', '/compliance/corrective-settings', { sources: { reconciliation: true } }))).toBe(403);
  });

  it('suggests missed and failed periods of mandatory duties once; recommended ones only when switched on', async () => {
    await insertPeriod('mandatory', '2026-01', 'missed');
    await insertPeriod('recommended', '2026-02', 'failed');
    await insertPeriod('mandatory', '2025-01', 'missed', 200); // older than 90 days
    await scan();
    await scan();
    const duty = (await pending()).filter((x) => x.source === 'duty' && x.sourceKey.startsWith(`duty:${dutyId}:`));
    expect(duty.map((x) => x.sourceKey)).toEqual([`duty:${dutyId}:2026-01`]);
    expect(duty[0]).toMatchObject({ serviceId: svcA, severity: 'minor', details: { kind: 'dutyMissed', period: '2026-01' }, canDecide: true });
    // the controls the duty's process is mapped to are pre-filled (none here)
    await s.api('PUT', '/compliance/corrective-settings', { sources: { dutyRecommended: true } });
    expect(await auditOf('compliance.corrective')).toContain('corrective.settings_changed');
    await scan();
    expect(
      (await pending())
        .filter((x) => x.sourceKey.startsWith(`duty:${dutyId}:`))
        .map((x) => x.sourceKey)
        .sort(),
    ).toEqual([`duty:${dutyId}:2026-01`, `duty:${dutyId}:2026-02`]);
    await s.api('PUT', '/compliance/corrective-settings', { sources: { dutyMandatory: false, dutyRecommended: false } });
    await insertPeriod('mandatory', '2026-03', 'failed');
    await scan();
    expect((await pending()).some((x) => x.sourceKey === `duty:${dutyId}:2026-03`)).toBe(false);
    await s.api('PUT', '/compliance/corrective-settings', { sources: { dutyMandatory: true } });
  });

  it('shows suggestions of a service to its editors, all of them to the roles that read the register', async () => {
    expect((await pending(olivia)).some((x) => x.serviceId === svcA)).toBe(true);
    expect(await pending(otto)).toEqual([]);
    expect(await pending(vera)).toEqual([]);
    expect((await pending(audrey)).every((x) => x.canDecide === false)).toBe(true);
  });

  it('confirms a suggestion as a pre-filled finding, once', async () => {
    const sug = (await pending()).find((x) => x.sourceKey === `duty:${dutyId}:2026-01`);
    expect(await status(audrey('POST', `/compliance/corrective-suggestions/${sug.id}/confirm`, {}))).toBe(403);
    const f = await olivia('POST', `/compliance/corrective-suggestions/${sug.id}/confirm`, { owner: 'olivia', dueDate: day(14) });
    expect(f).toMatchObject({
      source: 'duty',
      serviceId: svcA,
      owner: 'olivia',
      severity: 'minor',
      suggestionId: sug.id,
      sourceRef: { kind: 'duty', id: dutyId, path: `/duties/${dutyId}` },
    });
    expect(await code(s.api('POST', `/compliance/corrective-suggestions/${sug.id}/confirm`, {}))).toBe('CA_SUGGESTION_DECIDED');
    const all = (await s.api('GET', '/compliance/corrective-suggestions?status=confirmed')).items;
    expect(all.find((x: any) => x.id === sug.id)).toMatchObject({ status: 'confirmed', decidedBy: 'olivia', findingNumber: f.number });
    expect(await auditOf(sug.id)).toContain('corrective.suggestion_confirmed');
    // the event is never suggested again
    await scan();
    expect((await pending()).some((x) => x.sourceKey === `duty:${dutyId}:2026-01`)).toBe(false);
  });

  it('dismisses a suggestion with a reason; it does not come back', async () => {
    const sug = (await pending()).find((x) => x.sourceKey === `duty:${dutyId}:2026-02`);
    expect(await status(s.api('POST', `/compliance/corrective-suggestions/${sug.id}/dismiss`, {}))).toBe(400);
    const d = await dana('POST', `/compliance/corrective-suggestions/${sug.id}/dismiss`, { reason: 'Recommended only, accepted risk' });
    expect(d).toMatchObject({ status: 'dismissed', reason: 'Recommended only, accepted risk', decidedBy: 'dana' });
    await s.api('PUT', '/compliance/corrective-settings', { sources: { dutyRecommended: true } });
    await scan();
    expect((await pending()).some((x) => x.sourceKey === `duty:${dutyId}:2026-02`)).toBe(false);
    await s.api('PUT', '/compliance/corrective-settings', { sources: { dutyRecommended: false } });
    expect(await auditOf(sug.id)).toContain('corrective.suggestion_dismissed');
  });

  it('suggests accepted incident reviews of severity major or critical; minor ones only when switched on', async () => {
    const review = async (title: string, severity: string) => {
      const r = await dana('POST', '/records', { type: 'PIR', title, links: [{ kind: 'service', id: svcB, note: '' }] });
      await dana('PUT', `/records/${r.id}`, { fields: { incidentStart: new Date().toISOString(), severity, impact: 'Orders failed' }, baseVersion: r.version });
      await dana('POST', `/records/${r.id}/transition`, { action: 'propose' });
      await adam('POST', `/records/${r.id}/transition`, { action: 'accept' });
      return r.id as string;
    };
    const major = await review('Checkout outage', 'critical');
    const minor = await review('Slow search', 'minor');
    const draft = await dana('POST', '/records', { type: 'PIR', title: 'Not accepted' });
    await scan();
    const keys = (await pending()).map((x) => x.sourceKey);
    expect(keys).toContain(`incident:${major}`);
    expect(keys).not.toContain(`incident:${minor}`);
    expect(keys).not.toContain(`incident:${draft.id}`);
    expect((await pending()).find((x) => x.sourceKey === `incident:${major}`)).toMatchObject({
      source: 'incidentReview',
      severity: 'major',
      serviceId: svcB,
      recordId: major,
      details: { kind: 'incident', severity: 'critical' },
    });
    await s.api('PUT', '/compliance/corrective-settings', { sources: { incidentMinor: true } });
    await scan();
    expect((await pending()).map((x) => x.sourceKey)).toContain(`incident:${minor}`);
    await s.api('PUT', '/compliance/corrective-settings', { sources: { incidentMinor: false } });
  });

  it('reads the measures of the incident review as the actions of its finding', async () => {
    const sug = (await pending()).find((x) => x.source === 'incidentReview' && x.severity === 'major');
    const f = await dana('POST', `/compliance/corrective-suggestions/${sug.id}/confirm`, {});
    expect(f.record).toMatchObject({ id: sug.recordId, visible: true });
    await dana('POST', `/records/${sug.recordId}/measures`, { title: 'Add a second payment provider', owners: ['user:olivia'], dueDate: day(20) });
    let g = await dana('GET', `/compliance/corrective-actions/${f.id}`);
    expect(g.actions).toEqual([expect.objectContaining({ title: 'Add a second payment provider', measure: true, owners: ['user:olivia'] })]);
    expect(g).toMatchObject({ actionsTotal: 1, actionsOpen: 1 });
    // adding an action there adds a measure to the review
    g = await dana('POST', `/compliance/corrective-actions/${f.id}/actions`, { title: 'Alert on payment errors', owners: ['user:dana'], dueDate: day(10) });
    expect(g.actions.map((a: any) => a.title).sort()).toEqual(['Add a second payment provider', 'Alert on payment errors']);
    const measures = await dana('GET', `/records/${sug.recordId}/measures`);
    expect(measures.items.map((m: any) => m.title).sort()).toEqual(['Add a second payment provider', 'Alert on payment errors']);
    // no copies in ca_actions; /api/v1/measures and the reminders stay as they were
    const { db } = await import('../src/db.js');
    expect(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM ca_actions WHERE finding_id = ?', f.id)!.n).toBe(0);
    const token = (await dana('POST', '/me/tokens', { name: 'measures-ca', scope: 'read' })).token;
    const v1 = await (await fetch(`${s.base}/api/v1/measures?serviceId=${svcB}`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(v1.items.map((m: any) => m.title).sort()).toEqual(['Add a second payment provider', 'Alert on payment errors']);
    // the owner of a measure sees the finding and marks the action done through it
    const mid = g.actions.find((a: any) => a.title === 'Add a second payment provider').id;
    const done = await olivia('PUT', `/compliance/corrective-actions/${f.id}/actions/${mid}`, { done: true });
    expect(done.actions.find((a: any) => a.id === mid).doneBy).toBe('olivia');
    expect(await auditOf(f.id)).toEqual(expect.arrayContaining(['corrective.action_added', 'corrective.action_done']));
    const removed = await dana('DELETE', `/compliance/corrective-actions/${f.id}/actions/${mid}`);
    expect(removed.actionsTotal).toBe(1);
  });

  it('suggests person reviews whose removals are still there 30 days after approval', async () => {
    const { db } = await import('../src/db.js');
    const approved = new Date(Date.now() - 35 * DAY).toISOString();
    const recent = new Date(Date.now() - 5 * DAY).toISOString();
    const add = (id: string, at: string, st: string, recheck: string | null) => {
      db().run(
        `INSERT INTO person_reviews (id, title, person_name, identifiers, sources, status, created_by, created_at, approved_by, approved_at)
         VALUES (?, ?, 'Leaver', '[]', '[]', ?, 'dana', ?, 'adam', ?)`,
        id,
        `Review ${id}`,
        st,
        at,
        at,
      );
      db().run(
        `INSERT INTO person_review_items (id, review_id, seq, check_id, subject_id, right_name, decision, recheck) VALUES (?, ?, 1, 'chk_x', 'leaver', 'admin', 'remove', ?)`,
        `${id}_i`,
        id,
        recheck,
      );
    };
    add('prv_ca_old', approved, 'approved', 'present');
    add('prv_ca_new', recent, 'approved', null);
    add('prv_ca_gone', approved, 'approved', 'gone');
    await scan();
    const keys = (await pending()).map((x) => x.sourceKey);
    expect(keys).toContain('personReview:prv_ca_old');
    expect(keys).not.toContain('personReview:prv_ca_new');
    expect(keys).not.toContain('personReview:prv_ca_gone');
    expect((await pending()).find((x) => x.sourceKey === 'personReview:prv_ca_old')).toMatchObject({ source: 'accessReview', details: { count: 1 } });
    // only the roles that read the register: the suggestion has no service
    expect((await pending(olivia)).some((x) => x.sourceKey === 'personReview:prv_ca_old')).toBe(false);
  });

  it('suggests reconciliation findings open for more than seven days only when switched on, one per check and week', async () => {
    const { db } = await import('../src/db.js');
    const check = (await s.api('GET', '/compliance/access-checks'))[0];
    const snap = db().get<{ id: string }>('SELECT id FROM access_snapshots WHERE check_id = ? ORDER BY seq LIMIT 1', check.id)!.id;
    const finding = (n: number, daysAgo: number) =>
      db().run(
        `INSERT INTO access_findings (id, check_id, platform_id, snapshot_id, prev_snapshot_id, detected_at, window_from, window_to, subject_id, kind, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'grant', 'open')`,
        `afd_ca_${n}`,
        check.id,
        check.platformId,
        snap,
        snap,
        new Date(Date.now() - daysAgo * DAY).toISOString(),
        new Date(Date.now() - (daysAgo + 1) * DAY).toISOString(),
        new Date(Date.now() - daysAgo * DAY).toISOString(),
        `user-${n}`,
      );
    finding(1, 9);
    finding(2, 12);
    finding(3, 2);
    await scan();
    expect((await pending()).some((x) => x.source === 'reconciliation')).toBe(false);
    await s.api('PUT', '/compliance/corrective-settings', { sources: { reconciliation: true } });
    const sources = await import('../src/compliance/corrective-sources.js');
    sources.scanSuggestions(Date.now(), true);
    sources.scanSuggestions(Date.now() + 60_000, true);
    const rec = (await pending()).filter((x) => x.source === 'reconciliation' && x.sourceKey.startsWith(`reconciliation:${check.id}:`));
    expect(rec).toHaveLength(1);
    expect(rec[0].details).toMatchObject({ kind: 'reconciliation', count: 2, days: 7 });
    // a week later: one more for the same check
    sources.scanSuggestions(Date.now() + 7 * DAY, true);
    expect((await pending()).filter((x) => x.sourceKey.startsWith(`reconciliation:${check.id}:`))).toHaveLength(2);
    await s.api('PUT', '/compliance/corrective-settings', { sources: { reconciliation: false } });
  });

  it('keeps at most 1,000 pending suggestions: further ones wait', async () => {
    const { db } = await import('../src/db.js');
    const n = Number(db().get<{ n: number }>("SELECT COUNT(*) AS n FROM ca_suggestions WHERE status = 'pending'")!.n);
    db().tx(() => {
      for (let i = n; i < 1000; i++)
        db().run(
          `INSERT INTO ca_suggestions (id, source, source_key, title, severity, occurred_at, status, created_at) VALUES (?, 'other', ?, 'filler', 'minor', ?, 'pending', ?)`,
          `cas_fill_${i}`,
          `fill:${i}`,
          new Date().toISOString(),
          new Date().toISOString(),
        );
    });
    await insertPeriod('mandatory', '2026-04', 'missed');
    const sources = await import('../src/compliance/corrective-sources.js');
    expect(sources.scanSuggestions(Date.now(), true)).toMatchObject({ added: 0, waiting: 1 });
    const list = await s.api('GET', '/compliance/corrective-suggestions');
    expect(list).toMatchObject({ atLimit: true, limit: 1000 });
    db().run("DELETE FROM ca_suggestions WHERE source_key LIKE 'fill:%'");
    expect(sources.scanSuggestions(Date.now(), true).added).toBe(1);
    expect((await s.api('GET', '/compliance/corrective-suggestions')).atLimit).toBe(false);
  });

  it('has an extension point for further sources (the supplier review)', async () => {
    const sources = await import('../src/compliance/corrective-sources.js');
    sources.registerSuggestionSource({
      name: 'test-source',
      collect: () => [
        {
          source: 'supplierReview',
          sourceKey: 'test:certificate:1',
          sourceKind: null,
          sourceId: null,
          sourceLabel: 'Certificate of an invented supplier',
          serviceId: null,
          controlIds: [],
          recordId: null,
          title: 'Certificate expired',
          details: { kind: 'other' },
          severity: 'minor',
          occurredAt: new Date().toISOString(),
        },
      ],
    });
    sources.scanSuggestions(Date.now(), true);
    expect((await pending()).find((x) => x.sourceKey === 'test:certificate:1')).toMatchObject({ source: 'supplierReview' });
  });
});

describe('reading through the API, MCP, the dataset and evidence packs', () => {
  it('serves /api/v1/corrective-actions with the token owner’s rights', async () => {
    const token = async (c: Client, name: string) => (await c('POST', '/me/tokens', { name, scope: 'read' })).token as string;
    const v1 = async (t: string, p: string) => {
      const res = await fetch(`${s.base}/api/v1${p}`, { headers: { authorization: `Bearer ${t}` } });
      return { status: res.status, json: await res.json() };
    };
    const a = await token(audrey, 'ca-audrey');
    const all = await v1(a, '/corrective-actions?limit=200');
    expect(all.status).toBe(200);
    expect(all.json.items.length).toBeGreaterThan(3);
    const major = await v1(a, '/corrective-actions?severity=major&status=open&status=inProgress');
    expect(major.json.items.every((x: any) => x.severity === 'major' && ['open', 'inProgress'].includes(x.status))).toBe(true);
    const one = all.json.items.find((x: any) => x.title === 'Leavers keep database access');
    const detail = await v1(a, `/corrective-actions/${one.number}`);
    expect(detail.json).toMatchObject({ id: one.id, grcRef: 'RISK-7', sourceRef: { kind: 'url' } });
    expect(detail.json.permissions).toBeUndefined();
    expect((await v1(a, '/corrective-actions/caf_missing')).status).toBe(404);
    const v = await token(vera, 'ca-vera');
    expect((await v1(v, '/corrective-actions')).json.items).toEqual([]);
    expect((await v1(v, `/corrective-actions/${one.id}`)).status).toBe(404);
  });

  it('offers the MCP tool list_corrective_actions', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    const token = (await audrey('POST', '/me/tokens', { name: 'ca-mcp', scope: 'mcp' })).token as string;
    const call = async (args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': 'list_corrective_actions',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'list_corrective_actions',
            arguments: args,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
            },
          },
        }),
      });
      return (await res.json()).result;
    };
    const r = await call({ state: 'all', limit: 100 });
    expect(r.structuredContent.items.some((x: any) => x.title === 'Leavers keep database access')).toBe(true);
    const closed = await call({ state: 'closed' });
    expect(closed.structuredContent.items.every((x: any) => ['closed', 'cancelled'].includes(x.status))).toBe(true);
    const one = r.structuredContent.items.find((x: any) => x.title === 'Backups untested');
    const d = await call({ findingId: one.number });
    expect(d.structuredContent).toMatchObject({ status: 'closed', effectiveness: { result: 'effective' } });
    expect((await call({ findingId: 'CA-1999-0001' })).isError).toBe(true);
  });

  it('publishes the dataset compliance.correctiveActions for administrators and auditors', async () => {
    const jobs = await import('../src/compliance/corrective-jobs.js');
    expect(jobs.publishCorrectiveDataset(true)).toBe(true);
    const ds = await audrey('GET', '/datasets/compliance.correctiveActions');
    expect(ds.rows.some((r: any) => r.Title === 'Leavers keep database access' && r.Severity === 'major')).toBe(true);
    expect(await status(olivia('GET', '/datasets/compliance.correctiveActions'))).toBe(404);
  });

  it('puts the findings naming the pack’s controls into evidence packs', async () => {
    const p = await s.api('POST', '/compliance/evidence-packs', {
      title: 'Access control evidence',
      scope: { controlIds: [c518] },
      from: new Date(Date.now() - DAY).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });
    let pack = p;
    for (let i = 0; i < 600 && pack.status === 'building'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      pack = await s.api('GET', `/compliance/evidence-packs/${p.id}`);
    }
    expect(pack.status).toBe('ready');
    const { ZipReader } = await import('../src/compliance/zip.js');
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const { packsDir } = await import('../src/compliance/evidence-pack.js');
    const file = path.join(packsDir(), `${p.id}.zip`);
    expect(fs.existsSync(file)).toBe(true);
    const zip = await ZipReader.open(file);
    const findings = JSON.parse((await zip.read(zip.find('corrective-actions/findings.json')!)).toString());
    expect(findings.map((f: any) => f.title)).toContain('Leavers keep database access');
    expect(findings.every((f: any) => f.controls.some((c: any) => c.id === c518))).toBe(true);
    expect(findings[0].permissions).toBeUndefined();
    expect((await zip.read(zip.find('corrective-actions/findings.csv')!)).toString()).toContain('Leavers keep database access');
    expect((await verifyPack(file)).ok).toBe(true);
  });
});

describe('the module switch', () => {
  it('answers 404 MODULE_OFF while the Compliance module is off', async () => {
    await s.api('PUT', '/settings/modules/compliance', { enabled: false });
    try {
      expect(await code(s.api('GET', '/compliance/corrective-actions'))).toBe('MODULE_OFF');
    } finally {
      await s.api('PUT', '/settings/modules/compliance', { enabled: true });
    }
    expect((await s.api('GET', '/compliance/corrective-actions')).items.length).toBeGreaterThan(0);
  });
});

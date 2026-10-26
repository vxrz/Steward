import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tinyPng } from './png.js';
import { authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Manual steps (user task mode "manual", #83): checklist, fields, evidence files, "not available" reasons,
 * second-person verification (maker–checker) and after-the-fact entries.
 */
let s: TestServer;
const PW = 'Demo-password-1';
let olivia: Client, adam: Client, dana: Client, vera: Client, audrey: Client;
const cookies: Record<string, string> = {};

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { body?: { code?: string } }) => e.body?.code ?? 'no code',
  );

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {}); // dana designer, olivia operator, adam approver, audrey auditor, vera viewer; team "Service Desk" (olivia, adam)
  [olivia, adam, dana, vera, audrey] = await Promise.all(['olivia', 'adam', 'dana', 'vera', 'audrey'].map((u) => s.as(u, PW)));
  for (const u of ['olivia', 'adam', 'dana', 'vera']) cookies[u] = await loginCookie(s.base, u, PW);
  cookies.admin = await loginCookie(s.base, 'admin', 'Admin-password-1');
});
afterAll(async () => {
  await s?.app.close();
});

let n = 0;
/** Creates a process with the given steps (as admin) and starts it as `starter`; returns the run id and its first open task. */
async function start(
  steps: unknown[],
  starter: Client = olivia,
  extra: Record<string, unknown> = {},
): Promise<{ runId: string; task: any; processId: string }> {
  const p = await s.api('POST', '/processes', { definition: { name: `Manual ${++n} ${Date.now()}`, steps, ...extra } });
  const { id } = await starter('POST', '/runs', { processId: p.id });
  const run = await s.waitRun(id);
  expect(run.status, run.error).toBe('waiting');
  return { runId: id, task: run.tasks.find((t: any) => t.status === 'open'), processId: p.id };
}

const getTask = (c: Client, id: string) => c('GET', `/tasks/${id}`);

async function upload(user: string, taskId: string, filename: string, data: Buffer | string): Promise<{ status: number; body: any }> {
  const form = new FormData();
  form.append('file', new Blob([typeof data === 'string' ? data : new Uint8Array(data)]), filename);
  const res = await fetch(`${s.base}/api/tasks/${taskId}/evidence`, {
    method: 'POST',
    headers: { ...authHeaders(cookies[user]!), 'x-sm-client': '1' },
    body: form,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function auditOf(runId: string): Promise<any[]> {
  return (await s.api('GET', `/audit?runId=${runId}&limit=200`)) as any[];
}

const MANUAL = {
  id: 'replace',
  type: 'userTask',
  mode: 'manual',
  title: 'Replace the gateway',
  instructions: '## Steps\n\n- Switch off **line 3**\n- <script>alert(1)</script>',
  checklist: ['Line switched off', 'Gateway replaced', 'Line switched on'],
  checklistAllRequired: true,
  fields: [
    { id: 'ticket', type: 'ticket', label: 'Change ticket', use: 'required' },
    { id: 'serial', type: 'text', label: 'Serial number', hint: 'On the label', use: 'optional' },
    { id: 'minutes', type: 'number', label: 'Downtime (minutes)' },
    { id: 'link', type: 'link', label: 'Vendor case' },
    { id: 'when', type: 'datetime', label: 'Line back up' },
    { id: 'old', type: 'text', label: 'Old field', use: 'off' },
  ],
  evidence: 'required',
};

describe('checklist, fields and evidence', () => {
  it('checks the checklist and the fields, needs the evidence, and records everything', async () => {
    const { runId, task } = await start([MANUAL]);
    expect(task).toMatchObject({ mode: 'manual', manual: { stage: 'work', round: 1 } });
    expect(task.manual.spec.fields.map((f: any) => f.id)).toEqual(['ticket', 'serial', 'minutes', 'link', 'when']); // "off" is not asked
    const all = { checked: [0, 1, 2], fields: [{ id: 'ticket', value: 'CHG-1001' }] };

    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { ...all, checked: [0, 2] }))).toBe('MANUAL_CHECKLIST_INCOMPLETE');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { ...all, checked: [0, 1, 2, 7] }))).toBe('MANUAL_CHECKLIST_INVALID');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { ...all, fields: [] }))).toBe('MANUAL_FIELD_REQUIRED');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { ...all, fields: [...all.fields, { id: 'minutes', value: 'twelve' }] }))).toBe(
      'MANUAL_FIELD_INVALID',
    );
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { ...all, fields: [...all.fields, { id: 'link', value: 'javascript:alert(1)' }] }))).toBe(
      'MANUAL_FIELD_INVALID',
    );
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { ...all, fields: [...all.fields, { id: 'old', value: 'x' }] }))).toBe(
      'MANUAL_FIELD_UNKNOWN',
    );
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { ...all, extra: 1 }))).not.toBe('ok');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, all))).toBe('MANUAL_EVIDENCE_REQUIRED');

    // evidence: allow-listed types whose content matches, only by whoever may work on the step
    expect((await upload('olivia', task.id, 'page.html', '<html><script>alert(1)</script></html>')).status).toBe(415);
    expect((await upload('olivia', task.id, 'photo.png', 'not a png')).status).toBe(415);
    expect((await upload('vera', task.id, 'photo.png', tinyPng())).status).toBe(403);
    const wrong = await upload('olivia', task.id, 'wrong.txt', 'oops');
    expect(wrong.status).toBe(200);
    await olivia('DELETE', `/tasks/${task.id}/evidence/${wrong.body.id}`);
    const photo = await upload('olivia', task.id, 'gateway photo.png', tinyPng());
    expect(photo.status).toBe(200);
    expect(photo.body).toMatchObject({ filename: 'gateway photo.png', mime: 'image/png', size: tinyPng().length, uploadedBy: 'olivia', round: 1 });
    expect(photo.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    await olivia('POST', `/tasks/${task.id}/complete`, {
      ...all,
      fields: [
        { id: 'ticket', value: 'CHG-1001' },
        { id: 'serial', value: ' SN-42 ' },
        { id: 'minutes', value: '12,5' },
        { id: 'link', value: 'https://vendor.example.com/case/7' },
        { id: 'when', value: '2026-10-26T10:00:00Z' },
      ],
      comment: 'all fine',
    });
    const run = await s.waitRun(runId, ['succeeded', 'failed']);
    expect([run.status, run.error]).toEqual(['succeeded', null]);
    const done = run.tasks[0];
    expect(done).toMatchObject({ status: 'completed', decidedBy: 'olivia', manual: { stage: 'done', verification: null } });
    expect(done.manual.submission).toMatchObject({ checked: [0, 1, 2], completedBy: 'olivia', comment: 'all fine', verificationReasons: [] });
    expect(done.manual.submission.fields).toEqual([
      { id: 'ticket', value: 'CHG-1001', ticketId: null },
      { id: 'serial', value: 'SN-42' },
      { id: 'minutes', value: 12.5 },
      { id: 'link', value: 'https://vendor.example.com/case/7' },
      { id: 'when', value: '2026-10-26T10:00:00.000Z' },
    ]);
    // the step's output for later steps
    const step = run.steps.find((x: any) => x.stepId === 'replace');
    const full = await s.api('GET', `/runs/${runId}/steps/${step.id}`);
    expect(full.output).toMatchObject({ completed: true, completedBy: 'olivia', fields: { ticket: 'CHG-1001', minutes: 12.5 }, verifiedBy: null });
    expect(full.output.evidence).toEqual([{ filename: 'gateway photo.png', size: photo.body.size, sha256: photo.body.sha256 }]);

    const actions = (await auditOf(runId)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['task.created', 'task.evidence_added', 'task.evidence_removed', 'task.completed', 'run.succeeded']));
    expect(actions.filter((a) => a === 'task.evidence_added')).toHaveLength(2);
    // the protocol seal covers the manual entries
    const detail = await s.api('GET', `/runs/${runId}/report.json`);
    const { sealedProtocolHash } = await import('../src/audit.js');
    expect(sealedProtocolHash(runId)).toBe(detail.protocolHash);
  });

  it('serves evidence as a download to whoever may see the run, and refuses a changed file', async () => {
    const { runId, task } = await start([{ ...MANUAL, id: 'm2', checklistAllRequired: false, fields: [] }]);
    const up = await upload('olivia', task.id, 'notes.txt', 'checked <b>ok</b>');
    const url = `${s.base}/api/tasks/${task.id}/evidence/${up.body.id}/download`;
    for (const u of ['vera', 'adam']) {
      const res = await fetch(url, { headers: authHeaders(cookies[u]!) });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="notes.txt"/);
      expect(res.headers.get('content-security-policy')).toContain('sandbox');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await res.text()).toBe('checked <b>ok</b>');
    }
    // a process vera may not see: 404 for the task and its files
    const { db } = await import('../src/db.js');
    const pid = db().get<{ process_id: string }>('SELECT process_id FROM runs WHERE id = ?', runId)!.process_id;
    await s.api('PUT', `/processes/${pid}/access`, { acl: [{ subject: 'role:operator', permissions: ['view', 'run'] }] });
    expect((await fetch(url, { headers: authHeaders(cookies.vera!) })).status).toBe(404);
    expect(await status(vera('GET', `/tasks/${task.id}`))).toBe(404);
    // changed on disk
    const row = db().get<{ path: string }>('SELECT path FROM run_task_evidence WHERE id = ?', up.body.id)!;
    const fs = await import('node:fs');
    const { evidenceFile } = await import('../src/engine/manual.js');
    fs.chmodSync(evidenceFile(row.path), 0o600);
    fs.writeFileSync(evidenceFile(row.path), 'tampered');
    expect((await fetch(url, { headers: authHeaders(cookies.olivia!) })).status).toBe(409);
    await s.api('POST', `/runs/${runId}/cancel`);
  });

  it('evidence off: no files; optional: completing without files is fine', async () => {
    const off = await start([{ id: 'o', type: 'userTask', mode: 'manual', title: 'No files', evidence: 'off' }]);
    expect((await upload('olivia', off.task.id, 'a.txt', 'x')).status).toBe(409);
    await olivia('POST', `/tasks/${off.task.id}/complete`, {});
    expect((await s.waitRun(off.runId, ['succeeded', 'failed'])).status).toBe('succeeded');
    const opt = await start([{ id: 'o', type: 'userTask', mode: 'manual', title: 'Optional files', checklist: ['a', 'b'] }]);
    expect(opt.task.manual.spec.evidence).toBe('optional');
    await olivia('POST', `/tasks/${opt.task.id}/complete`, { checked: [1] });
    const run = await s.waitRun(opt.runId, ['succeeded', 'failed']);
    expect(run.status).toBe('succeeded');
    expect(run.tasks[0].manual.submission.checked).toEqual([1]);
  });

  it('only people who may decide the task work on it', async () => {
    const { runId, task } = await start([{ id: 'a', type: 'userTask', mode: 'manual', title: 'Assigned', assignees: ['user:dana'] }]);
    expect(await status(vera('POST', `/tasks/${task.id}/complete`, {}))).toBe(403);
    expect(await status(audrey('POST', `/tasks/${task.id}/complete`, {}))).toBe(403);
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, {}))).toBe('TASK_ASSIGNED');
    expect((await upload('olivia', task.id, 'a.txt', 'x')).status).toBe(403);
    // an approve body is not a manual completion and vice versa
    expect(await status(dana('POST', `/tasks/${task.id}/complete`, { approved: true }))).toBe(400);
    await dana('POST', `/tasks/${task.id}/complete`, {});
    expect((await s.waitRun(runId, ['succeeded', 'failed'])).status).toBe('succeeded');
    expect(await code(dana('POST', `/tasks/${task.id}/complete`, {}))).toBe('TASK_CLOSED');
  });
});

describe('not available', () => {
  it('a reason for missing required evidence or fields forces the verification by a second person', async () => {
    const { runId, task } = await start([{ ...MANUAL, id: 'na', checklistAllRequired: false }]);
    // only for what is required and missing
    expect(
      await code(
        olivia('POST', `/tasks/${task.id}/complete`, { fields: [{ id: 'ticket', value: 'X' }], notAvailable: [{ target: 'serial', reason: 'no label' }] }),
      ),
    ).toBe('MANUAL_NOT_AVAILABLE_INVALID');
    expect(
      await code(
        olivia('POST', `/tasks/${task.id}/complete`, {
          notAvailable: [
            { target: 'ticket', reason: ' ' },
            { target: 'evidence', reason: 'x' },
          ],
        }),
      ),
    ).toBe('MANUAL_REASON_REQUIRED');
    const r = await olivia('POST', `/tasks/${task.id}/complete`, {
      notAvailable: [
        { target: 'ticket', reason: 'Emergency change, ticket follows' },
        { target: 'evidence', reason: 'Camera not allowed in the clean room' },
      ],
    });
    expect(r).toMatchObject({ ok: true, verificationNeeded: true });
    const t = await getTask(olivia, task.id);
    expect(t).toMatchObject({ status: 'open', canDecide: false, cannotDecideCode: 'VERIFY_SAME_PERSON', manual: { stage: 'verify' } });
    expect(t.manual.submission.verificationReasons).toEqual(['notAvailable']);
    expect((await s.api('GET', `/runs/${runId}`)).status).toBe('waiting');
    // the person who completed it cannot verify, nor complete again
    expect(await code(olivia('POST', `/tasks/${task.id}/verify`, { approved: true }))).toBe('VERIFY_SAME_PERSON');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, {}))).toBe('TASK_WAITS_FOR_VERIFICATION');
    expect((await upload('olivia', task.id, 'late.txt', 'x')).status).toBe(409);
    const completed = (await auditOf(runId)).find((a) => a.action === 'task.completed');
    expect(completed.summary).toContain('not available: Change ticket (Emergency change, ticket follows); evidence (Camera not allowed in the clean room)');
    expect(completed.details.notAvailable).toHaveLength(2);

    await adam('POST', `/tasks/${task.id}/verify`, { approved: true, comment: 'Confirmed with the shift lead' });
    const run = await s.waitRun(runId, ['succeeded', 'failed']);
    expect(run.status).toBe('succeeded');
    expect(run.tasks[0].manual.verification).toMatchObject({ approved: true, by: 'adam', comment: 'Confirmed with the shift lead' });
    expect((await auditOf(runId)).map((a) => a.action)).toContain('task.verified');
  });
});

describe('second-person verification', () => {
  const verified = (more: Record<string, unknown>) => ({
    id: 'v',
    type: 'userTask',
    mode: 'manual',
    title: 'Verified step',
    verification: { required: true, ...more },
  });

  it('a verifier list (team) is strict, and the run starter can be excluded', async () => {
    const { runId, task } = await start([verified({ verifiers: ['team:Service Desk'], notRunStarter: true })], olivia);
    await dana('POST', `/tasks/${task.id}/complete`, { comment: 'done' });
    expect(await code(dana('POST', `/tasks/${task.id}/verify`, { approved: true }))).toBe('VERIFY_SAME_PERSON');
    expect(await code(olivia('POST', `/tasks/${task.id}/verify`, { approved: true }))).toBe('VERIFY_RUN_STARTER');
    // no administrator override for a verifier list
    expect(await code(s.api('POST', `/tasks/${task.id}/verify`, { approved: true }))).toBe('VERIFY_ASSIGNED');
    expect(await status(vera('POST', `/tasks/${task.id}/verify`, { approved: true }))).toBe(403);
    // the waiting-for-you lists: adam may verify, dana (who completed it) may not
    expect((await adam('GET', '/tasks?status=open&mine=1')).map((t: any) => t.id)).toContain(task.id);
    expect((await dana('GET', '/tasks?status=open&mine=1')).map((t: any) => t.id)).not.toContain(task.id);
    expect((await adam('GET', '/dashboard')).openTasks.map((t: any) => t.id)).toContain(task.id);
    await adam('POST', `/tasks/${task.id}/verify`, { approved: true });
    const run = await s.waitRun(runId, ['succeeded', 'failed']);
    expect(run.status).toBe('succeeded');
    expect(run.tasks[0]).toMatchObject({ decidedBy: 'dana', manual: { verification: { by: 'adam', approved: true } } });
  });

  it('a role restriction, and the default: everyone with run or approve rights but the completer', async () => {
    const role = await start([verified({ verifiers: ['role:approver'] })]);
    await olivia('POST', `/tasks/${role.task.id}/complete`, {});
    expect(await code(dana('POST', `/tasks/${role.task.id}/verify`, { approved: true }))).toBe('VERIFY_ASSIGNED');
    await adam('POST', `/tasks/${role.task.id}/verify`, { approved: true });
    expect((await s.waitRun(role.runId, ['succeeded', 'failed'])).status).toBe('succeeded');

    const any = await start([verified({})]);
    await olivia('POST', `/tasks/${any.task.id}/complete`, {});
    expect(await code(audrey('POST', `/tasks/${any.task.id}/verify`, { approved: true }))).toBe('VERIFY_RIGHTS');
    await dana('POST', `/tasks/${any.task.id}/verify`, { approved: true });
    expect((await s.waitRun(any.runId, ['succeeded', 'failed'])).status).toBe('succeeded');
  });

  it('the verifier is notified', async () => {
    const { flushNotifications } = await import('../src/notifications/service.js');
    const { task } = await start([verified({ verifiers: ['user:adam'] })]);
    await olivia('POST', `/tasks/${task.id}/complete`, {});
    await new Promise((r) => setTimeout(r, 50));
    await flushNotifications();
    const list = await adam('GET', '/notifications');
    const items = Array.isArray(list) ? list : list.items;
    expect(items.some((x: any) => x.title === 'Verification needed: Verified step')).toBe(true);
  });

  it('a rejection sends the step back to the person who completed it (default)', async () => {
    const { runId, task } = await start([{ ...verified({}), evidence: 'optional' }]);
    const first = await upload('olivia', task.id, 'first.txt', 'round 1');
    await olivia('POST', `/tasks/${task.id}/complete`, { comment: 'first try' });
    expect(await code(adam('POST', `/tasks/${task.id}/verify`, { approved: false }))).toBe('VERIFY_COMMENT_REQUIRED');
    expect(await adam('POST', `/tasks/${task.id}/verify`, { approved: false, comment: 'Photo is missing' })).toMatchObject({ outcome: 'returned' });
    const back = await getTask(olivia, task.id);
    expect(back).toMatchObject({ status: 'open', canDecide: true, manual: { stage: 'work', round: 2, submission: null } });
    expect(back.manual.returned).toHaveLength(1);
    expect(back.manual.returned[0]).toMatchObject({
      submission: { comment: 'first try', completedBy: 'olivia' },
      rejection: { by: 'adam', comment: 'Photo is missing' },
    });
    // files of the submitted round stay with the protocol
    expect(await code(olivia('DELETE', `/tasks/${task.id}/evidence/${first.body.id}`))).toBe('EVIDENCE_LOCKED');
    await upload('olivia', task.id, 'photo.png', tinyPng());
    await olivia('POST', `/tasks/${task.id}/complete`, { comment: 'second try' });
    await adam('POST', `/tasks/${task.id}/verify`, { approved: true });
    const run = await s.waitRun(runId, ['succeeded', 'failed']);
    expect(run.status).toBe('succeeded');
    expect(run.tasks[0].manual.evidence.map((e: any) => [e.filename, e.round])).toEqual([
      ['first.txt', 1],
      ['photo.png', 2],
    ]);
    const actions = (await auditOf(runId)).map((a) => a.action);
    expect(actions.filter((a) => a === 'task.completed')).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(['task.verification_rejected', 'task.verified']));
  });

  it('a rejection fails the run with onReject: fail', async () => {
    const { runId, task } = await start([verified({ onReject: 'fail' }), { id: 'after', type: 'log', message: 'never' }]);
    await olivia('POST', `/tasks/${task.id}/complete`, {});
    expect(await adam('POST', `/tasks/${task.id}/verify`, { approved: false, comment: 'Wrong device' })).toMatchObject({ outcome: 'failed' });
    const run = await s.waitRun(runId, ['succeeded', 'failed']);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Verification rejected by adam: Wrong device');
    expect(run.tasks[0]).toMatchObject({ status: 'completed', manual: { stage: 'done', verification: { approved: false } } });
    expect(run.steps.some((x: any) => x.stepId === 'after')).toBe(false);
  });

  it('never the same person under a former name (identity aliases of a moved instance)', async () => {
    const { db } = await import('../src/db.js');
    const { invalidateAliases } = await import('../src/auth/aliases.js');
    const users = await s.api('GET', '/users');
    const adamId = users.find((u: { username: string }) => u.username === 'adam').id;
    db().run(
      `INSERT INTO instance_imports (id, package_id, package_sha256, imported_at, imported_by, source_fingerprint, source_public_key, source_version,
         source_exported_at, source_exported_by, manifest, mapping, mapping_sha256, counts, history_checkpoint, history_entries)
       VALUES ('imp_manual', '00000000-0000-0000-0000-000000000083', 'x', 'now', 'test', 'fp', 'key', '0.1.2', 'now', 'test', '{}', '[]', '', '{}', '{}', 0)`,
    );
    db().run("INSERT INTO identity_aliases (kind, alias, target_id, import_id) VALUES ('user', 'laptop-adam', ?, 'imp_manual')", adamId);
    invalidateAliases();
    const { task } = await start([verified({})]);
    // the entry was made under the former name
    db().run(
      'UPDATE run_tasks SET submission = ?, completed_by = ?, stage = ? WHERE id = ?',
      JSON.stringify({ ...emptySubmission(), completedBy: 'laptop-adam' }),
      'laptop-adam',
      'verify',
      task.id,
    );
    expect(await code(adam('POST', `/tasks/${task.id}/verify`, { approved: true }))).toBe('VERIFY_SAME_PERSON');
    await dana('POST', `/tasks/${task.id}/verify`, { approved: true });
  });
});

const emptySubmission = () => ({
  checked: [],
  fields: [],
  notAvailable: [],
  doneAt: null,
  doneAtReason: null,
  comment: null,
  completedBy: 'x',
  completedAt: new Date().toISOString(),
  verificationReasons: ['step'],
});

describe('after-the-fact entries', () => {
  it('always need the verification; never in the future; not before the run without back-dating', async () => {
    const { runId, task } = await start([{ id: 'late', type: 'userTask', mode: 'manual', title: 'Done on site' }]);
    const runStart = Date.parse((await s.api('GET', `/runs/${runId}`)).startedAt);
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { doneAt: future, doneAtReason: 'x' }))).toBe('MANUAL_DONE_AT_FUTURE');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { doneAt: new Date(runStart - 60_000).toISOString(), doneAtReason: 'x' }))).toBe(
      'MANUAL_DONE_AT_TOO_EARLY',
    );
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { doneAt: 'yesterday', doneAtReason: 'x' }))).toBe('MANUAL_DONE_AT_INVALID');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { doneAt: new Date(runStart).toISOString() }))).toBe('MANUAL_DONE_AT_REASON_REQUIRED');
    const doneAt = new Date(runStart + 10).toISOString();
    expect(await olivia('POST', `/tasks/${task.id}/complete`, { doneAt, doneAtReason: 'No network on site' })).toMatchObject({ verificationNeeded: true });
    const t = await getTask(adam, task.id);
    expect(t.manual.submission).toMatchObject({ doneAt, doneAtReason: 'No network on site', verificationReasons: ['backdated'] });
    expect(Date.parse(t.manual.submission.completedAt)).toBeGreaterThanOrEqual(Date.parse(doneAt));
    const backdated = (await auditOf(runId)).find((a) => a.action === 'task.backdated');
    expect(backdated.details).toMatchObject({ doneAt, reason: 'No network on site' });
    expect(backdated.details.enteredAt).toBe(t.manual.submission.completedAt);
    await adam('POST', `/tasks/${task.id}/verify`, { approved: true });
    expect((await s.waitRun(runId, ['succeeded', 'failed'])).status).toBe('succeeded');
  });

  it('back-dating before the run start is bounded by the step setting (at most 30 days)', async () => {
    const { runId, task } = await start([{ id: 'late', type: 'userTask', mode: 'manual', title: 'Done last week', backdateDays: 2 }]);
    const runStart = Date.parse((await s.api('GET', `/runs/${runId}`)).startedAt);
    const day = 86_400_000;
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { doneAt: new Date(runStart - 3 * day).toISOString(), doneAtReason: 'paper form' }))).toBe(
      'MANUAL_DONE_AT_TOO_EARLY_DAYS',
    );
    await olivia('POST', `/tasks/${task.id}/complete`, { doneAt: new Date(runStart - day).toISOString(), doneAtReason: 'paper form' });
    expect((await getTask(adam, task.id)).manual.stage).toBe('verify');
    await s.api('POST', `/runs/${runId}/cancel`);
    // the definition itself cannot allow more than 30 days
    const { validateProcess } = await import('@sm/shared');
    expect(validateProcess({ name: 'x', steps: [{ id: 'a', type: 'userTask', mode: 'manual', title: 't', backdateDays: 31 }] }).ok).toBe(false);
  });
});

describe('records', () => {
  it('the run protocol PDF shows each manual step', async () => {
    const { runId, task } = await start([
      {
        ...MANUAL,
        id: 'pdf',
        checklistAllRequired: false,
        verification: { required: true, verifiers: ['role:approver'] },
        backdateDays: 1,
      },
    ]);
    const photo = await upload('olivia', task.id, 'gateway.png', tinyPng());
    const runStart = Date.parse((await s.api('GET', `/runs/${runId}`)).startedAt);
    await olivia('POST', `/tasks/${task.id}/complete`, {
      checked: [0, 2],
      fields: [
        { id: 'serial', value: 'SN-4711' },
        { id: 'minutes', value: '7' },
      ],
      notAvailable: [{ target: 'ticket', reason: 'Ticket system down' }],
      doneAt: new Date(runStart - 3600_000).toISOString(),
      doneAtReason: 'Entered from the paper log',
    });
    await adam('POST', `/tasks/${task.id}/verify`, { approved: true, comment: 'Checked the paper log' });
    expect((await s.waitRun(runId, ['succeeded', 'failed'])).status).toBe('succeeded');
    const { generateRunReport } = await import('../src/reports/service.js');
    const r = await generateRunReport(runId, { lang: 'en', actor: 'admin' });
    const text = r.texts.join('\n');
    for (const expected of [
      'Manual steps',
      'Manual step: Replace the gateway',
      'Done and verified by a second person',
      'Line switched off',
      'Gateway replaced',
      'SN-4711',
      'Not available: Ticket system down',
      'Entered from the paper log',
      'gateway.png',
      photo.body.sha256,
      'Checked the paper log',
      'Required (step setting, something required was not available, entered after the fact)',
      'Steps', // the instructions' heading (Markdown)
    ])
      expect(text, expected).toContain(expected);
    expect(text).toMatch(/verified by/i);
    expect(text).toMatch(/adam/);
    // Markdown is drawn as text: no HTML is interpreted
    expect(text).toContain('<script>alert(1)</script>');
    const de = await generateRunReport(runId, { lang: 'de', actor: 'admin' });
    expect(de.texts.join('\n')).toContain('Erledigt und von einer zweiten Person geprüft');
    // the HTML protocol escapes the entries
    const html = await s.api('GET', `/runs/${runId}/report.html`);
    expect(html).toContain('SN-4711');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('the public API shows manual steps; existing decisions keep their shape', async () => {
    const { task } = await start([{ ...MANUAL, id: 'api', checklistAllRequired: false, evidence: 'optional' }]);
    const { token } = await s.api('POST', '/me/tokens', { name: `manual ${Date.now()}`, scope: 'read' });
    const res = await fetch(`${s.base}/api/v1/tasks/${task.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ mode: 'manual', stage: 'work', manual: { round: 1, evidence: 'optional', completed: null } });
    expect(body.manual.checklist).toHaveLength(3);
    expect(body.manual.fields[0]).toMatchObject({ id: 'ticket', type: 'ticket', required: true, value: null });
  });

  it('a ticket field links to a documented ticket reference', async () => {
    const ref = await s.api('POST', '/ticket-references', { source: 'servicenow-incident', externalNumber: 'INC0042', title: 'Gateway down' });
    const { runId, task } = await start([
      { id: 't', type: 'userTask', mode: 'manual', title: 'Ticket', fields: [{ id: 'inc', type: 'ticket', label: 'Incident' }] },
    ]);
    await olivia('POST', `/tasks/${task.id}/complete`, { fields: [{ id: 'inc', value: 'inc0042' }] });
    const run = await s.waitRun(runId, ['succeeded', 'failed']);
    expect(run.tasks[0].manual.submission.fields[0]).toEqual({ id: 'inc', value: 'inc0042', ticketId: ref.id });
  });

  it('validation: duplicate field ids, manual settings on other modes', async () => {
    const { validateProcess } = await import('@sm/shared');
    const dup = validateProcess({
      name: 'x',
      steps: [
        {
          id: 'a',
          type: 'userTask',
          mode: 'manual',
          title: 't',
          fields: [
            { id: 'f', type: 'text', label: 'A' },
            { id: 'f', type: 'number', label: 'B' },
          ],
        },
      ],
    });
    expect(dup.issues.map((i) => i.code)).toContain('duplicateFieldId');
    const other = validateProcess({ name: 'x', steps: [{ id: 'a', type: 'userTask', mode: 'approve', title: 't', checklist: ['x'] }] });
    expect(other.ok).toBe(true);
    expect(other.warnings.map((i) => i.code)).toContain('manualSettingsIgnored');
  });
});

describe('security review', () => {
  const STEP = { id: 'm', type: 'userTask', mode: 'manual', title: 'Manual', evidence: 'optional', verification: { required: true } };

  /** Starts a multipart upload of a PNG and holds it after the first bytes; `finish()` sends the rest and answers status and body. */
  async function slowUpload(taskId: string): Promise<{ finish: () => Promise<{ status: number; body: any }> }> {
    const http = await import('node:http');
    const u = new URL(`${s.base}/api/tasks/${taskId}/evidence`);
    const boundary = 'XBOUNDARY';
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="late.png"\r\nContent-Type: image/png\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const png = tinyPng();
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: {
        ...authHeaders(cookies.olivia!),
        'x-sm-client': '1',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': head.length + png.length + tail.length,
      },
    });
    const answer = new Promise<{ status: number; body: any }>((res) =>
      req.on('response', (r) => {
        let b = '';
        r.on('data', (d) => (b += d));
        r.on('end', () => res({ status: r.statusCode!, body: b ? JSON.parse(b) : null }));
      }),
    );
    req.write(head);
    req.write(png.subarray(0, 10));
    await new Promise((r) => setTimeout(r, 300));
    return {
      finish: async () => {
        req.write(png.subarray(10));
        req.end(tail);
        return answer;
      },
    };
  }

  const evidenceFiles = async (runId: string) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.join(s.dataDir, 'artifacts', runId, 'evidence');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  it('M1: an upload that finishes after the step was completed and verified stores nothing', async () => {
    const { runId, task } = await start([STEP]);
    const upload = await slowUpload(task.id);
    await olivia('POST', `/tasks/${task.id}/complete`, {});
    await adam('POST', `/tasks/${task.id}/verify`, { approved: true });
    expect((await s.waitRun(runId, ['succeeded', 'failed'])).status).toBe('succeeded');
    const { sealedProtocolHash } = await import('../src/audit.js');
    const { protocolHash } = await import('../src/engine/store.js');
    const sealed = sealedProtocolHash(runId);
    const late = await upload.finish();
    expect(late).toMatchObject({ status: 409, body: { code: 'EVIDENCE_TOO_LATE' } });
    const t = await getTask(adam, task.id);
    expect(t.manual.evidence).toEqual([]);
    expect(await evidenceFiles(runId)).toEqual([]);
    expect(protocolHash(runId)).toBe(sealed);
  });

  it('M1: an upload that finishes after the step was sent back does not land in the rejected round', async () => {
    const { runId, task } = await start([STEP]);
    await upload('olivia', task.id, 'first.txt', 'round 1');
    const slow = await slowUpload(task.id);
    await olivia('POST', `/tasks/${task.id}/complete`, {});
    await adam('POST', `/tasks/${task.id}/verify`, { approved: false, comment: 'again' });
    const late = await slow.finish();
    expect(late).toMatchObject({ status: 409, body: { code: 'EVIDENCE_TOO_LATE' } });
    const t = await getTask(olivia, task.id);
    expect(t.manual.evidence.map((e: any) => [e.filename, e.round])).toEqual([['first.txt', 1]]);
    expect(t.manual.returned[0].submission.evidence.map((e: any) => e.filename)).toEqual(['first.txt']);
    expect(await evidenceFiles(runId)).toHaveLength(1);
    await s.api('POST', `/runs/${runId}/cancel`);
  });

  it('M1: parallel uploads cannot pass the file limit; the entry keeps exactly its files', async () => {
    const { runId, task } = await start([STEP]);
    const res = await Promise.all(Array.from({ length: 30 }, (_, i) => upload('olivia', task.id, `f${i}.png`, tinyPng())));
    expect(res.filter((r) => r.status === 200)).toHaveLength(20);
    expect(res.filter((r) => r.status !== 200).every((r) => r.body.code === 'EVIDENCE_LIMIT')).toBe(true);
    expect((await getTask(olivia, task.id)).manual.evidence).toHaveLength(20);
    expect(await evidenceFiles(runId)).toHaveLength(20);
    await olivia('POST', `/tasks/${task.id}/complete`, {});
    const t = await getTask(adam, task.id);
    expect(t.manual.submission.evidence).toHaveLength(20);
    expect(t.manual.submission.evidence[0]).toEqual(expect.objectContaining({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), uploadedBy: 'olivia' }));
    await s.api('POST', `/runs/${runId}/cancel`);
  });

  it('L1: whoever added evidence to the entry may not verify it', async () => {
    const { runId, task } = await start([STEP]);
    expect((await upload('adam', task.id, 'adam.png', tinyPng())).status).toBe(200);
    await olivia('POST', `/tasks/${task.id}/complete`, {});
    expect(await code(adam('POST', `/tasks/${task.id}/verify`, { approved: true }))).toBe('VERIFY_SAME_PERSON');
    expect((await adam('GET', '/tasks?status=open&mine=1')).map((x: any) => x.id)).not.toContain(task.id);
    await dana('POST', `/tasks/${task.id}/verify`, { approved: true });
    expect((await s.waitRun(runId, ['succeeded', 'failed'])).status).toBe('succeeded');
  });

  it('L2: required evidence counts only the current round; after a send-back every entry is verified', async () => {
    const req = await start([{ ...STEP, evidence: 'required' }]);
    await upload('olivia', req.task.id, 'wrong.png', tinyPng());
    await olivia('POST', `/tasks/${req.task.id}/complete`, {});
    await adam('POST', `/tasks/${req.task.id}/verify`, { approved: false, comment: 'wrong file' });
    expect(await code(olivia('POST', `/tasks/${req.task.id}/complete`, {}))).toBe('MANUAL_EVIDENCE_REQUIRED');
    await s.api('POST', `/runs/${req.runId}/cancel`);

    // verification only forced by "not available" in round 1 – still verified in round 2
    const forced = await start([{ id: 'f', type: 'userTask', mode: 'manual', title: 'Forced', evidence: 'required' }]);
    await olivia('POST', `/tasks/${forced.task.id}/complete`, { notAvailable: [{ target: 'evidence', reason: 'no camera' }] });
    await adam('POST', `/tasks/${forced.task.id}/verify`, { approved: false, comment: 'take a photo' });
    await upload('olivia', forced.task.id, 'photo.png', tinyPng());
    expect(await olivia('POST', `/tasks/${forced.task.id}/complete`, {})).toMatchObject({ verificationNeeded: true });
    const t = await getTask(adam, forced.task.id);
    expect(t.manual.submission.verificationReasons).toEqual(['returned']);
    expect(t.manual.submission.evidence.map((e: any) => e.filename)).toEqual(['photo.png']);
    await adam('POST', `/tasks/${forced.task.id}/verify`, { approved: true });
    expect((await s.waitRun(forced.runId, ['succeeded', 'failed'])).status).toBe('succeeded');
  });

  it('L3: times need Z or an explicit offset', async () => {
    const { runId, task } = await start([{ id: 't', type: 'userTask', mode: 'manual', title: 'Times', fields: [{ id: 'at', type: 'datetime', label: 'At' }] }]);
    const startedAt = (await s.api('GET', `/runs/${runId}`)).startedAt as string;
    const local = startedAt.slice(0, 16); // 2026-10-26T10:00 – no zone
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { fields: [{ id: 'at', value: local }] }))).toBe('MANUAL_FIELD_INVALID');
    expect(await code(olivia('POST', `/tasks/${task.id}/complete`, { doneAt: local, doneAtReason: 'x' }))).toBe('MANUAL_DONE_AT_INVALID');
    const offset = new Date(Date.parse(startedAt) + 1000).toISOString().replace('Z', '+00:00');
    await olivia('POST', `/tasks/${task.id}/complete`, { fields: [{ id: 'at', value: '2026-10-26T10:30+01:00' }], doneAt: offset, doneAtReason: 'x' });
    const sub = (await getTask(adam, task.id)).manual.submission;
    expect(sub.fields[0].value).toBe('2026-10-26T09:30:00.000Z');
    expect(sub.doneAt).toBe(new Date(offset).toISOString());
    await s.api('POST', `/runs/${runId}/cancel`);
  });

  it('nits: the protocol hash covers the step settings; ticket links only for references the reader may read', async () => {
    const { runId, task } = await start([
      { id: 'h', type: 'userTask', mode: 'manual', title: 'Hash', fields: [{ id: 'inc', type: 'ticket', label: 'Incident' }] },
    ]);
    const ref = await s.api('POST', '/ticket-references', { source: 'servicenow-incident', externalNumber: `INC-H-${Date.now()}`, title: 'x' });
    await olivia('POST', `/tasks/${task.id}/complete`, { fields: [{ id: 'inc', value: ref.externalNumber }] });
    expect((await s.waitRun(runId, ['succeeded', 'failed'])).status).toBe('succeeded');
    expect((await getTask(vera, task.id)).manual.submission.fields[0].ticketId).toBe(ref.id);
    const { manualForReader } = await import('../src/engine/manual.js');
    const raw = (await s.api('GET', `/runs/${runId}`)).tasks[0].manual;
    expect(manualForReader(raw, null).submission!.fields[0].ticketId).toBeNull();
    await s.api('DELETE', `/ticket-references/${ref.id}`);
    expect((await getTask(vera, task.id)).manual.submission.fields[0].ticketId).toBeNull();

    const { db } = await import('../src/db.js');
    const { protocolHash } = await import('../src/engine/store.js');
    const before = protocolHash(runId);
    db().run('UPDATE run_tasks SET verifiers = \'["role:viewer"]\' WHERE id = ?', task.id);
    expect(protocolHash(runId)).not.toBe(before);
    db().run("UPDATE run_tasks SET verifiers = '[]' WHERE id = ?", task.id);
    expect(protocolHash(runId)).toBe(before);
    const spec = db().get<{ manual: string }>('SELECT manual FROM run_tasks WHERE id = ?', task.id)!.manual;
    db().run('UPDATE run_tasks SET manual = ? WHERE id = ?', spec.replace('"Incident"', '"Changed"'), task.id);
    expect(protocolHash(runId)).not.toBe(before);
  });
});

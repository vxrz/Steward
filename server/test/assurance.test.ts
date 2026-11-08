import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  CONTROL_POINTS,
  STEP_UP_ACTIONS,
  applyChanges,
  controlPoint,
  controlPointOfAction,
  defaultAssurancePolicy,
  effectiveRule,
  instanceRule,
  normalizePolicy,
  policyChanges,
  splitPolicyChange,
} from '@sm/shared';
import { authHeaders, loginCookie, sessionClient, setup, ssoBinding, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Assurance policy (#210, auth/assurance.ts, docs/ASSURANCE.md): one catalogue of control points, an instance policy
 * that can only be tightened below the baseline, loosening with a second administrator, enforcement through one
 * module (step-up per point, four-eyes by identity), the proof in the audit chain, the policy as of a time, and the
 * assurance report (PDF, JSON, evidence packs).
 */

const ROOT = path.resolve(__dirname, '..', '..');
const PW = 'Demo-password-1';

describe('control-point catalogue and effective policy (unit)', () => {
  it('maps every step-up action of 0.4.0 and 0.5.0 to exactly one control point', () => {
    for (const a of STEP_UP_ACTIONS)
      expect(
        CONTROL_POINTS.filter((p) => p.actions.includes(a)).map((p) => p.key),
        a,
      ).toHaveLength(1);
    expect(new Set(CONTROL_POINTS.map((p) => p.key)).size).toBe(CONTROL_POINTS.length);
    expect(controlPointOfAction('grantAccess')?.key).toBe('access.grant');
    expect(controlPointOfAction('closeFirewallChange')?.key).toBe('firewallChange.close');
  });

  it('keeps 0.4.0 behaviour by default: the 22 step-up actions on, the new points off', () => {
    const before = STEP_UP_ACTIONS.slice(0, STEP_UP_ACTIONS.indexOf('changeAssurancePolicy'));
    expect(before).toHaveLength(22);
    const d = defaultAssurancePolicy();
    for (const a of before) expect(effectiveRule(controlPointOfAction(a)!, d), a).toMatchObject({ stepUp: true, maxAgeMinutes: null, mfa: false });
    for (const k of ['record.approve', 'accessCheck.decide', 'personReview.decide', 'manualStep.verify', 'firewallChange.close'])
      expect(effectiveRule(controlPoint(k)!, d).stepUp, k).toBe(false);
    // four-eyes as in 0.4.0: always where it was fixed, per item where items decided
    expect(effectiveRule(controlPoint('record.approve')!, d).fourEyes).toBe(true);
    expect(effectiveRule(controlPoint('run.decide')!, d).fourEyes).toBe(false);
    expect(effectiveRule(controlPoint('run.decide')!, d, { fourEyes: true }).fourEyes).toBe(true);
    expect(effectiveRule(controlPoint('accessCheck.decide')!, d, { fourEyes: false }).fourEyes).toBe(false);
  });

  it('never goes below the baseline, whatever is stored', () => {
    const stored = { points: { 'vault.passphrase': { stepUp: false }, 'record.approve': { fourEyes: 'off' as const }, 'apiToken.create': { stepUp: false } } };
    expect(instanceRule(controlPoint('vault.passphrase')!, stored).stepUp).toBe(true);
    expect(instanceRule(controlPoint('apiToken.create')!, stored).stepUp).toBe(true);
    expect(instanceRule(controlPoint('record.approve')!, stored).fourEyes).toBe('required');
    for (const k of ['vault.passphrase', 'audit.anchoring', 'apiToken.create', 'access.grant', 'sso.providers', 'signIn.settings', 'assurance.policy'])
      expect(controlPoint(k)!.baseline.stepUp, k).toBe(true);
    // the normal form drops what cannot apply
    expect(normalizePolicy({ ...defaultAssurancePolicy(), points: stored.points }).points).toEqual({});
  });

  it('is the strictest of baseline, instance policy and the item override', () => {
    const p = controlPoint('mcp.write')!;
    const required = { points: { 'mcp.write': { fourEyes: 'required' as const } } };
    expect(effectiveRule(p, required, { fourEyes: false }).fourEyes).toBe(true);
    expect(effectiveRule(p, { points: {} }, { fourEyes: true }).fourEyes).toBe(true);
    expect(effectiveRule(p, { points: {} }, { fourEyes: false }).fourEyes).toBe(false);
    const age = { points: { 'audit.export': { maxAgeMinutes: 2, mfa: true } } };
    expect(effectiveRule(controlPoint('audit.export')!, age)).toMatchObject({ stepUp: true, maxAgeMinutes: 2, mfa: true });
  });

  it('"May be decided in Microsoft Teams": on for run.decide, off for mcp.write and the bot itself, never with a step-up (ADR 0013)', () => {
    const d = defaultAssurancePolicy();
    expect(CONTROL_POINTS.filter((p) => p.supports.teams).map((p) => p.key)).toEqual(['run.decide', 'mcp.write', 'teams.bot']);
    expect(instanceRule(controlPoint('run.decide')!, d).teams).toBe(true);
    // security review 0.10.0: AI requests are decided in Steward, where the whole request is shown; the bot needs a second administrator
    expect(instanceRule(controlPoint('mcp.write')!, d).teams).toBe(false);
    expect(instanceRule(controlPoint('teams.bot')!, d).teams).toBe(false);
    // points with a step-up never take it
    for (const p of CONTROL_POINTS.filter((x) => x.supports.stepUp)) expect(p.supports.teams, p.key).toBeFalsy();
    expect(instanceRule(controlPoint('manualStep.verify')!, d).teams).toBeUndefined();
    const off = normalizePolicy({ ...d, points: { 'run.decide': { teams: false } } });
    expect(off.points).toEqual({ 'run.decide': { teams: false } });
    expect(policyChanges(d, off)).toEqual([{ point: 'run.decide', field: 'teams', from: true, to: false, direction: 'tighten' }]);
    expect(policyChanges(off, d)[0]!.direction).toBe('loosen');
    expect(applyChanges(off, policyChanges(off, d)).points).toEqual({});
    const bot = normalizePolicy({ ...d, points: { 'teams.bot': { teams: true } } });
    expect(policyChanges(d, bot)).toEqual([{ point: 'teams.bot', field: 'teams', from: false, to: true, direction: 'loosen' }]);
  });

  it('tells tightening from loosening and splits a mixed change', () => {
    const cur = normalizePolicy({ ...defaultAssurancePolicy(), points: { 'audit.export': { maxAgeMinutes: 3 } } });
    const next = { ...cur, points: { 'record.approve': { stepUp: true, maxAgeMinutes: 2, mfa: true }, 'credentials.export': { stepUp: false } } };
    const changes = policyChanges(cur, next);
    expect(changes.filter((c) => c.direction === 'tighten').map((c) => `${c.point}.${c.field}`)).toEqual([
      'record.approve.stepUp',
      'record.approve.maxAgeMinutes',
      'record.approve.mfa',
    ]);
    expect(changes.filter((c) => c.direction === 'loosen').map((c) => `${c.point}.${c.field}`)).toEqual([
      'audit.export.maxAgeMinutes',
      'credentials.export.stepUp',
    ]);
    const split = splitPolicyChange(cur, next);
    expect(split.now.points).toEqual({ 'audit.export': { maxAgeMinutes: 3 }, 'record.approve': { stepUp: true, maxAgeMinutes: 2, mfa: true } });
    expect(applyChanges(split.now, split.loosened).points).toEqual(next.points);
    // counting another amr value as multi-factor loosens; removing one tightens
    const more = { ...cur, mfa: { ...cur.mfa, amrValues: [...cur.mfa.amrValues, 'sms'] } };
    expect(policyChanges(cur, more)).toEqual([expect.objectContaining({ point: 'mfa.amrValues', direction: 'loosen' })]);
    const fewer = { ...cur, mfa: { ...cur.mfa, amrValues: ['mfa'] } };
    expect(policyChanges(cur, fewer)).toEqual([expect.objectContaining({ point: 'mfa.amrValues', direction: 'tighten' })]);
  });

  it('keeps the control-point table of docs/ASSURANCE.md and the labels in sync with the catalogue', async () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'ASSURANCE.md'), 'utf8');
    const table = /<!-- control-points:start -->\n([\s\S]*?)<!-- control-points:end -->/.exec(doc)?.[1] ?? '';
    const rows = table
      .split('\n')
      .filter((l) => l.startsWith('| `'))
      .map((l) => l.split('|').map((x) => x.trim()));
    expect(rows.map((r) => r[1]!.replace(/`/g, ''))).toEqual(CONTROL_POINTS.map((p) => p.key));
    for (const r of rows) {
      const p = controlPoint(r[1]!.replace(/`/g, ''))!;
      expect(r[2], p.key).toBe(p.group);
      const d = instanceRule(p, { points: {} });
      const stepUp = !p.supports.stepUp ? '–' : p.baseline.stepUp ? 'baseline' : d.stepUp ? 'on' : 'off';
      const fourEyes = !p.supports.fourEyes ? '–' : p.baseline.fourEyes ? 'baseline' : d.fourEyes!;
      expect([r[3], r[4]], p.key).toEqual([fourEyes, stepUp]);
    }
    const web = (lang: string) => JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'src', 'locales', lang, 'assurance.json'), 'utf8'));
    for (const lang of ['en', 'de'] as const) {
      const w = web(lang);
      for (const p of CONTROL_POINTS) {
        const entry = p.key.split('.').reduce((o: any, k) => o?.[k], w.points);
        expect(entry?.label, `${lang} ${p.key}`).toBeTruthy();
        expect(entry?.description, `${lang} ${p.key}`).toBeTruthy();
      }
    }
  });
});

describe('assurance policy (server)', () => {
  let s: TestServer;
  let admin2: Client;
  let mock: typeof import('../src/mock/mockOidc.js');
  let providerId = '';
  const refusal = async (p: Promise<unknown>): Promise<{ status: number; code?: string; body?: any }> => {
    try {
      await p;
      return { status: 200 };
    } catch (e) {
      const x = e as { status: number; body?: any };
      return { status: x.status, code: x.body?.code, body: x.body };
    }
  };
  const audits = async (action: string, limit = 5) => s.api('GET', `/audit?action=${action}&limit=${limit}`);
  const setPolicy = async (c: Client, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const v = await c('GET', '/assurance/policy');
    return c('PUT', '/assurance/policy', { points: { ...v.policy.points, ...patch }, mfa: v.policy.mfa, ...extra });
  };
  const resetPolicy = async () => {
    // back to the defaults: loosening goes through the second administrator
    const r = await s.api('PUT', '/assurance/policy', { points: {}, mfa: defaultAssurancePolicy().mfa });
    if (r.pending) await admin2('POST', `/assurance/policy/changes/${r.pending.id}/approve`, {});
  };

  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    await s.api('POST', '/demo/setup', {});
    const { temporaryPassword } = await s.api('POST', '/users', { username: 'admin2', roles: ['admin'] });
    const first = await s.as('admin2', temporaryPassword);
    await first('POST', '/auth/password', { current: temporaryPassword, next: 'Admin2-password-1' });
    admin2 = await s.as('admin2', 'Admin2-password-1');
    mock = await import('../src/mock/mockOidc.js');
    providerId = (await s.api('GET', '/sso/providers'))[0].id;
  }, 120_000);
  afterAll(async () => {
    await s?.app.close();
  });
  afterEach(() => mock?.resetMockIdentities());

  it('has report labels for every control point (the PDF draws them, en and de)', async () => {
    // (imported once the server runs: the module reads the configuration)
    const { POINT_LABELS } = await import('../src/compliance/assurance-pdf.js');
    for (const lang of ['en', 'de'] as const) expect(Object.keys(POINT_LABELS[lang]).sort(), lang).toEqual(CONTROL_POINTS.map((p) => p.key).sort());
  });

  it('shows the default policy: version 0, baseline locks, overrides', async () => {
    const v = await s.api('GET', '/assurance/policy');
    expect(v.policy.version).toBe(0);
    expect(v.since).toBeNull();
    expect(v.rules['vault.passphrase']).toMatchObject({ baseline: { stepUp: true }, instance: { stepUp: true } });
    expect(v.rules['record.approve'].instance).toMatchObject({ fourEyes: 'required', stepUp: false });
    expect(v.overrides.some((o: any) => o.point === 'record.approve' && o.kind === 'recordType')).toBe(true);
    expect(v.overrides.some((o: any) => o.point === 'accessCheck.decide' && o.kind === 'setting')).toBe(true);
    // auditors read it, others do not
    const audrey = await s.as('audrey', PW);
    expect((await audrey('GET', '/assurance/policy')).canChange).toBe(false);
    const vera = await s.as('vera', PW);
    expect((await refusal(vera('GET', '/assurance/policy'))).status).toBe(403);
  });

  it('applies tightening at once, with a step-up and an audit entry with before and after', async () => {
    const c = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    await c('DELETE', '/auth/step-up');
    expect(await refusal(setPolicy(c, { 'audit.export': { maxAgeMinutes: 4 } }))).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    await c('POST', '/auth/step-up', { password: 'Admin-password-1' });
    const r = await setPolicy(c, { 'audit.export': { maxAgeMinutes: 4 } });
    expect(r.pending).toBeNull();
    expect(r.applied).toEqual([expect.objectContaining({ point: 'audit.export', field: 'maxAgeMinutes', from: null, to: 4, direction: 'tighten' })]);
    expect(r.view.policy).toMatchObject({ version: 1, points: { 'audit.export': { maxAgeMinutes: 4 } } });
    const [e] = await audits('assurance.policy_changed', 1);
    expect(e).toMatchObject({ actor: 'admin', details: { version: 1, before: { version: 0, points: {} }, after: { version: 1 } } });
    // the change itself carries its proof: the step-up of assurance.policy
    expect(e.details.assurance).toEqual([
      expect.objectContaining({ point: 'assurance.policy', policyVersion: 0, stepUp: expect.objectContaining({ method: 'password' }) }),
    ]);
    // the baseline cannot be lowered: nothing changes, nothing waits
    const base = await setPolicy(s.api, { 'vault.passphrase': { stepUp: false } });
    expect(base).toMatchObject({ applied: [], pending: null });
    // the web app sends every point's rule as it shows it (null four-eyes where a point has none): nothing changes
    const shown = await s.api('GET', '/assurance/policy');
    const asShown = Object.fromEntries(Object.entries(shown.rules).map(([k, r]: [string, any]) => [k, r.instance]));
    expect(await s.api('PUT', '/assurance/policy', { points: asShown, mfa: shown.policy.mfa })).toMatchObject({ applied: [], pending: null });
    // longer than SM_STEP_UP_MINUTES is refused
    expect(await refusal(setPolicy(s.api, { 'audit.export': { maxAgeMinutes: 60 } }))).toMatchObject({ status: 400, code: 'ASSURANCE_MAX_AGE' });
  });

  it('asks again when the confirmation is older than the point allows', async () => {
    const cfg = await import('../src/config.js');
    const c = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    const { db } = await import('../src/db.js');
    // the sign-in counted as a confirmation 4½ minutes ago: within SM_STEP_UP_MINUTES (5), older than audit.export's 4
    const at = new Date(Date.now() - 4.5 * 60_000).toISOString();
    db().run("UPDATE sessions SET step_up_at = ? WHERE user_id = (SELECT id FROM users WHERE username = 'admin') AND step_up_at IS NOT NULL", at);
    expect(cfg.config.session.stepUpMs).toBe(5 * 60_000);
    const r = await refusal(c('GET', '/audit/export?format=json'));
    expect(r).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(r.body.stepUp).toMatchObject({ windowMinutes: 4, action: 'exportAuditLog' });
    // other points still take it (their age is SM_STEP_UP_MINUTES)
    expect((await c('GET', '/auth/step-up')).until).not.toBeNull();
    expect((await c('GET', '/auth/step-up?action=exportAuditLog')).until).toBeNull();
    await c('POST', '/auth/step-up', { password: 'Admin-password-1' });
    expect((await c('GET', '/audit/export?format=json')).entries?.length ?? 1).toBeGreaterThan(0);
  });

  it('lets loosening wait for a second administrator; the requester cannot approve it', async () => {
    const r = await setPolicy(s.api, { 'audit.export': {}, 'credentials.export': { stepUp: false } }, { comment: 'Weekly exports by a job' });
    expect(r.applied).toEqual([]);
    expect(r.pending).toMatchObject({ status: 'pending', requestedBy: 'admin', comment: 'Weekly exports by a job', canApprove: false, canReject: true });
    expect(r.pending.changes.map((c: any) => `${c.point}.${c.field}`).sort()).toEqual(['audit.export.maxAgeMinutes', 'credentials.export.stepUp']);
    expect(r.view.policy.version).toBe(1); // nothing changed yet
    expect((await audits('assurance.policy_change_requested', 1))[0]).toMatchObject({ actor: 'admin', details: { changeId: r.pending.id } });
    // one request at a time
    expect(await refusal(setPolicy(s.api, { 'backup.settings': { stepUp: false } }))).toMatchObject({ status: 409, code: 'ASSURANCE_CHANGE_PENDING' });
    // tightening still applies while it waits
    expect((await setPolicy(s.api, { 'record.approve': { stepUp: true } })).view.policy.version).toBe(2);
    // shown on System status
    expect((await s.api('GET', '/system/status')).security.assurancePendingChange).toMatchObject({ id: r.pending.id, requestedBy: 'admin' });
    // the requester may not approve it
    expect(await refusal(s.api('POST', `/assurance/policy/changes/${r.pending.id}/approve`, {}))).toMatchObject({ status: 403, code: 'FOUR_EYES_POLICY' });
    const seen = await admin2('GET', '/assurance/policy');
    expect(seen.pending).toMatchObject({ id: r.pending.id, canApprove: true });
    const done = await admin2('POST', `/assurance/policy/changes/${r.pending.id}/approve`, {});
    expect(done.pending).toBeNull();
    expect(done.policy.version).toBe(3);
    // applied on top of the tightening made meanwhile
    expect(done.policy.points).toEqual({ 'credentials.export': { stepUp: false }, 'record.approve': { stepUp: true } });
    const [e] = await audits('assurance.policy_changed', 1);
    expect(e).toMatchObject({ actor: 'admin2', details: { version: 3, requestedBy: 'admin', approvedBy: 'admin2', changeId: r.pending.id } });
    expect(e.details.assurance).toEqual([
      expect.objectContaining({ point: 'assurance.policy', fourEyes: expect.objectContaining({ requesters: ['admin'], approver: 'admin2' }) }),
    ]);
    expect((await s.api('GET', '/system/status')).security.assurancePendingChange).toBeNull();
  });

  it('rejects, withdraws and expires requests after seven days', async () => {
    const a = await setPolicy(s.api, { 'backup.settings': { stepUp: false } });
    expect(a.pending.status).toBe('pending');
    await admin2('POST', `/assurance/policy/changes/${a.pending.id}/reject`, { comment: 'Not now' });
    expect((await audits('assurance.policy_change_rejected', 1))[0]).toMatchObject({
      actor: 'admin2',
      details: { changeId: a.pending.id, comment: 'Not now' },
    });
    const b = await setPolicy(s.api, { 'backup.settings': { stepUp: false } });
    await s.api('POST', `/assurance/policy/changes/${b.pending.id}/reject`, {});
    expect((await audits('assurance.policy_change_withdrawn', 1))[0]).toMatchObject({ actor: 'admin', details: { changeId: b.pending.id } });
    const c = await setPolicy(s.api, { 'backup.settings': { stepUp: false } });
    const { expirePolicyChanges } = await import('../src/auth/assurance.js');
    expect(expirePolicyChanges(new Date(Date.now() + 6 * 86_400_000).toISOString())).toBe(0);
    expect(expirePolicyChanges(new Date(Date.now() + 7 * 86_400_000 + 1000).toISOString())).toBe(1);
    expect((await audits('assurance.policy_change_expired', 1))[0]).toMatchObject({
      actor: 'system',
      details: { changeId: c.pending.id, requestedBy: 'admin' },
    });
    expect(await refusal(admin2('POST', `/assurance/policy/changes/${c.pending.id}/approve`, {}))).toMatchObject({
      status: 409,
      code: 'ASSURANCE_CHANGE_DECIDED',
    });
    expect((await s.api('GET', '/assurance/policy')).policy.points['backup.settings']).toBeUndefined();
  });

  it('derives the policy as of any time from the audit chain', async () => {
    const versions = await s.api('GET', '/assurance/policy/history');
    expect(versions.map((v: any) => v.version)).toEqual([1, 2, 3]);
    expect(versions[2]).toMatchObject({ by: 'admin', approvedBy: 'admin2' });
    const before = await s.api('GET', `/assurance/policy/as-of?at=${encodeURIComponent('2020-01-01T00:00:00Z')}`);
    expect(before.policy).toMatchObject({ version: 0, points: {} });
    const atTwo = await s.api('GET', `/assurance/policy/as-of?at=${encodeURIComponent(versions[1].at)}`);
    expect(atTwo.policy).toMatchObject({ version: 2, points: { 'audit.export': { maxAgeMinutes: 4 }, 'record.approve': { stepUp: true } } });
    const { policyAsOf, currentPolicy } = await import('../src/auth/assurance.js');
    expect(policyAsOf(new Date().toISOString()).policy).toEqual(currentPolicy());
    // a policy changed directly in the database (seal broken) does not count: the audit log's version applies
    const { db } = await import('../src/db.js');
    const { forgetAssurancePolicy } = await import('../src/auth/assurance-policy.js');
    const row = db().get<{ value: string }>("SELECT value FROM settings WHERE key = 'assurance.policy'")!;
    const forged = JSON.parse(row.value);
    forged.policy.points['record.approve'] = {};
    db().run("UPDATE settings SET value = ? WHERE key = 'assurance.policy'", JSON.stringify(forged));
    forgetAssurancePolicy();
    expect(currentPolicy().points['record.approve']).toEqual({ stepUp: true });
    db().run("UPDATE settings SET value = ? WHERE key = 'assurance.policy'", row.value);
    forgetAssurancePolicy();
  });

  it('asks for a fresh confirmation before approving a record once the point requires it', async () => {
    const dana = await s.as('dana', PW);
    const adam = await s.as('adam', PW, { autoStepUp: false });
    const rec = await dana('POST', '/records', {
      type: 'CR',
      title: 'Assurance: rotate keys',
      fields: { reason: 'Rotation', risk: 'low', rollbackPlan: 'Old keys' },
      body: 'x',
    });
    await dana('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    await adam('DELETE', '/auth/step-up');
    // the submitter is not asked (the route refuses them itself) …
    const own = await refusal(dana('POST', `/records/${rec.id}/transition`, { action: 'approve' }));
    expect(own.status).toBe(403);
    expect(own.code).not.toBe('STEP_UP_REQUIRED');
    // … the approver is
    const r = await refusal(adam('POST', `/records/${rec.id}/transition`, { action: 'approve', comment: 'ok' }));
    expect(r).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(r.body.stepUp).toMatchObject({ method: 'password', action: 'approveRecord' });
    await adam('POST', '/auth/step-up', { password: PW });
    expect((await adam('POST', `/records/${rec.id}/transition`, { action: 'approve', comment: 'ok' })).status).toBe('approved');
    const e = (await s.api('GET', `/audit?entityId=${rec.id}&limit=20`)).find((x: any) => x.action === 'record.approve');
    const proof = e.details.assurance.find((p: any) => p.point === 'record.approve');
    expect(proof).toMatchObject({
      actor: 'adam',
      policyVersion: 3,
      rule: { stepUp: true, fourEyes: true },
      stepUp: { method: 'password', mfa: false },
      fourEyes: { required: true, approver: 'adam', checks: ['user', 'aliases', 'ssoSubject'] },
    });
    expect(proof.fourEyes.requesters).toContain('dana');
    expect(proof.session).toMatch(/^[0-9a-f]{16}$/);
    expect(proof.stepUp.confirmedAt).toBeTruthy();
    // implementing is no control point: no confirmation asked
    await dana('DELETE', '/auth/step-up');
    expect((await dana('POST', `/records/${rec.id}/transition`, { action: 'implement' })).status).toBe('implemented');
  });

  it('treats two accounts linked to the same single sign-on identity as one person', async () => {
    const mk = async (username: string, roles: string[]) => {
      const { temporaryPassword } = await s.api('POST', '/users', { username, roles });
      const first = await s.as(username, temporaryPassword);
      await first('POST', '/auth/password', { current: temporaryPassword, next: `${username}-Password-1` });
      return s.as(username, `${username}-Password-1`);
    };
    const p1 = await mk('pat-designer', ['designer']);
    const p2 = await mk('pat-approver', ['approver']);
    const { db } = await import('../src/db.js');
    const { invalidateAliases, sameIdentity } = await import('../src/auth/aliases.js');
    // the same person through two providers of one identity provider: issuer + sub are the same
    db().run("UPDATE users SET external_sub = ? WHERE username = 'pat-designer'", 'idp_a#iss=https%3A%2F%2Flogin.example#sub=p-123');
    db().run("UPDATE users SET external_sub = ? WHERE username = 'pat-approver'", 'idp_b#iss=https%3A%2F%2Flogin.example#sub=p-123');
    db().run("UPDATE users SET external_sub = ? WHERE username = 'adam'", 'idp_b#iss=https%3A%2F%2Flogin.example#sub=adam-1');
    invalidateAliases();
    const ids = db().all<{ id: string; username: string }>("SELECT id, username FROM users WHERE username IN ('pat-designer', 'pat-approver', 'adam')");
    const user = (n: string) => ids.find((x) => x.username === n)!;
    expect(sameIdentity('pat-designer', user('pat-approver'))).toBe(true);
    expect(sameIdentity('pat-designer', user('adam'))).toBe(false);
    const rec = await p1('POST', '/records', { type: 'CR', title: 'Linked identity', fields: { reason: 'x', risk: 'low', rollbackPlan: 'y' }, body: 'x' });
    await p1('POST', `/records/${rec.id}/transition`, { action: 'submit' });
    const detail = await p2('GET', `/records/${rec.id}`);
    expect(detail.actions.find((a: any) => a.action === 'approve')).toMatchObject({ allowed: false, reasonCode: 'FOUR_EYES_OWNER' });
    expect(await refusal(p2('POST', `/records/${rec.id}/transition`, { action: 'approve' }))).toMatchObject({ status: 403, code: 'FOUR_EYES_OWNER' });
    db().run("UPDATE users SET external_sub = NULL WHERE username IN ('pat-designer', 'pat-approver', 'adam')");
    invalidateAliases();
  });

  /** A session through the mock identity provider (as in step-up.test.ts). */
  async function ssoClient(login: string): Promise<Client> {
    const start = await fetch(`${s.base}/api/auth/oidc/${providerId}/start`, { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location')!);
    authorize.pathname += '/approve';
    authorize.searchParams.set('login', login);
    const approve = await fetch(authorize, { redirect: 'manual' });
    const res = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual', headers: { cookie: ssoBinding(start) } });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
    const key = /localStorage\.setItem\("sm\.sessionKey","([^"]+)"\)/.exec(await res.text())![1]!;
    return sessionClient(s.base, cookie, key);
  }
  async function ssoStepUp(c: Client, login: string, actions: string[]) {
    const start = await c('POST', '/auth/step-up/sso', { actions });
    const url = new URL(start.authorizationUrl);
    const asked = Object.fromEntries(url.searchParams);
    url.pathname += '/approve';
    url.searchParams.set('login', login);
    const approve = await fetch(url, { redirect: 'manual' });
    const callback = await fetch(new URL(approve.headers.get('location')!), { redirect: 'manual', headers: { cookie: c.cookies!() } });
    const html = await callback.text();
    return { asked, html, ticket: /ticket:"([^"]+)"/.exec(html)?.[1] };
  }

  it('requires multi-factor authentication where the policy says so: refused for passwords and SSO without MFA, accepted with amr', async () => {
    await setPolicy(s.api, { 'apiToken.create': { mfa: true } });
    // a password session cannot give a second factor
    const c = await s.as('admin', 'Admin-password-1', { autoStepUp: false });
    expect(await refusal(c('POST', '/me/tokens', { name: 'mfa', scope: 'read' }))).toMatchObject({ status: 403, code: 'ASSURANCE_MFA_REQUIRED' });
    expect((await audits('assurance.mfa_refused', 1))[0]).toMatchObject({ actor: 'admin', details: { points: ['apiToken.create'], method: 'password' } });
    // single sign-on without MFA: asked again – the provider is asked for a second factor, and refused without one
    mock.setMockIdentity('a1f3', { mfa: 'never' });
    const sso = await ssoClient('a1f3');
    const r = await refusal(sso('POST', '/me/tokens', { name: 'mfa', scope: 'read' }));
    expect(r).toMatchObject({ status: 403, code: 'STEP_UP_REQUIRED' });
    expect(r.body.stepUp).toMatchObject({ method: 'sso', mfa: true, action: 'createToken' });
    const no = await ssoStepUp(sso, 'a1f3', ['createToken']);
    expect(no.ticket).toBeUndefined();
    expect((await sso('GET', '/auth/step-up')).failure).toMatchObject({ code: 'STEP_UP_MFA_REQUIRED' });
    // with a second factor the provider reports in amr ("otp" counts under the default list): accepted, and recorded
    mock.setMockIdentity('a1f3', { amr: ['pwd', 'otp'] });
    const yes = await ssoStepUp(sso, 'a1f3', ['createToken']);
    expect(yes.ticket).toBeTruthy();
    expect(await sso('POST', '/auth/step-up/sso/complete', { ticket: yes.ticket })).toMatchObject({ confirmedWith: 'sso+mfa' });
    const token = await sso('POST', '/me/tokens', { name: 'mfa', scope: 'read' });
    expect(token.token).toMatch(/^smt_/);
    const e = (await audits('token.created', 3)).find((x: any) => x.details?.assurance);
    expect(e.details.assurance[0]).toMatchObject({
      point: 'apiToken.create',
      rule: { mfa: true },
      stepUp: { method: 'sso+mfa', mfa: true, amr: ['pwd', 'otp'], provider: expect.any(String) },
    });
    expect(Date.parse(e.details.assurance[0].stepUp.authTime)).toBeGreaterThan(Date.now() - 120_000);
    // configured acr values: asked for, and the provider's acr counts
    // (fewer amr values tighten at once; a new acr value loosens: a second administrator approves it)
    const lists = await setPolicy(s.api, {}, { mfa: { amrValues: ['mfa'], acrValues: ['urn:example:mfa'] } });
    expect(lists.pending.changes).toEqual([expect.objectContaining({ point: 'mfa.acrValues', direction: 'loosen' })]);
    await admin2('POST', `/assurance/policy/changes/${lists.pending.id}/approve`, {});
    mock.setMockIdentity('a1f3', { mfa: 'whenAsked', amr: ['pwd'] });
    const acr = await ssoStepUp(sso, 'a1f3', ['createToken']);
    expect(acr.asked.acr_values).toBe('urn:example:mfa');
    expect(acr.ticket).toBeTruthy();
    await sso('POST', '/auth/step-up/sso/complete', { ticket: acr.ticket });
    await sso('POST', '/me/tokens', { name: 'mfa-acr', scope: 'read' });
  });

  it('reports the policy, its changes, the events per control point and the exceptions (PDF and JSON)', async () => {
    const from = new Date(Date.now() - 3600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const json = await s.api('GET', `/assurance/report?${q}&format=json`);
    expect(json).toMatchObject({ format: 'steward-assurance-report', startVersion: 0 });
    expect(json.endVersion).toBeGreaterThanOrEqual(5);
    expect(json.versions.map((v: any) => v.version)).toEqual(expect.arrayContaining([1, 2, 3]));
    const approve = json.points.find((p: any) => p.point === 'record.approve');
    expect(approve).toMatchObject({ events: 1, fourEyes: 1, methods: { password: 1 } });
    expect(json.points.find((p: any) => p.point === 'apiToken.create').methods['sso+mfa']).toBeGreaterThanOrEqual(1);
    const kinds = json.exceptions.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['mfaRefused', 'loosening']));
    expect(json.exceptions.find((e: any) => e.kind === 'loosening').text).toContain('admin2');
    expect(json.requests.map((r: any) => r.outcome)).toEqual(expect.arrayContaining(['approved', 'expired', 'rejected', 'withdrawn']));
    expect(json.events.some((e: any) => e.proof.point === 'record.approve' && e.seq > 0)).toBe(true);
    expect(json.rules.find((r: any) => r.point === 'vault.passphrase')).toMatchObject({ baseline: true, stepUp: true });
    // PDF/A
    const cookie = await loginCookie(s.base, 'admin', 'Admin-password-1');
    const res = await fetch(`${s.base}/api/assurance/report?${q}&lang=de`, { headers: { 'x-sm-client': '1', ...authHeaders(cookie) } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/OutputIntents');
    expect((await audits('assurance.report_exported', 1))[0]).toMatchObject({ actor: 'admin' });
    // not for viewers; auditors yes
    const vera = await s.as('vera', PW);
    expect((await refusal(vera('GET', `/assurance/report?${q}&format=json`))).status).toBe(403);
    const audrey = await s.as('audrey', PW);
    expect((await audrey('GET', `/assurance/report?${q}&format=json`)).generatedBy).toBe('audrey');
  });

  it('puts the assurance report into evidence packs, listed in the signed manifest', async () => {
    const control = (await s.api('GET', '/compliance/controls?catalogue=ISO27001'))[0];
    const from = new Date(Date.now() - 3600_000).toISOString();
    const p = await s.api('POST', '/compliance/evidence-packs', {
      scope: { controlIds: [control.id] },
      from,
      to: new Date(Date.now() + 60_000).toISOString(),
      assurance: true,
    });
    let done = p;
    for (let i = 0; i < 120 && done.status === 'building'; i++) {
      await new Promise((r) => setTimeout(r, 250));
      done = await s.api('GET', `/compliance/evidence-packs/${p.id}`);
    }
    expect(done.status).toBe('ready');
    const cookie = await loginCookie(s.base, 'admin', 'Admin-password-1');
    const res = await fetch(`${s.base}/api/compliance/evidence-packs/${p.id}/download`, { headers: { 'x-sm-client': '1', ...authHeaders(cookie) } });
    expect(res.status).toBe(200);
    const file = path.join(s.dataDir, 'assurance-pack.zip');
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const { ZipReader } = await import('../src/compliance/zip.js');
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const zip = await ZipReader.open(file);
    const manifest = JSON.parse((await zip.read(zip.find('manifest.json')!)).toString());
    expect(manifest.files.map((f: any) => f.path)).toEqual(expect.arrayContaining(['assurance/assurance-report.pdf', 'assurance/assurance-report.json']));
    const index = JSON.parse((await zip.read(zip.find('index.json')!)).toString());
    expect(index.assurance).toMatchObject({ included: true, files: ['assurance/assurance-report.pdf', 'assurance/assurance-report.json'] });
    const report = JSON.parse((await zip.read(zip.find('assurance/assurance-report.json')!)).toString());
    expect(report.points.some((x: any) => x.point === 'record.approve')).toBe(true);
    const v = await verifyPack(file);
    expect(v.problems).toEqual([]);
    expect(v).toMatchObject({ ok: true, signatureOk: true });
  });

  it('back to the defaults: nothing asks more than 0.4.0 did', async () => {
    await resetPolicy();
    const v = await s.api('GET', '/assurance/policy');
    expect(v.policy.points).toEqual({});
    expect(v.policy.mfa).toEqual(defaultAssurancePolicy().mfa);
  });
});

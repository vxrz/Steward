import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { controlPoint, instanceRule } from '@sm/shared';
import { ADMIN, setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The statement of applicability with the responsibility matrix (ISO/IEC 27001 clause 6.1.3 d, ADR 0029 part 2): the
 * matrix (parties, supplier values read through, the recovery-test duty, rights, supplier links that move with a
 * merge and go with "not a supplier"), the SoA (pre-filled rows, rights of designers and of a row's owner, the derived
 * suggestion that never overwrites, evidence and findings per row, settings), versions (frozen content and SHA-256,
 * approval with the control point soa.approve: step-up and a second person, return), the signed export verified
 * offline, the public API, MCP, the dataset, limits and the audit trail.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let dana: Client, olivia: Client, adam: Client, audrey: Client, vera: Client;
let svcA: string, svcB: string, svcC: string;
let supplierId: string, contractId: string;
const ctl: Record<string, string> = {};
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
  (await s.api('GET', `/audit?entityId=${encodeURIComponent(entityId)}&limit=200`)) as { action: string; details?: any; summary: string }[];
const entry = (soa: any, ref: string) => soa.entries.find((e: any) => e.ref === ref);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam, audrey, vera] = await Promise.all(['dana', 'olivia', 'adam', 'audrey', 'vera'].map((u) => s.as(u, PW)));
  svcA = (await dana('POST', '/services', { name: 'Payroll (soa)', owners: ['user:olivia'] })).id;
  svcB = (await dana('POST', '/services', { name: 'Archive (soa)' })).id;
  svcC = (await dana('POST', '/services', { name: 'Intranet (soa)' })).id;
  const sup = await dana('POST', '/suppliers', { name: 'Hostwell (soa)', type: 'managedPlatform' });
  supplierId = sup.id;
  const withContract = await dana('POST', `/suppliers/${supplierId}/contracts`, {
    title: 'Managed hosting',
    slaAvailability: 99.9,
    slaSupportHours: '24/7',
    rtoHours: 4,
    rpoHours: 1,
  });
  contractId = withContract.contracts[0].id;
  await dana('POST', `/suppliers/${supplierId}/certificates`, { kind: 'iso27001', scope: 'Hosting', validUntil: '2099-01-01' });
  const controls = await s.api('GET', '/compliance/controls?catalogue=ISO27001');
  for (const c of controls) ctl[c.ref] = c.id;
});

describe('the responsibility matrix', () => {
  it('starts undecided with the default Annex A controls of each area', async () => {
    const m = await olivia('GET', `/services/${svcA}/responsibilities`);
    expect(m.rows.map((r: any) => r.area)).toEqual(['backup', 'recovery', 'patching', 'access', 'logging', 'incidents']);
    expect(m.undecided).toBe(6);
    expect(m.canEdit).toBe(true);
    expect(m.rows.find((r: any) => r.area === 'recovery').controls.map((c: any) => c.ref)).toEqual(['5.29', '5.30', '8.14']);
    expect(m.rows.find((r: any) => r.area === 'access').controls.map((c: any) => c.ref)).toEqual(['5.15', '5.16', '5.17', '5.18', '8.2', '8.5']);
    expect((await vera('GET', `/services/${svcA}/responsibilities`)).canEdit).toBe(false);
  });

  it('lets whoever may edit the service set it, reads the supplier values through and audits the change', async () => {
    expect(await status(vera('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'backup', party: 'team' }] }))).toBe(403);
    expect(await status(audrey('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'backup', party: 'team' }] }))).toBe(403);
    // olivia owns service A, not service B
    expect(await status(olivia('PUT', `/services/${svcB}/responsibilities`, { areas: [{ area: 'backup', party: 'team' }] }))).toBe(403);
    const m = await olivia('PUT', `/services/${svcA}/responsibilities`, {
      areas: [
        { area: 'backup', party: 'supplier', supplierId, contractId },
        { area: 'recovery', party: 'team' },
        { area: 'patching', party: 'central', centralName: 'Group IT' },
        { area: 'access', party: 'team' },
        { area: 'logging', party: 'notApplicable' },
        { area: 'incidents', party: 'shared', note: 'Group SOC triages, we fix' },
      ],
    });
    const backup = m.rows.find((r: any) => r.area === 'backup');
    expect(backup).toMatchObject({
      party: 'supplier',
      supplier: { id: supplierId, name: 'Hostwell (soa)' },
      contract: { id: contractId, rtoHours: 4, rpoHours: 1, slaAvailability: 99.9 },
      certificates: [{ kind: 'iso27001', validUntil: '2099-01-01' }],
      recoveryTest: 'notNeeded',
    });
    // the supplier record changes, the matrix shows it (read, not copied)
    await dana('PUT', `/suppliers/${supplierId}/contracts/${contractId}`, { title: 'Managed hosting', rtoHours: 2, rpoHours: 1 });
    expect((await olivia('GET', `/services/${svcA}/responsibilities`)).rows.find((r: any) => r.area === 'backup').contract.rtoHours).toBe(2);
    expect(m.undecided).toBe(0);
    const audit = await auditOf(svcA);
    expect(audit.map((a) => a.action)).toContain('responsibility.changed');
    expect(audit.find((a) => a.action === 'responsibility.changed')!.details.changes.length).toBe(6);
  });

  it('asks for a recovery-test duty only where the team does recovery itself', async () => {
    const m = await olivia('GET', `/services/${svcA}/responsibilities`);
    expect(m.rows.find((r: any) => r.area === 'recovery').recoveryTest).toBe('missing');
    expect(m.rows.find((r: any) => r.area === 'patching').recoveryTest).toBe('notNeeded');
    const procs = await s.api('GET', '/processes');
    const duty = await dana('POST', '/duties', {
      serviceId: svcA,
      processId: procs[0].id,
      name: 'Quarterly restore test (soa)',
      interval: 'quarterly',
      level: 'mandatory',
    });
    const other = await dana('POST', '/duties', {
      serviceId: svcB,
      processId: procs[0].id,
      name: 'Other restore (soa)',
      interval: 'quarterly',
      level: 'mandatory',
    });
    expect(await code(olivia('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'recovery', party: 'team', dutyId: other.id }] }))).toBe(
      'RESPONSIBILITY_DUTY_UNKNOWN',
    );
    const after = await olivia('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'recovery', party: 'team', dutyId: duty.id }] });
    expect(after.rows.find((r: any) => r.area === 'recovery')).toMatchObject({ recoveryTest: 'linked', duty: { id: duty.id } });
  });

  it('validates parties, suppliers and contracts', async () => {
    expect(await code(olivia('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'patching', party: 'central' }] }))).toBe(
      'RESPONSIBILITY_CENTRAL_NAME',
    );
    expect(await code(olivia('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'incidents', party: 'shared' }] }))).toBe(
      'RESPONSIBILITY_NOTE_REQUIRED',
    );
    expect(
      await code(olivia('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'logging', party: 'supplier', supplierId: 'sup_missing' }] })),
    ).toBe('SUPPLIER_NOT_FOUND');
    const other = await dana('POST', '/suppliers', { name: 'Othercorp (soa)' });
    expect(
      await code(olivia('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'logging', party: 'supplier', supplierId: other.id, contractId }] })),
    ).toBe('SUPPLIER_CONTRACT_NOT_FOUND');
    expect(await status(olivia('PUT', `/services/${svcA}/responsibilities`, { areas: [{ area: 'nope', party: 'team' }] }))).toBe(400);
    expect(
      await status(
        olivia('PUT', `/services/${svcA}/responsibilities`, {
          areas: [
            { area: 'backup', party: 'team' },
            { area: 'backup', party: 'team' },
          ],
        }),
      ),
    ).toBe(400);
  });

  it('counts the matrix rows as uses of the supplier', async () => {
    const sup = await s.api('GET', `/suppliers/${supplierId}`);
    expect(sup.usage.responsibility).toBe(1);
    expect(sup.usedBy.find((u: any) => u.kind === 'responsibility')).toMatchObject({ name: 'Payroll (soa)', path: `/services/${svcA}/responsibilities` });
  });
});

describe('the statement of applicability', () => {
  it('is created once per catalogue, pre-filled with one undecided row per control', async () => {
    expect(await status(olivia('POST', '/compliance/soa', { catalogueId: 'ISO27001' }))).toBe(403);
    const list = await dana('GET', '/compliance/soa');
    expect(list.canCreate).toBe(true);
    expect(list.catalogues.map((c: any) => c.key)).toContain('ISO27001');
    const soa = await dana('POST', '/compliance/soa', { catalogueId: 'ISO27001', scopeName: 'Payroll and archive', scopeServiceIds: [svcA, svcB] });
    expect(soa.entries.length).toBe(Object.keys(ctl).length);
    expect(soa.counts).toMatchObject({ controls: soa.entries.length, undecided: soa.entries.length, applicable: 0 });
    expect(soa.entries.every((e: any) => e.applicable === null && !e.decided)).toBe(true);
    expect(soa.fourEyes).toBe(true);
    expect(soa.scopeServices.map((x: any) => x.name)).toEqual(['Archive (soa)', 'Payroll (soa)']);
    expect(soa.permissions).toMatchObject({ edit: true, submit: false, submitBlocked: 'undecided', areaControls: false });
    expect(await code(dana('POST', '/compliance/soa', { catalogueId: 'ISO27001' }))).toBe('SOA_EXISTS');
    expect(await code(dana('POST', '/compliance/soa', { catalogueId: 'NOPE' }))).toBe('CATALOGUE_NOT_FOUND');
    expect(await code(dana('POST', '/compliance/soa', { catalogueId: 'NIS2', scopeServiceIds: ['svc_missing'] }))).toBe('SOA_SERVICE_UNKNOWN');
    expect((await auditOf(soa.id)).map((a) => a.action)).toContain('soa.created');
    // everyone who can sign in reads it
    expect((await vera('GET', '/compliance/soa/ISO27001')).permissions.edit).toBe(false);
    expect((await vera('GET', '/compliance/soa')).items.map((x: any) => x.catalogueKey)).toContain('ISO27001');
  });

  it('shows the derived suggestion from the matrix and never writes it into the row', async () => {
    // B: backup by the team; A: backup by the supplier
    await dana('PUT', `/services/${svcB}/responsibilities`, { areas: [{ area: 'backup', party: 'team' }] });
    const soa = await s.api('GET', '/compliance/soa/ISO27001');
    expect(soa.servicesInScope).toBe(2);
    const backup = entry(soa, '8.13');
    expect(backup.areas).toEqual(['backup']);
    expect(backup.suggestion).toMatchObject({ counts: { supplier: 1, team: 1 }, party: 'shared', undecided: 0 });
    const access = entry(soa, '5.18');
    // A: team; B: undecided
    expect(access.suggestion).toMatchObject({ counts: { team: 1 }, party: 'team', undecided: 1 });
    expect(entry(soa, '6.1').suggestion).toBeNull();
    expect(backup.party).toBeNull();
    // the person chooses the supplier; the matrix changes later: the stored party stays, the suggestion follows
    await dana('PUT', `/compliance/soa/ISO27001/entries/${ctl['8.13']}`, { party: 'supplier', supplierId });
    await dana('PUT', `/services/${svcB}/responsibilities`, { areas: [{ area: 'backup', party: 'supplier', supplierId }] });
    const after = entry(await s.api('GET', '/compliance/soa/ISO27001'), '8.13');
    expect(after.party).toBe('supplier');
    expect(after.supplier).toMatchObject({ id: supplierId });
    expect(after.suggestion).toMatchObject({ counts: { supplier: 2, team: 0 }, party: 'supplier', supplier: { id: supplierId } });
    await dana('PUT', `/services/${svcB}/responsibilities`, { areas: [{ area: 'backup', party: 'team' }] });
    expect(entry(await s.api('GET', '/compliance/soa/ISO27001'), '8.13').party).toBe('supplier');
    // a row that names a supplier counts as a use of it
    expect((await s.api('GET', `/suppliers/${supplierId}`)).usage.soaEntry).toBe(1);
  });

  it('lets designers and administrators change rows, and a row’s owner its status, how it is met and the review', async () => {
    const url = `/compliance/soa/ISO27001/entries/${ctl['5.18']}`;
    expect(await status(olivia('PUT', url, { status: 'implemented' }))).toBe(403);
    const e = await dana('PUT', url, {
      applicable: true,
      justification: 'Leavers must lose access',
      status: 'partly',
      party: 'team',
      owner: 'user:olivia',
      grcRef: 'RISK-1',
      grcUrl: 'https://grc.example.com/1',
      evidenceLinks: [{ title: 'Scanner report', url: 'https://scanner.example.com/r/1' }],
    });
    expect(e).toMatchObject({ applicable: true, status: 'partly', owner: 'user:olivia', decided: true, canEdit: true });
    // the owner: status, how it is met, the review – nothing else
    const own = await olivia('PUT', url, { status: 'implemented', howMet: 'Daily feed from HR', reviewed: true });
    expect(own).toMatchObject({ status: 'implemented', howMet: 'Daily feed from HR', reviewedBy: 'olivia', canEdit: false, canEditOwn: true });
    expect(await status(olivia('PUT', url, { justification: 'mine' }))).toBe(403);
    expect(await status(olivia('PUT', url, { status: 'planned', party: 'supplier' }))).toBe(403);
    expect(await status(adam('PUT', url, { status: 'planned' }))).toBe(403);
    // a team as the owner: its members
    await dana('PUT', url, { owner: 'team:service desk' });
    expect((await adam('PUT', url, { reviewed: true })).reviewedBy).toBe('adam');
    await dana('PUT', url, { owner: 'user:olivia' });
    // validation
    expect(await code(dana('PUT', url, { owner: 'user:nobody' }))).toBe('USER_UNKNOWN');
    expect(await status(dana('PUT', url, { grcUrl: 'javascript:alert(1)' }))).toBe(400);
    expect(await status(dana('PUT', url, { justification: 'x'.repeat(2001) }))).toBe(400);
    expect(await status(dana('PUT', url, { howMet: 'x'.repeat(1001) }))).toBe(400);
    expect(await status(dana('PUT', url, { evidenceLinks: Array.from({ length: 11 }, (_, i) => ({ title: `L${i}`, url: `https://e.example/${i}` })) }))).toBe(
      400,
    );
    expect(await code(dana('PUT', `/compliance/soa/ISO27001/entries/ctl_missing`, { applicable: true }))).toBe('CONTROL_NOT_FOUND');
    // not applicable: the status goes
    const na = await dana('PUT', `/compliance/soa/ISO27001/entries/${ctl['7.1']}`, { applicable: false, justification: 'No premises', status: 'implemented' });
    expect(na).toMatchObject({ applicable: false, status: null, decided: true });
    // audited with before and after, marked when the owner changed it
    const soa = await s.api('GET', '/compliance/soa/ISO27001');
    const changes = (await auditOf(soa.id)).filter((a) => a.action === 'soa.entry_changed' && a.details.ref === '5.18');
    expect(changes.some((a) => a.details.byOwner === true && a.details.after.status === 'implemented' && a.details.before.status === 'partly')).toBe(true);
  });

  it('marks an implemented row without mapped items or links as "no evidence", and shows the evidence it has', async () => {
    const url = `/compliance/soa/ISO27001/entries/${ctl['8.8']}`;
    const e = await dana('PUT', url, { applicable: true, justification: 'Internet-facing', status: 'implemented' });
    expect(e.noEvidence).toBe(true);
    expect(e.evidence).toMatchObject({ status: 'unmapped', mapped: 0 });
    expect((await dana('PUT', url, { evidenceLinks: [{ title: 'Scan', url: 'https://scan.example.com' }] })).noEvidence).toBe(false);
    // 5.18 has the access change record type mapped by default
    const access = entry(await vera('GET', '/compliance/soa/ISO27001'), '5.18');
    expect(access.evidence.mapped).toBeGreaterThan(0);
    expect(access.noEvidence).toBe(false);
  });

  it('shows the open corrective action findings of the row’s control', async () => {
    await s.api('POST', '/compliance/corrective-actions', { title: 'Leavers (soa)', source: 'internalAudit', controlIds: [ctl['5.18']] });
    const e = entry(await s.api('GET', '/compliance/soa/ISO27001'), '5.18');
    expect(e.findings).toEqual({ open: 1, total: 1 });
    // a reader who may not see the finding sees no count
    expect(entry(await vera('GET', '/compliance/soa/ISO27001'), '5.18').findings).toEqual({ open: 0, total: 0 });
  });

  it('changes the settings; the controls per area are for administrators', async () => {
    const soa = await dana('PUT', '/compliance/soa/ISO27001/settings', { scopeName: 'Payroll', fourEyes: true });
    expect(soa.scopeName).toBe('Payroll');
    expect(await status(dana('PUT', '/compliance/soa/ISO27001/settings', { areaControls: { backup: [ctl['8.13'], ctl['8.14']] } }))).toBe(403);
    expect(await status(olivia('PUT', '/compliance/soa/ISO27001/settings', { scopeName: 'x' }))).toBe(403);
    expect(await code(s.api('PUT', '/compliance/soa/ISO27001/settings', { areaControls: { backup: ['ctl_missing'] } }))).toBe('SOA_CONTROL_UNKNOWN');
    const own = await s.api('PUT', '/compliance/soa/ISO27001/settings', { areaControls: { backup: [ctl['8.13'], ctl['8.14']] } });
    expect(own.areaControlsDefault).toBe(false);
    expect(entry(own, '8.14').areas).toEqual(['backup']);
    // back to the defaults
    const back = await s.api('PUT', '/compliance/soa/ISO27001/settings', { areaControls: {} });
    expect(back.areaControlsDefault).toBe(true);
    expect(entry(back, '8.14').areas).toEqual(['recovery']);
    expect((await auditOf(soa.id)).map((a) => a.action)).toContain('soa.settings_changed');
  });
});

/** Decides every row still open (designer): applicable controls implemented. */
async function decideAll(): Promise<void> {
  const soa = await s.api('GET', '/compliance/soa/ISO27001');
  for (const e of soa.entries.filter((x: any) => !x.decided))
    await dana('PUT', `/compliance/soa/ISO27001/entries/${e.controlId}`, {
      applicable: e.applicable ?? true,
      justification: e.justification || 'Needed for the services in scope',
      status: e.status ?? 'implemented',
    });
}

describe('versions, approval and the signed export', () => {
  let soaId: string;
  let firstSha: string;

  it('submits only when every row is decided, freezing the content with its SHA-256', async () => {
    expect(await code(dana('POST', '/compliance/soa/ISO27001/versions'))).toBe('SOA_UNDECIDED');
    await decideAll();
    expect(await status(olivia('POST', '/compliance/soa/ISO27001/versions'))).toBe(403);
    const soa = await dana('POST', '/compliance/soa/ISO27001/versions');
    soaId = soa.id;
    expect(soa.waiting).toMatchObject({ number: 1, submittedBy: 'dana' });
    expect(soa.permissions).toMatchObject({ submit: false, submitBlocked: 'waiting' });
    const v = await vera('GET', '/compliance/soa/ISO27001/versions/1');
    expect(v.status).toBe('submitted');
    expect(v.content.entries.length).toBe(soa.entries.length);
    expect(v.content.entries.find((e: any) => e.ref === '8.13')).toMatchObject({ party: 'supplier', supplier: 'Hostwell (soa)' });
    // the frozen content and its hash
    const { db } = await import('../src/db.js');
    const { sha256 } = await import('../src/util.js');
    const row = db().get<{ content: string; content_sha256: string }>(
      'SELECT content, content_sha256 FROM soa_versions WHERE soa_id = ? AND number = 1',
      soaId,
    )!;
    expect(sha256(row.content)).toBe(row.content_sha256);
    expect(v.contentSha256).toBe(row.content_sha256);
    firstSha = row.content_sha256;
    expect(await code(dana('POST', '/compliance/soa/ISO27001/versions'))).toBe('SOA_VERSION_WAITING');
    expect((await auditOf(soaId)).find((a) => a.action === 'soa.version_submitted')!.details.contentSha256).toBe(firstSha);
  });

  it('asks the approver for a fresh confirmation (soa.approve), and refuses others', async () => {
    const p = controlPoint('soa.approve')!;
    expect(instanceRule(p, { points: {} })).toMatchObject({ stepUp: true, fourEyes: 'optional' });
    const fresh = await s.as('adam', PW, { autoStepUp: false });
    // a sign-in counts as a confirmation: ended right away
    await fresh('DELETE', '/auth/step-up');
    expect(await code(fresh('POST', '/compliance/soa/ISO27001/versions/1/decision', { approve: true }))).toBe('STEP_UP_REQUIRED');
    expect(await status(dana('POST', '/compliance/soa/ISO27001/versions/1/decision', { approve: true }))).toBe(403);
    expect(await status(audrey('POST', '/compliance/soa/ISO27001/versions/1/decision', { approve: true }))).toBe(403);
    // an API token never decides
    const token = (await adam('POST', '/me/tokens', { name: 'soa-token', scope: 'full' })).token as string;
    const res = await fetch(`${s.base}/api/compliance/soa/ISO27001/versions/1/decision`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    });
    expect(res.status).toBe(403);
  });

  it('returns a version with a comment', async () => {
    expect(await code(adam('POST', '/compliance/soa/ISO27001/versions/1/decision', { approve: false }))).toBe('SOA_COMMENT_REQUIRED');
    const soa = await adam('POST', '/compliance/soa/ISO27001/versions/1/decision', { approve: false, comment: 'Justify 7.1 better' });
    expect(soa.waiting).toBeNull();
    expect(soa.versions[0]).toMatchObject({ number: 1, status: 'returned', decidedBy: 'adam', comment: 'Justify 7.1 better' });
    expect(await code(adam('POST', '/compliance/soa/ISO27001/versions/1/decision', { approve: true }))).toBe('SOA_VERSION_NOT_WAITING');
    expect((await auditOf(soaId)).map((a) => a.action)).toContain('soa.version_returned');
  });

  it('needs a second person while the switch is on: the submitter never approves', async () => {
    await s.api('PUT', `/compliance/soa/ISO27001/entries/${ctl['7.1']}`, { justification: 'No own premises: the data centres are the suppliers’' });
    await s.api('POST', '/compliance/soa/ISO27001/versions');
    const own = await s.api('GET', '/compliance/soa/ISO27001');
    expect(own.permissions).toMatchObject({ decide: false, decideBlocked: 'ownSubmission', fourEyes: true });
    expect(await code(s.api('POST', '/compliance/soa/ISO27001/versions/2/decision', { approve: true }))).toBe('SOA_FOUR_EYES');
    expect((await adam('GET', '/compliance/soa/ISO27001')).permissions.decide).toBe(true);
  });

  it('approves: the PDF is archived with its SHA-256 in the audit log', async () => {
    const soa = await adam('POST', '/compliance/soa/ISO27001/versions/2/decision', { approve: true, comment: 'Fine' });
    expect(soa.latestApproved).toMatchObject({ number: 2, decidedBy: 'adam' });
    expect(soa.changedSinceApproved).toBe(0);
    const v = soa.versions.find((x: any) => x.number === 2);
    expect(v.status).toBe('approved');
    expect(v.pdfSha256).toMatch(/^[0-9a-f]{64}$/);
    const approved = (await auditOf(soaId)).find((a) => a.action === 'soa.version_approved')!;
    expect(approved.details).toMatchObject({ number: 2, pdfSha256: v.pdfSha256, contentSha256: v.contentSha256, fourEyes: true });
    // the step-up and the second person are recorded with the decision
    expect(approved.details.assurance?.[0]).toMatchObject({ point: 'soa.approve', fourEyes: { required: true, requesters: ['admin'], approver: 'adam' } });
    // a later change shows as "changed since the approved version"
    await dana('PUT', `/compliance/soa/ISO27001/entries/${ctl['8.8']}`, { howMet: 'Weekly image scan' });
    const after = await s.api('GET', '/compliance/soa/ISO27001');
    expect(after.changedSinceApproved).toBe(1);
    expect(entry(after, '8.8').changed).toBe(true);
    expect(entry(after, '5.18').changed).toBe(false);
  });

  it('exports the approved version as PDF, CSV and a signed ZIP that verifies offline', async () => {
    const token = (await audrey('POST', '/me/tokens', { name: 'soa-export', scope: 'read' })).token as string;
    const get = (q: string) => fetch(`${s.base}/api/compliance/soa/ISO27001/versions/${q}`, { headers: { authorization: `Bearer ${token}` } });
    expect((await get('1/export?format=zip')).status).toBe(409);
    const pdf = await get('2/export?format=pdf');
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toContain('application/pdf');
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    const csv = await (await get('2/export?format=csv')).text();
    expect(csv.split('\r\n')[0]).toContain('Control,Title,Applicable,Justification');
    expect(csv).toContain('Hostwell (soa)');
    const zipRes = await get('2/export?format=zip');
    expect(zipRes.status).toBe(200);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-test-'));
    const file = path.join(dir, 'soa.zip');
    fs.writeFileSync(file, Buffer.from(await zipRes.arrayBuffer()));
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const { ZipReader } = await import('../src/compliance/zip.js');
    const { vault, publicKeyFingerprint } = await import('../src/vault.js');
    const fp = publicKeyFingerprint(vault().signingPublicKey()!);
    const r = await verifyPack(file, { fingerprint: fp });
    expect(r).toMatchObject({ ok: true, trusted: true, kind: 'soa', signatureOk: true });
    expect(r.files).toEqual({ listed: 3, ok: 3 });
    const zip = await ZipReader.open(file);
    expect(zip.entries.map((e) => e.name).sort()).toEqual(['manifest.json', 'manifest.sig', 'public-key.pem', 'soa.csv', 'soa.json', 'soa.pdf']);
    const { sha256 } = await import('../src/util.js');
    const v2 = await s.api('GET', '/compliance/soa/ISO27001/versions/2');
    expect(sha256(await zip.read(zip.find('soa.json')!))).toBe(v2.contentSha256);
    expect(sha256(await zip.read(zip.find('soa.pdf')!))).toBe(v2.pdfSha256);
    // the SoA's own signature domain: re-signed under the evidence-pack domain it does not verify
    const manifest = await zip.read(zip.find('manifest.json')!);
    const { MANIFEST_SIGNATURE_DOMAIN } = await import('../src/compliance/evidence-verify.js');
    const { verifySignature } = await import('../src/vault.js');
    const sig = (await zip.read(zip.find('manifest.sig')!)).toString().trim();
    expect(verifySignature(vault().signingPublicKey()!, Buffer.concat([Buffer.from(MANIFEST_SIGNATURE_DOMAIN), manifest]), sig)).toBe(false);
    // a changed file fails the check
    const { ZipWriter } = await import('../src/compliance/zip.js');
    const tampered = path.join(dir, 'tampered.zip');
    const w = await ZipWriter.create(tampered);
    for (const e of zip.entries) {
      const body = await zip.read(e);
      await w.add(e.name, e.name === 'soa.csv' ? Buffer.concat([body, Buffer.from('"X","added"\r\n')]) : body);
    }
    await w.finish();
    const bad = await verifyPack(tampered, { fingerprint: fp });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toContain('soa.csv was changed');
    fs.rmSync(dir, { recursive: true, force: true });
    // viewers do not export; the export is audited
    const vt = (await vera('POST', '/me/tokens', { name: 'soa-vera', scope: 'read' })).token as string;
    expect((await fetch(`${s.base}/api/compliance/soa/ISO27001/versions/2/export?format=csv`, { headers: { authorization: `Bearer ${vt}` } })).status).toBe(
      403,
    );
    expect((await auditOf(soaId)).filter((a) => a.action === 'soa.exported').length).toBe(3);
  });

  it('checks the stored content against its SHA-256 before exporting it, and the verifier checks soa.json against the approval', async () => {
    const { db } = await import('../src/db.js');
    const row = db().get<{ id: string; content: string }>('SELECT id, content FROM soa_versions WHERE soa_id = ? AND number = 2', soaId)!;
    // changed in the database: never signed, exported or put into a pack under the original approval
    db().run('UPDATE soa_versions SET content = ? WHERE id = ?', row.content.replace('Hostwell (soa)', 'Someone else'), row.id);
    try {
      for (const format of ['zip', 'pdf', 'csv'])
        expect(await code(s.api('GET', `/compliance/soa/ISO27001/versions/2/export?format=${format}`)), format).toBe('SOA_CONTENT_CHANGED');
      const { latestApprovedFiles } = await import('../src/compliance/soa.js');
      expect(() => latestApprovedFiles()).toThrow(/does not match its recorded SHA-256/);
    } finally {
      db().run('UPDATE soa_versions SET content = ? WHERE id = ?', row.content, row.id);
    }
    // a signed file whose soa.json is not the content the approval names fails the offline check
    const { ZipWriter } = await import('../src/compliance/zip.js');
    const { verifyPack, SOA_SIGNATURE_DOMAIN } = await import('../src/compliance/evidence-verify.js');
    const { vault, publicKeyFingerprint, publicKeyPem } = await import('../src/vault.js');
    const { sha256 } = await import('../src/util.js');
    const pub = vault().signingPublicKey()!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soa-l3-'));
    try {
      const file = path.join(dir, 'changed.zip');
      const w = await ZipWriter.create(file);
      const changed = Buffer.from(row.content.replace('Hostwell (soa)', 'Someone else'), 'utf8');
      const listed = [await w.add('soa.json', changed)];
      const manifest = {
        format: 'steward-evidence-pack',
        version: 2,
        kind: 'soa',
        pack: { id: row.id, title: 'x', from: '', to: '', createdAt: '', createdBy: 'admin', contentSha256: sha256(row.content) },
        keyFingerprint: publicKeyFingerprint(pub),
        files: listed.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
      };
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      await w.add('manifest.json', bytes);
      await w.add('manifest.sig', Buffer.from(vault().sign(Buffer.concat([Buffer.from(SOA_SIGNATURE_DOMAIN, 'utf8'), bytes])) + '\n'));
      await w.add('public-key.pem', Buffer.from(publicKeyPem(pub)));
      await w.finish();
      const r = await verifyPack(file, { fingerprint: publicKeyFingerprint(pub) });
      expect(r).toMatchObject({ ok: false, signatureOk: true, kind: 'soa' });
      expect(r.problems.join(' ')).toContain('soa.json does not match the content SHA-256 the approval names');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fixes the second person when a version is submitted; only administrators switch it off, after a confirmation', async () => {
    // the administrator submits with the switch on
    const submitted = await s.api('POST', '/compliance/soa/ISO27001/versions');
    expect(submitted.versions[0]).toMatchObject({ number: 3, status: 'submitted', fourEyes: true });
    // a designer (or an approver) never switches it off – also not when creating a statement
    expect(await code(dana('PUT', '/compliance/soa/ISO27001/settings', { fourEyes: false }))).toBe('FORBIDDEN');
    expect(await code(dana('POST', '/compliance/soa', { catalogueId: 'none', fourEyes: false }))).toBe('FORBIDDEN');
    expect((await dana('GET', '/compliance/soa/ISO27001')).permissions.fourEyesOff).toBe(false);
    expect((await dana('GET', '/compliance/soa')).fourEyesOff).toBe(false);
    // an administrator confirms it is them first; other settings need no confirmation
    const fresh = await s.as(ADMIN.username, ADMIN.password, { autoStepUp: false });
    await fresh('DELETE', '/auth/step-up');
    expect(await code(fresh('PUT', '/compliance/soa/ISO27001/settings', { fourEyes: false }))).toBe('STEP_UP_REQUIRED');
    expect(await code(fresh('POST', '/compliance/soa', { catalogueId: 'none', fourEyes: false }))).toBe('STEP_UP_REQUIRED');
    expect((await fresh('PUT', '/compliance/soa/ISO27001/settings', { scopeName: 'Payroll', fourEyes: true })).fourEyes).toBe(true);
    const off = await s.api('PUT', '/compliance/soa/ISO27001/settings', { fourEyes: false });
    expect(off.fourEyes).toBe(false);
    const changed = (await auditOf(soaId)).find((a) => a.action === 'soa.settings_changed' && a.details.fields.includes('fourEyes'))!;
    expect(changed.details).toMatchObject({ before: { fourEyes: true }, after: { fourEyes: false } });
    expect(changed.details.assurance?.[0]).toMatchObject({ point: 'soa.approve', actor: 'admin' });
    // the waiting version keeps the rule it was submitted with: its submitter still does not approve it
    expect(off.permissions).toMatchObject({ decide: false, decideBlocked: 'ownSubmission' });
    expect(off.versions[0]).toMatchObject({ number: 3, fourEyes: true });
    expect(await code(s.api('POST', '/compliance/soa/ISO27001/versions/3/decision', { approve: true }))).toBe('SOA_FOUR_EYES');
    // a designer may switch it on again
    expect((await dana('PUT', '/compliance/soa/ISO27001/settings', { fourEyes: true })).fourEyes).toBe(true);
    await s.api('PUT', '/compliance/soa/ISO27001/settings', { fourEyes: false });
    await adam('POST', '/compliance/soa/ISO27001/versions/3/decision', { approve: false, comment: 'Submitted again without a second person' });
  });

  it('supersedes the approved version with the next one; without the switch the submitter may approve', async () => {
    await s.api('POST', '/compliance/soa/ISO27001/versions');
    expect((await s.api('GET', '/compliance/soa/ISO27001/versions/4')).fourEyes).toBe(false);
    const soa = await s.api('POST', '/compliance/soa/ISO27001/versions/4/decision', { approve: true });
    expect(soa.versions.map((v: any) => [v.number, v.status])).toEqual([
      [4, 'approved'],
      [3, 'returned'],
      [2, 'superseded'],
      [1, 'returned'],
    ]);
    // the policy can require a second person for every SoA
    const policy = await s.api('GET', '/assurance/policy');
    await s.api('PUT', '/assurance/policy', { points: { ...policy.policy.points, 'soa.approve': { fourEyes: 'required' } }, mfa: policy.policy.mfa });
    expect((await s.api('GET', '/compliance/soa/ISO27001')).permissions).toMatchObject({ fourEyes: true, fourEyesRequiredByPolicy: true, fourEyesOff: false });
    // then the switch cannot be turned off at all, not even by an administrator
    await s.api('PUT', '/compliance/soa/ISO27001/settings', { fourEyes: true });
    expect(await code(s.api('PUT', '/compliance/soa/ISO27001/settings', { fourEyes: false }))).toBe('SOA_FOUR_EYES_POLICY');
    expect(await code(s.api('POST', '/compliance/soa', { catalogueId: 'none', fourEyes: false }))).toBe('SOA_FOUR_EYES_POLICY');
    const list = await s.api('GET', '/assurance/policy');
    expect(list.overrides.some((o: any) => o.point === 'soa.approve' && o.kind === 'soa' && o.label === 'ISO27001')).toBe(true);
  });
});

describe('suppliers that are merged or are not a supplier', () => {
  it('moves the matrix and SoA links with a merge and clears them for "not a supplier"', async () => {
    const { db } = await import('../src/db.js');
    const { nowIso } = await import('../src/util.js');
    // an unconfirmed supplier (as after the vendor-text migration) linked from the matrix of service C
    const mk = (id: string, name: string) =>
      db().run(
        "INSERT INTO suppliers (id, name, norm_name, type, status, owners, aliases, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, 'other', 'unconfirmed', '[]', '[]', ?, 'system', ?, 'system')",
        id,
        name,
        name.toLowerCase(),
        nowIso(),
        nowIso(),
      );
    mk('sup_soa_dup', 'Hostwel');
    mk('sup_soa_onprem', 'On-premises (soa)');
    await dana('PUT', `/services/${svcC}/responsibilities`, {
      areas: [
        { area: 'backup', party: 'supplier', supplierId: 'sup_soa_dup' },
        { area: 'patching', party: 'supplier', supplierId: 'sup_soa_onprem' },
      ],
    });
    await dana('PUT', `/compliance/soa/ISO27001/entries/${ctl['5.23']}`, { party: 'supplier', supplierId: 'sup_soa_dup' });
    await dana('POST', '/suppliers/sup_soa_dup/merge', { into: supplierId });
    const m = await dana('GET', `/services/${svcC}/responsibilities`);
    expect(m.rows.find((r: any) => r.area === 'backup').supplier).toMatchObject({ id: supplierId });
    expect(entry(await s.api('GET', '/compliance/soa/ISO27001'), '5.23').supplier).toMatchObject({ id: supplierId });
    await dana('POST', '/suppliers/sup_soa_onprem/not-a-supplier', {});
    const after = await dana('GET', `/services/${svcC}/responsibilities`);
    expect(after.rows.find((r: any) => r.area === 'patching')).toMatchObject({ party: 'supplier', supplier: null, supplierHidden: false });
  });

  it('keeps the matrix row when its contract is removed, without the contract', async () => {
    const sup = await dana('POST', `/suppliers/${supplierId}/contracts`, { title: 'Short-lived' });
    const c = sup.contracts.find((x: any) => x.title === 'Short-lived').id;
    await dana('PUT', `/services/${svcC}/responsibilities`, { areas: [{ area: 'backup', party: 'supplier', supplierId, contractId: c }] });
    await dana('DELETE', `/suppliers/${supplierId}/contracts/${c}`);
    const row = (await dana('GET', `/services/${svcC}/responsibilities`)).rows.find((r: any) => r.area === 'backup');
    expect(row).toMatchObject({ party: 'supplier', supplier: { id: supplierId }, contract: null });
  });
});

describe('reading through the API, MCP and the dataset', () => {
  it('serves /api/v1/statements-of-applicability and the matrix with the token owner’s rights', async () => {
    const token = (await vera('POST', '/me/tokens', { name: 'soa-v1', scope: 'read' })).token as string;
    const v1 = async (p: string) => {
      const res = await fetch(`${s.base}/api/v1${p}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, json: await res.json() };
    };
    const list = await v1('/statements-of-applicability');
    expect(list.status).toBe(200);
    expect(list.json.items.find((x: any) => x.catalogueKey === 'ISO27001')).toMatchObject({ latestApproved: { number: 4 } });
    const one = await v1('/statements-of-applicability/ISO27001');
    expect(one.status).toBe(200);
    expect(one.json.entries.find((e: any) => e.ref === '5.18')).toMatchObject({ applicable: true, owner: 'user:olivia', grcRef: 'RISK-1' });
    expect(one.json.entries[0].canEdit).toBeUndefined();
    expect(one.json.versions.map((v: any) => v.number)).toEqual([4, 3, 2, 1]);
    expect((await v1('/statements-of-applicability/NIS2')).status).toBe(404);
    const m = await v1(`/services/${svcA}/responsibilities`);
    expect(m.json.rows.find((r: any) => r.area === 'backup')).toMatchObject({ party: 'supplier', supplier: { name: 'Hostwell (soa)' } });
    expect(m.json.canEdit).toBeUndefined();
  });

  it('offers the MCP tools get_statement_of_applicability and get_service_responsibilities', async () => {
    await s.api('PUT', '/mcp-server', { enabled: true });
    const token = (await audrey('POST', '/me/tokens', { name: 'soa-mcp', scope: 'mcp' })).token as string;
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${s.base}/api/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'mcp-protocol-version': '2026-07-28',
          'mcp-method': 'tools/call',
          'mcp-name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
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
    const list = await call('get_statement_of_applicability', {});
    expect(list.structuredContent.items.some((x: any) => x.catalogueKey === 'ISO27001')).toBe(true);
    const page = await call('get_statement_of_applicability', { catalogueKey: 'ISO27001', limit: 10 });
    expect(page.structuredContent.entries.length).toBe(10);
    expect(page.structuredContent.nextCursor).toBeTruthy();
    expect((await call('get_statement_of_applicability', { catalogueKey: 'NOPE' })).isError).toBe(true);
    const m = await call('get_service_responsibilities', { serviceId: svcA });
    expect(m.structuredContent.rows.find((r: any) => r.area === 'recovery')).toMatchObject({ party: 'team', recoveryTest: 'linked' });
  });

  it('publishes the dataset compliance.soa for administrators and auditors', async () => {
    const soa = await import('../src/compliance/soa.js');
    expect(soa.publishSoaDataset(true)).toBe(true);
    const ds = await audrey('GET', '/datasets/compliance.soa');
    expect(ds.rows.some((r: any) => r.Catalogue === 'ISO27001' && r.Control === '5.18' && r.Owner === 'user:olivia')).toBe(true);
    expect(await status(olivia('GET', '/datasets/compliance.soa'))).toBe(404);
  });

  it('gives the summary helpers of the ISMS report', async () => {
    const soa = await import('../src/compliance/soa.js');
    const { runAs } = await import('../src/auth/context.js');
    const st = runAs(null, () => soa.soaStatusOf('ISO27001'))!;
    expect(st.latestApproved?.number).toBe(4);
    expect(st.counts.undecided).toBe(0);
    expect(soa.soaStatusOf('NIS2')).toBeNull();
    const decisions = soa.soaDecisions(new Date(Date.now() - 86_400_000).toISOString(), new Date(Date.now() + 60_000).toISOString());
    expect(decisions.map((d) => [d.number, d.status])).toEqual(
      expect.arrayContaining([
        [4, 'approved'],
        [3, 'returned'],
        [1, 'returned'],
      ]),
    );
    // services with gaps in the matrix: A is decided, its recovery has its duty; B decided backup only; C two areas
    const { matrixGaps } = await import('../src/compliance/responsibilities.js');
    const gaps = matrixGaps([svcA, svcB, svcC]);
    expect(gaps.find((g) => g.serviceId === svcA)).toBeUndefined();
    expect(gaps.find((g) => g.serviceId === svcB)).toMatchObject({
      undecided: ['recovery', 'patching', 'access', 'logging', 'incidents'],
      noRecoveryTest: ['backup'],
    });
    expect(gaps.find((g) => g.serviceId === svcC)!.undecided).toHaveLength(4);
  });
});

describe('a version naming suppliers and services the reader may not see (security review 0.17.0)', () => {
  let hiddenSup = '';
  let hiddenSvc = '';
  let n = 0;

  beforeAll(async () => {
    const team = await s.api('POST', '/teams', { name: 'SoA names team', members: ['olivia'] });
    hiddenSup = (await s.api('POST', '/suppliers', { name: 'Shadow Hosting (soa)', type: 'saas' })).id;
    await s.api('PUT', `/owning-teams/supplier/${hiddenSup}`, { teamIds: [team.id] });
    hiddenSvc = (await s.api('POST', '/services', { name: 'Shadow service (soa)' })).id;
    await s.api('PUT', `/owning-teams/service/${hiddenSvc}`, { teamIds: [team.id] });
    const before = await s.api('GET', '/compliance/soa/ISO27001');
    await s.api('PUT', '/compliance/soa/ISO27001/settings', { scopeServiceIds: [...before.scopeServiceIds, hiddenSvc] });
    await s.api('PUT', `/compliance/soa/ISO27001/entries/${ctl['5.23']}`, {
      applicable: true,
      justification: 'Cloud services in use',
      status: 'implemented',
      party: 'supplier',
      supplierId: hiddenSup,
    });
    const soa = await s.api('POST', '/compliance/soa/ISO27001/versions');
    n = soa.waiting.number;
    await adam('POST', `/compliance/soa/ISO27001/versions/${n}/decision`, { approve: true });
  });

  it('leaves them out of what the reader is shown; the stored content and its SHA-256 stay', async () => {
    const shown = await dana('GET', `/compliance/soa/ISO27001/versions/${n}`);
    expect(shown.content.entries.find((e: any) => e.ref === '5.23')).toMatchObject({ party: 'supplier', supplier: null, supplierHidden: true });
    expect(shown.content.scope.services).not.toContain('Shadow service (soa)');
    expect(shown.content.scope.servicesHidden).toBe(1);
    expect(JSON.stringify(shown)).not.toContain('Shadow');
    // auditors and administrators see the frozen content as it is
    for (const c of [audrey, s.api]) {
      const all = await c('GET', `/compliance/soa/ISO27001/versions/${n}`);
      expect(all.content.entries.find((e: any) => e.ref === '5.23').supplier).toBe('Shadow Hosting (soa)');
      expect(all.content.scope.services).toContain('Shadow service (soa)');
      expect(all.content.scope.servicesHidden).toBeUndefined();
    }
    const { db } = await import('../src/db.js');
    const { sha256 } = await import('../src/util.js');
    const row = db().get<{ content: string; content_sha256: string }>('SELECT content, content_sha256 FROM soa_versions WHERE number = ?', n)!;
    expect(row.content).toContain('Shadow Hosting (soa)');
    expect(sha256(row.content)).toBe(row.content_sha256);
  });

  it('exports the signed files and puts them into evidence packs only for who may see every name', async () => {
    const soa = await dana('GET', '/compliance/soa/ISO27001');
    expect(soa.versions.find((v: any) => v.number === n).canExport).toBe(false);
    expect(await code(dana('GET', `/compliance/soa/ISO27001/versions/${n}/export?format=csv`))).toBe('SOA_EXPORT_HIDDEN');
    expect((await audrey('GET', '/compliance/soa/ISO27001')).versions.find((v: any) => v.number === n).canExport).toBe(true);
    const { latestApprovedFiles } = await import('../src/compliance/soa.js');
    const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
    const files = (name: string) => latestApprovedFiles(undefined, toAuthUser(findUserByName(name)!)).find((v) => v.catalogueKey === 'ISO27001')!;
    expect(files('dana')).toMatchObject({ number: n, hidden: true });
    expect(files('audrey')).toMatchObject({ number: n, hidden: false });
  });
});

describe('the module switch', () => {
  it('answers 404 MODULE_OFF while the Compliance module is off', async () => {
    await s.api('PUT', '/settings/modules/compliance', { enabled: false });
    try {
      expect(await code(s.api('GET', '/compliance/soa'))).toBe('MODULE_OFF');
      expect(await code(s.api('GET', `/services/${svcA}/responsibilities`))).toBe('MODULE_OFF');
    } finally {
      await s.api('PUT', '/settings/modules/compliance', { enabled: true });
    }
    expect((await s.api('GET', '/compliance/soa')).items.length).toBe(1);
  });
});

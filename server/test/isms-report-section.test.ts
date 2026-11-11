import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * The ISMS summary and the rest of ADR 0029 part 4: the report section (content, the owner's rights, the period, the
 * module switch, the PDF in English and German), the notification soa.approval_waiting to the approvers, and the
 * soa/ folder of evidence packs (the latest approved version of each catalogue whose controls are in the pack).
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
const DAY = 86_400_000;
let dana: Client, olivia: Client, adam: Client;
let svcA: string, svcB: string;
const ctl: Record<string, string> = {};
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

type Data = {
  moduleOff: boolean;
  soa: { items: any[]; decisions: any[]; missing: string | null };
  corrective: {
    open: Record<string, number>;
    overdue: number;
    overdueList: any[];
    closed: number;
    checks: { effective: number; notEffective: number };
    suggestions: number;
  };
  duties: { counts: Record<string, number>; notMet: any[] };
  reviews: { personReviews: number; removals: number; gone: number; supplierReviews: { done: number; late: number; notDone: number } };
  gaps: { service: string; undecided: string[]; noRecoveryTest: string[] }[];
  suppliers: { items: { supplier: string; kind: string; title: string; date: string; state: string }[]; unconfirmed: number };
};

async function build(user: string, config: Record<string, unknown>, from = Date.now() - 7 * DAY, to = Date.now() + 60_000): Promise<Data> {
  const { reportSection } = await import('../src/reports/sections.js');
  const { runAs } = await import('../src/auth/context.js');
  const { findUserByName, toAuthUser } = await import('../src/auth/users.js');
  const sec = reportSection('isms')!;
  return runAs(toAuthUser(findUserByName(user)!), () => sec.build(sec.schema.parse(config), { from, to, now: Date.now(), lang: 'en' })) as Data;
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [dana, olivia, adam] = await Promise.all(['dana', 'olivia', 'adam'].map((u) => s.as(u, PW)));
  svcA = (await dana('POST', '/services', { name: 'Payroll (isms)', owners: ['user:olivia'] })).id;
  svcB = (await dana('POST', '/services', { name: 'Archive (isms)' })).id;
  // a small catalogue of its own, so the statement is quick to decide
  await s.api('POST', '/compliance/catalogues/import', {
    key: 'ISMSX',
    name: 'ISMS test controls',
    filename: 'isms.csv',
    content: 'ref,title,description\nI.1,Backups,\nI.2,Supplier reviews,\nI.3,Logging,\n',
  });
  for (const c of await s.api('GET', '/compliance/controls?catalogue=ISMSX')) ctl[c.ref] = c.id;
});

describe('the notification soa.approval_waiting', () => {
  it('tells the approvers and administrators – not the submitter – that a version waits', async () => {
    await dana('POST', '/compliance/soa', { catalogueId: 'ISMSX', scopeName: 'Payroll' });
    await dana('PUT', `/compliance/soa/ISMSX/entries/${ctl['I.1']}`, { applicable: true, justification: 'Payroll data', status: 'implemented' });
    await dana('PUT', `/compliance/soa/ISMSX/entries/${ctl['I.2']}`, { applicable: true, justification: 'SaaS payroll', status: 'partly' });
    await dana('PUT', `/compliance/soa/ISMSX/entries/${ctl['I.3']}`, { applicable: false, justification: 'Logged by the supplier' });
    await dana('POST', '/compliance/soa/ISMSX/versions');
    const { flushNotifications } = await import('../src/notifications/service.js');
    await flushNotifications();
    await new Promise((r) => setTimeout(r, 50));
    await flushNotifications();
    const of = async (c: Client) => ((await c('GET', '/notifications')).items as any[]).filter((n) => n.event === 'soa.approval_waiting');
    const mine = await of(adam);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ link: '/compliance/soa/ISMSX' });
    expect(mine[0].title).toContain('ISMSX version 1');
    expect(mine[0].body).toContain('dana submitted version 1');
    expect(await of(s.api)).toHaveLength(1);
    expect(await of(dana)).toHaveLength(0);
    expect(await of(olivia)).toHaveLength(0);
    // a decision: it is grouped with the decisions and never folded into a count
    const { EVENT_DIGEST_GROUP, notificationCategory } = await import('@sm/shared');
    expect(EVENT_DIGEST_GROUP['soa.approval_waiting']).toBe('decisions');
    expect(notificationCategory('soa.approval_waiting')).toBe('decision');
    // approved by adam: the summary below reads version 1
    await adam('POST', '/compliance/soa/ISMSX/versions/1/decision', { approve: true, comment: 'Fine' });
  });
});

describe('the ISMS summary section', () => {
  let sup: string;

  beforeAll(async () => {
    // a row changed after the approval
    await dana('PUT', `/compliance/soa/ISMSX/entries/${ctl['I.2']}`, { howMet: 'Yearly review of the SOC 2 report' });
    // findings: a major one of service A that is overdue, a minor one of service B, an observation closed in the period
    await dana('POST', '/compliance/corrective-actions', {
      title: 'Payroll leavers keep access (isms)',
      source: 'externalAudit',
      severity: 'major',
      serviceId: svcA,
      dueDate: day(-5),
    });
    await dana('POST', '/compliance/corrective-actions', {
      title: 'Archive restore untested (isms)',
      source: 'internalAudit',
      severity: 'minor',
      serviceId: svcB,
    });
    const obs = await dana('POST', '/compliance/corrective-actions', {
      title: 'Payroll runbook outdated (isms)',
      source: 'internalAudit',
      severity: 'observation',
      serviceId: svcA,
    });
    await dana('POST', `/compliance/corrective-actions/${obs.id}/actions`, { title: 'Update the runbook', owners: ['user:dana'], dueDate: day(5), done: true });
    await dana('PUT', `/compliance/corrective-actions/${obs.id}`, { status: 'implemented' });
    await adam('POST', `/compliance/corrective-actions/${obs.id}/effectiveness`, { method: 'Read the runbook', result: 'effective' });
    // the matrix: service A decided in part, recovery by the team without a recovery test
    await olivia('PUT', `/services/${svcA}/responsibilities`, {
      areas: [
        { area: 'backup', party: 'central', centralName: 'Group IT' },
        { area: 'recovery', party: 'team' },
      ],
    });
    // suppliers: a certificate that runs out in 20 days, one that ran out 10 days ago, one far ahead; one to confirm
    sup = (await dana('POST', '/suppliers', { name: 'Payrollio (isms)', type: 'saas' })).id;
    await dana('POST', `/suppliers/${sup}/certificates`, { kind: 'iso27001', name: 'soon', validUntil: day(20) });
    await dana('POST', `/suppliers/${sup}/certificates`, { kind: 'c5', name: 'gone', validUntil: day(-10) });
    await dana('POST', `/suppliers/${sup}/certificates`, { kind: 'tisax', name: 'later', validUntil: day(300) });
    const { db } = await import('../src/db.js');
    const odd = await dana('POST', '/suppliers', { name: 'Unconfirmed Vendor (isms)', type: 'other' });
    db().run("UPDATE suppliers SET status = 'unconfirmed' WHERE id = ?", odd.id);
    // duty periods of the period: a mandatory one missed, one done; a supplier review done late
    const now = new Date().toISOString();
    for (const [id, supplierId, level] of [
      ['dty_isms_a', null, 'mandatory'],
      ['dty_isms_review', sup, 'mandatory'],
    ] as const)
      db().run(
        `INSERT INTO service_duties (id, service_id, supplier_id, name, description, process_id, interval_kind, level, owners, active_from, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, '', 'aws-iam-key-age', 'monthly', ?, '[]', ?, ?, 'admin', ?, 'admin')`,
        id,
        svcA,
        supplierId,
        id === 'dty_isms_a' ? 'Key review (isms)' : 'Supplier review (isms)',
        level,
        now,
        now,
        now,
      );
    const period = (dutyId: string, key: string, status: string, daysAgo: number, name: string) => {
      const end = new Date(Date.now() - daysAgo * DAY).toISOString();
      db().run(
        `INSERT INTO duty_periods (duty_id, period_key, period_start, period_end, grace_end, status, service_id, duty_name, process_id, process_name, level,
           interval_kind, grace_days, time_zone, evaluated_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aws-iam-key-age', 'AWS IAM key age', 'mandatory', 'monthly', 0, 'UTC', ?, ?)`,
        dutyId,
        key,
        new Date(Date.now() - (daysAgo + 30) * DAY).toISOString(),
        end,
        end,
        status,
        svcA,
        name,
        end,
        end,
      );
    };
    period('dty_isms_a', '2026-09', 'missed', 2, 'Key review (isms)');
    period('dty_isms_a', '2026-08', 'done', 40, 'Key review (isms)');
    period('dty_isms_review', '2026-10', 'late', 3, 'Supplier review (isms)');
    // a person review approved now, by adam
    db().run(
      `INSERT INTO person_reviews (id, title, person_name, status, created_by, created_at, approved_by, approved_at)
       VALUES ('prv_isms', 'Leaver review (isms)', 'Invented Leaver', 'approved', 'adam', ?, 'admin', ?)`,
      now,
      now,
    );
  });

  it('is a section of scheduled reports with its options and their defaults', async () => {
    const { reportSection, reportSectionIds } = await import('../src/reports/sections.js');
    expect(reportSectionIds()).toContain('isms');
    expect(reportSection('isms')!.schema.parse({})).toEqual({ catalogue: null, serviceIds: null, days: 90 });
    expect(await dana('GET', '/report-schedules')).toMatchObject({ sections: expect.arrayContaining(['isms']) });
    const bad = (sections: unknown) =>
      dana('POST', '/report-schedules', { name: 'Bad ISMS', preset: 'monthly', sections }).then(
        () => 200,
        (e: { status: number }) => e.status,
      );
    expect(await bad({ isms: { catalogue: 'NOPE' } })).toBe(400);
    expect(await bad({ isms: { days: 0 } })).toBe(400);
    expect(await bad({ isms: { serviceIds: ['svc_nope'] } })).toBe(400);
  });

  it('sums up the statement of applicability, findings, duties, reviews, the matrix and suppliers', async () => {
    const d = await build('admin', { catalogue: 'ISMSX', serviceIds: [svcA, svcB], days: 30 });
    expect(d.moduleOff).toBe(false);
    expect(d.soa.items).toHaveLength(1);
    expect(d.soa.items[0]).toMatchObject({
      catalogueKey: 'ISMSX',
      scopeName: 'Payroll',
      counts: { controls: 3, applicable: 2, notApplicable: 1, undecided: 0, implemented: 1, partly: 1 },
      latestApproved: { number: 1, decidedBy: 'adam' },
      waiting: null,
      changedSinceApproved: 1,
    });
    expect(d.soa.decisions).toEqual([expect.objectContaining({ catalogueKey: 'ISMSX', number: 1, status: 'approved', decidedBy: 'adam' })]);
    expect(d.corrective.open).toEqual({ major: 1, minor: 1, observation: 0 });
    expect(d.corrective.overdue).toBe(1);
    expect(d.corrective.overdueList).toEqual([expect.objectContaining({ title: 'Payroll leavers keep access (isms)', severity: 'major' })]);
    expect(d.corrective.closed).toBe(1);
    expect(d.corrective.checks).toEqual({ effective: 1, notEffective: 0 });
    expect(d.duties.counts).toMatchObject({ missed: 1, late: 1 });
    expect(d.duties.notMet).toEqual([expect.objectContaining({ duty: 'Key review (isms)', period: '2026-09', status: 'missed' })]);
    expect(d.reviews.supplierReviews).toEqual({ done: 0, late: 1, notDone: 0 });
    expect(d.reviews.personReviews).toBeGreaterThanOrEqual(1);
    const gapA = d.gaps.find((g) => g.service === 'Payroll (isms)')!;
    expect(gapA).toEqual({ service: 'Payroll (isms)', undecided: ['patching', 'access', 'logging', 'incidents'], noRecoveryTest: ['recovery'] });
    expect(d.gaps.find((g) => g.service === 'Archive (isms)')!.undecided).toHaveLength(6);
    // only the services asked for
    expect(d.gaps.every((g) => ['Payroll (isms)', 'Archive (isms)'].includes(g.service))).toBe(true);
    const mine = d.suppliers.items.filter((x) => x.supplier === 'Payrollio (isms)');
    expect(mine.map((x) => [x.title, x.state])).toEqual([
      ['c5 gone', 'past'],
      ['iso27001 soon', 'dueSoon'],
    ]);
    expect(d.suppliers.items.some((x) => x.supplier === 'Unconfirmed Vendor (isms)')).toBe(false);
    expect(d.suppliers.unconfirmed).toBeGreaterThanOrEqual(1);
    // without a catalogue: every statement; a catalogue without one says so
    expect((await build('admin', {})).soa.items.map((x) => x.catalogueKey)).toContain('ISMSX');
    expect((await build('admin', { catalogue: 'NIS2' })).soa).toMatchObject({ items: [], missing: 'NIS2' });
  });

  it('counts only what the schedule owner may see', async () => {
    const admin = await build('admin', { catalogue: 'ISMSX', serviceIds: [svcA, svcB] });
    const o = await build('olivia', { catalogue: 'ISMSX', serviceIds: [svcA, svcB] });
    // olivia edits service A only: the finding of service B is not hers to read
    expect(o.corrective.open).toEqual({ major: 1, minor: 0, observation: 0 });
    expect(admin.corrective.open.minor).toBe(1);
    // she may not read person reviews of others
    expect(o.reviews.personReviews).toBe(admin.reviews.personReviews - 1);
    // a supplier of a team she is not in is unknown to her
    const team = await s.api('POST', '/teams', { name: 'ISMS supplier team', members: ['dana'] });
    await s.api('PUT', `/owning-teams/supplier/${sup}`, { teamIds: [team.id] });
    try {
      expect((await build('olivia', { days: 30 })).suppliers.items.some((x) => x.supplier === 'Payrollio (isms)')).toBe(false);
      expect((await build('olivia', { serviceIds: [svcA] })).reviews.supplierReviews.late).toBe(0);
      expect((await build('dana', { days: 30 })).suppliers.items.some((x) => x.supplier === 'Payrollio (isms)')).toBe(true);
    } finally {
      await s.api('PUT', `/owning-teams/supplier/${sup}`, { teamIds: [] });
    }
  });

  it('counts the events of the report period only', async () => {
    const past = await build('admin', { catalogue: 'ISMSX', serviceIds: [svcA, svcB] }, Date.now() - 30 * DAY, Date.now() - 20 * DAY);
    expect(past.soa.decisions).toEqual([]);
    expect(past.corrective.closed).toBe(0);
    expect(past.corrective.checks).toEqual({ effective: 0, notEffective: 0 });
    expect(past.duties.counts.missed).toBe(0);
    expect(past.reviews.supplierReviews.late).toBe(0);
    // the state now stays: open findings and the statement
    expect(past.corrective.open.major).toBe(1);
    expect(past.soa.items[0].latestApproved.number).toBe(1);
  });

  it('holds nothing while the Compliance module is off', async () => {
    await s.api('PUT', '/settings/modules/compliance', { enabled: false });
    try {
      const d = await build('admin', { catalogue: 'ISMSX' });
      expect(d.moduleOff).toBe(true);
      expect(d.soa.items).toEqual([]);
      expect(d.corrective.open).toEqual({ major: 0, minor: 0, observation: 0 });
    } finally {
      await s.api('PUT', '/settings/modules/compliance', { enabled: true });
    }
  });

  it('is drawn into the PDF of a scheduled report, in English and German', async () => {
    const schedules = await import('../src/reports/schedules.js');
    for (const [lang, facts] of [
      ['en', ['ISMS summary', 'Statement of applicability', 'ISMSX · Payroll', 'Corrective actions', 'Payroll leavers keep access (isms)', 'Payrollio (isms)']],
      ['de', ['ISMS-Zusammenfassung', 'Erklärung zur Anwendbarkeit', 'Korrekturmaßnahmen', 'Lücken in der Verantwortungsmatrix']],
    ] as const) {
      const sch = await dana('POST', '/report-schedules', {
        name: `Management review ${lang} (isms)`,
        preset: 'monthly',
        lang,
        sections: { isms: { catalogue: 'ISMSX', serviceIds: [svcA, svcB], days: 30 } },
        recipients: { users: [], teams: [], emails: [] },
      });
      const rec = await schedules.runReportSchedule(sch.id, { actor: 'dana', compress: false });
      const text = rec.texts.join('\n');
      for (const fact of facts) expect(text, `${lang}: ${fact}`).toContain(fact);
    }
  });
});

describe('evidence packs', () => {
  it('hold the latest approved statement of each catalogue whose controls are in the pack, under soa/', async () => {
    const make = async (controlIds: string[]) => {
      const p = await s.api('POST', '/compliance/evidence-packs', {
        title: 'ISMS evidence',
        scope: { controlIds },
        from: new Date(Date.now() - DAY).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      });
      let pack = p;
      for (let i = 0; i < 600 && pack.status === 'building'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        pack = await s.api('GET', `/compliance/evidence-packs/${p.id}`);
      }
      expect(pack.status).toBe('ready');
      const { packsDir } = await import('../src/compliance/evidence-pack.js');
      return path.join(packsDir(), `${p.id}.zip`);
    };
    const { ZipReader } = await import('../src/compliance/zip.js');
    const { verifyPack } = await import('../src/compliance/evidence-verify.js');
    const { db } = await import('../src/db.js');
    const { sha256 } = await import('../src/util.js');
    const file = await make([ctl['I.1']!]);
    expect(fs.existsSync(file)).toBe(true);
    const zip = await ZipReader.open(file);
    const json = (await zip.read(zip.find('soa/ISMSX/soa-ISMSX-v1.json')!)).toString('utf8');
    const v = db().get<{ content_sha256: string; files: string }>(
      "SELECT v.content_sha256, v.files FROM soa_versions v JOIN soas s ON s.id = v.soa_id JOIN control_catalogues k ON k.id = s.catalogue_id WHERE k.key = 'ISMSX' AND v.number = 1",
    )!;
    // the frozen content byte for byte, the archived PDF as recorded, the CSV
    expect(sha256(json)).toBe(v.content_sha256);
    const pdf = await zip.read(zip.find('soa/ISMSX/soa-ISMSX-v1.pdf')!);
    expect(sha256(pdf)).toBe(JSON.parse(v.files).pdf.sha256);
    expect((await zip.read(zip.find('soa/ISMSX/soa-ISMSX-v1.csv')!)).toString('utf8')).toContain('Payroll data');
    const index = JSON.parse((await zip.read(zip.find('index.json')!)).toString('utf8'));
    expect(index.statementsOfApplicability).toEqual([expect.objectContaining({ catalogue: 'ISMSX', number: 1, contentSha256: v.content_sha256 })]);
    expect((await verifyPack(file)).ok).toBe(true);
    // a pack of other controls has no soa/ folder (ISO27001 has no approved statement here)
    const other = await ZipReader.open(await make([(await s.api('GET', '/compliance/controls?catalogue=ISO27001'))[0].id]));
    expect(other.find('soa/ISMSX/soa-ISMSX-v1.json')).toBeFalsy();
  });
});

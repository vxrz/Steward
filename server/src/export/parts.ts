import YAML from 'yaml';
import {
  EXPORT_LIMITS,
  fiscalYearLabel,
  fiscalYearOf,
  type ExportFiscalYear,
  type ExportFormat,
  type ExportPartChoice,
  type ExportPartId,
  type ExportPartInfo,
  type ModuleId,
} from '@sm/shared';
import { csvCell, csvTable } from '../csv.js';

/**
 * The parts a scheduled export can write (0.16.0, docs/EXPORTS.md, ADR 0027) – a registry: each part names its
 * formats, its module and a function that writes its files. A new part is one entry here (and its labels in the web
 * app's settings.json, exports.parts.<id>).
 *
 * Every part runs as the export's system principal (jobs.ts): it sees everything, so only administrators define
 * exports. A part writes what people read in Steward – never a secret: no vault value, no credential, no token, no
 * heartbeat or webhook secret (server/test/exports.test.ts checks the files of every part for the secrets it knows);
 * credentials typed into a monitor's definition are redacted (redact.ts).
 * The code of the areas is loaded when a part runs (lazy imports), so this registry pulls no module in at start.
 */

/** A file of a part, written in pieces (jobs.ts keeps it in the work folder, hashes it while it is written). */
export interface ExportWriter {
  /** Appends text (UTF-8) */
  write(text: string): Promise<void>;
}

export interface ExportContext {
  now: Date;
  /** A new file of the part: written as it goes and uploaded when the part has ended. */
  file(name: string): ExportWriter;
  /** Lets the server answer between pages of rows – a large part never holds the event loop for long. */
  pause(): Promise<void>;
  /** Facts the manifest records for the part, e.g. that the audit log was cut. */
  note(facts: Record<string, unknown>): void;
}

export interface ExportPartDef {
  id: ExportPartId;
  formats: readonly ExportFormat[];
  /** Not exported while this module is switched off (the run says so; the other parts are written) */
  module: ModuleId | null;
  options: readonly ('fiscalYear' | 'days')[];
  /** Writes the part's files with ctx.file – row by row or page by page, never the whole part as one string. */
  write(choice: ExportPartChoice, ctx: ExportContext): Promise<void>;
}

/** The limits of the parts (tests lower them). */
export const partLimits = { auditEntries: EXPORT_LIMITS.auditEntries as number };

/** Rows of plain objects as CSV: one column per key (in order of appearance), lists joined with "; ", objects as JSON. */
export function objectsCsv(items: readonly Record<string, unknown>[]): string {
  const keys: string[] = [];
  for (const i of items) for (const k of Object.keys(i)) if (!keys.includes(k)) keys.push(k);
  return csvTable(
    keys,
    items.map((i) => keys.map((k) => i[k] ?? null)),
    { quote: 'needed', bom: true },
  );
}

/** A CSV file written in pages: the header (with a byte order mark) first, then each page of rows as it comes. */
function csvFile(out: ExportWriter, head: readonly string[]) {
  let started = false;
  const line = (r: readonly unknown[]) => `${r.map((v) => csvCell(v, 'needed')).join(',')}\r\n`;
  return {
    async rows(rows: readonly (readonly unknown[])[]): Promise<void> {
      if (!started) await out.write(`\uFEFF${head.join(',')}\r\n`);
      started = true;
      if (rows.length) await out.write(rows.map(line).join(''));
    },
  };
}

/** The fiscal year of a choice, counted from the run's day. */
async function fiscalYear(which: ExportFiscalYear | undefined, now: Date): Promise<{ year: number; label: string }> {
  const { costSettings } = await import('../costs/access.js');
  const start = costSettings().fiscalYearStartMonth;
  const current = fiscalYearOf(now.toISOString().slice(0, 7), start);
  const year = which === 'previous' ? current - 1 : which === 'next' ? current + 1 : current;
  return { year, label: fiscalYearLabel(year, start) };
}

const costPlans: ExportPartDef = {
  id: 'costPlans',
  formats: ['csv'],
  module: 'costs',
  options: ['fiscalYear'],
  async write(choice, ctx) {
    const { planExportRows, PLAN_EXPORT_HEADS } = await import('../costs/plans.js');
    const fy = await fiscalYear(choice.fiscalYear, ctx.now);
    const fyText = fy.label.replace(/[^0-9A-Za-z]+/g, '-');
    const plan = ctx.file(`cost-plan-lines-${fyText}.csv`);
    const entries = ctx.file(`cost-entries-${fyText}.csv`);
    // one file holds every service's plan, the service first – the same services as the dataset and the team rollup
    await plan.write(`\uFEFF${PLAN_EXPORT_HEADS.plan}\r\n`);
    await entries.write(`\uFEFF${PLAN_EXPORT_HEADS.entries}\r\n`);
    for await (const s of planExportRows(fy.year, ctx.now.getTime())) {
      await plan.write(s.plan.map((r) => `${r}\r\n`).join(''));
      await entries.write(s.entries.map((r) => `${r}\r\n`).join(''));
      await ctx.pause();
    }
    // what the payment schedules still owe (ADR 0030): every schedule of a service that is not archived, as of the run
    const { commitments, commitmentCsvLines, COMMITMENT_CSV_HEAD } = await import('../costs/commitments.js');
    const owed = ctx.file('commitments.csv');
    await owed.write(`\uFEFF${COMMITMENT_CSV_HEAD.join(',')}\r\n`);
    await owed.write(
      commitmentCsvLines(commitments({}, ctx.now.getTime()))
        .map((r) => `${r}\r\n`)
        .join(''),
    );
  },
};

const plant: ExportPartDef = {
  id: 'plant',
  formats: ['yaml', 'json'],
  module: 'plant',
  options: [],
  async write(choice, ctx) {
    const { exportYaml } = await import('../plant/import.js');
    const x = exportYaml({}, { format: choice.format === 'json' ? 'json' : 'yaml' });
    await ctx.file(choice.format === 'json' ? 'plant-registry.json' : 'plant-registry.yaml').write(x.content);
  },
};

const services: ExportPartDef = {
  id: 'services',
  formats: ['csv'],
  module: null,
  options: [],
  async write(_choice, ctx) {
    const { listServiceEntries } = await import('../catalogue/service.js');
    await ctx.file('services.csv').write(objectsCsv(listServiceEntries({ archived: true }) as unknown as Record<string, unknown>[]));
  },
};

const applications: ExportPartDef = {
  id: 'applications',
  formats: ['csv'],
  module: null,
  options: [],
  async write(_choice, ctx) {
    const { listApplicationEntries } = await import('../catalogue/applications.js');
    await ctx.file('applications.csv').write(objectsCsv(listApplicationEntries({ archived: true }) as unknown as Record<string, unknown>[]));
  },
};

const systems: ExportPartDef = {
  id: 'systems',
  formats: ['csv'],
  module: null,
  options: [],
  async write(_choice, ctx) {
    const { listSystemEntries } = await import('../catalogue/systems.js');
    await ctx.file('systems.csv').write(objectsCsv(listSystemEntries() as unknown as Record<string, unknown>[]));
  },
};

const monitors: ExportPartDef = {
  id: 'monitors',
  formats: ['yaml'],
  module: null,
  options: [],
  async write(_choice, ctx) {
    // every monitor (not the templates) in its import format, one YAML document each – heartbeat secrets are never
    // part of a definition; credentials typed into one (request headers, user information or keys in URLs) are
    // redacted, and the manifest says where
    const { exportMonitorDocument, listMonitors } = await import('../monitors/service.js');
    const { redactCredentials } = await import('./redact.js');
    const out = ctx.file('monitors.yaml');
    const list = listMonitors({ templates: false });
    const redacted: string[] = [];
    if (!list.length) await out.write(YAML.stringify([]));
    for (const [i, m] of list.entries()) {
      const doc = exportMonitorDocument(m.id);
      const r = redactCredentials(doc);
      for (const p of r.paths) redacted.push(`${String(doc.key)}: ${p}`);
      await out.write(`---\n${YAML.stringify(r.value, { lineWidth: 0 })}`);
      if (i % 50 === 49) await ctx.pause();
    }
    if (redacted.length) ctx.note({ redacted: redacted.slice(0, 500), redactedCount: redacted.length });
  },
};

const auditLog: ExportPartDef = {
  id: 'auditLog',
  formats: ['csv', 'jsonl'],
  module: null,
  options: ['days'],
  async write(choice, ctx) {
    const { auditCutSeq, queryAudit } = await import('../audit.js');
    const { auditCsvHead, auditCsvLine } = await import('../audit-export.js');
    const days = Math.min(EXPORT_LIMITS.auditDaysMax, Math.max(1, Math.round(choice.days ?? 7)));
    const from = new Date(ctx.now.getTime() - days * 86_400_000).toISOString();
    const to = ctx.now.toISOString();
    const max = partLimits.auditEntries;
    const jsonl = choice.format === 'jsonl';
    const out = ctx.file(jsonl ? 'audit-log.jsonl' : 'audit-log.csv');
    if (!jsonl) await out.write(auditCsvHead());
    // the newest `max` entries of the period, oldest first: start after the newest entry that does not fit
    const cut = auditCutSeq(from, to, max);
    let after = cut ?? undefined;
    let n = 0;
    let first: string | null = null;
    for (;;) {
      const page = queryAudit({ from, to, sort: { key: 'time', dir: 'asc' }, afterSeq: after, limit: 5000 }).slice(0, max - n);
      first ??= page[0]?.ts ?? null;
      await out.write(page.map((e) => (jsonl ? JSON.stringify(e) + '\n' : auditCsvLine(e))).join(''));
      n += page.length;
      if (page.length < 5000 || n >= max) break;
      after = page[page.length - 1]!.seq;
      await ctx.pause();
    }
    // a cut is said in the manifest: the file starts later than the period
    if (cut !== null) ctx.note({ truncated: true, entries: n, firstEntryAt: first, period: { from, to } });
  },
};

const SUPPLIER_HEAD = [
  'Id',
  'Name',
  'Type',
  'Status',
  'Description',
  'Website',
  'Owners',
  'Aliases',
  'Personal data',
  'Data processing agreement',
  'Agreement since',
  'Agreement link',
  'Confidentiality',
  'Integrity',
  'Availability',
  'Contracts',
  'Certificates',
  'Next notice by',
  'Next certificate expiry',
  'Contacts',
  'Used by',
  'Updated',
] as const;
const CONTRACT_HEAD = [
  'Supplier id',
  'Supplier',
  'Contract id',
  'Title',
  'Reference',
  'Starts',
  'Ends',
  'Notice days',
  'Renewal',
  'Renewal months',
  'Term end',
  'Notice by',
  'SLA availability (%)',
  'Support hours',
  'Response times',
  'RTO (hours)',
  'RPO (hours)',
  'Link',
  'Note',
  'Cost plan lines',
] as const;
const CERTIFICATE_HEAD = [
  'Supplier id',
  'Supplier',
  'Certificate id',
  'Kind',
  'Name',
  'Scope',
  'Issuer',
  'Issued',
  'Valid until',
  'State',
  'Link',
  'Checked by',
  'Checked at',
] as const;

const suppliers: ExportPartDef = {
  id: 'suppliers',
  formats: ['csv'],
  module: null,
  options: [],
  async write(_choice, ctx) {
    // as /api/v1 and MCP give them (toPublic): contacts by name and role – never their e-mail or phone (ADR 0029, decided 8)
    const { publicSuppliers } = await import('../suppliers/service.js');
    const list = csvFile(ctx.file('suppliers.csv'), SUPPLIER_HEAD);
    const contracts = csvFile(ctx.file('supplier-contracts.csv'), CONTRACT_HEAD);
    const certificates = csvFile(ctx.file('supplier-certificates.csv'), CERTIFICATE_HEAD);
    await list.rows([]);
    await contracts.rows([]);
    await certificates.rows([]);
    for (const page of publicSuppliers(100, ctx.now.getTime())) {
      await list.rows(
        page.map((s) => [
          s.id,
          s.name,
          s.type,
          s.status,
          s.description,
          s.website,
          s.owners,
          s.aliases,
          s.personalData,
          s.dpaStatus ?? '',
          s.dpaSince ?? '',
          s.dpaLink,
          s.criticality.confidentiality?.label ?? '',
          s.criticality.integrity?.label ?? '',
          s.criticality.availability?.label ?? '',
          s.contractCount,
          s.certificateCount,
          s.nextNoticeBy ?? '',
          s.nextCertificateExpiry ?? '',
          s.contacts.map((c) => `${c.name} (${c.role})`),
          Object.entries(s.usage)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${k}: ${n}`),
          s.updatedAt,
        ]),
      );
      await contracts.rows(
        page.flatMap((s) =>
          s.contracts.map((c) => [
            s.id,
            s.name,
            c.id,
            c.title,
            c.reference,
            c.startsOn ?? '',
            c.endsOn ?? '',
            c.noticeDays,
            c.renewal,
            c.renewalMonths,
            c.termEnd ?? '',
            c.noticeBy ?? '',
            c.slaAvailability,
            c.slaSupportHours,
            c.slaResponse,
            c.rtoHours,
            c.rpoHours,
            c.link,
            c.note,
            c.costPlanLines.map((l) => `${l.serviceName} ${l.fiscalYear}: ${l.title}`),
          ]),
        ),
      );
      await certificates.rows(
        page.flatMap((s) =>
          s.certificates.map((c) => [
            s.id,
            s.name,
            c.id,
            c.kind,
            c.name,
            c.scope,
            c.issuer,
            c.issuedOn ?? '',
            c.validUntil ?? '',
            c.state,
            c.link,
            c.checkedBy ?? '',
            c.checkedAt ?? '',
          ]),
        ),
      );
      await ctx.pause();
    }
  },
};

const FINDING_HEAD = [
  'Number',
  'Title',
  'Source',
  'Severity',
  'Status',
  'Service',
  'Supplier',
  'Controls',
  'Owner',
  'Due',
  'Overdue',
  'Open actions',
  'Actions',
  'Effectiveness',
  'Checked by',
  'Checked at',
  'GRC reference',
  'Created',
  'Closed',
] as const;

const correctiveActions: ExportPartDef = {
  id: 'correctiveActions',
  formats: ['csv'],
  module: 'compliance',
  options: [],
  async write(_choice, ctx) {
    const { CaContext, listFindingSummaries } = await import('../compliance/corrective.js');
    const { db } = await import('../db.js');
    const out = csvFile(ctx.file('corrective-actions.csv'), FINDING_HEAD);
    await out.rows([]);
    const cactx = new CaContext();
    // oldest first, like a register
    const list = listFindingSummaries({}, cactx).reverse();
    for (let i = 0; i < list.length; i += 500) {
      const page = list.slice(i, i + 500);
      const extra = new Map(
        db()
          .all<{ id: string; eff_result: string | null; eff_checked_by: string | null; eff_checked_at: string | null; grc_ref: string }>(
            `SELECT id, eff_result, eff_checked_by, eff_checked_at, grc_ref FROM ca_findings WHERE id IN (${page.map(() => '?').join(', ')})`,
            ...page.map((f) => f.id),
          )
          .map((r) => [r.id, r]),
      );
      await out.rows(
        page.map((f) => {
          const x = extra.get(f.id);
          return [
            f.number,
            f.title,
            f.source,
            f.severity,
            f.status,
            f.serviceName ?? '',
            f.supplierName ?? '',
            f.controls.map((c) => `${c.catalogueKey} ${c.ref}`),
            f.owner ?? '',
            f.dueDate ?? '',
            f.overdue,
            f.actionsOpen,
            f.actionsTotal,
            x?.eff_result ?? '',
            x?.eff_checked_by ?? '',
            x?.eff_checked_at ?? '',
            x?.grc_ref ?? '',
            f.createdAt,
            f.closedAt ?? '',
          ];
        }),
      );
      await ctx.pause();
    }
  },
};

const soa: ExportPartDef = {
  id: 'soa',
  formats: ['json'],
  module: 'compliance',
  options: [],
  async write(_choice, ctx) {
    // the latest approved version of each catalogue: the frozen JSON byte for byte (its SHA-256 is the version's, as in
    // the audit log and the signed export) and its CSV beside it; nothing while no version is approved
    const { latestApprovedFiles } = await import('../compliance/soa.js');
    const versions = latestApprovedFiles();
    for (const v of versions) {
      await ctx.file(`${v.base}.json`).write(v.json);
      await ctx.file(`${v.base}.csv`).write(v.csv);
      await ctx.pause();
    }
    ctx.note({ versions: versions.map((v) => ({ catalogue: v.catalogueKey, number: v.number, approvedAt: v.approvedAt, contentSha256: v.contentSha256 })) });
  },
};

export const EXPORT_PARTS: readonly ExportPartDef[] = [
  costPlans,
  plant,
  services,
  applications,
  systems,
  monitors,
  auditLog,
  suppliers,
  correctiveActions,
  soa,
];

export const exportPart = (id: string): ExportPartDef | undefined => EXPORT_PARTS.find((p) => p.id === id);

/** The parts as the export page offers them, with whether their module is on. */
export async function exportPartInfos(): Promise<ExportPartInfo[]> {
  const { moduleEnabled } = await import('../modules/registry.js');
  return EXPORT_PARTS.map((p) => ({
    id: p.id,
    formats: [...p.formats],
    module: p.module,
    available: !p.module || moduleEnabled(p.module),
    options: [...p.options],
  }));
}

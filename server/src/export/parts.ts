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
import { db } from '../db.js';
import { csvCell, csvTable } from '../csv.js';

/**
 * The parts a scheduled export can write (0.16.0, docs/EXPORTS.md, ADR 0027) – a registry: each part names its
 * formats, its module and a function that writes its files. A new part is one entry here (and its labels in the web
 * app's settings.json, exports.parts.<id>).
 *
 * Every part runs as the export's system principal (jobs.ts): it sees everything, so only administrators define
 * exports. A part writes what people read in Steward – never a secret: no vault value, no credential, no token, no
 * heartbeat or webhook secret (server/test/exports.test.ts checks the files of every part for the secrets it knows).
 * The code of the areas is loaded when a part runs (lazy imports), so this registry pulls no module in at start.
 */

export interface ExportFile {
  name: string;
  content: string;
}

export interface ExportContext {
  now: Date;
}

export interface ExportPartDef {
  id: ExportPartId;
  formats: readonly ExportFormat[];
  /** Not exported while this module is switched off (the run says so; the other parts are written) */
  module: ModuleId | null;
  options: readonly ('fiscalYear' | 'days')[];
  write(choice: ExportPartChoice, ctx: ExportContext): Promise<ExportFile[]>;
}

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
  async write(choice, { now }) {
    const { planYear, planCsvRows } = await import('../costs/plans.js');
    const fy = await fiscalYear(choice.fiscalYear, now);
    const plan: string[] = [];
    const entries: string[] = [];
    let heads: { plan: string; entries: string } | null = null;
    for (const s of db().all<{ id: string }>('SELECT id FROM services ORDER BY name, id')) {
      const y = planYear(s.id, fy.year, now.getTime());
      const p = planCsvRows(y, 'plan');
      const e = planCsvRows(y, 'entries');
      heads ??= { plan: p.head, entries: e.head };
      // the service first, so one file holds every service's plan
      const svc = `${csvCell(y.serviceId, 'needed')},${csvCell(y.serviceName, 'needed')}`;
      plan.push(...p.rows.map((r) => `${svc},${r}`));
      entries.push(...e.rows.map((r) => `${svc},${r}`));
    }
    const head = (h: string | undefined, fallback: string) => `Service id,Service,${h ?? fallback}`;
    const file = (h: string, rows: string[]) => '\uFEFF' + [h, ...rows].join('\r\n') + '\r\n';
    const fyText = fy.label.replace(/[^0-9A-Za-z]+/g, '-');
    return [
      { name: `cost-plan-lines-${fyText}.csv`, content: file(head(heads?.plan, 'Fiscal year,Title'), plan) },
      { name: `cost-entries-${fyText}.csv`, content: file(head(heads?.entries, 'Date,Amount,Currency'), entries) },
    ];
  },
};

const plant: ExportPartDef = {
  id: 'plant',
  formats: ['yaml', 'json'],
  module: 'plant',
  options: [],
  async write(choice) {
    const { exportYaml } = await import('../plant/import.js');
    const x = exportYaml({}, { format: choice.format === 'json' ? 'json' : 'yaml' });
    return [{ name: choice.format === 'json' ? 'plant-registry.json' : 'plant-registry.yaml', content: x.content }];
  },
};

const services: ExportPartDef = {
  id: 'services',
  formats: ['csv'],
  module: null,
  options: [],
  async write() {
    const { listServiceEntries } = await import('../catalogue/service.js');
    return [{ name: 'services.csv', content: objectsCsv(listServiceEntries({ archived: true }) as unknown as Record<string, unknown>[]) }];
  },
};

const applications: ExportPartDef = {
  id: 'applications',
  formats: ['csv'],
  module: null,
  options: [],
  async write() {
    const { listApplicationEntries } = await import('../catalogue/applications.js');
    return [{ name: 'applications.csv', content: objectsCsv(listApplicationEntries({ archived: true }) as unknown as Record<string, unknown>[]) }];
  },
};

const systems: ExportPartDef = {
  id: 'systems',
  formats: ['csv'],
  module: null,
  options: [],
  async write() {
    const { listSystemEntries } = await import('../catalogue/systems.js');
    return [{ name: 'systems.csv', content: objectsCsv(listSystemEntries() as unknown as Record<string, unknown>[]) }];
  },
};

const monitors: ExportPartDef = {
  id: 'monitors',
  formats: ['yaml'],
  module: null,
  options: [],
  async write() {
    // every monitor (not the templates) in its import format, one YAML document each – heartbeat secrets are never
    // part of a definition
    const { exportMonitor, listMonitors } = await import('../monitors/service.js');
    const docs = listMonitors({ templates: false }).map((m) => exportMonitor(m.id));
    return [{ name: 'monitors.yaml', content: docs.length ? docs.map((d) => `---\n${d}`).join('') : YAML.stringify([]) }];
  },
};

const auditLog: ExportPartDef = {
  id: 'auditLog',
  formats: ['csv', 'jsonl'],
  module: null,
  options: ['days'],
  async write(choice, { now }) {
    const { queryAudit } = await import('../audit.js');
    const { auditCsv } = await import('../audit-export.js');
    const days = Math.min(EXPORT_LIMITS.auditDaysMax, Math.max(1, Math.round(choice.days ?? 7)));
    const from = new Date(now.getTime() - days * 86_400_000).toISOString();
    const to = now.toISOString();
    const entries: ReturnType<typeof queryAudit> = [];
    let after: number | undefined;
    for (;;) {
      const page = queryAudit({ from, to, sort: { key: 'time', dir: 'asc' }, afterSeq: after, limit: 5000 });
      entries.push(...page);
      if (page.length < 5000 || entries.length >= EXPORT_LIMITS.auditEntries) break;
      after = page[page.length - 1]!.seq;
    }
    const list = entries.slice(0, EXPORT_LIMITS.auditEntries);
    return choice.format === 'jsonl'
      ? [{ name: 'audit-log.jsonl', content: list.map((e) => JSON.stringify(e)).join('\n') + (list.length ? '\n' : '') }]
      : [{ name: 'audit-log.csv', content: auditCsv(list) }];
  },
};

export const EXPORT_PARTS: readonly ExportPartDef[] = [costPlans, plant, services, applications, systems, monitors, auditLog];

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

import { z } from 'zod';
import { COST_LIMITS, isoCurrencyCode } from './costs.js';
import { isCalendarDate, type CostPlanTarget } from './costPlans.js';
import type { SupplierRef } from './suppliers.js';

/**
 * CSV import of cost entries (0.18.0, ADR 0030 part 6, docs/COSTS.md#importing-entries-csv): invoice lists and ERP
 * exports. UTF-8 (a byte order mark is fine), comma, semicolon or tab (detected as for FOCUS files), a header row. The
 * columns are mapped by their header; the date format and the decimal separator are chosen, never guessed. The preview
 * stores nothing – the server reads the file again on import. Rows without problems are imported in one transaction,
 * all or nothing; duplicates are left out unless ticked one by one. The import is kept as a record (SHA-256) and can be
 * removed as a whole.
 */

export const COST_ENTRY_IMPORT_LIMITS = {
  /** A file at most */
  bytes: 5 * 1024 * 1024,
  rows: 5000,
  columns: 100,
  cellChars: COST_LIMITS.cellChars,
  /** Import records kept per service (older ones keep their entries, lose "Remove import") */
  importsKept: 100,
  headerChars: 200,
} as const;

export const COST_IMPORT_DATE_FORMATS = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY'] as const;
export type CostImportDateFormat = (typeof COST_IMPORT_DATE_FORMATS)[number];
/** The decimal separator; the other one is read as a thousands separator. */
export const COST_IMPORT_DECIMALS = ['.', ','] as const;
export type CostImportDecimal = (typeof COST_IMPORT_DECIMALS)[number];

/** A column, by its header text. */
const column = z.string().trim().min(1).max(COST_ENTRY_IMPORT_LIMITS.headerChars).nullable().default(null);

export const costEntryImportMapping = z
  .object({
    date: z.string().trim().min(1).max(COST_ENTRY_IMPORT_LIMITS.headerChars),
    amount: z.string().trim().min(1).max(COST_ENTRY_IMPORT_LIMITS.headerChars),
    /** The currency column, or one currency for the whole file */
    currency: column,
    fixedCurrency: isoCurrencyCode.nullable().default(null),
    reference: column,
    note: column,
    /** Optional: a plan line (its title or id), a supplier (its name or a spelling), a contract (title or number), an application or system (name) */
    planLine: column,
    supplier: column,
    contract: column,
    target: column,
    dateFormat: z.enum(COST_IMPORT_DATE_FORMATS),
    decimal: z.enum(COST_IMPORT_DECIMALS),
  })
  .strict()
  .refine((m) => !!m.currency || !!m.fixedCurrency, { path: ['currency'], message: 'a currency column or one currency for the file' });
export type CostEntryImportMapping = z.infer<typeof costEntryImportMapping>;

export const costEntryImportInput = z
  .object({
    csv: z.string().min(1).max(COST_ENTRY_IMPORT_LIMITS.bytes),
    fileName: z.string().trim().max(200).default(''),
    mapping: costEntryImportMapping,
    /** Rows (index, from 0 after the header) that are duplicates and imported all the same – ticked one by one */
    include: z.array(z.number().int().min(0).max(COST_ENTRY_IMPORT_LIMITS.rows)).max(COST_ENTRY_IMPORT_LIMITS.rows).default([]),
  })
  .strict();
export type CostEntryImportInput = z.input<typeof costEntryImportInput>;

/** What can be wrong with a row. */
export const COST_IMPORT_PROBLEMS = [
  'noDate',
  'badDate',
  'notNumber',
  'zero',
  'decimals',
  'noCurrency',
  'unknownCurrency',
  'planLineUnknown',
  'planLineOtherYear',
  'planLineCurrency',
  'supplierUnknown',
  'supplierArchived',
  'contractUnknown',
  'contractNotCovering',
  'targetUnknown',
  'limit',
] as const;
export type CostImportProblem = (typeof COST_IMPORT_PROBLEMS)[number];

export interface CostEntryImportRow {
  /** 0, 1, … after the header */
  index: number;
  /** The line of the file where the row starts */
  line: number;
  date: string | null;
  amount: string | null;
  currency: string | null;
  fiscalYear: number | null;
  label: string | null;
  planLine: { id: string; title: string } | null;
  supplier: SupplierRef | null;
  contract: { id: string; title: string } | null;
  target: CostPlanTarget | null;
  reference: string;
  note: string;
  problems: CostImportProblem[];
  /** The service has an entry – or an earlier row of the file one – with the same reference, date, amount and currency */
  duplicate: boolean;
  /** No reference: cannot be checked for duplicates (marked, not left out) */
  noReference: boolean;
}

export interface CostEntryImportPreview {
  fileName: string;
  sha256: string;
  bytes: number;
  header: string[];
  rows: CostEntryImportRow[];
  counts: { rows: number; ready: number; problems: number; duplicates: number };
  /** The same file (SHA-256) was imported into this service before */
  sameFile: { id: string; fileName: string; createdAt: string } | null;
}

/** An import record (GET /api/costs/plans/:serviceId/imports). */
export interface CostEntryImportRecord {
  id: string;
  fileName: string;
  sha256: string;
  rows: number;
  added: number;
  /** Rows left out, by reason */
  skipped: Record<string, number>;
  mapping: CostEntryImportMapping;
  createdAt: string;
  createdBy: string;
  removedAt: string | null;
  removedBy: string | null;
  /** Its entries still there */
  entries: number;
}

export interface CostEntryImports {
  imports: CostEntryImportRecord[];
  /** The mapping of the service's last import, offered again */
  lastMapping: CostEntryImportMapping | null;
  canEdit: boolean;
}

/** A date text in the chosen format → YYYY-MM-DD, or null. Character by character, no regular expression on the input. */
export function parseImportDate(text: string, format: CostImportDateFormat): string | null {
  const s = text.trim();
  if (s.length !== 10) return null;
  const digits = (a: number, b: number) => {
    const part = s.slice(a, b);
    for (const ch of part) if (ch < '0' || ch > '9') return null;
    return part;
  };
  let y: string | null, m: string | null, d: string | null;
  if (format === 'YYYY-MM-DD') {
    if (s[4] !== '-' || s[7] !== '-') return null;
    [y, m, d] = [digits(0, 4), digits(5, 7), digits(8, 10)];
  } else {
    const sep = format === 'DD.MM.YYYY' ? '.' : '/';
    if (s[2] !== sep || s[5] !== sep) return null;
    const a = digits(0, 2);
    const b = digits(3, 5);
    y = digits(6, 10);
    [d, m] = format === 'MM/DD/YYYY' ? [b, a] : [a, b];
  }
  if (!y || !m || !d) return null;
  const iso = `${y}-${m}-${d}`;
  return isCalendarDate(iso) ? iso : null;
}

/**
 * An amount text with the chosen decimal separator → a plain decimal ("1.234,56" with "," → "1234.56"); the other
 * separator is a thousands separator and spaces are left out. null when it is not a number.
 */
export function normaliseImportAmount(text: string, decimal: CostImportDecimal): string | null {
  const thousands = decimal === ',' ? '.' : ',';
  let out = '';
  let seenDecimal = false;
  const s = text.trim();
  if (!s || s.length > 40) return null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === ' ' || ch === ' ' || ch === "'" || ch === thousands) {
      if (seenDecimal) return null;
      continue;
    }
    if (ch === decimal) {
      if (seenDecimal) return null;
      seenDecimal = true;
      out += '.';
    } else if ((ch === '-' || ch === '+') && out === '') out += ch;
    else if (ch >= '0' && ch <= '9') out += ch;
    else return null;
  }
  return out && out !== '-' && out !== '+' && out !== '.' ? out : null;
}

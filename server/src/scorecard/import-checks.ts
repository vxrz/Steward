import { CIA_DIMENSIONS, CIA_LEVEL_KEY_RE, OBJECTIVE_STATUSES, OBJECTIVE_WINDOWS, SCORECARD_PART_STATUSES } from '@sm/shared';

/**
 * Checks of the scorecard tables of a migration package (#86), row by row, like the CIA scale check: values the
 * scorecard reads and compares – targets and samples in hundredths of a percent, statuses, the snapshot day – must be
 * what this instance itself would write. Problems block the import (dry run). No database access: the rows come from
 * the package.
 */

export const SCORECARD_IMPORT_TABLES = [
  'availability_objectives',
  'objective_samples',
  'objective_breaches',
  'scorecard_rules',
  'scorecard_snapshots',
] as const;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const hundredths = (v: unknown) => v === null || v === undefined || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 10000 && v !== '');
const isoOrNull = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && ISO.test(v));
const oneOf = (list: readonly string[], v: unknown) => typeof v === 'string' && list.includes(v);
const flag = (v: unknown) => v === 0 || v === 1 || v === '0' || v === '1' || v === true || v === false;
function jsonArray(v: unknown, item: (x: unknown) => boolean): boolean {
  try {
    const a: unknown = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) && a.length <= 10000 && a.every(item);
  } catch {
    return false;
  }
}

/** The problems of one row (empty: fine). */
export function scorecardRowProblems(table: string, r: Record<string, unknown>): string[] {
  const p: string[] = [];
  if (table === 'availability_objectives') {
    for (const w of OBJECTIVE_WINDOWS) if (!hundredths(r[`target_${w}`])) p.push(`target_${w} is not 0–10000 hundredths of a percent`);
    if (OBJECTIVE_WINDOWS.every((w) => r[`target_${w}`] === null || r[`target_${w}`] === undefined)) p.push('no target');
    if (!flag(r.notify)) p.push('notify is not 0 or 1');
    if (!isoOrNull(r.archived_at)) p.push('archived_at is not a timestamp');
  } else if (table === 'objective_samples') {
    if (!oneOf(OBJECTIVE_STATUSES, r.status)) p.push(`status "${String(r.status).slice(0, 20)}" is unknown`);
    for (const w of OBJECTIVE_WINDOWS) if (!hundredths(r[`value_${w}`])) p.push(`value_${w} is not 0–10000 hundredths of a percent`);
    if (typeof r.bucket !== 'string' || !ISO.test(r.bucket)) p.push('bucket is not a timestamp');
  } else if (table === 'objective_breaches') {
    if (typeof r.started_at !== 'string' || !ISO.test(r.started_at)) p.push('started_at is not a timestamp');
    if (!isoOrNull(r.ended_at) || !isoOrNull(r.notified_at)) p.push('ended_at or notified_at is not a timestamp');
    if (!jsonArray(r.windows, (x) => oneOf(OBJECTIVE_WINDOWS, x))) p.push('windows is not a list of windows');
  } else if (table === 'scorecard_rules') {
    if (!oneOf(CIA_DIMENSIONS, r.dimension)) p.push('dimension is unknown');
    if (typeof r.min_level !== 'string' || !CIA_LEVEL_KEY_RE.test(r.min_level)) p.push('min_level is not a level key');
    if (!flag(r.enabled)) p.push('enabled is not 0 or 1');
  } else if (table === 'scorecard_snapshots') {
    if (typeof r.day !== 'string' || !DAY.test(r.day)) p.push(`day "${String(r.day).slice(0, 20)}" is not YYYY-MM-DD`);
    for (const part of ['duties', 'availability', 'documentation', 'protection'])
      if (!oneOf(SCORECARD_PART_STATUSES, r[part])) p.push(`${part} "${String(r[part]).slice(0, 20)}" is not a status`);
    if (!flag(r.attention)) p.push('attention is not 0 or 1');
    if (!jsonArray(r.document_ids, (x) => typeof x === 'string' && x.length <= 200)) p.push('document_ids is not a list of ids');
    if (!jsonArray(r.owners, (x) => typeof x === 'string' && x.length <= 130)) p.push('owners is not a list of subjects');
  }
  return p;
}

/** Collects the problems of a table's rows (at most `max` messages, then a count). */
export function scorecardTableChecker(table: string, max = 5) {
  const problems: string[] = [];
  let more = 0;
  let row = 0;
  return {
    add(r: Record<string, unknown>) {
      row++;
      const p = scorecardRowProblems(table, r);
      if (!p.length) return;
      if (problems.length < max) problems.push(`${table}, row ${row}: ${p.join('; ')}`);
      else more++;
    },
    result: (): string[] => (more ? [...problems, `${table}: ${more} more rows with problems`] : problems),
  };
}

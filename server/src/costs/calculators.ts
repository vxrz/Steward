import jsonata from 'jsonata';
import { z } from 'zod';
import YAML from 'yaml';
import {
  COST_CALCULATOR_LIMITS,
  DAYS_PER_MONTH,
  HOURS_PER_MONTH,
  costCalculatorDefinition,
  normaliseCalculatorFile,
  parseQuantity,
  parseUnit,
  type CostCalculatorDefinition,
  type CostCalculatorDetail,
  type CostCalculatorInputDef,
  type CostCalculatorSummary,
  type CostInputValue,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentActor, currentUser, type AuthUser } from '../auth/context.js';
import { isAdmin } from '../auth/permissions.js';
import { assignCreatorTeams, forgetOwningTeams, owningTeams, teamRoles } from '../auth/policy.js';
import { evalExpr, renderString, type Bindings } from '../engine/expr.js';
import { parseYaml } from '../yaml-safe.js';
import { HttpError, newId, nowIso, sha256 } from '../util.js';
import { isCostsManager, teamDesigner, usesCosts } from './price-books.js';

/**
 * Calculators (0.21.0, ADR 0035 part 5): templates of typed inputs, named values and lines that each name an item and a
 * JSONata expression for its quantity. Formulas produce quantities only – Steward prices them (pricing.ts). Published
 * versions are immutable; the draft is tried with Calculate. Synced from Git as `kind: costCalculator` (sync/items.ts).
 *
 * Evaluation runs in the engine's sandbox (engine/expr.ts) with tighter limits: 500 ms per calculation, sequences of at
 * most 10,000, at most 200 resulting lines, quantities finite and not negative; the bindings hold the inputs, the
 * named values, the constants (730 hours per month) and $attr() of the items the estimate may use – no platform
 * variables, secrets, datasets, HTTP or the clock.
 *
 * Who: every reader of the Costs module reads calculators (they hold no prices); the costs managers maintain those
 * without owning teams, the owning teams' designers the others (ADR 0035 part 8).
 */

interface CalcRow {
  id: string;
  key: string;
  name: string;
  description: string;
  current_version: number;
  draft: string | null;
  source: 'manual' | 'git';
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

interface CalcVersionRow {
  id: string;
  calculator_id: string;
  number: number;
  definition: string;
  sha256: string;
  published_at: string;
  published_by: string;
}

const notFound = (id: string) => new HttpError(404, `Calculator ${id} not found`, 'COST_CALCULATOR_NOT_FOUND', { id });

export function calculatorRights(r: Pick<CalcRow, 'id'>, u: AuthUser | null = currentUser()): { view: boolean; edit: boolean } {
  if (!u) return { view: true, edit: true };
  if (!usesCosts(u)) return { view: false, edit: false };
  const teams = owningTeams('cost_calculator', r.id);
  const edit = isAdmin(u) || (teams.length ? teamRoles(u, teams).some((m) => m.roles.includes('designer')) : isCostsManager(u));
  return { view: true, edit };
}

const calcRow = (id: string): CalcRow | undefined => db().get<CalcRow>('SELECT * FROM cost_calculators WHERE id = ? OR key = ?', id, id);

export function requireCalculator(id: string, need: 'view' | 'edit' = 'view'): CalcRow {
  const r = calcRow(id);
  if (!r || !usesCosts(currentUser())) throw notFound(id);
  if (need === 'edit' && !calculatorRights(r).edit)
    throw new HttpError(403, `You are not allowed to change the calculator "${r.name}"`, 'FORBIDDEN', { context: 'calculator' });
  return r;
}

// ---------- the definition ----------

export interface ParsedCalculator {
  ok: boolean;
  definition: CostCalculatorDefinition | null;
  errors: string[];
}

/** Checks the syntax of every expression (a broken one answers with its line and the parser's message). */
function syntaxErrors(d: CostCalculatorDefinition): string[] {
  const out: string[] = [];
  const check = (where: string, expr: string) => {
    try {
      jsonata(expr);
    } catch (e) {
      out.push(`${where}: ${(e as Error).message}`);
    }
  };
  for (const l of d.let) check(`let.${l.key}`, l.value);
  d.lines.forEach((l, i) => {
    const key = l.key ?? `l${i + 1}`;
    check(`lines.${key}.quantity`, l.quantity);
    if (l.when) check(`lines.${key}.when`, l.when);
    for (const seg of templateExpressions(l.item.sku)) check(`lines.${key}.item.sku`, seg);
    for (const seg of templateExpressions(l.item.provider)) check(`lines.${key}.item.provider`, seg);
    for (const seg of templateExpressions(l.unit)) check(`lines.${key}.unit`, seg);
  });
  return out;
}

/** The expressions of a {{ … }} template (none for a plain SKU). */
function templateExpressions(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const a = s.indexOf('{{', i);
    if (a < 0) break;
    const b = s.indexOf('}}', a + 2);
    if (b < 0) break;
    out.push(s.slice(a + 2, b).trim());
    i = b + 2;
  }
  return out;
}

/** Parses a calculator file (YAML or JSON) as data within limits and checks it. Never throws. */
export function parseCalculator(text: string): ParsedCalculator {
  if (Buffer.byteLength(text, 'utf8') > COST_CALCULATOR_LIMITS.definitionBytes)
    return { ok: false, definition: null, errors: [`A calculator has at most ${COST_CALCULATOR_LIMITS.definitionBytes / 1024} KB`] };
  let raw: unknown;
  try {
    raw = text.trimStart().startsWith('{')
      ? JSON.parse(text)
      : parseYaml(text, { schema: 'core', customTags: [], maxBytes: COST_CALCULATOR_LIMITS.definitionBytes });
  } catch (e) {
    return { ok: false, definition: null, errors: [`Cannot parse: ${(e as Error).message.slice(0, 300)}`] };
  }
  const r = costCalculatorDefinition.safeParse(normaliseCalculatorFile(raw));
  if (!r.success) return { ok: false, definition: null, errors: r.error.issues.slice(0, 50).map((i) => `${i.path.join('.')}: ${i.message}`) };
  const syntax = syntaxErrors(r.data);
  if (syntax.length) return { ok: false, definition: r.data, errors: syntax };
  return { ok: true, definition: r.data, errors: [] };
}

const parsedCache = new Map<string, CostCalculatorDefinition>();
/** A published definition, parsed once per process (published versions never change). */
export function definitionOf(text: string): CostCalculatorDefinition {
  const key = sha256(text);
  const hit = parsedCache.get(key);
  if (hit) return hit;
  const p = parseCalculator(text);
  if (!p.ok || !p.definition) throw new HttpError(400, p.errors[0] ?? 'Not a calculator', 'COST_CALCULATOR_DEFINITION', { message: p.errors[0] ?? '' });
  if (parsedCache.size > 500) parsedCache.clear();
  parsedCache.set(key, p.definition);
  return p.definition;
}

const refuse = (p: ParsedCalculator): never => {
  const first = p.errors[0] ?? 'Not a calculator';
  const formula = p.definition && first.includes(': ') && /^(let|lines)\./.test(first);
  if (formula) {
    const at = first.indexOf(': ');
    throw new HttpError(400, first, 'COST_CALCULATOR_FORMULA', { line: first.slice(0, at), message: first.slice(at + 2) });
  }
  throw new HttpError(400, first, 'COST_CALCULATOR_DEFINITION', { message: first, errors: p.errors });
};

// ---------- reading ----------

function summary(r: CalcRow, def: CostCalculatorDefinition | null, rights: { edit: boolean }): CostCalculatorSummary {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    version: Number(r.current_version),
    hasDraft: r.draft !== null,
    source: r.source,
    inputs: def?.inputs.length ?? 0,
    lines: def?.lines.length ?? 0,
    providers: def ? [...new Set(def.lines.map((l) => l.item.provider))] : [],
    canEdit: rights.edit,
    updatedAt: r.updated_at,
  };
}

const currentText = (r: CalcRow): string | null =>
  Number(r.current_version) > 0
    ? (db().get<{ definition: string }>('SELECT definition FROM cost_calculator_versions WHERE calculator_id = ? AND number = ?', r.id, r.current_version)
        ?.definition ?? null)
    : null;

export function listCalculators(): CostCalculatorSummary[] {
  if (!usesCosts(currentUser())) return [];
  const rows = db().all<CalcRow>('SELECT * FROM cost_calculators ORDER BY name, id');
  const defs = new Map(
    db()
      .all<{ calculator_id: string; definition: string }>(
        'SELECT v.calculator_id, v.definition FROM cost_calculator_versions v JOIN cost_calculators c ON c.id = v.calculator_id AND v.number = c.current_version',
      )
      .map((v) => [v.calculator_id, v.definition]),
  );
  return rows.map((r) => {
    const text = defs.get(r.id) ?? r.draft;
    let def: CostCalculatorDefinition | null;
    try {
      def = text ? definitionOf(text) : null;
    } catch {
      def = null;
    }
    return summary(r, def, calculatorRights(r));
  });
}

export function getCalculator(id: string): CostCalculatorDetail {
  const r = requireCalculator(id);
  const text = currentText(r);
  const parsed = text ? definitionOf(text) : r.draft ? parseCalculator(r.draft).definition : null;
  const versions = db().all<CalcVersionRow>(
    'SELECT id, calculator_id, number, sha256, published_at, published_by, definition FROM cost_calculator_versions WHERE calculator_id = ? ORDER BY number DESC',
    r.id,
  );
  return {
    ...summary(r, parsed, calculatorRights(r)),
    definition: text ?? '',
    parsed,
    draft: r.draft,
    versions: versions.map((v) => ({ number: Number(v.number), sha256: v.sha256, publishedAt: v.published_at, publishedBy: v.published_by })),
    owningTeams: owningTeams('cost_calculator', r.id),
    checked: parsed?.checked ?? null,
  };
}

/** A published version's definition (the current one by default). */
export function calculatorVersion(id: string, n?: number | null): { row: CalcRow; number: number; text: string; definition: CostCalculatorDefinition } {
  const r = requireCalculator(id);
  const number = n ?? Number(r.current_version);
  if (!number) throw new HttpError(409, `The calculator "${r.name}" has no published version yet`, 'COST_CALCULATOR_UNPUBLISHED', { name: r.name });
  const v = db().get<CalcVersionRow>('SELECT * FROM cost_calculator_versions WHERE calculator_id = ? AND number = ?', r.id, number);
  if (!v) throw new HttpError(404, `Version ${number} of the calculator not found`, 'COST_CALCULATOR_NOT_FOUND', { id });
  return { row: r, number, text: v.definition, definition: definitionOf(v.definition) };
}

// ---------- writing ----------

export const calculatorSaveInput = z
  .object({
    definition: z.string().min(1).max(COST_CALCULATOR_LIMITS.definitionBytes),
    /** Publish as a new version (else the draft is kept) */
    publish: z.boolean().default(false),
  })
  .strict();

function publishVersion(r: CalcRow, text: string, def: CostCalculatorDefinition, via: 'app' | 'git'): number {
  const sha = sha256(text);
  const cur = db().get<{ sha256: string }>('SELECT sha256 FROM cost_calculator_versions WHERE calculator_id = ? AND number = ?', r.id, r.current_version);
  if (cur && cur.sha256 === sha) {
    db().run('UPDATE cost_calculators SET draft = NULL WHERE id = ?', r.id);
    return Number(r.current_version);
  }
  const number = Number(r.current_version) + 1;
  const now = nowIso();
  db().run(
    'INSERT INTO cost_calculator_versions (id, calculator_id, number, definition, sha256, published_at, published_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    newId('ccv_'),
    r.id,
    number,
    text,
    sha,
    now,
    currentActor(),
  );
  db().run(
    'UPDATE cost_calculators SET current_version = ?, name = ?, description = ?, draft = NULL, updated_at = ?, updated_by = ? WHERE id = ?',
    number,
    def.name,
    def.description ?? '',
    now,
    currentActor(),
    r.id,
  );
  audit({
    action: 'cost.calculator_published',
    entityType: 'cost_calculator',
    entityId: r.id,
    summary: `Calculator "${def.name}" version ${number} published${via === 'git' ? ' from Git' : ''}`,
    details: { version: number, sha256: sha, inputs: def.inputs.length, lines: def.lines.length, via },
  });
  return number;
}

/** Who may add calculators: the costs managers and the designers of a team (the calculator is their team's). */
export const mayAddCalculators = (u: AuthUser | null = currentUser()): boolean => isCostsManager(u) || teamDesigner(u);

/** A new calculator from its definition (kept as a draft unless published). */
export function createCalculator(body: unknown, via: 'app' | 'git' = 'app'): CostCalculatorDetail {
  const x = calculatorSaveInput.parse(body);
  const u = currentUser();
  if (!mayAddCalculators(u)) throw new HttpError(403, 'You are not allowed to add calculators', 'FORBIDDEN', { context: 'calculator' });
  const p = parseCalculator(x.definition);
  if (!p.ok || !p.definition) refuse(p);
  const def = p.definition!;
  if (db().get('SELECT 1 FROM cost_calculators WHERE key = ?', def.id))
    throw new HttpError(409, `A calculator with the id "${def.id}" exists`, 'COST_CALCULATOR_EXISTS', { id: def.id });
  const count = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_calculators')?.n ?? 0);
  if (count >= COST_CALCULATOR_LIMITS.calculators)
    throw new HttpError(409, `Steward keeps at most ${COST_CALCULATOR_LIMITS.calculators} calculators`, 'COST_CALCULATOR_LIMIT', {
      max: COST_CALCULATOR_LIMITS.calculators,
    });
  const id = newId('ccl_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO cost_calculators (id, key, name, description, current_version, draft, source, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      id,
      def.id,
      def.name,
      def.description ?? '',
      x.publish ? null : x.definition,
      via === 'git' ? 'git' : 'manual',
      now,
      currentActor(),
      now,
      currentActor(),
    );
    assignCreatorTeams('cost_calculator', id, u);
    audit({
      action: 'cost.calculator_added',
      entityType: 'cost_calculator',
      entityId: id,
      summary: `Calculator "${def.name}" (${def.id}) added${via === 'git' ? ' from Git' : ''}`,
      details: { key: def.id, inputs: def.inputs.length, lines: def.lines.length, via },
    });
    if (x.publish) publishVersion(calcRow(id)!, x.definition, def, via);
  });
  return getCalculator(id);
}

/** Saves the draft or publishes it as a new version. The id inside the definition stays the calculator's. */
export function saveCalculator(id: string, body: unknown, via: 'app' | 'git' = 'app'): CostCalculatorDetail {
  const r = requireCalculator(id, 'edit');
  const x = calculatorSaveInput.parse(body);
  const p = parseCalculator(x.definition);
  if (x.publish && (!p.ok || !p.definition)) refuse(p);
  if (p.definition && p.definition.id !== r.key)
    throw new HttpError(400, `The id of this calculator is "${r.key}"`, 'COST_CALCULATOR_DEFINITION', { message: `id: ${r.key}` });
  const now = nowIso();
  db().tx(() => {
    if (x.publish) publishVersion(r, x.definition, p.definition!, via);
    else {
      db().run('UPDATE cost_calculators SET draft = ?, updated_at = ?, updated_by = ? WHERE id = ?', x.definition, now, currentActor(), r.id);
      audit({
        action: 'cost.calculator_changed',
        entityType: 'cost_calculator',
        entityId: r.id,
        summary: `Draft of the calculator "${r.name}" saved`,
        details: { draft: true, valid: p.ok, bytes: Buffer.byteLength(x.definition, 'utf8') },
      });
    }
    if (via === 'git') db().run("UPDATE cost_calculators SET source = 'git' WHERE id = ?", r.id);
  });
  return getCalculator(r.id);
}

export function removeCalculator(id: string): void {
  const r = requireCalculator(id, 'edit');
  const used = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM cost_estimates WHERE calculator_id = ?', r.id)?.n ?? 0);
  if (used) throw new HttpError(409, `${used} estimate(s) use this calculator`, 'COST_CALCULATOR_IN_USE', { count: used });
  db().tx(() => {
    db().run('DELETE FROM cost_calculator_versions WHERE calculator_id = ?', r.id);
    db().run('DELETE FROM cost_calculators WHERE id = ?', r.id);
    forgetOwningTeams('cost_calculator', r.id);
    audit({
      action: 'cost.calculator_removed',
      entityType: 'cost_calculator',
      entityId: r.id,
      summary: `Calculator "${r.name}" removed`,
      details: { key: r.key, versions: Number(r.current_version) },
    });
  });
}

/** The definition as YAML for export and for Git (the current version, else the draft). */
export function exportCalculator(id: string): { name: string; yaml: string } {
  const r = requireCalculator(id);
  const text = currentText(r) ?? r.draft ?? '';
  return { name: `${r.key}.yaml`, yaml: text.trimStart().startsWith('{') ? YAML.stringify(JSON.parse(text), { lineWidth: 0 }) : text };
}

/** Git sync (sync/items.ts): the calculator with this key, and the hash of its current definition. */
export function calculatorByKey(key: string): { id: string; name: string } | null {
  const r = db().get<{ id: string; name: string }>('SELECT id, name FROM cost_calculators WHERE key = ?', key);
  return r ?? null;
}
export function calculatorHash(id: string): string | null {
  const r = db().get<CalcRow>('SELECT * FROM cost_calculators WHERE id = ?', id);
  if (!r) return null;
  const v = db().get<{ sha256: string }>('SELECT sha256 FROM cost_calculator_versions WHERE calculator_id = ? AND number = ?', r.id, r.current_version);
  return v?.sha256 ?? null;
}
export function calculatorText(id: string): string | null {
  const r = db().get<CalcRow>('SELECT * FROM cost_calculators WHERE id = ?', id);
  return r ? (currentText(r) ?? r.draft) : null;
}

// ---------- evaluation ----------

/** One scenario's values per input key (from the definition: the keys are checked, never taken from a request). */
export type Scenario = Map<string, unknown>;

export interface InputsResolved {
  scenarios: [Scenario, Scenario, Scenario];
  ranged: boolean;
}

const inputError = (key: string, message: string) => new HttpError(400, `Input ${key}: ${message}`, 'COST_CALCULATOR_INPUT', { key, message });

function numberOf(i: CostCalculatorInputDef, v: unknown): number {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw inputError(i.key, 'a number');
  if (i.type === 'integer' && !Number.isInteger(n)) throw inputError(i.key, 'a whole number');
  if (i.min !== undefined && n < i.min) throw inputError(i.key, `at least ${i.min}`);
  if (i.max !== undefined && n > i.max) throw inputError(i.key, `at most ${i.max}`);
  return n;
}

/**
 * The inputs of the three scenarios (low, expected, high) from the given values and the defaults: numbers and
 * integers may be ranges (unless `range: false`), checked for order (COST_RANGE_ORDER) and bounds; a select takes one
 * of its options; a table keeps the defined columns of at most its maxRows rows.
 */
export function resolveInputs(def: CostCalculatorDefinition, given: readonly { key: string; value: CostInputValue }[]): InputsResolved {
  const byKey = new Map(given.map((g) => [g.key, g.value]));
  const out: [Scenario, Scenario, Scenario] = [new Map(), new Map(), new Map()];
  let ranged = false;
  for (const i of def.inputs) {
    const v = byKey.has(i.key) ? byKey.get(i.key) : i.default;
    let vals: [unknown, unknown, unknown];
    switch (i.type) {
      case 'number':
      case 'integer': {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          const r = v as { low?: unknown; expected?: unknown; high?: unknown };
          if (i.range === false) throw inputError(i.key, 'one value, not a range');
          const lo = numberOf(i, r.low);
          const ex = numberOf(i, r.expected);
          const hi = numberOf(i, r.high);
          if (!(lo <= ex && ex <= hi))
            throw new HttpError(400, `Input ${i.key}: low ≤ expected ≤ high`, 'COST_RANGE_ORDER', { key: i.key, low: lo, expected: ex, high: hi });
          if (lo !== hi) ranged = true;
          vals = [lo, ex, hi];
        } else {
          const n = numberOf(i, v ?? 0);
          vals = [n, n, n];
        }
        break;
      }
      case 'boolean': {
        const b = v === undefined ? false : v;
        if (typeof b !== 'boolean') throw inputError(i.key, 'true or false');
        vals = [b, b, b];
        break;
      }
      case 'select': {
        const opts = (i.options ?? []).map(String);
        const s = v === undefined ? opts[0] : String(v);
        if (!opts.includes(s!)) throw inputError(i.key, `one of ${opts.join(', ')}`);
        // a numeric option stays a number
        const raw = (i.options ?? []).find((o) => String(o) === s);
        vals = [raw, raw, raw];
        break;
      }
      case 'table': {
        const rows = v === undefined ? [] : v;
        if (!Array.isArray(rows)) throw inputError(i.key, 'a list of rows');
        const max = i.maxRows ?? COST_CALCULATOR_LIMITS.tableRows;
        if (rows.length > max) throw inputError(i.key, `at most ${max} rows`);
        const table = rows.map((row, n) => {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw inputError(i.key, `row ${n + 1} is not a row`);
          const cells = new Map(Object.entries(row as Record<string, unknown>));
          const out: Record<string, unknown> = Object.create(null);
          for (const c of i.columns ?? []) {
            const raw = cells.has(c.key) ? cells.get(c.key) : c.default;
            if (c.type === 'number') {
              const x = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : (raw ?? 0);
              if (typeof x !== 'number' || !Number.isFinite(x)) throw inputError(i.key, `row ${n + 1}, ${c.key}: a number`);
              out[c.key] = x;
            } else out[c.key] = raw === undefined || raw === null ? '' : String(raw).slice(0, 200);
          }
          return { ...out };
        });
        vals = [table, table, table];
        break;
      }
    }
    for (let k = 0; k < 3; k++) out[k]!.set(i.key, vals[k]);
  }
  return { scenarios: out, ranged };
}

export interface CalculatedLine {
  key: string;
  label: string;
  group: string;
  provider: string;
  sku: string;
  priceId: string;
  unit: string;
  /** Millionths of `unit` */
  quantity: bigint;
}

const blocked = (name: string) => () => {
  throw new Error(`$${name}() is not available in a calculator`);
};
/** The engine's clock, randomness and id functions: not in a calculator (its result depends on its inputs only). */
const SANDBOX: Bindings = {
  now: blocked('now'),
  millis: blocked('millis'),
  random: blocked('random'),
  daysSince: blocked('daysSince'),
  daysAgo: blocked('daysAgo'),
  uuid: blocked('uuid'),
};

export type AttrResolver = (provider: string, sku: string, key: string) => Promise<string | null>;

/**
 * Runs a calculator for one scenario within a deadline (shared by the scenarios of one calculation): the named values
 * in order, then every line (once per row of its table input), its SKU template, its quantity. Errors carry the line.
 */
export async function evaluate(def: CostCalculatorDefinition, scenario: Scenario, deadline: number, attr: AttrResolver): Promise<CalculatedLine[]> {
  const inputs: Record<string, unknown> = Object.create(null);
  for (const [k, v] of scenario) inputs[k] = v;
  const lets: Record<string, unknown> = Object.create(null);
  const root: Record<string, unknown> = {
    inputs: { ...inputs },
    let: lets,
    const: { hoursPerMonth: HOURS_PER_MONTH, daysPerMonth: DAYS_PER_MONTH },
  };
  const bindings: Bindings = {
    ...SANDBOX,
    attr: (provider: unknown, sku: unknown, key: unknown) => attr(String(provider ?? ''), String(sku ?? ''), String(key ?? '')),
  };
  const opts = () => {
    const left = deadline - performance.now();
    if (left <= 0) throw new Error(`the calculation took longer than ${COST_CALCULATOR_LIMITS.timeoutMs} ms and was stopped`);
    return { timeoutMs: Math.max(1, Math.floor(left)), maxSequence: COST_CALCULATOR_LIMITS.maxSequence };
  };
  const formula = (where: string, e: unknown) => {
    const msg = (e as Error).message ?? String(e);
    return new HttpError(400, `${where}: ${msg}`, 'COST_CALCULATOR_FORMULA', { line: where, message: msg.slice(0, 500) });
  };
  for (const l of def.let) {
    try {
      lets[l.key] = await evalExpr(l.value, { ...root, let: { ...lets } }, bindings, opts());
    } catch (e) {
      throw formula(`let.${l.key}`, e);
    }
  }
  root.let = { ...lets };
  const out: CalculatedLine[] = [];
  for (const [i, l] of def.lines.entries()) {
    const key = l.key ?? `l${i + 1}`;
    const rows: (Record<string, unknown> | null)[] = l.each ? ((scenario.get(l.each) as Record<string, unknown>[] | undefined) ?? []) : [null];
    for (const [n, row] of rows.entries()) {
      const ctx = row ? { ...root, row } : root;
      const lineKey = l.each ? `${key}_${n + 1}` : key;
      try {
        if (l.when && !(await evalExpr(l.when, ctx, bindings, opts()))) continue;
      } catch (e) {
        throw formula(`lines.${key}.when`, e);
      }
      let q: unknown;
      const text = async (where: string, v: string) => {
        try {
          return v.includes('{{') ? (await renderString(v, ctx, bindings, opts())).trim() : v;
        } catch (e) {
          throw formula(`lines.${key}.${where}`, e);
        }
      };
      const sku = await text('item.sku', l.item.sku);
      const provider = await text('item.provider', l.item.provider);
      const unit = await text('unit', l.unit);
      if (!provider || provider.length > 120)
        throw new HttpError(400, `lines.${key}: the provider is empty or too long`, 'COST_CALCULATOR_OUTPUT', {
          line: key,
          message: 'the provider is empty or too long',
        });
      if (!parseUnit(unit))
        throw new HttpError(400, `lines.${key}: "${unit.slice(0, 60)}" is not a unit`, 'COST_CALCULATOR_OUTPUT', {
          line: key,
          message: `"${unit.slice(0, 60)}" is not a unit`,
        });
      try {
        q = await evalExpr(l.quantity, ctx, bindings, opts());
      } catch (e) {
        throw formula(`lines.${key}.quantity`, e);
      }
      if (q === undefined || q === null) q = 0;
      if (typeof q !== 'number' || !Number.isFinite(q))
        throw new HttpError(400, `lines.${key}: the quantity is not a number`, 'COST_CALCULATOR_OUTPUT', {
          line: key,
          message: 'the quantity is not a number',
        });
      if (q < 0)
        throw new HttpError(400, `lines.${key}: the quantity is below 0`, 'COST_CALCULATOR_OUTPUT', {
          line: key,
          message: 'the quantity is below 0 (a credit is an item with a negative price)',
        });
      const micros = parseQuantity(q);
      if (micros === null)
        throw new HttpError(400, `lines.${key}: the quantity is too large`, 'COST_CALCULATOR_OUTPUT', { line: key, message: 'the quantity is too large' });
      if (!sku.trim() || sku.length > 100)
        throw new HttpError(400, `lines.${key}: the SKU is empty or too long`, 'COST_CALCULATOR_OUTPUT', {
          line: key,
          message: 'the SKU is empty or too long',
        });
      out.push({
        key: lineKey,
        label: l.label ? (row && l.each ? `${l.label} ${n + 1}` : l.label) : '',
        group: l.group ?? '',
        provider,
        sku: sku.trim(),
        priceId: l.item.priceId ?? '',
        unit,
        quantity: micros,
      });
      if (out.length > COST_CALCULATOR_LIMITS.resultLines)
        throw new HttpError(400, `More than ${COST_CALCULATOR_LIMITS.resultLines} lines`, 'COST_CALCULATOR_OUTPUT', {
          line: lineKey,
          message: `more than ${COST_CALCULATOR_LIMITS.resultLines} lines`,
        });
    }
  }
  return out;
}

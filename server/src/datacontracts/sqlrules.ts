import { DATA_CONTRACT_SERVER_DIALECTS, readOnlyStatementProblem, sqlProblemParam, type DbDialect, type SqlProblem } from '@sm/shared';
import { HttpError } from '../util.js';
import { isObj, str, type OdcsDoc } from './odcs.js';

/**
 * SQL quality rules of a contract (#221, docs/DATA-CONTRACTS.md#sql-quality-rules): `quality` entries of type `sql`
 * (or with a `query`) on schema objects and properties. The data contract service runs them with the tested database
 * platform's credentials – on its own connection, outside Steward's read-only session (ADR 0008 layers 2 and 3) – so
 * Steward holds them to its own rules:
 *
 *  - saving a contract that has SQL rules needs the "use" right on every database platform linked to its servers
 *    (service.ts), and a test re-checks "use" for whoever runs it (testing.ts);
 *  - every rule passes Steward's statement check (shared/src/sqlcheck.ts: one SELECT or WITH … SELECT, no words that
 *    change something, no functions with effects outside the query, no placeholders – Steward binds no parameters), on
 *    save for the DBMS of the contract's servers and before each test for the tested platform's.
 *
 * The CLI's own placeholders ({model}, ${table}, {column} …) are names it fills in: they are read as a plain name for
 * the check. Other `${…}` references are variables the service would resolve from its environment: refused.
 */

export interface SqlRule {
  /** JSON Pointer of the rule: /schema/0/properties/2/quality/1 */
  path: string;
  /** Its id or name, else schema object (and field) with its number */
  name: string;
  query: string;
}

/** The CLI's placeholders (datacontract/engines/checks: model, table, object, schema …, field, column, property). */
const PLACEHOLDERS = new Set(['model', 'table', 'object', 'schema', 'dataset', 'project', 'catalog', 'database', 'field', 'column', 'property']);
const QUOTES = new Set(['"', "'", '`']);

/** The SQL rules of a contract, all levels (iterative), in document order. */
export function sqlRules(doc: OdcsDoc): SqlRule[] {
  const out: SqlRule[] = [];
  const schemas = Array.isArray(doc.schema) ? doc.schema : [];
  // [node, pointer, schema object name, field path]
  const stack: [unknown, string, string, string | null][] = [];
  for (let i = schemas.length - 1; i >= 0; i--)
    stack.push([schemas[i], `/schema/${i}`, str((schemas[i] as Record<string, unknown>)?.name) ?? `#${i + 1}`, null]);
  while (stack.length) {
    const [x, at, schema, field] = stack.pop()!;
    if (!isObj(x)) continue;
    if (Array.isArray(x.quality))
      x.quality.forEach((q, j) => {
        if (!isObj(q)) return;
        const query = typeof q.query === 'string' ? q.query : null;
        if (str(q.type)?.toLowerCase() !== 'sql' && !query) return;
        const name = str(q.id) ?? str(q.name) ?? `${field ? `${schema}.${field}` : schema} quality #${j + 1}`;
        out.push({ path: `${at}/quality/${j}`, name: name.slice(0, 200), query: query ?? '' });
      });
    if (isObj(x.items)) stack.push([x.items, `${at}/items`, schema, field]);
    const props = Array.isArray(x.properties) ? x.properties : [];
    for (let i = props.length - 1; i >= 0; i--) {
      const p = props[i];
      const n = isObj(p) ? (str(p.name) ?? `#${i + 1}`) : `#${i + 1}`;
      stack.push([p, `${at}/properties/${i}`, schema, field ? `${field}.${n}` : n]);
    }
  }
  return out;
}

/**
 * The query with the CLI's placeholders read as one plain name of the same length (so the character positions of a
 * problem stay those of the query), or the `${…}` reference that is not one of them.
 */
export function withoutPlaceholders(query: string): { sql: string; variable?: string } {
  let sql = '';
  let i = 0;
  while (i < query.length) {
    const open = query.indexOf('{', i);
    if (open < 0) {
      sql += query.slice(i);
      break;
    }
    const close = query.indexOf('}', open);
    const name = close > open ? query.slice(open + 1, close) : '';
    const dollar = query[open - 1] === '$';
    if (close < 0 || close - open > 40 || !PLACEHOLDERS.has(name)) {
      // ${VAR} (ODCS v3.2 variables): the service resolves them from its own environment
      if (dollar) return { sql: '', variable: query.slice(open - 1, close > open && close - open <= 60 ? close + 1 : open + 20) };
      sql += query.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    let start = dollar ? open - 1 : open;
    if (start > i && QUOTES.has(query[start - 1]!)) start--;
    let end = close + 1;
    if (QUOTES.has(query[end] ?? '')) end++;
    sql += `${query.slice(i, start)}${'x'.repeat(end - start)}`;
    i = end;
  }
  return { sql };
}

/** Why a rule is refused for this DBMS, or null. */
export function sqlRuleProblem(rule: SqlRule, dialect: DbDialect): SqlProblem | null {
  if (!rule.query.trim()) return { code: 'empty', message: 'The rule has no query' };
  const { sql, variable } = withoutPlaceholders(rule.query);
  if (variable !== undefined)
    return {
      code: 'refusedWord',
      message: `${variable} is a variable the data contract service would fill in from its own environment – not allowed in SQL rules`,
      word: variable,
      context: 'variable',
    };
  return readOnlyStatementProblem(sql, dialect, 0);
}

/** The DBMS of the contract's servers that Steward can test (PostgreSQL's check when it names none). */
export function contractDialects(doc: OdcsDoc): DbDialect[] {
  const out = new Set<DbDialect>();
  for (const s of Array.isArray(doc.servers) ? doc.servers : []) {
    const type = isObj(s) ? str(s.type) : null;
    const d = type && Object.hasOwn(DATA_CONTRACT_SERVER_DIALECTS, type) ? DATA_CONTRACT_SERVER_DIALECTS[type] : undefined;
    if (d) out.add(d);
  }
  return out.size ? [...out] : ['postgresql'];
}

/** 400 DATA_CONTRACT_SQL_REFUSED naming the first rule that does not pass the statement check for one of the DBMS. */
export function assertSqlRules(rules: SqlRule[], dialects: DbDialect[]): void {
  for (const r of rules)
    for (const d of dialects) {
      const p = sqlRuleProblem(r, d);
      if (p)
        throw new HttpError(400, `SQL quality rule "${r.name}" (${r.path}) is refused: ${p.message}`, 'DATA_CONTRACT_SQL_REFUSED', {
          rule: r.name,
          path: r.path,
          problem: sqlProblemParam(p),
        });
    }
}

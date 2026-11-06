import { DB_LIMITS, type DbDialect } from './database.js';
import type { ErrorParamText } from './errors.js';

/**
 * The read-only statement check of database platforms (ADR 0008, docs/DATABASES.md#what-steward-refuses): conservative
 * and parser-free, the same in the editor and on the server. It splits a statement into literals, quoted identifiers,
 * comments, placeholders and words, and accepts exactly one SELECT (or WITH … SELECT) without words that start or
 * change something. It refuses some harmless statements, and it cannot see what a view or function does – the
 * read-only account and the read-only transaction are the real protection; this check is the third layer, and its
 * lists of words and functions are a best effort, not a guarantee.
 */

export const SQL_PROBLEM_CODES = [
  'empty',
  'tooLong',
  'notSelect',
  'multipleStatements',
  'refusedWord',
  'refusedFunction',
  'executableComment',
  'optimizerHint',
  'rowLock',
  'unterminated',
  'backslash',
  'ambiguousComment',
  'invalidCharacter',
  'placeholders',
] as const;
export type SqlProblemCode = (typeof SQL_PROBLEM_CODES)[number];

export interface SqlProblem {
  code: SqlProblemCode;
  message: string;
  /** The word, function or character concerned */
  word?: string;
  /** Character offset in the statement */
  at?: number;
  /** Picks a variant of the translated text (errors:codes.DB_SQL_<CODE>_<context>) */
  context?: string;
  /** More values of the translated text */
  values?: Record<string, string | number>;
}

interface Token {
  /** quoted: a quoted identifier (its text without the quotes, upper case) – a name, never a refused word */
  kind: 'word' | 'symbol' | 'placeholder' | 'quoted';
  text: string;
  at: number;
}

/** Words that start a statement or change something; never accepted outside literals and quoted identifiers. */
export const REFUSED_WORDS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'DROP',
  'CREATE',
  'ALTER',
  'TRUNCATE',
  'RENAME',
  'COMMENT',
  'EXEC',
  'EXECUTE',
  'CALL',
  'DO',
  'GRANT',
  'REVOKE',
  'DENY',
  'BACKUP',
  'RESTORE',
  'DBCC',
  'SHUTDOWN',
  'KILL',
  'USE',
  'SET',
  'DECLARE',
  'BEGIN',
  'START',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'SAVE',
  'RELEASE',
  'WAITFOR',
  'BULK',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
  'INTO',
  'OUTFILE',
  'DUMPFILE',
  'RECONFIGURE',
  'CHECKPOINT',
  'UPDATETEXT',
  'WRITETEXT',
  'LOCK',
  'UNLOCK',
  'HANDLER',
  'LOAD',
  'COPY',
  'VACUUM',
  'REINDEX',
  'CLUSTER',
  'REFRESH',
  'LISTEN',
  'NOTIFY',
  'PREPARE',
  'DEALLOCATE',
  'IMPORT',
  'INSTALL',
  'UNINSTALL',
  'FLUSH',
  'RESET',
  'PURGE',
  'OPTIMIZE',
  'REPAIR',
  // PostgreSQL U&"…" UESCAPE '!': names and literals with an escape character the check would not see
  'UESCAPE',
]);

/**
 * SQL Server only: a T-SQL batch needs no semicolon, so every word that starts another statement (control flow,
 * messages, Service Broker, cursors and keys) is refused anywhere outside literals and quoted names.
 */
export const SQLSERVER_REFUSED_WORDS: ReadonlySet<string> = new Set([
  'IF',
  'WHILE',
  'BREAK',
  'CONTINUE',
  'RETURN',
  'GOTO',
  'THROW',
  'RAISERROR',
  'PRINT',
  'ENABLE',
  'DISABLE',
  'RECEIVE',
  'SEND',
  'CONVERSATION',
  'DIALOG',
  'OPEN',
  'CLOSE',
  'REVERT',
  'SETUSER',
  'READTEXT',
  'DUMP',
]);

/** SQL Server table hints that take locks beyond a plain read (refused like FOR SHARE elsewhere). */
const SQLSERVER_LOCK_HINTS: ReadonlySet<string> = new Set(['UPDLOCK', 'XLOCK', 'HOLDLOCK', 'TABLOCK', 'TABLOCKX']);

/**
 * Function names (upper case): an entry matches the name itself and names that continue with _ (DBLINK matches
 * DBLINK_EXEC); an entry ending in _ or * is a prefix (PG_ADVISORY_ matches PG_ADVISORY_LOCK, DBLINK* matches DBLINKX).
 * Functions with effects outside the transaction, and functions that run SQL given as text (which the check cannot
 * see into).
 */
const REFUSED_FUNCTIONS = [
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
  'PG_ADVISORY_',
  'PG_TRY_ADVISORY_',
  'PG_NOTIFY',
  'PG_SWITCH_WAL',
  'PG_PROMOTE',
  'PG_CREATE_',
  'PG_DROP_',
  'PG_FILE_',
  'PG_LOGICAL_EMIT_MESSAGE',
  'PG_REPLICATION_ORIGIN_',
  'PG_IMPORT_SYSTEM_COLLATIONS',
  'PG_BACKGROUND_',
  'SET_CONFIG',
  'LO_',
  'DBLINK*',
  // PostgreSQL: functions that run a query given as text
  'QUERY_TO_XML',
  'QUERY_TO_XMLSCHEMA',
  'CURSOR_TO_XML',
  'CURSOR_TO_XMLSCHEMA',
  'TABLE_TO_XML',
  'TABLE_TO_XMLSCHEMA',
  'SCHEMA_TO_XML',
  'SCHEMA_TO_XMLSCHEMA',
  'DATABASE_TO_XML',
  'DATABASE_TO_XMLSCHEMA',
  'TS_STAT',
  'TS_REWRITE',
  'CROSSTAB*',
  'CONNECTBY',
  'GET_LOCK',
  'RELEASE_LOCK',
  'RELEASE_ALL_LOCKS',
  'SOURCE_POS_WAIT',
  'MASTER_POS_WAIT',
  'LOAD_FILE',
  'XP_',
  'SP_',
];

/** Functions refused for one DBMS only (MariaDB sequences change outside the transaction). */
const DIALECT_FUNCTIONS: Record<DbDialect, readonly string[]> = { postgresql: [], mysql: ['NEXTVAL', 'SETVAL'], sqlserver: [] };

const matchesFunction = (w: string, f: string) =>
  f.endsWith('*') ? w.startsWith(f.slice(0, -1)) : f.endsWith('_') ? w.startsWith(f) : w === f || w.startsWith(`${f}_`);
const refusedFunction = (w: string, dialect: DbDialect): boolean =>
  REFUSED_FUNCTIONS.some((f) => matchesFunction(w, f)) || DIALECT_FUNCTIONS[dialect].some((f) => matchesFunction(w, f));

const isWordStart = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c.charCodeAt(0) > 127;
const isWordChar = (c: string) => isWordStart(c) || (c >= '0' && c <= '9') || c === '$';
const isDigit = (c: string) => c >= '0' && c <= '9';
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

const problem = (code: SqlProblemCode, message: string, extra: Partial<SqlProblem> = {}): SqlProblem => ({ code, message, ...extra });

/**
 * A problem as a nested error parameter ({ code, message, params }): the web app shows it translated
 * (errors:codes.DB_SQL_REFUSED_WORD …, with the variant of `context`); the English message stays for logs and audit.
 */
export function sqlProblemParam(p: SqlProblem): ErrorParamText {
  return { code: sqlProblemTextCode(p.code), message: p.message, params: sqlProblemValues(p) };
}

/** The code of a problem's translated text: refusedWord → DB_SQL_REFUSED_WORD. */
export const sqlProblemTextCode = (code: SqlProblemCode | string): string => `DB_SQL_${code.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

/** The values of a problem's translated text (the character counted from 1). */
export function sqlProblemValues(p: SqlProblem): Record<string, string | number> {
  const params: Record<string, string | number> = { ...p.values };
  if (p.word !== undefined) params.word = p.word;
  if (p.at !== undefined) params.at = p.at + 1;
  if (p.context) params.context = p.context;
  return params;
}

/** Splits a statement into tokens (literals, quoted identifiers and comments are dropped), or says why it cannot. */
export function sqlTokens(sql: string, dialect: DbDialect): Token[] | SqlProblem {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  /**
   * A quoted run from i (the opening quote) to its closing quote; a doubled quote stays inside. `name`: a quoted
   * identifier – kept as a token (its text, upper case), so a quoted function name is still checked.
   */
  const quoted = (close: string, what: string, noBackslash: boolean, name = false): SqlProblem | null => {
    const start = i;
    i++;
    for (;;) {
      if (i >= n) return problem('unterminated', `Unterminated ${what} at character ${start + 1}`, { at: start, context: name ? 'name' : 'literal' });
      const c = sql[i]!;
      if (noBackslash && c === '\\')
        return problem(
          'backslash',
          `A backslash in a literal (character ${i + 1}) is refused – its meaning depends on the server's settings; pass the value as a parameter`,
          { at: i },
        );
      if (c === close) {
        if (sql[i + 1] === close) {
          i += 2;
          continue;
        }
        i++;
        if (name)
          out.push({
            kind: 'quoted',
            text: sql
              .slice(start + 1, i - 1)
              .split(close + close)
              .join(close)
              .toUpperCase(),
            at: start,
          });
        return null;
      }
      i++;
    }
  };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1] ?? '';
    if (isSpace(c)) {
      i++;
      continue;
    }
    // comments
    if (c === '-' && next === '-') {
      // MariaDB/MySQL: "--" is a comment only when followed by a space; "--x" is two minus signs
      if (dialect === 'mysql' && sql[i + 2] !== undefined && !isSpace(sql[i + 2]!))
        return problem('ambiguousComment', `"--" without a following space (character ${i + 1}) is ambiguous in MariaDB/MySQL – write "-- "`, { at: i });
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const start = i;
      if (dialect === 'mysql' && (sql[i + 2] === '!' || (sql[i + 2] === 'M' && sql[i + 3] === '!')))
        return problem('executableComment', `Executable comments (/*! … */) are refused (character ${i + 1})`, { at: i });
      // optimizer hints change how the statement runs – MAX_EXECUTION_TIME(…) would lift Steward's time limit
      if (dialect === 'mysql' && sql[i + 2] === '+')
        return problem('optimizerHint', `Optimizer hints (/*+ … */) are refused in MariaDB/MySQL (character ${i + 1}) – they can lift the time limit`, {
          at: i,
        });
      // nested in PostgreSQL and SQL Server, not in MariaDB/MySQL
      let depth = 0;
      for (;;) {
        if (i >= n) return problem('unterminated', `Unterminated comment at character ${start + 1}`, { at: start, context: 'comment' });
        if (sql[i] === '/' && sql[i + 1] === '*' && (depth === 0 || dialect !== 'mysql')) {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      continue;
    }
    // literals and quoted identifiers
    if (c === "'") {
      const p = quoted("'", 'string literal', true);
      if (p) return p;
      continue;
    }
    if (c === '"') {
      // MariaDB/MySQL: a string literal – or a name with ANSI_QUOTES, so it is kept as a quoted name either way
      const p = quoted('"', dialect === 'mysql' ? 'string literal' : 'quoted identifier', true, true);
      if (p) return p;
      continue;
    }
    if (c === '`') {
      if (dialect !== 'mysql') return problem('invalidCharacter', `Unexpected \` at character ${i + 1}`, { at: i, word: '`' });
      const p = quoted('`', 'quoted identifier', false, true);
      if (p) return p;
      continue;
    }
    if (c === '[' && dialect === 'sqlserver') {
      const p = quoted(']', 'quoted identifier', false, true);
      if (p) return p;
      continue;
    }
    // PostgreSQL: $1 placeholders and $tag$ … $tag$ dollar quotes
    if (c === '$' && dialect === 'postgresql') {
      if (isDigit(next)) {
        let j = i + 1;
        while (j < n && isDigit(sql[j]!)) j++;
        out.push({ kind: 'placeholder', text: sql.slice(i, j), at: i });
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && isWordChar(sql[j]!) && sql[j] !== '$') j++;
      if (sql[j] === '$') {
        const tag = sql.slice(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        if (end < 0) return problem('unterminated', `Unterminated dollar-quoted literal at character ${i + 1}`, { at: i, context: 'literal' });
        i = end + tag.length;
        continue;
      }
      return problem('invalidCharacter', `Unexpected $ at character ${i + 1}`, { at: i, word: '$' });
    }
    if (c === '?' && dialect === 'mysql') {
      out.push({ kind: 'placeholder', text: '?', at: i });
      i++;
      continue;
    }
    // SQL Server: @p1 placeholders, @@VERSION, #temp names are words
    if (dialect === 'sqlserver' && (c === '@' || c === '#') && (isWordStart(next) || next === '@' || next === '#')) {
      let j = i + 1;
      while (j < n && (isWordChar(sql[j]!) || sql[j] === '@' || sql[j] === '#')) j++;
      const text = sql.slice(i, j);
      out.push({ kind: /^@p\d+$/i.test(text) ? 'placeholder' : 'word', text: text.toUpperCase(), at: i });
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && (isWordChar(sql[j]!) || (dialect === 'sqlserver' && (sql[j] === '@' || sql[j] === '#')))) j++;
      out.push({ kind: 'word', text: sql.slice(i, j).toUpperCase(), at: i });
      i = j;
      continue;
    }
    if (isDigit(c)) {
      let j = i + 1;
      while (j < n && (isWordChar(sql[j]!) || sql[j] === '.')) j++;
      i = j;
      continue;
    }
    if (c === '\0') return problem('invalidCharacter', `Unexpected NUL character at ${i + 1}`, { at: i, word: 'NUL' });
    out.push({ kind: 'symbol', text: c, at: i });
    i++;
  }
  return out;
}

/** The placeholders of a statement in the dialect's syntax: the number of parameters it needs, or a problem. */
export function sqlPlaceholderCount(tokens: Token[], dialect: DbDialect): number | SqlProblem {
  const ph = tokens.filter((t) => t.kind === 'placeholder');
  if (dialect === 'mysql') return ph.length;
  const nums = ph.map((t) => Number(t.text.replace(/^\$|^@P/i, '')));
  const max = nums.length ? Math.max(...nums) : 0;
  for (let k = 1; k <= max; k++)
    if (!nums.includes(k)) {
      const p = dialect === 'postgresql' ? `$${k}` : `@p${k}`;
      return problem('placeholders', `Placeholder ${p} is missing – number them from 1 without gaps`, { word: p, context: 'missing' });
    }
  if (nums.includes(0)) return problem('placeholders', 'Placeholders are numbered from 1', { context: 'fromOne' });
  return max;
}

/**
 * Why a statement is not accepted as a read-only query for this DBMS, or null. `params`: the number of parameters
 * the step sends (checked against the placeholders when given).
 */
export function readOnlyStatementProblem(sql: string, dialect: DbDialect, params?: number): SqlProblem | null {
  if (!sql.trim()) return problem('empty', 'The statement is empty');
  if (sql.length > DB_LIMITS.sqlChars)
    return problem('tooLong', `The statement is longer than ${DB_LIMITS.sqlChars} characters`, { values: { limit: DB_LIMITS.sqlChars } });
  const tokens = sqlTokens(sql, dialect);
  if (!Array.isArray(tokens)) return tokens;
  // one statement: a ; only at the very end
  const semi = tokens.findIndex((t) => t.kind === 'symbol' && t.text === ';');
  if (semi >= 0 && tokens.slice(semi + 1).some((t) => !(t.kind === 'symbol' && t.text === ';')))
    return problem('multipleStatements', `Only one statement is allowed (a ; at character ${tokens[semi]!.at + 1} is followed by more)`, {
      at: tokens[semi]!.at,
    });
  const first = tokens.find((t) => !(t.kind === 'symbol' && t.text === '('));
  if (!first || first.kind !== 'word' || (first.text !== 'SELECT' && first.text !== 'WITH'))
    return problem('notSelect', 'Only a query is allowed: one SELECT, or WITH … SELECT', { word: first?.text, at: first?.at });
  const word = (k: number, text: string) => tokens[k]?.kind === 'word' && tokens[k]!.text === text;
  const sqlserver = dialect === 'sqlserver';
  // parentheses: whether each open one is the body of a WITH name AS (…), and whether the last one closed was
  const open: boolean[] = [];
  let closedCte = false;
  let topSelects = 0;
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === 'symbol') {
      if (t.text === '(') open.push(word(k - 1, 'AS') || word(k - 1, 'XMLNAMESPACES'));
      else if (t.text === ')') closedCte = open.pop() ?? false;
      continue;
    }
    const call = tokens[k + 1]?.kind === 'symbol' && tokens[k + 1]!.text === '(';
    // a quoted name is a name – but a quoted function name still calls the function (compared without case)
    if (t.kind === 'quoted') {
      if (call && refusedFunction(t.text, dialect))
        return problem('refusedFunction', `"${t.text}" has effects outside the query and is not allowed (character ${t.at + 1})`, { word: t.text, at: t.at });
      continue;
    }
    if (t.kind !== 'word') continue;
    if (REFUSED_WORDS.has(t.text) || (sqlserver && SQLSERVER_REFUSED_WORDS.has(t.text)))
      return problem('refusedWord', `"${t.text}" is not allowed in a read-only query (character ${t.at + 1}); quote it if it is a name`, {
        word: t.text,
        at: t.at,
      });
    if (refusedFunction(t.text, dialect))
      return problem('refusedFunction', `"${t.text}" has effects outside the query and is not allowed (character ${t.at + 1})`, { word: t.text, at: t.at });
    // NEXT VALUE FOR a sequence (SQL Server, MariaDB): the sequence moves on even when the transaction is rolled back
    if (t.text === 'NEXT' && word(k + 1, 'VALUE'))
      return problem('refusedWord', `"NEXT VALUE FOR" changes a sequence and is not allowed (character ${t.at + 1})`, {
        word: 'NEXT VALUE FOR',
        at: t.at,
        context: 'sequence',
      });
    // row locks: FOR SHARE, FOR KEY SHARE, FOR NO KEY UPDATE (FOR UPDATE and LOCK IN SHARE MODE are refused words)
    if (t.text === 'FOR' && (word(k + 1, 'SHARE') || word(k + 1, 'KEY') || word(k + 1, 'NO')))
      return problem('rowLock', `Row locks (FOR ${tokens[k + 1]!.text} …, character ${t.at + 1}) are not allowed in a read-only query`, {
        word: `FOR ${tokens[k + 1]!.text}`,
        at: t.at,
      });
    if (sqlserver && SQLSERVER_LOCK_HINTS.has(t.text))
      return problem('rowLock', `The lock hint ${t.text} (character ${t.at + 1}) is not allowed in a read-only query`, {
        word: t.text,
        at: t.at,
        context: 'hint',
      });
    // SQL Server: a second SELECT outside parentheses starts a second statement unless UNION, EXCEPT or INTERSECT joins
    // it (or it is the query of a WITH … AS (…))
    if (sqlserver && t.text === 'SELECT' && open.length === 0) {
      const prev = tokens[k - 1];
      const joined = prev?.kind === 'word' && (prev.text === 'UNION' || prev.text === 'ALL' || prev.text === 'EXCEPT' || prev.text === 'INTERSECT');
      const cteQuery = first.text === 'WITH' && topSelects === 0 && prev?.kind === 'symbol' && prev.text === ')' && closedCte;
      const opening = t === first || cteQuery;
      if (!joined && !opening)
        return problem(
          'multipleStatements',
          `Only one statement is allowed: a second SELECT starts at character ${t.at + 1} (SQL Server needs no ; between statements) – join queries with UNION ALL`,
          { word: 'SELECT', at: t.at, context: 'select' },
        );
      topSelects++;
    }
  }
  if (!tokens.some((t) => t.kind === 'word' && t.text === 'SELECT')) return problem('notSelect', 'Only a query is allowed: one SELECT, or WITH … SELECT');
  if (params !== undefined) {
    const need = sqlPlaceholderCount(tokens, dialect);
    if (typeof need !== 'number') return need;
    if (need !== params)
      return problem(
        'placeholders',
        `The statement has ${need} placeholder(s) but ${params} parameter(s) are given (placeholders: ${dialect === 'postgresql' ? '$1, $2' : dialect === 'mysql' ? '?' : '@p1, @p2'} …)`,
        { context: 'count', values: { need, given: params, syntax: dialect === 'postgresql' ? '$1, $2' : dialect === 'mysql' ? '?' : '@p1, @p2' } },
      );
  }
  return null;
}

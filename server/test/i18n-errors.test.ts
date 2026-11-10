import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LIBRARY_REFUSALS, SQL_PROBLEM_CODES, sqlProblemTextCode } from '@sm/shared';

// Server errors reach the web UI as { error, code, params }. The UI shows errors:codes.<code>
// (translated, with the params filled in) and the English message only for unknown codes.
// These tests keep the codes and the translations in sync (docs/I18N.md, "API errors").
const root = path.resolve(__dirname, '../..');
const src = path.join(root, 'server/src');
const errorsJson = (lang: string) =>
  JSON.parse(fs.readFileSync(path.join(root, 'web/src/locales', lang, 'errors.json'), 'utf8')).codes as Record<string, string>;

/** Areas whose errors are shown on the pages a person works with; every HttpError there needs a code. */
const CODED_AREAS = [
  'records/',
  'sync/',
  'compliance/',
  'catalogue/',
  'duties/',
  'scorecard/',
  'credentials/',
  'reports/',
  'gatus/',
  'mcp/',
  'monitors/',
  'duplicate/',
  'plant/',
  'dbschema/',
  'datacontracts/',
  'routes/reports.ts',
  'routes/report-schedules.ts',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const literals = (n: ts.Expression | undefined): string[] => {
  if (!n) return [];
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isConditionalExpression(n)) return [...literals(n.whenTrue), ...literals(n.whenFalse)];
  if (ts.isParenthesizedExpression(n)) return literals(n.expression);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return [...literals(n.left), ...literals(n.right)];
  return [];
};

interface Throw {
  file: string;
  line: number;
  codes: string[];
  contexts: string[];
}

/** Every `new HttpError(…)` / `new CertificateError(…)` / `new DbError(…)` / `new MapError(…)` with its code(s) and literal `context` values. */
function scan(): { throws: Throw[]; otherCodes: { file: string; code: string }[] } {
  const throws: Throw[] = [];
  const otherCodes: { file: string; code: string }[] = [];
  for (const file of walk(src)) {
    const rel = path.relative(src, file).split(path.sep).join('/');
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ['HttpError', 'CertificateError', 'DbError', 'MapError'].includes(n.expression.text)) {
        const args = n.arguments ?? [];
        // DbError (database platforms) takes the code first: new DbError(code, message, params, status)
        // MapError (the map of sites) takes the arguments of HttpError
        const codeAt = n.expression.text === 'HttpError' || n.expression.text === 'MapError' ? 2 : n.expression.text === 'DbError' ? 0 : 1;
        const params = args[codeAt + 1];
        const contexts: string[] = [];
        if (params && ts.isObjectLiteralExpression(params))
          for (const p of params.properties) if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'context') contexts.push(...literals(p.initializer));
        const codes = literals(args[codeAt]);
        // a CertificateError without a code gets CERTIFICATE_INVALID
        if (n.expression.text === 'CertificateError' && !args[codeAt]) codes.push('CERTIFICATE_INVALID');
        throws.push({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, codes, contexts });
      }
      // codes in plain objects: reasons ({ code, message }), import notes, signed-PDF checks, hand-written error replies
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'code' && ts.isObjectLiteralExpression(n.parent)) {
        const siblings = n.parent.properties.map((p) => p.name?.getText(sf));
        if (['message', 'error', 'params', 'reason'].some((k) => siblings.includes(k)))
          for (const code of literals(n.initializer)) if (/^[A-Z][A-Z0-9_]{2,}$/.test(code)) otherCodes.push({ file: rel, code });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { throws, otherCodes };
}

describe('server error codes', () => {
  const { throws, otherCodes } = scan();
  // the reasons of the statement check (shared/src/sqlcheck.ts), nested in DB_STATEMENT_REFUSED
  for (const c of SQL_PROBLEM_CODES) otherCodes.push({ file: '../../shared/src/sqlcheck.ts', code: sqlProblemTextCode(c) });
  const en = errorsJson('en');
  const de = errorsJson('de');
  /** Codes the UI translates itself (record status, field labels of built-in types). */
  const VALUE_CODES = ['RECORD_STATUS', 'RECORD_FIELD', 'RUN_STATUS'];
  /** The theme card shows its upload errors itself (system:theme.errors.<CODE>). */
  const themeErrors = JSON.parse(fs.readFileSync(path.join(root, 'web/src/locales/en/system.json'), 'utf8')).theme.errors as Record<string, string>;
  /** Single sign-on configuration warnings and test sign-in notes are not errors: users:provider.warnings / provider.test.notes. */
  const ssoTexts = JSON.parse(fs.readFileSync(path.join(root, 'web/src/locales/en/users.json'), 'utf8')).provider as {
    warnings: Record<string, string>;
    test: { notes: Record<string, string> };
  };
  const known = (code: string) =>
    code in en ||
    `${code}_other` in en ||
    VALUE_CODES.includes(code) ||
    (code.startsWith('THEME_') && code in themeErrors) ||
    code in ssoTexts.warnings ||
    code in ssoTexts.test.notes;

  it('finds the errors (the scan works)', () => {
    expect(throws.length).toBeGreaterThan(300);
    expect(throws.some((t) => t.codes.includes('RECORD_NOT_FOUND'))).toBe(true);
  });

  it('every error in the records, services, credentials, reports, Gatus, MCP and monitor code has a code', () => {
    const missing = throws.filter((t) => CODED_AREAS.some((a) => t.file.startsWith(a)) && t.codes.length === 0).map((t) => `${t.file}:${t.line}`);
    expect(missing).toEqual([]);
  });

  it('every code thrown anywhere has an English and a German text (errors:codes.<CODE>)', () => {
    const all = new Set([...throws.flatMap((t) => t.codes), ...otherCodes.map((c) => c.code)]);
    const untranslated = [...all].filter((c) => !known(c)).sort();
    expect(untranslated).toEqual([]);
    for (const c of all) for (const k of [c, `${c}_one`, `${c}_other`]) if (k in en) expect(de[k], `de: errors:codes.${k}`).toBeTruthy();
  });

  it('every literal context has its own text or falls back to the code', () => {
    const missing: string[] = [];
    for (const t of throws)
      for (const code of t.codes)
        for (const ctx of t.contexts) if (ctx && !(`${code}_${ctx}` in en) && !(code in en)) missing.push(`${code}_${ctx} (${t.file}:${t.line})`);
    expect(missing).toEqual([]);
  });

  it('the English texts do not drift into keys nobody throws', () => {
    const all = new Set([...throws.flatMap((t) => t.codes), ...otherCodes.map((c) => c.code)]);
    // codes sent by hand-written replies or other services (auth routes, SSO) are listed here
    const external = new Set([
      'PASSWORD_CHANGE_REQUIRED',
      'NOT_SIGNED_IN',
      'VAULT_LOCKED',
      'SSO_VAULT_LOCKED',
      // single sign-on step-up refusals the dialog shows (auth/sso.ts finishStepUp), and the web app's own cancel
      'STEP_UP_OTHER_IDENTITY',
      'STEP_UP_REFUSED',
      'STEP_UP_SSO_FAILED',
      'STEP_UP_CANCELLED',
      // 0.13.0: the web app's own cancel of the choice per field after 409 PLANT_ENTRY_CHANGED (api.ts)
      'PLANT_ENTRY_CHANGED_CANCELLED',
      // a switched-off module (modules/registry.ts moduleOffCode(id): PLANT_MODULE_OFF or MODULE_OFF)
      'MODULE_OFF',
      // refused library releases (libraries/releases.ts refusal(code, …)): checked below
      ...LIBRARY_REFUSALS,
    ]);
    for (const c of LIBRARY_REFUSALS) expect(en[c] && errorsJson('de')[c], `errors:codes.${c}`).toBeTruthy();
    const unused = Object.keys(en)
      .map((k) => k.replace(/_(?:[a-z][A-Za-z0-9-]*|right_[a-z]+)$/, ''))
      .map((k) => k.replace(/_(?:one|other)$/, ''))
      .filter((k) => !all.has(k) && !external.has(k));
    expect([...new Set(unused)]).toEqual([]);
  });
});

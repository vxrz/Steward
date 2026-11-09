import YAML from 'yaml';
import { PLANT_SOURCE_LIMITS } from '@sm/shared';

/**
 * Secrets out of a collector's configuration before Steward keeps it (0.12, docs/PLANT.md "Gateway configurations").
 * What is stored, downloaded, diffed and attached to the gateway configuration document is the redacted copy; the
 * original is read once by the importer and never written anywhere. The redacted paths are kept (never the values).
 *
 * - JSON and YAML: the value of every key that looks secret (password, passwd, pwd, secret, token, API key, private
 *   key, credentials, certificate passwords, auth headers such as Authorization or Cookie, connection strings) is
 *   replaced at any depth – a whole object or list under such a key, too. A name/value pair whose name is such a key
 *   (`{ "key": "Authorization", "value": "Bearer …" }`, Node-RED's HTTP headers) loses its value.
 * - Node-RED: the `credentials` object of a node is dropped entirely, before anything else looks at it.
 * - URLs and connection strings with user information (`scheme://user:password@host`) lose the password, in every
 *   format and in any string.
 * - CSV: kept as it is, except columns whose header looks secret (blanked) and user information in URLs.
 * YAML comments are not kept (they are text nobody checked).
 */

export const REDACTED = '[redacted]';

/** Keys whose values are secrets (compared without "-", "_", "." and case). */
const SECRET_KEY =
  /^(pass(word|wd|phrase)?|pwd|.*password|.*passwd|.*secret|.*token|.*apikey|privatekey|.*privatekey|credentials?|.*credentials|authorization|proxyauthorization|auth|authheader|cookie|setcookie|xapikey|xauthtoken|connectionstring|connstr|connectionuri|sas|sastoken|signature|accesskey|accesskeyid|secretaccesskey|clientsecret|keystorepassword|truststorepassword|pfx|pfxpassword|passphrase|pin)$/;
/** Keys that look secret but name settings: their values are kept (an authentication mode, a token's lifetime). */
const NOT_SECRET = /^(authenticationmode|authmode|authtype|authenticationtype|tokenendpoint|tokenurl|tokentype|tokenlifetime|usetoken|usetls|secure)$/;

const norm = (k: string) => k.toLowerCase().replace(/[-_.\s]/g, '');
export const isSecretKey = (k: string): boolean => {
  const n = norm(k);
  return !!n && !NOT_SECRET.test(n) && SECRET_KEY.test(n);
};

/** user:password@ in a URL or connection string: the password goes, the user stays. */
const USERINFO = /\b([a-z][a-z0-9+.-]{1,30}:\/\/)([^\s/:@"'<>]*):([^\s/@"'<>]+)@/gi;

export function redactUserinfo(text: string): { text: string; hit: boolean } {
  let hit = false;
  const out = text.replace(USERINFO, (_m, scheme: string, user: string) => {
    hit = true;
    return `${scheme}${user}:${REDACTED}@`;
  });
  return { text: out, hit };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (isObj(v) && !Object.keys(v).length);
const pathOf = (base: string, key: string | number) =>
  typeof key === 'number' ? `${base}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`;

/** Keys of a name/value pair: the pair's name and the value it names. */
const PAIR_NAME = ['key', 'name', 'keyValue', 'header', 'k'];
const PAIR_VALUE = ['value', 'valueValue', 'val', 'v'];

export interface Redacted<T> {
  value: T;
  /** Where values were removed, in document order */
  paths: string[];
}

/**
 * A parsed JSON or YAML document with its secrets removed (a copy; the input is not changed). `nodeRed`: drop the
 * `credentials` of every node.
 */
export function redactValue<T>(input: T, opts: { nodeRed?: boolean } = {}): Redacted<T> {
  const paths: string[] = [];
  const walk = (v: unknown, at: string, depth: number): unknown => {
    if (depth > 200) return REDACTED; // deeper than any configuration: not kept
    if (typeof v === 'string') {
      const r = redactUserinfo(v);
      if (r.hit) paths.push(at || '(value)');
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, pathOf(at, i), depth + 1));
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    const pairName = PAIR_NAME.map((k) => v[k]).find((x) => typeof x === 'string') as string | undefined;
    const secretPair = !!pairName && isSecretKey(pairName);
    for (const [k, x] of Object.entries(v)) {
      const here = pathOf(at, k);
      // Node-RED keeps a node's sign-in data in `credentials`: never kept, not even redacted
      if (opts.nodeRed && k === 'credentials') {
        if (!empty(x)) paths.push(here);
        continue;
      }
      if ((isSecretKey(k) || (secretPair && PAIR_VALUE.includes(k))) && !empty(x)) {
        paths.push(here);
        out[k] = REDACTED;
        continue;
      }
      out[k] = walk(x, here, depth + 1);
    }
    return out;
  };
  const value = walk(input, '', 0) as T;
  return { value, paths: paths.slice(0, PLANT_SOURCE_LIMITS.redactedPaths) };
}

// ---------- CSV ----------

/** CSV cells, as the importer reads them (separator "," or ";", RFC 4180 quotes). */
export function csvCells(text: string): { rows: string[][]; sep: string } {
  const body = text.replace(/^\uFEFF/, '');
  const first = body.split(/\r?\n/, 1)[0] ?? '';
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') ((cell += '"'), i++);
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) (row.push(cell), (cell = ''));
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return { rows, sep };
}

const csvCell = (s: string, sep: string) => (s.includes(sep) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** A CSV file: as it is, unless a header looks secret (that column is blanked) or a cell holds a URL with a password. */
export function redactCsv(text: string): Redacted<string> {
  const { rows, sep } = csvCells(text);
  const head = rows[0] ?? [];
  const secret = head.map((h, i) => (isSecretKey(h.trim()) ? i : -1)).filter((i) => i >= 0);
  const paths: string[] = secret.filter((i) => rows.slice(1).some((r) => (r[i] ?? '').trim())).map((i) => `column ${JSON.stringify(head[i]!.trim())}`);
  let urls = false;
  if (!secret.length) {
    const r = redactUserinfo(text);
    if (r.hit) paths.push('(URLs with a password)');
    return { value: r.text, paths };
  }
  const out = rows.map((r, n) =>
    r.map((c, i) => {
      if (n > 0 && secret.includes(i)) return '';
      const u = redactUserinfo(c);
      urls ||= u.hit;
      return csvCell(u.text, sep);
    }),
  );
  if (urls) paths.push('(URLs with a password)');
  return { value: out.map((r) => r.join(sep)).join('\n') + '\n', paths };
}

// ---------- a file ----------

export interface RedactedFile {
  content: string;
  paths: string[];
  /** json, yaml or csv: how the content is written (and compared) */
  syntax: 'json' | 'yaml' | 'csv';
}

/**
 * A collector's file with its secrets removed. `parsed` is the file as the importer read it (JSON and YAML); `csv`:
 * a table file. JSON stays JSON (indented), YAML is written anew (without comments).
 */
export function redactFile(content: string, parsed: unknown, opts: { csv: boolean; nodeRed: boolean }): RedactedFile {
  if (opts.csv) {
    const r = redactCsv(content);
    return { content: r.value, paths: r.paths, syntax: 'csv' };
  }
  const r = redactValue(parsed, { nodeRed: opts.nodeRed });
  const json = /^\s*[[{]/.test(content);
  return json
    ? { content: JSON.stringify(r.value, null, 2) + '\n', paths: r.paths, syntax: 'json' }
    : { content: YAML.stringify(r.value, { lineWidth: 0 }), paths: r.paths, syntax: 'yaml' };
}

/** Every string of a parsed collection (names, destinations, settings) without passwords in URLs, settings of secret keys blanked. */
export function scrubParsed<T>(v: T): T {
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return redactUserinfo(x).text;
    if (Array.isArray(x)) return x.map(walk);
    if (!isObj(x)) return x;
    const out: Record<string, unknown> = {};
    for (const [k, y] of Object.entries(x)) out[k] = walk(y);
    // a setting { key, value } whose key looks secret
    if (typeof out.key === 'string' && 'value' in out && isSecretKey(out.key) && !empty(out.value)) out.value = REDACTED;
    return out;
  };
  return walk(v) as T;
}

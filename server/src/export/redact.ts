/**
 * Credentials out of monitor definitions before a scheduled export writes them (0.16.0, docs/EXPORTS.md "No secrets").
 * A monitor's own secrets (heartbeat keys) are never part of its definition, but a definition can carry credentials
 * typed into it: request headers of an HTTP check (`Authorization: Basic …`), user information in a URL
 * (`https://user:password@host/`), a key in a query (`…/api/hook?code=…`) or in the path of a webhook service that
 * puts it there (Slack, Discord). In the copy that leaves Steward each such value becomes `<redacted>`; the paths
 * of what was redacted are kept (never the values) and listed in the manifest.
 *
 * Only for what leaves Steward: the definition in the database, its YAML export (_Monitors → Export_) and Git sync stay
 * as they are, because they must import back.
 */

export const EXPORT_REDACTED = '<redacted>';

/** Header names whose values are credentials (case-insensitive). */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key)$|token|secret|key|auth|password|passwd|session/i;

/** Query parameter names whose values are credentials (compared in lower case). */
const SECRET_PARAMS = new Set([
  'code',
  'token',
  'key',
  'sig',
  'signature',
  'secret',
  'password',
  'passwd',
  'pwd',
  'apikey',
  'api_key',
  'api-key',
  'access_token',
  'client_secret',
  'auth',
]);
const SECRET_PARAM_PART = /token|secret|password|apikey|api_key|signature/i;

/** Webhook services that carry their secret in the URL path: the whole path goes. */
const SECRET_PATH_HOSTS = /^(hooks\.slack\.com|discord(app)?\.com|[a-z0-9-]+\.webhook\.office\.com|outlook\.office(365)?\.com)$/i;

/** Keys whose string values are URLs or paths (with a query) */
const URL_KEYS = new Set(['url', 'path', 'href', 'endpoint', 'webhook', 'webhookUrl', 'link']);

const ABSOLUTE = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is;

const isSecretParam = (name: string): boolean => {
  let n = name;
  try {
    n = decodeURIComponent(name);
  } catch {
    // a malformed escape: compared as it is
  }
  n = n.toLowerCase();
  return SECRET_PARAMS.has(n) || SECRET_PARAM_PART.test(n);
};

/** The query of a URL or path with the values of secret parameters redacted. */
function redactQuery(rest: string): { text: string; hit: boolean } {
  const q = rest.indexOf('?');
  if (q < 0) return { text: rest, hit: false };
  const hashAt = rest.indexOf('#', q);
  const query = rest.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  let hit = false;
  const out = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      if (eq < 0 || !isSecretParam(name) || pair.slice(eq + 1) === '') return pair;
      hit = true;
      return `${name}=${EXPORT_REDACTED}`;
    })
    .join('&');
  return { text: `${rest.slice(0, q)}?${out}${hashAt < 0 ? '' : rest.slice(hashAt)}`, hit };
}

/** A URL (or a path with a query) with user information, secret query values and secret paths redacted. */
export function redactUrl(value: string): { text: string; hit: boolean } {
  const m = ABSOLUTE.exec(value);
  if (!m) return value.includes('?') ? redactQuery(value) : { text: value, hit: false };
  const [, scheme, authority, rest] = m as unknown as [string, string, string, string];
  let hit = false;
  let host = authority;
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    host = authority.slice(at + 1);
    hit = true;
  }
  let tail = rest;
  const hostName = host.replace(/:\d+$/, '');
  if (SECRET_PATH_HOSTS.test(hostName) && /^\/[^?#]/.test(rest)) {
    const end = rest.search(/[?#]/);
    tail = `/${EXPORT_REDACTED}${end < 0 ? '' : rest.slice(end)}`;
    hit = true;
  }
  const q = redactQuery(tail);
  return { text: `${scheme}${at >= 0 ? `${EXPORT_REDACTED}@` : ''}${host}${q.text}`, hit: hit || q.hit };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const pathOf = (base: string, key: string | number) =>
  typeof key === 'number' ? `${base}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`;

/**
 * A copy of a definition with the credentials typed into it redacted, and where (paths like
 * `checks[0].headers.Authorization`). Request headers: by name; URLs: user information, secret query values and the
 * path of webhook services that carry their key in it – in URL fields and in any string that is an absolute URL.
 */
export function redactCredentials<T>(input: T): { value: T; paths: string[] } {
  const paths: string[] = [];
  const walk = (v: unknown, at: string, key: string | null, depth: number): unknown => {
    if (depth > 100) return v;
    if (typeof v === 'string') {
      if (!ABSOLUTE.test(v) && !(key !== null && URL_KEYS.has(key))) return v;
      const r = redactUrl(v);
      if (r.hit) paths.push(at);
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, pathOf(at, i), null, depth + 1));
    if (!isObj(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const here = pathOf(at, k);
      if (k.toLowerCase() === 'headers' && isObj(x)) {
        const headers: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(x)) {
          if (SECRET_HEADER.test(name) && value !== '' && value !== null && value !== undefined) {
            headers[name] = EXPORT_REDACTED;
            paths.push(pathOf(here, name));
          } else headers[name] = walk(value, pathOf(here, name), name, depth + 2);
        }
        out[k] = headers;
        continue;
      }
      out[k] = walk(x, here, k, depth + 1);
    }
    return out;
  };
  return { value: walk(input, '', null, 0) as T, paths };
}

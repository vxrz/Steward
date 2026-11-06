import { CHANGEDETECTION_KIND, PVAULT_KIND } from '@sm/shared';
import { HttpError } from '../util.js';

/**
 * Paths a platform kind never calls, whoever asks (v0.5.0, #205): checked in platformRequest for every request and
 * every redirect hop – process steps, the MCP gateway, monitors and Steward's own readers alike. A rule sees the
 * request URL's path segments (decoded, lower case, empty and "." segments dropped) and its query parameter names, and
 * answers why it is refused, or null.
 *
 * IBM Verify Privilege Vault (Delinea Secret Server): Steward never reads secret values. Refused are
 *   - /secrets/{id} itself (its answer holds the field values, items[].itemValue), /secrets/{id}/fields/…, file
 *     downloads, /secrets/{id}/restricted/… and every other sub-resource of a secret except summary, audits and state;
 *     /secrets/export and the like – only the search (/secrets), /secrets/lookup and /secrets/search-total stay
 *   - one-time password codes, the browser extension's search, launchers, the "internals" API, the SOAP web services
 *   - exports outside reports
 *   - searching by a field (filter.searchField / filter.searchFieldSlug, a way to test guesses of a value) and
 *     extended fields in search results (filter.extendedFields – field values)
 * The list is an allow list under /secrets: a sub-resource added in a later version is refused until it is reviewed.
 */

type Rule = (segments: string[], queryNames: string[], method: string) => string | null;

const SECRET_SUBRESOURCES_ALLOWED = new Set(['summary', 'audits', 'state']);
const SECRET_LISTS_ALLOWED = new Set(['lookup', 'search-total']);
const REFUSED_ANYWHERE = new Set([
  'one-time-password-code',
  'secret-extensions',
  'launchers',
  'launcher-session',
  'internals',
  'webservices',
  'winauthwebservices',
]);
const REFUSED_QUERY = new Set(['filter.extendedfields', 'extendedfields', 'filter.searchfield', 'filter.searchfieldslug', 'searchfield', 'searchfieldslug']);

const pvaultRule: Rule = (segs, query) => {
  for (const q of query) if (REFUSED_QUERY.has(q)) return `the query parameter ${q} (it reads or searches field values)`;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (REFUSED_ANYWHERE.has(s) || s.endsWith('.asmx')) return `/${s} (it can return secret values)`;
    if (s === 'export' && !segs.slice(0, i).includes('reports')) return '/export (an export holds secret values)';
    if (s !== 'secrets') continue;
    const rest = segs.slice(i + 1);
    if (!rest.length) continue;
    if (rest.length === 1 && SECRET_LISTS_ALLOWED.has(rest[0]!)) continue;
    if (rest.length === 1) return `/secrets/${rest[0]} (the answer holds the field values)`;
    if (rest.length === 2 && SECRET_SUBRESOURCES_ALLOWED.has(rest[1]!)) continue;
    return `/secrets/${rest.slice(0, 3).join('/')} (only a secret's summary, audits and state are read)`;
  }
  return null;
};

/**
 * changedetection.io (0.9.0, #242): read-only, and never page contents. Its API key may do everything, so the kind
 * itself only reads – an allow list below /api/v1 (any prefix before it, for a reverse proxy's sub-path):
 *   - GET (and HEAD) only: creating, changing and deleting watches, tags, notifications or history is refused
 *   - the watch list, a watch, the snapshot times of a watch (/watch/{uuid}/history), its favicon, the tags, a tag,
 *     search, systeminfo and the API description; refused are a snapshot (/watch/{uuid}/history/{timestamp}), a diff
 *     (/watch/{uuid}/difference/…) and /changes – page contents –, /notifications (its URLs carry credentials), and
 *     everything outside the API (changedetection.io's own pages: diff, preview, settings, backups …)
 *   - the parameters that change state on a GET: recheck, recheck_all, paused, muted
 */
const CD_ALLOWED = new Set(['watch', 'tags', 'tag', 'systeminfo', 'search', 'full-spec']);
const CD_REFUSED_QUERY = new Set(['recheck', 'recheck_all', 'paused', 'muted']);
const changedetectionRule: Rule = (segs, query, method) => {
  if (method !== 'GET' && method !== 'HEAD') return `${method} (Steward only reads changedetection.io)`;
  for (const q of query) if (CD_REFUSED_QUERY.has(q)) return `the query parameter ${q} (it changes the watch)`;
  let i = 0;
  while (i < segs.length - 1 && !(segs[i] === 'api' && segs[i + 1] === 'v1')) i++;
  if (i >= segs.length - 1) return "a path outside the REST API /api/v1 (changedetection.io's own pages can show page contents)";
  const rest = segs.slice(i + 2);
  const [first, , third, fourth] = rest;
  if (!first) return null;
  if (first === 'changes') return '/changes (its answer holds the diffs of the pages)';
  if (first === 'notifications') return '/notifications (notification URLs carry credentials)';
  if (!CD_ALLOWED.has(first)) return `/${first} (not one of the read endpoints Steward uses)`;
  if (first !== 'watch')
    return rest.length <= 2 && (first === 'tag' || rest.length === 1) ? null : `/${rest.slice(0, 3).join('/')} (not one of the read endpoints Steward uses)`;
  if (rest.length <= 2) return null;
  if (third === 'history' && fourth === undefined) return null;
  if (third === 'favicon' && fourth === undefined) return null;
  if (third === 'history' || third === 'difference') return `/watch/{uuid}/${third}/… (a snapshot or diff holds the page content)`;
  return `/watch/{uuid}/${third} (not one of the read endpoints Steward uses)`;
};

const RULES: Record<string, Rule> = { [PVAULT_KIND]: pvaultRule, [CHANGEDETECTION_KIND]: changedetectionRule };

/** The decoded, lower-case path segments of a URL; null when a segment cannot be decoded (refused). */
export function pathSegments(pathname: string): string[] | null {
  const out: string[] = [];
  for (const raw of pathname.split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    // an encoded slash or backslash inside a segment, and IIS's ";…" path parameters
    for (const part of seg.split(/[/\\]/)) {
      const semi = part.indexOf(';');
      const p = (semi >= 0 ? part.slice(0, semi) : part).trim().toLowerCase();
      if (p && p !== '.') out.push(p);
    }
  }
  return out;
}

/** Why a request of this platform kind to the URL is refused, or null (kinds without rules: always null). */
export function deniedPath(kind: string, url: string, method = 'GET'): string | null {
  const rule = RULES[kind];
  if (!rule) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'an invalid URL';
  }
  const segs = pathSegments(u.pathname);
  if (!segs) return 'a path that cannot be decoded';
  return rule(
    segs,
    [...u.searchParams.keys()].map((k) => k.trim().toLowerCase()),
    method.toUpperCase(),
  );
}

/** Throws 403 PLATFORM_PATH_DENIED when the platform kind never calls this URL. */
export function assertPathAllowed(kind: string, url: string, method?: string): void {
  const why = deniedPath(kind, url, method);
  if (!why) return;
  let where = url;
  try {
    const u = new URL(url);
    where = `${u.origin}${u.pathname}`;
  } catch {
    /* shown as given */
  }
  throw Object.assign(
    new HttpError(
      403,
      kind === PVAULT_KIND
        ? `Steward never reads secret values: ${why} is refused for IBM Verify Privilege Vault platforms (${where})`
        : `This path is refused for ${kind} platforms: ${why} (${where})`,
      'PLATFORM_PATH_DENIED',
      { kind, reason: why.slice(0, 200) },
    ),
    { retryable: false },
  );
}

/** Keys that hold secret values in a vault's answers: removed from every answer of the kind before it is used, stored or logged. */
const VALUE_KEYS: Record<string, ReadonlySet<string>> = {
  [PVAULT_KIND]: new Set(['itemvalue', 'extendedfields', 'password', 'privatekey', 'privatekeypassphrase', 'passphrase', 'filecontent']),
  // a watch's settings can carry credentials of the watched site or of notification targets (a Steward webhook secret),
  // and the AI evaluation cache of newer versions text of the page (#242)
  [CHANGEDETECTION_KIND]: new Set(['notification_urls', 'headers', 'body', 'browser_steps', 'webdriver_js_execute_code', 'llm_evaluation_cache']),
};

/** A copy of an answer without the kind's value keys (at most 64 levels deep; deeper parts are dropped). */
export function stripValues<T>(kind: string, body: T): T {
  const keys = VALUE_KEYS[kind];
  if (!keys) return body;
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 64) return null;
    if (Array.isArray(x)) return x.map((v) => walk(v, depth + 1));
    if (x && typeof x === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x)) if (!keys.has(k.toLowerCase())) out[k] = walk(v, depth + 1);
      return out;
    }
    return x;
  };
  return walk(body, 0) as T;
}

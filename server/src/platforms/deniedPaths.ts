import { KAFKA_CONNECT_KIND, PVAULT_KIND, redactConnectAnswer } from '@sm/shared';
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

type Rule = (segments: string[], queryNames: string[]) => string | null;

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

const RULES: Record<string, Rule> = { [PVAULT_KIND]: pvaultRule };

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
export function deniedPath(kind: string, url: string): string | null {
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
  );
}

/** Throws 403 PLATFORM_PATH_DENIED when the platform kind never calls this URL. */
export function assertPathAllowed(kind: string, url: string): void {
  const why = deniedPath(kind, url);
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
};

/**
 * Kinds that are only read (0.9.0): Kafka Connect (#223) – no connector is created, changed, restarted, paused or
 * resumed through Steward, whoever asks (process steps, the explorer, the MCP gateway, recordings).
 */
const READ_ONLY_KINDS = new Set([KAFKA_CONNECT_KIND]);
const READ_METHODS = new Set(['GET', 'HEAD']);

/** Throws 403 PLATFORM_METHOD_DENIED for a changing request to a platform of a read-only kind. */
export function assertMethodAllowed(kind: string, method: string): void {
  if (!READ_ONLY_KINDS.has(kind) || READ_METHODS.has(method.toUpperCase())) return;
  throw Object.assign(
    new HttpError(403, `Steward only reads ${kind} platforms: ${method.toUpperCase().slice(0, 10)} is refused`, 'PLATFORM_METHOD_DENIED', {
      kind,
      method: method.toUpperCase().slice(0, 10),
    }),
    { retryable: false },
  );
}

/**
 * A copy of an answer without the kind's value keys (at most 64 levels deep; deeper parts are dropped). Kafka Connect
 * (#223): connector configurations with their secret-looking values removed and error traces trimmed
 * (redactConnectAnswer in shared/src/kafkaConnect.ts).
 */
export function stripValues<T>(kind: string, body: T): T {
  if (kind === KAFKA_CONNECT_KIND) return redactConnectAnswer(body);
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

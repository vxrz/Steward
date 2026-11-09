import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CHANGEDETECTION_KIND,
  CONFLUENT_KIND,
  CONTAINER_REGISTRY_KIND,
  DATA_CONTRACT_SERVICE_KIND,
  KAFKA_CONNECT_KIND,
  PVAULT_KIND,
  redactConnectAnswer,
  watchUrlWithoutCredentials,
} from '@sm/shared';
import { HttpError } from '../util.js';

/**
 * Paths a platform kind never calls, whoever asks (v0.5.0, #205): checked in platformRequest for every request and
 * every redirect hop – process steps, the MCP gateway, monitors and Steward's own readers alike. A rule sees the
 * request URL's path segments (decoded, lower case, empty and "." segments dropped) and its query parameter names, and
 * answers why it is refused, or null. Kinds that are only read (0.9.0: Kafka Connect, changedetection.io) refuse every
 * method but GET and HEAD first, in the same check (assertPathAllowed, READ_ONLY_KINDS).
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

/**
 * changedetection.io (0.9.0, #242): read-only, and never page contents. Its API key may do everything, so the kind
 * itself only reads – an allow list below /api/v1 (any prefix before it, for a reverse proxy's sub-path):
 *   - GET (and HEAD) only (READ_ONLY_KINDS, PLATFORM_METHOD_DENIED): creating, changing and deleting watches, tags,
 *     notifications or history is refused
 *   - the watch list, a watch, the snapshot times of a watch (/watch/{uuid}/history), its favicon, the tags, a tag,
 *     search, systeminfo and the API description; refused are a snapshot (/watch/{uuid}/history/{timestamp}), a diff
 *     (/watch/{uuid}/difference/…) and /changes – page contents –, /notifications (its URLs carry credentials), and
 *     everything outside the API (changedetection.io's own pages: diff, preview, settings, backups …)
 *   - the parameters that change state on a GET: recheck, recheck_all, paused, muted
 */
const CD_ALLOWED = new Set(['watch', 'tags', 'tag', 'systeminfo', 'search', 'full-spec']);
const CD_REFUSED_QUERY = new Set(['recheck', 'recheck_all', 'paused', 'muted']);
const changedetectionRule: Rule = (segs, query) => {
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

/** Why a request of this platform kind to the URL is refused, or null (kinds without rules: always null). The method: deniedMethod. */
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

/**
 * Kinds that are only read (0.9.0): Kafka Connect (#223) – no connector is created, changed, restarted, paused or
 * resumed –, changedetection.io (#242) – no watch, tag, notification or history is created, changed or deleted – and
 * container registries (the version watch reads image tags) through Steward, whoever asks (process steps, the explorer,
 * the MCP gateway, monitors, recordings, redirect hops). 0.14.0: Confluent Cloud (#123) – no cluster, connector, key or
 * role binding is created, changed, paused or deleted.
 */
const READ_ONLY_KINDS: ReadonlySet<string> = new Set([KAFKA_CONNECT_KIND, CHANGEDETECTION_KIND, CONTAINER_REGISTRY_KIND, CONFLUENT_KIND]);

/**
 * Kinds with rules of their own – read-only, refused paths or values removed from answers. Their rules also apply to a
 * request that another platform sends to their origin (0.9.0, destinationKinds in restrictedOrigins.ts).
 */
export const RESTRICTED_KINDS: readonly string[] = [
  PVAULT_KIND,
  CHANGEDETECTION_KIND,
  KAFKA_CONNECT_KIND,
  CONTAINER_REGISTRY_KIND,
  DATA_CONTRACT_SERVICE_KIND,
  CONFLUENT_KIND,
];
const READ_METHODS = new Set(['GET', 'HEAD']);

/** Why this method is refused for the platform kind (a changing method to a read-only kind), or null. */
export function deniedMethod(kind: string, method: string): string | null {
  const m = method.trim().toUpperCase();
  return READ_ONLY_KINDS.has(kind) && !READ_METHODS.has(m) ? m.slice(0, 10) : null;
}

/**
 * Kinds only Steward's own code calls with a changing method (0.9.0): the data contract service (#221) – its POST /test
 * connects to any database with the credentials in the request's headers, its /lint and /export read what is sent –
 * so only Steward's tests and its "Lint with the service" call it (datacontracts/testing.ts, inside `ownCall`). From
 * process steps, the explorer, ad-hoc requests, the MCP gateway, monitors and recordings only GET and HEAD go through
 * (the connection test reads /openapi.json); /test and /lint are refused whatever the method.
 */
const OWN_CALL_KINDS: ReadonlySet<string> = new Set([DATA_CONTRACT_SERVICE_KIND]);
const OWN_CALL_PATHS = new Set(['test', 'lint']);
const ownCalls = new AsyncLocalStorage<string>();

/** Runs `fn` as Steward's own call to a kind of OWN_CALL_KINDS (its requests pass deniedOwnCall). */
export function ownCall<T>(kind: string, fn: () => Promise<T>): Promise<T> {
  return ownCalls.run(kind, fn);
}

/** Why a request to a kind only Steward calls is refused (not inside `ownCall` for that kind), or null. */
export function deniedOwnCall(kind: string, url: string, method: string): string | null {
  if (!OWN_CALL_KINDS.has(kind) || ownCalls.getStore() === kind) return null;
  const m = method.trim().toUpperCase();
  if (!READ_METHODS.has(m)) return `${m.slice(0, 10)} (only Steward's own tests and lint call this service)`;
  let segs: string[] | null;
  try {
    segs = pathSegments(new URL(url).pathname);
  } catch {
    return 'an invalid URL';
  }
  if (!segs) return 'a path that cannot be decoded';
  const hit = segs.find((x) => OWN_CALL_PATHS.has(x));
  return hit ? `/${hit} (only Steward's own tests and lint call this service)` : null;
}

/**
 * The one check of a request of a platform kind (platformRequest for the request and every redirect hop with the
 * method that hop is sent with, recorded test runs): 403 PLATFORM_METHOD_DENIED for a changing method to a read-only
 * kind, 403 PLATFORM_PATH_DENIED when the kind never calls this URL – or only Steward's own code does (deniedOwnCall).
 */
export function assertPathAllowed(kind: string, url: string, method: string, opts: { destination?: boolean } = {}): void {
  // a rule of the destination (another platform sent the request to the origin of a platform of this kind, 0.9.0)
  const whose = opts.destination ? ` (${originOfSafe(url)} belongs to a ${kind} platform – its rules apply whichever platform sends the request)` : '';
  const own = deniedOwnCall(kind, url, method);
  if (own)
    throw Object.assign(
      new HttpError(403, `This request is refused for ${kind} platforms: ${own}${whose}`, 'PLATFORM_PATH_DENIED', { kind, reason: own.slice(0, 200) }),
      { retryable: false },
    );
  const m = deniedMethod(kind, method);
  if (m)
    throw Object.assign(new HttpError(403, `Steward only reads ${kind} platforms: ${m} is refused${whose}`, 'PLATFORM_METHOD_DENIED', { kind, method: m }), {
      retryable: false,
    });
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
        ? `Steward never reads secret values: ${why} is refused for IBM Verify Privilege Vault platforms (${where})${whose}`
        : `This path is refused for ${kind} platforms: ${why} (${where})${whose}`,
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

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const URL_KEYS = new Set(['url', 'link']);

/**
 * A Confluent Cloud answer (0.14.0, #123) as Steward passes it on: no "secret" key at any depth (an API key's secret is
 * only in the answer that creates it – which this read-only kind never sends – but never passed on either way), and a
 * managed connector's configuration and status ("config" and "status" objects) with their secret-looking values
 * removed and error traces trimmed, like Kafka Connect's.
 * Everything else – pagination links included – stays as it is.
 */
function confluentAnswer<T>(body: T): T {
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 64) return null;
    if (Array.isArray(x)) return x.map((v) => walk(v, depth + 1));
    if (x && typeof x === 'object') {
      const entries: [string, unknown][] = [];
      for (const [k, v] of Object.entries(x)) {
        if (UNSAFE_KEYS.has(k) || k.toLowerCase() === 'secret') continue;
        // a connector's configuration and status (its error traces and task messages) like Kafka Connect's answers
        const connectPart = (k === 'config' || k === 'status') && v && typeof v === 'object' && !Array.isArray(v);
        entries.push([k, connectPart ? redactConnectAnswer(walk(v, depth + 1)) : walk(v, depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return x;
  };
  return walk(body, 0) as T;
}

/** The origin of a URL for a message (the text itself when it is none). */
function originOfSafe(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.slice(0, 120);
  }
}

/**
 * A copy of an answer without the kind's value keys (at most 64 levels deep; deeper parts are dropped). Kafka Connect
 * (#223): connector configurations with their secret-looking values removed and error traces trimmed
 * (redactConnectAnswer in shared/src/kafkaConnect.ts).
 */
export function stripValues<T>(kind: string, body: T): T {
  if (kind === KAFKA_CONNECT_KIND) return redactConnectAnswer(body);
  if (kind === CONFLUENT_KIND) return confluentAnswer(body);
  const keys = VALUE_KEYS[kind];
  if (!keys) return body;
  const walk = (x: unknown, depth: number): unknown => {
    if (depth > 64) return null;
    if (Array.isArray(x)) return x.map((v) => walk(v, depth + 1));
    if (x && typeof x === 'object') {
      const entries: [string, unknown][] = [];
      // keys taken from the answer: never __proto__ & co. as properties (Object.fromEntries defines them as own keys)
      for (const [k, v] of Object.entries(x)) {
        if (keys.has(k.toLowerCase()) || UNSAFE_KEYS.has(k)) continue;
        // a watch's URL without user info and secret-looking query values (0.9.0)
        if (kind === CHANGEDETECTION_KIND && typeof v === 'string' && URL_KEYS.has(k.toLowerCase())) entries.push([k, watchUrlWithoutCredentials(v)]);
        else entries.push([k, walk(v, depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return x;
  };
  return walk(body, 0) as T;
}

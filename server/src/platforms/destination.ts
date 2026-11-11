import { MQTT_KIND, dbPort, type AuthConfig, type DatabaseSettings, type PlatformConfig } from '@sm/shared';

/**
 * Where a platform's stored credentials go (security review 0.19.0 H1): the address of the base URL (templates of
 * variables filled in), the trusted origins, the addresses of the sign-in (token URL, login and refresh requests, the
 * STS endpoint), the portal of browser steps, the proxy, and the connections of kinds that do not speak HTTP to their
 * base URL – the MQTT broker (variable url), Kafka bootstrap servers, its OAuth token URL, Schema Registry and REST
 * endpoint, and the host and port of a database platform. A change of any of these is a change of destination: it
 * needs a signed-in session with a step-up (control point platform.destination), and the stored credentials are removed
 * unless an administrator confirms sending them to the new address (routes/platforms.ts).
 */
export interface PlatformDestination {
  baseUrl: string;
  trustedOrigins: string[];
  signIn: string[];
  portalUrl: string;
  proxy: string;
  connection: string[];
}

/** What a destination is computed from: the platform's kind, base URL and stored configuration. */
export interface DestinationSource {
  kind: string;
  baseUrl: string;
  config: Partial<PlatformConfig> | null | undefined;
}

/**
 * Variables of connector kinds that name where a connection (and its credentials) goes besides the base URL: Kafka and
 * Confluent Cloud (bootstrap servers, the OAuth token URL, Schema Registry, the cluster's REST endpoint) and – for MQTT
 * platforms – the broker URL. An identity cannot override them either (identities.ts fixedVariables).
 */
export const DESTINATION_VARIABLES = ['bootstrap', 'tokenUrl', 'schemaRegistryUrl', 'kafkaRestUrl'] as const;
const KIND_VARIABLES: Record<string, readonly string[]> = { [MQTT_KIND]: ['url'] };
export const destinationVariables = (kind: string): string[] => [...DESTINATION_VARIABLES, ...(KIND_VARIABLES[kind] ?? [])];

/** The URLs of a sign-in configuration that receive credentials. */
export function authUrls(a: AuthConfig | null | undefined): { field: string; url: string }[] {
  if (!a) return [];
  const out: { field: string; url: string }[] = [];
  const add = (field: string, v: unknown) => typeof v === 'string' && v.trim() && out.push({ field, url: v.trim() });
  add('tokenUrl', a.tokenUrl);
  add('request.url', a.request?.url);
  add('refresh.request.url', a.refresh?.request?.url);
  add('aws.stsEndpoint', a.aws?.stsEndpoint);
  return out;
}

/**
 * A URL template with only {{ baseUrl }} and {{ vars.x }} filled in – synchronously, so the check needs no expression
 * engine. Anything else in {{ … }} cannot be checked: null.
 */
export function fillUrl(template: string, baseUrl: string, vars: Record<string, string>): string | null {
  const filled = template.replace(/\{\{\s*(baseUrl|vars\.([A-Za-z_][A-Za-z0-9_]*))\s*\}\}/g, (_m, what: string, name?: string) =>
    what === 'baseUrl' ? baseUrl.replace(/\/+$/, '') : (vars[name!] ?? ''),
  );
  return filled.includes('{{') || filled.includes('}}') ? null : filled;
}

/** The origin of a URL (relative URLs against the base), or – when it cannot be read – the text itself, trimmed. */
function addressOf(raw: string, base: string, vars: Record<string, string>): string {
  const text = raw.trim();
  if (!text) return '';
  const filled = fillUrl(text, base, vars);
  if (filled === null) return text;
  try {
    const u = filled.startsWith('/') && !filled.startsWith('//') && base ? new URL(filled, base) : new URL(filled);
    return u.origin === 'null' ? `${u.protocol}//${u.host}`.toLowerCase() : u.origin;
  } catch {
    return filled.trim().toLowerCase();
  }
}

const sorted = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort();

/** The destination of a platform (see above). */
export function platformDestination(p: DestinationSource): PlatformDestination {
  const cfg = p.config ?? {};
  const vars: Record<string, string> = Object.fromEntries(
    Object.entries(cfg.variables && typeof cfg.variables === 'object' ? cfg.variables : {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
  );
  const base = fillUrl(p.baseUrl ?? '', '', vars) ?? p.baseUrl ?? '';
  const baseUrl = addressOf(p.baseUrl ?? '', '', vars);
  const connection: string[] = [];
  for (const name of destinationVariables(p.kind)) {
    const v = vars[name]?.trim();
    if (!v) continue;
    // host:port lists (Kafka bootstrap) are compared as a set; URLs by their origin
    if (name === 'bootstrap') for (const b of v.split(/[\s,]+/).filter(Boolean)) connection.push(`${name}=${b.toLowerCase()}`);
    else connection.push(`${name}=${addressOf(v, base, vars)}`);
  }
  const db = (cfg as { database?: Partial<DatabaseSettings> }).database;
  if (db && typeof db.host === 'string' && db.dialect)
    connection.push(`database=${db.host.trim().toLowerCase()}:${dbPort({ dialect: db.dialect, port: db.port })}`);
  return {
    baseUrl,
    trustedOrigins: sorted((cfg.http?.trustedOrigins ?? []).map((t) => (typeof t === 'string' ? addressOf(t, base, vars) : ''))),
    signIn: sorted(authUrls(cfg.auth).map((a) => addressOf(a.url, base, vars))),
    portalUrl: typeof cfg.portalUrl === 'string' ? addressOf(cfg.portalUrl, base, vars) : '',
    proxy: (typeof cfg.http?.proxy === 'string' ? cfg.http.proxy : '').trim(),
    connection: sorted(connection),
  };
}

/** The parts of the destination that differ (empty: the credentials keep going where they went). */
export function changedDestination(before: PlatformDestination, after: PlatformDestination): (keyof PlatformDestination)[] {
  return (Object.keys(after) as (keyof PlatformDestination)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}

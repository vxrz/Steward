import crypto from 'node:crypto';
import { nodePorts, outgoing, type ApiOperation, type AuthConfig, type FlowNode, type NodeOf, type Platform, type ProcessDefinition } from '@sm/shared';
import { hasTemplate, parseTemplate, stringify, stripBraces } from '../engine/expr.js';
import { endpointFor } from '../aws/client.js';
import { JS_HELPERS, parseSubset, pathText, referencedVars, stepsJs, toJs, type JsScope, type PathStep } from './jsonata-js.js';

/**
 * Postman export (#204): a platform as a Postman environment plus a collection of its API operations, a process as a
 * collection (one folder, the requests in step order) plus an environment for its connections. Collection format
 * v2.1. Pure functions of the data: nothing is evaluated or sent at export time, and no secret is read – every secret
 * (platform credentials, secret inputs, literal credentials in a definition) becomes an empty environment variable of
 * type `secret`. What does not map is written into the folder and request descriptions (docs/POSTMAN.md).
 */

export const POSTMAN_COLLECTION_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
/** The JSONata version Steward evaluates expressions with (server/package.json); a test keeps it in step. */
export const JSONATA_VERSION = '2.2.2';
const JSONATA_REQUIRE = `pm.require('npm:jsonata@${JSONATA_VERSION}')`;

// ---------------------------------------------------------------------------
// Postman types (the parts the export writes)
// ---------------------------------------------------------------------------

export interface PmVariable {
  key: string;
  value: string;
  type?: 'string' | 'boolean' | 'any' | 'number';
  description?: string;
}
export interface PmScript {
  listen: 'prerequest' | 'test';
  script: { type: 'text/javascript'; exec: string[] };
}
export interface PmAuthAttr {
  key: string;
  value: string;
  type: 'string';
}
export interface PmAuth {
  type: 'noauth' | 'basic' | 'bearer' | 'apikey' | 'awsv4';
  basic?: PmAuthAttr[];
  bearer?: PmAuthAttr[];
  apikey?: PmAuthAttr[];
  awsv4?: PmAuthAttr[];
}
export interface PmHeader {
  key: string;
  value: string;
  disabled?: boolean;
  description?: string;
}
export interface PmUrl {
  raw: string;
  protocol?: string;
  host?: string[];
  path?: string[];
  query?: { key: string; value: string; disabled?: boolean; description?: string }[];
  variable?: { key: string; value: string; description?: string }[];
}
export interface PmBody {
  mode: 'raw' | 'urlencoded';
  raw?: string;
  urlencoded?: { key: string; value: string; disabled?: boolean; description?: string }[];
  options?: { raw: { language: 'json' | 'text' } };
}
export interface PmRequest {
  method: string;
  header: PmHeader[];
  url: PmUrl;
  body?: PmBody;
  auth?: PmAuth;
  description?: string;
}
export interface PmItem {
  id?: string;
  name: string;
  request: PmRequest;
  event?: PmScript[];
  protocolProfileBehavior?: Record<string, unknown>;
}
export interface PmFolder {
  name: string;
  description?: string;
  item: (PmItem | PmFolder)[];
}
export interface PmCollection {
  info: { _postman_id: string; name: string; description?: string; schema: string };
  item: (PmItem | PmFolder)[];
  auth?: PmAuth;
  event?: PmScript[];
  variable?: PmVariable[];
}
export interface PmEnvironmentValue {
  key: string;
  value: string;
  type: 'default' | 'secret';
  enabled: boolean;
}
export interface PmEnvironment {
  id: string;
  name: string;
  values: PmEnvironmentValue[];
  _postman_variable_scope: 'environment';
  _postman_exported_at: string;
  _postman_exported_using: string;
}

export interface PostmanExport {
  collection: PmCollection;
  environment: PmEnvironment;
  /** Base of the file names: <base>.postman_collection.json, <base>.postman_environment.json */
  fileBase: string;
}

export interface ExportOptions {
  stewardVersion: string;
  /** ISO time of the export */
  exportedAt: string;
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Names of values that are credentials wherever they appear (platform variables, default headers, constants, literal
 * headers, query parameters and body fields of a definition): they are exported as empty secret variables.
 */
const SENSITIVE = /passw|passphrase|secret|token|api.?key|credential|private.?key|authori[sz]ation|cookie|session.?id|signature|access.?key|assertion/i;
export const isSensitiveName = (name: string): boolean => SENSITIVE.test(name);
/** Values that are credentials whatever their name (an Authorization value under another header name). */
const CREDENTIAL_VALUE = /^(bearer|basic|token|digest|negotiate)\s+\S/i;

/**
 * A credential written literally into a setting or a definition (not as {{ secrets.x }}): the name of the empty secret
 * variable that replaces it, or undefined for a value that is not one.
 */
function literalSecret(vars: Vars, name: string, key: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '' || value.includes('{{')) return undefined;
  return isSensitiveName(key) || CREDENTIAL_VALUE.test(value) ? vars.secret(name) : undefined;
}

/** A stable UUID (v4 layout) from a seed, so the same export gets the same ids. */
function uuidFrom(seed: string): string {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function slug(s: string): string {
  return (
    s
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'steward'
  );
}

const script = (listen: PmScript['listen'], lines: string[]): PmScript => ({ listen, script: { type: 'text/javascript', exec: lines } });
const attr = (key: string, value: string): PmAuthAttr => ({ key, value, type: 'string' });
const v = (name: string) => `{{${name}}}`;
const js = (x: unknown) => JSON.stringify(x);
const code = (s: string) => '`' + s.replace(/`/g, "'").replace(/\s+/g, ' ').trim().slice(0, 300) + '`';

/** Collects the environment's values and the collection's variables (first definition of a key wins). */
class Vars {
  readonly env = new Map<string, PmEnvironmentValue>();
  readonly coll = new Map<string, PmVariable>();
  /** Values the export could not compute: variable → what Steward computes there */
  readonly hand = new Map<string, string>();

  secret(key: string): string {
    if (!this.env.has(key)) this.env.set(key, { key, value: '', type: 'secret', enabled: true });
    return v(key);
  }
  envValue(key: string, value: string): string {
    if (!this.env.has(key)) this.env.set(key, { key, value, type: 'default', enabled: true });
    return v(key);
  }
  collection(key: string, value: string, description: string, type: PmVariable['type'] = 'string'): string {
    if (!this.coll.has(key)) this.coll.set(key, { key, value, type, description });
    return v(key);
  }
  /** A variable to fill in by hand: `what` is the Steward expression it stands for */
  byHand(key: string, what: string): string {
    if (!this.hand.has(key)) this.hand.set(key, what);
    return this.collection(key, '', `Set by hand – Steward computes ${what} here.`);
  }
  collectionList(): PmVariable[] {
    return [...this.coll.values()];
  }
  envList(): PmEnvironmentValue[] {
    return [...this.env.values()];
  }
}

/** A template with {{ expression }} parts as Postman text; `resolve` gives the Postman text of one expression. */
function translateTemplate(s: string, resolve: (expression: string) => string): string {
  if (!s.includes('{{')) return s;
  return parseTemplate(s)
    .map((seg) => (seg.kind === 'text' ? seg.text : resolve(seg.text)))
    .join('');
}

/** Ordered parts of a translated path ("{{base}}/a/b?x=1") for a Postman URL object. */
/**
 * A Postman URL object for a raw URL, split the way Postman splits it: the host is everything up to the first "/"
 * outside a {{variable}} – a base URL variable may hold a path, and so may a variable right after it.
 */
function urlOf(raw: string): PmUrl {
  const q = raw.indexOf('?');
  const beforeQuery = q < 0 ? raw : raw.slice(0, q);
  const queryText = q < 0 ? '' : raw.slice(q + 1);
  const url: PmUrl = { raw };
  const proto = /^([a-z][a-z0-9+.-]*):\/\//i.exec(beforeQuery);
  const rest = proto ? beforeQuery.slice(proto[0].length) : beforeQuery;
  let depth = 0;
  let cut = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (rest.startsWith('{{', i)) depth++;
    else if (rest.startsWith('}}', i) && depth > 0) depth--;
    else if (rest[i] === '/' && depth === 0) {
      cut = i;
      break;
    }
  }
  if (proto) url.protocol = proto[1]!.toLowerCase();
  url.host = [rest.slice(0, cut)];
  url.path = cut < rest.length ? rest.slice(cut + 1).split('/') : [];
  if (queryText) {
    url.query = queryText.split('&').map((pair) => {
      const i = pair.indexOf('=');
      return i < 0 ? { key: pair, value: '' } : { key: pair.slice(0, i), value: pair.slice(i + 1) };
    });
  }
  return url;
}

function addQuery(url: PmUrl, entries: { key: string; value: string; disabled?: boolean; description?: string }[]): PmUrl {
  if (!entries.length) return url;
  const query = [...(url.query ?? []), ...entries];
  const enabled = query.filter((q) => !q.disabled);
  const base = url.raw.split('?')[0]!;
  return { ...url, query, raw: enabled.length ? `${base}?${enabled.map((q) => `${q.key}=${q.value}`).join('&')}` : base };
}

// ---------------------------------------------------------------------------
// Platform templates (base URL, sign-in settings): scope vars, secrets, baseUrl, platform
// ---------------------------------------------------------------------------

/** The Postman text of a platform template; P is the variable prefix ("" for a platform, "slot." in a process). */
function platformTemplate(p: Platform, P: string, s: string, vars: Vars, extra: Record<string, string> = {}): string {
  let n = 0;
  return translateTemplate(s, (expression) => {
    const tree = parseSubset(stripBraces(`{{${expression}}}`));
    if (tree?.t === 'path' && !tree.variable && tree.steps.every((x) => x.index === undefined)) {
      const [root, name, ...more] = tree.steps.map((x) => x.key);
      if (Object.hasOwn(extra, root!) && name === undefined) return extra[root!]!;
      if (root === 'vars' && name && !more.length) return isSensitiveName(name) ? vars.secret(P + name) : v(P + name);
      if (root === 'secrets' && name && !more.length) return vars.secret(P + name);
      if (root === 'baseUrl' && name === undefined) return v(P + 'baseUrl');
      if (root === 'platform' && (name === 'name' || name === 'kind') && !more.length) return p[name];
    }
    return vars.byHand(`${P}expr.${++n}`, code(expression));
  });
}

/** Environment values of a platform: base URL, variables, every stored secret (empty, type secret). */
function platformEnvironment(p: Platform, P: string, vars: Vars): string {
  const base = p.baseUrl ? platformTemplate(p, P, p.baseUrl.replace(/\/+$/, ''), vars) : '';
  vars.envValue(P + 'baseUrl', base);
  for (const [k, val] of Object.entries(p.config.variables ?? {})) {
    if (isSensitiveName(k)) vars.secret(P + k);
    else vars.envValue(P + k, String(val ?? ''));
  }
  for (const k of p.secretKeys ?? []) vars.secret(P + k);
  return v(P + 'baseUrl');
}

/** Platform default headers (credentials in them as secret variables) and HTTP settings Postman has no field for. */
function platformHeaders(p: Platform, P: string, vars: Vars): PmHeader[] {
  return Object.entries(p.config.http?.defaultHeaders ?? {}).map(([key, value]) => ({
    key,
    value: literalSecret(vars, `${P}header.${key}`, key, value) ?? (isSensitiveName(key) ? vars.secret(`${P}header.${key}`) : String(value)),
  }));
}

function httpNotes(p: Platform): string[] {
  const h = p.config.http ?? {};
  const out: string[] = [];
  if (h.insecureTls) out.push('The platform accepts self-signed certificates: the requests turn off SSL certificate verification (strictSSL false).');
  if (h.caPem) out.push('The platform trusts its own CA certificate: add it under Postman Settings → Certificates → CA certificates.');
  if (h.proxy && h.proxy !== 'none')
    out.push(`Steward reaches the platform through a proxy (${h.proxy.replace(/\/\/[^@/]*@/, '//***@')}): set it under Postman Settings → Proxy.`);
  if (h.trustedOrigins?.length) out.push(`Steward also sends the credentials to ${h.trustedOrigins.join(', ')}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Sign-in → Postman auth (and a pre-request script for the token logins)
// ---------------------------------------------------------------------------

interface SignIn {
  /** undefined: the slot has no platform – the requests inherit (no auth) */
  auth?: PmAuth;
  /** Collection pre-request script lines (OAuth2 client credentials, login request) */
  prerequest: string[];
  notes: string[];
}

const SIGN_IN_LABELS: Record<AuthConfig['type'], string> = {
  none: 'no sign-in',
  basic: 'basic authentication',
  bearer: 'a bearer token',
  apiKey: 'an API key',
  oauth2_client_credentials: 'OAuth 2.0 client credentials',
  token_request: 'a login request',
  jwt: 'a key-pair JWT',
  aws_sigv4: 'AWS request signing (SigV4)',
};

/** The header a token login adds: Postman's bearer auth for `Authorization: Bearer <token>`, otherwise an API-key header. */
function tokenAuth(p: Platform, P: string, auth: AuthConfig, tokenVar: string, vars: Vars): PmAuth {
  const name = auth.headerName || 'Authorization';
  const value = platformTemplate(p, P, auth.headerValue || 'Bearer {{ token }}', vars, { token: v(tokenVar) });
  if (name.toLowerCase() === 'authorization' && value === `Bearer ${v(tokenVar)}`) return { type: 'bearer', bearer: [attr('token', v(tokenVar))] };
  return { type: 'apikey', apikey: [attr('key', name), attr('value', value), attr('in', 'header')] };
}

/**
 * A JavaScript expression that builds a template value in the script (strings resolved with pm.variables.replaceIn);
 * `secret` names the secret variable of a literal credential under a key.
 */
function scriptValue(x: unknown, tr: (s: string) => string, secret: (key: string, value: unknown) => string | undefined, key = ''): string {
  const lit = secret(key, x);
  if (lit) return `pm.variables.replaceIn(${js(lit)})`;
  if (typeof x === 'string') return `pm.variables.replaceIn(${js(tr(x))})`;
  if (Array.isArray(x)) return `[${x.map((e) => scriptValue(e, tr, secret, key)).join(', ')}]`;
  if (x && typeof x === 'object')
    return `{ ${Object.entries(x)
      .map(([k, e]) => `${js(k)}: ${scriptValue(e, tr, secret, k)}`)
      .join(', ')} }`;
  return js(x ?? null);
}

const PM_TOKEN_CACHE = [
  '  const cached = pm.collectionVariables.get(P + "accessToken");',
  '  const until = Number(pm.collectionVariables.get(P + "accessTokenExpiresAt") || 0);',
  '  if (cached && until > Date.now() + 30000) return;',
  '  const save = (token, expiresIn) => {',
  "    if (!token || typeof token !== 'string') { console.error('Steward: the sign-in answer has no token'); return; }",
  '    const seconds = Number(expiresIn) > 0 ? Number(expiresIn) : 1800;',
  '    pm.collectionVariables.set(P + "accessToken", token);',
  '    pm.collectionVariables.set(P + "accessTokenExpiresAt", String(Date.now() + seconds * 1000));',
  '  };',
];

function signIn(p: Platform | undefined, P: string, vars: Vars): SignIn {
  if (!p) return { prerequest: [], notes: [] };
  const auth: AuthConfig = p.config.auth ?? { type: 'none' };
  const notes: string[] = [];
  const label = `${p.name}: ${SIGN_IN_LABELS[auth.type] ?? auth.type}`;
  const tokenVars = () => {
    vars.collection(P + 'accessToken', '', `Access token of ${p.name}, fetched by the collection's pre-request script (not exported).`);
    vars.collection(P + 'accessTokenExpiresAt', '', `When the access token of ${p.name} expires (milliseconds since 1970).`);
    return P + 'accessToken';
  };
  switch (auth.type) {
    case 'none':
      return { auth: { type: 'noauth' }, prerequest: [], notes };
    case 'basic': {
      const [u, pw] = p.kind === 'kafka' ? ['registryKey', 'registrySecret'] : ['username', 'password'];
      return { auth: { type: 'basic', basic: [attr('username', vars.secret(P + u)), attr('password', vars.secret(P + pw))] }, prerequest: [], notes };
    }
    case 'bearer': {
      const name = auth.headerName || (p.kind === 'gitlab' ? 'PRIVATE-TOKEN' : 'Authorization');
      const token = vars.secret(P + 'token');
      return {
        auth:
          name.toLowerCase() === 'authorization'
            ? { type: 'bearer', bearer: [attr('token', token)] }
            : { type: 'apikey', apikey: [attr('key', name), attr('value', token), attr('in', 'header')] },
        prerequest: [],
        notes,
      };
    }
    case 'apiKey': {
      const inQuery = auth.apiKeyIn === 'query';
      const key = auth.apiKeyName || (inQuery ? 'api_key' : 'x-api-key');
      return {
        auth: { type: 'apikey', apikey: [attr('key', key), attr('value', vars.secret(P + 'apiKey')), attr('in', inQuery ? 'query' : 'header')] },
        prerequest: [],
        notes,
      };
    }
    case 'aws_sigv4': {
      const aws = auth.aws;
      if (aws?.roleArn)
        notes.push(
          `${p.name}: Steward assumes the role ${aws.roleArn} before it signs. Postman signs with the keys you enter – enter the temporary credentials of that role (access key, secret key and session token).`,
        );
      return {
        auth: {
          type: 'awsv4',
          awsv4: [
            attr('accessKey', vars.secret(P + 'accessKeyId')),
            attr('secretKey', vars.secret(P + 'secretAccessKey')),
            attr('sessionToken', vars.secret(P + 'sessionToken')),
            attr('region', vars.envValue(P + 'awsRegion', aws?.region ?? '')),
            attr('service', vars.envValue(P + 'awsService', aws?.service ?? '')),
          ],
        },
        prerequest: [],
        notes,
      };
    }
    case 'jwt': {
      const token = P + 'accessToken';
      vars.secret(token);
      notes.push(
        `${p.name} signs in with a key-pair JWT (signed with the private key${auth.jwt?.mode === 'exchange' ? ' and exchanged for an access token' : ''}). The Postman sandbox cannot sign it: create a token yourself (for Snowflake, e.g. \`snowsql --private-key-path rsa_key.p8 --generate-jwt -a <account> -u <user>\`) and paste it into the environment variable ${v(token)}.`,
      );
      return { auth: tokenAuth(p, P, auth, token, vars), prerequest: [], notes };
    }
    case 'oauth2_client_credentials': {
      const token = tokenVars();
      const id = vars.secret(P + 'clientId');
      const secret = vars.secret(P + 'clientSecret');
      const tr = (s: string) => platformTemplate(p, P, s, vars);
      const lines = [
        `// Steward sign-in of ${p.name}: OAuth 2.0 client credentials. Fetches an access token when there is none or it`,
        `// expires within 30 seconds, and keeps it in the collection variables ${token} and ${token}ExpiresAt.`,
        '(function () {',
        `  const P = ${js(P)};`,
        ...PM_TOKEN_CACHE,
        `  const clientId = pm.variables.get(${js(id.slice(2, -2))});`,
        `  const clientSecret = pm.variables.get(${js(secret.slice(2, -2))});`,
        `  if (!clientId || !clientSecret) { console.warn('Steward: enter ' + P + 'clientId and ' + P + 'clientSecret in the environment to sign in'); return; }`,
        "  const form = [{ key: 'grant_type', value: 'client_credentials' }];",
        ...(auth.scope ? [`  form.push({ key: 'scope', value: ${js(auth.scope)} });`] : []),
        ...Object.entries(auth.extraParams ?? {}).map(
          ([k, val]) => `  form.push({ key: ${js(k)}, value: pm.variables.replaceIn(${js(literalSecret(vars, `${P}login.${k}`, k, val) ?? tr(val))}) });`,
        ),
        '  const header = [];',
        (auth.clientAuth ?? 'basic') === 'basic'
          ? "  header.push({ key: 'Authorization', value: 'Basic ' + btoa(clientId + ':' + clientSecret) });"
          : "  form.push({ key: 'client_id', value: clientId }, { key: 'client_secret', value: clientSecret });",
        `  pm.sendRequest({ url: pm.variables.replaceIn(${js(tr(auth.tokenUrl ?? ''))}), method: 'POST', header, body: { mode: 'urlencoded', urlencoded: form } }, function (err, res) {`,
        "    if (err) { console.error('Steward: the token request failed', err); return; }",
        '    let body;',
        '    try { body = res.json(); } catch (e) { body = undefined; }',
        "    if (res.code >= 300 || !body) { console.error('Steward: the token request answered HTTP ' + res.code); return; }",
        '    save(body.access_token, body.expires_in);',
        '  });',
        '})();',
      ];
      return { auth: tokenAuth(p, P, auth, token, vars), prerequest: lines, notes };
    }
    case 'token_request': {
      const token = tokenVars();
      const rq = auth.request ?? { method: 'POST' as const, url: '' };
      const tr = (s: string) => platformTemplate(p, P, s, vars);
      const secret = (key: string, value: unknown) => literalSecret(vars, `${P}login.${key}`, key, value);
      const rawUrl = tr(rq.url ?? '');
      const url = /^https?:/i.test(rawUrl) ? rawUrl : v(P + 'baseUrl') + rawUrl;
      const headers = Object.entries(rq.headers ?? {});
      const bodyType = rq.bodyType ?? 'json';
      const hasContentType = headers.some(([k]) => k.toLowerCase() === 'content-type');
      const bodyLines =
        rq.body === undefined
          ? []
          : bodyType === 'form'
            ? [
                `  const fields = ${scriptValue(rq.body, tr, secret)};`,
                "  request.body = { mode: 'urlencoded', urlencoded: Object.keys(fields).map((k) => ({ key: k, value: String(fields[k]) })) };",
              ]
            : [
                `  request.body = { mode: 'raw', raw: JSON.stringify(${scriptValue(rq.body, tr, secret)}), options: { raw: { language: 'json' } } };`,
                ...(hasContentType ? [] : ["  request.header.push({ key: 'Content-Type', value: 'application/json' });"]),
              ];
      const pick = tokenPick(auth.tokenPath || 'access_token', auth.expiresInPath);
      const lines = [
        `// Steward sign-in of ${p.name}: a login request. Sends it when there is no token or it expires within 30 seconds,`,
        `// and keeps the token in the collection variables ${token} and ${token}ExpiresAt.`,
        '(function () {',
        `  const P = ${js(P)};`,
        ...PM_TOKEN_CACHE,
        `  const request = { url: pm.variables.replaceIn(${js(url)}), method: ${js(rq.method ?? 'POST')}, header: [${headers
          .map(([k, val]) => `{ key: ${js(k)}, value: pm.variables.replaceIn(${js(secret(k, val) ?? tr(val))}) }`)
          .join(', ')}] };`,
        ...bodyLines,
        '  pm.sendRequest(request, function (err, res) {',
        "    if (err) { console.error('Steward: the login request failed', err); return; }",
        "    if (res.code < 200 || res.code >= 300) { console.error('Steward: the login request answered HTTP ' + res.code); return; }",
        '    let body;',
        '    try { body = res.json(); } catch (e) { body = res.text(); }',
        '    const headers = {};',
        '    res.headers.each((h) => { headers[String(h.key).toLowerCase()] = h.value; });',
        ...pick.lines.map((l) => '    ' + l),
        '  });',
        '})();',
      ];
      if (pick.fallback)
        notes.push(
          `${p.name}: the token is read from the login answer with JSONata (${code(auth.tokenPath ?? '')}) – this needs the Postman app or the Postman CLI, not Newman.`,
        );
      return { auth: tokenAuth(p, P, auth, token, vars), prerequest: lines, notes };
    }
    default:
      notes.push(`${label}: not exported – sign in by hand.`);
      return { prerequest: [], notes };
  }
}

/** Lines that read the token (and its lifetime) from a login answer: plain JavaScript for a path, else JSONata. */
function tokenPick(tokenPath: string, expiresInPath?: string): { lines: string[]; fallback: boolean } {
  const scope: JsScope = {
    path: (steps, variable) => (variable === 'headers' ? `$p(headers, ${stepsJs(steps)})` : variable ? null : `$p(body, ${stepsJs(steps)})`),
  };
  const tree = parseSubset(stripBraces(tokenPath));
  const tokenJs = tree ? toJs(tree, scope) : null;
  const expTree = expiresInPath ? parseSubset(stripBraces(expiresInPath)) : null;
  const expJs = expiresInPath ? (expTree ? toJs(expTree, scope) : null) : 'undefined';
  if (tokenJs !== null && expJs !== null) return { lines: [...JS_HELPERS, `save(${tokenJs}, ${expJs});`], fallback: false };
  return {
    lines: [
      `// the token path is JSONata: evaluated with the jsonata package (Postman app and Postman CLI; not Newman)`,
      `const jsonata = ${JSONATA_REQUIRE};`,
      `Promise.all([jsonata(${js(stripBraces(tokenPath))}).evaluate(body, { headers }), ${expiresInPath ? `jsonata(${js(stripBraces(expiresInPath))}).evaluate(body, { headers })` : 'undefined'}])`,
      '  .then(([token, expiresIn]) => save(token, expiresIn))',
      "  .catch((e) => console.error('Steward: reading the token failed', e));",
    ],
    fallback: true,
  };
}

// ---------------------------------------------------------------------------
// Platform → environment + collection of its API operations
// ---------------------------------------------------------------------------

function operationItem(op: ApiOperation, base: string, headers: PmHeader[], strictSsl: boolean): PmItem {
  const path = op.path.replace(/\{([^}/]+)\}/g, ':$1');
  let url = urlOf(base + (path.startsWith('/') ? '' : '/') + path);
  const params = op.parameters ?? [];
  const value = (s?: { default?: unknown; enum?: unknown[] }) =>
    s?.default !== undefined ? stringify(s.default) : s?.enum?.length ? stringify(s.enum[0]) : '';
  const pathVars = params.filter((x) => x.in === 'path');
  if (pathVars.length) url.variable = pathVars.map((x) => ({ key: x.name, value: value(x.schema), ...(x.description ? { description: x.description } : {}) }));
  url = addQuery(
    url,
    params
      .filter((x) => x.in === 'query')
      .map((x) => ({
        key: x.name,
        value: value(x.schema),
        ...(x.required ? {} : { disabled: true }),
        ...(x.description ? { description: x.description } : {}),
      })),
  );
  const header: PmHeader[] = [
    ...headers,
    ...params
      .filter((x) => x.in === 'header')
      .map((x) => ({
        key: x.name,
        value: isSensitiveName(x.name) ? '' : value(x.schema),
        ...(x.required ? {} : { disabled: true }),
        ...(x.description ? { description: x.description } : {}),
      })),
  ];
  let body: PmBody | undefined;
  if (op.hasBody) {
    const ct = op.requestContentType ?? 'application/json';
    if (/x-www-form-urlencoded/i.test(ct) && op.requestBodyExample && typeof op.requestBodyExample === 'object') {
      body = {
        mode: 'urlencoded',
        urlencoded: Object.entries(op.requestBodyExample as Record<string, unknown>).map(([key, val]) => ({ key, value: stringify(val) })),
      };
    } else if (/json/i.test(ct)) {
      body = { mode: 'raw', raw: JSON.stringify(op.requestBodyExample ?? {}, null, 2), options: { raw: { language: 'json' } } };
    } else body = { mode: 'raw', raw: typeof op.requestBodyExample === 'string' ? op.requestBodyExample : '', options: { raw: { language: 'text' } } };
    if (!header.some((h) => h.key.toLowerCase() === 'content-type')) header.push({ key: 'Content-Type', value: ct });
  }
  const description = [op.description ?? '', op.operationId ? `Operation \`${op.operationId}\`.` : ''].filter(Boolean).join('\n\n');
  const ok = op.successStatus?.length ? op.successStatus : null;
  return {
    name: op.summary || op.operationId || `${op.method.toUpperCase()} ${op.path}`,
    request: { method: op.method.toUpperCase(), header, url, ...(body ? { body } : {}), ...(description ? { description } : {}) },
    ...(ok
      ? {
          event: [
            script('test', [
              `pm.test(${js(`HTTP status is ${ok.join(' or ')} (documented as success)`)}, function () {`,
              `  pm.expect(pm.response.code).to.be.oneOf(${js(ok)});`,
              '});',
            ]),
          ],
        }
      : {}),
    ...(strictSsl ? {} : { protocolProfileBehavior: { strictSSL: false } }),
  };
}

/** A platform as a Postman environment and a collection of the operations of its API descriptions (OpenAPI). */
export function platformToPostman(p: Platform, operations: ApiOperation[], opts: ExportOptions): PostmanExport {
  const vars = new Vars();
  const base = platformEnvironment(p, '', vars);
  const sign = signIn(p, '', vars);
  const headers = platformHeaders(p, '', vars);
  const strict = !p.config.http?.insecureTls;
  const folders = new Map<string, PmItem[]>();
  for (const op of operations) {
    const tag = op.tag || 'Operations';
    if (!folders.has(tag)) folders.set(tag, []);
    folders.get(tag)!.push(operationItem(op, base, headers, strict));
  }
  const item: (PmItem | PmFolder)[] = [];
  if (p.config.testPath) {
    item.push({
      name: 'Connection test',
      request: {
        method: 'GET',
        header: headers,
        url: urlOf(base + (p.config.testPath.startsWith('/') ? '' : '/') + platformTemplate(p, '', p.config.testPath, vars)),
        description: 'The request of Steward\'s "Test connection".',
      },
      ...(strict ? {} : { protocolProfileBehavior: { strictSSL: false } }),
    });
  }
  for (const [name, list] of folders) item.push({ name, item: list });
  const notes = [...sign.notes, ...httpNotes(p), ...handNotes(vars)];
  const description = [
    p.description.trim(),
    `Exported from Steward ${opts.stewardVersion} on ${opts.exportedAt.slice(0, 10)}: platform "${p.name}" (${p.kind}), sign-in ${SIGN_IN_LABELS[p.config.auth?.type ?? 'none'] ?? p.config.auth?.type}. Import it together with the environment "${p.name} (Steward)" and enter the secrets there – the export contains none.`,
    operations.length
      ? `${operations.length} operation(s) from the platform's API descriptions.`
      : 'The platform has no API description (OpenAPI): the collection has no operations.',
    notes.length ? `### Notes\n${notes.map((x) => `- ${x}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  return {
    collection: {
      info: { _postman_id: uuidFrom(`platform:${p.id}`), name: `${p.name} (Steward)`, description, schema: POSTMAN_COLLECTION_SCHEMA },
      item,
      ...(sign.auth ? { auth: sign.auth } : {}),
      ...(sign.prerequest.length ? { event: [script('prerequest', sign.prerequest)] } : {}),
      variable: vars.collectionList(),
    },
    environment: environment(`platform-env:${p.id}`, `${p.name} (Steward)`, vars, opts),
    fileBase: slug(p.name),
  };
}

function environment(seed: string, name: string, vars: Vars, opts: ExportOptions): PmEnvironment {
  return {
    id: uuidFrom(seed),
    name,
    values: vars.envList(),
    _postman_variable_scope: 'environment',
    _postman_exported_at: opts.exportedAt,
    _postman_exported_using: `Steward/${opts.stewardVersion}`,
  };
}

function handNotes(vars: Vars): string[] {
  return [...vars.hand].map(([key, what]) => `Set ${v(key)} by hand – Steward computes ${what} there.`);
}

// ---------------------------------------------------------------------------
// Process → collection (one folder, requests in step order) + environment of its connections
// ---------------------------------------------------------------------------

interface Placed {
  node: FlowNode;
  /** Conditions under which Steward runs it (loop, branch, error path) */
  context: string[];
}

/**
 * The nodes in the order a run reaches them: a topological order from the start node (depth first, the first port
 * of a node – "true", "each", "out", "approved" – before the others), with the branch and loop each node is in.
 */
export function stepOrder(def: ProcessDefinition): { placed: Placed[]; unreachable: FlowNode[]; notes: FlowNode[] } {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const start = def.nodes.find((n) => n.type === 'start');
  const children = (n: FlowNode) =>
    nodePorts(n as never)
      .map((p) => p.id)
      .flatMap((port) => outgoing(byId, def.wires, n.id, port));
  const post: FlowNode[] = [];
  const seen = new Set<string>();
  const visit = (n: FlowNode) => {
    seen.add(n.id);
    // reverse post-order: visiting the preferred child last puts it first
    for (const c of [...children(n)].reverse()) if (!seen.has(c.id)) visit(c);
    post.push(n);
  };
  if (start) visit(start);
  const order = post.reverse();
  const label = (n: FlowNode) => `"${n.name || n.id}"`;
  const loopNote = (f: NodeOf<'forEach'>) =>
    `In the loop ${label(f)}: Steward runs this once per item of ${code(f.items)}; here it runs once – set ${v(`vars.${f.as}`)} by hand.`;
  const edge = (from: FlowNode, port: string): string | null => {
    if (from.type === 'if') return `${port === 'true' ? 'Only when' : 'Only when this is false:'} ${code(from.condition)} (${label(from)}).`;
    if (from.type === 'forEach' && port === 'each') return loopNote(from);
    if (port === 'error') return `Only when ${label(from)} failed.`;
    if (from.type === 'userTask' && (port === 'approved' || port === 'rejected')) return `Only after ${label(from)} was ${port}.`;
    return null;
  };
  const ctx = new Map<string, Set<string>>();
  for (const n of order) {
    const mine = new Set<string>();
    for (const w of def.wires.filter((x) => x.to === n.id)) {
      const from = byId.get(w.from);
      if (!from || !ctx.has(from.id)) continue;
      for (const c of ctx.get(from.id)!) mine.add(c);
      const e = edge(from, w.port);
      if (e) mine.add(e);
    }
    // reached on both paths of a condition: it runs either way
    for (const c of [...mine]) {
      if (!c.startsWith('Only when ') || c.startsWith('Only when this is false:')) continue;
      const other = c.replace(/^Only when /, 'Only when this is false: ');
      if (mine.has(other)) {
        mine.delete(c);
        mine.delete(other);
      }
    }
    ctx.set(n.id, mine);
  }
  return {
    placed: order.filter((n) => n.type !== 'start').map((node) => ({ node, context: [...ctx.get(node.id)!] })),
    unreachable: def.nodes.filter((n) => !seen.has(n.id) && n.type !== 'note' && n.type !== 'start'),
    notes: def.nodes.filter((n) => n.type === 'note'),
  };
}

interface HttpProducer {
  kind: 'http';
  /** vars.<name> */
  name: string;
  item: PmItem;
  label: string;
  /** Paths later templates read: stored as text (vars.<name>.<path>) */
  raw: Map<string, PathStep[]>;
  /** Paths later checks read: stored as JSON (steward.vars.<name>.<path>) */
  json: Map<string, PathStep[]>;
  /** A later JSONata check reads the whole answer (steward.vars.<name>) */
  whole: boolean;
}
/** What wrote vars.<name> last before a step */
type Producer = HttpProducer | { kind: 'set'; value: unknown; template?: string } | { kind: 'other'; what: string };

const PM_HELPERS = [
  'function $r(name, as) {',
  '  let v = pm.variables.get(name);',
  '  if (v === undefined || v === null) return undefined;',
  "  if (typeof v === 'string') { v = pm.variables.replaceIn(v); if (as === 'json') { try { return JSON.parse(v); } catch (e) { return v; } } }",
  '  return v;',
  '}',
  "function $j(name) { const v = pm.collectionVariables.get(name); return v === undefined || v === '' ? undefined : JSON.parse(v); }",
  "function $pv(name, fallback) { const v = $r(name, 'string'); return v === undefined || v === '' ? fallback : v; }",
  "function $ms(t) { if (t === undefined || t === null || t === '') return undefined; if (typeof t === 'number') return t < 1e12 ? t * 1000 : t; const n = Date.parse(String(t)); return Number.isNaN(n) ? undefined : n; }",
];
const PM_OUT = [
  '// the answer as Steward keeps it (vars.<name> of the step)',
  'const $out = (function () {',
  '  let body;',
  '  try { body = pm.response.json(); } catch (e) { body = pm.response.text(); }',
  '  const headers = {};',
  '  pm.response.headers.each((h) => { headers[String(h.key).toLowerCase()] = h.value; });',
  '  return { status: pm.response.code, ok: pm.response.code >= 200 && pm.response.code < 300, headers, body, durationMs: pm.response.responseTime };',
  '})();',
  "function $w(name, v) { pm.collectionVariables.set(name, v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v)); }",
  "function $wj(name, v) { pm.collectionVariables.set(name, v === undefined ? '' : JSON.stringify(v)); }",
];
/** Steward's functions that read Steward's own data – a Postman script cannot provide them. */
const STEWARD_ONLY = /\$(systems|trend|daysUntil)\s*\(/;

const INPUT_STRING_TYPES = new Set(['string', 'select', 'secret', 'application']);
const VAR_TYPES: Record<string, PmVariable['type']> = { number: 'number', boolean: 'boolean' };

/** The literal value at a path of a definition's data (a set step's value, a constant) – data only, nothing evaluated. */
function navigate(value: unknown, steps: PathStep[]): unknown {
  let cur: unknown = value;
  for (const s of steps) {
    cur = Array.isArray(cur)
      ? cur.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>)[s.key] : undefined)).filter((x) => x !== undefined)
      : cur && typeof cur === 'object'
        ? (cur as Record<string, unknown>)[s.key]
        : undefined;
    if (s.index !== undefined && cur !== undefined) {
      const a = Array.isArray(cur) ? cur : [cur];
      cur = a[s.index < 0 ? a.length + s.index : s.index];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** What a step that has no Postman request does in Steward (the folder description lists it). */
function leftOut(n: FlowNode): string {
  const name = `"${n.name || n.id}"`;
  switch (n.type) {
    case 'userTask': {
      const who = n.assignees?.length ? ` by ${n.assignees.join(', ')}` : '';
      if (n.mode === 'approve') return `${name}: an approval${who}${n.fourEyes ? ' (four-eyes: not by the person who started the run)' : ''}.`;
      if (n.mode === 'select') return `${name}: a person selects items${who}.`;
      return `${name}: a manual step${who}${n.checklist?.length ? ` with a checklist of ${n.checklist.length}` : ''}${n.verification?.required ? ', verified by a second person (four-eyes)' : ''}.`;
    }
    case 'browser':
      return `${name}: browser automation (${n.actions.length} action(s)).`;
    case 'publish':
      return `${name}: publishes the dataset ${code(n.dataset)} for dashboards.`;
    case 'accessChange':
      return `${name}: records an access change (${n.kind}) for compliance.`;
    case 'subprocess':
      return `${name}: runs the sub-process ${code(n.process)} – export that process separately.`;
    case 'wait':
      return `${name}: waits ${n.seconds} s.`;
    case 'report':
      return `${name}: adds a section to the run report.`;
    case 'log':
      return `${name}: writes a log entry.`;
    case 'fail':
      return `${name}: stops the run with an error (${code(n.message)}).`;
    case 'forEach':
      return `${name}: a loop over ${code(n.items)} – the requests in it are exported once.`;
    case 'if':
      return `${name}: a branch on ${code(n.condition)} – the requests of both branches are exported.`;
    default:
      return `${name}: a ${n.type} step.`;
  }
}

export interface ProcessSource {
  id: string;
  name: string;
  version: number;
  definition: ProcessDefinition;
}

/** A connection slot of the process with the platform it is exported for (none: fill in by hand). */
export interface SlotBinding {
  platform?: Platform;
  /** How the platform was chosen, for the description */
  how?: string;
}

class NotTranslatable extends Error {}

interface Entry {
  item: PmItem;
  producer?: HttpProducer;
  /** The status test of the request */
  status: string[];
  /** The checks that follow it */
  checks: string[];
}

class ProcessExport {
  private readonly vars = new Vars();
  private readonly slots = new Map<string, { platform?: Platform; base: string; sign: SignIn; headers: PmHeader[] }>();
  private readonly inputs: Map<string, ProcessDefinition['inputs'][number]>;
  private readonly consts: Record<string, unknown>;
  private readonly producers = new Map<string, Producer>();
  private readonly entries: Entry[] = [];
  private current: Entry | null = null;
  /** Checks before the first request: they go into its pre-request script */
  private hostless: string[] = [];
  private readonly connections: string[] = [];
  private readonly left: string[] = [];
  private readonly jsonataChecks: string[] = [];
  private readonly unchecked: string[] = [];
  private readonly prerequest: string[] = [];

  constructor(
    private readonly proc: ProcessSource,
    bindings: Record<string, SlotBinding>,
    private readonly opts: ExportOptions,
  ) {
    const def = proc.definition;
    for (const c of def.connections) {
      const b = bindings[c.slot] ?? {};
      const P = `${c.slot}.`;
      if (b.platform) {
        const base = platformEnvironment(b.platform, P, this.vars);
        const sign = signIn(b.platform, P, this.vars);
        this.prerequest.push(...sign.prerequest);
        this.connections.push(
          `${code(c.slot)}: platform "${b.platform.name}" (${b.platform.kind})${b.how ? `, ${b.how}` : ''}; sign-in ${SIGN_IN_LABELS[b.platform.config.auth?.type ?? 'none']}.`,
          ...sign.notes,
          ...httpNotes(b.platform),
        );
        this.slots.set(c.slot, { platform: b.platform, base, sign, headers: platformHeaders(b.platform, P, this.vars) });
      } else {
        this.connections.push(
          `${code(c.slot)}${c.kind ? ` (${c.kind})` : ''}: exported without a platform${b.how ? ` (${b.how})` : ''} – enter ${v(P + 'baseUrl')} in the environment and the sign-in on the requests by hand.`,
        );
        this.slots.set(c.slot, { base: this.vars.envValue(P + 'baseUrl', ''), sign: { prerequest: [], notes: [] }, headers: [] });
      }
    }
    this.inputs = new Map(def.inputs.map((i) => [i.name, i]));
    for (const i of def.inputs) {
      const key = `inputs.${i.name}`;
      if (i.type === 'secret' || isSensitiveName(i.name)) {
        this.vars.secret(key);
        continue;
      }
      const d = i.default;
      const value =
        d === undefined || d === null
          ? ''
          : i.type === 'list' && typeof d === 'string'
            ? JSON.stringify(
                d
                  .split('\n')
                  .map((x) => x.trim())
                  .filter(Boolean),
              )
            : INPUT_STRING_TYPES.has(i.type)
              ? stringify(d)
              : JSON.stringify(d);
      this.vars.collection(
        key,
        value,
        `Input ${i.label ? `"${i.label}"` : i.name} (${i.type})${i.description ? ` – ${i.description}` : ''}.`,
        VAR_TYPES[i.type] ?? 'string',
      );
    }
    this.consts = def.constants ?? {};
  }

  private inputAs(name: string): 'string' | 'json' {
    return INPUT_STRING_TYPES.has(this.inputs.get(name)?.type ?? 'json') ? 'string' : 'json';
  }

  // ----- expressions in templates → Postman variables -----

  /** The Postman text of one {{ expression }} of a step; `strict`: throw instead of a variable set by hand. */
  private resolver(stepId: string, strict = false): (expression: string) => string {
    let n = 0;
    const hand = (expression: string) => {
      if (strict) throw new NotTranslatable(expression);
      return this.vars.byHand(`expr.${stepId}.${++n}`, code(expression));
    };
    return (expression) => {
      const tree = parseSubset(expression);
      if (tree?.t === 'path') return this.templatePath(tree.steps, tree.variable, expression, hand, strict);
      if (tree?.t === 'call') {
        const lits = tree.args.map((a) => (a.t === 'lit' && typeof a.v === 'string' ? a.v : undefined));
        if (tree.fn === 'secret' && tree.args.length === 2 && lits[0] && lits[1]) return this.vars.secret(`${lits[0]}.${lits[1]}`);
        if (tree.fn === 'pvar' && (tree.args.length === 2 || tree.args.length === 3) && lits[0] && lits[1] && (!tree.args[2] || tree.args[2].t === 'lit'))
          return this.pvar(lits[0], lits[1], tree.args[2]?.t === 'lit' ? stringify(tree.args[2].v) : '');
      }
      return hand(expression);
    };
  }

  private pvar(slot: string, name: string, fallback: string): string {
    const key = `${slot}.${name}`;
    if (isSensitiveName(name)) return this.vars.secret(key);
    const set = this.slots.get(slot)?.platform?.config.variables?.[name];
    const value = set === undefined || set === '' ? fallback : String(set);
    const existing = this.vars.env.get(key);
    if (existing) {
      if (existing.type === 'default' && existing.value === '') existing.value = value;
      return v(key);
    }
    return this.vars.envValue(key, value);
  }

  private templatePath(steps: PathStep[], variable: string | undefined, expression: string, hand: (e: string) => string, strict: boolean): string {
    if (variable && !['inputs', 'vars', 'const'].includes(variable)) return hand(expression);
    const root = variable ?? steps[0]!.key;
    const rest = variable ? steps : steps.slice(1);
    const first = rest[0];
    if (!first || (steps[0]!.index !== undefined && !variable)) return hand(expression);
    if (root === 'inputs' && rest.length === 1 && first.index === undefined && this.inputs.has(first.key)) return v(`inputs.${first.key}`);
    if (root === 'const') {
      if (isSensitiveName(first.key)) return rest.length === 1 && first.index === undefined ? this.vars.secret(`const.${first.key}`) : hand(expression);
      const key = `const.${pathText(rest)}`;
      return this.vars.collection(key, stringify(navigate(this.consts, rest)), `Constant of the process (${code(key)}).`);
    }
    if (root === 'conn') {
      const s = this.slots.get(first.key);
      const [a, b] = rest.slice(1);
      if (s && first.index === undefined && a?.index === undefined) {
        if (a?.key === 'baseUrl' && rest.length === 2) return v(`${first.key}.baseUrl`);
        if (a?.key === 'vars' && b && b.index === undefined && rest.length === 3) return v(`${first.key}.${b.key}`);
        if (s.platform && (a?.key === 'name' || a?.key === 'kind') && rest.length === 2) return s.platform[a.key];
      }
      return hand(expression);
    }
    if (root === 'vars' && first.index === undefined) {
      const more = rest.slice(1);
      const key = `vars.${pathText(rest)}`;
      const prod = this.producers.get(first.key);
      if (prod?.kind === 'http') {
        prod.raw.set(pathText(more), more);
        return this.vars.collection(key, '', `Set by the test script of "${prod.label}".`);
      }
      if (prod?.kind === 'set' && !hasTemplate(prod.value))
        return this.vars.collection(key, stringify(navigate(prod.value, more)), `Value set by the process (${code(`vars.${first.key}`)}).`);
      if (prod?.kind === 'set' && prod.template !== undefined && !more.length)
        return this.vars.collection(key, prod.template, `Value set by the process (${code(`vars.${first.key}`)}).`);
      if (strict) throw new NotTranslatable(expression);
      return this.vars.byHand(key, prod?.kind === 'other' ? prod.what : code(expression));
    }
    return hand(expression);
  }

  private template(stepId: string): (s: string) => string {
    const r = this.resolver(stepId);
    return (s) => translateTemplate(s, r);
  }

  // ----- expressions in checks → JavaScript -----

  private jsScope(host: PmItem | null): JsScope {
    const scope: JsScope = {
      path: (steps, variable) => {
        if (variable && !['inputs', 'vars', 'const'].includes(variable)) return null;
        const root = variable ?? steps[0]!.key;
        const rest = variable ? steps : steps.slice(1);
        const first = rest[0];
        if (!first || (!variable && steps[0]!.index !== undefined)) return null;
        const more = rest.slice(1);
        if (root === 'inputs') {
          if (first.index !== undefined || !this.inputs.has(first.key)) return null;
          return `$p($r(${js(`inputs.${first.key}`)}, ${js(this.inputAs(first.key))}), ${stepsJs(more)})`;
        }
        if (root === 'const') {
          if (!isSensitiveName(first.key)) return `$p(${js(this.consts)}, ${stepsJs(rest)})`;
          if (first.index !== undefined) return null;
          this.vars.secret(`const.${first.key}`);
          return `$p($r(${js(`const.${first.key}`)}, 'json'), ${stepsJs(more)})`;
        }
        if (root === 'conn') {
          const s = this.slots.get(first.key);
          const [a, b] = more;
          if (!s || first.index !== undefined || !a || a.index !== undefined) return null;
          if (a.key === 'baseUrl' && more.length === 1) return `$r(${js(`${first.key}.baseUrl`)}, 'string')`;
          if (a.key === 'vars' && b && b.index === undefined) return `$p($r(${js(`${first.key}.${b.key}`)}, 'string'), ${stepsJs(more.slice(2))})`;
          if (s.platform && (a.key === 'name' || a.key === 'kind') && more.length === 1) return js(s.platform[a.key]);
          return null;
        }
        if (root === 'vars') {
          if (first.index !== undefined) return null;
          return this.producers.get(first.key)?.kind === 'http'
            ? this.varJs(first.key, host, more)
            : `$p(${this.varJs(first.key, host, more)}, ${stepsJs(more)})`;
        }
        return null;
      },
      call: (fn, args) => {
        const lits = args.map((a) => (a.t === 'lit' && typeof a.v === 'string' ? a.v : undefined));
        if (fn === 'secret' && args.length === 2 && lits[0] && lits[1]) {
          this.vars.secret(`${lits[0]}.${lits[1]}`);
          return `$r(${js(`${lits[0]}.${lits[1]}`)}, 'string')`;
        }
        if (fn === 'pvar' && (args.length === 2 || args.length === 3) && lits[0] && lits[1]) {
          const fb = args[2] ? toJs(args[2], scope) : 'undefined';
          if (fb === null) return null;
          if (isSensitiveName(lits[1])) this.vars.secret(`${lits[0]}.${lits[1]}`);
          else this.pvar(lits[0], lits[1], args[2]?.t === 'lit' ? stringify(args[2].v) : '');
          return `$pv(${js(`${lits[0]}.${lits[1]}`)}, ${fb})`;
        }
        return null;
      },
    };
    return scope;
  }

  /**
   * JavaScript for vars.<name> in a script of `host`: the answer of this request, a value an earlier request stored,
   * a literal of a set step, or a variable (set by hand where Steward computes it). For an earlier request `more`
   * is the path read from it (that path's value is stored); otherwise the caller navigates `more` itself.
   */
  private varJs(name: string, host: PmItem | null, more: PathStep[] | null): string {
    const prod = this.producers.get(name);
    if (prod?.kind === 'http') {
      if (prod.item === host) return more ? `$p($out, ${stepsJs(more)})` : '$out';
      if (!more) {
        prod.whole = true;
        return `$j(${js(`steward.vars.${name}`)})`;
      }
      const text = pathText(more);
      prod.json.set(text, more);
      return `$j(${js(`steward.vars.${name}${text ? '.' + text : ''}`)})`;
    }
    if (prod?.kind === 'set' && !hasTemplate(prod.value)) return js(prod.value ?? null);
    if (prod?.kind === 'set' && prod.template !== undefined)
      this.vars.collection(`vars.${name}`, prod.template, `Value set by the process (${code(`vars.${name}`)}).`);
    else this.vars.byHand(`vars.${name}`, prod?.kind === 'other' ? prod.what : code(`vars.${name}`));
    return `$r(${js(`vars.${name}`)}, 'json')`;
  }

  /** The scope object of the JSONata fallback: inputs, the vars the expressions read, constants, connections. */
  private fallbackScope(expressions: string[], host: PmItem | null): string {
    const names = new Set<string>();
    for (const e of expressions) for (const n of referencedVars(e)) names.add(n);
    const varsJs = [...names].map((name) => `${js(name)}: ${this.varJs(name, host, null)}`);
    const inputsJs = this.proc.definition.inputs.map((i) => `${js(i.name)}: $r(${js(`inputs.${i.name}`)}, ${js(this.inputAs(i.name))})`);
    const constJs = Object.keys(this.consts).map((k) => {
      if (!isSensitiveName(k)) return `${js(k)}: ${js(this.consts[k] ?? null)}`;
      this.vars.secret(`const.${k}`);
      return `${js(k)}: $r(${js(`const.${k}`)}, 'json')`;
    });
    const connJs = [...this.slots].map(([slot, s]) => {
      const pv = Object.keys(s.platform?.config.variables ?? {})
        .filter((k) => !isSensitiveName(k))
        .map((k) => `${js(k)}: $r(${js(`${slot}.${k}`)}, 'string')`);
      return `${js(slot)}: { name: ${js(s.platform?.name ?? '')}, kind: ${js(s.platform?.kind ?? '')}, baseUrl: $r(${js(`${slot}.baseUrl`)}, 'string'), vars: { ${pv.join(', ')} } }`;
    });
    return `{ inputs: { ${inputsJs.join(', ')} }, vars: { ${varsJs.join(', ')} }, const: { ${constJs.join(', ')} }, conn: { ${connJs.join(', ')} } }`;
  }

  /** pm.test lines of a check step: plain JavaScript where the subset covers it, else JSONata; null: not exportable. */
  private checkLines(n: NodeOf<'check'>, host: PmItem | null): string[] | null {
    const title = `${n.severity && n.severity !== 'error' ? `[${n.severity}] ` : ''}${n.name || n.id}`;
    const condition = stripBraces(n.condition);
    const when = n.when ? stripBraces(n.when) : undefined;
    if (STEWARD_ONLY.test(condition) || (when && STEWARD_ONLY.test(when))) return null;
    const message = `Condition not met: ${condition}`;
    const scope = this.jsScope(host);
    const condTree = parseSubset(condition);
    const whenTree = when ? parseSubset(when) : null;
    const condJs = condTree ? toJs(condTree, scope) : null;
    const whenJs = when ? (whenTree ? toJs(whenTree, scope) : null) : 'true';
    if (condJs !== null && whenJs !== null) {
      const test = [`pm.test(${js(title)}, function () {`, `  pm.expect($truthy(${condJs}), ${js(message)}).to.equal(true);`, '});'];
      return when ? [`if ($truthy(${whenJs})) {`, ...test.map((l) => '  ' + l), '}'] : test;
    }
    this.jsonataChecks.push(`"${n.name || n.id}": ${code(condition)}${when ? ` (when ${code(when)})` : ''}`);
    return [
      `pm.test(${js(title)}, function (done) {`,
      '  // JSONata, as in Steward: needs the Postman app or the Postman CLI (pm.require), not Newman',
      `  const jsonata = ${JSONATA_REQUIRE};`,
      `  const scope = ${this.fallbackScope([condition, ...(when ? [when] : [])], host)};`,
      "  const bindings = { inputs: scope.inputs, vars: scope.vars, const: scope.const, pvar: (s, k, fb) => $pv(s + '.' + k, fb), secret: (s, k) => $r(s + '.' + k, 'string'),",
      '    daysSince: (t) => { const ms = $ms(t); return ms === undefined ? undefined : Math.floor((Date.now() - ms) / 86400000); },',
      "    daysAgo: (d) => new Date(Date.now() - Number(d) * 86400000).toISOString(), ts: (t) => $ms(t), uuid: () => pm.variables.replaceIn('{{$guid}}') };",
      `  Promise.resolve(${when ? `jsonata(${js(when)}).evaluate(scope, bindings)` : 'true'})`,
      `    .then((go) => ($truthy(go) ? jsonata(${js(condition)}).evaluate(scope, bindings) : true))`,
      `    .then((v) => { pm.expect($truthy(v), ${js(message)}).to.equal(true); done(); })`,
      '    .catch(done);',
      '});',
    ];
  }

  // ----- steps -----

  addHttp(node: NodeOf<'http'>, context: string[]): void {
    const name = node.name || node.id;
    const s = this.slots.get(node.connection);
    const t = this.template(node.id);
    const desc: string[] = [node.description ?? '', ...context];
    if (node.when) desc.push(`Steward calls this only when ${code(stripBraces(node.when))}.`);
    // credentials written literally into the definition are never exported
    const literal = (key: string, value: unknown, where: string): string | undefined =>
      literalSecret(this.vars, `secret.${node.id}.${where}${key}`, key, value);
    let base = s?.base ?? v(`${node.connection}.baseUrl`);
    if (node.aws && s?.platform) base = endpointFor(s.platform, node.aws.service, node.aws.region) || base;
    const rawPath = t(node.path);
    const absolute = /^https?:\/\//i.test(rawPath);
    // Steward puts a "/" between base URL and path unless the path starts with one; a path starting with a value is taken as it is
    let url = urlOf(absolute ? rawPath : base + (rawPath.startsWith('/') || rawPath.startsWith('{{') ? '' : '/') + rawPath);
    const query: { key: string; value: string }[] = [];
    for (const [k, val] of Object.entries(node.query ?? {})) {
      if (val === undefined || val === null || val === '') continue;
      const lit = literal(k, val, 'query.');
      for (const one of Array.isArray(val) ? val : [val])
        query.push({ key: k, value: lit ?? (typeof one === 'string' ? t(one) : one && typeof one === 'object' ? t(JSON.stringify(one)) : String(one)) });
    }
    url = addQuery(url, query);
    const header: PmHeader[] = [...(s?.headers ?? [])];
    for (const [k, val] of Object.entries(node.headers ?? {})) header.push({ key: k, value: literal(k, val, 'header.') ?? t(String(val)) });
    let body: PmBody | undefined;
    if (node.body !== undefined) {
      const walk = (x: unknown, key: string): unknown => {
        if (typeof x === 'string') return literal(key, x, 'body.') ?? t(x);
        if (Array.isArray(x)) return x.map((e) => walk(e, key));
        if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, e]) => [k, walk(e, k)]));
        return x;
      };
      const b = walk(node.body, '');
      if (node.bodyType === 'form' && b && typeof b === 'object' && !Array.isArray(b))
        body = { mode: 'urlencoded', urlencoded: Object.entries(b).map(([key, val]) => ({ key, value: stringify(val) })) };
      else if (node.bodyType === 'text') body = { mode: 'raw', raw: stringify(b), options: { raw: { language: 'text' } } };
      else {
        body = { mode: 'raw', raw: typeof b === 'string' ? b : JSON.stringify(b, null, 2), options: { raw: { language: 'json' } } };
        if (!header.some((h) => h.key.toLowerCase() === 'content-type')) header.push({ key: 'Content-Type', value: 'application/json' });
      }
    }
    let auth = s?.sign.auth;
    if (absolute && s?.platform) {
      const origin = (u: string | undefined) => (u ? /^(https?:\/\/[^/?#]+)/i.exec(u)?.[1]?.toLowerCase() : undefined);
      const own = [origin(s.platform.baseUrl), ...(s.platform.config.http?.trustedOrigins ?? []).map(origin)].filter(Boolean);
      if (!own.includes(origin(rawPath))) {
        auth = { type: 'noauth' };
        desc.push("An absolute URL outside the platform: Steward sends it without the platform's credentials, and so does this request.");
      }
    }
    if (node.aws && auth?.type === 'awsv4')
      auth = {
        type: 'awsv4',
        awsv4: auth.awsv4!.map((a) => (a.key === 'region' ? attr('region', node.aws!.region) : a.key === 'service' ? attr('service', node.aws!.service) : a)),
      };
    if (node.paginate && node.paginate.mode !== 'none') desc.push(`Steward reads all pages (${node.paginate.mode}); this request fetches the first one.`);
    if (node.retry) desc.push(`Steward tries it up to ${node.retry.attempts} time(s).`);
    if (node.onError === 'continue') desc.push('When it fails, Steward goes on with the next step.');
    const descText = desc.filter(Boolean).join('\n\n');
    const item: PmItem = {
      id: node.id,
      name,
      request: { method: node.method, header, url, ...(body ? { body } : {}), ...(auth ? { auth } : {}), ...(descText ? { description: descText } : {}) },
      ...(s?.platform?.config.http?.insecureTls ? { protocolProfileBehavior: { strictSSL: false } } : {}),
    };
    const accepted = node.expectStatus?.length ? node.expectStatus : null;
    const status = [
      `pm.test(${js(`${name}: HTTP status ${accepted ? accepted.join(' or ') : '2xx'}`)}, function () {`,
      accepted ? `  pm.expect(pm.response.code).to.be.oneOf(${js(accepted)});` : '  pm.expect(pm.response.code).to.be.within(200, 299);',
      '});',
    ];
    if (this.hostless.length) {
      item.event = [script('prerequest', [...JS_HELPERS, ...PM_HELPERS, ...this.hostless])];
      this.hostless = [];
    }
    const producer: HttpProducer | undefined = node.saveAs
      ? { kind: 'http', name: node.saveAs, item, label: name, raw: new Map(), json: new Map(), whole: false }
      : undefined;
    this.current = { item, producer, status, checks: [] };
    this.entries.push(this.current);
    // from the next step on, vars.<saveAs> is this answer
    if (producer) this.producers.set(node.saveAs!, producer);
  }

  addCheck(node: NodeOf<'check'>, context: string[]): void {
    const name = node.name || node.id;
    const lines = this.checkLines(node, this.current?.item ?? null);
    if (!lines) {
      this.unchecked.push(`"${name}" (${code(node.condition)}): uses Steward's own data ($systems, $trend, $daysUntil).`);
      return;
    }
    const block = [`// Check ${js(name)}${context.length ? ' – ' + context.join(' ') : ''}`, ...lines];
    if (this.current) this.current.checks.push(...block);
    else this.hostless.push(...block);
  }

  addSet(node: NodeOf<'set'>): void {
    for (const [k, val] of Object.entries(node.values ?? {})) {
      if (!hasTemplate(val)) {
        this.producers.set(k, { kind: 'set', value: val });
        continue;
      }
      if (typeof val === 'string') {
        try {
          this.producers.set(k, { kind: 'set', value: val, template: translateTemplate(val, this.resolver(node.id, true)) });
          continue;
        } catch (e) {
          if (!(e instanceof NotTranslatable)) throw e;
        }
      }
      this.producers.set(k, { kind: 'other', what: code(typeof val === 'string' ? stripBraces(val) : JSON.stringify(val)) });
    }
    if (node.saveAs) this.producers.set(node.saveAs, { kind: 'other', what: `the values of "${node.name || node.id}"` });
  }

  addOther(node: FlowNode, context: string[]): void {
    const name = node.name || node.id;
    this.left.push(leftOut(node) + (context.length ? ` ${context.join(' ')}` : ''));
    if (node.saveAs) this.producers.set(node.saveAs, { kind: 'other', what: `the result of "${name}"` });
    if (node.type === 'forEach') {
      this.producers.set(node.as, { kind: 'other', what: `each item of ${code(node.items)} (loop "${name}")` });
      this.producers.set(`${node.as}Index`, { kind: 'other', what: `the position of the item in the loop "${name}"` });
    }
    if (node.type === 'browser')
      for (const a of node.actions) if (a.as) this.producers.set(a.as, { kind: 'other', what: `the value the browser step "${name}" reads` });
  }

  // ----- the result -----

  finish(unreachable: FlowNode[], canvasNotes: FlowNode[]): PostmanExport {
    for (const e of this.entries) {
      const p = e.producer;
      const writes: string[] = [];
      if (p) {
        const name = p.name;
        for (const [text, steps] of p.raw) writes.push(`$w(${js(`vars.${name}${text ? '.' + text : ''}`)}, $p($out, ${stepsJs(steps)}));`);
        for (const [text, steps] of p.json) writes.push(`$wj(${js(`steward.vars.${name}${text ? '.' + text : ''}`)}, $p($out, ${stepsJs(steps)}));`);
        if (p.whole) writes.push(`$wj(${js(`steward.vars.${name}`)}, $out);`);
      }
      const helpers = writes.length || e.checks.length ? [...JS_HELPERS, ...PM_HELPERS, ...PM_OUT] : [];
      const lines = [...e.status, ...helpers, ...(writes.length ? ['// values later steps read (collection variables)', ...writes] : []), ...e.checks];
      e.item.event = [...(e.item.event ?? []), script('test', lines)];
    }
    if (this.hostless.length)
      this.unchecked.push(
        ...this.hostless.filter((l) => l.startsWith('// Check ')).map((l) => `${l.slice('// Check '.length)}: the process has no request to attach it to.`),
      );

    const def = this.proc.definition;
    const section = (title: string, lines: string[], intro?: string) =>
      lines.length ? `### ${title}\n${intro ? intro + '\n\n' : ''}${lines.map((x) => `- ${x}`).join('\n')}` : '';
    const description = [
      (def.description ?? '').trim(),
      `Exported from Steward ${this.opts.stewardVersion} on ${this.opts.exportedAt.slice(0, 10)}: process "${def.name}" (${this.proc.id}), version ${this.proc.version}. The requests are in step order; import the collection together with the environment "${def.name} (Steward)" and enter the secrets there – the export contains none.`,
      section('Connections', this.connections),
      section('Left out (no request in Postman)', this.left),
      section('Set by hand', handNotes(this.vars)),
      section(
        'Checks that need the Postman app or the Postman CLI',
        this.jsonataChecks,
        `These checks run their JSONata expression with ${JSONATA_REQUIRE}, which the Postman app and the Postman CLI support – Newman does not. The other checks are plain JavaScript and run anywhere.`,
      ),
      section('Checks not exported', this.unchecked),
      section(
        'Not connected to the start (never runs)',
        unreachable.map((n) => `"${n.name || n.id}" (${n.type})`),
      ),
      section(
        'Notes on the canvas',
        canvasNotes.map((n) => (n.type === 'note' ? n.text.replace(/\s+/g, ' ').slice(0, 500) : '')),
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    const folder: PmFolder = { name: def.name, description, item: this.entries.map((e) => e.item) };
    return {
      collection: {
        info: {
          _postman_id: uuidFrom(`process:${this.proc.id}:${this.proc.version}`),
          name: `${def.name} (Steward)`,
          description: `Steward process "${def.name}", version ${this.proc.version}: the folder holds its requests and says what the export left out.`,
          schema: POSTMAN_COLLECTION_SCHEMA,
        },
        item: [folder],
        ...(this.prerequest.length ? { event: [script('prerequest', this.prerequest)] } : {}),
        variable: this.vars.collectionList(),
      },
      environment: environment(`process-env:${this.proc.id}`, `${def.name} (Steward)`, this.vars, this.opts),
      fileBase: slug(this.proc.id),
    };
  }
}

/** A process as a Postman collection (a folder with its requests in step order) and an environment of its connections. */
export function processToPostman(proc: ProcessSource, bindings: Record<string, SlotBinding>, opts: ExportOptions): PostmanExport {
  const ex = new ProcessExport(proc, bindings, opts);
  const { placed, unreachable, notes } = stepOrder(proc.definition);
  for (const { node, context } of placed) {
    if (node.type === 'http') ex.addHttp(node, context);
    else if (node.type === 'check') ex.addCheck(node, context);
    else if (node.type === 'set') ex.addSet(node);
    else if (node.type !== 'note') ex.addOther(node, context);
  }
  return ex.finish(unreachable, notes);
}

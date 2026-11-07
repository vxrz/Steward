import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DEMO_DB, DEMO_DB_HOST } from '../dbms/demo.js';
import { demoSchemaRows } from '../dbms/demo-schema.js';
import { parseYaml } from '../yaml-safe.js';

/**
 * A simulated datacontract CLI API (`datacontract api`, https://cli.datacontract.com) for the demo and the tests (#221,
 * docs/DATA-CONTRACTS.md): mounted at /mock/datacontract, signed in with `x-api-key` like the real API started with
 * DATACONTRACT_CLI_API_KEY.
 *
 *   POST /test?server=<name>     the contract as application/yaml; the credentials of the tested server per request in
 *                                datacontract-<type>-username / -password (and -host, -port, -database), as the CLI
 *                                reads them. It "tests" against the demo shop database (dbms/demo-schema.ts): a field
 *                                that is not a column fails, a type that does not fit fails, quality rules pass – unless
 *                                they demand fewer than one (mustBeLessThan below 1 fails, a made-up finding). Wrong
 *                                credentials or another host: the connection check fails, as with the CLI.
 *   POST /lint                   passed, or failed when apiVersion, kind or id are missing.
 *   GET  /openapi.json           the API's description (the connection test).
 *
 * It never echoes credentials. Test helpers (with the API key): GET /datacontract/_mock/calls – the latest requests
 * with the names of the datacontract-* headers and whether the credentials matched; POST /datacontract/_mock/reset.
 */

export const DEMO_DATACONTRACT = { apiKey: 'demo-datacontract-key' };

interface Call {
  path: string;
  server: string | null;
  headerNames: string[];
  /** The values of the datacontract-* headers that are not credentials (host, port, database, TLS options) */
  settings?: Record<string, string>;
  credentialsMatched: boolean;
  contractId: string | null;
}
const calls: Call[] = [];
const MAX_CALLS = 50;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const key = req.headers['x-api-key'];
  if (!key) {
    void reply.code(401).send({ detail: "Missing API key. Use Header 'x-api-key' to provide the API key." });
    return false;
  }
  const a = Buffer.from(String(key));
  const b = Buffer.from(DEMO_DATACONTRACT.apiKey);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    void reply.code(403).send({ detail: 'The provided API key is not correct.' });
    return false;
  }
  return true;
}

/** The demo database's columns: table → column → data type. */
function demoColumns(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const r of demoSchemaRows('columns')) {
    const t = String(r.table_name);
    const m = out.get(t) ?? new Map<string, string>();
    m.set(String(r.column_name), String(r.data_type));
    out.set(t, m);
  }
  return out;
}

const fits = (logical: string, sqlType: string): boolean => {
  const t = sqlType.toLowerCase();
  if (logical === 'integer') return t.includes('int');
  if (logical === 'number') return t.includes('int') || t.includes('numeric') || t.includes('decimal') || t.includes('double') || t.includes('real');
  if (logical === 'boolean') return t.includes('bool');
  if (logical === 'date') return t.includes('date') || t.includes('time');
  if (logical === 'string') return t.includes('char') || t.includes('text');
  return true;
};

const PREFIX: Record<string, string> = { postgres: 'postgres', postgresql: 'postgres', mysql: 'mysql', sqlserver: 'sqlserver' };

function run(contract: Obj, serverName: string | null, headers: FastifyRequest['headers']): { body: Obj; matched: boolean } {
  const now = new Date().toISOString();
  const checks: Obj[] = [];
  const logs: Obj[] = [{ level: 'INFO', message: 'Running tests (demo service)', timestamp: now }];
  const servers = Array.isArray(contract.servers) ? contract.servers.filter(isObj) : [];
  const server = serverName ? servers.find((s) => s.server === serverName) : servers.length === 1 ? servers[0] : undefined;
  const base = {
    runId: crypto.randomUUID(),
    datacontractCliVersion: 'demo',
    dataContractId: typeof contract.id === 'string' ? contract.id : null,
    dataContractVersion: typeof contract.version === 'string' ? contract.version : null,
    server: serverName,
    timestampStart: now,
    dryRun: false,
  };
  if (!server) {
    checks.push({ type: 'server', name: 'Server exists', result: 'error', reason: `Server "${serverName ?? ''}" not found in the data contract` });
    return { body: { ...base, timestampEnd: now, result: 'error', checks, logs }, matched: false };
  }
  const p = PREFIX[String(server.type)] ?? String(server.type);
  const h = (k: string) => {
    const v = headers[`datacontract-${p}-${k}`];
    return typeof v === 'string' ? v : undefined;
  };
  const host = h('host') ?? (typeof server.host === 'string' ? server.host : '');
  const matched =
    host === DEMO_DB_HOST &&
    h('username') === DEMO_DB.username &&
    h('password') === DEMO_DB.password &&
    (h('database') ?? server.database) === DEMO_DB.database;
  if (!matched) {
    checks.push({ type: 'connection', name: 'Connect to the server', result: 'error', reason: 'Could not connect: authentication failed or unknown host' });
    return { body: { ...base, timestampEnd: now, result: 'error', checks, logs }, matched };
  }
  const tables = demoColumns();
  for (const s of (Array.isArray(contract.schema) ? contract.schema : []).filter(isObj)) {
    const model = String(s.name ?? '');
    const physical = String(s.physicalName ?? s.name ?? '');
    const table = tables.get(physical.includes('.') ? physical.slice(physical.lastIndexOf('.') + 1) : physical);
    if (!table) {
      checks.push({
        type: 'model_exists',
        category: 'schema',
        name: `Check that table ${physical} exists`,
        model,
        result: 'failed',
        reason: `Table ${physical} not found`,
      });
      continue;
    }
    for (const prop of (Array.isArray(s.properties) ? s.properties : []).filter(isObj)) {
      const field = String(prop.physicalName ?? prop.name ?? '');
      const col = table.get(field);
      checks.push({
        type: 'field_is_present',
        category: 'schema',
        name: `Check that field ${field} is present`,
        model,
        field,
        result: col ? 'passed' : 'failed',
        ...(col ? {} : { reason: `Field ${field} not found in ${physical}` }),
      });
      if (col && typeof prop.logicalType === 'string')
        checks.push({
          type: 'field_type',
          category: 'schema',
          name: `Check that field ${field} has type ${prop.logicalType}`,
          model,
          field,
          result: fits(prop.logicalType, col) ? 'passed' : 'failed',
          ...(fits(prop.logicalType, col) ? {} : { reason: `Type is ${col}` }),
        });
      for (const q of (Array.isArray(prop.quality) ? prop.quality : []).filter(isObj)) {
        const failed = typeof q.mustBeLessThan === 'number' && q.mustBeLessThan < 1;
        checks.push({
          type: String(q.rule ?? q.metric ?? 'quality'),
          category: 'quality',
          name: `Quality rule ${String(q.rule ?? q.metric ?? q.name ?? '')} on ${field}`,
          model,
          field,
          result: failed ? 'failed' : 'passed',
          ...(failed ? { reason: 'Value(s) not as expected: 3', diagnostics: { failedRows: 3 } } : {}),
        });
      }
    }
  }
  const result = checks.some((c) => c.result === 'error')
    ? 'error'
    : checks.some((c) => c.result === 'failed')
      ? 'failed'
      : checks.some((c) => c.result === 'warning')
        ? 'warning'
        : 'passed';
  logs.push({ level: 'INFO', message: `Finished: ${result}`, timestamp: new Date().toISOString() });
  return { body: { ...base, timestampEnd: new Date().toISOString(), result, checks, logs }, matched };
}

export async function mockDataContract(app: FastifyInstance): Promise<void> {
  await app.register(async (api) => {
    api.addContentTypeParser(['application/yaml', 'application/x-yaml', 'text/yaml'], { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (_req, body, done) =>
      done(null, body),
    );
    const read = (req: FastifyRequest): Obj | null => {
      try {
        const v = parseYaml(String(req.body ?? ''), { maxBytes: 2 * 1024 * 1024, maxKeys: 50_000, maxAliasCount: 100 });
        return isObj(v) ? v : null;
      } catch {
        return null;
      }
    };
    const remember = (c: Call) => {
      calls.push(c);
      if (calls.length > MAX_CALLS) calls.splice(0, calls.length - MAX_CALLS);
    };
    api.post('/datacontract/test', async (req, reply) => {
      if (!authorized(req, reply)) return reply;
      const contract = read(req);
      const server = typeof (req.query as Obj).server === 'string' ? String((req.query as Obj).server) : null;
      const headerNames = Object.keys(req.headers)
        .filter((k) => k.startsWith('datacontract-'))
        .sort();
      const settings = Object.fromEntries(
        headerNames.filter((k) => !k.endsWith('-username') && !k.endsWith('-password')).map((k) => [k, String(req.headers[k])]),
      );
      if (!contract) {
        remember({ path: '/test', server, headerNames, credentialsMatched: false, contractId: null });
        return {
          result: 'failed',
          checks: [{ type: 'lint', name: 'Data contract is valid', result: 'failed', reason: 'Could not parse the data contract' }],
          logs: [],
        };
      }
      const r = run(contract, server, req.headers);
      remember({
        path: '/test',
        server,
        headerNames,
        settings,
        credentialsMatched: r.matched,
        contractId: typeof contract.id === 'string' ? contract.id : null,
      });
      return r.body;
    });
    api.post('/datacontract/lint', async (req, reply) => {
      if (!authorized(req, reply)) return reply;
      const contract = read(req);
      const missing = contract ? ['apiVersion', 'kind', 'id'].filter((k) => contract[k] === undefined) : ['document'];
      remember({
        path: '/lint',
        server: null,
        headerNames: [],
        credentialsMatched: false,
        contractId: contract && typeof contract.id === 'string' ? contract.id : null,
      });
      if (!missing.length) return { result: 'passed', checks: [{ type: 'lint', name: 'Data contract is syntactically valid', result: 'passed' }] };
      return {
        result: 'failed',
        checks: missing.map((k) => ({ type: 'lint', name: 'Data contract is syntactically valid', result: 'failed', field: k, reason: `${k} is required` })),
      };
    });
    // the API's own description (the connection test reads it; the real API serves it without the key, too)
    api.get('/datacontract/openapi.json', async () => ({
      openapi: '3.1.0',
      info: { title: 'Data Contract CLI API (demo)', version: 'demo' },
      paths: { '/test': {}, '/lint': {} },
    }));
    api.get('/datacontract/_mock/calls', async (req, reply) => (authorized(req, reply) ? calls : reply));
    api.post('/datacontract/_mock/reset', async (req, reply) => {
      if (!authorized(req, reply)) return reply;
      calls.length = 0;
      return { ok: true };
    });
  });
}

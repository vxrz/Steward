import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * GET /api/v1/semantic-model: Steward's data model as an Apache Ossie semantic model, validated against
 * the official Ossie JSON schemas (vendored in test/fixtures/ossie, see the $comment in each file).
 */
let s: TestServer;
let token: string;

const schema = (v: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'ossie', `ossie-${v}.schema.json`), 'utf8'));

async function get(url: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}`, ...headers } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  token = (await s.api('POST', '/me/tokens', { name: 'ossie', scope: 'read' })).token;
});
afterAll(async () => s?.app.close());

/** Field names that would mean credentials or other secrets ended up in the model. */
const SECRETISH = /secret|password|passphrase|token|credential|apikey|api_key|clientsecret|privatekey|^inputs$|^bindings$|^config$|^variables$|sealed/i;

function namesOf(doc: any): string[] {
  const model = doc.semantic_model ? doc.semantic_model[0] : doc;
  return model.datasets.flatMap((d: any) => [d.name, ...d.fields.map((f: any) => f.name)]);
}

describe('semantic model (Apache Ossie)', () => {
  for (const version of ['0.1.1', '0.2.0.dev0']) {
    it(`validates against the Ossie ${version} schema`, async () => {
      const ajv = new Ajv2020({ allErrors: true, strict: false });
      const validate = ajv.compile(schema(version));
      const r = await get(`/semantic-model?version=${version}`);
      expect(r.status).toBe(200);
      expect(r.type).toContain('application/json');
      const doc = JSON.parse(r.text);
      expect(doc.version).toBe(version);
      expect(validate(doc), ajv.errorsText(validate.errors)).toBe(true);
      // the YAML rendering is the same document
      const y = await get(`/semantic-model?version=${version}&format=yaml`);
      expect(y.type).toContain('application/yaml');
      expect(YAML.parse(y.text)).toEqual(doc);
    });
  }

  it('defaults to the released revision and negotiates YAML via Accept', async () => {
    const def = JSON.parse((await get('/semantic-model')).text);
    expect(def.version).toBe('0.1.1');
    expect(def.semantic_model).toHaveLength(1);
    const y = await get('/semantic-model', { accept: 'application/yaml' });
    expect(y.type).toContain('application/yaml');
    expect(YAML.parse(y.text).version).toBe('0.1.1');
    const j = await get('/semantic-model', { accept: 'application/json, application/yaml;q=0.5' });
    expect(j.type).toContain('application/json');
    expect((await get('/semantic-model?version=9.9')).status).toBe(400);
  });

  it('models the API resources with relationships and metrics, and no secret fields', async () => {
    const doc = JSON.parse((await get('/semantic-model?version=0.2.0.dev0')).text);
    const datasets = new Map<string, any>(doc.datasets.map((d: any) => [d.name, d]));
    for (const n of [
      'processes',
      'runs',
      'run_steps',
      'tasks',
      'schedules',
      'webhook_triggers',
      'platforms',
      'dashboard_datasets',
      'dashboards',
      'monitors',
      'monitor_checks',
      'monitor_status_changes',
      'audit_entries',
    ]) {
      expect(datasets.has(n), n).toBe(true);
    }
    // every dataset says which API operation serves it, and that operation exists in the OpenAPI document
    const openapi = JSON.parse((await get('/openapi.json')).text);
    const ops = new Set(Object.values<any>(openapi.paths).map((p) => p.get.operationId));
    for (const d of doc.datasets) {
      const ext = JSON.parse(d.custom_extensions[0].data).steward;
      expect(ops.has(ext.operationId), `${d.name} → ${ext.operationId}`).toBe(true);
      expect(d.source).toBe(`steward.api_v1.${d.name}`);
      // relationship / key columns are declared fields
      const fields = new Set(d.fields.map((f: any) => f.name));
      for (const k of d.primary_key) expect(fields.has(k), `${d.name}.${k}`).toBe(true);
    }
    for (const r of doc.relationships) {
      expect(datasets.has(r.from) && datasets.has(r.to)).toBe(true);
      for (const c of r.from_columns)
        expect(
          datasets.get(r.from).fields.some((f: any) => f.name === c),
          `${r.name}: ${c}`,
        ).toBe(true);
      for (const c of r.to_columns)
        expect(
          datasets.get(r.to).fields.some((f: any) => f.name === c),
          `${r.name}: ${c}`,
        ).toBe(true);
    }
    expect(datasets.get('runs').metrics.map((m: any) => m.name)).toContain('run_success_rate');
    expect(datasets.get('monitors').metrics.map((m: any) => m.name)).toContain('monitor_availability_24h');
    // dataset-scoped metrics only reference fields of their own dataset (Ossie metric scoping rule 1)
    for (const d of doc.datasets) {
      const fields = new Set(d.fields.map((f: any) => f.name));
      for (const m of d.metrics ?? []) {
        for (const ref of m.expression.dialects[0].expression.matchAll(/"([A-Za-z0-9_]+)"(?:\."([A-Za-z0-9_]+)")?/g)) {
          const name = ref[2] ? `${ref[1]}.${ref[2]}` : ref[1];
          expect(fields.has(name), `${d.name}.${m.name} uses ${name}`).toBe(true);
        }
        expect(fields.has(m.name)).toBe(false); // fields and metrics share one namespace
      }
    }
    for (const v of ['0.1.1', '0.2.0.dev0']) {
      const text = (await get(`/semantic-model?version=${v}`)).text;
      for (const n of namesOf(JSON.parse(text))) expect(n, `${v}: ${n}`).not.toMatch(SECRETISH);
      expect(text).not.toMatch(/smt_|correct horse/);
    }
  });

  it('needs a token like the rest of v1', async () => {
    const r = await fetch(`${s.base}/api/v1/semantic-model`);
    expect(r.status).toBe(401);
  });
});

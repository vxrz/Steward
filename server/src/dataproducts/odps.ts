import YAML from 'yaml';
import { Ajv2019, type ErrorObject, type ValidateFunction } from 'ajv/dist/2019.js';
import { CIA_DIMENSIONS, type DataObjectives } from '@sm/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { owningTeams } from '../auth/policy.js';
import { readAsset } from '../reports/pdf/assets.js';
import { parseJson } from '../util.js';
import { Snapshot, objectivesFile } from './export.js';
import { defaultEnvironment } from './health.js';
import { ratingsByItem } from './ratings.js';
import { visibleProduct } from './service.js';
import { bindingsOf, environmentsOf, marks, portObjectsOf, portsOf, type PortRow } from './store.js';

/**
 * The ODPS v1.0.0 export of a data product (ADR 0036 part 15, decision 22; Open Data Product Standard by Bitol,
 * https://github.com/bitol-io/open-data-product-standard – its JSON Schema vendored in server/assets/odps with its
 * Apache 2.0 licence): `id` = the key, `name`, `version`, `status` = the lifecycle, `domain`, `description` (purpose,
 * usage), `team` (the owners), `support`, `inputPorts` and `outputPorts` with `version` and `contractId` = the bound
 * contract's ODCS id in one environment (production unless asked), `tags`, `authoritativeDefinitions` (external
 * references), Steward's own pages and /api/v1 as `managementPorts` (where SM_PUBLIC_URL is set), and what ODPS has no
 * field for under `customProperties` (type, rating, criticality, data objects, environments).
 *
 * ODPS requires a contract id on every input port: an input port without one (a source system, a text, an output port
 * without a contract in that environment) is listed under `customProperties` (`inputsWithoutContract`) instead.
 * Team scope as everywhere: a hidden domain, contract, data object or source product is left out.
 */

export const ODPS_API_VERSION = 'v1.0.0';
export const ODPS_SCHEMA_FILE = 'odps/odps-json-schema-v1.0.0.json';

type Obj = Record<string, unknown>;
const prop = (property: string, value: unknown, description?: string) => ({ property, value, ...(description ? { description } : {}) });
const nonEmpty = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);

/** The product as an ODPS v1.0.0 document (`environment`: whose bindings give the contracts; default production). */
export function odpsDocument(productId: string, environment?: string): Obj {
  const s = new Snapshot();
  const { row: p } = visibleProduct(productId, s.u);
  const envs = environmentsOf([p.id]).map((e) => e.environment);
  const env = environment ?? defaultEnvironment(envs) ?? '';
  const ports = portsOf([p.id]);
  const bindings = bindingsOf(ports.map((x) => x.id)).filter((b) => b.environment === env);
  const declared = portObjectsOf(ports.map((x) => x.id));
  const sourceIds = ports.map((x) => x.source_port_id).filter((x): x is string => !!x);
  const sources = new Map(
    (sourceIds.length ? db().all<PortRow>(`SELECT * FROM dp_ports WHERE id IN (${marks(sourceIds.length)})`, ...sourceIds) : []).map((r) => [r.id, r]),
  );
  const sourceBindings = bindingsOf([...sources.keys()]).filter((b) => b.environment === env);
  const contractOf = (portId: string, list = bindings): string | null => {
    const b = list.find((x) => x.port_id === portId);
    return b?.contract_id ? s.contractKey(b.contract_id) : null;
  };
  const objectKeys = (portId: string) =>
    declared
      .filter((d) => d.port_id === portId)
      .map((d) => s.objectKey(d.object_id))
      .filter((k): k is string => !!k)
      .sort();

  const outputPorts = ports
    .filter((x) => x.direction === 'output')
    .map((x) => {
      const contractId = contractOf(x.id);
      const objectives = objectivesFile({
        ...parseJson<DataObjectives>(x.objectives, {}),
        ...parseJson<DataObjectives>(bindings.find((b) => b.port_id === x.id)?.objectives ?? '{}', {}),
      });
      const custom = [
        prop('portType', x.port_type),
        prop('lifecycle', x.lifecycle),
        ...(x.sunset_date ? [prop('sunsetDate', x.sunset_date)] : []),
        ...(objectKeys(x.id).length ? [prop('dataObjects', objectKeys(x.id))] : []),
        ...(Object.keys(objectives).length ? [prop('objectives', objectives, 'Freshness in minutes, availability in percent over 30 days')] : []),
      ];
      return {
        name: x.name,
        ...(x.description ? { description: x.description } : {}),
        type: x.port_type,
        version: x.version,
        ...(contractId ? { contractId } : {}),
        customProperties: custom,
      };
    });

  const inputPorts: Obj[] = [];
  const withoutContract: Obj[] = [];
  for (const x of ports.filter((y) => y.direction === 'input')) {
    const sp = x.source_port_id ? sources.get(x.source_port_id) : undefined;
    const sourceKey = sp ? s.productKey(sp.product_id) : null;
    const contractId = sp && sourceKey ? contractOf(sp.id, sourceBindings) : null;
    const source =
      sp && sourceKey
        ? `${sourceKey}/${sp.name}${sp.version ? ` ${sp.version}` : ''}`
        : x.source_kind === 'text'
          ? x.source_text
          : x.source_kind === 'element'
            ? 'an element of a source system'
            : null;
    if (contractId)
      inputPorts.push({
        name: x.name,
        version: x.version || sp?.version || '',
        contractId,
        customProperties: [...(source ? [prop('source', source)] : []), ...(objectKeys(x.id).length ? [prop('dataObjects', objectKeys(x.id))] : [])],
      });
    else withoutContract.push({ name: x.name, version: x.version, ...(source ? { source } : {}) });
  }

  const owners = parseJson<string[]>(p.owners, []);
  const teams = owningTeams('data_product', p.id).map((t) => t.name);
  const members = owners.filter((o) => o.startsWith('user:')).map((o) => ({ username: o.slice(5), role: 'productOwner' }));
  const ownerTeams = owners.filter((o) => o.startsWith('team:')).map((o) => o.slice(5));
  const support = { channel: '', url: '', hours: '', ...parseJson<Record<string, string>>(p.support, {}) };
  const rating = ratingsByItem('product', [p.id]).get(p.id)!;
  const ratingValue = Object.fromEntries([
    ...CIA_DIMENSIONS.filter((d) => rating[d]).map((d) => [d, rating[d]!.level]),
    ...(p.classification ? [['classification', p.classification]] : []),
  ]);
  const domain = p.domain_id ? s.domainKey(p.domain_id) : null;
  const domainRow = domain ? [...s.allDomains().values()].find((d) => d.key === domain) : undefined;
  const allObjects = [...new Set(ports.flatMap((x) => (x.direction === 'output' ? objectKeys(x.id) : [])))];
  const base = config.publicUrl ? config.publicUrl.replace(/\/$/, '') : null;
  const refs = parseJson<{ label: string; url: string }[]>(p.external_refs, []);

  const doc: Obj = {
    apiVersion: ODPS_API_VERSION,
    kind: 'DataProduct',
    id: p.key,
    name: p.name,
    ...(p.version ? { version: p.version } : {}),
    status: p.lifecycle,
    ...(domainRow ? { domain: domainRow.name } : {}),
    ...(nonEmpty(p.purpose) || nonEmpty(p.description)
      ? { description: { ...(p.purpose ? { purpose: p.purpose } : {}), ...(p.description ? { usage: p.description } : {}) } }
      : {}),
    ...(parseJson<string[]>(p.tags, []).length ? { tags: parseJson<string[]>(p.tags, []) } : {}),
    ...(refs.length ? { authoritativeDefinitions: refs.map((r) => ({ type: 'reference', url: r.url, ...(r.label ? { description: r.label } : {}) })) } : {}),
    ...(inputPorts.length ? { inputPorts } : {}),
    ...(outputPorts.length ? { outputPorts } : {}),
    ...(base
      ? {
          managementPorts: [
            {
              name: 'steward',
              content: 'discoverability',
              type: 'rest',
              url: `${base}/data-products/${encodeURIComponent(p.id)}`,
              description: 'The product in Steward',
            },
            {
              name: 'steward-api',
              content: 'discoverability',
              type: 'rest',
              url: `${base}/api/v1/data-products/${encodeURIComponent(p.id)}`,
              description: 'The product in Steward’s public API (/api/v1, a token is needed)',
            },
          ],
        }
      : {}),
    ...(support.url
      ? { support: [{ channel: support.channel || 'support', url: support.url, ...(support.hours ? { description: `Hours: ${support.hours}` } : {}) }] }
      : {}),
    ...(members.length || teams.length || ownerTeams.length
      ? {
          team: {
            ...(teams.length ? { name: teams.join(', ') } : {}),
            ...(members.length ? { members } : {}),
            ...(ownerTeams.length ? { customProperties: [prop('ownerTeams', ownerTeams, 'Teams named as product owners')] } : {}),
          },
        }
      : {}),
    customProperties: [
      prop('stewardId', p.id),
      ...(p.type ? [prop('type', p.type, 'Source-aligned, aggregate or consumer-aligned')] : []),
      ...(domain ? [prop('domainKey', domain)] : []),
      ...(Object.keys(ratingValue).length ? [prop('rating', ratingValue, 'CIA rating on the instance’s scale and the classification')] : []),
      ...(p.criticality ? [prop('criticality', p.criticality)] : []),
      ...(p.tier ? [prop('supportTier', Number(p.tier))] : []),
      ...(p.sunset_date ? [prop('sunsetDate', p.sunset_date)] : []),
      ...(allObjects.length ? [prop('dataObjects', allObjects, 'Data objects its output ports expose (declared)')] : []),
      prop('environments', [...new Set(envs)].sort()),
      prop('environment', env, 'The environment whose bindings give the contracts of the ports'),
      ...(withoutContract.length
        ? [prop('inputsWithoutContract', withoutContract, 'Input ports without a data contract (ODPS needs one on an input port)')]
        : []),
    ],
    productCreatedTs: new Date(p.created_at).toISOString(),
  };
  return doc;
}

export function odpsFile(productId: string, environment?: string): { fileName: string; body: string } {
  const doc = odpsDocument(productId, environment);
  const name = String(doc.id).replace(/[^a-z0-9._-]+/gi, '-');
  return { fileName: `${name}.odps.yaml`, body: YAML.stringify(doc, { lineWidth: 0 }) };
}

// ---------- the check against the official schema ----------

let validator: ValidateFunction | null = null;

/** The vendored ODPS v1.0.0 JSON Schema, compiled once. */
function odpsValidator(): ValidateFunction {
  if (validator) return validator;
  const schema = JSON.parse(readAsset(ODPS_SCHEMA_FILE).toString('utf8')) as Obj;
  const ajv = new Ajv2019({ allErrors: true, strict: false, validateFormats: true });
  ajv.addFormat('date', { type: 'string', validate: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (v: string) => v.length >= 20 && v.length <= 40 && !Number.isNaN(Date.parse(v)) && v[10]?.toUpperCase() === 'T',
  });
  ajv.addFormat('uri', { type: 'string', validate: (v: string) => v.length <= 4096 && URL.canParse(v) });
  validator = ajv.compile(schema);
  return validator;
}

/** What the official schema finds wrong with a document (empty: valid). */
export function odpsProblems(doc: unknown): string[] {
  const v = odpsValidator();
  if (v(doc)) return [];
  return (v.errors ?? []).slice(0, 50).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
}

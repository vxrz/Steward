import { roleKeyFor } from '../contacts/roles.js';
import {
  CIA_DIMENSIONS,
  DATA_CLASSIFICATIONS,
  DATA_PORT_LIFECYCLES,
  DATA_PORT_TYPES,
  DATA_PRODUCT_CRITICALITIES,
  DATA_PRODUCT_KEY_RE,
  DATA_PRODUCT_LIFECYCLES,
  DATA_PRODUCT_TYPES,
  isProductionEnvironment,
  isSupportAddress,
  isSupportUrl,
  SUPPORT_LIMITS as SL,
  SUPPORT_PURPOSES,
  SUPPORT_TOOLS,
  toolOfAddress,
  type SupportPurpose,
} from '@sm/shared';
import { db } from '../db.js';
import { currentUser } from '../auth/context.js';
import { contractAccess } from '../auth/policy.js';
import { environmentList } from '../catalogue/environments.js';
import { domainAccess, productAccess } from './access.js';
import { odpsProblems } from './odps.js';
import type { DomainRow, ProductRow } from './store.js';
import type { ContactFile, SupportChannelFile } from './format.js';
import { listLevels } from '../support/levels.js';

/**
 * The ODPS import (ADR 0036 part 15, decision 22, phase 2): an Open Data Product Standard v1.0.0 document (`apiVersion:
 * v1.0.0`, `kind: DataProduct`) given to the import among the files of Steward's format becomes a `data_product:` of the
 * format before it is read – so it has the same preview, modes, rights and audit as every import.
 *
 * ODPS carries no elements or steps: the document creates or updates the product (key = `id`, name, version, status as
 * the lifecycle, domain, description, tags, authoritative definitions as external references, the product owners of its
 * team, support) and its ports; an output port's `contractId` binds the port to the data contract of that ODCS id in
 * one environment – the one named under the document's `customProperties` (`environment`, as Steward exports it), else
 * the instance's production environment. An input port's source is the output port its `customProperties` name
 * (`<product key>/<port> <version>`, as Steward exports it), else the visible output port bound to the same contract,
 * else a text. Steward's own extras under `customProperties` (type, criticality, support level – or the support tier of
 * exports before 0.26.0 –, sunset date, rating, data
 * objects, environments) are read back, so an exported product imports unchanged. What cannot be mapped is a warning of
 * the preview, never silently dropped; the document is checked against the vendored ODPS JSON Schema first.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** An ODPS document (any 1.x), not a file of Steward's format. */
export const isOdpsDocument = (raw: unknown): raw is Obj =>
  isObj(raw) && raw.kind === 'DataProduct' && typeof raw.apiVersion === 'string' && raw.version !== 1 && !('data_product' in raw);

/** `customProperties: [{ property, value }]` as a map (later entries win; property names never become object keys). */
function customOf(v: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(v)) return out;
  for (const x of v) if (isObj(x) && typeof x.property === 'string') out.set(x.property, x.value);
  return out;
}

const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/** "orders/orders v2" → the product key, the port's name and version. */
function parseSource(s: string): { product: string; port: string; version: string } | null {
  const slash = s.indexOf('/');
  if (slash <= 0) return null;
  const product = s.slice(0, slash).trim();
  const rest = s.slice(slash + 1).trim();
  const space = rest.lastIndexOf(' ');
  const port = space > 0 ? rest.slice(0, space) : rest;
  const version = space > 0 ? rest.slice(space + 1) : '';
  return DATA_PRODUCT_KEY_RE.test(product) && port ? { product, port, version } : null;
}

/** ODPS `scope` → Steward's purpose. */
const PURPOSE_OF_SCOPE: Record<string, SupportPurpose> = { interactive: 'questions', issues: 'issues', announcements: 'announcements' };
const isGuide = (r: Obj) => (str(r.type) ?? '').toLowerCase() === 'userguide';

export interface OdpsConversion {
  /** A file of Steward's format (`version: 1`, `data_product:`), to be checked by the format's schema */
  file: Obj | null;
  warnings: string[];
  problems: { path: string; message: string }[];
}

/** The ODPS document as a `data_product:` of Steward's format, with what could not be mapped as warnings. */
export function odpsToFile(raw: Obj): OdpsConversion {
  const warnings: string[] = [];
  const problems: { path: string; message: string }[] = [];
  const api = String(raw.apiVersion);
  if (!api.startsWith('v1.')) return { file: null, warnings, problems: [{ path: 'apiVersion', message: `ODPS ${api} is not read – Steward reads ODPS v1` }] };
  for (const p of odpsProblems(raw).slice(0, 20)) problems.push({ path: '(ODPS)', message: `Not a valid ODPS document: ${p}` });
  if (problems.length) return { file: null, warnings, problems };
  const id = str(raw.id) ?? '';
  const key = id.toLowerCase();
  if (!DATA_PRODUCT_KEY_RE.test(key)) {
    problems.push({ path: 'id', message: `The ODPS id "${id.slice(0, 100)}" is not a key Steward can use (lower case letters, digits, “.”, “_” and “-”)` });
    return { file: null, warnings, problems };
  }
  const u = currentUser();
  const custom = customOf(raw.customProperties);
  const product: Obj = { key, name: str(raw.name) ?? id };
  if (str(raw.version)) product.version = str(raw.version);
  const lifecycle = pick(raw.status, DATA_PRODUCT_LIFECYCLES);
  if (lifecycle) product.lifecycle = lifecycle;
  else if (raw.status !== undefined) warnings.push(`ODPS ${key}: the status "${String(raw.status).slice(0, 40)}" is not a lifecycle of Steward – left out`);

  // the domain: Steward's key where the document carries it, else a visible domain of that name
  const domainKey = str(custom.get('domainKey'));
  const domainName = str(raw.domain);
  if (domainKey) product.domain = domainKey;
  else if (domainName) {
    const hits = db()
      .all<DomainRow>('SELECT * FROM dp_domains')
      .filter((d) => d.name.trim().toLowerCase() === domainName.toLowerCase() && (!u || domainAccess(u, d).permissions.length));
    if (hits.length === 1) product.domain = hits[0]!.key;
    else warnings.push(`ODPS ${key}: no single domain is named "${domainName.slice(0, 100)}" – the product keeps its domain`);
  }

  if (isObj(raw.description)) {
    const d = raw.description;
    if (str(d.purpose)) product.purpose = str(d.purpose);
    const usage = [str(d.usage), str(d.limitations) ? `Limitations: ${str(d.limitations)}` : undefined].filter(Boolean).join('\n\n');
    if (usage) product.description = usage;
  }
  if (Array.isArray(raw.tags)) product.tags = raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 50);
  if (Array.isArray(raw.authoritativeDefinitions)) {
    const defs = raw.authoritativeDefinitions.filter(isObj);
    const refs = defs
      .filter((r) => !isGuide(r))
      .map((r) => ({ url: str(r.url) ?? '', label: str(r.description) ?? (str(r.type) === 'reference' ? '' : (str(r.type) ?? '')) }))
      .filter((r) => /^https?:\/\//i.test(r.url));
    if (refs.length) product.external_refs = refs.slice(0, 20);
    // 0.26.0 (ADR 0039 part 6): user guides are where the consumers find guides and documentation
    const guides = defs
      .filter((r) => isGuide(r) && isSupportUrl(str(r.url) ?? ''))
      .map((r) => ({ title: (str(r.description) ?? str(r.url)!).slice(0, SL.title), url: str(r.url)! }));
    if (guides.length) product.guides = guides.slice(0, SL.guides);
  }
  // the product owners and business contacts (0.25.1: contacts): team members with those roles – an e-mail address as
  // username is the contact's address, another username a Steward user (Steward's exports of before 0.25.1); teams
  // named as owners (ownerTeams of before) become group contacts
  if (isObj(raw.team)) {
    const contacts: ContactFile[] = [];
    // 0.26.0 (ADR 0039): a role of the catalogue for data products by its key or label (productOwner as before); an
    // unknown role is refused with a hint – the import makes no role
    const refusedRoles = new Set<string>();
    for (const m of Array.isArray(raw.team.members) ? raw.team.members : []) {
      if (!isObj(m)) continue;
      const text = str(m.role) ?? '';
      const role = text ? roleKeyFor('data_product', text) : undefined;
      const username = str(m.username);
      if (!username) continue;
      if (!role) {
        if (text) refusedRoles.add(text);
        continue;
      }
      const email = /^[^\s@]+@[^\s@]+$/.test(username) ? username : undefined;
      // a member with a name is that contact; one with only a username (Steward's exports of before 0.25.1) the account's
      const name = str(m.name);
      const until = str(m.dateOut);
      contacts.push({
        role,
        name: name ?? username,
        ...(email ? { email } : name ? {} : { user: username }),
        ...(until && /^\d{4}-\d{2}-\d{2}/.test(until) ? { until: until.slice(0, 10) } : {}),
      });
    }
    if (refusedRoles.size)
      warnings.push(
        `ODPS ${key}: team members in roles that are not contact roles of data products are not kept (${[...refusedRoles].join(', ')}) – administrators add roles under Settings → Contacts → Roles`,
      );
    const ownerTeams = customOf(raw.team.customProperties).get('ownerTeams');
    if (Array.isArray(ownerTeams))
      for (const t of ownerTeams) if (typeof t === 'string' && t.trim()) contacts.push({ role: 'productOwner', name: t.trim(), kind: 'group' });
    if (contacts.length) product.contacts = contacts;
  }
  // 0.26.0 (ADR 0039 part 7): every support entry is a channel – scope as the purpose (none: Steward's purpose under its
  // customProperties, else questions), tool, and the description as hours ("Hours: …" on its first line) and note
  if (Array.isArray(raw.support)) {
    const channels: SupportChannelFile[] = [];
    for (const x of raw.support) {
      if (!isObj(x)) continue;
      const url = str(x.url) ?? '';
      if (!isSupportAddress(url)) {
        warnings.push(
          `ODPS ${key}: the support channel "${(str(x.channel) ?? '').slice(0, 60)}" has an address Steward does not keep (https://, mailto: or tel:) – left out`,
        );
        continue;
      }
      const scope = (str(x.scope) ?? '').toLowerCase();
      const own = pick(customOf(x.customProperties).get('purpose'), SUPPORT_PURPOSES);
      const purpose = PURPOSE_OF_SCOPE[scope] ?? own ?? 'questions';
      const tool = pick((str(x.tool) ?? '').toLowerCase(), SUPPORT_TOOLS) ?? (str(x.tool) ? 'other' : toolOfAddress(url));
      const d = str(x.description) ?? '';
      const [first, ...rest] = d.split('\n');
      const hours = first?.startsWith('Hours: ') ? first.slice(7).trim() : '';
      const note = (hours ? rest.join('\n') : d).trim();
      channels.push({
        purpose,
        tool,
        name: (str(x.channel) ?? '').slice(0, SL.name),
        address: url,
        hours: hours.slice(0, SL.hours),
        note: note.slice(0, SL.note),
      });
    }
    if (channels.length) product.support_channels = channels.slice(0, SL.channels);
  }

  // Steward's extras
  const type = pick(custom.get('type'), DATA_PRODUCT_TYPES);
  if (type) product.type = type;
  const criticality = pick(custom.get('criticality'), DATA_PRODUCT_CRITICALITIES);
  if (criticality) product.criticality = criticality;
  // the support level by its name (0.26.0); a tier of exports before 0.26.0 picks the level made from it
  const level = custom.get('supportLevel');
  if (isObj(level) && str(level.name)) {
    const name = str(level.name)!;
    const n = name.toLowerCase();
    if (listLevels().some((l) => l.nameEn.trim().toLowerCase() === n || (!!l.nameDe && l.nameDe.trim().toLowerCase() === n)))
      product.support_level = { name: name.slice(0, SL.name) };
    else warnings.push(`ODPS ${key}: the support level "${name.slice(0, 100)}" is not one of Settings → Support levels – left out`);
  } else {
    const tier = custom.get('supportTier');
    if (tier === 1 || tier === 2 || tier === 3) product.tier = tier;
  }
  if (str(custom.get('sunsetDate'))) product.sunset_date = str(custom.get('sunsetDate'));
  const rating = custom.get('rating');
  if (isObj(rating)) {
    const r: Obj = {};
    for (const d of CIA_DIMENSIONS) if (typeof rating[d] === 'string') r[d] = rating[d];
    const c = pick(rating.classification, DATA_CLASSIFICATIONS);
    if (c) r.classification = c;
    if (Object.keys(r).length) product.rating = r;
  }
  const envs = custom.get('environments');
  if (Array.isArray(envs)) {
    const list = envs.filter((e): e is string => typeof e === 'string' && !!e.trim()).slice(0, 50);
    if (list.length) product.environments = list.map((environment) => ({ environment }));
  }
  // the environment whose bindings the contracts are: as exported, else production
  const environment = str(custom.get('environment')) ?? environmentList().find((e) => isProductionEnvironment(environmentList(), e.name))?.name ?? null;

  const ports: Obj[] = [];
  const outputs = Array.isArray(raw.outputPorts) ? raw.outputPorts.filter(isObj) : [];
  for (const [i, p] of outputs.entries()) {
    const name = str(p.name);
    if (!name) {
      warnings.push(`ODPS ${key}: output port ${i + 1} has no name – left out`);
      continue;
    }
    const pc = customOf(p.customProperties);
    const port: Obj = { direction: 'output', name, version: str(p.version) ?? '' };
    const t = pick(pc.get('portType'), DATA_PORT_TYPES) ?? pick(p.type, DATA_PORT_TYPES);
    if (t) port.type = t;
    if (str(p.description)) port.description = str(p.description);
    const lc = pick(pc.get('lifecycle'), DATA_PORT_LIFECYCLES);
    if (lc) port.lifecycle = lc;
    if (str(pc.get('sunsetDate'))) port.sunset_date = str(pc.get('sunsetDate'));
    const objects = pc.get('dataObjects');
    if (Array.isArray(objects)) port.data_objects = objects.filter((o): o is string => typeof o === 'string');
    const objectives = pc.get('objectives');
    if (isObj(objectives)) port.objectives = objectives;
    const contract = str(p.contractId);
    if (contract) {
      if (environment) port.bindings = [{ environment, contract }];
      else
        warnings.push(
          `ODPS ${key}: output port ${name} names the contract ${contract}, but no environment is known to bind it in – name one under customProperties (environment)`,
        );
    }
    ports.push(port);
  }

  const contractSource = (contractKey: string): Obj | null => {
    // the visible output port bound to the same contract (one only)
    const contracts = db()
      .all<{ id: string }>('SELECT id FROM data_contracts WHERE contract_key = ?', contractKey)
      .filter((c) => !u || contractAccess(u, { id: c.id }).permissions.includes('view'));
    if (contracts.length !== 1) return null;
    const rows = db().all<{ product_id: string; name: string; version: string }>(
      `SELECT p.product_id, p.name, p.version FROM dp_port_bindings b JOIN dp_ports p ON p.id = b.port_id WHERE b.contract_id = ? AND p.direction = 'output'`,
      contracts[0]!.id,
    );
    const visible = rows.filter((r) => {
      const pr = db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', r.product_id);
      return pr && pr.key !== key && (!u || productAccess(u, pr).permissions.length);
    });
    const distinct = [...new Map(visible.map((r) => [`${r.product_id}\u0000${r.name}\u0000${r.version}`, r])).values()];
    if (distinct.length !== 1) return null;
    const pr = db().get<ProductRow>('SELECT * FROM dp_products WHERE id = ?', distinct[0]!.product_id)!;
    return { product: pr.key, port: distinct[0]!.name, version: distinct[0]!.version };
  };
  const inputs = [
    ...(Array.isArray(raw.inputPorts) ? raw.inputPorts.filter(isObj) : []).map((p) => ({ p, contract: str(p.contractId) ?? null })),
    ...(Array.isArray(custom.get('inputsWithoutContract')) ? (custom.get('inputsWithoutContract') as unknown[]).filter(isObj) : []).map((p) => ({
      p,
      contract: null,
    })),
  ];
  for (const { p, contract } of inputs) {
    const name = str(p.name);
    if (!name) continue;
    const pc = customOf(p.customProperties);
    const port: Obj = { direction: 'input', name, version: str(p.version) ?? '' };
    const sourceText = str(pc.get('source')) ?? str(p.source);
    const parsed = sourceText ? parseSource(sourceText) : null;
    const fromContract = !parsed && contract ? contractSource(contract) : null;
    if (parsed) port.source = parsed;
    else if (fromContract) port.source = fromContract;
    else if (sourceText) port.source = { text: sourceText.slice(0, 500) };
    else if (contract) port.source = { text: `ODCS contract ${contract}`.slice(0, 500) };
    const objects = pc.get('dataObjects');
    if (Array.isArray(objects)) port.data_objects = objects.filter((o): o is string => typeof o === 'string');
    ports.push(port);
  }
  if (ports.length) product.ports = ports;
  if (Array.isArray(raw.managementPorts) && raw.managementPorts.length)
    warnings.push(`ODPS ${key}: management ports are Steward's own pages – the document's are not kept`);
  return { file: { version: 1, data_product: product }, warnings, problems };
}

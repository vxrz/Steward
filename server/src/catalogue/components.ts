import fs from 'node:fs';
import { EnvHttpProxyAgent } from 'undici';
import { z } from 'zod';
import {
  BRAND,
  boundedRecord,
  COMPONENT_LIMITS,
  COMPONENT_TYPES,
  type ApplicationComponent,
  type ApplicationStackItem,
  type ComponentType,
  type SbomChange,
  type SbomFormat,
  type SbomPreview,
  type StackEntry,
  type StackLifecycle,
  type StackProduct,
  type StackSource,
  type NamespaceReadout,
  type RepositoryReadout,
  type TopicReadout,
  type AwsReadout,
  type SnowflakeReadout,
  type DtrackReadout,
  DTRACK_KIND,
  DTRACK_PROJECT_RE,
  SNOWFLAKE_KIND,
  SNOWFLAKE_NAME_RE,
  AWS_KIND,
  AWS_TAG_VALUE_RE,
  KAFKA_KIND,
  KAFKA_TOPIC_RE,
  isGitPlatformKind,
  REPOSITORY_PATH_RE,
} from '@sm/shared';
import { db } from '../db.js';
import { audit } from '../audit.js';
import { currentUser, type AuthUser } from '../auth/context.js';
import { assertOutboundAllowed, guardedLookup } from '../platforms/outbound.js';
import { outboundContext } from '../platforms/policyContext.js';
import { forbid, me, catalogueVisibleNow } from '../records/access.js';
import { httpUrl } from '../records/links.js';
import { HttpError, newId, nowIso, parseJson } from '../util.js';
import { assetPath } from '../reports/pdf/assets.js';
import { lifecycleOf, lifecycleSettings, releasesOf } from './lifecycle.js';
import { environmentList, environmentValue, isProduction, rankOf } from './environments.js';
import { systemLinksOf } from './systems.js';
import { ownerProblem } from '../monitors/platforms.js';

/**
 * Components of an application (#103): what it consists of – repositories, container images, Kafka topics,
 * Snowflake databases, cloud accounts, Kubernetes namespaces, platforms, anything else – and the tech stack of
 * each one: endoflife.date products with the version in use, entered by hand or read from an SBOM (CycloneDX or
 * SPDX JSON). Only products endoflife.date knows are kept (operating systems, runtimes, databases, major
 * frameworks); libraries stay out. Entries entered by hand win over the SBOM.
 *
 * Permissions follow the application: everyone who can sign in reads them, whoever may edit the application
 * changes them. Every change is audited on the application.
 */

// ---------- the endoflife.date product list ----------

interface ProductRecord extends StackProduct {
  aliases: string[];
  purls: string[];
  cpes: string[];
}

interface ProductIndex {
  list: ProductRecord[];
  byId: Map<string, ProductRecord>;
  byPurl: Map<string, string>;
  byCpe: Map<string, string>;
  byName: Map<string, string>;
  source: string;
}

let index: ProductIndex | null = null;

/** Lower case type/namespace/name of a package URL, without version, qualifiers and subpath (pkg:npm/%40a/b@1?x#y → pkg:npm/@a/b). */
export function purlKey(purl: string): string | null {
  const s = purl.trim();
  if (!/^pkg:[a-z0-9.+-]+\//i.test(s)) return null;
  let rest = s.split('#')[0]!.split('?')[0]!;
  // the version follows the last "@" after the name (a namespace like %40angular is encoded)
  const at = rest.lastIndexOf('@');
  if (at > rest.indexOf('/')) rest = rest.slice(0, at);
  try {
    rest = decodeURIComponent(rest);
  } catch {
    /* keep it encoded */
  }
  return rest.toLowerCase().replace(/\/+$/, '');
}

/** part:vendor:product of a CPE 2.3 (cpe:2.3:a:nodejs:node.js:…) or 2.2 URI (cpe:/a:nodejs:node.js:…). */
export function cpeKey(cpe: string): string | null {
  const s = cpe.trim().toLowerCase();
  const parts = s.startsWith('cpe:2.3:') ? s.slice(8).split(':') : s.startsWith('cpe:/') ? s.slice(5).split(':') : null;
  if (!parts || parts.length < 3 || !parts[0] || !parts[1] || !parts[2] || parts[1] === '*' || parts[2] === '*') return null;
  return `${parts[0]}:${parts[1]}:${parts[2]}`;
}

const nameKey = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

function loadIndex(): ProductIndex {
  if (index) return index;
  let data: { source?: string; products?: ProductRecord[] } = {};
  try {
    data = JSON.parse(fs.readFileSync(assetPath('endoflife/products.json'), 'utf8')) as typeof data;
  } catch {
    throw new HttpError(500, 'The endoflife.date product list is missing (server/assets/endoflife/products.json)', 'STACK_PRODUCTS_MISSING');
  }
  const list = (data.products ?? []).filter((p) => typeof p?.id === 'string');
  const byId = new Map(list.map((p) => [p.id, p]));
  const byPurl = new Map<string, string>();
  const byCpe = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const p of list) {
    for (const u of p.purls ?? []) {
      const k = purlKey(u);
      if (k && !byPurl.has(k)) byPurl.set(k, p.id);
    }
    for (const c of p.cpes ?? []) {
      const k = cpeKey(c);
      if (k && !byCpe.has(k)) byCpe.set(k, p.id);
    }
    for (const n of [p.id, p.label, ...(p.aliases ?? [])]) if (n && !byName.has(nameKey(n))) byName.set(nameKey(n), p.id);
  }
  index = { list, byId, byPurl, byCpe, byName, source: data.source ?? '' };
  return index;
}

/** Tests: read the list again (e.g. after SM_ASSETS_DIR changed). */
export function resetProductIndex(): void {
  index = null;
}

/** The products offered for a tech stack (autocomplete). */
export function stackProducts(): { source: string; products: StackProduct[] } {
  me();
  const i = loadIndex();
  return { source: i.source, products: i.list.map((p) => ({ id: p.id, label: p.label, category: p.category, cycles: p.cycles ?? [] })) };
}

const labelOf = (product: string) => loadIndex().byId.get(product)?.label ?? product;
/** Is this an endoflife.date product Steward knows? */
export const isKnownProduct = (product: string): boolean => loadIndex().byId.has(product);

/** The name of a product of the list (its id when it is no longer on it); for jobs without a signed-in user. */
export const productLabel = labelOf;

// ---------- input ----------

const stackEntryInput = z
  .object({
    product: z.string().trim().min(1).max(100),
    version: z.string().trim().max(COMPONENT_LIMITS.version).default(''),
  })
  .strict();

export const componentInput = z
  .object({
    type: z.enum(COMPONENT_TYPES),
    name: z.string().trim().min(1).max(COMPONENT_LIMITS.name),
    url: z.union([httpUrl, z.literal('')]).default(''),
    note: z.string().max(COMPONENT_LIMITS.note).default(''),
    /** The environment (#129); empty: all environments / not specific to one */
    environment: environmentValue.default(''),
    /** Kubernetes namespace (#111): the cluster, a platform of kind kubernetes; repository (#107): its Git platform (missing: unchanged) */
    platformId: z.string().trim().min(1).max(100).nullable().optional(),
    /** The whole stack of the component (missing: unchanged). Entries that keep product and version keep their source; others count as entered by hand. */
    stack: z.array(stackEntryInput).max(COMPONENT_LIMITS.stackPerComponent).optional(),
    /** Its Dependency-Track project (#119), any type: name@version, name@latest or the UUID (missing: unchanged, null: none) */
    dependencyTrack: z
      .object({ platformId: z.string().trim().min(1).max(100), project: z.string().trim().min(3).max(360) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type ComponentInput = z.infer<typeof componentInput>;

export const sbomInput = z
  .object({
    /** The SBOM: its JSON text or the parsed document */
    sbom: z.union([z.string().max(COMPONENT_LIMITS.sbomBytes), boundedRecord(z.unknown(), 200)]).optional(),
    /** … or where to fetch it (https, outbound policy applies) */
    url: httpUrl.optional(),
  })
  .strict()
  .refine((b) => (b.sbom === undefined) !== (b.url === undefined), { message: 'Give either the SBOM or its URL' });
export type SbomInput = z.infer<typeof sbomInput>;

// ---------- reading ----------

interface ComponentRow {
  id: string;
  application_id: string;
  type: string;
  name: string;
  url: string;
  note: string;
  environment: string;
  sbom_format: string | null;
  sbom_name: string | null;
  sbom_imported_at: string | null;
  sbom_imported_by: string | null;
  platform_id?: string | null;
  cluster_state?: string | null;
  repo_state?: string | null;
  topic_state?: string | null;
  aws_state?: string | null;
  dt_platform_id?: string | null;
  dt_project?: string | null;
  dt_state?: string | null;
  snowflake_state?: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}

export interface StackRow {
  component_id?: string;
  system_id?: string;
  product: string;
  version: string;
  source: string;
  sbom_ref: string;
  set_at: string;
  set_by: string;
}

/** Whose stack: a component (component_stack) or a system (system_stack, #129). */
export type StackHolder = { table: 'component_stack'; key: 'component_id'; id: string } | { table: 'system_stack'; key: 'system_id'; id: string };
export const componentHolder = (id: string): StackHolder => ({ table: 'component_stack', key: 'component_id', id });
export const systemHolder = (id: string): StackHolder => ({ table: 'system_stack', key: 'system_id', id });

export const toEntry = (r: StackRow, releases: ReturnType<typeof releasesOf>, warnDays: number): StackEntry => ({
  product: r.product,
  label: labelOf(r.product),
  version: r.version,
  source: r.source as StackSource,
  sbomRef: r.sbom_ref,
  setAt: r.set_at,
  setBy: r.set_by,
  lifecycle: lifecycleOf(r.product, r.version, releases, warnDays),
});

/** The stack of the components of one application, by component, with the end of life of each entry (#104). */
function stackOf(appId: string): Map<string, StackEntry[]> {
  const out = new Map<string, StackEntry[]>();
  const rows = db().all<StackRow>(
    'SELECT cs.* FROM component_stack cs JOIN application_components c ON c.id = cs.component_id WHERE c.application_id = ? ORDER BY cs.product',
    appId,
  );
  const releases = releasesOf([...new Set(rows.map((r) => r.product))]);
  const { warnDays } = lifecycleSettings();
  for (const r of rows) out.set(r.component_id!, [...(out.get(r.component_id!) ?? []), toEntry(r, releases, warnDays)]);
  return out;
}

const typeOrder = (t: string) => COMPONENT_TYPES.indexOf(t as ComponentType);

function toComponent(r: ComponentRow, stack: StackEntry[]): ApplicationComponent {
  return {
    id: r.id,
    type: r.type as ComponentType,
    name: r.name,
    url: r.url,
    note: r.note,
    environment: r.environment ?? '',
    stack,
    sbom:
      r.sbom_format && r.sbom_imported_at
        ? { format: r.sbom_format as SbomFormat, name: r.sbom_name ?? '', importedAt: r.sbom_imported_at, importedBy: r.sbom_imported_by ?? '' }
        : null,
    ...(r.type === 'kubernetes-namespace'
      ? { platformId: r.platform_id ?? null, cluster: parseJson<NamespaceReadout | null>(r.cluster_state ?? null, null) }
      : r.type === 'repository'
        ? { platformId: r.platform_id ?? null, repository: parseJson<RepositoryReadout | null>(r.repo_state ?? null, null) }
        : r.type === 'kafka-topic'
          ? { platformId: r.platform_id ?? null, topic: parseJson<TopicReadout | null>(r.topic_state ?? null, null) }
          : r.type === 'cloud-account'
            ? { platformId: r.platform_id ?? null, aws: parseJson<AwsReadout | null>(r.aws_state ?? null, null) }
            : r.type === 'snowflake-database'
              ? { platformId: r.platform_id ?? null, snowflake: parseJson<SnowflakeReadout | null>(r.snowflake_state ?? null, null) }
              : {}),
    dependencyTrack:
      r.dt_platform_id && r.dt_project
        ? { platformId: r.dt_platform_id, project: r.dt_project, readout: parseJson<DtrackReadout | null>(r.dt_state ?? null, null) }
        : null,
    createdAt: r.created_at,
    createdBy: r.created_by,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

/** The components of an application, by type (as listed in COMPONENT_TYPES) and name. */
export function componentsOf(appId: string): ApplicationComponent[] {
  const rows = db()
    .all<ComponentRow>('SELECT * FROM application_components WHERE application_id = ?', appId)
    .sort((a, b) => typeOrder(a.type) - typeOrder(b.type) || a.name.localeCompare(b.name) || rankOf(a.environment) - rankOf(b.environment));
  const stacks = stackOf(appId);
  return rows.map((r) => toComponent(r, stacks.get(r.id) ?? []));
}

/** Number of components per application. */
export function componentCounts(): Map<string, number> {
  return new Map(
    db()
      .all<{ id: string; n: number }>('SELECT application_id AS id, COUNT(*) AS n FROM application_components GROUP BY application_id')
      .map((c) => [c.id, Number(c.n)]),
  );
}

/**
 * The stack of all components and systems of an application together: one entry per product and version, with the
 * components and systems using it and their environments (production first).
 */
export function stackRollup(
  components: ApplicationComponent[],
  systems: { systemId: string; name: string; environment: string; stack: StackEntry[] }[] = [],
): ApplicationStackItem[] {
  const list = environmentList();
  const out = new Map<string, ApplicationStackItem>();
  const itemOf = (s: StackEntry): ApplicationStackItem => {
    const k = `${s.product}\u0000${s.version}`;
    const item = out.get(k) ?? {
      product: s.product,
      label: s.label,
      version: s.version,
      lifecycle: s.lifecycle,
      components: [],
      systems: [],
      environments: [],
      production: false,
    };
    out.set(k, item);
    return item;
  };
  const addEnv = (item: ApplicationStackItem, env: string) => {
    if (!item.environments.includes(env)) item.environments.push(env);
    if (isProduction(env, list)) item.production = true;
  };
  for (const c of components)
    for (const s of c.stack) {
      const item = itemOf(s);
      item.components.push({ id: c.id, name: c.name, type: c.type, environment: c.environment });
      addEnv(item, c.environment);
    }
  for (const x of systems)
    for (const s of x.stack) {
      const item = itemOf(s);
      item.systems.push({ id: x.systemId, name: x.name, environment: x.environment });
      addEnv(item, x.environment);
    }
  for (const item of out.values()) item.environments.sort((a, b) => rankOf(a, list) - rankOf(b, list) || a.localeCompare(b));
  return [...out.values()].sort((a, b) => a.label.localeCompare(b.label) || b.version.localeCompare(a.version, undefined, { numeric: true }));
}

// ---------- changing ----------

type AppRow = { id: string; name: string; owners: string; archived: number };

/**
 * The application, when the user may change it and it is not archived. `canEdit` is the application module's
 * check (passed in to keep the two modules free of import cycles).
 */
function editableApp(appId: string, canEdit: (u: AuthUser | null, r: Pick<AppRow, 'id' | 'owners'>) => boolean, what: string): AppRow {
  const a = db().get<AppRow>('SELECT id, name, owners, archived FROM applications WHERE id = ?', appId);
  if (!a) throw new HttpError(404, `Application ${appId} not found`, 'APPLICATION_NOT_FOUND', { id: appId });
  if (!canEdit(currentUser(), a)) forbid(what, 'changeApplication');
  if (a.archived) throw new HttpError(409, `Application "${a.name}" is archived`, 'APPLICATION_ARCHIVED', { name: a.name });
  return a;
}

/**
 * The platform a component is read from: the cluster of a namespace (a platform of kind kubernetes, #111) or the Git
 * platform of a repository (github, gitlab, forgejo, #107) – one the user may use. Other types have none.
 */
function clusterOf(input: ComponentInput, u: AuthUser, current: string | null): string | null {
  if (
    input.type !== 'kubernetes-namespace' &&
    input.type !== 'repository' &&
    input.type !== 'kafka-topic' &&
    input.type !== 'cloud-account' &&
    input.type !== 'snowflake-database'
  )
    return null;
  const id = input.platformId === undefined ? current : input.platformId;
  if (id && input.type === 'repository' && (!REPOSITORY_PATH_RE.test(input.name) || input.name.split('/').some((x) => x === '.' || x === '..')))
    throw new HttpError(400, 'The repository path is owner/repository (GitLab: group/project)', 'COMPONENT_REPOSITORY_PATH', { path: input.name });
  if (id && input.type === 'kafka-topic' && !KAFKA_TOPIC_RE.test(input.name))
    throw new HttpError(400, 'A Kafka topic name has letters, digits, ".", "_" and "-" (at most 249)', 'KAFKA_TOPIC_NAME', { name: input.name.slice(0, 100) });
  if (id && input.type === 'cloud-account' && !AWS_TAG_VALUE_RE.test(input.name))
    throw new HttpError(
      400,
      'The name of an AWS cloud account component is the value of the application tag (letters, digits, spaces and _ . : / = + - @)',
      'COMPONENT_AWS_TAG',
      {
        name: input.name.slice(0, 100),
      },
    );
  if (id && input.type === 'snowflake-database' && !SNOWFLAKE_NAME_RE.test(input.name))
    throw new HttpError(400, 'A Snowflake database name has letters, digits, _ and $ and starts with a letter or _', 'SNOWFLAKE_NAME', {
      name: input.name.slice(0, 100),
    });
  if (!id || id === current) return id ?? null;
  const p = db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', id);
  if (input.type === 'snowflake-database') {
    if (p?.kind !== SNOWFLAKE_KIND || ownerProblem(u.username, id))
      throw new HttpError(400, 'Choose a Snowflake platform you may use', 'COMPONENT_SNOWFLAKE_PLATFORM', { id });
    return id;
  }
  if (input.type === 'cloud-account') {
    if (p?.kind !== AWS_KIND || ownerProblem(u.username, id)) throw new HttpError(400, 'Choose an AWS platform you may use', 'COMPONENT_AWS_PLATFORM', { id });
    return id;
  }
  if (input.type === 'kafka-topic') {
    if (p?.kind !== KAFKA_KIND || ownerProblem(u.username, id))
      throw new HttpError(400, 'Choose a Kafka platform you may use', 'COMPONENT_TOPIC_PLATFORM', { id });
    return id;
  }
  if (input.type === 'repository') {
    if (!isGitPlatformKind(p?.kind) || ownerProblem(u.username, id))
      throw new HttpError(400, 'Choose a GitHub, GitLab or Forgejo/Gitea platform you may use', 'COMPONENT_REPOSITORY_PLATFORM', { id });
    return id;
  }
  if (p?.kind !== 'kubernetes' || ownerProblem(u.username, id))
    throw new HttpError(400, 'Choose a Kubernetes platform you may use', 'COMPONENT_CLUSTER', { id });
  return id;
}

/** The Dependency-Track link of a component: checked (platform kind, may use it, project reference) or null. */
function dtrackOf(
  input: ComponentInput,
  u: AuthUser,
  current: { platformId: string | null; project: string | null },
): { platformId: string | null; project: string | null } {
  if (input.dependencyTrack === undefined) return current;
  if (input.dependencyTrack === null) return { platformId: null, project: null };
  const { platformId, project } = input.dependencyTrack;
  if (!DTRACK_PROJECT_RE.test(project))
    throw new HttpError(400, 'The Dependency-Track project is name@version, name@latest or its UUID', 'COMPONENT_DTRACK_PROJECT', {
      project: project.slice(0, 100),
    });
  if (platformId !== current.platformId) {
    const p = db().get<{ kind: string }>('SELECT kind FROM platforms WHERE id = ?', platformId);
    if (p?.kind !== DTRACK_KIND || ownerProblem(u.username, platformId))
      throw new HttpError(400, 'Choose a Dependency-Track platform you may use', 'COMPONENT_DTRACK_PLATFORM', { id: platformId });
  }
  return { platformId, project };
}

function componentRow(appId: string, componentId: string): ComponentRow {
  const r = db().get<ComponentRow>('SELECT * FROM application_components WHERE id = ? AND application_id = ?', componentId, appId);
  if (!r) throw new HttpError(404, 'This component does not belong to the application', 'COMPONENT_NOT_FOUND', { id: componentId });
  return r;
}

export function requireKnownProducts(stack: { product: string }[]): void {
  const i = loadIndex();
  const seen = new Set<string>();
  for (const s of stack) {
    if (!i.byId.has(s.product))
      throw new HttpError(400, `"${s.product}" is not a product endoflife.date knows`, 'STACK_PRODUCT_UNKNOWN', { product: s.product });
    if (seen.has(s.product)) throw new HttpError(400, `"${labelOf(s.product)}" is listed twice`, 'STACK_PRODUCT_TWICE', { product: labelOf(s.product) });
    seen.add(s.product);
  }
}

export interface StackDiff {
  added: { product: string; version: string }[];
  changed: { product: string; from: string; to: string }[];
  removed: { product: string; version: string }[];
}

export const stackSummary = (d: StackDiff): string =>
  [
    ...d.added.map((x) => `+${labelOf(x.product)} ${x.version}`.trim()),
    ...d.changed.map((x) => `${labelOf(x.product)} ${x.from || '?'} → ${x.to || '?'}`),
    ...d.removed.map((x) => `−${labelOf(x.product)}`),
  ].join(', ');

/** Replaces the stack of a component or system with these entries (inside a transaction). Unchanged entries keep their source. */
export function writeStack(h: StackHolder, wanted: { product: string; version: string }[], u: AuthUser): StackDiff {
  const before = new Map(
    db()
      .all<StackRow>(`SELECT * FROM ${h.table} WHERE ${h.key} = ?`, h.id)
      .map((r) => [r.product, r]),
  );
  const diff: StackDiff = { added: [], changed: [], removed: [] };
  const now = nowIso();
  for (const s of wanted) {
    const old = before.get(s.product);
    if (old && old.version === s.version) continue;
    if (old) {
      db().run(
        `UPDATE ${h.table} SET version = ?, source = 'manual', sbom_ref = '', set_at = ?, set_by = ? WHERE ${h.key} = ? AND product = ?`,
        s.version,
        now,
        u.username,
        h.id,
        s.product,
      );
      diff.changed.push({ product: s.product, from: old.version, to: s.version });
    } else {
      db().run(
        `INSERT INTO ${h.table} (${h.key}, product, version, source, sbom_ref, set_at, set_by) VALUES (?, ?, ?, 'manual', '', ?, ?)`,
        h.id,
        s.product,
        s.version,
        now,
        u.username,
      );
      diff.added.push({ product: s.product, version: s.version });
    }
  }
  const keep = new Set(wanted.map((s) => s.product));
  for (const [product, old] of before)
    if (!keep.has(product)) {
      db().run(`DELETE FROM ${h.table} WHERE ${h.key} = ? AND product = ?`, h.id, product);
      diff.removed.push({ product, version: old.version });
    }
  return diff;
}

/** The stack of one component or system, with the end of life of each entry. */
export function stackOfHolder(h: StackHolder): StackEntry[] {
  const rows = db().all<StackRow>(`SELECT * FROM ${h.table} WHERE ${h.key} = ? ORDER BY product`, h.id);
  const releases = releasesOf([...new Set(rows.map((r) => r.product))]);
  const { warnDays } = lifecycleSettings();
  return rows.map((r) => toEntry(r, releases, warnDays));
}

const touchApplication = (id: string, u: AuthUser) => db().run('UPDATE applications SET updated_at = ?, updated_by = ? WHERE id = ?', nowIso(), u.username, id);

type CanEdit = (u: AuthUser | null, r: Pick<AppRow, 'id' | 'owners'>) => boolean;

export function addComponent(appId: string, input: ComponentInput, canEdit: CanEdit): ApplicationComponent {
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const n = Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM application_components WHERE application_id = ?', appId)?.n ?? 0);
  if (n >= COMPONENT_LIMITS.perApplication)
    throw new HttpError(409, `An application has at most ${COMPONENT_LIMITS.perApplication} components`, 'COMPONENT_LIMIT', {
      max: COMPONENT_LIMITS.perApplication,
    });
  if (
    db().get(
      'SELECT 1 FROM application_components WHERE application_id = ? AND type = ? AND lower(name) = lower(?) AND environment = ?',
      appId,
      input.type,
      input.name,
      input.environment,
    )
  )
    throw new HttpError(409, `The application has a ${input.type} "${input.name}" already`, 'COMPONENT_EXISTS', { name: input.name });
  if (input.stack) requireKnownProducts(input.stack);
  const cluster = clusterOf(input, u, null);
  const dt = dtrackOf(input, u, { platformId: null, project: null });
  const id = newId('cmp_');
  const now = nowIso();
  db().tx(() => {
    db().run(
      `INSERT INTO application_components (id, application_id, type, name, url, note, environment, platform_id, dt_platform_id, dt_project, created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      appId,
      input.type,
      input.name,
      input.url,
      input.note,
      input.environment,
      cluster,
      dt.platformId,
      dt.project,
      now,
      u.username,
      now,
      u.username,
    );
    const diff = input.stack ? writeStack(componentHolder(id), input.stack, u) : { added: [], changed: [], removed: [] };
    touchApplication(appId, u);
    audit({
      action: 'application.component_added',
      entityType: 'application',
      entityId: appId,
      summary: `Component ${input.type} "${input.name}" added to application "${a.name}"${diff.added.length ? ` (stack: ${stackSummary(diff)})` : ''}`,
      details: { componentId: id, type: input.type, name: input.name, url: input.url, environment: input.environment, stack: diff.added },
    });
  });
  return componentsOf(appId).find((c) => c.id === id)!;
}

export function updateComponent(appId: string, componentId: string, input: ComponentInput, canEdit: CanEdit): ApplicationComponent {
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const cur = componentRow(appId, componentId);
  if (
    db().get(
      'SELECT 1 FROM application_components WHERE application_id = ? AND type = ? AND lower(name) = lower(?) AND environment = ? AND id <> ?',
      appId,
      input.type,
      input.name,
      input.environment,
      componentId,
    )
  )
    throw new HttpError(409, `The application has a ${input.type} "${input.name}" already`, 'COMPONENT_EXISTS', { name: input.name });
  if (input.stack) requireKnownProducts(input.stack);
  const cluster = clusterOf(input, u, cur.platform_id ?? null);
  const curDt = { platformId: cur.dt_platform_id ?? null, project: cur.dt_project ?? null };
  const dt = dtrackOf(input, u, curDt);
  const dtChanged = dt.platformId !== curDt.platformId || dt.project !== curDt.project;
  const fields = [
    ...(['type', 'name', 'url', 'note', 'environment'] as const).filter((k) => input[k] !== (cur[k] ?? '')),
    ...(cluster !== (cur.platform_id ?? null)
      ? ([input.type === 'repository' || input.type === 'cloud-account' || input.type === 'snowflake-database' ? 'platform' : 'cluster'] as const)
      : []),
    ...(dtChanged ? (['dependencyTrack'] as const) : []),
  ];
  db().tx(() => {
    const diff = input.stack ? writeStack(componentHolder(componentId), input.stack, u) : { added: [], changed: [], removed: [] };
    const stackChanged = diff.added.length + diff.changed.length + diff.removed.length > 0;
    if (!fields.length && !stackChanged) return;
    db().run(
      `UPDATE application_components SET type = ?, name = ?, url = ?, note = ?, environment = ?, platform_id = ?, dt_platform_id = ?, dt_project = ?,
       ${dtChanged ? 'dt_state = NULL,' : ''} updated_at = ?, updated_by = ? WHERE id = ?`,
      input.type,
      input.name,
      input.url,
      input.note,
      input.environment,
      cluster,
      dt.platformId,
      dt.project,
      nowIso(),
      u.username,
      componentId,
    );
    touchApplication(appId, u);
    audit({
      action: 'application.component_changed',
      entityType: 'application',
      entityId: appId,
      summary: `Component ${input.type} "${input.name}" of application "${a.name}" changed (${[...fields, ...(stackChanged ? [`stack: ${stackSummary(diff)}`] : [])].join(', ')})`,
      details: {
        componentId,
        changes: fields,
        ...(fields.includes('name') ? { name: { old: cur.name, new: input.name } } : {}),
        ...(fields.includes('type') ? { type: { old: cur.type, new: input.type } } : {}),
        ...(fields.includes('environment') ? { environment: { old: cur.environment ?? '', new: input.environment } } : {}),
        ...(stackChanged ? { stack: diff } : {}),
      },
    });
  });
  return componentsOf(appId).find((c) => c.id === componentId)!;
}

export function removeComponent(appId: string, componentId: string, canEdit: CanEdit): void {
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const cur = componentRow(appId, componentId);
  const stack = db().all<StackRow>('SELECT * FROM component_stack WHERE component_id = ?', componentId);
  const credentials = db()
    .all<{ id: string }>("SELECT id FROM credentials WHERE belongs_kind = 'component' AND belongs_id = ?", componentId)
    .map((c) => c.id);
  db().tx(() => {
    db().run('DELETE FROM component_stack WHERE component_id = ?', componentId);
    db().run('DELETE FROM application_components WHERE id = ?', componentId);
    // credentials of the component now belong to its application (#143)
    if (credentials.length)
      db().run("UPDATE credentials SET belongs_kind = 'application', belongs_id = ? WHERE belongs_kind = 'component' AND belongs_id = ?", appId, componentId);
    touchApplication(appId, u);
    audit({
      action: 'application.component_removed',
      entityType: 'application',
      entityId: appId,
      summary: `Component ${cur.type} "${cur.name}" removed from application "${a.name}"`,
      details: {
        componentId,
        type: cur.type,
        name: cur.name,
        stack: stack.map((s) => ({ product: s.product, version: s.version, source: s.source })),
        ...(credentials.length ? { credentialsMovedToApplication: credentials } : {}),
      },
    });
  });
}

// ---------- SBOM ----------

interface SbomItem {
  name: string;
  version: string;
  purl: string;
  cpes: string[];
  /** An operating system (CycloneDX type operating-system, SPDX purpose OPERATING-SYSTEM): matched by name too */
  os: boolean;
}

interface ParsedSbom {
  format: SbomFormat;
  name: string;
  items: SbomItem[];
}

const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function tooMany(): never {
  throw new HttpError(400, `The SBOM lists more than ${COMPONENT_LIMITS.sbomComponents} components – Steward reads at most that many`, 'SBOM_TOO_MANY', {
    max: COMPONENT_LIMITS.sbomComponents,
  });
}

/** Reads a CycloneDX (JSON, 1.2 or newer) or SPDX (JSON, 2.2 or newer) document. */
export function parseSbom(raw: unknown): ParsedSbom {
  let doc: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > COMPONENT_LIMITS.sbomBytes)
      throw new HttpError(400, `The SBOM is larger than ${COMPONENT_LIMITS.sbomBytes / 1024 / 1024} MB`, 'SBOM_TOO_LARGE', {
        max: COMPONENT_LIMITS.sbomBytes / 1024 / 1024,
      });
    try {
      doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      throw new HttpError(400, 'The SBOM is not valid JSON – Steward reads CycloneDX and SPDX in JSON', 'SBOM_INVALID');
    }
  }
  const d = obj(doc);
  if (d && str(d.bomFormat).toLowerCase() === 'cyclonedx') return parseCycloneDx(d);
  if (d && typeof d.spdxVersion === 'string') return parseSpdx(d);
  throw new HttpError(400, 'This is neither a CycloneDX nor an SPDX document (JSON)', 'SBOM_INVALID');
}

function cdxItem(c: Record<string, unknown>): SbomItem {
  const cpes = [str(c.cpe)].filter(Boolean);
  return { name: str(c.name, 200), version: str(c.version, 200), purl: str(c.purl, 1000), cpes, os: str(c.type) === 'operating-system' };
}

function parseCycloneDx(d: Record<string, unknown>): ParsedSbom {
  const items: SbomItem[] = [];
  const meta = obj(obj(d.metadata)?.component);
  // nested components (assemblies), iteratively: no deep recursion on hostile input
  const queue: unknown[] = [...arr(d.components)];
  if (meta) queue.push(...arr(meta.components));
  while (queue.length) {
    const c = obj(queue.pop());
    if (!c) continue;
    if (items.length >= COMPONENT_LIMITS.sbomComponents) tooMany();
    items.push(cdxItem(c));
    for (const sub of arr(c.components)) queue.push(sub);
  }
  if (meta) items.push(cdxItem(meta));
  const name = meta ? [str(meta.name, 200), str(meta.version, 100)].filter(Boolean).join(' ') : '';
  return { format: 'cyclonedx', name, items };
}

function parseSpdx(d: Record<string, unknown>): ParsedSbom {
  const items: SbomItem[] = [];
  for (const p of arr(d.packages)) {
    const o = obj(p);
    if (!o) continue;
    if (items.length >= COMPONENT_LIMITS.sbomComponents) tooMany();
    let purl = '';
    const cpes: string[] = [];
    for (const r of arr(o.externalRefs)) {
      const ref = obj(r);
      if (!ref) continue;
      const type = str(ref.referenceType).toLowerCase();
      const loc = str(ref.referenceLocator, 1000);
      if (type === 'purl' && !purl) purl = loc;
      else if (type.startsWith('cpe')) cpes.push(loc);
    }
    items.push({
      name: str(o.name, 200),
      version: str(o.versionInfo, 200),
      purl,
      cpes,
      os: str(o.primaryPackagePurpose).toUpperCase().replace(/_/g, '-') === 'OPERATING-SYSTEM',
    });
  }
  return { format: 'spdx', name: str(d.name, 200), items };
}

/**
 * The SBOM's items that endoflife.date knows, one per product: package URL first, then CPE, then (operating
 * systems only) the name. Everything else – libraries – stays out. With several items of one product, the
 * first one with a version counts.
 */
export function matchSbom(items: SbomItem[]): Map<string, { version: string; ref: string }> {
  const i = loadIndex();
  const out = new Map<string, { version: string; ref: string }>();
  for (const it of items) {
    let product: string | undefined;
    let ref = '';
    const pk = it.purl ? purlKey(it.purl) : null;
    if (pk && i.byPurl.has(pk)) ((product = i.byPurl.get(pk)), (ref = pk));
    if (!product)
      for (const c of it.cpes) {
        const ck = cpeKey(c);
        if (ck && i.byCpe.has(ck)) {
          product = i.byCpe.get(ck);
          ref = `cpe:${ck}`;
          break;
        }
      }
    if (!product && it.os && it.name && i.byName.has(nameKey(it.name))) ((product = i.byName.get(nameKey(it.name))), (ref = it.name));
    if (!product) continue;
    const version = it.version.trim().slice(0, COMPONENT_LIMITS.version);
    const prev = out.get(product);
    if (!prev || (!prev.version && version)) out.set(product, { version, ref: ref.slice(0, 300) });
  }
  return out;
}

export function planSbom(h: StackHolder, found: Map<string, { version: string; ref: string }>): SbomChange[] {
  const before = new Map(
    db()
      .all<StackRow>(`SELECT * FROM ${h.table} WHERE ${h.key} = ?`, h.id)
      .map((r) => [r.product, r]),
  );
  const changes: SbomChange[] = [];
  for (const [product, f] of found) {
    const old = before.get(product);
    const base = { product, label: labelOf(product), sbomRef: f.ref };
    if (!old) changes.push({ ...base, action: 'add', version: f.version, other: null });
    else if (old.source === 'manual')
      changes.push(
        old.version === f.version
          ? { ...base, action: 'keep', version: old.version, other: null }
          : { ...base, action: 'manual', version: old.version, other: f.version },
      );
    else if (old.version === f.version) changes.push({ ...base, action: 'keep', version: f.version, other: null });
    else changes.push({ ...base, action: 'update', version: f.version, other: old.version });
  }
  for (const [product, old] of before)
    if (!found.has(product) && old.source === 'sbom')
      changes.push({ product, label: labelOf(product), action: 'remove', version: old.version, other: null, sbomRef: old.sbom_ref });
  const order = { add: 0, update: 1, remove: 2, manual: 3, keep: 4 } as const;
  return changes.sort((a, b) => order[a.action] - order[b.action] || a.label.localeCompare(b.label));
}

/** Writes the planned SBOM changes into a stack (inside a transaction). */
export function applySbomChanges(h: StackHolder, changes: SbomChange[], u: AuthUser, now: string): void {
  for (const c of changes) {
    if (c.action === 'add')
      db().run(
        `INSERT INTO ${h.table} (${h.key}, product, version, source, sbom_ref, set_at, set_by) VALUES (?, ?, ?, 'sbom', ?, ?, ?)`,
        h.id,
        c.product,
        c.version,
        c.sbomRef,
        now,
        u.username,
      );
    else if (c.action === 'update')
      db().run(
        `UPDATE ${h.table} SET version = ?, sbom_ref = ?, set_at = ?, set_by = ? WHERE ${h.key} = ? AND product = ?`,
        c.version,
        c.sbomRef,
        now,
        u.username,
        h.id,
        c.product,
      );
    else if (c.action === 'remove') db().run(`DELETE FROM ${h.table} WHERE ${h.key} = ? AND product = ?`, h.id, c.product);
  }
}

const sbomDispatcher = new EnvHttpProxyAgent({ connect: { lookup: guardedLookup }, requestTls: { lookup: guardedLookup } } as never);

/** Fetches an SBOM: outbound policy, no redirects, at most COMPONENT_LIMITS.sbomBytes, 30 seconds. */
async function fetchSbom(url: string): Promise<string> {
  await assertOutboundAllowed(url, outboundContext());
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: 'application/vnd.cyclonedx+json, application/spdx+json, application/json;q=0.9, */*;q=0.1', 'user-agent': BRAND.slug },
      redirect: 'manual',
      dispatcher: sbomDispatcher,
      signal: AbortSignal.timeout(30_000),
    } as RequestInit);
  } catch (e) {
    const err = e as Error & { cause?: Error & { code?: string } };
    if (err.cause?.code === 'ESSRFBLOCKED') throw new HttpError(403, err.cause.message, 'SBOM_FETCH_BLOCKED');
    throw new HttpError(502, 'The SBOM could not be fetched (the host is not reachable)', 'SBOM_FETCH_FAILED');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(
      502,
      `The SBOM could not be fetched (HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ', redirects are not followed' : ''})`,
      'SBOM_FETCH_FAILED',
      { status: res.status },
    );
  }
  const max = COMPONENT_LIMITS.sbomBytes;
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new HttpError(502, `The SBOM is larger than ${max / 1024 / 1024} MB`, 'SBOM_TOO_LARGE', { max: max / 1024 / 1024 });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, `The SBOM is larger than ${max / 1024 / 1024} MB`, 'SBOM_TOO_LARGE', { max: max / 1024 / 1024 });
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readSbom(input: SbomInput): Promise<ParsedSbom> {
  return parseSbom(input.url ? await fetchSbom(input.url) : input.sbom);
}

/** What importing this SBOM would change in the component's stack (nothing is stored). */
export async function previewSbom(appId: string, componentId: string, input: SbomInput, canEdit: CanEdit): Promise<SbomPreview> {
  editableApp(appId, canEdit, 'change the components of this application');
  componentRow(appId, componentId);
  const sbom = await readSbom(input);
  const found = matchSbom(sbom.items);
  return { format: sbom.format, name: sbom.name, total: sbom.items.length, matched: found.size, changes: planSbom(componentHolder(componentId), found) };
}

/** Imports the SBOM into the component's stack: entries entered by hand stay, SBOM entries follow the SBOM. */
export async function importSbom(
  appId: string,
  componentId: string,
  input: SbomInput,
  canEdit: CanEdit,
): Promise<{ component: ApplicationComponent; preview: SbomPreview }> {
  // before anything is fetched: only those who may change the component make the server fetch a URL
  editableApp(appId, canEdit, 'change the components of this application');
  componentRow(appId, componentId);
  const sbom = await readSbom(input);
  // checked after the (slow) fetch, so nothing changed in between
  const u = me();
  const a = editableApp(appId, canEdit, 'change the components of this application');
  const cur = componentRow(appId, componentId);
  const found = matchSbom(sbom.items);
  const changes = planSbom(componentHolder(componentId), found);
  const now = nowIso();
  db().tx(() => {
    applySbomChanges(componentHolder(componentId), changes, u, now);
    db().run(
      'UPDATE application_components SET sbom_format = ?, sbom_name = ?, sbom_imported_at = ?, sbom_imported_by = ?, updated_at = ?, updated_by = ? WHERE id = ?',
      sbom.format,
      sbom.name.slice(0, 200),
      now,
      u.username,
      now,
      u.username,
      componentId,
    );
    touchApplication(appId, u);
    const counted = (k: SbomChange['action']) => changes.filter((c) => c.action === k);
    audit({
      action: 'application.sbom_imported',
      entityType: 'application',
      entityId: appId,
      summary:
        `SBOM (${sbom.format === 'cyclonedx' ? 'CycloneDX' : 'SPDX'}) imported into component "${cur.name}" of application "${a.name}": ` +
        `${counted('add').length} added, ${counted('update').length} changed, ${counted('remove').length} removed, ${counted('manual').length} kept as entered by hand`,
      details: {
        componentId,
        format: sbom.format,
        name: sbom.name,
        ...(input.url ? { url: input.url } : {}),
        total: sbom.items.length,
        matched: found.size,
        changes: changes.filter((c) => c.action !== 'keep').map((c) => ({ action: c.action, product: c.product, version: c.version, other: c.other })),
      },
    });
  });
  return {
    component: componentsOf(appId).find((c) => c.id === componentId)!,
    preview: { format: sbom.format, name: sbom.name, total: sbom.items.length, matched: found.size, changes },
  };
}

// ---------- process input ----------

/** What a process gets for an input of type application: the application with its components and stack. */
export interface ApplicationInputValue {
  id: string;
  name: string;
  criticality: string | null;
  owners: string[];
  tags: string[];
  url: string;
  components: {
    id: string;
    type: ComponentType;
    name: string;
    url: string;
    note: string;
    /** '' when the component serves all environments */
    environment: string;
    stack: { product: string; label: string; version: string; lifecycle: StackLifecycle | null }[];
    /** What Steward last read from the component's platform: a Kubernetes namespace, a repository or a Kafka topic; null otherwise */
    readout: NamespaceReadout | RepositoryReadout | TopicReadout | AwsReadout | SnowflakeReadout | null;
  }[];
  /** The systems the application runs on (#129), one entry per system and environment */
  systems: {
    id: string;
    name: string;
    kind: string;
    vendor: string;
    environment: string;
    production: boolean;
    note: string;
    stack: { product: string; label: string; version: string; lifecycle: StackLifecycle | null }[];
  }[];
  stack: {
    product: string;
    label: string;
    version: string;
    lifecycle: StackLifecycle | null;
    components: string[];
    systems: string[];
    environments: string[];
    production: boolean;
  }[];
}

/** At most this many applications in one input of type applications */
const MAX_INPUT_APPLICATIONS = 500;

/**
 * Resolves an input of type applications: a list of ids or names (or a text with one per line or comma), each like
 * an input of type application; an empty list means every application that is not archived.
 */
export function applicationsInputValue(v: unknown, label: string): ApplicationInputValue[] {
  const given = (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,;]/) : v == null ? [] : [v])
    .map((x) => (typeof x === 'string' ? x.trim() : x))
    .filter((x) => x !== '' && x != null);
  const ids = given.length
    ? given
    : db()
        .all<{ id: string }>('SELECT id FROM applications WHERE archived = 0 ORDER BY name')
        .map((r) => r.id);
  if (ids.length > MAX_INPUT_APPLICATIONS)
    throw new HttpError(400, `Input "${label}" names more than ${MAX_INPUT_APPLICATIONS} applications`, 'INPUT_APPLICATIONS_TOO_MANY', {
      input: label,
      max: MAX_INPUT_APPLICATIONS,
    });
  const seen = new Set<string>();
  return ids.map((x) => applicationInputValue(x, label)).filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

/**
 * Resolves an input of type application: an application id, its name (case does not matter – portable between
 * installations, e.g. in Git), or the value of an earlier run (an object with the id). Archived applications are
 * refused. Applications the one who starts the run may not see (another team's, #131) are not found.
 */
export function applicationInputValue(v: unknown, label: string): ApplicationInputValue {
  const given = typeof v === 'string' ? v.trim() : typeof obj(v)?.id === 'string' ? String(obj(v)!.id) : '';
  if (!given) throw new HttpError(400, `Input "${label}" must name an application`, 'INPUT_APPLICATION_INVALID', { input: label });
  const a =
    db().get<{ id: string; name: string; criticality: string | null; owners: string; tags: string; url: string; archived: number }>(
      'SELECT id, name, criticality, owners, tags, url, archived FROM applications WHERE id = ?',
      given,
    ) ??
    db().get<{ id: string; name: string; criticality: string | null; owners: string; tags: string; url: string; archived: number }>(
      'SELECT id, name, criticality, owners, tags, url, archived FROM applications WHERE lower(name) = lower(?) AND archived = 0',
      given,
    );
  // an application the starter may not see is unknown (#131)
  if (!a || !catalogueVisibleNow('application', a))
    throw new HttpError(400, `Input "${label}": application "${given.slice(0, 160)}" not found`, 'INPUT_APPLICATION_NOT_FOUND', {
      input: label,
      name: given.slice(0, 160),
    });
  if (a.archived)
    throw new HttpError(400, `Input "${label}": application "${a.name}" is archived`, 'INPUT_APPLICATION_ARCHIVED', { input: label, name: a.name });
  const components = componentsOf(a.id);
  const systems = systemLinksOf(a.id);
  const envs = environmentList();
  const plain = (s: StackEntry) => ({ product: s.product, label: s.label, version: s.version, lifecycle: s.lifecycle });
  return {
    id: a.id,
    name: a.name,
    criticality: a.criticality,
    owners: parseJson<string[]>(a.owners, []),
    tags: parseJson<string[]>(a.tags, []),
    url: a.url,
    components: components.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      url: c.url,
      note: c.note,
      environment: c.environment,
      stack: c.stack.map(plain),
      // what Steward last read from the component's platform (Kubernetes namespace, repository, Kafka topic), for checks against standards
      readout: c.cluster ?? c.repository ?? c.topic ?? c.aws ?? c.snowflake ?? null,
    })),
    systems: systems.map((x) => ({
      id: x.systemId,
      name: x.name,
      kind: x.kind,
      vendor: x.vendor,
      environment: x.environment,
      production: isProduction(x.environment, envs),
      note: x.note,
      stack: x.stack.map(plain),
    })),
    stack: stackRollup(components, systems).map((s) => ({
      product: s.product,
      label: s.label,
      version: s.version,
      lifecycle: s.lifecycle,
      components: s.components.map((c) => c.name),
      systems: [...new Set(s.systems.map((x) => x.name))],
      environments: s.environments,
      production: s.production,
    })),
  };
}

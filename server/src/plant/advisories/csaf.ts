import crypto from 'node:crypto';
import { z } from 'zod';
import {
  ADVISORY_LIMITS as L,
  ADVISORY_REMEDIATION_CATEGORIES,
  ADVISORY_SEVERITY_RANK,
  severityOfScore,
  type AdvisoryProduct,
  type AdvisoryReference,
  type AdvisoryRemediation,
  type AdvisorySeverity,
  type AdvisoryVulnerability,
} from '@sm/shared';
import { HttpError, type ErrorParams } from '../../util.js';

/**
 * Reading a CSAF 2.0 document (OASIS Common Security Advisory Framework, csaf_json_schema.json of CSAF 2.0): the
 * subset Steward needs, checked with zod and bounded – size, nesting of the product tree, counts of products,
 * vulnerabilities, product ids and notes, the length of every kept text. Unknown properties are left out, never kept.
 *
 * Required (as the schema requires them): document.category, csaf_version "2.0", publisher (category, name,
 * namespace), title, tracking (id, version, status, initial and current release date, revision_history). Profiles
 * other than security advisories (csaf_vex, csaf_base, informational) are read the same way: their product statuses
 * decide what matches.
 */

export interface CsafMeta {
  category: string;
  publisher: string;
  namespace: string;
  trackingId: string;
  title: string;
  version: string;
  status: string;
  initialRelease: string;
  currentRelease: string;
  language: string;
  tlp: string;
  aggregateSeverity: string;
}

export interface CsafContent {
  summary: string;
  products: AdvisoryProduct[];
  vulnerabilities: AdvisoryVulnerability[];
  references: AdvisoryReference[];
}

export interface ParsedCsaf {
  meta: CsafMeta;
  content: CsafContent;
  severity: AdvisorySeverity;
  cvss: number | null;
  cves: string[];
  sha256: string;
  size: number;
  /** The document as JSON text, unchanged */
  text: string;
}

const cut = (n: number) => z.string().transform((s) => (s.length > n ? `${s.slice(0, n)}…` : s));
const text = cut(L.textChars);
const short = cut(1000);
const id = z.string().min(1).max(1000);
const ids = z.array(id).max(L.productIds);

const helper = z
  .object({
    cpe: short.optional(),
    purl: short.optional(),
    model_numbers: z.array(short).max(1000).optional(),
  })
  .optional();
const fullProductName = z.object({ name: short, product_id: id, product_identification_helper: helper });
type FullProductName = z.infer<typeof fullProductName>;

const BRANCH_CATEGORIES = [
  'architecture',
  'host_name',
  'language',
  'legacy',
  'patch_level',
  'product_family',
  'product_name',
  'product_version',
  'product_version_range',
  'service_pack',
  'specification',
  'vendor',
] as const;
interface Branch {
  category: (typeof BRANCH_CATEGORIES)[number];
  name: string;
  product?: FullProductName;
  branches?: Branch[];
}
// nesting and size are counted before zod sees the tree (checkTree)
const branch: z.ZodType<Branch> = z.lazy(() =>
  z.object({
    category: z.enum(BRANCH_CATEGORIES),
    name: short.pipe(z.string().min(1)),
    product: fullProductName.optional(),
    branches: z.array(branch).max(L.branchNodes).optional(),
  }),
);

const note = z.object({ category: z.string().max(100), text, title: short.optional() });
const reference = z.object({ url: z.string().max(2000), summary: short, category: z.string().max(100).optional() });
const date = z.string().min(1).max(100);

const csafSchema = z.object({
  document: z.object({
    category: z.string().min(1).max(200),
    csaf_version: z.literal('2.0'),
    publisher: z.object({ category: z.string().min(1).max(100), name: z.string().min(1).max(500), namespace: z.string().min(1).max(1000) }),
    title: z.string().min(1).max(2000),
    lang: z.string().max(100).optional(),
    aggregate_severity: z.object({ text: short }).optional(),
    distribution: z.object({ tlp: z.object({ label: z.string().max(50) }).optional() }).optional(),
    notes: z.array(note).max(L.notes).optional(),
    references: z.array(reference).max(L.references).optional(),
    tracking: z.object({
      id: z.string().min(1).max(1000),
      version: z.string().min(1).max(200),
      status: z.enum(['draft', 'final', 'interim']),
      initial_release_date: date,
      current_release_date: date,
      revision_history: z
        .array(z.object({ date: date.optional(), number: z.string().max(200).optional() }))
        .min(1)
        .max(10_000),
    }),
  }),
  product_tree: z
    .object({
      branches: z.array(branch).max(L.branchNodes).optional(),
      full_product_names: z.array(fullProductName).max(L.products).optional(),
      relationships: z
        .array(
          z.object({
            category: z.string().max(100),
            full_product_name: fullProductName,
            product_reference: id,
            relates_to_product_reference: id,
          }),
        )
        .max(L.products)
        .optional(),
    })
    .optional(),
  vulnerabilities: z
    .array(
      z.object({
        cve: z.string().max(100).optional(),
        title: short.optional(),
        cwe: z.object({ id: z.string().max(100), name: short.optional() }).optional(),
        notes: z.array(note).max(L.notes).optional(),
        product_status: z
          .object({
            first_affected: ids.optional(),
            known_affected: ids.optional(),
            last_affected: ids.optional(),
            first_fixed: ids.optional(),
            fixed: ids.optional(),
            known_not_affected: ids.optional(),
            recommended: ids.optional(),
            under_investigation: ids.optional(),
          })
          .optional(),
        remediations: z
          .array(
            z.object({
              category: z.enum(ADVISORY_REMEDIATION_CATEGORIES),
              details: text,
              url: z.string().max(2000).optional(),
              product_ids: ids.optional(),
              group_ids: ids.optional(),
            }),
          )
          .max(L.remediations)
          .optional(),
        scores: z
          .array(
            z.object({
              products: ids,
              cvss_v3: z
                .object({ baseScore: z.number().min(0).max(10), baseSeverity: z.string().max(20).optional(), vectorString: z.string().max(300).optional() })
                .optional(),
              cvss_v2: z.object({ baseScore: z.number().min(0).max(10), vectorString: z.string().max(300).optional() }).optional(),
            }),
          )
          .max(L.remediations)
          .optional(),
        threats: z
          .array(z.object({ category: z.string().max(100), details: short }))
          .max(L.remediations)
          .optional(),
        references: z.array(reference).max(L.references).optional(),
      }),
    )
    .max(L.vulnerabilities)
    .optional(),
  product_groups: z.unknown().optional(),
});
type Csaf = z.infer<typeof csafSchema>;

/** Counts the nodes and the depth of the product tree before zod reads it (no recursion on input). */
function checkTree(doc: unknown): void {
  const tree = (doc as { product_tree?: { branches?: unknown } } | null)?.product_tree?.branches;
  if (!Array.isArray(tree)) return;
  const stack: { list: unknown[]; depth: number }[] = [{ list: tree, depth: 1 }];
  let nodes = 0;
  while (stack.length) {
    const { list, depth } = stack.pop()!;
    if (depth > L.branchDepth) throw invalid(`The product tree nests deeper than ${L.branchDepth} levels`);
    for (const b of list) {
      if (++nodes > L.branchNodes) throw invalid(`The product tree has more than ${L.branchNodes} branches`);
      const children = (b as { branches?: unknown } | null)?.branches;
      if (Array.isArray(children)) stack.push({ list: children, depth: depth + 1 });
    }
  }
}

const invalid = (message: string, details?: ErrorParams) => new HttpError(400, message, 'PLANT_ADVISORY_INVALID', details);

/** A CPE (2.2 URI or 2.3 formatted string): vendor, product and version, as far as it names them. */
export function cpeParts(cpe: string): { vendor: string; product: string; version: string } | null {
  const s = cpe.trim();
  let parts: string[];
  if (s.startsWith('cpe:2.3:')) parts = s.split(':').slice(3);
  else if (s.startsWith('cpe:/')) parts = s.slice(5).split(':').slice(1);
  else return null;
  const clean = (x: string | undefined) => (!x || x === '*' || x === '-' ? '' : x.replaceAll('\\', '').replaceAll('_', ' '));
  const vendor = clean(parts[0]);
  const product = clean(parts[1]);
  return vendor && product ? { vendor, product, version: clean(parts[2]) } : null;
}

function productsOf(c: Csaf): AdvisoryProduct[] {
  const out = new Map<string, AdvisoryProduct>();
  const add = (p: AdvisoryProduct) => {
    if (!out.has(p.id) && out.size < L.products) out.set(p.id, p);
  };
  const fromHelper = (f: FullProductName) => ({
    models: (f.product_identification_helper?.model_numbers ?? []).filter(Boolean).slice(0, 100),
    cpe: f.product_identification_helper?.cpe ?? '',
    purl: f.product_identification_helper?.purl ?? '',
  });
  // the branches: vendor › family › name › version or range (other categories describe a variant)
  type Path = { vendor: string; family: string[]; name: string; version: string; range: string };
  const queue: { b: Branch; path: Path }[] = (c.product_tree?.branches ?? []).map((b) => ({
    b,
    path: { vendor: '', family: [], name: '', version: '', range: '' },
  }));
  for (let i = 0; i < queue.length; i++) {
    const { b, path } = queue[i]!;
    const p: Path = { ...path, family: [...path.family] };
    if (b.category === 'vendor') p.vendor = b.name;
    else if (b.category === 'product_family') p.family.push(b.name);
    else if (b.category === 'product_name') p.name = b.name;
    else if (b.category === 'product_version') p.version = b.name;
    else if (b.category === 'product_version_range') p.range = b.name;
    if (b.product)
      add({
        id: b.product.product_id,
        vendor: p.vendor,
        family: p.family.join(' '),
        name: p.name || b.product.name,
        version: p.version,
        range: p.range,
        fullName: b.product.name,
        partOf: '',
        ...fromHelper(b.product),
      });
    for (const child of b.branches ?? []) queue.push({ b: child, path: p });
  }
  // full product names outside the tree: what their CPE says
  for (const f of c.product_tree?.full_product_names ?? []) {
    const h = fromHelper(f);
    const cpe = h.cpe ? cpeParts(h.cpe) : null;
    add({
      id: f.product_id,
      vendor: cpe?.vendor ?? '',
      family: '',
      name: cpe?.product ?? f.name,
      version: cpe?.version ?? '',
      range: '',
      fullName: f.name,
      partOf: '',
      ...h,
    });
  }
  // relationships: firmware installed on (or a default component of) a device – the device's model, the firmware's version
  for (const r of c.product_tree?.relationships ?? []) {
    const ref = out.get(r.product_reference);
    const on = out.get(r.relates_to_product_reference);
    if (!ref || !on) continue;
    const h = fromHelper(r.full_product_name);
    add({
      id: r.full_product_name.product_id,
      vendor: ref.vendor || on.vendor,
      family: on.family,
      name: on.name,
      version: ref.version,
      range: ref.range,
      fullName: r.full_product_name.name,
      partOf: on.fullName,
      models: h.models.length ? h.models : on.models,
      cpe: h.cpe,
      purl: h.purl,
    });
  }
  return [...out.values()];
}

const noteText = (notes: { category: string; text: string }[] | undefined, ...categories: string[]) => {
  for (const cat of categories) {
    const n = notes?.find((x) => x.category === cat);
    if (n) return n.text;
  }
  return '';
};

function vulnerabilitiesOf(c: Csaf): AdvisoryVulnerability[] {
  return (c.vulnerabilities ?? []).map((v) => {
    let best: { score: number; severity: AdvisorySeverity; vector: string } | null = null;
    for (const s of v.scores ?? []) {
      const v3 = s.cvss_v3;
      const v2 = s.cvss_v2;
      const score = v3?.baseScore ?? v2?.baseScore;
      if (score === undefined) continue;
      const named = v3?.baseSeverity?.toLowerCase();
      const severity: AdvisorySeverity = named && named in ADVISORY_SEVERITY_RANK ? (named as AdvisorySeverity) : severityOfScore(score);
      if (!best || score > best.score) best = { score, severity, vector: v3?.vectorString ?? v2?.vectorString ?? '' };
    }
    const ps = v.product_status ?? {};
    const uniq = (...lists: (string[] | undefined)[]) => [...new Set(lists.flatMap((l) => l ?? []))];
    return {
      cve: v.cve ?? '',
      title: v.title ?? '',
      cwe: v.cwe ? `${v.cwe.id}${v.cwe.name ? ` ${v.cwe.name}` : ''}` : '',
      summary: noteText(v.notes, 'summary', 'description', 'details', 'general'),
      cvss: best?.score ?? null,
      severity: best?.severity ?? 'unknown',
      vector: best?.vector ?? '',
      affected: uniq(ps.known_affected, ps.first_affected, ps.last_affected),
      underInvestigation: uniq(ps.under_investigation),
      fixed: uniq(ps.fixed, ps.first_fixed),
      recommended: uniq(ps.recommended),
      notAffected: uniq(ps.known_not_affected),
      remediations: (v.remediations ?? []).map((r): AdvisoryRemediation => ({
        category: r.category,
        details: r.details,
        url: safeUrl(r.url),
        productIds: r.product_ids ?? [],
      })),
      exploitation: (v.threats ?? []).find((t) => t.category === 'exploit_status')?.details ?? '',
    };
  });
}

/** Only http(s) links are kept (they are shown as links). */
export const safeUrl = (u: string | undefined): string => {
  if (!u) return '';
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : '';
  } catch {
    return '';
  }
};

const AGGREGATE: Record<string, AdvisorySeverity> = { critical: 'critical', important: 'high', high: 'high', moderate: 'medium', medium: 'medium', low: 'low' };

/** Reads, checks and condenses a CSAF document; refuses (400 PLANT_ADVISORY_INVALID) what is not one or is too large. */
export function parseCsaf(raw: string | Buffer): ParsedCsaf {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  if (buf.length > L.documentBytes)
    throw new HttpError(413, `The document is larger than ${L.documentBytes / 1024 / 1024} MB`, 'PLANT_ADVISORY_TOO_LARGE', {
      mb: L.documentBytes / 1024 / 1024,
    });
  const textOf = buf.toString('utf8');
  let doc: unknown;
  try {
    doc = JSON.parse(textOf);
  } catch {
    throw invalid('The file is not JSON – a CSAF document is a JSON file');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw invalid('The file is not a CSAF document (no JSON object)');
  checkTree(doc);
  const r = csafSchema.safeParse(doc);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    const where = issue.path.join('/');
    throw invalid(`The file is not a CSAF 2.0 document Steward can read: ${where ? `/${where}: ` : ''}${issue.message}`, { path: `/${where}` });
  }
  const c = r.data;
  const d = c.document;
  const products = productsOf(c);
  const vulnerabilities = vulnerabilitiesOf(c);
  let severity: AdvisorySeverity = 'unknown';
  let cvss: number | null = null;
  for (const v of vulnerabilities) {
    if (ADVISORY_SEVERITY_RANK[v.severity] > ADVISORY_SEVERITY_RANK[severity]) severity = v.severity;
    if (v.cvss !== null && (cvss === null || v.cvss > cvss)) cvss = v.cvss;
  }
  if (severity === 'unknown' && d.aggregate_severity) severity = AGGREGATE[d.aggregate_severity.text.trim().toLowerCase()] ?? 'unknown';
  const references: AdvisoryReference[] = (d.references ?? [])
    .map((x) => ({ url: safeUrl(x.url), summary: x.summary, category: x.category ?? 'external' }))
    .filter((x) => x.url);
  return {
    meta: {
      category: d.category,
      publisher: d.publisher.name,
      namespace: d.publisher.namespace,
      trackingId: d.tracking.id,
      title: d.title,
      version: d.tracking.version,
      status: d.tracking.status,
      initialRelease: d.tracking.initial_release_date,
      currentRelease: d.tracking.current_release_date,
      language: d.lang ?? '',
      tlp: d.distribution?.tlp?.label ?? '',
      aggregateSeverity: d.aggregate_severity?.text ?? '',
    },
    content: { summary: noteText(d.notes, 'summary', 'description', 'general'), products, vulnerabilities, references },
    severity,
    cvss,
    cves: [...new Set(vulnerabilities.map((v) => v.cve).filter(Boolean))].slice(0, 500),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
    text: textOf,
  };
}

/** TLP labels of documents everyone in the plant registry may read (CSAF 2.0: WHITE, GREEN; 2.1 calls WHITE CLEAR). */
export const PUBLIC_TLP = new Set(['WHITE', 'GREEN', 'UNLABELED', 'CLEAR', '']);

/** Documents marked TLP:AMBER or RED are not kept: everyone who sees the plant registry would read them. */
export function assertPublicTlp(p: ParsedCsaf): void {
  if (!PUBLIC_TLP.has(p.meta.tlp.toUpperCase()))
    throw new HttpError(400, `The document is marked TLP:${p.meta.tlp} – Steward keeps only TLP:WHITE, GREEN or unlabelled documents`, 'PLANT_ADVISORY_TLP', {
      tlp: p.meta.tlp,
    });
}

/** The stable id of an advisory: its publisher's namespace and tracking id (a newer version replaces the older one). */
export const advisoryId = (namespace: string, trackingId: string): string =>
  `adv_${crypto.createHash('sha256').update(`${namespace.trim().toLowerCase()}\n${trackingId.trim()}`).digest('hex').slice(0, 24)}`;

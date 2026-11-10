import {
  ADVISORY_SEVERITY_RANK,
  type AdvisoryFix,
  type AdvisoryMatchKind,
  type AdvisoryMatchReason,
  type AdvisoryProduct,
  type AdvisorySeverity,
  type AdvisoryVulnerability,
} from '@sm/shared';
import type { CsafContent } from './csaf.js';
import { inRange, newer, parseRange, sameVersion, upperBound, version } from './versions.js';

/**
 * Matching an advisory's products to assets (docs/ADVISORIES.md "Matching"), conservative and explainable:
 *
 * - **Vendor**: the asset's manufacturer and the product's vendor are the same (ignoring case and spaces), or the same
 *   once normalised (letters and digits only, legal forms such as GmbH, AG, Inc., Ltd. left out). One containing the
 *   other (at least 4 characters) is only *similar*.
 * - **Model**: the asset's model is the product name (or family + name) – the same or normalised (letters and digits
 *   only: "PM 200" = "PM-200") – or one of the product's model numbers (`*` and `?` as wildcards). One containing the
 *   other is only *similar*.
 * - **Firmware**: the product's version equals the firmware, its range contains it, or the product has no version
 *   (all versions). Firmware not recorded, or a range Steward does not read, is not enough.
 *
 * An asset is checked twice: with its own manufacturer and model, and with those of its device profile (the
 * controller) – the firmware of its assignment belongs to the profile's device when it has one, else to the asset; a
 * profile's own version (the firmware it describes) stands in when the assignment names none.
 *
 * Only vendor, model and firmware all exact make an **exact** match (counted as affected). Anything weaker, and products
 * under investigation, make a **possible** match – shown separately for a person to confirm or dismiss, never counted
 * on its own. Where the same vulnerability lists the asset's version as fixed or not affected, it does not match.
 */

export interface MatchCandidate {
  assetId: string;
  siteId: string;
  manufacturer: string;
  model: string;
  firmware: string;
  profile: { id: string; manufacturer: string; model: string; version: string } | null;
}

export interface MatchResult {
  kind: AdvisoryMatchKind;
  productIds: string[];
  cves: string[];
  cvss: number | null;
  severity: AdvisorySeverity;
  reasons: AdvisoryMatchReason[];
  fixes: AdvisoryFix[];
}

const LEGAL_FORMS = new Set([
  'gmbh',
  'ag',
  'kg',
  'se',
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'llc',
  'corp',
  'corporation',
  'co',
  'company',
  'sa',
  'sas',
  'spa',
  'srl',
  'sarl',
  'plc',
  'bv',
  'nv',
  'oy',
  'ab',
  'as',
  'kk',
  'mbh',
]);

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const alnum = (s: string) => [...s].filter((c) => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')).join('');
const words = (s: string) =>
  fold(s)
    .replaceAll('&', ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A vendor as compared: letters and digits, without legal forms ("Fooke GmbH & Co. KG" → "fookeand" … → "fooke"). */
export function normVendor(s: string): string {
  const w = words(s).filter((x) => !LEGAL_FORMS.has(x) && x !== 'and');
  return w.join('');
}
/** A model as compared: letters and digits only ("PM-200" → "pm200"). */
export const normModel = (s: string): string => alnum(fold(s));
const plain = (s: string) => fold(s).trim().replace(/\s+/g, ' ');

type How<T extends string> = T | null;

function vendorHow(asset: string, product: string): How<'same' | 'normalised' | 'similar'> {
  if (!asset.trim() || !product.trim()) return null;
  if (plain(asset) === plain(product)) return 'same';
  const a = normVendor(asset);
  const p = normVendor(product);
  if (!a || !p) return null;
  if (a === p) return 'normalised';
  const [short, long] = a.length <= p.length ? [a, p] : [p, a];
  return short.length >= 4 && long.includes(short) ? 'similar' : null;
}

/** A model number with `*` (any characters) and `?` (one character), compared normalised. */
function globMatch(pattern: string, model: string): boolean {
  const p = fold(pattern).replace(/[^a-z0-9*?]/g, '');
  const m = normModel(model);
  if (!p || p.length > 200 || m.length > 200) return false;
  // dynamic programming, no regular expression built from document data
  let prev = new Array<boolean>(m.length + 1).fill(false);
  prev[0] = true;
  for (let i = 1; i <= p.length; i++) {
    const cur = new Array<boolean>(m.length + 1).fill(false);
    const c = p[i - 1]!;
    if (c === '*') cur[0] = prev[0]!;
    for (let j = 1; j <= m.length; j++) {
      if (c === '*') cur[j] = prev[j]! || cur[j - 1]!;
      else cur[j] = prev[j - 1]! && (c === '?' || c === m[j - 1]);
    }
    prev = cur;
  }
  return prev[m.length]!;
}

function modelHow(asset: string, p: AdvisoryProduct): { how: 'same' | 'normalised' | 'model_number' | 'similar'; advisory: string } | null {
  if (!asset.trim()) return null;
  const names = [p.name, p.family && p.name ? `${p.family} ${p.name}` : ''].filter(Boolean);
  for (const n of names) if (plain(n) === plain(asset)) return { how: 'same', advisory: n };
  const a = normModel(asset);
  if (!a) return null;
  for (const n of names) if (normModel(n) === a) return { how: 'normalised', advisory: n };
  for (const m of p.models) if (globMatch(m, asset)) return { how: 'model_number', advisory: m };
  for (const n of [...names, ...p.models.filter((m) => !m.includes('*') && !m.includes('?'))]) {
    const x = normModel(n);
    if (!x) continue;
    const [short, long] = a.length <= x.length ? [a, x] : [x, a];
    if (short.length >= 2 && long.includes(short)) return { how: 'similar', advisory: n };
  }
  return null;
}

function versionHow(firmware: string, p: AdvisoryProduct): { how: AdvisoryMatchReason['version']['how'] | 'outside'; advisory: string } {
  if (p.version) {
    if (!firmware.trim()) return { how: 'unknown', advisory: p.version };
    const same = sameVersion(firmware, p.version);
    return { how: same === null ? 'unparsed' : same ? 'equal' : 'outside', advisory: p.version };
  }
  if (p.range) {
    const r = parseRange(p.range);
    if (r.kind === 'all') return { how: 'all', advisory: p.range };
    if (!firmware.trim()) return { how: 'unknown', advisory: p.range };
    const inside = inRange(r, firmware);
    return { how: inside === null ? 'unparsed' : inside ? 'in_range' : 'outside', advisory: p.range };
  }
  return { how: 'all', advisory: '' };
}

/** One way of looking at an asset: its own manufacturer and model, or its profile's. */
interface View {
  via: 'asset' | 'profile';
  profileId: string | null;
  vendor: string;
  model: string;
  firmware: string;
}

export function viewsOf(c: MatchCandidate): View[] {
  const out: View[] = [];
  if (c.profile) {
    out.push({ via: 'asset', profileId: null, vendor: c.manufacturer, model: c.model, firmware: '' });
    out.push({ via: 'profile', profileId: c.profile.id, vendor: c.profile.manufacturer, model: c.profile.model, firmware: c.firmware || c.profile.version });
  } else out.push({ via: 'asset', profileId: null, vendor: c.manufacturer, model: c.model, firmware: c.firmware });
  return out.filter((v) => v.vendor.trim() && v.model.trim());
}

const VERSION_TEXT: Record<AdvisoryMatchReason['version']['how'], (r: AdvisoryMatchReason) => string> = {
  in_range: (r) => `firmware ${r.version.asset} in ${r.version.advisory}`,
  equal: (r) => `firmware ${r.version.asset} = ${r.version.advisory}`,
  all: (r) => (r.version.advisory ? `all versions (${r.version.advisory})` : 'all versions'),
  unknown: (r) => `firmware not recorded (affected: ${r.version.advisory})`,
  unparsed: (r) => `firmware ${r.version.asset} – range "${r.version.advisory}" not understood`,
};

export function reasonText(r: Omit<AdvisoryMatchReason, 'text'>): string {
  const how = (h: string) => (h === 'same' ? '' : h === 'normalised' ? ' (normalised)' : h === 'model_number' ? ' (model number)' : ' (similar)');
  const via = r.via === 'profile' ? ` via device profile ${r.profileId}` : '';
  const status = r.status === 'under_investigation' ? '; under investigation' : '';
  return `matched on vendor ${r.vendor.advisory}${how(r.vendor.how)}, model ${r.model.advisory}${how(r.model.how)}, ${VERSION_TEXT[r.version.how](r as AdvisoryMatchReason)}${via}${status}`;
}

/** How one view of an asset compares with one product; null: no match at all. */
export function compare(v: View, p: AdvisoryProduct, status: AdvisoryMatchReason['status']): { reason: AdvisoryMatchReason; exact: boolean } | null {
  const vh = vendorHow(v.vendor, p.vendor);
  if (!vh) return null;
  const mh = modelHow(v.model, p);
  if (!mh) return null;
  const ver = versionHow(v.firmware, p);
  if (ver.how === 'outside') return null;
  const base: Omit<AdvisoryMatchReason, 'text'> = {
    via: v.via,
    profileId: v.profileId,
    productId: p.id,
    product: p.fullName,
    vendor: { advisory: p.vendor, asset: v.vendor, how: vh },
    model: { advisory: mh.advisory, asset: v.model, how: mh.how },
    version: { advisory: ver.advisory, asset: v.firmware, how: ver.how },
    status,
  };
  const exact = vh !== 'similar' && mh.how !== 'similar' && (ver.how === 'in_range' || ver.how === 'equal' || ver.how === 'all') && status === 'affected';
  return { reason: { ...base, text: reasonText(base) }, exact };
}

/** The view's version is listed as fixed or not affected by this vulnerability (vendor and model exact). */
function clearedBy(v: View, vuln: AdvisoryVulnerability, products: Map<string, AdvisoryProduct>): boolean {
  for (const pid of [...vuln.fixed, ...vuln.notAffected]) {
    const p = products.get(pid);
    if (!p) continue;
    const c = compare(v, p, 'affected');
    if (c?.exact && c.reason.version.how !== 'all') return true;
  }
  return false;
}

/** Fixed firmware of the same vendor and model in this vulnerability, else the upper end of the affected range. */
function fixesFor(p: AdvisoryProduct, vuln: AdvisoryVulnerability, products: Map<string, AdvisoryProduct>, firmware: string): AdvisoryFix[] {
  const out: AdvisoryFix[] = [];
  for (const pid of [...vuln.fixed, ...vuln.recommended]) {
    const f = products.get(pid);
    if (!f || !f.version) continue;
    if (normVendor(f.vendor) !== normVendor(p.vendor) || normModel(f.name) !== normModel(p.name)) continue;
    out.push({ version: f.version, from: 'fixed_product', product: f.fullName });
  }
  if (!out.length && p.range) {
    const up = upperBound(parseRange(p.range));
    if (up) out.push({ version: up, from: 'range', product: p.fullName });
  }
  // only versions above the firmware (when both read)
  return out.filter((f) => !firmware || newer(f.version, firmware) !== false);
}

/** Matches one advisory against the candidates; assets without any match are left out. */
export function matchAdvisory(content: CsafContent, candidates: MatchCandidate[]): Map<string, MatchResult> {
  const products = new Map(content.products.map((p) => [p.id, p]));
  // index the products a vulnerability names by normalised vendor
  const out = new Map<string, MatchResult>();
  const vendorKeys = new Map<string, MatchCandidate[]>();
  for (const c of candidates)
    for (const v of viewsOf(c)) {
      const k = normVendor(v.vendor);
      if (!k) continue;
      const list = vendorKeys.get(k) ?? [];
      if (!list.includes(c)) list.push(c);
      vendorKeys.set(k, list);
    }
  const candidatesFor = (vendor: string): MatchCandidate[] => {
    const k = normVendor(vendor);
    if (!k) return [];
    const exact = vendorKeys.get(k) ?? [];
    const similar: MatchCandidate[] = [];
    for (const [key, list] of vendorKeys) {
      if (key === k) continue;
      const [short, long] = key.length <= k.length ? [key, k] : [k, key];
      if (short.length >= 4 && long.includes(short)) similar.push(...list);
    }
    return [...new Set([...exact, ...similar])];
  };
  type Acc = { exact: AdvisoryMatchReason[]; possible: AdvisoryMatchReason[]; exactVulns: Set<number>; possibleVulns: Set<number>; fixes: AdvisoryFix[] };
  const acc = new Map<string, Acc>();
  content.vulnerabilities.forEach((vuln, vi) => {
    const lists: [string[], AdvisoryMatchReason['status']][] = [
      [vuln.affected, 'affected'],
      [vuln.underInvestigation, 'under_investigation'],
    ];
    for (const [list, status] of lists)
      for (const pid of list) {
        const p = products.get(pid);
        if (!p || !p.vendor) continue;
        for (const c of candidatesFor(p.vendor))
          for (const v of viewsOf(c)) {
            const m = compare(v, p, status);
            if (!m) continue;
            if (clearedBy(v, vuln, products)) continue;
            const a = acc.get(c.assetId) ?? { exact: [], possible: [], exactVulns: new Set(), possibleVulns: new Set(), fixes: [] };
            acc.set(c.assetId, a);
            if (m.exact) {
              a.exact.push(m.reason);
              a.exactVulns.add(vi);
            } else {
              a.possible.push(m.reason);
              a.possibleVulns.add(vi);
            }
            a.fixes.push(...fixesFor(p, vuln, products, v.firmware));
          }
      }
  });
  for (const [assetId, a] of acc) {
    const kind: AdvisoryMatchKind = a.exact.length ? 'exact' : 'possible';
    const reasons = dedupe(kind === 'exact' ? a.exact : a.possible, (r) => r.text).slice(0, 10);
    const vulns = [...(kind === 'exact' ? a.exactVulns : a.possibleVulns)].map((i) => content.vulnerabilities[i]!);
    let severity: AdvisorySeverity = 'unknown';
    let cvss: number | null = null;
    for (const v of vulns) {
      if (ADVISORY_SEVERITY_RANK[v.severity] > ADVISORY_SEVERITY_RANK[severity]) severity = v.severity;
      if (v.cvss !== null && (cvss === null || v.cvss > cvss)) cvss = v.cvss;
    }
    out.set(assetId, {
      kind,
      productIds: [...new Set(reasons.map((r) => r.productId))],
      cves: [...new Set(vulns.map((v) => v.cve).filter(Boolean))],
      cvss,
      severity,
      reasons,
      fixes: dedupe(a.fixes, (f) => `${f.from}:${f.version}`)
        .sort((x, y) => (x.from === y.from ? (newer(x.version, y.version) ? 1 : -1) : x.from === 'fixed_product' ? -1 : 1))
        .slice(0, 5),
    });
  }
  return out;
}

const dedupe = <T>(list: T[], key: (x: T) => string): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => (seen.has(key(x)) ? false : (seen.add(key(x)), true)));
};

/** How a device profile compares with the advisory's affected products (the best result), for the advisory's page. */
export function matchProfile(
  content: CsafContent,
  p: { id: string; manufacturer: string; model: string; version: string },
): { kind: AdvisoryMatchKind; text: string } | null {
  const products = new Map(content.products.map((x) => [x.id, x]));
  const view: View = { via: 'profile', profileId: p.id, vendor: p.manufacturer, model: p.model, firmware: version(p.version) ? p.version : '' };
  let best: { kind: AdvisoryMatchKind; text: string } | null = null;
  for (const vuln of content.vulnerabilities)
    for (const pid of [...vuln.affected, ...vuln.underInvestigation]) {
      const prod = products.get(pid);
      if (!prod) continue;
      const m = compare(view, prod, vuln.affected.includes(pid) ? 'affected' : 'under_investigation');
      if (!m) continue;
      if (m.exact) return { kind: 'exact', text: m.reason.text };
      best ??= { kind: 'possible', text: m.reason.text };
    }
  return best;
}

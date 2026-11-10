import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Security advisories at scale (0.14, docs/ADVISORIES.md "Limits"): a few thousand advisories – as a CSAF feed such as
 * CISA's brings over the years – generated in the test. Matching runs in bounded batches (a read does a small one, the
 * job resumes where it stopped), and the list is filtered, sorted and paged by the database, in the internal API and
 * /api/v1 alike.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const N = 3000;
/** Every 10th names the demo's controller (Example Controls C80) – matching milling centre 2 (firmware 3.2.0) */
const MATCHING = N / 10;
const db = async () => (await import('../src/db.js')).db();
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const SCORE = { critical: 9.5, high: 7.5, medium: 5.0, low: 2.0 } as const;

function content(i: number) {
  const ours = i % 10 === 0;
  const vendor = ours ? 'Example Controls' : `Generated Vendor ${i % 97}`;
  const severity = SEVERITIES[i % 4]!;
  return {
    vendor,
    severity,
    content: {
      summary: `Generated advisory ${i}`,
      products: [
        {
          id: 'P1',
          vendor,
          family: '',
          name: ours ? 'C80' : `Model ${i}`,
          version: '',
          range: 'vers:generic/<3.4.0',
          models: [],
          fullName: `${vendor} <3.4.0`,
          cpe: '',
          purl: '',
          partOf: '',
        },
      ],
      vulnerabilities: [
        {
          cve: `CVE-2099-${30000 + i}`,
          title: '',
          cwe: '',
          summary: '',
          cvss: SCORE[severity],
          severity,
          vector: '',
          affected: ['P1'],
          underInvestigation: [],
          fixed: [],
          recommended: [],
          notAffected: [],
          remediations: [],
          exploitation: '',
        },
      ],
      references: [],
    },
  };
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('PUT', '/settings/plant', { enabled: true, enterprise: 'Brightwater Components', labels: {}, fields: {} });
  // the generated documents go straight into the table, unmatched (as after a large feed's first read); the demo's source stays off
  const d = await db();
  d.run('UPDATE plant_advisory_sources SET enabled = 0');
  const { normVendor } = await import('../src/plant/advisories/match.js');
  const now = new Date().toISOString();
  d.tx(() => {
    for (let i = 0; i < N; i++) {
      const g = content(i);
      const day = new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString();
      d.run(
        `INSERT INTO plant_advisories (id, publisher, namespace, tracking_id, title, category, doc_status, version, initial_release, current_release, severity,
           severity_rank, cvss, cves, vendors, content, document, sha256, size, origin, integrity, created_at, created_by, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, 'csaf_security_advisory', 'final', '1', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 2, 'feed', 'none', ?, 'system', ?, 'system')`,
        `adv_gen${String(i).padStart(6, '0')}`,
        g.vendor,
        `https://gen-${i % 97}.example`,
        `GEN-${String(i).padStart(5, '0')}`,
        `Generated advisory ${i} of ${g.vendor}`,
        day,
        day,
        g.severity,
        { critical: 5, high: 4, medium: 3, low: 2 }[g.severity],
        SCORE[g.severity],
        JSON.stringify([`CVE-2099-${30000 + i}`]),
        JSON.stringify([normVendor(g.vendor)]),
        JSON.stringify(g.content),
        `sha-${i}`,
        now,
        now,
      );
    }
  });
  const { resetAdvisoryFingerprint } = await import('../src/plant/advisories/store.js');
  resetAdvisoryFingerprint();
}, 600_000);

const stale = async () => Number((await db()).get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_advisories WHERE match_stamp = ''")?.n);

describe('a few thousand advisories', () => {
  it('a read matches a small batch only; the job resumes where it stopped and finishes', async () => {
    expect(await stale()).toBe(N);
    const started = Date.now();
    await s.api('GET', '/plant/advisories?limit=10');
    expect(Date.now() - started).toBeLessThan(15_000);
    const afterRead = await stale();
    expect(afterRead).toBeGreaterThanOrEqual(N - 100);
    expect(afterRead).toBeLessThan(N);
    const { runAdvisoryJob } = await import('../src/plant/advisories/fetch.js');
    // a job run with a tiny budget stops early and leaves the rest for the next run
    await runAdvisoryJob(Date.now(), 1);
    const afterShort = await stale();
    expect(afterShort).toBeGreaterThan(0);
    expect(afterShort).toBeLessThan(afterRead);
    for (let i = 0; i < 50 && (await stale()) > 0; i++) await runAdvisoryJob(Date.now(), 20_000);
    expect(await stale()).toBe(0);
    const d = await db();
    expect(Number(d.get<{ n: number }>("SELECT COUNT(*) AS n FROM plant_advisory_matches WHERE asset_id = 'rvs-mill-02' AND current = 1")?.n)).toBe(MATCHING);
  });

  it('the list is paged, filtered and sorted by the server', async () => {
    const started = Date.now();
    const first = await s.api('GET', '/plant/advisories?affecting=0&limit=50');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(first.total).toBe(N);
    expect(first.items).toHaveLength(50);
    expect(first.nextOffset).toBe(50);
    const second = await s.api('GET', '/plant/advisories?affecting=0&limit=50&offset=50');
    const ids = new Set([...first.items, ...second.items].map((x: { id: string }) => x.id));
    expect(ids.size).toBe(100);
    // the default sort: most severe first, then the newest
    expect(first.items[0].severity).toBe('critical');
    // the default view: only what affects the reader's sites
    const mine = await s.api('GET', '/plant/advisories?affecting=1&limit=200');
    expect(mine.total).toBe(MATCHING);
    expect(mine.items.every((x: { affectedAssets: number }) => x.affectedAssets === 1)).toBe(true);
    // filters: severity, vendor, text, site, status – the counts agree with the items
    const critical = await s.api('GET', '/plant/advisories?affecting=0&severity=critical&limit=1');
    expect(critical.total).toBe(N / 4);
    const vendor = await s.api('GET', `/plant/advisories?affecting=0&vendor=${encodeURIComponent('Example Controls GmbH')}&limit=1`);
    expect(vendor.total).toBe(MATCHING);
    const text = await s.api('GET', '/plant/advisories?affecting=0&q=GEN-0012&limit=50');
    expect(text.items.map((x: { trackingId: string }) => x.trackingId).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `GEN-0012${i}`));
    expect((await s.api('GET', '/plant/advisories?site=hillcrest&limit=1')).total).toBe(0);
    expect((await s.api('GET', '/plant/advisories?site=riverside&limit=1')).total).toBe(MATCHING);
    // status: one mitigated, the rest open
    const d = await db();
    d.run("UPDATE plant_advisory_matches SET remediation = 'mitigated' WHERE advisory_id = 'adv_gen000010' AND asset_id = 'rvs-mill-02'");
    const mitigated = await s.api('GET', '/plant/advisories?status=mitigated&limit=10');
    expect(mitigated.items.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([['adv_gen000010', 'mitigated']]);
    const open = await s.api('GET', '/plant/advisories?status=open&limit=200');
    expect(open.total).toBe(MATCHING - 1);
    expect(open.items.every((x: { status: string }) => x.status === 'open')).toBe(true);
    const unaffected = await s.api('GET', '/plant/advisories?affecting=0&status=unaffected&limit=1');
    expect(unaffected.total).toBe(N - MATCHING);
    // sort by updated, ascending: the oldest first
    const oldest = await s.api('GET', '/plant/advisories?affecting=0&sort=updated&order=asc&limit=1');
    expect(oldest.items[0].id).toBe('adv_gen000000');
    const byTitle = await s.api('GET', '/plant/advisories?affecting=0&sort=title&limit=3');
    expect(byTitle.items.map((x: { title: string }) => x.title)).toEqual([...byTitle.items.map((x: { title: string }) => x.title)].sort());
    // sort by affected assets: the advisories with a match first
    const byAffected = await s.api('GET', '/plant/advisories?affecting=0&sort=affected&limit=5');
    expect(byAffected.items.every((x: { affectedAssets: number }) => x.affectedAssets === 1)).toBe(true);
    // the last page
    const last = await s.api('GET', `/plant/advisories?affecting=0&limit=50&offset=${N - 20}`);
    expect(last.items).toHaveLength(20);
    expect(last.nextOffset).toBeNull();
  });

  it('/api/v1 pages with a cursor through the same query', async () => {
    const token = (await s.api('POST', '/me/tokens', { name: 'scale', scope: 'read' })).token as string;
    const v1 = async (url: string) => {
      const res = await fetch(`${s.base}/api/v1${url}`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status, await res.clone().text()).toBe(200);
      return res.json() as Promise<{ items: { id: string; severity: string }[]; nextCursor: string | null }>;
    };
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { items: { id: string }[]; nextCursor: string | null } = await v1(`/plant/advisories?limit=100${cursor ? `&cursor=${cursor}` : ''}`);
      for (const x of page.items) seen.add(x.id);
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen.size).toBe(MATCHING);
    expect(pages).toBe(3);
    const other = await fetch(`${s.base}/api/v1/plant/advisories?limit=100&severity=low&cursor=${(await v1('/plant/advisories?limit=100')).nextCursor}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(other.status).toBe(400);
  });
});

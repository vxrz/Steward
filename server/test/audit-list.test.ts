import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The audit log sorted and filtered by the server (0.13): GET /api/audit and /api/v1/audit with `sort`/`order`, the
 * keyset paging that stays complete and free of repeats while sorted, the filters, and the facets for the filters of
 * the audit page. Who may read the log does not change.
 */

let s: TestServer;
const PW = 'Demo-password-1';
const refused = (p: Promise<unknown>): Promise<{ status: number; body: any }> =>
  p.then(
    () => {
      throw new Error('not refused');
    },
    (e: { status: number; body: any }) => e,
  );

/** Test entries with invented actors and targets; ties on purpose (same actor, same target) to test the paging. */
const ACTORS = ['quinn.zeller', 'ada.brandt', 'Mila.Ost', 'ada.brandt', 'bo.lindqvist', 'quinn.zeller', 'ada.brandt'];
let tag = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  // the demo's people (audrey: auditor, vera: viewer)
  await s.api('POST', '/demo/setup', {});
  tag = `sortcheck${Date.now()}`;
  const { audit } = await import('../src/audit.js');
  ACTORS.forEach((actor, i) =>
    audit({
      actor,
      action: `${tag}.${['b', 'a', 'c'][i % 3]}`,
      entityType: i % 2 ? 'sortcheck_widget' : 'sortcheck_gadget',
      entityId: i === 4 ? null : `w-${i % 3}`,
      summary: `${tag} entry ${i}`,
    }),
  );
});

type Entry = { seq: number; actor: string; action: string; entityType: string; entityId?: string | null; ts: string };
const list = (query: string): Promise<Entry[]> => s.api('GET', `/audit?action=${tag}.&${query}`);

/** All pages of a sorted list, `size` entries at a time (the web app's "load more"). */
async function allPages(query: string, size: number, from = 0): Promise<Entry[]> {
  const out: Entry[] = [];
  let after = from;
  for (let i = 0; i < 50; i++) {
    const page = await list(`${query}&limit=${size}${after ? `&afterSeq=${after}` : ''}`);
    out.push(...page);
    if (page.length < size) return out;
    after = page.at(-1)!.seq;
  }
  throw new Error('paging does not end');
}

const bySeq = (a: Entry, b: Entry) => a.seq - b.seq;
const target = (e: Entry) => [e.entityType, e.entityId ?? ''];
/** The expected order: the column (byte order, like COLLATE "C" on PostgreSQL), then the chain order. */
function expected(rows: Entry[], key: (e: Entry) => string[], dir: 'asc' | 'desc'): number[] {
  const cmp = (a: Entry, b: Entry) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? -1 : 1;
    return a.seq - b.seq;
  };
  return [...rows].sort((a, b) => (dir === 'asc' ? cmp(a, b) : cmp(b, a))).map((e) => e.seq);
}

describe('sorted by the server', () => {
  it('defaults to newest first; time sorts by the chain order in both directions', async () => {
    const all = await list('');
    expect(all).toHaveLength(ACTORS.length);
    expect(all.map((e) => e.seq)).toEqual(
      [...all]
        .sort(bySeq)
        .reverse()
        .map((e) => e.seq),
    );
    expect((await list('sort=time&order=desc')).map((e) => e.seq)).toEqual(all.map((e) => e.seq));
    expect((await list('sort=time&order=asc')).map((e) => e.seq)).toEqual([...all].sort(bySeq).map((e) => e.seq));
  });

  it('sorts by actor, action and target, ties in the chain order', async () => {
    const all = await list('');
    for (const dir of ['asc', 'desc'] as const) {
      expect((await list(`sort=actor&order=${dir}`)).map((e) => e.seq)).toEqual(expected(all, (e) => [e.actor], dir));
      expect((await list(`sort=action&order=${dir}`)).map((e) => e.seq)).toEqual(expected(all, (e) => [e.action], dir));
      expect((await list(`sort=target&order=${dir}`)).map((e) => e.seq)).toEqual(expected(all, target, dir));
    }
    // the direction defaults to descending
    expect((await list('sort=actor')).map((e) => e.seq)).toEqual(expected(all, (e) => [e.actor], 'desc'));
  });

  it('pages through a sorted list without gaps or repeats, also when new entries arrive in between', async () => {
    const all = await list('');
    for (const sort of ['time', 'actor', 'action', 'target'] as const)
      for (const dir of ['asc', 'desc'] as const) {
        const key = sort === 'target' ? target : sort === 'time' ? () => [] : (e: Entry) => [e[sort]];
        for (const size of [1, 2, 3])
          expect(
            (await allPages(`sort=${sort}&order=${dir}`, size)).map((e) => e.seq),
            `${sort} ${dir} by ${size}`,
          ).toEqual(expected(all, key, dir));
      }
    // an entry written between two pages does not shift the pages that follow
    const first = await list('sort=actor&order=asc&limit=3');
    const { audit } = await import('../src/audit.js');
    audit({ actor: 'aaron.early', action: `${tag}.late`, entityType: 'sortcheck_gadget', summary: `${tag} late entry` });
    const rest = await allPages('sort=actor&order=asc', 2, first.at(-1)!.seq);
    expect([...first, ...rest].map((e) => e.seq)).toEqual(expected(all, (e) => [e.actor], 'asc'));
  });

  it('filters by actor, category, target type, text and time together with a sort', async () => {
    const ada = await list('actor=ada.brandt&sort=time&order=asc');
    expect(ada.map((e) => e.actor)).toEqual(['ada.brandt', 'ada.brandt', 'ada.brandt']);
    const widgets = await list('entityType=sortcheck_widget&sort=target&order=asc');
    expect(widgets.every((e) => e.entityType === 'sortcheck_widget')).toBe(true);
    expect(widgets.map((e) => e.seq)).toEqual(expected(widgets, target, 'asc'));
    expect((await s.api('GET', `/audit?action=${tag}.a&sort=actor&order=asc`)).every((e: Entry) => e.action === `${tag}.a`)).toBe(true);
    const text = await s.api('GET', `/audit?q=${tag}%20entry%205&sort=action`);
    expect(text.map((e: Entry) => e.actor)).toEqual(['quinn.zeller']);
    const [oldest] = await list('sort=time&order=asc&limit=1');
    expect(await list(`from=${encodeURIComponent(oldest!.ts)}&to=${encodeURIComponent(oldest!.ts)}`)).toEqual([]);
    expect((await list(`to=${encodeURIComponent(new Date(Date.parse(oldest!.ts) + 1).toISOString())}&sort=time&order=asc`))[0]?.seq).toBe(oldest!.seq);
  });

  it('refuses an unknown sort, beforeSeq with a sort and a cursor entry that is gone', async () => {
    expect((await refused(list('sort=summary'))).status).toBe(400);
    expect((await refused(list('order=sideways'))).status).toBe(400);
    expect((await refused(list('sort=actor&beforeSeq=5'))).body.code).toBe('AUDIT_CURSOR_SORT');
    // beforeSeq still continues the newest-first list
    const all = await list('');
    expect((await list(`beforeSeq=${all[1]!.seq}`)).map((e) => e.seq)).toEqual(all.slice(2).map((e) => e.seq));
    expect((await refused(list('sort=actor&afterSeq=999999999'))).body.code).toBe('AUDIT_CURSOR_UNKNOWN');
  });
});

describe('facets and permissions', () => {
  it('lists the actors and target types for the filters, sorted and distinct', async () => {
    const f = await s.api('GET', '/audit/facets');
    for (const a of ['ada.brandt', 'bo.lindqvist', 'Mila.Ost', 'quinn.zeller', 'admin']) expect(f.actors).toContain(a);
    expect(f.entityTypes).toEqual(expect.arrayContaining(['sortcheck_gadget', 'sortcheck_widget']));
    expect(new Set(f.actors).size).toBe(f.actors.length);
    expect(f.actors).toEqual([...f.actors].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('auditors read the sorted log and the facets; viewers do not', async () => {
    const audrey = await s.as('audrey', PW);
    expect((await audrey('GET', `/audit?action=${tag}.&sort=actor&order=asc`)).length).toBeGreaterThanOrEqual(ACTORS.length);
    expect((await audrey('GET', '/audit/facets')).actors.length).toBeGreaterThan(0);
    const vera = await s.as('vera', PW);
    expect((await refused(vera('GET', `/audit?sort=actor`))).status).toBe(403);
    expect((await refused(vera('GET', '/audit/facets'))).status).toBe(403);
  });
});

describe('public API', () => {
  it('sorts with sort/order and pages with the cursor in the same order', async () => {
    const all = await list('');
    const { token } = await s.api('POST', '/me/tokens', { name: 'audit sort', scope: 'read' });
    const v1 = async (q: string) => {
      const r = await fetch(`${s.base}/api/v1/audit?action=${tag}.&${q}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, body: (await r.json()) as any };
    };
    const seen: number[] = [];
    let cursor = '';
    for (let i = 0; i < 20; i++) {
      const r = await v1(`sort=target&order=asc&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((e: Entry) => e.seq));
      if (!r.body.nextCursor) break;
      cursor = r.body.nextCursor;
    }
    expect(seen).toEqual(expected(all, target, 'asc').filter((seq) => all.some((e) => e.seq === seq)));
    // a cursor belongs to its order
    const page = await v1('sort=actor&limit=1');
    expect((await v1(`sort=action&limit=1&cursor=${page.body.nextCursor}`)).status).toBe(400);
    expect((await v1('sort=nonsense')).status).toBe(400);
  });
});

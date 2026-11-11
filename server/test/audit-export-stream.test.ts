import { beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, loginCookie, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * The interactive audit export (GET /api/audit/export) reads and writes the chain page by page (security review 0.19.0
 * M2): it held the whole chain and the whole file in memory. The files stay the same and still verify offline.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';

let s: TestServer;
let cookie = '';
const ENTRIES = 12_345;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { audit } = await import('../src/audit.js');
  const { db } = await import('../src/db.js');
  db().tx(() => {
    for (let i = 0; i < ENTRIES; i++) audit({ action: 'test.entry', entityType: 'test', summary: `entry ${i}, "quoted"` });
  });
  cookie = await loginCookie(s.base, 'admin', 'Admin-password-1');
}, 120_000);

async function download(format: string): Promise<{ text: string; type: string }> {
  const res = await fetch(`${s.base}/api/audit/export?format=${format}`, { headers: authHeaders(cookie) });
  expect(res.status).toBe(200);
  return { text: await res.text(), type: res.headers.get('content-type') ?? '' };
}

const chainSize = async () => {
  const { db } = await import('../src/db.js');
  return Number(db().get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE seq >= 1')!.n);
};

describe('audit export in pages', () => {
  it('writes every entry as JSON lines, without the entry of the export itself', async () => {
    const { text, type } = await download('jsonl');
    expect(type).toContain('application/x-ndjson');
    const lines = text.split('\n');
    // as before: no line break after the last entry
    expect(lines.at(-1)).not.toBe('');
    const seqs = lines.map((l) => JSON.parse(l).seq as number);
    expect(seqs[0]).toBe(1);
    expect(seqs.every((x, i) => i === 0 || x === seqs[i - 1]! + 1)).toBe(true);
    // up to the entry before the export's own
    expect(seqs.at(-1)).toBe((await chainSize()) - 1);
    expect(lines.some((l) => l.includes('"audit.exported"'))).toBe(false);
  });

  it('writes CSV with one header line', async () => {
    const { text } = await download('csv');
    const rows = text.trimEnd().split('\r\n');
    expect(rows[0]).toBe('seq,ts,actor,action,entityType,entityId,runId,summary,details,prevHash,hash');
    expect(rows.filter((r) => r.includes('test.entry'))).toHaveLength(ENTRIES);
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('writes the JSON bundle that verifies offline', async () => {
    const { text } = await download('json');
    const bundle = JSON.parse(text);
    expect(bundle).toMatchObject({ format: 'steward-audit-export', version: 1, checkpoint: { seq: expect.any(Number) } });
    expect(bundle.entries.filter((e: any) => e.action === 'test.entry')).toHaveLength(ENTRIES);
    const { verifyExport } = await import('../src/cli/audit-verify-export.js');
    const x = verifyExport({
      entries: bundle.entries,
      checkpoints: [{ source: 'export', cp: bundle.checkpoint }],
      publicKey: bundle.publicKeyPem,
      keySource: 'option',
    });
    expect(x.problems).toEqual([]);
  });

  it('reads the chain in pages of 5,000', async () => {
    const { db } = await import('../src/db.js');
    const d = db() as unknown as { all: (...a: unknown[]) => unknown[] };
    const original = d.all.bind(d);
    const limits: unknown[] = [];
    d.all = (sql: unknown, ...args: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('FROM audit_log WHERE seq > ? AND seq <= ?')) limits.push(args.at(-1));
      return original(sql, ...args);
    };
    try {
      await download('jsonl');
    } finally {
      d.all = original;
    }
    expect(limits.length).toBeGreaterThanOrEqual(3);
    expect(limits.every((l) => l === 5000)).toBe(true);
  });
});

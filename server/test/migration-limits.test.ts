import crypto from 'node:crypto';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { AuditCheckpoint, AuditEntry } from '@sm/shared';

/**
 * A migration package is read within bounds: the audit history is checked and taken over line by line (never held in
 * memory as a whole, each line capped), what a package unpacks to has an absolute ceiling, and nothing is unpacked
 * without room on the disk.
 */
async function* chunks(...parts: Buffer[]): AsyncGenerator<Buffer> {
  for (const p of parts) yield p;
}
async function collect(g: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const l of g) out.push(l);
  return out;
}

describe('lines of a package entry', () => {
  it('keeps a character that is split between two chunks, skips empty lines and caps the length', async () => {
    const { splitLines } = await import('../src/migration/import.js');
    const text = Buffer.from('{"name":"Müller"}\n\n{"name":"Groß"}\n', 'utf8');
    const cut = text.indexOf(Buffer.from('ü')) + 1; // between the two bytes of "ü"
    expect(await collect(splitLines(chunks(text.subarray(0, cut), text.subarray(cut)), 1000, 'x'))).toEqual(['{"name":"Müller"}', '{"name":"Groß"}']);
    await expect(collect(splitLines(chunks(Buffer.from('a'.repeat(50)), Buffer.from('\nb')), 40, 'audit.jsonl'))).rejects.toMatchObject({
      code: 'MIGRATION_PACKAGE_INVALID',
    });
    // also a long line without any newline
    await expect(collect(splitLines(chunks(Buffer.from('a'.repeat(30)), Buffer.from('a'.repeat(30))), 40, 'audit.jsonl'))).rejects.toMatchObject({
      code: 'MIGRATION_PACKAGE_INVALID',
    });
  });
});

describe('the audit history of a package, entry by entry', () => {
  const key = crypto.generateKeyPairSync('ed25519');
  const spki = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  async function history(n: number): Promise<{ entries: AuditEntry[]; cp: AuditCheckpoint }> {
    const { DIGEST_SEED, GENESIS, checkpointPayload, digestStep } = await import('../src/audit.js');
    const { publicKeyFingerprint } = await import('../src/vault.js');
    const entries: AuditEntry[] = [];
    let digest = DIGEST_SEED;
    for (let seq = 1; seq <= n; seq++) {
      const e: AuditEntry = {
        seq,
        ts: `2026-01-01T00:00:0${seq}.000Z`,
        actor: 'dana',
        action: 'test.entry',
        entityType: 'test',
        entityId: null,
        runId: null,
        summary: `Entry ${seq}`,
        details: { n: seq },
        prevHash: seq === 1 ? GENESIS : `h${seq - 1}`,
        hash: `h${seq}`,
      };
      digest = digestStep(digest, e);
      entries.push(e);
    }
    const body = { v: 1 as const, seq: n, hash: `h${n}`, digest, count: n, ts: '2026-01-02T00:00:00.000Z', keyFingerprint: publicKeyFingerprint(spki) };
    const signature = crypto.sign(null, Buffer.from(checkpointPayload(body)), key.privateKey).toString('base64');
    return { entries, cp: { ...body, signature } };
  }

  async function check(entries: AuditEntry[], cp: AuditCheckpoint, expected = entries.length, lines?: string[]) {
    const { HistoryVerifier } = await import('../src/migration/history.js');
    const v = new HistoryVerifier(cp, spki);
    for (const l of lines ?? entries.map((e) => JSON.stringify(e))) v.addLine(l);
    return v.result(expected);
  }

  it('accepts an unbroken history that ends at the signed checkpoint', async () => {
    const { entries, cp } = await history(5);
    expect(await check(entries, cp)).toMatchObject({ ok: true, entries: 5 });
  });

  it('refuses a missing, a changed, an extra or an unreadable entry, a wrong count and a forged checkpoint', async () => {
    const { entries, cp } = await history(5);
    expect(
      (
        await check(
          entries.filter((e) => e.seq !== 3),
          cp,
          5,
        )
      ).message,
    ).toContain('Entry #3 is missing');
    expect((await check(entries.slice(0, 4), cp, 5)).message).toContain('not in the history');
    const changed = entries.map((e) => (e.seq === 2 ? { ...e, summary: 'changed' } : e));
    expect((await check(changed, cp)).message).toContain('digest');
    const more = await history(6);
    expect((await check(more.entries, cp, 6)).message).toContain('after the signed checkpoint');
    expect((await check(entries, cp, 6)).message).toContain('5 of 6');
    const lines = entries.map((e) => JSON.stringify(e));
    lines[1] = '{"seq": "two"}';
    expect((await check(entries, cp, 5, lines)).ok).toBe(false);
    expect((await check(entries, { ...cp, digest: 'f'.repeat(64) })).message).toContain('signature');
  });
});

describe('size and disk space', () => {
  it('has an absolute ceiling for what a package unpacks to (SM_MIGRATION_MAX_UNPACKED_MB, default 20 GiB)', async () => {
    const { checkUnpackedSize, maxUnpackedBytes } = await import('../src/migration/import.js');
    expect(maxUnpackedBytes()).toBe(20 * 1024 ** 3);
    process.env.SM_MIGRATION_MAX_UNPACKED_MB = '10';
    try {
      expect(() => checkUnpackedSize(10 * 1024 ** 2)).not.toThrow();
      expect(() => checkUnpackedSize(10 * 1024 ** 2 + 1)).toThrow(expect.objectContaining({ code: 'MIGRATION_UNPACKED_TOO_LARGE', statusCode: 413 }));
    } finally {
      delete process.env.SM_MIGRATION_MAX_UNPACKED_MB;
    }
  });

  it('refuses to unpack without room on the disk', async () => {
    const { freeBytes, requireFreeSpace } = await import('../src/migration/import.js');
    expect(freeBytes(os.tmpdir())).toBeGreaterThan(0);
    expect(() => requireFreeSpace(os.tmpdir(), 100 * 1024 ** 2, 2 * 1024 ** 3)).not.toThrow();
    expect(() => requireFreeSpace(os.tmpdir(), 2 * 1024 ** 3, 2 * 1024 ** 3)).toThrow(
      expect.objectContaining({ code: 'MIGRATION_DISK_SPACE', statusCode: 507 }),
    );
    expect(() => requireFreeSpace(os.tmpdir(), Number.MAX_SAFE_INTEGER)).toThrow(expect.objectContaining({ code: 'MIGRATION_DISK_SPACE' }));
  });
});

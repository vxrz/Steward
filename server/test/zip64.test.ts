import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { ZIP_MAX_ENTRIES, ZipFormatError, ZipReader, ZipWriter } from '../src/compliance/zip.js';

/**
 * ZIP64 in the backup archive (O4 of the 0.10 review): past 4 GB, files over 4 GB and more than 65,535 files – tested
 * without writing gigabytes. The count is real (70,000 empty files); the sizes and offsets use the writer's test limits,
 * which put the ZIP64 records in for small values, so every record is written and read; Info-ZIP's unzip and Python's
 * zipfile (when installed, as on CI runners) read the same files, so they are real ZIP64 and not only our own dialect.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-zip64-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(dir, `a${n++}.zip`);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

const hasPython = spawnSync('python3', ['--version']).status === 0;
const hasUnzip = spawnSync('unzip', ['-v']).status === 0;
/** Python's zipfile: every entry's name and content hash (it checks the CRCs too). */
function pythonRead(zip: string): { count: number; digest: Record<string, string> } {
  const script = [
    'import hashlib, json, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'bad = z.testzip()',
    'assert bad is None, bad',
    'names = z.namelist()',
    'print(json.dumps({"count": len(names), "digest": {n: hashlib.sha256(z.read(n)).hexdigest() for n in names[:50] + names[-50:]}}))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-I', '-c', script, zip], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** Reads every entry back and compares it with what was written. */
async function readBack(zip: string, written: Map<string, Buffer>, o = { zip64: true }) {
  const r = await ZipReader.open(zip, o);
  expect(r.entries.map((e) => e.name)).toEqual([...written.keys()]);
  for (const [name, content] of written) {
    const e = r.find(name)!;
    const d = await r.digest(e);
    expect({ name, ok: d.crcOk, sha: d.sha256 }).toEqual({ name, ok: true, sha: sha(content) });
  }
  return r;
}

describe('ZIP64 archives', () => {
  it('hold more than 65,535 files (ZIP64 end records), read by us, unzip and Python', async () => {
    const zip = file();
    const w = await ZipWriter.create(zip, undefined, { zip64: true });
    const count = 70_000;
    for (let i = 0; i < count; i++) await w.add(`data/f${String(i).padStart(6, '0')}`, Buffer.alloc(0));
    await w.add('manifest.json', Buffer.from('{"ok":true}'));
    expect(await w.finish()).toMatchObject({ entries: count + 1 });
    const raw = fs.readFileSync(zip);
    // the plain end record points to the ZIP64 one
    expect(raw.readUInt32LE(raw.length - 22)).toBe(0x06054b50);
    expect(raw.readUInt16LE(raw.length - 22 + 10)).toBe(0xffff);
    expect(raw.readUInt32LE(raw.length - 42)).toBe(0x07064b50);
    const r = await ZipReader.open(zip, { zip64: true });
    expect(r.entries).toHaveLength(count + 1);
    expect((await r.read(r.find('manifest.json')!)).toString()).toBe('{"ok":true}');
    expect(r.find('data/f069999')).toMatchObject({ usize: 0, csize: 0 });
    // other readers of the package (evidence packs, migration, libraries) still refuse ZIP64
    await expect(ZipReader.open(zip)).rejects.toThrow(/Unsupported ZIP file \(ZIP64\)/);
    if (hasPython) expect(pythonRead(zip).count).toBe(count + 1);
    if (hasUnzip) expect(execFileSync('unzip', ['-tqq', zip], { encoding: 'utf8' }).trim()).toBe('');
  }, 120_000);

  it('are refused past 65,000 files without ZIP64, as before', async () => {
    const w = await ZipWriter.create(file());
    for (let i = 0; i < ZIP_MAX_ENTRIES; i++) await w.add(`f${i}`, Buffer.alloc(0));
    await expect(w.add('one-more', Buffer.alloc(0))).rejects.toThrow(`More than ${ZIP_MAX_ENTRIES} files`);
    await w.abort();
  }, 120_000);

  it('write sizes and offsets past the 32-bit limit as ZIP64 fields (test limits), stored and deflated', async () => {
    const zip = file();
    // with a 32-bit limit of 4096 bytes and a 16-bit one of 3 entries, the second half of the archive needs ZIP64
    // offsets, the large files ZIP64 sizes, and the end needs the ZIP64 end records
    const w = await ZipWriter.create(zip, undefined, { zip64: true, limits: { u32: 4096, u16: 3 } });
    const written = new Map<string, Buffer>();
    const put = async (name: string, content: Buffer, o: { compress?: boolean; stream?: boolean } = {}) => {
      written.set(name, content);
      await w.add(name, o.stream ? Readable.from([content.subarray(0, 1000), content.subarray(1000)]) : content, { compress: o.compress });
    };
    await put('small.txt', Buffer.from('small'));
    await put('big.bin', crypto.randomBytes(10_000));
    await put('big-deflated.txt', Buffer.from('x'.repeat(20_000)), { compress: true });
    await put('streamed.bin', crypto.randomBytes(5000), { stream: true });
    await put('after-4gb.txt', Buffer.from('this local header starts past the 32-bit offset limit'));
    await w.finish();
    await readBack(zip, written);
    // the reader of plain archives refuses it
    await expect(ZipReader.open(zip)).rejects.toThrow(ZipFormatError);
    if (hasPython) {
      const p = pythonRead(zip);
      expect(p.count).toBe(written.size);
      for (const [name, content] of written) expect(p.digest[name], name).toBe(sha(content));
    }
    if (hasUnzip) {
      const out = path.join(dir, `x${n}`);
      execFileSync('unzip', ['-qq', zip, '-d', out]);
      for (const [name, content] of written) expect(sha(fs.readFileSync(path.join(out, name))), name).toBe(sha(content));
    }
  });

  it('stay plain PKZIP 2.0 – readable by earlier versions – while nothing needs ZIP64', async () => {
    const a = file();
    const b = file();
    const mtime = new Date('2026-11-08T10:00:00Z');
    for (const [f, o] of [
      [a, { zip64: true }],
      [b, {}],
    ] as const) {
      const w = await ZipWriter.create(f, undefined, o);
      await w.add('database/steward.db', Buffer.from('SQLite format 3\0…'), { mtime });
      await w.add('data/vault.json', Buffer.from('{}'), { mtime, compress: true });
      await w.finish();
    }
    expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
    // what 0.10 accepts: the strict reader without ZIP64
    expect((await ZipReader.open(a)).entries.map((e) => e.name)).toEqual(['database/steward.db', 'data/vault.json']);
  });

  it('give a file whose size is unknown up front a ZIP64 local header, and one that may pass 4 GB too', async () => {
    const zip = file();
    const w = await ZipWriter.create(zip, undefined, { zip64: true, limits: { u32: 100_000 } });
    const content = crypto.randomBytes(60_000);
    const src = path.join(dir, 'large-file.bin');
    fs.writeFileSync(src, content);
    await w.addFile('from-file.bin', src); // 60,000 ≥ half the limit: ZIP64 local header (sizes in the extra field)
    await w.add('stream.bin', Readable.from([Buffer.from('abc')])); // size unknown: ZIP64 local header
    await w.add('known.bin', Buffer.from('abc')); // a buffer: plain
    await w.finish();
    const raw = fs.readFileSync(zip);
    expect(raw.readUInt32LE(18)).toBe(0xffffffff);
    expect(raw.readUInt16LE(28)).toBe(20); // a ZIP64 extra field with both sizes
    const r = await readBack(
      zip,
      new Map([
        ['from-file.bin', content],
        ['stream.bin', Buffer.from('abc')],
        ['known.bin', Buffer.from('abc')],
      ]),
    );
    expect(r.find('stream.bin')).toMatchObject({ usize: 3, csize: 3 });
    if (hasPython) expect(pythonRead(zip).count).toBe(3);
  });

  it('refuse a file that grows past the 32-bit limit without a ZIP64 local header', async () => {
    const w = await ZipWriter.create(file(), undefined, { zip64: true, limits: { u32: 1000 } });
    // announced as small, but 2,000 bytes come
    await expect(w.add('liar.bin', Readable.from([crypto.randomBytes(2000)]), { size: 10 })).rejects.toThrow(/grew past 4 GB/);
    await w.abort();
  });

  it('are checked as strictly as plain ones: a changed ZIP64 size is found', async () => {
    const zip = file();
    const w = await ZipWriter.create(zip, undefined, { zip64: true, limits: { u32: 1000, u16: 1 } });
    await w.add('a.bin', crypto.randomBytes(3000));
    await w.add('b.bin', crypto.randomBytes(10));
    await w.finish();
    const raw = fs.readFileSync(zip);
    // the local header's ZIP64 extra field of a.bin: usize at 30 + name (5) + 4
    const changed = Buffer.from(raw);
    changed.writeBigUInt64LE(2999n, 30 + 5 + 4);
    const bad = file();
    fs.writeFileSync(bad, changed);
    await expect(ZipReader.open(bad, { zip64: true })).rejects.toThrow(/local header of a\.bin differs/);
    // trailing data after the end record
    const tail = file();
    fs.writeFileSync(tail, Buffer.concat([raw, Buffer.from('x')]));
    await expect(ZipReader.open(tail, { zip64: true })).rejects.toThrow(ZipFormatError);
  });
});

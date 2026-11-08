import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';

/**
 * A small streaming ZIP writer and reader (PKZIP 2.0: stored and deflated entries, UTF-8 names). The writer streams
 * every entry straight to the file and patches the local header afterwards, so large files are never held in memory.
 * The reader never extracts to disk: it streams one entry at a time with a hard limit on the inflated size (zip bombs).
 *
 * ZIP64 (PKWARE APPNOTE 4.5.3, version 4.5) only where it is asked for (`zip64: true`, backups): archives over 4 GB,
 * files over 4 GB and more than 65,535 files. Even then only what does not fit gets ZIP64 records – an entry whose
 * size, or offset, fits in 32 bits is written exactly as without ZIP64, and the ZIP64 end records are only written when
 * the count, the size or the offset of the central directory needs them – so an archive within the old limits is
 * byte for byte what earlier versions wrote, and earlier versions can read it. Everything else (evidence packs,
 * migration packages, libraries) stays PKZIP 2.0 below 4 GB, and its readers refuse ZIP64.
 */

const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;
export const ZIP_MAX_ENTRIES = 65000;
/** ZIP64 archives: most entries (the central directory is kept in memory while writing and reading). */
export const ZIP64_MAX_ENTRIES = 2_000_000;
const ZIP64_EXTRA = 0x0001;

export interface ZipWriterOptions {
  /** Write ZIP64 records where needed (archives, files over 4 GB, more than 65,535 files). Default false. */
  zip64?: boolean;
  /**
   * Tests only: the largest value written into a 32-bit field (default 0xFFFFFFFE) and into the 16-bit entry count
   * (default 0xFFFE), so the ZIP64 records can be tested with small files.
   */
  limits?: { u32?: number; u16?: number };
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** Entry names: relative, forward slashes, no "..", no control characters. */
export function safeEntryName(name: string): string {
  const n = name.replace(/\\/g, '/').replace(/^\/+/, '');
  // eslint-disable-next-line no-control-regex -- control characters are rejected on purpose
  if (!n || n.split('/').some((p) => p === '..' || p === '.' || p === '') || /[\u0000-\u001f\u007f]/.test(n) || Buffer.byteLength(n) > 1000)
    throw new Error(`Invalid entry name "${name.slice(0, 100)}"`);
  return n;
}

interface Central {
  name: Buffer;
  method: number;
  time: number;
  date: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  /** The local header has a ZIP64 extra field with both sizes (the sizes in it are 0xFFFFFFFF) */
  local64: boolean;
}

/** A ZIP64 extended information extra field with the given 64-bit values. */
function zip64Extra(values: number[]): Buffer {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(ZIP64_EXTRA, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

export interface WrittenEntry {
  path: string;
  size: number;
  sha256: string;
}

export class ZipWriter {
  private entries: Central[] = [];
  private names = new Set<string>();
  private offset = 0;
  private readonly zip64: boolean;
  private readonly u32: number;
  private readonly u16: number;
  private readonly maxEntries: number;
  private constructor(
    private fh: fs.promises.FileHandle,
    private readonly maxBytes: number,
    o: ZipWriterOptions,
  ) {
    this.zip64 = o.zip64 === true;
    this.u32 = o.limits?.u32 ?? MAX_U32 - 1;
    this.u16 = o.limits?.u16 ?? MAX_U16 - 1;
    this.maxEntries = this.zip64 ? ZIP64_MAX_ENTRIES : ZIP_MAX_ENTRIES;
  }

  /** Creates the file (it must not exist). Without ZIP64 an archive stays below 4 GB (minus 1 MB for its directory). */
  static async create(file: string, maxBytes?: number, o: ZipWriterOptions = {}): Promise<ZipWriter> {
    const limit = o.zip64 ? (maxBytes ?? Number.MAX_SAFE_INTEGER) : Math.min(maxBytes ?? MAX_U32, MAX_U32 - 1024 * 1024);
    return new ZipWriter(await fs.promises.open(file, 'wx', 0o600), limit, o);
  }

  get bytesWritten(): number {
    return this.offset;
  }

  /** Writes at the end of what was written so far, or at `position` (header patches); always positional. */
  private async write(buf: Buffer, position?: number): Promise<void> {
    const at = position ?? this.offset;
    if (position === undefined) this.offset += buf.length;
    let done = 0;
    while (done < buf.length) {
      const { bytesWritten } = await this.fh.write(buf, done, buf.length - done, at + done);
      done += bytesWritten;
    }
    if (this.offset > this.maxBytes) throw new ZipLimitError(`The pack would exceed ${Math.floor(this.maxBytes / 1024 / 1024)} MB`);
  }

  /**
   * Adds an entry from a stream (or a buffer); deflates when `compress` is set. Returns size and SHA-256 of the content.
   * `size`: the expected size of a stream (ZIP64: a file that may pass 4 GB gets its ZIP64 local header up front).
   */
  async add(path: string, source: Readable | Buffer, o: { compress?: boolean; mtime?: Date; size?: number } = {}): Promise<WrittenEntry> {
    const nameStr = safeEntryName(path);
    if (this.names.has(nameStr)) throw new Error(`Duplicate entry ${nameStr}`);
    if (this.entries.length >= this.maxEntries) throw new ZipLimitError(`More than ${this.maxEntries} files`);
    this.names.add(nameStr);
    const name = Buffer.from(nameStr, 'utf8');
    const method = o.compress ? 8 : 0;
    const { time, date } = dosTime(o.mtime ?? new Date());
    const headerAt = this.offset;
    // the local header is written before the sizes are known: a ZIP64 one for anything that may need it (half the
    // limit leaves room for a file that grows while it is read, and for deflate output larger than its input)
    const expected = Buffer.isBuffer(source) ? source.length : o.size;
    const local64 = this.zip64 && (expected === undefined || expected >= Math.floor(this.u32 / 2));
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(local64 ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    if (local64) {
      header.writeUInt32LE(MAX_U32, 18);
      header.writeUInt32LE(MAX_U32, 22);
    }
    header.writeUInt16LE(name.length, 26);
    const extra = local64 ? zip64Extra([0, 0]) : Buffer.alloc(0);
    header.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([header, name, extra]));
    let crc = 0;
    let usize = 0;
    let csize = 0;
    const hash = crypto.createHash('sha256');
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        csize += chunk.length;
        this.write(chunk).then(() => cb(), cb);
      },
    });
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        crc = zlib.crc32(chunk, crc);
        usize += chunk.length;
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const src = Buffer.isBuffer(source) ? Readable.from([source]) : source;
    if (method === 8) await pipeline(src, tap, zlib.createDeflateRaw({ level: 6 }), sink);
    else await pipeline(src, tap, sink);
    if (!local64 && (usize > this.u32 || csize > this.u32))
      throw new ZipLimitError(this.zip64 ? 'A file grew past 4 GB while it was added' : 'A file is larger than 4 GB');
    if (local64) {
      const c = Buffer.alloc(4);
      c.writeUInt32LE(crc >>> 0, 0);
      await this.write(c, headerAt + 14);
      await this.write(zip64Extra([usize, csize]).subarray(4), headerAt + 30 + name.length + 4);
    } else {
      const patch = Buffer.alloc(12);
      patch.writeUInt32LE(crc >>> 0, 0);
      patch.writeUInt32LE(csize, 4);
      patch.writeUInt32LE(usize, 8);
      await this.write(patch, headerAt + 14);
    }
    this.entries.push({ name, method, time, date, crc: crc >>> 0, csize, usize, offset: headerAt, local64 });
    return { path: nameStr, size: usize, sha256: hash.digest('hex') };
  }

  async addFile(path: string, file: string, o: { compress?: boolean } = {}): Promise<WrittenEntry> {
    const size = this.zip64 ? (await fs.promises.stat(file)).size : undefined;
    return this.add(path, fs.createReadStream(file), { ...o, size });
  }

  async finish(): Promise<{ size: number; entries: number }> {
    const cdStart = this.offset;
    // written in batches: one write per entry is slow for a million files
    let batch: Buffer[] = [];
    let batched = 0;
    const flush = async () => {
      if (batch.length) await this.write(Buffer.concat(batch));
      batch = [];
      batched = 0;
    };
    for (const e of this.entries) {
      const sizes64 = e.local64 || e.usize > this.u32 || e.csize > this.u32;
      const offset64 = e.offset > this.u32;
      const extra = sizes64 || offset64 ? zip64Extra([...(sizes64 ? [e.usize, e.csize] : []), ...(offset64 ? [e.offset] : [])]) : Buffer.alloc(0);
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(extra.length ? 0x032d : 0x0314, 4); // made by: UNIX, 4.5 (ZIP64) or 2.0
      h.writeUInt16LE(extra.length || e.local64 ? 45 : 20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(sizes64 ? MAX_U32 : e.csize, 20);
      h.writeUInt32LE(sizes64 ? MAX_U32 : e.usize, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt16LE(extra.length, 30);
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
      h.writeUInt32LE(offset64 ? MAX_U32 : e.offset, 42);
      batch.push(h, e.name, extra);
      batched += 46 + e.name.length + extra.length;
      if (batched > 1024 * 1024) await flush();
    }
    await flush();
    const cdSize = this.offset - cdStart;
    const count = this.entries.length;
    // ZIP64 end records only when the plain end record cannot hold the values; then all three say "see ZIP64"
    const end64 = this.zip64 && (count > this.u16 || cdSize > this.u32 || cdStart > this.u32);
    if (end64) {
      const recordAt = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(44n, 4); // size of the rest of the record
      r.writeUInt16LE(0x032d, 12); // made by: UNIX, 4.5
      r.writeUInt16LE(45, 14);
      r.writeBigUInt64LE(BigInt(count), 24);
      r.writeBigUInt64LE(BigInt(count), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordAt), 8);
      locator.writeUInt32LE(1, 16); // disks
      await this.write(Buffer.concat([r, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(end64 ? MAX_U16 : count, 8);
    end.writeUInt16LE(end64 ? MAX_U16 : count, 10);
    end.writeUInt32LE(end64 ? MAX_U32 : cdSize, 12);
    end.writeUInt32LE(end64 ? MAX_U32 : cdStart, 16);
    await this.write(end);
    await this.fh.close();
    return { size: this.offset, entries: count };
  }

  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined); // aborting after a failure: the file is removed by the caller
  }
}

export class ZipLimitError extends Error {}
export class ZipFormatError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

/** The ZIP64 extended information of an extra field block: the values in the order of the fields marked 0xFFFFFFFF. */
function readZip64Extra(extra: Buffer, want: number, what: string): number[] {
  let p = 0;
  let found: number[] | undefined;
  while (p < extra.length) {
    if (p + 4 > extra.length) throw new ZipFormatError(`Broken ZIP file (extra field of ${what})`);
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) throw new ZipFormatError(`Broken ZIP file (extra field of ${what})`);
    if (id === ZIP64_EXTRA) {
      if (found || len < 8 * want) throw new ZipFormatError(`Broken ZIP file (ZIP64 field of ${what})`);
      found = [];
      for (let i = 0; i < want; i++) {
        const v = extra.readBigUInt64LE(p + 4 + 8 * i);
        if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError(`Unsupported ZIP file (${what} is too large)`);
        found.push(Number(v));
      }
    }
    p += 4 + len;
  }
  if (!found) throw new ZipFormatError(`Broken ZIP file (${what} has no ZIP64 field)`);
  return found;
}

export interface ZipReaderOptions {
  /** Accept ZIP64 records (as ZipWriter writes them with `zip64`: backups). Default false: refused. */
  zip64?: boolean;
}

/**
 * Reads the central directory of a ZIP file; entries are streamed on demand. Only well-formed archives
 * as ZipWriter writes them are accepted: one disk, no ZIP64 (unless `zip64`), no encryption or data descriptors, every
 * local header matching its central directory entry, and the entries, the central directory and the
 * end record covering the file without gaps, overlaps or trailing bytes – so no data can hide in a
 * pack outside what the verifier checks.
 */
export class ZipReader {
  private constructor(
    readonly file: string,
    readonly size: number,
    readonly entries: ZipEntry[],
  ) {}

  static async open(file: string, o: ZipReaderOptions = {}): Promise<ZipReader> {
    const fh = await fs.promises.open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (size < 22) throw new ZipFormatError('Not a ZIP file (too small)');
      const tailLen = Math.min(size, 22 + 65535);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new ZipFormatError('Not a ZIP file (no end of central directory)');
      const eocdAt = size - tailLen + eocd;
      let count = tail.readUInt16LE(eocd + 10);
      let cdSize = tail.readUInt32LE(eocd + 12);
      let cdOffset = tail.readUInt32LE(eocd + 16);
      const commentLen = tail.readUInt16LE(eocd + 20);
      if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0 || tail.readUInt16LE(eocd + 8) !== count)
        throw new ZipFormatError('Unsupported ZIP file (several disks)');
      const end64 = count === MAX_U16 || cdSize === MAX_U32 || cdOffset === MAX_U32;
      if (end64 && !o.zip64) throw new ZipFormatError('Unsupported ZIP file (ZIP64)');
      if (eocdAt + 22 + commentLen !== size) throw new ZipFormatError('Broken ZIP file (data after the end of the archive)');
      /** where the central directory must end: the end record, or the ZIP64 end record before it */
      let cdEnd = eocdAt;
      if (end64) {
        if (eocdAt < 20 + 56) throw new ZipFormatError('Broken ZIP file (no ZIP64 end record)');
        const locator = Buffer.alloc(20);
        await fh.read(locator, 0, 20, eocdAt - 20);
        if (locator.readUInt32LE(0) !== 0x07064b50) throw new ZipFormatError('Broken ZIP file (no ZIP64 end record locator)');
        const recordAt = Number(locator.readBigUInt64LE(8));
        if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new ZipFormatError('Unsupported ZIP file (several disks)');
        if (recordAt + 56 !== eocdAt - 20) throw new ZipFormatError('Broken ZIP file (data around the ZIP64 end record)');
        const r = Buffer.alloc(56);
        await fh.read(r, 0, 56, recordAt);
        if (r.readUInt32LE(0) !== 0x06064b50 || r.readBigUInt64LE(4) !== 44n) throw new ZipFormatError('Broken ZIP file (ZIP64 end record)');
        if (r.readUInt32LE(16) !== 0 || r.readUInt32LE(20) !== 0 || r.readBigUInt64LE(24) !== r.readBigUInt64LE(32))
          throw new ZipFormatError('Unsupported ZIP file (several disks)');
        const big = [r.readBigUInt64LE(32), r.readBigUInt64LE(40), r.readBigUInt64LE(48)];
        if (big.some((v) => v > BigInt(size))) throw new ZipFormatError('Broken ZIP file (ZIP64 end record)');
        [count, cdSize, cdOffset] = big.map(Number) as [number, number, number];
        if (count > ZIP64_MAX_ENTRIES) throw new ZipLimitError(`More than ${ZIP64_MAX_ENTRIES} files`);
        cdEnd = recordAt;
      }
      if (cdOffset + cdSize !== cdEnd) throw new ZipFormatError('Broken ZIP file (data between the central directory and its end record)');
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries: ZipEntry[] = [];
      const names: Buffer[] = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipFormatError('Broken ZIP file (central directory entry)');
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen2 = cd.readUInt16LE(p + 32);
        const flags = cd.readUInt16LE(p + 8);
        if (flags & 0x0009) throw new ZipFormatError('Unsupported ZIP file (encrypted entries or data descriptors)');
        if (p + 46 + nameLen + extraLen + commentLen2 > cd.length) throw new ZipFormatError('Broken ZIP file (central directory entry)');
        const name = cd.subarray(p + 46, p + 46 + nameLen);
        const entry: ZipEntry = {
          method: cd.readUInt16LE(p + 10),
          crc: cd.readUInt32LE(p + 16),
          csize: cd.readUInt32LE(p + 20),
          usize: cd.readUInt32LE(p + 24),
          offset: cd.readUInt32LE(p + 42),
          name: name.toString('utf8'),
        };
        if (o.zip64 && (entry.usize === MAX_U32 || entry.csize === MAX_U32 || entry.offset === MAX_U32)) {
          if (cd.readUInt16LE(p + 34) !== 0) throw new ZipFormatError('Unsupported ZIP file (several disks)');
          const marked = [entry.usize === MAX_U32, entry.csize === MAX_U32, entry.offset === MAX_U32];
          const values = readZip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), marked.filter(Boolean).length, entry.name);
          if (marked[0]) entry.usize = values.shift()!;
          if (marked[1]) entry.csize = values.shift()!;
          if (marked[2]) entry.offset = values.shift()!;
        }
        if (entry.offset + 30 > size) throw new ZipFormatError(`Broken ZIP file (entry ${entry.name})`);
        entries.push(entry);
        names.push(Buffer.from(name));
        p += 46 + nameLen + extraLen + commentLen2;
      }
      if (p !== cdSize) throw new ZipFormatError('Broken ZIP file (the central directory has more data than its entries)');
      // every local header matches its central directory entry; the entries cover the file up to the central directory
      const spans: { start: number; end: number; name: string }[] = [];
      const head = Buffer.alloc(30);
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i]!;
        await fh.read(head, 0, 30, e.offset);
        if (head.readUInt32LE(0) !== 0x04034b50) throw new ZipFormatError(`Broken ZIP file (local header of ${e.name})`);
        const nameLen = head.readUInt16LE(26);
        const extraLen = head.readUInt16LE(28);
        if (e.offset + 30 + nameLen + extraLen > size) throw new ZipFormatError(`Broken ZIP file (local header of ${e.name})`);
        // the sizes of a ZIP64 local header are in its extra field (both)
        const local64 = !!o.zip64 && head.readUInt32LE(18) === MAX_U32 && head.readUInt32LE(22) === MAX_U32;
        const localName = Buffer.alloc(nameLen + (local64 ? extraLen : 0));
        await fh.read(localName, 0, localName.length, e.offset + 30);
        let [lusize, lcsize] = [head.readUInt32LE(22), head.readUInt32LE(18)];
        if (local64) [lusize, lcsize] = readZip64Extra(localName.subarray(nameLen), 2, `the local header of ${e.name}`) as [number, number];
        if (
          head.readUInt16LE(6) & 0x0009 ||
          head.readUInt16LE(8) !== e.method ||
          head.readUInt32LE(14) !== e.crc ||
          lcsize !== e.csize ||
          lusize !== e.usize ||
          !localName.subarray(0, nameLen).equals(names[i]!)
        )
          throw new ZipFormatError(`Broken ZIP file (the local header of ${e.name} differs from the central directory)`);
        spans.push({ start: e.offset, end: e.offset + 30 + nameLen + extraLen + e.csize, name: e.name });
      }
      spans.sort((a, b) => a.start - b.start);
      let at = 0;
      for (const sp of spans) {
        if (sp.start !== at)
          throw new ZipFormatError(sp.start > at ? `Broken ZIP file (unlisted data before ${sp.name})` : `Broken ZIP file (${sp.name} overlaps another entry)`);
        at = sp.end;
      }
      if (at !== cdOffset) throw new ZipFormatError('Broken ZIP file (unlisted data before the central directory)');
      return new ZipReader(file, size, entries);
    } finally {
      await fh.close();
    }
  }

  private byName?: Map<string, ZipEntry>;
  /** The (first) entry of that name; indexed, as a backup can have a million entries. */
  find(name: string): ZipEntry | undefined {
    if (!this.byName) {
      this.byName = new Map();
      for (const e of this.entries) if (!this.byName.has(e.name)) this.byName.set(e.name, e);
    }
    return this.byName.get(name);
  }

  /** The content of an entry as a stream, inflated, cut off with an error past `maxBytes`. */
  async stream(e: ZipEntry, maxBytes = e.usize): Promise<Readable> {
    const fh = await fs.promises.open(this.file, 'r');
    const head = Buffer.alloc(30);
    try {
      await fh.read(head, 0, 30, e.offset);
    } finally {
      await fh.close();
    }
    if (head.readUInt32LE(0) !== 0x04034b50) throw new ZipFormatError(`Broken ZIP file (local header of ${e.name})`);
    const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    if (start + e.csize > this.size) throw new ZipFormatError(`Broken ZIP file (data of ${e.name})`);
    const raw = e.csize ? fs.createReadStream(this.file, { start, end: start + e.csize - 1 }) : Readable.from([]);
    if (e.method === 0) return raw;
    if (e.method !== 8) throw new ZipFormatError(`Unsupported compression method ${e.method} (${e.name})`);
    const inflate = zlib.createInflateRaw({ maxOutputLength: Math.max(1, maxBytes) });
    raw.on('error', (err: Error) => inflate.destroy(err));
    return raw.pipe(inflate);
  }

  /** SHA-256, size and CRC check of an entry (streamed). */
  async digest(e: ZipEntry, maxBytes = e.usize): Promise<{ sha256: string; size: number; crcOk: boolean }> {
    const hash = crypto.createHash('sha256');
    let size = 0;
    let crc = 0;
    const s = await this.stream(e, maxBytes);
    for await (const chunk of s as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > maxBytes) {
        s.destroy();
        throw new ZipFormatError(`${e.name} is larger than declared`);
      }
      crc = zlib.crc32(chunk, crc);
      hash.update(chunk);
    }
    return { sha256: hash.digest('hex'), size, crcOk: crc >>> 0 === e.crc && size === e.usize };
  }

  /** A small entry as a buffer (manifest, signature, key, index). */
  async read(e: ZipEntry, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
    if (e.usize > maxBytes) throw new ZipLimitError(`${e.name} is too large`);
    const parts: Buffer[] = [];
    let n = 0;
    for await (const chunk of (await this.stream(e, maxBytes)) as AsyncIterable<Buffer>) {
      n += chunk.length;
      if (n > maxBytes) throw new ZipLimitError(`${e.name} is too large`);
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  }
}

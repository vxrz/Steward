import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';

/**
 * A small streaming ZIP writer and reader (PKZIP 2.0: stored and deflated entries, UTF-8 names, no
 * ZIP64 – packs stay below 4 GB). The writer streams every entry straight to the file and patches
 * the local header afterwards, so large files are never held in memory. The reader never extracts
 * to disk: it streams one entry at a time with a hard limit on the inflated size (zip bombs).
 */

const MAX_U32 = 0xffffffff;
export const ZIP_MAX_ENTRIES = 65000;

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
  private constructor(
    private fh: fs.promises.FileHandle,
    private readonly maxBytes: number,
  ) {}

  /** Creates the file (it must not exist). */
  static async create(file: string, maxBytes = MAX_U32): Promise<ZipWriter> {
    return new ZipWriter(await fs.promises.open(file, 'wx', 0o600), Math.min(maxBytes, MAX_U32 - 1024 * 1024));
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

  /** Adds an entry from a stream (or a buffer); deflates when `compress` is set. Returns size and SHA-256 of the content. */
  async add(path: string, source: Readable | Buffer, o: { compress?: boolean; mtime?: Date } = {}): Promise<WrittenEntry> {
    const nameStr = safeEntryName(path);
    if (this.names.has(nameStr)) throw new Error(`Duplicate entry ${nameStr}`);
    if (this.entries.length >= ZIP_MAX_ENTRIES) throw new ZipLimitError(`More than ${ZIP_MAX_ENTRIES} files`);
    this.names.add(nameStr);
    const name = Buffer.from(nameStr, 'utf8');
    const method = o.compress ? 8 : 0;
    const { time, date } = dosTime(o.mtime ?? new Date());
    const headerAt = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt16LE(name.length, 26);
    await this.write(Buffer.concat([header, name]));
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
    if (usize > MAX_U32 || csize > MAX_U32) throw new ZipLimitError('A file is larger than 4 GB');
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(crc >>> 0, 0);
    patch.writeUInt32LE(csize, 4);
    patch.writeUInt32LE(usize, 8);
    await this.write(patch, headerAt + 14);
    this.entries.push({ name, method, time, date, crc: crc >>> 0, csize, usize, offset: headerAt });
    return { path: nameStr, size: usize, sha256: hash.digest('hex') };
  }

  async addFile(path: string, file: string, o: { compress?: boolean } = {}): Promise<WrittenEntry> {
    return this.add(path, fs.createReadStream(file), o);
  }

  async finish(): Promise<{ size: number; entries: number }> {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(0x0314, 4); // made by: UNIX, 2.0
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.csize, 20);
      h.writeUInt32LE(e.usize, 24);
      h.writeUInt16LE(e.name.length, 28);
      h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
      h.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([h, e.name]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - cdStart, 12);
    end.writeUInt32LE(cdStart, 16);
    await this.write(end);
    await this.fh.close();
    return { size: this.offset, entries: this.entries.length };
  }

  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
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

/** Reads the central directory of a ZIP file; entries are streamed on demand. */
export class ZipReader {
  private constructor(
    readonly file: string,
    readonly size: number,
    readonly entries: ZipEntry[],
  ) {}

  static async open(file: string): Promise<ZipReader> {
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
      const count = tail.readUInt16LE(eocd + 10);
      const cdSize = tail.readUInt32LE(eocd + 12);
      const cdOffset = tail.readUInt32LE(eocd + 16);
      if (cdOffset + cdSize > size) throw new ZipFormatError('Broken ZIP file (central directory outside the file)');
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries: ZipEntry[] = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipFormatError('Broken ZIP file (central directory entry)');
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const entry: ZipEntry = {
          method: cd.readUInt16LE(p + 10),
          crc: cd.readUInt32LE(p + 16),
          csize: cd.readUInt32LE(p + 20),
          usize: cd.readUInt32LE(p + 24),
          offset: cd.readUInt32LE(p + 42),
          name: cd.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
        };
        if (entry.offset + 30 > size) throw new ZipFormatError(`Broken ZIP file (entry ${entry.name})`);
        entries.push(entry);
        p += 46 + nameLen + extraLen + commentLen;
      }
      return new ZipReader(file, size, entries);
    } finally {
      await fh.close();
    }
  }

  find(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name);
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

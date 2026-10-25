import zlib from 'node:zlib';

/** A small valid PNG (1 × 1). */
export function tinyPng(): Buffer {
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

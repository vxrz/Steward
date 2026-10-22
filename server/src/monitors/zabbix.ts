import net from 'node:net';
import { guardedLookup } from '../platforms/outbound.js';
import zlib from 'node:zlib';

/**
 * Zabbix sender (trapper) protocol – what `zabbix_sender` speaks to the
 * Zabbix server or proxy (default port 10051):
 *
 *   "ZBXD" | flags (1 byte) | data length (4 bytes, little endian) | reserved (4 bytes, little endian) | JSON
 *
 * flags: 0x01 Zabbix protocol, 0x02 compression (zlib; "reserved" then holds the
 * uncompressed size), 0x04 large packet (both length fields are 8 bytes).
 * Request:  {"request":"sender data","data":[{"host":"…","key":"…","value":"…","clock":1700000000,"ns":0}],"clock":…,"ns":…}
 * Response: {"response":"success","info":"processed: 1; failed: 0; total: 1; seconds spent: 0.000055"}
 * Values are only accepted for items of type "Zabbix trapper" on the given host
 * (and from addresses in the item's "Allowed hosts", if set); everything else
 * counts as "failed".
 */

export interface SenderItem {
  host: string;
  key: string;
  value: string;
  clock?: number;
  ns?: number;
}

export interface SenderResult {
  response: string;
  info: string;
  processed: number;
  failed: number;
  total: number;
  secondsSpent: number | null;
}

const MAGIC = Buffer.from('ZBXD', 'ascii');

export function encodePacket(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(13);
  MAGIC.copy(header, 0);
  header[4] = 0x01;
  header.writeUInt32LE(json.length, 5);
  header.writeUInt32LE(0, 9);
  return Buffer.concat([header, json]);
}

/** Decodes one packet from the start of `buf`; null while incomplete. */
export function decodePacket(buf: Buffer): { json: unknown; size: number } | null {
  if (buf.length < 5) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Not a Zabbix protocol answer (missing ZBXD header)');
  const flags = buf[4]!;
  const large = (flags & 0x04) !== 0;
  const headerSize = large ? 21 : 13;
  if (buf.length < headerSize) return null;
  const len = large ? Number(buf.readBigUInt64LE(5)) : buf.readUInt32LE(5);
  if (len > 64 * 1024 * 1024) throw new Error('Zabbix answer too large');
  if (buf.length < headerSize + len) return null;
  let data = buf.subarray(headerSize, headerSize + len);
  if (flags & 0x02) data = zlib.inflateSync(data);
  return { json: JSON.parse(data.toString('utf8')), size: headerSize + len };
}

export function parseInfo(info: string): Pick<SenderResult, 'processed' | 'failed' | 'total' | 'secondsSpent'> {
  const num = (re: RegExp) => {
    const m = re.exec(info);
    return m ? Number(m[1]) : NaN;
  };
  const seconds = num(/seconds spent:\s*([\d.]+)/i);
  return {
    processed: num(/processed:\s*([\d.]+)/i) || 0,
    failed: num(/failed:\s*([\d.]+)/i) || 0,
    total: num(/total:\s*([\d.]+)/i) || 0,
    secondsSpent: Number.isNaN(seconds) ? null : seconds,
  };
}

/** Sends values to a Zabbix server/proxy trapper port and parses the processed/failed counters. */
export function zabbixSend(host: string, port: number, items: SenderItem[], timeoutMs = 10000): Promise<SenderResult> {
  const now = Date.now();
  const packet = encodePacket({
    request: 'sender data',
    data: items.map((i) => ({ host: i.host, key: i.key, value: i.value, clock: i.clock ?? Math.floor(now / 1000), ns: i.ns ?? (now % 1000) * 1e6 })),
    clock: Math.floor(now / 1000),
    ns: (now % 1000) * 1e6,
  });
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, lookup: guardedLookup });
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (err: Error | null, r?: SenderResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(r!);
    };
    const timer = setTimeout(() => done(new Error(`Zabbix trapper ${host}:${port} did not answer within ${timeoutMs} ms`)), timeoutMs);
    sock.once('connect', () => sock.write(packet));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        const p = decodePacket(buf);
        if (!p) return;
        const j = p.json as { response?: string; info?: string };
        const info = String(j.info ?? '');
        if (j.response !== 'success') return done(new Error(`Zabbix answered "${j.response ?? '?'}"${info ? `: ${info}` : ''}`));
        done(null, { response: j.response, info, ...parseInfo(info) });
      } catch (e) {
        done(e as Error);
      }
    });
    sock.once('error', (e) => done(new Error(`Zabbix trapper ${host}:${port}: ${e.message}`)));
    sock.once('end', () => done(new Error(`Zabbix trapper ${host}:${port} closed the connection without an answer`)));
  });
}

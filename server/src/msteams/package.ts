import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { BRAND } from '@sm/shared';
import { ZipWriter } from '../compliance/zip.js';
import { publicBaseUrl } from '../notifications/settings.js';
import { resolveLook } from '../notifications/look.js';
import { botConfig } from './settings.js';

/**
 * The Teams app package an administrator uploads to the tenant (ADR 0013): manifest.json (schema 1.17) with the bot
 * (scopes personal and team, no tabs, no message extensions) and its two icons. The bot id is the Entra app id.
 */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A square PNG: a filled colour (or a white outline on transparency for the outline icon). */
export function squarePng(size: number, rgb: [number, number, number], outline = false): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const edge = Math.max(2, Math.round(size / 10));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const border = x < edge || y < edge || x >= size - edge || y >= size - edge;
      const on = outline ? border : true;
      raw[o] = outline ? 255 : rgb[0];
      raw[o + 1] = outline ? 255 : rgb[1];
      raw[o + 2] = outline ? 255 : rgb[2];
      raw[o + 3] = on ? 255 : 0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function manifest(): Record<string, unknown> {
  const c = botConfig();
  const base = publicBaseUrl();
  const host = (() => {
    try {
      return new URL(base).hostname;
    } catch {
      return 'localhost';
    }
  })();
  const name = resolveLook().name || BRAND.name;
  return {
    $schema: 'https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: '1.0.0',
    id: c.appId,
    developer: { name, websiteUrl: base, privacyUrl: base, termsOfUseUrl: base },
    name: { short: name.slice(0, 30), full: `${name} approvals`.slice(0, 100) },
    description: {
      short: `Decisions from ${name} in Microsoft Teams`.slice(0, 80),
      full: `Posts decisions that wait in ${name} and lets the people who may decide approve or reject them in the card. Everything else opens ${name}.`.slice(
        0,
        4000,
      ),
    },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#1C7ED6',
    bots: [{ botId: c.appId, scopes: ['personal', 'team'], isNotificationOnly: false, supportsFiles: false }],
    permissions: ['identity'],
    validDomains: [host],
  };
}

/** The zip of the app package, as bytes. */
export async function appPackage(): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-teams-'));
  try {
    const file = path.join(dir, 'app.zip');
    const zip = await ZipWriter.create(file);
    try {
      await zip.add('manifest.json', Buffer.from(JSON.stringify(manifest(), null, 2)), { compress: true });
      await zip.add('color.png', squarePng(192, [28, 126, 214]));
      await zip.add('outline.png', squarePng(32, [255, 255, 255], true));
      await zip.finish();
    } catch (e) {
      await zip.abort();
      throw e;
    }
    return fs.readFileSync(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AA_TEXT,
  SURFACES,
  THEME_DEFAULTS,
  composite,
  contrastRatio,
  generatePalette,
  hexToOklch,
  normalizeHex,
  resolveThemeColor,
  themeContrastNotes,
  themeCssVariables,
} from '@sm/shared';
import { ADMIN, authHeaders, loginCookie, setup, startTestServer, type Client, type TestServer } from './helpers.js';

let s: TestServer;
let viewer: Client;
let auditor: Client;

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

/** A user with a fresh password (new accounts must change the temporary one first). */
async function user(username: string, role: string): Promise<Client> {
  const { temporaryPassword } = await s.api('POST', '/users', { username, roles: [role] });
  const c = await s.as(username, temporaryPassword);
  await c('POST', '/auth/password', { current: temporaryPassword, next: 'Theme-password-1' });
  return c;
}

// ---------- test images (headers are what the server checks) ----------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A real (decodable) RGB PNG of the given size. */
function png(width: number, height: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: Math.min(height, 64) }, () => row));
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw))];
  if (pad) parts.push(chunk('tEXt', Buffer.alloc(pad, 0x41)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
/** JPEG header up to the frame (SOF0) marker */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
/** WebP (VP8X extended header) */
function webp(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

const upload = (data: Buffer, client: Client = s.api) => client('POST', '/settings/theme/logo', { contentBase64: data.toString('base64') });

const rawLogin = (username: string, password: string) => loginCookie(s.base, username, password);

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  viewer = await user('tvera', 'viewer');
  auditor = await user('taudrey', 'auditor');
});
afterAll(async () => {
  await s?.app.close();
});

describe('colour functions (shared/src/theme.ts)', () => {
  it('keeps Mantine palettes for the defaults and puts a custom colour at shade 6', () => {
    expect(generatePalette(THEME_DEFAULTS.primaryColor)[7]).toBe('#1c7ed6');
    expect(generatePalette(THEME_DEFAULTS.primaryColor)[6]).toBe('#228be6');
    expect(generatePalette(THEME_DEFAULTS.accentColor)[6]).toBe('#7950f2');
    const p = generatePalette('#E30613');
    expect(p).toHaveLength(10);
    expect(p[6]).toBe('#e30613');
    // lightness falls from shade 0 to 9 (perceptual ramp)
    const l = p.map((x) => hexToOklch(x).l);
    for (let i = 1; i < 10; i++) expect(l[i]).toBeLessThanOrEqual(l[i - 1]! + 1e-9);
    expect(normalizeHex('#AbC')).toBe('#aabbcc');
    expect(normalizeHex('red')).toBeNull();
  });

  it('reaches WCAG AA for text on filled elements and for text colours, for any colour', () => {
    const colours = ['#ffff00', '#ffd400', '#00ff00', '#00ffff', '#ff00ff', '#ffffff', '#000000', '#777777', '#1c7ed6', '#7950f2', '#e30613', '#00a86b', '#6a0dad', '#ff8800'];
    let seed = 7;
    for (let i = 0; i < 300; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      colours.push('#' + (seed & 0xffffff).toString(16).padStart(6, '0'));
    }
    for (const c of colours) {
      const r = resolveThemeColor(c);
      for (const scheme of ['light', 'dark'] as const) {
        const x = r[scheme];
        expect(contrastRatio(x.onFilled, x.filled), `${c} ${scheme} filled`).toBeGreaterThanOrEqual(AA_TEXT);
        expect(contrastRatio(x.onFilled, x.filledHover), `${c} ${scheme} hover`).toBeGreaterThanOrEqual(AA_TEXT);
        for (const bg of SURFACES[scheme]) {
          expect(contrastRatio(x.text, bg), `${c} ${scheme} text on ${bg}`).toBeGreaterThanOrEqual(AA_TEXT);
          // light-variant background (badges, alerts, active navigation)
          expect(contrastRatio(x.text, composite(r.palette[6], scheme === 'light' ? 0.1 : 0.15, bg)), `${c} ${scheme} text on tint`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
    }
  });

  it('uses dark text on bright colours (auto contrast) and explains the adjustments', () => {
    const yellow = resolveThemeColor('#ffd400');
    expect(yellow.light.onFilled).toBe('#000000');
    expect(yellow.light.filled).toBe('#ffd400');
    expect(contrastRatio(yellow.light.text, '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT);
    const notes = themeContrastNotes({ primaryColor: '#ffd400', accentColor: THEME_DEFAULTS.accentColor });
    expect(notes.map((n) => `${n.color}:${n.scheme}:${n.kind}`)).toEqual(expect.arrayContaining(['primary:both:darkTextOnFilled', 'primary:light:textAdjusted', 'primary:light:lowSurfaceContrast']));
    // the defaults need no notes
    expect(themeContrastNotes(THEME_DEFAULTS)).toEqual([]);
    const vars = themeCssVariables({ primaryColor: '#ffd400', accentColor: '#7950f2' }, 'light');
    expect(vars['--mantine-primary-color-contrast']).toBe('#000000');
    expect(vars['--mantine-color-anchor']).toBe(yellow.light.text);
    expect(vars['--sm-accent-contrast']).toBe('#ffffff');
  });

  it('reads type and size of PNG, JPEG and WebP from their headers only', async () => {
    // (imported here: config.ts must only be loaded after startTestServer() set SM_DATA_DIR)
    const { imageInfo } = await import('../src/theme/service.js');
    expect(imageInfo(png(120, 40))).toEqual({ mime: 'image/png', width: 120, height: 40 });
    expect(imageInfo(jpeg(300, 100))).toEqual({ mime: 'image/jpeg', width: 300, height: 100 });
    expect(imageInfo(webp(64, 32))).toEqual({ mime: 'image/webp', width: 64, height: 32 });
    expect(imageInfo(SVG)).toBeNull();
    expect(imageInfo(Buffer.from('GIF89a……'))).toBeNull();
  });
});

describe('GET /api/theme (public)', () => {
  it('is reachable without signing in, contains only theme fields and supports ETag/304', async () => {
    const res = await fetch(`${s.base}/api/theme`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-cache');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"[\w-]+"$/);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['accentColor', 'appName', 'colorScheme', 'custom', 'logoUrl', 'primaryColor', 'radius']);
    expect(body).toMatchObject({ primaryColor: THEME_DEFAULTS.primaryColor, custom: false, logoUrl: null });
    const again = await fetch(`${s.base}/api/theme`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });
});

describe('theme settings (administrators)', () => {
  it('rejects other users and invalid input', async () => {
    expect(await status(viewer('PUT', '/settings/theme', { primaryColor: '#ff0000' }))).toBe(403);
    expect(await status(auditor('GET', '/settings/theme'))).toBe(403);
    const anonymous = await fetch(`${s.base}/api/settings/theme`, { method: 'PUT', headers: { 'x-sm-client': '1', 'content-type': 'application/json' }, body: '{}' });
    expect(anonymous.status).toBe(401);
    for (const bad of [{ primaryColor: 'red' }, { accentColor: '#12345' }, { primaryColor: '#1234567' }, { radius: 'xl' }, { colorScheme: 'sepia' }, { appName: 'A\u0007B' }, { appName: '<b>x</b>' }, { appName: 'x'.repeat(61) }, { logo: 'x' }]) {
      expect(await status(s.api('PUT', '/settings/theme', bad)), JSON.stringify(bad)).toBe(400);
    }
  });

  it('saves, normalises and serves the theme to everyone with a new ETag, and audits the change', async () => {
    const before = (await fetch(`${s.base}/api/theme`)).headers.get('etag');
    const saved = await s.api('PUT', '/settings/theme', { primaryColor: '#FD0', accentColor: '#e30613', colorScheme: 'dark', radius: 'lg', appName: '  ACME Steward ' });
    expect(saved).toMatchObject({ primaryColor: '#ffdd00', accentColor: '#e30613', colorScheme: 'dark', radius: 'lg', appName: 'ACME Steward', updatedBy: ADMIN.username });
    const res = await fetch(`${s.base}/api/theme`);
    expect(res.headers.get('etag')).not.toBe(before);
    expect(await res.json()).toMatchObject({ primaryColor: '#ffdd00', appName: 'ACME Steward', custom: true });
    const audit = await s.api('GET', '/audit?action=theme.updated&limit=5');
    expect(audit[0].summary).toContain('primaryColor');
    expect(audit[0].details.primaryColor).toEqual({ from: THEME_DEFAULTS.primaryColor, to: '#ffdd00' });
    expect(audit[0].actor).toBe(ADMIN.username);
    // saving the same values again changes nothing and is not audited
    await s.api('PUT', '/settings/theme', { primaryColor: '#ffdd00' });
    expect((await s.api('GET', '/audit?action=theme.updated&limit=5')).length).toBe(audit.length);
  });

  it('serves the web app manifest with the display name and theme colour (ETag/304)', async () => {
    const res = await fetch(`${s.base}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/manifest+json');
    const m = await res.json();
    expect(m).toMatchObject({ name: 'ACME Steward', short_name: 'ACME Steward', theme_color: '#ffdd00', start_url: '/' });
    expect(m.icons.length).toBeGreaterThan(0);
    expect((await fetch(`${s.base}/manifest.webmanifest`, { headers: { 'if-none-match': res.headers.get('etag')! } })).status).toBe(304);
  });

  it('keeps theme settings out of the general settings', async () => {
    const settings = await s.api('GET', '/settings');
    expect(Object.keys(settings).some((k) => k.startsWith('theme'))).toBe(false);
  });
});

describe('header logo', () => {
  it('accepts PNG, JPEG and WebP by magic bytes and serves them publicly with nosniff', async () => {
    for (const [data, mime] of [
      [jpeg(400, 100), 'image/jpeg'],
      [webp(200, 50), 'image/webp'],
      [png(160, 48), 'image/png'],
    ] as const) {
      const after = await upload(data);
      expect(after.logo).toMatchObject({ mime, size: data.length });
    }
    const t = await (await fetch(`${s.base}/api/theme`)).json();
    expect(t.logoUrl).toMatch(/^\/api\/theme\/logo\?v=[0-9a-f]{16}$/);
    const res = await fetch(`${s.base}${t.logoUrl}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(Buffer.from(await res.arrayBuffer()).equals(png(160, 48))).toBe(true);
    expect((await fetch(`${s.base}/api/theme/logo`, { headers: { 'if-none-match': res.headers.get('etag')! } })).status).toBe(304);
    // without the matching version the response is revalidated, not cached for good
    expect((await fetch(`${s.base}/api/theme/logo?v=0000`)).headers.get('cache-control')).toContain('no-cache');
    const audit = await s.api('GET', '/audit?action=theme.logo_uploaded&limit=5');
    expect(audit[0].details).toMatchObject({ mime: 'image/png', width: 160, height: 48 });
    expect(audit[0].details.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects SVG, other types, oversized files and huge images', async () => {
    const code = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'accepted';
      } catch (e) {
        return JSON.parse((e as Error).message.replace(/^[^{]*/, '')).code;
      }
    };
    expect(await code(upload(SVG))).toBe('THEME_LOGO_SVG');
    expect(await code(upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')))).toBe('THEME_LOGO_SVG');
    expect(await code(upload(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1')))).toBe('THEME_LOGO_TYPE');
    expect(await code(upload(Buffer.from('%PDF-1.7 …')))).toBe('THEME_LOGO_TYPE');
    expect(await code(upload(png(5000, 10)))).toBe('THEME_LOGO_DIMENSIONS');
    expect(await code(upload(png(10, 10, 520 * 1024)))).toBe('THEME_LOGO_TOO_LARGE');
    expect(await code(upload(png(10, 10), viewer))).toBe('FORBIDDEN');
    // multipart upload over the limit
    const cookie = await rawLogin(ADMIN.username, ADMIN.password);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png(10, 10, 600 * 1024))], { type: 'image/png' }), 'big.png');
    const res = await fetch(`${s.base}/api/settings/theme/logo`, { method: 'POST', headers: { 'x-sm-client': '1', ...authHeaders(cookie) }, body: form });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('THEME_LOGO_TOO_LARGE');
    // the previous logo is still in place
    expect((await s.api('GET', '/settings/theme')).logo.mime).toBe('image/png');
  });

  it('removes the logo and resets everything to the defaults (audited)', async () => {
    const removed = await s.api('DELETE', '/settings/theme/logo');
    expect(removed.logo).toBeNull();
    expect((await fetch(`${s.base}/api/theme/logo`)).status).toBe(404);
    const reset = await s.api('POST', '/settings/theme/reset');
    expect(reset).toMatchObject({ ...THEME_DEFAULTS, logo: null });
    expect(await (await fetch(`${s.base}/api/theme`)).json()).toMatchObject({ custom: false, appName: '' });
    expect((await (await fetch(`${s.base}/manifest.webmanifest`)).json()).name).toBe('Steward');
    const actions = (await s.api('GET', '/audit?limit=20')).map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['theme.logo_removed', 'theme.reset']));
  });
});

describe('about and system status', () => {
  it('GET /api/about: every signed-in user, build from SM_BUILD_COMMIT/SM_BUILD_DATE or "development"', async () => {
    expect((await fetch(`${s.base}/api/about`)).status).toBe(401);
    const dev = await viewer('GET', '/about');
    expect(dev.build).toEqual({ version: expect.any(String), commit: null, date: null });
    process.env.SM_BUILD_COMMIT = '0123456789abcdef0123456789abcdef01234567';
    process.env.SM_BUILD_DATE = '2026-10-01T12:00:00Z';
    try {
      expect((await viewer('GET', '/about')).build).toMatchObject({ commit: '0123456789abcdef0123456789abcdef01234567', date: '2026-10-01T12:00:00.000Z' });
    } finally {
      delete process.env.SM_BUILD_COMMIT;
      delete process.env.SM_BUILD_DATE;
    }
  });

  it('GET /api/system/status: administrators (full), auditors (limited), nobody else', async () => {
    expect((await fetch(`${s.base}/api/system/status`)).status).toBe(401);
    expect(await status(viewer('GET', '/system/status'))).toBe(403);

    const full = await s.api('GET', '/system/status');
    expect(full.view).toBe('full');
    expect(full.ready).toBe(true);
    expect(full.checks.database.ok).toBe(true);
    expect(['sqlite', 'postgres']).toContain(full.database.kind);
    expect(full.database.sizeBytes).toBeGreaterThan(0);
    expect(full.database.location).toBeTruthy();
    expect(full.runtime.dataDir).toBe(s.dataDir);
    expect(full.runtime.node).toBe(process.version);
    expect(['node', 'container', 'executable']).toContain(full.deployment);
    expect(full.vault).toEqual({ initialized: true, unlocked: true, unattendedUnlock: expect.any(Boolean) });
    expect(full.publicApi.basePath).toBe('/api/v1');
    expect(full.metrics.access).toBe('adminsAndAuditors');

    const limited = await auditor('GET', '/system/status');
    expect(limited.view).toBe('limited');
    expect(limited.runtime.dataDir).toBeUndefined();
    expect(limited.runtime.hostname).toBeUndefined();
    expect(limited.database.location).toBeUndefined();
    expect(limited.security.allowedHosts).toBeUndefined();

    // no secrets, no data folder for auditors
    for (const body of [JSON.stringify(full), JSON.stringify(limited)]) {
      expect(body).not.toContain('correct horse battery');
      expect(body).not.toContain(ADMIN.password);
      expect(body).not.toMatch(/"(password|secret|token|passphrase|dsn)"\s*:/i);
    }
    expect(JSON.stringify(limited)).not.toContain(s.dataDir);
  });

  it('GET /api/ready keeps its contract', async () => {
    const res = await fetch(`${s.base}/api/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: true, checks: { vault: { ok: true }, database: { ok: true }, scheduler: { ok: true } } });
  });
});

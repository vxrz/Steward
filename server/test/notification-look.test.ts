import fs from 'node:fs';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

process.env.SM_GATUS_AUTOSTART = '0';

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType: string; cid?: string }[];
}
const mails = vi.hoisted(() => [] as Mail[]);
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (m: Mail) => {
        mails.push(m);
      },
      close: () => undefined,
    }),
  },
}));

let s: TestServer;
let viewer: Client;
let channels: typeof import('../src/notifications/channels.js');
let look: typeof import('../src/notifications/look.js');

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
/** A decodable RGB PNG; `pad` adds a text chunk to make the file larger. */
function png(width: number, height: number, pad = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw))];
  if (pad) parts.push(chunk('tEXt', Buffer.alloc(pad, 0x41)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
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

const uploadAppLogo = (data: Buffer) => s.api('POST', '/settings/theme/logo', { contentBase64: data.toString('base64') });
const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status: number }) => e.status,
  );
async function testMail(): Promise<Mail> {
  mails.length = 0;
  const r = await s.api('POST', '/settings/notifications/test', { channel: 'email', to: 'ops@example.com' });
  expect(r).toEqual({ ok: true });
  expect(mails).toHaveLength(1);
  return mails[0]!;
}
const msg = (event: string, data?: Record<string, unknown>) => ({
  event,
  title: 'Run failed',
  body: 'Step 3 answered HTTP 500',
  locale: 'en' as const,
  link: 'https://steward.example/runs/run_1',
  ts: new Date().toISOString(),
  ...(data ? { data } : {}),
});
type Card = { attachments: { content: { body: any[]; actions: any[] } }[] };
const cardImages = (card: unknown) => JSON.stringify(card).match(/"type":"Image"/g)?.length ?? 0;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/users', { username: 'lookvera', roles: ['viewer'], password: 'Look-password-1' });
  viewer = await s.as('lookvera', 'Look-password-1');
  const notif = await s.api('GET', '/settings/notifications');
  await s.api('PUT', '/settings/notifications', {
    ...notif,
    email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
    allowedEmailDomains: ['example.com'],
  });
  channels = await import('../src/notifications/channels.js');
  look = await import('../src/notifications/look.js');
});

afterAll(async () => {
  await s.app.close();
  fs.rmSync(s.dataDir, { recursive: true, force: true });
});

describe('look of e-mails and Teams messages', () => {
  it('follows the Appearance settings until something is set', async () => {
    const before = await s.api('GET', '/settings/notifications/look');
    expect(before).toMatchObject({ name: '', color: '', logoSource: 'app', footer: '', effective: { name: 'Steward', logo: false, logoProblem: 'missing' } });
    await s.api('PUT', '/settings/theme', { appName: 'Acme Ops', primaryColor: '#0b7285' });
    expect((await s.api('GET', '/settings/notifications/look')).effective).toMatchObject({ name: 'Acme Ops', color: '#0b7285' });
    const m = await testMail();
    expect(m.subject).toMatch(/^\[Acme Ops\] /);
    expect(m.html).toContain('background:#0b7285');
    expect(m.html).toContain('>Acme Ops</td>');
    expect(m.html).toContain('Open in Acme Ops');
    // no logo uploaded: nothing attached, no image in the mail
    expect(m.attachments ?? []).toHaveLength(0);
    expect(m.html).not.toContain('<img');
  });

  it('attaches the app logo inline (cid) and never links to Steward', async () => {
    await uploadAppLogo(png(120, 40));
    const m = await testMail();
    const logo = m.attachments?.find((a) => a.cid === look.LOGO_CID);
    expect(logo).toMatchObject({ contentType: 'image/png', filename: 'logo.png' });
    expect(logo!.content.equals(png(120, 40))).toBe(true);
    expect(m.html).toContain(`src="cid:${look.LOGO_CID}"`);
    expect(m.html).not.toMatch(/src="https?:/);
    expect((await s.api('GET', '/settings/notifications/look')).effective.logo).toBe(true);
  });

  it('leaves out a WebP app logo (mail clients cannot show it) and says why', async () => {
    await uploadAppLogo(webp(120, 40));
    expect((await s.api('GET', '/settings/notifications/look')).effective).toMatchObject({ logo: false, logoProblem: 'type' });
    const m = await testMail();
    expect(m.attachments ?? []).toHaveLength(0);
    // the report logo (here the Steward default the reports use) works instead
    await s.api('PUT', '/settings/notifications/look', { logoSource: 'report' });
    const r = await testMail();
    expect(r.attachments?.find((a) => a.cid === look.LOGO_CID)?.contentType).toBe('image/png');
    await s.api('PUT', '/settings/notifications/look', { logoSource: 'none' });
    expect((await testMail()).attachments ?? []).toHaveLength(0);
    await s.api('DELETE', '/settings/theme/logo');
  });

  it('escapes name and footer and keeps them on one line', async () => {
    await s.api('PUT', '/settings/notifications/look', {
      name: '<b>Ops & "Co"</b>',
      footer: 'Internal\r\nBcc: x@evil.example <script>alert(1)</script>',
      color: '#ffd43b',
    });
    const m = await testMail();
    expect(m.html).not.toContain('<b>Ops');
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;b&gt;Ops &amp; &quot;Co&quot;&lt;/b&gt;');
    expect(m.html).toContain('Internal Bcc: x@evil.example &lt;script&gt;');
    expect(m.subject).not.toMatch(/[\r\n]/);
    // text part: the footer under a signature separator
    expect(m.text).toContain('\n--\nInternal Bcc: x@evil.example <script>alert(1)</script>\n');
    // a light header colour gets dark text
    expect(m.html).toContain('color:#212529">&lt;b&gt;Ops');
  });

  it('validates input, is for administrators only and writes one audit entry per change', async () => {
    for (const bad of [{ color: 'red' }, { color: '#12345' }, { logoSource: 'remote' }, { name: 'x'.repeat(61) }, { footer: 'x'.repeat(301) }, { unknown: 1 }])
      expect(await status(s.api('PUT', '/settings/notifications/look', bad)), JSON.stringify(bad)).toBe(400);
    expect(await status(viewer('GET', '/settings/notifications/look'))).toBe(403);
    expect(await status(viewer('PUT', '/settings/notifications/look', { name: 'x' }))).toBe(403);
    expect(await status(viewer('POST', '/settings/notifications/look/preview', {}))).toBe(403);
    const audit = async () => (await s.api('GET', '/audit?action=notifications.look_updated&limit=50')) as { details: Record<string, unknown> }[];
    const n = (await audit()).length;
    const saved = await s.api('PUT', '/settings/notifications/look', { name: 'Service desk', color: '', footer: '', logoSource: 'app' });
    expect(saved).toMatchObject({ name: 'Service desk', color: '', effective: { name: 'Service desk', color: '#0b7285' }, updatedBy: 'admin' });
    const after = await audit();
    expect(after).toHaveLength(n + 1);
    expect(after[0]!.details.name).toEqual({ from: '<b>Ops & "Co"</b>', to: 'Service desk' });
    await s.api('PUT', '/settings/notifications/look', { name: 'Service desk' });
    expect(await audit()).toHaveLength(n + 1);
  });

  it('previews unsaved settings without sending or storing anything', async () => {
    await uploadAppLogo(png(64, 32));
    mails.length = 0;
    const p = await s.api('POST', '/settings/notifications/look/preview', { name: 'Draft name', color: '#862e9c' });
    expect(p.subject).toMatch(/^\[Draft name\] /);
    expect(p.html).toContain('background:#862e9c');
    expect(p.html).toContain('src="data:image/png;base64,');
    expect(JSON.stringify(p.teams)).toContain('Draft name');
    expect(mails).toHaveLength(0);
    expect((await s.api('GET', '/settings/notifications/look')).name).toBe('Service desk');
    expect(await status(s.api('POST', '/settings/notifications/look/preview', { color: 'nope' }))).toBe(400);
  });
});

describe('Teams card', () => {
  it('carries the name, a colour strip by severity and the footer', () => {
    const l = look.resolveLook({ name: 'Acme', footer: 'Internal', logoSource: 'none' });
    const card = channels.teamsCard(msg('run.failed'), l) as Card;
    const body = card.attachments[0]!.content.body;
    expect(body[0]).toMatchObject({ type: 'Container', style: 'attention' });
    expect(JSON.stringify(body[0])).toContain('"text":"Acme"');
    expect(body.at(-1)).toMatchObject({ text: 'Internal', isSubtle: true });
    expect(card.attachments[0]!.content.actions[0]).toMatchObject({ title: 'Open in Acme' });
    const style = (event: string, data?: Record<string, unknown>) => (channels.teamsCard(msg(event, data), l) as Card).attachments[0]!.content.body[0].style;
    expect(style('monitor.status', { status: 'up' })).toBe('good');
    expect(style('monitor.status', { status: 'down' })).toBe('attention');
    expect(style('monitor.status', { status: 'degraded' })).toBe('warning');
    expect(style('task.assigned')).toBe('warning');
    expect(style('report.ready')).toBe('accent');
    expect(style('test')).toBe('accent');
  });

  it('embeds only a small logo, so the card stays below the 28 KB Teams limit', async () => {
    await uploadAppLogo(png(64, 32));
    const small = channels.teamsCard(msg('run.failed'), look.resolveLook({ logoSource: 'app' }));
    expect(cardImages(small)).toBe(1);
    expect(JSON.stringify(small)).toContain('"url":"data:image/png;base64,');
    await uploadAppLogo(png(64, 32, 20000));
    const big = channels.teamsCard(msg('run.failed'), look.resolveLook({ logoSource: 'app' }));
    expect(cardImages(big)).toBe(0);
    expect(JSON.stringify(big).length).toBeLessThan(28 * 1024);
    // the e-mail still carries the larger logo (it is attached, not inline in the HTML)
    const m = await testMail();
    expect(m.attachments?.find((a) => a.cid === look.LOGO_CID)?.content.length).toBeGreaterThan(20000);
    await s.api('DELETE', '/settings/theme/logo');
  });
});

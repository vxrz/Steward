import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
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
let receiver: http.Server | undefined;
const received: { path: string; body: any }[] = [];

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
  receiver?.close();
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

describe('own notification logo', () => {
  const upload = (c: Client, data: Buffer) => c('POST', '/settings/notifications/look/logo', { contentBase64: data.toString('base64') });

  it('is uploaded, used for e-mails and Teams, audited and removed again', async () => {
    const audit = async (action: string) => (await s.api('GET', `/audit?action=${action}&limit=50`)) as { details?: Record<string, unknown> }[];
    const before = (await audit('notifications.logo_uploaded')).length;
    const logo = png(90, 30);
    const after = await upload(s.api, logo);
    expect(after.customLogo).toMatchObject({ mime: 'image/png', size: logo.length });
    expect((await audit('notifications.logo_uploaded')).length).toBe(before + 1);
    expect((await audit('notifications.logo_uploaded'))[0]!.details).toMatchObject({ size: logo.length, mime: 'image/png' });
    await s.api('PUT', '/settings/notifications/look', { logoSource: 'custom' });
    expect((await s.api('GET', '/settings/notifications/look')).effective).toMatchObject({ logo: true });
    const m = await testMail();
    const att = m.attachments?.find((a) => a.cid === look.LOGO_CID);
    expect(att?.content.equals(logo)).toBe(true);
    expect(cardImages(channels.teamsCard(msg('test'), look.resolveLook()))).toBe(1);
    // the app and the reports keep their own logos: nothing else changed
    expect(await status(s.api('GET', '/theme/logo'))).toBe(404);
    // removed: the choice stays, the settings say why there is no logo
    const removed = await s.api('DELETE', '/settings/notifications/look/logo');
    expect(removed.customLogo).toBeNull();
    expect(removed.effective).toMatchObject({ logo: false, logoProblem: 'missing' });
    expect((await audit('notifications.logo_removed')).length).toBeGreaterThan(0);
    expect((await testMail()).attachments ?? []).toHaveLength(0);
  });

  it('takes PNG or JPEG up to 512 KB only, from administrators only', async () => {
    const err = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: { status: number; body?: { code?: string } }) => e,
      );
    const webpErr = await err(upload(s.api, webp(40, 40)));
    expect(webpErr?.status).toBe(400);
    const big = await err(upload(s.api, png(16, 16, 520 * 1024)));
    expect(big?.status).toBe(400);
    expect(await status(upload(s.api, Buffer.alloc(0)))).toBe(400);
    expect(await status(upload(viewer, png(16, 16)))).toBe(403);
    expect(await status(viewer('DELETE', '/settings/notifications/look/logo'))).toBe(403);
    expect(await status(viewer('GET', '/settings/notifications/look/logo'))).toBe(403);
    // a JPEG replaces a PNG
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x11)]);
    await upload(s.api, png(16, 16));
    expect((await upload(s.api, jpeg)).customLogo).toMatchObject({ mime: 'image/jpeg', size: jpeg.length });
    expect(fs.existsSync(`${s.dataDir}/branding/notification-logo.png`)).toBe(false);
    expect(fs.existsSync(`${s.dataDir}/branding/notification-logo.jpg`)).toBe(true);
    await s.api('DELETE', '/settings/notifications/look/logo');
    await s.api('PUT', '/settings/notifications/look', { logoSource: 'none' });
  });
});

describe('style', () => {
  it('keeps the look of 0.2.1 by default', async () => {
    const l = await s.api('GET', '/settings/notifications/look');
    expect(l).toMatchObject({
      logoSize: 'medium',
      logoAlign: 'left',
      headerStyle: 'solid',
      buttonColor: '',
      corners: 'rounded',
      font: 'system',
      dryRunDelivery: 'marked',
    });
    const html = look.emailHtml({
      look: look.resolveLook({ color: '#1c7ed6' }),
      locale: 'en',
      title: 'T',
      content: '',
      button: { label: 'Open', href: 'https://x.example' },
    });
    expect(html).toContain('<td style="background:#1c7ed6;padding:14px 20px">');
    expect(html).toContain('border-radius:8px');
    expect(html).toContain('<td style="border-radius:6px;background:#1c7ed6">');
    expect(html).toContain("-apple-system,'Segoe UI'");
  });

  it('applies header style, logo size and position, button colour, corners and font', async () => {
    await uploadAppLogo(png(64, 32));
    const saved = await s.api('PUT', '/settings/notifications/look', {
      logoSource: 'app',
      color: '#0b7285',
      headerStyle: 'line',
      logoSize: 'large',
      logoAlign: 'center',
      buttonColor: '#ffd43b',
      corners: 'square',
      font: 'serif',
    });
    expect(saved).toMatchObject({ headerStyle: 'line', logoSize: 'large', logoAlign: 'center', buttonColor: '#ffd43b', corners: 'square', font: 'serif' });
    const m = await testMail();
    expect(m.html).toContain('background:#ffffff;border-bottom:3px solid #0b7285;');
    expect(m.html).toContain('height:40px');
    expect(m.html).toContain('text-align:center');
    // the light button gets dark text
    expect(m.html).toContain('<td style="border-radius:0px;background:#ffd43b"><a href=');
    expect(m.html).toMatch(/background:#ffd43b"><a [^>]*color:#212529/);
    expect(m.html).toContain('border-radius:0px;overflow:hidden');
    expect(m.html).toContain("Georgia,'Times New Roman'");
    // Teams takes only the logo size and position
    const card = channels.teamsCard(msg('test'), look.resolveLook()) as Card;
    const head = JSON.stringify(card.attachments[0]!.content.body[0]);
    expect(head).toContain('"height":"32px"');
    expect(head).toContain('"horizontalAlignment":"Center"');
    // minimal: white header with a thin line
    await s.api('PUT', '/settings/notifications/look', { headerStyle: 'minimal' });
    expect((await testMail()).html).toContain('background:#ffffff;border-bottom:1px solid #e9ecef;');
    for (const bad of [
      { headerStyle: 'fancy' },
      { logoSize: 'huge' },
      { buttonColor: 'red' },
      { font: 'Comic Sans' },
      { corners: 'round' },
      { dryRunDelivery: 'never' },
    ])
      expect(await status(s.api('PUT', '/settings/notifications/look', bad)), JSON.stringify(bad)).toBe(400);
    await s.api('PUT', '/settings/notifications/look', {
      headerStyle: 'solid',
      logoSize: 'medium',
      logoAlign: 'left',
      buttonColor: '',
      corners: 'rounded',
      font: 'system',
      logoSource: 'none',
    });
    await s.api('DELETE', '/settings/theme/logo');
  });

  it('moves with a migration package (setting checked like a save)', () => {
    const c = look.checkedLook({
      name: 'X',
      headerStyle: 'line',
      font: 'evil',
      buttonColor: 'javascript:alert(1)',
      dryRunDelivery: 'inAppOnly',
      logoSource: 'custom',
    });
    expect(c).toMatchObject({ name: 'X', headerStyle: 'line', font: 'system', buttonColor: '', dryRunDelivery: 'inAppOnly', logoSource: 'custom' });
  });
});

describe('dry runs', () => {
  const failing = async (name: string) =>
    (
      await s.api('POST', '/processes', {
        definition: {
          name,
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'chk', type: 'check', name: 'Users exist', condition: 'false', message: 'No users found', failRun: true, x: 1, y: 0 },
          ],
          wires: [{ from: 'start', port: 'out', to: 'chk' }],
        },
      })
    ).id as string;
  const run = async (processId: string, dryRun: boolean) => {
    const { id } = await s.api('POST', '/runs', { processId, dryRun });
    expect((await s.waitRun(id, ['succeeded', 'failed'])).status).toBe('failed');
    return id as string;
  };
  const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
  async function settle(pred: () => boolean) {
    for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
    await flush();
  }

  beforeAll(async () => {
    receiver = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        received.push({ path: req.url ?? '', body: JSON.parse(data || 'null') });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
    const notif = await s.api('GET', '/settings/notifications');
    const all = ['inApp', 'email', 'teams', 'webhook'];
    await s.api('PUT', '/settings/notifications', {
      ...notif,
      email: { enabled: true, host: 'smtp.example.com', port: 587, secure: false, from: 'steward@example.com' },
      teams: { enabled: true, webhookUrl: `${url}/teams` },
      webhook: { enabled: true, url: `${url}/hook` },
      routes: { ...notif.routes, 'run.failed': all, 'check.failed': all, 'task.assigned': all },
      baseUrl: 'https://sm.example.com',
    });
    await s.api('PATCH', '/me', { email: 'admin@example.com', emailNotifications: true, locale: 'en' });
    await s.api('PUT', '/settings/notifications/look', { name: 'Acme', color: '#0b7285', logoSource: 'none', dryRunDelivery: 'marked' });
  });

  it('are marked as a test on every channel, never red', async () => {
    mails.length = 0;
    received.length = 0;
    await run(await failing('Nightly export'), true);
    await settle(() => mails.length >= 2 && received.length >= 4);
    const runMail = mails.find((m) => m.subject.includes('Run failed'))!;
    const checkMail = mails.find((m) => m.subject.includes('Users exist'))!;
    expect(runMail.subject).toBe('[Acme] Dry run – Run failed: Nightly export');
    // state first, then where (#144)
    expect(checkMail.subject).toBe('[Acme] Dry run – Error · Users exist – Nightly export');
    for (const m of [runMail, checkMail]) {
      expect(m.html).toContain('Dry run – a test, nothing was changed. No action needed.');
      expect(m.html).toContain(`background:${look.TONE_HEX.emphasis}`);
      expect(m.html).not.toContain(look.TONE_HEX.attention);
      expect(m.text.startsWith('Dry run – a test, nothing was changed. No action needed.\n\n')).toBe(true);
    }
    const teams = received.filter((r) => r.path === '/teams');
    expect(teams).toHaveLength(2);
    for (const t of teams) {
      const body = t.body.attachments[0].content.body;
      expect(body[0].style).toBe('emphasis');
      expect(body[1]).toMatchObject({ text: 'Dry run – a test, nothing was changed. No action needed.' });
    }
    const hooks = received.filter((r) => r.path === '/hook');
    expect(hooks).toHaveLength(2);
    for (const h of hooks) {
      expect(h.body.data.dryRun).toBe(true);
      expect(h.body.title).toMatch(/^Dry run – /);
    }
    // in the app too
    const inApp = (await s.api('GET', '/notifications?limit=100')).items.filter((x: any) => x.title.includes('Nightly export'));
    expect(inApp.every((x: any) => x.title.startsWith('Dry run – '))).toBe(true);
  });

  it("use the recipient's language", async () => {
    await s.api('PATCH', '/me', { locale: 'de' });
    mails.length = 0;
    await run(await failing('Inventar'), true);
    await settle(() => mails.length >= 2);
    const subjects = mails.map((m) => m.subject).sort();
    expect(subjects).toEqual(['[Acme] Probelauf – Ausführung fehlgeschlagen: Inventar', '[Acme] Probelauf – Fehler · Users exist – Inventar']);
    expect(mails[0]!.html).toContain('Probelauf – ein Test, es wurde nichts geändert. Kein Handlungsbedarf.');
    await s.api('PATCH', '/me', { locale: 'en' });
  });

  it('stay in the app with "in the app only"; real runs are sent as before', async () => {
    await s.api('PUT', '/settings/notifications/look', { dryRunDelivery: 'inAppOnly' });
    const p = await failing('Weekly cleanup');
    mails.length = 0;
    received.length = 0;
    const dry = await run(p, true);
    // once the in-app notifications are stored, any external send would be queued already
    let inApp: any[] = [];
    for (let i = 0; i < 100 && inApp.length < 2; i++) {
      inApp = (await s.api('GET', '/notifications?limit=100')).items.filter((x: any) => x.link === `/runs/${dry}`);
      if (inApp.length < 2) await new Promise((r) => setTimeout(r, 100));
    }
    await flush();
    expect(inApp.map((x) => x.event).sort()).toEqual(['check.failed', 'run.failed']);
    expect(mails.filter((m) => m.subject.includes('Weekly cleanup'))).toHaveLength(0);
    expect(received).toHaveLength(0);
    // a real run of the same process: red and without the banner
    await run(p, false);
    await settle(() => mails.some((m) => m.subject.includes('Weekly cleanup')));
    const real = mails.find((m) => m.subject === '[Acme] Run failed: Weekly cleanup')!;
    expect(real.html).toContain(`background:${look.TONE_HEX.attention}`);
    expect(real.html).not.toContain('No action needed');
    await s.api('PUT', '/settings/notifications/look', { dryRunDelivery: 'marked' });
  });

  it('can be previewed', async () => {
    const p = await s.api('POST', '/settings/notifications/look/preview', { sample: 'dryRun' });
    expect(p.subject).toMatch(/^\[Acme\] Dry run – Run failed: /);
    expect(p.html).toContain('No action needed');
    expect((p.teams as Card).attachments[0]!.content.body[0].style).toBe('emphasis');
    expect(await status(s.api('POST', '/settings/notifications/look/preview', { sample: 'other' }))).toBe(400);
  });
});

describe('dry runs: tasks', () => {
  const approval = async (name: string) =>
    (
      await s.api('POST', '/processes', {
        definition: {
          name,
          nodes: [
            { id: 'start', type: 'start', x: 0, y: 0 },
            { id: 'ok', type: 'userTask', mode: 'approve', title: `Approve ${name}`, assignees: ['role:admin'], x: 1, y: 0 },
          ],
          wires: [{ from: 'start', port: 'out', to: 'ok' }],
        },
      })
    ).id as string;
  const flush = async () => (await import('../src/notifications/service.js')).flushNotifications();
  /** Starts a run that waits for its approval; returns the run once the task notification is stored in the app. */
  async function waitingRun(processId: string, dryRun: boolean) {
    const { id } = await s.api('POST', '/runs', { processId, dryRun });
    expect((await s.waitRun(id, ['waiting'])).status).toBe('waiting');
    let inApp: any[] = [];
    for (let i = 0; i < 100 && !inApp.length; i++) {
      inApp = (await s.api('GET', '/notifications?limit=100')).items.filter((x: any) => x.event === 'task.assigned' && x.link === `/runs/${id}`);
      if (!inApp.length) await new Promise((r) => setTimeout(r, 100));
    }
    await flush();
    return { id: id as string, inApp };
  }
  const cancel = (id: string) => s.api('POST', `/runs/${id}/cancel`, {});

  it('marks the message about a task of a dry run; the task itself is a normal task', async () => {
    mails.length = 0;
    received.length = 0;
    const { id, inApp } = await waitingRun(await approval('Dry cleanup'), true);
    expect(inApp[0].title).toBe('Dry run – Decision needed: Approve Dry cleanup');
    const mail = mails.find((m) => m.subject.includes('Approve Dry cleanup'))!;
    expect(mail.subject).toBe('[Acme] Dry run – Decision needed: Approve Dry cleanup');
    expect(mail.html).toContain('Dry run – a test, nothing was changed. No action needed.');
    expect(mail.html).toContain(`background:${look.TONE_HEX.emphasis}`);
    expect(mail.html).not.toContain(look.TONE_HEX.warning);
    const teams = received.find((r) => r.path === '/teams')!;
    expect(teams.body.attachments[0].content.body[0].style).toBe('emphasis');
    expect(received.find((r) => r.path === '/hook')!.body.data).toMatchObject({ dryRun: true, runId: id });
    // the task is unchanged: open, and it can be decided so the dry run goes on
    const run = await s.api('GET', `/runs/${id}`);
    expect(run.tasks[0]).toMatchObject({ status: 'open', title: 'Approve Dry cleanup' });
    await cancel(id);
  });

  it('keeps task messages of dry runs in the app with "in the app only"', async () => {
    await s.api('PUT', '/settings/notifications/look', { dryRunDelivery: 'inAppOnly' });
    mails.length = 0;
    received.length = 0;
    const { id, inApp } = await waitingRun(await approval('Quiet cleanup'), true);
    expect(inApp).toHaveLength(1);
    expect(inApp[0].title).toMatch(/^Dry run – /);
    expect(mails.filter((m) => m.subject.includes('Quiet cleanup'))).toHaveLength(0);
    expect(received).toHaveLength(0);
    await cancel(id);
    await s.api('PUT', '/settings/notifications/look', { dryRunDelivery: 'marked' });
  });

  it('leaves task messages of real runs as they were', async () => {
    mails.length = 0;
    received.length = 0;
    const { id, inApp } = await waitingRun(await approval('Real cleanup'), false);
    expect(inApp[0].title).toBe('Decision needed: Approve Real cleanup');
    const mail = mails.find((m) => m.subject.includes('Approve Real cleanup'))!;
    expect(mail.subject).toBe('[Acme] Decision needed: Approve Real cleanup');
    expect(mail.html).not.toContain('No action needed');
    expect(mail.html).toContain(`background:${look.TONE_HEX.warning}`);
    expect(received.find((r) => r.path === '/teams')!.body.attachments[0].content.body[0].style).toBe('warning');
    expect(received.find((r) => r.path === '/hook')!.body.data.dryRun).toBe(false);
    await cancel(id);
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tinyPng } from './png.js';
import { ADMIN, authHeaders, loginCookie, quiesce, setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Stored files and logos are served with a type taken from their content, never from what the database (or an
 * imported migration package) says – otherwise a row could turn a file into a page or a script on Steward's origin.
 */
let s: TestServer;
let cookie = '';

const get = (url: string) => fetch(`${s.base}/api${url}`, { headers: authHeaders(cookie) });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  await quiesce();
  cookie = await loginCookie(s.base, ADMIN.username, ADMIN.password);
});
afterAll(async () => {
  await s?.app.close();
});

describe('stored content is served with the type of its content', () => {
  it('the public header logo: a stored script type or non-image data is never served', async () => {
    const { writeSetting } = await import('../src/settings.js');
    writeSetting('theme.logo', {
      mime: 'text/javascript',
      size: 9,
      width: 1,
      height: 1,
      sha256: 'x',
      updatedAt: 'now',
      data: Buffer.from('alert(1);').toString('base64'),
    });
    expect((await fetch(`${s.base}/api/theme/logo`)).status).toBe(404);
    const png = tinyPng();
    writeSetting('theme.logo', { mime: 'text/javascript', size: png.length, width: 1, height: 1, sha256: 'x', updatedAt: 'now', data: png.toString('base64') });
    const res = await fetch(`${s.base}/api/theme/logo`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    writeSetting('theme.logo', null);
  });

  it('run artifacts: images inline, anything else a sandboxed download', async () => {
    const { db } = await import('../src/db.js');
    const { config } = await import('../src/config.js');
    const run = (await s.api('GET', '/runs?limit=1'))[0];
    const dir = path.join(config.dataDir, 'artifacts', run.id);
    fs.mkdirSync(dir, { recursive: true });
    const add = (id: string, name: string, mime: string, data: Buffer) => {
      fs.writeFileSync(path.join(dir, name), data);
      db().run(
        'INSERT INTO run_artifacts (id, run_id, step_key, kind, name, mime, path, sha256, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        run.id,
        's',
        'screenshot',
        name,
        mime,
        path.join(dir, name),
        'x',
        data.length,
        'now',
      );
    };
    add('art_html', 'evil.html', 'text/html', Buffer.from('<script src="/api/theme/logo"></script>'));
    add('art_png', 'shot.png', 'text/html', tinyPng());
    const html = await get('/artifacts/art_html');
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('application/octet-stream');
    expect(html.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(html.headers.get('content-security-policy')).toContain('sandbox');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    const png = await get('/artifacts/art_png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('content-disposition')).toMatch(/^inline;/);
  });

  it('record attachments: a type uploads never produce becomes a plain download', async () => {
    const { db } = await import('../src/db.js');
    const dana = await s.as('dana', 'Demo-password-1');
    const rec = await dana('POST', '/records', { type: 'CR', title: 'Typed', fields: { reason: 'x', risk: 'low', rollbackPlan: 'x' }, body: 'x' });
    const danaCookie = await loginCookie(s.base, 'dana', 'Demo-password-1');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(Buffer.from('plain text notes'))]), 'notes.txt');
    const up = await (
      await fetch(`${s.base}/api/records/${rec.id}/attachments`, { method: 'POST', headers: { ...authHeaders(danaCookie), 'x-sm-client': '1' }, body: form })
    ).json();
    db().run("UPDATE record_attachments SET mime = 'text/javascript' WHERE id = ?", up.id);
    const res = await get(`/records/${rec.id}/attachments/${up.id}/download`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('the report logo: the type comes from the file, not from the branding setting', async () => {
    const { writeSetting } = await import('../src/settings.js');
    const { config } = await import('../src/config.js');
    fs.mkdirSync(path.join(config.dataDir, 'branding'), { recursive: true });
    fs.writeFileSync(path.join(config.dataDir, 'branding', 'logo.png'), '<html><script>alert(1)</script>');
    writeSetting('reports.branding', { logoMime: 'text/html', logoUpdatedAt: 'now' });
    const res = await get('/reports/branding/logo');
    expect(res.headers.get('content-type')).toBe('image/png'); // the default logo
    expect(
      Buffer.from(await res.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
  });
});

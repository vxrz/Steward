import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';

let s: TestServer;
const web = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-web-'));

beforeAll(async () => {
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Steward</title>');
  process.env.SM_WEB_DIST = web;
  s = await startTestServer();
});
afterAll(async () => {
  await s.app.close();
  fs.rmSync(web, { recursive: true, force: true });
});

describe('web UI fallback', () => {
  it('serves the app for page URLs, also with dots in the query string', async () => {
    for (const url of ['/records', '/compliance/access-changes?subject=a@example.com', '/tickets?vendor=acme.corp']) {
      const res = await fetch(s.base + url);
      expect(res.status, url).toBe(200);
      expect(await res.text()).toContain('<title>Steward</title>');
    }
  });

  it('never answers missing files or unknown API routes with the app', async () => {
    expect((await fetch(s.base + '/assets/missing.js')).status).toBe(404);
    expect([401, 404]).toContain((await fetch(s.base + '/api/does-not-exist')).status); // sign-in is checked first
  });
});

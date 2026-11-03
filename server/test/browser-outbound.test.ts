import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * Browser steps (v0.3.1): a navigation the outbound policy blocks – typically a portal redirecting to a sign-in page on
 * another host – used to end in a bare net::ERR_BLOCKED_BY_CLIENT. The step now says which origin was blocked and how
 * to allow it, in its error, its output and the run log.
 */

/** Whether Playwright and its Chromium are installed (browser steps are optional). */
async function chromiumInstalled(): Promise<boolean> {
  try {
    const pw = (await import('playwright')) as unknown as { chromium: { executablePath(): string } };
    return fs.existsSync(pw.chromium.executablePath());
  } catch {
    return false;
  }
}

const hasChromium = await chromiumInstalled();

describe('browser steps and the outbound policy', () => {
  let s: TestServer;
  let portal: http.Server;
  let sso: http.Server;
  let ssoOrigin: string;
  let platformId: string;

  beforeAll(async () => {
    s = await startTestServer();
    await setup(s);
    sso = http.createServer((_req, res) => res.end('<html><body>Sign in</body></html>'));
    await new Promise<void>((r) => sso.listen(0, '127.0.0.1', r));
    ssoOrigin = `http://127.0.0.1:${(sso.address() as AddressInfo).port}`;
    portal = http.createServer((req, res) => {
      if (req.url === '/js') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(`<html><body>Portal<script>setTimeout(() => (location.href = '${ssoOrigin}/login'), 10)</script></body></html>`);
      }
      res.writeHead(302, { location: `${ssoOrigin}/login` });
      res.end();
    });
    await new Promise<void>((r) => portal.listen(0, '127.0.0.1', r));
    platformId = (
      await s.api('POST', '/platforms', {
        name: 'Portal behind SSO',
        kind: 'generic',
        baseUrl: `http://127.0.0.1:${(portal.address() as AddressInfo).port}`,
        config: { auth: { type: 'none' }, variables: {}, http: { proxy: 'none' } },
      })
    ).id;
  });
  afterAll(async () => {
    portal?.close();
    sso?.close();
    await s?.app.close();
  });

  it('names the origin and the fix', async () => {
    const { blockedNavigation } = await import('../src/engine/runner.js');
    expect(blockedNavigation('https://sso.example.com', new Error('Blocked by the outbound policy: https://sso.example.com is not …'))).toBe(
      "blocked by the outbound policy: https://sso.example.com – add it to the platform's trusted origins or the allow-list (Settings → Security & sign-in → Outbound access)",
    );
    expect(blockedNavigation('http://169.254.169.254', new Error('Blocked: request to a link-local / cloud metadata address'))).toMatch(
      /^blocked: http:\/\/169\.254\.169\.254 – Blocked: request to a link-local/,
    );
  });

  it.skipIf(!hasChromium)(
    'a redirect to a host outside the policy names the blocked origin instead of ERR_BLOCKED_BY_CLIENT alone',
    async () => {
      const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
      const p = await s.api('POST', '/processes', {
        definition: {
          name: 'Portal check',
          connections: [{ slot: 'portal' }],
          inputs: [],
          nodes: [n('start', 'start'), n('open', 'browser', { connection: 'portal', actions: [{ action: 'goto', value: '/home' }] })],
          wires: [{ from: 'start', port: 'out', to: 'open' }],
        },
      });
      const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: { portal: platformId }, inputs: {} });
      const r = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
      expect(r.status).toBe('failed');
      const step = r.steps.find((x: any) => x.key === 'open');
      expect(step.error).toContain(`blocked by the outbound policy: ${ssoOrigin} – add it to the platform's trusted origins or the allow-list`);
      expect(r.logs.some((l: any) => l.message.includes(`Browser: blocked by the outbound policy: ${ssoOrigin}`))).toBe(true);
    },
    120_000,
  );

  it.skipIf(!hasChromium)(
    'a navigation by the page (script, link) that the policy blocks is named in the output and the log',
    async () => {
      const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
      const p = await s.api('POST', '/processes', {
        definition: {
          name: 'Portal script',
          connections: [{ slot: 'portal' }],
          inputs: [],
          nodes: [
            n('start', 'start'),
            n('open', 'browser', {
              connection: 'portal',
              actions: [
                { action: 'goto', value: '/js' },
                { action: 'wait', value: '500' },
              ],
            }),
          ],
          wires: [{ from: 'start', port: 'out', to: 'open' }],
        },
      });
      const { id } = await s.api('POST', '/runs', { processId: p.id, bindings: { portal: platformId }, inputs: {} });
      const r = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
      expect(r.status).toBe('succeeded');
      const step = await s.api('GET', `/runs/${r.id}/steps/${r.steps.find((x: any) => x.key === 'open').id}`);
      expect(step.output.blockedByPolicy).toEqual([
        `blocked by the outbound policy: ${ssoOrigin} – add it to the platform's trusted origins or the allow-list (Settings → Security & sign-in → Outbound access)`,
      ]);
      expect(step.summary).toContain('1 navigation(s) blocked by the outbound policy');
    },
    120_000,
  );
});

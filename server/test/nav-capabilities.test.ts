import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * What the sidebar shows (v0.3.1): /auth/status tells whether Schedules/Triggers and Credentials are of use to the
 * user – a viewer sees neither, until a team gives them a role that works with them or they own a credential entry.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
const PW = 'Demo-password-1';
let vera: Client, olivia: Client, audrey: Client, adam: Client;
const caps = async (c: Client) => ((await c('GET', '/auth/status')) as { me: { capabilities: Record<string, boolean> } }).me.capabilities;

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  [vera, olivia, audrey, adam] = await Promise.all(['vera', 'olivia', 'audrey', 'adam'].map((u) => s.as(u, PW)));
});
afterAll(async () => {
  await s?.app.close();
});

describe('sidebar capabilities', () => {
  it('by instance role', async () => {
    expect(await caps(s.api)).toMatchObject({ viewAutomation: true, viewCredentials: true });
    expect(await caps(olivia)).toMatchObject({ viewAutomation: true, viewCredentials: true });
    expect(await caps(audrey)).toMatchObject({ viewAutomation: true, viewCredentials: true });
    expect(await caps(adam)).toMatchObject({ viewAutomation: false, viewCredentials: true });
    expect(await caps(vera)).toMatchObject({ viewAutomation: false, viewCredentials: false });
  });

  it('an owned credential entry shows the register to a viewer', async () => {
    await s.api('POST', '/credentials', { name: 'Vera’s token', type: 'token', ownerSubjects: ['user:vera'] });
    expect(await caps(vera)).toMatchObject({ viewAutomation: false, viewCredentials: true });
  });
});

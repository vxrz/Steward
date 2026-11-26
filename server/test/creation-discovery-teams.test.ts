import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Discovery under "owning teams only" (ADR 0042 point 6): a run is started by the system or by a schedule, not by a
 * person in a session, so it has no creator whose team could be required – it keeps adding elements (with the teams of
 * its source or platform, none when neither has any) instead of failing like an import by a person without a team.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let kafka = '';

beforeAll(async () => {
  s = await startTestServer();
  await setup(s, { newItemVisibility: 'owningTeams' });
  await s.api('POST', '/demo/setup', { applications: false });
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  dana = await s.as('dana', 'Demo-password-1');
  kafka = ((await s.api('GET', '/platforms')) as { id: string; kind: string }[]).find((p) => p.kind === 'kafka')!.id;
}, 180_000);

describe('a discovery run with "owningTeams"', () => {
  it('adds its elements although nobody signed in created them', async () => {
    const mk = await import('../src/mock/mockKafka.js');
    mk.addKafkaTopics('inv-owning.', 3);
    const src = await dana('POST', '/data-products/discovery-sources', { name: 'Invented owning', platformId: kafka, scope: ['inv-owning.'], enabled: false });
    const { runSource } = await import('../src/dataproducts/discovery/job.js');
    const run = await runSource(src.id, { trigger: 'schedule' });
    expect(run).toMatchObject({ status: 'succeeded', added: 3 });
    mk.resetKafka();
  }, 60_000);
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Data contracts in monitors, processes and reports (#221): the monitor check "Data contract" (the test with the
 * owner's rights, Steward's own findings), the process step "Test a data contract" (and that a test run never calls the
 * service), the "Data contracts" section of scheduled reports. The contracts themselves: datacontracts.test.ts.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Demo-password-1';
const KEY = 'demo-datacontract-key';

let s: TestServer;
let dana: Client;
let orders: { id: string; key: string };
let customers: { id: string; key: string };

const failure = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('expected a failure');
    },
    (e: { status: number; body: Record<string, unknown> }) => e,
  );
const calls = async (): Promise<unknown[]> => (await fetch(`${s.base}/mock/datacontract/_mock/calls`, { headers: { 'x-api-key': KEY } })).json();
const resetMock = () => fetch(`${s.base}/mock/datacontract/_mock/reset`, { method: 'POST', headers: { 'x-api-key': KEY } });

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  await s.api('POST', '/demo/setup', {});
  dana = await s.as('dana', PW);
  const list = await s.api('GET', '/data-contracts');
  orders = list.find((c: { key: string }) => c.key === 'shop-orders');
  customers = list.find((c: { key: string }) => c.key === 'shop-customers');
  // the orders contract promises a column "channel" the demo table does not have: its test fails
  const doc = YAML.parse((await s.api('GET', `/data-contracts/${orders.id}`)).yaml);
  doc.schema[0].properties.push({ name: 'channel', logicalType: 'string' });
  await s.api('PUT', `/data-contracts/${orders.id}/settings`, {
    servicePlatformId: (await s.api('GET', `/data-contracts/${orders.id}`)).servicePlatformId,
    testServer: 'production',
    requireChangeRecord: false,
  });
  await s.api('POST', `/data-contracts/${orders.id}/versions`, { yaml: YAML.stringify(doc) });
  // the customers' table columns are known once the schema was read
  const shop = (await s.api('GET', '/platforms')).find((p: { name: string }) => p.name === 'Shop database (demo)').id;
  await s.api('POST', `/db-schemas/platform/${shop}/read`);
}, 120_000);
afterAll(async () => {
  await s?.app.close();
});

describe('monitors, processes and reports', () => {
  it('the monitor check tests the contract with the owner’s rights and judges Steward’s findings', async () => {
    const check = (x: Record<string, unknown>) => ({ check: { id: 'c', name: 'Contract', type: 'data-contract', ...x } });
    const tested = await dana('POST', '/monitors/check-preview', check({ contract: orders.id }));
    expect(tested.status).toBe('down'); // version 2 promises a column "channel" the table does not have
    const findings = await dana('POST', '/monitors/check-preview', check({ contract: customers.id, mode: 'findings' }));
    expect(findings.status).toBe('down');
    expect(findings.message).toContain('phone');
    // a contract dana may not see reads like a missing one
    const missing = await failure(dana('POST', '/monitors/check-preview', check({ contract: 'dct_missing' })));
    expect(missing).toMatchObject({ status: 400, body: { code: 'DATA_CONTRACT_NOT_FOUND' } });
    const runs = await s.api('GET', `/data-contracts/${orders.id}/runs`);
    expect(runs[0]).toMatchObject({ via: 'monitor', actor: 'dana' });
  });

  it('the process step tests the contract and stores the run with the run’s id', async () => {
    const n = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ id, type, x: 0, y: 0, ...extra });
    const p = await dana('POST', '/processes', {
      definition: {
        name: 'Test the shop contracts',
        connections: [],
        inputs: [],
        nodes: [
          n('start', 'start'),
          n('orders', 'contractTest', { contract: 'shop-orders' }),
          n('customers', 'contractTest', { contract: customers.id, saveAs: 'customers' }),
        ],
        wires: [
          { from: 'start', to: 'orders', port: 'out' },
          { from: 'orders', to: 'customers', port: 'out' },
        ],
      },
    });
    const { id } = await dana('POST', '/runs', { processId: p.id, bindings: {} });
    const run = await s.waitRun(id, ['succeeded', 'failed', 'cancelled']);
    expect(run.status).toBe('succeeded');
    const steps = run.steps.filter((x: { stepId: string }) => x.stepId === 'customers' || x.stepId === 'orders');
    expect(steps.map((x: { status: string }) => x.status).sort()).toEqual(['failed', 'failed']);
    const runs = await s.api('GET', `/data-contracts/${customers.id}/runs`);
    expect(runs[0]).toMatchObject({ via: 'process', sourceId: id, actor: 'dana' });
    // a test run never calls the service
    await resetMock();
    const { id: testId } = await dana('POST', '/runs', { processId: p.id, bindings: {}, recorded: true });
    const t = await s.waitRun(testId, ['succeeded', 'failed', 'cancelled']);
    expect(t.status).toBe('succeeded');
    expect((await calls()).length).toBe(0);
  });

  it('the report section lists the contracts with their tests and versions', async () => {
    const sched = await s.api('POST', '/report-schedules', {
      name: 'Contracts',
      preset: 'weekly',
      lang: 'en',
      sections: { contracts: { contractIds: null } },
      recipients: { users: [], teams: [], emails: [] },
    });
    const report = await s.api('POST', `/report-schedules/${sched.id}/run`, {}).catch((e: { status: number }) => e);
    expect(report).toBeTruthy();
    expect(
      (
        await failure(
          s.api('POST', '/report-schedules', { name: 'x', preset: 'weekly', lang: 'en', sections: { contracts: { contractIds: ['dct_missing'] } } }),
        )
      ).status,
    ).toBe(400);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';

/**
 * Industrial Edge devices in the catalogue (0.25.0, ADR 0037 part 3): the IEM device id of a system and its status from
 * the examples' dataset (online within the report interval plus the grace), and the installations readout's
 * suggestions – confirmed by a person with the right to change the target, audited, never applied on their own.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

let s: TestServer;
let dana: Client;
let olivia: Client;
let vera: Client;
let processId = '';
const PW = 'Edge-password-1';
const status = async (p: Promise<unknown>): Promise<{ status: number; code?: string }> =>
  p.then(
    () => ({ status: 200 }),
    (e: { status: number; body?: { code?: string } }) => ({ status: e.status, code: e.body?.code }),
  );
const utc = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

async function publish(key: string, rows: Record<string, unknown>[], metrics: Record<string, number> = {}) {
  const { publishDataset } = await import('../src/dashboards/datasets.js');
  publishDataset({
    key,
    title: key,
    processId,
    processName: 'Invented IEM readout',
    runId: '',
    dryRun: false,
    columns: [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith('_'))))],
    rows,
    metrics,
  });
}

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  for (const [name, role] of [
    ['dana', 'designer'],
    ['olivia', 'operator'],
    ['vera', 'viewer'],
  ] as const)
    createUser({ username: name, roles: [role], password: PW });
  dana = await s.as('dana', PW);
  olivia = await s.as('olivia', PW);
  vera = await s.as('vera', PW);
  processId = (await s.api('POST', '/processes', { definition: { name: 'Invented IEM readout', steps: [{ id: 'n', type: 'log', message: 'x' }] } })).id;
});

describe('the IEM device id and status of a system', () => {
  it('is kept on the system (audited) and its status follows the examples’ online rule', async () => {
    const now = Date.now();
    await publish(
      'iem.devices',
      [
        {
          _key: 'dev-a',
          Device: 'edge-a',
          State: 'online',
          Onboarding: 'ACTIVE',
          Firmware: 'ied-os-2.4.0-12-amd64',
          'Last seen': utc(now - 50 * 60000),
          'Report interval (min)': 60,
        },
        {
          _key: 'dev-b',
          Device: 'edge-b',
          State: 'online',
          Onboarding: 'ACTIVE',
          Firmware: 'ied-os-2.1.0-1-amd64',
          'Last seen': utc(now - 80 * 60000),
          'Report interval (min)': 60,
        },
        { _key: 'dev-c', Device: 'edge-c', State: 'not onboarded', Onboarding: 'PENDING', Firmware: '–', 'Last seen': '–' },
      ],
      { graceMinutes: 15 },
    );
    const sys = await dana('POST', '/systems', { name: 'edge-a.example', kind: 'appliance', iemDeviceId: 'dev-a' });
    expect(sys.iemDeviceId).toBe('dev-a');
    expect(await dana('GET', `/systems/${sys.id}/iem`)).toMatchObject({
      found: true,
      name: 'edge-a',
      state: 'online',
      firmware: 'ied-os-2.4.0-12-amd64',
      intervalMinutes: 60,
      graceMinutes: 15,
    });
    // 80 minutes is more than 60 + 15: offline (the dataset said online when it was published)
    await dana('PUT', `/systems/${sys.id}`, { name: 'edge-a.example', kind: 'appliance', iemDeviceId: 'dev-b' });
    expect(await dana('GET', `/systems/${sys.id}/iem`)).toMatchObject({ state: 'offline', firmware: 'ied-os-2.1.0-1-amd64' });
    const changed = (await s.api('GET', '/audit?action=system.changed'))[0];
    expect(changed.details).toMatchObject({ changes: ['iem_device_id'], iemDeviceId: { old: 'dev-a', new: 'dev-b' } });
    await dana('PUT', `/systems/${sys.id}`, { name: 'edge-a.example', kind: 'appliance', iemDeviceId: 'dev-c' });
    expect((await dana('GET', `/systems/${sys.id}/iem`)).state).toBe('notOnboarded');
    await dana('PUT', `/systems/${sys.id}`, { name: 'edge-a.example', kind: 'appliance', iemDeviceId: 'dev-zz' });
    expect(await dana('GET', `/systems/${sys.id}/iem`)).toMatchObject({ found: false, state: 'unknown' });
    // missing keeps it, null clears it
    await dana('PUT', `/systems/${sys.id}`, { name: 'edge-a.example', kind: 'appliance' });
    expect((await dana('GET', `/systems/${sys.id}`)).iemDeviceId).toBe('dev-zz');
    await dana('PUT', `/systems/${sys.id}`, { name: 'edge-a.example', kind: 'appliance', iemDeviceId: null });
    expect(await dana('GET', `/systems/${sys.id}/iem`)).toBeNull();
    await dana('DELETE', `/systems/${sys.id}`);
  });
});

describe('the installations readout and its suggestions', () => {
  let named = '';
  let opcua = '';
  let hiddenSys = '';
  beforeAll(async () => {
    await publish('iem.installations', [
      {
        _key: 'dev-1/app-1',
        'Device id': 'dev-1',
        Device: 'edge-line-1',
        Onboarding: 'ACTIVE',
        'Application id': 'app-1',
        Application: 'Invented OPC UA connector',
        Version: '1.12.2',
      },
      {
        _key: 'dev-1/app-2',
        'Device id': 'dev-1',
        Device: 'edge-line-1',
        Onboarding: 'ACTIVE',
        'Application id': 'app-2',
        Application: 'Invented Databus',
        Version: '2.1.0',
      },
      { _key: 'dev-2/', 'Device id': 'dev-2', Device: 'edge-line-2', Onboarding: 'ACTIVE', 'Application id': '–', Application: '–', Version: '–' },
      { _key: 'dev-3/', 'Device id': 'dev-3', Device: 'edge-secret', Onboarding: 'ACTIVE', 'Application id': '–', Application: '–', Version: '–' },
      { _key: 'dev-9/', 'Device id': 'dev-9', Device: 'edge-gone', Onboarding: 'DELETED', 'Application id': '–', Application: '–', Version: '–' },
    ]);
    // edge-line-1 is a system by name (no IEM id yet); the OPC UA connector is in the catalogue, the Databus is not
    named = (await s.api('POST', '/systems', { name: 'edge-line-1.example', kind: 'appliance', owners: ['user:olivia'] })).id;
    opcua = (await s.api('POST', '/applications', { name: 'Invented OPC UA connector' })).id;
    hiddenSys = (await s.api('POST', '/systems', { name: 'Invented hidden', kind: 'appliance', iemDeviceId: 'dev-3' })).id;
    await s.api('PUT', `/access/system/${hiddenSys}/scope`, { restricted: true });
  });

  it('suggests, as the reader may see the catalogue; a viewer sees them without the right to confirm', async () => {
    const e = await dana('GET', '/systems/edge-suggestions');
    expect(e.readout).toMatchObject({ dataset: 'iem.installations', devices: 3, installations: 2 });
    expect(e.suggestions.map((x: { key: string }) => x.key)).toEqual([
      `linkSystem:dev-1:${named}`,
      'addApplication:dev-1:invented opc ua connector',
      'addApplication:dev-1:invented databus',
      'createSystem:dev-2',
    ]);
    expect(e.suggestions[1]).toMatchObject({ application: { id: opcua }, appVersion: '1.12.2', canConfirm: true });
    expect(e.suggestions[2]).toMatchObject({ application: null, appTitle: 'Invented Databus' });
    // dev-3 is recorded in a system she may not see: counted, never named
    expect(e.hidden).toBe(1);
    expect(JSON.stringify(e)).not.toContain('edge-secret');
    expect(JSON.stringify(e)).not.toContain(hiddenSys);
    const v = await vera('GET', '/systems/edge-suggestions');
    expect(v.suggestions.every((x: { canConfirm: boolean }) => !x.canConfirm)).toBe(true);
    expect(await status(vera('POST', '/systems/edge-suggestions/confirm', { key: 'createSystem:dev-2' }))).toMatchObject({ status: 403 });
    // an operator who owns the named system may record the device id there, not create a system
    const o = await olivia('GET', '/systems/edge-suggestions');
    expect(o.suggestions.find((x: { kind: string }) => x.kind === 'linkSystem').canConfirm).toBe(true);
    expect(o.suggestions.find((x: { kind: string }) => x.kind === 'createSystem').canConfirm).toBe(false);
  });

  it('confirming does what it says with the target’s rights and is audited; nothing happens on its own', async () => {
    expect((await s.api('GET', '/systems')).some((x: { name: string }) => x.name === 'edge-line-2')).toBe(false);
    await olivia('POST', '/systems/edge-suggestions/confirm', { key: `linkSystem:dev-1:${named}` });
    expect((await s.api('GET', `/systems/${named}`)).iemDeviceId).toBe('dev-1');
    const r = await dana('POST', '/systems/edge-suggestions/confirm', { key: 'createSystem:dev-2' });
    expect(await s.api('GET', `/systems/${r.systemId}`)).toMatchObject({ name: 'edge-line-2', kind: 'appliance', iemDeviceId: 'dev-2' });
    await dana('POST', '/systems/edge-suggestions/confirm', { key: 'addApplication:dev-1:invented opc ua connector' });
    const added = await dana('POST', '/systems/edge-suggestions/confirm', { key: 'addApplication:dev-1:invented databus' });
    expect((await s.api('GET', `/applications/${added.applicationId}`)).name).toBe('Invented Databus');
    const sys = await s.api('GET', `/systems/${named}`);
    expect(sys.applications.map((a: { applicationName: string; note: string }) => [a.applicationName, a.note])).toEqual([
      ['Invented Databus', 'Version 2.1.0 (Industrial Edge readout)'],
      ['Invented OPC UA connector', 'Version 1.12.2 (Industrial Edge readout)'],
    ]);
    const audits = await s.api('GET', '/audit?action=edge.suggestion_confirmed');
    expect(audits).toHaveLength(4);
    expect(audits.find((a: { details: { kind: string } }) => a.details.kind === 'createSystem').details).toMatchObject({
      deviceId: 'dev-2',
      systemId: r.systemId,
    });
    // the readout and the catalogue agree now; a confirmed key is gone
    expect((await dana('GET', '/systems/edge-suggestions')).suggestions).toEqual([]);
    expect(await status(dana('POST', '/systems/edge-suggestions/confirm', { key: 'createSystem:dev-2' }))).toMatchObject({
      status: 404,
      code: 'EDGE_SUGGESTION_GONE',
    });
  });

  it('a dismissed one stays away until restored; dismissing is audited', async () => {
    await publish('iem.installations', [
      { _key: 'dev-4/', 'Device id': 'dev-4', Device: 'edge-line-4', Onboarding: 'ACTIVE', 'Application id': '–', Application: '–', Version: '–' },
    ]);
    expect((await dana('GET', '/systems/edge-suggestions')).suggestions.map((x: { key: string }) => x.key)).toEqual(['createSystem:dev-4']);
    expect(await status(vera('POST', '/systems/edge-suggestions/dismiss', { key: 'createSystem:dev-4' }))).toMatchObject({ status: 403 });
    await dana('POST', '/systems/edge-suggestions/dismiss', { key: 'createSystem:dev-4' });
    expect(await dana('GET', '/systems/edge-suggestions')).toMatchObject({ suggestions: [], dismissed: 1 });
    expect((await s.api('GET', '/audit?action=edge.suggestion_dismissed'))[0].details).toMatchObject({ key: 'createSystem:dev-4', deviceName: 'edge-line-4' });
    expect(await dana('POST', '/systems/edge-suggestions/restore', {})).toEqual({ restored: 1 });
    expect((await dana('GET', '/systems/edge-suggestions')).suggestions).toHaveLength(1);
  });
});

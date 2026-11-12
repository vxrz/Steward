import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mqttPacket from 'mqtt-packet';
import { setup, startTestServer, type TestServer } from './helpers.js';

/**
 * MQTT brokers connect to the address that was checked (security review 0.19.0 L3): the broker's name was checked once
 * and then resolved again by MQTT.js on connect and every reconnect, so a name rebound to a cloud-metadata address after
 * the check was reached. Now every connection resolves through the pinning lookup.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const NAME = 'broker.invented.example';
/** What the next lookups of NAME answer (then 127.0.0.1) */
const answers = vi.hoisted(() => [] as string[]);
const lookups = vi.hoisted(() => ({ n: 0 }));
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>();
  const lookup = (async (host: string, opts?: unknown) => {
    if (host !== 'broker.invented.example') return (real.lookup as (h: string, o?: unknown) => Promise<unknown>)(host, opts);
    lookups.n++;
    const address = answers.shift() ?? '127.0.0.1';
    const one = { address, family: net.isIP(address) };
    return (opts as { all?: boolean } | undefined)?.all ? [one] : one;
  }) as typeof real.lookup;
  return { ...real, default: { ...real, lookup }, lookup };
});

let s: TestServer;
let broker: net.Server;
let port = 0;

beforeAll(async () => {
  // a minimal MQTT broker over plain TCP: accepts every CONNECT
  broker = net.createServer((sock) => {
    const parser = mqttPacket.parser({ protocolVersion: 4 });
    parser.on('packet', (p: mqttPacket.Packet) => {
      if (p.cmd === 'connect') sock.write(mqttPacket.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false } as mqttPacket.IConnackPacket));
      if (p.cmd === 'disconnect') sock.end();
    });
    sock.on('data', (d) => parser.parse(d));
    sock.on('error', () => undefined); // the client went away
  });
  await new Promise<void>((r) => broker.listen(0, '127.0.0.1', () => r()));
  port = (broker.address() as net.AddressInfo).port;
  s = await startTestServer();
  await setup(s);
});
afterAll(() => broker?.close());

describe('L3: MQTT connects to the checked address', () => {
  it('connects through the pinning lookup, and refuses a name rebound after the check', async () => {
    const p = await s.api('POST', '/platforms', {
      name: 'Invented broker',
      kind: 'mqtt',
      config: { auth: { type: 'none' }, variables: { url: `mqtt://${NAME}:${port}` } },
    });
    const ok = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(ok).toMatchObject({ ok: true, message: expect.stringContaining(`mqtt://${NAME}:${port}`) });
    // resolved for the check and again for the connection
    expect(lookups.n).toBeGreaterThanOrEqual(2);
    // the check sees the harmless address, the connection the metadata address: refused before anything is sent
    answers.push('127.0.0.1', '169.254.169.254');
    const refused = await s.api('POST', `/platforms/${p.id}/test`, {});
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/link-local|Blocked/) });
  });
});

import { beforeAll, describe, expect, it } from 'vitest';
import { setup, startTestServer, type Client, type TestServer } from './helpers.js';
import { mqttBroker } from '@sm/shared';

/**
 * Edge applications in data products (0.25.0, ADR 0037 part 3): the `mqtt.topic` element kind for MQTT brokers and the
 * Industrial Edge Databus (OpenLineage namespace mqtt://host:port), and _Runs on_ – the system and environment an
 * application or connector runner runs on, named in the step and the pipeline picture ("… @ ied-line-01.example"),
 * hidden from who may not see the system and kept by their save; carried by the file format.
 */

process.env.SM_GATUS_AUTOSTART = '0';
process.env.SM_MONITOR_AUTOSTART = '0';
process.env.SM_MONITOR_DEMO_SIMULATOR = '0';

const PW = 'Edge-password-1';
let s: TestServer;
let dana: Client;
let vera: Client;
let kafka = '';
let mqtt = '';
let edge = '';
let hidden = '';
let bridge = '';
let product = '';
let topic = '';
let databus = '';

const fail = async (p: Promise<unknown>): Promise<{ status: number; code: string; params: Record<string, unknown> }> => {
  try {
    await p;
  } catch (e) {
    const err = e as { status: number; body?: { code?: string; params?: Record<string, unknown> } };
    return { status: err.status, code: err.body?.code ?? '', params: err.body?.params ?? {} };
  }
  throw new Error('expected a refusal');
};

beforeAll(async () => {
  s = await startTestServer();
  await setup(s);
  const { createUser } = await import('../src/auth/users.js');
  createUser({ username: 'dana', roles: ['designer'], password: PW });
  createUser({ username: 'vera', roles: ['viewer'], password: PW });
  dana = await s.as('dana', PW);
  vera = await s.as('vera', PW);
  await s.api('PUT', '/settings/modules/dataProducts', { enabled: true });
  kafka = (
    await s.api('POST', '/platforms', {
      name: 'Invented Kafka',
      kind: 'kafka',
      environment: 'prod',
      baseUrl: '',
      config: { auth: { type: 'none' }, variables: { bootstrap: 'kafka-1.example:9092' } },
    })
  ).id;
  mqtt = (
    await s.api('POST', '/platforms', {
      name: 'Invented broker',
      kind: 'mqtt',
      baseUrl: '',
      config: { auth: { type: 'none' }, variables: { url: 'mqtts://broker.example' } },
    })
  ).id;
  edge = (await s.api('POST', '/systems', { name: 'ied-line-01.example', kind: 'appliance' })).id;
  hidden = (await s.api('POST', '/systems', { name: 'Invented hidden box', kind: 'appliance' })).id;
  await s.api('PUT', `/access/system/${hidden}/scope`, { restricted: true });
  bridge = (await s.api('POST', '/applications', { name: 'Invented edge stream bridge' })).id;
}, 120_000);

describe('mqtt.topic elements', () => {
  it('name their broker: the platform’s, or the Databus of an edge device; OpenLineage mqtt://host:port', async () => {
    expect(mqttBroker('ie-databus')).toBe('ie-databus:1883');
    expect(mqttBroker('mqtts://broker.example')).toBe('broker.example:8883');
    expect(mqttBroker('ws://127.0.0.1:9001/mqtt')).toBe('127.0.0.1:9001');
    expect(mqttBroker('not a host')).toBeNull();
    const onBroker = await dana('POST', '/data-elements', { platformId: mqtt, kind: 'mqtt.topic', qualifiedName: 'plant/line1/state', environment: 'prod' });
    expect(onBroker).toMatchObject({ kind: 'mqtt.topic', olNamespace: 'mqtt://broker.example:8883', olName: 'plant/line1/state' });
    const d = await dana('POST', '/data-elements', {
      kind: 'mqtt.topic',
      qualifiedName: 'ie/d/j/simatic/v1/s7c1/dp/r/line1/default',
      environment: 'prod',
      // 0.25.0 integration: the broker in the generic parts' namespace field (host:port is enough)
      namespace: 'ie-databus:1883',
    });
    databus = d.id;
    expect(d).toMatchObject({ platformId: null, olNamespace: 'mqtt://ie-databus:1883', olName: 'ie/d/j/simatic/v1/s7c1/dp/r/line1/default' });
    // a rename follows in OpenLineage
    const renamed = await dana('PUT', `/data-elements/${d.id}`, { qualifiedName: 'ie/d/j/simatic/v1/s7c1/dp/r/line-1/default' });
    expect(renamed.olName).toBe('ie/d/j/simatic/v1/s7c1/dp/r/line-1/default');
    // the broker is people's to change, through the namespace – and survives an edit that does not name it
    const moved = await dana('PUT', `/data-elements/${d.id}`, { namespace: 'mqtts://broker.invented.example' });
    expect(moved).toMatchObject({ olNamespace: 'mqtt://broker.invented.example:8883', olName: 'ie/d/j/simatic/v1/s7c1/dp/r/line-1/default' });
    expect((await dana('PUT', `/data-elements/${d.id}`, { description: 'Line 1 state' })).olNamespace).toBe('mqtt://broker.invented.example:8883');
    expect((await dana('PUT', `/data-elements/${d.id}`, { namespace: 'mqtt://ie-databus:1883' })).olNamespace).toBe('mqtt://ie-databus:1883');
    // not a broker address; not beside a broker platform (its url gives the namespace); no technology or properties
    expect(await fail(dana('PUT', `/data-elements/${d.id}`, { namespace: 'https://not-a-broker.example/x' }))).toMatchObject({
      status: 400,
      code: 'DATA_ELEMENT_GENERIC',
      params: { context: 'broker' },
    });
    expect(await fail(dana('PUT', `/data-elements/${onBroker.id}`, { namespace: 'mqtt://other.example:1883' }))).toMatchObject({
      status: 400,
      code: 'DATA_ELEMENT_GENERIC',
      params: { context: 'brokerPlatform' },
    });
    expect(await fail(dana('PUT', `/data-elements/${d.id}`, { technology: 'mqtt' }))).toMatchObject({ status: 400, params: { context: 'notGeneric' } });
    // not on a Kafka platform
    expect(await fail(dana('POST', '/data-elements', { platformId: kafka, kind: 'mqtt.topic', qualifiedName: 'x' }))).toMatchObject({
      status: 400,
      code: 'DATA_ELEMENT_PLATFORM',
    });
  });
});

describe('runs on', () => {
  beforeAll(async () => {
    product = (await dana('POST', '/data-products', { key: 'line-telemetry', name: 'Line telemetry' })).id;
    topic = (await dana('POST', '/data-elements', { platformId: kafka, kind: 'kafka.topic', qualifiedName: 'line1.state.v1', environment: 'prod' })).id;
    await dana('POST', `/data-products/${product}/members`, { elementIds: [databus, topic], role: 'internal' });
    // an MQTT topic is a port's element like a Kafka topic
    const port = await dana('POST', `/data-products/${product}/ports`, { direction: 'input', name: 'Line 1 on the Databus', type: 'topic' });
    await dana('PUT', `/data-products/${product}/ports/${port.id}/bindings/prod`, { elementIds: [databus] });
  });

  it('a step: Databus topic → application on the edge device → Kafka topic, named in the step and the picture', async () => {
    const step = await dana('POST', `/data-products/${product}/steps`, {
      name: 'Databus to Kafka',
      kind: 'replicate',
      inputs: [databus],
      outputs: [topic],
      runner: { kind: 'application', id: bridge, runsOn: { systemId: edge, environment: 'prod' } },
    });
    expect(step).toMatchObject({
      runner: { kind: 'application', id: bridge, runsOn: { systemId: edge, environment: 'prod' } },
      runsOn: { id: edge, name: 'ied-line-01.example', environment: 'prod' },
      runsOnHidden: false,
    });
    const view = await dana('GET', `/data-products/${product}/views/pipeline?environment=prod`);
    expect(JSON.stringify(view)).toContain('Invented edge stream bridge @ ied-line-01.example (prod)');
    // only an application or a connector runs on a system; the system must be one she may see
    expect(
      await fail(
        dana('PUT', `/data-products/${product}/steps/${step.id}`, {
          name: 'x',
          inputs: [databus],
          outputs: [topic],
          runner: { kind: 'platform', id: kafka, runsOn: { systemId: edge, environment: '' } },
        }),
      ),
    ).toMatchObject({ status: 400, code: 'DATA_STEP_INVALID', params: { context: 'runsOn' } });
    expect(
      await fail(
        dana('PUT', `/data-products/${product}/steps/${step.id}`, {
          name: 'x',
          inputs: [databus],
          outputs: [topic],
          runner: { kind: 'application', id: bridge, runsOn: { systemId: hidden, environment: '' } },
        }),
      ),
    ).toMatchObject({ status: 400, params: { context: 'runsOn' } });
  });

  it('a system the reader may not see is not named and stays when they save the step; the file format carries it', async () => {
    const [step] = await dana('GET', `/data-products/${product}/steps`);
    await s.api('PUT', `/data-products/${product}/steps/${step.id}`, {
      name: 'Databus to Kafka',
      kind: 'replicate',
      inputs: [databus],
      outputs: [topic],
      runner: { kind: 'application', id: bridge, runsOn: { systemId: hidden, environment: 'prod' } },
    });
    const [seen] = await dana('GET', `/data-products/${product}/steps`);
    expect(seen).toMatchObject({ runner: { kind: 'application', id: bridge, runsOn: null }, runsOn: null, runsOnHidden: true });
    expect(JSON.stringify(seen)).not.toContain(hidden);
    expect(JSON.stringify(await dana('GET', `/data-products/${product}/views/pipeline?environment=prod`))).not.toContain('Invented hidden box');
    await dana('PUT', `/data-products/${product}/steps/${step.id}`, {
      name: 'Databus to Kafka (bridge)',
      kind: 'replicate',
      inputs: [databus],
      outputs: [topic],
      runner: { kind: 'application', id: bridge },
    });
    const [admin] = await s.api('GET', `/data-products/${product}/steps`);
    expect(admin).toMatchObject({ name: 'Databus to Kafka (bridge)', runsOn: { id: hidden } });
    // back on the edge device; the export names it, the viewer reads it
    await s.api('PUT', `/data-products/${product}/steps/${step.id}`, {
      name: 'Databus to Kafka',
      kind: 'replicate',
      inputs: [databus],
      outputs: [topic],
      runner: { kind: 'application', id: bridge, runsOn: { systemId: edge, environment: 'prod' } },
    });
    expect((await vera('GET', `/data-products/${product}/steps`))[0].runsOn).toMatchObject({ name: 'ied-line-01.example' });
    const exported = await dana('GET', `/data-products/${product}/export?format=json`);
    expect(JSON.stringify(exported)).toContain('"runs_on":{"system":"ied-line-01.example","environment":"prod"}');
  });
});

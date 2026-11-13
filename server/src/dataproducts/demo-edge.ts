import { IE_DATABUS_BROKER } from '@sm/shared';
import { db } from '../db.js';
import { logger } from '../log.js';
import { applicationInput, canEditApplication, createApplication } from '../catalogue/applications.js';
import { createSystem, linkSystem, systemInput } from '../catalogue/systems.js';
import { addMembers, insertElement, updateElement } from './elements.js';
import { createStep } from './steps.js';

/**
 * The edge of the demo (0.25.0, ADR 0037 part 3, docs/DATA-PRODUCTS.md#the-demo): machine data from the invented
 * milling line 1 reaches Confluent through an Industrial Edge device – all invented.
 *
 *   - the system `ied-line-01.example` (an appliance, the IEM device `dev-001` of the simulated IEM) with the
 *     applications "OPC UA Connector" and "Edge Stream Bridge" running on it; IEM also reports a Databus and a data
 *     service there that the catalogue does not record – the Industrial Edge suggestions offer them;
 *   - the elements: the Databus topic `ie/d/line-1/opcua/state` (mqtt.topic, broker ie-databus:1883) and the Confluent
 *     topic `plant.line1.state.v1`, both in prod, in the draft product "Machine measurements";
 *   - the step "Databus to Confluent" (replicate): runner Edge Stream Bridge @ ied-line-01.example (prod);
 *   - in the plant registry (when it is on, plant/demo-edge.ts): the edge device as an asset whose device is the
 *     system, and the OPC UA collection of milling centre 1 that writes the Databus topic (the element's plant sink).
 *
 * Once: the system's name says it was loaded.
 */

export const EDGE_DEMO = {
  system: 'ied-line-01.example',
  iemDevice: 'dev-001',
  connector: 'OPC UA Connector',
  bridge: 'Edge Stream Bridge',
  databusTopic: 'ie/d/line-1/opcua/state',
  confluentTopic: 'plant.line1.state.v1',
  product: 'machine-measurements',
} as const;

const idOf = (sql: string, ...args: unknown[]) => db().get<{ id: string }>(sql, ...args)?.id;

/** The catalogue and data products half (with the service half of the demo). */
export function seedEdgeDemo(): void {
  if (idOf('SELECT id FROM systems WHERE name = ?', EDGE_DEMO.system)) return;
  const system = createSystem(
    systemInput.parse({
      name: EDGE_DEMO.system,
      kind: 'appliance',
      vendor: 'Invented',
      note: 'Industrial Edge device of milling line 1 (invented): reads the machines over OPC UA and sends their state to Confluent.',
      iemDeviceId: EDGE_DEMO.iemDevice,
    }),
  ).id;
  const app = (name: string, version: string) => {
    const id = idOf('SELECT id FROM applications WHERE name = ?', name) ?? createApplication(applicationInput.parse({ name, version, vendor: 'Invented' })).id;
    linkSystem(id, { systemId: system, environment: 'prod', note: `Version ${version} on the edge device` }, canEditApplication);
    return id;
  };
  app(EDGE_DEMO.connector, '1.12.2');
  const bridge = app(EDGE_DEMO.bridge, '1.0.1');

  const product = idOf('SELECT id FROM dp_products WHERE key = ?', EDGE_DEMO.product);
  const confluent = idOf('SELECT id FROM platforms WHERE name = ?', 'Confluent Cloud (demo)');
  if (!product || !confluent) return;
  const databus = insertElement({
    kind: 'mqtt.topic',
    qualifiedName: EDGE_DEMO.databusTopic,
    environment: 'prod',
    layer: 'source',
    description: 'Machine state of milling line 1 on the Databus of the edge device (published by the OPC UA connector).',
    namespace: `mqtt://${IE_DATABUS_BROKER}`,
  });
  const topic = insertElement({
    platformId: confluent,
    kind: 'kafka.topic',
    qualifiedName: EDGE_DEMO.confluentTopic,
    environment: 'prod',
    layer: 'raw',
    description: 'Machine state of milling line 1 in Confluent Cloud, sent on by the edge device.',
  });
  addMembers(product, 'Machine measurements', { elementIds: [databus], role: 'input' });
  addMembers(product, 'Machine measurements', { elementIds: [topic], role: 'internal' });
  createStep(product, 'Machine measurements', {
    name: 'Databus to Confluent',
    kind: 'replicate',
    description: 'The bridge application on the edge device subscribes to the Databus topic and produces each message to Confluent.',
    inputs: [databus],
    outputs: [topic],
    runner: { kind: 'application', id: bridge, runsOn: { systemId: system, environment: 'prod' } },
    schedule: 'continuous',
  });
}

/** Links the Databus element to the plant sink that writes it (the plant half calls it once its collection exists). */
export function linkEdgeDemoSink(sink: { assetId: string; collectionId: string; sinkId: string }): void {
  const id = idOf("SELECT id FROM dp_elements WHERE kind = 'mqtt.topic' AND qualified_name = ?", EDGE_DEMO.databusTopic);
  if (!id) return;
  try {
    updateElement(id, { plantSink: sink });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo Databus element not linked to its plant sink');
  }
}

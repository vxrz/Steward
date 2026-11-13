import { db } from '../db.js';
import { logger } from '../log.js';
import { EDGE_DEMO, linkEdgeDemoSink } from '../dataproducts/demo-edge.js';
import { assetInput } from './model.js';
import { createAsset } from './service.js';
import { createDevice } from './network.js';
import { deviceInput } from './network-model.js';
import { collectionInput, createCollection } from './collections.js';

/**
 * The plant half of the edge demo (0.25.0, ADR 0037 part 3; the catalogue half: dataproducts/demo-edge.ts): the edge
 * device of milling line 1 as an asset of Riverside Works whose device is the system `ied-line-01.example`, and the
 * OPC UA collection of milling centre 1 that its connector runs, writing the machine state to the Databus – the plant
 * sink of the Databus topic element. Only when the registry, the demo enterprise and the system are there; once.
 */
export function seedPlantEdgeDemo(): void {
  const system = db().get<{ id: string }>('SELECT id FROM systems WHERE name = ?', EDGE_DEMO.system)?.id;
  const connector = db().get<{ id: string }>('SELECT id FROM applications WHERE name = ?', EDGE_DEMO.connector)?.id;
  if (!system || !connector || !db().get("SELECT 1 FROM plant_assets WHERE id = 'rvs-mill-01'")) return;
  if (db().get("SELECT 1 FROM plant_assets WHERE id = 'rvs-edge-01'")) return;
  try {
    createAsset(
      assetInput.parse({
        id: 'rvs-edge-01',
        siteId: 'riverside',
        areaId: 'rvs-machining',
        workCenterId: 'rvs-mill-line-1',
        name: 'Edge device line 1',
        manufacturer: 'Invented Edge Devices',
        model: 'IPC 100',
        domain: 'machining',
        role: 'edge-device',
        tags: ['edge'],
        description: 'Industrial Edge device of milling line 1: reads the milling centres over OPC UA and sends their state on to Confluent.',
      }),
    );
    createDevice(
      'rvs-edge-01',
      deviceInput.parse({ id: 'ied-line-01', hostname: 'ied-line-01', domain: 'example', purpose: 'Industrial Edge device', system }),
    );
    createCollection(
      'rvs-mill-01',
      collectionInput.parse({
        id: 'edge-state',
        name: 'Machine state to the Databus',
        collector: { kind: 'application', ref: connector },
        mode: 'interval',
        intervalMs: 1000,
        items: [{ address: 'ns=2;s=ProgramStatus', outputName: 'ProgStatus' }],
        sinks: [{ id: 'databus', name: 'Databus', kind: 'other', ref: 'Industrial Edge Databus', object: EDGE_DEMO.databusTopic, format: 'MQTT' }],
      }),
    );
    linkEdgeDemoSink({ assetId: 'rvs-mill-01', collectionId: 'edge-state', sinkId: 'databus' });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'demo edge device not added to the plant registry');
  }
}

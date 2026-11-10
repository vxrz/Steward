import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { db } from '../db.js';
import { applyImport } from './import.js';
import { plantEnabled } from './settings.js';
import { seedAdvisoryDemo } from './advisories/demo.js';

/** The demo's invented enterprise (examples/plant): two sites, their hierarchy and buildings, about ten assets. */
export const PLANT_DEMO_FILE = 'brightwater.plant.yaml';
/** Part 2 (#219): invented device profiles, KPI definitions and the assignments of some assets (one with a check problem). */
export const PLANT_DEMO_DATA_FILE = 'brightwater-data-points.plant.yaml';

/**
 * Loads the demo enterprise when the module is on and the registry is still empty (demo mode only: on "Load demo
 * data", or when an administrator turns the module on). Imported like any file, so it is audited and can be replaced.
 */
export function seedPlantDemo(): number {
  if (!config.demo || !plantEnabled()) return 0;
  if (db().get('SELECT 1 FROM plant_sites LIMIT 1')) return 0;
  const files = [PLANT_DEMO_FILE, PLANT_DEMO_DATA_FILE].map((name) => ({
    name,
    content: fs.readFileSync(path.join(config.examplesDir, 'plant', name), 'utf8'),
  }));
  const r = applyImport({ files, mode: 'add', missing: 'mark', replaces: null, removeMissing: false, cascade: false });
  // 0.14: a simulated CSAF provider with invented advisories for the demo's devices (docs/ADVISORIES.md)
  seedAdvisoryDemo();
  return r.counts.add;
}

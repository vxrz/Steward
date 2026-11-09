import { config, loopbackUrl } from '../../config.js';
import { db } from '../../db.js';
import { logger } from '../../log.js';
import { plantEnabled } from '../settings.js';
import { createSource, fetchSource } from './fetch.js';

/**
 * The demo's advisory source (demo mode only): the simulated provider at /mock/csaf with the invented advisories of
 * examples/plant/advisories, read once right away (outside tests) and then by the job. A real installation starts
 * without any source.
 */
export function seedAdvisoryDemo(): void {
  if (!config.demo || !plantEnabled()) return;
  if (db().get('SELECT 1 FROM plant_advisory_sources LIMIT 1')) return;
  const s = createSource({
    name: 'Example PSIRTs (demo)',
    url: `${loopbackUrl()}/mock/csaf/.well-known/csaf/provider-metadata.json`,
    enabled: true,
    intervalHours: 24,
    publishers: [],
    since: null,
  });
  if (process.env.VITEST) return;
  setTimeout(() => {
    fetchSource(s.id).catch((err: unknown) => logger.warn({ err }, 'demo advisories not read'));
  }, 1000).unref();
}

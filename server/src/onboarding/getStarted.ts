import {
  CONFLUENT_KIND,
  MONITOR_TYPE_KINDS,
  NON_HTTP_KINDS,
  PVAULT_KIND,
  SNOWFLAKE_KIND,
  isGitPlatformKind,
  type PlatformGetStarted,
  type ProcessTemplate,
} from '@sm/shared';
import { listTemplates } from '../processes/service.js';
import { listBundles } from './bundles.js';

/** A template fits a kind: one of its connections takes it, or – for templates that read through applications (AWS, Kafka) – it is tagged with it. */
export const templateFits = (t: Pick<ProcessTemplate, 'connectionKinds' | 'tags'>, kind: string): boolean =>
  (t.connectionKinds ?? []).includes(kind) || (!(t.connectionKinds ?? []).length && t.tags.includes(kind));

/** Access check sources that read a kind of platform directly (the dataset source works with every platform). */
export function accessSourcesFor(kind: string): string[] {
  if (kind === 'insights-hub') return ['insights-hub'];
  if (isGitPlatformKind(kind)) return ['git'];
  if (kind === SNOWFLAKE_KIND) return ['snowflake'];
  if (kind === 'aws') return ['aws'];
  if (kind === CONFLUENT_KIND) return ['confluent'];
  if (kind === PVAULT_KIND) return ['privilege-vault'];
  return [];
}

export function monitorTypesFor(kind: string): string[] {
  const direct = Object.entries(MONITOR_TYPE_KINDS)
    .filter(([, kinds]) => kinds.includes(kind))
    .map(([type]) => type);
  // every HTTP API can be checked with a platform request
  return NON_HTTP_KINDS.has(kind) ? direct : [...direct, 'platform'];
}

/**
 * "What's next" with a platform of a kind (v0.4.0): the setup wizard's last step and the platform page's "Get started"
 * panel – matching templates and bundles, monitor check types and examples, access check sources, the MCP gateway.
 */
export async function getStarted(kind: string): Promise<PlatformGetStarted> {
  const templates = listTemplates()
    .filter((t) => templateFits(t, kind))
    .map((t) => ({ id: t.id, name: t.name, recommendedSchedule: t.recommendedSchedule?.cron ?? (t.recommendedSchedule?.text || null) }));
  const bundles = (await listBundles()).filter((b) => b.kinds.includes(kind)).map((b) => ({ id: b.id, name: b.name, description: b.description }));
  const monitorTypes = monitorTypesFor(kind);
  const { listExamples, exampleCheckTypes } = await import('../monitors/service.js');
  const monitorExamples = listExamples()
    .filter((e) => {
      try {
        return exampleCheckTypes(e.file).some((type) => MONITOR_TYPE_KINDS[type]?.includes(kind));
      } catch {
        return false;
      }
    })
    .map((e) => ({ file: e.file, name: e.name }));
  return {
    kind,
    templates,
    bundles,
    monitorTypes,
    monitorExamples,
    accessSources: accessSourcesFor(kind),
    mcp: !NON_HTTP_KINDS.has(kind),
  };
}

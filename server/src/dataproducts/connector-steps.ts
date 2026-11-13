import { z } from 'zod';
import {
  CONFLUENT_KIND,
  DATA_PRODUCT_LIMITS as L,
  KAFKA_CONNECT_KIND,
  type AclEntry,
  type DataLineageEnd,
  type DataStep,
  type DataStepRunner,
  type PlatformPermission,
} from '@sm/shared';
import { db } from '../db.js';
import { me } from '../auth/access.js';
import type { AuthUser } from '../auth/context.js';
import { platformAccess } from '../auth/policy.js';
import { HttpError, parseJson } from '../util.js';
import { elementAccess } from './access.js';
import { connectorStepHealth } from './connector-health.js';
import { connectorsOf, draftOf, familyOf, matchEnds, type ConnectorFamily } from './connector-lineage.js';
import { elementTeamIds, elementsByIds } from './store.js';
import { createStep } from './steps.js';

/**
 * _Create step from connector_ (0.25.0, ADR 0037 part 1): a step of kind _bridge_ filled from a Kafka Connect or
 * Confluent connector – the connector as its runner (with its technology: Debezium, Kafka Connect, Confluent), its inputs
 * and outputs as connector-lineage.ts reads them from the allow-listed configuration and the readout (no request to the
 * platform), matched to elements of the catalogue. The step is written by createStep, as one written by hand: who may
 * change the product writes it, one of its outputs is the product's, and only elements the person may see are named.
 * Its health is the connector's state through the existing checks (connector-health.ts).
 *
 *   GET  /api/data-products/connectors                                the connectors of the platforms the reader may see
 *   GET  /api/data-products/:id/steps/from-connector?platformId=&connector=   the step it would be
 *   POST /api/data-products/:id/steps/from-connector                  { platformId, connector, name? }
 */

export interface ConnectorChoice {
  platformId: string;
  platformName: string;
  platformKind: string;
  connectors: { key: string; name: string; type: 'source' | 'sink' | 'unknown'; class: string; state: string; family: ConnectorFamily }[];
}

export interface ConnectorStepDraft {
  platformId: string;
  connector: string;
  name: string;
  kind: 'bridge';
  family: ConnectorFamily;
  runner: DataStepRunner;
  description: string;
  inputs: DataLineageEnd[];
  outputs: DataLineageEnd[];
  hiddenInputs: number;
  hiddenOutputs: number;
  unmatchedInputs: string[];
  unmatchedOutputs: string[];
  health: DataStep['health'];
}

/** Kafka Connect and Confluent platforms the reader may see (id, name, kind). */
function connectorPlatforms(u: AuthUser): { id: string; name: string; kind: string; use: boolean }[] {
  return db()
    .all<{ id: string; name: string; kind: string; acl: string }>(
      'SELECT id, name, kind, acl FROM platforms WHERE kind IN (?, ?) ORDER BY name',
      KAFKA_CONNECT_KIND,
      CONFLUENT_KIND,
    )
    .flatMap((p) => {
      const perms = platformAccess(u, { id: p.id, acl: parseJson<AclEntry<PlatformPermission>[]>(p.acl, []) }).permissions;
      return perms.length ? [{ id: p.id, name: p.name, kind: p.kind, use: perms.includes('use') }] : [];
    });
}

/** The connectors of the platforms the reader may see, from their last readouts. */
export function listConnectors(): ConnectorChoice[] {
  return connectorPlatforms(me()).map((p) => ({
    platformId: p.id,
    platformName: p.name,
    platformKind: p.kind,
    connectors: connectorsOf(p.id)
      .map((c) => ({ key: c.key, name: c.name, type: c.type, class: c.class, state: c.state, family: familyOf(c) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

const draftQuery = z.object({ platformId: z.string().trim().min(1).max(100), connector: z.string().trim().min(1).max(L.short) }).strict();
const createInput = draftQuery.extend({ name: z.string().trim().min(1).max(L.name).optional() }).strict();

const DESCRIPTION: Record<ConnectorFamily, (type: string) => string> = {
  debezium: () => 'Change data capture: the Debezium source connector writes the changes of its tables to topics.',
  snowflakeSink: () => 'Sink: the Snowflake connector writes its topics to tables.',
  s3Sink: () => 'Sink: the S3 connector writes its topics to object storage.',
  other: (type) => (type === 'sink' ? 'Sink: the connector reads its topics.' : 'Source: the connector writes its topics.'),
};

/** The step a connector would be: its ends matched, those the reader may not see counted. */
export function connectorStepDraft(query: unknown): ConnectorStepDraft {
  const u = me();
  const q = draftQuery.parse(query);
  const platform = connectorPlatforms(u).find((p) => p.id === q.platformId);
  if (!platform) throw new HttpError(404, `Platform ${q.platformId} not found`, 'PLATFORM_NOT_FOUND', { id: q.platformId });
  const c = connectorsOf(platform.id).find((x) => x.key === q.connector || x.name === q.connector);
  if (!c) throw new HttpError(404, `The platform has no connector "${q.connector}" (read it again?)`, 'KAFKA_CONNECTOR_NOT_FOUND');
  const d = draftOf(c);
  const m = matchEnds(d);
  const rows = elementsByIds([...m.inputs, ...m.outputs]);
  const teams = elementTeamIds([...rows.keys()]);
  const seen = (id: string) => elementAccess(u, teams.get(id) ?? []).permissions.length > 0;
  const end = (id: string): DataLineageEnd | null => {
    const r = rows.get(id);
    return r && seen(id) ? { id: r.id, kind: r.kind, qualifiedName: r.qualified_name, displayName: r.display_name, environment: r.environment } : null;
  };
  const inputs = m.inputs.map(end).filter((x): x is DataLineageEnd => !!x);
  const outputs = m.outputs.map(end).filter((x): x is DataLineageEnd => !!x);
  const runner: DataStepRunner = { kind: 'connector', platformId: platform.id, name: c.name.slice(0, L.short), technology: d.technology };
  return {
    platformId: platform.id,
    connector: c.key,
    name: c.name.slice(0, L.name),
    kind: 'bridge',
    family: d.family,
    runner,
    description: DESCRIPTION[d.family](d.type),
    inputs,
    outputs,
    hiddenInputs: m.inputs.length - inputs.length,
    hiddenOutputs: m.outputs.length - outputs.length,
    unmatchedInputs: m.unmatchedInputs.slice(0, 20),
    unmatchedOutputs: m.unmatchedOutputs.slice(0, 20),
    health: connectorStepHealth(u, [{ id: 'draft', runner }]).get('draft') ?? null,
  };
}

/**
 * Creates the step (createStep: who may change the product; one output of the product; the elements the person may
 * see – the others are left out and named in the answer's counts). Audited as every step (`dataproduct.step_added`).
 */
export function createConnectorStep(productId: string, productName: string, body: unknown): DataStep {
  const input = createInput.parse(body);
  const d = connectorStepDraft({ platformId: input.platformId, connector: input.connector });
  if (!d.outputs.length)
    throw new HttpError(400, 'No element of the catalogue is written by this connector – a step needs an output', 'DATA_STEP_INVALID', {
      context: 'noOutputInProduct',
    });
  return createStep(productId, productName, {
    name: input.name ?? d.name,
    kind: 'bridge',
    runner: d.runner,
    description: d.description,
    inputs: d.inputs.map((e) => e.id).slice(0, L.stepEnds),
    outputs: d.outputs.map((e) => e.id).slice(0, L.stepEnds),
  });
}

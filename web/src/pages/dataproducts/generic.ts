import { useQuery } from '@tanstack/react-query';
import { findTechnology, type DataLineageEnd, type DataStep, type DataStepRunner, type DataTechnology } from '@sm/shared';
import { get } from '../../api';
import { dpKeys } from './api';

/**
 * The reads of generic parts, bridges and connectors (0.25.0, ADR 0037): the technology list, the connectors a step can
 * be made from and the step a connector would be. Keys under `dataProducts`, so a change of the module reads them again.
 */

const enc = encodeURIComponent;

export const genericKeys = {
  technologies: [...dpKeys.all, 'technologies'] as const,
  connectors: [...dpKeys.all, 'connectors'] as const,
  connectorDraft: (productId: string, platformId: string, connector: string) => [...dpKeys.all, 'connectorDraft', productId, platformId, connector] as const,
};

/** The technology list: built-in entries first, then the administrators' (GET /api/data-products/technologies). */
export const useTechnologies = () =>
  useQuery({ queryKey: genericKeys.technologies, queryFn: () => get<DataTechnology[]>('/data-products/technologies'), staleTime: 5 * 60_000 });

/** The list entry a stored value names, or null (a value not in the list). */
export const technologyEntry = (list: readonly DataTechnology[] | undefined, value: string | null | undefined): DataTechnology | null =>
  findTechnology(list ?? [], value);

export interface ConnectorChoice {
  platformId: string;
  platformName: string;
  platformKind: string;
  connectors: { key: string; name: string; type: 'source' | 'sink' | 'unknown'; class: string; state: string; family: ConnectorFamily }[];
}

export type ConnectorFamily = 'debezium' | 'snowflakeSink' | 's3Sink' | 'other';

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

/** Kafka Connect and Confluent connectors of the platforms the reader may see (from their last readouts). */
export const useConnectors = (enabled: boolean) =>
  useQuery({ queryKey: genericKeys.connectors, queryFn: () => get<ConnectorChoice[]>('/data-products/connectors'), enabled, staleTime: 30_000 });

/** The step a connector would be in a product (its ends matched to the catalogue). */
export const useConnectorDraft = (productId: string, platformId: string | null, connector: string | null) =>
  useQuery({
    queryKey: genericKeys.connectorDraft(productId, platformId ?? '', connector ?? ''),
    queryFn: () => get<ConnectorStepDraft>(`/data-products/${enc(productId)}/steps/from-connector?platformId=${enc(platformId!)}&connector=${enc(connector!)}`),
    enabled: !!platformId && !!connector,
    retry: false,
  });

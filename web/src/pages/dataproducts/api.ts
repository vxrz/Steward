import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DataConsumer,
  DataDiscoveryRun,
  DataDiscoverySource,
  DataDomain,
  DataElement,
  DataElementChecks,
  DataElementSummary,
  DataMaturityLevel,
  DataMonitorProposal,
  DataObject,
  DataObjectSummary,
  DataPage,
  DataPort,
  DataProduct,
  DataProductMember,
  DataProductSummary,
  DataScorecardPart,
  DataStep,
  Platform,
  ProductCost,
  ProductHealth,
} from '@sm/shared';
import { ApiError, get } from '../../api';
import { viewKeys } from './views/queries';

/**
 * The reads of the data products pages (ADR 0036 part 19): one hook per resource, keys under `dataProducts` so that a
 * change invalidates every page of the module at once (and the pictures, whose keys are WP6's).
 */

export const dpKeys = {
  all: ['dataProducts'] as const,
  domains: ['dataProducts', 'domains'] as const,
  products: (q: string) => ['dataProducts', 'products', q] as const,
  product: (id: string) => ['dataProducts', 'product', id] as const,
  productHealth: (id: string) => ['dataProducts', 'product', id, 'health'] as const,
  listHealth: (ids: string, environment: string) => ['dataProducts', 'health', ids, environment] as const,
  members: (id: string, q: string) => ['dataProducts', 'product', id, 'members', q] as const,
  steps: (id: string) => ['dataProducts', 'product', id, 'steps'] as const,
  consumers: (id: string, portId: string) => ['dataProducts', 'product', id, 'consumers', portId] as const,
  monitor: (id: string, environment: string) => ['dataProducts', 'product', id, 'monitor', environment] as const,
  costs: (id: string, environment: string, month: string) => ['dataProducts', 'product', id, 'costs', environment, month] as const,
  scorecard: (id: string, environment: string) => ['dataProducts', 'product', id, 'scorecard', environment] as const,
  links: (kind: string, id: string) => ['dataProducts', 'links', kind, id] as const,
  history: (id: string) => ['dataProducts', 'history', id] as const,
  elements: (q: string) => ['dataProducts', 'elements', q] as const,
  elementSearch: (q: string) => ['dataProducts', 'elementSearch', q] as const,
  element: (id: string) => ['dataProducts', 'element', id] as const,
  elementChecks: (id: string) => ['dataProducts', 'element', id, 'checks'] as const,
  objects: (q: string) => ['dataProducts', 'objects', q] as const,
  object: (id: string) => ['dataProducts', 'object', id] as const,
  objectElements: (id: string) => ['dataProducts', 'object', id, 'elements'] as const,
  sources: ['dataProducts', 'sources'] as const,
  source: (id: string) => ['dataProducts', 'source', id] as const,
  runs: (id: string) => ['dataProducts', 'source', id, 'runs'] as const,
  platforms: ['dataProducts', 'platforms'] as const,
};

/** A query string from the set values (empty ones left out). */
export const qs = (o: Record<string, string | number | boolean | null | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  return p.toString();
};

const enc = encodeURIComponent;

/** Everything of the module changed: lists, pages and pictures read again. */
export function useInvalidateDataProducts(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: dpKeys.all });
    void qc.invalidateQueries({ queryKey: viewKeys.all });
  };
}

// ---------- domains ----------

export const useDomains = () => useQuery({ queryKey: dpKeys.domains, queryFn: () => get<DataDomain[]>('/data-domains'), staleTime: 30_000 });

// ---------- products ----------

/** A page of products after another (keyset paging), filters in the query string. */
export function useProductList(query: string) {
  return useInfiniteQuery({
    queryKey: dpKeys.products(query),
    initialPageParam: '',
    queryFn: ({ pageParam }) => get<DataPage<DataProductSummary>>(`/data-products?${query}${pageParam ? `&cursor=${enc(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export const useProduct = (id: string) => useQuery({ queryKey: dpKeys.product(id), queryFn: () => get<DataProduct>(`/data-products/${enc(id)}`), retry: false });

/** Health of a page of products in one environment ('' each product's default: production first). */
export function useListHealth(ids: string[], environment: string) {
  const key = ids.join(',');
  return useQuery({
    queryKey: dpKeys.listHealth(key, environment),
    queryFn: () => get<ProductHealth[]>(`/data-products/health?${qs({ ids: key, environment })}`),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export const useProductHealth = (id: string) =>
  useQuery({ queryKey: dpKeys.productHealth(id), queryFn: () => get<ProductHealth[]>(`/data-products/${enc(id)}/health`), staleTime: 30_000 });

export function useMembers(id: string, query: string) {
  return useInfiniteQuery({
    queryKey: dpKeys.members(id, query),
    initialPageParam: '',
    queryFn: ({ pageParam }) => get<DataPage<DataProductMember>>(`/data-products/${enc(id)}/members?${query}${pageParam ? `&cursor=${enc(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export const useSteps = (id: string) => useQuery({ queryKey: dpKeys.steps(id), queryFn: () => get<DataStep[]>(`/data-products/${enc(id)}/steps`) });

export const usePorts = (id: string) => useQuery({ queryKey: [...dpKeys.product(id), 'ports'], queryFn: () => get<DataPort[]>(`/data-products/${enc(id)}/ports`) });

export const useConsumers = (id: string, portId: string, enabled = true) =>
  useQuery({
    queryKey: dpKeys.consumers(id, portId),
    queryFn: () => get<DataConsumer[]>(`/data-products/${enc(id)}/ports/${enc(portId)}/consumers`),
    enabled,
  });

export const useMonitorProposal = (id: string, environment: string, enabled: boolean) =>
  useQuery({
    queryKey: dpKeys.monitor(id, environment),
    queryFn: () => get<DataMonitorProposal>(`/data-products/${enc(id)}/monitor?${qs({ environment })}`),
    enabled,
    retry: false,
  });

// ---------- costs and scorecard (WP4: the routes come with their package) ----------

/** A read that answers `null` while the route is not there yet (404 of a route, not of the product: the page loaded it). */
async function optional<T>(url: string): Promise<T | null> {
  try {
    return await get<T>(url);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && e.code !== 'DATA_PRODUCT_NOT_FOUND') return null;
    throw e;
  }
}

/** GET /api/data-products/:id/costs?environment=&month= – ProductCost (ADR 0036 part 11); null: not available yet. */
export const useProductCosts = (id: string, environment: string, month: string) =>
  useQuery({
    queryKey: dpKeys.costs(id, environment, month),
    queryFn: () => optional<ProductCost>(`/data-products/${enc(id)}/costs?${qs({ environment, month })}`),
    retry: false,
  });

/**
 * The scorecard of a product in an environment as this page reads it (ADR 0036 part 13): the parts and ISO/IEC 25012
 * dimensions with their state and evidence, and the maturity computed from them. GET /api/data-products/:id/scorecard
 */
export interface DataProductScorecard {
  productId: string;
  environment: string;
  parts: DataScorecardPart[];
  maturity: DataMaturityLevel;
}

export const useScorecard = (id: string, environment: string) =>
  useQuery({
    queryKey: dpKeys.scorecard(id, environment),
    queryFn: () => optional<DataProductScorecard>(`/data-products/${enc(id)}/scorecard?${qs({ environment })}`),
    retry: false,
    staleTime: 30_000,
  });

// ---------- elements ----------

export function useElementList(query: string) {
  return useInfiniteQuery({
    queryKey: dpKeys.elements(query),
    initialPageParam: '',
    queryFn: ({ pageParam }) => get<DataPage<DataElementSummary>>(`/data-elements?${query}${pageParam ? `&cursor=${enc(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/** The first matches of a search in the catalogue (the pickers: the server searches, debounced by the caller). */
export function useElementSearch(query: string, enabled = true) {
  return useQuery({
    queryKey: dpKeys.elementSearch(query),
    queryFn: () => get<DataPage<DataElementSummary>>(`/data-elements?${query}&limit=20`),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
}

export const useElement = (id: string) => useQuery({ queryKey: dpKeys.element(id), queryFn: () => get<DataElement>(`/data-elements/${enc(id)}`), retry: false });

export const useElementChecks = (id: string) =>
  useQuery({ queryKey: dpKeys.elementChecks(id), queryFn: () => get<DataElementChecks & { canLink: boolean }>(`/data-elements/${enc(id)}/checks`) });

// ---------- data objects ----------

export function useObjectList(query: string) {
  return useInfiniteQuery({
    queryKey: dpKeys.objects(query),
    initialPageParam: '',
    queryFn: ({ pageParam }) => get<DataPage<DataObjectSummary>>(`/data-objects?${query}${pageParam ? `&cursor=${enc(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export const useObject = (id: string) => useQuery({ queryKey: dpKeys.object(id), queryFn: () => get<DataObject>(`/data-objects/${enc(id)}`), retry: false });

export const useObjectElements = (id: string) =>
  useInfiniteQuery({
    queryKey: dpKeys.objectElements(id),
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      get<DataPage<DataElementSummary> & { hidden: number }>(`/data-objects/${enc(id)}/elements${pageParam ? `?cursor=${enc(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next ?? undefined,
  });

// ---------- discovery ----------

export const useSources = () => useQuery({ queryKey: dpKeys.sources, queryFn: () => get<DataDiscoverySource[]>('/data-products/discovery-sources') });
export const useSource = (id: string) =>
  useQuery({ queryKey: dpKeys.source(id), queryFn: () => get<DataDiscoverySource>(`/data-products/discovery-sources/${enc(id)}`), retry: false });
export const useRuns = (id: string, running: boolean) =>
  useQuery({
    queryKey: dpKeys.runs(id),
    queryFn: () => get<DataDiscoveryRun[]>(`/data-products/discovery-sources/${enc(id)}/runs`),
    // while a run goes on, look again every few seconds
    refetchInterval: running ? 4000 : false,
  });

// ---------- platforms ----------

/** The platforms the reader may see (names for the element forms and filters). */
export const usePlatforms = () => useQuery({ queryKey: dpKeys.platforms, queryFn: () => get<Platform[]>('/platforms'), staleTime: 60_000 });

/** The rows of all loaded pages of an infinite list. */
export const pagesOf = <T>(data: { pages: DataPage<T>[] } | undefined): T[] => data?.pages.flatMap((p) => p.items) ?? [];

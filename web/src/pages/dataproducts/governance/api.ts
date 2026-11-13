import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DataAccessRequest,
  DataAccessSettings,
  DataActualView,
  DataEndorsementView,
  DataPortReview,
  DataPortReviewDue,
  DataPortReviewSummary,
  DataPromotion,
  DataPromotionPreview,
  DataRopa,
} from '@sm/shared';
import { get } from '../../../api';
import { dpKeys, qs } from '../api';

/**
 * The reads of consumers, access and governance (0.24.0, ADR 0036 phase 2): keys below the module's (`dataProducts`),
 * so a change anywhere in the module reads them again.
 */

const enc = encodeURIComponent;

export const govKeys = {
  all: [...dpKeys.all, 'governance'] as const,
  actual: (id: string, portId: string, environment: string) => [...dpKeys.all, 'governance', 'actual', id, portId, environment] as const,
  requests: (q: string) => [...dpKeys.all, 'governance', 'requests', q] as const,
  productRequests: (id: string) => [...dpKeys.all, 'governance', 'productRequests', id] as const,
  request: (id: string) => [...dpKeys.all, 'governance', 'request', id] as const,
  settings: (id: string) => [...dpKeys.all, 'governance', 'settings', id] as const,
  reviews: (id: string) => [...dpKeys.all, 'governance', 'reviews', id] as const,
  review: (id: string) => [...dpKeys.all, 'governance', 'review', id] as const,
  promotion: (id: string, from: string, to: string) => [...dpKeys.all, 'governance', 'promotion', id, from, to] as const,
  promotions: (id: string) => [...dpKeys.all, 'governance', 'promotions', id] as const,
  endorsement: (id: string) => [...dpKeys.all, 'governance', 'endorsement', id] as const,
  ropa: (q: string) => [...dpKeys.all, 'governance', 'ropa', q] as const,
};

export function useInvalidateGovernance(): () => void {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: dpKeys.all });
}

export const useActual = (id: string, portId: string, environment: string, enabled = true) =>
  useQuery({
    queryKey: govKeys.actual(id, portId, environment),
    queryFn: () => get<DataActualView>(`/data-products/${enc(id)}/ports/${enc(portId)}/actual?${qs({ environment })}`),
    enabled: enabled && !!environment,
  });

export type RequestScope = 'decide' | 'mine' | 'all';
export const useAccessRequests = (scope: RequestScope, status: string) =>
  useQuery({
    queryKey: govKeys.requests(`${scope}|${status}`),
    queryFn: () => get<{ items: DataAccessRequest[]; total: number }>(`/data-products/access-requests?${qs({ scope, status })}`),
    placeholderData: keepPreviousData,
  });

export const useProductRequests = (id: string) =>
  useQuery({
    queryKey: govKeys.productRequests(id),
    queryFn: () => get<{ items: DataAccessRequest[]; total: number }>(`/data-products/${enc(id)}/access-requests`),
  });

export const useAccessRequest = (id: string | null) =>
  useQuery({
    queryKey: govKeys.request(id ?? ''),
    queryFn: () => get<DataAccessRequest>(`/data-products/access-requests/${enc(id!)}`),
    enabled: !!id,
  });

export const useAccessSettings = (id: string) =>
  useQuery({ queryKey: govKeys.settings(id), queryFn: () => get<DataAccessSettings>(`/data-products/${enc(id)}/access-settings`) });

export const useProductReviews = (id: string) =>
  useQuery({
    queryKey: govKeys.reviews(id),
    queryFn: () => get<{ items: DataPortReviewSummary[]; due: DataPortReviewDue[] }>(`/data-products/${enc(id)}/port-reviews`),
  });

export const useReview = (id: string | null) =>
  useQuery({ queryKey: govKeys.review(id ?? ''), queryFn: () => get<DataPortReview>(`/data-products/port-reviews/${enc(id!)}`), enabled: !!id });

export const usePromotionPreview = (id: string, from: string | null, to: string | null) =>
  useQuery({
    queryKey: govKeys.promotion(id, from ?? '', to ?? ''),
    queryFn: () => get<DataPromotionPreview>(`/data-products/${enc(id)}/promotion?${qs({ from, to })}`),
    enabled: !!from && !!to && from !== to,
    retry: false,
  });

export const usePromotions = (id: string) =>
  useQuery({ queryKey: govKeys.promotions(id), queryFn: () => get<DataPromotion[]>(`/data-products/${enc(id)}/promotions`) });

export const useEndorsement = (id: string) =>
  useQuery({ queryKey: govKeys.endorsement(id), queryFn: () => get<DataEndorsementView>(`/data-products/${enc(id)}/endorsement`) });

export const useRopa = (q: string) =>
  useQuery({
    queryKey: govKeys.ropa(q),
    queryFn: () => get<DataRopa>(`/data-products/records-of-processing?${q}`),
    placeholderData: keepPreviousData,
  });

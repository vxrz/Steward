import { useQuery } from '@tanstack/react-query';
import type { DataPortPreview, DataRopaDetails, DataSemanticModelView, DataSemanticValidAnswer, DataSemanticVersion } from '@sm/shared';
import { get } from '../../../api';
import { dpKeys, qs } from '../api';

/**
 * The reads of phase 3, package D (0.25.0, ADR 0037 parts 4 and 6): semantic models, previews and the Art. 30 details –
 * keys below the module's (`dataProducts`), so a change anywhere in the module reads them again.
 */

const enc = encodeURIComponent;

export const semKeys = {
  model: (id: string) => [...dpKeys.all, 'semantic', 'model', id] as const,
  version: (id: string, n: number) => [...dpKeys.all, 'semantic', 'version', id, n] as const,
  valid: (id: string, date: string) => [...dpKeys.all, 'semantic', 'valid', id, date] as const,
  preview: (id: string, portId: string, environment: string) => [...dpKeys.all, 'semantic', 'preview', id, portId, environment] as const,
  ropa: (kind: 'data-products' | 'data-objects', id: string) => [...dpKeys.all, 'semantic', 'ropa', kind, id] as const,
};

export const useSemanticModel = (id: string) =>
  useQuery({ queryKey: semKeys.model(id), queryFn: () => get<DataSemanticModelView>(`/data-products/${enc(id)}/semantic-model`) });

export const useSemanticVersion = (id: string, n: number | null) =>
  useQuery({
    queryKey: semKeys.version(id, n ?? 0),
    queryFn: () => get<DataSemanticVersion>(`/data-products/${enc(id)}/semantic-model/versions/${n}`),
    enabled: !!n,
  });

export const useSemanticValid = (id: string, date: string) =>
  useQuery({
    queryKey: semKeys.valid(id, date),
    queryFn: () => get<DataSemanticValidAnswer>(`/data-products/${enc(id)}/semantic-model/valid?${qs({ date })}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  });

export const usePortPreview = (id: string, portId: string, environment: string) =>
  useQuery({
    queryKey: semKeys.preview(id, portId, environment),
    queryFn: () => get<DataPortPreview>(`/data-products/${enc(id)}/ports/${enc(portId)}/preview?${qs({ environment })}`),
  });

export const useRopaDetails = (kind: 'data-products' | 'data-objects', id: string) =>
  useQuery({ queryKey: semKeys.ropa(kind, id), queryFn: () => get<DataRopaDetails>(`/${kind}/${enc(id)}/ropa-details`) });

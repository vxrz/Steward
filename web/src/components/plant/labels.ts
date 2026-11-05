import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PlantConfig, PlantRecordType } from '@sm/shared';
import { get } from '../../api';
import { plantKeys } from '../../queryKeys';

/** The module's configuration for every page: own display names, own fields, the enterprise (#218). */
export function usePlantConfig(enabled = true) {
  return useQuery({ queryKey: plantKeys.config, queryFn: () => get<PlantConfig>('/plant/config'), staleTime: 60_000, enabled });
}

/**
 * The display name of a record type: the installation's own name in the UI language (Settings → Modules), else the
 * module's word. `fallback` gives the translated default (the nav entries have their own).
 */
export function useOwnLabel(enabled = true) {
  const cfg = usePlantConfig(enabled);
  const { i18n } = useTranslation();
  return useCallback(
    (type: PlantRecordType, plural: boolean, fallback: string): string => {
      const all = cfg.data?.labels[type];
      const own = all?.[i18n.language] ?? all?.[i18n.language.split('-')[0]!];
      return (plural ? own?.other : own?.one) || fallback;
    },
    [cfg.data, i18n.language],
  );
}

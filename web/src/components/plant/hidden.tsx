import { Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PLANT_HIDDEN, isPlantHidden, type PlantHiddenCatalogue } from '@sm/shared';
import { get } from '../../api';
import { plantKeys } from '../../queryKeys';

/**
 * Device profiles and KPI definitions the reader may not see (0.21.0, #293): the server counts them and replaces their
 * ids by placeholders (`~hidden-1`) and their names by `~hidden`; the pages say "a device profile you may not see".
 */
export { isPlantHidden };

/** A profile's or KPI definition's name as shown: the placeholder in words. */
export function useShownName() {
  const { t } = useTranslation('plant');
  return (name: string, kind: 'profile' | 'kpi' = 'profile') =>
    isPlantHidden(name) ? t(kind === 'kpi' ? 'catalogueAccess.hiddenKpi' : 'catalogueAccess.hiddenProfile') : name;
}

/** Check parameters with the placeholders in words (the profile and KPI names a check names). */
export function useShownParams() {
  const { t } = useTranslation('plant');
  return (params: Record<string, string | number>): Record<string, string | number> =>
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => {
        if (typeof v !== 'string' || !v.includes(PLANT_HIDDEN)) return [k, v];
        const word = t(k === 'kpi' ? 'catalogueAccess.hiddenKpi' : 'catalogueAccess.hiddenProfile');
        return [
          k,
          v
            .split(', ')
            .map((x) => (isPlantHidden(x) ? word : x))
            .join(', '),
        ];
      }),
    );
}

/** How many entries of the catalogues the reader may not see (one request, shared by the pages). */
export function useHiddenCatalogue() {
  return useQuery({ queryKey: plantKeys.hiddenCatalogue, queryFn: () => get<PlantHiddenCatalogue>('/plant/catalogue/hidden') });
}

/** "and 2 device profiles you may not see" below a list – nothing when there are none. */
export function HiddenCount({ kind }: { kind: 'profiles' | 'kpis' }) {
  const { t } = useTranslation('plant');
  const q = useHiddenCatalogue();
  const count = q.data?.[kind] ?? 0;
  if (!count) return null;
  return (
    <Text size="sm" c="dimmed" data-testid={`hidden-${kind}`}>
      {t(kind === 'profiles' ? 'catalogueAccess.profilesHidden' : 'catalogueAccess.kpisHidden', { count })}
    </Text>
  );
}

import { useTranslation } from 'react-i18next';
import type { ModuleUse } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../../../shared/src/brand';

/**
 * The module layer of access (ADR 0034) as one sentence: "Uses Plant registry through team Plant engineering" or
 * "Does not use Costs" – for _Why do I have access?_, person access reviews and the test sign-in.
 */
export function useModuleUseText(): (u: ModuleUse) => string {
  const { t } = useTranslation('modules');
  return (u) => {
    const name = t(`items.${u.module}.name`, { brand: BRAND.name });
    if (!u.uses) return t('access.notUses', { name });
    const through = u.through.map((r) => t(`access.through.${r.source}`, { team: r.team ?? '' })).join(', ');
    return t('access.uses', { name, through });
  };
}

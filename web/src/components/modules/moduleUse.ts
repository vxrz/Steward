import { useTranslation } from 'react-i18next';
import type { ModuleRoleReason, ModuleUse } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../../../shared/src/brand';

/**
 * The module layer of access (ADR 0034) as one sentence: "Uses Plant registry through team Plant engineering" or
 * "Does not use Costs" – for _Why do I have access?_, person access reviews and the test sign-in. A module that declares
 * module roles (0.23.0) adds the person's role and where it comes from: "…; module role manager (through team …)".
 */
export function useModuleUseText(): (u: ModuleUse) => string {
  const { t } = useTranslation(['modules', 'common']);
  const reason = (r: ModuleRoleReason) => t(`access.roleThrough.${r.source}`, { team: r.team ?? '', role: r.coreRole ? t(`common:roles.${r.coreRole}`) : '' });
  return (u) => {
    const name = t(`items.${u.module}.name`, { brand: BRAND.name });
    if (!u.uses) return t('access.notUses', { name });
    const through = u.through.map((r) => t(`access.through.${r.source}`, { team: r.team ?? '' })).join(', ');
    if (!u.role) return t('access.uses', { name, through });
    const best = (u.roleThrough ?? []).filter((r) => r.role === u.role);
    const role = t('access.role', { role: t(`roleNames.${u.role}`), through: best.map(reason).join(', ') });
    return t('access.usesWithRole', { name, through, role });
  };
}

/** The name of a module role in the UI language (Viewer, Contributor, Manager – Leser, Mitwirkender, Verwalter). */
export function useModuleRoleLabel(): (role: string | null | undefined) => string {
  const { t } = useTranslation('modules');
  return (role) => (role === 'viewer' || role === 'contributor' || role === 'manager' ? t(`roleNames.${role}`) : t('access.noRole'));
}

import { useMe } from '../../auth';

/**
 * Who may create products, data objects, elements and steps (ADR 0036 part 12): the module's contributors and managers
 * – designers and administrators until module roles exist (server/src/dataproducts/access.ts canCreate). The server
 * decides; this only hides buttons that would be refused.
 */
export function useCanCreate(): boolean {
  const { isAdmin, hasRole } = useMe();
  return isAdmin || hasRole('designer');
}

/** Domains, discovery sources and the module's settings: its managers (designers until module roles exist). */
export const useCanManageModule = useCanCreate;

import { useQuery } from '@tanstack/react-query';
import type { AreaVisibility, Capabilities, ModuleId, VisibilityArea, VisibilitySummary } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod into the first download.
import { moduleDef, moduleOfNav } from '../../shared/src/modules';
import { useMe } from './auth';
import { get } from './api';

/**
 * The modules (0.11.0, ADR 0016) as the web app sees them: the server says in /auth/status which are on
 * (Capabilities.modules; a module missing there is on – older servers), and the pages, the sidebar and the search
 * leave out what is switched off – and (0.21.0) what the person does not use, the same way.
 */
export const moduleOn = (caps: Capabilities, id: ModuleId): boolean => {
  // the plant registry kept its own flag (it also says whether the person may use it)
  if (id === 'plant') return caps.modules?.plant ?? caps.plant === true;
  return caps.modules?.[id] !== false;
};

/**
 * A module that is on but not used by the person (ADR 0034): hidden like a switched-off one (Capabilities.modules
 * says false), its pages say "You do not use this module" instead of "switched off".
 */
export const moduleNotYours = (caps: Capabilities, id: ModuleId): boolean => caps.moduleAccess?.[id] === 'notYours';

/** Whether a sidebar entry's module (if it has one) is on. */
export const navModuleOn = (caps: Capabilities, key: string): boolean => {
  const id = moduleOfNav(key);
  return !id || moduleOn(caps, id);
};

/**
 * A module-only user's modules (0.23.0, ADR 0034): they use these through module roles and have no other working role –
 * the sidebar, the start page and the pages follow them. Empty for everyone else (older servers: the plant flag).
 */
export const moduleOnlyOf = (caps: Capabilities): ModuleId[] => (caps.moduleOnly?.length ? caps.moduleOnly : caps.plantOnly ? ['plant'] : []);

/** Whether a sidebar entry belongs to one of a module-only user's modules (the Plant area as a whole for the registry). */
export const moduleOnlyNav = (mods: readonly ModuleId[], key: string, group?: string): boolean => {
  const id = moduleOfNav(key);
  return (!!id && mods.includes(id)) || (group === 'plant' && mods.includes('plant'));
};

/** Whether a module-only user reaches a page: the pages of their modules, their profile and About. */
export const moduleOnlyPage = (mods: readonly ModuleId[], pathname: string): boolean =>
  ['/profile', '/about', ...mods.flatMap((m) => moduleDef(m).pages)].some((p) => pathname === p || pathname.startsWith(`${p}/`));

/** A module-only user's start page: the first of their modules (the plant registry's sites first). */
export const moduleOnlyStart = (mods: readonly ModuleId[]): string => (mods.includes('plant') ? '/plant/sites' : (moduleDef(mods[0]!).pages[0] ?? '/profile'));

export function useModuleOn(id: ModuleId): boolean {
  return moduleOn(useMe().caps, id);
}

export const visibilityKey = ['me', 'visibility'] as const;

/** What the signed-in person may see, area by area (GET /api/me/visibility), and whether the answer is there. */
export function useVisibilityQuery(enabled = true): { data: VisibilitySummary | undefined; settled: boolean } {
  const q = useQuery({ queryKey: visibilityKey, queryFn: () => get<VisibilitySummary>('/me/visibility'), staleTime: 30_000, enabled });
  return { data: q.data, settled: !enabled || q.isSuccess || q.isError };
}

/** What the signed-in person may see, area by area: undefined while it loads. */
export function useVisibility(enabled = true): VisibilitySummary | undefined {
  return useVisibilityQuery(enabled).data;
}

/** One area of it (undefined while it loads, without an area, or for areas the server does not decide). */
export function useAreaVisibility(area: VisibilityArea | undefined): AreaVisibility | undefined {
  const v = useVisibility(!!area);
  return area ? v?.areas[area] : undefined;
}

import { useQuery } from '@tanstack/react-query';
import type { AreaVisibility, Capabilities, ModuleId, VisibilityArea, VisibilitySummary } from '@sm/shared';
// Direct import: the @sm/shared barrel would pull zod into the first download.
import { moduleOfNav } from '../../shared/src/modules';
import { useMe } from './auth';
import { get } from './api';

/**
 * The modules (0.11.0, ADR 0016) as the web app sees them: the server says in /auth/status which are on
 * (Capabilities.modules; a module missing there is on – older servers), and the pages, the sidebar and the search
 * leave out what is switched off.
 */
export const moduleOn = (caps: Capabilities, id: ModuleId): boolean => {
  // the plant registry kept its own flag (it also says whether the person may use it)
  if (id === 'plant') return caps.modules?.plant ?? caps.plant === true;
  return caps.modules?.[id] !== false;
};

/** Whether a sidebar entry's module (if it has one) is on. */
export const navModuleOn = (caps: Capabilities, key: string): boolean => {
  const id = moduleOfNav(key);
  return !id || moduleOn(caps, id);
};

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

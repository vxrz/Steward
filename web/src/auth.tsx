import { createContext, useContext } from 'react';
import type { Capabilities, Me, Role } from '@sm/shared';

const NO_CAPS: Capabilities = {
  manageUsers: false,
  manageSettings: false,
  viewAudit: false,
  createProcesses: false,
  createPlatforms: false,
  createMonitors: false,
};

export const MeContext = createContext<Me | null>(null);

/** The signed-in user and what they may do globally. */
export function useMe(): { me: Me | null; caps: Capabilities; hasRole: (r: Role) => boolean; isAdmin: boolean; username: string } {
  const me = useContext(MeContext);
  const roles = me?.user.roles ?? [];
  return {
    me,
    caps: me?.capabilities ?? NO_CAPS,
    hasRole: (r) => roles.includes(r),
    isAdmin: roles.includes('admin'),
    username: me?.user.username ?? '',
  };
}

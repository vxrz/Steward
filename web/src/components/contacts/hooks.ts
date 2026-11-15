import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CONTACT_LIMITS, builtInContactRoles, contactEmailKey, contactRoleLabel, type ContactList, type ContactRole } from '@sm/shared';
import { get } from '../../api';

/** The query key of the role catalogue (invalidated by the settings page). */
export const CONTACT_ROLES_KEY = ['contacts', 'roles'] as const;

/**
 * The role catalogue (0.26.0, ADR 0039): every role with its labels, kinds, cardinality and whether it is on – read
 * once and kept a minute. While it loads (or for a module-only user who cannot read it), the built-in roles.
 */
export function useContactRoles(): { roles: ContactRole[]; loaded: boolean } {
  const q = useQuery({ queryKey: CONTACT_ROLES_KEY, queryFn: () => get<ContactRole[]>('/contact-roles'), staleTime: 60_000 });
  return { roles: q.data ?? FALLBACK, loaded: !!q.data };
}
const FALLBACK = builtInContactRoles();

/** The label of a role in the person's language (the catalogue's; a kept free-text role as it is). */
export function useContactRoleLabel(): (role: string) => string {
  const { i18n } = useTranslation('contacts');
  const { roles } = useContactRoles();
  return (role: string) => contactRoleLabel(roles, role, i18n.language);
}

/** Search the directory (only contacts the person may see; active ones unless `status` says otherwise). */
export function useContactSearch(q: string, opts: { status?: 'active' | 'left' | 'all'; enabled?: boolean; limit?: number } = {}) {
  const [debounced] = useDebouncedValue(q.trim(), 250);
  const qs = new URLSearchParams({ q: debounced, status: opts.status ?? 'active', limit: String(opts.limit ?? CONTACT_LIMITS.search) }).toString();
  return useQuery({
    queryKey: ['contacts', 'search', qs],
    queryFn: () => get<ContactList>(`/contacts?${qs}`),
    enabled: opts.enabled !== false,
    staleTime: 15_000,
  });
}

/** Contacts the person may see with this e-mail address (a hint before making a second entry for the same person). */
export function useEmailMatches(email: string) {
  const key = contactEmailKey(email);
  const valid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(key);
  const found = useContactSearch(key, { enabled: valid, status: 'all' });
  return valid ? (found.data?.items ?? []).filter((c) => contactEmailKey(c.email) === key) : [];
}

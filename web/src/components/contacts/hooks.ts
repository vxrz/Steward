import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CONTACT_LIMITS, contactEmailKey, type ContactList } from '@sm/shared';
import { get } from '../../api';

/** The translated label of a role of a link kind (free text as it is). */
export function useContactRoleLabel(): (role: string) => string {
  const { t } = useTranslation('contacts');
  return (role: string) => t(`roles.${role}` as 'roles.business', { defaultValue: role });
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

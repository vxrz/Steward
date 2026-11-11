import { Alert, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconUserShare } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { OwnedKind } from '@sm/shared';
import { post } from '../api';
import { accessKeys } from '../queryKeys';

/** The item a form names owners or responsibles on (#195): its kind and id (none: a new item), a contract's supplier. */
export interface NamedScope {
  kind: OwnedKind | 'supplierContract';
  id?: string | null;
  supplierId?: string;
}

const lower = (s: string) => s.trim().toLowerCase();

/**
 * Says before saving that a named user or team from outside the item's owning teams will see and change it (#195):
 * saving asks the person to confirm it is them (step-up, like an access list). Only the subjects the form adds count –
 * those already named have their access. Nothing is shown for an item without owning teams.
 */
export function NamedOutsideHint({ scope, value, saved = [] }: { scope: NamedScope; value: readonly string[]; saved?: readonly string[] }) {
  const { t } = useTranslation('access');
  const had = new Set(saved.map(lower));
  const added = [...new Set(value.map(lower))].filter((v) => v && !had.has(v));
  const q = useQuery({
    queryKey: accessKeys.namedOutside(scope.kind, scope.id, scope.supplierId, added),
    queryFn: () =>
      post<{ teams: string[]; outside: string[] }>('/access/named-outside', {
        kind: scope.kind,
        ...(scope.id ? { id: scope.id } : {}),
        ...(scope.supplierId ? { supplierId: scope.supplierId } : {}),
        subjects: added,
      }),
    enabled: added.length > 0,
    retry: false,
    staleTime: 30_000,
  });
  const outside = added.length ? (q.data?.outside ?? []) : [];
  if (!outside.length) return null;
  return (
    <Alert color="yellow" variant="light" p="xs" icon={<IconUserShare size={16} />} data-testid="named-outside-hint">
      <Text size="sm">{t('namedOutside.hint', { count: outside.length, names: outside.join(', '), teams: (q.data?.teams ?? []).join(', ') })}</Text>
    </Alert>
  );
}

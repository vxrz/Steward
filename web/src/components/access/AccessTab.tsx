import { useCallback, useRef } from 'react';
import { Box } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { OwnedKind, ResourceAccessView } from '@sm/shared';
import { get } from '../../api';
import { useMe } from '../../auth';
import { OwningTeams, owningTeamsKey, type OwningTeamsResponse } from '../OwningTeams';
import { SharesPanel, accessKey } from './SharesPanel';

/**
 * The Access tab of an item (ADR 0033 part 7): its owning teams with _Why do I have access?_, and its shares – one
 * tab for every kind that is switched to shares.
 */
export function AccessTab({ kind, id, mt }: { kind: OwnedKind; id: string; mt?: 'md' }) {
  // the same query as the panel's (one request): a Restricted item without teams says so above as well
  const q = useQuery({ queryKey: accessKey(kind, id), queryFn: () => get<ResourceAccessView>(`/access/${kind}/${id}/shares`) });
  // the same query as the owning teams panel's (one request): administrators – only they set owning teams – get the way
  // there from the scope line (the field is there when they may change them)
  const { isAdmin } = useMe();
  const teams = useQuery({ queryKey: owningTeamsKey(kind, id), queryFn: () => get<OwningTeamsResponse>(`/owning-teams/${kind}/${id}`) });
  const field = useRef<HTMLInputElement>(null);
  const toTeams = useCallback(() => {
    field.current?.scrollIntoView({ block: 'center' });
    field.current?.focus();
  }, []);
  return (
    <Box data-testid="access-tab" mt={mt}>
      <OwningTeams kind={kind} id={id} restricted={!!q.data?.restricted} fieldRef={field} />
      <SharesPanel kind={kind} id={id} onOwningTeams={isAdmin && teams.data?.canChange ? toTeams : undefined} />
    </Box>
  );
}

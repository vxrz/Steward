import { Anchor, Badge, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconBrandGit } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { SyncKind, SyncOrigin } from '@sm/shared';
import { getOptional } from '../../api';

/** Origins of synced items of one kind (cached; one request per kind and page). */
export function useSyncOrigins(kind: SyncKind) {
  return useQuery({
    queryKey: ['sync-origins', kind],
    queryFn: () => getOptional<SyncOrigin[]>(`/sync-origins?kind=${kind}`, []),
    staleTime: 60_000,
  });
}

export function useSyncOrigin(kind: SyncKind, id: string | undefined): SyncOrigin | undefined {
  const q = useSyncOrigins(kind);
  return id ? q.data?.find((o) => o.entityId === id) : undefined;
}

/** "From Git" badge of an item that came from a Git sync source; links to the file at that commit. */
export function GitOriginBadge({ kind, id, size = 'sm' }: { kind: SyncKind; id: string | undefined; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('gitSync');
  const o = useSyncOrigin(kind, id);
  if (!o) return null;
  const vars = { source: o.sourceName, path: o.path, sha: o.commit.slice(0, 10) };
  return (
    <Tooltip label={t('origin.tooltip', vars)} withArrow>
      <Anchor href={o.webUrl} target="_blank" rel="noopener noreferrer" aria-label={t('origin.label', vars)} data-testid="git-origin" underline="never">
        <Badge size={size} variant="light" color="grape" leftSection={<IconBrandGit size={12} aria-hidden />} style={{ cursor: 'pointer' }}>
          {t('origin.badge')}
        </Badge>
      </Anchor>
    </Tooltip>
  );
}

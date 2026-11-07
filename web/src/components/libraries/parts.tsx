import { Anchor, Badge, Group, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconBooks, IconHandStop, IconShieldX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { LibraryItemKind, LibraryItemOrigin, LibraryKeyState, LibraryReleaseState } from '@sm/shared';
import { getOptional } from '../../api';
import { TONE } from '../common';
import { libraryKeys } from '../../queryKeys';

/** Items of one kind installed from libraries (cached; one request per kind and page). */
export function useLibraryOrigins(kind: LibraryItemKind) {
  return useQuery({
    queryKey: libraryKeys.origins(kind),
    queryFn: () => getOptional<LibraryItemOrigin[]>(`/library-origins?kind=${kind}`, []),
    staleTime: 60_000,
  });
}

export function useLibraryOrigin(kind: LibraryItemKind, id: string | undefined): LibraryItemOrigin | undefined {
  const q = useLibraryOrigins(kind);
  return id ? q.data?.find((o) => o.entityId === id) : undefined;
}

/**
 * "From library" badge of an item installed from a library (ADR 0014): names the release and links to it; marks a
 * release signed by a revoked key and a library on hold.
 */
export function LibraryOriginBadge({ kind, id, size = 'sm' }: { kind: LibraryItemKind; id: string | undefined; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('libraries');
  const o = useLibraryOrigin(kind, id);
  if (!o) return null;
  const vars = { library: o.libraryName, release: o.release };
  return (
    <Group gap={4} wrap="nowrap" component="span">
      <Tooltip label={o.changedLocally ? t('origin.tooltipChanged', vars) : t('origin.tooltip', vars)} withArrow>
        <Anchor
          component={Link}
          to={`/libraries/${encodeURIComponent(o.library)}`}
          aria-label={t('origin.label', vars)}
          data-testid="library-origin"
          underline="never"
        >
          <Badge size={size} variant="light" color="teal" leftSection={<IconBooks size={12} aria-hidden />} style={{ cursor: 'pointer' }}>
            {t('origin.badge')}
          </Badge>
        </Anchor>
      </Tooltip>
      {o.revoked && (
        <Badge size={size} variant="light" color={TONE.bad} leftSection={<IconShieldX size={12} aria-hidden />}>
          {t('state.revokedKey')}
        </Badge>
      )}
      {o.held && (
        <Badge size={size} variant="light" color={TONE.attention} leftSection={<IconHandStop size={12} aria-hidden />}>
          {t('state.held')}
        </Badge>
      )}
    </Group>
  );
}

const RELEASE_COLOR: Record<LibraryReleaseState, string> = {
  staged: TONE.person,
  installed: TONE.ok,
  previous: TONE.neutral,
  superseded: TONE.neutral,
  older: TONE.neutral,
};

export function ReleaseStateBadge({ state, size = 'sm' }: { state: LibraryReleaseState; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('libraries');
  return (
    <Badge size={size} variant="light" color={RELEASE_COLOR[state]}>
      {t(`releaseState.${state}`)}
    </Badge>
  );
}

const KEY_COLOR: Record<LibraryKeyState | 'unknown', string> = { active: TONE.ok, retired: TONE.neutral, revoked: TONE.bad, unknown: TONE.attention };

export function KeyStateBadge({ state, size = 'sm' }: { state: LibraryKeyState | 'unknown'; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('libraries');
  return (
    <Badge size={size} variant="light" color={KEY_COLOR[state]}>
      {t(`keyState.${state}`)}
    </Badge>
  );
}

/** A key fingerprint (SHA256:…) as ssh-keygen -l prints it: monospace, wraps anywhere on phones. */
export function Fingerprint({ value, size = 'sm' }: { value: string; size?: 'xs' | 'sm' }) {
  return (
    <Text size={size} className="mono" style={{ overflowWrap: 'anywhere' }} component="span">
      {value}
    </Text>
  );
}

import { useEffect } from 'react';
import { Anchor, Badge, Button, Group, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconEdit, IconGitPullRequest, IconPencil } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantChangeSetSource, PlantChangeSetState, PlantEntryKind, PlantOpenChanges } from '@sm/shared';
import { PLANT_DRAFT_EVENT, get, inDraft } from '../../../api';
import { plantKeys } from '../../../queryKeys';
import { usePlantConfig } from '../labels';

/** Plant change sets (0.13.0, docs/PLANT.md "Change sets"): what several pages share. */

export const STATE_COLOR: Record<PlantChangeSetState, string> = {
  draft: 'gray',
  proposed: 'blue',
  applied: 'green',
  rejected: 'red',
  withdrawn: 'gray',
  expired: 'orange',
};

export function StateBadge({ state, size = 'sm' }: { state: PlantChangeSetState; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('plantChanges');
  return (
    <Badge size={size} variant="light" color={STATE_COLOR[state]} data-testid="change-set-state">
      {t(`states.${state}`)}
    </Badge>
  );
}

export function SourceBadge({ source }: { source: PlantChangeSetSource }) {
  const { t } = useTranslation('plantChanges');
  return (
    <Badge size="sm" variant="default">
      {t(`sources.${source}`)}
    </Badge>
  );
}

export function useKindName(): (k: PlantEntryKind | string | null) => string {
  const { t } = useTranslation('plantChanges');
  return (k) => (k ? t(`kinds.${k as PlantEntryKind}`, { defaultValue: k }) : t('kinds.document'));
}

/** The change sets' part of the plant configuration: the policy, whether the person may propose, their draft. */
export function useChangeSetConfig() {
  const cfg = usePlantConfig();
  return cfg.data?.changeSets ?? null;
}

/** Whether changes to this site need a second person (plant.changeSet and the site's switch). */
export function useReviewRequired(siteReview: boolean | undefined): boolean {
  const c = useChangeSetConfig();
  return c?.level === 'required' || (c?.level === 'optional' && !!siteReview);
}

/**
 * Refreshes what shows drafts and open changes when a save went into a draft (api.ts sends the event on a 202), and
 * after any change set action.
 */
export function useDraftRefresh(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const on = () => {
      void qc.invalidateQueries({ queryKey: plantKeys.config });
      void qc.invalidateQueries({ queryKey: ['plant', 'open-changes'] });
      void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
    };
    window.addEventListener(PLANT_DRAFT_EVENT, on);
    return () => window.removeEventListener(PLANT_DRAFT_EVENT, on);
  }, [qc]);
}

/**
 * How an edit form saves: as before for who manages the entry; into the person's draft for who may only propose it
 * (the route answers 202 with the draft – the form gets the entry as it would be with the change).
 */
export function draftSave<T>(canManage: boolean, send: () => Promise<T>): Promise<T> {
  return canManage ? send() : inDraft(send);
}

/** Edit for who may only propose: what they save goes into their draft. */
export function ProposeEditButton({ onClick, testId }: { onClick: () => void; testId: string }) {
  const { t } = useTranslation('plantChanges');
  return (
    <Tooltip label={t('form.draftHint')} multiline w={280} withArrow>
      <Button size="xs" variant="default" leftSection={<IconEdit size={14} aria-hidden />} onClick={onClick} data-testid={testId}>
        {t('form.proposeEdit')}
      </Button>
    </Tooltip>
  );
}

/** "2 open changes" (and "Changed in your draft") of a site or an entry, with a link to them in Plant → Changes. */
export function OpenChangesChip({ query }: { query: { site?: string; kind?: PlantEntryKind; id?: string } }) {
  const { t } = useTranslation('plantChanges');
  const key = query.site ? `site:${query.site}` : `${query.kind}:${query.id}`;
  const qs = query.site ? `site=${encodeURIComponent(query.site)}` : `kind=${query.kind}&id=${encodeURIComponent(query.id ?? '')}`;
  const open = useQuery({ queryKey: plantKeys.openChanges(key), queryFn: () => get<PlantOpenChanges>(`/plant/change-sets/open?${qs}`), staleTime: 30_000 });
  if (!open.data?.count) return null;
  const first = open.data.items[0];
  const to =
    open.data.count === 1 && first
      ? `/plant/changes/${encodeURIComponent(first.id)}`
      : `/plant/changes?box=review${query.site ? `&site=${encodeURIComponent(query.site)}` : ''}`;
  return (
    <Group gap={4} wrap="nowrap" data-testid="open-changes-chip">
      <Tooltip label={open.data.items.map((i) => i.title).join(' · ')} withArrow>
        <Anchor component={Link} to={to} underline="never">
          <Badge size="md" variant="light" color="blue" leftSection={<IconGitPullRequest size={12} aria-hidden />} style={{ cursor: 'pointer' }}>
            {t('chip.open', { count: open.data.count })}
          </Badge>
        </Anchor>
      </Tooltip>
      {open.data.mine > 0 && (
        <Badge size="md" variant="light" color="grape" leftSection={<IconPencil size={12} aria-hidden />} data-testid="changed-in-draft">
          {t('chip.mine')}
        </Badge>
      )}
    </Group>
  );
}

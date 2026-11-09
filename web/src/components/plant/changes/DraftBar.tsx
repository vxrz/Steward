import { useState } from 'react';
import { ActionIcon, Badge, Button, Group, Menu, Paper, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { IconChevronDown, IconChevronUp, IconGitPullRequest, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantChangeSetDetail, PlantChangeSetList } from '@sm/shared';
import { get, notifyError, patch, post } from '../../../api';
import { plantKeys } from '../../../queryKeys';
import { useChangeSetConfig, useDraftRefresh } from './common';

export const DRAFT_BAR_ID = 'plant-draft-bar';

/** "Skip to your draft": the draft bar is reached from the start of the page (WCAG 2.4.1), visible only with focus. */
export function DraftSkipLink() {
  const { t } = useTranslation('plantChanges');
  const cfg = useChangeSetConfig();
  if (!cfg?.draft) return null;
  return (
    <a
      href={`#${DRAFT_BAR_ID}`}
      className="skip-link"
      onClick={(e) => {
        e.preventDefault();
        const bar = document.getElementById(DRAFT_BAR_ID);
        bar?.focus();
        bar?.scrollIntoView({ block: 'end' });
      }}
    >
      {t('bar.skip')}
    </a>
  );
}

/**
 * The draft bar of the plant pages (0.13.0, ADR 0020 §5): the person's current draft – its name, how many changes,
 * _Review and propose_ – and switching to another draft or starting one. Shown while the person has a draft, or may
 * propose where changes need a second person. A labelled region; on a phone it folds to its count.
 */
export function DraftBar() {
  const { t } = useTranslation('plantChanges');
  const cfg = useChangeSetConfig();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [folded, setFolded] = useState(true);
  useDraftRefresh();
  const draft = cfg?.draft ?? null;
  const show = !!draft || (!!cfg?.canPropose && cfg.level !== 'off');
  const drafts = useQuery({
    queryKey: plantKeys.changeSets('drafts'),
    queryFn: () => get<PlantChangeSetList>('/plant/change-sets?box=drafts'),
    enabled: show,
    staleTime: 30_000,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: plantKeys.config });
    void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
  };
  const switchTo = useMutation({
    mutationFn: (id: string) => patch<PlantChangeSetDetail>(`/plant/change-sets/${encodeURIComponent(id)}`, { current: true }),
    onSuccess: refresh,
    onError: (e) => notifyError(e),
  });
  const start = useMutation({
    mutationFn: () => post<PlantChangeSetDetail>('/plant/change-sets', { title: t('bar.newTitle'), current: true }),
    onSuccess: (d) => {
      refresh();
      navigate(`/plant/changes/${encodeURIComponent(d.id)}`);
    },
    onError: (e) => notifyError(e),
  });
  if (!show) return null;
  const others = (drafts.data?.items ?? []).filter((d) => d.id !== draft?.id);
  const compact = narrow && folded;
  return (
    <Paper
      component="section"
      id={DRAFT_BAR_ID}
      tabIndex={-1}
      aria-label={t('bar.label')}
      withBorder
      shadow="sm"
      p="xs"
      mt="md"
      data-testid="draft-bar"
      style={{ position: 'sticky', bottom: 8, zIndex: 50, outline: 'none' }}
    >
      <Group justify="space-between" gap="xs" wrap={compact ? 'nowrap' : 'wrap'}>
        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconGitPullRequest size={18} aria-hidden />
          {draft ? (
            <>
              <Text size="sm" fw={600} truncate>
                {compact ? t('bar.short') : t('bar.draft', { title: draft.title })}
              </Text>
              <Badge size="sm" variant="light" data-testid="draft-bar-count">
                {t('bar.count', { count: draft.operationCount })}
              </Badge>
            </>
          ) : (
            <Text size="sm">{t('bar.none')}</Text>
          )}
        </Group>
        {narrow && (
          <ActionIcon variant="subtle" onClick={() => setFolded(!folded)} aria-expanded={!folded} aria-label={folded ? t('bar.unfold') : t('bar.fold')}>
            {folded ? <IconChevronUp size={16} aria-hidden /> : <IconChevronDown size={16} aria-hidden />}
          </ActionIcon>
        )}
        {!compact && (
          <Group gap="xs" wrap="wrap">
            {draft && (
              <Button size="xs" component={Link} to={`/plant/changes/${encodeURIComponent(draft.id)}`} data-testid="draft-bar-review">
                {t('bar.review')}
              </Button>
            )}
            <Menu position="top-end" withinPortal>
              <Menu.Target>
                <Button size="xs" variant="default" rightSection={<IconChevronDown size={14} aria-hidden />}>
                  {t('bar.switch')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                {others.map((d) => (
                  <Menu.Item key={d.id} onClick={() => switchTo.mutate(d.id)}>
                    {d.title} ({t('bar.count', { count: d.operationCount })})
                  </Menu.Item>
                ))}
                {others.length > 0 && <Menu.Divider />}
                <Menu.Item leftSection={<IconPlus size={14} aria-hidden />} onClick={() => start.mutate()}>
                  {t('bar.start')}
                </Menu.Item>
                <Menu.Item component={Link} to="/plant/changes?box=drafts">
                  {t('bar.all')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        )}
      </Group>
    </Paper>
  );
}

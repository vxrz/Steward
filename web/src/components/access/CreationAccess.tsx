import { useMemo, useState } from 'react';
import { Anchor, Collapse, MultiSelect, Stack, Switch, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CreationAccess, NewResourceTeams, Team } from '@sm/shared';
import { get } from '../../api';
import { useMe } from '../../auth';
import { subjectOptionLabel, useSubjects } from '../SubjectsInput';

/**
 * Access at creation (ADR 0040 part 1): the owning teams, Restricted and shares a new process, monitor or dashboard
 * starts with, pre-filled from the creator's team defaults. `body()` is the `access` object of the create request – or
 * undefined while nothing differs from the defaults, so the server applies its own (`newResourceTeams`).
 */
export function useCreationAccess(opened: boolean) {
  const { isAdmin } = useMe();
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams'), enabled: opened && isAdmin });
  const mine = useQuery({ queryKey: ['new-resource-teams'], queryFn: () => get<NewResourceTeams>('/me/new-resource-teams'), enabled: opened });
  const [picked, setPicked] = useState<string[] | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [shares, setShares] = useState<string[]>([]);
  const defaults = useMemo(() => (mine.data?.teams ?? []).map((x) => x.id), [mine.data]);
  const teamIds = picked ?? defaults;
  const options = isAdmin
    ? (teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))
    : (mine.data?.choices ?? []).map((x) => ({ value: x.id, label: x.name }));
  const sameTeams = teamIds.length === defaults.length && teamIds.every((x) => defaults.includes(x));
  return {
    teamIds,
    setTeamIds: setPicked,
    restricted,
    setRestricted,
    shares,
    setShares,
    options,
    /** The `access` of the create request: only what differs from the defaults (undefined: the defaults apply) */
    body: (): CreationAccess | undefined =>
      sameTeams && !restricted && !shares.length
        ? undefined
        : {
            ...(sameTeams ? {} : { owningTeams: teamIds }),
            ...(restricted ? { restricted: true } : {}),
            ...(shares.length ? { shares: shares.map((subject) => ({ subject, level: 'view' as const, actions: [], expiresAt: null })) } : {}),
          },
    reset: () => {
      setPicked(null);
      setRestricted(false);
      setShares([]);
    },
  };
}

export type CreationAccessState = ReturnType<typeof useCreationAccess>;

/** The compact _Access_ section of a New dialog: collapsed, with the choices in one line. */
export function CreationAccessFields({ state }: { state: CreationAccessState }) {
  const { t } = useTranslation(['access', 'common']);
  const [open, setOpen] = useState(false);
  const subjects = useSubjects();
  const names = new Map(state.options.map((o) => [o.value, o.label]));
  const summary = [
    state.teamIds.length ? t('create.summaryTeams', { teams: state.teamIds.map((x) => names.get(x) ?? x).join(', ') }) : t('create.summaryInstance'),
    ...(state.restricted ? [t('create.summaryRestricted')] : []),
    ...(state.shares.length ? [t('create.summaryShares', { count: state.shares.length })] : []),
  ].join(' · ');
  const list = (subjects.data ?? []).filter((s) => (state.restricted || s.kind !== 'role') && s.value !== 'role:admin' && s.value !== 'role:status');
  return (
    <div>
      <Anchor component="button" type="button" size="sm" fw={500} onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="creation-access-toggle">
        {open ? t('create.hide') : t('create.show')}
      </Anchor>
      <Text size="xs" c="dimmed">
        {summary}
      </Text>
      <Collapse expanded={open}>
        <Stack mt="xs" gap="sm">
          <MultiSelect
            label={t('create.teams')}
            description={t('create.teamsHint')}
            placeholder={state.teamIds.length ? undefined : t('create.wholeInstance')}
            data={state.options}
            value={state.teamIds}
            onChange={state.setTeamIds}
            searchable
            clearable
          />
          <Switch
            label={t('create.restricted')}
            description={t('create.restrictedHint')}
            checked={state.restricted}
            onChange={(e) => state.setRestricted(e.currentTarget.checked)}
          />
          {subjects.isSuccess && list.length > 0 && (
            <MultiSelect
              label={t('create.shares')}
              description={t('create.sharesHint')}
              data={list.map((s) => ({ value: s.value, label: subjectOptionLabel(s) }))}
              value={state.shares}
              onChange={state.setShares}
              searchable
              clearable
              nothingFoundMessage={t('common:subjects.nothingFound')}
            />
          )}
        </Stack>
      </Collapse>
    </div>
  );
}

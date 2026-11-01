import { Badge, Card, Group, Select, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { NewResourceTeams } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../api';

const DEFAULT = '__default';

/**
 * Profile → Owning team of new resources (#136): which teams the resources one creates get now, where that comes from
 * (one's own choice, the teams' defaults or none), and the choice of one team. Shown only to members of a team.
 */
export function NewResourceTeamsCard() {
  const { t } = useTranslation('profile');
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['new-resource-teams'], queryFn: () => get<NewResourceTeams>('/me/new-resource-teams') });
  const s = q.data;
  if (!s || !s.choices.length) return null;
  const choose = async (v: string | null) => {
    try {
      const next = await put<NewResourceTeams>('/me/new-resource-teams', { teamId: !v || v === DEFAULT ? null : v });
      qc.setQueryData(['new-resource-teams'], next);
      notifyOk(t('newResources.saved'));
    } catch (e) {
      notifyError(e);
    }
  };
  const names = s.teams.map((x) => x.name).join(', ');
  return (
    <Card withBorder>
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="xs">
        <Title order={5}>{t('newResources.title')}</Title>
        <Badge variant="light" color={s.source.from === 'own' ? 'blue' : 'gray'} data-testid="new-resources-source">
          {t(`newResources.source.${s.source.from}`)}
        </Badge>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('newResources.intro')}
      </Text>
      <Select
        label={t('newResources.choose')}
        maw={360}
        data={[{ value: DEFAULT, label: t('newResources.default') }, ...s.choices.map((c) => ({ value: c.id, label: c.name }))]}
        value={s.chosen ?? DEFAULT}
        onChange={choose}
        allowDeselect={false}
      />
      <Text size="xs" c="dimmed" mt="xs" data-testid="new-resources-now">
        {s.teams.length ? t('newResources.now', { teams: names, count: s.teams.length }) : t('newResources.nowNone')}
      </Text>
    </Card>
  );
}

import { Button, Card, Group, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconChevronRight, IconBrandGit } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { SyncSource } from '@sm/shared';
import { getOptional } from '../../api';

/** Settings → Git sync: a short summary and the way to the sources page. */
export function GitSyncSettingsCard() {
  const { t } = useTranslation('gitSync');
  const sources = useQuery({ queryKey: ['sync-sources'], queryFn: () => getOptional<SyncSource[]>('/sync-sources', []) });
  // the example library is always there, disabled: name the sources that fetch
  const on = (sources.data ?? []).filter((s) => s.enabled);
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconBrandGit size={18} aria-hidden />
        <Title order={5}>{t('sources.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('sources.settingsCard')}
      </Text>
      <Group gap="xs">
        <Button component={Link} to="/settings/git-sync" variant="default" size="xs" w="fit-content" rightSection={<IconChevronRight size={14} aria-hidden />}>
          {t('sources.manageLink')}
        </Button>
        {sources.data && (
          <Text size="xs" c="dimmed">
            {on.length ? t('sources.enabledList', { names: on.map((s) => s.name).join(', ') }) : t('sources.noneEnabled')}
          </Text>
        )}
      </Group>
    </Card>
  );
}

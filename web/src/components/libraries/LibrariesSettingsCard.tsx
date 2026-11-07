import { Button, Card, Group, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconBooks, IconChevronRight } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/** Settings → Integrations → Libraries: the way to the trusted publishers and to the libraries. */
export function LibrariesSettingsCard() {
  const { t } = useTranslation('libraries');
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconBooks size={18} aria-hidden />
        <Title order={5}>{t('settingsCard.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('settingsCard.text')}
      </Text>
      <Group gap="xs">
        <Button component={Link} to="/settings/libraries" variant="default" size="xs" rightSection={<IconChevronRight size={14} aria-hidden />}>
          {t('settingsCard.publishers')}
        </Button>
        <Button component={Link} to="/libraries" variant="subtle" size="xs">
          {t('settingsCard.libraries')}
        </Button>
      </Group>
    </Card>
  );
}

import { Button, Card, Group, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconTruckDelivery } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/** Settings → Migration: moving this instance to another one, or bringing one in. */
export function MigrationSettingsCard() {
  const { t } = useTranslation('settings');
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconTruckDelivery size={18} aria-hidden />
        <Title order={5}>{t('migration.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('migration.card')}
      </Text>
      <Button component={Link} to="/settings/migration" variant="light" size="xs">
        {t('migration.open')}
      </Button>
    </Card>
  );
}

import { Button, Card, Group, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconCloudUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/** Settings → Backups (#117): encrypted backups to S3. */
export function BackupSettingsCard() {
  const { t } = useTranslation('settings');
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconCloudUpload size={18} aria-hidden />
        <Title order={5}>{t('backups.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('backups.card')}
      </Text>
      <Button component={Link} to="/settings/backups" variant="light" size="xs">
        {t('backups.open')}
      </Button>
    </Card>
  );
}

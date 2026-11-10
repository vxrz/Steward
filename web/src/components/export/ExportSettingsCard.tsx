import { Button, Card, Group, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconChevronRight, IconFileExport } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/** Settings → Exports (0.16.0, docs/EXPORTS.md): scheduled exports of readable files to S3. */
export function ExportSettingsCard() {
  const { t } = useTranslation('settings');
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconFileExport size={18} aria-hidden />
        <Title order={5}>{t('exports.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('exports.card')}
      </Text>
      <Button component={Link} to="/settings/exports" variant="default" size="xs" w="fit-content" rightSection={<IconChevronRight size={14} aria-hidden />}>
        {t('exports.open')}
      </Button>
    </Card>
  );
}

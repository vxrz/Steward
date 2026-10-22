import { Button } from '@mantine/core';
import { IconActivityHeartbeat } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

/** "System status" button for the settings page header (administrators and auditors). */
export function SystemStatusLink() {
  const { t } = useTranslation('nav');
  return (
    <Button component={Link} to="/settings/status" variant="default" leftSection={<IconActivityHeartbeat size={16} />}>
      {t('userMenu.systemStatus')}
    </Button>
  );
}

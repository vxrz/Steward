import { Alert, Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { fmtTime } from '../../format';

/** Shown on every page of a session opened with emergency access (steward admin emergency-access). */
export function EmergencyBanner({ expiresAt, onSignOut }: { expiresAt: string; onSignOut: () => void }) {
  const { t } = useTranslation('auth');
  return (
    <Alert color="orange" variant="filled" mb="md" icon={<IconAlertTriangle size={20} />} role="alert" data-testid="emergency-banner">
      <Group justify="space-between" gap="sm" wrap="wrap">
        <Text size="sm" style={{ flex: '1 1 260px' }}>
          {t('emergency.banner', { time: fmtTime(expiresAt) })}
        </Text>
        <Button size="xs" variant="white" color="orange" onClick={onSignOut}>
          {t('emergency.signOut')}
        </Button>
      </Group>
    </Alert>
  );
}

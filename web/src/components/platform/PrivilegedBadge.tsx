import { Badge } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/** The badge of a privileged platform identity (0.14.0, ADR 0009 step 4) – wherever identities are named. */
export function PrivilegedBadge({ size = 'sm' }: { size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('platforms');
  return (
    <Badge variant="light" color="orange" size={size} leftSection={<IconShieldLock size={12} aria-hidden />} data-testid="identity-privileged">
      {t('identities.privileged')}
    </Badge>
  );
}

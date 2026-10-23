import { useState } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Platform } from '@sm/shared';
import { notifyError, notifyOk, post } from '../../api';
import { confirmDialog } from '../confirm';

/**
 * Shown when the platform's connection settings fail their integrity check (changed directly in the
 * database). No requests go to the platform until an administrator reviews the settings and confirms them.
 */
export function PlatformIntegrityAlert({ platform, canConfirm }: { platform: Platform; canConfirm: boolean }) {
  const { t } = useTranslation('platforms');
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (platform.integrity !== 'mismatch' && platform.integrity !== 'unsealed') return null;
  const confirm = async () => {
    if (!(await confirmDialog({ action: 'confirm', message: t('integrity.confirmQuestion', { url: platform.baseUrl }), danger: false }))) return;
    setBusy(true);
    try {
      await post(`/platforms/${platform.id}/confirm-config`);
      notifyOk(t('integrity.confirmed'));
      void qc.invalidateQueries();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert color="red" icon={<IconAlertTriangle size={18} />} title={t('integrity.title')} mb="md">
      <Text size="sm">{t('integrity.text', { url: platform.baseUrl })}</Text>
      <Group mt="xs">
        {canConfirm ? (
          <Button size="xs" color="red" variant="light" loading={busy} onClick={confirm}>
            {t('integrity.confirm')}
          </Button>
        ) : (
          <Text size="xs">{t('integrity.askAdmin')}</Text>
        )}
      </Group>
    </Alert>
  );
}

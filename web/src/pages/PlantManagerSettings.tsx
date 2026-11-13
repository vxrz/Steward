import { Stack } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '../components/common';
import { PlantSettingsCard } from '../components/plant/PlantSettingsCard';

/**
 * The plant registry's settings for its managers (0.23.0, ADR 0034 decision 11): the enterprise's name, own display
 * names and own fields, review intervals – for whoever an administrator granted the manager role. The switch, who uses
 * the module and the map stay in Settings → Modules, for administrators.
 */
export function PlantManagerSettingsPage() {
  const { t } = useTranslation('plant');
  return (
    <Stack>
      <PageHeader title={t('settings.managerTitle')} />
      <PlantSettingsCard manager />
    </Stack>
  );
}

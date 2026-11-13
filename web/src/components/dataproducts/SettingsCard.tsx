import { Anchor, Badge, Card, Group, Stack, Text, Title } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconPackages } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DATA_DISCOVERY_LIMITS, DEFAULT_DATA_LAYERS, DEFAULT_REGULATORY_FLAGS } from '@sm/shared';

/**
 * Settings → Catalogue → Data products (ADR 0036 parts 2, 4 and 9): the layers elements are drawn in, the regulatory
 * flags data objects carry and the defaults of the module. 0.22.0 ships them as built-in lists (the pictures draw the
 * layers in this order, a layer or flag typed on an element or a data object is kept as it is); environments come from
 * Settings → Environments, production first.
 */
export function DataProductsSettingsCard() {
  const { t } = useTranslation('dataProducts');
  const list = (xs: readonly string[]) => (
    <Group gap={4}>
      {xs.map((x) => (
        <Badge key={x} variant="light" color="gray" tt="none">
          {x}
        </Badge>
      ))}
    </Group>
  );
  return (
    <Card withBorder id="data-products" data-testid="data-products-settings">
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconPackages size={18} aria-hidden />
        <Title order={2} size="h5">
          {t('settings.title')}
        </Title>
      </Group>
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          {t('settings.help')}
        </Text>
        <div>
          <Text size="sm" fw={500}>
            {t('settings.layers')}
          </Text>
          <Text size="xs" c="dimmed" mb={4}>
            {t('settings.layersHint')}
          </Text>
          {list(DEFAULT_DATA_LAYERS)}
        </div>
        <div>
          <Text size="sm" fw={500}>
            {t('settings.flags')}
          </Text>
          <Text size="xs" c="dimmed" mb={4}>
            {t('settings.flagsHint')}
          </Text>
          {list(DEFAULT_REGULATORY_FLAGS)}
        </div>
        <div>
          <Text size="sm" fw={500}>
            {t('settings.defaults')}
          </Text>
          <Text size="sm">{t('settings.defaultsText', { interval: DATA_DISCOVERY_LIMITS.intervalMinutes.default / 60 })}</Text>
        </div>
        <Group gap="md">
          <Anchor component={Link} to="/settings/catalogue" size="sm">
            {t('settings.environments')}
          </Anchor>
          <Anchor component={Link} to="/data-domains" size="sm">
            {t('settings.domains')}
          </Anchor>
          <Anchor component={Link} to="/data-products/discovery" size="sm">
            {t('settings.discovery')}
          </Anchor>
        </Group>
      </Stack>
    </Card>
  );
}

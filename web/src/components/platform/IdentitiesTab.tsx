import type { ReactNode } from 'react';
import { Alert, Anchor, Badge, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconId } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { Platform, PlatformIdentity } from '@sm/shared';

/**
 * The identities of a platform (0.9.0, ADR 0009). Step 1: every platform has one default identity, shown read-only –
 * its credentials are changed on the Credentials tab, its MCP mode on the MCP tab.
 */
export function IdentitiesTab({ platform, onOpenTab }: { platform: Platform; onOpenTab: (tab: 'credentials' | 'mcp') => void }) {
  const { t } = useTranslation(['platforms', 'common']);
  const identities = platform.identities ?? [];
  return (
    <Stack>
      <Alert color="blue" variant="light" icon={<IconId size={18} />}>
        {t('identities.info')}
      </Alert>
      {identities.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('identities.none')}
        </Text>
      ) : (
        identities.map((i) => <IdentityCard key={i.id} platform={platform} identity={i} onOpenTab={onOpenTab} />)
      )}
    </Stack>
  );
}

function IdentityCard({
  platform,
  identity: i,
  onOpenTab,
}: {
  platform: Platform;
  identity: PlatformIdentity;
  onOpenTab: (tab: 'credentials' | 'mcp') => void;
}) {
  const { t } = useTranslation(['platforms', 'common']);
  const mcp =
    i.mcp.mode === 'writes'
      ? t('identities.mcp.writes', { mode: t(`identities.mcp.writeModes.${i.mcp.writes ?? 'confirm'}`) })
      : t(`identities.mcp.${i.mcp.mode}`);
  const changed = i.integrity === 'mismatch' || i.integrity === 'unsealed';
  return (
    <Paper withBorder p="md" data-testid="identity-card">
      <Group justify="space-between" align="flex-start" mb="sm" gap="xs">
        <Group gap="xs" wrap="wrap">
          <Title order={5}>{i.name}</Title>
          {i.default && (
            <Badge variant="light" size="sm">
              {t('identities.default')}
            </Badge>
          )}
          {i.readOnly && (
            <Badge variant="light" color="teal" size="sm">
              {t('identities.readOnly')}
            </Badge>
          )}
          {i.privileged && (
            <Badge variant="light" color="orange" size="sm">
              {t('identities.privileged')}
            </Badge>
          )}
        </Group>
        {changed && (
          <Badge variant="light" color="red" size="sm" leftSection={<IconAlertTriangle size={12} />}>
            {t('identities.changedOutside')}
          </Badge>
        )}
      </Group>
      {i.description && (
        <Text size="sm" mb="sm">
          {i.description}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" verticalSpacing="sm">
        <Field label={t('identities.signIn')}>
          {i.ownSignIn ? t('identities.ownSignIn') : t('identities.platformSignIn', { auth: t(`auth.${platform.config.auth?.type ?? 'none'}`) })}
        </Field>
        <Field label={t('identities.credentials')}>
          <Stack gap={2}>
            <Text size="sm" className={i.secretKeys.length ? 'mono' : undefined} style={{ overflowWrap: 'anywhere' }}>
              {i.secretKeys.length ? i.secretKeys.join(', ') : t('identities.noCredentials')}
            </Text>
            {i.default && (
              <Anchor component="button" type="button" size="sm" onClick={() => onOpenTab('credentials')} style={{ alignSelf: 'flex-start' }}>
                {t('identities.openCredentials')}
              </Anchor>
            )}
          </Stack>
        </Field>
        <Field label={t('identities.mcpLabel')}>
          <Stack gap={2}>
            <Text size="sm">{mcp}</Text>
            {i.default && (
              <Anchor component="button" type="button" size="sm" onClick={() => onOpenTab('mcp')} style={{ alignSelf: 'flex-start' }}>
                {t('identities.openMcp')}
              </Anchor>
            )}
          </Stack>
        </Field>
        <Field label={t('identities.operations')}>{i.operationFilter ? t('identities.filtered') : t('identities.allOperations')}</Field>
        <Field label={t('identities.whoMayUse')}>{i.default ? t('identities.everyoneWithUse') : t('identities.accessList')}</Field>
        <Field label={t('identities.you')}>{i.mayUse ? t('identities.youMayUse') : t('identities.youMayNotUse')}</Field>
      </SimpleGrid>
    </Paper>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed" fw={600}>
        {label}
      </Text>
      {typeof children === 'string' ? <Text size="sm">{children}</Text> : children}
    </div>
  );
}

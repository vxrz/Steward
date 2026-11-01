import { useState } from 'react';
import { Alert, Anchor, Card, Code, Divider, Group, Stack, Switch, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconRobot } from '@tabler/icons-react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import type { McpServerStatus } from '@sm/shared';
import { notifyError, notifyOk, put } from '../../api';
import { origin } from '../PublicApiInfo';
import { McpClientConfig, useMcpServer } from './McpClientConfig';
import { McpOAuthSettings } from './McpOAuthSettings';

/** Settings → MCP server: on/off (administrators), endpoint and client configuration. */
export function McpServerCard() {
  const { t } = useTranslation('mcp');
  const qc = useQueryClient();
  const status = useMcpServer();
  const [busy, setBusy] = useState(false);
  const s = status.data;
  if (!s) return null;
  const toggle = async (body: { enabled?: boolean; runRequests?: boolean; controlProposals?: boolean }) => {
    setBusy(true);
    try {
      const next = await put<McpServerStatus>('/mcp-server', body);
      qc.setQueryData(['mcp-server'], next);
      notifyOk(
        body.enabled !== undefined
          ? body.enabled
            ? t('settings.turnedOn')
            : t('settings.turnedOff')
          : body.controlProposals !== undefined
            ? body.controlProposals
              ? t('settings.controlProposalsOn')
              : t('settings.controlProposalsOff')
            : body.runRequests
              ? t('settings.runRequestsOn')
              : t('settings.runRequestsOff'),
      );
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card withBorder>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconRobot size={18} />
        <Title order={5}>{t('settings.title')}</Title>
      </Group>
      <Stack gap="sm">
        <Text size="sm">{t('settings.intro')}</Text>
        {s.forcedOff && (
          <Alert color="gray" variant="light" p="xs">
            <Trans t={t} i18nKey="settings.forcedOff" components={{ c: <Code /> }} values={{ name: 'SM_MCP=off' }} />
          </Alert>
        )}
        <Switch
          label={t('settings.enable')}
          description={t('settings.enableHint')}
          checked={s.enabled}
          disabled={busy || s.forcedOff}
          onChange={(e) => toggle({ enabled: e.currentTarget.checked })}
        />
        <Switch
          label={t('settings.runRequests')}
          description={t('settings.runRequestsHint')}
          checked={s.runRequests}
          disabled={busy || !s.enabled}
          onChange={(e) => toggle({ runRequests: e.currentTarget.checked })}
        />
        <Switch
          label={t('settings.controlProposals')}
          description={t('settings.controlProposalsHint')}
          checked={s.controlProposals}
          disabled={busy || !s.enabled}
          onChange={(e) => toggle({ controlProposals: e.currentTarget.checked })}
        />
        {s.enabled && (
          <>
            <Text size="sm">
              <Trans
                t={t}
                i18nKey="settings.endpoint"
                components={{ c: <Code /> }}
                values={{ url: `${origin()}${s.path}`, versions: s.protocolVersions.join(', ') }}
              />
            </Text>
            <Text size="sm">
              <Trans t={t} i18nKey="settings.token" components={{ a: <Anchor inherit component={Link} to="/profile" /> }} />
            </Text>
            <McpClientConfig status={s} />
            <Text size="xs" c="dimmed">
              {t('settings.limits', { requests: s.rateLimitPerMinute, gateway: s.gatewayRateLimitPerMinute })}
            </Text>
            <Text size="xs" c="dimmed">
              {t('settings.security')}
            </Text>
            <Divider my="xs" />
            <McpOAuthSettings />
          </>
        )}
      </Stack>
    </Card>
  );
}

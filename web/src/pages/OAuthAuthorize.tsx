import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Code, Group, List, Stack, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconRobot } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import type { McpOAuthConsent } from '@sm/shared';
import { ApiError, get, notifyError, post } from '../api';
import { useMe } from '../auth';

/** The parameters of the authorization request, as the MCP client put them in the address. */
const PARAMS = ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'] as const;

/**
 * /oauth/authorize (#12): an MCP client asks to act as the signed-in person through Steward's MCP server. The person
 * sees which client asks and where the browser returns, and allows or denies; Steward then sends the browser back.
 * Problems that cannot go back to the client (unknown client or return address) are shown here.
 */
export function OAuthAuthorizePage() {
  const { t } = useTranslation('mcp');
  const { me } = useMe();
  const { search } = useLocation();
  const request = useMemo(() => {
    const sp = new URLSearchParams(search);
    return Object.fromEntries(PARAMS.filter((k) => sp.has(k)).map((k) => [k, sp.get(k)!]));
  }, [search]);
  const q = useQuery({
    queryKey: ['oauth-consent', search],
    queryFn: () => get<McpOAuthConsent>(`/oauth/authorize?${new URLSearchParams(request).toString()}`),
    retry: false,
  });
  const [busy, setBusy] = useState<'allow' | 'deny' | null>(null);
  const err = q.error instanceof ApiError ? q.error : null;
  const back = typeof err?.params?.redirectTo === 'string' ? err.params.redirectTo : null;
  useEffect(() => {
    // a problem the client must hear about: send the browser back with the OAuth error
    if (back) window.location.replace(back);
  }, [back]);

  const answer = async (approve: boolean) => {
    setBusy(approve ? 'allow' : 'deny');
    try {
      const r = await post<{ redirectTo: string }>('/oauth/authorize', { request, approve });
      window.location.assign(r.redirectTo);
    } catch (e) {
      notifyError(e);
      setBusy(null);
    }
  };

  return (
    <Stack maw={560} mx="auto" mt="xl">
      <Card withBorder p="lg">
        <Group gap="xs" mb="md" wrap="nowrap">
          <IconRobot size={22} />
          <Title order={2} size="h4">
            {t('consent.title')}
          </Title>
        </Group>
        {q.isLoading && <Text size="sm">{t('consent.checking')}</Text>}
        {err && !back && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} title={t('consent.cannotTitle')}>
            {err.message}
          </Alert>
        )}
        {back && <Text size="sm">{t('consent.returning')}</Text>}
        {q.data && (
          <Stack gap="sm">
            <Text size="sm">
              <Trans
                t={t}
                i18nKey="consent.asks"
                values={{ client: q.data.clientName, user: me?.user.displayName ?? me?.user.username ?? '' }}
                components={{ b: <b /> }}
              />
            </Text>
            <Text size="sm">
              <Trans t={t} i18nKey="consent.returnsTo" values={{ host: q.data.redirectHost }} components={{ c: <Code /> }} />
            </Text>
            {q.data.registeredBy === 'dynamic' && (
              <Alert color="yellow" variant="light" p="xs">
                {t('consent.selfRegistered')}
              </Alert>
            )}
            <Text size="sm" fw={500}>
              {t('consent.canTitle')}
            </Text>
            <List size="sm" spacing={2}>
              <List.Item>{t('consent.can.read')}</List.Item>
              <List.Item>{t('consent.can.ask')}</List.Item>
              <List.Item>{t('consent.can.not')}</List.Item>
            </List>
            <Text size="xs" c="dimmed">
              {q.data.alreadyGranted ? t('consent.alreadyGranted') : t('consent.revokeLater')}
            </Text>
            <Group justify="flex-end" mt="sm">
              <Button variant="default" loading={busy === 'deny'} disabled={!!busy} onClick={() => answer(false)}>
                {t('consent.deny')}
              </Button>
              <Button loading={busy === 'allow'} disabled={!!busy} onClick={() => answer(true)}>
                {t('consent.allow')}
              </Button>
            </Group>
          </Stack>
        )}
      </Card>
    </Stack>
  );
}

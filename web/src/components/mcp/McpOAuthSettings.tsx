import { useEffect, useState } from 'react';
import { Badge, Button, Code, Group, NumberInput, Stack, Switch, Table, Text, Textarea, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { MCP_OAUTH_LIMITS, type McpOAuthClient, type McpOAuthGrant, type McpOAuthSettings as Settings } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../../api';
import { fmtRelative } from '../../format';
import { confirmDanger } from '../confirm';
import { origin } from '../PublicApiInfo';

interface View {
  settings: Settings;
  clients: McpOAuthClient[];
  grants: McpOAuthGrant[];
}

/**
 * Settings → MCP server → OAuth sign-in (#12, administrators): optional, off by default. MCP clients that support
 * OAuth sign in with the person's Steward account; MCP tokens keep working either way.
 */
export function McpOAuthSettings() {
  const { t } = useTranslation(['mcp', 'common']);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mcp-oauth'], queryFn: () => get<View>('/settings/mcp-oauth') });
  const [life, setLife] = useState<{ access: number; refresh: number } | null>(null);
  const [adding, setAdding] = useState<{ name: string; uris: string } | null>(null);
  const v = q.data;
  useEffect(() => {
    if (v) setLife({ access: v.settings.accessTokenMinutes, refresh: v.settings.refreshTokenDays });
  }, [v]);
  if (!v || !life) return null;
  const apply = (next: View, done?: string) => {
    qc.setQueryData(['mcp-oauth'], next);
    void qc.invalidateQueries({ queryKey: ['mcp-server'] });
    if (done) notifyOk(done);
  };
  const change = async (body: Partial<Settings>, done: string) => {
    try {
      apply(await put<View>('/settings/mcp-oauth', body), done);
    } catch (e) {
      notifyError(e);
    }
  };
  const removeClient = async (c: McpOAuthClient) => {
    if (
      !(await confirmDanger({
        action: 'remove',
        title: t('oauth.removeClientTitle', { name: c.name }),
        message: t('oauth.removeClientText', { count: c.grants }),
      }))
    )
      return;
    try {
      apply(await del<View>(`/settings/mcp-oauth/clients/${c.id}`), t('oauth.clientRemoved'));
    } catch (e) {
      notifyError(e);
    }
  };
  const revoke = async (g: McpOAuthGrant) => {
    try {
      apply(await del<View>(`/settings/mcp-oauth/grants/${g.id}`), t('oauth.grantRevoked'));
    } catch (e) {
      notifyError(e);
    }
  };
  const addClient = async () => {
    if (!adding) return;
    try {
      await post('/settings/mcp-oauth/clients', {
        name: adding.name,
        redirectUris: adding.uris
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setAdding(null);
      apply(await get<View>('/settings/mcp-oauth'), t('oauth.clientAdded'));
    } catch (e) {
      notifyError(e);
    }
  };
  const s = v.settings;
  return (
    <Stack gap="sm" data-testid="mcp-oauth">
      <Title order={6}>{t('oauth.title')}</Title>
      <Switch
        label={t('oauth.enable')}
        description={t('oauth.enableHint')}
        checked={s.enabled}
        onChange={(e) => change({ enabled: e.currentTarget.checked }, e.currentTarget.checked ? t('oauth.turnedOn') : t('oauth.turnedOff'))}
      />
      {s.enabled && (
        <>
          <Text size="sm">
            <Trans t={t} i18nKey="oauth.discovery" components={{ c: <Code /> }} values={{ url: `${origin()}/.well-known/oauth-authorization-server` }} />
          </Text>
          <Switch
            label={t('oauth.dynamic')}
            description={t('oauth.dynamicHint')}
            checked={s.dynamicRegistration}
            onChange={(e) => change({ dynamicRegistration: e.currentTarget.checked }, t('oauth.saved'))}
          />
          <Group align="flex-end" gap="sm">
            <NumberInput
              label={t('oauth.accessMinutes')}
              min={MCP_OAUTH_LIMITS.accessTokenMinutes[0]}
              max={MCP_OAUTH_LIMITS.accessTokenMinutes[1]}
              value={life.access}
              onChange={(x) => setLife({ ...life, access: Number(x) || s.accessTokenMinutes })}
              w={200}
            />
            <NumberInput
              label={t('oauth.refreshDays')}
              min={MCP_OAUTH_LIMITS.refreshTokenDays[0]}
              max={MCP_OAUTH_LIMITS.refreshTokenDays[1]}
              value={life.refresh}
              onChange={(x) => setLife({ ...life, refresh: Number(x) || s.refreshTokenDays })}
              w={200}
            />
            <Button
              variant="default"
              disabled={life.access === s.accessTokenMinutes && life.refresh === s.refreshTokenDays}
              onClick={() => change({ accessTokenMinutes: life.access, refreshTokenDays: life.refresh }, t('oauth.saved'))}
            >
              {t('common:save')}
            </Button>
          </Group>

          <Group justify="space-between" mt="xs">
            <Text fw={500} size="sm">
              {t('oauth.clients')}
            </Text>
            {!adding && (
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding({ name: '', uris: '' })}>
                {t('oauth.addClient')}
              </Button>
            )}
          </Group>
          {adding && (
            <Stack gap="xs">
              <TextInput label={t('oauth.clientName')} value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.currentTarget.value })} />
              <Textarea
                label={t('oauth.redirectUris')}
                description={t('oauth.redirectUrisHint')}
                autosize
                minRows={2}
                value={adding.uris}
                onChange={(e) => setAdding({ ...adding, uris: e.currentTarget.value })}
              />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => setAdding(null)}>
                  {t('common:cancel')}
                </Button>
                <Button onClick={addClient} disabled={!adding.name.trim() || !adding.uris.trim()}>
                  {t('oauth.addClient')}
                </Button>
              </Group>
            </Stack>
          )}
          {v.clients.length ? (
            <Table.ScrollContainer minWidth={560}>
              <Table verticalSpacing={4} fz="sm">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('oauth.clientName')}</Table.Th>
                    <Table.Th>{t('oauth.redirect')}</Table.Th>
                    <Table.Th>{t('oauth.lastUsed')}</Table.Th>
                    <Table.Th />
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {v.clients.map((c) => (
                    <Table.Tr key={c.id}>
                      <Table.Td>
                        {c.name}{' '}
                        <Badge size="xs" variant="light" color={c.registeredBy === 'dynamic' ? 'gray' : 'blue'}>
                          {c.registeredBy === 'dynamic' ? t('oauth.selfRegistered') : t('oauth.addedBy', { name: c.registeredBy })}
                        </Badge>
                        <Text size="xs" c="dimmed">
                          {t('oauth.people', { count: c.grants })}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" style={{ wordBreak: 'break-all' }}>
                          {c.redirectUris.join(', ')}
                        </Text>
                      </Table.Td>
                      <Table.Td className="nowrap">{c.lastUsedAt ? fmtRelative(c.lastUsedAt) : '–'}</Table.Td>
                      <Table.Td>
                        <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconTrash size={12} />} onClick={() => removeClient(c)}>
                          {t('oauth.remove')}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          ) : (
            <Text size="sm" c="dimmed">
              {t('oauth.noClients')}
            </Text>
          )}
          {v.grants.length > 0 && (
            <>
              <Text fw={500} size="sm" mt="xs">
                {t('oauth.connected')}
              </Text>
              <Table verticalSpacing={4} fz="sm">
                <Table.Tbody>
                  {v.grants.map((g) => (
                    <Table.Tr key={g.id}>
                      <Table.Td>{g.owner}</Table.Td>
                      <Table.Td>{g.clientName}</Table.Td>
                      <Table.Td className="nowrap">{g.lastUsedAt ? fmtRelative(g.lastUsedAt) : '–'}</Table.Td>
                      <Table.Td>
                        <Button size="compact-xs" variant="subtle" color="red" onClick={() => revoke(g)}>
                          {t('oauth.revoke')}
                        </Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </>
          )}
        </>
      )}
    </Stack>
  );
}

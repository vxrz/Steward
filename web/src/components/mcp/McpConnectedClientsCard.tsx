import { Button, Card, Group, Table, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconPlugConnected } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { McpOAuthGrant } from '@sm/shared';
import { del, get, notifyError, notifyOk } from '../../api';
import { fmtDay, fmtRelative } from '../../format';
import { confirmDanger } from '../confirm';
import { useMcpServer } from './McpClientConfig';

/** Profile → Connected MCP clients (#12): AI assistants the person allowed through OAuth, and revoking them. */
export function McpConnectedClientsCard() {
  const { t } = useTranslation('mcp');
  const qc = useQueryClient();
  const status = useMcpServer();
  const q = useQuery({ queryKey: ['mcp-clients'], queryFn: () => get<McpOAuthGrant[]>('/me/mcp-clients') });
  const grants = q.data ?? [];
  if (!status.data?.oauth.enabled && !grants.length) return null;
  const revoke = async (g: McpOAuthGrant) => {
    if (!(await confirmDanger({ action: 'revoke', title: t('connected.revokeTitle', { name: g.clientName }), message: t('connected.revokeText') }))) return;
    try {
      qc.setQueryData(['mcp-clients'], await del<McpOAuthGrant[]>(`/me/mcp-clients/${g.id}`));
      notifyOk(t('connected.revoked'));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Card withBorder>
      <Group gap="xs" mb="xs" wrap="nowrap">
        <IconPlugConnected size={18} />
        <Title order={5}>{t('connected.title')}</Title>
      </Group>
      <Text size="sm" c="dimmed" mb="sm">
        {t('connected.intro')}
      </Text>
      {grants.length ? (
        <Table verticalSpacing={4} fz="sm" data-testid="mcp-connected-clients">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('connected.client')}</Table.Th>
              <Table.Th>{t('connected.lastUsed')}</Table.Th>
              <Table.Th>{t('connected.until')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {grants.map((g) => (
              <Table.Tr key={g.id}>
                <Table.Td>{g.clientName}</Table.Td>
                <Table.Td className="nowrap">{g.lastUsedAt ? fmtRelative(g.lastUsedAt) : '–'}</Table.Td>
                <Table.Td className="nowrap">{fmtDay(g.expiresAt)}</Table.Td>
                <Table.Td>
                  <Button size="compact-xs" variant="subtle" color="red" onClick={() => revoke(g)} aria-label={t('connected.revokeOf', { name: g.clientName })}>
                    {t('connected.revoke')}
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      ) : (
        <Text size="sm" c="dimmed">
          {t('connected.none')}
        </Text>
      )}
    </Card>
  );
}

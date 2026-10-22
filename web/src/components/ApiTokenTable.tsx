import { ActionIcon, Badge, Code, Table, Text, Tooltip } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ApiToken } from '@sm/shared';
import { fmtDate, fmtRelative } from '../format';

export function tokenState(t: ApiToken): { state: 'revoked' | 'expired' | 'active'; color: string } {
  if (t.revoked) return { state: 'revoked', color: 'gray' };
  if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return { state: 'expired', color: 'orange' };
  return { state: 'active', color: 'green' };
}

/** API tokens as a table; scrolls horizontally inside its box on small screens. */
export function ApiTokenTable({ tokens, showOwner, onRevoke }: { tokens: ApiToken[]; showOwner?: boolean; onRevoke: (t: ApiToken) => void }) {
  const { t } = useTranslation(['profile', 'common']);
  return (
    <Table.ScrollContainer minWidth={showOwner ? 760 : 660}>
      <Table verticalSpacing={6} fz="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('common:name')}</Table.Th>
            {showOwner && <Table.Th>{t('tokens.owner')}</Table.Th>}
            <Table.Th>{t('tokens.token')}</Table.Th>
            <Table.Th>{t('tokens.scope')}</Table.Th>
            <Table.Th>{t('tokens.created')}</Table.Th>
            <Table.Th>{t('tokens.lastUsed')}</Table.Th>
            <Table.Th>{t('tokens.expires')}</Table.Th>
            <Table.Th>{t('tokens.status')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tokens.map((tk) => {
            const st = tokenState(tk);
            return (
              <Table.Tr key={tk.id} data-inactive={st.state !== 'active' || undefined}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {tk.name}
                  </Text>
                </Table.Td>
                {showOwner && <Table.Td>{tk.owner}</Table.Td>}
                <Table.Td>
                  <Code>{tk.prefix}…</Code>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color={tk.scope === 'full' ? 'orange' : 'blue'}>
                    {tk.scope === 'full' ? t('tokens.full') : t('tokens.read')}
                  </Badge>
                </Table.Td>
                <Table.Td className="nowrap">
                  <Tooltip label={fmtDate(tk.createdAt)}>
                    <span>{fmtRelative(tk.createdAt)}</span>
                  </Tooltip>
                </Table.Td>
                <Table.Td className="nowrap">
                  {tk.lastUsedAt ? (
                    <Tooltip label={fmtDate(tk.lastUsedAt)}>
                      <span>{fmtRelative(tk.lastUsedAt)}</span>
                    </Tooltip>
                  ) : (
                    t('tokens.never')
                  )}
                </Table.Td>
                <Table.Td className="nowrap">{tk.expiresAt ? fmtDate(tk.expiresAt) : t('tokens.never')}</Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="dot" color={st.color}>
                    {t(`tokens.states.${st.state}`)}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {!tk.revoked && (
                    <Tooltip label={t('tokens.revoke')}>
                      <ActionIcon variant="subtle" color="red" onClick={() => onRevoke(tk)} aria-label={t('tokens.revokeNamed', { name: tk.name })}>
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}

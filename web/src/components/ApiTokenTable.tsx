import { ActionIcon, Badge, Code, Table, Text, Tooltip } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import type { ApiToken } from '@sm/shared';
import { fmtDate, fmtRelative } from '../format';

export function tokenState(t: ApiToken): { label: string; color: string } {
  if (t.revoked) return { label: 'revoked', color: 'gray' };
  if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return { label: 'expired', color: 'orange' };
  return { label: 'active', color: 'green' };
}

/** API tokens as a table; scrolls horizontally inside its box on small screens. */
export function ApiTokenTable({ tokens, showOwner, onRevoke }: { tokens: ApiToken[]; showOwner?: boolean; onRevoke: (t: ApiToken) => void }) {
  return (
    <Table.ScrollContainer minWidth={showOwner ? 760 : 660}>
      <Table verticalSpacing={6} fz="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            {showOwner && <Table.Th>Owner</Table.Th>}
            <Table.Th>Token</Table.Th>
            <Table.Th>Scope</Table.Th>
            <Table.Th>Created</Table.Th>
            <Table.Th>Last used</Table.Th>
            <Table.Th>Expires</Table.Th>
            <Table.Th>Status</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tokens.map((t) => {
            const st = tokenState(t);
            return (
              <Table.Tr key={t.id} style={{ opacity: st.label === 'active' ? 1 : 0.6 }}>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {t.name}
                  </Text>
                </Table.Td>
                {showOwner && <Table.Td>{t.owner}</Table.Td>}
                <Table.Td>
                  <Code>{t.prefix}…</Code>
                </Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="light" color={t.scope === 'full' ? 'orange' : 'blue'}>
                    {t.scope === 'full' ? 'full access' : 'read only'}
                  </Badge>
                </Table.Td>
                <Table.Td className="nowrap">
                  <Tooltip label={fmtDate(t.createdAt)}>
                    <span>{fmtRelative(t.createdAt)}</span>
                  </Tooltip>
                </Table.Td>
                <Table.Td className="nowrap">{t.lastUsedAt ? <Tooltip label={fmtDate(t.lastUsedAt)}><span>{fmtRelative(t.lastUsedAt)}</span></Tooltip> : 'never'}</Table.Td>
                <Table.Td className="nowrap">{t.expiresAt ? fmtDate(t.expiresAt) : 'never'}</Table.Td>
                <Table.Td>
                  <Badge size="sm" variant="dot" color={st.color}>
                    {st.label}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  {!t.revoked && (
                    <Tooltip label="Revoke token">
                      <ActionIcon variant="subtle" color="red" onClick={() => onRevoke(t)} aria-label={`Revoke token ${t.name}`}>
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

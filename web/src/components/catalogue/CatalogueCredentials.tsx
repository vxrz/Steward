import { Anchor, Box, Stack, Table, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ApplicationCredential } from '@sm/shared';
import { fmtDay } from '../../format';
import { CredentialStatusBadge } from '../../pages/Credentials';

/** Credentials register entries of a catalogue item (application or system), with what is due (#125, #143). */
export function CatalogueCredentials({
  credentials,
  help,
  empty,
  testId,
}: {
  credentials: ApplicationCredential[];
  help: string;
  empty: string;
  testId: string;
}) {
  const { t } = useTranslation(['applications', 'credentials']);
  const titleId = `${testId}-title`;
  return (
    <Stack gap="xs" data-testid={testId}>
      <Text fw={600} id={titleId}>
        {t('credentials.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {help}
      </Text>
      {credentials.length === 0 ? (
        <Text size="sm" c="dimmed">
          {empty}
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-labelledby={titleId}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('credentials:table.name')}</Table.Th>
                <Table.Th>{t('credentials:table.status')}</Table.Th>
                <Table.Th>{t('credentials:table.nextDue')}</Table.Th>
                <Table.Th>{t('credentials:table.roles')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {credentials.map((c) => (
                <Table.Tr key={c.id}>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    <Anchor component={Link} to={`/credentials?open=${encodeURIComponent(c.id)}`} size="sm">
                      {c.name}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {[
                        t(`credentials:types.${c.type}`, { defaultValue: c.type }),
                        c.componentName ? t('credentials.ofComponent', { name: c.componentName }) : null,
                        c.relation === 'usedBy' ? t('credentials.usedBy') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    <Box w="max-content">
                      <CredentialStatusBadge status={c.status} />
                    </Box>
                  </Table.Td>
                  <Table.Td className="nowrap">{c.nextDueAt ? fmtDay(c.nextDueAt) : '–'}</Table.Td>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>{c.roles.join(', ') || '–'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}

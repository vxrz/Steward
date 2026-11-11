import { Anchor, Box, Stack, Table, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ApplicationCredential } from '@sm/shared';
import { fmtDay } from '../../format';
import { CredentialStatusBadge } from '../../pages/Credentials';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { TableScroll } from '../TableScroll';

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
    <CollapsibleSection
      id={testId}
      collapseOnPhone
      testId={testId}
      onlyInGroup
      size="h5"
      title={t('credentials.title')}
      count={credentials.length}
      // expired or overdue for rotation/review: an error that opens the section; due soon: a warning
      tone={
        credentials.some((c) => c.status === 'expired' || c.status === 'overdue')
          ? 'error'
          : credentials.some((c) => c.status === 'dueSoon')
            ? 'warning'
            : undefined
      }
      defaultOpen={credentials.length > 0}
      description={help}
    >
      <Stack gap="xs">
        {credentials.length === 0 ? (
          <Text size="sm" c="dimmed">
            {empty}
          </Text>
        ) : (
          <TableScroll>
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
          </TableScroll>
        )}
      </Stack>
    </CollapsibleSection>
  );
}

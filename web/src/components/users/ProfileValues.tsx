import { Stack, Table, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { UserProfileValue } from '@sm/shared';

/** Read-only fields from the single sign-on provider (department, job title …). */
export function ProfileValues({ values }: { values: UserProfileValue[] }) {
  const { t } = useTranslation('users');
  if (!values.length) return null;
  return (
    <Stack gap={4} data-testid="profile-values">
      <Text size="sm" fw={500}>
        {t('profileValues.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('profileValues.hint')}
      </Text>
      <Table fz="sm" verticalSpacing={2} withTableBorder>
        <Table.Tbody>
          {values.map((v) => (
            <Table.Tr key={v.key}>
              <Table.Th w="40%" fw={500}>
                {v.label}
              </Table.Th>
              <Table.Td style={{ wordBreak: 'break-word' }}>{v.value}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

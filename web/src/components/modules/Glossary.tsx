import { Anchor, Modal, Stack, Table, Text, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
// Direct import: the @sm/shared barrel would pull zod and dagre into the first download.
import { BRAND } from '../../../../shared/src/brand';

/** The terms of the glossary, grouped as in docs/GLOSSARY.md (0.11.0, P7). */
const GROUPS = {
  catalogue: ['service', 'application', 'system', 'component', 'platform'],
  automation: ['process', 'run', 'step', 'decision'],
  watching: ['monitor', 'check', 'objective'],
  records: ['document', 'credential', 'duty', 'team', 'module'],
} as const;

/** Help → Glossary: the words Steward uses and how the catalogue terms relate (en and de). */
export default function GlossaryDialog({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { t } = useTranslation('modules');
  return (
    <Modal opened={opened} onClose={onClose} title={t('glossary.title')} size="lg">
      <Stack gap="sm" data-testid="glossary">
        <Text size="sm">{t('glossary.intro', { brand: BRAND.name })}</Text>
        <Text size="sm" fw={600}>
          {t('glossary.relation', { brand: BRAND.name })}
        </Text>
        {(Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((g) => (
          <Stack key={g} gap={4}>
            <Title order={3} size="h5">
              {t(`glossary.groups.${g}`)}
            </Title>
            <Table fz="sm" verticalSpacing={4} aria-label={t(`glossary.groups.${g}`)}>
              <Table.Tbody>
                {GROUPS[g].map((k) => (
                  <Table.Tr key={k}>
                    <Table.Th scope="row" w={170} style={{ verticalAlign: 'top' }}>
                      {t(`glossary.terms.${k}.term`)}
                    </Table.Th>
                    <Table.Td>{t(`glossary.terms.${k}.text`, { brand: BRAND.name })}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        ))}
        <Text size="sm">
          <Anchor href={`${BRAND.repoUrl}/blob/HEAD/docs/GLOSSARY.md`} target="_blank" rel="noopener">
            {t('glossary.docs')}
          </Anchor>
        </Text>
      </Stack>
    </Modal>
  );
}

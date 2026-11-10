import { ActionIcon, Code, CopyButton, Group, Text, Tooltip, VisuallyHidden } from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';

/**
 * The id of an entry in its page header (a line of its own), with a button that copies it – for the public API, YAML and MCP. The button
 * is named "Copy id"; a copy is announced ("Copied") in a polite live region and shown by the check mark.
 */
export function CopyId({ id, testId = 'copy-id' }: { id: string; testId?: string }) {
  const { t } = useTranslation();
  return (
    <CopyButton value={id} timeout={2000}>
      {({ copied, copy }) => (
        <Group gap={4} wrap="nowrap" data-testid={testId} maw="100%" w="fit-content">
          <Text span size="xs" c="dimmed">
            {t('copyId.label')}
          </Text>
          <Code style={{ overflowWrap: 'anywhere', minWidth: 0 }}>{id}</Code>
          <Tooltip label={copied ? t('copied') : t('copyId.copy')} withArrow>
            <ActionIcon
              variant="subtle"
              color={copied ? 'green' : 'gray'}
              size="md"
              onClick={copy}
              aria-label={t('copyId.copy')}
              data-testid={`${testId}-button`}
            >
              {copied ? <IconCheck size={16} aria-hidden /> : <IconCopy size={16} aria-hidden />}
            </ActionIcon>
          </Tooltip>
          <VisuallyHidden component="span" role="status" aria-live="polite">
            {copied ? t('copied') : ''}
          </VisuallyHidden>
        </Group>
      )}
    </CopyButton>
  );
}

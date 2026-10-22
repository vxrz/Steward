import { useState } from 'react';
import { ActionIcon, Box, Code, CopyButton, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { McpServerStatus } from '@sm/shared';
import { getOptional } from '../../api';
import { origin } from '../PublicApiInfo';

/** MCP server status (any signed-in user); null on servers without MCP. */
export function useMcpServer() {
  return useQuery({ queryKey: ['mcp-server'], queryFn: () => getOptional<McpServerStatus | null>('/mcp-server', null), staleTime: 30000 });
}

/** A code block with a copy button. */
export function CopyCode({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation('common');
  return (
    <Box pos="relative">
      <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', paddingRight: 36 }}>
        {text}
      </Code>
      <CopyButton value={text}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? t('copied') : t('copy')}>
            <ActionIcon size="sm" variant="subtle" onClick={copy} pos="absolute" top={6} right={6} aria-label={`${t('copy')}: ${label}`}>
              {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Box>
  );
}

type Kind = 'stdio' | 'http';

/**
 * Ready-to-copy client configuration: the stdio bridge for desktop clients (Claude Desktop style
 * `mcpServers`) and the Streamable HTTP endpoint with an Authorization header (VS Code `servers`).
 * With `token` the real token is filled in (shown once after creating it), otherwise a placeholder.
 */
export function McpClientConfig({ status, token }: { status: McpServerStatus; token?: string }) {
  const { t } = useTranslation('mcp');
  const [kind, setKind] = useState<Kind>('stdio');
  const base = origin();
  const endpoint = `${base}${status.path}`;
  const tokenFile = t('config.tokenFile');
  const stdio = JSON.stringify(
    { mcpServers: { steward: { command: 'steward', args: ['mcp', '--url', base, '--api-key-file', tokenFile] } } },
    null,
    2,
  );
  const http = JSON.stringify(
    {
      servers: {
        steward: { type: 'http', url: endpoint, headers: { Authorization: token ? `Bearer ${token}` : 'Bearer ${input:steward-mcp-token}' } },
      },
      ...(token ? {} : { inputs: [{ type: 'promptString', id: 'steward-mcp-token', description: t('config.tokenPrompt'), password: true }] }),
    },
    null,
    2,
  );
  return (
    <Stack gap="xs">
      <SegmentedControl
        fullWidth
        value={kind}
        onChange={(v) => setKind(v as Kind)}
        data={[
          { value: 'stdio', label: t('config.stdio') },
          { value: 'http', label: t('config.http') },
        ]}
        aria-label={t('config.kind')}
      />
      {kind === 'stdio' ? (
        <>
          <Text size="sm">
            <Trans t={t} i18nKey="config.stdioHint" components={{ c: <Code /> }} values={{ file: 'claude_desktop_config.json', token: tokenFile }} />
          </Text>
          <CopyCode text={stdio} label={t('config.stdio')} />
          <Text size="xs" c="dimmed">
            <Trans t={t} i18nKey="config.stdioSource" components={{ c: <Code /> }} values={{ cmd: 'npm run --silent mcp -- --url …' }} />
          </Text>
        </>
      ) : (
        <>
          <Text size="sm">
            <Trans t={t} i18nKey="config.httpHint" components={{ c: <Code /> }} values={{ file: '.vscode/mcp.json', url: endpoint }} />
          </Text>
          <CopyCode text={http} label={t('config.http')} />
        </>
      )}
    </Stack>
  );
}

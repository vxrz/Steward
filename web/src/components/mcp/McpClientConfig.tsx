import { useState } from 'react';
import { useMediaQuery } from '@mantine/hooks';
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

type Kind = 'stdio' | 'http' | 'vibe';

/** The environment variable that holds the token for Mistral Vibe (`api_key_env`) and the Claude Code command. */
const TOKEN_ENV = 'STEWARD_MCP_TOKEN';

/**
 * Ready-to-copy client configuration: the stdio bridge for desktop clients (Claude Desktop style
 * `mcpServers`), the Streamable HTTP endpoint with an Authorization header (VS Code `servers`, the Claude Code
 * command) and Mistral Vibe CLI's `[[mcp_servers]]` (TOML; the token from an environment variable, sent as
 * `Authorization: Bearer …` by default). With `token` the real token is filled in where the format holds one (shown
 * once after creating it), otherwise a placeholder.
 */
export function McpClientConfig({ status, token }: { status: McpServerStatus; token?: string }) {
  const { t } = useTranslation('mcp');
  const [kind, setKind] = useState<Kind>('stdio');
  // three segments do not fit side by side on a phone
  const narrow = useMediaQuery('(max-width: 36em)');
  const base = origin();
  const endpoint = `${base}${status.path}`;
  const tokenFile = t('config.tokenFile');
  const stdio = JSON.stringify({ mcpServers: { steward: { command: 'steward', args: ['mcp', '--url', base, '--api-key-file', tokenFile] } } }, null, 2);
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
  // TOML basic strings take JSON's escaping for these values
  const vibe = [
    '[[mcp_servers]]',
    `name = ${JSON.stringify('steward')}`,
    `transport = ${JSON.stringify('streamable-http')}`,
    `url = ${JSON.stringify(endpoint)}`,
    `api_key_env = ${JSON.stringify(TOKEN_ENV)}`,
  ].join('\n');
  // the shell fills in the token from the environment: a command line with the token itself stays in the shell's history
  const claudeCode = `claude mcp add --transport http steward ${endpoint} --header "Authorization: Bearer $${TOKEN_ENV}"`;
  return (
    <Stack gap="xs">
      <SegmentedControl
        fullWidth
        orientation={narrow ? 'vertical' : 'horizontal'}
        value={kind}
        onChange={(v) => setKind(v as Kind)}
        data={[
          { value: 'stdio', label: t('config.stdio') },
          { value: 'http', label: t('config.http') },
          { value: 'vibe', label: t('config.vibe') },
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
      ) : kind === 'http' ? (
        <>
          <Text size="sm">
            <Trans t={t} i18nKey="config.httpHint" components={{ c: <Code /> }} values={{ file: '.vscode/mcp.json', url: endpoint }} />
          </Text>
          <CopyCode text={http} label={t('config.http')} />
          <Text size="sm">
            <Trans t={t} i18nKey="config.claudeCodeHint" components={{ c: <Code /> }} values={{ env: TOKEN_ENV }} />
          </Text>
          <CopyCode text={claudeCode} label={t('config.claudeCode')} />
        </>
      ) : (
        <>
          <Text size="sm">
            <Trans t={t} i18nKey="config.vibeHint" components={{ c: <Code /> }} values={{ file: '~/.vibe/config.toml', env: TOKEN_ENV }} />
          </Text>
          <CopyCode text={vibe} label={t('config.vibe')} />
        </>
      )}
    </Stack>
  );
}

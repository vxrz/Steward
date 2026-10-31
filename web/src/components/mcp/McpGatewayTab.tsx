import { useEffect, useState } from 'react';
import { Alert, Button, Group, Select, Stack, Switch, Text, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { MCP_WRITE_MODES, type ApiOperation, type McpWriteMode, type Platform } from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../api';
import { useMcpServer } from './McpClientConfig';

/** Platform → MCP: the read-only gateway for MCP clients (users with "manage" switch it). */
export function McpGatewayTab({ platform, readOnly }: { platform: Platform; readOnly: boolean }) {
  const { t } = useTranslation('mcp');
  const qc = useQueryClient();
  const server = useMcpServer();
  const ops = useQuery({ queryKey: ['platform', platform.id, 'operations'], queryFn: () => get<ApiOperation[]>(`/platforms/${platform.id}/operations`) });
  const current = platform.config.mcpGateway;
  const [enabled, setEnabled] = useState(!!current?.enabled);
  const [prefixes, setPrefixes] = useState((current?.allowedPathPrefixes ?? []).join('\n'));
  const [writes, setWrites] = useState<McpWriteMode>(current?.writes ?? 'off');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setEnabled(!!current?.enabled);
    setPrefixes((current?.allowedPathPrefixes ?? []).join('\n'));
    setWrites(current?.writes ?? 'off');
  }, [current?.enabled, current?.allowedPathPrefixes, current?.writes]);
  const readOps = (ops.data ?? []).filter((o) => o.method === 'GET' || o.method === 'HEAD').length;
  const writeOps = (ops.data ?? []).length - readOps;
  const save = async () => {
    setBusy(true);
    try {
      await put(`/platforms/${platform.id}/mcp-gateway`, {
        enabled,
        writes,
        allowedPathPrefixes: prefixes
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean),
      });
      await qc.invalidateQueries({ queryKey: ['platform', platform.id] });
      notifyOk(t('gateway.saved'));
    } catch (e) {
      notifyError(e, t('gateway.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack maw={760}>
      <Text size="sm">{t('gateway.intro')}</Text>
      {server.data && !server.data.enabled && (
        <Alert color="gray" variant="light" icon={<IconInfoCircle size={16} />} p="xs">
          {t('gateway.serverOff')}
        </Alert>
      )}
      <Switch
        label={t('gateway.enable')}
        description={t('gateway.enableHint')}
        checked={enabled}
        disabled={readOnly || busy}
        onChange={(e) => setEnabled(e.currentTarget.checked)}
      />
      <Text size="sm">{ops.data ? t('gateway.operations', { count: readOps, read: readOps, write: writeOps }) : null}</Text>
      <Select
        label={t('gateway.writes')}
        description={t('gateway.writesHint')}
        allowDeselect={false}
        data={MCP_WRITE_MODES.map((m) => ({ value: m, label: t(`gateway.writeModes.${m}`) }))}
        value={writes}
        onChange={(v) => setWrites((v as McpWriteMode) ?? 'off')}
        disabled={readOnly || busy || !enabled}
        maw={480}
      />
      <Textarea
        label={t('gateway.prefixes')}
        description={t('gateway.prefixesHint')}
        placeholder="/api/v1/devices"
        autosize
        minRows={2}
        maxRows={8}
        disabled={readOnly || busy}
        value={prefixes}
        onChange={(e) => setPrefixes(e.currentTarget.value)}
        classNames={{ input: 'mono' }}
      />
      <Text size="xs" c="dimmed">
        {t('gateway.security')}
      </Text>
      {!readOnly && (
        <Group>
          <Button onClick={save} loading={busy}>
            {t('gateway.save')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

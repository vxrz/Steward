import { useState } from 'react';
import { Alert, Badge, Button, Code, Group, Paper, SegmentedControl, Stack, Table, Text, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { IconCheck, IconRobot, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { MCP_REQUEST_LIMITS, type McpRequest } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE } from '../components/common';
import { fmtDate, fmtRelative } from '../format';

const STATUS_COLOR: Record<McpRequest['status'], string> = {
  pending: TONE.attention,
  done: TONE.ok,
  failed: TONE.bad,
  rejected: TONE.neutral,
  withdrawn: TONE.neutral,
  expired: TONE.neutral,
};

function StatusBadge({ status }: { status: McpRequest['status'] }) {
  const { t } = useTranslation('mcp');
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" size="sm">
      {t(`requests.status.${status}`)}
    </Badge>
  );
}

const what = (r: McpRequest) => (r.kind === 'gateway' ? `${r.method} ${r.path}` : (r.processName ?? r.processId ?? ''));

/** AI requests (#11): changing calls and runs that MCP clients asked for, waiting for a person. */
export function McpRequestsPage() {
  const { t } = useTranslation('mcp');
  const { isAdmin, hasRole } = useMe();
  const [scope, setScope] = useState<'decide' | 'mine' | 'all'>('decide');
  const q = useQuery({ queryKey: ['mcp-requests', scope], queryFn: () => get<McpRequest[]>(`/mcp-requests?scope=${scope}`) });
  const list = q.data ?? [];
  return (
    <>
      <PageHeader title={t('requests.title')} description={t('requests.description')} />
      <SegmentedControl
        mb="md"
        value={scope}
        onChange={(v) => setScope(v as 'decide')}
        aria-label={t('requests.scope')}
        data={[
          { value: 'decide', label: t('requests.scopes.decide') },
          { value: 'mine', label: t('requests.scopes.mine') },
          ...(isAdmin || hasRole('auditor') ? [{ value: 'all', label: t('requests.scopes.all') }] : []),
        ]}
      />
      <QueryState query={q} />
      {q.isSuccess && list.length === 0 && (
        <EmptyState icon={IconRobot} title={t('requests.emptyTitle')}>
          {t('requests.emptyText')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('requests.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('requests.what')}</Table.Th>
                <Table.Th>{t('requests.where')}</Table.Th>
                <Table.Th>{t('requests.statusLabel')}</Table.Th>
                <Table.Th>{t('requests.requestedBy')}</Table.Th>
                <Table.Th>{t('requests.asked')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Text size="sm" fw={500} component={Link} to={`/mcp-requests/${r.id}`} className="mono">
                      {what(r)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{r.kind === 'gateway' ? (r.platformName ?? '–') : t('requests.run')}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={r.status} />
                  </Table.Td>
                  <Table.Td>{r.requestedBy}</Table.Td>
                  <Table.Td>{fmtRelative(r.createdAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </>
  );
}

export function McpRequestDetailPage() {
  const { t } = useTranslation('mcp');
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['mcp-request', id], queryFn: () => get<McpRequest>(`/mcp-requests/${id}`) });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const r = q.data;
  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    try {
      qc.setQueryData(['mcp-request', id], await post<McpRequest>(`/mcp-requests/${id}/decision`, { approve, comment }));
      await qc.invalidateQueries({ queryKey: ['mcp-requests'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const back = [{ to: '/mcp-requests', label: t('requests.title') }];
  if (!r) return <QueryState query={q} />;
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  return (
    <>
      <PageHeader
        back={back}
        title={<span className="mono">{what(r)}</span>}
        description={
          <Group gap="xs">
            <StatusBadge status={r.status} />
            <span>{t(`requests.modes.${r.mode}`)}</span>
          </Group>
        }
      />
      <Stack maw={900}>
        <Alert color="yellow" variant="light" p="xs">
          <Text size="sm">{t('requests.dataNotInstructions')}</Text>
        </Alert>
        <Paper withBorder p="sm">
          <Text size="sm">{t('requests.askedBy', { user: r.requestedBy, token: r.tokenName, when: fmtDate(r.createdAt) })}</Text>
          <Text size="sm" mt={4}>
            <Text span fw={600}>
              {t('requests.reason')}:{' '}
            </Text>
            {r.reason}
          </Text>
          {r.status === 'pending' && (
            <Text size="xs" c="dimmed" mt={4}>
              {t('requests.expires', { when: fmtRelative(r.expiresAt) })}
            </Text>
          )}
        </Paper>
        <Paper withBorder p="sm">
          {r.kind === 'gateway' ? (
            <Stack gap={6}>
              <Text size="sm">
                {t('requests.platform')}: {r.platformName ?? r.platformId}
                {r.operation ? ` · ${r.operation}` : ''}
              </Text>
              <Code block>{`${r.method} ${r.path}${Object.keys(r.query).length ? `\n${t('requests.query')}: ${json(r.query)}` : ''}`}</Code>
              {r.body !== null && (
                <>
                  <Text size="sm" fw={600}>
                    {t('requests.body')}
                  </Text>
                  <Code block>{json(r.body)}</Code>
                </>
              )}
            </Stack>
          ) : (
            <Stack gap={6}>
              <Text size="sm">
                {t('requests.process')}:{' '}
                <Text span component={Link} to={`/processes/${r.processId}`}>
                  {r.processName}
                </Text>
                {r.dryRun ? ` · ${t('requests.dryRun')}` : ''}
              </Text>
              {Object.keys(r.inputs).length > 0 && <Code block>{json(r.inputs)}</Code>}
            </Stack>
          )}
        </Paper>
        {(r.canApprove || r.canReject) && (
          <Paper withBorder p="sm">
            <Textarea
              label={t('requests.comment')}
              value={comment}
              onChange={(e) => setComment(e.currentTarget.value)}
              maxLength={MCP_REQUEST_LIMITS.comment}
              autosize
              minRows={2}
            />
            <Group justify="flex-end" mt="xs">
              {r.canReject && (
                <Button variant="default" leftSection={<IconX size={14} />} loading={busy === 'reject'} disabled={!!busy} onClick={() => decide(false)}>
                  {t('requests.reject')}
                </Button>
              )}
              {r.canApprove && (
                <Button leftSection={<IconCheck size={14} />} loading={busy === 'approve'} disabled={!!busy} onClick={() => decide(true)}>
                  {r.kind === 'run' ? t('requests.approveRun') : t('requests.approveCall')}
                </Button>
              )}
            </Group>
          </Paper>
        )}
        {r.decidedBy && r.decidedAt && (
          <Paper withBorder p="sm">
            <Text size="sm">
              {t('requests.decided', { user: r.decidedBy, when: fmtDate(r.decidedAt) })}
              {r.comment ? ` – ${r.comment}` : ''}
            </Text>
            {r.error && (
              <Text size="sm" c="red" mt={4}>
                {r.error}
              </Text>
            )}
            {r.runId && (
              <Text size="sm" mt={4} component={Link} to={`/runs/${r.runId}`}>
                {t('requests.openRun')}
              </Text>
            )}
            {r.resultStatus !== null && (
              <>
                <Text size="sm" mt={4}>
                  {t('requests.result', { status: r.resultStatus })}
                </Text>
                {r.resultBody !== null && <Code block>{json(r.resultBody)}</Code>}
              </>
            )}
          </Paper>
        )}
      </Stack>
    </>
  );
}

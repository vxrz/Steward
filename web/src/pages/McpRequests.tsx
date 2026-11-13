import { useCallback, useState } from 'react';
import { Alert, Badge, Button, Code, Group, Paper, SegmentedControl, Stack, Text, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { DecideFromLinkModal, DecideNotPossible, useDecideParam } from '../components/DecideFromLink';
import { PrivilegedBadge } from '../components/platform/PrivilegedBadge';
import { IconCheck, IconRobot, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { MCP_REQUEST_LIMITS, type McpProposalSelection, type McpRequest } from '@sm/shared';
import { get, notifyError, post } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE } from '../components/common';
import { useListParams } from '../components/page/params';
import { DataTable, type DataColumn } from '../components/DataTable';
import { fmtDate, fmtRelative } from '../format';
import { CatalogueProposalReview, MappingsProposalReview } from '../components/mcp/ProposalReview';
import { PlantProposalReview } from '../components/mcp/PlantProposalReview';
import { DataProductsProposalReview } from '../components/mcp/DataProductsProposalReview';

const STATUS_COLOR: Record<McpRequest['status'], string> = {
  pending: TONE.attention,
  done: TONE.ok,
  failed: TONE.bad,
  rejected: TONE.neutral,
  withdrawn: TONE.neutral,
  expired: TONE.neutral,
};

/** Sort order of the status column: what waits for a person first. */
const REQUEST_STATUS_ORDER: McpRequest['status'][] = ['pending', 'failed', 'done', 'rejected', 'withdrawn', 'expired'];

function StatusBadge({ status }: { status: McpRequest['status'] }) {
  const { t } = useTranslation('mcp');
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" size="sm">
      {t(`requests.status.${status}`)}
    </Badge>
  );
}

const what = (r: McpRequest) =>
  r.proposalSummary?.type === 'catalogue'
    ? `${r.proposalSummary.key} – ${r.proposalSummary.name}`
    : r.proposalSummary?.type === 'mappings'
      ? `${r.proposalSummary.catalogueKey} · ${r.proposalSummary.mappings} ↔`
      : r.proposalSummary?.type === 'plant' || r.proposalSummary?.type === 'dataProducts'
        ? r.proposalSummary.title
        : r.kind === 'gateway'
          ? `${r.method} ${r.path}`
          : (r.processName ?? r.processId ?? '');

/** AI requests (#11): changing calls and runs that MCP clients asked for, waiting for a person. */
export function McpRequestsPage() {
  const { t } = useTranslation('mcp');
  const { isAdmin, hasRole } = useMe();
  // the scope lives in the address (?scope=mine), so the view can be shared and survives a reload
  const { params, set } = useListParams();
  const scopes: ('decide' | 'mine' | 'all')[] = ['decide', 'mine', ...(isAdmin || hasRole('auditor') ? (['all'] as const) : [])];
  const asked = params.get('scope');
  const scope = scopes.find((x) => x === asked) ?? 'decide';
  const q = useQuery({ queryKey: ['mcp-requests', scope], queryFn: () => get<McpRequest[]>(`/mcp-requests?scope=${scope}`) });
  const list = q.data ?? [];
  const where = (r: McpRequest) => (r.kind === 'gateway' ? (r.platformName ?? '–') : r.kind === 'run' ? t('requests.run') : t(`requests.kinds.${r.kind}`));
  const columns: DataColumn<McpRequest>[] = [
    {
      key: 'what',
      header: t('requests.what'),
      sortValue: what,
      cell: (r) => (
        <Text size="sm" fw={500} component={Link} to={`/mcp-requests/${r.id}`} className="mono" onClick={(e) => e.stopPropagation()}>
          {what(r)}
        </Text>
      ),
    },
    { key: 'where', header: t('requests.where'), sortValue: where, cell: where },
    {
      key: 'status',
      header: t('requests.statusLabel'),
      // what waits for a person first
      sortValue: (r) => REQUEST_STATUS_ORDER.indexOf(r.status),
      cell: (r) => <StatusBadge status={r.status} />,
    },
    { key: 'requestedBy', header: t('requests.requestedBy'), sortValue: (r) => r.requestedBy, cell: (r) => r.requestedBy },
    {
      key: 'asked',
      header: t('requests.asked'),
      sortValue: (r) => r.createdAt,
      nowrap: true,
      tdProps: (r) => ({ title: fmtDate(r.createdAt) }),
      cell: (r) => fmtRelative(r.createdAt),
    },
  ];
  return (
    <>
      <PageHeader title={t('requests.title')} description={t('requests.description')} />
      <SegmentedControl
        mb="md"
        value={scope}
        onChange={(v) => set('scope', v === 'decide' ? null : v)}
        aria-label={t('requests.scope')}
        data={scopes.map((x) => ({ value: x, label: t(`requests.scopes.${x}`) }))}
      />
      <QueryState query={q} />
      {q.isSuccess && list.length === 0 && (
        <EmptyState icon={IconRobot} title={t('requests.emptyTitle')}>
          {t('requests.emptyText')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <DataTable
          rows={list}
          columns={columns}
          rowKey={(r) => r.id}
          ariaLabel={t('requests.title')}
          rowHref={(r) => `/mcp-requests/${r.id}`}
          testId="mcp-request-list"
          rememberSort="mcp-requests"
          // the inbox's own order: newest first (the server's order)
          defaultSort={{ key: 'asked', dir: 'desc' }}
          card={(r) => (
            <Paper withBorder p="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Text size="sm" fw={600} component={Link} to={`/mcp-requests/${r.id}`} className="mono" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  {what(r)}
                </Text>
                <StatusBadge status={r.status} />
              </Group>
              <Text size="xs" c="dimmed">
                {where(r)} · {r.requestedBy} · {fmtRelative(r.createdAt)}
              </Text>
            </Paper>
          )}
        />
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
  // proposals (#74): what the reviewer accepts of them
  const [selection, setSelection] = useState<{ value: McpProposalSelection; count: number } | null>(null);
  const onSelection = useCallback((value: McpProposalSelection, count: number) => setSelection({ value, count }), []);
  const r = q.data;
  // a card's Approve / Reject link (ADR 0013): the dialog opens with that choice; the person confirms
  const link = useDecideParam();
  const decide = async (approve: boolean, note = comment): Promise<boolean> => {
    setBusy(approve ? 'approve' : 'reject');
    try {
      const body = { approve, comment: note, ...(approve && r?.proposal && selection ? { selection: selection.value } : {}) };
      qc.setQueryData(['mcp-request', id], await post<McpRequest>(`/mcp-requests/${id}/decision`, body));
      await qc.invalidateQueries({ queryKey: ['mcp-requests'] });
      return true;
    } catch (e) {
      notifyError(e);
      return false;
    } finally {
      setBusy(null);
    }
  };
  const back = [{ to: '/mcp-requests', label: t('requests.title') }];
  if (!r) return <QueryState query={q} />;
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  const linkDecidable = !!link.verb && !r.proposal && (link.verb === 'approve' ? r.canApprove : r.canReject);
  return (
    <>
      {link.verb && linkDecidable && (
        <DecideFromLinkModal
          verb={link.verb}
          title={what(r)}
          commentMax={MCP_REQUEST_LIMITS.comment}
          onConfirm={(approve, note) => decide(approve, note)}
          onClose={link.clear}
        />
      )}
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
        {link.verb && !linkDecidable && <DecideNotPossible onClose={link.clear} />}
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
        {r.proposal?.type === 'catalogue' && <CatalogueProposalReview p={r.proposal} editable={r.canApprove} onChange={onSelection} />}
        {r.proposal?.type === 'mappings' && <MappingsProposalReview p={r.proposal} editable={r.canApprove} onChange={onSelection} />}
        {r.proposal?.type === 'plant' && <PlantProposalReview p={r.proposal} editable={r.canApprove} onChange={onSelection} />}
        {r.proposal?.type === 'dataProducts' && <DataProductsProposalReview p={r.proposal} editable={r.canApprove} onChange={onSelection} />}
        {!r.proposal && (
          <Paper withBorder p="sm">
            {r.kind === 'gateway' ? (
              <Stack gap={6}>
                <Text size="sm">
                  {t('requests.platform')}: {r.platformName ?? r.platformId}
                  {r.identityName ? ` · ${r.identityName}` : ''}
                  {r.operation ? ` · ${r.operation}` : ''} {r.privileged && <PrivilegedBadge size="xs" />}
                </Text>
                {/* a privileged identity (0.14.0, ADR 0009 step 4): approving asks the approver to confirm it is them */}
                {r.privileged && r.canApprove && (
                  <Text size="xs" c="dimmed" data-testid="mcp-request-privileged">
                    {t('requests.privilegedHint')}
                  </Text>
                )}
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
        )}
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
                <Button
                  leftSection={<IconCheck size={14} />}
                  loading={busy === 'approve'}
                  disabled={!!busy || (!!r.proposal && !selection?.count && !selection?.value.catalogue?.remove.length)}
                  onClick={() => decide(true)}
                >
                  {r.proposal
                    ? t('requests.acceptProposal', { count: selection?.count ?? 0 })
                    : r.kind === 'run'
                      ? t('requests.approveRun')
                      : t('requests.approveCall')}
                </Button>
              )}
            </Group>
          </Paper>
        )}
        {r.decidedBy && r.decidedAt && (
          <Paper withBorder p="sm">
            <Text size="sm">
              {t('requests.decided', { user: r.decidedBy, when: fmtDate(r.decidedAt) })}
              {r.decidedVia === 'teams' ? ` ${t('requests.viaTeams')}` : ''}
              {r.comment ? ` – ${r.comment}` : ''}
            </Text>
            {r.error && (
              <Text size="sm" c="red" mt={4}>
                {r.error}
              </Text>
            )}
            {r.proposal && r.resultBody !== null && r.status === 'done' && (
              <Text size="sm" mt={4}>
                {r.proposal.type === 'catalogue'
                  ? t('proposals.resultCatalogue', r.resultBody as Record<string, number>)
                  : r.proposal.type === 'plant'
                    ? t('plantProposal.result', r.resultBody as Record<string, number>)
                    : r.proposal.type === 'dataProducts'
                      ? t('dpProposal.applied', r.resultBody as Record<string, number>)
                      : t('proposals.resultMappings', r.resultBody as Record<string, number>)}
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

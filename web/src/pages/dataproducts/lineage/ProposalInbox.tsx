import { useState } from 'react';
import { Anchor, Badge, Button, Group, Modal, Paper, SegmentedControl, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCheck, IconEyeOff, IconGitBranch, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_LINEAGE_PROPOSAL_STATUSES,
  DATA_PRODUCT_LIMITS as L,
  DATA_STEP_KINDS,
  type DataLineageEnd,
  type DataLineageProposal,
  type DataLineageProposalStatus,
  type DataLineageRunState,
  type DataStepKind,
} from '@sm/shared';
import { notifyError, notifyOk, post } from '../../../api';
import { QueryState } from '../../../components/common';
import { DataTable } from '../../../components/DataTable';
import { confirmDanger } from '../../../components/confirm';
import { fmtDate, fmtRelative } from '../../../format';
import { useInvalidateDataProducts } from '../api';
import { useProposals } from './api';

const enc = encodeURIComponent;

const RUN_COLOR: Record<DataLineageRunState, string> = { start: 'blue', running: 'blue', complete: 'green', abort: 'orange', fail: 'red', other: 'gray' };

export function RunBadge({ run }: { run: DataLineageProposal['lastRun'] }) {
  const { t } = useTranslation('dataLineage');
  if (!run)
    return (
      <Text size="xs" c="dimmed">
        {t('proposals.noRun')}
      </Text>
    );
  return (
    <Stack gap={2}>
      <Group gap={6} wrap="nowrap">
        <Badge size="xs" variant="light" color={RUN_COLOR[run.state]} tt="none" data-state={run.state}>
          {t(`proposals.runStates.${run.state}`)}
        </Badge>
        <Text size="xs" c="dimmed" title={fmtDate(run.at)}>
          {fmtRelative(run.at)}
        </Text>
      </Group>
      {run.completeAt && run.state !== 'complete' && (
        <Text size="xs" c="dimmed">
          {t('proposals.lastComplete', { when: fmtRelative(run.completeAt) })}
        </Text>
      )}
    </Stack>
  );
}

/** One side of a proposal: the elements (links), the ones the reader may not see counted, the datasets not in the catalogue. */
function Ends({ ends, hidden, unmatched, unmatchedCount }: { ends: DataLineageEnd[]; hidden: number; unmatched: string[]; unmatchedCount: number }) {
  const { t } = useTranslation('dataLineage');
  if (!ends.length && !hidden && !unmatchedCount)
    return (
      <Text size="xs" c="dimmed">
        –
      </Text>
    );
  return (
    <Stack gap={2}>
      {ends.map((e) => (
        <Anchor key={e.id} component={Link} to={`/data-elements/${enc(e.id)}`} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
          {e.qualifiedName}
          <Text span size="xs" c="dimmed">
            {' '}
            · {e.environment}
          </Text>
        </Anchor>
      ))}
      {hidden > 0 && (
        <Group gap={4} wrap="nowrap">
          <IconEyeOff size={12} aria-hidden />
          <Text size="xs" c="dimmed" fs="italic">
            {t('proposals.hidden', { count: hidden })}
          </Text>
        </Group>
      )}
      {unmatchedCount > 0 && (
        <Tooltip
          multiline
          w={320}
          // the names also for the keyboard and on touch screens, not only on hover
          events={{ hover: true, focus: true, touch: true }}
          label={
            <Stack gap={0}>
              <Text size="xs" fw={600}>
                {t('proposals.unmatchedTitle')}
              </Text>
              {unmatched.map((u) => (
                <Text key={u} size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {u}
                </Text>
              ))}
            </Stack>
          }
        >
          <Text size="xs" c="orange" tabIndex={0} style={{ cursor: 'help' }} data-testid="proposal-unmatched">
            {t('proposals.unmatched', { count: unmatchedCount })}
          </Text>
        </Tooltip>
      )}
    </Stack>
  );
}

/** Accepting: the step's name and kind may be changed on the way. */
function AcceptModal({ p, onClose, onDone }: { p: DataLineageProposal; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(['dataLineage', 'dataProductViews', 'common']);
  const [name, setName] = useState(p.name);
  const [kind, setKind] = useState<DataStepKind>(p.kind);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await post(`/data-products/lineage-proposals/${enc(p.id)}/accept`, { name: name.trim() || p.name, kind });
      notifyOk(t('proposals.accepted'));
      onDone();
    } catch (e) {
      notifyError(e, t('proposals.notDecided'));
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('proposals.acceptTitle', { name: p.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm" data-testid="proposal-accept-form">
          <Text size="sm">
            {p.changed ? t('proposals.acceptChangeHelp') : t('proposals.acceptHelp', { inputs: p.inputs.length, outputs: p.outputs.length })}
          </Text>
          {!p.changed && (
            <>
              <TextInput label={t('proposals.stepName')} maxLength={L.name} value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
              <Select
                label={t('proposals.stepKind')}
                data={DATA_STEP_KINDS.map((k) => ({ value: k, label: t(`dataProductViews:stepKinds.${k}`) }))}
                value={kind}
                onChange={(k) => k && setKind(k as DataStepKind)}
                allowDeselect={false}
              />
            </>
          )}
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} leftSection={<IconCheck size={14} />} data-testid="proposal-accept-confirm">
              {t('proposals.accept')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * The inbox of proposed steps (0.24.0): of one lineage source, or of every source the reader sees (the Discovery page),
 * by status – open first. Each proposal says which elements the job reads and writes (others counted, datasets outside
 * the catalogue named on hover), its last run and why the reader cannot accept it, if they cannot.
 */
export function ProposalInbox({ sourceId, sources }: { sourceId?: string; sources?: { id: string; name: string }[] }) {
  const { t } = useTranslation(['dataLineage', 'dataProductViews', 'common']);
  const [status, setStatus] = useState<DataLineageProposalStatus>('open');
  // four statuses do not fit beside each other on a phone ("Bereits dokumentiert"): one below the other there
  const narrow = useMediaQuery('(max-width: 40em)') ?? false;
  const [source, setSource] = useState<string | null>(null);
  const q = useProposals({ status, sourceId: sourceId ?? source ?? undefined });
  const invalidate = useInvalidateDataProducts();
  const [accepting, setAccepting] = useState<DataLineageProposal | null>(null);
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const reject = async (p: DataLineageProposal) => {
    if (!(await confirmDanger({ action: 'confirm', message: t('proposals.rejectConfirm', { name: p.name }), confirmLabel: t('proposals.reject') }))) return;
    try {
      await post(`/data-products/lineage-proposals/${enc(p.id)}/reject`);
      notifyOk(t('proposals.rejected'));
      invalidate();
    } catch (e) {
      notifyError(e, t('proposals.notDecided'));
    }
  };
  const job = (p: DataLineageProposal) => (
    <Stack gap={2}>
      <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
        {p.name}
      </Text>
      <Group gap={4} wrap="wrap">
        <Badge size="xs" variant="outline" color="gray" tt="none">
          {p.tool}
        </Badge>
        {!sourceId && (
          <Text size="xs" c="dimmed">
            {p.sourceName}
          </Text>
        )}
      </Group>
      {p.key !== p.name && (
        <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
          {p.key}
        </Text>
      )}
      {p.changed && (
        <Group gap={4} wrap="nowrap">
          <IconAlertTriangle size={12} aria-hidden style={{ color: 'var(--mantine-color-orange-text)' }} />
          <Text size="xs" c="orange">
            {t('proposals.changed')}
          </Text>
        </Group>
      )}
      {p.status === 'documented' && (
        <Text size="xs" c="dimmed">
          {t('proposals.documentedBy')}
        </Text>
      )}
      {p.decidedBy && p.decidedAt && (
        <Text size="xs" c="dimmed">
          {t('proposals.decided', { status: t(`proposals.statuses.${p.status}`), by: p.decidedBy, when: fmtRelative(p.decidedAt) })}
        </Text>
      )}
    </Stack>
  );
  const reads = (p: DataLineageProposal) => (
    <Ends ends={p.inputs} hidden={p.hiddenInputs} unmatched={p.unmatchedInputs} unmatchedCount={p.unmatchedInputCount} />
  );
  const writes = (p: DataLineageProposal) => (
    <Ends ends={p.outputs} hidden={p.hiddenOutputs} unmatched={p.unmatchedOutputs} unmatchedCount={p.unmatchedOutputCount} />
  );
  const actions = (p: DataLineageProposal) =>
    p.canAccept || p.canReject ? (
      <Group gap={4} wrap="nowrap">
        {p.canAccept && (
          <Button
            size="compact-xs"
            leftSection={<IconCheck size={12} />}
            onClick={() => setAccepting(p)}
            aria-label={t('proposals.acceptNamed', { name: p.name })}
            data-testid="proposal-accept"
          >
            {t('proposals.accept')}
          </Button>
        )}
        {p.canReject && (
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconX size={12} />}
            onClick={() => void reject(p)}
            aria-label={t('proposals.rejectNamed', { name: p.name })}
            data-testid="proposal-reject"
          >
            {t('proposals.reject')}
          </Button>
        )}
      </Group>
    ) : p.status === 'open' && p.cannotAccept ? (
      <Text size="xs" c="dimmed" maw={220}>
        {t(`proposals.cannot.${p.cannotAccept}`)}
      </Text>
    ) : null;
  return (
    <Stack gap="sm" data-testid="proposal-inbox">
      <Group gap="sm" wrap="wrap" align="flex-end">
        <SegmentedControl
          size="xs"
          aria-label={t('proposals.statusFilter')}
          data={DATA_LINEAGE_PROPOSAL_STATUSES.map((s) => ({ value: s, label: t(`proposals.statuses.${s}`) }))}
          value={status}
          onChange={(s) => setStatus(s as DataLineageProposalStatus)}
          orientation={narrow ? 'vertical' : 'horizontal'}
          fullWidth={narrow}
          w={narrow ? '100%' : undefined}
          data-testid="proposal-status"
        />
        {!sourceId && sources && sources.length > 1 && (
          <Select
            size="xs"
            aria-label={t('proposals.source')}
            placeholder={t('proposals.allSources')}
            data={sources.map((s) => ({ value: s.id, label: s.name }))}
            value={source}
            onChange={setSource}
            clearable
            w={220}
          />
        )}
      </Group>
      <QueryState query={q} rows={2} />
      {q.isSuccess && !rows.length && (
        <Text size="sm" c="dimmed" data-testid="proposal-empty">
          {t(`proposals.empty.${status}`)}
        </Text>
      )}
      {rows.length > 0 && (
        <DataTable
          testId="proposal-table"
          ariaLabel={t('proposals.title')}
          rows={rows}
          rowKey={(p) => p.id}
          card={(p) => (
            <Paper withBorder p="sm" component="article" aria-label={p.name} data-testid="proposal-card">
              <Stack gap={6}>
                {job(p)}
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  <IconGitBranch size={14} aria-hidden style={{ flex: 'none', marginTop: 3 }} />
                  <Stack gap={4} style={{ minWidth: 0 }}>
                    <Text size="xs" c="dimmed">
                      {t('proposals.reads')}
                    </Text>
                    {reads(p)}
                    <Text size="xs" c="dimmed">
                      {t('proposals.writes')}
                    </Text>
                    {writes(p)}
                  </Stack>
                </Group>
                <RunBadge run={p.lastRun} />
                {actions(p)}
              </Stack>
            </Paper>
          )}
          columns={[
            { key: 'job', header: t('proposals.job'), sortValue: (p) => p.name, cell: job },
            { key: 'reads', header: t('proposals.reads'), cell: reads },
            { key: 'writes', header: t('proposals.writes'), cell: writes },
            { key: 'run', header: t('proposals.lastRun'), sortValue: (p) => p.lastRun?.at ?? '', cell: (p) => <RunBadge run={p.lastRun} /> },
            { key: 'actions', header: t('proposals.actions'), cell: actions },
          ]}
        />
      )}
      {q.hasNextPage && (
        <Group>
          <Button size="xs" variant="default" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
            {t('proposals.loadMore')}
          </Button>
        </Group>
      )}
      {accepting && (
        <AcceptModal
          p={accepting}
          onClose={() => setAccepting(null)}
          onDone={() => {
            setAccepting(null);
            invalidate();
          }}
        />
      )}
    </Stack>
  );
}

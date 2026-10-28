import { useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, SegmentedControl, Stack, Switch, Table, Text, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconBrandGit, IconCheck, IconExternalLink, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SYNC_RETENTION_DAYS, type ProcessDefinition, type SyncKind, type SyncUpdate, type SyncUpdateDetail, type SyncUpdateStatus } from '@sm/shared';
import { PlatformChoices, chosenPlatforms, platformsComplete } from '../components/monitors/PlatformChoices';
import { get, notifyError, notifyOk, post } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE } from '../components/common';
import { SummaryView, summarize, UnifiedDiff } from '../components/editor/VersionDiff';
import { fmtDate, fmtRelative } from '../format';

const FILTERS: Record<'open' | 'invalid' | 'decided', SyncUpdateStatus[]> = {
  open: ['pending'],
  invalid: ['invalid'],
  decided: ['accepted', 'rejected', 'superseded'],
};
const STATUS_COLOR: Record<SyncUpdateStatus, string> = {
  pending: TONE.person,
  accepted: TONE.ok,
  rejected: TONE.neutral,
  superseded: TONE.neutral,
  invalid: TONE.bad,
};

/** Where the local item of an update lives in the UI. */
export function itemLink(kind: SyncKind | null, id: string | null): string | null {
  if (!kind || !id) return null;
  if (kind === 'process') return `/processes/${encodeURIComponent(id)}`;
  if (kind === 'dashboard') return `/dashboards/${encodeURIComponent(id)}`;
  if (kind === 'monitor') return `/monitors/${encodeURIComponent(id)}`;
  return '/records/types';
}

function UpdateBadges({ u }: { u: SyncUpdate }) {
  const { t } = useTranslation('gitSync');
  return (
    <Group gap={4} wrap="wrap">
      {u.status === 'pending' ? (
        <Badge size="sm" variant="light" color={u.action === 'create' ? TONE.ok : TONE.active}>
          {u.action === 'create' ? t('updates.new') : t('updates.change')}
        </Badge>
      ) : (
        <Badge size="sm" variant="light" color={STATUS_COLOR[u.status]}>
          {t(`updates.status.${u.status}`)}
        </Badge>
      )}
      {u.conflict && u.status === 'pending' && (
        <Badge size="sm" variant="light" color={TONE.attention}>
          {t('updates.conflict')}
        </Badge>
      )}
    </Group>
  );
}

/** "Updates from Git": the inbox of staged changes. */
export function GitUpdatesPage() {
  const { t } = useTranslation(['gitSync', 'common']);
  const { caps } = useMe();
  const [params] = useSearchParams();
  const source = params.get('source') ?? undefined;
  const [filter, setFilter] = useState<keyof typeof FILTERS>('open');
  const list = useQuery({
    queryKey: ['sync-updates', filter, source],
    queryFn: () => get<SyncUpdate[]>(`/sync-updates?status=${FILTERS[filter].join(',')}${source ? `&sourceId=${encodeURIComponent(source)}` : ''}`),
    enabled: caps.createProcesses,
  });
  if (!caps.createProcesses) return <PageHeader title={t('updates.title')} description={t('updates.noAccess')} />;
  return (
    <>
      <PageHeader title={t('updates.title')} description={t('updates.description')} />
      <Group mb="sm">
        <SegmentedControl
          aria-label={t('updates.filter')}
          value={filter}
          onChange={(v) => setFilter(v as keyof typeof FILTERS)}
          data={(Object.keys(FILTERS) as (keyof typeof FILTERS)[]).map((k) => ({ value: k, label: t(`updates.filters.${k}`) }))}
        />
      </Group>
      <QueryState query={list} />
      {list.data?.length === 0 && (
        <EmptyState icon={IconBrandGit} title={t('updates.empty')}>
          {t('updates.emptyHint')}
        </EmptyState>
      )}
      {!!list.data?.length && (
        <Table.ScrollContainer minWidth={640}>
          <Table striped highlightOnHover verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('updates.item')}</Table.Th>
                <Table.Th>{t('updates.file')}</Table.Th>
                <Table.Th>{t('updates.source')}</Table.Th>
                <Table.Th>{t('updates.fetched')}</Table.Th>
                <Table.Th>{t('updates.state')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.data.map((u) => (
                <Table.Tr key={u.id} data-testid="sync-update">
                  <Table.Td>
                    <Anchor size="sm" component={Link} to={`/git-updates/${u.id}`} fw={500}>
                      {u.entityName ?? u.path.split('/').pop()}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {u.kind ? t(`form.kind.${u.kind}`) : t('updates.invalid')}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {u.path}
                    </Text>
                    <Text size="xs" c="dimmed" className="mono">
                      {u.commit.slice(0, 10)}
                    </Text>
                  </Table.Td>
                  <Table.Td>{u.sourceName}</Table.Td>
                  <Table.Td title={fmtDate(u.createdAt)}>{fmtRelative(u.createdAt)}</Table.Td>
                  <Table.Td>
                    <UpdateBadges u={u} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </>
  );
}

/** One update: what changes (diff against the item in Steward), and the decision. */
export function GitUpdateDetailPage() {
  const { t } = useTranslation(['gitSync', 'common']);
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['sync-updates', 'detail', id], queryFn: () => get<SyncUpdateDetail>(`/sync-updates/${encodeURIComponent(id)}`) });
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [context, setContext] = useState(true);
  // monitors: the platform chosen for each platform name in the file
  const [platformChoices, setPlatformChoices] = useState<Record<string, string>>({});
  const u = q.data;
  const summary = useMemo(
    () =>
      u?.kind === 'process' && u.currentDefinition && u.incomingDefinition
        ? summarize(u.currentDefinition as ProcessDefinition, u.incomingDefinition as ProcessDefinition)
        : null,
    [u],
  );
  if (!u) return <QueryState query={q} />;
  const kindLabel = u.kind ? t(`form.kind.${u.kind}`) : t('updates.invalid');
  const name = u.entityName ?? u.path.split('/').pop()!;
  const decide = async (what: 'accept' | 'reject', force = false) => {
    setBusy(true);
    try {
      const platforms = what === 'accept' && u.platforms?.length ? chosenPlatforms(u.platforms, platformChoices) : undefined;
      const r = await post<SyncUpdate>(`/sync-updates/${u.id}/${what}`, {
        comment: comment.trim() || undefined,
        ...(force ? { force: true } : {}),
        ...(platforms ? { platforms } : {}),
      });
      notifyOk(what === 'accept' ? (r.resultVersion ? t('detail.acceptedVersion', { version: r.resultVersion }) : t('detail.accepted')) : t('detail.rejected'));
      void qc.invalidateQueries({ queryKey: ['sync-updates'] });
      void qc.invalidateQueries({ queryKey: ['sync-origins'] });
      void qc.invalidateQueries({ queryKey: ['sync-sources'] });
      const link = what === 'accept' ? itemLink(r.kind, r.entityId) : null;
      if (link && r.kind === 'process') navigate(link);
      else void q.refetch();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const link = itemLink(u.kind, u.entityId);
  return (
    <>
      <PageHeader
        back={[{ to: '/git-updates', label: t('updates.title') }]}
        title={
          <Group gap="xs" wrap="wrap">
            <span>{t('detail.title', { name })}</span>
            <UpdateBadges u={u} />
          </Group>
        }
        description={
          <Group gap="xs" wrap="wrap">
            <span>{u.action === 'create' ? t('detail.actionCreate', { kind: kindLabel }) : t('detail.actionUpdate', { kind: kindLabel })}</span>
            <span>·</span>
            <span className="mono">{t('detail.origin', { path: u.path, sha: u.commit.slice(0, 10) })}</span>
            {u.commitVerified !== null && (
              <Badge size="xs" variant="light" color={u.commitVerified ? TONE.ok : TONE.neutral}>
                {u.commitVerified ? t('detail.verified') : t('detail.notVerified')}
              </Badge>
            )}
          </Group>
        }
        actions={
          <>
            {u.webUrl && (
              <Button
                component="a"
                href={u.webUrl}
                target="_blank"
                rel="noopener noreferrer"
                variant="default"
                size="xs"
                leftSection={<IconExternalLink size={14} />}
              >
                {t('detail.openInGit')}
              </Button>
            )}
            {link && u.entityId && (
              <Button component={Link} to={link} variant="default" size="xs">
                {t('detail.openItem')}
              </Button>
            )}
          </>
        }
      />
      <Stack maw={1100} gap="sm">
        {u.status === 'invalid' && (
          <Alert color="red" title={t('detail.errorsTitle')}>
            <Stack gap={2}>
              {u.errors.map((e, i) => (
                <Text key={i} size="sm">
                  {e}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        {u.status === 'pending' && u.conflict && (
          <Alert color="orange" title={t('detail.conflictTitle')}>
            {t('detail.conflictText', { reason: u.conflictReason ? t(`detail.conflictReasons.${u.conflictReason}`) : '' })}
          </Alert>
        )}
        {u.decidedBy && u.decidedAt && (
          <Text size="sm" c="dimmed">
            {t('detail.decided', { status: t(`updates.status.${u.status}`), by: u.decidedBy, when: fmtRelative(u.decidedAt) })}
            {u.comment ? ` – ${u.comment}` : ''}
          </Text>
        )}
        {u.status !== 'invalid' && (
          <>
            {summary && (
              <Paper withBorder p="xs">
                <SummaryView s={summary} />
              </Paper>
            )}
            {u.contentRemoved ? (
              <Text size="sm" c="dimmed">
                {t('detail.contentRemoved', { days: SYNC_RETENTION_DAYS })}
              </Text>
            ) : u.currentText === null ? (
              <Text size="sm">{t('detail.newItem')}</Text>
            ) : u.currentText === u.incomingText ? (
              <Text size="sm">{t('detail.noChanges')}</Text>
            ) : (
              <Switch size="xs" label={t('detail.contextOnly')} checked={context} onChange={(e) => setContext(e.currentTarget.checked)} />
            )}
            {!u.contentRemoved && (
              <UnifiedDiff
                oldText={u.currentText ?? ''}
                newText={u.incomingText}
                oldName={t('detail.local')}
                newName={t('detail.incoming')}
                context={u.currentText === null || !context ? 100000 : 3}
              />
            )}
          </>
        )}
        {(u.status === 'pending' || u.status === 'invalid') && (
          <Paper withBorder p="sm">
            {u.status === 'pending' && !u.canDecide ? (
              <Text size="sm" c="dimmed">
                {t('detail.cannotDecide')}
              </Text>
            ) : (
              <Stack gap="xs">
                {u.status === 'pending' && u.platforms?.length ? (
                  <PlatformChoices refs={u.platforms} choices={platformChoices} onChange={setPlatformChoices} />
                ) : null}
                <Textarea
                  label={t('detail.comment')}
                  value={comment}
                  onChange={(e) => setComment(e.currentTarget.value)}
                  autosize
                  minRows={2}
                  maxLength={2000}
                />
                <Group gap="xs">
                  {u.status === 'pending' && (
                    <Button
                      leftSection={<IconCheck size={16} />}
                      color={u.conflict ? 'orange' : undefined}
                      loading={busy}
                      disabled={!!u.platforms?.length && !platformsComplete(u.platforms, platformChoices)}
                      onClick={() => decide('accept', u.conflict)}
                    >
                      {u.conflict ? t('detail.acceptAnyway') : t('detail.accept')}
                    </Button>
                  )}
                  <Button variant="default" leftSection={<IconX size={16} />} loading={busy} onClick={() => decide('reject')}>
                    {t('detail.reject')}
                  </Button>
                </Group>
              </Stack>
            )}
          </Paper>
        )}
      </Stack>
    </>
  );
}

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, Anchor, Badge, Button, Code, Group, Modal, Paper, Radio, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconAlertTriangle, IconArrowBackUp, IconCheck, IconCopy, IconPencil, IconSend, IconTrash, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantChangeConflict, PlantChangeEntryDiff, PlantChangeOperation, PlantChangeSetDetail, PlantChangeSetPreview } from '@sm/shared';
import { del, get, notifyError, notifyOk, patch, post } from '../api';
import { fmtDate, fmtRelative } from '../format';
import { plantKeys } from '../queryKeys';
import { DetailState } from '../components/common';
import { DetailHeader } from '../components/page/DetailPage';
import { CollapsibleSection } from '../components/page/CollapsibleSection';
import { PreviewBadge } from '../components/plant/common';
import { FieldDiffs } from '../components/plant/changes';
import { showValue } from '../components/plant/changes/EntryConflictDialog';
import { SourceBadge, StateBadge, useKindName } from '../components/plant/changes/common';

const ACTIONS = ['change', 'add', 'rename', 'remove'] as const;
const ACTION_COLOR = { add: 'green', change: 'blue', remove: 'red', rename: 'violet' } as const;

/**
 * The review page of a plant change set (0.13.0, ADR 0020 §5): what applying it now would do, grouped into added,
 * changed, renamed and removed entries, field by field; when something changed in Steward since, the conflicts first
 * with three columns – _When drafted_, _Now in Steward_, _This change_ – and a choice each. _Propose_, _Apply_ (with the
 * fingerprint of the preview shown), _Reject_ with a comment, _Back to the author_, _Withdraw_, _Revert_, _Copy_.
 * Keyboard: every action is a button in reading order; a conflict is a radio group with its field path as legend;
 * `[` and `]` move between conflicts; a new preview is announced.
 */
export function PlantChangeSetPage() {
  const { t } = useTranslation(['plantChanges', 'common']);
  const { changeSetId } = useParams();
  const id = changeSetId ?? '';
  const qc = useQueryClient();
  const navigate = useNavigate();
  const kindName = useKindName();
  const detail = useQuery({ queryKey: plantKeys.changeSet(id), queryFn: () => get<PlantChangeSetDetail>(`/plant/change-sets/${encodeURIComponent(id)}`) });
  const d = detail.data;
  const open = d?.state === 'draft' || d?.state === 'proposed';
  const preview = useQuery({
    queryKey: plantKeys.changeSetPreview(id),
    queryFn: () => post<PlantChangeSetPreview>(`/plant/change-sets/${encodeURIComponent(id)}/preview`, {}),
    enabled: !!d && open && d.operationCount > 0,
  });
  const [announce, setAnnounce] = useState('');
  const [rejecting, setRejecting] = useState<'reject' | 'return' | null>(null);
  const [comment, setComment] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const conflictsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (preview.isSuccess) setAnnounce(t('detail.previewReady', { count: preview.data.entries.length, conflicts: preview.data.conflicts.length }));
  }, [preview.isSuccess, preview.dataUpdatedAt, preview.data, t]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: plantKeys.changeSet(id) });
    void qc.invalidateQueries({ queryKey: plantKeys.changeSetPreview(id) });
    void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
    void qc.invalidateQueries({ queryKey: plantKeys.config });
    void qc.invalidateQueries({ queryKey: ['plant', 'open-changes'] });
  };
  const act = useMutation({
    mutationFn: async (a: { what: string; body?: unknown }) => {
      const base = `/plant/change-sets/${encodeURIComponent(id)}`;
      if (a.what === 'title') return patch<PlantChangeSetDetail>(base, a.body);
      if (a.what === 'current') return patch<PlantChangeSetDetail>(base, { current: true });
      return post<PlantChangeSetDetail>(`${base}/${a.what}`, a.body ?? {});
    },
    onSuccess: (r, a) => {
      refresh();
      if (a.what === 'apply') {
        void qc.invalidateQueries({ queryKey: plantKeys.all });
        notifyOk(t('detail.applied'));
      }
      if ((a.what === 'revert' || a.what === 'copy') && r.id !== id) navigate(`/plant/changes/${encodeURIComponent(r.id)}`);
      setRejecting(null);
      setRenaming(false);
    },
    onError: (e) => {
      refresh();
      notifyError(e);
    },
  });
  const removeOp = useMutation({
    mutationFn: (seq: number) => del(`/plant/change-sets/${encodeURIComponent(id)}/operations/${seq}`),
    onSuccess: refresh,
    onError: (e) => notifyError(e),
  });
  if (!d) return <DetailState query={detail} back="plantChanges" />;
  const p = preview.data;
  const entries = p?.entries ?? d.applied ?? [];
  const conflicts = p?.conflicts ?? [];
  const resolve = (c: PlantChangeConflict, choice: 'mine' | 'theirs') =>
    act.mutate({ what: 'resolve', body: { choices: [{ seq: c.seq, path: c.path, choice }] } });
  // [ and ] move between the conflicts
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== '[' && e.key !== ']') return;
    const groups = [...(conflictsRef.current?.querySelectorAll<HTMLElement>('[data-conflict]') ?? [])];
    if (!groups.length) return;
    const at = groups.findIndex((g) => g.contains(document.activeElement));
    const next = e.key === ']' ? (at + 1) % groups.length : (at - 1 + groups.length) % groups.length;
    groups[next]?.querySelector<HTMLInputElement>('input')?.focus();
    e.preventDefault();
  };
  return (
    <div onKeyDown={onKeyDown}>
      <DetailHeader
        back="plantChanges"
        title={d.title}
        status={
          <>
            <StateBadge state={d.state} size="md" />
            <SourceBadge source={d.source} />
            {d.review && (
              <Badge variant="light" color="orange">
                {t('detail.review')}
              </Badge>
            )}
            <PreviewBadge />
          </>
        }
        description={
          <Stack gap={2}>
            <Text size="sm">
              {t('detail.by', { by: d.authors.join(', '), when: fmtRelative(d.createdAt) })}
              {d.decidedBy &&
                ` · ${t(`detail.decided.${d.state === 'applied' ? 'applied' : 'other'}`, { by: d.decidedBy, when: d.decidedAt ? fmtDate(d.decidedAt) : '' })}`}
            </Text>
            {(d.sites.length > 0 || d.catalogue) && (
              <Text size="sm" c="dimmed">
                {t('detail.where', { sites: [...d.sites, ...(d.catalogue ? [t('list.catalogue')] : [])].join(', ') })}
              </Text>
            )}
            {d.mcpRequestId && (
              <Anchor component={Link} to={`/mcp-requests?request=${encodeURIComponent(d.mcpRequestId)}`} size="sm">
                {t('detail.request')}
              </Anchor>
            )}
            {d.reverts && (
              <Anchor component={Link} to={`/plant/changes/${encodeURIComponent(d.reverts)}`} size="sm">
                {t('detail.reverts')}
              </Anchor>
            )}
          </Stack>
        }
        actions={
          <Group gap="xs" wrap="wrap">
            {d.canPropose && (
              <Button
                size="xs"
                leftSection={<IconSend size={14} aria-hidden />}
                onClick={() => act.mutate({ what: 'propose' })}
                loading={act.isPending && act.variables?.what === 'propose'}
                data-testid="cs-propose"
              >
                {t('detail.propose')}
              </Button>
            )}
            {d.canApply && p && (
              <Button
                size="xs"
                color="green"
                leftSection={<IconCheck size={14} aria-hidden />}
                disabled={!p.ok}
                onClick={() => act.mutate({ what: 'apply', body: { fingerprint: p.fingerprint } })}
                loading={act.isPending && act.variables?.what === 'apply'}
                data-testid="cs-apply"
              >
                {t('detail.apply')}
              </Button>
            )}
            {d.canReject && (
              <Button
                size="xs"
                variant="default"
                color="red"
                leftSection={<IconX size={14} aria-hidden />}
                onClick={() => setRejecting('reject')}
                data-testid="cs-reject"
              >
                {t('detail.reject')}
              </Button>
            )}
            {d.canReturn && (
              <Button size="xs" variant="default" onClick={() => setRejecting('return')} data-testid="cs-return">
                {t('detail.return')}
              </Button>
            )}
            {d.canEdit && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconPencil size={14} aria-hidden />}
                onClick={() => {
                  setTitle(d.title);
                  setRenaming(true);
                }}
              >
                {t('detail.rename')}
              </Button>
            )}
            {d.canWithdraw && (
              <Button size="xs" variant="default" onClick={() => act.mutate({ what: 'withdraw' })} data-testid="cs-withdraw">
                {t('detail.withdraw')}
              </Button>
            )}
            {d.canRevert && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconArrowBackUp size={14} aria-hidden />}
                onClick={() => act.mutate({ what: 'revert' })}
                data-testid="cs-revert"
              >
                {t('detail.revert')}
              </Button>
            )}
            {d.canCopy && (
              <Button size="xs" variant="default" leftSection={<IconCopy size={14} aria-hidden />} onClick={() => act.mutate({ what: 'copy' })}>
                {t('detail.copy')}
              </Button>
            )}
          </Group>
        }
      />
      <div aria-live="polite" className="visually-hidden" data-testid="cs-announce">
        {announce}
      </div>
      <Stack gap="md">
        {d.comment && (
          <Alert variant="light" color={d.state === 'rejected' ? 'red' : 'blue'} title={t('detail.comment')}>
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
              {d.comment}
            </Text>
          </Alert>
        )}
        {open && p?.applyBlocked && d.state === 'proposed' && (
          <Alert variant="light" color="gray" data-testid="cs-blocked">
            {t(`blocked.${p.applyBlocked.code}`, { defaultValue: p.applyBlocked.message })}
          </Alert>
        )}
        {open && p && p.stepUp && (
          <Text size="sm" c="dimmed">
            {t('detail.stepUp')}
          </Text>
        )}
        {preview.isLoading && (
          <Text size="sm" c="dimmed">
            {t('detail.previewing')}
          </Text>
        )}
        {p && p.problems.length > 0 && (
          <Alert variant="light" color="orange" icon={<IconAlertTriangle size={16} aria-hidden />} title={t('detail.problems')} data-testid="cs-problems">
            <Stack gap={2}>
              {p.problems.map((x, i) => (
                <Text key={i} size="sm">
                  {x.seq ? `${t('detail.change', { seq: x.seq })}: ` : ''}
                  {x.message}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}
        {conflicts.length > 0 && (
          <CollapsibleSection id="cs-conflicts" title={t('conflict.title')} count={conflicts.length} tone="warning" forceOpen>
            <Text size="sm" mb="xs">
              {t('conflict.intro')}
            </Text>
            <Stack gap="sm" ref={conflictsRef} data-testid="cs-conflicts">
              {conflicts.map((c) => (
                <Paper key={`${c.seq}:${c.path}`} withBorder p="sm" data-conflict>
                  <Radio.Group
                    label={
                      <Text component="span" fw={600} className="mono">
                        {t('conflict.legend', { seq: c.seq, path: c.path })}
                      </Text>
                    }
                    value={c.choice ?? ''}
                    onChange={(v) => resolve(c, v as 'mine' | 'theirs')}
                    data-testid={`cs-conflict-${c.path}`}
                  >
                    <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="xs" mt={4}>
                      <div>
                        <Text size="xs" c="dimmed">
                          {t('conflict.drafted')}
                        </Text>
                        <Code block fz="xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {showValue(c.base)}
                        </Code>
                      </div>
                      <div>
                        <Radio value="theirs" label={t('conflict.now')} disabled={!d.canEdit && !d.canApply} />
                        <Code block fz="xs" mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {showValue(c.theirs)}
                        </Code>
                      </div>
                      <div>
                        <Radio value="mine" label={t('conflict.this')} disabled={!d.canEdit && !d.canApply} />
                        <Code block fz="xs" mt={4} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                          {showValue(c.mine)}
                        </Code>
                      </div>
                    </SimpleGrid>
                  </Radio.Group>
                </Paper>
              ))}
            </Stack>
          </CollapsibleSection>
        )}
        {ACTIONS.map((a) => {
          const list = entries.filter((e) => e.action === a);
          if (!list.length) return null;
          return (
            <CollapsibleSection key={a} id={`cs-${a}`} title={t(`groups.${a}`)} count={list.length}>
              <Stack gap="xs" component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }} data-testid={`cs-group-${a}`}>
                {list.map((e) => (
                  <EntryCard key={`${e.kind}:${e.scope}:${e.id}`} e={e} kindName={kindName} />
                ))}
              </Stack>
            </CollapsibleSection>
          );
        })}
        {p && p.hidden > 0 && (
          <Text size="sm" c="dimmed">
            {t('detail.hidden', { count: p.hidden })}
          </Text>
        )}
        <CollapsibleSection id="cs-operations" title={t('detail.operations')} count={d.operations.length} defaultOpen={d.state === 'draft'}>
          <Stack gap="xs" data-testid="cs-operations">
            {d.operations.map((o) => (
              <OperationRow key={o.seq} o={o} kindName={kindName} canRemove={d.canEdit} onRemove={() => removeOp.mutate(o.seq)} />
            ))}
            {d.hiddenOperations > 0 && (
              <Text size="sm" c="dimmed">
                {t('detail.hiddenOps', { count: d.hiddenOperations })}
              </Text>
            )}
          </Stack>
        </CollapsibleSection>
      </Stack>
      <Modal
        opened={!!rejecting}
        onClose={() => setRejecting(null)}
        title={rejecting === 'return' ? t('detail.return') : t('detail.reject')}
        closeButtonProps={{ 'aria-label': t('common:close') }}
      >
        <Stack gap="sm">
          <Textarea
            label={t('detail.commentLabel')}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={3}
            maxLength={2000}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRejecting(null)}>
              {t('common:cancel')}
            </Button>
            <Button
              color={rejecting === 'reject' ? 'red' : undefined}
              onClick={() => act.mutate({ what: rejecting!, body: { comment } })}
              data-testid="cs-decide-confirm"
            >
              {rejecting === 'return' ? t('detail.return') : t('detail.reject')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={renaming} onClose={() => setRenaming(false)} title={t('detail.rename')} closeButtonProps={{ 'aria-label': t('common:close') }}>
        <Stack gap="sm">
          <TextInput label={t('list.title')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={200} data-autofocus />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setRenaming(false)}>
              {t('common:cancel')}
            </Button>
            <Button onClick={() => act.mutate({ what: 'title', body: { title: title.trim() } })} disabled={!title.trim()}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </div>
  );
}

function EntryCard({ e, kindName }: { e: PlantChangeEntryDiff; kindName: (k: string) => string }) {
  const { t } = useTranslation('plantChanges');
  return (
    <Paper withBorder p="sm" component="li" data-testid="cs-entry">
      <Group gap="xs" wrap="wrap">
        <Badge size="sm" variant="light" color={ACTION_COLOR[e.action]}>
          {t(`actions.${e.action}`)}
        </Badge>
        <Text size="xs" c="dimmed">
          {kindName(e.kind)}
        </Text>
        {e.stale && (
          <Badge size="sm" variant="light" color="orange">
            {t('detail.stale')}
          </Badge>
        )}
      </Group>
      <Text size="sm" mt={4} style={{ overflowWrap: 'anywhere' }}>
        {e.name}
      </Text>
      <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
        {e.scope ? `${e.scope} / ` : ''}
        {e.from ? `${e.from} → ${e.id}` : e.id}
      </Text>
      <FieldDiffs diff={e.diff} open={e.diff.length <= 5} />
    </Paper>
  );
}

function OperationRow({
  o,
  kindName,
  canRemove,
  onRemove,
}: {
  o: PlantChangeOperation;
  kindName: (k: string | null) => string;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation('plantChanges');
  return (
    <Group justify="space-between" gap="xs" wrap="nowrap" data-testid="cs-operation">
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Group gap="xs" wrap="wrap">
          <Text size="xs" c="dimmed">
            {o.seq}.
          </Text>
          <Badge size="xs" variant="default">
            {t(`ops.${o.op}`)}
          </Badge>
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
            {kindName(o.kind)}{' '}
            {o.path ? (
              <Anchor component={Link} to={o.path}>
                {o.name || o.id}
              </Anchor>
            ) : (
              o.name || o.id
            )}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">
          {t('detail.opBy', { by: o.author })}
        </Text>
      </Stack>
      {canRemove && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="red"
          leftSection={<IconTrash size={12} aria-hidden />}
          onClick={onRemove}
          aria-label={t('detail.removeOp', { seq: o.seq })}
        >
          {t('detail.remove')}
        </Button>
      )}
    </Group>
  );
}

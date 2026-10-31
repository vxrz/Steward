import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  MultiSelect,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  TagsInput,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconCheck, IconPlus, IconRefresh, IconSend, IconShieldCheck, IconUserSearch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PERSON_REVIEW_LIMITS, type AccessCheck, type PersonReview, type PersonReviewDecision, type PersonReviewSummary } from '@sm/shared';
import { get, notifyError, post, put } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE, useCreateParam } from '../components/common';
import { fmtDate, fmtRelative } from '../format';

const STATUS_COLOR: Record<PersonReview['status'], string> = { open: TONE.active, submitted: TONE.attention, approved: TONE.ok, closed: TONE.neutral };

function StatusBadge({ status }: { status: PersonReview['status'] }) {
  const { t } = useTranslation('compliance');
  return (
    <Badge color={STATUS_COLOR[status]} variant="light" size="sm">
      {t(`personReviews.status.${status}`)}
    </Badge>
  );
}

/** Compliance → Person reviews (#118): everything one person may do on the platforms, decided right by right. */
export function PersonReviewsPage() {
  const { t } = useTranslation(['compliance', 'common']);
  const { isAdmin, hasRole } = useMe();
  const canCreate = isAdmin || hasRole('designer');
  const [creating, setCreating] = useState(false);
  const reviews = useQuery({ queryKey: ['person-reviews'], queryFn: () => get<PersonReviewSummary[]>('/compliance/person-reviews') });
  useCreateParam(canCreate, () => setCreating(true));
  const list = reviews.data ?? [];
  const newButton = canCreate && (
    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
      {t('personReviews.new')}
    </Button>
  );
  return (
    <>
      <PageHeader title={t('personReviews.title')} description={t('personReviews.description')} actions={newButton} />
      <QueryState query={reviews} />
      {reviews.isSuccess && list.length === 0 && (
        <EmptyState icon={IconUserSearch} title={t('personReviews.emptyTitle')} action={newButton}>
          {t('personReviews.emptyText')}
        </EmptyState>
      )}
      {list.length > 0 && (
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('personReviews.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('personReviews.reviewTitle')}</Table.Th>
                <Table.Th>{t('personReviews.person')}</Table.Th>
                <Table.Th>{t('personReviews.statusLabel')}</Table.Th>
                <Table.Th>{t('personReviews.rights')}</Table.Th>
                <Table.Th>{t('personReviews.started')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {list.map((r) => (
                <Table.Tr key={r.id}>
                  <Table.Td>
                    <Text size="sm" fw={500} component={Link} to={`/compliance/person-reviews/${r.id}`}>
                      {r.title}
                    </Text>
                  </Table.Td>
                  <Table.Td>{r.personName}</Table.Td>
                  <Table.Td>
                    <StatusBadge status={r.status} />
                  </Table.Td>
                  <Table.Td>{t('personReviews.countsLine', { ...r.counts, platforms: r.platforms })}</Table.Td>
                  <Table.Td>
                    {r.createdBy} · {fmtRelative(r.createdAt)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {creating && <NewReviewModal onClose={() => setCreating(false)} />}
    </>
  );
}

function NewReviewModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['compliance', 'common']);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const checks = useQuery({ queryKey: ['access-checks'], queryFn: () => get<AccessCheck[]>('/compliance/access-checks') });
  const [title, setTitle] = useState('');
  const [personUser, setPersonUser] = useState('');
  const [personName, setPersonName] = useState('');
  const [identifiers, setIdentifiers] = useState<string[]>([]);
  const [checkIds, setCheckIds] = useState<string[]>([]);
  const [fourEyes, setFourEyes] = useState(true);
  const [busy, setBusy] = useState(false);
  const suggest = async () => {
    try {
      const r = await get<{ personName: string; identifiers: string[] }>(`/compliance/person-reviews/suggest?user=${encodeURIComponent(personUser.trim())}`);
      if (!personName.trim()) setPersonName(r.personName);
      setIdentifiers((was) => [...new Set([...was, ...r.identifiers])]);
    } catch (e) {
      notifyError(e);
    }
  };
  const ready = title.trim() && personName.trim() && identifiers.length > 0 && checkIds.length > 0;
  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const r = await post<PersonReview>('/compliance/person-reviews', {
        title: title.trim(),
        personUser: personUser.trim() || undefined,
        personName: personName.trim(),
        identifiers,
        checkIds,
        fourEyes,
      });
      await qc.invalidateQueries({ queryKey: ['person-reviews'] });
      navigate(`/compliance/person-reviews/${r.id}`);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('personReviews.new')} size="lg">
      <Stack gap="sm">
        <TextInput
          label={t('personReviews.reviewTitle')}
          placeholder={t('personReviews.titlePlaceholder')}
          required
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          maxLength={PERSON_REVIEW_LIMITS.title}
        />
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <TextInput
            style={{ flex: 1 }}
            label={t('personReviews.personUser')}
            description={t('personReviews.personUserHelp')}
            value={personUser}
            onChange={(e) => setPersonUser(e.currentTarget.value)}
            maxLength={128}
          />
          <Button variant="light" onClick={suggest} disabled={!personUser.trim()} leftSection={<IconUserSearch size={14} />}>
            {t('personReviews.suggest')}
          </Button>
        </Group>
        <TextInput label={t('personReviews.person')} required value={personName} onChange={(e) => setPersonName(e.currentTarget.value)} maxLength={200} />
        <TagsInput
          label={t('personReviews.identifiers')}
          description={t('personReviews.identifiersHelp')}
          required
          value={identifiers}
          onChange={setIdentifiers}
          maxTags={PERSON_REVIEW_LIMITS.identifiers}
          clearable
        />
        <MultiSelect
          label={t('personReviews.checks')}
          description={t('personReviews.checksHelp')}
          required
          searchable
          data={(checks.data ?? []).map((c) => ({ value: c.id, label: c.platformName ? `${c.name} (${c.platformName})` : c.name }))}
          value={checkIds}
          onChange={setCheckIds}
          maxValues={PERSON_REVIEW_LIMITS.checks}
        />
        <Switch
          label={t('personReviews.fourEyes')}
          description={t('personReviews.fourEyesHelp')}
          checked={fourEyes}
          onChange={(e) => setFourEyes(e.currentTarget.checked)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!ready}>
            {t('personReviews.start')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type Draft = Record<string, { decision: PersonReviewDecision | null; comment: string }>;

const draftOf = (r: PersonReview): Draft => Object.fromEntries(r.items.map((i) => [i.id, { decision: i.decision, comment: i.comment }]));

export function PersonReviewDetailPage() {
  const { t } = useTranslation(['compliance', 'common']);
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['person-review', id], queryFn: () => get<PersonReview>(`/compliance/person-reviews/${id}`) });
  const r = q.data;
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [approvalComment, setApprovalComment] = useState('');
  const [seal, setSeal] = useState<boolean | null>(null);
  useEffect(() => {
    if (r) setDraft(draftOf(r));
  }, [r]);
  const changed = useMemo(
    () => (r ? r.items.filter((i) => draft[i.id] && (draft[i.id]!.decision !== i.decision || draft[i.id]!.comment !== i.comment)) : []),
    [r, draft],
  );
  const checkName = (checkId: string) => r?.sources.find((s) => s.checkId === checkId)?.checkName ?? checkId;
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      const next = (await fn()) as PersonReview;
      qc.setQueryData(['person-review', id], next);
      await qc.invalidateQueries({ queryKey: ['person-reviews'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    put<PersonReview>(`/compliance/person-reviews/${id}/decisions`, {
      decisions: changed.map((i) => ({ itemId: i.id, decision: draft[i.id]!.decision, comment: draft[i.id]!.comment })),
    });
  const verify = async () => {
    try {
      setSeal((await get<{ ok: boolean }>(`/compliance/person-reviews/${id}/seal`)).ok);
    } catch (e) {
      notifyError(e);
    }
  };
  const set = (itemId: string, patch: Partial<Draft[string]>) => setDraft((d) => ({ ...d, [itemId]: { ...d[itemId]!, ...patch } }));
  const back = [{ to: '/compliance/person-reviews', label: t('personReviews.title') }];
  if (!r) return <QueryState query={q} />;
  return (
    <>
      <PageHeader
        back={back}
        title={r.title}
        description={
          <Group gap="xs">
            <StatusBadge status={r.status} />
            <span>{t('personReviews.countsLine', { ...r.counts, platforms: r.sources.length })}</span>
          </Group>
        }
        actions={
          <>
            {r.canDecide && (
              <>
                <Button size="xs" variant="default" disabled={!changed.length} loading={busy === 'save'} onClick={() => run('save', save)}>
                  {t('personReviews.save')}
                </Button>
                <Button
                  size="xs"
                  leftSection={<IconSend size={14} />}
                  loading={busy === 'submit'}
                  onClick={() =>
                    run('submit', async () => {
                      if (changed.length) await save();
                      return post(`/compliance/person-reviews/${id}/submit`);
                    })
                  }
                >
                  {r.fourEyes ? t('personReviews.submit') : t('personReviews.submitSeal')}
                </Button>
              </>
            )}
            {r.canRecheck && r.counts.remove > 0 && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconRefresh size={14} />}
                loading={busy === 'recheck'}
                onClick={() => run('recheck', () => post(`/compliance/person-reviews/${id}/recheck`))}
              >
                {t('personReviews.recheck')}
              </Button>
            )}
          </>
        }
      />
      <SimpleGrid cols={{ base: 1, sm: 2 }} mb="md">
        <Paper withBorder p="sm">
          <Text size="sm" fw={600}>
            {r.personName}
            {r.personUser && (
              <Text span size="xs" c="dimmed">
                {' '}
                · {t('personReviews.stewardUser', { user: r.personUser })}
              </Text>
            )}
          </Text>
          <Text size="xs" c="dimmed">
            {t('personReviews.identifiers')}: {r.identifiers.join(', ')}
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            {t('personReviews.startedBy', { user: r.createdBy, when: fmtDate(r.createdAt) })}
          </Text>
          {r.submittedBy && r.submittedAt && (
            <Text size="xs" c="dimmed">
              {t('personReviews.submittedBy', { user: r.submittedBy, when: fmtDate(r.submittedAt) })}
            </Text>
          )}
          {r.approvedBy && r.approvedAt && (
            <Text size="xs" c="dimmed">
              {t('personReviews.approvedBy', { user: r.approvedBy, when: fmtDate(r.approvedAt) })}
              {r.approvalComment && ` – ${r.approvalComment}`}
            </Text>
          )}
          {r.status === 'open' && r.approvalComment && (
            <Alert color="orange" variant="light" mt="xs" p="xs">
              <Text size="xs">{t('personReviews.sentBack', { comment: r.approvalComment })}</Text>
            </Alert>
          )}
          {r.sealHash && (
            <Group gap="xs" mt="xs">
              <Text size="xs" className="mono" title={r.sealHash}>
                {t('personReviews.seal', { hash: r.sealHash.slice(0, 16) })}
              </Text>
              <Button size="compact-xs" variant="subtle" leftSection={<IconShieldCheck size={12} />} onClick={verify}>
                {t('personReviews.verifySeal')}
              </Button>
              {seal !== null && (
                <Badge size="xs" color={seal ? TONE.ok : TONE.bad} variant="light">
                  {seal ? t('personReviews.sealOk') : t('personReviews.sealBroken')}
                </Badge>
              )}
            </Group>
          )}
        </Paper>
        <Paper withBorder p="sm">
          <Text size="sm" fw={600} mb={4}>
            {t('personReviews.sources')}
          </Text>
          <Stack gap={2}>
            {r.sources.map((s) => (
              <Text size="xs" key={s.checkId} c={s.origin === 'failed' ? 'red' : undefined}>
                {s.checkName}
                {s.platformName ? ` (${s.platformName})` : ''}: {t(`personReviews.origin.${s.origin}`, { when: s.readAt ? fmtDate(s.readAt) : '' })} ·{' '}
                {t('personReviews.matched', { count: s.matched })}
                {s.error ? ` – ${s.error}` : ''}
              </Text>
            ))}
          </Stack>
        </Paper>
      </SimpleGrid>
      {r.canApprove && (
        <Paper withBorder p="sm" mb="md">
          <Text size="sm" fw={600}>
            {t('personReviews.approvalTitle')}
          </Text>
          <Textarea
            mt={4}
            label={t('personReviews.approvalComment')}
            description={t('personReviews.approvalCommentHelp')}
            value={approvalComment}
            onChange={(e) => setApprovalComment(e.currentTarget.value)}
            maxLength={PERSON_REVIEW_LIMITS.comment}
            autosize
            minRows={2}
          />
          <Group justify="flex-end" mt="xs">
            <Button
              size="xs"
              variant="default"
              loading={busy === 'back'}
              onClick={() => run('back', () => post(`/compliance/person-reviews/${id}/approval`, { approve: false, comment: approvalComment }))}
            >
              {t('personReviews.sendBack')}
            </Button>
            <Button
              size="xs"
              leftSection={<IconCheck size={14} />}
              loading={busy === 'approve'}
              onClick={() => run('approve', () => post(`/compliance/person-reviews/${id}/approval`, { approve: true, comment: approvalComment }))}
            >
              {t('personReviews.approve')}
            </Button>
          </Group>
        </Paper>
      )}
      {r.items.length === 0 ? (
        <Alert color="gray" variant="light">
          {t('personReviews.noRights')}
        </Alert>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-label={t('personReviews.rights')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('personReviews.check')}</Table.Th>
                <Table.Th>{t('personReviews.account')}</Table.Th>
                <Table.Th>{t('personReviews.right')}</Table.Th>
                <Table.Th>{t('personReviews.decision')}</Table.Th>
                <Table.Th>{t('personReviews.comment')}</Table.Th>
                {r.counts.gone + r.counts.present > 0 && <Table.Th>{t('personReviews.recheckLabel')}</Table.Th>}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {r.items.map((i) => {
                const d = draft[i.id] ?? { decision: i.decision, comment: i.comment };
                return (
                  <Table.Tr key={i.id}>
                    <Table.Td>{checkName(i.checkId)}</Table.Td>
                    <Table.Td>
                      <Text size="sm">{i.subjectName || i.subjectId}</Text>
                      {(i.subjectName && i.subjectName !== i.subjectId) || i.subjectType ? (
                        <Text size="xs" c="dimmed">
                          {[i.subjectName && i.subjectName !== i.subjectId ? i.subjectId : '', i.subjectType ?? ''].filter(Boolean).join(' · ')}
                        </Text>
                      ) : null}
                    </Table.Td>
                    <Table.Td className="mono">{i.right}</Table.Td>
                    <Table.Td>
                      {r.canDecide ? (
                        <SegmentedControl
                          size="xs"
                          aria-label={t('personReviews.decisionFor', { right: i.right })}
                          value={d.decision ?? ''}
                          onChange={(v) => set(i.id, { decision: (v || null) as PersonReviewDecision | null })}
                          data={[
                            { value: '', label: t('personReviews.decisions.open') },
                            { value: 'keep', label: t('personReviews.decisions.keep') },
                            { value: 'remove', label: t('personReviews.decisions.remove') },
                          ]}
                        />
                      ) : (
                        <Badge size="sm" variant="light" color={i.decision === 'remove' ? TONE.bad : i.decision === 'keep' ? TONE.ok : TONE.neutral}>
                          {t(`personReviews.decisions.${i.decision ?? 'open'}`)}
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td miw={200}>
                      {r.canDecide ? (
                        <TextInput
                          size="xs"
                          aria-label={t('personReviews.commentFor', { right: i.right })}
                          placeholder={d.decision === 'remove' ? t('personReviews.commentRequired') : undefined}
                          error={d.decision === 'remove' && !d.comment.trim()}
                          value={d.comment}
                          onChange={(e) => set(i.id, { comment: e.currentTarget.value })}
                          maxLength={PERSON_REVIEW_LIMITS.comment}
                        />
                      ) : (
                        <>
                          <Text size="sm">{i.comment}</Text>
                          {i.decidedBy && (
                            <Text size="xs" c="dimmed">
                              {i.decidedBy}
                            </Text>
                          )}
                        </>
                      )}
                    </Table.Td>
                    {r.counts.gone + r.counts.present > 0 && (
                      <Table.Td>
                        {i.recheck && (
                          <Badge
                            size="sm"
                            variant="light"
                            color={i.recheck === 'gone' ? TONE.ok : TONE.attention}
                            title={i.recheckedAt ? fmtDate(i.recheckedAt) : undefined}
                          >
                            {t(`personReviews.recheckState.${i.recheck}`)}
                          </Badge>
                        )}
                      </Table.Td>
                    )}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </>
  );
}

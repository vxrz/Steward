import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Modal, NumberInput, Paper, Radio, Select, Stack, Switch, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconAlertTriangle, IconCircleCheck, IconEye, IconFileTypePdf, IconGitCompare, IconPencil, IconSettings } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DocumentChangelogRow, EditionKind, RecordDetail, RecordEdition, RecordAttachment, ReviewOutcome, ReviewStatus, Subject } from '@sm/shared';
import { apiUrl, get, getOptional, notifyError, notifyOk, post, put } from '../../api';
import { UnifiedDiff } from '../editor/VersionDiff';
import { MarkdownView } from './MarkdownView';
import { Field } from './common';
import { fieldLabel } from './builtin';
import { fmtDate, fmtDay } from '../../format';
import { currentLanguage } from '../../i18n';

/**
 * Living documents (workflow "document"): the review status, the document changelog (editions and
 * reviews), a frozen edition, the diff between editions, and the review actions and settings.
 */

const REVIEW_COLORS: Record<ReviewStatus, string> = { current: 'green', dueSoon: 'yellow', overdue: 'red', none: 'gray' };

export function ReviewStatusBadge({ status, size = 'sm' }: { status: ReviewStatus; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation('records');
  return (
    <Badge color={REVIEW_COLORS[status]} variant="light" size={size}>
      {t(`document.reviewStatus.${status}`)}
    </Badge>
  );
}

export function EditionBadge({ edition, size = 'sm' }: { edition: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const { t } = useTranslation('records');
  return (
    <Badge color="green" variant="outline" size={size}>
      {t('document.editionShort', { edition })}
    </Badge>
  );
}

/** Submitting a document: minor or major edition and what changed (inside the transition dialog). */
export function EditionFields({
  rec,
  kind,
  onKind,
  summary,
  onSummary,
}: {
  rec: RecordDetail;
  kind: EditionKind | null;
  onKind: (k: EditionKind) => void;
  summary: string;
  onSummary: (s: string) => void;
}) {
  const { t } = useTranslation('records');
  const doc = rec.document!;
  return (
    <>
      {doc.currentEdition ? (
        <Radio.Group label={t('document.kind')} value={kind ?? ''} onChange={(v) => onKind(v as EditionKind)} required>
          <Stack gap={6} mt={4}>
            <Radio value="minor" label={t('document.kindMinor', { edition: doc.nextEdition.minor })} />
            <Radio value="major" label={t('document.kindMajor', { edition: doc.nextEdition.major })} />
          </Stack>
        </Radio.Group>
      ) : (
        <Text size="sm">{t('document.firstEdition')}</Text>
      )}
      <Textarea
        label={t('document.changeSummary')}
        description={t('document.changeSummaryHelp')}
        autosize
        minRows={2}
        value={summary}
        onChange={(e) => onSummary(e.currentTarget.value)}
        required
        maxLength={2000}
      />
    </>
  );
}

const editionText = (e: RecordEdition, typeKey: string) =>
  [
    `# ${e.title}`,
    '',
    ...Object.entries(e.fields).map(([k, x]) => {
      const def = e.fieldDefs.find((f) => f.key === k);
      return `${def ? fieldLabel(typeKey, def) : k}: ${x}`;
    }),
    '',
    e.body,
  ].join('\n');

/** The "Changelog" tab of a living document. */
export function DocumentChangelog({ rec, onChange }: { rec: RecordDetail; onChange: (r?: RecordDetail) => void }) {
  const { t } = useTranslation(['records', 'common']);
  const doc = rec.document!;
  const r = doc.review;
  const log = useQuery({
    queryKey: ['record-changelog', rec.id, rec.updatedAt],
    queryFn: () => get<DocumentChangelogRow[]>(`/records/${rec.id}/changelog`),
  });
  const [viewing, setViewing] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ from: string; to: string } | null>(null);
  const [reviewing, setReviewing] = useState<ReviewOutcome | null>(null);
  const [settings, setSettings] = useState(false);
  const [pdfBusy, setPdfBusy] = useState<string | null>(null);
  // editions oldest first: the previous one of each
  const order = [...doc.editions].reverse().map((e) => e.edition);
  const previous = (e: string) => order[order.indexOf(e) - 1];
  const last = doc.reviews[0];
  const pdf = async (edition: string) => {
    setPdfBusy(edition);
    try {
      const a = await post<RecordAttachment>(`/records/${rec.id}/editions/${edition}/pdf`, {
        lang: ['en', 'de'].includes(currentLanguage()) ? currentLanguage() : 'en',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      notifyOk(t('document.pdfCreated', { file: a.filename }));
      onChange();
    } catch (e) {
      notifyError(e);
    } finally {
      setPdfBusy(null);
    }
  };
  return (
    <Stack gap="lg">
      <Paper withBorder p="sm" data-testid="document-review">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Group gap="xs">
              <Text fw={600}>{t('document.reviewTitle')}</Text>
              <ReviewStatusBadge status={r.status} />
            </Group>
            <Text size="sm">
              {r.nextReviewAt
                ? t('document.nextReview', { date: fmtDay(r.nextReviewAt) })
                : doc.currentEdition
                  ? t('document.noReviewPlanned')
                  : t('document.noEditionYet')}
            </Text>
            <Text size="xs" c="dimmed">
              {t('document.reviewOwner', { owner: r.owner })} ·{' '}
              {r.intervalMonths > 0 ? t('document.interval', { count: r.intervalMonths }) : t('document.noInterval')}
              {last ? ` · ${t('document.lastReview', { date: fmtDay(last.createdAt), reviewer: last.reviewer })}` : ''}
            </Text>
            {r.updateRequestedAt && (
              <Text size="xs" c="orange">
                {t('document.updateRequested', { date: fmtDay(r.updateRequestedAt) })}
              </Text>
            )}
          </Stack>
          <Group gap="xs">
            {doc.permissions.review && !r.updateRequestedAt && (
              <Button size="xs" leftSection={<IconCircleCheck size={14} />} onClick={() => setReviewing('no_change')}>
                {t('document.reviewedNoChange')}
              </Button>
            )}
            {doc.permissions.review && rec.status === 'published' && (
              <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setReviewing('needs_update')}>
                {t('document.needsUpdate')}
              </Button>
            )}
            {doc.permissions.settings && (
              <Button size="xs" variant="default" leftSection={<IconSettings size={14} />} onClick={() => setSettings(true)}>
                {t('document.reviewSettings')}
              </Button>
            )}
          </Group>
        </Group>
      </Paper>
      {doc.pending && (
        <Alert color="blue" variant="light" title={t('document.pendingTitle', { edition: doc.pending.edition })}>
          <Text size="sm">{t(`document.kinds.${doc.pending.kind}`)}</Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {doc.pending.changeSummary}
          </Text>
        </Alert>
      )}
      <Stack gap="xs">
        <Text fw={600}>{t('document.changelog')}</Text>
        {(log.data ?? []).some((row) => !row.intact) && (
          <Alert color="red" icon={<IconAlertTriangle size={16} />} data-testid="changelog-not-intact">
            {t('document.changelogNotIntact')}
          </Alert>
        )}
        {(log.data ?? []).length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('document.noEditions')}
          </Text>
        ) : (
          <div className="table-scroll">
            <Table fz="sm" aria-label={t('document.changelog')} data-testid="document-changelog" style={{ minWidth: 760 }}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('document.edition')}</Table.Th>
                  <Table.Th>{t('document.date')}</Table.Th>
                  <Table.Th>{t('document.people')}</Table.Th>
                  <Table.Th>{t('document.approvedBy')}</Table.Th>
                  <Table.Th>{t('document.summary')}</Table.Th>
                  <Table.Th aria-label={t('document.actions')} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {(log.data ?? []).map((row, i) => (
                  <Table.Tr key={`${row.kind}:${row.edition}:${row.at}:${i}`}>
                    <Table.Td className="nowrap">
                      {row.kind === 'edition' ? (
                        <Group gap={4} wrap="nowrap">
                          <Text size="sm" fw={600}>
                            {row.edition}
                          </Text>
                          <Badge size="xs" variant="default">
                            {t(`document.kinds.${row.editionKind ?? 'major'}`)}
                          </Badge>
                        </Group>
                      ) : (
                        <Badge size="xs" variant="light" color={row.outcome === 'no_change' ? 'green' : 'orange'}>
                          {t(`document.outcomes.${row.outcome ?? 'no_change'}`)}
                        </Badge>
                      )}
                      {!row.intact && (
                        <Badge size="xs" color="red" variant="filled" mt={4} leftSection={<IconAlertTriangle size={10} />}>
                          {t('document.notIntactShort')}
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td className="nowrap">{fmtDate(row.at)}</Table.Td>
                    <Table.Td>{row.people.join(', ') || '–'}</Table.Td>
                    <Table.Td>{row.approvedBy ?? '–'}</Table.Td>
                    <Table.Td style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                      {row.text || (row.kind === 'review' ? t('document.reviewOf', { edition: row.edition ?? '–' }) : '–')}
                    </Table.Td>
                    <Table.Td>
                      {row.kind === 'edition' && row.edition && (
                        <Group gap={4} wrap="nowrap">
                          <Button
                            size="compact-xs"
                            variant="subtle"
                            leftSection={<IconEye size={12} />}
                            onClick={() => setViewing(row.edition)}
                            aria-label={t('document.openNamed', { edition: row.edition })}
                          >
                            {t('document.open')}
                          </Button>
                          {previous(row.edition) && (
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              leftSection={<IconGitCompare size={12} />}
                              onClick={() => setDiff({ from: previous(row.edition!)!, to: row.edition! })}
                              aria-label={t('document.diffNamed', { from: previous(row.edition), to: row.edition })}
                            >
                              {t('document.diff')}
                            </Button>
                          )}
                          {rec.permissions.generatePdf && (
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              leftSection={<IconFileTypePdf size={12} />}
                              loading={pdfBusy === row.edition}
                              onClick={() => void pdf(row.edition!)}
                              aria-label={t('document.pdfNamed', { edition: row.edition })}
                            >
                              {t('document.pdf')}
                            </Button>
                          )}
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Stack>
      {viewing && <EditionModal rec={rec} edition={viewing} onClose={() => setViewing(null)} />}
      {diff && <EditionDiffModal rec={rec} from={diff.from} to={diff.to} onClose={() => setDiff(null)} />}
      {reviewing && <ReviewModal rec={rec} outcome={reviewing} onClose={() => setReviewing(null)} onDone={onChange} />}
      {settings && <ReviewSettingsModal rec={rec} onClose={() => setSettings(false)} onDone={onChange} />}
    </Stack>
  );
}

const useEdition = (rec: RecordDetail, edition: string) =>
  useQuery({ queryKey: ['record-edition', rec.id, edition], queryFn: () => get<RecordEdition>(`/records/${rec.id}/editions/${edition}`), staleTime: Infinity });

function EditionModal({ rec, edition, onClose }: { rec: RecordDetail; edition: string; onClose: () => void }) {
  const { t } = useTranslation(['records', 'common']);
  const q = useEdition(rec, edition);
  const e = q.data;
  return (
    <Modal opened onClose={onClose} title={t('document.editionTitle', { number: rec.number, edition })} size="xl">
      {!e ? (
        <Text size="sm" c="dimmed">
          {q.isError ? t('common:loadFailed') : t('common:loading')}
        </Text>
      ) : (
        <Stack gap="sm">
          {!e.intact && (
            <Alert color="red" icon={<IconAlertTriangle size={16} />}>
              {t('document.notIntact')}
            </Alert>
          )}
          <Text size="sm">
            {t('document.approvedLine', { date: fmtDate(e.approvedAt), approver: e.approvedBy, kind: t(`document.kinds.${e.kind}`) })}
            {e.current ? ` · ${t('document.current')}` : ''}
          </Text>
          <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
            {t('detail.contentHash', { hash: e.contentHash })}
          </Text>
          <Text fw={600}>{e.title}</Text>
          {e.fieldDefs.length > 0 && (
            <Paper withBorder p="sm">
              <Stack gap="xs">
                {e.fieldDefs
                  .filter((f) => e.fields[f.key])
                  .map((f) => (
                    <Field key={f.key} label={fieldLabel(rec.typeKey, f)}>
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                        {e.fields[f.key]}
                      </Text>
                    </Field>
                  ))}
              </Stack>
            </Paper>
          )}
          {e.body.trim() ? (
            <MarkdownView text={e.body} />
          ) : (
            <Text c="dimmed" size="sm">
              {t('detail.noBody')}
            </Text>
          )}
          {e.attachments.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                {t('tabs.attachments', { count: e.attachments.length })}
              </Text>
              {e.attachments.map((a) => (
                <Anchor key={a.id} href={apiUrl(`/records/${rec.id}/attachments/${a.id}/download`)} size="sm">
                  {a.filename}
                </Anchor>
              ))}
            </Stack>
          )}
          <Group justify="flex-end">
            <Button onClick={onClose}>{t('common:close')}</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function EditionDiffModal({ rec, from, to, onClose }: { rec: RecordDetail; from: string; to: string; onClose: () => void }) {
  const { t } = useTranslation(['records', 'common']);
  const a = useEdition(rec, from).data;
  const b = useEdition(rec, to).data;
  const [context, setContext] = useState(true);
  return (
    <Modal opened onClose={onClose} title={t('document.diffTitle', { from, to })} size="xl">
      <Stack gap="sm">
        <Switch size="xs" label={t('versions.contextOnly')} checked={context} onChange={(e) => setContext(e.currentTarget.checked)} />
        {a && b ? (
          editionText(a, rec.typeKey) === editionText(b, rec.typeKey) ? (
            <Text size="sm">{t('versions.same')}</Text>
          ) : (
            <UnifiedDiff
              oldText={editionText(a, rec.typeKey)}
              newText={editionText(b, rec.typeKey)}
              oldName={t('document.editionShort', { edition: from })}
              newName={t('document.editionShort', { edition: to })}
              context={context ? 3 : 100000}
            />
          )
        ) : (
          <Text size="sm" c="dimmed">
            {t('common:loading')}
          </Text>
        )}
        <Group justify="flex-end">
          <Button onClick={onClose}>{t('common:close')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ReviewModal({ rec, outcome, onClose, onDone }: { rec: RecordDetail; outcome: ReviewOutcome; onClose: () => void; onDone: (r: RecordDetail) => void }) {
  const { t } = useTranslation(['records', 'common']);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const needs = outcome === 'needs_update';
  const submit = async () => {
    setBusy(true);
    try {
      onDone(await post<RecordDetail>(`/records/${rec.id}/review`, { outcome, comment: comment.trim() }));
      notifyOk(needs ? t('document.reviewedNeedsUpdate') : t('document.reviewedDone'));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      opened
      onClose={onClose}
      title={t(needs ? 'document.needsUpdateTitle' : 'document.reviewTitleNamed', { number: rec.number, edition: rec.document?.currentEdition ?? '' })}
    >
      <Stack gap="sm">
        <Text size="sm">{needs ? t('document.needsUpdateHelp') : t('document.noChangeHelp')}</Text>
        <Textarea
          label={t('document.reviewComment')}
          description={needs ? t('transition.commentRequired') : t('transition.commentOptional')}
          autosize
          minRows={2}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
          required={needs}
          maxLength={4000}
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={needs && !comment.trim()}>
            {needs ? t('document.needsUpdate') : t('document.reviewedNoChange')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function ReviewSettingsModal({ rec, onClose, onDone }: { rec: RecordDetail; onClose: () => void; onDone: (r: RecordDetail) => void }) {
  const { t } = useTranslation(['records', 'common']);
  const r = rec.document!.review;
  const may = rec.document!.permissions;
  const subjects = useQuery({
    queryKey: ['subjects'],
    queryFn: () => getOptional<Subject[]>('/subjects', []),
    retry: false,
    staleTime: 60000,
    enabled: may.reviewOwner,
  });
  const [owner, setOwner] = useState<string | null>(r.ownerOverride);
  const [months, setMonths] = useState<number | ''>(r.intervalOverride ?? '');
  const [next, setNext] = useState(r.nextReviewOverride ? r.nextReviewOverride.slice(0, 10) : '');
  const [busy, setBusy] = useState(false);
  const users = (subjects.data ?? []).filter((s) => s.kind === 'user').map((s) => ({ value: s.value.slice(5), label: s.label }));
  if (owner && !users.some((u) => u.value.toLowerCase() === owner.toLowerCase())) users.unshift({ value: owner, label: owner });
  const today = new Date().toISOString().slice(0, 10);
  const submit = async () => {
    setBusy(true);
    try {
      onDone(
        // only what this user may change (the server checks it again)
        await put<RecordDetail>(`/records/${rec.id}/review-settings`, {
          ...(may.reviewOwner ? { reviewOwner: owner || null } : {}),
          ...(may.reviewInterval ? { intervalMonths: months === '' ? null : months } : {}),
          nextReviewAt: next || null,
        }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('document.settingsTitle', { number: rec.number })}>
      <Stack gap="sm">
        {!may.reviewOwner && (
          <Text size="sm" c="dimmed">
            {t('document.settingsApproversOnly')}
          </Text>
        )}
        <Select
          label={t('document.settingsOwner')}
          description={t('document.settingsOwnerHelp', { owner: rec.owner })}
          placeholder={rec.owner}
          data={users}
          value={owner}
          onChange={setOwner}
          searchable
          clearable
          disabled={!may.reviewOwner}
        />
        <NumberInput
          label={t('document.settingsInterval')}
          description={
            may.anyInterval
              ? t('document.settingsIntervalHelp', { count: r.typeIntervalMonths })
              : t('document.settingsIntervalLimited', { count: r.typeIntervalMonths })
          }
          placeholder={String(r.typeIntervalMonths)}
          min={may.anyInterval ? 0 : 1}
          max={may.anyInterval || r.typeIntervalMonths <= 0 ? 120 : r.typeIntervalMonths}
          disabled={!may.reviewInterval}
          allowDecimal={false}
          value={months}
          onChange={(v) => setMonths(typeof v === 'number' ? v : '')}
        />
        <TextInput
          type="date"
          label={t('document.settingsNext')}
          description={may.reviewInterval ? t('document.settingsNextHelp') : t('document.settingsNextLimited')}
          min={today}
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={submit} loading={busy}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

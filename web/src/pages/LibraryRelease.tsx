import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  List,
  Modal,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconArrowBackUp, IconCheck, IconFileDiff, IconPlayerPlay, IconTrash, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { LibraryInstallSummary, LibraryProcessAbilities, LibraryReleaseSummary, LibraryReview, LibraryReviewItem } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../api';
import { useMe } from '../auth';
import { DetailState, Markdown, TONE } from '../components/common';
import { DetailPage } from '../components/page/DetailPage';
import { confirmDanger } from '../components/confirm';
import { UnifiedDiff } from '../components/editor/VersionDiff';
import { Fingerprint, KeyStateBadge, ReleaseStateBadge } from '../components/libraries/parts';
import { libraryKeys } from '../queryKeys';
import { fmtDate } from '../format';
import { libraryPath, SourceText } from './Libraries';

type Result = { status: 'installed'; library: LibraryInstallSummary } | { status: 'requested'; release: LibraryReleaseSummary };

const STATUS_COLOR: Record<LibraryReviewItem['status'], string> = {
  new: TONE.ok,
  changed: TONE.active,
  unchanged: TONE.neutral,
  removed: TONE.neutral,
  conflict: TONE.attention,
  skipped: TONE.neutral,
};

/** What a process can do, as badges; abilities new since the installed release are marked. */
function Abilities({ a, fresh }: { a: LibraryProcessAbilities; fresh: string[] }) {
  const { t } = useTranslation('libraries');
  const isNew = (token: string) => fresh.includes(token);
  const badge = (token: string, label: string, color: string = TONE.neutral) => (
    <Badge key={token} size="sm" tt="none" variant={isNew(token) ? 'filled' : 'light'} color={color} title={isNew(token) ? t('abilities.new') : undefined}>
      {label}
      {isNew(token) ? ` · ${t('abilities.new')}` : ''}
    </Badge>
  );
  const out = [
    ...a.slots.map((s) => badge(`slot:${s.slot}:${s.kind ?? '*'}`, t('abilities.slot', { slot: s.slot, kind: s.kind ?? t('abilities.anyKind') }))),
    a.writes ? badge('writes', t('abilities.writes', { count: a.writes }), TONE.bad) : null,
    a.accessChanges ? badge('accessChanges', t('abilities.accessChanges', { count: a.accessChanges }), TONE.attention) : null,
    a.browser ? badge('browser', t('abilities.browser', { count: a.browser }), TONE.attention) : null,
    a.ai ? badge('ai', t('abilities.ai', { count: a.ai }), TONE.person) : null,
    a.databaseQueries ? badge('databaseQueries', t('abilities.databaseQueries', { count: a.databaseQueries })) : null,
    a.notifications ? badge('notifications', t('abilities.notifications', { count: a.notifications })) : null,
    a.userTasks ? badge('userTasks', t('abilities.userTasks', { count: a.userTasks })) : null,
    ...a.subprocesses.map((p) => badge(`subprocess:${p}`, t('abilities.subprocess', { process: p }))),
    ...a.datasets.map((d) => badge(`dataset:${d}`, t('abilities.dataset', { dataset: d }))),
  ].filter(Boolean);
  return out.length ? (
    <Group gap={6} wrap="wrap">
      {out}
    </Group>
  ) : (
    <Text size="sm" c="dimmed">
      {t('abilities.readOnly')}
    </Text>
  );
}

/** A connector type's destinations, shown in full: credentials of platforms made from it go there. */
function ConnectorDetails({ item }: { item: LibraryReviewItem }) {
  const { t } = useTranslation('libraries');
  const c = item.connector!;
  const row = (label: string, value: string) => (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
        {value || '–'}
      </Text>
    </Stack>
  );
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs" mt="xs" data-testid="library-connector">
      {row(t('connector.baseUrl'), c.baseUrl)}
      {row(t('connector.tokenUrl'), c.tokenUrl ?? '')}
      {row(t('connector.trustedOrigins'), c.trustedOrigins.join(', '))}
      {row(t('connector.auth'), `${c.authType}${c.secretFields.length ? ` (${c.secretFields.join(', ')})` : ''}`)}
    </SimpleGrid>
  );
}

/** The review of a release: the whole of it, what it can do, the references, the decisions – then install (or roll back). */
export function LibraryReleasePage() {
  const { t } = useTranslation(['libraries', 'common']);
  const { id = '' } = useParams();
  const { username, caps } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: libraryKeys.review(id),
    queryFn: () => get<LibraryReview>(`/library-releases/${encodeURIComponent(id)}/review`),
    enabled: caps.createProcesses,
    retry: false,
  });
  const [platforms, setPlatforms] = useState<Record<string, string>>({});
  const [processes, setProcesses] = useState<Record<string, string>>({});
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [decisions, setDecisions] = useState<Record<string, 'keep' | 'take'>>({});
  const [diff, setDiff] = useState<LibraryReviewItem | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setPlatforms(Object.fromEntries(q.data.references.platforms.filter((r) => r.mapped).map((r) => [r.ref, r.mapped!])));
    setProcesses(Object.fromEntries(q.data.references.processes.filter((r) => r.mapped).map((r) => [r.ref, r.mapped!])));
  }, [q.data]);
  const review = q.data;
  const conflicts = useMemo(() => review?.items.filter((i) => i.status === 'conflict') ?? [], [review]);
  if (!review) return <DetailState query={q} back={{ to: '/libraries', label: t('list.title') }} />;
  const r = review.release;
  const isRollback = r.state === 'previous';
  const request = r.installRequest;
  const mine = !!request && request.by === username;
  const missingRefs = [
    ...review.references.platforms.filter((x) => !platforms[x.ref] && x.candidates.length === 0 && !x.mapped),
    ...review.references.processes.filter((x) => !processes[x.ref] && x.candidates.length === 0),
  ];
  const undecided = conflicts.filter((c) => !decisions[c.path]);
  const refresh = () => void qc.invalidateQueries({ queryKey: libraryKeys.all });
  const send = async (url: string, body: unknown) => {
    setBusy(true);
    try {
      const res = await post<Result>(url, body);
      refresh();
      if (res.status === 'requested') notifyOk(t('install.requested'));
      else {
        notifyOk(isRollback ? t('install.rolledBack', { release: r.release }) : t('install.done', { name: r.name, release: r.release }));
        navigate(libraryPath(res.library.library));
      }
    } catch (e) {
      notifyError(e, t('install.failed'));
    } finally {
      setBusy(false);
    }
  };
  const install = () =>
    send(`/library-releases/${encodeURIComponent(id)}/install`, {
      platforms,
      processes,
      skip: [...skip],
      keepLocal: conflicts.filter((c) => decisions[c.path] === 'keep').map((c) => c.path),
      takeLibrary: conflicts.filter((c) => decisions[c.path] === 'take').map((c) => c.path),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
    });
  const approve = () => send(`/library-releases/${encodeURIComponent(id)}/approve`, {});
  const withdraw = async () => {
    try {
      await post(`/library-releases/${encodeURIComponent(id)}/withdraw`, {});
      notifyOk(t('install.withdrawn'));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const discard = async () => {
    if (!(await confirmDanger({ action: 'discard', message: t('discard.confirm', { name: r.name, release: r.release }) }))) return;
    try {
      await del(`/library-releases/${encodeURIComponent(id)}`);
      notifyOk(t('discard.done'));
      refresh();
      navigate('/libraries');
    } catch (e) {
      notifyError(e);
    }
  };
  const blocked = !review.canInstall || missingRefs.length > 0 || undecided.length > 0 || !!request;
  const installLabel = isRollback
    ? t('install.rollback', { release: r.release })
    : review.installed
      ? t('install.update', { release: r.release })
      : t('install.button');
  const installButton = (
    <Button
      size="xs"
      leftSection={isRollback ? <IconArrowBackUp size={14} /> : <IconPlayerPlay size={14} />}
      onClick={() => void install()}
      loading={busy}
      disabled={blocked}
      data-testid="library-install"
    >
      {installLabel}
    </Button>
  );
  const canAct = r.state === 'staged' || isRollback;
  return (
    <DetailPage
      back={[{ to: '/libraries', label: t('list.title') }, ...(review.installed ? [{ to: libraryPath(r.library), label: r.name }] : [])]}
      title={`${r.name} ${r.release}`}
      status={
        <>
          <ReleaseStateBadge state={r.state} />
          <KeyStateBadge state={r.keyState} />
          {r.needsVersion && (
            <Badge variant="light" color={TONE.attention}>
              {t('state.needsVersion', { version: r.needsVersion })}
            </Badge>
          )}
        </>
      }
      description={t('review.description', { publisher: r.publisherName, count: r.items })}
      actions={
        canAct ? (
          request && !mine ? (
            <Button size="xs" leftSection={<IconCheck size={14} />} onClick={() => void approve()} loading={busy} data-testid="library-approve">
              {t('install.approve')}
            </Button>
          ) : request ? (
            <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => void withdraw()} data-testid="library-withdraw">
              {t('install.withdraw')}
            </Button>
          ) : (
            installButton
          )
        ) : undefined
      }
      menu={
        r.state === 'staged' && !request
          ? { items: [{ label: t('discard.button'), icon: IconTrash, color: 'red', onClick: () => void discard(), testId: 'library-discard' }] }
          : undefined
      }
    >
      <Stack gap="md" maw={1100}>
        {r.keyState === 'revoked' && (
          <Alert color="red" title={t('review.revokedTitle')}>
            {t('review.revokedText')}
          </Alert>
        )}
        {request && (
          <Alert color="violet" title={t('review.requestTitle')} data-testid="library-request">
            {mine ? t('review.requestMine', { when: fmtDate(request.at) }) : t('review.requestOther', { by: request.by, when: fmtDate(request.at) })}
          </Alert>
        )}
        {canAct && review.blockers.length > 0 && (
          <Alert color="orange" title={t('review.blockersTitle')} data-testid="library-blockers">
            <List size="sm">
              {review.blockers.map((b) => (
                <List.Item key={b}>{t(`blockers.${b}`, { defaultValue: b })}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        <Card withBorder component="section" aria-labelledby="release-signature">
          <Title order={2} size="h4" mb="xs" id="release-signature">
            {t('review.signature')}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('review.publisher')}
              </Text>
              <Text size="sm">
                {r.publisherName}{' '}
                <Text span size="xs" c="dimmed" className="mono">
                  ({r.publisherId})
                </Text>
              </Text>
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('review.key')}
              </Text>
              <Fingerprint value={r.keyFingerprint} />
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('review.source')}
              </Text>
              <SourceText r={r} />
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('review.sha256')}
              </Text>
              <Fingerprint value={r.sha256} size="xs" />
            </Stack>
            {review.licence && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {t('review.licence')}
                </Text>
                <Text size="sm">{review.licence}</Text>
              </Stack>
            )}
            {review.installed && (
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {t('review.installed')}
                </Text>
                <Text size="sm">{review.installed.release}</Text>
              </Stack>
            )}
          </SimpleGrid>
          {review.description && (
            <Stack gap={2} mt="sm">
              <Markdown text={review.description} />
            </Stack>
          )}
          {review.changelog.length > 0 && (
            <Stack gap={2} mt="sm">
              <Text size="xs" c="dimmed">
                {t('review.changelog')}
              </Text>
              {review.changelog.slice(0, 5).map((c) => (
                <Text size="sm" key={c.release}>
                  <Text span fw={600}>
                    {c.release}
                  </Text>{' '}
                  {c.notes}
                </Text>
              ))}
            </Stack>
          )}
        </Card>
        {(review.references.platforms.length > 0 || review.references.processes.length > 0) && (
          <Card withBorder component="section" aria-labelledby="release-references">
            <Title order={2} size="h4" id="release-references">
              {t('review.references')}
            </Title>
            <Text size="sm" c="dimmed" mb="xs">
              {t('review.referencesHint')}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              {review.references.platforms.map((x) => (
                <Select
                  key={`p:${x.ref}`}
                  label={
                    <>
                      {x.ref}
                      {x.isNew && (
                        <Badge size="xs" ml={6} variant="light" color={TONE.person}>
                          {t('review.newReference')}
                        </Badge>
                      )}
                    </>
                  }
                  description={[x.description, x.kind ? t('review.kind', { kind: x.kind }) : ''].filter(Boolean).join(' · ')}
                  placeholder={x.candidates.length ? t('review.choosePlatform') : t('review.noPlatform')}
                  data={x.candidates.map((c) => ({ value: c.id, label: c.name }))}
                  value={platforms[x.ref] ?? null}
                  onChange={(v) => setPlatforms((m) => Object.fromEntries([...Object.entries(m).filter(([k]) => k !== x.ref), ...(v ? [[x.ref, v]] : [])]))}
                  disabled={!canAct || !!request}
                  data-testid={`library-ref-${x.ref}`}
                />
              ))}
              {review.references.processes.map((x) => (
                <Select
                  key={`r:${x.ref}`}
                  label={x.ref}
                  description={x.description || t('review.processRef')}
                  placeholder={t('review.chooseProcess')}
                  searchable
                  data={x.candidates.map((c) => ({ value: c.id, label: c.name }))}
                  value={processes[x.ref] ?? null}
                  onChange={(v) => setProcesses((m) => Object.fromEntries([...Object.entries(m).filter(([k]) => k !== x.ref), ...(v ? [[x.ref, v]] : [])]))}
                  disabled={!canAct || !!request}
                />
              ))}
            </SimpleGrid>
          </Card>
        )}
        <Card withBorder component="section" aria-labelledby="release-items">
          <Title order={2} size="h4" id="release-items">
            {t('review.items')}
          </Title>
          <Text size="sm" c="dimmed" mb="sm">
            {t('review.itemsHint')}
          </Text>
          <Stack gap="sm" data-testid="library-items">
            {review.items.map((it) => (
              <Card key={`${it.kind}:${it.path}`} withBorder padding="sm" data-testid="library-item" component="article" aria-label={it.name}>
                <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
                  <Stack gap={2} style={{ minWidth: 0, flex: '1 1 16rem' }}>
                    <Group gap="xs" wrap="wrap">
                      <Text fw={600} size="sm" style={{ overflowWrap: 'anywhere' }}>
                        {it.name}
                      </Text>
                      <Badge size="xs" variant="default">
                        {t(`kind.${it.kind}`)}
                      </Badge>
                      <Badge size="xs" variant="light" color={STATUS_COLOR[it.status]}>
                        {it.status === 'conflict' && it.conflictReason ? t(`conflict.${it.conflictReason}`) : t(`itemStatus.${it.status}`)}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {it.path} · {it.identity}
                    </Text>
                    {it.status === 'removed' && (
                      <Text size="xs" c="dimmed">
                        {t('review.removedHint')}
                      </Text>
                    )}
                  </Stack>
                  <Group gap="xs" wrap="wrap">
                    {(it.status === 'changed' || it.status === 'conflict' || it.status === 'new') && it.incomingText && (
                      <Button size="compact-xs" variant="subtle" leftSection={<IconFileDiff size={14} />} onClick={() => setDiff(it)}>
                        {it.currentText ? t('review.showChanges') : t('review.showFile')}
                      </Button>
                    )}
                    {it.status === 'new' && canAct && !request && (
                      <Checkbox
                        size="xs"
                        label={t('review.install')}
                        checked={!skip.has(it.path)}
                        onChange={(e) => {
                          const on = e.currentTarget.checked;
                          setSkip((s) => {
                            const n = new Set(s);
                            if (on) n.delete(it.path);
                            else n.add(it.path);
                            return n;
                          });
                        }}
                      />
                    )}
                  </Group>
                </Group>
                {it.status === 'conflict' && canAct && !request && (
                  <Stack gap={4} mt="xs">
                    <Text size="xs">{t(`conflictHint.${it.conflictReason ?? 'notFromLibrary'}`)}</Text>
                    <SegmentedControl
                      size="xs"
                      aria-label={t('review.decision', { name: it.name })}
                      data={[
                        { value: 'keep', label: t('review.keepLocal') },
                        ...(it.conflictReason === 'otherLibrary' ? [] : [{ value: 'take', label: t('review.takeLibrary') }]),
                      ]}
                      value={decisions[it.path] ?? ''}
                      onChange={(v) => setDecisions((d) => ({ ...d, [it.path]: v as 'keep' | 'take' }))}
                      data-testid="library-decision"
                      w="fit-content"
                    />
                  </Stack>
                )}
                {it.abilities && (
                  <Stack gap={4} mt="xs">
                    <Text size="xs" c="dimmed">
                      {t('review.abilities')}
                    </Text>
                    <Abilities a={it.abilities} fresh={it.newAbilities ?? []} />
                  </Stack>
                )}
                {it.platformRefs && it.platformRefs.length > 0 && (
                  <Text size="xs" c="dimmed" mt={4}>
                    {t('review.monitorRefs', { refs: it.platformRefs.join(', ') })} · {t('review.monitorDisabled')}
                  </Text>
                )}
                {it.connector && <ConnectorDetails item={it} />}
                {it.problems.map((p) => (
                  <Text key={p} size="xs" c="red" mt={4}>
                    {p}
                  </Text>
                ))}
                {!it.canDecide && it.status !== 'unchanged' && it.status !== 'removed' && (
                  <Text size="xs" c="dimmed" mt={4}>
                    {it.kind === 'connector' ? t('review.adminOnly') : t('review.noRight')}
                  </Text>
                )}
              </Card>
            ))}
          </Stack>
        </Card>
        {canAct && !request && (
          <Card withBorder component="section" aria-label={installLabel}>
            <Stack gap="sm">
              <Textarea
                label={t('review.comment')}
                description={t('review.commentHint')}
                value={comment}
                onChange={(e) => setComment(e.currentTarget.value)}
                autosize
                minRows={2}
                maxLength={2000}
              />
              {undecided.length > 0 && (
                <Text size="sm" c="orange.8">
                  {t('review.undecided', { count: undecided.length })}
                </Text>
              )}
              {review.needsAdmin && (
                <Text size="sm" c="dimmed">
                  {t('review.needsAdmin')}
                </Text>
              )}
              <Group>{installButton}</Group>
            </Stack>
          </Card>
        )}
        {r.state === 'installed' && (
          <Text size="sm">
            <Anchor component={Link} to={libraryPath(r.library)}>
              {t('review.toLibrary')}
            </Anchor>
          </Text>
        )}
      </Stack>
      {diff && (
        <Modal opened onClose={() => setDiff(null)} title={diff.name} size="xl">
          {diff.currentText ? (
            <UnifiedDiff oldText={diff.currentText} newText={diff.incomingText} oldName={t('review.local')} newName={t('review.incoming')} context={3} />
          ) : (
            <UnifiedDiff oldText="" newText={diff.incomingText} oldName="—" newName={diff.path} context={3} />
          )}
        </Modal>
      )}
    </DetailPage>
  );
}

import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Card, FileButton, Group, Paper, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconArrowBackUp, IconBooks, IconHandStop, IconKey, IconPlayerPlay, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { LIBRARY_LIMITS, type LibraryInstallSummary, type LibraryItemOrigin, type LibraryReleaseSummary } from '@sm/shared';
import { get, getOptional, notifyError, notifyOk, post } from '../api';
import { useMe } from '../auth';
import { DetailState, QueryState, TONE } from '../components/common';
import { ListPage, useStoredListView } from '../components/page/ListPage';
import { AutomateTabs } from '../components/page/LinkTabs';
import { DetailPage } from '../components/page/DetailPage';
import { DataTable } from '../components/DataTable';
import { confirmDanger, confirmDialog } from '../components/confirm';
import { Fingerprint, KeyStateBadge, ReleaseStateBadge } from '../components/libraries/parts';
import { libraryKeys } from '../queryKeys';
import { fmtDate, fmtRelative } from '../format';
import { itemLink } from './GitUpdates';

export const toBase64 = async (f: File): Promise<string> => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export const releasePath = (id: string) => `/libraries/releases/${encodeURIComponent(id)}`;
export const libraryPath = (library: string) => `/libraries/${encodeURIComponent(library)}`;

/** Where a release came from: a tag of a Git source, or an uploaded file. */
export function SourceText({ r }: { r: LibraryReleaseSummary }) {
  const { t } = useTranslation('libraries');
  return r.source.type === 'git' ? (
    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
      {t('source.git', { source: r.source.sourceName, tag: r.source.tag })}{' '}
      <Text span size="xs" c="dimmed" className="mono">
        {r.source.commit.slice(0, 10)}
      </Text>
    </Text>
  ) : (
    <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
      {t('source.upload', { file: r.source.fileName })}
    </Text>
  );
}

/** The badges of an installed library: on hold, signed by a revoked key, an update waits. */
function InstallBadges({ l }: { l: LibraryInstallSummary }) {
  const { t } = useTranslation('libraries');
  return (
    <Group gap={4} wrap="wrap">
      {l.held && (
        <Badge size="sm" variant="light" color={TONE.attention}>
          {t('state.held')}
        </Badge>
      )}
      {l.revoked && (
        <Badge size="sm" variant="light" color={TONE.bad}>
          {t('state.revokedKey')}
        </Badge>
      )}
      {l.update && (
        <Badge size="sm" variant="light" color={TONE.person}>
          {t('state.update', { release: l.update.release })}
        </Badge>
      )}
      {!l.held && !l.revoked && !l.update && (
        <Badge size="sm" variant="light" color={TONE.ok}>
          {t('state.current')}
        </Badge>
      )}
    </Group>
  );
}

/** Upload a .zip of a signed library folder: verified, then staged for review (nothing is installed). */
function UploadButton({ size = 'xs' }: { size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('libraries');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const upload = async (f: File | null) => {
    if (!f) return;
    if (f.size > LIBRARY_LIMITS.maxUploadBytes) {
      notifyError(new Error(t('upload.tooLarge', { mb: LIBRARY_LIMITS.maxUploadBytes / 1024 / 1024 })), t('upload.failed'));
      return;
    }
    setBusy(true);
    try {
      const r = await post<LibraryReleaseSummary>('/library-releases/upload', { fileName: f.name, content: await toBase64(f) });
      void qc.invalidateQueries({ queryKey: libraryKeys.all });
      notifyOk(t('upload.staged', { library: r.name, release: r.release }));
      navigate(releasePath(r.id));
    } catch (e) {
      notifyError(e, t('upload.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FileButton onChange={(f) => void upload(f)} accept=".zip,application/zip">
      {(props) => (
        <Button size={size} leftSection={<IconUpload size={14} />} loading={busy} {...props} data-testid="library-upload">
          {t('list.upload')}
        </Button>
      )}
    </FileButton>
  );
}

/** Automate → Libraries: installed libraries and the releases waiting for a review. */
export function LibrariesPage() {
  const { t } = useTranslation(['libraries', 'common']);
  const { caps, isAdmin } = useMe();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const view = useStoredListView('libraries', narrow);
  const [q, setQ] = useState('');
  const list = useQuery({
    queryKey: libraryKeys.list,
    queryFn: () => get<{ installed: LibraryInstallSummary[]; staged: LibraryReleaseSummary[] }>('/libraries'),
    enabled: caps.createProcesses,
  });
  if (!caps.createProcesses) return <ListPage tabs={<AutomateTabs active="/libraries" />} title={t('list.title')} description={t('list.noAccess')} />;
  const needle = q.trim().toLowerCase();
  const match = (...xs: string[]) => !needle || xs.some((x) => x.toLowerCase().includes(needle));
  const installed = (list.data?.installed ?? []).filter((l) => match(l.name, l.library, l.publisherName));
  const staged = (list.data?.staged ?? []).filter((r) => match(r.name, r.library, r.publisherName));
  const none = list.isSuccess && !list.data.installed.length && !list.data.staged.length;
  const publishersLink = isAdmin && (
    <Button size="xs" variant="default" leftSection={<IconKey size={14} />} component={Link} to="/settings/libraries">
      {t('list.publishers')}
    </Button>
  );
  return (
    <ListPage
      testId="libraries"
      tabs={<AutomateTabs active="/libraries" />}
      title={t('list.title')}
      description={t('list.description')}
      primaryAction={<UploadButton />}
      actions={publishersLink}
      search={none ? undefined : { value: q, onChange: setQ, placeholder: t('list.search') }}
      view={none || !installed.length ? undefined : 'libraries'}
      viewState={view}
      empty={{
        show: none,
        icon: IconBooks,
        title: t('list.emptyTitle'),
        text: t('list.emptyText'),
        whoCanAct: isAdmin ? undefined : t('list.whoCanAct'),
        action: (
          <Group gap="xs" justify="center">
            <UploadButton size="sm" />
            {isAdmin && (
              <Button variant="default" leftSection={<IconKey size={16} />} component={Link} to="/settings/libraries">
                {t('list.publishers')}
              </Button>
            )}
          </Group>
        ),
      }}
    >
      <QueryState query={list} />
      {staged.length > 0 && (
        <Stack gap="xs" mb="lg" component="section" aria-labelledby="libraries-staged">
          <Title order={2} size="h4" id="libraries-staged">
            {t('list.staged')}
          </Title>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="library-staged">
            {staged.map((r) => (
              <Paper key={r.id} withBorder p="md" component="article" aria-labelledby={`release-${r.id}`}>
                <Stack gap={6}>
                  <Group gap="xs" justify="space-between" wrap="nowrap" align="flex-start">
                    <Anchor id={`release-${r.id}`} component={Link} to={releasePath(r.id)} fw={600} style={{ overflowWrap: 'anywhere' }}>
                      {r.name} {r.release}
                    </Anchor>
                    <KeyStateBadge state={r.keyState} size="xs" />
                  </Group>
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {t('list.byPublisher', { publisher: r.publisherName })} · {t('list.itemCount', { count: r.items })}
                  </Text>
                  <SourceText r={r} />
                  <Group gap={6}>
                    {r.needsVersion && (
                      <Badge size="sm" variant="light" color={TONE.attention}>
                        {t('state.needsVersion', { version: r.needsVersion })}
                      </Badge>
                    )}
                    {r.installRequest && (
                      <Badge size="sm" variant="light" color={TONE.person}>
                        {t('state.waitingSecond')}
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed" title={fmtDate(r.stagedAt)}>
                    {t('list.stagedAgo', { when: fmtRelative(r.stagedAt) })}
                  </Text>
                </Stack>
              </Paper>
            ))}
          </SimpleGrid>
        </Stack>
      )}
      {!none && list.isSuccess && !installed.length && !staged.length && (
        <Text size="sm" c="dimmed">
          {t('list.noMatch')}
        </Text>
      )}
      {installed.length > 0 && (
        <Stack gap="xs" component="section" aria-labelledby="libraries-installed">
          <Title order={2} size="h4" id="libraries-installed">
            {t('list.installed')}
          </Title>
          {view.cards ? (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} data-testid="library-cards">
              {installed.map((l) => (
                <Paper key={l.library} withBorder p="md" component="article" aria-labelledby={`library-${l.library}`}>
                  <Stack gap={6}>
                    <Anchor id={`library-${l.library}`} component={Link} to={libraryPath(l.library)} fw={600} style={{ overflowWrap: 'anywhere' }}>
                      {l.name}
                    </Anchor>
                    <Text size="xs" c="dimmed" className="mono" style={{ overflowWrap: 'anywhere' }}>
                      {l.library} {l.release.release}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {t('list.byPublisher', { publisher: l.publisherName })}
                    </Text>
                    <InstallBadges l={l} />
                  </Stack>
                </Paper>
              ))}
            </SimpleGrid>
          ) : (
            <DataTable
              testId="library-table"
              ariaLabel={t('list.installed')}
              rows={installed}
              rowKey={(l) => l.library}
              rowHref={(l) => libraryPath(l.library)}
              columns={[
                {
                  key: 'name',
                  header: t('list.name'),
                  sortValue: (l) => l.name,
                  cell: (l) => (
                    <>
                      <Anchor component={Link} to={libraryPath(l.library)} fw={500} size="sm" onClick={(e) => e.stopPropagation()}>
                        {l.name}
                      </Anchor>
                      <Text size="xs" c="dimmed" className="mono">
                        {l.library}
                      </Text>
                    </>
                  ),
                },
                { key: 'release', header: t('list.release'), sortValue: (l) => l.release.release, nowrap: true, cell: (l) => l.release.release },
                { key: 'publisher', header: t('list.publisher'), sortValue: (l) => l.publisherName, cell: (l) => l.publisherName },
                { key: 'state', header: t('list.state'), cell: (l) => <InstallBadges l={l} /> },
                { key: 'installed', header: t('list.installedAt'), sortValue: (l) => l.installedAt, nowrap: true, cell: (l) => fmtRelative(l.installedAt) },
              ]}
            />
          )}
        </Stack>
      )}
    </ListPage>
  );
}

/** One installed library: its release, the key, Hold, rollback, uninstall, its releases and items. */
export function LibraryDetailPage() {
  const { t } = useTranslation(['libraries', 'common']);
  const { library = '' } = useParams();
  const { isAdmin, caps } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: libraryKeys.detail(library),
    queryFn: () => get<LibraryInstallSummary & { releases: LibraryReleaseSummary[] }>(`/libraries/${encodeURIComponent(library)}`),
    enabled: caps.createProcesses,
  });
  const items = useQuery({
    queryKey: libraryKeys.origins('all'),
    queryFn: () => getOptional<LibraryItemOrigin[]>('/library-origins', []),
  });
  const [busy, setBusy] = useState(false);
  if (!q.data) return <DetailState query={q} back={{ to: '/libraries', label: t('list.title') }} />;
  const l = q.data;
  const refresh = () => void qc.invalidateQueries({ queryKey: libraryKeys.all });
  const hold = async (held: boolean) => {
    const ok = await confirmDialog({
      action: 'confirm',
      title: held ? t('hold.title') : t('hold.liftTitle'),
      message: held ? t('hold.confirm', { name: l.name }) : t('hold.liftConfirm', { name: l.name }),
      confirmLabel: held ? t('hold.button') : t('hold.lift'),
      danger: held,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await post(`/libraries/${encodeURIComponent(library)}/hold`, { held });
      notifyOk(held ? t('hold.done') : t('hold.lifted'));
      refresh();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const uninstall = async () => {
    if (
      !(await confirmDanger({
        action: 'remove',
        title: t('uninstall.title'),
        message: t('uninstall.confirm', { name: l.name }),
        confirmLabel: t('uninstall.button'),
      }))
    )
      return;
    try {
      await post(`/libraries/${encodeURIComponent(library)}/uninstall`, {});
      notifyOk(t('uninstall.done'));
      refresh();
      navigate('/libraries');
    } catch (e) {
      notifyError(e);
    }
  };
  const own = (items.data ?? []).filter((o) => o.library === library);
  return (
    <DetailPage
      back={{ to: '/libraries', label: t('list.title') }}
      title={l.name}
      status={
        <>
          <Badge variant="light" color={TONE.ok}>
            {l.release.release}
          </Badge>
          {l.held && (
            <Badge variant="light" color={TONE.attention}>
              {t('state.held')}
            </Badge>
          )}
          {l.revoked && (
            <Badge variant="light" color={TONE.bad}>
              {t('state.revokedKey')}
            </Badge>
          )}
        </>
      }
      description={t('detail.description', { library: l.library, publisher: l.publisherName })}
      actions={
        <>
          {l.update && (
            <Button size="xs" leftSection={<IconPlayerPlay size={14} />} component={Link} to={releasePath(l.update.id)}>
              {t('detail.reviewUpdate', { release: l.update.release })}
            </Button>
          )}
          {isAdmin && (
            <Button
              size="xs"
              variant={l.revoked && !l.held ? 'filled' : 'default'}
              color={l.held ? undefined : TONE.attention}
              leftSection={<IconHandStop size={14} />}
              onClick={() => void hold(!l.held)}
              loading={busy}
              data-testid="library-hold"
            >
              {l.held ? t('hold.lift') : t('hold.button')}
            </Button>
          )}
        </>
      }
      menu={{
        items: [
          ...(l.previous
            ? [
                {
                  label: t('detail.rollback', { release: l.previous.release }),
                  icon: IconArrowBackUp,
                  to: releasePath(l.previous.id),
                  testId: 'library-rollback',
                },
              ]
            : []),
          { label: t('uninstall.button'), icon: IconTrash, color: 'red', onClick: () => void uninstall(), testId: 'library-uninstall' },
        ],
      }}
    >
      <Stack gap="md" maw={1000}>
        {l.revoked && (
          <Alert color="red" title={t('detail.revokedTitle')} data-testid="library-revoked">
            {l.held ? t('detail.revokedHeld') : isAdmin ? t('detail.revokedText') : t('detail.revokedTextAsk')}
          </Alert>
        )}
        {l.held && !l.revoked && (
          <Alert color="orange" title={t('state.held')}>
            {t('detail.heldText', { by: l.heldBy ?? '–', when: l.heldAt ? fmtDate(l.heldAt) : '–' })}
          </Alert>
        )}
        <Card withBorder>
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" verticalSpacing="sm">
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('detail.key')}
              </Text>
              <Group gap="xs" wrap="wrap">
                <Fingerprint value={l.release.keyFingerprint} />
                <KeyStateBadge state={l.release.keyState} size="xs" />
              </Group>
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('detail.source')}
              </Text>
              <SourceText r={l.release} />
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('detail.installed')}
              </Text>
              <Text size="sm">{t('detail.installedBy', { by: l.installedBy, when: fmtDate(l.installedAt) })}</Text>
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('detail.checked')}
              </Text>
              <Text size="sm">
                {l.release.source.type === 'git'
                  ? l.lastCheckedAt
                    ? t('detail.checkedAt', { when: fmtRelative(l.lastCheckedAt), newest: l.newestSeen ?? '–' })
                    : t('detail.neverChecked')
                  : t('detail.uploaded')}
              </Text>
            </Stack>
          </SimpleGrid>
        </Card>
        <Card withBorder>
          <Title order={2} size="h4" mb="xs">
            {t('detail.items')}
          </Title>
          {own.length ? (
            <Stack gap={4}>
              {own.map((o) => {
                const to = o.kind === 'connector' ? '/platforms' : itemLink(o.kind, o.entityId);
                return (
                  <Group key={`${o.kind}:${o.entityId}`} gap="xs" wrap="wrap">
                    <Badge size="xs" variant="default">
                      {t(`kind.${o.kind}`)}
                    </Badge>
                    {to ? (
                      <Anchor component={Link} to={to} size="sm">
                        {o.name}
                      </Anchor>
                    ) : (
                      <Text size="sm">{o.name}</Text>
                    )}
                    {o.changedLocally && (
                      <Badge size="xs" variant="light" color={TONE.attention}>
                        {t('itemStatus.changedLocally')}
                      </Badge>
                    )}
                  </Group>
                );
              })}
            </Stack>
          ) : (
            <Text size="sm" c="dimmed">
              {t('detail.noItems')}
            </Text>
          )}
        </Card>
        <Card withBorder>
          <Title order={2} size="h4" mb="xs">
            {t('detail.releases')}
          </Title>
          <Table.ScrollContainer minWidth={520}>
            <Table verticalSpacing="xs" data-testid="library-releases">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('list.release')}</Table.Th>
                  <Table.Th>{t('list.state')}</Table.Th>
                  <Table.Th>{t('detail.key')}</Table.Th>
                  <Table.Th>{t('detail.staged')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {l.releases.map((r) => (
                  <Table.Tr key={r.id}>
                    <Table.Td>
                      <Anchor component={Link} to={releasePath(r.id)} size="sm" fw={500}>
                        {r.release}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <ReleaseStateBadge state={r.state} size="xs" />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <KeyStateBadge state={r.keyState} size="xs" />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" title={fmtDate(r.stagedAt)}>
                        {fmtRelative(r.stagedAt)}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Card>
      </Stack>
    </DetailPage>
  );
}

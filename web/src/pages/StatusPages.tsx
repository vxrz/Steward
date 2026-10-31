import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  AppShell,
  Badge,
  Button,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { IconCopy, IconLink, IconLinkOff, IconLogout, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  STATUS_NOTICE_LEVELS,
  STATUS_PAGE_LIMITS,
  type ServiceState,
  type ServiceSummary,
  type StatusNoticeLevel,
  type StatusPage,
  type StatusPageView,
} from '@sm/shared';
import { apiUrl, del, get, getOptional, notifyError, post, put } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE, useCreateParam } from '../components/common';
import { fmtDate, fmtRelative } from '../format';
import { BRAND } from '../../../shared/src/brand';

const STATE_COLOR: Record<ServiceState, string> = {
  outage: TONE.bad,
  degraded: TONE.attention,
  maintenance: TONE.active,
  operational: TONE.ok,
  unknown: TONE.neutral,
};
const NOTICE_COLOR: Record<StatusNoticeLevel, string> = { info: 'blue', warning: 'orange', outage: 'red' };

function StateBadge({ state, size = 'sm' }: { state: ServiceState; size?: 'sm' | 'lg' }) {
  const { t } = useTranslation('services');
  return (
    <Badge color={STATE_COLOR[state]} variant="light" size={size}>
      {t(`statusPages.states.${state}`)}
    </Badge>
  );
}

/** The page itself – the same for colleagues, status viewers and the link without sign-in. */
export function StatusView({ view }: { view: StatusPageView }) {
  const { t } = useTranslation('services');
  return (
    <Stack maw={900}>
      <Group justify="space-between" wrap="wrap">
        <div>
          <Title order={2}>{view.title}</Title>
          {view.description && (
            <Text c="dimmed" size="sm">
              {view.description}
            </Text>
          )}
        </div>
        <StateBadge state={view.state} size="lg" />
      </Group>
      {view.notice && (
        <Alert color={NOTICE_COLOR[view.noticeLevel]} variant="light">
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {view.notice}
          </Text>
        </Alert>
      )}
      {view.services.map((s) => (
        <Paper key={s.name} withBorder p="sm">
          <Group justify="space-between" wrap="nowrap">
            <Text fw={600}>{s.name}</Text>
            <StateBadge state={s.state} />
          </Group>
          {s.maintenance.map((m) => (
            <Text key={`${m.title}${m.startsAt}`} size="sm" mt={4}>
              {t(m.active ? 'statusPages.maintenanceNow' : 'statusPages.maintenancePlanned', {
                title: m.title,
                from: fmtDate(m.startsAt),
                to: fmtDate(m.endsAt),
              })}
            </Text>
          ))}
          {s.vendorIssues.map((v) => (
            <Text key={`${v.vendor}${v.since}`} size="sm" mt={4}>
              {t('statusPages.vendorIssue', { vendor: v.vendor, since: fmtRelative(v.since) })}
            </Text>
          ))}
          {s.objectives.map((o) => (
            <Text key={o.name} size="xs" c="dimmed" mt={4}>
              {o.value === null
                ? t('statusPages.objectiveNoData', { name: o.name, target: o.target })
                : t('statusPages.objective', { name: o.name, value: o.value.toFixed(2), target: o.target })}
            </Text>
          ))}
        </Paper>
      ))}
      <Text size="xs" c="dimmed">
        {t('statusPages.generated', { when: fmtDate(view.generatedAt) })}
      </Text>
    </Stack>
  );
}

/** Opened with a page's secret link: the token is in the fragment (#t=…), which no server or proxy log sees. */
export function PublicStatusPage() {
  const { t } = useTranslation('services');
  const token = new URLSearchParams(window.location.hash.slice(1)).get('t') ?? '';
  const q = useQuery({
    queryKey: ['public-status', token],
    enabled: !!token,
    refetchInterval: 60_000,
    queryFn: async () => {
      const r = await fetch(apiUrl('/public/status-page'), { headers: { 'x-status-token': token } });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as StatusPageView;
    },
    retry: false,
  });
  return (
    <Center p="md" style={{ minHeight: '100vh', alignItems: 'flex-start' }}>
      <Stack w="100%" maw={900} pt="xl">
        <Text size="sm" c="dimmed">
          {BRAND.name}
        </Text>
        {!token || q.isError ? <Alert color="gray">{t('statusPages.linkInvalid')}</Alert> : q.data ? <StatusView view={q.data} /> : <Loader />}
      </Stack>
    </Center>
  );
}

/** Status viewers (role "status" only) see nothing but the status pages. */
export function StatusViewerApp({ onSignOut }: { onSignOut: () => void }) {
  const { t } = useTranslation('services');
  const pages = useQuery({ queryKey: ['status-pages'], queryFn: () => get<StatusPage[]>('/status-pages') });
  const [selected, setSelected] = useState<string | null>(null);
  const id = selected ?? pages.data?.[0]?.id ?? null;
  const view = useQuery({
    queryKey: ['status-page-view', id],
    enabled: !!id,
    refetchInterval: 60_000,
    queryFn: () => get<StatusPageView>(`/status-pages/${id}/view`),
  });
  return (
    <AppShell header={{ height: 56 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Text fw={700}>{BRAND.name}</Text>
          <Group gap="xs" wrap="nowrap">
            {(pages.data?.length ?? 0) > 1 && (
              <Select
                aria-label={t('statusPages.title')}
                size="xs"
                allowDeselect={false}
                data={(pages.data ?? []).map((p) => ({ value: p.id, label: p.title }))}
                value={id}
                onChange={setSelected}
              />
            )}
            <Button size="xs" variant="subtle" leftSection={<IconLogout size={14} />} onClick={onSignOut}>
              {t('statusPages.signOut')}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        <QueryState query={pages} />
        {pages.isSuccess && !pages.data.length && <Alert color="gray">{t('statusPages.noneForViewer')}</Alert>}
        {view.data && <StatusView view={view.data} />}
      </AppShell.Main>
    </AppShell>
  );
}

/** Services → Status pages: the list, and for designers and administrators the editor and the secret links. */
export function StatusPagesPage() {
  const { t } = useTranslation('services');
  const qc = useQueryClient();
  const { isAdmin, hasRole } = useMe();
  const canEdit = isAdmin || hasRole('designer');
  const pages = useQuery({ queryKey: ['status-pages'], queryFn: () => get<StatusPage[]>('/status-pages') });
  const [editing, setEditing] = useState<StatusPage | 'new' | null>(null);
  const [link, setLink] = useState<{ title: string; url: string } | null>(null);
  useCreateParam(canEdit, () => setEditing('new'));
  const refresh = () => qc.invalidateQueries({ queryKey: ['status-pages'] });
  const makeLink = async (p: StatusPage) => {
    try {
      const r = await post<{ token: string }>(`/status-pages/${p.id}/link`);
      setLink({ title: p.title, url: `${window.location.origin}${apiUrl('/').replace(/\/api\/$/, '')}/status#t=${r.token}` });
      await refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const revoke = async (p: StatusPage) => {
    try {
      await del(`/status-pages/${p.id}/link`);
      await refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const remove = async (p: StatusPage) => {
    try {
      await del(`/status-pages/${p.id}`);
      await refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const list = pages.data ?? [];
  const newButton = canEdit && (
    <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
      {t('statusPages.new')}
    </Button>
  );
  return (
    <>
      <PageHeader title={t('statusPages.title')} description={t('statusPages.description')} actions={newButton} />
      <QueryState query={pages} />
      {pages.isSuccess && !list.length && (
        <EmptyState icon={IconLink} title={t('statusPages.emptyTitle')} action={newButton}>
          {t('statusPages.emptyText')}
        </EmptyState>
      )}
      <Stack>
        {list.map((p) => (
          <Paper key={p.id} withBorder p="sm">
            <Group justify="space-between" wrap="wrap">
              <div>
                <Text fw={600} component={Link} to={`/status-pages/${p.id}`}>
                  {p.title}
                </Text>
                <Text size="xs" c="dimmed">
                  {t('statusPages.servicesCount', { count: p.serviceIds.length })}
                  {p.publicLink && p.publicLinkCreatedAt ? ` · ${t('statusPages.linkSince', { when: fmtDate(p.publicLinkCreatedAt) })}` : ''}
                </Text>
              </div>
              {p.canEdit && (
                <Group gap={4}>
                  <Button size="xs" variant="light" leftSection={<IconLink size={14} />} onClick={() => makeLink(p)}>
                    {p.publicLink ? t('statusPages.newLink') : t('statusPages.makeLink')}
                  </Button>
                  {p.publicLink && (
                    <Button size="xs" variant="subtle" color="red" leftSection={<IconLinkOff size={14} />} onClick={() => revoke(p)}>
                      {t('statusPages.revokeLink')}
                    </Button>
                  )}
                  <ActionIcon variant="subtle" aria-label={t('statusPages.edit', { title: p.title })} onClick={() => setEditing(p)}>
                    <IconPencil size={16} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="red" aria-label={t('statusPages.delete', { title: p.title })} onClick={() => remove(p)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              )}
            </Group>
          </Paper>
        ))}
      </Stack>
      {editing && <PageEditor page={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {link && (
        <Modal opened onClose={() => setLink(null)} title={t('statusPages.linkTitle', { title: link.title })} size="lg">
          <Stack>
            <Text size="sm">{t('statusPages.linkOnce')}</Text>
            <Group gap="xs" wrap="nowrap">
              <Code style={{ overflowWrap: 'anywhere' }}>{link.url}</Code>
              <CopyButton value={link.url}>
                {({ copied, copy }) => (
                  <ActionIcon variant="light" onClick={copy} aria-label={copied ? t('statusPages.copied') : t('statusPages.copy')}>
                    <IconCopy size={16} />
                  </ActionIcon>
                )}
              </CopyButton>
            </Group>
          </Stack>
        </Modal>
      )}
    </>
  );
}

function PageEditor({ page, onClose }: { page: StatusPage | null; onClose: () => void }) {
  const { t } = useTranslation(['services', 'common']);
  const qc = useQueryClient();
  const services = useQuery({ queryKey: ['services'], queryFn: () => getOptional<ServiceSummary[]>('/services', []) });
  const [f, setF] = useState({
    title: page?.title ?? '',
    description: page?.description ?? '',
    serviceIds: page?.serviceIds ?? [],
    showObjectives: page?.showObjectives ?? true,
    showVendorIssues: page?.showVendorIssues ?? true,
    notice: page?.notice ?? '',
    noticeLevel: page?.noticeLevel ?? ('info' as StatusNoticeLevel),
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (page) await put(`/status-pages/${page.id}`, f);
      else await post('/status-pages', f);
      await qc.invalidateQueries({ queryKey: ['status-pages'] });
      onClose();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={page ? t('statusPages.editTitle') : t('statusPages.new')} size="lg">
      <Stack gap="sm">
        <TextInput
          label={t('statusPages.pageTitle')}
          required
          value={f.title}
          onChange={(e) => setF({ ...f, title: e.currentTarget.value })}
          maxLength={STATUS_PAGE_LIMITS.title}
        />
        <Textarea
          label={t('statusPages.pageDescription')}
          value={f.description}
          onChange={(e) => setF({ ...f, description: e.currentTarget.value })}
          maxLength={STATUS_PAGE_LIMITS.description}
          autosize
          minRows={2}
        />
        <MultiSelect
          label={t('statusPages.services')}
          description={t('statusPages.servicesHelp')}
          required
          searchable
          data={(services.data ?? []).filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name }))}
          value={f.serviceIds}
          onChange={(v) => setF({ ...f, serviceIds: v })}
          maxValues={STATUS_PAGE_LIMITS.services}
        />
        <Switch
          label={t('statusPages.showVendorIssues')}
          checked={f.showVendorIssues}
          onChange={(e) => setF({ ...f, showVendorIssues: e.currentTarget.checked })}
        />
        <Switch label={t('statusPages.showObjectives')} checked={f.showObjectives} onChange={(e) => setF({ ...f, showObjectives: e.currentTarget.checked })} />
        <Textarea
          label={t('statusPages.notice')}
          description={t('statusPages.noticeHelp')}
          value={f.notice}
          onChange={(e) => setF({ ...f, notice: e.currentTarget.value })}
          maxLength={STATUS_PAGE_LIMITS.notice}
          autosize
          minRows={2}
        />
        <Select
          label={t('statusPages.noticeLevel')}
          allowDeselect={false}
          data={STATUS_NOTICE_LEVELS.map((l) => ({ value: l, label: t(`statusPages.noticeLevels.${l}`) }))}
          value={f.noticeLevel}
          onChange={(v) => setF({ ...f, noticeLevel: (v as StatusNoticeLevel) ?? 'info' })}
          w={{ base: '100%', xs: 240 }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!f.title.trim() || !f.serviceIds.length}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** One page, for signed-in users (refreshes every minute). */
export function StatusPageViewPage() {
  const { t } = useTranslation('services');
  const { id = '' } = useParams();
  const q = useQuery({ queryKey: ['status-page-view', id], refetchInterval: 60_000, queryFn: () => get<StatusPageView>(`/status-pages/${id}/view`) });
  if (!q.data) return <QueryState query={q} />;
  return (
    <Stack>
      <Text size="sm" component={Link} to="/status-pages">
        ← {t('statusPages.title')}
      </Text>
      <StatusView view={q.data} />
    </Stack>
  );
}

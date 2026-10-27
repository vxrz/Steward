import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconBrandGit, IconCheck, IconCopy, IconDownload, IconEdit, IconKey, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  GIT_PROVIDERS,
  SYNC_KINDS,
  SYNC_LIMITS,
  SYNC_REF_TYPES,
  type SyncFetchResult,
  type SyncSource,
  type SyncSourceSecret,
  type SyncSourceSettings,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE, useFieldErrors } from '../components/common';
import { fmtDate, fmtRelative } from '../format';
import { confirmDanger } from '../components/confirm';
import { WEB_BUILD } from '../buildInfo';
import { appUrl } from '../basePath';

type Draft = SyncSourceSettings & { id?: string; token?: string; hasToken?: boolean; removeToken?: boolean };

const emptyDraft = (): Draft => ({
  name: '',
  provider: 'forgejo',
  repoUrl: '',
  apiUrl: '',
  refType: 'branch',
  branch: 'main',
  folder: '',
  kinds: [...SYNC_KINDS],
  intervalMinutes: 0,
  webhookEnabled: false,
  requireSignedCommits: false,
  allowedSigners: [],
  autoAcceptNew: false,
  enabled: true,
});

/** Settings → Git sync: the sources (administrators). */
export function GitSyncPage() {
  const { t } = useTranslation(['gitSync', 'common']);
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ['sync-sources'], queryFn: () => get<SyncSource[]>('/sync-sources'), enabled: isAdmin });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secret, setSecret] = useState<{ path: string; secret: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sync-sources'] });
    void qc.invalidateQueries({ queryKey: ['sync-updates'] });
  };

  if (!isAdmin) return <PageHeader back="settings" title={t('sources.title')} description={t('sources.readOnly')} />;

  const fetchNow = async (s: SyncSource) => {
    setBusy(s.id);
    try {
      const r = await post<SyncFetchResult>(`/sync-sources/${s.id}/fetch`);
      notifyOk(
        [
          t('sources.fetched', { commit: r.commit?.slice(0, 10) ?? '–', staged: r.staged, invalid: r.invalid, unchanged: r.unchanged }),
          r.autoAccepted ? t('sources.fetchedAuto', { count: r.autoAccepted }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
    } catch (e) {
      notifyError(e, t('sources.fetchFailed'));
    } finally {
      setBusy(null);
      refresh();
    }
  };
  const remove = async (s: SyncSource) => {
    if (!(await confirmDanger({ action: 'delete', message: t('sources.deleteConfirm', { name: s.name }) }))) return;
    try {
      await del(`/sync-sources/${s.id}`);
      notifyOk(t('sources.deleted'));
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const rotate = async (s: SyncSource) => {
    if (!(await confirmDanger({ action: 'rotate', message: t('sources.rotateConfirm') }))) return;
    try {
      const r = await post<SyncSourceSecret>(`/sync-sources/${s.id}/rotate-webhook-secret`);
      if (r.webhookSecret) setSecret({ path: r.source.webhookPath, secret: r.webhookSecret });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader
        back="settings"
        title={t('sources.title')}
        description={t('sources.description')}
        actions={
          <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft(emptyDraft())}>
            {t('sources.new')}
          </Button>
        }
      />
      <QueryState query={sources} />
      {sources.data?.length === 0 && (
        <EmptyState
          icon={IconBrandGit}
          title={t('sources.empty')}
          action={
            <Button leftSection={<IconPlus size={16} />} onClick={() => setDraft(emptyDraft())}>
              {t('sources.new')}
            </Button>
          }
        >
          {t('sources.emptyHint')}
        </EmptyState>
      )}
      <Stack maw={900}>
        {sources.data?.map((s) => (
          <Card withBorder key={s.id} data-testid="sync-source">
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
              <Stack gap={4} style={{ minWidth: 0, flex: '1 1 18rem' }}>
                <Group gap="xs" wrap="wrap">
                  <Text fw={600}>{s.name}</Text>
                  <Badge variant="light" color="gray">
                    {t(`form.providers.${s.provider}`)}
                  </Badge>
                  {s.builtIn && (
                    <Badge variant="light" color={TONE.active}>
                      {t('sources.builtIn')}
                    </Badge>
                  )}
                  {!s.enabled && (
                    <Badge variant="light" color={TONE.neutral}>
                      {t('sources.disabled')}
                    </Badge>
                  )}
                  {s.pendingCount > 0 && (
                    <Anchor component={Link} to={`/git-updates?source=${s.id}`} size="sm">
                      {t('sources.openUpdates', { count: s.pendingCount })}
                    </Anchor>
                  )}
                </Group>
                <Text size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
                  {s.repoUrl} · {s.refType === 'tag' ? t('sources.refTag', { ref: s.resolvedRef }) : s.resolvedRef}
                  {s.folder ? ` · ${s.folder}/` : ''}
                </Text>
                {s.builtIn && (
                  <Text size="xs" c="dimmed">
                    {t('sources.builtInHint')}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  {s.kinds.map((k) => t(`form.kind.${k}`)).join(', ')} ·{' '}
                  {s.intervalMinutes ? t('sources.schedule', { count: s.intervalMinutes }) : t('sources.noSchedule')}
                  {s.webhookEnabled ? ` · ${t('sources.webhookOn')}` : ''}
                  {s.requireSignedCommits ? ` · ${t('form.requireSigned')}` : ''}
                  {s.autoAcceptNew ? ` · ${t('form.autoAccept')}` : ''}
                </Text>
                <Group gap="xs" wrap="wrap">
                  <Text size="xs" c="dimmed" title={s.lastFetchAt ? fmtDate(s.lastFetchAt) : undefined}>
                    {s.lastFetchAt ? t('sources.lastFetch', { when: fmtRelative(s.lastFetchAt) }) : t('sources.never')}
                  </Text>
                  {s.lastCommit && (
                    <Text size="xs" c="dimmed" className="mono">
                      {t('sources.commit', { sha: s.lastCommit.slice(0, 10) })}
                    </Text>
                  )}
                  {s.lastVerified !== null && (
                    <Badge size="xs" variant="light" color={s.lastVerified ? TONE.ok : TONE.neutral}>
                      {s.lastVerified ? t('sources.signed') : t('sources.unsigned')}
                    </Badge>
                  )}
                </Group>
                {s.lastStatus === 'error' && s.lastError && (
                  <Alert color="red" variant="light" p="xs">
                    {s.lastError}
                  </Alert>
                )}
              </Stack>
              <Group gap={4} wrap="nowrap">
                <Button size="xs" variant="light" leftSection={<IconDownload size={14} />} loading={busy === s.id} onClick={() => fetchNow(s)}>
                  {t('sources.fetchNow')}
                </Button>
                <Tooltip label={t('sources.edit')}>
                  <ActionIcon variant="subtle" aria-label={t('sources.edit')} onClick={() => setDraft({ ...s, token: '', hasToken: s.hasToken })}>
                    <IconEdit size={16} />
                  </ActionIcon>
                </Tooltip>
                {s.webhookEnabled && (
                  <Tooltip label={t('sources.rotate')}>
                    <ActionIcon variant="subtle" aria-label={t('sources.rotate')} onClick={() => rotate(s)}>
                      <IconKey size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
                <Tooltip label={t('sources.delete')}>
                  <ActionIcon variant="subtle" color="red" aria-label={t('sources.delete')} onClick={() => remove(s)}>
                    <IconTrash size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>
          </Card>
        ))}
      </Stack>
      {draft && (
        <SourceDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={(r) => {
            setDraft(null);
            refresh();
            if (r.webhookSecret && r.source.webhookEnabled) setSecret({ path: r.source.webhookPath, secret: r.webhookSecret });
          }}
        />
      )}
      {secret && <SecretDialog path={secret.path} secret={secret.secret} onClose={() => setSecret(null)} />}
    </>
  );
}

function SourceDialog({ draft: initial, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: (r: SyncSourceSecret) => void }) {
  const { t } = useTranslation(['gitSync', 'common']);
  const [d, setD] = useState<Draft>({ ...initial, refType: initial.refType ?? 'branch' });
  // the web app is built with the server's version (one release)
  const version = WEB_BUILD.version;
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const v = useFieldErrors({
    name: !d.name.trim() && t('common:validation.required'),
    repoUrl: !d.repoUrl.trim() && t('common:validation.required'),
    kinds: !d.kinds.length && t('common:validation.requiredOne'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      name: d.name,
      provider: d.provider,
      repoUrl: d.repoUrl,
      apiUrl: d.apiUrl ?? '',
      refType: d.refType,
      branch: d.branch,
      folder: d.folder,
      kinds: d.kinds,
      intervalMinutes: d.intervalMinutes,
      webhookEnabled: d.webhookEnabled,
      requireSignedCommits: d.requireSignedCommits,
      allowedSigners: d.allowedSigners,
      autoAcceptNew: d.autoAcceptNew,
      enabled: d.enabled,
      // write-only: omitted = keep, '' = remove
      ...(d.removeToken ? { token: '' } : d.token ? { token: d.token } : {}),
    };
    try {
      const r = d.id ? { source: await put<SyncSource>(`/sync-sources/${d.id}`, body) } : await post<SyncSourceSecret>('/sync-sources', body);
      notifyOk(t('sources.saved'));
      onSaved(r);
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={d.id ? t('form.titleEdit') : t('form.titleNew')} size="lg">
      <Stack gap="sm">
        <TextInput label={t('form.name')} required value={d.name} onChange={(e) => set('name', e.currentTarget.value)} data-autofocus error={v.error('name')} />
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
          <Select
            label={t('form.provider')}
            data={GIT_PROVIDERS.map((p) => ({ value: p, label: t(`form.providers.${p}`) }))}
            value={d.provider}
            allowDeselect={false}
            onChange={(v) => v && set('provider', v as Draft['provider'])}
          />
          <Select
            label={t('form.refType')}
            data={SYNC_REF_TYPES.map((r) => ({ value: r, label: t(`form.refTypes.${r}`) }))}
            value={d.refType}
            allowDeselect={false}
            onChange={(v) => v && set('refType', v as Draft['refType'])}
          />
        </SimpleGrid>
        <TextInput
          label={d.refType === 'tag' ? t('form.tag') : t('form.branch')}
          required
          value={d.branch}
          onChange={(e) => set('branch', e.currentTarget.value)}
          description={
            d.branch.includes('{version}')
              ? `${t('form.refHint', { version })} ${t('form.refResolved', { ref: d.branch.replaceAll('{version}', version) })}`
              : t('form.refHint', { version })
          }
        />
        <TextInput
          label={t('form.repoUrl')}
          description={t('form.repoUrlHint')}
          required
          value={d.repoUrl}
          onChange={(e) => set('repoUrl', e.currentTarget.value)}
          placeholder="https://git.example.com/team/steward-library"
          error={v.error('repoUrl')}
        />
        <TextInput label={t('form.apiUrl')} description={t('form.apiUrlHint')} value={d.apiUrl ?? ''} onChange={(e) => set('apiUrl', e.currentTarget.value)} />
        <TextInput
          label={t('form.folder')}
          description={t('form.folderHint')}
          value={d.folder}
          onChange={(e) => set('folder', e.currentTarget.value)}
          placeholder="steward"
        />
        <Checkbox.Group label={t('form.kinds')} value={d.kinds} onChange={(k) => set('kinds', k as Draft['kinds'])} required error={v.error('kinds')}>
          <Group gap="md" mt={4}>
            {SYNC_KINDS.map((k) => (
              <Checkbox key={k} value={k} label={t(`form.kind.${k}`)} />
            ))}
          </Group>
        </Checkbox.Group>
        <PasswordInput
          label={t('form.token')}
          description={d.hasToken && !d.removeToken ? t('form.tokenKeep') : t('form.tokenHint')}
          value={d.token ?? ''}
          disabled={d.removeToken}
          autoComplete="off"
          onChange={(e) => set('token', e.currentTarget.value)}
        />
        {d.hasToken && <Checkbox label={t('form.tokenRemove')} checked={!!d.removeToken} onChange={(e) => set('removeToken', e.currentTarget.checked)} />}
        <NumberInput
          label={t('form.interval')}
          description={t('form.intervalHint')}
          min={0}
          max={10080}
          value={d.intervalMinutes}
          onChange={(v) => set('intervalMinutes', Number(v) || 0)}
          maw={260}
        />
        <Switch
          label={t('form.webhook')}
          description={t('form.webhookHint')}
          checked={d.webhookEnabled}
          onChange={(e) => set('webhookEnabled', e.currentTarget.checked)}
        />
        <Switch
          label={t('form.requireSigned')}
          description={t('form.requireSignedHint')}
          checked={d.requireSignedCommits}
          onChange={(e) => set('requireSignedCommits', e.currentTarget.checked)}
        />
        {d.requireSignedCommits && (
          <TagsInput
            label={t('form.allowedSigners')}
            description={t('form.allowedSignersHint')}
            value={d.allowedSigners}
            onChange={(v) => set('allowedSigners', v)}
            maxTags={SYNC_LIMITS.maxAllowedSigners}
            splitChars={[',', ' ', ';']}
            clearable
          />
        )}
        <Switch
          label={t('form.autoAccept')}
          description={t('form.autoAcceptHint')}
          checked={d.autoAcceptNew}
          onChange={(e) => set('autoAcceptNew', e.currentTarget.checked)}
        />
        <Switch label={t('form.enabled')} checked={d.enabled} onChange={(e) => set('enabled', e.currentTarget.checked)} />
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function SecretDialog({ path, secret, onClose }: { path: string; secret: string; onClose: () => void }) {
  const { t } = useTranslation('gitSync');
  const url = appUrl(path);
  const copyRow = (label: string, value: string) => (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <Group gap="xs" wrap="nowrap">
        <Code style={{ overflowWrap: 'anywhere', flex: 1 }} data-testid={`secret-${label}`}>
          {value}
        </Code>
        <CopyButton value={value}>
          {({ copied, copy }) => (
            <ActionIcon variant="subtle" onClick={copy} aria-label={`${t('secret.copy')}: ${label}`}>
              {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
            </ActionIcon>
          )}
        </CopyButton>
      </Group>
    </Stack>
  );
  return (
    <Modal opened onClose={onClose} title={t('secret.title')} size="lg">
      <Stack gap="sm">
        <Text size="sm">{t('secret.text')}</Text>
        {copyRow(t('secret.url'), url)}
        {copyRow(t('secret.secret'), secret)}
        <Text size="xs" c="dimmed">
          {t('secret.hint')}
        </Text>
        <Group justify="flex-end">
          <Button onClick={onClose}>{t('secret.done')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

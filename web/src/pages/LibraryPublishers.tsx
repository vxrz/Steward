import { useState } from 'react';
import { ActionIcon, Alert, Badge, Button, Card, Group, Menu, Modal, Stack, TagsInput, Text, Textarea, TextInput, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconDots, IconEdit, IconKey, IconPlus, IconShieldX, IconTrash, IconArchive } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { LibraryKey, LibraryPublisher } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { EmptyState, PageHeader, QueryState, TONE, useFieldErrors } from '../components/common';
import { confirmDanger } from '../components/confirm';
import { Fingerprint, KeyStateBadge } from '../components/libraries/parts';
import { libraryKeys } from '../queryKeys';
import { fmtDate } from '../format';

type PublisherDraft = { id: string; name: string; contact: string; libraries: string[]; existing?: boolean };

function PublisherDialog({ draft, onClose, onSaved }: { draft: PublisherDraft; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['libraries', 'common']);
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({
    id: !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(d.id) && t('publishers.idInvalid'),
    name: !d.name.trim() && t('common:validation.required'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      const body = { name: d.name, contact: d.contact, libraries: d.libraries };
      if (d.existing) await put(`/library-publishers/${encodeURIComponent(d.id)}`, body);
      else await post('/library-publishers', { id: d.id, ...body });
      notifyOk(t('publishers.saved'));
      onSaved();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={d.existing ? t('publishers.edit') : t('publishers.add')}>
      <Stack gap="sm">
        <TextInput
          label={t('publishers.id')}
          description={t('publishers.idHint')}
          required
          disabled={d.existing}
          value={d.id}
          onChange={(e) => setD({ ...d, id: e.currentTarget.value.trim().toLowerCase() })}
          error={v.error('id')}
          data-autofocus
        />
        <TextInput label={t('publishers.name')} required value={d.name} onChange={(e) => setD({ ...d, name: e.currentTarget.value })} error={v.error('name')} />
        <TextInput
          label={t('publishers.contact')}
          description={t('publishers.contactHint')}
          value={d.contact}
          onChange={(e) => setD({ ...d, contact: e.currentTarget.value })}
        />
        <TagsInput
          label={t('publishers.libraries')}
          description={t('publishers.librariesHint')}
          value={d.libraries}
          onChange={(libraries) => setD({ ...d, libraries: libraries.map((x) => x.trim().toLowerCase()) })}
          clearable
        />
        <Group justify="flex-end" mt="sm">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function KeyDialog({ publisher, onClose, onSaved }: { publisher: LibraryPublisher; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['libraries', 'common']);
  const [key, setKey] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ key: !/^(ssh-ed25519|sk-ssh-ed25519@openssh\.com) AAAA/.test(key.trim()) && t('keys.keyInvalid') });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      const k = await post<LibraryKey>(`/library-publishers/${encodeURIComponent(publisher.id)}/keys`, { key: key.trim(), expiresAt: expiresAt || null });
      notifyOk(t('keys.added', { fingerprint: k.fingerprint }));
      onSaved();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('keys.add', { name: publisher.name })} size="lg">
      <Stack gap="sm">
        <Textarea
          label={t('keys.key')}
          description={t('keys.keyHint')}
          required
          autosize
          minRows={3}
          className="mono"
          value={key}
          onChange={(e) => setKey(e.currentTarget.value)}
          error={v.error('key')}
          placeholder="sk-ssh-ed25519@openssh.com AAAA… publisher@example.com"
          data-autofocus
        />
        <TextInput
          type="date"
          label={t('keys.expires')}
          description={t('keys.expiresHint')}
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.currentTarget.value)}
          maw={220}
        />
        <Alert color="blue" variant="light">
          {t('keys.compare')}
        </Alert>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            {t('keys.trust')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function RevokeDialog({ k, onClose, onSaved }: { k: LibraryKey; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['libraries', 'common']);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ reason: reason.trim().length < 3 && t('keys.reasonNeeded') });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      await post(`/library-keys/${encodeURIComponent(k.id)}/revoke`, { reason: reason.trim() });
      notifyOk(t('keys.revoked'));
      onSaved();
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('keys.revokeTitle')}>
      <Stack gap="sm">
        <Text size="sm">{t('keys.revokeText')}</Text>
        <Fingerprint value={k.fingerprint} />
        <Textarea
          label={t('keys.reason')}
          required
          value={reason}
          onChange={(e) => setReason(e.currentTarget.value)}
          error={v.error('reason')}
          data-autofocus
          autosize
          minRows={2}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button color="red" onClick={() => void save()} loading={busy} data-testid="library-revoke-confirm">
            {t('keys.revoke')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Settings → Libraries → Trusted publishers (administrators): publishers, their keys, rotation and revocation. */
export function LibraryPublishersPage() {
  const { t } = useTranslation(['libraries', 'common']);
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: libraryKeys.publishers, queryFn: () => get<LibraryPublisher[]>('/library-publishers'), enabled: isAdmin });
  const [draft, setDraft] = useState<PublisherDraft | null>(null);
  const [keyFor, setKeyFor] = useState<LibraryPublisher | null>(null);
  const [revoke, setRevoke] = useState<LibraryKey | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: libraryKeys.all });
  if (!isAdmin) return <PageHeader back="settings" title={t('publishers.title')} description={t('publishers.adminOnly')} />;
  const add = () => setDraft({ id: '', name: '', contact: '', libraries: [] });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifyOk(ok);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const removePublisher = async (p: LibraryPublisher) => {
    if (!(await confirmDanger({ action: 'remove', message: t('publishers.removeConfirm', { name: p.name }) }))) return;
    await act(() => del(`/library-publishers/${encodeURIComponent(p.id)}`), t('publishers.removed'));
  };
  const removeKey = async (k: LibraryKey) => {
    if (!(await confirmDanger({ action: 'remove', message: t('keys.removeConfirm', { fingerprint: k.fingerprint }) }))) return;
    await act(() => del(`/library-keys/${encodeURIComponent(k.id)}`), t('keys.removed'));
  };
  const retire = async (k: LibraryKey) => {
    if (!(await confirmDanger({ action: 'confirm', title: t('keys.retireTitle'), message: t('keys.retireConfirm'), confirmLabel: t('keys.retire') }))) return;
    await act(() => post(`/library-keys/${encodeURIComponent(k.id)}/retire`, {}), t('keys.retired'));
  };
  const add_ = (
    <Button leftSection={<IconPlus size={16} />} onClick={add} data-testid="publisher-add">
      {t('publishers.add')}
    </Button>
  );
  return (
    <>
      <PageHeader back="settings" title={t('publishers.title')} description={t('publishers.description')} actions={q.data?.length ? add_ : undefined} />
      <QueryState query={q} />
      {q.data?.length === 0 && (
        <EmptyState icon={IconKey} title={t('publishers.emptyTitle')} action={add_}>
          {t('publishers.emptyText')}
        </EmptyState>
      )}
      <Stack maw={1000} gap="md">
        {q.data?.map((p) => (
          <Card withBorder key={p.id} data-testid="library-publisher" component="section" aria-labelledby={`publisher-${p.id}`}>
            <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs" mb="xs">
              <Stack gap={2} style={{ minWidth: 0, flex: '1 1 16rem' }}>
                <Group gap="xs" wrap="wrap">
                  <Title order={2} size="h4" id={`publisher-${p.id}`}>
                    {p.name}
                  </Title>
                  <Text size="xs" c="dimmed" className="mono">
                    {p.id}
                  </Text>
                  {p.builtIn && (
                    <Badge size="sm" variant="light" color={TONE.active}>
                      {t('publishers.builtIn')}
                    </Badge>
                  )}
                  {p.integrity !== 'ok' && (
                    <Badge size="sm" variant="light" color={TONE.bad}>
                      {t(`integrity.${p.integrity}`)}
                    </Badge>
                  )}
                </Group>
                <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  {p.libraries.length ? t('publishers.onlyLibraries', { libraries: p.libraries.join(', ') }) : t('publishers.anyLibrary')}
                  {p.contact ? ` · ${p.contact}` : ''}
                </Text>
                {p.installed.length > 0 && (
                  <Text size="xs" c="dimmed">
                    {t('publishers.installed', { libraries: p.installed.join(', ') })}
                  </Text>
                )}
              </Stack>
              <Group gap="xs">
                {!p.builtIn && (
                  <Button size="xs" variant="default" leftSection={<IconKey size={14} />} onClick={() => setKeyFor(p)} data-testid="publisher-add-key">
                    {t('keys.addShort')}
                  </Button>
                )}
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <Tooltip label={t('common:detailPage.moreActions')} withArrow>
                      <ActionIcon variant="default" size="input-xs" aria-label={t('common:detailPage.moreActions')}>
                        <IconDots size={16} />
                      </ActionIcon>
                    </Tooltip>
                  </Menu.Target>
                  <Menu.Dropdown>
                    {!p.builtIn && (
                      <Menu.Item leftSection={<IconEdit size={14} />} onClick={() => setDraft({ ...p, existing: true })}>
                        {t('publishers.edit')}
                      </Menu.Item>
                    )}
                    <Menu.Item leftSection={<IconTrash size={14} />} color="red" onClick={() => void removePublisher(p)}>
                      {t('publishers.remove')}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            </Group>
            <Stack gap="xs">
              {p.keys.length === 0 && (
                <Text size="sm" c="dimmed">
                  {t('keys.none')}
                </Text>
              )}
              {p.keys.map((k) => (
                <Card key={k.id} withBorder padding="xs" data-testid="library-key">
                  <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
                    <Stack gap={2} style={{ minWidth: 0, flex: '1 1 18rem' }}>
                      <Fingerprint value={k.fingerprint} />
                      <Group gap={6} wrap="wrap">
                        <KeyStateBadge state={k.state} size="xs" />
                        <Badge size="xs" variant="default">
                          {k.type === 'sk-ssh-ed25519@openssh.com' ? t('keys.hardware') : t('keys.software')}
                        </Badge>
                        {k.integrity !== 'ok' && (
                          <Badge size="xs" variant="light" color={TONE.bad}>
                            {t(`integrity.${k.integrity}`)}
                          </Badge>
                        )}
                        {k.expiresAt && (
                          <Text size="xs" c="dimmed">
                            {t('keys.validUntil', { date: k.expiresAt })}
                          </Text>
                        )}
                        {k.comment && (
                          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                            {k.comment}
                          </Text>
                        )}
                      </Group>
                      {k.state === 'revoked' && k.revokedReason && (
                        <Text size="xs" c="red">
                          {t('keys.revokedBecause', { reason: k.revokedReason, when: k.changedAt ? fmtDate(k.changedAt) : '–' })}
                        </Text>
                      )}
                    </Stack>
                    <Group gap={4}>
                      {k.state === 'active' && !k.builtIn && (
                        <Button size="compact-xs" variant="default" leftSection={<IconArchive size={12} />} onClick={() => void retire(k)}>
                          {t('keys.retire')}
                        </Button>
                      )}
                      {k.state !== 'revoked' && !k.builtIn && (
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="red"
                          leftSection={<IconShieldX size={12} />}
                          onClick={() => setRevoke(k)}
                          data-testid="library-key-revoke"
                        >
                          {t('keys.revoke')}
                        </Button>
                      )}
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        onClick={() => void removeKey(k)}
                        aria-label={t('keys.removeLabel', { fingerprint: k.fingerprint })}
                      >
                        {t('keys.remove')}
                      </Button>
                    </Group>
                  </Group>
                </Card>
              ))}
            </Stack>
          </Card>
        ))}
      </Stack>
      {draft && (
        <PublisherDialog
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={() => {
            setDraft(null);
            refresh();
          }}
        />
      )}
      {keyFor && (
        <KeyDialog
          publisher={keyFor}
          onClose={() => setKeyFor(null)}
          onSaved={() => {
            setKeyFor(null);
            refresh();
          }}
        />
      )}
      {revoke && (
        <RevokeDialog
          k={revoke}
          onClose={() => setRevoke(null)}
          onSaved={() => {
            setRevoke(null);
            refresh();
          }}
        />
      )}
    </>
  );
}

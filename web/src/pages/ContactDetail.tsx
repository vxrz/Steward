import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Checkbox, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconArrowsExchange, IconPencil, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { type ContactDetail, type ContactInput, type ContactListItem, type ContactReplaceResult } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';
import { DetailState } from '../components/common';
import { DetailPage } from '../components/page/DetailPage';
import { confirmDanger } from '../components/confirm';
import { FormModal, FormModalCancel } from '../components/FormModal';
import { DataTable } from '../components/DataTable';
import { ContactForm } from '../components/contacts/ContactForm';
import { ContactLine, ContactSearchSelect } from '../components/contacts/ContactSearch';
import { useContactRoleLabel } from '../components/contacts/hooks';
import { fmtDate } from '../format';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
        {value || '–'}
      </Text>
    </div>
  );
}

/** Replace with…: the links move to the chosen contact (visible links on items the person may change; administrators all). */
function ReplaceModal({ contact, onClose }: { contact: ContactDetail; onClose: () => void }) {
  const { t } = useTranslation('contacts');
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [target, setTarget] = useState<ContactListItem | null>(null);
  const [markLeft, setMarkLeft] = useState(false);
  const replace = useMutation({
    mutationFn: () => post<ContactReplaceResult>(`/contacts/${contact.id}/replace`, { targetId: target!.id, markLeft }),
    onSuccess: (r) => {
      notifyOk([t('replace.done', { count: r.moved }), r.skipped ? t('replace.skipped', { count: r.skipped }) : ''].filter(Boolean).join(' '));
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      void qc.invalidateQueries({ queryKey: ['contact'] });
      onClose();
      navigate(`/contacts/${r.target.id}`);
    },
    onError: (e) => notifyError(e),
  });
  return (
    <FormModal onClose={onClose} title={t('replace.title')} dirty={!!target} size="lg">
      <Stack gap="sm">
        <Text size="sm">{t(isAdmin ? 'replace.introAdmin' : 'replace.intro')}</Text>
        {target ? (
          <Paper withBorder p="xs">
            <Group justify="space-between" wrap="nowrap">
              <ContactLine contact={target} />
              <Button size="xs" variant="subtle" onClick={() => setTarget(null)}>
                {t('picker.remove', { name: target.name })}
              </Button>
            </Group>
          </Paper>
        ) : (
          <ContactSearchSelect label={t('replace.target')} exclude={[contact.id]} onPick={setTarget} testId="contact-replace-target" />
        )}
        {contact.canEdit && contact.status !== 'left' && (
          <Checkbox label={t('replace.markLeft')} checked={markLeft} onChange={(e) => setMarkLeft(e.currentTarget.checked)} />
        )}
        <Group justify="flex-end">
          <FormModalCancel />
          <Button disabled={!target} loading={replace.isPending} onClick={() => replace.mutate()} data-testid="contact-replace-submit">
            {t('replace.confirm')}
          </Button>
        </Group>
      </Stack>
    </FormModal>
  );
}

/** A contact's page: its fields, where it is named (hidden items counted, never named), Replace with…, Erase. */
export function ContactDetailPage() {
  const { id = '' } = useParams();
  const { t } = useTranslation(['contacts', 'common']);
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const roleLabel = useContactRoleLabel();
  const [editing, setEditing] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const q = useQuery({ queryKey: ['contact', id], queryFn: () => get<ContactDetail>(`/contacts/${encodeURIComponent(id)}`) });
  const save = useMutation({
    mutationFn: (c: ContactInput) => put<ContactDetail>(`/contacts/${encodeURIComponent(id)}`, c),
    onSuccess: (c) => {
      qc.setQueryData(['contact', id], c);
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      setEditing(false);
      notifyOk(t('edit.saved'));
    },
    onError: (e) => notifyError(e),
  });
  const back = { to: '/contacts', label: t('title') };
  const linkRole = (l: ContactDetail['links'][number]) => roleLabel(l.role);
  const itemLink = (l: ContactDetail['links'][number]) =>
    l.href ? (
      <Anchor component={Link} to={l.href} size="sm" fw={500}>
        {l.itemName}
      </Anchor>
    ) : (
      <Text size="sm">{l.itemName}</Text>
    );
  if (!q.data) return <DetailState query={q} back={back} />;
  const c = q.data;
  const erase = async () => {
    if (!(await confirmDanger({ action: 'delete', title: t('erase.title'), message: t('erase.message', { name: c.name }), confirmLabel: t('erase.confirm') })))
      return;
    try {
      await del(`/contacts/${encodeURIComponent(c.id)}`);
      notifyOk(t('erase.done'));
      void qc.invalidateQueries({ queryKey: ['contacts'] });
      navigate('/contacts');
    } catch (e) {
      notifyError(e);
    }
  };
  const menu = [
    ...(c.canEdit || c.links.length
      ? [{ label: t('replace.action'), icon: IconArrowsExchange, onClick: () => setReplacing(true), testId: 'contact-replace' }]
      : []),
    ...(isAdmin ? [{ label: t('erase.action'), icon: IconTrash, color: 'red', onClick: () => void erase(), testId: 'contact-erase' }] : []),
  ];
  return (
    <DetailPage
      back={back}
      title={c.name}
      status={
        <Group gap={6} component="span">
          <Badge variant="light" color={c.status === 'left' ? 'gray' : 'teal'}>
            {t(`status.${c.status}`)}
          </Badge>
          <Badge variant="outline" color="gray">
            {t(`kinds.${c.kind}`)}
          </Badge>
        </Group>
      }
      actions={
        c.canEdit ? (
          <Button size="xs" leftSection={<IconPencil size={14} />} onClick={() => setEditing(true)} data-testid="contact-edit">
            {t('edit.action')}
          </Button>
        ) : undefined
      }
      menu={menu.length ? { items: menu } : undefined}
    >
      <Stack gap="md">
        <Paper withBorder p="md">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="sm">
            <Field label={t('fields.email')} value={c.email ? <Anchor href={`mailto:${c.email}`}>{c.email}</Anchor> : ''} />
            <Field label={t('fields.phone')} value={c.phone ? <Anchor href={`tel:${c.phone.replace(/\s+/g, '')}`}>{c.phone}</Anchor> : ''} />
            <Field label={t('fields.orgUnit')} value={c.orgUnit} />
            <Field
              label={t('fields.url')}
              value={
                c.url ? (
                  <Anchor href={c.url} target="_blank" rel="noopener noreferrer">
                    {c.url}
                  </Anchor>
                ) : (
                  ''
                )
              }
            />
            <Field label={t('fields.user')} value={c.user ?? ''} />
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt="sm">
            {t('detail.created', { date: fmtDate(c.createdAt), by: c.createdBy })} · {t('detail.updated', { date: fmtDate(c.updatedAt), by: c.updatedBy })}
          </Text>
        </Paper>
        <Alert variant="light" color="gray" p="xs">
          <Text size="xs">{t('noRight')}</Text>
        </Alert>
        <div>
          <Title order={2} size="h4">
            {t('detail.whereUsed')}
          </Title>
          <Text size="xs" c="dimmed" mb="xs">
            {t('detail.whereUsedHint')}
          </Text>
          {c.links.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('detail.noLinks')}
            </Text>
          ) : (
            // a card per link on a phone, as the other lists
            <DataTable
              rows={c.links}
              rowKey={(l) => `${l.kind}:${l.itemId}:${l.role}`}
              ariaLabel={t('detail.whereUsed')}
              testId="contact-where-used"
              columns={[
                { key: 'kind', header: t('detail.kind'), sortValue: (l) => t(`linkKinds.${l.kind}`), cell: (l) => t(`linkKinds.${l.kind}`) },
                { key: 'item', header: t('detail.item'), sortValue: (l) => l.itemName.toLowerCase(), cell: (l) => itemLink(l) },
                { key: 'role', header: t('detail.role'), sortValue: (l) => linkRole(l), cell: (l) => linkRole(l) },
              ]}
              card={(l) => (
                <Paper withBorder p="sm">
                  <Stack gap={2}>
                    {itemLink(l)}
                    <Text size="xs" c="dimmed">
                      {t(`linkKinds.${l.kind}`)} · {linkRole(l)}
                    </Text>
                  </Stack>
                </Paper>
              )}
            />
          )}
          {c.hiddenLinks > 0 && (
            <Text size="sm" c="dimmed" mt="xs" data-testid="contact-hidden-links">
              {t('detail.hiddenLinks', { count: c.hiddenLinks })}
            </Text>
          )}
          {c.decisions > 0 && (
            <Text size="sm" c="dimmed" mt="xs">
              {t('detail.decisions', { count: c.decisions })}
            </Text>
          )}
        </div>
      </Stack>
      {editing && (
        <ContactForm
          title={t('edit.title')}
          submitLabel={t('edit.save')}
          initial={{ kind: c.kind, name: c.name, email: c.email, phone: c.phone, orgUnit: c.orgUnit, url: c.url, status: c.status, userId: c.user ?? null }}
          withStatus
          busy={save.isPending}
          onClose={() => setEditing(false)}
          onSubmit={(x) => save.mutate(x)}
        />
      )}
      {replacing && <ReplaceModal contact={c} onClose={() => setReplacing(false)} />}
    </DetailPage>
  );
}

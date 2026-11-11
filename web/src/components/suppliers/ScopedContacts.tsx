import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Modal, MultiSelect, Paper, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  SUPPLIER_CONTACT_ROLES,
  SUPPLIER_LIMITS,
  type ApplicationSummary,
  type ScopedContacts,
  type SupplierContact,
  type SupplierContactRole,
  type SupplierContactScopeKind,
  type SupplierContract,
  type SupplierDetail,
  type SystemSummary,
} from '@sm/shared';
import { del, get, notifyError, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';

const pathOf = (supplierId: string, x: { kind: SupplierContactScopeKind; id: string }) =>
  x.kind === 'contract' ? `/suppliers/${supplierId}/contracts/${x.id}` : x.kind === 'application' ? `/applications/${x.id}` : `/systems/${x.id}`;

/** The _Applies to_ chips of a contact (ADR 0031): the items the reader may see, and how many others for who may change it. */
export function AppliesTo({ supplierId, contact }: { supplierId: string; contact: SupplierContact }) {
  const { t } = useTranslation('suppliers');
  if (contact.companyWide)
    return (
      <Badge size="xs" variant="default">
        {t('scopedContacts.companyWide')}
      </Badge>
    );
  return (
    <Group gap={4} wrap="wrap">
      {contact.unused && (
        <Badge size="xs" color="gray" variant="light">
          {t('scopedContacts.unused')}
        </Badge>
      )}
      {contact.scope.map((x) => (
        <Badge
          key={`${x.kind}:${x.id}`}
          size="xs"
          variant="light"
          component={Link}
          to={pathOf(supplierId, x)}
          style={{ cursor: 'pointer', textTransform: 'none' }}
        >
          {t(`scopedContacts.kinds.${x.kind}`)}: {x.name}
        </Badge>
      ))}
      {contact.hiddenScope > 0 && (
        <Text size="xs" c="dimmed">
          {t('scopedContacts.hiddenItems', { count: contact.hiddenScope })}
        </Text>
      )}
    </Group>
  );
}

/**
 * The supplier's contacts (ADR 0031 part 6): company-wide first, then the scoped ones with what they apply to.
 * E-mail and phone show in the app only. Who may change a contact changes it all; who may change only some of its items
 * takes their own items off (_Remove from my contract_); the last item removes the contact.
 */
export function SupplierContacts({
  s,
  contacts,
  onSaved,
  contractId,
}: {
  s: SupplierDetail;
  contacts: SupplierContact[];
  onSaved: () => void;
  contractId?: string;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [editing, setEditing] = useState<SupplierContact | 'new' | null>(null);
  const canAdd = s.status !== 'archived' && (s.canEdit || (!!contractId && !!s.contracts.find((c) => c.id === contractId)?.canEdit));
  const remove = async (c: SupplierContact) => {
    if (!(await confirmDanger({ action: 'remove', message: t('contacts.removeConfirm', { name: c.name }) }))) return;
    try {
      await del(`/suppliers/${s.id}/contacts/${c.id}`);
      onSaved();
    } catch (e) {
      notifyError(e);
    }
  };
  /** Take one's own item off the contact; its last item removes it (asked first). */
  const takeOff = async (c: SupplierContact, item: { kind: SupplierContactScopeKind; id: string; name: string }) => {
    const rest = c.scope.filter((x) => !(x.kind === item.kind && x.id === item.id));
    if (rest.length === 0 && c.hiddenScope === 0) return remove(c);
    if (
      !(await confirmDanger({
        action: 'remove',
        title: t('scopedContacts.takeOff'),
        message: t('scopedContacts.takeOffConfirm', { name: c.name, item: item.name }),
      }))
    )
      return;
    try {
      await put(`/suppliers/${s.id}/contacts/${c.id}`, {
        name: c.name,
        role: c.role,
        email: c.email,
        phone: c.phone,
        note: c.note,
        scope: rest.map((x) => ({ kind: x.kind, id: x.id })),
      });
      onSaved();
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" data-testid="supplier-contacts">
      <Group justify="space-between">
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          {t('contacts.help')}
        </Text>
        {canAdd && (
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setEditing('new')} data-testid="contact-add">
            {t('contacts.add')}
          </Button>
        )}
      </Group>
      {contacts.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('contacts.empty')}
        </Text>
      )}
      {contacts.map((c) => (
        <Paper withBorder p="sm" key={c.id} data-testid={`contact-${c.id}`}>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div style={{ minWidth: 0 }}>
              <Text size="sm" fw={500}>
                {c.name}{' '}
                <Text span size="xs" c="dimmed">
                  {t(`contacts.roles.${c.role}`)}
                </Text>
              </Text>
              <Group gap="sm" wrap="wrap">
                {c.email && (
                  <Anchor href={`mailto:${c.email}`} size="xs">
                    {c.email}
                  </Anchor>
                )}
                {c.phone && <Text size="xs">{c.phone}</Text>}
              </Group>
              {c.note && (
                <Text size="xs" c="dimmed">
                  {c.note}
                </Text>
              )}
              <Group gap={4} mt={4} wrap="wrap">
                <Text size="xs" c="dimmed">
                  {t('scopedContacts.appliesTo')}
                </Text>
                <AppliesTo supplierId={s.id} contact={c} />
              </Group>
            </div>
            <Group gap={4} wrap="nowrap">
              {c.canEdit && (
                <>
                  <ActionIcon variant="subtle" aria-label={t('contacts.edit')} onClick={() => setEditing(c)}>
                    <IconEdit size={14} />
                  </ActionIcon>
                  <ActionIcon variant="subtle" color="red" aria-label={t('common:remove')} onClick={() => void remove(c)}>
                    <IconTrash size={14} />
                  </ActionIcon>
                </>
              )}
              {!c.canEdit &&
                c.scope
                  .filter((x) => x.canRemove)
                  .map((x) => (
                    <Button key={`${x.kind}:${x.id}`} size="compact-xs" variant="subtle" color="red" onClick={() => void takeOff(c, x)}>
                      {t('scopedContacts.takeOffNamed', { item: x.name })}
                    </Button>
                  ))}
            </Group>
          </Group>
        </Paper>
      ))}
      {editing && (
        <ContactModal
          s={s}
          contact={editing === 'new' ? undefined : editing}
          contractId={contractId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onSaved();
          }}
        />
      )}
    </Stack>
  );
}

function ContactModal({
  s,
  contact,
  contractId,
  onClose,
  onSaved,
}: {
  s: SupplierDetail;
  contact?: SupplierContact;
  contractId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [name, setName] = useState(contact?.name ?? '');
  const [role, setRole] = useState<SupplierContactRole>(contact?.role ?? 'accountManager');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [note, setNote] = useState(contact?.note ?? '');
  const initial = contact ? contact.scope.map((x) => `${x.kind}:${x.id}`) : contractId ? [`contract:${contractId}`] : [];
  const [scope, setScope] = useState<string[]>(initial);
  const apps = useQuery({ queryKey: ['applications'], queryFn: () => get<ApplicationSummary[]>('/applications') });
  const systems = useQuery({ queryKey: ['systems', 'contacts'], queryFn: () => get<SystemSummary[]>('/systems') });
  const [busy, setBusy] = useState(false);
  const options = [
    {
      group: t('scopedContacts.kinds.contract'),
      items: s.contracts.map((c: SupplierContract) => ({ value: `contract:${c.id}`, label: c.reference ? `${c.title} · ${c.reference}` : c.title })),
    },
    { group: t('scopedContacts.kinds.application'), items: (apps.data ?? []).map((a) => ({ value: `application:${a.id}`, label: a.name })) },
    { group: t('scopedContacts.kinds.system'), items: (systems.data ?? []).map((x) => ({ value: `system:${x.id}`, label: x.name })) },
  ];
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    email: !!email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && t('common:validation.invalid'),
    scope: !!contact && !contact.companyWide && scope.length === 0 && contact.hiddenScope === 0 && t('scopedContacts.lastItem'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    const body = {
      name: name.trim(),
      role,
      email: email.trim(),
      phone: phone.trim(),
      note,
      scope: scope.map((x) => {
        const [kind, ...id] = x.split(':');
        return { kind, id: id.join(':') };
      }),
    };
    try {
      if (contact) await put(`/suppliers/${s.id}/contacts/${contact.id}`, body);
      else await post(`/suppliers/${s.id}/contacts`, body);
      onSaved();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={contact ? t('contacts.edit') : t('contacts.add')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('contacts.name')}
            required
            maxLength={SUPPLIER_LIMITS.text}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={v.error('name')}
            data-autofocus
          />
          <Select
            label={t('contacts.role')}
            data={SUPPLIER_CONTACT_ROLES.map((r) => ({ value: r, label: t(`contacts.roles.${r}`) }))}
            value={role}
            allowDeselect={false}
            onChange={(r) => r && setRole(r as SupplierContactRole)}
          />
          <Group grow align="flex-start">
            <TextInput
              label={t('contacts.email')}
              type="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              error={v.error('email')}
            />
            <TextInput label={t('contacts.phone')} type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
          </Group>
          <MultiSelect
            label={t('scopedContacts.appliesTo')}
            description={contact && !contact.companyWide ? t('scopedContacts.scopedHint') : t('scopedContacts.scopeHint')}
            placeholder={scope.length ? undefined : t('scopedContacts.companyWide')}
            data={options}
            value={scope}
            onChange={setScope}
            searchable
            maxValues={SUPPLIER_LIMITS.contactScope}
            error={v.error('scope')}
            data-testid="contact-scope"
          />
          <Textarea
            label={t('contacts.note')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SUPPLIER_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} data-testid="contact-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The contacts scoped to an application or system, per supplier (its _Suppliers_ panel, ADR 0031). */
export function ItemContacts({ kind, id }: { kind: 'application' | 'system'; id: string }) {
  const { t } = useTranslation('suppliers');
  const q = useQuery({
    queryKey: ['suppliers', 'scoped-contacts', kind, id],
    queryFn: () => get<ScopedContacts[]>(`/suppliers/scoped-contacts?kind=${kind}&id=${encodeURIComponent(id)}`),
  });
  if (!q.data?.length) return null;
  return (
    <Stack gap={4} data-testid="item-supplier-contacts">
      <Text size="xs" c="dimmed">
        {t('scopedContacts.itemTitle')}
      </Text>
      {q.data.map((g) =>
        g.contacts.map((c) => (
          <Text size="sm" key={c.id}>
            <Anchor component={Link} to={`/suppliers/${g.supplier.id}?tab=contacts`} size="sm">
              {c.name}
            </Anchor>{' '}
            <Text span size="xs" c="dimmed">
              {t(`contacts.roles.${c.role}`)} · {g.supplier.name}
            </Text>
            {c.email && (
              <>
                {' '}
                <Anchor href={`mailto:${c.email}`} size="xs">
                  {c.email}
                </Anchor>
              </>
            )}
            {c.phone && <Text span size="xs">{` ${c.phone}`}</Text>}
          </Text>
        )),
      )}
    </Stack>
  );
}

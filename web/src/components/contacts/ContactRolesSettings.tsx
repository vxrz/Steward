import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CONTACT_LIMITS, CONTACT_LINK_KINDS, type ContactLinkKind, type ContactRole, type ContactRoleCardinality } from '@sm/shared';
import { ApiError, del, notifyError, notifyOk, post, put } from '../../api';
import { errorText } from '../../i18n/errors';
import { focusRowControl } from '../../focusReturn';
import { DataTable } from '../DataTable';
import { useMe } from '../../auth';
import { FormModal, FormModalCancel } from '../FormModal';
import { useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { CONTACT_ROLES_KEY, useContactRoleLabel, useContactRoles } from './hooks';

const enc = encodeURIComponent;
const KEY_RE = /^[a-z][A-Za-z0-9]{0,59}$/;

/**
 * Settings → Contacts → Roles (0.26.0, ADR 0039 part 1), for administrators: the role catalogue – list, create, edit,
 * switch off, and delete an own role nobody is named in. Built-in roles can be relabelled and switched off (altogether
 * or for one of their kinds), never deleted or re-keyed. Changes are audited (contact.role_*).
 */
export function ContactRolesSettings() {
  const { t } = useTranslation('contacts');
  const roleLabel = useContactRoleLabel();
  const { roles, loaded } = useContactRoles();
  const { isAdmin } = useMe();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ role?: ContactRole } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const changed = () => qc.invalidateQueries({ queryKey: CONTACT_ROLES_KEY });
  const used = (r: ContactRole) => Object.values(r.usage ?? {}).reduce((n, x) => n + (x ?? 0), 0);
  const kindsText = (r: ContactRole) => r.kinds.map((k) => t(`linkKinds.${k}`)).join(', ') || '–';
  const remove = async (r: ContactRole) => {
    if (!(await confirmDanger({ action: 'delete', title: t('catalogue.deleteTitle', { name: roleLabel(r.key) }), message: t('catalogue.deleteMessage') })))
      return;
    try {
      const index = roles.findIndex((x) => x.key === r.key);
      await del(`/contact-roles/${enc(r.key)}`);
      await changed();
      notifyOk(t('catalogue.deleted'));
      // the focus goes to the row that took its place (its Edit button), not to the top of the page
      focusRowControl(
        card.current,
        '[data-role-edit]',
        index,
        () => card.current?.querySelector<HTMLElement>('[data-testid="contact-role-new"]'),
        `[data-testid="contact-role-delete-${CSS.escape(r.key)}"]`,
      );
    } catch (e) {
      notifyError(e);
    }
  };
  const status = (r: ContactRole) => (
    <Group gap={4} wrap="wrap">
      <Badge size="xs" variant="light" color={r.builtIn ? 'gray' : 'blue'} tt="none">
        {r.builtIn ? t('catalogue.builtIn') : t('catalogue.own')}
      </Badge>
      {!r.active && (
        <Badge size="xs" variant="outline" color="gray" tt="none">
          {t('catalogue.off')}
        </Badge>
      )}
      {r.expected && (
        <Badge size="xs" variant="light" color="orange" tt="none">
          {t('catalogue.expected')}
        </Badge>
      )}
    </Group>
  );
  const actions = (r: ContactRole) => {
    if (!isAdmin) return null;
    const n = used(r);
    const why = n ? t('catalogue.deleteInUse') : t('catalogue.delete');
    return (
      <Group gap={2} wrap="nowrap">
        <Tooltip label={t('catalogue.edit')}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="lg"
            aria-label={t('catalogue.editTitle', { name: roleLabel(r.key) })}
            onClick={() => setEditing({ role: r })}
            data-role-edit
          >
            <IconPencil size={16} />
          </ActionIcon>
        </Tooltip>
        {/* built-in roles are switched off, never deleted: no button (the description says so) */}
        {!r.builtIn && (
          <Tooltip label={why}>
            <ActionIcon
              variant="subtle"
              color="red"
              size="lg"
              aria-label={`${why}: ${roleLabel(r.key)}`}
              disabled={n > 0}
              onClick={() => void remove(r)}
              data-testid={`contact-role-delete-${r.key}`}
            >
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    );
  };
  return (
    <Card withBorder id="contact-roles" data-testid="contact-roles" ref={card}>
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
          <div style={{ flex: 1, minWidth: 240 }}>
            <Title order={2} size="h5">
              {t('catalogue.title')}
            </Title>
            <Text size="sm" c="dimmed">
              {t('catalogue.description')}
            </Text>
          </div>
          {isAdmin && (
            <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing({})} data-testid="contact-role-new">
              {t('catalogue.new')}
            </Button>
          )}
        </Group>
        {loaded && (
          <DataTable
            testId="contact-role-table"
            ariaLabel={t('catalogue.title')}
            rows={roles}
            rowKey={(r) => r.key}
            rowProps={(r) => ({ 'data-testid': `contact-role-${r.key}` })}
            card={(r) => (
              <Stack gap={4} data-testid={`contact-role-${r.key}`}>
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <RoleName r={r} />
                  {actions(r)}
                </Group>
                <Text size="xs" c="dimmed">
                  {kindsText(r)} · {t('catalogue.cardinality')}: {t(`catalogue.cardinalities.${r.cardinality}`)}
                </Text>
                {status(r)}
              </Stack>
            )}
            columns={[
              { key: 'label', header: t('catalogue.table.label'), cell: (r) => <RoleName r={r} /> },
              { key: 'kinds', header: t('catalogue.table.kinds'), cell: (r) => <Text size="sm">{kindsText(r)}</Text> },
              { key: 'cardinality', header: t('catalogue.table.cardinality'), nowrap: true, cell: (r) => t(`catalogue.cardinalities.${r.cardinality}`) },
              { key: 'status', header: t('catalogue.table.status'), cell: status },
              ...(isAdmin
                ? [
                    {
                      key: 'usage',
                      header: t('catalogue.table.usage'),
                      nowrap: true,
                      cell: (r: ContactRole) => (used(r) ? t('catalogue.inUse', { count: used(r) }) : t('catalogue.unused')),
                    },
                    { key: 'actions', header: t('catalogue.table.actions'), cell: actions },
                  ]
                : []),
            ]}
          />
        )}
      </Stack>
      {editing && (
        <RoleForm
          role={editing.role}
          onClose={() => setEditing(null)}
          onSaved={(created) => {
            void changed();
            setEditing(null);
            notifyOk(created ? t('catalogue.created') : t('catalogue.saved'));
          }}
        />
      )}
    </Card>
  );
}

function RoleName({ r }: { r: ContactRole }) {
  const roleLabel = useContactRoleLabel();
  return (
    <Stack gap={0} style={{ minWidth: 0 }}>
      <Text size="sm" fw={500} style={{ overflowWrap: 'break-word', hyphens: 'auto' }}>
        {roleLabel(r.key)}
      </Text>
      <Text size="xs" c="dimmed" className="mono">
        {r.key}
      </Text>
    </Stack>
  );
}

function RoleForm({ role, onClose, onSaved }: { role?: ContactRole; onClose: () => void; onSaved: (created: boolean) => void }) {
  const { t } = useTranslation(['contacts', 'common']);
  const roleLabel = useContactRoleLabel();
  const [key, setKey] = useState(role?.key ?? '');
  const [en, setEn] = useState(role?.labels.en ?? '');
  const [de, setDe] = useState(role?.labels.de ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [kinds, setKinds] = useState<ContactLinkKind[]>(role?.kinds ?? []);
  const [cardinality, setCardinality] = useState<ContactRoleCardinality>(role?.cardinality ?? 'many');
  const [expected, setExpected] = useState(role?.expected ?? false);
  const [active, setActive] = useState(role?.active ?? true);
  const [busy, setBusy] = useState(false);
  // what the server refused, shown at its field until that field changes
  const [server, setServer] = useState<Partial<Record<'key' | 'en' | 'de' | 'kinds', string>>>({});
  const clear = (f: 'key' | 'en' | 'de' | 'kinds') => setServer(({ [f]: _gone, ...rest }) => rest);
  const offered = role?.builtIn ? (role.builtInKinds ?? role.kinds) : CONTACT_LINK_KINDS;
  const v = useFieldErrors({
    key: !role && !!key.trim() && !KEY_RE.test(key.trim()) && t('common:validation.invalid'),
    en: !en.trim() && t('common:validation.required'),
    kinds: !role?.builtIn && !kinds.length && t('common:validation.requiredOne'),
  });
  const save = async () => {
    setBusy(true);
    try {
      const body = {
        ...(!role && key.trim() ? { key: key.trim() } : {}),
        labels: { en: en.trim(), de: de.trim() },
        description: description.trim(),
        kinds,
        cardinality,
        expected,
        active,
      };
      if (role) await put(`/contact-roles/${enc(role.key)}`, body);
      else await post('/contact-roles', body);
      onSaved(!role);
    } catch (e) {
      const field = refusedField(e, en, de);
      if (!field) return notifyError(e);
      // rendered at once, so the field to focus is marked invalid already
      flushSync(() => setServer({ [field]: errorText(e) }));
      document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={role ? t('catalogue.editTitle', { name: roleLabel(role.key) }) : t('catalogue.newTitle')} size="lg">
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('catalogue.labelEn')}
              required
              maxLength={CONTACT_LIMITS.roleLabel}
              value={en}
              onChange={(e) => {
                setEn(e.currentTarget.value);
                clear('en');
              }}
              error={v.error('en') ?? server.en}
              data-autofocus
              data-testid="contact-role-label-en"
            />
            <TextInput
              label={t('catalogue.labelDe')}
              maxLength={CONTACT_LIMITS.roleLabel}
              value={de}
              onChange={(e) => {
                setDe(e.currentTarget.value);
                clear('de');
              }}
              error={server.de}
              data-testid="contact-role-label-de"
            />
          </SimpleGrid>
          <TextInput
            label={t('catalogue.key')}
            description={t('catalogue.keyHint')}
            maxLength={60}
            value={key}
            onChange={(e) => {
              setKey(e.currentTarget.value);
              clear('key');
            }}
            error={v.error('key') ?? server.key}
            disabled={!!role}
            classNames={{ input: 'mono' }}
            data-testid="contact-role-key"
          />
          <Textarea
            label={t('catalogue.descriptionField')}
            maxLength={CONTACT_LIMITS.roleDescription}
            autosize
            minRows={2}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Checkbox.Group
            label={t('catalogue.kinds')}
            description={role?.builtIn ? t('catalogue.kindsHint') : undefined}
            value={kinds}
            onChange={(x) => {
              setKinds(x as ContactLinkKind[]);
              clear('kinds');
            }}
            error={v.error('kinds') ?? server.kinds}
            data-testid="contact-role-kinds"
          >
            <SimpleGrid cols={{ base: 1, xs: 2, sm: 3 }} mt={6} spacing={6}>
              {offered.map((k) => (
                <Checkbox key={k} value={k} label={t(`linkKinds.${k}`)} data-testid={`contact-role-kind-${k}`} />
              ))}
            </SimpleGrid>
          </Checkbox.Group>
          <Stack gap={4}>
            <Text size="sm" fw={500} id="contact-role-cardinality">
              {t('catalogue.cardinality')}
            </Text>
            <SegmentedControl
              aria-labelledby="contact-role-cardinality"
              value={cardinality}
              onChange={(x) => setCardinality(x as ContactRoleCardinality)}
              data={(['many', 'one'] as const).map((c) => ({ value: c, label: t(`catalogue.cardinalities.${c}`) }))}
              data-testid="contact-role-cardinality"
            />
          </Stack>
          <Switch
            label={t('catalogue.expected')}
            description={t('catalogue.expectedHint')}
            checked={expected}
            onChange={(e) => setExpected(e.currentTarget.checked)}
            data-testid="contact-role-expected"
          />
          <Switch
            label={t('catalogue.active')}
            description={t('catalogue.activeHint')}
            checked={active}
            onChange={(e) => setActive(e.currentTarget.checked)}
            data-testid="contact-role-active"
          />
          <Group justify="flex-end" mt="sm">
            <FormModalCancel>{t('catalogue.cancel')}</FormModalCancel>
            <Button type="submit" loading={busy} data-testid="contact-role-save">
              {role ? t('catalogue.save') : t('catalogue.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

/** The field a refusal of the server belongs to (null: none – shown as a notification). */
function refusedField(e: unknown, en: string, de: string): 'key' | 'en' | 'de' | 'kinds' | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'CONTACT_ROLE_TAKEN') return 'key';
  if (e.code === 'CONTACT_ROLE_KINDS' || (e.code === 'CONTACT_ROLE_BUILT_IN' && e.params?.context === 'kinds')) return 'kinds';
  if (e.code === 'CONTACT_ROLE_LABEL_TAKEN') {
    const label = String(e.params?.label ?? '')
      .trim()
      .toLowerCase();
    return de.trim().toLowerCase() === label && en.trim().toLowerCase() !== label ? 'de' : 'en';
  }
  return null;
}

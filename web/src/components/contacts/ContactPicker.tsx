import { useMemo, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Paper, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CONTACT_LIMITS,
  CONTACT_LINK_ROLES,
  type ContactInput,
  type ContactLink,
  type ContactLinkInput,
  type ContactLinkKind,
  type ContactRef,
} from '@sm/shared';
import { ContactForm } from './ContactForm';
import { ContactLine, ContactSearchSelect } from './ContactSearch';
import { useContactRoleLabel } from './hooks';

/**
 * The contacts of an item (ADR 0038, docs/CONTACTS.md): pick from the directory – only contacts the person may see are
 * offered, matched by name and e-mail address – or create one on the way, each with a role of the item's kind
 * (CONTACT_LINK_ROLES; free text where the kind has no list, e.g. plant sites).
 *
 * The value is a list of links as the server takes them (ContactLinkInput) with what to show (`display`); send
 * `toLinkInputs(value)`, start from `fromLinks(item.contacts)`.
 */

/** One contact of the item: an existing one (contactId + display) or a new one (contact). */
export type ContactPickerValue = ContactLinkInput & { display?: ContactRef };

/** The picker's value from the links an item shows. */
export const fromLinks = (links: readonly ContactLink[]): ContactPickerValue[] =>
  links.map((l) => ({ role: l.role, contactId: l.contact.id, display: l.contact }));

/** What the server takes (setLinks): links without what is only shown. */
export const toLinkInputs = (value: readonly ContactPickerValue[]): ContactLinkInput[] =>
  value.map(({ display: _d, ...l }) => (l.contactId ? { role: l.role, contactId: l.contactId } : { role: l.role, contact: l.contact }));

/**
 * The contacts of an item with their roles. Keyboard: the search is a combobox (type, arrows, Enter), every row's role
 * and remove button are in the tab order; screen readers hear the field's label, each row's name and the remove
 * button's "Remove <name>". On a phone the rows stack.
 */
export function ContactPicker({
  kind,
  value,
  onChange,
  label,
  description,
  roles,
  disabled,
  error,
  testId = 'contact-picker',
}: {
  kind: ContactLinkKind;
  value: ContactPickerValue[];
  onChange: (v: ContactPickerValue[]) => void;
  label: string;
  description?: string;
  /** Only these roles of the kind (default: all of them) */
  roles?: readonly string[];
  disabled?: boolean;
  error?: string;
  testId?: string;
}) {
  const { t } = useTranslation('contacts');
  const roleLabel = useContactRoleLabel();
  const kindRoles: readonly string[] | null = CONTACT_LINK_ROLES[kind];
  const roleOptions = useMemo(() => (kindRoles ? kindRoles.filter((r) => !roles || roles.includes(r)) : null), [kindRoles, roles]);
  const [role, setRole] = useState<string>(roleOptions?.[0] ?? '');
  const [creating, setCreating] = useState(false);
  const perRole = (r: string) => value.filter((v) => v.role === r).length;
  const full = !!role && perRole(role) >= CONTACT_LIMITS.perRole;
  const freeRoleOk = !!role.trim() && role.trim().length <= CONTACT_LIMITS.role;
  const add = (v: ContactPickerValue) => {
    if (v.contactId && value.some((x) => x.contactId === v.contactId && x.role === v.role)) return;
    onChange([...value, v]);
  };
  const rowName = (v: ContactPickerValue) => v.display?.name ?? v.contact?.name ?? '';
  const chosenIds = value.filter((v) => v.role === role && v.contactId).map((v) => v.contactId!);
  const roleField = roleOptions ? (
    <Select
      label={t('picker.role')}
      data={roleOptions.map((r) => ({ value: r, label: roleLabel(r) }))}
      value={role}
      onChange={(r) => setRole(r ?? roleOptions[0]!)}
      allowDeselect={false}
      disabled={disabled}
      w={{ base: '100%', xs: 200 }}
      data-testid={`${testId}-role`}
    />
  ) : (
    <TextInput
      label={t('picker.roleFree')}
      placeholder={t('picker.rolePlaceholder')}
      value={role}
      maxLength={CONTACT_LIMITS.role}
      onChange={(e) => setRole(e.currentTarget.value)}
      disabled={disabled}
      w={{ base: '100%', xs: 200 }}
      data-testid={`${testId}-role`}
    />
  );
  return (
    <Stack gap={6} data-testid={testId} role="group" aria-label={label}>
      <div>
        <Text size="sm" fw={500} component="div">
          {label}
        </Text>
        {description && (
          <Text size="xs" c="dimmed">
            {description}
          </Text>
        )}
      </div>
      {value.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('picker.none')}
        </Text>
      ) : (
        <Stack gap={4} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {value.map((v, i) => {
            const name = rowName(v);
            return (
              <Paper key={`${v.role}:${v.contactId ?? `new-${i}`}`} withBorder p={6} component="li">
                <Group justify="space-between" wrap="nowrap" align="center" gap="xs">
                  <Group gap="xs" wrap="wrap" style={{ minWidth: 0, flex: 1 }}>
                    <Badge variant="light" tt="none" style={{ flexShrink: 0 }}>
                      {roleOptions ? roleLabel(v.role) : v.role}
                    </Badge>
                    <ContactLine
                      contact={v.display ?? { name, email: v.contact?.email ?? '', orgUnit: v.contact?.orgUnit ?? '', status: 'active' }}
                      isNew={!v.contactId}
                    />
                  </Group>
                  {!disabled && (
                    <Tooltip label={t('picker.remove', { name })} withArrow>
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="lg"
                        aria-label={t('picker.remove', { name })}
                        onClick={() => onChange(value.filter((_, j) => j !== i))}
                      >
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              </Paper>
            );
          })}
        </Stack>
      )}
      {!disabled && (
        <Group gap="xs" align="flex-end" wrap="wrap">
          {roleField}
          <div style={{ flex: 1, minWidth: 220 }}>
            <ContactSearchSelect
              label={t('picker.search')}
              exclude={chosenIds}
              disabled={full || (!roleOptions && !freeRoleOk)}
              onPick={(c) => add({ role: role.trim(), contactId: c.id, display: c })}
              testId={`${testId}-search`}
            />
          </div>
          <Button
            variant="default"
            leftSection={<IconUserPlus size={16} />}
            onClick={() => setCreating(true)}
            disabled={full || (!roleOptions && !freeRoleOk)}
            data-testid={`${testId}-new`}
          >
            {t('picker.createNew')}
          </Button>
        </Group>
      )}
      {full && (
        <Text size="xs" c="dimmed">
          {t('picker.limit', { max: CONTACT_LIMITS.perRole })}
        </Text>
      )}
      {error && (
        <Text size="xs" c="red" role="alert">
          {error}
        </Text>
      )}
      {creating && (
        <ContactForm
          title={t('picker.createTitle')}
          submitLabel={t('picker.add')}
          onClose={() => setCreating(false)}
          offerMatches
          onSubmit={(c: ContactInput) => {
            add({ role: role.trim(), contact: c });
            setCreating(false);
          }}
          onUseExisting={(c) => {
            add({ role: role.trim(), contactId: c.id, display: c });
            setCreating(false);
          }}
        />
      )}
    </Stack>
  );
}

/** Whether two values name the same contacts in the same roles (for "unsaved changes"). */
export const sameContacts = (a: readonly ContactPickerValue[], b: readonly ContactPickerValue[]): boolean =>
  JSON.stringify(toLinkInputs(a)) === JSON.stringify(toLinkInputs(b));

/** The contacts of an item, read only: role, name, e-mail address, phone. */
export function ContactLinksView({ links, kind }: { links: readonly ContactLink[]; kind: ContactLinkKind }) {
  const { t } = useTranslation('contacts');
  const roleLabel = useContactRoleLabel();
  const listed = CONTACT_LINK_ROLES[kind];
  if (!links.length)
    return (
      <Text size="sm" c="dimmed">
        {t('picker.none')}
      </Text>
    );
  return (
    <Stack gap={4} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {links.map((l) => (
        <Group key={`${l.role}:${l.contact.id}`} gap="xs" wrap="wrap" component="li">
          <Badge variant="light" tt="none">
            {listed ? roleLabel(l.role) : l.role}
          </Badge>
          <ContactLine contact={{ ...l.contact, email: l.contact.email ?? '', orgUnit: l.contact.orgUnit ?? '' }} />
          {l.contact.phone && (
            <Text size="xs" c="dimmed">
              {l.contact.phone}
            </Text>
          )}
        </Group>
      ))}
    </Stack>
  );
}

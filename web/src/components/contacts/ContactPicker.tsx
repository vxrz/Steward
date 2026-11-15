import { useMemo, useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Paper, Select, Stack, Text, TextInput, Tooltip, VisuallyHidden } from '@mantine/core';
import { IconCalendarUser, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CONTACT_LIMITS,
  contactLinkEnded,
  contactRoleOn,
  missingExpectedRoles,
  type ContactInput,
  type ContactLink,
  type ContactLinkInput,
  type ContactLinkKind,
  type ContactRef,
  type ContactRole,
  type InheritedContactLink,
} from '@sm/shared';
import { ContactForm } from './ContactForm';
import { ContactLine, ContactSearchSelect } from './ContactSearch';
import { useContactRoleLabel, useContactRoles } from './hooks';
import { fmtDayOnly } from '../../format';

/**
 * The contacts of an item (ADR 0038, docs/CONTACTS.md): pick from the directory – only contacts the person may see are
 * offered, matched by name and e-mail address – or create one on the way, each with a role of the role catalogue that
 * is switched on for the item's kind (0.26.0, ADR 0039: Settings → Contacts → Roles). A link can name the contact it
 * stands in for (deputy, same role) and the day it ends (until).
 *
 * The value is a list of links as the server takes them (ContactLinkInput) with what to show (`display`); send
 * `toLinkInputs(value)`, start from `fromLinks(item.contacts)`.
 */

/** One contact of the item: an existing one (contactId + display) or a new one (contact). */
export type ContactPickerValue = ContactLinkInput & { display?: ContactRef };

/** The picker's value from the links an item shows. */
export const fromLinks = (links: readonly ContactLink[]): ContactPickerValue[] =>
  links.map((l) => ({ role: l.role, contactId: l.contact.id, display: l.contact, deputyOf: l.deputyOf ?? null, until: l.until ?? null }));

/** What the server takes (setLinks): links without what is only shown. */
export const toLinkInputs = (value: readonly ContactPickerValue[]): ContactLinkInput[] =>
  value.map(({ display: _d, ...l }) =>
    l.contactId
      ? { role: l.role, contactId: l.contactId, deputyOf: l.deputyOf ?? null, until: l.until || null }
      : { role: l.role, contact: l.contact, until: l.until || null },
  );

/** Whether a link's role is switched off for the kind (kept, marked). */
const roleOff = (roles: readonly ContactRole[], kind: ContactLinkKind, role: string) => {
  const r = roles.find((x) => x.key === role);
  return !!r && !contactRoleOn(r, kind);
};

/**
 * The contacts of an item with their roles. Keyboard: the search is a combobox (type, arrows, Enter), every row's
 * details and remove buttons are in the tab order; screen readers hear the field's label, each row's name and the
 * buttons' "Remove <name>" and "Deputy and end date: <name>". On a phone the rows stack.
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
  const { roles: catalogue } = useContactRoles();
  const roleOptions = useMemo(() => catalogue.filter((r) => contactRoleOn(r, kind) && (!roles || roles.includes(r.key))), [catalogue, kind, roles]);
  const [chosenRole, setRole] = useState<string>('');
  const role = roleOptions.some((r) => r.key === chosenRole) ? chosenRole : (roleOptions[0]?.key ?? '');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  // what changed, for screen readers (the list itself changes silently)
  const [said, setSaid] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const perRole = (r: string) => value.filter((v) => v.role === r).length;
  const full = !!role && perRole(role) >= CONTACT_LIMITS.perRole;
  const rowName = (v: ContactPickerValue | undefined) => v?.display?.name ?? v?.contact?.name ?? '';
  const one = roleOptions.find((r) => r.key === role)?.cardinality === 'one';
  // a role of one contact that has a current one: a new contact stands in for it (changeable in its details)
  const taken = one ? value.find((v) => v.role === role && !v.deputyOf && v.contactId && !contactLinkEnded(v)) : undefined;
  const add = (v: ContactPickerValue) => {
    if (v.contactId && value.some((x) => x.contactId === v.contactId && x.role === v.role)) return;
    onChange([...value, taken && v.contactId ? { ...v, deputyOf: taken.contactId } : v]);
    setSaid(t('picker.added', { name: rowName(v), role: roleLabel(v.role) }));
  };
  const update = (i: number, patch: Partial<ContactPickerValue>) => onChange(value.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  /** Removes row i; the focus goes to the next row's remove button, else the previous one, else the search. */
  const remove = (i: number) => {
    const gone = value[i]!;
    const name = rowName(gone);
    // who stood in for the removed contact stands in for nobody
    onChange(value.filter((_, j) => j !== i).map((v) => (v.role === gone.role && v.deputyOf && v.deputyOf === gone.contactId ? { ...v, deputyOf: null } : v)));
    setSaid(t('picker.removed', { name }));
    setOpen(null);
    requestAnimationFrame(() => {
      const buttons = box.current?.querySelectorAll<HTMLElement>('[data-contact-remove]') ?? [];
      (buttons[Math.min(i, buttons.length - 1)] ?? box.current?.querySelector<HTMLElement>(`[data-testid="${testId}-search"]`))?.focus();
    });
  };
  const chosenIds = value.filter((v) => v.role === role && v.contactId).map((v) => v.contactId!);
  const noRoles = roleOptions.length === 0;
  return (
    <Stack gap={6} data-testid={testId} role="group" aria-label={label} ref={box}>
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
            const others = value.filter((x) => x.role === v.role && x.contactId && x.contactId !== v.contactId && !x.deputyOf);
            const deputyName = v.deputyOf ? rowName(value.find((x) => x.contactId === v.deputyOf)) : '';
            return (
              <Paper key={`${v.role}:${v.contactId ?? `new-${i}`}`} withBorder p={6} component="li" data-testid={`${testId}-row`}>
                <Group justify="space-between" wrap="nowrap" align="center" gap="xs">
                  <Group gap="xs" wrap="wrap" style={{ minWidth: 0, flex: 1 }}>
                    <Badge variant="light" tt="none" style={{ flexShrink: 0 }} color={roleOff(catalogue, kind, v.role) ? 'gray' : undefined}>
                      {roleLabel(v.role) || t('picker.noRole')}
                    </Badge>
                    <ContactLine
                      contact={v.display ?? { name, email: v.contact?.email ?? '', orgUnit: v.contact?.orgUnit ?? '', status: 'active' }}
                      isNew={!v.contactId}
                    />
                    <LinkMarks kind={kind} role={v.role} deputyName={deputyName} until={v.until ?? null} />
                  </Group>
                  {!disabled && (
                    <Group gap={2} wrap="nowrap">
                      <Tooltip label={t('picker.details', { name })} withArrow>
                        <ActionIcon
                          variant={open === i ? 'light' : 'subtle'}
                          size="lg"
                          aria-label={t('picker.details', { name })}
                          aria-expanded={open === i}
                          onClick={() => setOpen(open === i ? null : i)}
                          data-testid={`${testId}-details`}
                        >
                          <IconCalendarUser size={16} />
                        </ActionIcon>
                      </Tooltip>
                      <Tooltip label={t('picker.remove', { name })} withArrow>
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          size="lg"
                          aria-label={t('picker.remove', { name })}
                          onClick={() => remove(i)}
                          data-contact-remove
                        >
                          <IconTrash size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  )}
                </Group>
                {open === i && !disabled && (
                  <Group gap="xs" mt={6} align="flex-end" wrap="wrap">
                    {v.contactId && (
                      <Select
                        label={t('picker.deputyOf')}
                        placeholder={t('picker.deputyNone')}
                        data={others.map((x) => ({ value: x.contactId!, label: rowName(x) }))}
                        value={v.deputyOf ?? null}
                        onChange={(d) => update(i, { deputyOf: d })}
                        clearable
                        disabled={!others.length}
                        w={{ base: '100%', xs: 220 }}
                        data-testid={`${testId}-deputy`}
                      />
                    )}
                    <TextInput
                      type="date"
                      label={t('picker.until')}
                      value={v.until ?? ''}
                      onChange={(e) => update(i, { until: e.currentTarget.value || null })}
                      w={{ base: '100%', xs: 180 }}
                      data-testid={`${testId}-until`}
                    />
                  </Group>
                )}
              </Paper>
            );
          })}
        </Stack>
      )}
      {!disabled && (
        <Group gap="xs" align="flex-end" wrap="wrap">
          <Select
            label={t('picker.role')}
            data={roleOptions.map((r) => ({ value: r.key, label: roleLabel(r.key) }))}
            value={role || null}
            onChange={(r) => setRole(r ?? '')}
            allowDeselect={false}
            disabled={noRoles}
            w={{ base: '100%', xs: 200 }}
            data-testid={`${testId}-role`}
          />
          <div style={{ flex: 1, minWidth: 220 }}>
            <ContactSearchSelect
              label={t('picker.search')}
              description={noRoles ? t('picker.noRoles') : taken ? t('picker.oneTaken', { role: roleLabel(role), name: rowName(taken) }) : undefined}
              exclude={chosenIds}
              error={!!error}
              disabled={full || noRoles}
              onPick={(c) => add({ role, contactId: c.id, display: c })}
              testId={`${testId}-search`}
            />
          </div>
          <Button
            variant="default"
            leftSection={<IconUserPlus size={16} />}
            onClick={() => setCreating(true)}
            disabled={full || noRoles}
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
      <VisuallyHidden role="status" aria-live="polite" data-testid={`${testId}-status`}>
        {said}
      </VisuallyHidden>
      {creating && (
        <ContactForm
          title={t('picker.createTitle')}
          submitLabel={t('picker.add')}
          onClose={() => setCreating(false)}
          offerMatches
          onSubmit={(c: ContactInput) => {
            add({ role, contact: c });
            setCreating(false);
          }}
          onUseExisting={(c) => {
            add({ role, contactId: c.id, display: c });
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

/** A link's marks: the role switched off, whom a deputy stands in for, until when – or ended. */
function LinkMarks({ kind, role, deputyName, until }: { kind: ContactLinkKind; role: string; deputyName: string; until: string | null }) {
  const { t } = useTranslation('contacts');
  const { roles } = useContactRoles();
  return (
    <>
      {roleOff(roles, kind, role) && (
        <Badge size="xs" color="gray" variant="outline" tt="none">
          {t('picker.roleOff')}
        </Badge>
      )}
      {deputyName && (
        <Text size="xs" c="dimmed">
          {t('picker.deputyFor', { name: deputyName })}
        </Text>
      )}
      {until &&
        (contactLinkEnded({ until }) ? (
          <Badge size="xs" color="gray" variant="light" tt="none" data-testid="contact-ended">
            {t('picker.ended', { date: fmtDayOnly(until) })}
          </Badge>
        ) : (
          <Text size="xs" c="dimmed">
            {t('picker.untilDate', { date: fmtDayOnly(until) })}
          </Text>
        ))}
    </>
  );
}

/** The contacts of an item, read only: role, name, e-mail address, phone – with deputy, until and ended (0.26.0). */
export function ContactLinksView({ links, kind }: { links: readonly ContactLink[]; kind: ContactLinkKind }) {
  const { t } = useTranslation('contacts');
  const roleLabel = useContactRoleLabel();
  const { roles } = useContactRoles();
  if (!links.length)
    return (
      <Text size="sm" c="dimmed">
        {t('picker.none')}
      </Text>
    );
  const nameOf = new Map(links.map((l) => [l.contact.id, l.contact.name]));
  return (
    <Stack gap={4} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {links.map((l) => (
        <Group key={`${l.role}:${l.contact.id}`} gap="xs" wrap="wrap" component="li">
          <Badge variant="light" tt="none" color={roleOff(roles, kind, l.role) ? 'gray' : undefined}>
            {roleLabel(l.role) || t('picker.noRole')}
          </Badge>
          <ContactLine contact={{ ...l.contact, email: l.contact.email ?? '', orgUnit: l.contact.orgUnit ?? '' }} />
          {l.contact.phone && (
            <Text size="xs" c="dimmed">
              {l.contact.phone}
            </Text>
          )}
          <LinkMarks kind={kind} role={l.role} deputyName={l.deputyOf ? (nameOf.get(l.deputyOf) ?? '') : ''} until={l.until ?? null} />
        </Group>
      ))}
    </Stack>
  );
}

/**
 * Contacts an item shows from its domain (0.26.0, ADR 0039 part 2): read only, marked "from domain …" – never copied;
 * they are changed on the domain.
 */
export function InheritedContactsView({ links, testId = 'inherited-contacts' }: { links: readonly InheritedContactLink[]; testId?: string }) {
  const { t } = useTranslation('contacts');
  const roleLabel = useContactRoleLabel();
  if (!links.length) return null;
  const nameOf = new Map(links.map((l) => [l.contact.id, l.contact.name]));
  return (
    <Stack gap={4} data-testid={testId}>
      <Text size="xs" c="dimmed">
        {t('inherited.hint')}
      </Text>
      <Stack gap={4} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {links.map((l) => (
          <Group key={`${l.from.id}:${l.role}:${l.contact.id}`} gap="xs" wrap="wrap" component="li">
            <Badge variant="outline" tt="none">
              {roleLabel(l.role)}
            </Badge>
            <ContactLine contact={{ ...l.contact, email: l.contact.email ?? '', orgUnit: l.contact.orgUnit ?? '' }} />
            <Text size="xs" c="dimmed">
              {t('inherited.from', { name: l.from.name })}
            </Text>
            <LinkMarks kind="data_domain" role={l.role} deputyName={l.deputyOf ? (nameOf.get(l.deputyOf) ?? '') : ''} until={l.until ?? null} />
          </Group>
        ))}
      </Stack>
    </Stack>
  );
}

/** The hint of an item that lacks a contact in an expected role (own or inherited, not ended). */
export function ExpectedRolesHint({
  kind,
  links,
  inherited = [],
}: {
  kind: ContactLinkKind;
  links: readonly { role: string; until?: string | null }[];
  inherited?: readonly { role: string; until?: string | null }[];
}) {
  const { t } = useTranslation('contacts');
  const roleLabel = useContactRoleLabel();
  const { roles, loaded } = useContactRoles();
  const missing = loaded ? missingExpectedRoles(roles, kind, links, inherited) : [];
  if (!missing.length) return null;
  return (
    <Text size="xs" c="orange.8" data-testid="contacts-expected">
      {t('expected.missing', { count: missing.length, roles: missing.map(roleLabel).join(', ') })}
    </Text>
  );
}

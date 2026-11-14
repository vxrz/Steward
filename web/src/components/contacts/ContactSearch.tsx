import { useState } from 'react';
import { Badge, Group, Select, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { ContactListItem, ContactRef } from '@sm/shared';
import { useContactSearch } from './hooks';

/** One contact as a line: name, the e-mail address and organisational unit, "left", "new". */
export function ContactLine({ contact, isNew }: { contact: Pick<ContactRef, 'name' | 'email' | 'orgUnit' | 'status'>; isNew?: boolean }) {
  const { t } = useTranslation('contacts');
  const sub = [contact.email, contact.orgUnit].filter(Boolean).join(' · ');
  return (
    <div style={{ minWidth: 0 }}>
      <Group gap={6} wrap="wrap">
        <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere' }}>
          {contact.name}
        </Text>
        {contact.status === 'left' && (
          <Badge size="xs" color="gray" variant="light">
            {t('picker.left')}
          </Badge>
        )}
        {isNew && (
          <Badge size="xs" variant="light">
            {t('picker.new')}
          </Badge>
        )}
      </Group>
      {sub && (
        <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
          {sub}
        </Text>
      )}
    </div>
  );
}

/**
 * A searchable select of the directory: the contacts the person may see, by name or e-mail address. `exclude`: ids
 * already chosen. Calls `onPick` with the chosen contact and clears itself.
 */
export function ContactSearchSelect({
  label,
  description,
  error,
  exclude = [],
  onPick,
  disabled,
  status = 'active',
  testId,
}: {
  label: string;
  description?: string;
  /** Marks the field invalid (the message is shown by the picker) */
  error?: boolean;
  exclude?: readonly string[];
  onPick: (c: ContactListItem) => void;
  disabled?: boolean;
  status?: 'active' | 'all';
  testId?: string;
}) {
  const { t } = useTranslation('contacts');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const found = useContactSearch(q, { status, enabled: open || !!q });
  const items = (found.data?.items ?? []).filter((c) => !exclude.includes(c.id));
  const byId = new Map(items.map((c) => [c.id, c]));
  return (
    <Select
      label={label}
      description={description}
      error={error}
      placeholder={t('picker.searchPlaceholder')}
      searchable
      searchValue={q}
      onSearchChange={setQ}
      onDropdownOpen={() => setOpen(true)}
      // opened by typing, a click or the arrow keys – not by the focus alone (tabbing through a form, the focus moved
      // to a field with an error, or back after a removal)
      openOnFocus={false}
      value={null}
      disabled={disabled}
      // the server searched already: show what it found
      filter={({ options }) => options}
      data={items.map((c) => ({ value: c.id, label: c.email ? `${c.name} <${c.email}>` : c.name }))}
      nothingFoundMessage={found.isFetching ? '…' : t('picker.nothingFound')}
      renderOption={({ option }) => {
        const c = byId.get(option.value);
        return c ? <ContactLine contact={c} /> : option.label;
      }}
      onChange={(id) => {
        const c = id ? byId.get(id) : undefined;
        if (!c) return;
        onPick(c);
        setQ('');
      }}
      comboboxProps={{ withinPortal: true }}
      data-testid={testId ?? 'contact-search'}
    />
  );
}

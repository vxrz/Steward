import { useState } from 'react';
import { Button, Group, Stack, Text } from '@mantine/core';
import { IconEdit } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ContactLink, ContactLinkInput, ContactLinkKind } from '@sm/shared';
import { notifyOk } from '../../api';
import { errorText } from '../../i18n/errors';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { ContactLinksView, ContactPicker, ExpectedRolesHint, fromLinks, sameContacts, toLinkInputs, type ContactPickerValue } from './ContactPicker';

/**
 * The business contacts of an item as a section of its page (0.26.0, ADR 0039: applications and systems): read only,
 * with Edit for who may change the item – the picker, saved as a whole. A contact never gives a right.
 */
export function ItemContactsSection({
  id,
  kind,
  contacts,
  canEdit,
  onSave,
  description,
  children,
}: {
  /** The section's id (its folded state is remembered) */
  id: string;
  kind: ContactLinkKind;
  contacts: readonly ContactLink[];
  canEdit: boolean;
  onSave: (links: ContactLinkInput[]) => Promise<void>;
  description?: string;
  /** Further read-only panels below (the contacts of an application's services) */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation('contacts');
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<ContactPickerValue[]>([]);
  const [saving, setSaving] = useState(false);
  // the server's refusal, shown at the picker (a role switched off, a second contact in a role of one, a bad deputy)
  const [error, setError] = useState<string | undefined>();
  const focus = (selector: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
  const start = () => {
    setValue(fromLinks(contacts));
    setError(undefined);
    setEditing(true);
    // into the picker: its role, else (no role to choose) its search
    focus(`[data-testid="${id}-picker-role"]:not(:disabled), [data-testid="${id}-picker-search"]`);
  };
  /** Back to reading: the focus returns to Edit (the buttons that had it are gone). */
  const stop = () => {
    setEditing(false);
    setError(undefined);
    focus(`[data-testid="${id}-edit"]`);
  };
  const save = async () => {
    setSaving(true);
    try {
      await onSave(toLinkInputs(value));
      stop();
      notifyOk(t('section.saved'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <CollapsibleSection
      id={id}
      testId={id}
      size="h5"
      title={t('section.title')}
      count={contacts.length}
      defaultOpen
      actions={
        canEdit && !editing ? (
          <Button size="xs" variant="default" leftSection={<IconEdit size={14} />} onClick={start} data-testid={`${id}-edit`}>
            {t('section.edit')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          {description ?? t('noRight')}
        </Text>
        {editing ? (
          <>
            <ContactPicker
              kind={kind}
              label={t('section.title')}
              value={value}
              onChange={(v) => {
                setValue(v);
                setError(undefined);
              }}
              error={error}
              testId={`${id}-picker`}
            />
            <Group gap="xs" justify="flex-end">
              <Button variant="default" size="xs" onClick={stop} disabled={saving}>
                {t('section.cancel')}
              </Button>
              <Button size="xs" onClick={save} loading={saving} disabled={sameContacts(value, fromLinks(contacts))} data-testid={`${id}-save`}>
                {t('section.save')}
              </Button>
            </Group>
          </>
        ) : (
          <>
            <ContactLinksView links={contacts} kind={kind} />
            <ExpectedRolesHint kind={kind} links={contacts} />
          </>
        )}
        {children}
      </Stack>
    </CollapsibleSection>
  );
}

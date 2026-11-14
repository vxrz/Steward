import { useRef, useState } from 'react';
import { ActionIcon, Badge, Button, Group, Paper, Stack, Text, TextInput, Tooltip, VisuallyHidden } from '@mantine/core';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CONTACT_LIMITS, type ContactDetail, type ContactInput } from '@sm/shared';
import { notifyError, post } from '../../api';
import { ContactForm } from './ContactForm';
import { ContactSearchSelect } from './ContactSearch';
import { useContactRoleLabel } from './hooks';

/**
 * Who decided (ADR 0038, DocumentedDecision.decidedBy): contacts from the directory – the person may see them, they
 * have not left – each with a role (a role of the module, e.g. domainOwner, or free text). The names are frozen by the
 * server when the decision is recorded (snapshotsOf). A new contact is created in the directory first (linked to
 * nothing until the decision names it, so seen by its author).
 *
 * The value is what documentedDecisionInput.decidedBy takes, with the name to show.
 */
export interface ContactSnapshotValue {
  contactId: string;
  role: string;
  /** Shown only */
  name: string;
}

export function ContactSnapshotPicker({
  value,
  onChange,
  label,
  description,
  defaultRole = '',
  roles,
  canCreate = true,
  error,
  testId = 'contact-snapshot-picker',
}: {
  value: ContactSnapshotValue[];
  onChange: (v: ContactSnapshotValue[]) => void;
  label?: string;
  description?: string;
  /** The role a newly picked contact gets (editable per row) */
  defaultRole?: string;
  /** Roles with a translated label (contacts:roles.<role>); others are free text */
  roles?: readonly string[];
  /** Offer "New contact" (POST /contacts: who works in Steward) */
  canCreate?: boolean;
  error?: string;
  testId?: string;
}) {
  const { t } = useTranslation('contacts');
  const roleLabel = useContactRoleLabel();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  // what changed, for screen readers (the list itself changes silently)
  const [said, setSaid] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const full = value.length >= CONTACT_LIMITS.decidedBy;
  const add = (contactId: string, name: string) => {
    if (full || value.some((v) => v.contactId === contactId)) return;
    onChange([...value, { contactId, name, role: defaultRole }]);
    setSaid(t('picker.addedDecider', { name }));
  };
  /** Removes row i; the focus goes to the next row's remove button, else the previous one, else the search. */
  const remove = (i: number) => {
    const name = value[i]!.name;
    onChange(value.filter((_, j) => j !== i));
    setSaid(t('picker.removed', { name }));
    requestAnimationFrame(() => {
      const buttons = box.current?.querySelectorAll<HTMLElement>('[data-contact-remove]') ?? [];
      (buttons[Math.min(i, buttons.length - 1)] ?? box.current?.querySelector<HTMLElement>(`[data-testid="${testId}-search"]`))?.focus();
    });
  };
  const create = useMutation({
    mutationFn: (c: ContactInput) => post<ContactDetail>('/contacts', c),
    onSuccess: (c) => {
      add(c.id, c.name);
      setCreating(false);
      void qc.invalidateQueries({ queryKey: ['contacts'] });
    },
    onError: (e) => notifyError(e),
  });
  const shownRole = (r: string) => (roles?.includes(r) ? roleLabel(r) : r);
  return (
    <Stack gap={6} data-testid={testId} role="group" aria-label={label ?? t('snapshot.label')} ref={box}>
      <div>
        <Text size="sm" fw={500} component="div">
          {label ?? t('snapshot.label')}
        </Text>
        <Text size="xs" c="dimmed">
          {description ?? t('snapshot.frozen')}
        </Text>
      </div>
      {value.length > 0 && (
        <Stack gap={4} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {value.map((v, i) => (
            <Paper key={v.contactId} withBorder p={6} component="li">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Text size="sm" fw={500} style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
                  {v.name}
                </Text>
                <Group gap="xs" wrap="nowrap">
                  {roles?.includes(v.role) ? (
                    <Badge variant="light" tt="none">
                      {shownRole(v.role)}
                    </Badge>
                  ) : (
                    <TextInput
                      size="xs"
                      aria-label={t('snapshot.role', { name: v.name })}
                      placeholder={t('picker.role')}
                      value={v.role}
                      maxLength={CONTACT_LIMITS.role}
                      onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, role: e.currentTarget.value } : x)))}
                    />
                  )}
                  <Tooltip label={t('picker.remove', { name: v.name })} withArrow>
                    <ActionIcon
                      variant="subtle"
                      color="red"
                      size="lg"
                      aria-label={t('picker.remove', { name: v.name })}
                      onClick={() => remove(i)}
                      data-contact-remove
                    >
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
      <Group gap="xs" align="flex-end" wrap="wrap">
        <div style={{ flex: 1, minWidth: 220 }}>
          <ContactSearchSelect
            label={t('picker.search')}
            exclude={value.map((v) => v.contactId)}
            disabled={full}
            error={!!error}
            onPick={(c) => add(c.id, c.name)}
            testId={`${testId}-search`}
          />
        </div>
        {canCreate && (
          <Button variant="default" leftSection={<IconUserPlus size={16} />} disabled={full} onClick={() => setCreating(true)} data-testid={`${testId}-new`}>
            {t('picker.createNew')}
          </Button>
        )}
      </Group>
      {full && (
        <Text size="xs" c="dimmed">
          {t('snapshot.limit', { max: CONTACT_LIMITS.decidedBy })}
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
          offerMatches
          busy={create.isPending}
          onClose={() => setCreating(false)}
          onSubmit={(c) => create.mutate(c)}
          onUseExisting={(c) => {
            add(c.id, c.name);
            setCreating(false);
          }}
        />
      )}
    </Stack>
  );
}

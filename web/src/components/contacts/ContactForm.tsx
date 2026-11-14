import { useState } from 'react';
import { Alert, Button, Group, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { CONTACT_KINDS, CONTACT_LIMITS, CONTACT_STATUSES, type ContactInput, type ContactKind, type ContactListItem, type ContactStatus } from '@sm/shared';
import { FormModal, FormModalCancel } from '../FormModal';
import { useEmailMatches } from './hooks';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RE = /^https?:\/\/\S+$/i;

/**
 * A contact's fields in a dialog: kind, name, e-mail address, phone, organisational unit, web address – and, when
 * editing, the status. `offerMatches` (the picker): contacts the person may see with the same e-mail address are
 * offered instead of a second entry for the same person.
 */
export function ContactForm({
  title,
  submitLabel,
  initial,
  withStatus = false,
  offerMatches = false,
  busy,
  onSubmit,
  onUseExisting,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: Partial<ContactInput>;
  withStatus?: boolean;
  offerMatches?: boolean;
  busy?: boolean;
  onSubmit: (c: ContactInput) => void;
  onUseExisting?: (c: ContactListItem) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['contacts', 'common']);
  const [kind, setKind] = useState<ContactKind>(initial?.kind ?? 'person');
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [orgUnit, setOrgUnit] = useState(initial?.orgUnit ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [status, setStatus] = useState<ContactStatus>(initial?.status ?? 'active');
  const [tried, setTried] = useState(false);
  const matches = useEmailMatches(offerMatches ? email : '');
  const active = matches.filter((m) => m.status === 'active');
  const left = matches.filter((m) => m.status === 'left');
  const errors = {
    name: !name.trim() ? t('common:validation.required') : null,
    email: email.trim() && !EMAIL.test(email.trim()) ? t('fields.emailInvalid') : null,
    url: url.trim() && !URL_RE.test(url.trim()) ? t('common:validation.url') : null,
  };
  const valid = !errors.name && !errors.email && !errors.url;
  const submit = () => {
    setTried(true);
    if (!valid) return;
    onSubmit({
      kind,
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      orgUnit: orgUnit.trim(),
      url: url.trim(),
      ...(withStatus ? { status } : {}),
      ...(initial?.userId !== undefined ? { userId: initial.userId } : {}),
    });
  };
  return (
    <FormModal onClose={onClose} title={title} size="lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          submit();
        }}
      >
        <Stack gap="sm">
          <div>
            <Text size="sm" fw={500} id="contact-kind-label">
              {t('fields.kind')}
            </Text>
            <SegmentedControl
              aria-labelledby="contact-kind-label"
              value={kind}
              onChange={(v) => setKind(v as ContactKind)}
              data={CONTACT_KINDS.map((k) => ({ value: k, label: t(`kinds.${k}`) }))}
            />
          </div>
          <TextInput
            label={t('fields.name')}
            required
            value={name}
            maxLength={CONTACT_LIMITS.name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={tried && errors.name}
            data-autofocus
            data-testid="contact-name"
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
            <TextInput
              label={t('fields.email')}
              type="email"
              value={email}
              maxLength={CONTACT_LIMITS.email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              error={tried && errors.email}
              data-testid="contact-email"
            />
            <TextInput label={t('fields.phone')} type="tel" value={phone} maxLength={CONTACT_LIMITS.phone} onChange={(e) => setPhone(e.currentTarget.value)} />
            <TextInput label={t('fields.orgUnit')} value={orgUnit} maxLength={CONTACT_LIMITS.orgUnit} onChange={(e) => setOrgUnit(e.currentTarget.value)} />
            <TextInput
              label={t('fields.url')}
              type="url"
              value={url}
              maxLength={CONTACT_LIMITS.url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              error={tried && errors.url}
            />
          </SimpleGrid>
          {withStatus && (
            <Select
              label={t('fields.status')}
              description={t('fields.statusHint')}
              data={CONTACT_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
              value={status}
              onChange={(v) => setStatus((v as ContactStatus) ?? 'active')}
              allowDeselect={false}
            />
          )}
          {offerMatches && onUseExisting && matches.length > 0 && (
            <Alert color="blue" variant="light" data-testid="contact-matches">
              {active.length > 0 && (
                <>
                  <Text size="sm">{t('picker.matches', { names: active.map((m) => m.name).join(', ') })}</Text>
                  <Group gap="xs" mt="xs">
                    {active.slice(0, 3).map((m) => (
                      <Button key={m.id} size="xs" variant="light" onClick={() => onUseExisting(m)}>
                        {t('picker.useMatch', { name: m.name })}
                      </Button>
                    ))}
                  </Group>
                </>
              )}
              {/* a contact who has left is offered nowhere new (ADR 0038): named, not offered */}
              {left.length > 0 && (
                <Text size="sm" mt={active.length ? 'xs' : 0} data-testid="contact-matches-left">
                  {t('picker.matchesLeft', { names: left.map((m) => m.name).join(', ') })}
                </Text>
              )}
            </Alert>
          )}
          <Group justify="flex-end">
            <FormModalCancel />
            <Button type="submit" loading={busy} data-testid="contact-submit">
              {submitLabel}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

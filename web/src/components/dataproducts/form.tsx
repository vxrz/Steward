import { useState, type ReactNode } from 'react';
import { ActionIcon, Button, Group, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DATA_PRODUCT_KEY_RE, DATA_PRODUCT_LIMITS, type DataExternalRef } from '@sm/shared';
import { notifyError } from '../../api';
import { FormModalCancel } from '../FormModal';

/** Helpers of the data products forms: busy state, the key from a name, the buttons, external references. */

/** Runs `fn` once at a time; errors are shown (translated by their code) and the dialog stays open. */
export function useBusy(): [boolean, (fn: () => Promise<void>, failed?: string) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, failed?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notifyError(e, failed);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run];
}

/** A key from a name: lower case, digits, `.`, `_`, `-` (DATA_PRODUCT_KEY_RE), at most 100 characters. */
export function keyFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, DATA_PRODUCT_LIMITS.key);
}

export const validKey = (k: string) => DATA_PRODUCT_KEY_RE.test(k.trim());
export const isHttpUrl = (u: string) => /^https?:\/\/\S+$/i.test(u.trim());

/** Cancel and the submit button of a dialog's form. */
export function FormButtons({ busy, submit, testId }: { busy: boolean; submit?: ReactNode; testId?: string }) {
  const { t } = useTranslation('common');
  return (
    <Group justify="flex-end" mt="sm">
      <FormModalCancel />
      <Button type="submit" loading={busy} data-testid={testId}>
        {submit ?? t('save')}
      </Button>
    </Group>
  );
}

/** External references (a catalogue entry, a wiki page): label and web address, at most 50. */
export function ExternalRefsInput({ value, onChange, error }: { value: DataExternalRef[]; onChange: (v: DataExternalRef[]) => void; error?: boolean }) {
  const { t } = useTranslation('dataProducts');
  const set = (i: number, patch: Partial<DataExternalRef>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Stack gap={6}>
      <Text size="sm" fw={500}>
        {t('form.externalRefs')}
      </Text>
      <Text size="xs" c="dimmed" mt={-4}>
        {t('form.externalRefsHint')}
      </Text>
      {value.map((r, i) => (
        <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
          <TextInput
            size="xs"
            aria-label={t('form.refLabel')}
            placeholder={t('form.refLabel')}
            value={r.label}
            maxLength={DATA_PRODUCT_LIMITS.short}
            onChange={(e) => set(i, { label: e.currentTarget.value })}
            style={{ flex: 1, minWidth: 0 }}
          />
          <TextInput
            size="xs"
            aria-label={t('form.refUrl')}
            placeholder="https://…"
            value={r.url}
            maxLength={DATA_PRODUCT_LIMITS.url}
            onChange={(e) => set(i, { url: e.currentTarget.value })}
            error={error && !isHttpUrl(r.url) ? t('form.refUrlInvalid') : undefined}
            style={{ flex: 2, minWidth: 0 }}
          />
          <Tooltip label={t('form.refRemove')}>
            <ActionIcon variant="subtle" color="red" aria-label={t('form.refRemove')} onClick={() => onChange(value.filter((_, j) => j !== i))} mt={2}>
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      ))}
      {value.length < DATA_PRODUCT_LIMITS.externalRefs && (
        <Group>
          <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => onChange([...value, { label: '', url: '' }])}>
            {t('form.refAdd')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

/** Rows of external references worth sending (both parts empty: left out). */
export const refsToSend = (refs: DataExternalRef[]) => refs.map((r) => ({ label: r.label.trim(), url: r.url.trim() })).filter((r) => r.label || r.url);

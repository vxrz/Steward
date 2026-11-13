import { useEffect, useState } from 'react';
import { Button, Group, Paper, Select, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { notifyError, notifyOk, put } from '../../api';
import { useSubjects } from '../SubjectsInput';
import { accessKey } from './SharesPanel';

/**
 * The owner of a process or a monitor (0.23.0): one user with every right on it – shown on the Access tab as an implied
 * Manage. Who manages the item changes it (`PUT /processes/:id/access` or `/monitors/:id/access` with `{ owner }`); a
 * new owner gains every right, so the server asks for the step-up. A monitor always has an owner.
 */
export function OwnerField({
  kind,
  id,
  owner,
  canChange,
  onSaved,
}: {
  kind: 'process' | 'monitor';
  id: string;
  owner: string | null;
  canChange: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['access', 'common']);
  const qc = useQueryClient();
  const subjects = useSubjects();
  const [value, setValue] = useState<string | null>(owner);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(owner), [owner]);
  const users = (subjects.data ?? []).filter((s) => s.kind === 'user').map((s) => ({ value: s.value.slice(5), label: s.label }));
  // the current owner stays choosable even when the list does not name them
  if (owner && !users.some((u) => u.value === owner)) users.unshift({ value: owner, label: owner });
  const dirty = (value ?? null) !== (owner ?? null) && (kind === 'process' || !!value);
  const save = async () => {
    setBusy(true);
    try {
      await put(`/${kind === 'process' ? 'processes' : 'monitors'}/${id}/access`, { owner: value });
      void qc.invalidateQueries({ queryKey: accessKey(kind, id) });
      notifyOk(t('ownerSaved'));
      onSaved();
    } catch (e) {
      notifyError(e, t('ownerNotSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper withBorder p="md" mb="md" data-testid="owner-field">
      <Group gap="sm" align="flex-end" wrap="wrap">
        <Select
          label={t('owner')}
          description={kind === 'monitor' ? t('ownerHintMonitor') : t('ownerHint')}
          data={users}
          value={value}
          onChange={setValue}
          clearable={kind === 'process'}
          searchable
          disabled={!canChange}
          style={{ flex: '1 1 260px' }}
          maw={420}
        />
        {canChange && (
          <Button onClick={() => void save()} disabled={!dirty} loading={busy}>
            {t('ownerSave')}
          </Button>
        )}
      </Group>
      {!canChange && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('ownerNotYours')}
        </Text>
      )}
    </Paper>
  );
}

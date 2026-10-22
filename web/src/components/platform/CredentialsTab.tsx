import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Alert, Autocomplete, Badge, Button, Group, Modal, Paper, PasswordInput, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconLock, IconPencil, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import type { Platform } from '@sm/shared';
import { notifyError, notifyOk, put } from '../../api';
import { Hint } from '../common';
import { requiredSecrets } from './SettingsTab';

const COMMON_KEYS = ['clientId', 'clientSecret', 'username', 'password', 'token', 'apiKey'];

export function CredentialsTab({ platform, readOnly = false }: { platform: Platform; readOnly?: boolean }) {
  const { t } = useTranslation(['platforms', 'common']);
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const needed = requiredSecrets(platform.config.auth);
  const missing = needed.filter((k) => !platform.secretKeys.includes(k));

  const refresh = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ['platform', platform.id] }), qc.invalidateQueries({ queryKey: ['platforms'] })]);

  const save = async () => {
    setBusy(true);
    try {
      await put(`/platforms/${platform.id}/secrets`, { [key.trim()]: value });
      await refresh();
      notifyOk(t('credentials.stored', { key: key.trim() }));
      setKey('');
      setValue('');
    } catch (e) {
      notifyError(e, t('credentials.notStored'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (k: string) => {
    try {
      await put(`/platforms/${platform.id}/secrets`, { [k]: null });
      await refresh();
      notifyOk(t('credentials.removed', { key: k }));
    } catch (e) {
      notifyError(e, t('credentials.notRemoved'));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Stack>
      <Alert color="blue" variant="light" icon={<IconLock size={18} />}>
        <Trans t={t} i18nKey="credentials.info" components={{ code: <code>{"$secret('<slot>', 'key')"}</code> }} />
      </Alert>
      {missing.length > 0 && (
        <Alert color="orange" variant="light">
          {t('credentials.missing', { keys: missing.join(', ') })}
        </Alert>
      )}
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          {t('credentials.storedTitle')}
        </Title>
        {platform.secretKeys.length === 0 ? (
          <Text size="sm" c="dimmed">
            {t('credentials.none')}
          </Text>
        ) : (
          <div className="table-scroll">
            <Table>
              <Table.Tbody>
                {platform.secretKeys.map((k) => (
                  <Table.Tr key={k}>
                    <Table.Td>
                      <Group gap={6}>
                        <Text className="mono">{k}</Text>
                        {needed.includes(k) && (
                          <Badge size="xs" variant="light">
                            {t('credentials.usedByAuth')}
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td c="dimmed">••••••••</Table.Td>
                    <Table.Td w={90}>
                      {!readOnly && <Group gap={4} wrap="nowrap" justify="flex-end">
                        <Tooltip label={t('credentials.replace')}>
                          <ActionIcon
                            variant="subtle"
                            onClick={() => {
                              setKey(k);
                              setValue('');
                            }}
                            aria-label={t('credentials.replace')}
                          >
                            <IconPencil size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label={t('common:remove')}>
                          <ActionIcon variant="subtle" color="red" onClick={() => setRemoving(k)} aria-label={t('common:remove')}>
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Paper>
      {readOnly ? (
        <Text size="sm" c="dimmed">{t('credentials.readOnly')}</Text>
      ) : (
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          {t('credentials.addTitle')}
        </Title>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim() && value) save();
          }}
        >
          <Stack>
            <Autocomplete
              label={t('common:name')}
              placeholder={t('credentials.namePlaceholder')}
              data={[...new Set([...needed, ...COMMON_KEYS])]}
              value={key}
              onChange={setKey}
            />
            <PasswordInput label={t('common:value')} value={value} onChange={(e) => setValue(e.currentTarget.value)} autoComplete="new-password" />
            {platform.secretKeys.includes(key.trim()) && <Hint>{t('credentials.replaces', { key: key.trim() })}</Hint>}
            <Group justify="flex-end">
              <Button type="submit" loading={busy} disabled={!key.trim() || !value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim())}>
                {t('credentials.store')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Paper>
      )}
      <Modal opened={!!removing} onClose={() => setRemoving(null)} title={t('credentials.removeTitle')}>
        <Text size="sm">
          <Trans t={t} i18nKey="credentials.removeText" values={{ key: removing ?? '' }} components={{ b: <strong /> }} />
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setRemoving(null)}>
            {t('common:cancel')}
          </Button>
          <Button color="red" onClick={() => removing && remove(removing)}>
            {t('common:remove')}
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Alert, Autocomplete, Badge, Button, Group, Modal, Paper, PasswordInput, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { IconLock, IconPencil, IconTrash } from '@tabler/icons-react';
import type { Platform } from '@sm/shared';
import { notifyError, notifyOk, put } from '../../api';
import { Hint } from '../common';
import { requiredSecrets } from './SettingsTab';

const COMMON_KEYS = ['clientId', 'clientSecret', 'username', 'password', 'token', 'apiKey'];

export function CredentialsTab({ platform }: { platform: Platform }) {
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
      notifyOk(`Secret "${key.trim()}" stored`);
      setKey('');
      setValue('');
    } catch (e) {
      notifyError(e, 'Secret not stored');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (k: string) => {
    try {
      await put(`/platforms/${platform.id}/secrets`, { [k]: null });
      await refresh();
      notifyOk(`Secret "${k}" removed`);
    } catch (e) {
      notifyError(e, 'Not removed');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Stack>
      <Alert color="blue" variant="light" icon={<IconLock size={18} />}>
        Secrets are encrypted (AES-256-GCM) with a key derived from your master passphrase and never shown again or sent to the
        browser. Every change is recorded in the audit log (names only, never values). In processes they are available via{' '}
        <code>$secret('&lt;slot&gt;', 'key')</code> and are masked in all logs.
      </Alert>
      {missing.length > 0 && (
        <Alert color="orange" variant="light">
          The configured authentication needs: {missing.join(', ')}
        </Alert>
      )}
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          Stored secrets
        </Title>
        {platform.secretKeys.length === 0 ? (
          <Text size="sm" c="dimmed">
            No secrets stored yet.
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
                            used by auth
                          </Badge>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td c="dimmed">••••••••</Table.Td>
                    <Table.Td w={90}>
                      <Group gap={4} wrap="nowrap" justify="flex-end">
                        <Tooltip label="Replace">
                          <ActionIcon
                            variant="subtle"
                            onClick={() => {
                              setKey(k);
                              setValue('');
                            }}
                            aria-label="Replace"
                          >
                            <IconPencil size={16} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Remove">
                          <ActionIcon variant="subtle" color="red" onClick={() => setRemoving(k)} aria-label="Remove">
                            <IconTrash size={16} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        )}
      </Paper>
      <Paper withBorder p="md">
        <Title order={5} mb="sm">
          Add or replace a secret
        </Title>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim() && value) save();
          }}
        >
          <Stack>
            <Autocomplete
              label="Name"
              placeholder="e.g. clientSecret"
              data={[...new Set([...needed, ...COMMON_KEYS])]}
              value={key}
              onChange={setKey}
            />
            <PasswordInput label="Value" value={value} onChange={(e) => setValue(e.currentTarget.value)} autoComplete="new-password" />
            {platform.secretKeys.includes(key.trim()) && <Hint>This replaces the stored value of “{key.trim()}”.</Hint>}
            <Group justify="flex-end">
              <Button type="submit" loading={busy} disabled={!key.trim() || !value || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key.trim())}>
                Store secret
              </Button>
            </Group>
          </Stack>
        </form>
      </Paper>
      <Modal opened={!!removing} onClose={() => setRemoving(null)} title="Remove secret">
        <Text size="sm">
          Remove the secret <strong>{removing}</strong>? Processes using it will fail until it is set again.
        </Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setRemoving(null)}>
            Cancel
          </Button>
          <Button color="red" onClick={() => removing && remove(removing)}>
            Remove
          </Button>
        </Group>
      </Modal>
    </Stack>
  );
}

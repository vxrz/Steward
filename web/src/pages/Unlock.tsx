import { useState } from 'react';
import { Alert, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { VaultStatus } from '@sm/shared';
import { post } from '../api';

export function UnlockPage({ status }: { status: VaultStatus }) {
  const qc = useQueryClient();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [operator, setOperator] = useState(localStorage.getItem('sm.operator') ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = !status.initialized;

  const submit = async () => {
    setError(null);
    if (setup && passphrase !== confirm) return setError('Passphrases do not match');
    setBusy(true);
    try {
      await post(setup ? '/vault/setup' : '/vault/unlock', { passphrase, operator: operator || undefined });
      if (operator) localStorage.setItem('sm.operator', operator);
      await qc.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={420}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Stack>
            <Center>
              <IconShieldLock size={40} stroke={1.4} />
            </Center>
            <Title order={3} ta="center">
              {setup ? 'Set up Service Manager' : 'Unlock Service Manager'}
            </Title>
            <Text size="sm" c="dimmed" ta="center">
              {setup
                ? 'Choose a master passphrase. It encrypts all platform credentials and signs the audit log. It cannot be recovered – keep it safe.'
                : 'Enter your master passphrase to decrypt credentials and start scheduled processes.'}
            </Text>
            <TextInput
              label="Your name (recorded in the audit log)"
              required={setup}
              value={operator}
              onChange={(e) => setOperator(e.currentTarget.value)}
              placeholder="e.g. Jane Doe"
            />
            <PasswordInput label="Master passphrase" required value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} autoFocus />
            {setup && <PasswordInput label="Repeat passphrase" required value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />}
            {error && <Alert color="red">{error}</Alert>}
            <Button type="submit" loading={busy} disabled={passphrase.length < (setup ? 8 : 1)}>
              {setup ? 'Create vault' : 'Unlock'}
            </Button>
            {status.demo && (
              <Text size="xs" c="dimmed" ta="center">
                Demo mode – pick any passphrase (min. 8 characters).
              </Text>
            )}
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}

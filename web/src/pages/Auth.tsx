import { useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Button, Center, Collapse, Divider, Group, Paper, PasswordInput, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconClockHour4, IconLock, IconShieldLock, IconUserCircle } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthStatus } from '@sm/shared';
import { post } from '../api';
import { SsoButtons, SsoErrorAlert, useSsoError } from '../components/sso/SsoButtons';

const POLICY = 'At least 10 characters, letters plus a digit or symbol.';

function policyError(pw: string): string | null {
  if (pw.length < 10) return 'Password must have at least 10 characters';
  if (!/[A-Za-z]/.test(pw) || !/[^A-Za-z]/.test(pw)) return 'Use letters and at least one digit or symbol';
  return null;
}

function Card({ icon, title, intro, children }: { icon: ReactNode; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w="100%" maw={440}>
        <Stack>
          <Center>{icon}</Center>
          <Title order={3} ta="center">
            {title}
          </Title>
          {intro && (
            <Text size="sm" c="dimmed" ta="center">
              {intro}
            </Text>
          )}
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}

function useRefreshAuth() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function SetupPage({ status }: { status: AuthStatus }) {
  const refresh = useRefreshAuth();
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const existingVault = status.initialized;

  const submit = async () => {
    setError(null);
    if (!existingVault && passphrase !== passphrase2) return setError('Passphrases do not match');
    if (password !== password2) return setError('Passwords do not match');
    const pe = policyError(password);
    if (pe) return setError(pe);
    setBusy(true);
    try {
      await post('/auth/setup', { passphrase, username: username.trim(), displayName: displayName.trim() || undefined, password });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={<IconShieldLock size={40} stroke={1.4} />}
      title="Set up Service Manager"
      intro={
        existingVault
          ? 'This installation has no user accounts yet. Enter the existing master passphrase and create the first administrator.'
          : 'Choose a master passphrase and create the first administrator account.'
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack>
          <Alert variant="light" color="blue" p="xs">
            <Text size="xs">
              The <b>master passphrase</b> encrypts all platform credentials and signs the audit log. It is needed after every restart
              to unlock the tool (or set <code>SM_MASTER_PASSPHRASE</code>). It cannot be recovered – keep it safe, e.g. in your company
              password manager.
            </Text>
          </Alert>
          <PasswordInput label="Master passphrase" required value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} autoFocus />
          {!existingVault && (
            <PasswordInput label="Repeat passphrase" required value={passphrase2} onChange={(e) => setPassphrase2(e.currentTarget.value)} />
          )}
          <Text fw={600} size="sm" mt="xs">
            First administrator
          </Text>
          <TextInput label="User name" required value={username} onChange={(e) => setUsername(e.currentTarget.value)} placeholder="e.g. jdoe" autoComplete="username" />
          <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} placeholder="e.g. Jane Doe" />
          <PasswordInput label="Password" description={POLICY} required value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" />
          <PasswordInput label="Repeat password" required value={password2} onChange={(e) => setPassword2(e.currentTarget.value)} autoComplete="new-password" />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={passphrase.length < 8 || !username.trim() || !password}>
            {existingVault ? 'Create administrator' : 'Set up'}
          </Button>
          {status.demo && (
            <Text size="xs" c="dimmed" ta="center">
              Demo mode – pick any passphrase (min. 8 characters).
            </Text>
          )}
        </Stack>
      </form>
    </Card>
  );
}

export function LoginPage({ status }: { status: AuthStatus }) {
  const refresh = useRefreshAuth();
  const [username, setUsername] = useState(localStorage.getItem('sm.lastUser') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoError, clearSsoError] = useSsoError();

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await post('/auth/login', { username: username.trim(), password });
      try {
        localStorage.setItem('sm.lastUser', username.trim());
      } catch {
        /* ignore */
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const providers = status.ssoProviders ?? [];
  const ssoFirst = status.passwordLogin === 'adminsOnly' && providers.length > 0;
  const [showPassword, setShowPassword] = useState(!ssoFirst);

  const passwordForm = (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Stack>
        <TextInput label="User name" required value={username} onChange={(e) => setUsername(e.currentTarget.value)} autoFocus={!ssoFirst && !username} autoComplete="username" />
        <PasswordInput
          label="Password"
          required
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          autoFocus={!ssoFirst && !!username}
          autoComplete="current-password"
        />
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy} disabled={!username.trim() || !password} variant={ssoFirst ? 'light' : 'filled'}>
          Sign in
        </Button>
      </Stack>
    </form>
  );

  return (
    <Card icon={<IconUserCircle size={40} stroke={1.4} />} title="Sign in to Service Manager">
      <SsoErrorAlert error={ssoError} onClose={clearSsoError} />
      {ssoFirst ? (
        <>
          <SsoButtons providers={providers} />
          <Divider />
          <UnstyledButton onClick={() => setShowPassword((v) => !v)}>
            <Group gap={4}>
              {showPassword ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              <Text size="sm" c="dimmed">
                Administrator sign-in (break-glass)
              </Text>
            </Group>
          </UnstyledButton>
          <Collapse in={showPassword}>{passwordForm}</Collapse>
        </>
      ) : (
        <>
          {passwordForm}
          {providers.length > 0 && (
            <>
              <Divider label="or" labelPosition="center" />
              <SsoButtons providers={providers} />
            </>
          )}
        </>
      )}
      {!status.unlocked && (
        <Text size="xs" c="dimmed" ta="center">
          The vault is locked. After signing in, an administrator can unlock it.
        </Text>
      )}
      {status.demo && (
        <Text size="xs" c="dimmed" ta="center">
          Demo mode · v{status.version}
        </Text>
      )}
    </Card>
  );
}

export function ChangePasswordForm({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const refresh = useRefreshAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    if (next !== next2) return setError('New passwords do not match');
    const pe = policyError(next);
    if (pe) return setError(pe);
    setBusy(true);
    try {
      await post('/auth/password', { current, next });
      await refresh();
      onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Stack>
        <PasswordInput
          label={forced ? 'Temporary password' : 'Current password'}
          required
          value={current}
          onChange={(e) => setCurrent(e.currentTarget.value)}
          autoComplete="current-password"
          autoFocus
        />
        <PasswordInput label="New password" description={POLICY} required value={next} onChange={(e) => setNext(e.currentTarget.value)} autoComplete="new-password" />
        <PasswordInput label="Repeat new password" required value={next2} onChange={(e) => setNext2(e.currentTarget.value)} autoComplete="new-password" />
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy} disabled={!current || !next}>
          Change password
        </Button>
      </Stack>
    </form>
  );
}

export function ForcedPasswordChangePage({ status, onSignOut }: { status: AuthStatus; onSignOut: () => void }) {
  return (
    <Card
      icon={<IconLock size={40} stroke={1.4} />}
      title="Choose a new password"
      intro={`Welcome ${status.me?.user.displayName ?? ''}. Your account uses a temporary password – please choose your own before continuing.`}
    >
      <ChangePasswordForm forced />
      <Anchor size="xs" ta="center" onClick={onSignOut}>
        Sign out
      </Anchor>
    </Card>
  );
}

export function VaultLockedPage({ status, onSignOut }: { status: AuthStatus; onSignOut: () => void }) {
  const refresh = useRefreshAuth();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = !!status.me?.user.roles.includes('admin');

  if (!isAdmin) {
    return (
      <Card
        icon={<IconClockHour4 size={40} stroke={1.4} />}
        title="Waiting for an administrator"
        intro="Service Manager was restarted and its vault is locked. An administrator has to unlock it with the master passphrase before you can continue."
      >
        <Group justify="center">
          <Button variant="light" onClick={() => refresh()}>
            Check again
          </Button>
          <Button variant="subtle" onClick={onSignOut}>
            Sign out
          </Button>
        </Group>
      </Card>
    );
  }

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await post('/vault/unlock', { passphrase });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={<IconShieldLock size={40} stroke={1.4} />}
      title="Unlock the vault"
      intro="Enter the master passphrase to decrypt credentials, verify the audit log and start schedules."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack>
          <Group justify="center" gap={6}>
            <Text size="sm">Signed in as {status.me?.user.displayName}</Text>
            <Badge size="xs" variant="light">
              admin
            </Badge>
          </Group>
          <PasswordInput label="Master passphrase" required value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} autoFocus />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={!passphrase}>
            Unlock
          </Button>
          <Anchor size="xs" ta="center" onClick={onSignOut}>
            Sign out
          </Anchor>
        </Stack>
      </form>
    </Card>
  );
}

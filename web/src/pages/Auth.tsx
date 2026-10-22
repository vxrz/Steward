import { useState, type ReactNode } from 'react';
import { Alert, Anchor, Badge, Box, Button, Center, Collapse, Divider, Group, Paper, PasswordInput, Stack, Text, TextInput, Title, UnstyledButton } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconClockHour4, IconLock, IconShieldLock } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import type { AuthStatus } from '@sm/shared';
import { post } from '../api';
import { SsoButtons, SsoErrorAlert, useSsoError } from '../components/sso/SsoButtons';
import { AppFooter } from '../components/brand/AppFooter';
import { Logo } from '../components/brand/Logo';
import { LanguageMenu } from '../components/LanguageSwitcher';
import { errorText } from '../i18n/errors';
import { BRAND } from '../../../shared/src/brand';

type PolicyError = 'policyTooShort' | 'policyCharacters';

function policyError(pw: string): PolicyError | null {
  if (pw.length < 10) return 'policyTooShort';
  if (!/[A-Za-z]/.test(pw) || !/[^A-Za-z]/.test(pw)) return 'policyCharacters';
  return null;
}

function Card({ icon, title, intro, children }: { icon: ReactNode; title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <Stack mih="100vh" p="md" gap={0} justify="space-between" align="center">
      <Group w="100%" justify="flex-end">
        <LanguageMenu />
      </Group>
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
      <AppFooter />
    </Stack>
  );
}

function useRefreshAuth() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function SetupPage({ status }: { status: AuthStatus }) {
  const { t } = useTranslation('auth');
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
    if (!existingVault && passphrase !== passphrase2) return setError(t('passphrasesDiffer'));
    if (password !== password2) return setError(t('passwordsDiffer'));
    const pe = policyError(password);
    if (pe) return setError(t(pe));
    setBusy(true);
    try {
      await post('/auth/setup', { passphrase, username: username.trim(), displayName: displayName.trim() || undefined, password });
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      icon={<IconShieldLock size={40} stroke={1.4} />}
      title={t('setup.title', { brand: BRAND.name })}
      intro={existingVault ? t('setup.introExistingVault') : t('setup.intro')}
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
              <Trans t={t} i18nKey="setup.passphraseInfo" components={{ b: <b />, code: <code /> }} />
            </Text>
          </Alert>
          <PasswordInput label={t('masterPassphrase')} required value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} autoFocus />
          {!existingVault && (
            <PasswordInput label={t('setup.repeatPassphrase')} required value={passphrase2} onChange={(e) => setPassphrase2(e.currentTarget.value)} />
          )}
          <Text fw={600} size="sm" mt="xs">
            {t('setup.firstAdmin')}
          </Text>
          <TextInput
            label={t('username')}
            required
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            placeholder={t('setup.usernamePlaceholder')}
            autoComplete="username"
          />
          <TextInput label={t('displayName')} value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} placeholder={t('setup.displayNamePlaceholder')} />
          <PasswordInput
            label={t('password')}
            description={t('policy')}
            required
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="new-password"
          />
          <PasswordInput label={t('repeatPassword')} required value={password2} onChange={(e) => setPassword2(e.currentTarget.value)} autoComplete="new-password" />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={passphrase.length < 8 || !username.trim() || !password}>
            {existingVault ? t('setup.createAdmin') : t('setup.submit')}
          </Button>
          {status.demo && (
            <Text size="xs" c="dimmed" ta="center">
              {t('setup.demoHint')}
            </Text>
          )}
        </Stack>
      </form>
    </Card>
  );
}

function lastUser(): string {
  try {
    return localStorage.getItem('sm.lastUser') ?? '';
  } catch {
    return '';
  }
}

export function LoginPage({ status }: { status: AuthStatus }) {
  const { t } = useTranslation('auth');
  const refresh = useRefreshAuth();
  const [username, setUsername] = useState(lastUser);
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
      setError(errorText(e));
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
        <TextInput
          label={t('username')}
          required
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
          autoFocus={!ssoFirst && !username}
          autoComplete="username"
        />
        <PasswordInput
          label={t('password')}
          required
          value={password}
          onChange={(e) => setPassword(e.currentTarget.value)}
          autoFocus={!ssoFirst && !!username}
          autoComplete="current-password"
        />
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy} disabled={!username.trim() || !password} variant={ssoFirst ? 'light' : 'filled'}>
          {t('login.submit')}
        </Button>
      </Stack>
    </form>
  );

  return (
    <Card icon={<Logo size={48} title={BRAND.name} />} title={t('login.title', { brand: BRAND.name })}>
      <SsoErrorAlert error={ssoError} onClose={clearSsoError} />
      {ssoFirst ? (
        <>
          <SsoButtons providers={providers} />
          <Divider />
          <UnstyledButton onClick={() => setShowPassword((v) => !v)}>
            <Group gap={4} wrap="nowrap">
              {showPassword ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              <Text size="sm" c="dimmed">
                {t('login.breakGlass')}
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
              <Divider label={t('login.or')} labelPosition="center" />
              <SsoButtons providers={providers} />
            </>
          )}
        </>
      )}
      {!status.unlocked && (
        <Text size="xs" c="dimmed" ta="center">
          {t('login.vaultLocked')}
        </Text>
      )}
      {status.demo && (
        <Text size="xs" c="dimmed" ta="center">
          {t('login.demo', { version: status.version })}
        </Text>
      )}
    </Card>
  );
}

export function ChangePasswordForm({ forced, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { t } = useTranslation('auth');
  const refresh = useRefreshAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setError(null);
    if (next !== next2) return setError(t('changePassword.newPasswordsDiffer'));
    const pe = policyError(next);
    if (pe) return setError(t(pe));
    setBusy(true);
    try {
      await post('/auth/password', { current, next });
      await refresh();
      onDone?.();
    } catch (e) {
      setError(errorText(e));
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
          label={forced ? t('changePassword.temporary') : t('changePassword.current')}
          required
          value={current}
          onChange={(e) => setCurrent(e.currentTarget.value)}
          autoComplete="current-password"
          autoFocus
        />
        <PasswordInput
          label={t('changePassword.new')}
          description={t('policy')}
          required
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
          autoComplete="new-password"
        />
        <PasswordInput label={t('changePassword.repeatNew')} required value={next2} onChange={(e) => setNext2(e.currentTarget.value)} autoComplete="new-password" />
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy} disabled={!current || !next}>
          {t('changePassword.submit')}
        </Button>
      </Stack>
    </form>
  );
}

export function ForcedPasswordChangePage({ status, onSignOut }: { status: AuthStatus; onSignOut: () => void }) {
  const { t } = useTranslation('auth');
  return (
    <Card icon={<IconLock size={40} stroke={1.4} />} title={t('forced.title')} intro={t('forced.intro', { name: status.me?.user.displayName ?? '' })}>
      <ChangePasswordForm forced />
      <Anchor size="xs" ta="center" onClick={onSignOut}>
        {t('signOut')}
      </Anchor>
    </Card>
  );
}

export function VaultLockedPage({ status, onSignOut }: { status: AuthStatus; onSignOut: () => void }) {
  const { t } = useTranslation(['auth', 'common']);
  const refresh = useRefreshAuth();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = !!status.me?.user.roles.includes('admin');

  if (!isAdmin) {
    return (
      <Card icon={<IconClockHour4 size={40} stroke={1.4} />} title={t('vault.waitingTitle')} intro={t('vault.waitingIntro', { brand: BRAND.name })}>
        <Group justify="center">
          <Button variant="light" onClick={() => refresh()}>
            {t('vault.checkAgain')}
          </Button>
          <Button variant="subtle" onClick={onSignOut}>
            {t('signOut')}
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
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card icon={<IconShieldLock size={40} stroke={1.4} />} title={t('vault.unlockTitle')} intro={t('vault.unlockIntro')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Stack>
          <Group justify="center" gap={6}>
            <Text size="sm">{t('vault.signedInAs', { name: status.me?.user.displayName ?? '' })}</Text>
            <Badge size="xs" variant="light">
              {t('common:roles.admin')}
            </Badge>
          </Group>
          <PasswordInput label={t('masterPassphrase')} required value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} autoFocus />
          {error && <Alert color="red">{error}</Alert>}
          <Button type="submit" loading={busy} disabled={!passphrase}>
            {t('vault.unlock')}
          </Button>
          <Box ta="center">
            <Anchor size="xs" onClick={onSignOut}>
              {t('signOut')}
            </Anchor>
          </Box>
        </Stack>
      </form>
    </Card>
  );
}

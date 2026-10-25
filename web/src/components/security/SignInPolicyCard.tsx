import { Alert, Card, Code, Radio, Stack, Text, Title } from '@mantine/core';
import { Trans, useTranslation } from 'react-i18next';
import type { AuthStatus, PasswordLogin, Settings } from '@sm/shared';
import { useMe } from '../../auth';

const MODES: PasswordLogin[] = ['all', 'adminsOnly', 'none'];

/**
 * Settings → Sign-in: who may sign in with a password. "Single sign-on only" is offered once it cannot lock
 * everyone out (an enabled provider, and the administrator changing it signed in through it); the server
 * checks the same. SM_PASSWORD_LOGIN on the server makes it read-only.
 */
export function SignInPolicyCard({
  settings,
  saved,
  auth,
  readOnly,
  onChange,
}: {
  settings: Settings;
  /** The value stored on the server (the card warns before a change takes effect) */
  saved: PasswordLogin | undefined;
  auth: AuthStatus | undefined;
  readOnly: boolean;
  onChange: (v: PasswordLogin) => void;
}) {
  const { t } = useTranslation('settings');
  const { me } = useMe();
  const providers = auth?.ssoProviders ?? [];
  const value = settings.passwordLogin ?? 'all';
  const fromEnv = !!settings.passwordLoginFromEnv;
  const viaSso = !!me && !me.emergency && providers.some((p) => p.id === me.user.authSource);
  // "none" can always be kept once it is on (e.g. in an emergency session); turning it on needs SSO
  const noneBlocked = saved !== 'none' && (!providers.length || !viaSso);
  return (
    <Card withBorder>
      <Title order={5} mb="sm">
        {t('signIn.title')}
      </Title>
      <Stack gap="sm">
        <Radio.Group
          value={value}
          onChange={(v) => onChange(v as PasswordLogin)}
          label={t('signIn.question')}
          description={fromEnv ? <Trans t={t} i18nKey="signIn.fromEnv" values={{ name: 'SM_PASSWORD_LOGIN' }} components={{ c: <Code /> }} /> : undefined}
        >
          <Stack gap="xs" mt="xs">
            {MODES.map((m) => (
              <Radio
                key={m}
                value={m}
                label={t(`signIn.mode.${m}`)}
                description={t(`signIn.mode.${m}Hint`)}
                disabled={readOnly || fromEnv || (m === 'none' && noneBlocked)}
                data-testid={`password-login-${m}`}
              />
            ))}
          </Stack>
        </Radio.Group>
        {settings.passwordLoginPending && (
          <Alert color="blue" variant="light" p="xs" data-testid="password-login-pending">
            <Text size="sm">
              <Trans t={t} i18nKey="signIn.pendingNone" values={{ name: 'SM_PASSWORD_LOGIN' }} components={{ c: <Code /> }} />
            </Text>
          </Alert>
        )}
        {!fromEnv && noneBlocked && (
          <Text size="sm" c="dimmed" data-testid="password-login-none-blocked">
            {!providers.length ? t('signIn.noneNeedsProvider') : t('signIn.noneNeedsSsoAdmin')}
          </Text>
        )}
        {providers.length === 0 && value === 'adminsOnly' && (
          <Alert color="orange" variant="light" p="xs">
            {t('signIn.noProvider')}
          </Alert>
        )}
        {value === 'none' && (
          <Alert color="orange" variant="light" p="xs" title={t('signIn.emergencyTitle')}>
            <Text size="sm">
              <Trans t={t} i18nKey="signIn.emergencyHint" components={{ c: <Code /> }} />
            </Text>
          </Alert>
        )}
        {value !== 'all' && saved !== value && !fromEnv && (
          <Text size="sm" c="dimmed">
            {t('signIn.sessionsEnd')}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

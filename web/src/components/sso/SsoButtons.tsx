import { useEffect, useState } from 'react';
import { Alert, Button, Stack } from '@mantine/core';
import { IconBrandWindows, IconKey } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { isSsoErrorCode, SSO_REFERENCE, type SsoErrorCode, type SsoProviderPublic } from '@sm/shared';
import { appPath, withBase } from '../../basePath';

/** A failed single sign-on as the server reports it: a known code, and the reference of a refused sign-in. */
export interface SsoError {
  code: SsoErrorCode;
  reference?: string;
}

/**
 * Reads ?sso_error=… (and ?sso_ref=…) once and removes them from the address bar. Only known codes count: anything
 * else in the address shows the generic text, so a link cannot put its own words on the sign-in page.
 */
export function useSsoError(): [SsoError | null, () => void] {
  const [error, setError] = useState<SsoError | null>(() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const raw = q.get('sso_error');
      if (raw === null) return null;
      const ref = q.get('sso_ref') ?? '';
      const code = isSsoErrorCode(raw) ? raw : 'SSO_FAILED';
      return { code, ...(code === 'SSO_SIGN_IN_REFUSED' && SSO_REFERENCE.test(ref) ? { reference: ref } : {}) };
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!error) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('sso_error');
    url.searchParams.delete('sso_ref');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }, [error]);
  return [error, () => setError(null)];
}

export function SsoButtons({ providers }: { providers: SsoProviderPublic[] }) {
  const { t } = useTranslation('auth');
  if (!providers.length) return null;
  // app-relative: the server puts its base path in front again after signing in
  const path = appPath();
  const returnTo = encodeURIComponent(path.startsWith('/') ? path : '/');
  return (
    <Stack gap="xs">
      {providers.map((p) => (
        <Button
          key={p.id}
          component="a"
          href={withBase(`/api/auth/oidc/${encodeURIComponent(p.id)}/start?returnTo=${returnTo}`)}
          variant="default"
          size="md"
          fullWidth
          leftSection={p.type === 'entra' ? <IconBrandWindows size={18} /> : <IconKey size={18} />}
          h="auto"
          py={8}
          styles={{ label: { whiteSpace: 'normal', textAlign: 'center' }, inner: { minHeight: 26 } }}
        >
          {t('sso.signInWith', { provider: p.displayName })}
        </Button>
      ))}
    </Stack>
  );
}

export function SsoErrorAlert({ error, onClose }: { error: SsoError | null; onClose: () => void }) {
  const { t } = useTranslation('auth');
  if (!error) return null;
  return (
    <Alert color="red" title={t('sso.failed')} withCloseButton onClose={onClose} data-testid="sso-error">
      {error.code === 'SSO_SIGN_IN_REFUSED' && error.reference
        ? t('sso.errors.SSO_SIGN_IN_REFUSED_reference', { reference: error.reference })
        : t(`sso.errors.${error.code}`)}
    </Alert>
  );
}

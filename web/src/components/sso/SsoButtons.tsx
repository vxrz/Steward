import { useEffect, useState } from 'react';
import { Alert, Button, Stack } from '@mantine/core';
import { IconBrandWindows, IconKey } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { SsoProviderPublic } from '@sm/shared';
import { appPath, withBase } from '../../basePath';

/** Reads ?sso_error=… once and removes it from the address bar. */
export function useSsoError(): [string | null, () => void] {
  const [error, setError] = useState<string | null>(() => {
    try {
      return new URLSearchParams(window.location.search).get('sso_error');
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!error) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('sso_error');
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

export function SsoErrorAlert({ error, onClose }: { error: string | null; onClose: () => void }) {
  const { t } = useTranslation('auth');
  if (!error) return null;
  return (
    <Alert color="red" title={t('sso.failed')} withCloseButton onClose={onClose}>
      {error}
    </Alert>
  );
}

import { useEffect, useState } from 'react';
import { Alert, Button, Stack } from '@mantine/core';
import { IconBrandWindows, IconKey } from '@tabler/icons-react';
import type { SsoProviderPublic } from '@sm/shared';

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
  if (!providers.length) return null;
  const path = window.location.pathname + window.location.search;
  const returnTo = encodeURIComponent(path.startsWith('/') ? path : '/');
  return (
    <Stack gap="xs">
      {providers.map((p) => (
        <Button
          key={p.id}
          component="a"
          href={`/api/auth/oidc/${encodeURIComponent(p.id)}/start?returnTo=${returnTo}`}
          variant="default"
          size="md"
          fullWidth
          leftSection={p.type === 'entra' ? <IconBrandWindows size={18} /> : <IconKey size={18} />}
          h="auto"
          py={8}
          styles={{ label: { whiteSpace: 'normal', textAlign: 'center' }, inner: { minHeight: 26 } }}
        >
          Sign in with {p.displayName}
        </Button>
      ))}
    </Stack>
  );
}

export function SsoErrorAlert({ error, onClose }: { error: string | null; onClose: () => void }) {
  if (!error) return null;
  return (
    <Alert color="red" title="Single sign-on failed" withCloseButton onClose={onClose}>
      {error}
    </Alert>
  );
}

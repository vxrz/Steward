import { Alert, List, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ErrorParams, SsoConfigWarning } from '@sm/shared';
import { listFormat } from '../../format';

/** Text values of warning parameters (lists joined in the UI language). */
function values(params: ErrorParams | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    out[k] = Array.isArray(v) ? listFormat().format(v.map(String)) : typeof v === 'number' ? v : String(v ?? '');
  }
  return out;
}

/** What to look at in a provider's settings: claims others can influence, linking by name, user name collisions … */
export function ConfigWarnings({ warnings }: { warnings: SsoConfigWarning[] }) {
  const { t } = useTranslation('users');
  if (!warnings.length) return null;
  return (
    <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title={t('provider.warnings.title')} data-testid="sso-warnings">
      <List size="sm" spacing={4}>
        {warnings.map((w, i) => (
          <List.Item key={`${w.code}-${i}`}>
            <Text size="sm">{t(`provider.warnings.${w.code}`, values(w.params))}</Text>
          </List.Item>
        ))}
      </List>
    </Alert>
  );
}

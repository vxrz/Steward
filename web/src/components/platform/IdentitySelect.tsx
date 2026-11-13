import { Select, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Platform, PlatformIdentity } from '@sm/shared';

/** The value standing for the default identity (nothing is stored then: the platform's default at the time of use). */
const DEFAULT = '__default__';

/** A platform by id or name (monitor definitions may name one). */
export function platformByRef(platforms: Platform[] | undefined, ref: string): Platform | undefined {
  return platforms?.find((p) => p.id === ref) ?? platforms?.find((p) => p.name.toLowerCase() === ref.toLowerCase());
}

/** The identity a stored reference (id or name; empty: the default) names on a platform. */
export function identityOf(platform: Platform | undefined, ref: string | null | undefined): PlatformIdentity | undefined {
  const list = platform?.identities ?? [];
  if (!ref) return list.find((i) => i.default);
  return list.find((i) => i.id === ref) ?? list.find((i) => i.name.toLowerCase() === ref.toLowerCase());
}

/**
 * Choosing the identity of a platform (0.13.0, ADR 0009): shown only where the platform has more than one. Identities
 * the person may not use are listed, but cannot be chosen (it explains why a choice is missing); `needsWrites` leaves
 * out read-only identities (a slot that writes, a monitor output). `value` empty: the default identity. Privileged
 * identities (0.14.0, ADR 0009 step 4) are marked; choosing one says that a step-up – and maybe a second person – is
 * needed; `noPrivileged` (monitors) cannot choose them.
 */
export function IdentitySelect({
  platform,
  value,
  onChange,
  needsWrites,
  noPrivileged,
  disabled,
  label,
  testId,
}: {
  platform: Platform | undefined;
  value: string | undefined;
  onChange: (identityId: string | undefined) => void;
  needsWrites?: boolean;
  noPrivileged?: boolean;
  disabled?: boolean;
  label?: string;
  testId?: string;
}) {
  const { t } = useTranslation('platforms');
  const identities = platform?.identities ?? [];
  if (identities.length < 2) return null;
  const current = identityOf(platform, value);
  const item = (i: PlatformIdentity) => {
    const why = !i.mayUse
      ? t('identitySelect.notAllowed')
      : needsWrites && i.readOnly
        ? t('identitySelect.readOnly')
        : noPrivileged && i.privileged
          ? t('identitySelect.noPrivileged')
          : '';
    return {
      value: i.default ? DEFAULT : i.id,
      label: `${i.name}${i.default ? ` (${t('identities.default')})` : ''}${i.readOnly ? ` · ${t('identities.readOnly')}` : ''}${i.privileged ? ` · ${t('identities.privileged')}` : ''}${why ? ` – ${why}` : ''}`,
      disabled: !!why,
    };
  };
  return (
    <Stack gap={4}>
      <Select
        label={label ?? t('identitySelect.label')}
        description={t('identitySelect.description')}
        data={identities.map(item)}
        value={current ? (current.default ? DEFAULT : current.id) : DEFAULT}
        onChange={(v) => onChange(!v || v === DEFAULT ? undefined : v)}
        allowDeselect={false}
        disabled={disabled}
        data-testid={testId ?? 'identity-select'}
      />
      {current?.privileged && !noPrivileged && (
        <Text size="xs" c="dimmed" data-testid="identity-privileged-hint">
          {t('identitySelect.privilegedHint')}
        </Text>
      )}
    </Stack>
  );
}

import { Alert, Select, Stack, Text } from '@mantine/core';
import type { MonitorPlatformReference } from '@sm/shared';
import { useTranslation } from 'react-i18next';

/** The platform for a reference: the one chosen, else the one the name resolves to, else the only one the user may pick. */
const platformFor = (r: MonitorPlatformReference, choices: Record<string, string>): string | undefined =>
  choices[r.ref] ?? r.resolved?.id ?? (r.candidates.length === 1 ? r.candidates[0]!.id : undefined);

/** The platform for each reference, sent with the import or the acceptance. */
export function chosenPlatforms(refs: MonitorPlatformReference[], choices: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of refs) {
    const id = platformFor(r, choices);
    if (id) out[r.ref] = id;
  }
  return out;
}

/** Whether every reference has a platform. */
export const platformsComplete = (refs: MonitorPlatformReference[], choices: Record<string, string>) => refs.every((r) => !!platformFor(r, choices));

/**
 * One platform picker per platform reference of a monitor file (import, Git sync): the file names a
 * platform ("Insights Hub"), the user picks which of their platforms of that kind it stands for.
 */
export function PlatformChoices({
  refs,
  choices,
  onChange,
}: {
  refs: MonitorPlatformReference[];
  choices: Record<string, string>;
  onChange: (choices: Record<string, string>) => void;
}) {
  const { t } = useTranslation('monitors');
  if (!refs.length) return null;
  return (
    <Stack gap="xs" data-testid="platform-choices">
      <Text size="sm" fw={500}>
        {t('platformChoices.title')}
      </Text>
      {refs.map((r) => {
        const usedBy = r.usedBy.map((u) => u.name).join(', ');
        const label = t('platformChoices.label', { ref: r.ref });
        return r.candidates.length ? (
          <Select
            key={r.ref}
            label={label}
            description={t('platformChoices.usedBy', { usedBy })}
            placeholder={t('platformChoices.choose')}
            data={r.candidates.map((c) => ({ value: c.id, label: c.name }))}
            value={platformFor(r, choices) ?? null}
            onChange={(v) => onChange({ ...choices, ...(v ? { [r.ref]: v } : {}) })}
            allowDeselect={false}
            required
          />
        ) : (
          <Alert key={r.ref} color="orange" variant="light" title={label}>
            {r.kind ? t('platformChoices.noneOfKind', { kind: r.kind }) : t('platformChoices.none')}
          </Alert>
        );
      })}
    </Stack>
  );
}

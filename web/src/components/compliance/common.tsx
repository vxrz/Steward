import { Badge, Group, Select, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { AccessFindingStatus, CoverageStatus } from '@sm/shared';
import { TONE } from '../common';

/** Shared pieces of the compliance pages: the period picker and the badges. */

export type PeriodPreset = '30' | '90' | '365' | 'custom';

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface Period {
  preset: PeriodPreset;
  /** YYYY-MM-DD (local) */
  from: string;
  to: string;
}

export function presetPeriod(preset: Exclude<PeriodPreset, 'custom'>, now = new Date()): Period {
  const from = new Date(now.getTime() - Number(preset) * 86400000);
  return { preset, from: day(from), to: day(now) };
}

/** The period as ISO timestamps: from the start of the first day to the end of the last day (local time). */
export function periodRange(p: Period): { from: string; to: string } {
  const [fy, fm, fd] = p.from.split('-').map(Number);
  const [ty, tm, td] = p.to.split('-').map(Number);
  return { from: new Date(fy!, fm! - 1, fd!, 0, 0, 0).toISOString(), to: new Date(ty!, tm! - 1, td!, 23, 59, 59, 999).toISOString() };
}

export const validPeriod = (p: Period) => /^\d{4}-\d{2}-\d{2}$/.test(p.from) && /^\d{4}-\d{2}-\d{2}$/.test(p.to) && p.from <= p.to;

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const { t } = useTranslation('compliance');
  return (
    <Group gap="xs" align="flex-end" wrap="wrap">
      <Select
        size="xs"
        label={t('period.label')}
        w={{ base: '100%', xs: 180 }}
        allowDeselect={false}
        data={[
          { value: '30', label: t('period.days30') },
          { value: '90', label: t('period.days90') },
          { value: '365', label: t('period.days365') },
          { value: 'custom', label: t('period.custom') },
        ]}
        value={value.preset}
        onChange={(v) => {
          if (!v) return;
          onChange(v === 'custom' ? { ...value, preset: 'custom' } : presetPeriod(v as '30'));
        }}
      />
      <TextInput
        size="xs"
        type="date"
        label={t('period.from')}
        value={value.from}
        onChange={(e) => onChange({ ...value, preset: 'custom', from: e.currentTarget.value })}
        w={{ base: '48%', xs: 150 }}
      />
      <TextInput
        size="xs"
        type="date"
        label={t('period.to')}
        value={value.to}
        onChange={(e) => onChange({ ...value, preset: 'custom', to: e.currentTarget.value })}
        w={{ base: '48%', xs: 150 }}
      />
    </Group>
  );
}

const COVERAGE_COLOR: Record<CoverageStatus, string> = { covered: TONE.ok, gap: TONE.bad, unmapped: TONE.neutral };

export function CoverageBadge({ status, size = 'sm' }: { status: CoverageStatus; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('compliance');
  return (
    <Badge color={COVERAGE_COLOR[status]} variant={status === 'gap' ? 'filled' : 'light'} size={size} style={{ minWidth: 'max-content' }}>
      {t(`coverage.${status}`)}
    </Badge>
  );
}

const FINDING_COLOR: Record<AccessFindingStatus, string> = { open: TONE.attention, documented: TONE.ok, dismissed: TONE.neutral };

export function FindingStatusBadge({ status }: { status: AccessFindingStatus }) {
  const { t } = useTranslation('compliance');
  return (
    <Badge color={FINDING_COLOR[status]} variant="light" size="sm">
      {t(`findingStatus.${status}`)}
    </Badge>
  );
}

export function KindBadge({ kind }: { kind: string }) {
  const { t } = useTranslation('compliance');
  const color = kind === 'revoke' || kind === 'offboarding' ? 'grape' : kind === 'modify' ? 'cyan' : 'indigo';
  return (
    <Badge color={color} variant="outline" size="sm">
      {t(`kinds.${kind as 'grant'}`, { defaultValue: kind })}
    </Badge>
  );
}

/** "+ A, B  − C" with colours (granted green, revoked red); text says it as well. */
export function RightsDiff({ granted, revoked }: { granted: string[]; revoked: string[] }) {
  const { t } = useTranslation('compliance');
  return (
    <Group gap={4} wrap="wrap">
      {granted.map((r) => (
        <Badge key={`+${r}`} size="xs" variant="light" color={TONE.ok} title={t('rights.granted')} style={{ textTransform: 'none' }}>
          + {r}
        </Badge>
      ))}
      {revoked.map((r) => (
        <Badge key={`-${r}`} size="xs" variant="light" color={TONE.bad} title={t('rights.revoked')} style={{ textTransform: 'none' }}>
          − {r}
        </Badge>
      ))}
    </Group>
  );
}

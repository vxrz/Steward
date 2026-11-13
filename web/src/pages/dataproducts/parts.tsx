import type { ReactNode } from 'react';
import { Alert, Anchor, Badge, Group, Paper, Select, Stack, Text, Title, Tooltip } from '@mantine/core';
import { Link, useSearchParams } from 'react-router-dom';
import { IconAlertTriangle, IconEyeOff, IconLock, IconUserShield } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  isProductionEnvironment,
  type DataClassification,
  type DataElementKind,
  type DataElementOnProduct,
  type DataMemberRole,
  type DataObjectLifecycle,
  type DataProductLifecycle,
  type DataProductType,
  type DataRef,
  type PersonalDataLevel,
  type RatingFloor,
} from '@sm/shared';
import { useEnvironmentList } from '../../components/catalogue/environments';
import { useLevel } from '../../components/catalogue/cia';

/** Small parts of the data products pages: badges (always a word beside a colour), facts, references, the environment switch. */

const LIFECYCLE_COLOR: Record<DataProductLifecycle, string> = {
  proposed: 'gray',
  draft: 'gray',
  active: 'green',
  deprecated: 'orange',
  retired: 'red',
};

export function LifecycleBadge({ lifecycle, sunsetDate, size = 'sm' }: { lifecycle: DataProductLifecycle | DataObjectLifecycle; sunsetDate?: string | null; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProducts');
  const badge = (
    <Badge size={size} variant={lifecycle === 'active' ? 'light' : 'outline'} color={LIFECYCLE_COLOR[lifecycle]} tt="none" data-lifecycle={lifecycle}>
      {t(`lifecycle.${lifecycle}`)}
    </Badge>
  );
  return sunsetDate && lifecycle === 'deprecated' ? <Tooltip label={t('lifecycle.sunsetOn', { date: sunsetDate })}>{badge}</Tooltip> : badge;
}

export function TypeBadge({ type, size = 'sm' }: { type: DataProductType | null; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProducts');
  if (!type) return null;
  return (
    <Badge size={size} variant="light" color="grape" tt="none">
      {t(`types.${type}`)}
    </Badge>
  );
}

const CLASS_COLOR: Record<DataClassification, string> = { public: 'gray', internal: 'blue', confidential: 'orange', strictly_confidential: 'red' };

export function ClassificationBadge({ value, size = 'sm' }: { value: DataClassification | null; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProducts');
  if (!value) return null;
  return (
    <Badge size={size} variant="light" color={CLASS_COLOR[value]} tt="none" leftSection={value !== 'public' ? <IconLock size={11} aria-hidden /> : undefined}>
      {t(`classification.${value}`)}
    </Badge>
  );
}

export function PersonalDataBadge({ value, size = 'sm' }: { value: PersonalDataLevel; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProducts');
  if (value === 'none') return null;
  return (
    <Badge size={size} variant="light" color={value === 'special' ? 'red' : 'yellow'} tt="none" leftSection={<IconUserShield size={11} aria-hidden />}>
      {t(`personalData.${value}`)}
    </Badge>
  );
}

const ROLE_COLOR: Record<DataMemberRole, string> = { input: 'cyan', internal: 'gray', output: 'teal' };

export function RoleBadge({ role, size = 'sm' }: { role: DataMemberRole; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('dataProducts');
  return (
    <Badge size={size} variant="light" color={ROLE_COLOR[role]} tt="none">
      {t(`roles.${role}`)}
    </Badge>
  );
}

/** The kind of an element in words. */
export function useKindLabel(): (k: DataElementKind) => string {
  const { t } = useTranslation('dataProductViews');
  return (k) => t(`elementKinds.${k}`);
}

/** A labelled value of a facts grid. */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" component="div" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </div>
  );
}

/** A card of a page with a heading (h2) and optional actions on the right. */
export function Section({ title, actions, children, testId }: { title: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Paper withBorder p="md" data-testid={testId}>
      <Group justify="space-between" mb="sm" gap="xs" wrap="wrap">
        <Title order={2} size="h5">
          {title}
        </Title>
        {actions && (
          <Group gap="xs" wrap="wrap">
            {actions}
          </Group>
        )}
      </Group>
      {children}
    </Paper>
  );
}

/** A product, data object or domain the reader may see (a link), or one they may not (counted, never named). */
export function RefLink({ r, base }: { r: DataRef | null; base: '/data-products' | '/data-objects' | '/data-domains' | '/data-contracts' }) {
  const { t } = useTranslation('dataProducts');
  if (!r) return <>–</>;
  if (r.hidden)
    return (
      <Text span size="sm" c="dimmed" fs="italic">
        {t('hidden.item')}
      </Text>
    );
  if (base === '/data-domains') return <>{r.name}</>;
  return (
    <Anchor component={Link} to={`${base}/${encodeURIComponent(r.id)}`} size="sm">
      {r.name}
    </Anchor>
  );
}

/** "and 2 you may not see" after a list of names. */
export function HiddenCount({ count }: { count: number }) {
  const { t } = useTranslation('dataProducts');
  if (!count) return null;
  return (
    <Group gap={4} wrap="nowrap" component="span">
      <IconEyeOff size={14} aria-hidden />
      <Text span size="sm" c="dimmed">
        {t('hidden.count', { count })}
      </Text>
    </Group>
  );
}

/** An element as a product shows it: a link to its page where the reader may open it, else its name only. */
export function ElementName({ e, short = false }: { e: Pick<DataElementOnProduct, 'id' | 'qualifiedName' | 'displayName' | 'visible'>; short?: boolean }) {
  const name = short ? e.displayName || e.qualifiedName : e.qualifiedName;
  return e.visible ? (
    <Anchor component={Link} to={`/data-elements/${encodeURIComponent(e.id)}`} size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
      {name}
    </Anchor>
  ) : (
    <Text span size="sm" className="mono" style={{ overflowWrap: 'anywhere' }}>
      {name}
    </Text>
  );
}

/** The platform of an element: its name, none, or one the reader may not see. */
export function PlatformName({ name, hidden }: { name: string | null; hidden: boolean }) {
  const { t } = useTranslation('dataProducts');
  if (hidden)
    return (
      <Text span size="sm" c="dimmed" fs="italic">
        {t('hidden.platform')}
      </Text>
    );
  return <>{name ?? t('elements.noPlatform')}</>;
}

/** The rating floor (decision 8): a warning without a reason, a note with one; the classification's highest exposed. */
export function RatingFloorNote({ floor, objects }: { floor: RatingFloor & { objects: DataRef[] }; objects?: DataRef[] }) {
  const { t } = useTranslation(['dataProducts', 'applications']);
  const level = useLevel();
  if (!floor.findings.length) return null;
  const names = new Map((objects ?? floor.objects).map((o) => [o.id ?? '', o]));
  const from = (ids: string[]) => {
    const seen = ids.map((id) => names.get(id)).filter((o): o is DataRef => !!o && !o.hidden);
    const hidden = ids.length - seen.length;
    return [seen.map((o) => o.name).join(', '), hidden ? t('hidden.count', { count: hidden }) : ''].filter(Boolean).join(', ');
  };
  const dim = (d: string) => (d === 'classification' ? t('rating.classification') : t(`applications:cia.dimensions.${d}` as 'applications:cia.dimensions.integrity'));
  const lv = (d: string, k: string | null) =>
    !k ? t('rating.notRated') : d === 'classification' ? t(`classification.${k as DataClassification}`) : (level(d as 'integrity', k)?.label ?? k);
  return (
    <Alert
      color={floor.warning ? 'orange' : 'gray'}
      variant="light"
      icon={<IconAlertTriangle size={16} />}
      title={floor.warning ? t('rating.belowTitle') : t('rating.belowExplained')}
      data-testid="rating-floor"
    >
      <Stack gap={4}>
        {floor.findings.map((f) => (
          <Text size="sm" key={f.dimension}>
            {t('rating.below', { dimension: dim(f.dimension), level: lv(f.dimension, f.level), floor: lv(f.dimension, f.floor), objects: from(f.from) })}
            {f.reason ? ` – ${t('rating.reason', { reason: f.reason })}` : ` – ${t('rating.noReason')}`}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}

/** The environments of a product, production first (Settings → Environments order, then the rest by name). */
export function useSortedEnvironments(names: readonly string[]): string[] {
  const list = useEnvironmentList();
  const rank = (n: string) => {
    if (isProductionEnvironment(list, n)) return -1;
    const i = list.findIndex((e) => e.name.toLowerCase() === n.toLowerCase());
    return i < 0 ? list.length : i;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * The environment shown, from the address (`?environment=`), else the first of `names` (production first) – the
 * switch above a view. One environment: no switch, its name is said.
 */
export function useEnvironmentParam(names: readonly string[]): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const sorted = useSortedEnvironments(names);
  const asked = params.get('environment') ?? '';
  const value = asked && sorted.includes(asked) ? asked : (sorted[0] ?? '');
  const set = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('environment', v);
    else next.delete('environment');
    setParams(next, { replace: true });
  };
  return [value, set];
}

export function EnvironmentSwitch({ names, value, onChange, testId }: { names: readonly string[]; value: string; onChange: (v: string) => void; testId?: string }) {
  const { t } = useTranslation('dataProducts');
  const list = useEnvironmentList();
  const sorted = useSortedEnvironments(names);
  if (sorted.length < 2) return null;
  return (
    <Select
      size="xs"
      label={t('environment.label')}
      data={sorted.map((n) => ({ value: n, label: isProductionEnvironment(list, n) ? t('environment.production', { name: n }) : n }))}
      value={value}
      onChange={(v) => v && onChange(v)}
      allowDeselect={false}
      w={{ base: '100%', xs: 220 }}
      data-testid={testId}
    />
  );
}

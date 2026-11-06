import { useState, type ReactNode } from 'react';
import { Anchor, Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCircleCheck, IconCircleDashed, IconCircleX, IconNetwork } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { LinkKind, LinkTarget, LiveState, PlantItemRef, PlantLiveStatus, PlantSiteNetwork, SecurityLevel, ZoneCriticality } from '@sm/shared';
import { get } from '../../api';
import { TONE } from '../common';
import { fmtDate } from '../../format';
import { plantKeys } from '../../queryKeys';

/** A labelled value in the network's cards (the text in the size of the card's). */
export function NetField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="sm" component="div" style={{ overflowWrap: 'anywhere' }}>
        {children}
      </Text>
    </div>
  );
}

/** Colours of the live status: green only when a check says online; unknown stays gray (never green). */
export const LIVE_COLOR: Record<LiveState, string> = { online: TONE.ok, offline: TONE.bad, unknown: TONE.neutral };
const LIVE_ICON = { online: IconCircleCheck, offline: IconCircleX, unknown: IconCircleDashed } as const;

const CRITICALITY_COLOR: Record<ZoneCriticality, string> = { low: TONE.neutral, medium: TONE.soon, high: TONE.attention, critical: TONE.bad };

/** Online, offline or unknown – with the reason in a tooltip when nothing watches it. */
export function LiveBadge({ live, size = 'sm' }: { live: PlantLiveStatus; size?: 'xs' | 'sm' | 'md' }) {
  const { t } = useTranslation('plantNetwork');
  const Icon = LIVE_ICON[live.state];
  const badge = (
    <Badge
      color={LIVE_COLOR[live.state]}
      variant={live.state === 'unknown' ? 'outline' : 'light'}
      size={size}
      leftSection={<Icon size={12} aria-hidden />}
      style={{ minWidth: 'max-content' }}
      data-testid="live-badge"
      data-state={live.state}
    >
      {t(`live.${live.state}`)}
    </Badge>
  );
  if (live.watched) return badge;
  return (
    <Tooltip label={t('live.notWatchedHint')} multiline w={260} withArrow>
      {badge}
    </Tooltip>
  );
}

/** What each linked check says, with its monitor or dataset (named only when the reader may see it). */
export function LiveChecks({ live, empty }: { live: PlantLiveStatus; empty?: string }) {
  const { t } = useTranslation('plantNetwork');
  if (!live.checks.length)
    return (
      <Text size="sm" c="dimmed">
        {empty ?? t('live.noChecks')}
      </Text>
    );
  return (
    <Stack gap={4} data-testid="live-checks">
      {live.checks.map((c, i) => {
        // a check the reader may not see: its state only, no name, check, reason or time
        const name = c.visible ? c.label || c.ref : t('live.hiddenCheck');
        return (
          <Group key={i} gap={6} wrap="nowrap" align="flex-start">
            <Badge color={LIVE_COLOR[c.state]} variant={c.state === 'unknown' ? 'outline' : 'light'} size="xs" style={{ minWidth: 'max-content' }}>
              {t(`live.${c.state}`)}
            </Badge>
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {c.path ? (
                  <Anchor component={Link} to={c.path} size="sm">
                    {name}
                  </Anchor>
                ) : (
                  name
                )}
                {c.check && (
                  <Text span size="xs" c="dimmed" className="mono">
                    {' '}
                    · {c.check}
                  </Text>
                )}
              </Text>
              <Text size="xs" c="dimmed">
                {t(`reasons.${c.reason}`, { kind: t(`checkKinds.${c.kind}`) })}
                {c.at && ` · ${fmtDate(c.at)}`}
              </Text>
            </Stack>
          </Group>
        );
      })}
    </Stack>
  );
}

export function CriticalityBadge({ value, size = 'sm' }: { value: ZoneCriticality | null; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plantNetwork');
  if (!value) return null;
  return (
    <Badge color={CRITICALITY_COLOR[value]} variant="light" size={size} style={{ minWidth: 'max-content' }}>
      {t(`criticality.${value}`)}
    </Badge>
  );
}

/** The IEC 62443-3-2 target security level, or "SL-T open" until a risk assessment sets it. */
export function SlBadge({ value, size = 'sm' }: { value: SecurityLevel | null; size?: 'xs' | 'sm' }) {
  const { t } = useTranslation('plantNetwork');
  return (
    <Tooltip label={value ? t('zone.slSetHint') : t('zone.slOpenHint')} multiline w={260} withArrow>
      <Badge color={value ? 'indigo' : 'gray'} variant={value ? 'light' : 'outline'} size={size} style={{ minWidth: 'max-content' }} data-testid="sl-badge">
        {value ? t('zone.sl', { level: value }) : t('zone.slOpen')}
      </Badge>
    </Tooltip>
  );
}

/** A Steward item a record names: a link for who may open it, the name for a plant viewer, "not visible" otherwise. */
export function ItemRefView({ item, fallback }: { item: PlantItemRef | null; fallback?: string }) {
  const { t } = useTranslation('plantNetwork');
  if (!item)
    return (
      <Text span size="sm">
        {fallback || '–'}
      </Text>
    );
  if (item.path)
    return (
      <Anchor component={Link} to={item.path} size="sm">
        {item.label || item.id}
      </Anchor>
    );
  if (item.visible || item.kind === 'job' || item.kind === 'dataset')
    return (
      <Text span size="sm" className={item.kind === 'dataset' ? 'mono' : undefined}>
        {item.label || item.id}
      </Text>
    );
  return (
    <Text span size="sm" c="dimmed">
      {t('notVisible')}
    </Text>
  );
}

/** A small row of counts: online, offline, unknown. */
export function LiveCounts({ counts, compact }: { counts: Record<LiveState, number>; compact?: boolean }) {
  const { t } = useTranslation('plantNetwork');
  return (
    <SimpleGrid cols={3} spacing="xs" data-testid="live-counts">
      {(['online', 'offline', 'unknown'] as const).map((s) => {
        const Icon = LIVE_ICON[s];
        return (
          <Paper key={s} withBorder p={compact ? 6 : 'sm'} data-testid={`live-count-${s}`}>
            <Group gap={6} wrap="nowrap" justify="center">
              <Icon size={compact ? 16 : 20} color={`var(--mantine-color-${LIVE_COLOR[s]}-filled)`} aria-hidden />
              <Text fw={700} size={compact ? 'md' : 'xl'}>
                {counts[s]}
              </Text>
            </Group>
            <Text size="xs" c="dimmed" ta="center">
              {t(`live.${s}`)}
            </Text>
          </Paper>
        );
      })}
    </SimpleGrid>
  );
}

/** The site page's card: its assets by live status and the way to its OT network. */
export function SiteNetworkCard({ siteId }: { siteId: string }) {
  const { t } = useTranslation('plantNetwork');
  const q = useQuery({ queryKey: plantKeys.network(siteId), queryFn: () => get<PlantSiteNetwork>(`/plant/sites/${encodeURIComponent(siteId)}/network`) });
  const n = q.data;
  return (
    <Paper withBorder p="md" mt="md" data-testid="site-network-card">
      <Stack gap="xs">
        <Group gap={6} wrap="nowrap">
          <IconNetwork size={18} aria-hidden />
          <Text fw={600}>{t('title')}</Text>
        </Group>
        {n ? (
          <>
            <LiveCounts counts={n.statusCounts} compact />
            <Text size="xs" c="dimmed">
              {t('card.summary', { vlans: n.vlans.length, zones: n.zones.length, devices: n.devices.length })}
            </Text>
          </>
        ) : (
          <Text size="sm" c="dimmed">
            {q.isError ? t('card.error') : t('card.loading')}
          </Text>
        )}
        <Group gap="xs">
          <Button size="xs" variant="light" component={Link} to={`/plant/sites/${encodeURIComponent(siteId)}/network`} data-testid="open-network">
            {t('card.open')}
          </Button>
          {/* the picture of it (#230) */}
          <Button
            size="xs"
            variant="default"
            component={Link}
            to={`/plant/sites/${encodeURIComponent(siteId)}/network/diagram`}
            data-testid="open-network-diagram"
          >
            {t('card.diagram')}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}

/**
 * A Steward item to pick (a system, application, platform, process or monitor): searched as one types, through the
 * link targets the reader may see. `keep` is the current value with its label, so an item the reader no longer finds
 * stays selected.
 */
export function ItemSelect({
  kind,
  value,
  onChange,
  label,
  description,
  keep,
  filter,
  required,
  error,
  testId,
}: {
  kind: LinkKind;
  value: string | null;
  onChange: (v: string | null) => void;
  label: ReactNode;
  description?: ReactNode;
  keep?: { id: string; label: string } | null;
  filter?: (x: LinkTarget) => boolean;
  required?: boolean;
  error?: ReactNode;
  testId?: string;
}) {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search, 250);
  const q = useQuery({
    queryKey: ['link-targets', kind, debounced],
    queryFn: () => get<LinkTarget[]>(`/link-targets?kind=${kind}&q=${encodeURIComponent(debounced)}&limit=50`),
  });
  const found = (q.data ?? []).filter((x) => !filter || filter(x));
  const options = found.map((x) => ({ value: x.id, label: x.detail ? `${x.label} (${x.detail})` : x.label }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: keep?.label || value });
  return (
    <Select
      label={label}
      description={description}
      data={options}
      value={value}
      onChange={onChange}
      searchable
      clearable={!required}
      required={required}
      onSearchChange={setSearch}
      nothingFoundMessage="–"
      error={error}
      data-testid={testId}
      comboboxProps={{ withinPortal: true }}
    />
  );
}

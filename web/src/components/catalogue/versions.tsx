import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  List,
  Modal,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconArrowDown, IconArrowUp, IconArrowUpRight, IconListDetails, IconPackage, IconRefresh } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  CONTAINER_REGISTRY_KIND,
  DEFAULT_WATCH_CONFIG,
  PACKAGE_ECOSYSTEMS,
  VERSION_LIMITS,
  VERSION_SCHEMES,
  VERSION_SOURCES,
  isGitPlatformKind,
  type ApplicationDetail,
  type DtrackReadout,
  type Platform,
  type StackEntry,
  type StackLifecycle,
  type StackVersion,
  type VersionEntryDetail,
  type VersionLag,
  type VersionSettings,
  type VersionSource,
  type VersionWatchConfig,
  type VersionWatchStatus,
} from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../../api';
import { fmtDate, fmtDay, fmtRelative } from '../../format';
import { platformKeys, versionKeys } from '../../queryKeys';
import { EmptyState } from '../common';
import { LifecycleBadge, lifecycleText } from './lifecycle';

/**
 * Version watch (#241): the newest version of every tech stack entry, how far behind it is and where it was found –
 * a badge next to the stack entry, the table of an application's tech stack, the dialog of one entry (with its
 * setting), and the settings with the state of the sources.
 */

export const LAG_COLORS: Record<VersionLag, string> = { major: 'red', minor: 'orange', patch: 'blue', current: 'green', unknown: 'gray' };
const LAG_ORDER: Record<VersionLag, number> = { major: 0, minor: 1, patch: 2, unknown: 3, current: 4 };

type T = TFunction<'applications'>;

/** "2 major releases behind", "up to date" … */
export function behindText(t: T, w: StackVersion): string {
  if (w.lag === 'major') return t('versions.behind.major', { count: w.behind?.major ?? 1 });
  if (w.lag === 'minor') return t('versions.behind.minor', { count: w.behind?.minor ?? 1 });
  if (w.lag === 'patch') return w.behind?.patch ? t('versions.behind.patch', { count: w.behind.patch }) : t('versions.behind.patchOnly');
  if (w.lag === 'current') return t('versions.behind.current');
  return t('versions.behind.unknown');
}

/** Short: "2 major", "3 minor", "1 patch", "up to date". */
function behindShort(t: T, w: StackVersion): string {
  if (w.lag === 'major') return t('versions.short.major', { count: w.behind?.major ?? 1 });
  if (w.lag === 'minor') return t('versions.short.minor', { count: w.behind?.minor ?? 1 });
  if (w.lag === 'patch') return t('versions.short.patch');
  if (w.lag === 'current') return t('versions.short.current');
  return t('versions.short.unknown');
}

const sourceLabel = (t: T, s: VersionSource) => t(`versions.sources.${s}`);

export function LagBadge({ watch }: { watch: StackVersion }) {
  const { t } = useTranslation('applications');
  return (
    <Badge size="sm" variant="light" color={LAG_COLORS[watch.lag]} tt="none" data-lag={watch.lag}>
      {behindShort(t, watch)}
    </Badge>
  );
}

/**
 * Next to a stack entry: the newest version when the installed one is behind (coloured by how far), as a button that
 * opens the entry's dialog. Nothing when it is up to date or nothing is known.
 */
export function VersionBadge({ entry, onOpen }: { entry: StackEntry; onOpen?: () => void }) {
  const { t } = useTranslation('applications');
  const w = entry.watch;
  if (!w?.newest || (w.lag !== 'major' && w.lag !== 'minor' && w.lag !== 'patch')) return null;
  const name = [entry.label, entry.version].filter(Boolean).join(' ');
  const tip = [
    t('versions.newestAt', { version: w.newest, where: w.where }),
    behindText(t, w),
    w.daysBehind !== null ? t('versions.daysBehind', { count: w.daysBehind }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const label = t('versions.badgeLabel', { name, newest: w.newest, behind: behindText(t, w) });
  return (
    <Tooltip label={tip} multiline maw={320}>
      <Badge
        component={onOpen ? 'button' : 'span'}
        type={onOpen ? 'button' : undefined}
        onClick={onOpen}
        size="sm"
        variant="outline"
        color={LAG_COLORS[w.lag]}
        tt="none"
        leftSection={<IconArrowUpRight size={12} aria-hidden />}
        aria-label={label}
        data-testid="version-badge"
        data-lag={w.lag}
        style={onOpen ? { cursor: 'pointer' } : undefined}
      >
        {w.newest}
      </Badge>
    </Tooltip>
  );
}

// ---------- the application's tech stack ----------

interface Row {
  key: string;
  holder: 'component' | 'system';
  holderId: string;
  holderName: string;
  environment: string;
  entry: StackEntry;
  dtrack: DtrackReadout | null;
}

function rowsOf(app: ApplicationDetail): Row[] {
  const rows: Row[] = [];
  for (const c of app.components)
    for (const s of c.stack)
      rows.push({
        key: `c ${c.id} ${s.product}`,
        holder: 'component',
        holderId: c.id,
        holderName: c.name,
        environment: c.environment,
        entry: s,
        dtrack: c.dependencyTrack?.readout ?? null,
      });
  const seen = new Set<string>();
  for (const l of app.systems)
    for (const s of l.stack) {
      const key = `s ${l.systemId} ${s.product}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ key, holder: 'system', holderId: l.systemId, holderName: l.name, environment: l.environment, entry: s, dtrack: null });
    }
  const rank = (r: Row) => (r.entry.lifecycle?.state === 'eol' ? -1 : LAG_ORDER[r.entry.watch?.lag ?? 'unknown']);
  return rows.filter((r) => r.entry.watch !== null).sort((a, b) => rank(a) - rank(b) || a.entry.label.localeCompare(b.entry.label));
}

function Vulns({ r }: { r: DtrackReadout | null }) {
  const { t } = useTranslation('applications');
  if (!r || !r.project)
    return (
      <Text span size="sm" c="dimmed">
        –
      </Text>
    );
  const bad = r.counts.critical + r.counts.high;
  return (
    <Tooltip label={t('versions.vulnTip', { project: `${r.project.name}@${r.project.version}`, date: fmtDate(r.readAt) })}>
      <Badge size="sm" variant="light" color={r.counts.critical ? 'red' : r.counts.high ? 'orange' : 'green'} tt="none">
        {bad ? t('versions.vulnCounts', { critical: r.counts.critical, high: r.counts.high }) : t('versions.vulnNone')}
      </Badge>
    </Tooltip>
  );
}

/** The versions of an application's tech stack: one row per component or system and product, the worst first. */
export function StackVersions({ app }: { app: ApplicationDetail }) {
  const { t } = useTranslation('applications');
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const [open, setOpen] = useState<Row | null>(null);
  const rows = rowsOf(app);
  if (!rows.length) return null;
  const withDt = rows.some((r) => !!r.dtrack?.project);
  const count = (lag: VersionLag) => rows.filter((r) => r.entry.watch?.lag === lag).length;
  const where = (r: Row) => (r.environment ? `${r.holderName} (${r.environment})` : r.holderName);
  const details = (r: Row) => (
    <ActionIcon variant="subtle" aria-label={t('versions.details', { product: r.entry.label, holder: r.holderName })} onClick={() => setOpen(r)}>
      <IconListDetails size={16} />
    </ActionIcon>
  );
  const eol = (lc: StackLifecycle | null) =>
    lc && lc.state !== 'unknown' ? (
      <Badge size="sm" variant="light" tt="none" color={lc.state === 'eol' ? 'red' : lc.state === 'ending' ? 'yellow' : 'green'} data-lifecycle={lc.state}>
        {t(`lifecycle.states.${lc.state}`)}
        {lc.eolFrom ? ` · ${fmtDay(lc.eolFrom)}` : ''}
      </Badge>
    ) : (
      <Text span size="sm" c="dimmed">
        –
      </Text>
    );
  return (
    <Stack gap={6} mt="sm" data-testid="stack-versions">
      <Group justify="space-between" gap="xs">
        <Text fw={600} size="sm" id="versions-title">
          {t('versions.title')}
        </Text>
        <Group gap={4}>
          {(['major', 'minor', 'patch', 'current'] as const).map((lag) =>
            count(lag) ? (
              <Badge key={lag} size="sm" variant="light" color={LAG_COLORS[lag]} tt="none">
                {t(`versions.counts.${lag}`, { count: count(lag) })}
              </Badge>
            ) : null,
          )}
        </Group>
      </Group>
      <Text size="xs" c="dimmed">
        {t('versions.help')}
      </Text>
      {phone ? (
        <Stack gap="xs" role="list" aria-labelledby="versions-title">
          {rows.map((r) => (
            <Card key={r.key} withBorder padding="xs" role="listitem" data-testid="version-row">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Stack gap={4} style={{ minWidth: 0 }}>
                  <Group gap={6}>
                    <LifecycleBadge text={[r.entry.label, r.entry.version].filter(Boolean).join(' ')} lifecycle={r.entry.lifecycle} />
                    {r.entry.watch && <LagBadge watch={r.entry.watch} />}
                  </Group>
                  <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {r.entry.watch?.newest ? t('versions.newestAt', { version: r.entry.watch.newest, where: r.entry.watch.where }) : t('versions.noNewest')}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                    {where(r)}
                    {r.entry.watch?.daysBehind ? ` · ${t('versions.daysBehind', { count: r.entry.watch.daysBehind })}` : ''}
                  </Text>
                </Stack>
                {details(r)}
              </Group>
            </Card>
          ))}
        </Stack>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-labelledby="versions-title" verticalSpacing={4}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('versions.columns.installed')}</Table.Th>
                <Table.Th>{t('versions.columns.newest')}</Table.Th>
                <Table.Th>{t('versions.columns.behind')}</Table.Th>
                <Table.Th>{t('versions.columns.eol')}</Table.Th>
                {withDt && <Table.Th>{t('versions.columns.vulnerabilities')}</Table.Th>}
                <Table.Th aria-label={t('components.actions')} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => {
                const w = r.entry.watch!;
                return (
                  <Table.Tr key={r.key} data-testid="version-row">
                    <Table.Td>
                      <Stack gap={2} align="flex-start">
                        <LifecycleBadge text={[r.entry.label, r.entry.version].filter(Boolean).join(' ')} lifecycle={r.entry.lifecycle} />
                        <Text span size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                          {where(r)}
                        </Text>
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {w.newest ? (
                        <Stack gap={0}>
                          <Text span size="sm" className="mono nowrap">
                            {w.newest}
                          </Text>
                          <Text span size="xs" c="dimmed">
                            {w.where}
                          </Text>
                        </Stack>
                      ) : (
                        <Tooltip label={w.error ?? t('versions.noNewest')} multiline maw={320}>
                          <Text span size="sm" c="dimmed">
                            {t('versions.noNewest')}
                          </Text>
                        </Tooltip>
                      )}
                    </Table.Td>
                    <Table.Td className="nowrap">
                      <Stack gap={0}>
                        <span>
                          <LagBadge watch={w} />
                        </span>
                        {w.daysBehind ? (
                          <Text span size="xs" c="dimmed">
                            {t('versions.forDays', { count: w.daysBehind })}
                          </Text>
                        ) : null}
                      </Stack>
                    </Table.Td>
                    <Table.Td className="nowrap">{eol(r.entry.lifecycle)}</Table.Td>
                    {withDt && (
                      <Table.Td className="nowrap">
                        <Vulns r={r.dtrack} />
                      </Table.Td>
                    )}
                    <Table.Td>{details(r)}</Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </div>
      )}
      {open && (
        <VersionEntryModal
          holder={open.holder}
          id={open.holderId}
          product={open.entry.product}
          lifecycle={open.entry.lifecycle}
          onClose={() => setOpen(null)}
        />
      )}
    </Stack>
  );
}

// ---------- one entry ----------

const SOURCE_CHOICES = ['auto', ...VERSION_SOURCES, 'off'] as const;

/** One stack entry: newest version, behind by, end of life, vulnerabilities, what each source said; its setting for editors. */
export function VersionEntryModal({
  holder,
  id,
  product,
  lifecycle,
  onClose,
}: {
  holder: 'component' | 'system';
  id: string;
  product: string;
  lifecycle: StackLifecycle | null;
  onClose: () => void;
}) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const key = versionKeys.entry(holder, id, product);
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<VersionEntryDetail>(`/catalogue/versions/entry?holder=${holder}&id=${encodeURIComponent(id)}&product=${encodeURIComponent(product)}`),
  });
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms'), enabled: !!q.data?.canEdit });
  const [draft, setDraft] = useState<VersionWatchConfig | null>(null);
  const [busy, setBusy] = useState<'save' | 'read' | null>(null);
  const d = q.data;
  const cfg = draft ?? d?.config ?? DEFAULT_WATCH_CONFIG;
  const patch = (p: Partial<VersionWatchConfig>) => setDraft({ ...cfg, ...p });
  const done = async (r: VersionEntryDetail) => {
    qc.setQueryData(key, r);
    setDraft(null);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['application'] }),
      qc.invalidateQueries({ queryKey: ['system'] }),
      qc.invalidateQueries({ queryKey: versionKeys.all, exact: true }),
    ]);
  };
  const save = async () => {
    setBusy('save');
    try {
      await done(await put<VersionEntryDetail>('/catalogue/versions/entry', { holder, id, product, config: cfg }));
      notifyOk(t('versions.entrySaved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const read = async () => {
    setBusy('read');
    try {
      await done(await post<VersionEntryDetail>('/catalogue/versions/entry/read', { holder, id, product }));
      notifyOk(t('versions.entryRead'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const usable = (platforms.data ?? []).filter((p) => p.permissions?.includes('use') ?? true);
  const ociPlatforms = usable.filter((p) => p.kind === CONTAINER_REGISTRY_KIND);
  const gitPlatforms = usable.filter((p) => isGitPlatformKind(p.kind));
  const needsPlatform = cfg.source === 'oci' || cfg.source === 'git';
  const w = d?.watch ?? null;
  return (
    <Modal opened onClose={onClose} title={d ? t('versions.entryTitle', { product: d.label, holder: d.holderName }) : t('versions.title')} size="lg">
      {!d ? (
        <Text size="sm" c="dimmed">
          {q.isError ? t('common:loadFailed') : t('common:loading')}
        </Text>
      ) : (
        <Stack gap="sm" data-testid="version-entry">
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('versions.installed')}
              </Text>
              <Text fw={600} className="mono">
                {d.version || '–'}
              </Text>
              {lifecycle && (
                <Text size="xs" c={lifecycle.state === 'eol' ? 'red' : 'dimmed'}>
                  {lifecycleText(t, lifecycle)}
                </Text>
              )}
            </Stack>
            <Stack gap={2}>
              <Text size="xs" c="dimmed">
                {t('versions.newest')}
              </Text>
              <Text fw={600} className="mono" data-testid="version-newest">
                {w?.newest ?? '–'}
              </Text>
              {w && (
                <Group gap={6}>
                  <LagBadge watch={w} />
                  <Text size="xs" c="dimmed">
                    {behindText(t, w)}
                    {w.daysBehind !== null && w.lag !== 'current' ? ` · ${t('versions.daysBehind', { count: w.daysBehind })}` : ''}
                  </Text>
                </Group>
              )}
            </Stack>
          </SimpleGrid>
          {w?.source ? (
            <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
              {t('versions.foundIn', { source: sourceLabel(t, w.source), where: w.where, ref: w.ref })}
              {w.newestAt ? ` · ${t('versions.published', { date: fmtDay(w.newestAt) })}` : ''}
              {w.checkedAt ? ` · ${t('versions.checked', { when: fmtRelative(w.checkedAt) })}` : ''}
            </Text>
          ) : w ? (
            <Alert color="gray" variant="light" p="xs">
              <Text size="xs">{t('versions.nothingFound', { reason: w.error ?? '' })}</Text>
            </Alert>
          ) : (
            <Text size="xs" c="dimmed">
              {t('versions.off')}
            </Text>
          )}
          {d.vulnerabilities && (
            <Stack gap={2} data-testid="version-vulnerabilities">
              <Text size="sm" fw={600}>
                {t('versions.vulnTitle')}
              </Text>
              <Text size="xs">
                {t('versions.vulnProject', {
                  project: d.vulnerabilities.project,
                  critical: d.vulnerabilities.counts.critical,
                  high: d.vulnerabilities.counts.high,
                  medium: d.vulnerabilities.counts.medium,
                  low: d.vulnerabilities.counts.low,
                })}
              </Text>
              {d.vulnerabilities.findings.length > 0 && (
                <List size="xs" spacing={0}>
                  {d.vulnerabilities.findings.map((f) => (
                    <List.Item key={`${f.vulnId} ${f.component}`}>
                      {t('versions.finding', { id: f.vulnId, severity: f.severity, component: f.component, version: f.version })}
                      {f.fixedIn ? ` – ${t('versions.fixedIn', { version: f.fixedIn })}` : ''}
                    </List.Item>
                  ))}
                </List>
              )}
            </Stack>
          )}
          {d.tried.length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600} id="version-tried">
                {t('versions.tried')}
              </Text>
              <div className="table-scroll">
                <Table fz="xs" aria-labelledby="version-tried" verticalSpacing={2}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('versions.columns.source')}</Table.Th>
                      <Table.Th>{t('versions.columns.lookedUp')}</Table.Th>
                      <Table.Th>{t('versions.columns.result')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {d.tried.map((x) => (
                      <Table.Tr key={x.source}>
                        <Table.Td className="nowrap">{sourceLabel(t, x.source)}</Table.Td>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>{[x.where, x.ref].filter(Boolean).join(' · ') || '–'}</Table.Td>
                        <Table.Td style={{ overflowWrap: 'anywhere' }}>{x.newest ? `${x.newest}${x.note ? ` (${x.note})` : ''}` : (x.note ?? '–')}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </div>
            </Stack>
          )}
          {d.canEdit && (
            <Stack gap="xs" data-testid="version-entry-setting">
              <Text size="sm" fw={600}>
                {t('versions.setting')}
              </Text>
              <Select
                label={t('versions.source')}
                description={t('versions.sourceHint')}
                allowDeselect={false}
                data={SOURCE_CHOICES.map((s) => ({
                  value: s,
                  label: s === 'auto' ? t('versions.auto') : s === 'off' ? t('versions.notWatched') : sourceLabel(t, s),
                }))}
                value={cfg.source}
                onChange={(v) => patch({ source: (v ?? 'auto') as VersionWatchConfig['source'] })}
              />
              {cfg.source !== 'off' && (
                <>
                  {(cfg.source === 'auto' || cfg.source === 'registry' || cfg.source === 'dtrack') && (
                    <TextInput
                      label={t('versions.purl')}
                      description={t('versions.purlHint')}
                      // i18n-ignore: a package URL, the same in every language
                      placeholder="pkg:npm/react"
                      classNames={{ input: 'mono' }}
                      value={cfg.purl}
                      onChange={(e) => patch({ purl: e.currentTarget.value })}
                    />
                  )}
                  {needsPlatform && (
                    <Group grow align="flex-start">
                      <Select
                        label={t('versions.platform')}
                        required
                        searchable
                        data={(cfg.source === 'oci' ? ociPlatforms : gitPlatforms).map((p) => ({ value: p.id, label: p.name }))}
                        value={cfg.platformId}
                        onChange={(v) => patch({ platformId: v })}
                        nothingFoundMessage={t('versions.noPlatform')}
                      />
                      <TextInput
                        label={cfg.source === 'oci' ? t('versions.image') : t('versions.repository')}
                        required
                        // i18n-ignore: an image or repository path, the same in every language
                        placeholder={cfg.source === 'oci' ? 'library/postgres' : 'owner/repository'}
                        classNames={{ input: 'mono' }}
                        value={cfg.name}
                        onChange={(e) => patch({ name: e.currentTarget.value })}
                      />
                    </Group>
                  )}
                  {(cfg.source === 'auto' || needsPlatform) && (
                    <Group grow align="flex-start">
                      <TextInput
                        label={t('versions.tagPattern')}
                        description={t('versions.tagPatternHint')}
                        // i18n-ignore: a tag template, the same in every language
                        placeholder="{version}-alpine"
                        classNames={{ input: 'mono' }}
                        maxLength={VERSION_LIMITS.tagPattern}
                        value={cfg.tagPattern}
                        onChange={(e) => patch({ tagPattern: e.currentTarget.value })}
                      />
                      {cfg.source === 'git' && (
                        <div>
                          <Text size="sm" fw={500} mb={4} id="version-git-refs">
                            {t('versions.gitRefs')}
                          </Text>
                          <SegmentedControl
                            size="xs"
                            aria-labelledby="version-git-refs"
                            value={cfg.gitRefs}
                            onChange={(v) => patch({ gitRefs: v === 'tags' ? 'tags' : 'releases' })}
                            data={[
                              { value: 'releases', label: t('versions.releases') },
                              { value: 'tags', label: t('versions.tags') },
                            ]}
                          />
                        </div>
                      )}
                    </Group>
                  )}
                  <Group grow align="flex-start">
                    <Select
                      label={t('versions.scheme')}
                      allowDeselect={false}
                      data={VERSION_SCHEMES.map((s) => ({ value: s, label: t(`versions.schemes.${s}`) }))}
                      value={cfg.scheme}
                      onChange={(v) => patch({ scheme: (v ?? 'auto') as VersionWatchConfig['scheme'] })}
                    />
                    <Select
                      label={t('versions.prereleases')}
                      allowDeselect={false}
                      data={[
                        { value: 'default', label: t('versions.prereleasesDefault') },
                        { value: 'on', label: t('versions.prereleasesOn') },
                        { value: 'off', label: t('versions.prereleasesOff') },
                      ]}
                      value={cfg.prereleases === null ? 'default' : cfg.prereleases ? 'on' : 'off'}
                      onChange={(v) => patch({ prereleases: v === 'on' ? true : v === 'off' ? false : null })}
                    />
                  </Group>
                </>
              )}
              <Group justify="space-between" mt="xs">
                <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void read()} loading={busy === 'read'} disabled={!!draft}>
                  {t('versions.readNow')}
                </Button>
                <Button onClick={() => void save()} loading={busy === 'save'} disabled={!draft || (needsPlatform && (!cfg.platformId || !cfg.name.trim()))}>
                  {t('common:save')}
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      )}
    </Modal>
  );
}

// ---------- settings ----------

/** Opens the version watch settings and the state of its sources. */
export function VersionWatchButton() {
  const { t } = useTranslation('applications');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="default" leftSection={<IconPackage size={14} />} onClick={() => setOpen(true)}>
        {t('versions.button')}
      </Button>
      {open && <VersionWatchModal onClose={() => setOpen(false)} />}
    </>
  );
}

function VersionWatchModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const qc = useQueryClient();
  const status = useQuery({ queryKey: versionKeys.all, queryFn: () => get<VersionWatchStatus>('/catalogue/versions') });
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms') });
  const [draft, setDraft] = useState<VersionSettings | null>(null);
  const [busy, setBusy] = useState<'save' | 'refresh' | null>(null);
  const s = status.data;
  const settings = draft ?? s?.settings ?? null;
  const patch = (p: Partial<VersionSettings>) => settings && setDraft({ ...settings, ...p });
  const refreshAll = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: versionKeys.all }),
      qc.invalidateQueries({ queryKey: ['application'] }),
      qc.invalidateQueries({ queryKey: ['system'] }),
      qc.invalidateQueries({ queryKey: ['scorecard'] }),
    ]);
  };
  const save = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      await put('/catalogue/versions', draft);
      setDraft(null);
      await refreshAll();
      notifyOk(t('versions.saved'));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const refresh = async () => {
    setBusy('refresh');
    try {
      const r = await post<VersionWatchStatus>('/catalogue/versions/refresh', {});
      await refreshAll();
      notifyOk(t('versions.refreshed', { count: r.withNewest, total: r.entries }));
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(null);
    }
  };
  const all = platforms.data ?? [];
  const move = (i: number, by: number) => {
    if (!settings) return;
    const order = [...settings.order];
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    patch({ order });
  };
  const toggle = (src: VersionSource, on: boolean) => {
    if (!settings) return;
    const order = on ? [...settings.order, src] : settings.order.filter((x) => x !== src);
    patch({ order });
  };
  return (
    <Modal opened onClose={onClose} title={t('versions.settingsTitle')} size="lg">
      {!s || !settings ? (
        <Text size="sm" c="dimmed">
          {status.isError ? t('common:loadFailed') : t('common:loading')}
        </Text>
      ) : (
        <Stack gap="sm" data-testid="version-settings">
          <Text size="sm" c="dimmed">
            {t('versions.settingsHelp')}
          </Text>
          {s.entries === 0 ? (
            <EmptyState compact icon={IconPackage} title={t('versions.noEntries')}>
              {t('versions.noEntriesHint')}
            </EmptyState>
          ) : (
            <Text size="sm" data-testid="version-status">
              {s.refreshedAt
                ? t('versions.status', { count: s.withNewest, total: s.entries, when: fmtRelative(s.refreshedAt) })
                : t('versions.neverRefreshed', { count: s.entries })}{' '}
              {t('versions.statusBehind', { major: s.behind.major, minor: s.behind.minor, patch: s.behind.patch, current: s.current })}
            </Text>
          )}
          {s.errors.length > 0 && (
            <Alert color="orange" title={t('versions.errors')}>
              <List size="sm">
                {s.errors.slice(0, 10).map((e) => (
                  <List.Item key={`${e.source} ${e.ref}`} style={{ overflowWrap: 'anywhere' }}>
                    {sourceLabel(t, e.source)} · {e.ref}: {e.error}
                  </List.Item>
                ))}
              </List>
            </Alert>
          )}
          <div>
            <Text size="sm" fw={500} id="version-order">
              {t('versions.order')}
            </Text>
            <Text size="xs" c="dimmed" mb={4}>
              {t('versions.orderHint')}
            </Text>
            <Stack gap={4} role="list" aria-labelledby="version-order">
              {[...settings.order, ...VERSION_SOURCES.filter((x) => !settings.order.includes(x))].map((src) => {
                const i = settings.order.indexOf(src);
                const on = i >= 0;
                const info = s.sources.find((x) => x.source === src);
                return (
                  <Group key={src} gap="xs" wrap="nowrap" role="listitem" justify="space-between">
                    <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                      <Checkbox
                        label={`${on ? `${i + 1}. ` : ''}${sourceLabel(t, src)}`}
                        checked={on}
                        disabled={!s.canEdit}
                        onChange={(e) => toggle(src, e.currentTarget.checked)}
                      />
                      {info && info.lookups > 0 && (
                        <Text size="xs" c={info.failed ? 'orange.8' : 'dimmed'}>
                          {t('versions.lookups', { count: info.lookups, failed: info.failed })}
                        </Text>
                      )}
                    </Group>
                    {s.canEdit && on && (
                      <Group gap={0} wrap="nowrap">
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          aria-label={t('versions.up', { source: sourceLabel(t, src) })}
                          disabled={i === 0}
                          onClick={() => move(i, -1)}
                        >
                          <IconArrowUp size={14} />
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          size="sm"
                          aria-label={t('versions.down', { source: sourceLabel(t, src) })}
                          disabled={i === settings.order.length - 1}
                          onClick={() => move(i, 1)}
                        >
                          <IconArrowDown size={14} />
                        </ActionIcon>
                      </Group>
                    )}
                  </Group>
                );
              })}
            </Stack>
          </div>
          <NumberInput
            label={t('versions.refreshHours')}
            description={t('versions.refreshHoursHint')}
            min={VERSION_LIMITS.refreshHoursMin}
            max={VERSION_LIMITS.refreshHoursMax}
            value={settings.refreshHours.registry}
            onChange={(v) => {
              const h = typeof v === 'number' ? v : VERSION_LIMITS.defaultRefreshHours;
              patch({ refreshHours: { dtrack: h, registry: h, oci: h, git: h, endoflife: h } });
            }}
            disabled={!s.canEdit}
            w={260}
          />
          <div>
            <Text size="sm" fw={500}>
              {t('versions.registries')}
            </Text>
            <Text size="xs" c="dimmed" mb={4}>
              {t('versions.registriesHint')}
            </Text>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
              {PACKAGE_ECOSYSTEMS.map((e) => (
                <TextInput
                  key={e}
                  label={t(`versions.ecosystems.${e}`)}
                  size="xs"
                  classNames={{ input: 'mono' }}
                  placeholder={t('versions.registryOff')}
                  value={settings.registries[e]}
                  onChange={(ev) => patch({ registries: { ...settings.registries, [e]: ev.currentTarget.value } })}
                  disabled={!s.canEdit}
                />
              ))}
            </SimpleGrid>
          </div>
          <MultiSelect
            label={t('versions.ociPlatforms')}
            description={t('versions.ociPlatformsHint')}
            data={all.filter((p) => p.kind === CONTAINER_REGISTRY_KIND).map((p) => ({ value: p.id, label: p.name }))}
            value={settings.ociPlatformIds}
            onChange={(v) => patch({ ociPlatformIds: v })}
            nothingFoundMessage={t('versions.noPlatform')}
            disabled={!s.canEdit}
            clearable
          />
          <Select
            label={t('versions.gitPlatform')}
            description={t('versions.gitPlatformHint')}
            data={all.filter((p) => isGitPlatformKind(p.kind)).map((p) => ({ value: p.id, label: p.name }))}
            value={settings.gitPlatformId}
            onChange={(v) => patch({ gitPlatformId: v })}
            placeholder={t('versions.none')}
            clearable
            disabled={!s.canEdit}
          />
          <Switch
            label={t('versions.prereleasesSetting')}
            description={t('versions.prereleasesSettingHint')}
            checked={settings.prereleases}
            onChange={(e) => patch({ prereleases: e.currentTarget.checked })}
            disabled={!s.canEdit}
          />
          <Switch
            label={t('versions.notify')}
            description={t('versions.notifyHint')}
            checked={settings.notify}
            onChange={(e) => patch({ notify: e.currentTarget.checked })}
            disabled={!s.canEdit}
          />
          <Switch
            label={t('versions.scorecard')}
            description={t('versions.scorecardHint')}
            checked={settings.scorecard}
            onChange={(e) => patch({ scorecard: e.currentTarget.checked })}
            disabled={!s.canEdit}
          />
          <Group grow align="flex-start">
            <NumberInput
              label={t('versions.warnMinors')}
              min={1}
              max={VERSION_LIMITS.warnMinorsMax}
              value={settings.warnMinors}
              onChange={(v) => patch({ warnMinors: typeof v === 'number' ? v : 2 })}
              disabled={!s.canEdit}
            />
            <NumberInput
              label={t('versions.warnDays')}
              min={1}
              max={VERSION_LIMITS.warnDaysMax}
              value={settings.warnDays}
              onChange={(v) => patch({ warnDays: typeof v === 'number' ? v : 180 })}
              disabled={!s.canEdit}
            />
          </Group>
          <Text size="xs" c="dimmed">
            {t('versions.warnHint')}
          </Text>
          {!s.canEdit && (
            <Text size="xs" c="dimmed">
              {t('versions.adminOnly')}
            </Text>
          )}
          <Text size="xs" c="dimmed">
            {t('versions.renovate')}
          </Text>
          <Group justify="space-between" mt="xs">
            {s.canRefresh ? (
              <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={() => void refresh()} loading={busy === 'refresh'}>
                {t('versions.refresh')}
              </Button>
            ) : (
              <span />
            )}
            {s.canEdit && (
              <Button onClick={() => void save()} loading={busy === 'save'} disabled={!draft}>
                {t('common:save')}
              </Button>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

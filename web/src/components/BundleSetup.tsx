import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Anchor, Badge, Button, Card, Checkbox, Group, List, SegmentedControl, Select, Stack, Table, Text, Title } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { IconCalendarPlus, IconCheck, IconPackages, IconPlayerPlay, IconPlugConnected, IconPower } from '@tabler/icons-react';
import type { Platform, TemplateBundle, TemplateBundleSetupItem, TemplateBundleSetupResult } from '@sm/shared';
import { notifyError, post } from '../api';
import { DescriptionText } from './DescriptionText';

const ACTION_COLORS: Record<TemplateBundleSetupItem['action'], string> = {
  created: 'green',
  updated: 'blue',
  started: 'teal',
  skipped: 'gray',
  kept: 'gray',
  failed: 'red',
};

/** A bundle in the gallery: what it sets up, what it needs, and "Set up". */
export function BundleCard({
  bundle,
  have,
  label,
  canSetUp,
  onSetUp,
}: {
  bundle: TemplateBundle;
  have: Set<string>;
  label: (kind: string) => string;
  canSetUp: boolean;
  onSetUp: () => void;
}) {
  const { t } = useTranslation('processes');
  const exists = bundle.processes.filter((p) => p.existing).length + bundle.dashboards.filter((d) => d.existing).length;
  return (
    <Card withBorder padding="sm" data-testid="bundle-card">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap={6}>
            <IconPackages size={16} aria-hidden />
            <Text fw={600}>{bundle.name}</Text>
          </Group>
          <DescriptionText text={bundle.description} size="sm" c="dimmed" lineClamp={3} />
          <Group gap={4} mt={6}>
            {bundle.platforms.map((p) => {
              const ok = p.kinds.some((k) => have.has(k));
              return (
                <Badge
                  key={p.key}
                  size="xs"
                  tt="none"
                  variant={ok ? 'light' : 'outline'}
                  color={ok ? 'blue' : 'orange'}
                  leftSection={ok ? <IconCheck size={10} /> : <IconPlugConnected size={10} />}
                >
                  {t('templates.needs', { kind: p.kinds.map(label).join(' / ') })}
                </Badge>
              );
            })}
            <Badge size="xs" variant="outline">
              {t('bundles.contents', { processes: bundle.processes.length, dashboards: bundle.dashboards.length, monitors: bundle.monitors.length })}
            </Badge>
            {exists > 0 && (
              <Badge size="xs" variant="light" color="gray">
                {t('bundles.partlySetUp', { count: exists })}
              </Badge>
            )}
          </Group>
        </div>
        {canSetUp && (
          <Button size="xs" style={{ flexShrink: 0 }} onClick={onSetUp} aria-label={t('bundles.setUpNamed', { name: bundle.name })}>
            {t('bundles.setUp')}
          </Button>
        )}
      </Group>
    </Card>
  );
}

/**
 * Setting a bundle up: the platform for each of its platforms, what happens to what exists, monitors and dry runs –
 * then the result with links and the "turn on" step for the schedules and monitors (created switched off).
 */
export function BundleSetup({
  bundle,
  platforms,
  label,
  onBack,
  onClose,
}: {
  bundle: TemplateBundle;
  platforms: Platform[];
  label: (kind: string) => string;
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(['processes', 'common']);
  const qc = useQueryClient();
  const usable = platforms.filter((p) => p.permissions.includes('use'));
  const fitting = (kinds: string[]) => usable.filter((p) => kinds.includes(p.kind));
  const [bindings, setBindings] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(bundle.platforms.map((bp) => [bp.key, fitting(bp.kinds).length === 1 ? fitting(bp.kinds)[0]!.id : null])),
  );
  const [existing, setExisting] = useState<'skip' | 'update'>('skip');
  const [monitors, setMonitors] = useState(true);
  const [dryRuns, setDryRuns] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TemplateBundleSetupResult | null>(null);
  const [turnedOn, setTurnedOn] = useState<TemplateBundleSetupItem[] | null>(null);
  const anyExisting = bundle.processes.some((p) => p.existing) || bundle.dashboards.some((d) => d.existing);
  const missing = bundle.platforms.filter((bp) => !bindings[bp.key]);

  const setUp = async () => {
    setBusy(true);
    try {
      const r = await post<TemplateBundleSetupResult>(`/template-bundles/${encodeURIComponent(bundle.id)}/setup`, {
        bindings: Object.fromEntries(Object.entries(bindings).filter((e): e is [string, string] => !!e[1])),
        existing,
        monitors,
        dryRuns,
      });
      setResult(r);
      for (const key of ['processes', 'dashboards', 'schedules', 'monitors', 'template-bundles', 'runs']) qc.invalidateQueries({ queryKey: [key] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  const turnOn = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const r = await post<{ items: TemplateBundleSetupItem[] }>(`/template-bundles/${encodeURIComponent(bundle.id)}/turn-on`, result.turnOn);
      setTurnedOn(r.items);
      qc.invalidateQueries({ queryKey: ['schedules'] });
      qc.invalidateQueries({ queryKey: ['monitors'] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };

  const grouped = useMemo(() => {
    const items = result?.items ?? [];
    return (['process', 'schedule', 'dashboard', 'monitor', 'dryRun'] as const)
      .map((type) => ({ type, items: items.filter((i) => i.type === type) }))
      .filter((g) => g.items.length);
  }, [result]);

  if (result) {
    const failed = result.items.filter((i) => i.action === 'failed').length;
    const toTurnOn = result.turnOn.schedules.length + result.turnOn.monitors.length;
    return (
      <Stack data-testid="bundle-result">
        <Alert color={failed ? 'orange' : 'green'} icon={<IconCheck size={18} />} title={t('bundles.resultTitle', { name: result.bundle.name })}>
          {failed ? t('bundles.resultFailed', { count: failed }) : t('bundles.resultText')}
        </Alert>
        {grouped.map((g) => (
          <Stack key={g.type} gap={4} component="section" aria-label={t(`bundles.types.${g.type}`)}>
            <Title order={6} c="dimmed" tt="uppercase" fz="xs">
              {t(`bundles.types.${g.type}`)}
            </Title>
            <div className="table-scroll">
              <Table fz="sm">
                <Table.Tbody>
                  {g.items.map((i, n) => (
                    <Table.Tr key={`${i.type}-${i.source}-${n}`}>
                      <Table.Td>
                        {i.link ? (
                          <Anchor component={Link} to={i.link} size="sm" onClick={onClose}>
                            {i.name}
                          </Anchor>
                        ) : (
                          i.name
                        )}
                        {i.message && (
                          <Text size="xs" c={i.action === 'failed' ? 'red' : 'dimmed'}>
                            {i.message}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td className="nowrap" style={{ textAlign: 'right' }}>
                        <Badge size="sm" variant="light" color={ACTION_COLORS[i.action]} data-testid="bundle-item-action">
                          {t(`bundles.actions.${i.action}`)}
                        </Badge>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          </Stack>
        ))}
        {toTurnOn > 0 && !turnedOn && (
          <Alert color="blue" icon={<IconPower size={18} />} title={t('bundles.turnOnTitle')}>
            <Stack gap="xs">
              <Text size="sm">{t('bundles.turnOnText', { schedules: result.turnOn.schedules.length, monitors: result.turnOn.monitors.length })}</Text>
              <Group>
                <Button size="xs" leftSection={<IconPower size={14} />} onClick={turnOn} loading={busy} data-testid="bundle-turn-on">
                  {t('bundles.turnOn')}
                </Button>
                <Button size="xs" variant="default" component={Link} to="/schedules" onClick={onClose} leftSection={<IconCalendarPlus size={14} />}>
                  {t('bundles.reviewSchedules')}
                </Button>
              </Group>
            </Stack>
          </Alert>
        )}
        {turnedOn && (
          <Alert color={turnedOn.some((i) => i.action === 'failed') ? 'orange' : 'green'} data-testid="bundle-turned-on">
            {t('bundles.turnedOn', { count: turnedOn.filter((i) => i.action === 'updated').length })}
            {turnedOn
              .filter((i) => i.action === 'failed')
              .map((i) => (
                <Text key={i.id ?? i.source} size="xs" c="red">
                  {i.name}: {i.message}
                </Text>
              ))}
          </Alert>
        )}
        <Group>
          <Button variant="default" onClick={onClose}>
            {t('common:close')}
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack data-testid="bundle-setup">
      <Group gap={6}>
        <IconPackages size={18} aria-hidden />
        <Title order={4}>{bundle.name}</Title>
      </Group>
      <DescriptionText text={bundle.description} size="sm" c="dimmed" />
      <div>
        <Text size="sm" fw={500}>
          {t('bundles.willCreate')}
        </Text>
        <List size="sm" spacing={2}>
          {bundle.processes.map((p) => (
            <List.Item key={p.template} icon={<IconPlayerPlay size={14} />}>
              {p.name}
              {p.schedule && (
                <Text span size="xs" c="dimmed">
                  {' · '}
                  {t('bundles.scheduleOff', { cron: p.schedule.cron })}
                </Text>
              )}
              {p.existing && (
                <Badge size="xs" ml={6} variant="light" color="gray">
                  {t('bundles.exists')}
                </Badge>
              )}
            </List.Item>
          ))}
          {bundle.dashboards.map((d) => (
            <List.Item key={d.template}>
              {t('bundles.dashboard', { name: d.name })}
              {d.existing && (
                <Badge size="xs" ml={6} variant="light" color="gray">
                  {t('bundles.exists')}
                </Badge>
              )}
            </List.Item>
          ))}
          {bundle.monitors.map((m) => (
            <List.Item key={m.file}>
              {t('bundles.monitor', { name: m.name })}
              {m.existing && (
                <Badge size="xs" ml={6} variant="light" color="gray">
                  {t('bundles.exists')}
                </Badge>
              )}
            </List.Item>
          ))}
        </List>
      </div>
      {bundle.platforms.map((bp) => {
        const options = fitting(bp.kinds);
        return options.length ? (
          <Select
            key={bp.key}
            label={bp.label}
            description={t('bundles.platformHint', { kinds: bp.kinds.map(label).join(', ') })}
            placeholder={t('bundles.choosePlatform')}
            data={options.map((p) => ({ value: p.id, label: p.environment ? `${p.name} (${p.environment})` : p.name }))}
            value={bindings[bp.key] ?? null}
            onChange={(v) => setBindings((b) => ({ ...b, [bp.key]: v }))}
            required
            data-testid="bundle-platform"
          />
        ) : (
          <Alert key={bp.key} color="orange" icon={<IconPlugConnected size={18} />}>
            {t('bundles.noPlatform', { label: bp.label, kinds: bp.kinds.map(label).join(', ') })}{' '}
            <Anchor component={Link} to="/platforms" size="sm" onClick={onClose}>
              {t('bundles.addPlatform')}
            </Anchor>
          </Alert>
        );
      })}
      {anyExisting && (
        <Stack gap={4}>
          <Text size="sm" fw={500} id="bundle-existing">
            {t('bundles.existingLabel')}
          </Text>
          <SegmentedControl
            aria-labelledby="bundle-existing"
            value={existing}
            onChange={(v) => setExisting(v as 'skip' | 'update')}
            data={[
              { value: 'skip', label: t('bundles.existingSkip') },
              { value: 'update', label: t('bundles.existingUpdate') },
            ]}
            style={{ alignSelf: 'flex-start' }}
          />
          <Text size="xs" c="dimmed">
            {t('bundles.existingHint')}
          </Text>
        </Stack>
      )}
      {bundle.monitors.some((m) => m.optional) && (
        <Checkbox label={t('bundles.withMonitors')} checked={monitors} onChange={(e) => setMonitors(e.currentTarget.checked)} />
      )}
      <Checkbox
        label={t('bundles.withDryRuns')}
        description={t('bundles.withDryRunsHint')}
        checked={dryRuns}
        onChange={(e) => setDryRuns(e.currentTarget.checked)}
      />
      <Text size="xs" c="dimmed">
        {t('bundles.offHint')}
      </Text>
      <Group justify="space-between">
        <Button variant="subtle" onClick={onBack}>
          {t('templates.backToList')}
        </Button>
        <Button onClick={setUp} loading={busy} disabled={missing.length > 0} leftSection={<IconPackages size={16} />} data-testid="bundle-submit">
          {t('bundles.setUp')}
        </Button>
      </Group>
    </Stack>
  );
}

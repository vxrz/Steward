import { useMemo, useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, List, Loader, Modal, Paper, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconHeartRateMonitor, IconInfoCircle } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataMonitorResult, DataProduct, ProductHealth } from '@sm/shared';
import { notifyOk, post } from '../../api';
import { ErrorState } from '../../components/common';
import { TableScroll } from '../../components/TableScroll';
import { useBusy } from '../../components/dataproducts/form';
import { HealthBadge } from './views';
import { pagesOf, qs, useInvalidateDataProducts, useMembers, useMonitorProposal, useProductHealth } from './api';
import { ElementName, EnvironmentSwitch, Section, useEnvironmentParam } from './parts';

const enc = encodeURIComponent;

/**
 * Health of a product (ADR 0036 part 10): per environment its monitor's status while the monitor runs, else the worst
 * of its output-port elements (internal ones at most degrading); no linked check is _No data_, never OK. Below, the
 * elements and how many checks watch them, and _Create monitor_ / _Update monitor_: the proposal is shown first, a
 * person applies it, the monitor is a disabled draft to review.
 */
export function ProductHealthTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProducts', 'dataProductViews']);
  const health = useProductHealth(p.id);
  const envNames = useMemo(() => (health.data ?? []).map((h) => h.environment).filter(Boolean), [health.data]);
  const [environment, setEnvironment] = useEnvironmentParam(envNames.length ? envNames : p.environments);
  const h = (health.data ?? []).find((x) => x.environment === environment) ?? health.data?.[0];
  const members = useMembers(p.id, qs({ environment, limit: 100 }));
  const names = useMemo(() => new Map(pagesOf(members.data).map((m) => [m.elementId, m.element])), [members.data]);
  const [proposing, setProposing] = useState(false);
  const canEdit = p.permissions.includes('edit');
  const monitor = p.environmentDetails.find((e) => e.environment === (h?.environment ?? environment))?.monitorId ?? null;
  if (health.error) return <ErrorState error={health.error} onRetry={() => void health.refetch()} />;
  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Text size="sm" c="dimmed" maw={640}>
          {t('health.help')}
        </Text>
        <EnvironmentSwitch names={envNames} value={environment} onChange={setEnvironment} testId="health-environment" />
      </Group>
      {!h ? (
        <Loader size="sm" />
      ) : (
        <SimpleGrid cols={{ base: 1, md: 2 }}>
          <Section title={t('health.product')} testId="health-summary">
            <Stack gap="xs">
              <Group gap="xs">
                <HealthBadge status={h.status} />
                <Text size="sm" c="dimmed">
                  {t(`health.sources.${h.source}`)}
                </Text>
              </Group>
              {h.monitorId && (
                <Anchor component={Link} to={`/monitors/${enc(h.monitorId)}`} size="sm">
                  {t('health.openMonitor')}
                </Anchor>
              )}
              {h.status === 'noData' && (
                <Alert variant="light" color="gray" icon={<IconInfoCircle size={16} />} p="xs">
                  {t('health.noDataHint')}
                </Alert>
              )}
            </Stack>
          </Section>
          <Section
            title={t('health.monitor')}
            testId="health-monitor"
            actions={
              canEdit && (
                <Button size="xs" leftSection={<IconHeartRateMonitor size={14} />} onClick={() => setProposing(true)} data-testid="monitor-propose">
                  {monitor ? t('health.updateMonitor') : t('health.createMonitor')}
                </Button>
              )
            }
          >
            <Text size="sm">{monitor ? t('health.hasMonitor') : t('health.noMonitor')}</Text>
            {monitor && (
              <Anchor component={Link} to={`/monitors/${enc(monitor)}`} size="sm">
                {t('health.openMonitor')}
              </Anchor>
            )}
            <Text size="xs" c="dimmed" mt="xs">
              {t('health.monitorHint')}
            </Text>
          </Section>
        </SimpleGrid>
      )}
      {h && <ElementHealthTable h={h} names={names} />}
      {proposing && <MonitorProposal p={p} environment={h?.environment ?? environment} onClose={() => setProposing(false)} />}
    </Stack>
  );
}

function ElementHealthTable({ h, names }: { h: ProductHealth; names: Map<string, { id: string; qualifiedName: string; displayName: string; visible: boolean }> }) {
  const { t } = useTranslation('dataProducts');
  return (
    <Section title={t('health.elements')} testId="health-elements">
      {h.elements.length ? (
        <TableScroll>
          <Table fz="sm" aria-label={t('health.elements')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('elements.name')}</Table.Th>
                <Table.Th scope="col">{t('products.health')}</Table.Th>
                <Table.Th scope="col">{t('health.checks')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {h.elements.map((e) => {
                const n = names.get(e.elementId);
                return (
                  <Table.Tr key={e.elementId}>
                    <Table.Td>{n ? <ElementName e={n} /> : <Text size="sm">{t('ports.anElement')}</Text>}</Table.Td>
                    <Table.Td>
                      <HealthBadge status={e.status} size="xs" />
                    </Table.Td>
                    <Table.Td>
                      {e.checks.visible + e.checks.hidden === 0
                        ? t('health.noChecks')
                        : [t('health.checksVisible', { count: e.checks.visible }), e.checks.hidden ? t('health.checksHidden', { count: e.checks.hidden }) : ''].filter(Boolean).join(', ')}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </TableScroll>
      ) : (
        <Text size="sm" c="dimmed">
          {t('health.noElements')}
        </Text>
      )}
    </Section>
  );
}

/**
 * The proposal of _Create monitor_ (or _Update monitor_) before anything is made: the checks, the soft links along the
 * steps and what was left out and why; applying it makes a disabled draft (or adds the checks) – never enabled here.
 */
function MonitorProposal({ p, environment, onClose }: { p: DataProduct; environment: string; onClose: () => void }) {
  const { t } = useTranslation(['dataProducts', 'common']);
  const q = useMonitorProposal(p.id, environment, true);
  const invalidate = useInvalidateDataProducts();
  const [name, setName] = useState('');
  const [busy, run] = useBusy();
  const [result, setResult] = useState<DataMonitorResult | null>(null);
  const x = q.data;
  const apply = () =>
    run(async () => {
      const r = await post<DataMonitorResult>(`/data-products/${enc(p.id)}/monitor`, { environment, ...(name.trim() && !x?.monitor ? { name: name.trim() } : {}) });
      setResult(r);
      invalidate();
      notifyOk(r.created ? t('monitor.created', { name: r.monitor.name }) : t('monitor.updated', { count: r.added, name: r.monitor.name }));
    }, t('monitor.notApplied'));
  return (
    <Modal opened onClose={onClose} size="xl" title={x?.monitor ? t('monitor.updateTitle', { environment }) : t('monitor.createTitle', { environment })}>
      <Stack gap="sm" data-testid="monitor-proposal">
        {q.isLoading && <Loader size="sm" />}
        {q.error && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {result ? (
          <Alert color="green" variant="light" data-testid="monitor-result">
            <Stack gap={4}>
              <Text size="sm">{result.created ? t('monitor.createdLong', { name: result.monitor.name }) : t('monitor.updated', { count: result.added, name: result.monitor.name })}</Text>
              <Anchor component={Link} to={`/monitors/${enc(result.monitor.id)}`} size="sm">
                {t('monitor.review')}
              </Anchor>
            </Stack>
          </Alert>
        ) : (
          x && (
            <>
              <Text size="sm">{x.monitor ? t('monitor.updateHelp') : t('monitor.createHelp')}</Text>
              {x.monitorHidden && (
                <Alert color="orange" variant="light">
                  {t('monitor.hidden')}
                </Alert>
              )}
              {x.checks.length ? (
                <TableScroll>
                  <Table fz="sm" aria-label={t('monitor.checks')} data-testid="monitor-checks">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th scope="col">{t('monitor.check')}</Table.Th>
                        <Table.Th scope="col">{t('monitor.mode')}</Table.Th>
                        <Table.Th scope="col">{t('monitor.watches')}</Table.Th>
                        <Table.Th scope="col">{t('monitor.weight')}</Table.Th>
                        <Table.Th scope="col">{t('monitor.maxAge')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {x.checks.map((c) => (
                        <Table.Tr key={c.id}>
                          <Table.Td>{c.name}</Table.Td>
                          <Table.Td>{t(`monitor.modes.${c.mode}`)}</Table.Td>
                          <Table.Td className="mono" style={{ overflowWrap: 'anywhere' }}>
                            {c.elementName ?? '–'}
                            {c.role && (
                              <Text span size="xs" c="dimmed">
                                {' '}
                                · {t(`roles.${c.role}`)}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Badge size="xs" color={c.critical ? 'red' : 'gray'} variant="light" tt="none">
                              {c.critical ? t('monitor.critical') : t('monitor.degrades')}
                            </Badge>
                          </Table.Td>
                          <Table.Td className="nowrap">{c.maxAgeMinutes ? t('objectives.minutes', { count: c.maxAgeMinutes }) : '–'}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </TableScroll>
              ) : (
                <Alert color="gray" variant="light">
                  {t('monitor.nothing')}
                </Alert>
              )}
              {x.links.length > 0 && <Text size="sm">{t('monitor.links', { count: x.links.length })}</Text>}
              {x.skipped.length > 0 && (
                <Paper withBorder p="sm">
                  <Text size="sm" fw={600} mb={4}>
                    {t('monitor.skipped')}
                  </Text>
                  <List size="sm" spacing={2}>
                    {x.skipped.map((s) => (
                      <List.Item key={s.reason}>
                        {t(`monitor.skipReasons.${s.reason}`, { count: s.count })}
                        {s.elements.length > 0 && (
                          <Text span size="xs" c="dimmed" className="mono">
                            {' '}
                            ({s.elements.map((e) => e.name).join(', ')}
                            {s.count > s.elements.length ? ` ${t('monitor.andMore', { count: s.count - s.elements.length })}` : ''})
                          </Text>
                        )}
                      </List.Item>
                    ))}
                  </List>
                </Paper>
              )}
              {!x.monitor && x.checks.length > 0 && (
                <TextInput label={t('monitor.name')} placeholder={t('monitor.namePlaceholder', { name: p.name, environment })} maxLength={160} value={name} onChange={(e) => setName(e.currentTarget.value)} />
              )}
              {!x.canApply && (
                <Text size="sm" c="dimmed">
                  {t('monitor.cannotApply')}
                </Text>
              )}
            </>
          )
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {result ? t('common:close') : t('common:cancel')}
          </Button>
          {!result && x && (
            <Button onClick={() => void apply()} loading={busy} disabled={!x.canApply || !x.checks.length} data-testid="monitor-apply">
              {x.monitor ? t('monitor.applyUpdate', { count: x.checks.length }) : t('monitor.applyCreate')}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

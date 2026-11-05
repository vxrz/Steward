import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Menu, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconAlertTriangle, IconCpu, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type {
  PlantAssignmentValues,
  PlantAssignmentView,
  PlantInterface,
  PlantKpiInstance,
  PlantKpiSummary,
  PlantPointOverride,
  PlantProfileSummary,
  PlantPublication,
} from '@sm/shared';
import { del, get, notifyError, put } from '../../api';
import { EmptyState, QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { Field } from '../records/common';
import { plantKeys } from '../../queryKeys';
import { fmtDate } from '../../format';
import { NotInSourceBadge, useNameOf, usePlantLabel } from './common';
import { Breakable, ChecksList, ParamsView, ProtocolBadge, RowMenu, UnitText } from './data';
import { AssignmentFormModal, AssignmentInterfaceModal, KpiInstanceModal, OverrideModal, PublicationModal } from './dataForms';

const EMPTY: PlantAssignmentValues = { profileId: null, firmware: '', interfaces: [], overrides: [], publications: [], kpis: [], notes: '' };

type Dialog =
  | { kind: 'assignment' }
  | { kind: 'interface'; iface: PlantInterface }
  | { kind: 'override'; index: number | null }
  | { kind: 'publication'; index: number | null }
  | { kind: 'kpi'; index: number | null; kpi?: string };

const putAt = <T,>(list: T[], index: number | null, item: T) => (index === null ? [...list, item] : list.map((x, i) => (i === index ? item : x)));

function Part({
  title,
  help,
  action,
  children,
  testId,
}: {
  title: string;
  help?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Stack gap={6} data-testid={testId}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={600}>
            {title}
          </Text>
          {help && (
            <Text size="xs" c="dimmed">
              {help}
            </Text>
          )}
        </div>
        {action}
      </Group>
      {children}
    </Stack>
  );
}

/**
 * What an asset's interfaces deliver (#219): its device profile and firmware, per interface whether it is set up and
 * where, data points that differ on this asset, where its data points are published, its KPI instances, what Steward
 * finds wrong with them and the KPIs it can have.
 */
export function AssetDataSection({ assetId }: { assetId: string }) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const qc = useQueryClient();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const q = useQuery({
    queryKey: plantKeys.assignment(assetId),
    queryFn: () => get<PlantAssignmentView>(`/plant/assets/${encodeURIComponent(assetId)}/assignment`),
  });
  const v = q.data;
  const canManage = !!v?.canManage;
  const profiles = useQuery({ queryKey: plantKeys.profiles, queryFn: () => get<PlantProfileSummary[]>('/plant/profiles'), enabled: canManage });
  const kpis = useQuery({ queryKey: plantKeys.kpis, queryFn: () => get<PlantKpiSummary[]>('/plant/kpis'), enabled: canManage });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  if (!v) return <QueryState query={q} rows={2} />;
  const a = v.assignment ?? EMPTY;
  const base = `/plant/assets/${encodeURIComponent(assetId)}/assignment`;
  const done = (x: PlantAssignmentView) => {
    qc.setQueryData(plantKeys.assignment(assetId), x);
    void qc.invalidateQueries({ queryKey: plantKeys.checks });
    void qc.invalidateQueries({ queryKey: plantKeys.profiles });
    void qc.invalidateQueries({ queryKey: plantKeys.kpis });
  };
  const save = async (next: PlantAssignmentValues) => done(await put<PlantAssignmentView>(base, next));
  const removeAt = async <K extends 'overrides' | 'publications' | 'kpis'>(key: K, index: number, what: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t('assignment.removeConfirm', { what }) }))) return;
    await save({ ...a, [key]: a[key].filter((_, i) => i !== index) }).catch(notifyError);
  };
  const removeAll = async () => {
    if (!(await confirmDanger({ action: 'remove', message: t('assignment.removeAllConfirm', { name: v.asset.name }) }))) return;
    try {
      done(await del<PlantAssignmentView>(base));
    } catch (e) {
      notifyError(e);
    }
  };
  const profile = v.profile;
  const pointOptions = (profile?.interfaces ?? []).flatMap((i) =>
    i.groups.flatMap((g) => g.dataPoints.map((d) => ({ value: d.id, label: `${d.name} (${d.id})` }))),
  );
  const pointName = (id: string) => pointOptions.find((p) => p.value === id)?.label ?? id;
  const pointLink = (id: string) =>
    profile && pointOptions.some((p) => p.value === id) ? (
      <Anchor component={Link} to={`/plant/profiles/${encodeURIComponent(profile.id)}/points/${encodeURIComponent(id)}`} size="sm">
        {pointName(id)}
      </Anchor>
    ) : (
      <Text size="sm" className="mono">
        {id}
      </Text>
    );
  const add = (text: string, d: Dialog, testId?: string) =>
    canManage && (
      <Button size="compact-xs" variant="default" leftSection={<IconPlus size={12} />} onClick={() => setDialog(d)} data-testid={testId}>
        {text}
      </Button>
    );
  const kpiAt = (k: PlantKpiInstance) => v.kpis.find((x) => x.job === k.job);
  const problemsOf = (job: string) => v.checks.filter((c) => c.job === job).length;
  return (
    <Stack gap="sm" data-testid="asset-data">
      <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap="xs">
            <Title order={2} fz="h4">
              {t('assignment.title')}
            </Title>
            {v.notInSource && <NotInSourceBadge size="xs" />}
          </Group>
          <Text size="xs" c="dimmed">
            {t('assignment.help')}
          </Text>
        </div>
        {canManage && v.assignment && (
          <Group gap={4} wrap="nowrap">
            <Button size="xs" variant="default" onClick={() => setDialog({ kind: 'assignment' })}>
              {t('assignment.editButton')}
            </Button>
            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <Button size="xs" variant="subtle" color="red" px={6} aria-label={t('assignment.removeAll')}>
                  <IconTrash size={14} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={() => void removeAll()}>
                  {t('assignment.removeAll')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        )}
      </Group>
      {!v.assignment ? (
        <EmptyState
          compact
          icon={IconCpu}
          title={t('assignment.emptyTitle')}
          whoCanAct={canManage ? undefined : t('assignment.whoCanAct')}
          action={
            canManage && (
              <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setDialog({ kind: 'assignment' })}>
                {t('assignment.assign')}
              </Button>
            )
          }
        >
          {t('assignment.emptyText', { type: label('asset', false, true) })}
        </EmptyState>
      ) : (
        <Paper withBorder p="md">
          <Stack gap="md">
            <Group gap="xl" wrap="wrap">
              <Field label={t('assignment.profile')}>
                {profile ? (
                  <Anchor component={Link} to={`/plant/profiles/${encodeURIComponent(profile.id)}`} size="sm" fw={500}>
                    {profile.name}
                  </Anchor>
                ) : a.profileId ? (
                  <Text size="sm" c="orange.8" className="mono">
                    {a.profileId}
                  </Text>
                ) : (
                  '–'
                )}
              </Field>
              <Field label={t('assignment.firmware')}>{a.firmware ? <span className="mono">{a.firmware}</span> : '–'}</Field>
            </Group>
            {a.notes && (
              <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                {a.notes}
              </Text>
            )}
            {v.checks.length > 0 && (
              <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} title={t('checks.problems', { count: v.checks.length })}>
                <ChecksList checks={v.checks} testId="asset-checks" />
              </Alert>
            )}
            {profile && (
              <Part title={t('assignment.interfaces')} help={t('assignment.interfacesHelp')} testId="assignment-interfaces">
                <Stack gap={6}>
                  {profile.interfaces.map((iface) => {
                    const set = a.interfaces.find((x) => x.interface === iface.id);
                    return (
                      <Group key={iface.id} justify="space-between" wrap="nowrap" align="flex-start" gap="xs" data-testid={`assigned-${iface.id}`}>
                        <Stack gap={2} style={{ minWidth: 0 }}>
                          <Group gap={6} wrap="wrap">
                            <Text size="sm" fw={500}>
                              {iface.name || iface.id}
                            </Text>
                            <ProtocolBadge protocol={iface.protocol} size="xs" />
                            {set?.active ? (
                              <Badge size="xs" color="green" variant="light">
                                {t('assignment.activeBadge')}
                              </Badge>
                            ) : (
                              <Badge size="xs" color="gray" variant="outline">
                                {set ? t('assignment.inactive') : t('assignment.notSetUp')}
                              </Badge>
                            )}
                          </Group>
                          {set?.endpoint && (
                            <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                              {set.endpoint}
                            </Text>
                          )}
                          {set?.notes && (
                            <Text size="xs" c="dimmed">
                              {set.notes}
                            </Text>
                          )}
                        </Stack>
                        {canManage && (
                          <Button size="compact-xs" variant="subtle" style={{ flex: 'none' }} onClick={() => setDialog({ kind: 'interface', iface })}>
                            {t('assignment.setUp')}
                          </Button>
                        )}
                      </Group>
                    );
                  })}
                </Stack>
              </Part>
            )}
            {profile && (
              <Part
                title={t('assignment.overrides')}
                help={t('assignment.overridesHelp')}
                action={add(t('assignment.addOverride'), { kind: 'override', index: null })}
                testId="assignment-overrides"
              >
                {a.overrides.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('assignment.noOverrides')}
                  </Text>
                ) : (
                  <Stack gap={4}>
                    {a.overrides.map((o: PlantPointOverride, i) => (
                      <Group key={o.dataPoint} justify="space-between" wrap="nowrap" gap="xs">
                        <Stack gap={0} style={{ minWidth: 0 }}>
                          <Group gap={6} wrap="wrap">
                            {pointLink(o.dataPoint)}
                            {!o.available && (
                              <Badge size="xs" color="orange" variant="light">
                                {t('assignment.notDelivered')}
                              </Badge>
                            )}
                          </Group>
                          <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                            {[
                              o.address && t('assignment.addressIs', { address: o.address }),
                              o.dataType && o.dataType,
                              o.unit && <UnitText key="u" unit={o.unit} />,
                              o.updateRateMs !== null && `${o.updateRateMs} ms`,
                              o.notes,
                            ]
                              .filter(Boolean)
                              .map((x, j) => (
                                <span key={j}>
                                  {j > 0 && ' · '}
                                  {x}
                                </span>
                              ))}
                          </Text>
                        </Stack>
                        {canManage && (
                          <RowMenu
                            label={t('assignment.overrideActions', { name: o.dataPoint })}
                            onEdit={() => setDialog({ kind: 'override', index: i })}
                            onRemove={() => void removeAt('overrides', i, o.dataPoint)}
                          />
                        )}
                      </Group>
                    ))}
                  </Stack>
                )}
              </Part>
            )}
            {profile && (
              <Part
                title={t('assignment.publications')}
                help={t('assignment.publicationsHelp')}
                action={add(t('assignment.addPublication'), { kind: 'publication', index: null })}
                testId="assignment-publications"
              >
                {a.publications.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('assignment.noPublications')}
                  </Text>
                ) : narrow ? (
                  <Stack gap={6}>
                    {a.publications.map((p: PlantPublication, i) => (
                      <Group key={i} justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                        <Stack gap={0} style={{ minWidth: 0 }}>
                          {pointLink(p.dataPoint)}
                          <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                            {[p.target, [p.path, p.name].filter(Boolean).join(' / ')].filter(Boolean).join(': ')}
                          </Text>
                          {p.publishedBy && (
                            <Text size="xs" c="dimmed">
                              {t('assignment.publishedByIs', { by: p.publishedBy })}
                            </Text>
                          )}
                        </Stack>
                        {canManage && (
                          <RowMenu
                            label={t('assignment.publicationActions', { name: p.dataPoint })}
                            onEdit={() => setDialog({ kind: 'publication', index: i })}
                            onRemove={() => void removeAt('publications', i, p.dataPoint)}
                          />
                        )}
                      </Group>
                    ))}
                  </Stack>
                ) : (
                  <div className="table-scroll" tabIndex={0} role="region" aria-label={t('assignment.publications')}>
                    <Table fz="sm" aria-label={t('assignment.publications')} layout="fixed" miw={560}>
                      <colgroup>
                        <col style={{ width: '24%' }} />
                        <col style={{ width: '16%' }} />
                        <col style={{ width: '24%' }} />
                        <col style={{ width: '17%' }} />
                        <col />
                        {canManage && <col style={{ width: 40 }} />}
                      </colgroup>
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>{t('data.point')}</Table.Th>
                          <Table.Th>{t('data.target')}</Table.Th>
                          <Table.Th>{t('data.path')}</Table.Th>
                          <Table.Th>{t('data.pubName')}</Table.Th>
                          <Table.Th>{t('assignment.publishedBy')}</Table.Th>
                          {canManage && <Table.Th aria-label={t('actions')} />}
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {a.publications.map((p, i) => (
                          <Table.Tr key={i}>
                            <Table.Td>{pointLink(p.dataPoint)}</Table.Td>
                            <Table.Td style={{ overflowWrap: 'break-word' }}>{p.target || '–'}</Table.Td>
                            <Table.Td className="mono" style={{ overflowWrap: 'break-word' }}>
                              {p.path ? <Breakable text={p.path} /> : '–'}
                            </Table.Td>
                            <Table.Td className="mono" style={{ overflowWrap: 'break-word' }}>
                              {p.name || '–'}
                            </Table.Td>
                            <Table.Td>{p.publishedBy || '–'}</Table.Td>
                            {canManage && (
                              <Table.Td>
                                <RowMenu
                                  label={t('assignment.publicationActions', { name: p.dataPoint })}
                                  onEdit={() => setDialog({ kind: 'publication', index: i })}
                                  onRemove={() => void removeAt('publications', i, p.dataPoint)}
                                />
                              </Table.Td>
                            )}
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </div>
                )}
              </Part>
            )}
            <Part
              title={t('assignment.kpis')}
              help={t('assignment.kpisHelp')}
              action={add(t('assignment.addKpi'), { kind: 'kpi', index: null }, 'add-kpi-instance')}
              testId="assignment-kpis"
            >
              {a.kpis.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('assignment.noKpis')}
                </Text>
              ) : (
                <Stack gap="xs">
                  {a.kpis.map((k, i) => {
                    const shown = kpiAt(k);
                    const problems = problemsOf(k.job);
                    return (
                      <Paper key={k.job} withBorder p="sm" data-testid={`kpi-instance-${k.job}`}>
                        <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                          <Stack gap={4} style={{ minWidth: 0 }}>
                            <Group gap={6} wrap="wrap">
                              {shown?.definition ? (
                                <Anchor component={Link} to={`/plant/kpis/${encodeURIComponent(k.kpi)}`} size="sm" fw={500}>
                                  {nameOf(shown.definition)}
                                </Anchor>
                              ) : (
                                <Text size="sm" c="orange.8" className="mono">
                                  {k.kpi}
                                </Text>
                              )}
                              {!k.active && (
                                <Badge size="xs" variant="default">
                                  {t('assignment.inactive')}
                                </Badge>
                              )}
                              {problems > 0 && (
                                <Badge size="xs" color="orange" variant="light">
                                  {t('checks.problems', { count: problems })}
                                </Badge>
                              )}
                            </Group>
                            <Text size="xs" c="dimmed">
                              {t('assignment.job')} <span className="mono">{k.job}</span>
                            </Text>
                            <ParamsView params={k.params} />
                            {shown && shown.results.length > 0 && (
                              <Group gap={6} wrap="wrap">
                                {shown.results.map((r) =>
                                  r.path ? (
                                    <Anchor key={`${r.kind}:${r.id}`} component={Link} to={r.path} size="xs">
                                      {t(`assignment.results.${r.kind}`, { name: r.label })}
                                    </Anchor>
                                  ) : (
                                    <Text key={`${r.kind}:${r.id}`} size="xs" c="dimmed">
                                      {t(`assignment.results.${r.kind}`, {
                                        name: r.visible ? r.label : r.kind === 'dataset' ? r.id : t('assignment.notVisible'),
                                      })}
                                    </Text>
                                  ),
                                )}
                              </Group>
                            )}
                          </Stack>
                          {canManage && (
                            <RowMenu
                              label={t('assignment.kpiActions', { job: k.job })}
                              onEdit={() => setDialog({ kind: 'kpi', index: i })}
                              onRemove={() => void removeAt('kpis', i, k.job)}
                            />
                          )}
                        </Group>
                      </Paper>
                    );
                  })}
                </Stack>
              )}
            </Part>
            <Part title={t('assignment.possible')} help={t('assignment.possibleHelp')} testId="assignment-possible">
              {v.possibleKpis.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {profile ? t('explore.nonePossible') : t('explore.nonePossibleNoProfile')}
                </Text>
              ) : (
                <Group gap={6} wrap="wrap">
                  {v.possibleKpis.map((k) => (
                    <Group key={k.id} gap={4} wrap="nowrap">
                      <Anchor component={Link} to={`/plant/kpis/${encodeURIComponent(k.id)}`} size="sm">
                        {nameOf(k)}
                      </Anchor>
                      {k.instantiated ? (
                        <Badge size="xs" variant="light" color="green">
                          {t('explore.instantiated')}
                        </Badge>
                      ) : (
                        canManage && (
                          <Button size="compact-xs" variant="subtle" onClick={() => setDialog({ kind: 'kpi', index: null, kpi: k.id })}>
                            {t('assignment.addThis')}
                          </Button>
                        )
                      )}
                    </Group>
                  ))}
                </Group>
              )}
            </Part>
            {v.updatedAt && (
              <Text size="xs" c="dimmed">
                {t('changedBy', { user: v.updatedBy, date: fmtDate(v.updatedAt) })}
              </Text>
            )}
          </Stack>
        </Paper>
      )}
      {dialog?.kind === 'assignment' && (
        <AssignmentFormModal
          profileId={a.profileId}
          firmware={a.firmware}
          notes={a.notes}
          profiles={profiles.data ?? []}
          onClose={() => setDialog(null)}
          onSave={async (x) => {
            // another profile has other interfaces and data points: what named the old one goes
            const same = x.profileId === a.profileId;
            await save({ ...a, ...x, ...(same ? {} : { interfaces: [], overrides: [], publications: [] }) });
          }}
        />
      )}
      {dialog?.kind === 'interface' && (
        <AssignmentInterfaceModal
          iface={dialog.iface}
          value={a.interfaces.find((x) => x.interface === dialog.iface.id)}
          onClose={() => setDialog(null)}
          onSave={(x) => {
            const has = a.interfaces.some((y) => y.interface === x.interface);
            return save({ ...a, interfaces: has ? a.interfaces.map((y) => (y.interface === x.interface ? x : y)) : [...a.interfaces, x] });
          }}
        />
      )}
      {dialog?.kind === 'override' && (
        <OverrideModal
          value={dialog.index === null ? undefined : a.overrides[dialog.index]}
          points={pointOptions.filter((p) => dialog.index !== null || !a.overrides.some((o) => o.dataPoint === p.value))}
          onClose={() => setDialog(null)}
          onSave={(x) => save({ ...a, overrides: putAt(a.overrides, dialog.index, x) })}
        />
      )}
      {dialog?.kind === 'publication' && (
        <PublicationModal
          value={dialog.index === null ? undefined : a.publications[dialog.index]}
          points={pointOptions}
          onClose={() => setDialog(null)}
          onSave={(x) => save({ ...a, publications: putAt(a.publications, dialog.index, x) })}
        />
      )}
      {dialog?.kind === 'kpi' && (
        <KpiInstanceModal
          value={dialog.index === null ? undefined : a.kpis[dialog.index]}
          kpis={kpis.data ?? []}
          defaultKpi={dialog.kpi}
          jobs={a.kpis.filter((_, i) => i !== dialog.index).map((k) => k.job)}
          onClose={() => setDialog(null)}
          onSave={(x) => save({ ...a, kpis: putAt(a.kpis, dialog.index, x) })}
        />
      )}
    </Stack>
  );
}

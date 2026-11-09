import { useEffect, useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, List, Modal, Paper, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconArrowBackUp, IconDownload, IconEdit, IconEyeOff, IconFile, IconHierarchy2, IconPlus, IconTrash } from '@tabler/icons-react';
import { Menu } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import {
  PLANT_DATA_LIMITS,
  plantOriginKey,
  type PlantDataPoint,
  type PlantInterface,
  type PlantModelOrigin,
  type PlantProfileDetail,
  type PlantProfileSummary,
  type PlantProfileValues,
} from '@sm/shared';
import { apiUrl, del, get, notifyError, put } from '../api';
import { DetailState, EmptyState } from '../components/common';
import { useAliasRedirect, useChangeId } from '../components/plant/ids';
import { DetailHeader } from '../components/page/DetailPage';
import { Field } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { CopiedFromNote, DuplicateButton } from '../components/duplicate/DuplicateButton';
import { fmtDate } from '../format';
import { plantKeys } from '../queryKeys';
import { NotInSourceBadge, PreviewBadge, useNameOf, usePlantLabel } from '../components/plant/common';
import { TemplateBadge } from '../components/plant/potential';
import { ExtractBaseModal } from '../components/plant/ExtractBaseModal';
import { FormButtons } from '../components/plant/forms';
import { AssetBriefLink, DataPointTable, ProtocolBadge, RowMenu } from '../components/plant/data';
import {
  baseInterface,
  describeFileSet,
  describeGroup,
  describeInterface,
  ordered,
  removePoint as removeOwnPoint,
  resetPointDescription,
  resetInterface,
  resetPoint,
  saveGroup,
  saveInterface,
  savePoint,
  setInterfacePresent,
  setPointPresent,
} from '../components/plant/profileEdit';
import { DataPointFormModal, InterfaceFormModal, ProfileFormModal } from '../components/plant/dataForms';
import { PlantDocumentsPanel } from '../components/plant/DocumentsPanel';
import { SourceLine } from './PlantSite';
import { CollapsibleSection, SectionGroup, SectionGroupControls } from '../components/page/CollapsibleSection';
import { DescribedText, DescriptionModal } from '../components/plant/describe';

/** Where an interface or data point of a derived profile comes from (0.11.0); nothing on a profile without a base. */
function OriginBadge({ origin, derived, nameOf }: { origin: PlantModelOrigin | undefined; derived: boolean; nameOf: (id: string) => string }) {
  const { t } = useTranslation('plantModel');
  if (!derived || !origin) return null;
  if (origin.kind === 'own')
    return (
      <Badge size="xs" variant="light" color="green" tt="none" data-testid="origin-own">
        {t('origin.own')}
      </Badge>
    );
  if (origin.kind === 'overridden')
    return (
      <Badge size="xs" variant="light" color="blue" tt="none" data-testid="origin-overridden">
        {t('origin.overridden', { fields: origin.fields.join(', '), from: nameOf(origin.from) })}
      </Badge>
    );
  return (
    <Badge size="xs" variant="default" tt="none" data-testid="origin-inherited">
      {t('origin.inherited', { from: nameOf(origin.from) })}
    </Badge>
  );
}

type Dialog =
  | { kind: 'profile' }
  | { kind: 'interface'; iface?: PlantInterface }
  | { kind: 'point'; iface: PlantInterface; group: string; point?: PlantDataPoint }
  | { kind: 'group'; iface: PlantInterface; group: string; description: string }
  /** 0.12.0: a description written here – the profile's, or one of an inherited item */
  | { kind: 'describe'; title: string; value: string; help?: string; apply: (text: string) => PlantProfileValues };

/**
 * A device profile (#219): its interfaces with their data point groups and data points, the files a file-transfer
 * interface exchanges, the assets that have the profile and the KPI definitions that read it.
 */
export function PlantProfilePage() {
  const { t } = useTranslation(['plant', 'common', 'plantModel']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const { profileId } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const q = useQuery({ queryKey: plantKeys.profile(profileId), queryFn: () => get<PlantProfileDetail>(`/plant/profiles/${encodeURIComponent(profileId!)}`) });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [extracting, setExtracting] = useState(false);
  const p = q.data;
  const profiles = useQuery({ queryKey: plantKeys.profiles, queryFn: () => get<PlantProfileSummary[]>('/plant/profiles'), enabled: !!p?.canManage });
  // ?edit=1 (after Duplicate): open the form once the profile is loaded
  useEffect(() => {
    if (p?.canManage && search.get('edit') === '1') {
      setDialog({ kind: 'profile' });
      setSearch({}, { replace: true });
    }
  }, [p?.canManage, search, setSearch]);
  useAliasRedirect([[profileId, p?.id]]);
  const changeId = useChangeId(p ? { kind: 'profile', id: p.id, name: p.name } : null, !!p?.canManage);
  if (!p) return <DetailState query={q} back="plantProfiles" />;
  const base = `/plant/profiles/${encodeURIComponent(p.id)}`;
  const save = async (next: PlantProfileValues) => {
    const { id: _id, ...body } = next;
    const saved = await put<PlantProfileDetail>(base, { ...body, revision: p.revision });
    qc.setQueryData(plantKeys.profile(profileId), saved);
    void qc.invalidateQueries({ queryKey: plantKeys.profiles });
    void qc.invalidateQueries({ queryKey: ['plant', 'point', p.id] });
  };
  const values = p.own;
  const derived = !!p.extends;
  const nameOf2 = (id: string) => (id === p.id ? p.name : (p.bases.find((b) => b.id === id)?.name ?? id));
  const inheritedIface = (id: string) => p.origins.interfaces[id]?.kind !== undefined && p.origins.interfaces[id]?.kind !== 'own';
  const inheritedPoint = (id: string) => p.origins.points[id]?.kind !== undefined && p.origins.points[id]?.kind !== 'own';
  const inheritedGroup = (iface: string, group: string) =>
    inheritedIface(iface) && !!p.base?.interfaces.find((x) => x.id === iface)?.groups.some((x) => x.name === group);
  const inheritedFileSet = (iface: string, id: string) =>
    inheritedIface(iface) && !!p.base?.interfaces.find((x) => x.id === iface)?.fileSets.some((x) => x.id === id);
  const act = (next: PlantProfileValues) => void save(next).catch(notifyError);
  /** Where an item's description comes from (0.12.0): inherited from a base (its name) or changed here */
  const described = (origin: PlantModelOrigin | undefined) => ({
    inheritedFrom: derived && origin && origin.descriptionFrom !== p.id ? nameOf2(origin.descriptionFrom) : null,
    changedHere: derived && !!origin && origin.kind !== 'own' && origin.descriptionFrom === p.id,
  });
  const allPoints = p.interfaces.flatMap((i) => i.groups.flatMap((g) => g.dataPoints.map((d) => d.id)));
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('profile.deleteConfirm', { name: p.name }) }))) return;
    try {
      await del(base);
      void qc.invalidateQueries({ queryKey: plantKeys.all });
      navigate('/plant/profiles');
    } catch (e) {
      notifyError(e);
    }
  };
  const removeInterface = async (iface: PlantInterface) => {
    const n = iface.groups.reduce((s, g) => s + g.dataPoints.length, 0);
    if (!(await confirmDanger({ action: 'remove', message: t('data.removeInterfaceConfirm', { name: iface.name || iface.id, count: n }) }))) return;
    await save({ ...values, interfaces: values.interfaces.filter((i) => i.id !== iface.id) }).catch(notifyError);
  };
  const removePoint = async (iface: PlantInterface, point: PlantDataPoint) => {
    if (!(await confirmDanger({ action: 'remove', message: t('data.removePointConfirm', { name: point.name }) }))) return;
    await save(removeOwnPoint(p, iface.id, point.id)).catch(notifyError);
  };
  /** The menu of an inherited item: change it (an override), back to the base's values, not present. */
  const inheritedMenu = (
    label: string,
    onEdit: () => void,
    origin: PlantModelOrigin | undefined,
    reset: () => PlantProfileValues,
    drop: () => PlantProfileValues,
    resetDescription?: () => PlantProfileValues,
  ) => (
    <RowMenu
      label={label}
      onEdit={onEdit}
      extra={
        <>
          {origin?.kind === 'overridden' && (
            <Menu.Item leftSection={<IconArrowBackUp size={14} />} onClick={() => act(reset())}>
              {t('plantModel:actions.reset')}
            </Menu.Item>
          )}
          {resetDescription && origin?.fields.includes('description') && (
            <Menu.Item leftSection={<IconArrowBackUp size={14} />} onClick={() => act(resetDescription())}>
              {t('plantModel:describe.reset')}
            </Menu.Item>
          )}
          <Menu.Item leftSection={<IconEyeOff size={14} />} onClick={() => act(drop())}>
            {t('plantModel:actions.notPresent')}
          </Menu.Item>
        </>
      }
    />
  );
  return (
    <>
      <DetailHeader
        recent={{ label: p.name, kind: 'profile' }}
        back="plantProfiles"
        title={p.name}
        status={
          <>
            {p.category && <Badge variant="default">{p.category}</Badge>}
            {p.template && <TemplateBadge size="sm" />}
            {p.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
          </>
        }
        description={[p.manufacturer, p.model, p.version && t('profile.versionIs', { version: p.version })].filter(Boolean).join(' · ') || undefined}
        actions={
          <>
            {p.canManage && (
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setDialog({ kind: 'profile' })}>
                {t('common:edit')}
              </Button>
            )}
            {p.canManage && <DuplicateButton kind="device-profile" id={p.id} />}
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`/plant/export?profile=${encodeURIComponent(p.id)}`)}
              download
              leftSection={<IconDownload size={14} />}
            >
              {t('export.one')}
            </Button>
          </>
        }
        menu={
          p.canManage
            ? {
                items: [
                  ...(changeId.item ? [changeId.item] : []),
                  // 0.12.0: a base from the data points this profile shares with others (only a profile without a base)
                  ...(!p.extends
                    ? [
                        {
                          label: t('plantModel:extract.buttonProfile'),
                          icon: IconHierarchy2,
                          onClick: () => setExtracting(true),
                          testId: 'profile-extract-base',
                        },
                      ]
                    : []),
                  { label: t('profile.delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'profile-delete' },
                ],
              }
            : undefined
        }
      />
      {changeId.modal}
      {extracting && profiles.data && <ExtractBaseModal profiles={profiles.data} preselect={[p.id]} onClose={() => setExtracting(false)} />}
      <CopiedFromNote kind="device-profile" id={p.id} pathOf={(id) => `/plant/profiles/${encodeURIComponent(id)}`} />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {derived ? (
              <DescribedText
                text={p.description}
                inheritedFrom={p.descriptionFrom !== p.id ? nameOf2(p.descriptionFrom) : null}
                changedHere={!!values.description && p.descriptionFrom === p.id}
                editable={p.canManage}
                onEdit={() =>
                  setDialog({
                    kind: 'describe',
                    title: t('plantModel:describe.profileTitle', { name: p.name }),
                    value: values.description,
                    help: t('plantModel:describe.inheritedHelp', { from: nameOf2(p.bases[0]?.id ?? '') }),
                    apply: (text) => ({ ...values, description: text }),
                  })
                }
                onReset={() => act({ ...values, description: '' })}
                testId="profile-description"
              />
            ) : (
              p.description && (
                <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                  {p.description}
                </Text>
              )
            )}
            {derived && (
              <Paper withBorder p="sm" data-testid="profile-bases">
                <Stack gap={6}>
                  <Group gap={6} wrap="wrap">
                    <Text size="sm" fw={600}>
                      {t('plantModel:extends.chain')}
                    </Text>
                    {p.bases.map((b, i) => (
                      <Group key={b.id} gap={6} wrap="nowrap">
                        {i > 0 && (
                          <Text size="sm" c="dimmed" aria-hidden>
                            →
                          </Text>
                        )}
                        {b.exists ? (
                          <Anchor component={Link} to={`/plant/profiles/${encodeURIComponent(b.id)}`} size="sm">
                            {b.name}
                          </Anchor>
                        ) : (
                          <Text size="sm" className="mono">
                            {b.id}
                          </Text>
                        )}
                      </Group>
                    ))}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {t('plantModel:extends.chainHelp')}
                  </Text>
                  {(p.notPresent.interfaces.length > 0 || p.notPresent.points.length > 0) && (
                    <Stack gap={4} data-testid="profile-not-present">
                      <Text size="sm" fw={500}>
                        {t('plantModel:notPresent.title')}
                      </Text>
                      {[
                        ...p.notPresent.interfaces.map((x) => ({
                          key: `i:${x.id}`,
                          label: t('plantModel:notPresent.interface', { name: x.name }),
                          x,
                          kind: 'interface' as const,
                        })),
                        ...p.notPresent.points.map((x) => ({
                          key: `p:${x.id}`,
                          label: t('plantModel:notPresent.point', { name: x.name, id: x.id }),
                          x,
                          kind: 'point' as const,
                        })),
                      ].map((r) => (
                        <Group key={r.key} gap="xs" wrap="nowrap" justify="space-between">
                          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                            {r.label}
                            {r.x.by !== p.id && (
                              <Text span size="xs" c="dimmed">
                                {' '}
                                {t('plantModel:notPresent.by', { name: nameOf2(r.x.by) })}
                              </Text>
                            )}
                          </Text>
                          {p.canManage && r.x.by === p.id && (
                            <Button
                              size="compact-xs"
                              variant="subtle"
                              onClick={() => act(r.kind === 'interface' ? setInterfacePresent(p, r.x.id, true) : setPointPresent(p, r.x.id, true))}
                            >
                              {t('plantModel:actions.restore')}
                            </Button>
                          )}
                        </Group>
                      ))}
                    </Stack>
                  )}
                  {(p.unusedOverrides.interfaces.length > 0 || p.unusedOverrides.points.length > 0) && (
                    <Text size="xs" data-testid="profile-unused-overrides">
                      {t('plantModel:unused', { items: [...p.unusedOverrides.interfaces, ...p.unusedOverrides.points].join(', ') })}
                    </Text>
                  )}
                </Stack>
              </Paper>
            )}
            <SectionGroup controls="none">
              <Stack gap="sm" data-testid="profile-interfaces">
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <div>
                    <Title order={2} fz="h4">
                      {t('profile.interfaces')}
                    </Title>
                    <Text size="xs" c="dimmed">
                      {t('profile.interfacesHelp')}
                    </Text>
                  </div>
                  <SectionGroupControls min={4} />
                  {p.canManage && (
                    <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setDialog({ kind: 'interface' })}>
                      {t('data.addInterface')}
                    </Button>
                  )}
                </Group>
                {p.interfaces.length === 0 && (
                  <EmptyState compact title={t('data.noInterfacesTitle')} whoCanAct={p.canManage ? undefined : t('profiles.whoCanAct')}>
                    {t('data.noInterfacesText')}
                  </EmptyState>
                )}
                {p.interfaces.map((iface) => (
                  // each interface folds (this page view); open while there are at most three, a link to #iface-<id> opens it
                  <CollapsibleSection
                    key={iface.id}
                    id={`iface-${iface.id}`}
                    testId={`interface-${iface.id}`}
                    variant="card"
                    order={3}
                    title={iface.name || iface.id}
                    defaultOpen={p.interfaces.length <= 3}
                    summary={
                      <>
                        <ProtocolBadge protocol={iface.protocol} />
                        <OriginBadge origin={p.origins.interfaces[iface.id]} derived={derived} nameOf={nameOf2} />
                        <Text size="xs" c="dimmed" data-testid="interface-counts">
                          {[
                            t('data.pointCount', { count: iface.groups.reduce((n, g) => n + g.dataPoints.length, 0) }),
                            t('data.groupCount', { count: iface.groups.filter((g) => g.name).length }),
                            iface.fileSets.length > 0 && t('data.fileSetCount', { count: iface.fileSets.length }),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </>
                    }
                    actions={
                      p.canManage && (
                        <>
                          <Button
                            size="compact-xs"
                            variant="default"
                            leftSection={<IconPlus size={12} />}
                            onClick={() => setDialog({ kind: 'point', iface, group: iface.groups.find((g) => g.name)?.name ?? '' })}
                          >
                            {t('data.addPoint')}
                          </Button>
                          {inheritedIface(iface.id) ? (
                            inheritedMenu(
                              t('data.interfaceActions', { name: iface.name || iface.id }),
                              () => setDialog({ kind: 'interface', iface }),
                              p.origins.interfaces[iface.id],
                              () => resetInterface(p, iface.id),
                              () => setInterfacePresent(p, iface.id, false),
                              () => describeInterface(p, iface.id, null),
                            )
                          ) : (
                            <RowMenu
                              label={t('data.interfaceActions', { name: iface.name || iface.id })}
                              onEdit={() => setDialog({ kind: 'interface', iface })}
                              onRemove={() => void removeInterface(iface)}
                            />
                          )}
                        </>
                      )
                    }
                  >
                    <Stack gap="sm">
                      <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                        {[
                          t(`data.directions.${iface.direction}`),
                          iface.defaultPort !== null && t('data.portIs', { port: iface.defaultPort }),
                          t(`data.auth.${iface.authentication}`),
                          iface.client && t('data.clientIs', { client: iface.client }),
                          iface.version && t('data.versionIs', { version: iface.version }),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      <DescribedText
                        text={iface.description}
                        {...described(p.origins.interfaces[iface.id])}
                        editable={p.canManage && inheritedIface(iface.id)}
                        onEdit={() =>
                          setDialog({
                            kind: 'describe',
                            title: t('plantModel:describe.itemTitle', { name: iface.name || iface.id }),
                            value: iface.description,
                            apply: (text) => describeInterface(p, iface.id, text),
                          })
                        }
                        onReset={() => act(describeInterface(p, iface.id, null))}
                        testId={`interface-description-${iface.id}`}
                      />
                      {iface.notes && (
                        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
                          {iface.notes}
                        </Text>
                      )}
                      {ordered(iface.groups).map((g) => (
                        <Stack key={g.name || '(none)'} gap={6}>
                          <Group justify="space-between" gap="xs" wrap="nowrap">
                            <div>
                              <Text size="sm" fw={600}>
                                {g.name || t('data.ungrouped')}
                              </Text>
                              <DescribedText
                                size="xs"
                                text={g.description}
                                {...described(p.origins.groups[plantOriginKey(iface.id, g.name)])}
                                editable={p.canManage && inheritedGroup(iface.id, g.name)}
                                onEdit={() =>
                                  setDialog({
                                    kind: 'describe',
                                    title: t('plantModel:describe.itemTitle', { name: g.name }),
                                    value: g.description,
                                    apply: (text) => describeGroup(p, iface.id, g.name, text),
                                  })
                                }
                                onReset={() => act(describeGroup(p, iface.id, g.name, ''))}
                                testId={`group-description-${iface.id}-${g.name}`}
                              />
                            </div>
                            {p.canManage && g.name && !inheritedGroup(iface.id, g.name) && (
                              <RowMenu
                                label={t('data.groupActions', { name: g.name })}
                                onEdit={() => setDialog({ kind: 'group', iface, group: g.name, description: g.description })}
                              />
                            )}
                          </Group>
                          <DataPointTable
                            profileId={p.id}
                            protocol={iface.protocol}
                            points={g.dataPoints}
                            label={t('data.pointsOf', { group: g.name || t('data.ungrouped'), iface: iface.name || iface.id })}
                            canManage={p.canManage}
                            onEdit={(point) => setDialog({ kind: 'point', iface, group: g.name, point })}
                            onRemove={(point) => void removePoint(iface, point)}
                            badge={(point) => <OriginBadge origin={p.origins.points[point.id]} derived={derived} nameOf={nameOf2} />}
                            menuFor={(point) =>
                              inheritedPoint(point.id) ? (
                                inheritedMenu(
                                  t('data.pointActions', { name: point.name }),
                                  () => setDialog({ kind: 'point', iface, group: g.name, point }),
                                  p.origins.points[point.id],
                                  () => resetPoint(p, point.id),
                                  () => setPointPresent(p, point.id, false),
                                  () => resetPointDescription(p, point.id),
                                )
                              ) : (
                                <RowMenu
                                  label={t('data.pointActions', { name: point.name })}
                                  onEdit={() => setDialog({ kind: 'point', iface, group: g.name, point })}
                                  onRemove={() => void removePoint(iface, point)}
                                />
                              )
                            }
                          />
                        </Stack>
                      ))}
                      {iface.groups.every((g) => !g.dataPoints.length) && !iface.fileSets.length && (
                        <Text size="sm" c="dimmed">
                          {t('data.noPoints')}
                        </Text>
                      )}
                      {iface.fileSets.length > 0 && (
                        <Stack gap={4} data-testid="file-sets">
                          <Text size="sm" fw={600}>
                            {t('data.fileSets')}
                          </Text>
                          {iface.fileSets.map((f) => (
                            <Group key={f.id} gap="xs" wrap="nowrap" align="flex-start">
                              <IconFile size={16} aria-hidden style={{ marginTop: 2, flex: 'none' }} />
                              <Stack gap={0} style={{ minWidth: 0 }}>
                                <Text size="sm" fw={500}>
                                  {f.name || f.id}
                                </Text>
                                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                                  {[
                                    f.pathPattern && t('data.pathPatternIs', { pattern: f.pathPattern }),
                                    f.format && t('data.formatIs', { format: f.format }),
                                    f.producedPer && t('data.producedPerIs', { per: f.producedPer }),
                                    t(`data.directions.${f.direction}`),
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </Text>
                                <DescribedText
                                  size="xs"
                                  text={f.description}
                                  {...described(p.origins.fileSets[plantOriginKey(iface.id, f.id)])}
                                  editable={p.canManage && inheritedFileSet(iface.id, f.id)}
                                  onEdit={() =>
                                    setDialog({
                                      kind: 'describe',
                                      title: t('plantModel:describe.itemTitle', { name: f.name || f.id }),
                                      value: f.description,
                                      apply: (text) => describeFileSet(p, iface.id, f.id, text),
                                    })
                                  }
                                  onReset={() => act(describeFileSet(p, iface.id, f.id, ''))}
                                  testId={`file-set-description-${iface.id}-${f.id}`}
                                />
                                {f.notes && (
                                  <Text size="xs" style={{ whiteSpace: 'pre-line' }}>
                                    {f.notes}
                                  </Text>
                                )}
                              </Stack>
                            </Group>
                          ))}
                        </Stack>
                      )}
                    </Stack>
                  </CollapsibleSection>
                ))}
              </Stack>
            </SectionGroup>
            <PlantDocumentsPanel kind="device-profile" id={p.id} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="md">
            <Paper withBorder p="md" data-testid="profile-assets">
              <Stack gap="xs">
                <Title order={2} fz="h5">
                  {t('profile.usedBy', { type: label('asset', true) })}
                </Title>
                {p.assets.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('profile.noAssets', { type: label('asset', true, true) })}
                  </Text>
                ) : (
                  <Stack gap={4}>
                    {p.assets.map((a) => (
                      <AssetBriefLink key={a.id} asset={a} />
                    ))}
                  </Stack>
                )}
              </Stack>
            </Paper>
            {(p.extendedBy.length > 0 || derived) && (
              <Paper withBorder p="md" data-testid="profile-extended-by">
                <Stack gap="xs">
                  <Title order={2} fz="h5">
                    {t('plantModel:extends.extendedBy')}
                  </Title>
                  {p.extendedBy.length === 0 ? (
                    <Text size="sm" c="dimmed">
                      {t('plantModel:extends.noneExtends')}
                    </Text>
                  ) : (
                    <List size="sm" spacing={2}>
                      {p.extendedBy.map((x) => (
                        <List.Item key={x.id}>
                          <Anchor component={Link} to={`/plant/profiles/${encodeURIComponent(x.id)}`} size="sm">
                            {x.name}
                          </Anchor>
                        </List.Item>
                      ))}
                    </List>
                  )}
                </Stack>
              </Paper>
            )}
            <Paper withBorder p="md" data-testid="profile-kpis">
              <Stack gap="xs">
                <Title order={2} fz="h5">
                  {t('profile.kpis')}
                </Title>
                {p.kpis.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('profile.noKpis')}
                  </Text>
                ) : (
                  <List size="sm" spacing={2}>
                    {p.kpis.map((k) => (
                      <List.Item key={k.id}>
                        <Anchor component={Link} to={`/plant/kpis/${encodeURIComponent(k.id)}`} size="sm">
                          {nameOf(k)}
                        </Anchor>
                        {k.dataPoints.length > 0 && (
                          <Text span size="xs" c="dimmed" className="mono">
                            {' '}
                            {k.dataPoints.join(', ')}
                          </Text>
                        )}
                      </List.Item>
                    ))}
                  </List>
                )}
              </Stack>
            </Paper>
            <Paper withBorder p="md">
              <Stack gap="sm">
                <Field label={t('form.id')}>
                  <span className="mono">{p.id}</span>
                </Field>
                <Field label={t('asset.manufacturerModel')}>{[p.manufacturer, p.model].filter(Boolean).join(' · ') || '–'}</Field>
                <Field label={t('profile.version')}>{p.version || '–'}</Field>
                <Field label={t('profile.counts')}>{t('profile.countsText', { interfaces: p.interfaceCount, points: p.dataPointCount })}</Field>
                {p.notes && (
                  <Field label={t('data.notes')}>
                    <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                      {p.notes}
                    </Text>
                  </Field>
                )}
                <SourceLine importId={p.importId} />
                <Text size="xs" c="dimmed">
                  {t('changedBy', { user: p.updatedBy, date: fmtDate(p.updatedAt) })}
                </Text>
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>
      {dialog?.kind === 'profile' && (
        <ProfileFormModal
          profile={values}
          bases={(profiles.data ?? []).filter((x) => x.id !== p.id).map((x) => ({ value: x.id, label: `${x.name} (${x.id})` }))}
          onClose={() => setDialog(null)}
          onSave={save}
        />
      )}
      {dialog?.kind === 'interface' && (
        <InterfaceFormModal
          iface={dialog.iface}
          taken={p.interfaces.map((i) => i.id)}
          inherited={!!dialog.iface && inheritedIface(dialog.iface.id)}
          baseProtocol={dialog.iface ? baseInterface(p, dialog.iface.id)?.protocol : undefined}
          onClose={() => setDialog(null)}
          onSave={(iface) => save(saveInterface(p, iface))}
        />
      )}
      {dialog?.kind === 'point' && (
        <DataPointFormModal
          point={dialog.point}
          protocol={dialog.iface.protocol}
          group={dialog.group}
          groups={dialog.iface.groups.map((g) => g.name)}
          taken={allPoints}
          inherited={!!dialog.point && inheritedPoint(dialog.point.id)}
          onClose={() => setDialog(null)}
          onSave={(point, group) => save(savePoint(p, dialog.iface.id, point, group, dialog.point?.id ?? null))}
        />
      )}
      {dialog?.kind === 'describe' && (
        <DescriptionModal
          title={dialog.title}
          value={dialog.value}
          help={dialog.help}
          max={PLANT_DATA_LIMITS.longText}
          onClose={() => setDialog(null)}
          onSave={(text) => save(dialog.apply(text))}
        />
      )}
      {dialog?.kind === 'group' && (
        <GroupModal
          name={dialog.group}
          description={dialog.description}
          taken={dialog.iface.groups.map((g) => g.name).filter((n) => n !== dialog.group)}
          onClose={() => setDialog(null)}
          onSave={(name, description) => save(saveGroup(p, dialog.iface.id, dialog.group, name, description))}
        />
      )}
    </>
  );
}

function GroupModal({
  name: name0,
  description: description0,
  taken,
  onClose,
  onSave,
}: {
  name: string;
  description: string;
  taken: string[];
  onClose: () => void;
  onSave: (name: string, description: string) => Promise<void>;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const [name, setName] = useState(name0);
  const [description, setDescription] = useState(description0);
  const [busy, setBusy] = useState(false);
  const error = !name.trim() ? t('common:validation.required') : taken.includes(name.trim()) ? t('data.groupTaken') : undefined;
  return (
    <Modal opened onClose={onClose} title={t('data.editGroup', { name: name0 })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (error) return;
          setBusy(true);
          onSave(name.trim(), description).then(onClose, (err: unknown) => {
            notifyError(err);
            setBusy(false);
          });
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('data.group')}
            required
            data-autofocus
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={error}
          />
          <Textarea
            label={t('form.description')}
            autosize
            minRows={1}
            maxRows={5}
            maxLength={8000}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </Modal>
  );
}

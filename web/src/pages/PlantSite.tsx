import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Box, Button, Grid, Group, Menu, Paper, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { IconBuilding, IconChevronDown, IconDots, IconDownload, IconEdit, IconId, IconMap, IconPencil, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  ASSET_STATUSES,
  LEVEL_RECORD_TYPE,
  type PlantBuilding,
  type PlantLevel,
  type PlantImportSummary,
  type PlantNode,
  type PlantSiteDetail,
} from '@sm/shared';
import { apiUrl, del, get, notifyError, patch, post, put } from '../api';
import { DetailState, EmptyState } from '../components/common';
import { ChangeIdModal, useAliasRedirect, useChangeId, type EntryRef } from '../components/plant/ids';
import { DetailHeader } from '../components/page/DetailPage';
import { Field, LinksPanel } from '../components/records/common';
import { OwningTeams } from '../components/OwningTeams';
import { AccessEditor } from '../components/AccessEditor';
import { confirmDanger } from '../components/confirm';
import { fmtDate } from '../format';
import { plantKeys } from '../queryKeys';
import {
  AssetStatusBadge,
  FieldValuesView,
  MapLink,
  NotInSourceBadge,
  PreviewBadge,
  RefsView,
  useNameOf,
  usePlantConfig,
  usePlantLabel,
} from '../components/plant/common';
import { AssetFormModal, BuildingFormModal, NodeFormModal, SiteFormModal } from '../components/plant/forms';
import { SiteNetworkCard } from '../components/plant/network';
import { PlantDocumentsPanel } from '../components/plant/DocumentsPanel';
import { PlantSiteTabPage, SiteTabs } from './plant/views/tabs';
import { SectionGroup, SectionGroupControls, useCollapsible } from '../components/page/CollapsibleSection';

type NodeDialog = { level: PlantLevel; parentId: string | null; node?: PlantNode } | null;

/**
 * A site (#218): its ISA-95 hierarchy (area → work center → work unit) with the building that applies to each node, the
 * buildings (the spatial axis), its assets by status, contacts, external references, own fields, links and access.
 */
export function PlantSitePage() {
  const { t } = useTranslation(['plant', 'common', 'plantMap', 'plantIds']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const mapOn = usePlantConfig().data?.map.on === true;
  const { siteId, tab } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: plantKeys.site(siteId), queryFn: () => get<PlantSiteDetail>(`/plant/sites/${encodeURIComponent(siteId!)}`) });
  const [editing, setEditing] = useState(false);
  const [nodeDialog, setNodeDialog] = useState<NodeDialog>(null);
  const [buildingDialog, setBuildingDialog] = useState<{ building?: PlantBuilding } | null>(null);
  const [newAsset, setNewAsset] = useState(false);
  // Change id of a node or building (0.11.0)
  const [idOf, setIdOf] = useState<EntryRef | null>(null);
  // a link to #node-<id> opens the path to that node
  const { hash } = useLocation();
  const target = hash.startsWith('#node-') ? decodeURIComponent(hash.slice(6)) : null;
  const s = q.data;
  // an old id in the address (0.11.0): the entry's id replaces it
  useAliasRedirect([[siteId, s?.id]]);
  const changeId = useChangeId(s ? { kind: 'site', id: s.id, name: s.name } : null, !!s?.canManage);
  if (!s) return <DetailState query={q} back="plantSites" />;
  // the other tabs (#230): the structure as a picture
  if (tab) return <PlantSiteTabPage site={s} tab={tab} />;
  const saved = (x: PlantSiteDetail) => {
    qc.setQueryData(plantKeys.site(siteId), x);
    void qc.invalidateQueries({ queryKey: plantKeys.sites });
    void qc.invalidateQueries({ queryKey: plantKeys.mapSites });
    void qc.invalidateQueries({ queryKey: plantKeys.hierarchy });
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: plantKeys.site(siteId) });
  const base = `/plant/sites/${encodeURIComponent(s.id)}`;
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('site.deleteConfirm', { name: nameOf(s) }) }))) return;
    try {
      await del(base);
      void qc.invalidateQueries({ queryKey: plantKeys.all });
      navigate('/plant/sites');
    } catch (e) {
      notifyError(e);
    }
  };
  const removeNode = async (n: PlantNode) => {
    if (
      !(await confirmDanger({ action: 'remove', message: t('node.deleteConfirm', { type: label(LEVEL_RECORD_TYPE[n.level], false, true), name: nameOf(n) }) }))
    )
      return;
    try {
      saved(await del<PlantSiteDetail>(`${base}/nodes/${encodeURIComponent(n.id)}`));
    } catch (e) {
      notifyError(e);
    }
  };
  const removeBuilding = async (b: PlantBuilding) => {
    if (!(await confirmDanger({ action: 'remove', message: t('building.deleteConfirm', { name: nameOf(b) }) }))) return;
    try {
      saved(await del<PlantSiteDetail>(`${base}/buildings/${encodeURIComponent(b.id)}`));
    } catch (e) {
      notifyError(e);
    }
  };
  const buildingName = (id: string | null) => (id ? nameOf(s.buildings.find((b) => b.id === id)) || id : '');
  const canManage = s.canManage;
  const assetsCard = (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600}>{label('asset', true)}</Text>
          <Text fw={600} size="lg">
            {s.assetCount}
          </Text>
        </Group>
        <Group gap={6}>
          {ASSET_STATUSES.filter((x) => s.statusCounts[x]).map((x) => (
            <Group key={x} gap={2} wrap="nowrap">
              <AssetStatusBadge status={x} size="xs" />
              <Text size="xs">{s.statusCounts[x]}</Text>
            </Group>
          ))}
        </Group>
        <Group gap="xs">
          <Button size="xs" variant="light" component={Link} to={`/plant/assets?site=${encodeURIComponent(s.id)}`}>
            {t('site.showAssets', { type: label('asset', true, true) })}
          </Button>
          {canManage && (
            <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setNewAsset(true)}>
              {t('assets.new', { type: label('asset', false, true) })}
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
  );

  return (
    <>
      <DetailHeader
        recent={{ label: nameOf(s), kind: 'site' }}
        back="plantSites"
        title={nameOf(s)}
        status={
          <>
            {s.code && <Badge variant="default">{s.code}</Badge>}
            {s.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
          </>
        }
        description={s.description || undefined}
        actions={
          <>
            {canManage && (
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                {t('common:edit')}
              </Button>
            )}
            <Button
              size="xs"
              variant="default"
              component="a"
              href={apiUrl(`/plant/export?site=${encodeURIComponent(s.id)}`)}
              download
              leftSection={<IconDownload size={14} />}
            >
              {t('export.site')}
            </Button>
          </>
        }
        menu={
          canManage
            ? {
                items: [
                  ...(changeId.item ? [changeId.item] : []),
                  { label: t('site.delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'site-delete' },
                ],
              }
            : undefined
        }
        tabs={<SiteTabs site={s} active="" />}
      />
      {changeId.modal}
      {idOf && <ChangeIdModal entry={idOf} onClose={() => setIdOf(null)} onRenamed={() => refresh()} />}
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {/* on phones the asset summary comes first, before the long tree */}
            <Box hiddenFrom="md">{assetsCard}</Box>
            {/* areas open, the levels below them folded; Expand all / Collapse all for the whole tree */}
            <SectionGroup controls="none">
              <Stack gap="xs" data-testid="plant-hierarchy">
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <div>
                    <Title order={2} fz="h4">
                      {t('hierarchy.title')}
                    </Title>
                    <Text size="xs" c="dimmed">
                      {t('hierarchy.help')}
                    </Text>
                  </div>
                  <Group gap="xs">
                    <SectionGroupControls />
                    {canManage && (
                      <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setNodeDialog({ level: 'area', parentId: null })}>
                        {t('hierarchy.add', { type: label('area', false, true) })}
                      </Button>
                    )}
                  </Group>
                </Group>
                {s.areas.length === 0 ? (
                  <EmptyState compact title={t('hierarchy.emptyTitle')} whoCanAct={canManage ? undefined : t('hierarchy.whoCanAct')}>
                    {t('hierarchy.emptyText')}
                  </EmptyState>
                ) : (
                  <ul className="plant-tree" aria-label={t('hierarchy.title')}>
                    {s.areas.map((a) => (
                      <NodeItem
                        key={a.id}
                        node={a}
                        site={s}
                        buildingName={buildingName}
                        canManage={canManage}
                        onAdd={(level, parentId) => setNodeDialog({ level, parentId })}
                        onEdit={(n) => setNodeDialog({ level: n.level, parentId: n.parentId, node: n })}
                        onRemove={(n) => void removeNode(n)}
                        onChangeId={(n) => setIdOf({ kind: 'node', scope: s.id, id: n.id, name: nameOf(n) })}
                        target={target}
                      />
                    ))}
                  </ul>
                )}
              </Stack>
            </SectionGroup>

            <Stack gap="xs" data-testid="plant-buildings">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <div>
                  <Title order={2} fz="h4">
                    {label('building', true)}
                  </Title>
                  <Text size="xs" c="dimmed">
                    {t('buildings.help')}
                  </Text>
                </div>
                {canManage && (
                  <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setBuildingDialog({})}>
                    {t('buildings.add', { type: label('building', false, true) })}
                  </Button>
                )}
              </Group>
              {s.buildings.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('buildings.empty')}
                </Text>
              ) : (
                <div className="table-scroll" tabIndex={0} role="region" aria-label={label('building', true)}>
                  <Table fz="sm" aria-label={label('building', true)}>
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('form.name')}</Table.Th>
                        <Table.Th>{t('building.kind')}</Table.Th>
                        <Table.Th>{t('building.parent')}</Table.Th>
                        <Table.Th>{t('buildings.nodes')}</Table.Th>
                        <Table.Th>{label('asset', true)}</Table.Th>
                        {canManage && <Table.Th aria-label={t('actions')} />}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {s.buildings.map((b) => (
                        <Table.Tr key={b.id}>
                          <Table.Td>
                            <Group gap={6} wrap="nowrap">
                              <IconBuilding size={14} aria-hidden />
                              <Text size="sm" fw={500}>
                                {nameOf(b)}
                              </Text>
                              {b.notInSource && <NotInSourceBadge size="xs" />}
                            </Group>
                            <Text size="xs" c="dimmed" className="mono">
                              {b.id}
                            </Text>
                          </Table.Td>
                          <Table.Td>{t(`buildingKinds.${b.kind}`)}</Table.Td>
                          <Table.Td>{buildingName(b.parentId) || '–'}</Table.Td>
                          <Table.Td>{b.nodeCount}</Table.Td>
                          <Table.Td>{b.assetCount}</Table.Td>
                          {canManage && (
                            <Table.Td>
                              <Group gap={2} wrap="nowrap">
                                <Tooltip label={t('common:edit')}>
                                  <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    aria-label={t('building.editNamed', { name: nameOf(b) })}
                                    onClick={() => setBuildingDialog({ building: b })}
                                  >
                                    <IconPencil size={16} />
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label={t('plantIds:changeId.menu')}>
                                  <ActionIcon
                                    variant="subtle"
                                    color="gray"
                                    aria-label={t('plantIds:changeId.title', { name: nameOf(b) })}
                                    onClick={() => setIdOf({ kind: 'building', scope: s.id, id: b.id, name: nameOf(b) })}
                                  >
                                    <IconId size={16} />
                                  </ActionIcon>
                                </Tooltip>
                                <Tooltip label={t('common:remove')}>
                                  <ActionIcon
                                    variant="subtle"
                                    color="red"
                                    aria-label={t('building.removeNamed', { name: nameOf(b) })}
                                    onClick={() => void removeBuilding(b)}
                                  >
                                    <IconTrash size={16} />
                                  </ActionIcon>
                                </Tooltip>
                              </Group>
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Stack>

            <PlantDocumentsPanel kind="site" id={s.id} />
            <LinksPanel
              links={s.links}
              backlinks={s.backlinks}
              canEdit={canManage}
              self={{ kind: 'site', id: s.id }}
              onAdd={async (l) => {
                await post(`${base}/links`, l);
                refresh();
              }}
              onUpdate={async (lid, l) => {
                await patch(`${base}/links/${lid}`, l);
                refresh();
              }}
              onRemove={async (lid) => {
                await del(`${base}/links/${lid}`);
                refresh();
              }}
            />
            {canManage && s.acl && (
              <Stack gap="xs" data-testid="site-access">
                <Title order={2} fz="h4">
                  {t('site.access')}
                </Title>
                <AccessEditor kind="site" acl={s.acl} onSave={async (acl) => saved(await put<PlantSiteDetail>(`${base}/access`, { acl }))} />
              </Stack>
            )}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Box visibleFrom="md">{assetsCard}</Box>
          {/* the OT network (#220): the live status of the assets and the way to the site's network */}
          <SiteNetworkCard siteId={s.id} />
          <Paper withBorder p="md" mt={{ base: 0, md: 'md' }}>
            <Stack gap="sm">
              <Field label={t('form.id')}>
                <span className="mono">{s.id}</span>
              </Field>
              <Field label={t('site.position')}>
                <Stack gap={4} align="flex-start">
                  <MapLink geo={s.geo} name={nameOf(s)} />
                  {/* the map of sites (#234), once an administrator turned it on: the site with its own zoom */}
                  {s.geo && mapOn && (
                    <Anchor component={Link} to={`/plant/map?site=${encodeURIComponent(s.id)}`} size="sm" data-testid="show-on-map">
                      <Group gap={4} wrap="nowrap" component="span">
                        <IconMap size={14} aria-hidden />
                        <span>{t('plantMap:showOnMap')}</span>
                      </Group>
                    </Anchor>
                  )}
                </Stack>
              </Field>
              <Field label={t('contacts.title')}>
                {s.contacts.length === 0 ? (
                  '–'
                ) : (
                  <Stack gap={6}>
                    {s.contacts.map((c, i) => (
                      <div key={i}>
                        <Text size="sm" fw={500}>
                          {c.name}
                          {c.role && (
                            <Text span size="xs" c="dimmed">
                              {' '}
                              · {c.role}
                            </Text>
                          )}
                        </Text>
                        {c.email && (
                          <Anchor href={`mailto:${c.email}`} size="sm" style={{ overflowWrap: 'anywhere' }}>
                            {c.email}
                          </Anchor>
                        )}
                        {c.phone && <Text size="sm">{c.phone}</Text>}
                      </div>
                    ))}
                  </Stack>
                )}
              </Field>
              <Field label={t('refs.title')}>
                <RefsView refs={s.refs} />
              </Field>
              <FieldValuesView type="site" values={s.fields}>
                {(l, v) => (
                  <Field key={l} label={l}>
                    {v}
                  </Field>
                )}
              </FieldValuesView>
              <SourceLine importId={s.importId} />
              <Text size="xs" c="dimmed">
                {t('changedBy', { user: s.updatedBy, date: fmtDate(s.updatedAt) })}
              </Text>
            </Stack>
          </Paper>
          <OwningTeams kind="site" id={s.id} mt="md" />
        </Grid.Col>
      </Grid>
      {editing && <SiteFormModal site={s} onClose={() => setEditing(false)} onSaved={saved} />}
      {nodeDialog && <NodeFormModal site={s} {...nodeDialog} onClose={() => setNodeDialog(null)} onSaved={saved} />}
      {buildingDialog && <BuildingFormModal site={s} building={buildingDialog.building} onClose={() => setBuildingDialog(null)} onSaved={saved} />}
      {newAsset && (
        <AssetFormModal
          defaults={{ siteId: s.id }}
          onClose={() => setNewAsset(false)}
          onSaved={(a) => {
            void qc.invalidateQueries({ queryKey: plantKeys.all });
            navigate(`/plant/assets/${encodeURIComponent(a.id)}`);
          }}
        />
      )}
    </>
  );
}

/** Where a record came from (an import: its files and date), shown in the side panel. */
export function SourceLine({ importId }: { importId: string | null }) {
  const { t } = useTranslation('plant');
  const imports = useQuery({
    queryKey: plantKeys.imports,
    queryFn: () => get<PlantImportSummary[]>('/plant/imports'),
    enabled: !!importId,
  });
  const imp = importId ? imports.data?.find((i) => i.id === importId) : undefined;
  return (
    <Field label={t('source.title')}>
      {importId ? (
        <Anchor component={Link} to="/plant/import" size="sm">
          {imp ? t('source.importOf', { files: imp.files.map((f) => f.name).join(', '), when: fmtDate(imp.createdAt) }) : t('source.import', { id: importId })}
        </Anchor>
      ) : (
        t('source.manual')
      )}
    </Field>
  );
}

const CHILD: Record<PlantLevel, PlantLevel | null> = { area: 'work_center', work_center: 'work_unit', work_unit: null };
/** Whether `id` is below `node` in the tree */
const holds = (node: PlantNode, id: string): boolean => node.children.some((c) => c.id === id || holds(c, id));

/** One node of the tree with its children: name, ISA-95 kind, domain, the building that applies, its assets. */
function NodeItem({
  node,
  site,
  buildingName,
  canManage,
  onAdd,
  onEdit,
  onRemove,
  onChangeId,
  target,
}: {
  /** The node a link (#node-<id>) points to: the nodes above it open */
  target: string | null;
  node: PlantNode;
  site: PlantSiteDetail;
  buildingName: (id: string | null) => string;
  canManage: boolean;
  onAdd: (level: PlantLevel, parentId: string) => void;
  onEdit: (n: PlantNode) => void;
  onRemove: (n: PlantNode) => void;
  onChangeId: (n: PlantNode) => void;
}) {
  const { t } = useTranslation(['plant', 'common', 'plantIds']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const child = CHILD[node.level];
  const own = !!node.buildingId;
  const building = node.effectiveBuildingId;
  const hasChildren = node.children.length > 0;
  // areas open, the levels below folded (this page view); the path to a linked node opens
  const { open, toggle } = useCollapsible({
    id: `node-${node.id}`,
    defaultOpen: node.level === 'area',
    forceOpen: !!target && holds(node, target),
    inGroup: hasChildren,
  });
  return (
    <li
      className="plant-tree-item sm-anchor"
      id={`node-${node.id}`}
      data-level={node.level}
      data-testid={`node-${node.id}`}
      data-open={hasChildren ? open : undefined}
    >
      <Group gap="xs" justify="space-between" wrap="nowrap" className="plant-tree-row">
        <Group gap={6} wrap="wrap" style={{ minWidth: 0 }}>
          {hasChildren ? (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="md"
              onClick={toggle}
              aria-expanded={open}
              aria-controls={`node-${node.id}-children`}
              aria-label={t('hierarchy.levelsBelow', { name: nameOf(node) })}
              data-testid={`node-${node.id}-toggle`}
            >
              <IconChevronDown size={16} className="sm-section-chevron" data-open={open} aria-hidden />
            </ActionIcon>
          ) : (
            <Box w={28} style={{ flex: 'none' }} aria-hidden />
          )}
          <Badge size="xs" variant="light" color={node.level === 'area' ? 'blue' : node.level === 'work_center' ? 'teal' : 'gray'}>
            {label(LEVEL_RECORD_TYPE[node.level])}
          </Badge>
          <Text size="sm" fw={node.level === 'area' ? 600 : 500} style={{ overflowWrap: 'anywhere' }}>
            {nameOf(node)}
          </Text>
          <Text size="xs" c="dimmed" className="mono">
            {node.id}
          </Text>
          {node.type && (
            <Badge size="xs" variant="outline" color="gray">
              {t(`isaTypes.${node.type as 'unit'}`, { defaultValue: node.type })}
            </Badge>
          )}
          {node.domain && (
            <Badge size="xs" variant="default">
              {node.domain}
            </Badge>
          )}
          {building && (
            <Tooltip label={own ? t('hierarchy.buildingOwn') : t('hierarchy.buildingInherited')} withArrow>
              <Group gap={2} wrap="nowrap" component="span" c={own ? undefined : 'dimmed'} data-testid="node-building" tabIndex={0}>
                <IconBuilding size={13} aria-hidden />
                <Text span size="xs" fs={own ? undefined : 'italic'}>
                  {buildingName(building)}
                </Text>
              </Group>
            </Tooltip>
          )}
          {node.notInSource && <NotInSourceBadge size="xs" />}
          {hasChildren && !open && (
            <Text size="xs" c="dimmed" data-testid="node-below">
              {t('hierarchy.below', { count: node.children.length })}
            </Text>
          )}
        </Group>
        <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
          {node.assetCount > 0 && (
            <Anchor component={Link} to={`/plant/assets?site=${encodeURIComponent(site.id)}&node=${encodeURIComponent(node.id)}`} size="xs">
              {t('hierarchy.assetCount', { count: node.assetCount })}
            </Anchor>
          )}
          {canManage && (
            <Menu position="bottom-end" withinPortal shadow="md">
              <Menu.Target>
                <ActionIcon variant="subtle" color="gray" aria-label={t('hierarchy.actionsNamed', { name: nameOf(node) })}>
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {child && (
                  <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => onAdd(child, node.id)}>
                    {t('hierarchy.add', { type: label(LEVEL_RECORD_TYPE[child], false, true) })}
                  </Menu.Item>
                )}
                <Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onEdit(node)}>
                  {t('common:edit')}
                </Menu.Item>
                <Menu.Item leftSection={<IconId size={14} />} onClick={() => onChangeId(node)} data-testid={`change-id-${node.id}`}>
                  {t('plantIds:changeId.menu')}
                </Menu.Item>
                <Menu.Item leftSection={<IconTrash size={14} />} color="red" onClick={() => onRemove(node)}>
                  {t('common:remove')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          )}
        </Group>
      </Group>
      {hasChildren && (
        // folded: hidden, not removed, so Expand all and the path to a linked node reach every level
        <ul className="plant-tree" id={`node-${node.id}-children`} hidden={!open}>
          {node.children.map((c) => (
            <NodeItem
              key={c.id}
              node={c}
              site={site}
              buildingName={buildingName}
              canManage={canManage}
              onAdd={onAdd}
              onEdit={onEdit}
              onRemove={onRemove}
              onChangeId={onChangeId}
              target={target}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

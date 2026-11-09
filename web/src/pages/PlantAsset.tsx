import { useEffect, useRef, useState } from 'react';
import { Anchor, Badge, Button, FileButton, Grid, Group, Image, List, Paper, Stack, Text, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconArrowMoveRight, IconBuilding, IconChevronRight, IconEdit, IconPhoto, IconTrash, IconUpload } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { PLANT_LIMITS, type PlantAssetDetail } from '@sm/shared';
import { apiUrl, del, get, notifyError, patch, post, put } from '../api';
import { DetailState } from '../components/common';
import { useAliasRedirect, useChangeId } from '../components/plant/ids';
import { DetailHeader } from '../components/page/DetailPage';
import { Field, LinksPanel } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { CopiedFromNote, DuplicateButton } from '../components/duplicate/DuplicateButton';
import { fmtDate, fmtDay } from '../format';
import { plantKeys } from '../queryKeys';
import { AssetStatusBadge, FieldValuesView, NotInSourceBadge, PreviewBadge, RefsView, useNameOf, usePlantLabel } from '../components/plant/common';
import { AssetFormModal } from '../components/plant/forms';
import { MoveAssetModal } from '../components/plant/MoveTo';
import { AssetDataSection } from '../components/plant/AssetData';
import { AssetNetworkSection } from '../components/plant/AssetNetwork';
import { AssetAdvisoriesSection } from '../components/plant/advisories/AssetAdvisories';
import { PlantDocumentsPanel } from '../components/plant/DocumentsPanel';
import { SourceLine } from './PlantSite';
import { AssetTabs, PlantAssetTabPage } from './plant/views/tabs';
import { OpenChangesChip, ProposeEditButton } from '../components/plant/changes/common';

/**
 * An asset (#218): where it is (site › area › work center › work unit, and the building that applies), the equipment
 * it is part of and the equipment that is part of it, its taxonomy, lifecycle, capabilities, external references, own
 * fields, image and links to Steward systems, applications and platforms; since #219 what its interfaces deliver
 * (device profile, endpoints, publications) and its KPI instances with what Steward checks in them.
 */
export function PlantAssetPage() {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const { assetId, tab } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const q = useQuery({ queryKey: plantKeys.asset(assetId), queryFn: () => get<PlantAssetDetail>(`/plant/assets/${encodeURIComponent(assetId!)}`) });
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const resetImage = useRef<() => void>(null);
  const a = q.data;
  // ?edit=1 (after Duplicate): open the form once the asset is loaded
  useEffect(() => {
    if (a?.canManage && search.get('edit') === '1') {
      setEditing(true);
      setSearch({}, { replace: true });
    }
  }, [a?.canManage, search, setSearch]);
  useAliasRedirect([[assetId, a?.id]]);
  const changeId = useChangeId(a ? { kind: 'asset', id: a.id, name: a.name } : null, !!a?.canManage);
  if (!a) return <DetailState query={q} back="plantAssets" />;
  // the other tabs (#230): the data flow as a picture
  if (tab) return <PlantAssetTabPage asset={a} tab={tab} />;
  const base = `/plant/assets/${encodeURIComponent(a.id)}`;
  const saved = (x: PlantAssetDetail) => {
    qc.setQueryData(plantKeys.asset(assetId), x);
    void qc.invalidateQueries({ queryKey: ['plant', 'assets'] });
    void qc.invalidateQueries({ queryKey: plantKeys.sites });
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: plantKeys.asset(assetId) });
  const remove = async () => {
    const message = a.children.length
      ? t('asset.deleteConfirmChildren', { name: a.name, count: a.children.length })
      : t('asset.deleteConfirm', { name: a.name });
    if (!(await confirmDanger({ action: 'delete', message }))) return;
    try {
      await del(base);
      void qc.invalidateQueries({ queryKey: plantKeys.all });
      navigate('/plant/assets');
    } catch (e) {
      notifyError(e);
    }
  };
  const upload = async (file: File | null) => {
    resetImage.current?.();
    if (!file) return;
    setUploading(true);
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
      saved(await put<PlantAssetDetail>(`${base}/image`, { contentBase64: btoa(bin) }));
    } catch (e) {
      notifyError(e);
    } finally {
      setUploading(false);
    }
  };
  const loc = a.location;
  const crumbs = [
    { to: `/plant/sites/${encodeURIComponent(loc.site.id)}`, label: nameOf(loc.site) },
    ...[loc.area, loc.workCenter, loc.workUnit]
      .filter((x): x is NonNullable<typeof x> => !!x)
      .map((n) => ({ to: `/plant/assets?site=${encodeURIComponent(loc.site.id)}&node=${encodeURIComponent(n.id)}`, label: nameOf(n) })),
  ];
  const today = new Date().toISOString().slice(0, 10);
  const eos = a.endOfSupport;
  return (
    <>
      <DetailHeader
        recent={{ label: a.name, kind: 'asset' }}
        back="plantAssets"
        title={a.name}
        status={
          <>
            <AssetStatusBadge status={a.status} size="md" />
            {a.notInSource && <NotInSourceBadge />}
            <PreviewBadge />
            {/* 0.13.0: open change sets that touch it, and whether the person's draft does */}
            <OpenChangesChip query={{ kind: 'asset', id: a.id }} />
          </>
        }
        description={
          <nav aria-label={t('asset.location')} data-testid="asset-location">
            <Group gap={4} wrap="wrap">
              {crumbs.map((c, i) => (
                <Group key={c.to} gap={4} wrap="nowrap">
                  {i > 0 && <IconChevronRight size={12} aria-hidden />}
                  <Anchor component={Link} to={c.to} size="sm">
                    {c.label}
                  </Anchor>
                </Group>
              ))}
              {loc.building && (
                <Group gap={4} wrap="nowrap" ml="xs">
                  <IconBuilding size={14} aria-hidden />
                  <Text size="sm">{nameOf(loc.building)}</Text>
                </Group>
              )}
            </Group>
          </nav>
        }
        actions={
          a.canManage ? (
            <>
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                {t('common:edit')}
              </Button>
              <DuplicateButton kind="asset" id={a.id} />
            </>
          ) : (
            // 0.13.0: who may only propose edits into their draft
            a.canPropose && <ProposeEditButton onClick={() => setEditing(true)} testId="asset-propose-edit" />
          )
        }
        menu={
          a.canManage
            ? {
                items: [
                  { label: t('move.menu'), icon: IconArrowMoveRight, onClick: () => setMoving(true), testId: 'move-to' },
                  ...(changeId.item ? [changeId.item] : []),
                  { label: t('asset.delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'asset-delete' },
                ],
              }
            : undefined
        }
        tabs={<AssetTabs asset={a} active="" />}
      />
      {changeId.modal}
      <CopiedFromNote kind="asset" id={a.id} pathOf={(id) => `/plant/assets/${encodeURIComponent(id)}`} />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {a.description && <Text size="sm">{a.description}</Text>}
            {a.capabilities.length > 0 && (
              <Stack gap={4} data-testid="asset-capabilities">
                <Title order={2} fz="h4">
                  {t('asset.capabilities')}
                </Title>
                <List size="sm" spacing={2}>
                  {a.capabilities.map((c) => (
                    <List.Item key={c}>{c}</List.Item>
                  ))}
                </List>
              </Stack>
            )}
            <Stack gap={6} data-testid="asset-equipment">
              <Title order={2} fz="h4">
                {t('asset.equipment')}
              </Title>
              <Text size="xs" c="dimmed">
                {t('asset.equipmentHelp')}
              </Text>
              <Field label={t('asset.partOf')}>
                {a.parent ? (
                  a.parent.visible ? (
                    <Group gap={6}>
                      <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(a.parent.id)}`} size="sm">
                        {a.parent.name}
                      </Anchor>
                      <AssetStatusBadge status={a.parent.status} size="xs" />
                    </Group>
                  ) : (
                    t('asset.hidden')
                  )
                ) : (
                  '–'
                )}
              </Field>
              <Field label={t('asset.parts')}>
                {a.children.length === 0 ? (
                  '–'
                ) : (
                  <Stack gap={2}>
                    {a.children.map((c, i) =>
                      c.visible ? (
                        <Group key={c.id} gap={6}>
                          <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(c.id)}`} size="sm">
                            {c.name}
                          </Anchor>
                          <AssetStatusBadge status={c.status} size="xs" />
                        </Group>
                      ) : (
                        <Text key={`hidden-${i}`} size="sm" c="dimmed">
                          {t('asset.hidden')}
                        </Text>
                      ),
                    )}
                  </Stack>
                )}
              </Field>
            </Stack>
            <AssetDataSection assetId={a.id} />
            <AssetNetworkSection assetId={a.id} />
            <AssetAdvisoriesSection assetId={a.id} />
            <PlantDocumentsPanel kind="asset" id={a.id} />
            <LinksPanel
              links={a.links}
              backlinks={a.backlinks}
              canEdit={a.canManage}
              self={{ kind: 'asset', id: a.id }}
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
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="md" data-testid="asset-image">
            {a.image ? (
              <Image
                src={apiUrl(`${base}/image?v=${a.image.sha256.slice(0, 12)}`)}
                alt={t('asset.imageAlt', { name: a.name })}
                radius="sm"
                fit="contain"
                mah={260}
              />
            ) : (
              <Group gap="xs" c="dimmed">
                <IconPhoto size={20} aria-hidden />
                <Text size="sm">{a.imageName ? t('asset.imageNotUploaded', { name: a.imageName }) : t('asset.noImage')}</Text>
              </Group>
            )}
            {a.canManage && (
              <Group gap="xs" mt="sm">
                <FileButton resetRef={resetImage} onChange={(f) => void upload(f)} accept="image/png,image/jpeg,image/webp">
                  {(props) => (
                    <Button size="xs" variant="default" leftSection={<IconUpload size={14} />} loading={uploading} {...props}>
                      {a.image ? t('asset.imageReplace') : t('asset.imageUpload')}
                    </Button>
                  )}
                </FileButton>
                {a.image && (
                  <Button size="xs" variant="subtle" color="red" onClick={() => void del<PlantAssetDetail>(`${base}/image`).then(saved, notifyError)}>
                    {t('asset.imageRemove')}
                  </Button>
                )}
              </Group>
            )}
            {a.canManage && (
              <Text size="xs" c="dimmed" mt={4}>
                {t('asset.imageHelp', { kb: PLANT_LIMITS.imageBytes / 1024 })}
              </Text>
            )}
          </Paper>
          <Paper withBorder p="md" mt="md">
            <Stack gap="sm">
              <Field label={t('form.id')}>
                <span className="mono">{a.id}</span>
              </Field>
              <Field label={t('asset.manufacturerModel')}>{[a.manufacturer, a.model].filter(Boolean).join(' · ') || '–'}</Field>
              <Field label={label('building')}>
                {loc.building ? (
                  <>
                    {nameOf(loc.building)}
                    <Text span size="xs" c="dimmed">
                      {' '}
                      ·{' '}
                      {t(`asset.buildingFrom.${loc.buildingFrom ?? 'asset'}`, {
                        type:
                          loc.buildingFrom && loc.buildingFrom !== 'asset'
                            ? label(loc.buildingFrom === 'work_unit' ? 'workUnit' : loc.buildingFrom === 'work_center' ? 'workCenter' : 'area', false, true)
                            : '',
                      })}
                    </Text>
                  </>
                ) : (
                  '–'
                )}
              </Field>
              <Field label={t('asset.taxonomy')}>
                {[a.domain, a.processArea, a.role].some(Boolean) ? (
                  <Stack gap={2}>
                    {a.domain && <Text size="sm">{t('asset.domainIs', { value: a.domain })}</Text>}
                    {a.processArea && <Text size="sm">{t('asset.processAreaIs', { value: a.processArea })}</Text>}
                    {a.role && <Text size="sm">{t('asset.roleIs', { value: a.role })}</Text>}
                  </Stack>
                ) : (
                  '–'
                )}
              </Field>
              <Field label={t('asset.tags')}>
                {a.tags.length ? (
                  <Group gap={4}>
                    {a.tags.map((x) => (
                      <Badge
                        key={x}
                        size="sm"
                        variant="default"
                        component={Link}
                        to={`/plant/assets?tag=${encodeURIComponent(x)}`}
                        style={{ cursor: 'pointer' }}
                      >
                        {x}
                      </Badge>
                    ))}
                  </Group>
                ) : (
                  '–'
                )}
              </Field>
              <Field label={t('asset.lifecycle')}>
                <Stack gap={2}>
                  <Text size="sm">{t('asset.commissionedOn', { date: a.commissioned ? fmtDay(`${a.commissioned}T00:00:00`) : '–' })}</Text>
                  <Group gap={6}>
                    <Text size="sm">{t('asset.endOfSupportOn', { date: eos ? fmtDay(`${eos}T00:00:00`) : '–' })}</Text>
                    {eos && eos < today && (
                      <Badge size="xs" color="red" variant="light">
                        {t('asset.pastEndOfSupport')}
                      </Badge>
                    )}
                  </Group>
                </Stack>
              </Field>
              <Field label={t('refs.title')}>
                <RefsView refs={a.refs} />
              </Field>
              <FieldValuesView type="asset" values={a.fields}>
                {(l, v) => (
                  <Field key={l} label={l}>
                    {v}
                  </Field>
                )}
              </FieldValuesView>
              <SourceLine importId={a.importId} />
              <Text size="xs" c="dimmed">
                {t('changedBy', { user: a.updatedBy, date: fmtDate(a.updatedAt) })}
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      {editing && <AssetFormModal asset={a} onClose={() => setEditing(false)} onSaved={saved} />}
      {moving && <MoveAssetModal asset={a} onClose={() => setMoving(false)} onSaved={saved} />}
    </>
  );
}

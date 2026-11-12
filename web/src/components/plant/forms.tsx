import { Suspense, useMemo, useState } from 'react';
import { ActionIcon, Box, Button, Group, NumberInput, Select, SimpleGrid, Skeleton, Stack, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  ASSET_STATUSES,
  BUILDING_KINDS,
  LEVEL_RECORD_TYPE,
  PLANT_ID_RE,
  PLANT_LIMITS,
  WORK_CENTER_TYPES,
  WORK_UNIT_TYPES,
  type AssetStatus,
  type BuildingKind,
  type ExternalRef,
  type FieldValues,
  type PlantAssetDetail,
  type PlantAssetSummary,
  type PlantBuilding,
  type PlantFieldDef,
  type PlantHierarchySite,
  type PlantLevel,
  type PlantNode,
  type PlantRecordType,
  type PlantSiteDetail,
  type SiteContact,
  type Translations,
} from '@sm/shared';
import { get, notifyError, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { plantKeys } from '../../queryKeys';
import { MapChunkBoundary, PositionPicker } from './map/MapPanel';
import { hasWebGl2 } from './map/mapShared';
import { cleanRefs, FieldInputs, RefsEditor, refsValid, slugId, TranslationsInput, useNameOf, usePlantConfig, usePlantLabel } from './common';
import { draftSave } from './changes/common';
import { FormModal, useFormModalCloseIfAny } from '../FormModal';

/** Every node of a site's tree, flat (pickers). */
export function flatNodes(areas: PlantNode[]): PlantNode[] {
  return areas.flatMap((a) => [a, ...a.children.flatMap((wc) => [wc, ...wc.children])]);
}

/** A node with the names of the levels above it: "Milling line 1 › Milling cell 1" (names repeat across lines). */
export function nodePath(all: PlantNode[], n: PlantNode, nameOf: (x: PlantNode) => string): string {
  const parts = [nameOf(n)];
  let cur = n;
  for (let i = 0; i < 3 && cur.parentId; i++) {
    const p = all.find((x) => x.id === cur.parentId);
    if (!p) break;
    parts.unshift(nameOf(p));
    cur = p;
  }
  return parts.join(' › ');
}

/** Required own fields that are empty (a form shows them at their input). */
function missingFields(defs: PlantFieldDef[] | undefined, values: FieldValues): boolean {
  return (defs ?? []).some((d) => d.required && (values[d.key] === undefined || values[d.key] === null || values[d.key] === ''));
}

/** Empty own field values are not sent (the server keeps only what is set). */
export const cleanFieldValues = (v: FieldValues): FieldValues =>
  Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== null && x !== undefined));

/** The id of a new record: suggested from the name until the person types their own. */
export function useIdField(initial: string | undefined) {
  const [id, setId] = useState(initial ?? '');
  const [own, setOwn] = useState(!!initial);
  return {
    id,
    follow: (name: string) => !own && setId(slugId(name)),
    set: (v: string) => {
      setOwn(true);
      setId(v.toLowerCase());
    },
  };
}

export function IdInput({ value, onChange, disabled, error }: { value: string; onChange: (v: string) => void; disabled: boolean; error?: string }) {
  const { t } = useTranslation('plant');
  return (
    <TextInput
      label={t('form.id')}
      description={disabled ? t('form.idFixed') : t('form.idHelp')}
      required
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      disabled={disabled}
      maxLength={PLANT_LIMITS.id}
      classNames={{ input: 'mono' }}
      error={error}
    />
  );
}

export function FormButtons({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  const { t } = useTranslation('common');
  // inside a guarded dialog, Cancel asks before throwing away what was entered (as Esc and the ✕ do)
  const guarded = useFormModalCloseIfAny();
  return (
    <Group justify="flex-end" mt="xs">
      <Button variant="default" onClick={guarded ?? onClose}>
        {t('cancel')}
      </Button>
      <Button type="submit" loading={busy}>
        {t('save')}
      </Button>
    </Group>
  );
}

// ---------- site ----------

export function SiteFormModal({ site, onClose, onSaved }: { site?: PlantSiteDetail; onClose: () => void; onSaved: (s: PlantSiteDetail) => void }) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const cfg = usePlantConfig();
  const [name, setName] = useState(site?.name ?? '');
  const id = useIdField(site?.id);
  const [code, setCode] = useState(site?.code ?? '');
  const [names, setNames] = useState<Translations>(site?.names ?? {});
  const [description, setDescription] = useState(site?.description ?? '');
  const [lat, setLat] = useState<number | ''>(site?.geo?.lat ?? '');
  const [lon, setLon] = useState<number | ''>(site?.geo?.lon ?? '');
  const [zoom, setZoom] = useState<number | ''>(site?.geo?.zoom ?? '');
  const [contacts, setContacts] = useState<SiteContact[]>(site?.contacts ?? []);
  const [refs, setRefs] = useState<ExternalRef[]>(site?.refs ?? []);
  const [fields, setFields] = useState<FieldValues>(site?.fields ?? {});
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const webgl = useMemo(() => hasWebGl2(), []);
  const geoPartial = (lat === '') !== (lon === '');
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('form.idInvalid'),
    geo: geoPartial && t('form.geoBoth'),
    refs: !refsValid(refs) && t('refs.invalid'),
    contacts: contacts.some((c) => !c.name.trim() || (c.email.trim() && !/^[^\s@]+@[^\s@]+$/.test(c.email.trim()))) && t('contacts.invalid'),
  });
  const save = async () => {
    setShown(true);
    if (!v.validate() || missingFields(cfg.data?.fields.site, fields)) return;
    setBusy(true);
    const body = {
      code: code.trim(),
      name: name.trim(),
      names,
      description,
      geo: lat === '' || lon === '' ? null : { lat, lon, zoom: zoom === '' ? null : zoom },
      contacts: contacts.map((c) => ({ name: c.name.trim(), role: c.role.trim(), email: c.email.trim(), phone: c.phone.trim(), url: c.url.trim() })),
      refs: cleanRefs(refs),
      fields: cleanFieldValues(fields),
    };
    try {
      onSaved(
        site
          ? // 0.13.0: the revision it loaded (409 PLANT_ENTRY_CHANGED when someone else changed it since); who may only
            // propose saves into their draft
            await draftSave(site.canManage, () => put<PlantSiteDetail>(`/plant/sites/${encodeURIComponent(site.id)}`, { ...body, revision: site.revision }))
          : await post<PlantSiteDetail>('/plant/sites', { id: id.id, ...body }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const setContact = (i: number, patch: Partial<SiteContact>) => setContacts(contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <FormModal
      onClose={onClose}
      size="lg"
      title={site ? t('site.editTitle', { name: site.name }) : t('site.newTitle', { type: label('site', false, true) })}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('form.name')}
              required
              data-autofocus
              maxLength={PLANT_LIMITS.name}
              value={name}
              onChange={(e) => {
                setName(e.currentTarget.value);
                id.follow(e.currentTarget.value);
              }}
              error={v.error('name')}
            />
            <TextInput
              label={t('site.code')}
              description={t('site.codeHelp')}
              maxLength={PLANT_LIMITS.code}
              value={code}
              onChange={(e) => setCode(e.currentTarget.value)}
            />
          </SimpleGrid>
          <IdInput value={id.id} onChange={id.set} disabled={!!site} error={v.error('id')} />
          <TranslationsInput value={names} onChange={setNames} />
          <Textarea
            label={t('form.description')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={PLANT_LIMITS.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <div>
            <Text size="sm" fw={500}>
              {t('site.position')}
            </Text>
            <Text size="xs" c="dimmed" mb={4}>
              {t('site.positionHelp')}
            </Text>
            <SimpleGrid cols={{ base: 1, xs: 3 }}>
              <NumberInput
                label={t('site.lat')}
                min={-90}
                max={90}
                decimalScale={7}
                value={lat}
                onChange={(x) => setLat(typeof x === 'number' ? x : '')}
                error={v.error('geo')}
              />
              <NumberInput label={t('site.lon')} min={-180} max={180} decimalScale={7} value={lon} onChange={(x) => setLon(typeof x === 'number' ? x : '')} />
              <NumberInput
                label={t('site.zoom')}
                min={0}
                max={19}
                allowDecimal={false}
                value={zoom}
                onChange={(x) => setZoom(typeof x === 'number' ? x : '')}
              />
            </SimpleGrid>
            {/* the map of sites (#234), once it is on: a click on the map sets the position (typing stays possible) */}
            {cfg.data?.map.on && webgl && (
              <Box mt="xs">
                <MapChunkBoundary fallback={null}>
                  <Suspense fallback={<Skeleton height={220} radius="md" />}>
                    <PositionPicker
                      config={cfg.data.map}
                      lat={lat === '' ? null : lat}
                      lon={lon === '' ? null : lon}
                      zoom={zoom === '' ? null : zoom}
                      onPick={(p) => {
                        setLat(p.lat);
                        setLon(p.lon);
                        if (zoom === '') setZoom(Math.min(Math.max(p.zoom, 0), 19));
                      }}
                    />
                  </Suspense>
                </MapChunkBoundary>
              </Box>
            )}
          </div>
          <Stack gap="xs" data-testid="contacts-editor">
            <Text size="sm" fw={500}>
              {t('contacts.title')}
            </Text>
            {contacts.map((c, i) => (
              <Group key={i} gap="xs" align="flex-end" wrap="wrap">
                <TextInput
                  size="xs"
                  label={t('contacts.name')}
                  required
                  value={c.name}
                  onChange={(e) => setContact(i, { name: e.currentTarget.value })}
                  style={{ flex: '2 1 140px' }}
                  maxLength={200}
                />
                <TextInput
                  size="xs"
                  label={t('contacts.role')}
                  value={c.role}
                  onChange={(e) => setContact(i, { role: e.currentTarget.value })}
                  style={{ flex: '2 1 120px' }}
                  maxLength={200}
                />
                <TextInput
                  size="xs"
                  label={t('contacts.email')}
                  type="email"
                  value={c.email}
                  onChange={(e) => setContact(i, { email: e.currentTarget.value })}
                  style={{ flex: '2 1 160px' }}
                  maxLength={320}
                />
                <TextInput
                  size="xs"
                  label={t('contacts.phone')}
                  type="tel"
                  value={c.phone}
                  onChange={(e) => setContact(i, { phone: e.currentTarget.value })}
                  style={{ flex: '1 1 110px' }}
                  maxLength={60}
                />
                <ActionIcon
                  variant="subtle"
                  color="red"
                  mb={2}
                  aria-label={t('contacts.remove', { name: c.name || '–' })}
                  onClick={() => setContacts(contacts.filter((_, j) => j !== i))}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Group>
            ))}
            {v.error('contacts') && (
              <Text size="xs" c="red">
                {v.error('contacts')}
              </Text>
            )}
            <Button
              size="xs"
              variant="default"
              w="fit-content"
              leftSection={<IconPlus size={14} />}
              onClick={() => setContacts([...contacts, { name: '', role: '', email: '', phone: '', url: '' }])}
              disabled={contacts.length >= PLANT_LIMITS.contacts}
            >
              {t('contacts.add')}
            </Button>
          </Stack>
          <RefsEditor value={refs} onChange={setRefs} />
          {v.error('refs') && (
            <Text size="xs" c="red">
              {v.error('refs')}
            </Text>
          )}
          <FieldInputs type="site" values={fields} onChange={setFields} errors={shown} />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </FormModal>
  );
}

// ---------- hierarchy node ----------

const TYPES: Record<PlantLevel, readonly string[]> = { area: [], work_center: WORK_CENTER_TYPES, work_unit: WORK_UNIT_TYPES };
const PARENT: Record<PlantLevel, PlantLevel | null> = { area: null, work_center: 'area', work_unit: 'work_center' };

export function NodeFormModal({
  site,
  level,
  parentId,
  node,
  onClose,
  onSaved,
}: {
  site: PlantSiteDetail;
  level: PlantLevel;
  parentId: string | null;
  node?: PlantNode;
  onClose: () => void;
  onSaved: (s: PlantSiteDetail) => void;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const cfg = usePlantConfig();
  const type: PlantRecordType = LEVEL_RECORD_TYPE[level];
  const [name, setName] = useState(node?.name ?? '');
  const id = useIdField(node?.id);
  const [names, setNames] = useState<Translations>(node?.names ?? {});
  const [kind, setKind] = useState<string | null>(node?.type || null);
  const [domain, setDomain] = useState(node?.domain ?? '');
  const [building, setBuilding] = useState<string | null>(node?.buildingId ?? null);
  const [parent, setParent] = useState<string | null>(node?.parentId ?? parentId);
  const [description, setDescription] = useState(node?.description ?? '');
  const [fields, setFields] = useState<FieldValues>(node?.fields ?? {});
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const parents = flatNodes(site.areas).filter((n) => n.level === PARENT[level]);
  const inherited = parent ? flatNodes(site.areas).find((n) => n.id === parent)?.effectiveBuildingId : null;
  const inheritedName = inherited ? nameOf(site.buildings.find((b) => b.id === inherited)) : '';
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('form.idInvalid'),
    parent: !!PARENT[level] && !parent && t('common:validation.required'),
  });
  const save = async () => {
    setShown(true);
    if (!v.validate() || missingFields(cfg.data?.fields[type], fields)) return;
    setBusy(true);
    const body = {
      parentId: parent,
      name: name.trim(),
      names,
      type: kind ?? '',
      domain: domain.trim(),
      buildingId: building,
      description,
      fields: cleanFieldValues(fields),
    };
    const base = `/plant/sites/${encodeURIComponent(site.id)}/nodes`;
    try {
      onSaved(
        node
          ? await put<PlantSiteDetail>(`${base}/${encodeURIComponent(node.id)}`, { ...body, revision: node.revision })
          : await post<PlantSiteDetail>(base, { id: id.id, level, ...body }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <FormModal
      onClose={onClose}
      size="lg"
      title={node ? t('node.editTitle', { type: label(type, false, true), name: node.name }) : t('node.newTitle', { type: label(type, false, true) })}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            {t(`node.help.${level}`)}
          </Text>
          <TextInput
            label={t('form.name')}
            required
            data-autofocus
            maxLength={PLANT_LIMITS.name}
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              id.follow(e.currentTarget.value);
            }}
            error={v.error('name')}
          />
          <IdInput value={id.id} onChange={id.set} disabled={!!node} error={v.error('id')} />
          <TranslationsInput value={names} onChange={setNames} />
          {PARENT[level] && (
            <Select
              label={label(LEVEL_RECORD_TYPE[PARENT[level]!])}
              required
              data={parents.map((p) => ({ value: p.id, label: `${nameOf(p)} (${p.id})` }))}
              value={parent}
              onChange={setParent}
              allowDeselect={false}
              searchable
              error={v.error('parent')}
            />
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {level === 'area' ? (
              <TextInput
                label={t('node.domain')}
                description={t('node.domainHelp')}
                maxLength={60}
                value={domain}
                onChange={(e) => setDomain(e.currentTarget.value)}
              />
            ) : (
              <Select
                label={t('node.type')}
                description={t('node.typeHelp')}
                data={TYPES[level].map((x) => ({ value: x, label: t(`isaTypes.${x as 'unit'}`) }))}
                value={kind}
                onChange={setKind}
                clearable
              />
            )}
            <Select
              label={label('building')}
              description={inherited ? t('node.buildingInherits', { name: inheritedName }) : t('node.buildingHelp')}
              placeholder={inherited ? inheritedName : undefined}
              data={site.buildings.map((b) => ({ value: b.id, label: nameOf(b) }))}
              value={building}
              onChange={setBuilding}
              clearable
              searchable
            />
          </SimpleGrid>
          <Textarea
            label={t('form.description')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={PLANT_LIMITS.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <FieldInputs type={type} values={fields} onChange={setFields} errors={shown} />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </FormModal>
  );
}

// ---------- building ----------

export function BuildingFormModal({
  site,
  building,
  onClose,
  onSaved,
}: {
  site: PlantSiteDetail;
  building?: PlantBuilding;
  onClose: () => void;
  onSaved: (s: PlantSiteDetail) => void;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const cfg = usePlantConfig();
  const [name, setName] = useState(building?.name ?? '');
  const id = useIdField(building?.id);
  const [names, setNames] = useState<Translations>(building?.names ?? {});
  const [kind, setKind] = useState<BuildingKind>(building?.kind ?? 'building');
  const [parent, setParent] = useState<string | null>(building?.parentId ?? null);
  const [description, setDescription] = useState(building?.description ?? '');
  const [fields, setFields] = useState<FieldValues>(building?.fields ?? {});
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const v = useFieldErrors({ name: !name.trim() && t('common:validation.required'), id: !PLANT_ID_RE.test(id.id) && t('form.idInvalid') });
  const save = async () => {
    setShown(true);
    if (!v.validate() || missingFields(cfg.data?.fields.building, fields)) return;
    setBusy(true);
    const body = { name: name.trim(), names, kind, parentId: parent, description, fields: cleanFieldValues(fields) };
    const base = `/plant/sites/${encodeURIComponent(site.id)}/buildings`;
    try {
      onSaved(
        building
          ? await put<PlantSiteDetail>(`${base}/${encodeURIComponent(building.id)}`, { ...body, revision: building.revision })
          : await post<PlantSiteDetail>(base, { id: id.id, ...body }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <FormModal
      onClose={onClose}
      size="lg"
      title={building ? t('building.editTitle', { name: building.name }) : t('building.newTitle', { type: label('building', false, true) })}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Text size="xs" c="dimmed">
            {t('building.help')}
          </Text>
          <TextInput
            label={t('form.name')}
            required
            data-autofocus
            maxLength={PLANT_LIMITS.name}
            value={name}
            onChange={(e) => {
              setName(e.currentTarget.value);
              id.follow(e.currentTarget.value);
            }}
            error={v.error('name')}
          />
          <IdInput value={id.id} onChange={id.set} disabled={!!building} error={v.error('id')} />
          <TranslationsInput value={names} onChange={setNames} />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('building.kind')}
              data={BUILDING_KINDS.map((k) => ({ value: k, label: t(`buildingKinds.${k}`) }))}
              value={kind}
              onChange={(x) => x && setKind(x as BuildingKind)}
              allowDeselect={false}
            />
            <Select
              label={t('building.parent')}
              description={t('building.parentHelp')}
              data={site.buildings.filter((b) => b.id !== building?.id).map((b) => ({ value: b.id, label: nameOf(b) }))}
              value={parent}
              onChange={setParent}
              clearable
              searchable
            />
          </SimpleGrid>
          <Textarea
            label={t('form.description')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={PLANT_LIMITS.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <FieldInputs type="building" values={fields} onChange={setFields} errors={shown} />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </FormModal>
  );
}

// ---------- asset ----------

export function useHierarchy() {
  return useQuery({ queryKey: plantKeys.hierarchy, queryFn: () => get<PlantHierarchySite[]>('/plant/hierarchy') });
}

export function AssetFormModal({
  asset,
  defaults,
  onClose,
  onSaved,
}: {
  asset?: PlantAssetDetail;
  defaults?: { siteId?: string | null; nodeId?: string | null };
  onClose: () => void;
  onSaved: (a: PlantAssetDetail) => void;
}) {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const cfg = usePlantConfig();
  const tree = useHierarchy();
  const sites = (tree.data ?? []).filter((s) => s.canManage || s.id === asset?.siteId);
  const [name, setName] = useState(asset?.name ?? '');
  const id = useIdField(asset?.id);
  const [status, setStatus] = useState<AssetStatus>(asset?.status ?? 'operational');
  const [siteId, setSiteId] = useState<string | null>(asset?.siteId ?? defaults?.siteId ?? (sites.length === 1 ? sites[0]!.id : null));
  const site = (tree.data ?? []).find((s) => s.id === siteId);
  const nodes = useMemo(() => flatNodes(site?.areas ?? []), [site]);
  const initialNode = asset ? (asset.location.workUnit?.id ?? asset.location.workCenter?.id ?? asset.location.area?.id ?? null) : (defaults?.nodeId ?? null);
  const [nodeId, setNodeId] = useState<string | null>(initialNode);
  const [building, setBuilding] = useState<string | null>(asset?.location.buildingId ?? null);
  const [parent, setParent] = useState<string | null>(asset?.parentId ?? null);
  const [manufacturer, setManufacturer] = useState(asset?.manufacturer ?? '');
  const [model, setModel] = useState(asset?.model ?? '');
  const [domain, setDomain] = useState(asset?.domain ?? '');
  const [processArea, setProcessArea] = useState(asset?.processArea ?? '');
  const [role, setRole] = useState(asset?.role ?? '');
  const [tags, setTags] = useState<string[]>(asset?.tags ?? []);
  const [commissioned, setCommissioned] = useState(asset?.commissioned ?? '');
  const [endOfSupport, setEndOfSupport] = useState(asset?.endOfSupport ?? '');
  const [description, setDescription] = useState(asset?.description ?? '');
  const [capabilities, setCapabilities] = useState((asset?.capabilities ?? []).join('\n'));
  const [refs, setRefs] = useState<ExternalRef[]>(asset?.refs ?? []);
  const [fields, setFields] = useState<FieldValues>(asset?.fields ?? {});
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  // the possible parents: assets of the same site (not the asset itself)
  const siblings = useQuery({
    queryKey: plantKeys.assets(`site=${siteId ?? ''}`),
    queryFn: () => get<PlantAssetSummary[]>(`/plant/assets?site=${encodeURIComponent(siteId!)}`),
    enabled: !!siteId,
  });
  const node = nodes.find((n) => n.id === nodeId);
  const inherited = node?.effectiveBuildingId ? nameOf(site?.buildings.find((b) => b.id === node.effectiveBuildingId)) : '';
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('form.idInvalid'),
    site: !siteId && t('common:validation.required'),
    refs: !refsValid(refs) && t('refs.invalid'),
  });
  const levelLabel = (n: PlantNode) => label(LEVEL_RECORD_TYPE[n.level]);
  const nodeOptions = nodes.map((n) => ({
    value: n.id,
    label: `${nodePath(nodes, n, nameOf)} (${levelLabel(n)})`,
  }));
  const save = async () => {
    setShown(true);
    if (!v.validate() || missingFields(cfg.data?.fields.asset, fields)) return;
    setBusy(true);
    const level = node?.level;
    const body = {
      siteId,
      areaId: level === 'area' ? nodeId : null,
      workCenterId: level === 'work_center' ? nodeId : null,
      workUnitId: level === 'work_unit' ? nodeId : null,
      buildingId: building,
      name: name.trim(),
      manufacturer: manufacturer.trim(),
      model: model.trim(),
      status,
      parentId: parent,
      domain: domain.trim(),
      processArea: processArea.trim(),
      role: role.trim(),
      tags,
      commissioned: commissioned || null,
      endOfSupport: endOfSupport || null,
      description,
      capabilities: capabilities
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean),
      imageName: asset?.imageName ?? '',
      refs: cleanRefs(refs),
      fields: cleanFieldValues(fields),
    };
    try {
      onSaved(
        asset
          ? await draftSave(asset.canManage, () =>
              put<PlantAssetDetail>(`/plant/assets/${encodeURIComponent(asset.id)}`, { ...body, revision: asset.revision }),
            )
          : await post<PlantAssetDetail>('/plant/assets', { id: id.id, ...body }),
      );
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <FormModal
      onClose={onClose}
      size="lg"
      title={asset ? t('asset.editTitle', { name: asset.name }) : t('asset.newTitle', { type: label('asset', false, true) })}
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('form.name')}
              required
              data-autofocus
              maxLength={PLANT_LIMITS.name}
              value={name}
              onChange={(e) => {
                setName(e.currentTarget.value);
                id.follow(e.currentTarget.value);
              }}
              error={v.error('name')}
            />
            <Select
              label={t('asset.status')}
              data={ASSET_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
              value={status}
              onChange={(x) => x && setStatus(x as AssetStatus)}
              allowDeselect={false}
            />
          </SimpleGrid>
          <IdInput value={id.id} onChange={id.set} disabled={!!asset} error={v.error('id')} />
          <Text size="sm" fw={600} mt="xs">
            {t('asset.location')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={label('site')}
              required
              data={sites.map((s) => ({ value: s.id, label: s.code ? `${nameOf(s)} (${s.code})` : nameOf(s) }))}
              value={siteId}
              onChange={(x) => {
                setSiteId(x);
                if (x !== siteId) {
                  setNodeId(null);
                  setBuilding(null);
                  setParent(null);
                }
              }}
              allowDeselect={false}
              searchable
              error={v.error('site')}
            />
            <Select
              label={t('asset.place')}
              description={t('asset.placeHelp')}
              data={nodeOptions}
              value={nodeId}
              onChange={setNodeId}
              clearable
              searchable
              disabled={!site}
            />
            <Select
              label={t('asset.buildingOverride')}
              description={inherited ? t('asset.buildingInherits', { name: inherited }) : t('asset.buildingHelp')}
              placeholder={inherited || undefined}
              data={(site?.buildings ?? []).map((b) => ({ value: b.id, label: nameOf(b) }))}
              value={building}
              onChange={setBuilding}
              clearable
              searchable
              disabled={!site}
            />
            <Select
              label={t('asset.parent')}
              description={t('asset.parentHelp')}
              data={(siblings.data ?? []).filter((a) => a.id !== asset?.id).map((a) => ({ value: a.id, label: `${a.name} (${a.id})` }))}
              value={parent}
              onChange={setParent}
              clearable
              searchable
              disabled={!site}
            />
          </SimpleGrid>
          <Text size="sm" fw={600} mt="xs">
            {t('asset.details')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label={t('asset.manufacturer')} maxLength={200} value={manufacturer} onChange={(e) => setManufacturer(e.currentTarget.value)} />
            <TextInput label={t('asset.model')} maxLength={200} value={model} onChange={(e) => setModel(e.currentTarget.value)} />
            <TextInput
              label={t('asset.domain')}
              description={t('asset.domainHelp')}
              maxLength={60}
              value={domain}
              onChange={(e) => setDomain(e.currentTarget.value)}
            />
            <TextInput label={t('asset.processArea')} maxLength={60} value={processArea} onChange={(e) => setProcessArea(e.currentTarget.value)} />
            <TextInput label={t('asset.role')} description={t('asset.roleHelp')} maxLength={60} value={role} onChange={(e) => setRole(e.currentTarget.value)} />
            <TagsInput label={t('asset.tags')} value={tags} onChange={setTags} maxTags={PLANT_LIMITS.tags} clearable />
            <TextInput label={t('asset.commissioned')} type="date" value={commissioned} onChange={(e) => setCommissioned(e.currentTarget.value)} />
            <TextInput label={t('asset.endOfSupport')} type="date" value={endOfSupport} onChange={(e) => setEndOfSupport(e.currentTarget.value)} />
          </SimpleGrid>
          <Textarea
            label={t('form.description')}
            autosize
            minRows={2}
            maxRows={6}
            maxLength={PLANT_LIMITS.description}
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
          />
          <Textarea
            label={t('asset.capabilities')}
            description={t('asset.capabilitiesHelp')}
            autosize
            minRows={2}
            maxRows={8}
            value={capabilities}
            onChange={(e) => setCapabilities(e.currentTarget.value)}
          />
          <RefsEditor value={refs} onChange={setRefs} />
          {v.error('refs') && (
            <Text size="xs" c="red">
              {v.error('refs')}
            </Text>
          )}
          <FieldInputs type="asset" values={fields} onChange={setFields} errors={shown} />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </FormModal>
  );
}

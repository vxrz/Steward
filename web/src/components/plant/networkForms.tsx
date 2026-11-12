import { useState, type ReactNode } from 'react';
import {
  ActionIcon,
  Button,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  TagsInput,
  Text,
  TextInput,
  Textarea,
  Tooltip,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  ADDRESS_TYPES,
  COLLECTOR_KINDS,
  CONDUIT_DIRECTIONS,
  DESTINATION_KINDS,
  DEVICE_CONFIDENCE,
  DEVICE_FLAG_SUGGESTIONS,
  DEVICE_STATES,
  isCidr,
  isIpAddress,
  macOf,
  PEER_KINDS,
  PLANT_ID_RE,
  STATUS_CHECK_KINDS,
  TRANSFER_MODES,
  VLAN_RANGE_TYPES,
  ZONE_CRITICALITIES,
  ZONE_LEVELS,
  type MonitorDetail,
  type MonitorSummary,
  type PlantAssetNetwork,
  type PlantConduitValues,
  type PlantDataPathValues,
  type PlantDeviceValues,
  type PlantItemRef,
  type PlantSiteNetwork,
  type PlantStatusCheck,
  type PlantSubnet,
  type PlantVlanValues,
  type PlantZoneValues,
  type SecurityLevel,
  type SystemSummary,
  type ZoneLevel,
} from '@sm/shared';
import { get, notifyError, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { FormButtons, IdInput, useIdField } from './forms';
import { ItemMultiSelect, ItemSelect } from './network';
import { saveOrDraft } from './changes/common';
import { FormModal as GuardedModal } from '../FormModal';

/**
 * The forms of the OT network (#220): a VLAN with its subnets and ranges, a zone, a conduit, a device, a data path and
 * the checks that give a live status. Each saves through the plant API and hands back the network it answers with.
 */

const text = (s: string) => s.trim();
const del = <T,>(list: T[], i: number) => list.filter((_, j) => j !== i);
const at = <T,>(list: T[], i: number, x: Partial<T>) => list.map((y, j) => (j === i ? { ...y, ...x } : y));

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <ActionIcon variant="subtle" color="red" aria-label={label} onClick={onClick} mt={{ base: 0, sm: 24 }}>
        <IconTrash size={16} />
      </ActionIcon>
    </Tooltip>
  );
}

function AddButton({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }) {
  return (
    <Group>
      <Button size="compact-xs" variant="default" leftSection={<IconPlus size={12} />} onClick={onClick} data-testid={testId}>
        {children}
      </Button>
    </Group>
  );
}

function FormModal({
  title,
  onClose,
  onSubmit,
  busy,
  children,
  size = 'lg',
}: {
  title: ReactNode;
  onClose: () => void;
  onSubmit: () => void;
  busy: boolean;
  children: ReactNode;
  size?: string;
}) {
  return (
    <GuardedModal onClose={onClose} size={size} title={title}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <Stack gap="sm">
          {children}
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </GuardedModal>
  );
}

/**
 * Runs a save; closes on success, tells what went wrong otherwise. Who may only propose (`canManage` false) saves into
 * their draft (0.13.0); an answer of a save into a draft is not shown as saved – the page keeps Steward's values.
 */
function useSave<T>(onSaved: (x: T) => void, onClose: () => void, canManage = true) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    run: async (f: () => Promise<T>) => {
      setBusy(true);
      try {
        await saveOrDraft(canManage, f, onSaved);
        onClose();
      } catch (e) {
        notifyError(e);
        setBusy(false);
      }
    },
  };
}

const siteBase = (siteId: string) => `/plant/sites/${encodeURIComponent(siteId)}`;
const assetBase = (assetId: string) => `/plant/assets/${encodeURIComponent(assetId)}`;

// ---------- VLAN ----------

const EMPTY_SUBNET: PlantSubnet = { cidr: '', gateway: '', description: '', ranges: [] };

export function VlanModal({
  network,
  vlan,
  sites,
  onClose,
  onSaved,
}: {
  network: PlantSiteNetwork;
  vlan?: PlantVlanValues & { revision?: number };
  /** The other sites the reader may see (id, name) */
  sites: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (n: PlantSiteNetwork) => void;
}) {
  const { t } = useTranslation(['plantNetwork', 'plant', 'common']);
  const [name, setName] = useState(vlan?.name ?? '');
  const id = useIdField(vlan?.id);
  const [vid, setVid] = useState<number | ''>(vlan?.vid ?? '');
  const [type, setType] = useState(vlan?.type ?? '');
  const [owner, setOwner] = useState(vlan?.owner ?? '');
  const [description, setDescription] = useState(vlan?.description ?? '');
  const [subnets, setSubnets] = useState<PlantSubnet[]>(vlan?.subnets ?? []);
  const [restricted, setRestricted] = useState(vlan?.restricted ?? false);
  const [managedBy, setManagedBy] = useState(vlan?.managedBy ?? '');
  const [rulesAt, setRulesAt] = useState(vlan?.rulesAt ?? '');
  const [other, setOther] = useState<string[]>(vlan?.sites ?? []);
  const [location, setLocation] = useState(vlan?.location ?? '');
  const [segmentId, setSegmentId] = useState<string | null>(vlan?.segmentId ?? null);
  const [notes, setNotes] = useState(vlan?.notes ?? '');
  const segments = useQuery({ queryKey: ['systems', 'network'], queryFn: () => get<SystemSummary[]>('/systems') });
  const save = useSave(onSaved, onClose, network.canManage);
  const badSubnet = subnets.findIndex((s) => !isCidr(s.cidr.trim()) || (s.gateway.trim() && !isIpAddress(s.gateway.trim())));
  const badRange = subnets.some((s) => s.ranges.some((r) => !isIpAddress(r.start.trim()) || !isIpAddress(r.end.trim())));
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('plant:form.idInvalid'),
    vid: vid !== '' && (vid < 1 || vid > 4094) && t('vlan.vidInvalid'),
    subnets: (badSubnet >= 0 || badRange) && t('vlan.subnetInvalid'),
  });
  const submit = () => {
    if (!v.validate()) return;
    const body = {
      name: text(name),
      vid: vid === '' ? null : vid,
      type: text(type),
      owner: text(owner),
      description,
      subnets: subnets.map((s) => ({
        cidr: text(s.cidr),
        gateway: text(s.gateway),
        description: text(s.description),
        ranges: s.ranges.map((r) => ({ ...r, start: text(r.start), end: text(r.end) })),
      })),
      restricted,
      managedBy: text(managedBy),
      rulesAt: text(rulesAt),
      sites: other,
      location: text(location),
      segmentId,
      notes,
    };
    const base = `${siteBase(network.site.id)}/vlans`;
    void save.run(() =>
      vlan
        ? put<PlantSiteNetwork>(`${base}/${encodeURIComponent(vlan.id)}`, { ...body, revision: vlan.revision })
        : post<PlantSiteNetwork>(base, { id: id.id, ...body }),
    );
  };
  const segmentOptions = (segments.data ?? []).filter((s) => s.kind === 'network').map((s) => ({ value: s.id, label: s.name }));
  if (segmentId && !segmentOptions.some((o) => o.value === segmentId)) segmentOptions.unshift({ value: segmentId, label: segmentId });
  return (
    <FormModal title={vlan ? t('vlan.editTitle', { name: vlan.name }) : t('vlan.newTitle')} onClose={onClose} onSubmit={submit} busy={save.busy}>
      <Text size="xs" c="dimmed">
        {t('vlan.formHelp')}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('plant:form.name')}
          required
          data-autofocus
          value={name}
          maxLength={200}
          onChange={(e) => {
            setName(e.currentTarget.value);
            id.follow(e.currentTarget.value);
          }}
          error={v.error('name')}
        />
        <NumberInput
          label={t('vlan.vid')}
          description={t('vlan.vidHelp')}
          min={1}
          max={4094}
          allowDecimal={false}
          value={vid}
          onChange={(x) => setVid(typeof x === 'number' ? x : '')}
          error={v.error('vid')}
        />
      </SimpleGrid>
      <IdInput value={id.id} onChange={id.set} disabled={!!vlan} error={v.error('id')} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label={t('vlan.type')} description={t('vlan.typeHelp')} value={type} maxLength={60} onChange={(e) => setType(e.currentTarget.value)} />
        <TextInput label={t('owner')} value={owner} maxLength={200} onChange={(e) => setOwner(e.currentTarget.value)} />
        <TextInput label={t('vlan.managedBy')} value={managedBy} maxLength={200} onChange={(e) => setManagedBy(e.currentTarget.value)} />
        <TextInput label={t('vlan.location')} value={location} maxLength={200} onChange={(e) => setLocation(e.currentTarget.value)} />
      </SimpleGrid>
      <TextInput
        label={t('vlan.rulesAt')}
        description={t('vlan.rulesAtHelp')}
        value={rulesAt}
        maxLength={2000}
        onChange={(e) => setRulesAt(e.currentTarget.value)}
      />
      <Switch
        label={t('vlan.restricted')}
        description={t('vlan.restrictedHelp')}
        checked={restricted}
        onChange={(e) => setRestricted(e.currentTarget.checked)}
      />
      <Stack gap={6} data-testid="vlan-subnets">
        <Text size="sm" fw={500}>
          {t('vlan.subnets')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('vlan.subnetsHelp')}
        </Text>
        {subnets.map((s, i) => (
          <Paper key={i} withBorder p="xs">
            <Stack gap={6}>
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <SimpleGrid cols={{ base: 1, sm: 2 }} style={{ flex: 1 }}>
                  <TextInput
                    label={t('vlan.cidr')}
                    placeholder="10.20.110.0/24"
                    classNames={{ input: 'mono' }}
                    value={s.cidr}
                    onChange={(e) => setSubnets(at(subnets, i, { cidr: e.currentTarget.value }))}
                    error={v.error('subnets') && !isCidr(s.cidr.trim()) ? t('vlan.cidrInvalid') : undefined}
                  />
                  <TextInput
                    label={t('vlan.gateway')}
                    placeholder="10.20.110.1"
                    classNames={{ input: 'mono' }}
                    value={s.gateway}
                    onChange={(e) => setSubnets(at(subnets, i, { gateway: e.currentTarget.value }))}
                    error={v.error('subnets') && s.gateway.trim() && !isIpAddress(s.gateway.trim()) ? t('addressInvalid') : undefined}
                  />
                </SimpleGrid>
                <RemoveButton label={t('vlan.removeSubnet', { cidr: s.cidr || i + 1 })} onClick={() => setSubnets(del(subnets, i))} />
              </Group>
              {s.ranges.map((r, j) => (
                <Group key={j} gap="xs" align="flex-start" wrap="nowrap">
                  <SimpleGrid cols={{ base: 1, sm: 3 }} style={{ flex: 1 }}>
                    <TextInput
                      label={t('vlan.rangeStart')}
                      size="xs"
                      classNames={{ input: 'mono' }}
                      value={r.start}
                      onChange={(e) => setSubnets(at(subnets, i, { ranges: at(s.ranges, j, { start: e.currentTarget.value }) }))}
                    />
                    <TextInput
                      label={t('vlan.rangeEnd')}
                      size="xs"
                      classNames={{ input: 'mono' }}
                      value={r.end}
                      onChange={(e) => setSubnets(at(subnets, i, { ranges: at(s.ranges, j, { end: e.currentTarget.value }) }))}
                    />
                    <Select
                      label={t('vlan.rangeType')}
                      size="xs"
                      data={VLAN_RANGE_TYPES.map((x) => ({ value: x, label: t(`rangeTypes.${x}`) }))}
                      value={r.type}
                      allowDeselect={false}
                      onChange={(x) => x && setSubnets(at(subnets, i, { ranges: at(s.ranges, j, { type: x as (typeof VLAN_RANGE_TYPES)[number] }) }))}
                    />
                  </SimpleGrid>
                  <RemoveButton label={t('vlan.removeRange')} onClick={() => setSubnets(at(subnets, i, { ranges: del(s.ranges, j) }))} />
                </Group>
              ))}
              <AddButton onClick={() => setSubnets(at(subnets, i, { ranges: [...s.ranges, { start: '', end: '', type: 'static', notes: '' }] }))}>
                {t('vlan.addRange')}
              </AddButton>
            </Stack>
          </Paper>
        ))}
        {v.error('subnets') && (
          <Text size="xs" c="red">
            {v.error('subnets')}
          </Text>
        )}
        <AddButton onClick={() => setSubnets([...subnets, { ...EMPTY_SUBNET }])} testId="add-subnet">
          {t('vlan.addSubnet')}
        </AddButton>
      </Stack>
      <Select
        label={t('vlan.segment')}
        description={t('vlan.segmentHelp')}
        data={segmentOptions}
        value={segmentId}
        onChange={setSegmentId}
        searchable
        clearable
        nothingFoundMessage={t('vlan.noSegments')}
      />
      <MultiSelect
        label={t('vlan.otherSites')}
        description={t('vlan.otherSitesHelp')}
        data={sites.filter((x) => x.id !== network.site.id).map((x) => ({ value: x.id, label: x.name }))}
        value={other}
        onChange={setOther}
        searchable
        clearable
      />
      <Textarea
        label={t('plant:form.description')}
        autosize
        minRows={2}
        maxRows={6}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea label={t('notes')} autosize minRows={2} maxRows={6} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

/** "Create segment from this VLAN": a network segment in the system catalogue, linked to the VLAN. */
export function SegmentModal({
  siteId,
  vlan,
  onClose,
  onSaved,
}: {
  siteId: string;
  vlan: PlantVlanValues;
  onClose: () => void;
  onSaved: (n: PlantSiteNetwork) => void;
}) {
  const { t } = useTranslation(['plantNetwork', 'common']);
  const [name, setName] = useState(vlan.name);
  const save = useSave(onSaved, onClose);
  const v = useFieldErrors({ name: !name.trim() && t('common:validation.required') });
  return (
    <FormModal
      title={t('segment.title', { name: vlan.name })}
      size="md"
      onClose={onClose}
      busy={save.busy}
      onSubmit={() =>
        v.validate() && void save.run(() => post<PlantSiteNetwork>(`${siteBase(siteId)}/vlans/${encodeURIComponent(vlan.id)}/segment`, { name: name.trim() }))
      }
    >
      <Text size="sm">{t('segment.help', { vid: vlan.vid ?? '–', subnets: vlan.subnets.map((s) => s.cidr).join(', ') || '–' })}</Text>
      <TextInput
        label={t('segment.name')}
        required
        data-autofocus
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.currentTarget.value)}
        error={v.error('name')}
      />
    </FormModal>
  );
}

// ---------- zone and conduit ----------

export function ZoneModal({
  network,
  zone,
  onClose,
  onSaved,
}: {
  network: PlantSiteNetwork;
  /** The zone as the reader sees it: `items` names its systems and platforms, `hiddenItems` counts the others */
  zone?: PlantZoneValues & { revision?: number; items?: PlantItemRef[]; hiddenItems?: number };
  onClose: () => void;
  onSaved: (n: PlantSiteNetwork) => void;
}) {
  const { t } = useTranslation(['plantNetwork', 'plant', 'common']);
  const [name, setName] = useState(zone?.name ?? '');
  const id = useIdField(zone?.id);
  const [description, setDescription] = useState(zone?.description ?? '');
  const [criticality, setCriticality] = useState<string | null>(zone?.criticality ?? null);
  const [level, setLevel] = useState<string | null>(zone?.level ?? null);
  const [vlans, setVlans] = useState<string[]>(zone?.vlans ?? []);
  const [systems, setSystems] = useState<string[]>(zone?.systems ?? []);
  const [platforms, setPlatforms] = useState<string[]>(zone?.platforms ?? []);
  const known = (zone?.items ?? []).map((x) => ({ id: x.id, label: x.label }));
  const [owner, setOwner] = useState(zone?.owner ?? '');
  const [sl, setSl] = useState<string | null>(zone?.slTarget ? String(zone.slTarget) : null);
  const [assessment, setAssessment] = useState(zone?.riskAssessment ?? '');
  const [assessedAt, setAssessedAt] = useState(zone?.assessedAt ?? '');
  const [notes, setNotes] = useState(zone?.notes ?? '');
  const save = useSave(onSaved, onClose, network.canManage);
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('plant:form.idInvalid'),
    assessment: !!sl && !assessment.trim() && t('zone.assessmentRequired'),
  });
  const submit = () => {
    if (!v.validate()) return;
    const body = {
      name: text(name),
      description,
      criticality,
      level: level as ZoneLevel | null,
      vlans,
      // those the reader may not see are not sent: the server keeps them
      systems,
      platforms,
      owner: text(owner),
      slTarget: sl ? (Number(sl) as SecurityLevel) : null,
      riskAssessment: text(assessment),
      assessedAt: assessedAt || null,
      notes,
    };
    const base = `${siteBase(network.site.id)}/zones`;
    void save.run(() =>
      zone
        ? put<PlantSiteNetwork>(`${base}/${encodeURIComponent(zone.id)}`, { ...body, revision: zone.revision })
        : post<PlantSiteNetwork>(base, { id: id.id, ...body }),
    );
  };
  return (
    <FormModal title={zone ? t('zone.editTitle', { name: zone.name }) : t('zone.newTitle')} onClose={onClose} onSubmit={submit} busy={save.busy}>
      <Text size="xs" c="dimmed">
        {t('zone.formHelp')}
      </Text>
      <TextInput
        label={t('plant:form.name')}
        required
        data-autofocus
        value={name}
        maxLength={200}
        onChange={(e) => {
          setName(e.currentTarget.value);
          id.follow(e.currentTarget.value);
        }}
        error={v.error('name')}
      />
      <IdInput value={id.id} onChange={id.set} disabled={!!zone} error={v.error('id')} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select
          label={t('zone.criticality')}
          description={t('zone.criticalityHelp')}
          data={ZONE_CRITICALITIES.map((x) => ({ value: x, label: t(`criticality.${x}`) }))}
          value={criticality}
          onChange={setCriticality}
          clearable
        />
        <Select
          label={t('zone.level')}
          description={t('zone.levelHelp')}
          data={ZONE_LEVELS.map((x) => ({ value: x, label: t(`levels.${x}`) }))}
          value={level}
          onChange={setLevel}
          clearable
          placeholder={t('zone.levelDerived')}
          data-testid="zone-level"
        />
      </SimpleGrid>
      <TextInput label={t('owner')} value={owner} maxLength={200} onChange={(e) => setOwner(e.currentTarget.value)} />
      <MultiSelect
        label={t('zone.vlans')}
        data={network.vlans.map((x) => ({ value: x.id, label: x.vid ? `${x.name} (VID ${x.vid})` : x.name }))}
        value={vlans}
        onChange={setVlans}
        searchable
        clearable
      />
      {/* 0.20: Steward systems and platforms in the zone – cloud services, enterprise systems without a VLAN of the site */}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <ItemMultiSelect
          kind="system"
          label={t('zone.systems')}
          description={t('zone.systemsHelp')}
          value={systems}
          onChange={setSystems}
          known={known}
          testId="zone-systems"
        />
        <ItemMultiSelect
          kind="platform"
          label={t('zone.platforms')}
          description={t('zone.platformsHelp')}
          value={platforms}
          onChange={setPlatforms}
          known={known}
          testId="zone-platforms"
        />
      </SimpleGrid>
      {!!zone?.hiddenItems && (
        <Text size="xs" c="dimmed" data-testid="zone-hidden-items">
          {t('zone.hiddenItemsKept', { count: zone.hiddenItems })}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Select
          label={t('zone.slTarget')}
          description={t('zone.slTargetHelp')}
          data={[1, 2, 3, 4].map((x) => ({ value: String(x), label: t('zone.sl', { level: x }) }))}
          value={sl}
          onChange={setSl}
          clearable
          placeholder={t('zone.slOpen')}
        />
        <TextInput
          label={t('zone.riskAssessment')}
          description={t('zone.riskAssessmentHelp')}
          value={assessment}
          maxLength={500}
          onChange={(e) => setAssessment(e.currentTarget.value)}
          error={v.error('assessment')}
          required={!!sl}
        />
        <TextInput label={t('zone.assessedAt')} type="date" value={assessedAt} onChange={(e) => setAssessedAt(e.currentTarget.value)} />
      </SimpleGrid>
      <Textarea
        label={t('plant:form.description')}
        autosize
        minRows={2}
        maxRows={6}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea label={t('notes')} autosize minRows={2} maxRows={6} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

export function ConduitModal({
  network,
  conduit,
  onClose,
  onSaved,
}: {
  network: PlantSiteNetwork;
  conduit?: PlantConduitValues & { revision?: number };
  onClose: () => void;
  onSaved: (n: PlantSiteNetwork) => void;
}) {
  const { t } = useTranslation(['plantNetwork', 'plant', 'common']);
  const [name, setName] = useState(conduit?.name ?? '');
  const id = useIdField(conduit?.id);
  const [a, setA] = useState<string | null>(conduit?.zones[0] ?? null);
  const [b, setB] = useState<string | null>(conduit?.zones[1] ?? null);
  const [direction, setDirection] = useState<string>(conduit?.direction ?? 'both');
  const [protocols, setProtocols] = useState<string[]>(conduit?.protocols ?? []);
  const [controls, setControls] = useState<string[]>(conduit?.controls ?? []);
  const [description, setDescription] = useState(conduit?.description ?? '');
  const [notes, setNotes] = useState(conduit?.notes ?? '');
  const save = useSave(onSaved, onClose, network.canManage);
  const zoneName = (z: string | null) => network.zones.find((x) => x.id === z)?.name ?? z ?? '…';
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('plant:form.idInvalid'),
    a: !a && t('common:validation.required'),
    b: (!b && t('common:validation.required')) || (a === b && t('conduit.sameZone')),
  });
  const zones = network.zones.map((z) => ({ value: z.id, label: z.name }));
  const submit = () => {
    if (!v.validate()) return;
    const body = { name: text(name), description, zones: [a!, b!], direction, protocols, controls, notes };
    const base = `${siteBase(network.site.id)}/conduits`;
    void save.run(() =>
      conduit
        ? put<PlantSiteNetwork>(`${base}/${encodeURIComponent(conduit.id)}`, { ...body, revision: conduit.revision })
        : post<PlantSiteNetwork>(base, { id: id.id, ...body }),
    );
  };
  return (
    <FormModal title={conduit ? t('conduit.editTitle', { name: conduit.name }) : t('conduit.newTitle')} onClose={onClose} onSubmit={submit} busy={save.busy}>
      <Text size="xs" c="dimmed">
        {t('conduit.formHelp')}
      </Text>
      <TextInput
        label={t('plant:form.name')}
        required
        data-autofocus
        value={name}
        maxLength={200}
        onChange={(e) => {
          setName(e.currentTarget.value);
          id.follow(e.currentTarget.value);
        }}
        error={v.error('name')}
      />
      <IdInput value={id.id} onChange={id.set} disabled={!!conduit} error={v.error('id')} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label={t('conduit.zoneA')} required data={zones} value={a} onChange={setA} searchable error={v.error('a')} />
        <Select label={t('conduit.zoneB')} required data={zones} value={b} onChange={setB} searchable error={v.error('b')} />
      </SimpleGrid>
      <Select
        label={t('conduit.direction')}
        data={CONDUIT_DIRECTIONS.map((x) => ({ value: x, label: t(`directions.${x}`, { a: zoneName(a), b: zoneName(b) }) }))}
        value={direction}
        onChange={(x) => x && setDirection(x)}
        allowDeselect={false}
      />
      <TagsInput label={t('conduit.protocols')} description={t('conduit.protocolsHelp')} value={protocols} onChange={setProtocols} maxTags={30} clearable />
      <TagsInput label={t('conduit.controls')} description={t('conduit.controlsHelp')} value={controls} onChange={setControls} maxTags={30} clearable />
      <Textarea
        label={t('plant:form.description')}
        autosize
        minRows={2}
        maxRows={6}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea label={t('notes')} autosize minRows={2} maxRows={6} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

// ---------- checks ----------

const EMPTY_CHECK: PlantStatusCheck = { kind: 'monitor', ref: '', check: '', column: '', value: '', timeColumn: '', maxAgeMinutes: null, note: '' };

function MonitorCheckSelect({ monitor, value, onChange }: { monitor: string; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation('plantNetwork');
  const q = useQuery({ queryKey: ['monitor', monitor], queryFn: () => get<MonitorDetail>(`/monitors/${encodeURIComponent(monitor)}`), enabled: !!monitor });
  const options = (q.data?.checks ?? []).map((c) => ({ value: c.checkId, label: `${c.name} (${c.key})` }));
  if (value && !options.some((o) => o.value === value)) options.unshift({ value, label: value });
  return (
    <Select
      label={t('checks.check')}
      description={t('checks.checkHelp')}
      data={options}
      value={value || null}
      onChange={(x) => onChange(x ?? '')}
      clearable
      searchable
      placeholder={t('checks.wholeMonitor')}
    />
  );
}

/** The checks that give a live status: monitors (or one of their checks) and dataset freshness. */
export function ChecksEditor({ value, onChange }: { value: PlantStatusCheck[]; onChange: (v: PlantStatusCheck[]) => void }) {
  const { t } = useTranslation('plantNetwork');
  const monitors = useQuery({ queryKey: ['monitors', 'list'], queryFn: () => get<MonitorSummary[]>('/monitors') });
  const monitorOptions = (monitors.data ?? []).filter((m) => !m.isTemplate).map((m) => ({ value: m.key, label: `${m.name} (${m.key})` }));
  return (
    <Stack gap={6} data-testid="checks-editor">
      <Text size="sm" fw={500}>
        {t('checks.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('checks.help')}
      </Text>
      {value.map((c, i) => {
        // a check the reader may not see: it is kept as it is (sent back by its slot) or removed, never changed
        if (c.hiddenSlot !== undefined)
          return (
            <Paper key={i} withBorder p="xs" data-testid="hidden-check">
              <Group gap="xs" align="center" wrap="nowrap" justify="space-between">
                <Text size="sm" c="dimmed" style={{ minWidth: 0 }}>
                  {t('checks.hidden')}
                </Text>
                <RemoveButton label={t('checks.remove')} onClick={() => onChange(del(value, i))} />
              </Group>
            </Paper>
          );
        const set = (x: Partial<PlantStatusCheck>) => onChange(at(value, i, x));
        const options = c.ref && !monitorOptions.some((o) => o.value === c.ref) ? [{ value: c.ref, label: c.ref }, ...monitorOptions] : monitorOptions;
        return (
          <Paper key={i} withBorder p="xs">
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <Select
                    label={t('checks.kind')}
                    data={STATUS_CHECK_KINDS.map((k) => ({ value: k, label: t(`checkKinds.${k}`) }))}
                    value={c.kind}
                    allowDeselect={false}
                    onChange={(k) => k && onChange(at(value, i, { ...EMPTY_CHECK, kind: k as PlantStatusCheck['kind'] }))}
                  />
                  {c.kind === 'monitor' ? (
                    <Select
                      label={t('checks.monitor')}
                      data={options}
                      value={c.ref || null}
                      onChange={(x) => set({ ref: x ?? '', check: '' })}
                      searchable
                      required
                      nothingFoundMessage={t('checks.noMonitors')}
                    />
                  ) : (
                    <TextInput
                      label={t('checks.dataset')}
                      description={t('checks.datasetHelp')}
                      classNames={{ input: 'mono' }}
                      value={c.ref}
                      required
                      onChange={(e) => set({ ref: e.currentTarget.value })}
                    />
                  )}
                </SimpleGrid>
                {c.kind === 'monitor' && c.ref && <MonitorCheckSelect monitor={c.ref} value={c.check} onChange={(x) => set({ check: x })} />}
                {c.kind === 'dataset' && (
                  <SimpleGrid cols={{ base: 1, sm: 2 }}>
                    <TextInput label={t('checks.column')} value={c.column} onChange={(e) => set({ column: e.currentTarget.value })} />
                    <TextInput label={t('checks.value')} value={c.value} onChange={(e) => set({ value: e.currentTarget.value })} />
                    <TextInput
                      label={t('checks.timeColumn')}
                      description={t('checks.timeColumnHelp')}
                      value={c.timeColumn}
                      onChange={(e) => set({ timeColumn: e.currentTarget.value })}
                    />
                    <NumberInput
                      label={t('checks.maxAge')}
                      description={t('checks.maxAgeHelp')}
                      min={1}
                      allowDecimal={false}
                      value={c.maxAgeMinutes ?? ''}
                      onChange={(x) => set({ maxAgeMinutes: typeof x === 'number' ? x : null })}
                    />
                  </SimpleGrid>
                )}
              </Stack>
              <RemoveButton label={t('checks.remove')} onClick={() => onChange(del(value, i))} />
            </Group>
          </Paper>
        );
      })}
      <AddButton onClick={() => onChange([...value, { ...EMPTY_CHECK }])} testId="add-check">
        {t('checks.add')}
      </AddButton>
    </Stack>
  );
}

const cleanChecks = (list: PlantStatusCheck[]) =>
  list
    .filter((c) => c.hiddenSlot !== undefined || c.ref.trim())
    .map((c) =>
      c.hiddenSlot !== undefined ? c : { ...c, ref: c.ref.trim(), column: c.column.trim(), value: c.value.trim(), timeColumn: c.timeColumn.trim() },
    );

export function AssetChecksModal({
  assetId,
  checks,
  canManage = true,
  onClose,
  onSaved,
}: {
  assetId: string;
  checks: PlantStatusCheck[];
  /** false: who may only propose – the checks go into their draft */
  canManage?: boolean;
  onClose: () => void;
  onSaved: (n: PlantAssetNetwork) => void;
}) {
  const { t } = useTranslation('plantNetwork');
  const [value, setValue] = useState(checks);
  const save = useSave(onSaved, onClose, canManage);
  return (
    <FormModal
      title={t('checks.assetTitle')}
      onClose={onClose}
      busy={save.busy}
      onSubmit={() => void save.run(() => put<PlantAssetNetwork>(`${assetBase(assetId)}/checks`, { checks: cleanChecks(value) }))}
    >
      <ChecksEditor value={value} onChange={setValue} />
    </FormModal>
  );
}

// ---------- device ----------

export function DeviceModal({
  network,
  device,
  onClose,
  onSaved,
}: {
  network: PlantAssetNetwork;
  device?: PlantDeviceValues & { revision?: number };
  onClose: () => void;
  onSaved: (n: PlantAssetNetwork) => void;
}) {
  const { t } = useTranslation(['plantNetwork', 'plant', 'common']);
  const [d, setD] = useState<PlantDeviceValues>(
    device ?? {
      id: '',
      hostname: '',
      domain: '',
      purpose: '',
      mac: '',
      serial: '',
      vlan: null,
      addressType: null,
      address: '',
      switch: '',
      switchPort: '',
      wallOutlet: '',
      cmdbPort: '',
      state: 'active',
      flags: [],
      confidence: null,
      owner: '',
      monitoring: '',
      checks: [],
      notes: '',
    },
  );
  const id = useIdField(device?.id);
  const set = (x: Partial<PlantDeviceValues>) => setD({ ...d, ...x });
  const save = useSave(onSaved, onClose, network.canManage);
  const v = useFieldErrors({
    id: !PLANT_ID_RE.test(id.id) && t('plant:form.idInvalid'),
    mac: !!d.mac.trim() && !macOf(d.mac) && t('device.macInvalid'),
    address: !!d.address.trim() && !isIpAddress(d.address.trim()) && t('addressInvalid'),
    flags: d.flags.some((f) => !/^[a-z][a-z0-9_]{0,39}$/.test(f)) && t('device.flagInvalid'),
  });
  const submit = () => {
    if (!v.validate()) return;
    const { id: _id, ...rest } = d;
    const body = {
      ...rest,
      hostname: text(d.hostname),
      domain: text(d.domain),
      mac: d.mac.trim() ? macOf(d.mac)! : '',
      address: text(d.address),
      checks: cleanChecks(d.checks),
    };
    const base = `${assetBase(network.asset.id)}/devices`;
    void save.run(() =>
      device
        ? put<PlantAssetNetwork>(`${base}/${encodeURIComponent(device.id)}`, { ...body, revision: device.revision })
        : post<PlantAssetNetwork>(base, { id: id.id, ...body }),
    );
  };
  const input = (k: keyof PlantDeviceValues, label: string, opts: { mono?: boolean; max?: number; placeholder?: string; error?: string } = {}) => (
    <TextInput
      label={label}
      value={String(d[k] ?? '')}
      maxLength={opts.max ?? 200}
      placeholder={opts.placeholder}
      classNames={opts.mono ? { input: 'mono' } : undefined}
      error={opts.error}
      onChange={(e) => set({ [k]: e.currentTarget.value } as Partial<PlantDeviceValues>)}
    />
  );
  return (
    <FormModal
      title={device ? t('device.editTitle', { name: device.hostname || device.id }) : t('device.newTitle')}
      onClose={onClose}
      onSubmit={submit}
      busy={save.busy}
      size="xl"
    >
      <Text size="xs" c="dimmed">
        {t('device.formHelp')}
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput
          label={t('device.hostname')}
          data-autofocus
          value={d.hostname}
          maxLength={253}
          classNames={{ input: 'mono' }}
          onChange={(e) => {
            set({ hostname: e.currentTarget.value });
            id.follow(e.currentTarget.value);
          }}
        />
        {input('domain', t('device.domain'), { mono: true, max: 253, placeholder: 'ot.example.com' })}
      </SimpleGrid>
      <IdInput value={id.id} onChange={id.set} disabled={!!device} error={v.error('id')} />
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {input('purpose', t('device.purpose'))}
        {input('serial', t('device.serial'), { mono: true })}
        {input('mac', t('device.mac'), { mono: true, max: 20, placeholder: '00-00-5E-00-53-01', error: v.error('mac') })}
        <Select
          label={t('device.vlan')}
          data={network.vlans.map((x) => ({ value: x.id, label: x.vid ? `${x.name} (VID ${x.vid})` : x.name }))}
          value={d.vlan}
          onChange={(x) => set({ vlan: x })}
          clearable
          searchable
          nothingFoundMessage={t('device.noVlans')}
        />
        <Select
          label={t('device.addressType')}
          data={ADDRESS_TYPES.map((x) => ({ value: x, label: t(`addressTypes.${x}`) }))}
          value={d.addressType}
          onChange={(x) => set({ addressType: x as PlantDeviceValues['addressType'] })}
          clearable
        />
        {input('address', t('device.address'), { mono: true, max: 45, placeholder: '10.20.110.21', error: v.error('address') })}
        {input('switch', t('device.switch'), { mono: true })}
        {input('switchPort', t('device.switchPort'), { mono: true, max: 100 })}
        {input('wallOutlet', t('device.wallOutlet'), { mono: true, max: 100 })}
        {input('cmdbPort', t('device.cmdbPort'), { mono: true })}
        <Select
          label={t('device.state')}
          data={DEVICE_STATES.map((x) => ({ value: x, label: t(`deviceStates.${x}`) }))}
          value={d.state}
          onChange={(x) => x && set({ state: x as PlantDeviceValues['state'] })}
          allowDeselect={false}
        />
        <Select
          label={t('device.confidence')}
          description={t('device.confidenceHelp')}
          data={DEVICE_CONFIDENCE.map((x) => ({ value: x, label: t(`confidence.${x}`) }))}
          value={d.confidence}
          onChange={(x) => set({ confidence: x as PlantDeviceValues['confidence'] })}
          clearable
        />
        {input('owner', t('owner'))}
        {input('monitoring', t('device.monitoring'), { max: 500 })}
      </SimpleGrid>
      <TagsInput
        label={t('device.flags')}
        description={t('device.flagsHelp')}
        data={[...DEVICE_FLAG_SUGGESTIONS]}
        value={d.flags}
        onChange={(x) =>
          set({
            flags: x.map((f) =>
              f
                .trim()
                .toLowerCase()
                .replace(/[\s-]+/g, '_'),
            ),
          })
        }
        maxTags={20}
        clearable
        error={v.error('flags')}
      />
      <ChecksEditor value={d.checks} onChange={(checks) => set({ checks })} />
      <Textarea label={t('notes')} autosize minRows={2} maxRows={6} value={d.notes} onChange={(e) => set({ notes: e.currentTarget.value })} />
    </FormModal>
  );
}

// ---------- data path ----------

const COLLECTOR_LINK = { application: 'application', platform: 'platform', process: 'process' } as const;

export function DataPathModal({
  network,
  path,
  onClose,
  onSaved,
}: {
  network: PlantAssetNetwork;
  path?: PlantDataPathValues & { revision?: number };
  onClose: () => void;
  onSaved: (n: PlantAssetNetwork) => void;
}) {
  const { t } = useTranslation(['plantNetwork', 'plant', 'common']);
  const [subject, setSubject] = useState(path?.subject ?? '');
  const id = useIdField(path?.id);
  const [description, setDescription] = useState(path?.description ?? '');
  const [devices, setDevices] = useState<string[]>(path?.devices ?? []);
  const [collector, setCollector] = useState<PlantDataPathValues['collector']>(path?.collector ?? null);
  const [transfers, setTransfers] = useState<PlantDataPathValues['transfers']>(path?.transfers ?? []);
  const [destinations, setDestinations] = useState<PlantDataPathValues['destinations']>(path?.destinations ?? []);
  const [notes, setNotes] = useState(path?.notes ?? '');
  const save = useSave(onSaved, onClose, network.canManage);
  const view = network.dataPaths.find((x) => x.id === path?.id);
  // what the form shows for a Steward item it loaded: its name, or "not visible" – never the name of one the reader may not see
  const keepOf = (ref: PlantItemRef | null | undefined) => (ref ? { id: ref.id, label: ref.visible ? ref.label : t('notVisible') } : null);
  const v = useFieldErrors({
    subject: !subject.trim() && t('common:validation.required'),
    id: !PLANT_ID_RE.test(id.id) && t('plant:form.idInvalid'),
    collector: !!collector && !collector.ref.trim() && t('common:validation.required'),
    transfers: transfers.some((x) => !x.protocol.trim() || (x.peerKind !== 'other' && !x.peer)) && t('path.transferIncomplete'),
    destinations: destinations.some((x) => !x.ref.trim()) && t('path.destinationIncomplete'),
  });
  const deviceOptions = network.devices.map((x) => ({ value: x.id, label: x.hostname ? `${x.hostname} (${x.id})` : x.id }));
  const submit = () => {
    if (!v.validate()) return;
    const body = {
      subject: text(subject),
      description,
      devices,
      collector: collector ? { ...collector, ref: collector.ref.trim() } : null,
      transfers: transfers.map((x) => ({ ...x, protocol: x.protocol.trim(), peer: x.peer.trim() })),
      destinations: destinations.map((x) => ({ ...x, ref: x.ref.trim(), path: x.path.trim() })),
      notes,
    };
    const base = `${assetBase(network.asset.id)}/paths`;
    void save.run(() =>
      path
        ? put<PlantAssetNetwork>(`${base}/${encodeURIComponent(path.id)}`, { ...body, revision: path.revision })
        : post<PlantAssetNetwork>(base, { id: id.id, ...body }),
    );
  };
  return (
    <FormModal title={path ? t('path.editTitle', { name: path.subject }) : t('path.newTitle')} onClose={onClose} onSubmit={submit} busy={save.busy} size="xl">
      <Text size="xs" c="dimmed">
        {t('path.formHelp')}
      </Text>
      <TextInput
        label={t('path.subject')}
        description={t('path.subjectHelp')}
        required
        data-autofocus
        value={subject}
        maxLength={200}
        onChange={(e) => {
          setSubject(e.currentTarget.value);
          id.follow(e.currentTarget.value);
        }}
        error={v.error('subject')}
      />
      <IdInput value={id.id} onChange={id.set} disabled={!!path} error={v.error('id')} />
      <MultiSelect
        label={t('path.devices')}
        data={deviceOptions}
        value={devices}
        onChange={setDevices}
        searchable
        clearable
        nothingFoundMessage={t('path.noDevices')}
      />
      <Stack gap={6} data-testid="path-collector">
        <Text size="sm" fw={500}>
          {t('path.collector')}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Select
            label={t('path.collectorKind')}
            data={COLLECTOR_KINDS.map((k) => ({ value: k, label: t(`collectorKinds.${k}`) }))}
            value={collector?.kind ?? null}
            onChange={(k) => setCollector(k ? { kind: k as (typeof COLLECTOR_KINDS)[number], ref: '', host: collector?.host ?? null } : null)}
            clearable
            placeholder={t('path.noCollector')}
          />
          {collector &&
            (collector.kind === 'job' ? (
              <TextInput
                label={t('path.jobName')}
                required
                value={collector.ref}
                onChange={(e) => setCollector({ ...collector, ref: e.currentTarget.value })}
                error={v.error('collector')}
              />
            ) : (
              <ItemSelect
                kind={COLLECTOR_LINK[collector.kind]}
                label={t(`collectorKinds.${collector.kind}`)}
                value={collector.ref || null}
                keep={keepOf(view?.collectorRef)}
                onChange={(x) => setCollector({ ...collector, ref: x ?? '' })}
                required
                error={v.error('collector')}
              />
            ))}
          {collector && (
            <ItemSelect
              kind="system"
              label={t('path.host')}
              description={t('path.hostHelp')}
              value={collector.host}
              keep={keepOf(view?.collectorHost)}
              onChange={(x) => setCollector({ ...collector, host: x })}
            />
          )}
        </SimpleGrid>
      </Stack>
      <Stack gap={6} data-testid="path-transfers">
        <Text size="sm" fw={500}>
          {t('path.transfers')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('path.transfersHelp')}
        </Text>
        {transfers.map((x, i) => (
          <Paper key={i} withBorder p="xs">
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <SimpleGrid cols={{ base: 1, sm: 3 }} style={{ flex: 1, minWidth: 0 }}>
                <TextInput
                  label={t('path.protocol')}
                  placeholder="opc-ua"
                  required
                  value={x.protocol}
                  maxLength={60}
                  onChange={(e) => setTransfers(at(transfers, i, { protocol: e.currentTarget.value }))}
                />
                <Select
                  label={t('path.mode')}
                  description={t(`modeHelp.${x.mode}`)}
                  data={TRANSFER_MODES.map((m) => ({ value: m, label: t(`modes.${m}`) }))}
                  value={x.mode}
                  allowDeselect={false}
                  renderOption={({ option }) => (
                    <Stack gap={0}>
                      <Text size="sm">{option.label}</Text>
                      <Text size="xs" c="dimmed">
                        {t(`modeHelp.${option.value as (typeof TRANSFER_MODES)[number]}`)}
                      </Text>
                    </Stack>
                  )}
                  onChange={(m) => m && setTransfers(at(transfers, i, { mode: m as (typeof TRANSFER_MODES)[number] }))}
                />
                <NumberInput
                  label={t('path.port')}
                  min={1}
                  max={65535}
                  allowDecimal={false}
                  value={x.port ?? ''}
                  onChange={(p) => setTransfers(at(transfers, i, { port: typeof p === 'number' ? p : null }))}
                />
                <Select
                  label={t('path.peerKind')}
                  data={PEER_KINDS.map((k) => ({ value: k, label: t(`peerKinds.${k}`) }))}
                  value={x.peerKind}
                  allowDeselect={false}
                  onChange={(k) => k && setTransfers(at(transfers, i, { peerKind: k as (typeof PEER_KINDS)[number], peer: '' }))}
                />
                {x.peerKind === 'device' ? (
                  <Select
                    label={t('path.peer')}
                    data={deviceOptions}
                    value={x.peer || null}
                    onChange={(p) => setTransfers(at(transfers, i, { peer: p ?? '' }))}
                    required
                  />
                ) : x.peerKind === 'system' || x.peerKind === 'application' || x.peerKind === 'platform' ? (
                  <ItemSelect
                    kind={x.peerKind}
                    label={t('path.peer')}
                    value={x.peer || null}
                    keep={keepOf(view?.peers[i])}
                    onChange={(p) => setTransfers(at(transfers, i, { peer: p ?? '' }))}
                    required
                  />
                ) : (
                  <TextInput
                    label={t('path.peer')}
                    value={x.peer}
                    maxLength={200}
                    onChange={(e) => setTransfers(at(transfers, i, { peer: e.currentTarget.value }))}
                  />
                )}
              </SimpleGrid>
              <RemoveButton label={t('path.removeTransfer')} onClick={() => setTransfers(del(transfers, i))} />
            </Group>
            {/* pushing to or pulling from the collector's own host is usually a service on it that is a system of its own */}
            {x.peerKind === 'system' && x.mode !== 'receive' && !!x.peer && x.peer === collector?.host && (
              <Text size="xs" c="dimmed" mt={4} data-testid="peer-is-host">
                {t('path.peerIsHost')}
              </Text>
            )}
          </Paper>
        ))}
        {v.error('transfers') && (
          <Text size="xs" c="red">
            {v.error('transfers')}
          </Text>
        )}
        <AddButton onClick={() => setTransfers([...transfers, { protocol: '', mode: 'pull', peerKind: 'other', peer: '', port: null, notes: '' }])}>
          {t('path.addTransfer')}
        </AddButton>
      </Stack>
      <Stack gap={6} data-testid="path-destinations">
        <Text size="sm" fw={500}>
          {t('path.destinations')}
        </Text>
        {destinations.map((x, i) => (
          <Paper key={i} withBorder p="xs">
            <Group gap="xs" align="flex-start" wrap="nowrap">
              <SimpleGrid cols={{ base: 1, sm: 3 }} style={{ flex: 1, minWidth: 0 }}>
                <Select
                  label={t('path.destinationKind')}
                  data={DESTINATION_KINDS.map((k) => ({ value: k, label: t(`destinationKinds.${k}`) }))}
                  value={x.kind}
                  allowDeselect={false}
                  onChange={(k) => k && setDestinations(at(destinations, i, { kind: k as (typeof DESTINATION_KINDS)[number], ref: '' }))}
                />
                {x.kind === 'system' || x.kind === 'application' || x.kind === 'platform' ? (
                  <ItemSelect
                    kind={x.kind}
                    label={t('path.destination')}
                    value={x.ref || null}
                    keep={keepOf(view?.targets[i])}
                    onChange={(r) => setDestinations(at(destinations, i, { ref: r ?? '' }))}
                    required
                  />
                ) : (
                  <TextInput
                    label={x.kind === 'dataset' ? t('checks.dataset') : t('path.destination')}
                    classNames={x.kind === 'dataset' ? { input: 'mono' } : undefined}
                    value={x.ref}
                    required
                    maxLength={200}
                    onChange={(e) => setDestinations(at(destinations, i, { ref: e.currentTarget.value }))}
                  />
                )}
                <TextInput
                  label={t('path.where')}
                  description={t('path.whereHelp')}
                  classNames={{ input: 'mono' }}
                  value={x.path}
                  maxLength={500}
                  onChange={(e) => setDestinations(at(destinations, i, { path: e.currentTarget.value }))}
                />
              </SimpleGrid>
              <RemoveButton label={t('path.removeDestination')} onClick={() => setDestinations(del(destinations, i))} />
            </Group>
          </Paper>
        ))}
        {v.error('destinations') && (
          <Text size="xs" c="red">
            {v.error('destinations')}
          </Text>
        )}
        <AddButton onClick={() => setDestinations([...destinations, { kind: 'other', ref: '', path: '', notes: '' }])}>{t('path.addDestination')}</AddButton>
      </Stack>
      <Textarea
        label={t('plant:form.description')}
        autosize
        minRows={2}
        maxRows={6}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />
      <Textarea label={t('notes')} autosize minRows={2} maxRows={6} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
    </FormModal>
  );
}

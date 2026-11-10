import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Anchor, Button, Group, Modal, Paper, Select, Stack, Text, TextInput, VisuallyHidden } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconArrowsMove, IconDevices, IconPlus, IconRoute, IconSearch } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DEVICE_STATES,
  ipValue,
  type PlantAssetNetwork,
  type PlantDataPathValues,
  type PlantDataPathView,
  type PlantDataQualityHint,
  type PlantDeviceRef,
  type PlantDeviceValues,
  type PlantDeviceView,
  type PlantSiteNetwork,
} from '@sm/shared';
import { del, get, notifyError } from '../../api';
import { EmptyState, QueryState } from '../common';
import { confirmDanger } from '../confirm';
import { DataTable, type DataColumn } from '../DataTable';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { useMediaQuery } from '@mantine/hooks';
import { plantKeys } from '../../queryKeys';
import { NotInSourceBadge, usePlantLabel } from './common';
import { RowMenu } from './data';
import { BulkBar, SelectAllBox, SelectBox, useSelection } from './bulk';
import { anyWatched, LiveBadge, NotWatchedHint } from './network';
import { DataPathModal, DeviceModal } from './networkForms';
import { DataPathSummary, DeviceHints, deviceValues, pathValues } from './AssetNetwork';
import { FormButtons } from './forms';
import { Tokens } from './Tokens';
import { saveOrDraft } from './changes/common';
import { DeviceMenuItems, DuplicateDeviceModal, MoveEntriesModal, type MoveItem } from './MoveEntries';

/**
 * The site's Devices and Data paths tabs (0.12, docs/PLANT.md#editing-in-place): sortable and filtered lists with a
 * count, quieter rows for devices not in use, and – for who manages the site – Add (with the asset to add it to), Edit
 * and Remove per row with the asset's own forms, and "Change selected" for devices (the bulk change with its preview;
 * data paths have none). The data quality hints of the site sit above the devices.
 */

const keyOf = (x: { assetId: string; id: string }) => `${x.assetId}/${x.id}`;
const deviceRowId = (x: { assetId: string; id: string }) => `device-${x.assetId}-${x.id}`;
const ALL = '';
const NO_VLAN = '__none__';

// ---------- editing: the asset's forms, opened from the site ----------

type Edit =
  | { kind: 'pick'; what: 'device' | 'path' }
  | { kind: 'device'; assetId: string; device?: PlantDeviceValues }
  | { kind: 'path'; assetId: string; path?: PlantDataPathValues }
  // 0.16: devices to another asset; a copy of a device
  | { kind: 'move'; items: MoveItem[] }
  | { kind: 'duplicate'; assetId: string; device: { id: string; name: string } };

/** Opens the device and data path forms of an asset from the site's lists, and removes entries (confirmed). */
export function useSiteNetworkEdit(n: PlantSiteNetwork) {
  const { t } = useTranslation('plantNetwork');
  const qc = useQueryClient();
  const [edit, setEdit] = useState<Edit | null>(null);
  const done = (x: PlantAssetNetwork) => {
    qc.setQueryData(plantKeys.assetNetwork(x.asset.id), x);
    void qc.invalidateQueries({ queryKey: ['plant', 'network'] });
  };
  const remove = async (what: 'devices' | 'paths', assetId: string, id: string, name: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t(what === 'devices' ? 'device.removeConfirm' : 'path.removeConfirm', { name }) }))) return;
    try {
      await saveOrDraft(n.canManage, () => del<PlantAssetNetwork>(`/plant/assets/${encodeURIComponent(assetId)}/${what}/${encodeURIComponent(id)}`), done);
    } catch (e) {
      notifyError(e);
    }
  };
  // with one asset there is nothing to choose
  const add = (what: 'device' | 'path') =>
    setEdit(
      n.assets.length === 1
        ? what === 'device'
          ? { kind: 'device', assetId: n.assets[0]!.id }
          : { kind: 'path', assetId: n.assets[0]!.id }
        : { kind: 'pick', what },
    );
  const modals =
    edit &&
    (edit.kind === 'move' ? (
      <MoveEntriesModal kind="device" items={edit.items} siteId={n.site.id} onClose={() => setEdit(null)} />
    ) : edit.kind === 'duplicate' ? (
      <DuplicateDeviceModal assetId={edit.assetId} siteId={n.site.id} device={edit.device} onClose={() => setEdit(null)} onSaved={done} />
    ) : edit.kind === 'pick' ? (
      <PickAssetModal
        n={n}
        what={edit.what}
        onClose={() => setEdit(null)}
        onPick={(assetId) => setEdit(edit.what === 'device' ? { kind: 'device', assetId } : { kind: 'path', assetId })}
      />
    ) : (
      <AssetFormLoader edit={edit} onClose={() => setEdit(null)} onSaved={done} />
    ));
  return {
    // 0.13.0: who may only propose edits here too – what they save goes into their draft
    can: n.canManage || !!n.canPropose,
    add,
    editDevice: (d: PlantDeviceView) => setEdit({ kind: 'device', assetId: d.assetId, device: deviceValues(d) }),
    editPath: (p: PlantDataPathView) => setEdit({ kind: 'path', assetId: p.assetId, path: pathValues(p) }),
    removeDevice: (d: PlantDeviceView) => void remove('devices', d.assetId, d.id, d.hostname || d.id),
    moveDevices: (items: MoveItem[]) => setEdit({ kind: 'move', items }),
    duplicateDevice: (d: PlantDeviceView) => setEdit({ kind: 'duplicate', assetId: d.assetId, device: { id: d.id, name: d.hostname || d.id } }),
    removePath: (p: PlantDataPathView) => void remove('paths', p.assetId, p.id, p.subject),
    modals,
  };
}
export type SiteNetworkEdit = ReturnType<typeof useSiteNetworkEdit>;

/** The asset a new device or data path belongs to. */
function PickAssetModal({
  n,
  what,
  onClose,
  onPick,
}: {
  n: PlantSiteNetwork;
  what: 'device' | 'path';
  onClose: () => void;
  onPick: (assetId: string) => void;
}) {
  const { t } = useTranslation('plantNetwork');
  const label = usePlantLabel();
  const [assetId, setAssetId] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  return (
    <Modal opened onClose={onClose} title={what === 'device' ? t('device.newTitle') : t('path.newTitle')} size="md">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setShown(true);
          if (assetId) onPick(assetId);
        }}
        data-testid="pick-asset"
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('site.pickHelp', { type: label('asset', false, true) })}
          </Text>
          <Select
            label={label('asset')}
            data={n.assets.map((a) => ({ value: a.id, label: a.name }))}
            value={assetId}
            onChange={setAssetId}
            searchable
            required
            data-autofocus
            nothingFoundMessage="–"
            error={shown && !assetId ? t('site.pickRequired', { type: label('asset', false, true) }) : undefined}
            comboboxProps={{ withinPortal: true }}
            data-testid="pick-asset-select"
          />
          <FormButtons busy={false} onClose={onClose} />
        </Stack>
      </form>
    </Modal>
  );
}

/** Loads the asset's network (its VLANs and devices for the form), then shows the device or data path form. */
function AssetFormLoader({
  edit,
  onClose,
  onSaved,
}: {
  edit: Extract<Edit, { kind: 'device' | 'path' }>;
  onClose: () => void;
  onSaved: (x: PlantAssetNetwork) => void;
}) {
  const { t } = useTranslation('plantNetwork');
  const q = useQuery({
    queryKey: plantKeys.assetNetwork(edit.assetId),
    queryFn: () => get<PlantAssetNetwork>(`/plant/assets/${encodeURIComponent(edit.assetId)}/network`),
  });
  if (!q.data)
    return (
      <Modal opened onClose={onClose} title={edit.kind === 'device' ? t('device.newTitle') : t('path.newTitle')}>
        <QueryState query={q} rows={3} />
      </Modal>
    );
  return edit.kind === 'device' ? (
    <DeviceModal network={q.data} device={edit.device} onClose={onClose} onSaved={onSaved} />
  ) : (
    <DataPathModal network={q.data} path={edit.path} onClose={onClose} onSaved={onSaved} />
  );
}

/** "Add device" / "Add data path" for who manages the site (a site without assets has nothing to add them to). */
function AddButton({ n, edit, what, testId }: { n: PlantSiteNetwork; edit: SiteNetworkEdit; what: 'device' | 'path'; testId: string }) {
  const { t } = useTranslation('plantNetwork');
  if (!edit.can || !n.assets.length) return null;
  return (
    <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => edit.add(what)} data-testid={testId}>
      {what === 'device' ? t('device.add') : t('path.add')}
    </Button>
  );
}

// ---------- the lists ----------

function Filters({ children }: { children: ReactNode }) {
  return (
    <Group gap="xs" wrap="wrap" align="flex-end">
      {children}
    </Group>
  );
}

/** An IP address as text that sorts by its value (IPv4 before IPv6). */
const addressSort = (a: string) => {
  const v = a ? ipValue(a) : null;
  return v ? `${v.v}:${v.n.toString(16).padStart(32, '0')}` : a || null;
};

function Address({ d }: { d: PlantDeviceView }) {
  const { t } = useTranslation('plantNetwork');
  // no address but a type: the type alone ("Dynamic (DHCP)"), not "–" and the type
  if (!d.address) return d.addressType ? <Text size="sm">{t(`addressTypes.${d.addressType}`)}</Text> : <>–</>;
  return (
    <>
      <Text size="sm" className="mono">
        {d.address}
      </Text>
      {d.addressType && (
        <Text size="xs" c="dimmed">
          {t(`addressTypes.${d.addressType}`)}
        </Text>
      )}
    </>
  );
}

function StateText({ d }: { d: PlantDeviceView }) {
  const { t } = useTranslation('plantNetwork');
  return (
    <Text size="sm" data-testid="device-state" fs={d.state === 'active' ? undefined : 'italic'}>
      {t(`deviceStates.${d.state}`)}
    </Text>
  );
}

/** The devices of every asset of the site, with the data quality hints above them. */
export function SiteDevices({ n, edit, narrow }: { n: PlantSiteNetwork; edit: SiteNetworkEdit; narrow: boolean }) {
  const { t } = useTranslation(['plantNetwork', 'common']);
  const { t: tp } = useTranslation('plant');
  const label = usePlantLabel();
  const [search, setSearch] = useState('');
  const [vlan, setVlan] = useState(ALL);
  const [state, setState] = useState(ALL);
  const [asset, setAsset] = useState(ALL);
  const [target, setTarget] = useState<string | null>(null);
  const vlanName = (id: string | null) => (id ? (n.vlans.find((v) => v.id === id)?.name ?? id) : '–');
  const s = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      n.devices.filter(
        (d) =>
          (!s || [d.id, d.hostname, d.address, d.mac, d.assetName, d.switch, d.switchPort].some((x) => x.toLowerCase().includes(s))) &&
          (vlan === ALL || (vlan === NO_VLAN ? !d.vlan : d.vlan === vlan)) &&
          (state === ALL || d.state === state) &&
          (asset === ALL || d.assetId === asset),
      ),
    [n.devices, s, vlan, state, asset],
  );
  const keys = shown.map(keyOf);
  const sel = useSelection(keys);
  const watched = anyWatched(n.devices);
  const filtered = shown.length !== n.devices.length;
  // a hint's device: every filter off, the row shown, scrolled to and focused
  const show = (r: PlantDeviceRef) => {
    setSearch('');
    setVlan(ALL);
    setState(ALL);
    setAsset(ALL);
    setTarget(keyOf({ assetId: r.assetId, id: r.deviceId }));
  };
  useEffect(() => {
    if (!target) return;
    const [assetId, id] = target.split('/') as [string, string];
    const el = document.getElementById(deviceRowId({ assetId, id }));
    el?.scrollIntoView({ block: 'center' });
    el?.focus({ preventScroll: true });
  }, [target]);
  const menu = (d: PlantDeviceView) =>
    edit.can && (
      <RowMenu
        label={t('device.actions', { name: d.hostname || d.id })}
        onEdit={() => edit.editDevice(d)}
        onRemove={() => edit.removeDevice(d)}
        extra={
          <DeviceMenuItems
            onMove={() => edit.moveDevices([{ asset: d.assetId, id: d.id, name: d.hostname || d.id }])}
            onDuplicate={() => edit.duplicateDevice(d)}
          />
        }
      />
    );
  const columns: DataColumn<PlantDeviceView>[] = [
    ...(edit.can
      ? [
          {
            key: 'select',
            header: <SelectAllBox sel={sel} ids={keys} />,
            label: t('device.select'),
            cell: (d: PlantDeviceView) => <SelectBox sel={sel} id={keyOf(d)} name={d.hostname || d.id} />,
          },
        ]
      : []),
    {
      key: 'hostname',
      header: t('device.hostname'),
      nowrap: true,
      sortValue: (d) => d.hostname || d.id,
      cell: (d) => (
        <>
          <Text size="sm" fw={500} className="mono">
            {d.hostname || d.id}
          </Text>
          {d.notInSource && <NotInSourceBadge size="xs" />}
          <DeviceHints device={d} />
        </>
      ),
    },
    {
      key: 'asset',
      header: label('asset'),
      sortValue: (d) => d.assetName,
      cell: (d) => (
        <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(d.assetId)}`} size="sm">
          {d.assetName}
        </Anchor>
      ),
    },
    { key: 'address', header: t('device.address'), nowrap: true, sortValue: (d) => addressSort(d.address), cell: (d) => <Address d={d} /> },
    {
      key: 'mac',
      header: t('device.mac'),
      nowrap: true,
      sortValue: (d) => d.mac,
      cell: (d) => (
        <Text size="sm" className="mono">
          {d.mac || '–'}
        </Text>
      ),
    },
    { key: 'vlan', header: t('device.vlan'), nowrap: true, sortValue: (d) => (d.vlan ? vlanName(d.vlan) : null), cell: (d) => vlanName(d.vlan) },
    {
      key: 'port',
      header: t('device.port'),
      nowrap: true,
      sortValue: (d) => [d.switch, d.switchPort].filter(Boolean).join(' ') || null,
      cell: (d) => (
        <Text size="sm" className="mono">
          {[d.switch, d.switchPort].filter(Boolean).join(' · ') || '–'}
        </Text>
      ),
    },
    { key: 'state', header: t('device.state'), nowrap: true, sortValue: (d) => DEVICE_STATES.indexOf(d.state), cell: (d) => <StateText d={d} /> },
    ...(watched
      ? [
          {
            key: 'live',
            header: t('overview.live'),
            nowrap: true,
            sortValue: (d: PlantDeviceView) => (d.live.watched ? d.live.state : null),
            cell: (d: PlantDeviceView) => <LiveBadge live={d.live} size="xs" />,
          },
        ]
      : []),
    ...(edit.can ? [{ key: 'actions', header: <VisuallyHidden>{t('actions')}</VisuallyHidden>, label: t('actions'), cell: menu }] : []),
  ];
  const card = (d: PlantDeviceView) => (
    <Paper
      withBorder
      p="sm"
      id={deviceRowId(d)}
      tabIndex={-1}
      data-testid={`site-device-${d.id}`}
      className={d.state === 'inactive' || d.state === 'retired' ? 'card-quiet' : undefined}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
          {edit.can && <SelectBox sel={sel} id={keyOf(d)} name={d.hostname || d.id} />}
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} className="mono" style={{ overflowWrap: 'anywhere' }}>
              {d.hostname || d.id}
            </Text>
            <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(d.assetId)}`} size="xs">
              {d.assetName}
            </Anchor>
            <Text size="xs" className="mono">
              <Tokens values={[d.address || (d.addressType ? t(`addressTypes.${d.addressType}`) : ''), d.mac]} empty="–" />
            </Text>
            <Text size="xs" c="dimmed">
              <Tokens values={[d.vlan ? vlanName(d.vlan) : '', [d.switch, d.switchPort].filter(Boolean).join(' ')]} />
            </Text>
            {d.state !== 'active' && <StateText d={d} />}
            <DeviceHints device={d} />
          </Stack>
        </Group>
        <Group gap={4} wrap="nowrap" style={{ flex: 'none' }}>
          {watched && <LiveBadge live={d.live} size="xs" />}
          {menu(d)}
        </Group>
      </Group>
    </Paper>
  );
  return (
    <Stack gap="sm">
      <DataQualitySection n={n} onShow={show} />
      {n.devices.length === 0 ? (
        <EmptyState
          icon={IconDevices}
          title={t('device.emptyTitle')}
          whoCanAct={edit.can ? undefined : t('whoCanAct')}
          action={<AddButton n={n} edit={edit} what="device" testId="add-site-device-empty" />}
        >
          {t('device.emptyText', { type: label('asset', false, true) })}
        </EmptyState>
      ) : (
        <>
          <Filters>
            <TextInput
              size="xs"
              leftSection={<IconSearch size={14} aria-hidden />}
              placeholder={t('device.search')}
              aria-label={t('device.search')}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              w={260}
              type="search"
            />
            <Select
              size="xs"
              aria-label={t('device.vlan')}
              data={[
                { value: ALL, label: t('device.allVlans') },
                { value: NO_VLAN, label: t('device.noVlan') },
                ...n.vlans.map((v) => ({ value: v.id, label: v.vid !== null ? `${v.name} (VID ${v.vid})` : v.name })),
              ]}
              value={vlan}
              onChange={(v) => setVlan(v ?? ALL)}
              allowDeselect={false}
              searchable
              w={200}
              data-testid="filter-vlan"
            />
            <Select
              size="xs"
              aria-label={t('device.state')}
              data={[{ value: ALL, label: t('device.allStates') }, ...DEVICE_STATES.map((x) => ({ value: x, label: t(`deviceStates.${x}`) }))]}
              value={state}
              onChange={(v) => setState(v ?? ALL)}
              allowDeselect={false}
              w={160}
              data-testid="filter-state"
            />
            <Select
              size="xs"
              aria-label={label('asset')}
              data={[
                { value: ALL, label: t('device.allAssets', { type: label('asset', true, true) }) },
                ...n.assets.map((a) => ({ value: a.id, label: a.name })),
              ]}
              value={asset}
              onChange={(v) => setAsset(v ?? ALL)}
              allowDeselect={false}
              searchable
              w={200}
              data-testid="filter-asset"
            />
          </Filters>
          <Text size="xs" c="dimmed" aria-live="polite" data-testid="device-count">
            {filtered ? t('device.countOf', { count: n.devices.length, shown: shown.length }) : t('device.count', { count: n.devices.length })}
          </Text>
          {!watched && <NotWatchedHint />}
          {edit.can && shown.length > 0 && (
            <BulkBar
              kind="device"
              sel={sel}
              visible={keys}
              selectAll={narrow}
              entries={shown.map((d) => ({ id: d.id, scope: d.assetId, key: keyOf(d), name: d.hostname || d.id }))}
              extra={(chosen) => (
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconArrowsMove size={14} />}
                  disabled={!chosen.length}
                  onClick={() => edit.moveDevices(chosen.map((c) => ({ asset: c.scope!, id: c.id, name: c.name })))}
                  data-testid="bulk-move-devices"
                >
                  {tp('moveEntries.menu', { type: label('asset', false, true) })}
                </Button>
              )}
            />
          )}
          {shown.length === 0 ? (
            <Text size="sm" c="dimmed">
              {t('device.noMatch')}
            </Text>
          ) : (
            <DataTable
              rows={shown}
              columns={columns}
              rowKey={keyOf}
              ariaLabel={t('device.title')}
              card={card}
              rememberSort="plant-site-devices"
              testId="site-devices"
              rowProps={(d) => ({
                id: deviceRowId(d),
                tabIndex: -1,
                'data-testid': `site-device-${d.id}`,
                'data-state': d.state,
                className:
                  [d.state === 'inactive' || d.state === 'retired' ? 'row-quiet' : '', target === keyOf(d) ? 'row-target' : ''].join(' ').trim() || undefined,
              })}
            />
          )}
        </>
      )}
    </Stack>
  );
}

/** What a hint says, from its kind. */
function hintText(t: (k: string, o?: Record<string, unknown>) => string, h: PlantDataQualityHint): string {
  return t(`quality.kinds.${h.kind}`, { value: h.value, variants: h.variants.join(' / '), count: h.devices.length });
}

const HINT_DEVICES = 20;

/**
 * "Data quality (N)": what looks wrong in the documentation of the site's devices – open when there is something,
 * folded when all is well (docs/reviews/UX-REVIEW.md, "v0.12.0: collapsible content"). Each device leads to its row.
 */
export function DataQualitySection({ n, onShow }: { n: PlantSiteNetwork; onShow: (r: PlantDeviceRef) => void }) {
  const { t } = useTranslation('plantNetwork');
  const hints = n.dataQuality;
  if (!n.devices.length && !hints.length) return null;
  return (
    <CollapsibleSection
      id="data-quality"
      title={t('quality.title')}
      count={hints.length}
      tone={hints.length ? 'warning' : undefined}
      defaultOpen={hints.length > 0}
      description={t('quality.help')}
      variant="card"
    >
      {hints.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('quality.none')}
        </Text>
      ) : (
        <Stack gap="xs" component="ul" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {hints.map((h) => (
            <li key={`${h.kind}:${h.value}`} data-testid={`quality-${h.kind}`}>
              <Text size="sm" fw={500}>
                {hintText(t as never, h)}
              </Text>
              <Group gap={6} wrap="wrap" style={{ rowGap: 2 }}>
                {h.devices.slice(0, HINT_DEVICES).map((d) => (
                  <Text key={`${d.assetId}/${d.deviceId}`} size="xs" component="span">
                    <Anchor component="button" type="button" size="xs" className="mono" onClick={() => onShow(d)} data-testid="quality-device">
                      {d.hostname || d.deviceId}
                    </Anchor>{' '}
                    <Text span size="xs" c="dimmed">
                      (
                      <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(d.assetId)}`} size="xs">
                        {d.assetName}
                      </Anchor>
                      )
                    </Text>
                  </Text>
                ))}
                {h.devices.length > HINT_DEVICES && (
                  <Text size="xs" c="dimmed">
                    {t('path.chainMore', { count: h.devices.length - HINT_DEVICES })}
                  </Text>
                )}
              </Group>
            </li>
          ))}
        </Stack>
      )}
    </CollapsibleSection>
  );
}

/** The data paths of every asset of the site. */
export function SitePaths({ n, edit }: { n: PlantSiteNetwork; edit: SiteNetworkEdit }) {
  const { t } = useTranslation('plantNetwork');
  const label = usePlantLabel();
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [search, setSearch] = useState('');
  const [asset, setAsset] = useState(ALL);
  const s = search.trim().toLowerCase();
  const shown = n.dataPaths.filter(
    (p) =>
      (!s ||
        [p.id, p.subject, p.description, p.assetName, p.collectorRef?.label ?? '', ...p.transfers.map((x) => x.protocol)].some((x) =>
          x.toLowerCase().includes(s),
        )) &&
      (asset === ALL || p.assetId === asset),
  );
  const menu = (p: PlantDataPathView) =>
    edit.can && <RowMenu label={t('path.actions', { name: p.subject })} onEdit={() => edit.editPath(p)} onRemove={() => edit.removePath(p)} />;
  const columns: DataColumn<PlantDataPathView>[] = [
    {
      key: 'subject',
      header: t('path.subject'),
      sortValue: (p) => p.subject,
      cell: (p) => (
        <>
          <Text size="sm" fw={500}>
            {p.subject}
          </Text>
          <Text size="xs" c="dimmed" className="mono nowrap">
            {p.id}
          </Text>
          {p.notInSource && <NotInSourceBadge size="xs" />}
        </>
      ),
    },
    {
      key: 'asset',
      header: label('asset'),
      sortValue: (p) => p.assetName,
      cell: (p) => (
        <Anchor component={Link} to={`/plant/assets/${encodeURIComponent(p.assetId)}`} size="sm">
          {p.assetName}
        </Anchor>
      ),
    },
    {
      key: 'devices',
      header: t('path.devices'),
      sortValue: (p) => p.devices.join(' ') || null,
      cell: (p) =>
        p.devices.length ? (
          <Stack gap={0}>
            {p.devices.map((d) => (
              <Text key={d} size="sm" className="mono nowrap">
                {d}
              </Text>
            ))}
          </Stack>
        ) : (
          '–'
        ),
    },
    { key: 'how', header: t('path.how'), cell: (p) => <DataPathSummary path={{ ...p, description: '' }} /> },
    ...(edit.can ? [{ key: 'actions', header: <VisuallyHidden>{t('actions')}</VisuallyHidden>, label: t('actions'), cell: menu }] : []),
  ];
  const card = (p: PlantDataPathView) => (
    <Paper withBorder p="sm" data-testid={`site-path-${p.id}`}>
      <Group justify="space-between" wrap="nowrap" gap="xs" align="flex-start">
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Text size="sm" fw={600}>
            {p.subject}
          </Text>
          <DataPathSummary path={p} withAsset />
        </Stack>
        {menu(p)}
      </Group>
    </Paper>
  );
  if (!n.dataPaths.length)
    return (
      <EmptyState
        icon={IconRoute}
        title={t('path.emptyTitle')}
        whoCanAct={edit.can ? undefined : t('whoCanAct')}
        action={<AddButton n={n} edit={edit} what="path" testId="add-site-path-empty" />}
      >
        {t('path.emptyText', { type: label('asset', false, true) })}
      </EmptyState>
    );
  return (
    <Stack gap="sm">
      <Filters>
        <TextInput
          size="xs"
          leftSection={<IconSearch size={14} aria-hidden />}
          placeholder={t('path.search')}
          aria-label={t('path.search')}
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          w={260}
          type="search"
        />
        <Select
          size="xs"
          aria-label={label('asset')}
          data={[{ value: ALL, label: t('device.allAssets', { type: label('asset', true, true) }) }, ...n.assets.map((a) => ({ value: a.id, label: a.name }))]}
          value={asset}
          onChange={(v) => setAsset(v ?? ALL)}
          allowDeselect={false}
          searchable
          w={200}
          data-testid="filter-path-asset"
        />
      </Filters>
      <Text size="xs" c="dimmed" aria-live="polite" data-testid="path-count">
        {shown.length !== n.dataPaths.length
          ? t('path.countOf', { count: n.dataPaths.length, shown: shown.length })
          : t('path.count', { count: n.dataPaths.length })}
      </Text>
      {shown.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('path.noMatch')}
        </Text>
      ) : (
        <DataTable
          rows={shown}
          columns={columns}
          rowKey={keyOf}
          ariaLabel={t('path.title')}
          card={narrow ? card : undefined}
          rememberSort="plant-site-paths"
          testId="site-paths"
          verticalSpacing="xs"
          rowProps={(p) => ({ id: `path-${p.assetId}-${p.id}`, 'data-testid': `site-path-${p.id}`, style: { verticalAlign: 'top' } })}
        />
      )}
    </Stack>
  );
}

export { AddButton as SiteNetworkAddButton };

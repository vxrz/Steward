import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, Group, Modal, Paper, Select, SimpleGrid, Stack, Table, TagsInput, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconEdit, IconGitPullRequest, IconShieldLock, IconTrash } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ASSET_STATUSES,
  DEVICE_CONFIDENCE,
  DEVICE_FLAG_SUGGESTIONS,
  DEVICE_STATES,
  PLANT_BULK_FIELDS,
  type PlantBulkItem,
  type PlantBulkKind,
  type PlantBulkResult,
  type PlantBulkSet,
  type PlantChangeSetDetail,
  type PlantChangeSetSummary,
  type PlantProfileSummary,
} from '@sm/shared';
import { get, notifyError, notifyOk, post } from '../../api';
import { plantKeys } from '../../queryKeys';
import { useNameOf, usePlantConfig } from './common';
import { useChangeSetConfig } from './changes/common';
import { flatNodes, nodePath, useHierarchy } from './forms';
import { useCountsText, useProblemText } from './ids';

/**
 * Changing or removing many plant entries at once from the lists (0.11.0, docs/PLANT.md#changing-many-entries-at-once):
 * a selection (a checkbox per row or card, "select all shown"), the bar with Edit selected and Remove selected, and
 * the dialog that previews what changes, what is skipped and what is refused before anything is applied.
 */

export interface Selection {
  ids: Set<string>;
  has: (id: string) => boolean;
  toggle: (id: string) => void;
  setAll: (ids: string[], on: boolean) => void;
  clear: () => void;
}

/** The selected entries of a list; ids that leave the list (a filter, a removal) leave the selection. */
export function useSelection(visible: string[]): Selection {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const key = visible.join('\n');
  useEffect(() => {
    setIds((cur) => {
      const keep = new Set(visible);
      const next = new Set([...cur].filter((x) => keep.has(x)));
      return next.size === cur.size ? cur : next;
    });
    // visible is compared by its text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return {
    ids,
    has: (id) => ids.has(id),
    toggle: (id) =>
      setIds((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    setAll: (list, on) => setIds((cur) => (on ? new Set([...cur, ...list]) : new Set([...cur].filter((x) => !list.includes(x))))),
    clear: () => setIds(new Set()),
  };
}

/** The checkbox of a row or card. */
export function SelectBox({ sel, id, name }: { sel: Selection; id: string; name: string }) {
  const { t } = useTranslation('plantIds');
  return (
    <Checkbox
      size="sm"
      aria-label={t('bulk.selectRow', { name })}
      checked={sel.has(id)}
      onChange={() => sel.toggle(id)}
      onClick={(e) => e.stopPropagation()}
      data-testid={`select-${id}`}
    />
  );
}

/** The "select all shown" checkbox of a table header. */
export function SelectAllBox({ sel, ids }: { sel: Selection; ids: string[] }) {
  const { t } = useTranslation('plantIds');
  const on = ids.length > 0 && ids.every((x) => sel.has(x));
  const some = ids.some((x) => sel.has(x));
  return (
    <Checkbox
      size="sm"
      aria-label={t('bulk.selectAll')}
      checked={on}
      indeterminate={some && !on}
      onChange={() => sel.setAll(ids, !on)}
      data-testid="select-all"
    />
  );
}

export interface BulkEntry {
  id: string;
  scope?: string;
  /** The key of its selection when the id alone is not unique (a device: `<asset>/<device>`); default the id */
  key?: string;
  name: string;
  /** The site of an asset (building and place need one site) */
  siteId?: string;
}

/**
 * The bar above a list while entries are selected, with the dialog. `selectAll` is shown for card views (a table has
 * its own checkbox in the header).
 */
export function BulkBar({
  kind,
  sel,
  entries,
  visible,
  canEdit = true,
  selectAll = true,
}: {
  kind: PlantBulkKind;
  sel: Selection;
  entries: BulkEntry[];
  /** The ids shown (for "select all shown") */
  visible: string[];
  canEdit?: boolean;
  /** Its own "select all shown" (card views; a table has one in its header) */
  selectAll?: boolean;
}) {
  const { t } = useTranslation('plantIds');
  const [open, setOpen] = useState<'edit' | 'remove' | null>(null);
  const chosen = entries.filter((e) => sel.has(e.key ?? e.id));
  const editable = canEdit && PLANT_BULK_FIELDS[kind].length > 0;
  return (
    <>
      <Paper withBorder p="xs" mb="sm" data-testid="bulk-bar">
        <Group gap="sm" wrap="wrap" justify="space-between">
          <Group gap="sm" wrap="wrap">
            {selectAll && <SelectAllBox sel={sel} ids={visible} />}
            <Text size="sm" aria-live="polite">
              {t('bulk.selected', { count: chosen.length })}
            </Text>
            {chosen.length > 0 && (
              <Button size="compact-xs" variant="subtle" onClick={sel.clear}>
                {t('bulk.clear')}
              </Button>
            )}
          </Group>
          <Group gap="xs">
            {editable && (
              <Button
                size="xs"
                variant="default"
                leftSection={<IconEdit size={14} />}
                disabled={!chosen.length}
                onClick={() => setOpen('edit')}
                data-testid="bulk-edit"
              >
                {t('bulk.edit')}
              </Button>
            )}
            <Button
              size="xs"
              variant="default"
              color="red"
              leftSection={<IconTrash size={14} />}
              disabled={!chosen.length}
              onClick={() => setOpen('remove')}
              data-testid="bulk-remove"
            >
              {t('bulk.remove')}
            </Button>
          </Group>
        </Group>
      </Paper>
      {open && (
        <BulkModal
          kind={kind}
          action={open}
          entries={chosen}
          onClose={() => setOpen(null)}
          onDone={(r) => {
            setOpen(null);
            if (r.action === 'remove') sel.clear();
          }}
        />
      )}
    </>
  );
}

const OUTCOME_COLOR: Record<PlantBulkItem['outcome'], string> = { changed: 'blue', unchanged: 'gray', removed: 'red', skipped: 'orange', refused: 'orange' };

function BulkModal({
  kind,
  action,
  entries,
  onClose,
  onDone,
}: {
  kind: PlantBulkKind;
  action: 'edit' | 'remove';
  entries: BulkEntry[];
  onClose: () => void;
  onDone: (r: PlantBulkResult) => void;
}) {
  const { t } = useTranslation(['plantIds', 'plant', 'common']);
  const { t: tc } = useTranslation('plantChanges');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const cfg = usePlantConfig();
  const cs = useChangeSetConfig();
  const catalogue = kind === 'profile' || kind === 'kpi';
  // 0.13.0: who manages applies; who may propose adds the change to their draft (both: both buttons)
  const canApply = !!(catalogue ? cfg.data?.canManageCatalogue : cfg.data?.canManageSome);
  const canDraft = !!cs?.canPropose;
  const countsText = useCountsText();
  const problemText = useProblemText();
  const [set, setSet] = useState<PlantBulkSet>({});
  const [cascade, setCascade] = useState(false);
  const [preview, setPreview] = useState<PlantBulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const body = { kind, action, items: entries.map((e) => ({ id: e.id, scope: e.scope ?? '' })), set: action === 'edit' ? set : {}, cascade };
  const given = Object.values(set).some((v) => v !== undefined);
  const run = async (apply: boolean) => {
    setBusy(true);
    try {
      const r = await post<PlantBulkResult & { changeSet?: PlantChangeSetSummary }>(apply ? '/plant/bulk' : '/plant/bulk/preview', body);
      if (!apply) setPreview(r);
      else if (r.changeSet) {
        // changes here need a second person: the bulk change became a proposed change set of its own
        notifyOk(tc('form.proposedForReview', { title: r.changeSet.title }));
        void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
        onDone(r);
        navigate(`/plant/changes/${encodeURIComponent(r.changeSet.id)}`);
      } else {
        notifyOk(t('bulk.result', r.counts));
        void qc.invalidateQueries({ queryKey: plantKeys.all });
        onDone(r);
      }
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  /** Add to draft (0.13.0): the bulk change as one change of the person's current draft – nothing is changed yet. */
  const addToDraft = async () => {
    setBusy(true);
    try {
      const d = await post<PlantChangeSetDetail>('/plant/change-sets/current/operations', { op: 'bulk', value: body });
      notifyOk(tc('form.addedToDraft', { title: d.title }));
      void qc.invalidateQueries({ queryKey: plantKeys.config });
      void qc.invalidateQueries({ queryKey: ['plant', 'change-sets'] });
      onDone({ ...preview!, applied: false });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
    }
  };
  // a removal is previewed at once (and again when "also remove" changes)
  useEffect(() => {
    if (action === 'remove') void run(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cascade]);
  const change = (patch: PlantBulkSet) => {
    setSet((cur) => ({ ...cur, ...patch }));
    setPreview(null);
  };
  const doable = preview ? preview.counts.changed + preview.counts.removed : 0;
  const title = action === 'edit' ? t('bulk.editTitle', { count: entries.length }) : t('bulk.removeTitle', { count: entries.length });
  return (
    <Modal opened onClose={onClose} title={title} size="xl">
      <Stack gap="sm" data-testid="bulk-dialog">
        {action === 'edit' ? (
          <>
            <Text size="sm" c="dimmed">
              {t('bulk.editHelp')}
            </Text>
            <EditFields kind={kind} entries={entries} set={set} change={change} />
          </>
        ) : (
          <Checkbox
            label={t('bulk.cascade')}
            description={t('bulk.cascadeHelp')}
            checked={cascade}
            onChange={(e) => {
              setCascade(e.currentTarget.checked);
              setPreview(null);
            }}
            data-testid="bulk-cascade"
          />
        )}
        {preview && (
          <Stack gap="xs" data-testid="bulk-preview">
            <Group gap="xs">
              {(Object.keys(preview.counts) as PlantBulkItem['outcome'][])
                .filter((o) => preview.counts[o] > 0)
                .map((o) => (
                  <Badge key={o} color={OUTCOME_COLOR[o]} variant="light">
                    {t(`bulk.outcome.${o}`)}: {preview.counts[o]}
                  </Badge>
                ))}
            </Group>
            {preview.stepUp && doable > 0 && (
              <Alert color="blue" variant="light" icon={<IconShieldLock size={16} />} p="xs">
                <Text size="sm">{t('bulk.stepUp')}</Text>
              </Alert>
            )}
            <div className="table-scroll" tabIndex={0} role="region" aria-label={title}>
              <Table fz="sm" aria-label={title}>
                <Table.Tbody>
                  {preview.items.slice(0, 300).map((i) => (
                    <Table.Tr key={`${i.scope}|${i.id}`}>
                      <Table.Td>
                        <Badge size="sm" color={OUTCOME_COLOR[i.outcome]} variant="light">
                          {t(`bulk.outcome.${i.outcome}`)}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm">{i.name}</Text>
                        <Text size="xs" c="dimmed" className="mono">
                          {i.scope ? `${i.scope} / ` : ''}
                          {i.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {i.fields?.length ? (
                          <Text size="xs">{i.fields.map((f) => t(`bulk.fields.${f as 'status'}`, { defaultValue: f })).join(', ')}</Text>
                        ) : null}
                        {i.with?.length ? <Text size="xs">{t('bulk.with', { list: countsText(i.with) })}</Text> : null}
                        {i.reason && (
                          <Text size="xs" c="orange.8">
                            {problemText(i.reason)}
                          </Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          </Stack>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          {action === 'edit' && (
            <Button variant="default" onClick={() => void run(false)} disabled={!given} loading={busy && !preview} data-testid="bulk-preview-button">
              {t('bulk.preview')}
            </Button>
          )}
          {canDraft && (
            <Button
              variant={canApply ? 'default' : 'filled'}
              leftSection={<IconGitPullRequest size={14} aria-hidden />}
              onClick={() => void addToDraft()}
              disabled={!preview || doable === 0}
              loading={busy && !!preview}
              data-testid="bulk-add-to-draft"
            >
              {tc('form.addToDraft')}
            </Button>
          )}
          {canApply && (
            <Button
              color={action === 'remove' ? 'red' : undefined}
              onClick={() => void run(true)}
              disabled={!preview || doable === 0}
              loading={busy && !!preview}
              data-testid="bulk-apply"
            >
              {action === 'remove' ? t('bulk.applyRemove') : t('bulk.apply')}
            </Button>
          )}
        </Group>
        {canDraft && preview && doable > 0 && (
          <Text size="xs" c="dimmed">
            {tc('form.addToDraftHint')}
          </Text>
        )}
        {action === 'edit' && !given && (
          <Text size="xs" c="dimmed">
            {t('bulk.nothingSet')}
          </Text>
        )}
      </Stack>
    </Modal>
  );
}

const UNCHANGED = '__unchanged__';
/** A device flag as stored: snake_case */
const flagOf = (f: string) =>
  f
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
const NONE = '__none__';

function EditFields({ kind, entries, set, change }: { kind: PlantBulkKind; entries: BulkEntry[]; set: PlantBulkSet; change: (p: PlantBulkSet) => void }) {
  const { t } = useTranslation(['plantIds', 'plant', 'plantNetwork']);
  const nameOf = useNameOf();
  const fields = PLANT_BULK_FIELDS[kind];
  const has = (f: keyof PlantBulkSet) => fields.includes(f);
  const tree = useHierarchy();
  const profiles = useQuery({ queryKey: plantKeys.profiles, queryFn: () => get<PlantProfileSummary[]>('/plant/profiles'), enabled: has('profileId') });
  const sites = [...new Set(entries.map((e) => e.siteId).filter(Boolean))];
  const site = sites.length === 1 ? tree.data?.find((s) => s.id === sites[0]) : undefined;
  const nodes = useMemo(() => (site ? flatNodes(site.areas) : []), [site]);
  const text = (f: 'domain' | 'processArea' | 'role' | 'manufacturer' | 'model' | 'category' | 'type' | 'managedBy' | 'owner') =>
    has(f) && (
      <TextInput
        key={f}
        size="xs"
        label={t(`bulk.fields.${f}`)}
        placeholder={t('bulk.unchanged')}
        value={set[f] ?? ''}
        onChange={(e) => change({ [f]: e.currentTarget.value || undefined })}
      />
    );
  const choice = <V extends string>(f: keyof PlantBulkSet, data: { value: string; label: string }[], none = false) => (
    <Select
      key={f}
      size="xs"
      label={t(`bulk.fields.${f as 'status'}`)}
      data={[{ value: UNCHANGED, label: t('bulk.unchanged') }, ...(none ? [{ value: NONE, label: t('bulk.none') }] : []), ...data]}
      value={set[f] === undefined ? UNCHANGED : set[f] === null ? NONE : String(set[f])}
      onChange={(v) => change({ [f]: v === UNCHANGED || !v ? undefined : v === NONE ? null : (v as V) })}
      allowDeselect={false}
      data-testid={`bulk-field-${f}`}
    />
  );
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
      {has('status') &&
        choice(
          'status',
          ASSET_STATUSES.map((s) => ({ value: s, label: t(`plant:status.${s}`) })),
        )}
      {has('state') &&
        choice(
          'state',
          DEVICE_STATES.map((s) => ({ value: s, label: t(`plantNetwork:deviceStates.${s}`) })),
        )}
      {has('confidence') &&
        choice(
          'confidence',
          DEVICE_CONFIDENCE.map((s) => ({ value: s, label: t(`plantNetwork:confidence.${s}`) })),
          true,
        )}
      {has('addFlags') && (
        <TagsInput
          size="xs"
          label={t('bulk.fields.addFlags')}
          data={[...DEVICE_FLAG_SUGGESTIONS]}
          value={set.addFlags ?? []}
          onChange={(v) => change({ addFlags: v.length ? v.map(flagOf) : undefined })}
        />
      )}
      {has('removeFlags') && (
        <TagsInput
          size="xs"
          label={t('bulk.fields.removeFlags')}
          data={[...DEVICE_FLAG_SUGGESTIONS]}
          value={set.removeFlags ?? []}
          onChange={(v) => change({ removeFlags: v.length ? v.map(flagOf) : undefined })}
        />
      )}
      {has('addTags') && (
        <TagsInput size="xs" label={t('bulk.fields.addTags')} value={set.addTags ?? []} onChange={(v) => change({ addTags: v.length ? v : undefined })} />
      )}
      {has('removeTags') && (
        <TagsInput
          size="xs"
          label={t('bulk.fields.removeTags')}
          value={set.removeTags ?? []}
          onChange={(v) => change({ removeTags: v.length ? v : undefined })}
        />
      )}
      {has('buildingId') &&
        (site
          ? choice(
              'buildingId',
              site.buildings.map((b) => ({ value: b.id, label: nameOf(b) })),
              true,
            )
          : null)}
      {has('nodeId') &&
        (site
          ? choice(
              'nodeId',
              nodes.map((n) => ({ value: n.id, label: nodePath(nodes, n, nameOf) })),
              true,
            )
          : null)}
      {has('profileId') &&
        choice(
          'profileId',
          (profiles.data ?? []).map((p) => ({ value: p.id, label: p.name })),
          true,
        )}
      {text('manufacturer')}
      {text('model')}
      {text('domain')}
      {text('processArea')}
      {text('role')}
      {has('endOfSupport') && (
        <TextInput
          size="xs"
          type="date"
          label={t('bulk.fields.endOfSupport')}
          value={set.endOfSupport ?? ''}
          onChange={(e) => change({ endOfSupport: e.currentTarget.value || undefined })}
        />
      )}
      {text('category')}
      {text('type')}
      {text('managedBy')}
      {text('owner')}
      {has('buildingId') && !site && (
        <Text size="xs" c="dimmed">
          {t('bulk.siteOnly')}
        </Text>
      )}
    </SimpleGrid>
  );
}

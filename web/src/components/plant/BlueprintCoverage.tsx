import { useState } from 'react';
import { Anchor, Badge, Button, Checkbox, CloseButton, Group, Menu, Paper, Select, Stack, Table, Text, TextInput, Textarea, ActionIcon } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconDots, IconListCheck, IconPlus } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  BLUEPRINT_IMPORTANCES,
  BLUEPRINT_LIMITS,
  type BlueprintTargetKind,
  type PlantAssignmentView,
  type PlantBlueprintCoverage,
  type PlantBlueprintCoverageView,
  type PlantBlueprintSignalCoverage,
  type PlantBlueprintSummary,
  type PlantInterface,
} from '@sm/shared';
import { del, get, notifyError, post, put } from '../../api';
import { QueryState, useFieldErrors } from '../common';
import { confirmDanger } from '../confirm';
import { FormModal } from '../FormModal';
import { fmtDate } from '../../format';
import { plantKeys } from '../../queryKeys';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { FormButtons } from './forms';
import { ImportanceBadge, StateBadge, STATE_COLOR } from './blueprints';

/** A data point a signal can be mapped to: the ones the profile (or the asset's model) has. */
export interface PickPoint {
  id: string;
  name: string;
  group: string;
}

/** The data points of a list of interfaces, flat, once each. */
export function pointsOf(interfaces: PlantInterface[]): PickPoint[] {
  const seen = new Set<string>();
  const out: PickPoint[] = [];
  for (const i of interfaces)
    for (const g of i.groups)
      for (const d of g.dataPoints) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        out.push({ id: d.id, name: d.name, group: [i.name || i.id, g.name].filter(Boolean).join(' › ') });
      }
  return out;
}

type Dialog =
  | { kind: 'assign' }
  | { kind: 'map'; bp: PlantBlueprintCoverage; sig: PlantBlueprintSignalCoverage }
  | { kind: 'mark'; bp: PlantBlueprintCoverage; sig: PlantBlueprintSignalCoverage };

/**
 * The machine blueprints of a device profile or an asset (0.30.0, ADR 0041): what is assigned, what each signal's state is
 * (covered, missing, not collected, not applicable), the mapping of signals to data points and the marks. Advice only.
 */
export function BlueprintCoverageSection({ kind, id, points }: { kind: BlueprintTargetKind; id: string; points: PickPoint[] }) {
  const { t } = useTranslation(['plantBlueprints', 'common']);
  const qc = useQueryClient();
  const base = `/plant/${kind === 'profile' ? 'profiles' : 'assets'}/${encodeURIComponent(id)}/blueprints`;
  const key = plantKeys.blueprintCoverage(kind, id);
  const q = useQuery({ queryKey: key, queryFn: () => get<PlantBlueprintCoverageView>(base) });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const v = q.data;
  if (!v) return <QueryState query={q} rows={2} />;
  const canEdit = v.canEdit;
  /** Every write answers the coverage; the counts of the blueprint's page and list change too */
  const run = async (call: () => Promise<PlantBlueprintCoverageView>) => {
    const next = await call();
    qc.setQueryData(key, next);
    void qc.invalidateQueries({ queryKey: plantKeys.blueprints });
    void qc.invalidateQueries({ queryKey: ['plant', 'blueprint'] });
  };
  const act = (call: () => Promise<PlantBlueprintCoverageView>) => void run(call).catch(notifyError);
  const sigPath = (bp: PlantBlueprintCoverage, s: PlantBlueprintSignalCoverage) =>
    `${base}/${encodeURIComponent(bp.blueprint.id)}/signals/${encodeURIComponent(s.signal.id)}`;
  const unassign = async (bp: PlantBlueprintCoverage) => {
    if (!(await confirmDanger({ action: 'remove', message: t('coverage.unassignConfirm', { name: bp.blueprint.name }) }))) return;
    act(() => del<PlantBlueprintCoverageView>(`${base}/${encodeURIComponent(bp.blueprint.id)}`));
  };
  const clearMapping = async (bp: PlantBlueprintCoverage, s: PlantBlueprintSignalCoverage) => {
    if (!(await confirmDanger({ action: 'remove', message: t('coverage.clearMappingConfirm', { name: s.signal.name }) }))) return;
    act(() => del<PlantBlueprintCoverageView>(`${sigPath(bp, s)}/mapping`));
  };
  const total = v.blueprints.reduce((n, b) => n + b.totals.missing, 0);
  const what = t(kind === 'profile' ? 'coverage.whatProfile' : 'coverage.whatAsset');
  return (
    <CollapsibleSection
      id="blueprints"
      testId="section-blueprints"
      title={t('coverage.title')}
      count={v.blueprints.length}
      defaultOpen={false}
      icon={<IconListCheck size={18} aria-hidden style={{ flex: 'none' }} />}
      summary={
        v.blueprints.length > 0 ? (
          <Text size="xs" c="dimmed" data-testid="blueprints-summary">
            {v.blueprints
              .map((b) => `${b.blueprint.name}: ${t('coverage.summary', { covered: b.totals.covered, applicable: b.totals.applicable })}`)
              .join(' · ')}
            {total > 0 ? ` · ${t('coverage.summaryMissing', { count: total })}` : ''}
          </Text>
        ) : undefined
      }
      actions={
        canEdit && (
          <Button
            size="compact-xs"
            variant="default"
            leftSection={<IconPlus size={12} />}
            onClick={() => setDialog({ kind: 'assign' })}
            data-testid="blueprint-assign"
          >
            {t('coverage.assign')}
          </Button>
        )
      }
      description={t('coverage.help', { what })}
    >
      <Stack gap="md">
        {v.blueprints.length === 0 && (
          <Text size="sm" c="dimmed" data-testid="blueprints-none">
            {t('coverage.none')}
          </Text>
        )}
        {v.blueprints.map((bp) => (
          <Paper key={bp.blueprint.id} withBorder p="sm" data-testid={`coverage-${bp.blueprint.id}`}>
            <Stack gap="xs">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <Group gap="xs" wrap="wrap">
                  <Anchor component={Link} to={`/plant/blueprints/${encodeURIComponent(bp.blueprint.id)}`} fw={600} size="sm">
                    {bp.blueprint.name}
                  </Anchor>
                  {bp.blueprint.version && (
                    <Text size="xs" c="dimmed">
                      {t('page.versionIs', { version: bp.blueprint.version })}
                    </Text>
                  )}
                  {kind === 'asset' && (
                    <Badge size="xs" variant="default" tt="none">
                      {t(`coverage.via.${bp.via}`)}
                    </Badge>
                  )}
                </Group>
                {canEdit && bp.via !== 'profile' && (
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="red"
                    onClick={() => void unassign(bp)}
                    data-testid={`blueprint-unassign-${bp.blueprint.id}`}
                  >
                    {t('coverage.unassign')}
                  </Button>
                )}
                {canEdit && bp.via === 'profile' && (
                  <Text size="xs" c="dimmed">
                    {t('coverage.viaProfileOnly')}
                  </Text>
                )}
              </Group>
              <Group gap="md" wrap="wrap" data-testid={`totals-${bp.blueprint.id}`}>
                {BLUEPRINT_IMPORTANCES.map((imp) => {
                  const x = bp.byImportance[imp];
                  if (x.total === 0) return null;
                  return (
                    <Group key={imp} gap={6} wrap="nowrap" data-testid={`totals-${bp.blueprint.id}-${imp}`}>
                      <ImportanceBadge importance={imp} />
                      <Text size="xs">
                        {t('coverage.totalLine', { covered: x.covered, applicable: x.applicable })}
                        {x.missing > 0 && ` · ${t('coverage.missingLine', { count: x.missing })}`}
                        {x.notCollected > 0 && ` · ${t('coverage.notCollectedLine', { count: x.notCollected })}`}
                        {x.notApplicable > 0 && ` · ${t('coverage.notApplicableLine', { count: x.notApplicable })}`}
                      </Text>
                    </Group>
                  );
                })}
              </Group>
              <Table.ScrollContainer minWidth={480}>
                <Table verticalSpacing="xs" aria-label={t('coverage.signalsOf', { name: bp.blueprint.name })}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>{t('coverage.signalCell')}</Table.Th>
                      <Table.Th>{t('coverage.stateCell')}</Table.Th>
                      <Table.Th>{t('coverage.pointsCell')}</Table.Th>
                      {canEdit && (
                        <Table.Th>
                          <span className="sr-only">{t('coverage.actionsCell')}</span>
                        </Table.Th>
                      )}
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {bp.signals.map((s) => (
                      <Table.Tr key={s.signal.id} data-testid={`coverage-signal-${bp.blueprint.id}-${s.signal.id}`}>
                        <Table.Td>
                          <Group gap={6} wrap="wrap">
                            <Text size="sm" fw={500}>
                              {s.signal.name}
                            </Text>
                            <ImportanceBadge importance={s.signal.importance} />
                          </Group>
                          {s.signal.meaning && (
                            <Text size="xs" c="dimmed">
                              {s.signal.meaning}
                            </Text>
                          )}
                        </Table.Td>
                        <Table.Td>
                          <StateBadge state={s.state} />
                        </Table.Td>
                        <Table.Td>
                          <SignalDetail
                            s={s}
                            kind={kind}
                            canEdit={canEdit}
                            onUnmap={(dp) => act(() => del<PlantBlueprintCoverageView>(`${sigPath(bp, s)}/mapping/${encodeURIComponent(dp)}`))}
                            onAccept={(dp) => act(() => post<PlantBlueprintCoverageView>(`${sigPath(bp, s)}/mapping`, { dataPoint: dp }))}
                          />
                        </Table.Td>
                        {canEdit && (
                          <Table.Td>
                            <Menu position="bottom-end" withinPortal>
                              <Menu.Target>
                                <ActionIcon
                                  variant="subtle"
                                  color="gray"
                                  aria-label={t('signals.actions', { name: s.signal.name })}
                                  data-testid={`signal-menu-${s.signal.id}`}
                                >
                                  <IconDots size={16} />
                                </ActionIcon>
                              </Menu.Target>
                              <Menu.Dropdown>
                                <Menu.Item onClick={() => setDialog({ kind: 'map', bp, sig: s })} data-testid="signal-map">
                                  {s.points.some((p) => p.source === kind) ? t('coverage.changeMapping') : t('coverage.map')}
                                </Menu.Item>
                                {s.points.some((p) => p.source === kind) && (
                                  <Menu.Item onClick={() => void clearMapping(bp, s)}>{t('coverage.clearMapping')}</Menu.Item>
                                )}
                                {s.notApplicable === null && (
                                  <Menu.Item onClick={() => setDialog({ kind: 'mark', bp, sig: s })} data-testid="signal-mark">
                                    {t('coverage.markNotApplicable')}
                                  </Menu.Item>
                                )}
                                {s.notApplicable !== null && s.notApplicable.on === kind && (
                                  <Menu.Item
                                    onClick={() => act(() => del<PlantBlueprintCoverageView>(`${sigPath(bp, s)}/not-applicable`))}
                                    data-testid="signal-clear-mark"
                                  >
                                    {t('coverage.clearMark')}
                                  </Menu.Item>
                                )}
                              </Menu.Dropdown>
                            </Menu>
                          </Table.Td>
                        )}
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Table.ScrollContainer>
            </Stack>
          </Paper>
        ))}
      </Stack>
      {dialog?.kind === 'assign' && (
        <AssignModal
          have={v.blueprints.map((b) => b.blueprint.id)}
          onClose={() => setDialog(null)}
          onSave={(bid) => run(() => put<PlantBlueprintCoverageView>(`${base}/${encodeURIComponent(bid)}`, {}))}
        />
      )}
      {dialog?.kind === 'map' && (
        <MapModal
          name={dialog.sig.signal.name}
          points={points}
          initial={dialog.sig.points.filter((p) => p.source === kind).map((p) => p.id)}
          onClose={() => setDialog(null)}
          onSave={(ids) => run(() => put<PlantBlueprintCoverageView>(`${sigPath(dialog.bp, dialog.sig)}/mapping`, { dataPoints: ids }))}
        />
      )}
      {dialog?.kind === 'mark' && (
        <MarkModal
          name={dialog.sig.signal.name}
          onClose={() => setDialog(null)}
          onSave={(reason) => run(() => put<PlantBlueprintCoverageView>(`${sigPath(dialog.bp, dialog.sig)}/not-applicable`, { reason }))}
        />
      )}
    </CollapsibleSection>
  );
}

/** What a signal's row says besides its state: the mapped data points, the suggestions, the mark with its reason. */
function SignalDetail({
  s,
  kind,
  canEdit,
  onAccept,
  onUnmap,
}: {
  s: PlantBlueprintSignalCoverage;
  kind: BlueprintTargetKind;
  canEdit: boolean;
  onAccept: (dataPoint: string) => void;
  onUnmap: (dataPoint: string) => void;
}) {
  const { t } = useTranslation('plantBlueprints');
  return (
    <Stack gap={4}>
      {s.points.length > 0 && (
        <Group gap={4} wrap="wrap">
          {s.points.map((p) => (
            <Badge
              key={p.id}
              size="xs"
              variant="default"
              tt="none"
              className="mono"
              color={p.missing ? 'red' : undefined}
              title={p.source !== kind ? t('coverage.viaAsset') : undefined}
            >
              {p.name}
              {p.missing ? ` (${t('coverage.gone')})` : p.collected === false ? ` (${t('coverage.notCollectedPoint')})` : ''}
              {canEdit && p.source === kind && (
                <CloseButton
                  size="xs"
                  aria-label={t('coverage.unmapPoint', { name: p.name })}
                  onClick={() => onUnmap(p.id)}
                  data-testid={`unmap-${p.id}`}
                  style={{ display: 'inline-flex', verticalAlign: 'middle' }}
                />
              )}
            </Badge>
          ))}
        </Group>
      )}
      {s.state === 'notCollected' && (
        <Text size="xs" c="dimmed">
          {t('coverage.stateHelp.notCollected')}
        </Text>
      )}
      {s.notApplicable && (
        <Text size="xs" data-testid="not-applicable-note" style={{ overflowWrap: 'anywhere' }}>
          <Text span c="dimmed" size="xs">
            {t('coverage.markedBy', { where: t(`coverage.markedOn.${s.notApplicable.on}`), by: s.notApplicable.by, at: fmtDate(s.notApplicable.at) })}
            {': '}
          </Text>
          {s.notApplicable.reason}
        </Text>
      )}
      {s.suggestions.length > 0 && (
        <Stack gap={2} data-testid="suggestions">
          {s.suggestions.map((x) => (
            <Group key={x.dataPoint} gap={6} wrap="wrap">
              <Badge size="xs" variant="outline" color={STATE_COLOR.notCollected} tt="none">
                {t('coverage.suggestion')}
              </Badge>
              <Text size="xs" title={t('coverage.suggestionNote')}>
                {t('coverage.suggestionText', { name: x.name, matched: x.matched })}
              </Text>
              {canEdit && (
                <Button size="compact-xs" variant="light" onClick={() => onAccept(x.dataPoint)} data-testid={`suggestion-accept-${x.dataPoint}`}>
                  {t('coverage.accept')}
                </Button>
              )}
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function AssignModal({ have, onClose, onSave }: { have: string[]; onClose: () => void; onSave: (id: string) => Promise<void> }) {
  const { t } = useTranslation(['plantBlueprints', 'common']);
  const all = useQuery({ queryKey: plantKeys.blueprints, queryFn: () => get<PlantBlueprintSummary[]>('/plant/blueprints') });
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = (all.data ?? []).filter((b) => !have.includes(b.id)).map((b) => ({ value: b.id, label: b.name }));
  return (
    <FormModal onClose={onClose} title={t('coverage.assignTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!pick) return;
          setBusy(true);
          onSave(pick).then(onClose, (err: unknown) => {
            notifyError(err);
            setBusy(false);
          });
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('coverage.assignField')}
            data={options}
            value={pick}
            onChange={setPick}
            searchable
            required
            data-autofocus
            nothingFoundMessage={t('coverage.assignNone')}
            data-testid="blueprint-assign-select"
          />
          {all.isSuccess && options.length === 0 && (
            <Text size="sm" c="dimmed">
              {t('coverage.assignNone')}
            </Text>
          )}
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </FormModal>
  );
}

function MapModal({
  name,
  points,
  initial,
  onClose,
  onSave,
}: {
  name: string;
  points: PickPoint[];
  initial: string[];
  onClose: () => void;
  onSave: (ids: string[]) => Promise<void>;
}) {
  const { t } = useTranslation(['plantBlueprints', 'common']);
  const [chosen, setChosen] = useState<string[]>(initial);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const needle = search.trim().toLowerCase();
  const shown = points.filter((p) => !needle || p.id.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle));
  // a mapping that exists stays choosable although its data point is gone
  const gone = initial.filter((i) => !points.some((p) => p.id === i));
  const rows = [...gone.map((id) => ({ id, name: id, group: '' })), ...shown];
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <FormModal onClose={onClose} title={t('coverage.pickerTitle', { name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          onSave(chosen).then(onClose, (err: unknown) => {
            notifyError(err);
            setBusy(false);
          });
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('coverage.pickerHelp')}
          </Text>
          <TextInput
            placeholder={t('coverage.pickerSearch')}
            aria-label={t('coverage.pickerSearch')}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            data-autofocus
            data-testid="map-search"
          />
          <Stack gap={6} mah={320} style={{ overflowY: 'auto' }} data-testid="map-points">
            {points.length === 0 && (
              <Text size="sm" c="dimmed">
                {t('coverage.pickerNone')}
              </Text>
            )}
            {points.length > 0 && rows.length === 0 && (
              <Text size="sm" c="dimmed">
                {t('coverage.pickerNoMatch')}
              </Text>
            )}
            {rows.map((p) => (
              <Checkbox
                key={p.id}
                checked={chosen.includes(p.id)}
                onChange={() => toggle(p.id)}
                data-testid={`map-point-${p.id}`}
                label={
                  <>
                    {p.name}{' '}
                    <Text span size="xs" c="dimmed" className="mono">
                      {p.id}
                    </Text>
                  </>
                }
                description={p.group || undefined}
              />
            ))}
          </Stack>
          <Text size="xs" c="dimmed">
            {t('coverage.pickerSelected', { count: chosen.length })}
          </Text>
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </FormModal>
  );
}

function MarkModal({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (reason: string) => Promise<void> }) {
  const { t } = useTranslation(['plantBlueprints', 'common']);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ reason: !reason.trim() && t('common:validation.required') });
  return (
    <FormModal onClose={onClose} title={t('coverage.markTitle', { name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.validate()) return;
          setBusy(true);
          onSave(reason.trim()).then(onClose, (err: unknown) => {
            notifyError(err);
            setBusy(false);
          });
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('coverage.markHelp')}
          </Text>
          <Textarea
            label={t('coverage.reason')}
            required
            data-autofocus
            autosize
            minRows={2}
            maxRows={6}
            maxLength={BLUEPRINT_LIMITS.reason}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
            error={v.error('reason')}
            data-testid="mark-reason"
          />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </FormModal>
  );
}

/** The asset's section: the data points to map to are those of the asset's model (its profile's and its own). */
export function AssetBlueprintCoverage({ assetId }: { assetId: string }) {
  const q = useQuery({
    queryKey: plantKeys.assignment(assetId),
    queryFn: () => get<PlantAssignmentView>(`/plant/assets/${encodeURIComponent(assetId)}/assignment`),
  });
  return <BlueprintCoverageSection kind="asset" id={assetId} points={pointsOf(q.data?.model ?? [])} />;
}

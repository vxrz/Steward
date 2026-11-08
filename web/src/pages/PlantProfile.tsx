import { useEffect, useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, List, Modal, Paper, Stack, Text, TextInput, Textarea, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconDownload, IconEdit, IconFile, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantDataPoint, PlantInterface, PlantProfileDetail, PlantProfileValues } from '@sm/shared';
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
import { FormButtons } from '../components/plant/forms';
import { AssetBriefLink, DataPointTable, ProtocolBadge, RowMenu } from '../components/plant/data';
import { DataPointFormModal, InterfaceFormModal, ProfileFormModal } from '../components/plant/dataForms';
import { SourceLine } from './PlantSite';

const valuesOf = (p: PlantProfileDetail): PlantProfileValues => ({
  id: p.id,
  name: p.name,
  manufacturer: p.manufacturer,
  model: p.model,
  version: p.version,
  category: p.category,
  description: p.description,
  notes: p.notes,
  interfaces: p.interfaces,
});

/** The data points without a group come last (as the file lists them). */
const ordered = (groups: PlantInterface['groups']) => [...groups.filter((g) => g.name), ...groups.filter((g) => !g.name && g.dataPoints.length)];

/** Puts a data point into its group (a new group is added), in place when it stays in its group. */
function placePoint(iface: PlantInterface, point: PlantDataPoint, group: string, was: string | null): PlantInterface {
  const groups = iface.groups.map((g) => ({ ...g, dataPoints: [...g.dataPoints] }));
  const from = was === null ? null : groups.find((g) => g.dataPoints.some((d) => d.id === was));
  if (from && from.name === group) {
    from.dataPoints = from.dataPoints.map((d) => (d.id === was ? point : d));
    return { ...iface, groups };
  }
  if (from) from.dataPoints = from.dataPoints.filter((d) => d.id !== was);
  const to = groups.find((g) => g.name === group);
  if (to) to.dataPoints.push(point);
  else groups.push({ name: group, description: '', dataPoints: [point] });
  return { ...iface, groups: ordered(groups) };
}

type Dialog =
  | { kind: 'profile' }
  | { kind: 'interface'; iface?: PlantInterface }
  | { kind: 'point'; iface: PlantInterface; group: string; point?: PlantDataPoint }
  | { kind: 'group'; iface: PlantInterface; group: string; description: string };

/**
 * A device profile (#219): its interfaces with their data point groups and data points, the files a file-transfer
 * interface exchanges, the assets that have the profile and the KPI definitions that read it.
 */
export function PlantProfilePage() {
  const { t } = useTranslation(['plant', 'common']);
  const label = usePlantLabel();
  const nameOf = useNameOf();
  const { profileId } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const q = useQuery({ queryKey: plantKeys.profile(profileId), queryFn: () => get<PlantProfileDetail>(`/plant/profiles/${encodeURIComponent(profileId!)}`) });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const p = q.data;
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
    const saved = await put<PlantProfileDetail>(base, body);
    qc.setQueryData(plantKeys.profile(profileId), saved);
    void qc.invalidateQueries({ queryKey: plantKeys.profiles });
    void qc.invalidateQueries({ queryKey: ['plant', 'point', p.id] });
  };
  const values = valuesOf(p);
  const withInterface = (iface: PlantInterface) => ({
    ...values,
    interfaces: values.interfaces.some((i) => i.id === iface.id)
      ? values.interfaces.map((i) => (i.id === iface.id ? iface : i))
      : [...values.interfaces, iface],
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
    const next = { ...iface, groups: ordered(iface.groups.map((g) => ({ ...g, dataPoints: g.dataPoints.filter((d) => d.id !== point.id) }))) };
    await save(withInterface(next)).catch(notifyError);
  };
  return (
    <>
      <DetailHeader
        recent={{ label: p.name, kind: 'profile' }}
        back="plantProfiles"
        title={p.name}
        status={
          <>
            {p.category && <Badge variant="default">{p.category}</Badge>}
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
                  { label: t('profile.delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'profile-delete' },
                ],
              }
            : undefined
        }
      />
      {changeId.modal}
      <CopiedFromNote kind="device-profile" id={p.id} pathOf={(id) => `/plant/profiles/${encodeURIComponent(id)}`} />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {p.description && (
              <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                {p.description}
              </Text>
            )}
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
                <Paper key={iface.id} withBorder p="md" component="section" aria-labelledby={`iface-${iface.id}`} data-testid={`interface-${iface.id}`}>
                  <Stack gap="sm">
                    <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                      <Stack gap={4} style={{ minWidth: 0 }}>
                        <Group gap="xs" wrap="wrap">
                          <Title order={3} fz="h5" id={`iface-${iface.id}`}>
                            {iface.name || iface.id}
                          </Title>
                          <ProtocolBadge protocol={iface.protocol} />
                        </Group>
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
                      </Stack>
                      {p.canManage && (
                        <Group gap={4} wrap="nowrap">
                          <Button
                            size="compact-xs"
                            variant="default"
                            leftSection={<IconPlus size={12} />}
                            onClick={() => setDialog({ kind: 'point', iface, group: iface.groups.find((g) => g.name)?.name ?? '' })}
                          >
                            {t('data.addPoint')}
                          </Button>
                          <RowMenu
                            label={t('data.interfaceActions', { name: iface.name || iface.id })}
                            onEdit={() => setDialog({ kind: 'interface', iface })}
                            onRemove={() => void removeInterface(iface)}
                          />
                        </Group>
                      )}
                    </Group>
                    {iface.description && (
                      <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                        {iface.description}
                      </Text>
                    )}
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
                            {g.description && (
                              <Text size="xs" c="dimmed">
                                {g.description}
                              </Text>
                            )}
                          </div>
                          {p.canManage && g.name && (
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
                              {(f.description || f.notes) && (
                                <Text size="xs" style={{ whiteSpace: 'pre-line' }}>
                                  {[f.description, f.notes].filter(Boolean).join('\n')}
                                </Text>
                              )}
                            </Stack>
                          </Group>
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              ))}
            </Stack>
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
      {dialog?.kind === 'profile' && <ProfileFormModal profile={values} onClose={() => setDialog(null)} onSave={save} />}
      {dialog?.kind === 'interface' && (
        <InterfaceFormModal
          iface={dialog.iface}
          taken={p.interfaces.map((i) => i.id)}
          onClose={() => setDialog(null)}
          onSave={(iface) => save(withInterface(iface))}
        />
      )}
      {dialog?.kind === 'point' && (
        <DataPointFormModal
          point={dialog.point}
          protocol={dialog.iface.protocol}
          group={dialog.group}
          groups={dialog.iface.groups.map((g) => g.name)}
          taken={allPoints}
          onClose={() => setDialog(null)}
          onSave={(point, group) => save(withInterface(placePoint(dialog.iface, point, group, dialog.point?.id ?? null)))}
        />
      )}
      {dialog?.kind === 'group' && (
        <GroupModal
          name={dialog.group}
          description={dialog.description}
          taken={dialog.iface.groups.map((g) => g.name).filter((n) => n !== dialog.group)}
          onClose={() => setDialog(null)}
          onSave={(name, description) =>
            save(
              withInterface({
                ...dialog.iface,
                groups: dialog.iface.groups.map((g) => (g.name === dialog.group ? { ...g, name, description } : g)),
              }),
            )
          }
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

import { Anchor, Button, Grid, Group, Paper, Stack, Table, Text, Title } from '@mantine/core';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { IconEdit, IconInfoCircle, IconLock, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { PlantBlueprintDetail, PlantBlueprintSignal } from '@sm/shared';
import { del, get, notifyError, post, put } from '../api';
import { DetailState, EmptyState } from '../components/common';
import { DetailHeader } from '../components/page/DetailPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { AccessTab } from '../components/access/AccessTab';
import { Field } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { fmtDate } from '../format';
import { plantKeys } from '../queryKeys';
import { NotInSourceBadge, PreviewBadge } from '../components/plant/common';
import { AssetBriefLink, RowMenu } from '../components/plant/data';
import { BlueprintFormModal, ImportanceBadge, SignalFormModal, WhyBadges } from '../components/plant/blueprints';
import { SourceLine } from './PlantSite';

type Dialog = { kind: 'blueprint' } | { kind: 'signal'; signal?: PlantBlueprintSignal };

/** A machine blueprint (0.30.0, ADR 0041): its signals, where it is assigned, and who may see and change it. */
export function PlantBlueprintPage() {
  const { t } = useTranslation(['plantBlueprints', 'plant', 'common']);
  const { blueprintId, tab } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: plantKeys.blueprint(blueprintId),
    queryFn: () => get<PlantBlueprintDetail>(`/plant/blueprints/${encodeURIComponent(blueprintId!)}`),
  });
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const b = q.data;
  if (!b) return <DetailState query={q} back="plantBlueprints" />;
  const base = `/plant/blueprints/${encodeURIComponent(b.id)}`;
  if (tab && tab !== 'access') return <Navigate to={base} replace />;
  const done = (saved: PlantBlueprintDetail) => {
    qc.setQueryData(plantKeys.blueprint(blueprintId), saved);
    void qc.invalidateQueries({ queryKey: plantKeys.blueprints });
    // coverage of every profile and asset that has it changes with its signals
    void qc.invalidateQueries({ queryKey: ['plant', 'blueprintCoverage'] });
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('page.deleteConfirm', { name: b.name }) }))) return;
    try {
      await del(base);
      void qc.invalidateQueries({ queryKey: plantKeys.all });
      navigate('/plant/blueprints');
    } catch (e) {
      notifyError(e);
    }
  };
  const removeSignal = async (s: PlantBlueprintSignal) => {
    if (!(await confirmDanger({ action: 'remove', message: t('signals.removeConfirm', { name: s.name }) }))) return;
    try {
      done(await del<PlantBlueprintDetail>(`${base}/signals/${encodeURIComponent(s.id)}`));
    } catch (e) {
      notifyError(e);
    }
  };
  const tabs = (
    <LinkTabs
      label={t('page.tabs.label', { name: b.name })}
      active={tab ? `${base}/${tab}` : base}
      tabs={[
        { to: base, label: t('page.tabs.overview'), icon: IconInfoCircle, testId: 'blueprint-tab-overview' },
        { to: `${base}/access`, label: t('page.tabs.access'), icon: IconLock, testId: 'blueprint-tab-access' },
      ]}
    />
  );
  const status = (
    <>
      {b.notInSource && <NotInSourceBadge />}
      <PreviewBadge />
    </>
  );
  if (tab === 'access')
    return (
      <>
        <DetailHeader recent={{ label: b.name, kind: 'blueprint', to: base }} back="plantBlueprints" title={b.name} status={status} tabs={tabs} />
        <AccessTab kind="blueprint" id={b.id} />
      </>
    );
  return (
    <>
      <DetailHeader
        recent={{ label: b.name, kind: 'blueprint' }}
        back="plantBlueprints"
        title={b.name}
        tabs={tabs}
        status={status}
        description={[b.reference, b.version && t('page.versionIs', { version: b.version })].filter(Boolean).join(' · ') || undefined}
        actions={
          b.canEdit && (
            <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setDialog({ kind: 'blueprint' })} data-testid="blueprint-edit">
              {t('page.edit')}
            </Button>
          )
        }
        menu={
          b.canManage
            ? { items: [{ label: t('page.delete'), icon: IconTrash, color: 'red', onClick: () => void remove(), testId: 'blueprint-delete' }] }
            : undefined
        }
      />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {b.description && (
              <Text size="sm" style={{ whiteSpace: 'pre-line' }}>
                {b.description}
              </Text>
            )}
            <Stack gap="sm" data-testid="blueprint-signals">
              <Group justify="space-between" wrap="wrap" gap="xs">
                <div>
                  <Title order={2} fz="h4">
                    {t('signals.title')}
                  </Title>
                  <Text size="xs" c="dimmed">
                    {t('signals.help')}
                  </Text>
                </div>
                {b.canEdit && (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconPlus size={14} />}
                    onClick={() => setDialog({ kind: 'signal' })}
                    data-testid="signal-add"
                  >
                    {t('signals.add')}
                  </Button>
                )}
              </Group>
              {b.signals.length === 0 ? (
                <EmptyState compact title={t('signals.none')} />
              ) : (
                <Table.ScrollContainer minWidth={420}>
                  <Table verticalSpacing="xs" aria-label={t('signals.title')} data-testid="blueprint-signal-table">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('signals.name')}</Table.Th>
                        <Table.Th>{t('signals.importance')}</Table.Th>
                        <Table.Th>{t('signals.why')}</Table.Th>
                        {b.canEdit && (
                          <Table.Th>
                            <span className="sr-only">{t('coverage.actionsCell')}</span>
                          </Table.Th>
                        )}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {b.signals.map((s) => (
                        <Table.Tr key={s.id} data-testid={`signal-row-${s.id}`}>
                          <Table.Td>
                            <Text size="sm" fw={500}>
                              {s.name}
                            </Text>
                            {s.meaning && (
                              <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
                                {s.meaning}
                              </Text>
                            )}
                            {s.aliases.length > 0 && (
                              <Text size="xs" c="dimmed">
                                {t('signals.aliases')}: {s.aliases.join(', ')}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <ImportanceBadge importance={s.importance} />
                          </Table.Td>
                          <Table.Td>
                            <WhyBadges why={s.why} />
                          </Table.Td>
                          {b.canEdit && (
                            <Table.Td>
                              <RowMenu
                                label={t('signals.actions', { name: s.name })}
                                onEdit={() => setDialog({ kind: 'signal', signal: s })}
                                onRemove={() => void removeSignal(s)}
                              />
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              )}
            </Stack>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="md">
            <Paper withBorder p="md" data-testid="blueprint-usage">
              <Stack gap="xs">
                <Title order={2} fz="h5">
                  {t('page.usedBy')}
                </Title>
                {b.profiles.length === 0 && b.assets.length === 0 && (
                  <Text size="sm" c="dimmed">
                    {t('page.notAssigned')}
                  </Text>
                )}
                {b.profiles.length > 0 && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                      {t('page.profiles')}
                    </Text>
                    {b.profiles.map((p) => (
                      <Anchor key={p.id} component={Link} to={`/plant/profiles/${encodeURIComponent(p.id)}`} size="sm">
                        {p.name}
                      </Anchor>
                    ))}
                  </Stack>
                )}
                {b.assets.length > 0 && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                      {t('page.assets')}
                    </Text>
                    {b.assets.map((a) => (
                      <AssetBriefLink key={a.id} asset={a} />
                    ))}
                  </Stack>
                )}
              </Stack>
            </Paper>
            <Paper withBorder p="md">
              <Stack gap="sm">
                <Field label={t('page.id')}>
                  <span className="mono">{b.id}</span>
                </Field>
                <Field label={t('page.reference')}>{b.reference || '–'}</Field>
                <Field label={t('page.version')}>{b.version || '–'}</Field>
                <Text size="xs" c="dimmed">
                  {t('page.signalCounts', { must: b.byImportance.must, should: b.byImportance.should, nice: b.byImportance.nice })}
                </Text>
                <SourceLine importId={b.importId} />
                <Text size="xs" c="dimmed">
                  {t('plant:changedBy', { user: b.updatedBy, date: fmtDate(b.updatedAt) })}
                </Text>
              </Stack>
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>
      {dialog?.kind === 'blueprint' && (
        <BlueprintFormModal
          blueprint={{ id: b.id, name: b.name, description: b.description, reference: b.reference, version: b.version }}
          onClose={() => setDialog(null)}
          onSave={async (v) => {
            const { id: _id, ...body } = v;
            done(await put<PlantBlueprintDetail>(base, body));
          }}
        />
      )}
      {dialog?.kind === 'signal' && (
        <SignalFormModal
          signal={dialog.signal}
          taken={b.signals.map((s) => s.id).filter((id) => id !== dialog.signal?.id)}
          onClose={() => setDialog(null)}
          onSave={async (s) => {
            if (dialog.signal) {
              const { id: _id, ...body } = s;
              done(await put<PlantBlueprintDetail>(`${base}/signals/${encodeURIComponent(dialog.signal.id)}`, body));
            } else done(await post<PlantBlueprintDetail>(`${base}/signals`, s));
          }}
        />
      )}
    </>
  );
}

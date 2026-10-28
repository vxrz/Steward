import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Box, Button, Grid, Group, Modal, Paper, Select, Stack, Table, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { IconArchive, IconArchiveOff, IconEdit, IconExternalLink, IconPlus, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { ApplicationDetail, ApplicationDocument, Platform } from '@sm/shared';
import { del, get, notifyError, patch, post } from '../api';
import { DetailState, PageHeader, subjectLabel, useFieldErrors } from '../components/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { Field, LinksPanel, RecordStatusBadge } from '../components/records/common';
import { EditionBadge, ReviewStatusBadge } from '../components/records/DocumentPanel';
import { confirmDanger } from '../components/confirm';
import { fmtDate, fmtDay } from '../format';
import { CriticalityBadge } from './Services';
import { ApplicationFormModal } from './Applications';
import { RatingPanel } from '../components/catalogue/cia';
import { DutiesPanel } from '../components/duties/DutiesPanel';
import { useRoleLabel } from '../components/catalogue/ServiceApplications';
import { ComponentsPanel } from '../components/catalogue/ComponentsPanel';

export function ApplicationDetailPage() {
  const { t } = useTranslation(['applications', 'common']);
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['application', id], queryFn: () => get<ApplicationDetail>(`/applications/${id}`) });
  const [editing, setEditing] = useState(false);
  const roleLabel = useRoleLabel();
  const refresh = (a?: ApplicationDetail) => {
    if (a) qc.setQueryData(['application', id], a);
    else void qc.invalidateQueries({ queryKey: ['application', id] });
    void qc.invalidateQueries({ queryKey: ['applications'] });
    void qc.invalidateQueries({ queryKey: ['service'] });
  };
  const a = q.data;
  if (!a) return <DetailState query={q} back="applications" />;
  const archive = async () => {
    if (!a.archived && !(await confirmDanger({ action: 'archive', message: t('archiveConfirm', { name: a.name }) }))) return;
    try {
      refresh(await post<ApplicationDetail>(`/applications/${a.id}/archive`, { archived: !a.archived }));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <PageHeader
        back="applications"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{a.name}</span>
            <CriticalityBadge value={a.criticality} />
            {a.archived && (
              <Badge variant="outline" color="gray">
                {t('archived')}
              </Badge>
            )}
          </Group>
        }
        description={t('detailLine', { user: a.updatedBy, date: fmtDate(a.updatedAt) })}
        actions={
          a.canEdit && (
            <>
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                {t('common:edit')}
              </Button>
              <Button size="xs" variant="default" leftSection={a.archived ? <IconArchiveOff size={14} /> : <IconArchive size={14} />} onClick={archive}>
                {a.archived ? t('restore') : t('archive')}
              </Button>
            </>
          )
        }
      />
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {a.description.trim() ? (
              <MarkdownView text={a.description} />
            ) : (
              <Text c="dimmed" size="sm">
                {t('noDescription')}
              </Text>
            )}
            <RatingPanel app={a} onSaved={refresh} />
            <ComponentsPanel app={a} onSaved={refresh} />
            <IntegrationsPanel app={a} onSaved={refresh} />
            <Stack gap="xs" data-testid="application-services">
              <Text fw={600}>{t('services.title')}</Text>
              {a.services.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('services.empty')}
                </Text>
              ) : (
                <Stack gap={4}>
                  {a.services.map((s) => (
                    <Text key={s.id} size="sm">
                      <Anchor component={Link} to={`/services/${s.id}`} size="sm">
                        {s.name}
                      </Anchor>{' '}
                      · {roleLabel(s.role, s.roleText)}
                    </Text>
                  ))}
                </Stack>
              )}
            </Stack>
            <ApplicationDocuments documents={a.documents} />
            <DutiesPanel applicationId={a.id} />
            <LinksPanel
              links={a.links}
              backlinks={a.backlinks}
              canEdit={a.canEdit}
              self={{ kind: 'application', id: a.id }}
              onAdd={async (l) => {
                await post(`/applications/${a.id}/links`, l);
                refresh();
              }}
              onUpdate={async (lid, l) => {
                await patch(`/applications/${a.id}/links/${lid}`, l);
                refresh();
              }}
              onRemove={async (lid) => {
                await del(`/applications/${a.id}/links/${lid}`);
                refresh();
              }}
            />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Field label={t('vendor')}>
                <Text size="sm">{[a.vendor, a.version].filter(Boolean).join(' · ') || '–'}</Text>
              </Field>
              {a.url && (
                <Field label={t('url')}>
                  <Anchor href={a.url} target="_blank" rel="noopener noreferrer nofollow" size="sm" style={{ overflowWrap: 'anywhere' }}>
                    {t('openUrl')} <IconExternalLink size={12} aria-hidden />
                  </Anchor>
                </Field>
              )}
              <Field label={t('owners')}>
                <Text size="sm">{a.owners.map(subjectLabel).join(', ') || '–'}</Text>
              </Field>
              <Field label={t('cmdb')}>
                {a.cmdb ? (
                  <Text size="sm">
                    {[a.cmdb.system, a.cmdb.id].filter(Boolean).join(' · ')}
                    {a.cmdb.url && (
                      <>
                        {' '}
                        <Anchor href={a.cmdb.url} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                          {t('openCmdb')} <IconExternalLink size={12} aria-hidden />
                        </Anchor>
                      </>
                    )}
                  </Text>
                ) : (
                  <Text size="sm" c="dimmed">
                    {t('noCmdb')}
                  </Text>
                )}
              </Field>
              {a.tags.length > 0 && (
                <Field label={t('tags')}>
                  <Group gap={4}>
                    {a.tags.map((tag) => (
                      <Badge key={tag} size="sm" variant="default">
                        {tag}
                      </Badge>
                    ))}
                  </Group>
                </Field>
              )}
              <Text size="xs" c="dimmed">
                {t('created', { user: a.createdBy, date: fmtDate(a.createdAt) })}
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      {editing && <ApplicationFormModal app={a} onClose={() => setEditing(false)} onSaved={(x) => refresh(x)} />}
    </>
  );
}

/** The Steward platforms mapped to the application; editors map and remove them. */
function IntegrationsPanel({ app, onSaved }: { app: ApplicationDetail; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const [adding, setAdding] = useState(false);
  const remove = async (platformId: string, name: string) => {
    if (!(await confirmDanger({ action: 'remove', message: t('integrations.removeConfirm', { name }) }))) return;
    try {
      onSaved(await del<ApplicationDetail>(`/applications/${app.id}/platforms/${platformId}`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" data-testid="application-integrations">
      <Group justify="space-between">
        <Text fw={600} id="integrations-title">
          {t('integrations.title')}
        </Text>
        {app.canEdit && !app.archived && (
          <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>
            {t('integrations.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('integrations.help')}
      </Text>
      {app.integrations.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('integrations.empty')}
        </Text>
      ) : (
        <Stack gap={4} role="list" aria-labelledby="integrations-title">
          {app.integrations.map((i, n) => (
            <Group key={i.platformId ?? `hidden-${n}`} justify="space-between" wrap="nowrap" role="listitem">
              <Box style={{ minWidth: 0 }}>
                {i.visible && i.path ? (
                  <Text size="sm">
                    <Anchor component={Link} to={i.path} size="sm">
                      {i.name}
                    </Anchor>
                    {i.environment && (
                      <Badge ml={6} size="xs" variant="outline">
                        {i.environment}
                      </Badge>
                    )}
                  </Text>
                ) : (
                  <Text size="sm" c="dimmed" fs="italic">
                    {t('integrations.notVisible')}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  {t('integrations.mappedBy', { user: i.mappedBy, date: fmtDate(i.mappedAt) })}
                </Text>
              </Box>
              {app.canEdit && i.canManage && i.platformId && (
                <ActionIcon
                  variant="subtle"
                  color="red"
                  aria-label={t('integrations.remove', { name: i.name })}
                  onClick={() => void remove(i.platformId!, i.name)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {adding && <AddPlatformModal app={app} onClose={() => setAdding(false)} onSaved={onSaved} />}
    </Stack>
  );
}

function AddPlatformModal({ app, onClose, onSaved }: { app: ApplicationDetail; onClose: () => void; onSaved: (a: ApplicationDetail) => void }) {
  const { t } = useTranslation(['applications', 'common']);
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<Platform[]>('/platforms') });
  const mapped = new Set(app.integrations.map((i) => i.platformId));
  const [platformId, setPlatformId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = useFieldErrors({ platform: !platformId && t('common:validation.required') });
  const save = async () => {
    if (!v.validate() || !platformId) return;
    setBusy(true);
    try {
      onSaved(await post<ApplicationDetail>(`/applications/${app.id}/platforms`, { platformId }));
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('integrations.addTitle', { name: app.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('integrations.platform')}
            data={(platforms.data ?? [])
              // mapping needs the manage right on the platform
              .filter((p) => !mapped.has(p.id) && p.permissions.includes('manage'))
              .map((p) => ({ value: p.id, label: p.environment ? `${p.name} (${p.environment})` : p.name }))}
            value={platformId}
            onChange={setPlatformId}
            searchable
            required
            nothingFoundMessage={t('noMatch')}
            error={v.error('platform')}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/** The living documents that apply to the application, with edition and review status. */
function ApplicationDocuments({ documents }: { documents: ApplicationDocument[] }) {
  const { t } = useTranslation(['applications', 'services']);
  return (
    <Stack gap="xs" data-testid="application-documents">
      <Text fw={600} id="application-documents-title">
        {t('documents.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('documents.help')}
      </Text>
      {documents.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('documents.empty')}
        </Text>
      ) : (
        <div className="table-scroll">
          <Table fz="sm" aria-labelledby="application-documents-title">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('services:documents.document')}</Table.Th>
                <Table.Th>{t('services:documents.edition')}</Table.Th>
                <Table.Th>{t('services:documents.status')}</Table.Th>
                <Table.Th>{t('services:documents.review')}</Table.Th>
                <Table.Th>{t('services:documents.nextReview')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {documents.map((d) => (
                <Table.Tr key={d.id}>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>
                    <Text span size="xs" c="dimmed" className="mono nowrap">
                      {d.number}
                    </Text>{' '}
                    <Anchor component={Link} to={`/records/${d.id}`} size="sm">
                      {d.title}
                    </Anchor>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    {d.edition ? (
                      <Box w="max-content">
                        <EditionBadge edition={d.edition} size="sm" />
                      </Box>
                    ) : (
                      <Text span size="sm" c="dimmed">
                        {t('services:documents.draft')}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td className="nowrap">
                    <Box w="max-content">
                      <RecordStatusBadge status={d.status} />
                    </Box>
                  </Table.Td>
                  <Table.Td className="nowrap">
                    <Box w="max-content">
                      <ReviewStatusBadge status={d.reviewStatus} />
                    </Box>
                  </Table.Td>
                  <Table.Td className="nowrap">{fmtDay(d.nextReviewAt)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
      )}
    </Stack>
  );
}

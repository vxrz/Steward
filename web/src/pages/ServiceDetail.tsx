import { useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { IconArchive, IconArchiveOff, IconEdit, IconExternalLink } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { TagBadges } from '../components/tags';
import type { ServiceDetail } from '@sm/shared';
import { del, get, notifyError, patch, post } from '../api';
import { DetailState, PageHeader, subjectLabel } from '../components/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { Field, LinksPanel } from '../components/records/common';
import { fmtDate } from '../format';
import { CriticalityBadge, ServiceFormModal } from './Services';
import { TicketsPanel } from '../components/tickets/TicketsPanel';
import { ServiceDocumentsPanel } from '../components/records/ServiceDocuments';
import { confirmDanger } from '../components/confirm';
import { ProtectionNeedPanel } from '../components/catalogue/cia';
import { ServiceApplicationsPanel } from '../components/catalogue/ServiceApplications';
import { DutiesPanel } from '../components/duties/DutiesPanel';
import { ScorecardPanel } from '../components/scorecard/ScorecardPanel';
import { ObjectivesPanel } from '../components/scorecard/ObjectivesPanel';
import { MaintenancePanel } from '../components/catalogue/maintenance';
import { OpenMeasuresPanel } from '../components/records/IncidentReview';

export function ServiceDetailPage() {
  const { t } = useTranslation(['services', 'common']);
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['service', id], queryFn: () => get<ServiceDetail>(`/services/${id}`) });
  const [editing, setEditing] = useState(false);
  const refresh = (s?: ServiceDetail) => {
    if (s) qc.setQueryData(['service', id], s);
    else void qc.invalidateQueries({ queryKey: ['service', id] });
    void qc.invalidateQueries({ queryKey: ['services'] });
    void qc.invalidateQueries({ queryKey: ['applications'] });
  };
  const s = q.data;
  if (!s) return <DetailState query={q} back="services" />;
  const archive = async () => {
    if (!s.archived && !(await confirmDanger({ action: 'archive', message: t('archiveConfirm', { name: s.name }) }))) return;
    try {
      refresh(await post<ServiceDetail>(`/services/${s.id}/archive`, { archived: !s.archived }));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <PageHeader
        back="services"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{s.name}</span>
            <CriticalityBadge value={s.criticality} />
            {s.archived && (
              <Badge variant="outline" color="gray">
                {t('archived')}
              </Badge>
            )}
          </Group>
        }
        description={t('detailLine', { user: s.updatedBy, date: fmtDate(s.updatedAt) })}
        actions={
          s.canEdit && (
            <>
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                {t('common:edit')}
              </Button>
              <Button size="xs" variant="default" leftSection={s.archived ? <IconArchiveOff size={14} /> : <IconArchive size={14} />} onClick={archive}>
                {s.archived ? t('restore') : t('archive')}
              </Button>
            </>
          )
        }
      />
      <Grid gutter="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            <MaintenancePanel kind="service" id={s.id} canPlan={s.canEdit && !s.archived} />
            {s.description.trim() ? (
              <MarkdownView text={s.description} />
            ) : (
              <Text c="dimmed" size="sm">
                {t('noDescription')}
              </Text>
            )}
            <ProtectionNeedPanel service={s} onSaved={refresh} />
            <ServiceApplicationsPanel service={s} onSaved={refresh} />
            {!s.archived && <ScorecardPanel serviceId={s.id} />}
            <DutiesPanel serviceId={s.id} canEdit={s.canEdit && !s.archived} applications={s.applications.map((a) => ({ id: a.id, name: a.name }))} />
            <OpenMeasuresPanel serviceId={s.id} />
            <ObjectivesPanel serviceId={s.id} canEdit={s.canEdit && !s.archived} applications={s.applications.map((a) => ({ id: a.id, name: a.name }))} />
            <ServiceDocumentsPanel service={s} documents={s.documents} />
            <LinksPanel
              links={s.links}
              backlinks={s.backlinks}
              canEdit={s.canEdit}
              self={{ kind: 'service', id: s.id }}
              onAdd={async (l) => {
                await post(`/services/${s.id}/links`, l);
                refresh();
              }}
              onUpdate={async (lid, l) => {
                await patch(`/services/${s.id}/links/${lid}`, l);
                refresh();
              }}
              onRemove={async (lid) => {
                await del(`/services/${s.id}/links/${lid}`);
                refresh();
              }}
            />
            <TicketsPanel kind="service" id={s.id} label={s.name} />
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Field label={t('contacts')}>
                {s.contacts.length === 0 ? (
                  <Text size="sm" c="dimmed">
                    {t('noContacts')}
                  </Text>
                ) : (
                  s.contacts.map((c) => (
                    <Text key={`${c.role}${c.email}`} size="sm">
                      {t(`contactRoles.${c.role}`)}:{' '}
                      <Anchor href={`mailto:${c.email}`} size="sm">
                        {c.name ? `${c.name} <${c.email}>` : c.email}
                      </Anchor>
                    </Text>
                  ))
                )}
              </Field>
              <Field label={t('owners')}>
                <Text size="sm">{s.owners.map(subjectLabel).join(', ') || '–'}</Text>
              </Field>
              <Field label={t('cmdb')}>
                {s.cmdb ? (
                  <Text size="sm">
                    {[s.cmdb.system, s.cmdb.id].filter(Boolean).join(' · ')}
                    {s.cmdb.url && (
                      <>
                        {' '}
                        <Anchor href={s.cmdb.url} target="_blank" rel="noopener noreferrer nofollow" size="sm">
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
              {s.tags.length > 0 && (
                <Field label={t('tags')}>
                  <TagBadges size="sm" tags={s.tags} linkTo={(tag) => `/services?tag=${encodeURIComponent(tag)}`} />
                </Field>
              )}
              <Text size="xs" c="dimmed">
                {t('created', { user: s.createdBy, date: fmtDate(s.createdAt) })}
              </Text>
            </Stack>
          </Paper>
        </Grid.Col>
      </Grid>
      {editing && <ServiceFormModal service={s} onClose={() => setEditing(false)} onSaved={(x) => refresh(x)} />}
    </>
  );
}

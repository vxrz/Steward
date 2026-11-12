import { useEffect, useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, Paper, Stack, Text } from '@mantine/core';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import {
  IconApps,
  IconArchive,
  IconArchiveOff,
  IconCalendarCheck,
  IconEdit,
  IconExternalLink,
  IconFileCertificate,
  IconGauge,
  IconInfoCircle,
  IconReceipt,
  IconServer2,
  IconTarget,
  IconTicket,
  IconTool,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { CopyId } from '../components/CopyId';
import { TagBadges } from '../components/tags';
import type { ApplicationDetail, ServiceDetail } from '@sm/shared';
import { del, get, notifyError, patch, post } from '../api';
import { DetailState } from '../components/common';
import { MarkdownView } from '../components/records/MarkdownView';
import { Field, LinksPanel } from '../components/records/common';
import { fmtDate } from '../format';
import { CriticalityBadge, ServiceFormModal } from './Services';
import { TicketsPanel } from '../components/tickets/TicketsPanel';
import { CopiedFromNote, DuplicateButton } from '../components/duplicate/DuplicateButton';
import { useMe } from '../auth';
import { ServiceDocumentsPanel } from '../components/records/ServiceDocuments';
import { confirmDanger } from '../components/confirm';
import { ProtectionNeedPanel } from '../components/catalogue/cia';
import { ServiceApplicationsPanel } from '../components/catalogue/ServiceApplications';
import { DutiesPanel } from '../components/duties/DutiesPanel';
import { ScorecardPanel } from '../components/scorecard/ScorecardPanel';
import { ObjectivesPanel } from '../components/scorecard/ObjectivesPanel';
import { MaintenancePanel } from '../components/catalogue/maintenance';
import { OpenMeasuresPanel } from '../components/records/IncidentReview';
import { OwningTeams } from '../components/OwningTeams';
import { DataTable } from '../components/DataTable';
import { DetailPage } from '../components/page/DetailPage';
import { CostsButton } from '../components/costs/CostsButton';
import { ServiceCostPlan } from '../components/costs/ServicePlan';
import { ServiceResponsibilitiesPanel } from '../components/compliance/Responsibilities';
import { LinkTabs } from '../components/page/LinkTabs';
import { EnvironmentBadge } from '../components/catalogue/environments';
import { useModuleOn } from '../modules';
import { ServiceSuppliers } from '../components/suppliers/ServiceSuppliers';
import { useSubjectLabel } from '../components/SubjectsInput';

/** The tabs of the service hub (v0.4.0): most catalogue work starts from a service. '' is the overview. */
export const SERVICE_TABS = [
  '',
  'applications',
  'systems',
  'duties',
  'objectives',
  'maintenance',
  'documents',
  'tickets',
  'scorecard',
  'costs',
  'responsibilities',
] as const;
export type ServiceTab = (typeof SERVICE_TABS)[number];
const TAB_ICONS = {
  '': IconInfoCircle,
  applications: IconApps,
  systems: IconServer2,
  duties: IconCalendarCheck,
  objectives: IconTarget,
  maintenance: IconTool,
  documents: IconFileCertificate,
  tickets: IconTicket,
  scorecard: IconGauge,
  costs: IconReceipt,
  responsibilities: IconUsersGroup,
} as const;

export function ServiceDetailPage() {
  const { t } = useTranslation(['services', 'common']);
  const { id, tab: tabParam = '' } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['service', id], queryFn: () => get<ServiceDetail>(`/services/${id}`) });
  const [editing, setEditing] = useState(false);
  // ?edit=1: a copy opens in edit mode (Duplicate)
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.get('edit') !== '1') return;
    setEditing(true);
    params.delete('edit');
    setParams(params, { replace: true });
  }, [params, setParams]);
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  const refresh = (s?: ServiceDetail) => {
    if (s) qc.setQueryData(['service', id], s);
    else void qc.invalidateQueries({ queryKey: ['service', id] });
    void qc.invalidateQueries({ queryKey: ['services'] });
    void qc.invalidateQueries({ queryKey: ['applications'] });
  };
  // objectives and the scorecard belong to the scorecard module (ADR 0016): switched off, their tabs go
  const scorecardOn = useModuleOn('scorecard');
  // the cost plan (ADR 0026) belongs to the costs module
  const costsOn = useModuleOn('costs');
  // the responsibility matrix (ADR 0029) belongs to the compliance module
  const complianceOn = useModuleOn('compliance');
  const tabs = SERVICE_TABS.filter(
    (x) => (scorecardOn || (x !== 'objectives' && x !== 'scorecard')) && (costsOn || x !== 'costs') && (complianceOn || x !== 'responsibilities'),
  );
  const tab = tabs.find((x) => x === tabParam);
  // an unknown tab: the overview
  if (tab === undefined) return <Navigate to={`/services/${id}`} replace />;
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
  const editable = s.canEdit && !s.archived;
  const appRefs = s.applications.map((a) => ({ id: a.id, name: a.name }));
  const counts: Partial<Record<ServiceTab, number>> = { applications: s.applications.length, documents: s.documents.length };
  const base = `/services/${s.id}`;
  return (
    <DetailPage
      back="services"
      title={s.name}
      status={
        <>
          <CriticalityBadge value={s.criticality} />
          {s.archived && (
            <Badge variant="outline" color="gray">
              {t('archived')}
            </Badge>
          )}
        </>
      }
      description={
        <>
          {t('detailLine', { user: s.updatedBy, date: fmtDate(s.updatedAt) })}
          <CopyId id={s.id} />
          <CopiedFromNote kind="service" id={s.id} pathOf={(id) => `/services/${id}`} />
        </>
      }
      recent={{ label: s.name, kind: 'service', to: base }}
      actions={
        <>
          <CostsButton scope="service" id={s.id} />
          {(s.canEdit || canCreate) && (
            <>
              {canCreate && <DuplicateButton kind="service" id={s.id} />}
              {s.canEdit && (
                <>
                  <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                    {t('common:edit')}
                  </Button>
                  <Button size="xs" variant="default" leftSection={s.archived ? <IconArchiveOff size={14} /> : <IconArchive size={14} />} onClick={archive}>
                    {s.archived ? t('restore') : t('archive')}
                  </Button>
                </>
              )}
            </>
          )}
        </>
      }
      tabs={
        <LinkTabs
          label={t('hub.tabsLabel', { name: s.name })}
          active={tab ? `${base}/${tab}` : base}
          tabs={tabs.map((x) => ({
            to: x ? `${base}/${x}` : base,
            label: t(`hub.tabs.${x || 'overview'}`),
            icon: TAB_ICONS[x],
            count: counts[x],
            testId: `service-tab-${x || 'overview'}`,
          }))}
        />
      }
    >
      <div data-testid={`service-hub-${tab || 'overview'}`}>
        {tab === '' && (
          <Grid gap="lg">
            <Grid.Col span={{ base: 12, md: 8 }}>
              <Stack gap="lg">
                {s.description.trim() ? (
                  <MarkdownView text={s.description} />
                ) : (
                  <Text c="dimmed" size="sm">
                    {t('noDescription')}
                  </Text>
                )}
                <ProtectionNeedPanel service={s} onSaved={refresh} />
                <OpenMeasuresPanel serviceId={s.id} />
                <ServiceSuppliers serviceId={s.id} />
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
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <ServiceFacts service={s} />
              <OwningTeams kind="service" id={s.id} mt="md" />
            </Grid.Col>
          </Grid>
        )}
        {tab === 'applications' && <ServiceApplicationsPanel service={s} onSaved={refresh} />}
        {tab === 'systems' && <ServiceSystemsPanel service={s} />}
        {tab === 'duties' && <DutiesPanel serviceId={s.id} canEdit={editable} applications={appRefs} />}
        {tab === 'objectives' && <ObjectivesPanel serviceId={s.id} canEdit={editable} applications={appRefs} />}
        {tab === 'maintenance' && <MaintenancePanel kind="service" id={s.id} canPlan={editable} />}
        {tab === 'documents' && <ServiceDocumentsPanel service={s} documents={s.documents} />}
        {tab === 'tickets' && <TicketsPanel kind="service" id={s.id} label={s.name} />}
        {tab === 'scorecard' &&
          (s.archived ? (
            <Text c="dimmed" size="sm">
              {t('hub.archivedScorecard')}
            </Text>
          ) : (
            <ScorecardPanel serviceId={s.id} />
          ))}
        {tab === 'costs' && <ServiceCostPlan serviceId={s.id} />}
        {tab === 'responsibilities' && <ServiceResponsibilitiesPanel serviceId={s.id} />}
      </div>
      {editing && s.canEdit && <ServiceFormModal service={s} onClose={() => setEditing(false)} onSaved={(x) => refresh(x)} />}
    </DetailPage>
  );
}

/** Contacts, responsible people, CMDB entry and tags beside the overview. */
function ServiceFacts({ service: s }: { service: ServiceDetail }) {
  const { t } = useTranslation(['services', 'common']);
  const subjectName = useSubjectLabel();
  return (
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
          <Text size="sm" data-testid="service-owners">
            {s.owners.map(subjectName).join(', ') || '–'}
          </Text>
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
  );
}

interface SystemRow {
  key: string;
  systemId: string;
  name: string;
  kind: string;
  vendor: string;
  environment: string;
  applications: { id: string; name: string }[];
}

/**
 * The systems the service runs on: the "Runs on" entries of its applications, one row per system and
 * environment. They are changed on the application (its "Runs on").
 */
function ServiceSystemsPanel({ service }: { service: ServiceDetail }) {
  const { t } = useTranslation(['services', 'applications']);
  const apps = useQueries({
    queries: service.applications.map((a) => ({ queryKey: ['application', a.id], queryFn: () => get<ApplicationDetail>(`/applications/${a.id}`) })),
  });
  const loading = apps.some((q) => q.isLoading);
  const rows = new Map<string, SystemRow>();
  for (const q of apps) {
    const a = q.data;
    if (!a) continue;
    for (const l of a.systems) {
      const key = `${l.systemId}|${l.environment}`;
      const row = rows.get(key) ?? { key, systemId: l.systemId, name: l.name, kind: l.kind, vendor: l.vendor, environment: l.environment, applications: [] };
      if (!row.applications.some((x) => x.id === a.id)) row.applications.push({ id: a.id, name: a.name });
      rows.set(key, row);
    }
  }
  const list = [...rows.values()];
  const kind = (k: string) => (t as unknown as (key: string) => string)(`applications:systems.kinds.${k}`);
  const appLinks = (r: SystemRow) =>
    r.applications.map((a, i) => (
      <span key={a.id}>
        {i > 0 && ', '}
        <Anchor component={Link} to={`/applications/${a.id}`} size="sm">
          {a.name}
        </Anchor>
      </span>
    ));
  return (
    <Stack gap="xs" data-testid="service-systems">
      <Text fw={600} id="service-systems-title">
        {t('hub.systems.title')}
      </Text>
      <Text size="xs" c="dimmed">
        {t('hub.systems.help')}
      </Text>
      {!loading && list.length === 0 ? (
        <Text size="sm" c="dimmed">
          {service.applications.length ? t('hub.systems.empty') : t('hub.systems.noApplications')}
        </Text>
      ) : (
        <DataTable
          rows={list}
          rowKey={(r) => r.key}
          ariaLabel={t('hub.systems.title')}
          columns={[
            {
              key: 'name',
              header: t('hub.systems.system'),
              sortValue: (r) => r.name,
              cell: (r) => (
                <Anchor component={Link} to={`/systems/${r.systemId}`} size="sm" fw={500}>
                  {r.name}
                </Anchor>
              ),
            },
            { key: 'kind', header: t('hub.systems.kind'), sortValue: (r) => r.kind, cell: (r) => kind(r.kind) },
            { key: 'vendor', header: t('hub.systems.vendor'), sortValue: (r) => r.vendor, cell: (r) => r.vendor || '–' },
            { key: 'env', header: t('hub.systems.environment'), sortValue: (r) => r.environment, cell: (r) => <EnvironmentBadge value={r.environment} /> },
            { key: 'apps', header: t('hub.systems.applications'), cell: appLinks },
          ]}
          card={(r) => (
            <Paper withBorder p="xs">
              <Group gap={6} wrap="wrap">
                <Anchor component={Link} to={`/systems/${r.systemId}`} size="sm" fw={500}>
                  {r.name}
                </Anchor>
                <EnvironmentBadge value={r.environment} />
              </Group>
              <Text size="xs" c="dimmed" mt={4}>
                {kind(r.kind)}
                {r.vendor ? ` · ${r.vendor}` : ''}
              </Text>
              <Text size="sm" mt={4} component="div">
                {appLinks(r)}
              </Text>
            </Paper>
          )}
        />
      )}
    </Stack>
  );
}

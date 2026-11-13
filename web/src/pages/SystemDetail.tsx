import { useEffect, useState } from 'react';
import { Anchor, Badge, Button, Grid, Group, Paper, Stack, Table, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconEdit, IconExternalLink, IconFileImport, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { SbomPreview, SystemDetail } from '@sm/shared';
import { del, get, notifyError } from '../api';
import { CopyId } from '../components/CopyId';
import { DetailState } from '../components/common';
import { Field } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { fmtDate } from '../format';
import { EnvironmentBadge } from '../components/catalogue/environments';
import { SbomImportModal, SbomLine, StackBadges } from '../components/catalogue/ComponentsPanel';
import { SystemFormModal } from './Systems';
import { CatalogueCredentials } from '../components/catalogue/CatalogueCredentials';
import { MaintenancePanel } from '../components/catalogue/maintenance';
import { AccessTab } from '../components/access/AccessTab';
import { DetailHeader } from '../components/page/DetailPage';
import { FirewallNetworkPanel, NetworkAttributesView } from '../components/catalogue/network';
import { CopiedFromNote, DuplicateButton } from '../components/duplicate/DuplicateButton';
import { useMe } from '../auth';
import { SystemSchemaField } from '../components/dbschema/SystemSchemaField';
import { SupplierText } from '../components/suppliers/SupplierPicker';
import { ItemContacts } from '../components/suppliers/ScopedContacts';
import { CostAttributionPanel } from '../components/costs/Attribution';
import { IfModule } from '../components/modules/ModuleOff';
import { TableScroll } from '../components/TableScroll';
import { useSubjectLabel } from '../components/SubjectsInput';

/** A system (#129): what it is, its tech stack, the platform it is, and the applications that run on it per environment. */
export function SystemDetailPage() {
  const { t } = useTranslation(['applications', 'common']);
  const subjectName = useSubjectLabel();
  const { id } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['system', id], queryFn: () => get<SystemDetail>(`/systems/${id}`) });
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [search, setSearch] = useSearchParams();
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  const s = q.data;
  // ?edit=1 (e.g. after Duplicate): open the form once the system is loaded
  useEffect(() => {
    if (s?.canEdit && search.get('edit') === '1') {
      setEditing(true);
      setSearch({}, { replace: true });
    }
  }, [s?.canEdit, search, setSearch]);
  if (!s) return <DetailState query={q} back="systems" />;
  const saved = (x: SystemDetail) => {
    qc.setQueryData(['system', id], x);
    void qc.invalidateQueries({ queryKey: ['systems'] });
    void qc.invalidateQueries({ queryKey: ['application'] });
  };
  const remove = async () => {
    if (!(await confirmDanger({ action: 'delete', message: t('systems.deleteConfirm', { name: s.name }) }))) return;
    try {
      await del(`/systems/${s.id}`);
      void qc.invalidateQueries({ queryKey: ['systems'] });
      navigate('/systems');
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <>
      <DetailHeader
        recent={{ label: s.name, kind: 'system' }}
        back="systems"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{s.name}</span>
            <Badge variant="default">{t(`systems.kinds.${s.kind}`)}</Badge>
          </Group>
        }
        description={
          <>
            {t('detailLine', { user: s.updatedBy, date: fmtDate(s.updatedAt) })}
            <CopyId id={s.id} />
          </>
        }
        actions={
          (s.canEdit || canCreate) && (
            <>
              {s.canEdit && (
                <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                  {t('common:edit')}
                </Button>
              )}
              {canCreate && <DuplicateButton kind="system" id={s.id} />}
              {s.canEdit && (
                <>
                  <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => setImporting(true)}>
                    {t('systems.importSbom')}
                  </Button>
                  <Button size="xs" variant="default" color="red" leftSection={<IconTrash size={14} />} onClick={() => void remove()}>
                    {t('common:delete')}
                  </Button>
                </>
              )}
            </>
          )
        }
      />
      <CopiedFromNote kind="system" id={s.id} />
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {s.note && <Text size="sm">{s.note}</Text>}
            <MaintenancePanel kind="system" id={s.id} canPlan={s.canEdit} />
            <FirewallNetworkPanel system={s} />
            <Stack gap="xs" data-testid="system-stack">
              <Text fw={600}>{t('components.stack')}</Text>
              <StackBadges stack={s.stack} holder={{ kind: 'system', id: s.id }} />
              {s.sbom && <SbomLine sbom={s.sbom} />}
            </Stack>
            <CatalogueCredentials
              credentials={s.credentials}
              help={t('systems.credentialsHelp')}
              empty={t('systems.noCredentials')}
              testId="system-credentials"
            />
            <Stack gap="xs" data-testid="system-applications">
              <Text fw={600} id="system-apps-title">
                {t('systems.applications')}
              </Text>
              {s.applications.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('systems.noApplications')}
                </Text>
              ) : (
                <TableScroll>
                  <Table fz="sm" aria-labelledby="system-apps-title">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('environments.label')}</Table.Th>
                        <Table.Th>{t('systems.application')}</Table.Th>
                        <Table.Th>{t('runsOn.note')}</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {s.applications.map((a) => (
                        <Table.Tr key={a.linkId}>
                          <Table.Td className="nowrap">
                            <EnvironmentBadge value={a.environment} />
                          </Table.Td>
                          <Table.Td>
                            <Anchor component={Link} to={`/applications/${a.applicationId}`} size="sm">
                              {a.applicationName}
                            </Anchor>
                            {a.archived && (
                              <Badge ml={6} size="xs" variant="outline" color="gray">
                                {t('archived')}
                              </Badge>
                            )}
                          </Table.Td>
                          <Table.Td>{a.note || '–'}</Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </TableScroll>
              )}
            </Stack>
            <IfModule module="costs">
              <CostAttributionPanel kind="system" id={s.id} />
            </IfModule>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="md">
            <Stack gap="sm">
              <Field label={t('systems.vendor')}>
                <SupplierText supplier={s.supplier} vendor={s.vendor} />
              </Field>
              <ItemContacts kind="system" id={s.id} />
              {s.kind === 'network' && <NetworkAttributesView attributes={s.attributes} />}
              <Field label={t('owners')}>{s.owners.length ? s.owners.map(subjectName).join(', ') : '–'}</Field>
              <Field label={t('systems.platform')}>
                {s.platform ? (
                  <Anchor component={Link} to={`/platforms/${s.platform.id}`} size="sm">
                    {s.platform.environment ? `${s.platform.name} (${s.platform.environment})` : s.platform.name}
                  </Anchor>
                ) : s.platformHidden ? (
                  t('systems.platformHidden')
                ) : (
                  '–'
                )}
              </Field>
              <SystemSchemaField system={s} />
              <Field label={t('environments.title')}>
                {s.environments.length ? (
                  <Group gap={4}>
                    {s.environments.map((e) => (
                      <EnvironmentBadge key={e} value={e} />
                    ))}
                  </Group>
                ) : (
                  '–'
                )}
              </Field>
              {s.cmdbUrl && (
                <Field label={t('systems.cmdbUrl')}>
                  <Anchor href={s.cmdbUrl} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                    {t('systems.openCmdb')} <IconExternalLink size={12} aria-hidden />
                  </Anchor>
                </Field>
              )}
              <Text size="xs" c="dimmed">
                {t('systems.created', { user: s.createdBy, date: fmtDate(s.createdAt) })}
              </Text>
            </Stack>
          </Paper>
          <AccessTab kind="system" id={s.id} mt="md" />
          {s.backlinks.length > 0 && (
            <Paper withBorder p="md" mt="md" data-testid="system-backlinks">
              <Stack gap={4}>
                <Text fw={600} size="sm">
                  {t('firewall.linkedFrom')}
                </Text>
                {s.backlinks.map((b) => (
                  <Anchor key={b.linkId} component={Link} to={b.path} size="sm">
                    {b.label}
                    {b.note ? ` (${b.note})` : ''}
                  </Anchor>
                ))}
              </Stack>
            </Paper>
          )}
        </Grid.Col>
      </Grid>
      {editing && <SystemFormModal system={s} onClose={() => setEditing(false)} onSaved={saved} />}
      {importing && (
        <SbomImportModal
          title={t('systems.sbomTitle', { name: s.name })}
          base={`/systems/${s.id}/sbom`}
          onClose={() => setImporting(false)}
          onApplied={(r: { preview: SbomPreview; system: SystemDetail }) => saved(r.system)}
        />
      )}
    </>
  );
}

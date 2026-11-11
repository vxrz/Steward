import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconArchive, IconCheck, IconEdit, IconExternalLink, IconGitMerge, IconPlus, IconRestore, IconTrash, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CIA_DIMENSIONS,
  SUPPLIER_CERTIFICATE_KINDS,
  SUPPLIER_CONTACT_ROLES,
  SUPPLIER_LIMITS,
  SUPPLIER_RENEWALS,
  type SupplierCertificate,
  type SupplierCertificateKind,
  type SupplierContact,
  type SupplierContactRole,
  type SupplierContract,
  type CostScheduleList,
  type SupplierDetail,
  type SupplierRenewal,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { CopyId } from '../components/CopyId';
import { DetailState, subjectLabel, useFieldErrors } from '../components/common';
import { Field } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { fmtDate, fmtDay, fmtNumber, listFormat } from '../format';
import { OwningTeams } from '../components/OwningTeams';
import { DetailHeader } from '../components/page/DetailPage';
import { supplierKeys } from '../queryKeys';
import { DueDate, MergeModal, SupplierFormModal, SupplierStatusBadge } from './Suppliers';
import { SupplierFindings } from '../components/compliance/corrective';
import { useModuleOn } from '../modules';
import { ContractPayments } from '../components/costs/ContractPayments';
import { SupplierCosts } from '../components/costs/Commitments';

const DOC_LINK = /^(https?:\/\/\S+|rec_[A-Za-z0-9_-]{4,40}|[A-Z][A-Z0-9]{0,9}-\d{4}-\d{4,6})$/i;

/** A document link: the record when the reader may open it, else the URL (or the text as it is). */
function DocLink({ link, record }: { link: string; record?: { id: string; number: string; title: string } | null }) {
  if (record)
    return (
      <Anchor component={Link} to={`/records/${record.id}`} size="sm">
        {record.number} {record.title}
      </Anchor>
    );
  if (/^https?:\/\//i.test(link))
    return (
      <Anchor href={link} target="_blank" rel="noopener noreferrer nofollow" size="sm">
        {link.replace(/^https?:\/\//, '').slice(0, 60)} <IconExternalLink size={12} aria-hidden />
      </Anchor>
    );
  return <Text size="sm">{link || '–'}</Text>;
}

/** A supplier (0.17.0, ADR 0029): contracts, certificates, contacts, what links it and its review duty. */
export function SupplierDetailPage() {
  const { t } = useTranslation(['suppliers', 'common', 'applications', 'corrective']);
  const { id } = useParams();
  const complianceOn = useModuleOn('compliance');
  const costsOn = useModuleOn('costs');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: supplierKeys.detail(id), queryFn: () => get<SupplierDetail>(`/suppliers/${id}`) });
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [contact, setContact] = useState<SupplierContact | 'new' | null>(null);
  const [contract, setContract] = useState<SupplierContract | 'new' | null>(null);
  const [certificate, setCertificate] = useState<SupplierCertificate | 'new' | null>(null);
  const s = q.data;
  if (!s) return <DetailState query={q} back="suppliers" />;
  const saved = (x: SupplierDetail) => {
    qc.setQueryData(supplierKeys.detail(id), x);
    void qc.invalidateQueries({ queryKey: supplierKeys.all });
  };
  const act = async (fn: () => Promise<SupplierDetail | unknown>, ok: string) => {
    try {
      const r = await fn();
      notifyOk(ok);
      if (r && typeof r === 'object' && 'id' in r) saved(r as SupplierDetail);
      else void qc.invalidateQueries({ queryKey: supplierKeys.all });
    } catch (e) {
      notifyError(e);
    }
  };
  const dismiss = async () => {
    if (
      !(await confirmDanger({
        action: 'remove',
        title: t('actions.notSupplier'),
        confirmLabel: t('actions.notSupplier'),
        message: t('confirmNotSupplier', { name: s.name }),
      }))
    )
      return;
    try {
      await post(`/suppliers/${s.id}/not-a-supplier`);
      notifyOk(t('actions.dismissed'));
      void qc.invalidateQueries({ queryKey: supplierKeys.all });
      navigate('/suppliers?status=unconfirmed');
    } catch (e) {
      notifyError(e);
    }
  };
  const archive = async (archived: boolean) => {
    if (archived && !(await confirmDanger({ action: 'archive', message: t('confirmArchive', { name: s.name }) }))) return;
    await act(() => post<SupplierDetail>(`/suppliers/${s.id}/archive`, { archived }), archived ? t('actions.archived') : t('actions.unarchived'));
  };
  const remove = async (what: 'contacts' | 'contracts' | 'certificates', itemId: string, message: string) => {
    if (!(await confirmDanger({ action: 'remove', message }))) return;
    try {
      saved(await del<SupplierDetail>(`/suppliers/${s.id}/${what}/${itemId}`));
    } catch (e) {
      notifyError(e);
    }
  };
  /** Removing a contract removes its payment schedules (ADR 0030): the dialog names the paying services first. */
  const removeContract = async (c: SupplierContract) => {
    let services: string[] = [];
    if (costsOn)
      try {
        services = [...new Set((await get<CostScheduleList>(`/costs/schedules?contractId=${encodeURIComponent(c.id)}`)).schedules.map((x) => x.serviceName))];
      } catch {
        // no list (the Costs module switched off meanwhile): the plain question
      }
    await remove(
      'contracts',
      c.id,
      services.length
        ? t('contracts.removeWithPayments', { name: c.title, services: listFormat().format(services), count: services.length })
        : t('contracts.removeConfirm', { name: c.title }),
    );
  };
  const certName = (c: SupplierCertificate) => (c.kind === 'other' && c.name ? c.name : t(`certificates.kinds.${c.kind}`));
  const crit = CIA_DIMENSIONS.filter((d) => s.criticality[d]);
  return (
    <>
      <DetailHeader
        recent={{ label: s.name, kind: 'supplier' }}
        back="suppliers"
        title={
          <Group gap="sm" wrap="wrap">
            <span>{s.name}</span>
            <Badge variant="default">{t(`types.${s.type}`)}</Badge>
          </Group>
        }
        status={<SupplierStatusBadge status={s.status} />}
        description={
          <>
            {t('detail.updated', { user: s.updatedBy, date: fmtDate(s.updatedAt) })}
            <CopyId id={s.id} />
          </>
        }
        actions={
          <>
            {s.canEdit && (
              <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)}>
                {t('common:edit')}
              </Button>
            )}
            {s.canManage && s.status === 'unconfirmed' && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconCheck size={14} />}
                onClick={() => void act(() => post<SupplierDetail>(`/suppliers/${s.id}/confirm`), t('actions.confirmed'))}
              >
                {t('actions.confirm')}
              </Button>
            )}
          </>
        }
        menu={
          s.canManage
            ? {
                items: [
                  ...(s.status !== 'archived'
                    ? [{ label: t('actions.merge'), icon: IconGitMerge, onClick: () => setMerging(true), testId: 'supplier-merge' }]
                    : []),
                  ...(s.status === 'unconfirmed'
                    ? [{ label: t('actions.notSupplier'), icon: IconX, color: 'red', onClick: () => void dismiss(), testId: 'supplier-dismiss' }]
                    : []),
                  s.status === 'archived'
                    ? { label: t('actions.unarchive'), icon: IconRestore, onClick: () => void archive(false) }
                    : { label: t('actions.archive'), icon: IconArchive, onClick: () => void archive(true), testId: 'supplier-archive' },
                ],
              }
            : undefined
        }
      />
      {s.status === 'unconfirmed' && (
        <Alert color="yellow" variant="light" mb="md" data-testid="supplier-unconfirmed">
          {t('detail.unconfirmedNote')}
        </Alert>
      )}
      {s.status === 'archived' && (
        <Alert color="gray" variant="light" mb="md">
          {t('detail.archivedNote')}
        </Alert>
      )}
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            {s.description && <Text size="sm">{s.description}</Text>}
            {/* ---- contracts ---- */}
            <Stack gap="xs" data-testid="supplier-contracts">
              <Group justify="space-between">
                <Text fw={600} id="supplier-contracts-title">
                  {t('contracts.title')}
                </Text>
                {s.canEdit && (
                  <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setContract('new')}>
                    {t('contracts.add')}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {t('contracts.help')}
              </Text>
              {s.contracts.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('contracts.empty')}
                </Text>
              ) : (
                s.contracts.map((c) => (
                  <Paper withBorder p="sm" key={c.id}>
                    <Group justify="space-between" wrap="nowrap" align="flex-start">
                      <div style={{ minWidth: 0 }}>
                        <Text fw={600} size="sm">
                          {c.title}
                          {c.reference ? ` · ${c.reference}` : ''}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {[
                            c.startsOn || c.endsOn ? `${c.startsOn ? fmtDay(c.startsOn) : '…'} – ${c.endsOn ? fmtDay(c.endsOn) : '…'}` : '',
                            c.renewal === 'automatic' ? t('contracts.renewsBy', { count: c.renewalMonths ?? 0 }) : t(`contracts.renewals.${c.renewal}`),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </div>
                      {s.canEdit && (
                        <Group gap={4} wrap="nowrap">
                          <ActionIcon variant="subtle" aria-label={t('contracts.edit')} onClick={() => setContract(c)}>
                            <IconEdit size={14} />
                          </ActionIcon>
                          <ActionIcon variant="subtle" color="red" aria-label={t('common:remove')} onClick={() => void removeContract(c)}>
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Group>
                      )}
                    </Group>
                    <Group gap="lg" mt="xs" wrap="wrap" align="flex-start">
                      <Field label={t('contracts.noticeBy')}>
                        <DueDate date={c.noticeBy} state={c.noticeState} />
                      </Field>
                      {c.termEnd && c.termEnd !== c.endsOn && <Field label={t('contracts.termEnd')}>{fmtDay(c.termEnd)}</Field>}
                      {(c.slaAvailability !== null || c.slaSupportHours) && (
                        <Field label={t('contracts.sla')}>
                          <Text size="sm">
                            {[c.slaAvailability !== null ? `${fmtNumber(c.slaAvailability)} %` : '', c.slaSupportHours].filter(Boolean).join(' · ')}
                          </Text>
                        </Field>
                      )}
                      {(c.rtoHours !== null || c.rpoHours !== null) && (
                        <Field label={`${t('contracts.rtoHours')} / ${t('contracts.rpoHours')}`}>
                          <Text size="sm">
                            {t('contracts.rtoRpo', {
                              rto: c.rtoHours === null ? '–' : fmtNumber(c.rtoHours),
                              rpo: c.rpoHours === null ? '–' : fmtNumber(c.rpoHours),
                            })}
                          </Text>
                        </Field>
                      )}
                      {c.link && (
                        <Field label={t('contracts.link')}>
                          <DocLink link={c.link} record={c.record} />
                        </Field>
                      )}
                    </Group>
                    {c.slaResponse && (
                      <Text size="xs" mt={4}>
                        {t('contracts.slaResponse')}: {c.slaResponse}
                      </Text>
                    )}
                    {c.costPlanLines.length > 0 && (
                      <Text size="xs" mt={4}>
                        {t('contracts.costPlanLines')}:{' '}
                        {c.costPlanLines.map((l, i) => (
                          <span key={l.id}>
                            {i > 0 && ', '}
                            <Anchor component={Link} to={`/services/${l.serviceId}?tab=costs`} size="xs">
                              {l.serviceName} · {l.title} ({l.fiscalYear})
                            </Anchor>
                          </span>
                        ))}
                      </Text>
                    )}
                    {c.note && (
                      <Text size="xs" c="dimmed" mt={4}>
                        {c.note}
                      </Text>
                    )}
                    {costsOn && <ContractPayments contractId={c.id} contractTitle={c.title} />}
                  </Paper>
                ))
              )}
            </Stack>
            {/* ---- payments and what they owe (Costs module, ADR 0030) ---- */}
            {costsOn && <SupplierCosts supplierId={s.id} />}
            {/* ---- certificates ---- */}
            <Stack gap="xs" data-testid="supplier-certificates">
              <Group justify="space-between">
                <Text fw={600} id="supplier-certificates-title">
                  {t('certificates.title')}
                </Text>
                {s.canEdit && (
                  <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setCertificate('new')}>
                    {t('certificates.add')}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {t('certificates.help')}
              </Text>
              {s.certificates.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('certificates.empty')}
                </Text>
              ) : (
                <div className="table-scroll">
                  <Table fz="sm" aria-labelledby="supplier-certificates-title">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('certificates.kind')}</Table.Th>
                        <Table.Th>{t('certificates.scope')}</Table.Th>
                        <Table.Th>{t('certificates.validUntil')}</Table.Th>
                        <Table.Th>{t('certificates.link')}</Table.Th>
                        {s.canEdit && <Table.Th aria-label={t('common:edit')} />}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {s.certificates.map((c) => (
                        <Table.Tr key={c.id}>
                          <Table.Td>
                            <Text size="sm" fw={500}>
                              {certName(c)}
                            </Text>
                            {c.issuer && (
                              <Text size="xs" c="dimmed">
                                {c.issuer}
                              </Text>
                            )}
                            {c.checkedBy && c.checkedAt && (
                              <Text size="xs" c="dimmed">
                                {t('certificates.checkedBy', { user: c.checkedBy, date: fmtDay(c.checkedAt) })}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>{c.scope || '–'}</Table.Td>
                          <Table.Td className="nowrap">
                            <DueDate date={c.validUntil} state={c.state} />
                          </Table.Td>
                          <Table.Td>{c.link ? <DocLink link={c.link} record={c.record} /> : '–'}</Table.Td>
                          {s.canEdit && (
                            <Table.Td>
                              <Group gap={4} wrap="nowrap">
                                <ActionIcon variant="subtle" aria-label={t('certificates.edit')} onClick={() => setCertificate(c)}>
                                  <IconEdit size={14} />
                                </ActionIcon>
                                <ActionIcon
                                  variant="subtle"
                                  color="red"
                                  aria-label={t('common:remove')}
                                  onClick={() => void remove('certificates', c.id, t('certificates.removeConfirm', { name: certName(c) }))}
                                >
                                  <IconTrash size={14} />
                                </ActionIcon>
                              </Group>
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Stack>
            {/* ---- contacts ---- */}
            <Stack gap="xs" data-testid="supplier-contacts">
              <Group justify="space-between">
                <Text fw={600} id="supplier-contacts-title">
                  {t('contacts.title')}
                </Text>
                {s.canEdit && (
                  <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setContact('new')}>
                    {t('contacts.add')}
                  </Button>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {t('contacts.help')}
              </Text>
              {s.contacts.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('contacts.empty')}
                </Text>
              ) : (
                <div className="table-scroll">
                  <Table fz="sm" aria-labelledby="supplier-contacts-title">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>{t('contacts.name')}</Table.Th>
                        <Table.Th>{t('contacts.role')}</Table.Th>
                        <Table.Th>{t('contacts.email')}</Table.Th>
                        <Table.Th>{t('contacts.phone')}</Table.Th>
                        {s.canEdit && <Table.Th aria-label={t('common:edit')} />}
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {s.contacts.map((c) => (
                        <Table.Tr key={c.id}>
                          <Table.Td>
                            {c.name}
                            {c.note && (
                              <Text size="xs" c="dimmed">
                                {c.note}
                              </Text>
                            )}
                          </Table.Td>
                          <Table.Td>{t(`contacts.roles.${c.role}`)}</Table.Td>
                          <Table.Td>
                            {c.email ? (
                              <Anchor href={`mailto:${c.email}`} size="sm">
                                {c.email}
                              </Anchor>
                            ) : (
                              '–'
                            )}
                          </Table.Td>
                          <Table.Td className="nowrap">{c.phone || '–'}</Table.Td>
                          {s.canEdit && (
                            <Table.Td>
                              <Group gap={4} wrap="nowrap">
                                <ActionIcon variant="subtle" aria-label={t('contacts.edit')} onClick={() => setContact(c)}>
                                  <IconEdit size={14} />
                                </ActionIcon>
                                <ActionIcon
                                  variant="subtle"
                                  color="red"
                                  aria-label={t('common:remove')}
                                  onClick={() => void remove('contacts', c.id, t('contacts.removeConfirm', { name: c.name }))}
                                >
                                  <IconTrash size={14} />
                                </ActionIcon>
                              </Group>
                            </Table.Td>
                          )}
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </div>
              )}
            </Stack>
            {/* ---- used by ---- */}
            <Stack gap="xs" data-testid="supplier-used-by">
              <Text fw={600}>{t('usedBy.title')}</Text>
              {s.usedBy.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('usedBy.empty')}
                </Text>
              ) : (
                <Stack gap={4}>
                  {s.usedBy.map((u) => (
                    <Group key={`${u.kind}:${u.id}`} gap="xs" wrap="nowrap">
                      <Badge size="xs" variant="default" style={{ flexShrink: 0 }}>
                        {t(`usedBy.kinds.${u.kind}`)}
                      </Badge>
                      <Anchor component={Link} to={u.path} size="sm" style={{ overflowWrap: 'anywhere' }}>
                        {u.name}
                      </Anchor>
                      {u.detail && (
                        <Text size="xs" c="dimmed" truncate>
                          {u.kind === 'finding' ? t(`corrective:statuses.${u.detail}`, { defaultValue: u.detail }) : u.detail}
                        </Text>
                      )}
                    </Group>
                  ))}
                </Stack>
              )}
            </Stack>
            {/* ---- corrective action findings about the supplier (Compliance module) ---- */}
            {complianceOn && <SupplierFindings supplier={{ id: s.id, name: s.name, status: s.status }} />}
            {/* ---- the supplier review ---- */}
            <Stack gap="xs" data-testid="supplier-duties">
              <Text fw={600}>{t('duties.title')}</Text>
              <Text size="xs" c="dimmed">
                {t('duties.help')}
              </Text>
              {s.duties.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('duties.empty')}
                </Text>
              ) : (
                s.duties.map((d) => (
                  <Group key={d.id} gap="xs" wrap="wrap">
                    <Anchor component={Link} to={`/duties/${d.id}`} size="sm">
                      {d.name}
                    </Anchor>
                    <Text size="xs" c="dimmed">
                      {d.serviceName}
                    </Text>
                    {d.periods.map((p) => (
                      <Badge
                        key={p.periodKey}
                        size="xs"
                        variant="light"
                        color={p.status === 'done' ? 'green' : p.status === 'missed' || p.status === 'failed' ? 'red' : 'gray'}
                      >
                        {p.periodKey}: {p.status}
                      </Badge>
                    ))}
                  </Group>
                ))
              )}
            </Stack>
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Paper withBorder p="md">
            <Stack gap="sm">
              <Field label={t('fields.website')}>
                {s.website ? (
                  <Anchor href={s.website} target="_blank" rel="noopener noreferrer nofollow" size="sm">
                    {s.website.replace(/^https?:\/\//, '')} <IconExternalLink size={12} aria-hidden />
                  </Anchor>
                ) : (
                  '–'
                )}
              </Field>
              <Field label={t('fields.owners')}>{s.owners.length ? s.owners.map(subjectLabel).join(', ') : '–'}</Field>
              <Field label={t('detail.dataProtection')}>
                <Text size="sm">
                  {!s.personalData ? t('dpa.none') : t(`dpa.${s.dpaStatus ?? 'missing'}`)}
                  {s.personalData && s.dpaStatus === 'inPlace' && s.dpaSince ? ` · ${fmtDay(s.dpaSince)}` : ''}
                </Text>
                {s.personalData && s.dpaStatus === 'missing' && (
                  <Badge size="xs" color="red" variant="light">
                    {t('dpa.missing')}
                  </Badge>
                )}
                {s.dpaLink && <DocLink link={s.dpaLink} />}
              </Field>
              <Field label={t('fields.criticality')}>
                <Text size="sm">{crit.length ? crit.map((d) => `${t(`applications:cia.dimensions.${d}`)}: ${s.criticality[d]!.label}`).join(' · ') : '–'}</Text>
                <Text size="xs" c="dimmed">
                  {t('fields.criticalityHint')}
                </Text>
              </Field>
              {s.aliases.length > 0 && <Field label={t('fields.aliases')}>{s.aliases.join(', ')}</Field>}
              {s.migratedFrom.length > 0 && (
                <Field label={t('detail.migratedFrom')}>
                  {s.migratedFrom.map((m) => (
                    <Text size="sm" key={m.table}>
                      {t(`detail.migratedTable.${m.table}` as 'detail.migratedTable.applications')}: {m.spellings.join(', ')}
                    </Text>
                  ))}
                </Field>
              )}
              <Text size="xs" c="dimmed">
                {t('detail.created', { user: s.createdBy, date: fmtDate(s.createdAt) })}
              </Text>
            </Stack>
          </Paper>
          <OwningTeams kind="supplier" id={s.id} mt="md" />
        </Grid.Col>
      </Grid>
      {editing && <SupplierFormModal supplier={s} onClose={() => setEditing(false)} onSaved={saved} />}
      {merging && (
        <MergeModal
          supplier={s}
          onClose={() => setMerging(false)}
          onMerged={(into) => {
            setMerging(false);
            void qc.invalidateQueries({ queryKey: supplierKeys.all });
            navigate(`/suppliers/${into.id}`);
          }}
        />
      )}
      {contact && <ContactModal supplierId={s.id} contact={contact === 'new' ? undefined : contact} onClose={() => setContact(null)} onSaved={saved} />}
      {contract && <ContractModal supplierId={s.id} contract={contract === 'new' ? undefined : contract} onClose={() => setContract(null)} onSaved={saved} />}
      {certificate && (
        <CertificateModal
          supplierId={s.id}
          certificate={certificate === 'new' ? undefined : certificate}
          onClose={() => setCertificate(null)}
          onSaved={saved}
        />
      )}
    </>
  );
}

/** Saves a contact, contract or certificate with `send` and hands the supplier back. */
function useSave(send: (body: unknown) => Promise<SupplierDetail>, onSaved: (s: SupplierDetail) => void, onClose: () => void) {
  const [busy, setBusy] = useState(false);
  return {
    busy,
    save: async (body: unknown) => {
      setBusy(true);
      try {
        onSaved(await send(body));
        onClose();
      } catch (e) {
        notifyError(e);
        setBusy(false);
      }
    },
  };
}

function FormButtons({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  const { t } = useTranslation('common');
  return (
    <Group justify="flex-end">
      <Button variant="default" onClick={onClose}>
        {t('cancel')}
      </Button>
      <Button type="submit" loading={busy}>
        {t('save')}
      </Button>
    </Group>
  );
}

function ContactModal({
  supplierId,
  contact,
  onClose,
  onSaved,
}: {
  supplierId: string;
  contact?: SupplierContact;
  onClose: () => void;
  onSaved: (s: SupplierDetail) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [name, setName] = useState(contact?.name ?? '');
  const [role, setRole] = useState<SupplierContactRole>(contact?.role ?? 'accountManager');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [note, setNote] = useState(contact?.note ?? '');
  const v = useFieldErrors({
    name: !name.trim() && t('common:validation.required'),
    email: !!email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && t('common:validation.invalid'),
  });
  const { busy, save } = useSave(
    (body) =>
      contact ? put<SupplierDetail>(`/suppliers/${supplierId}/contacts/${contact.id}`, body) : post<SupplierDetail>(`/suppliers/${supplierId}/contacts`, body),
    onSaved,
    onClose,
  );
  return (
    <Modal opened onClose={onClose} title={contact ? t('contacts.edit') : t('contacts.add')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save({ name: name.trim(), role, email: email.trim(), phone: phone.trim(), note });
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('contacts.name')}
            required
            maxLength={SUPPLIER_LIMITS.text}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            error={v.error('name')}
            data-autofocus
          />
          <Select
            label={t('contacts.role')}
            data={SUPPLIER_CONTACT_ROLES.map((r) => ({ value: r, label: t(`contacts.roles.${r}`) }))}
            value={role}
            allowDeselect={false}
            onChange={(r) => r && setRole(r as SupplierContactRole)}
          />
          <Group grow align="flex-start">
            <TextInput
              label={t('contacts.email')}
              type="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              error={v.error('email')}
            />
            <TextInput label={t('contacts.phone')} type="tel" maxLength={40} value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
          </Group>
          <Textarea
            label={t('contacts.note')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SUPPLIER_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </Modal>
  );
}

const numOrNull = (v: string | number) => (v === '' || v === null || v === undefined ? null : Number(v));

function ContractModal({
  supplierId,
  contract,
  onClose,
  onSaved,
}: {
  supplierId: string;
  contract?: SupplierContract;
  onClose: () => void;
  onSaved: (s: SupplierDetail) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [title, setTitle] = useState(contract?.title ?? '');
  const [reference, setReference] = useState(contract?.reference ?? '');
  const [startsOn, setStartsOn] = useState(contract?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(contract?.endsOn ?? '');
  const [noticeDays, setNoticeDays] = useState<string | number>(contract?.noticeDays ?? '');
  const [renewal, setRenewal] = useState<SupplierRenewal>(contract?.renewal ?? 'fixedEnd');
  const [renewalMonths, setRenewalMonths] = useState<string | number>(contract?.renewalMonths ?? 12);
  const [link, setLink] = useState(contract?.link ?? '');
  const [slaAvailability, setSlaAvailability] = useState<string | number>(contract?.slaAvailability ?? '');
  const [slaSupportHours, setSlaSupportHours] = useState(contract?.slaSupportHours ?? '');
  const [slaResponse, setSlaResponse] = useState(contract?.slaResponse ?? '');
  const [rtoHours, setRtoHours] = useState<string | number>(contract?.rtoHours ?? '');
  const [rpoHours, setRpoHours] = useState<string | number>(contract?.rpoHours ?? '');
  const [note, setNote] = useState(contract?.note ?? '');
  const v = useFieldErrors({
    title: !title.trim() && t('common:validation.required'),
    endsOn: !!startsOn && !!endsOn && endsOn < startsOn && t('common:validation.invalid'),
    link: !!link.trim() && !DOC_LINK.test(link.trim()) && t('common:validation.invalid'),
  });
  const { busy, save } = useSave(
    (body) =>
      contract
        ? put<SupplierDetail>(`/suppliers/${supplierId}/contracts/${contract.id}`, body)
        : post<SupplierDetail>(`/suppliers/${supplierId}/contracts`, body),
    onSaved,
    onClose,
  );
  return (
    <Modal opened onClose={onClose} size="lg" title={contract ? t('contracts.edit') : t('contracts.add')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.validate()) return;
          void save({
            title: title.trim(),
            reference: reference.trim(),
            startsOn: startsOn || null,
            endsOn: endsOn || null,
            noticeDays: numOrNull(noticeDays),
            renewal,
            renewalMonths: renewal === 'automatic' ? numOrNull(renewalMonths) : null,
            link: link.trim(),
            slaAvailability: numOrNull(slaAvailability),
            slaSupportHours: slaSupportHours.trim(),
            slaResponse: slaResponse.trim(),
            rtoHours: numOrNull(rtoHours),
            rpoHours: numOrNull(rpoHours),
            note,
          });
        }}
      >
        <Stack gap="sm">
          <Group grow align="flex-start">
            <TextInput
              label={t('contracts.titleField')}
              required
              maxLength={SUPPLIER_LIMITS.text}
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
              error={v.error('title')}
              data-autofocus
            />
            <TextInput
              label={t('contracts.reference')}
              maxLength={SUPPLIER_LIMITS.reference}
              value={reference}
              onChange={(e) => setReference(e.currentTarget.value)}
            />
          </Group>
          <Group grow align="flex-start">
            <TextInput type="date" label={t('contracts.startsOn')} value={startsOn} onChange={(e) => setStartsOn(e.currentTarget.value)} />
            <TextInput type="date" label={t('contracts.endsOn')} value={endsOn} onChange={(e) => setEndsOn(e.currentTarget.value)} error={v.error('endsOn')} />
            <NumberInput
              label={t('contracts.noticeDays')}
              min={0}
              max={SUPPLIER_LIMITS.noticeDays}
              allowDecimal={false}
              value={noticeDays}
              onChange={setNoticeDays}
            />
          </Group>
          <Group grow align="flex-start">
            <Select
              label={t('contracts.renewal')}
              data={SUPPLIER_RENEWALS.map((r) => ({ value: r, label: t(`contracts.renewals.${r}`) }))}
              value={renewal}
              allowDeselect={false}
              onChange={(r) => r && setRenewal(r as SupplierRenewal)}
            />
            {renewal === 'automatic' && (
              <NumberInput
                label={t('contracts.renewalMonths')}
                min={1}
                max={SUPPLIER_LIMITS.renewalMonths}
                allowDecimal={false}
                value={renewalMonths}
                onChange={setRenewalMonths}
              />
            )}
          </Group>
          <TextInput
            label={t('contracts.link')}
            description={t('fields.docLinkHint')}
            value={link}
            onChange={(e) => setLink(e.currentTarget.value)}
            error={v.error('link')}
          />
          <Text fw={600} size="sm">
            {t('contracts.sla')}
          </Text>
          <Group grow align="flex-start">
            <NumberInput label={t('contracts.slaAvailability')} min={0} max={100} decimalScale={3} value={slaAvailability} onChange={setSlaAvailability} />
            <TextInput
              label={t('contracts.slaSupportHours')}
              maxLength={SUPPLIER_LIMITS.text}
              value={slaSupportHours}
              onChange={(e) => setSlaSupportHours(e.currentTarget.value)}
            />
          </Group>
          <Textarea
            label={t('contracts.slaResponse')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SUPPLIER_LIMITS.note}
            value={slaResponse}
            onChange={(e) => setSlaResponse(e.currentTarget.value)}
          />
          <Group grow align="flex-start">
            <NumberInput label={t('contracts.rtoHours')} min={0} max={SUPPLIER_LIMITS.hours} decimalScale={2} value={rtoHours} onChange={setRtoHours} />
            <NumberInput label={t('contracts.rpoHours')} min={0} max={SUPPLIER_LIMITS.hours} decimalScale={2} value={rpoHours} onChange={setRpoHours} />
          </Group>
          <Textarea
            label={t('contracts.note')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SUPPLIER_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </Modal>
  );
}

function CertificateModal({
  supplierId,
  certificate,
  onClose,
  onSaved,
}: {
  supplierId: string;
  certificate?: SupplierCertificate;
  onClose: () => void;
  onSaved: (s: SupplierDetail) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [kind, setKind] = useState<SupplierCertificateKind>(certificate?.kind ?? 'iso27001');
  const [name, setName] = useState(certificate?.name ?? '');
  const [scope, setScope] = useState(certificate?.scope ?? '');
  const [issuer, setIssuer] = useState(certificate?.issuer ?? '');
  const [issuedOn, setIssuedOn] = useState(certificate?.issuedOn ?? '');
  const [validUntil, setValidUntil] = useState(certificate?.validUntil ?? '');
  const [link, setLink] = useState(certificate?.link ?? '');
  const [checked, setChecked] = useState(false);
  const v = useFieldErrors({ link: !!link.trim() && !DOC_LINK.test(link.trim()) && t('common:validation.invalid') });
  const { busy, save } = useSave(
    (body) =>
      certificate
        ? put<SupplierDetail>(`/suppliers/${supplierId}/certificates/${certificate.id}`, body)
        : post<SupplierDetail>(`/suppliers/${supplierId}/certificates`, body),
    onSaved,
    onClose,
  );
  return (
    <Modal opened onClose={onClose} size="lg" title={certificate ? t('certificates.edit') : t('certificates.add')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!v.validate()) return;
          void save({
            kind,
            name: name.trim(),
            scope: scope.trim(),
            issuer: issuer.trim(),
            issuedOn: issuedOn || null,
            validUntil: validUntil || null,
            link: link.trim(),
            checked,
          });
        }}
      >
        <Stack gap="sm">
          <Group grow align="flex-start">
            <Select
              label={t('certificates.kind')}
              data={SUPPLIER_CERTIFICATE_KINDS.map((k) => ({ value: k, label: t(`certificates.kinds.${k}`) }))}
              value={kind}
              allowDeselect={false}
              onChange={(k) => k && setKind(k as SupplierCertificateKind)}
              data-autofocus
            />
            <TextInput
              label={t('certificates.name')}
              description={t('certificates.nameHint')}
              maxLength={SUPPLIER_LIMITS.text}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
            />
          </Group>
          <Textarea
            label={t('certificates.scope')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SUPPLIER_LIMITS.note}
            value={scope}
            onChange={(e) => setScope(e.currentTarget.value)}
          />
          <TextInput label={t('certificates.issuer')} maxLength={SUPPLIER_LIMITS.text} value={issuer} onChange={(e) => setIssuer(e.currentTarget.value)} />
          <Group grow align="flex-start">
            <TextInput type="date" label={t('certificates.issuedOn')} value={issuedOn} onChange={(e) => setIssuedOn(e.currentTarget.value)} />
            <TextInput
              type="date"
              label={t('certificates.validUntil')}
              description={t('certificates.validUntilHint')}
              value={validUntil}
              onChange={(e) => setValidUntil(e.currentTarget.value)}
            />
          </Group>
          <TextInput
            label={t('certificates.link')}
            description={t('fields.docLinkHint')}
            value={link}
            onChange={(e) => setLink(e.currentTarget.value)}
            error={v.error('link')}
          />
          <Checkbox label={t('certificates.checked')} checked={checked} onChange={(e) => setChecked(e.currentTarget.checked)} />
          <FormButtons busy={busy} onClose={onClose} />
        </Stack>
      </form>
    </Modal>
  );
}

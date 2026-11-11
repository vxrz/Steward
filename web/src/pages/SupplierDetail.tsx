import { useState } from 'react';
import { ActionIcon, Alert, Anchor, Badge, Button, Checkbox, Chip, Grid, Group, Paper, Select, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { IconArchive, IconCheck, IconEdit, IconExternalLink, IconGitMerge, IconPlus, IconRestore, IconTrash, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  CIA_DIMENSIONS,
  SUPPLIER_CERTIFICATE_KINDS,
  SUPPLIER_LIMITS,
  type SupplierCertificate,
  type SupplierCertificateKind,
  type SupplierContract,
  type SupplierDetail,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { CopyId } from '../components/CopyId';
import { DetailState, subjectLabel, useFieldErrors } from '../components/common';
import { Field } from '../components/records/common';
import { confirmDanger } from '../components/confirm';
import { fmtDate, fmtDay } from '../format';
import { OwningTeams } from '../components/OwningTeams';
import { DetailHeader } from '../components/page/DetailPage';
import { LinkTabs } from '../components/page/LinkTabs';
import { supplierKeys } from '../queryKeys';
import { DueDate, MergeModal, SupplierFormModal, SupplierStatusBadge } from './Suppliers';
import { SupplierFindings } from '../components/compliance/corrective';
import { useModuleOn } from '../modules';
import { SupplierCosts } from '../components/costs/Commitments';
import { ContractModal } from '../components/suppliers/ContractForm';
import { SupplierContacts } from '../components/suppliers/ScopedContacts';
import { DocLink, DpaState, RemoveContractModal } from '../components/suppliers/contractParts';
import { FormModal, FormModalCancel } from '../components/FormModal';
import { TableScroll } from '../components/TableScroll';

const DOC_LINK = /^(https?:\/\/\S+|rec_[A-Za-z0-9_-]{4,40}|[A-Z][A-Z0-9]{0,9}-\d{4}-\d{4,6})$/i;
const TABS = ['overview', 'contracts', 'services', 'contacts', 'certificates', 'usedBy'] as const;
type Tab = (typeof TABS)[number];

/**
 * A supplier (0.17.0, ADR 0029; shared since 0.18.0, ADR 0031): the company record and – in tabs – its contracts with
 * the services they cover, the services it serves, its contacts, certificates and what links it.
 */
export function SupplierDetailPage() {
  const { t } = useTranslation(['suppliers', 'common', 'applications', 'corrective']);
  const { id } = useParams();
  const [params] = useSearchParams();
  const tab: Tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'overview';
  const complianceOn = useModuleOn('compliance');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: supplierKeys.detail(id), queryFn: () => get<SupplierDetail>(`/suppliers/${id}`) });
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const s = q.data;
  if (!s) return <DetailState query={q} back="suppliers" />;
  const saved = (x?: SupplierDetail) => {
    if (x) qc.setQueryData(supplierKeys.detail(id), x);
    void qc.invalidateQueries({ queryKey: supplierKeys.all });
  };
  const act = async (fn: () => Promise<SupplierDetail | unknown>, ok: string) => {
    try {
      const r = await fn();
      notifyOk(ok);
      if (r && typeof r === 'object' && 'id' in r) saved(r as SupplierDetail);
      else saved();
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
  const base = `/suppliers/${s.id}`;
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
        tabs={
          <LinkTabs
            label={t('detailTabs.label')}
            active={tab === 'overview' ? base : `${base}?tab=${tab}`}
            tabs={TABS.map((x) => ({
              to: x === 'overview' ? base : `${base}?tab=${x}`,
              label: t(`detailTabs.${x}`),
              count: x === 'contracts' ? s.contracts.length : x === 'contacts' ? s.contacts.length : undefined,
              testId: `supplier-tab-${x}`,
            }))}
          />
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
      {tab === 'overview' && <Overview s={s} complianceOn={complianceOn} />}
      {tab === 'contracts' && <ContractsTab s={s} onSaved={saved} />}
      {tab === 'services' && <ServicesTab s={s} />}
      {tab === 'contacts' && <SupplierContacts s={s} contacts={s.contacts} onSaved={() => saved()} />}
      {tab === 'certificates' && <CertificatesTab s={s} onSaved={saved} />}
      {tab === 'usedBy' && <UsedByTab s={s} />}
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
    </>
  );
}

/** Overview: the company record – data, owners, owning teams, the DPA default for contracts, criticality, reviews and findings. */
function Overview({ s, complianceOn }: { s: SupplierDetail; complianceOn: boolean }) {
  const { t } = useTranslation(['suppliers', 'common', 'applications']);
  const crit = CIA_DIMENSIONS.filter((d) => s.criticality[d]);
  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, md: 8 }}>
        <Stack gap="lg">
          {s.description && <Text size="sm">{s.description}</Text>}
          {s.dpaMissing && (
            <Alert color="red" variant="light" data-testid="supplier-dpa-missing">
              {s.contractCount ? t('detail.dpaMissingContracts', { count: s.dpaMissingContracts }) : t('dpa.missing')}
            </Alert>
          )}
          {complianceOn && <SupplierFindings supplier={{ id: s.id, name: s.name, status: s.status }} />}
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
            <Field label={t('detail.dataProtectionDefault')}>
              <Text size="sm">
                {!s.personalData ? t('dpa.none') : t(`dpa.${s.dpaStatus ?? 'missing'}`)}
                {s.personalData && s.dpaStatus === 'inPlace' && s.dpaSince ? ` · ${fmtDay(s.dpaSince)}` : ''}
              </Text>
              {s.dpaLink && <DocLink link={s.dpaLink} />}
              <Text size="xs" c="dimmed">
                {t('detail.dataProtectionDefaultHint')}
              </Text>
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
  );
}

/** One contract as the Contracts tab lists it (a card; an order form indented under its master). */
function ContractCard({ s, c, onEdit, onRemove }: { s: SupplierDetail; c: SupplierContract; onEdit: () => void; onRemove: () => void }) {
  const { t } = useTranslation(['suppliers', 'common']);
  return (
    <Paper withBorder p="sm" ml={c.parentId ? 'xl' : 0} data-testid={`contract-${c.id}`}>
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <div style={{ minWidth: 0 }}>
          <Group gap={6} wrap="wrap">
            <Anchor component={Link} to={`/suppliers/${s.id}/contracts/${c.id}`} fw={600} size="sm">
              {c.title}
            </Anchor>
            {c.reference && (
              <Text size="xs" c="dimmed">
                {c.reference}
              </Text>
            )}
            {c.parentId && (
              <Badge size="xs" variant="default">
                {t('contract.orderForm')}
              </Badge>
            )}
            {c.orderForms.length > 0 && (
              <Badge size="xs" variant="default">
                {t('contract.master')}
              </Badge>
            )}
            {c.parentHidden && (
              <Text size="xs" c="dimmed">
                {t('contract.hiddenMaster')}
              </Text>
            )}
          </Group>
          <Group gap={4} mt={4} wrap="wrap">
            {c.services.map((x) => (
              <Badge
                key={x.id}
                size="sm"
                variant="light"
                color={x.status === 'proposed' ? 'yellow' : 'blue'}
                style={{ textTransform: 'none' }}
                title={x.purpose || undefined}
              >
                {x.name}
                {x.purpose ? ` – ${x.purpose}` : ''}
                {x.status === 'proposed' ? ` (${t('contractServices.toConfirm')})` : ''}
              </Badge>
            ))}
            {c.hiddenServices > 0 && (
              <Text size="xs" c="dimmed">
                {t('contractServices.hidden', { count: c.hiddenServices })}
              </Text>
            )}
          </Group>
          <Group gap="md" mt={4} wrap="wrap">
            <Text size="xs">
              {t('contracts.noticeBy')}: <DueDate date={c.noticeBy} state={c.noticeState} />
            </Text>
            {c.termEnd && <Text size="xs">{t('serviceSuppliers.termEnd', { date: fmtDay(c.termEnd) })}</Text>}
            <DpaState c={c} />
          </Group>
          {c.owners.length > 0 && (
            <Text size="xs" c="dimmed">
              {t('serviceSuppliers.owners', { owners: c.owners.map(subjectLabel).join(', ') })}
            </Text>
          )}
        </div>
        {c.canEdit && (
          <Group gap={4} wrap="nowrap">
            <ActionIcon variant="subtle" aria-label={t('contracts.edit')} onClick={onEdit}>
              <IconEdit size={14} />
            </ActionIcon>
            <ActionIcon variant="subtle" color="red" aria-label={t('contract.remove')} onClick={onRemove}>
              <IconTrash size={14} />
            </ActionIcon>
          </Group>
        )}
      </Group>
    </Paper>
  );
}

/** Contracts: masters with their order forms indented; filters "Mine" and "Covering services I edit"; the payments (Costs module). */
function ContractsTab({ s, onSaved }: { s: SupplierDetail; onSaved: (x?: SupplierDetail) => void }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const costsOn = useModuleOn('costs');
  const [filter, setFilter] = useState<string[]>([]);
  const [editing, setEditing] = useState<SupplierContract | 'new' | null>(null);
  const [removing, setRemoving] = useState<SupplierContract | null>(null);
  const shown = s.contracts.filter((c) => (!filter.includes('mine') || c.mine) && (!filter.includes('services') || c.services.some((x) => x.editsService)));
  return (
    <Stack gap="sm" data-testid="supplier-contracts">
      <Group justify="space-between" wrap="wrap">
        <Chip.Group multiple value={filter} onChange={setFilter}>
          <Group gap={6}>
            <Chip size="xs" value="mine" data-testid="contracts-filter-mine">
              {t('contractsTab.mine')}
            </Chip>
            <Chip size="xs" value="services">
              {t('contractsTab.myServices')}
            </Chip>
          </Group>
        </Chip.Group>
        {s.canAddContract && (
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setEditing('new')} data-testid="contract-add">
            {t('contracts.add')}
          </Button>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('contractsTab.help')}
      </Text>
      {shown.length === 0 ? (
        <Text size="sm" c="dimmed">
          {s.contracts.length ? t('contractsTab.noMatch') : t('contracts.empty')}
        </Text>
      ) : (
        shown.map((c) => <ContractCard key={c.id} s={s} c={c} onEdit={() => setEditing(c)} onRemove={() => setRemoving(c)} />)
      )}
      {costsOn && <SupplierCosts supplierId={s.id} />}
      {editing && (
        <ContractModal supplier={s} contract={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={(x) => onSaved(x)} />
      )}
      {removing && (
        <RemoveContractModal
          supplier={s}
          contract={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            onSaved();
          }}
        />
      )}
    </Stack>
  );
}

/** Services: covered by a contract the reader sees (with purposes), or using the supplier without one. */
function ServicesTab({ s }: { s: SupplierDetail }) {
  const { t } = useTranslation('suppliers');
  return (
    <Stack gap="xs" data-testid="supplier-services">
      <Text size="xs" c="dimmed">
        {t('servicesTab.help')}
      </Text>
      {s.serviceUse.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('servicesTab.empty')}
        </Text>
      )}
      {s.serviceUse.map((x) => (
        <Paper withBorder p="sm" key={x.id}>
          <Group gap="xs" wrap="wrap">
            <Anchor component={Link} to={`/services/${x.id}`} fw={600} size="sm">
              {x.name}
            </Anchor>
            {x.contracts.length === 0 && (
              <Badge size="xs" variant="light" color="gray">
                {t('serviceSuppliers.noContract')}
              </Badge>
            )}
          </Group>
          {x.contracts.map((c) => (
            <Text size="xs" key={c.id}>
              <Anchor component={Link} to={`/suppliers/${s.id}/contracts/${c.id}`} size="xs">
                {c.title}
              </Anchor>
              {c.purpose ? ` – ${c.purpose}` : ''}
              {c.status === 'proposed' ? ` (${t('contractServices.toConfirm')})` : ''}
            </Text>
          ))}
          {x.via.length > 0 && (
            <Text size="xs" c="dimmed">
              {t('servicesTab.via', { items: x.via.map((v) => v.name).join(', ') })}
            </Text>
          )}
        </Paper>
      ))}
    </Stack>
  );
}

/** Used by: what links the supplier (items the reader may see); an item naming a contract they may not see says so. */
function UsedByTab({ s }: { s: SupplierDetail }) {
  const { t } = useTranslation(['suppliers', 'corrective']);
  return (
    <Stack gap="xs" data-testid="supplier-used-by">
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
              {u.contract && (
                <Text size="xs" c="dimmed" truncate>
                  {u.contract.title}
                </Text>
              )}
              {u.contractHidden && (
                <Text size="xs" c="dimmed" fs="italic">
                  {t('contract.hidden')}
                </Text>
              )}
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

/** Certificates and reports (unchanged since 0.17). */
function CertificatesTab({ s, onSaved }: { s: SupplierDetail; onSaved: (x?: SupplierDetail) => void }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [certificate, setCertificate] = useState<SupplierCertificate | 'new' | null>(null);
  const certName = (c: SupplierCertificate) => (c.kind === 'other' && c.name ? c.name : t(`certificates.kinds.${c.kind}`));
  const remove = async (c: SupplierCertificate) => {
    if (!(await confirmDanger({ action: 'remove', message: t('certificates.removeConfirm', { name: certName(c) }) }))) return;
    try {
      onSaved(await del<SupplierDetail>(`/suppliers/${s.id}/certificates/${c.id}`));
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" data-testid="supplier-certificates">
      <Group justify="space-between">
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          {t('certificates.help')}
        </Text>
        {s.canEdit && (
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setCertificate('new')}>
            {t('certificates.add')}
          </Button>
        )}
      </Group>
      {s.certificates.length === 0 ? (
        <Text size="sm" c="dimmed">
          {t('certificates.empty')}
        </Text>
      ) : (
        <TableScroll>
          <Table fz="sm" aria-label={t('certificates.title')}>
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
                        <ActionIcon variant="subtle" color="red" aria-label={t('common:remove')} onClick={() => void remove(c)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Group>
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      )}
      {certificate && (
        <CertificateModal
          supplierId={s.id}
          certificate={certificate === 'new' ? undefined : certificate}
          onClose={() => setCertificate(null)}
          onSaved={(x) => onSaved(x)}
        />
      )}
    </Stack>
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

function FormButtons({ busy }: { busy: boolean }) {
  const { t } = useTranslation('common');
  return (
    <Group justify="flex-end">
      <FormModalCancel />
      <Button type="submit" loading={busy}>
        {t('save')}
      </Button>
    </Group>
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
    <FormModal onClose={onClose} size="lg" title={certificate ? t('certificates.edit') : t('certificates.add')}>
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
          <FormButtons busy={busy} />
        </Stack>
      </form>
    </FormModal>
  );
}

import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Grid, Group, Paper, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { IconEdit, IconTrash } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { SupplierContract, SupplierContractDetail, SupplierDetail } from '@sm/shared';
import { get } from '../api';
import { DetailState, subjectLabel } from '../components/common';
import { CopyId } from '../components/CopyId';
import { Field } from '../components/records/common';
import { DetailHeader } from '../components/page/DetailPage';
import { fmtDay, fmtNumber } from '../format';
import { supplierKeys } from '../queryKeys';
import { useModuleOn } from '../modules';
import { DueDate } from './Suppliers';
import { DocLink, DpaState, RemoveContractModal } from '../components/suppliers/contractParts';
import { ContractModal } from '../components/suppliers/ContractForm';
import { ContractPlatforms, ContractServices } from '../components/suppliers/ContractServices';
import { SupplierContacts } from '../components/suppliers/ScopedContacts';
import { ContractPayments } from '../components/costs/ContractPayments';

/** A value of the contract, in grey with "from the master agreement" when the order form inherits it (ADR 0031). */
function Inherited({ c, field, children }: { c: SupplierContract; field: SupplierContract['inherited'][number]; children: React.ReactNode }) {
  const { t } = useTranslation('suppliers');
  if (!c.inherited.includes(field)) return <>{children}</>;
  return (
    <Text size="sm" c="dimmed" component="span">
      {children}{' '}
      <Text span size="xs">
        ({t('contract.fromMaster')})
      </Text>
    </Text>
  );
}

/**
 * A supplier contract's page (`/suppliers/:id/contracts/:contractId`, ADR 0031): general data, the services it covers
 * with their purposes, owners and who sees it and why, term and notice, the SLA (inherited values in grey), data
 * protection, payments (Costs module), its contacts and the reviews and findings that name it. 404 for who may not see it.
 */
export function SupplierContractPage() {
  const { t } = useTranslation(['suppliers', 'common']);
  const { id, contractId } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const costsOn = useModuleOn('costs');
  const key = [...supplierKeys.detail(id), 'contract', contractId] as const;
  const q = useQuery({ queryKey: key, queryFn: () => get<SupplierContractDetail>(`/suppliers/${id}/contracts/${contractId}`) });
  const sup = useQuery({ queryKey: supplierKeys.detail(id), queryFn: () => get<SupplierDetail>(`/suppliers/${id}`) });
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const d = q.data;
  if (!d || !sup.data) return <DetailState query={d ? sup : q} back="suppliers" />;
  const c = d.contract;
  const refresh = (gone?: boolean) => {
    void qc.invalidateQueries({ queryKey: supplierKeys.all });
    if (gone) navigate(`/suppliers/${d.supplier.id}`);
  };
  const terms = [
    c.startsOn || c.endsOn ? `${c.startsOn ? fmtDay(c.startsOn) : '…'} – ${c.endsOn ? fmtDay(c.endsOn) : '…'}` : '',
    c.renewal === 'automatic' ? t('contracts.renewsBy', { count: c.renewalMonths ?? 0 }) : t(`contracts.renewals.${c.renewal}`),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      <DetailHeader
        recent={{ label: c.title, kind: 'supplier' }}
        back={['suppliers', { to: `/suppliers/${d.supplier.id}?tab=contracts`, label: d.supplier.name }]}
        title={
          <Group gap="sm" wrap="wrap">
            <span>{c.title}</span>
            {c.reference && <Badge variant="default">{c.reference}</Badge>}
            {c.teamOwned && (
              <Badge variant="light" color="grape">
                {t('contract.teamOwned')}
              </Badge>
            )}
          </Group>
        }
        description={
          <>
            <Anchor component={Link} to={`/suppliers/${d.supplier.id}`} size="sm">
              {d.supplier.name}
            </Anchor>
            <CopyId id={c.id} />
          </>
        }
        actions={
          c.canEdit && (
            <Button size="xs" leftSection={<IconEdit size={14} />} onClick={() => setEditing(true)} data-testid="contract-edit">
              {t('common:edit')}
            </Button>
          )
        }
        menu={
          c.canEdit
            ? { items: [{ label: t('contract.remove'), icon: IconTrash, color: 'red', onClick: () => setRemoving(true), testId: 'contract-remove' }] }
            : undefined
        }
      />
      {c.parentHidden && (
        <Alert color="gray" variant="light" mb="md">
          {t('contract.hiddenMaster')}
        </Alert>
      )}
      {c.endsAfterMaster && (
        <Alert color="yellow" variant="light" mb="md">
          {t('contract.endsAfterMaster')}
        </Alert>
      )}
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Stack gap="lg">
            <Stack gap="xs" data-testid="contract-services-section">
              <Text fw={600}>{t('contract.services')}</Text>
              <ContractServices supplierId={d.supplier.id} contract={c} onChanged={refresh} />
            </Stack>
            {(c.platforms.length > 0 || c.hiddenPlatforms > 0 || c.canEdit) && (
              <Stack gap="xs" data-testid="contract-platforms-section">
                <Text fw={600}>{t('contract.platforms')}</Text>
                <ContractPlatforms supplierId={d.supplier.id} contract={c} onChanged={refresh} />
              </Stack>
            )}
            <Stack gap="xs">
              <Text fw={600}>{t('contract.term')}</Text>
              <Group gap="lg" wrap="wrap" align="flex-start">
                <Field label={t('contract.term')}>{terms || '–'}</Field>
                <Field label={t('contracts.noticeBy')}>
                  <DueDate date={c.noticeBy} state={c.noticeState} />
                </Field>
                {c.termEnd && <Field label={t('contracts.termEnd')}>{fmtDay(c.termEnd)}</Field>}
                {c.noticeDays !== null && <Field label={t('contracts.noticeDays')}>{fmtNumber(c.noticeDays)}</Field>}
                {c.link && (
                  <Field label={t('contracts.link')}>
                    <DocLink link={c.link} record={c.record} />
                  </Field>
                )}
              </Group>
            </Stack>
            <Stack gap="xs" data-testid="contract-sla">
              <Text fw={600}>{t('contracts.sla')}</Text>
              <Group gap="lg" wrap="wrap" align="flex-start">
                <Field label={t('contracts.slaAvailability')}>
                  <Inherited c={c} field="slaAvailability">
                    {c.slaAvailability === null ? '–' : `${fmtNumber(c.slaAvailability)} %`}
                  </Inherited>
                </Field>
                <Field label={t('contracts.slaSupportHours')}>
                  <Inherited c={c} field="slaSupportHours">
                    {c.slaSupportHours || '–'}
                  </Inherited>
                </Field>
                <Field label={t('contracts.rtoHours')}>
                  <Inherited c={c} field="rtoHours">
                    {c.rtoHours === null ? '–' : fmtNumber(c.rtoHours)}
                  </Inherited>
                </Field>
                <Field label={t('contracts.rpoHours')}>
                  <Inherited c={c} field="rpoHours">
                    {c.rpoHours === null ? '–' : fmtNumber(c.rpoHours)}
                  </Inherited>
                </Field>
              </Group>
              {c.slaResponse && (
                <Text size="sm">
                  {t('contracts.slaResponse')}:{' '}
                  <Inherited c={c} field="slaResponse">
                    {c.slaResponse}
                  </Inherited>
                </Text>
              )}
            </Stack>
            {c.costPlanLines.length > 0 && (
              <Text size="sm" data-testid="contract-plan-lines">
                {t('contracts.costPlanLines')}:{' '}
                {c.costPlanLines.map((l, i) => (
                  <span key={l.id}>
                    {i > 0 && ', '}
                    <Anchor component={Link} to={`/services/${l.serviceId}?tab=costs`} size="sm">
                      {l.serviceName} · {l.title} ({l.fiscalYear})
                    </Anchor>
                  </span>
                ))}
              </Text>
            )}
            {costsOn && (
              <Stack gap="xs">
                <Text fw={600}>{t('contract.payments')}</Text>
                <ContractPayments contractId={c.id} contractTitle={c.title} />
              </Stack>
            )}
            <Stack gap="xs">
              <Text fw={600}>{t('contacts.title')}</Text>
              <SupplierContacts s={sup.data} contacts={d.contacts} contractId={c.id} onSaved={() => refresh()} />
            </Stack>
            <Stack gap="xs" data-testid="contract-reviews">
              <Text fw={600}>{t('contract.reviews')}</Text>
              {d.reviews.length === 0 ? (
                <Text size="sm" c="dimmed">
                  {t('contract.noReviews')}
                </Text>
              ) : (
                d.reviews.map((r) => (
                  <Group key={`${r.kind}:${r.id}`} gap="xs" wrap="nowrap">
                    <Badge size="xs" variant="default">
                      {t(`usedBy.kinds.${r.kind}`)}
                    </Badge>
                    <Anchor component={Link} to={r.path} size="sm">
                      {r.name}
                    </Anchor>
                  </Group>
                ))
              )}
            </Stack>
            {c.note && (
              <Text size="sm" c="dimmed">
                {c.note}
              </Text>
            )}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Stack gap="md">
            <Paper withBorder p="md" data-testid="contract-visibility">
              <Stack gap="sm">
                <Text fw={600} size="sm">
                  {t('contract.visibility')}
                </Text>
                <Field label={t('contractForm.owners')}>{c.owners.length ? c.owners.map(subjectLabel).join(', ') : '–'}</Field>
                <Text size="sm">
                  {d.visibility.open ? t('contract.visibleOpen') : t('contract.visibleTeam', { teams: d.visibility.teams.join(', ') || '–' })}
                </Text>
                {!d.visibility.open && d.visibility.services.length > 0 && (
                  <Text size="xs" c="dimmed">
                    {t('contract.visibleServices', { services: d.visibility.services.map((x) => x.name).join(', ') })}
                  </Text>
                )}
                {!d.visibility.open && d.visibility.platforms.length > 0 && (
                  <Text size="xs" c="dimmed" data-testid="contract-visible-platforms">
                    {t('contract.visiblePlatforms', { platforms: d.visibility.platforms.map((x) => x.name).join(', ') })}
                  </Text>
                )}
                <Text size="xs" c="dimmed">
                  {t(`contract.why.${c.readReason}`)}
                </Text>
              </Stack>
            </Paper>
            <Paper withBorder p="md">
              <Stack gap="sm">
                <Text fw={600} size="sm">
                  {t('contract.dataProtection')}
                </Text>
                <DpaState c={c} />
                <Text size="xs" c="dimmed">
                  {c.personalData === null ? t(`contract.personalDataFrom.${c.dpa.personalDataFrom}`) : t('contract.personalDataOwn')}
                </Text>
                {c.dpa.link && <DocLink link={c.dpa.link} />}
              </Stack>
            </Paper>
            {(c.parent || c.orderForms.length > 0) && (
              <Paper withBorder p="md">
                <Stack gap="xs">
                  {c.parent && (
                    <Field label={t('contractForm.master')}>
                      <Anchor component={Link} to={`/suppliers/${d.supplier.id}/contracts/${c.parent.id}`} size="sm">
                        {c.parent.title}
                      </Anchor>
                    </Field>
                  )}
                  {c.orderForms.length > 0 && (
                    <Field label={t('contract.orderForms')}>
                      {c.orderForms.map((oid) => {
                        const o = sup.data!.contracts.find((x) => x.id === oid);
                        return o ? (
                          <Anchor key={oid} component={Link} to={`/suppliers/${d.supplier.id}/contracts/${oid}`} size="sm" display="block">
                            {o.title}
                          </Anchor>
                        ) : null;
                      })}
                    </Field>
                  )}
                </Stack>
              </Paper>
            )}
          </Stack>
        </Grid.Col>
      </Grid>
      {editing && <ContractModal supplier={sup.data} contract={c} onClose={() => setEditing(false)} onSaved={() => refresh()} />}
      {removing && (
        <RemoveContractModal
          supplier={sup.data}
          contract={c}
          onClose={() => setRemoving(false)}
          onRemoved={() => {
            void qc.invalidateQueries({ queryKey: supplierKeys.all });
            navigate(`/suppliers/${d.supplier.id}?tab=contracts`);
          }}
        />
      )}
    </>
  );
}

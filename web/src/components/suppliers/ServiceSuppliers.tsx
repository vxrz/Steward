import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCheck, IconDoorExit, IconPlus, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SUPPLIER_LIMITS, type ServiceContracts, type SupplierDetail } from '@sm/shared';
import { del, get, notifyError, notifyOk, put } from '../../api';
import { fmtDay, fmtNumber } from '../../format';
import { supplierKeys } from '../../queryKeys';
import { confirmDanger } from '../confirm';
import { CollapsibleSection } from '../page/CollapsibleSection';
import { DueDate } from '../../pages/Suppliers';
import { DpaState } from './contractParts';
import { ContractModal } from './ContractForm';
import { useSupplierOptions } from './SupplierPicker';
import { FormModal, FormModalCancel } from '../FormModal';

/**
 * The service page's _Suppliers_ section (ADR 0031): the contracts covering the service – supplier, contract, purpose,
 * owners, term end, notice-by date, SLA with RTO/RPO, DPA state; proposed ones with _Confirm_ and _Not this service_;
 * _Leave contract_; _Add contract_ and _Add to a contract_ for who may edit the service; and the suppliers its
 * applications and systems link without a contract covering the service.
 */
export function ServiceSuppliers({ serviceId }: { serviceId: string }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const qc = useQueryClient();
  const key = ['suppliers', 'service', serviceId] as const;
  const q = useQuery({ queryKey: key, queryFn: () => get<ServiceContracts>(`/services/${serviceId}/contracts`) });
  const [adding, setAdding] = useState<'new' | 'existing' | null>(null);
  const d = q.data;
  if (!d) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: supplierKeys.all });
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifyOk(ok);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const base = (supplierId: string, contractId: string) => `/suppliers/${supplierId}/contracts/${contractId}/services/${serviceId}`;
  const leave = async (x: ServiceContracts['contracts'][number]) => {
    const proposed = x.status === 'proposed';
    if (
      !(await confirmDanger({
        action: 'remove',
        title: proposed ? t('contractServices.dismiss') : t('contractServices.leave'),
        confirmLabel: proposed ? t('contractServices.dismiss') : t('contractServices.leave'),
        message: proposed
          ? t('serviceSuppliers.dismissConfirm', { contract: x.contract.title })
          : t('serviceSuppliers.leaveConfirm', { contract: x.contract.title }),
      }))
    )
      return;
    await run(() => del(base(x.supplier.id, x.contract.id)), proposed ? t('contractServices.dismissed') : t('contractServices.left'));
  };
  const count = d.contracts.length + d.uncovered.length;
  return (
    <CollapsibleSection
      title={t('serviceSuppliers.title')}
      count={count}
      id="service-suppliers"
      defaultOpen={count > 0}
      actions={
        d.canEdit && (
          <Group gap={4}>
            <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setAdding('new')} data-testid="service-add-contract">
              {t('serviceSuppliers.addContract')}
            </Button>
            <Button size="compact-xs" variant="default" onClick={() => setAdding('existing')} data-testid="service-add-to-contract">
              {t('serviceSuppliers.addToContract')}
            </Button>
          </Group>
        )
      }
    >
      <Stack gap="xs" data-testid="service-suppliers">
        {count === 0 && (
          <Text size="sm" c="dimmed">
            {t('serviceSuppliers.empty')}
          </Text>
        )}
        {d.contracts.map((x) => {
          const c = x.contract;
          return (
            <Paper withBorder p="sm" key={c.id} data-testid={`service-contract-${c.id}`}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="wrap">
                    <Anchor component={Link} to={`/suppliers/${x.supplier.id}`} size="sm">
                      {x.supplier.name}
                    </Anchor>
                    <Text size="sm">·</Text>
                    <Anchor component={Link} to={`/suppliers/${x.supplier.id}/contracts/${c.id}`} size="sm" fw={600}>
                      {c.title}
                    </Anchor>
                    {x.status === 'proposed' && (
                      <Badge size="xs" color="yellow" variant="light">
                        {t('contractServices.toConfirm')}
                      </Badge>
                    )}
                  </Group>
                  <Text size="xs" c="dimmed">
                    {x.purpose || t('contractServices.noPurpose')}
                  </Text>
                  <Group gap="md" mt={4} wrap="wrap">
                    <Text size="xs">
                      {t('contracts.noticeBy')}: <DueDate date={c.noticeBy} state={c.noticeState} />
                    </Text>
                    {c.termEnd && <Text size="xs">{t('serviceSuppliers.termEnd', { date: fmtDay(c.termEnd) })}</Text>}
                    {c.slaAvailability !== null && <Text size="xs">{`${t('contracts.sla')} ${fmtNumber(c.slaAvailability)} %`}</Text>}
                    {(c.rtoHours !== null || c.rpoHours !== null) && (
                      <Text size="xs">
                        {t('contracts.rtoRpo', {
                          rto: c.rtoHours === null ? '–' : fmtNumber(c.rtoHours),
                          rpo: c.rpoHours === null ? '–' : fmtNumber(c.rpoHours),
                        })}
                      </Text>
                    )}
                    <DpaState c={c} />
                  </Group>
                  {c.owners.length > 0 && (
                    <Text size="xs" c="dimmed">
                      {t('serviceSuppliers.owners', { owners: c.owners.join(', ') })}
                    </Text>
                  )}
                </div>
                {x.canChange && (
                  <Group gap={4} wrap="nowrap">
                    {x.status === 'proposed' && (
                      <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<IconCheck size={12} />}
                        onClick={() => void run(() => put(base(x.supplier.id, c.id), { confirm: true }), t('contractServices.confirmed'))}
                        data-testid={`service-confirm-${c.id}`}
                      >
                        {t('contractServices.confirm')}
                      </Button>
                    )}
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      leftSection={x.status === 'proposed' ? <IconX size={12} /> : <IconDoorExit size={12} />}
                      onClick={() => void leave(x)}
                      data-testid={`service-leave-${c.id}`}
                    >
                      {x.status === 'proposed' ? t('contractServices.dismiss') : t('contractServices.leave')}
                    </Button>
                  </Group>
                )}
              </Group>
            </Paper>
          );
        })}
        {d.uncovered.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              {t('serviceSuppliers.uncovered')}
            </Text>
            {d.uncovered.map((u) => (
              <Group key={u.id} gap="xs" wrap="wrap">
                <Anchor component={Link} to={`/suppliers/${u.id}`} size="sm">
                  {u.name}
                </Anchor>
                <Badge size="xs" variant="light" color="gray">
                  {t('serviceSuppliers.noContract')}
                </Badge>
                <Text size="xs" c="dimmed">
                  {u.via.map((v) => v.name).join(', ')}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
      {adding === 'new' && <NewContractForService serviceId={serviceId} onClose={() => setAdding(null)} onSaved={refresh} />}
      {adding === 'existing' && (
        <AddToContract
          serviceId={serviceId}
          taken={d.contracts.map((x) => x.contract.id)}
          onClose={() => setAdding(null)}
          onSaved={(supplierId, contractId, purpose) =>
            run(() => put(base(supplierId, contractId), { purpose }), t('contractServices.added')).then(() => setAdding(null))
          }
        />
      )}
    </CollapsibleSection>
  );
}

/** _Add contract_: choose a supplier, then the contract form – the new contract covers the service. */
function NewContractForService({ serviceId, onClose, onSaved }: { serviceId: string; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const options = useSupplierOptions();
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const supplier = useQuery({
    queryKey: supplierKeys.detail(supplierId),
    queryFn: () => get<SupplierDetail>(`/suppliers/${supplierId}`),
    enabled: !!supplierId,
  });
  if (supplier.data)
    return (
      <ContractModal
        supplier={supplier.data}
        serviceId={serviceId}
        onClose={onClose}
        onSaved={() => {
          notifyOk(t('serviceSuppliers.contractAdded'));
          onSaved();
        }}
      />
    );
  return (
    <FormModal onClose={onClose} title={t('serviceSuppliers.addContract')}>
      <Stack gap="sm">
        <Select
          label={t('serviceSuppliers.supplier')}
          description={t('serviceSuppliers.newSupplierHint')}
          data={(options.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
          value={supplierId}
          onChange={setSupplierId}
          searchable
          data-autofocus
          data-testid="service-contract-supplier"
        />
        <Group justify="space-between">
          <Anchor component={Link} to="/suppliers?new=1" size="sm">
            {t('new')}
          </Anchor>
          <FormModalCancel />
        </Group>
      </Stack>
    </FormModal>
  );
}

/** _Add to a contract_: the contracts the person may change (from the supplier picker's options). */
function AddToContract({
  serviceId,
  taken,
  onClose,
  onSaved,
}: {
  serviceId: string;
  taken: string[];
  onClose: () => void;
  onSaved: (supplierId: string, contractId: string, purpose: string) => Promise<void>;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const options = useSupplierOptions();
  const [value, setValue] = useState<string | null>(null);
  const [purpose, setPurpose] = useState('');
  const data = (options.data ?? []).flatMap((s) =>
    s.contracts
      .filter((c) => c.canEdit && !taken.includes(c.id) && !c.services.includes(serviceId))
      .map((c) => ({ value: `${s.id}|${c.id}`, label: `${s.name} · ${c.title}` })),
  );
  return (
    <FormModal onClose={onClose} title={t('serviceSuppliers.addToContract')}>
      <Stack gap="sm">
        <Select
          label={t('serviceSuppliers.contract')}
          data={data}
          value={value}
          onChange={setValue}
          searchable
          nothingFoundMessage={t('serviceSuppliers.noContracts')}
          data-autofocus
          data-testid="service-add-to-contract-select"
        />
        <TextInput
          label={t('contractServices.purpose')}
          maxLength={SUPPLIER_LIMITS.purpose}
          value={purpose}
          onChange={(e) => setPurpose(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <FormModalCancel />
          <Button
            disabled={!value}
            onClick={() => {
              const [s, c] = value!.split('|');
              void onSaved(s!, c!, purpose.trim());
            }}
          >
            {t('common:add')}
          </Button>
        </Group>
      </Stack>
    </FormModal>
  );
}

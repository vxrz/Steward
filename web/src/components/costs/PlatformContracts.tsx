import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { IconDoorExit, IconPlus } from '@tabler/icons-react';
import { SUPPLIER_LIMITS, type PlatformContracts as PlatformContractList, type SupplierDetail } from '@sm/shared';
import { del, get, notifyError, notifyOk, put } from '../../api';
import { fmtDay } from '../../format';
import { costKeys, supplierKeys } from '../../queryKeys';
import { confirmDanger } from '../confirm';
import { ContractModal } from '../suppliers/ContractForm';
import { FormModal, FormModalCancel } from '../FormModal';
import { useSupplierOptions } from '../suppliers/SupplierPicker';

/**
 * The contracts covering a platform (0.19.0, ADR 0032), on its cost plan: a platform team's own contracts – supplier,
 * contract, purpose, term end and notice-by date – with _Add contract_ and _Add to a contract_ for who manages the
 * platform or is a member of its owning teams, and _Take off the contract_ where they may.
 */
export function PlatformContracts({ platformId }: { platformId: string }) {
  const { t } = useTranslation(['suppliers', 'costs', 'common']);
  const qc = useQueryClient();
  const key = ['suppliers', 'platform', platformId] as const;
  const q = useQuery({ queryKey: key, queryFn: () => get<PlatformContractList>(`/platforms/${encodeURIComponent(platformId)}/contracts`) });
  const [adding, setAdding] = useState<'new' | 'existing' | null>(null);
  const d = q.data;
  if (!d) return null;
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: supplierKeys.all });
    void qc.invalidateQueries({ queryKey: costKeys.all });
  };
  const base = (supplierId: string, contractId: string) => `/suppliers/${supplierId}/contracts/${contractId}/platforms/${encodeURIComponent(platformId)}`;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      notifyOk(ok);
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };
  const leave = async (x: PlatformContractList['contracts'][number]) => {
    if (
      !(await confirmDanger({
        action: 'remove',
        title: t('contractPlatforms.leave'),
        confirmLabel: t('contractPlatforms.leave'),
        message: t('platformContracts.leaveConfirm', { contract: x.contract.title }),
      }))
    )
      return;
    await run(() => del(base(x.supplier.id, x.contract.id)), t('contractPlatforms.left'));
  };
  if (!d.contracts.length && !d.canEdit) return null;
  return (
    <Stack gap="sm" data-testid="platform-contracts">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Title order={3} size="h5">
          {t('platformContracts.title')}
        </Title>
        {d.canEdit && (
          <Group gap={4}>
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setAdding('new')} data-testid="platform-add-contract">
              {t('serviceSuppliers.addContract')}
            </Button>
            <Button size="xs" variant="default" onClick={() => setAdding('existing')} data-testid="platform-add-to-contract">
              {t('serviceSuppliers.addToContract')}
            </Button>
          </Group>
        )}
      </Group>
      <Text size="xs" c="dimmed" maw={720}>
        {t('platformContracts.help')}
      </Text>
      {d.contracts.length === 0 && (
        <Text size="sm" c="dimmed">
          {t('platformContracts.empty')}
        </Text>
      )}
      {d.contracts.map((x) => (
        <Paper withBorder p="sm" key={x.contract.id} data-testid={`platform-contract-${x.contract.id}`}>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <div style={{ minWidth: 0 }}>
              <Group gap={6} wrap="wrap">
                <Anchor component={Link} to={`/suppliers/${x.supplier.id}`} size="sm">
                  {x.supplier.name}
                </Anchor>
                <Text size="sm">·</Text>
                <Anchor component={Link} to={`/suppliers/${x.supplier.id}/contracts/${x.contract.id}`} size="sm" fw={600}>
                  {x.contract.title}
                </Anchor>
                {x.contract.teamOwned && (
                  <Badge size="xs" variant="light" color="gray">
                    {t('platformContracts.teamOwned')}
                  </Badge>
                )}
              </Group>
              <Text size="xs" c="dimmed">
                {x.purpose || t('contractServices.noPurpose')}
              </Text>
              <Group gap="md" mt={4} wrap="wrap">
                {x.contract.termEnd && <Text size="xs">{t('serviceSuppliers.termEnd', { date: fmtDay(x.contract.termEnd) })}</Text>}
                {x.contract.noticeBy && <Text size="xs">{t('platformContracts.noticeBy', { date: fmtDay(x.contract.noticeBy) })}</Text>}
              </Group>
            </div>
            {x.canChange && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<IconDoorExit size={12} />}
                onClick={() => void leave(x)}
                data-testid={`platform-leave-${x.contract.id}`}
              >
                {t('contractPlatforms.leave')}
              </Button>
            )}
          </Group>
        </Paper>
      ))}
      {adding === 'new' && <NewContractForPlatform platformId={platformId} onClose={() => setAdding(null)} onSaved={refresh} />}
      {adding === 'existing' && (
        <AddToContract
          taken={d.contracts.map((x) => x.contract.id)}
          onClose={() => setAdding(null)}
          onSaved={(supplierId, contractId, purpose) =>
            run(() => put(base(supplierId, contractId), { purpose }), t('contractPlatforms.added')).then(() => setAdding(null))
          }
        />
      )}
    </Stack>
  );
}

/** _Add contract_: choose a supplier, then the contract form – the new contract covers the platform. */
function NewContractForPlatform({ platformId, onClose, onSaved }: { platformId: string; onClose: () => void; onSaved: () => void }) {
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
        platformId={platformId}
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
          data-testid="platform-contract-supplier"
        />
        <Group justify="flex-end">
          <FormModalCancel />
        </Group>
      </Stack>
    </FormModal>
  );
}

/** _Add to a contract_: the contracts the person may change (from the supplier picker's options). */
function AddToContract({
  taken,
  onClose,
  onSaved,
}: {
  taken: string[];
  onClose: () => void;
  onSaved: (supplierId: string, contractId: string, purpose: string) => Promise<void>;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const options = useSupplierOptions();
  const [value, setValue] = useState<string | null>(null);
  const [purpose, setPurpose] = useState('');
  const data = (options.data ?? []).flatMap((s) =>
    s.contracts.filter((c) => c.canEdit && !taken.includes(c.id)).map((c) => ({ value: `${s.id}|${c.id}`, label: `${s.name} · ${c.title}` })),
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
          data-testid="platform-add-to-contract-select"
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

import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCheck, IconDoorExit, IconEdit, IconPlus, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { SUPPLIER_LIMITS, type ServiceSummary, type SupplierContract, type SupplierContractService } from '@sm/shared';
import { del, get, notifyError, notifyOk, put } from '../../api';
import { confirmDanger } from '../confirm';
import { FormModal, FormModalCancel } from '../FormModal';

/**
 * The services a contract covers, each with its purpose (ADR 0031): proposed ones with _Confirm_ and _Not this service_,
 * _Leave contract_ for who may change the contract or edit the service, and _Add a service_ for who may change the
 * contract. Covered services the reader may not see are counted for who may change it, never named.
 */
export function ContractServices({
  supplierId,
  contract,
  onChanged,
}: {
  supplierId: string;
  contract: SupplierContract;
  /** After a change: reload; `gone` when the reader no longer sees the contract (they left it) */
  onChanged: (gone?: boolean) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [purpose, setPurpose] = useState<SupplierContractService | null>(null);
  const [adding, setAdding] = useState(false);
  const base = `/suppliers/${supplierId}/contracts/${contract.id}/services`;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      notifyOk(ok);
      onChanged(!!r && typeof r === 'object' && 'ok' in r);
    } catch (e) {
      notifyError(e);
    }
  };
  const leave = async (s: SupplierContractService) => {
    const proposed = s.status === 'proposed';
    if (
      !(await confirmDanger({
        action: 'remove',
        title: proposed ? t('contractServices.dismiss') : t('contractServices.leave'),
        confirmLabel: proposed ? t('contractServices.dismiss') : t('contractServices.leave'),
        message: proposed
          ? t('contractServices.dismissConfirm', { service: s.name })
          : t('contractServices.leaveConfirm', { service: s.name, contract: contract.title }),
      }))
    )
      return;
    await run(() => del(`${base}/${s.id}`), proposed ? t('contractServices.dismissed') : t('contractServices.left'));
  };
  return (
    <Stack gap="xs" data-testid="contract-services-list">
      {contract.services.length === 0 && contract.hiddenServices === 0 && (
        <Text size="sm" c="dimmed">
          {t('contractServices.none')}
        </Text>
      )}
      {contract.services.map((s) => (
        <Group key={s.id} justify="space-between" wrap="nowrap" align="flex-start" data-testid={`contract-service-${s.id}`}>
          <div style={{ minWidth: 0 }}>
            <Group gap={6} wrap="wrap">
              <Anchor component={Link} to={`/services/${s.id}`} size="sm" fw={500}>
                {s.name}
              </Anchor>
              {s.archived && (
                <Badge size="xs" variant="default">
                  {t('contractServices.archived')}
                </Badge>
              )}
              {s.status === 'proposed' && (
                <Badge size="xs" color="yellow" variant="light">
                  {t('contractServices.toConfirm')}
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              {s.purpose || t('contractServices.noPurpose')}
              {s.status === 'proposed' &&
                s.proposedFrom.length > 0 &&
                ` · ${t('contractServices.proposedFrom', { from: s.proposedFrom.map((x) => t(`contractServices.sources.${x}`)).join(', ') })}`}
            </Text>
          </div>
          {s.canChange && (
            <Group gap={4} wrap="nowrap">
              {s.status === 'proposed' && (
                <Button
                  size="compact-xs"
                  variant="light"
                  leftSection={<IconCheck size={12} />}
                  onClick={() => void run(() => put(`${base}/${s.id}`, { confirm: true }), t('contractServices.confirmed'))}
                  data-testid={`confirm-service-${s.id}`}
                >
                  {t('contractServices.confirm')}
                </Button>
              )}
              <ActionIcon variant="subtle" aria-label={t('contractServices.editPurpose')} onClick={() => setPurpose(s)}>
                <IconEdit size={14} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={s.status === 'proposed' ? t('contractServices.dismiss') : t('contractServices.leave')}
                onClick={() => void leave(s)}
                data-testid={`leave-service-${s.id}`}
              >
                {s.status === 'proposed' ? <IconX size={14} /> : <IconDoorExit size={14} />}
              </ActionIcon>
            </Group>
          )}
        </Group>
      ))}
      {contract.hiddenServices > 0 && (
        <Text size="xs" c="dimmed" data-testid="contract-hidden-services">
          {t('contractServices.hidden', { count: contract.hiddenServices })}
        </Text>
      )}
      {contract.canEdit && (
        <Group>
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setAdding(true)} data-testid="contract-add-service">
            {t('contractServices.add')}
          </Button>
        </Group>
      )}
      {purpose && (
        <PurposeModal
          service={purpose}
          onClose={() => setPurpose(null)}
          onSave={(p) => run(() => put(`${base}/${purpose.id}`, { purpose: p }), t('contractServices.saved')).then(() => setPurpose(null))}
        />
      )}
      {adding && (
        <AddServiceModal
          taken={contract.services.map((s) => s.id)}
          onClose={() => setAdding(false)}
          onSave={(id, p) => run(() => put(`${base}/${id}`, { purpose: p }), t('contractServices.added')).then(() => setAdding(false))}
        />
      )}
    </Stack>
  );
}

function PurposeModal({ service, onClose, onSave }: { service: SupplierContractService; onClose: () => void; onSave: (p: string) => Promise<void> }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [value, setValue] = useState(service.purpose);
  return (
    <FormModal onClose={onClose} title={t('contractServices.purposeTitle', { service: service.name })}>
      <Stack gap="sm">
        <TextInput
          label={t('contractServices.purpose')}
          maxLength={SUPPLIER_LIMITS.purpose}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          data-autofocus
        />
        <Group justify="flex-end">
          <FormModalCancel />
          <Button onClick={() => void onSave(value.trim())}>{t('common:save')}</Button>
        </Group>
      </Stack>
    </FormModal>
  );
}

function AddServiceModal({ taken, onClose, onSave }: { taken: string[]; onClose: () => void; onSave: (id: string, purpose: string) => Promise<void> }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const services = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services') });
  const [id, setId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState('');
  return (
    <FormModal onClose={onClose} title={t('contractServices.add')}>
      <Stack gap="sm">
        <Select
          label={t('contractServices.service')}
          data={(services.data ?? []).filter((s) => !s.archived && !taken.includes(s.id)).map((s) => ({ value: s.id, label: s.name }))}
          value={id}
          onChange={setId}
          searchable
          data-autofocus
          data-testid="add-service-select"
        />
        <TextInput
          label={t('contractServices.purpose')}
          maxLength={SUPPLIER_LIMITS.purpose}
          value={purpose}
          onChange={(e) => setPurpose(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <FormModalCancel />
          <Button disabled={!id} onClick={() => id && void onSave(id, purpose.trim())} data-testid="add-service-save">
            {t('common:add')}
          </Button>
        </Group>
      </Stack>
    </FormModal>
  );
}

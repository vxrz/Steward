import { useState } from 'react';
import { ActionIcon, Anchor, Badge, Button, Group, MultiSelect, Select, Stack, Text, TextInput } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCheck, IconDoorExit, IconEdit, IconPlus, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  SUPPLIER_LIMITS,
  type Platform,
  type ServiceSummary,
  type SupplierContract,
  type SupplierContractItemKind,
  type SupplierContractPlatform,
  type SupplierContractService,
} from '@sm/shared';
import { del, get, notifyError, notifyOk, put } from '../../api';
import { confirmDanger } from '../confirm';
import { platformKeys } from '../../queryKeys';
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
            {s.items.length > 0 && (
              <Group gap={4} wrap="wrap" data-testid={`contract-service-items-${s.id}`}>
                <Text size="xs" c="dimmed">
                  {t('contractServices.itemsFor')}
                </Text>
                {s.items.map((x) => (
                  <Badge key={`${x.kind}:${x.id}`} size="xs" variant="outline" color="gray">
                    <Anchor component={Link} to={x.kind === 'application' ? `/applications/${x.id}` : `/systems/${x.id}`} size="xs" inherit>
                      {x.name}
                    </Anchor>
                  </Badge>
                ))}
              </Group>
            )}
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
          onSave={(p, items) => run(() => put(`${base}/${purpose.id}`, { purpose: p, items }), t('contractServices.saved')).then(() => setPurpose(null))}
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

type Item = { kind: SupplierContractItemKind; id: string };

/** The purpose of a covered service and (0.19.0, ADR 0032) the applications and systems of it the contract is for. */
function PurposeModal({
  service,
  onClose,
  onSave,
}: {
  service: SupplierContractService;
  onClose: () => void;
  onSave: (p: string, items: Item[]) => Promise<void>;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [value, setValue] = useState(service.purpose);
  const options = useQuery({
    queryKey: ['suppliers', 'service-items', service.id],
    queryFn: () => get<{ items: (Item & { name: string })[] }>(`/services/${encodeURIComponent(service.id)}/contract-items`),
  });
  const [items, setItems] = useState<string[]>(service.items.map((x) => `${x.kind}:${x.id}`));
  const data = [
    ...(options.data?.items ?? []).map((x) => ({ value: `${x.kind}:${x.id}`, label: `${x.name} (${t(`contractServices.itemKinds.${x.kind}`)})` })),
    ...service.items
      .filter((x) => !(options.data?.items ?? []).some((o) => o.kind === x.kind && o.id === x.id))
      .map((x) => ({ value: `${x.kind}:${x.id}`, label: x.name })),
  ];
  const parsed = items.map((v) => ({ kind: v.slice(0, v.indexOf(':')) as SupplierContractItemKind, id: v.slice(v.indexOf(':') + 1) }));
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
        <MultiSelect
          label={t('contractServices.items')}
          description={t('contractServices.itemsHint')}
          placeholder={items.length ? undefined : t('contractServices.itemsNone')}
          data={data}
          value={items}
          onChange={setItems}
          searchable
          clearable
          maxValues={SUPPLIER_LIMITS.contractItems}
          data-testid="contract-service-items"
        />
        <Group justify="flex-end">
          <FormModalCancel />
          <Button onClick={() => void onSave(value.trim(), parsed)} data-testid="contract-service-save">
            {t('common:save')}
          </Button>
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

/**
 * The platforms a contract covers (0.19.0, ADR 0032), each with its purpose: a platform team's own contract. Covering a
 * platform lets its managers and the members of its owning teams see a team-owned contract. _Add a platform_ for who
 * may change the contract; the purpose and _Take off the contract_ also for who manages the platform.
 */
export function ContractPlatforms({
  supplierId,
  contract,
  onChanged,
}: {
  supplierId: string;
  contract: SupplierContract;
  onChanged: (gone?: boolean) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [editing, setEditing] = useState<SupplierContractPlatform | null>(null);
  const [adding, setAdding] = useState(false);
  const base = `/suppliers/${supplierId}/contracts/${contract.id}/platforms`;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      notifyOk(ok);
      onChanged(!!r && typeof r === 'object' && 'ok' in r);
    } catch (e) {
      notifyError(e);
    }
  };
  const leave = async (p: SupplierContractPlatform) => {
    if (
      !(await confirmDanger({
        action: 'remove',
        title: t('contractPlatforms.leave'),
        confirmLabel: t('contractPlatforms.leave'),
        message: t('contractPlatforms.leaveConfirm', { platform: p.name, contract: contract.title }),
      }))
    )
      return;
    await run(() => del(`${base}/${p.id}`), t('contractPlatforms.left'));
  };
  if (!contract.platforms.length && !contract.hiddenPlatforms && !contract.canEdit) return null;
  return (
    <Stack gap="xs" data-testid="contract-platforms-list">
      {contract.platforms.length === 0 && contract.hiddenPlatforms === 0 && (
        <Text size="sm" c="dimmed">
          {t('contractPlatforms.none')}
        </Text>
      )}
      {contract.platforms.map((p) => (
        <Group key={p.id} justify="space-between" wrap="nowrap" align="flex-start" data-testid={`contract-platform-${p.id}`}>
          <div style={{ minWidth: 0 }}>
            <Anchor component={Link} to={`/platforms/${p.id}`} size="sm" fw={500}>
              {p.name}
            </Anchor>
            <Text size="xs" c="dimmed">
              {p.purpose || t('contractServices.noPurpose')}
            </Text>
          </div>
          {p.canChange && (
            <Group gap={4} wrap="nowrap">
              <ActionIcon variant="subtle" aria-label={t('contractServices.editPurpose')} onClick={() => setEditing(p)}>
                <IconEdit size={14} />
              </ActionIcon>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t('contractPlatforms.leave')}
                onClick={() => void leave(p)}
                data-testid={`leave-platform-${p.id}`}
              >
                <IconDoorExit size={14} />
              </ActionIcon>
            </Group>
          )}
        </Group>
      ))}
      {contract.hiddenPlatforms > 0 && (
        <Text size="xs" c="dimmed" data-testid="contract-hidden-platforms">
          {t('contractPlatforms.hidden', { count: contract.hiddenPlatforms })}
        </Text>
      )}
      {contract.canEdit && (
        <Group>
          <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setAdding(true)} data-testid="contract-add-platform">
            {t('contractPlatforms.add')}
          </Button>
        </Group>
      )}
      {(editing || adding) && (
        <PlatformModal
          current={editing}
          taken={contract.platforms.map((p) => p.id)}
          onClose={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSave={(id, purpose) =>
            run(() => put(`${base}/${id}`, { purpose }), editing ? t('contractServices.saved') : t('contractPlatforms.added')).then(() => {
              setEditing(null);
              setAdding(false);
            })
          }
        />
      )}
    </Stack>
  );
}

function PlatformModal({
  current,
  taken,
  onClose,
  onSave,
}: {
  current: SupplierContractPlatform | null;
  taken: string[];
  onClose: () => void;
  onSave: (id: string, purpose: string) => Promise<void>;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const platforms = useQuery({ queryKey: platformKeys.all, queryFn: () => get<Platform[]>('/platforms'), enabled: !current });
  const [id, setId] = useState<string | null>(current?.id ?? null);
  const [purpose, setPurpose] = useState(current?.purpose ?? '');
  return (
    <FormModal onClose={onClose} title={current ? t('contractServices.purposeTitle', { service: current.name }) : t('contractPlatforms.add')}>
      <Stack gap="sm">
        {!current && (
          <Select
            label={t('contractPlatforms.platform')}
            description={t('contractPlatforms.addHint')}
            data={(platforms.data ?? []).filter((p) => !taken.includes(p.id)).map((p) => ({ value: p.id, label: p.name }))}
            value={id}
            onChange={setId}
            searchable
            data-autofocus
            data-testid="add-platform-select"
          />
        )}
        <TextInput
          label={t('contractServices.purpose')}
          maxLength={SUPPLIER_LIMITS.purpose}
          value={purpose}
          onChange={(e) => setPurpose(e.currentTarget.value)}
          data-testid="add-platform-purpose"
        />
        <Group justify="flex-end">
          <FormModalCancel />
          <Button disabled={!id} onClick={() => id && void onSave(id, purpose.trim())} data-testid="add-platform-save">
            {current ? t('common:save') : t('common:add')}
          </Button>
        </Group>
      </Stack>
    </FormModal>
  );
}

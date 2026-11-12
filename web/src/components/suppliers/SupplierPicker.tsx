import { useState } from 'react';
import { Anchor, Button, Group, Modal, Select, Stack, TextInput } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SUPPLIER_LIMITS, SUPPLIER_TYPES, type SupplierDetail, type SupplierOption, type SupplierRef, type SupplierType } from '@sm/shared';
import { get, notifyError, post } from '../../api';
import { useMe } from '../../auth';
import { supplierKeys } from '../../queryKeys';

const NEW = '__new__';

/**
 * The supplier of a form (0.17.0, ADR 0029): who is linked now, and what the form sends. `body` is undefined while
 * the person did not change the choice – so a supplier the person may not see is never cleared by saving.
 */
export function useSupplierChoice(initial: SupplierRef | null | undefined) {
  const [value, setValue] = useState<string | null>(initial?.id ?? null);
  const [touched, setTouched] = useState(false);
  return {
    value,
    set: (v: string | null) => {
      setValue(v);
      setTouched(true);
    },
    body: touched ? value : undefined,
  };
}

/** The suppliers a person may link (not archived), with their contracts. */
export function useSupplierOptions() {
  return useQuery({ queryKey: supplierKeys.options, queryFn: () => get<SupplierOption[]>('/suppliers/options'), staleTime: 30_000 });
}

/**
 * Picks a supplier, or makes a new one (designers and administrators). Where no supplier is chosen, the form keeps
 * its free-text vendor (`children`: shown only then).
 */
export function SupplierPicker({
  value,
  onChange,
  initial,
  label,
  description,
  testId,
  children,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  /** The linked supplier when the form opened (kept in the list when archived) */
  initial?: SupplierRef | null;
  label?: string;
  description?: string;
  testId?: string;
  /** The free-text vendor, shown while no supplier is chosen */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation('suppliers');
  const { hasRole } = useMe();
  const canCreate = hasRole('admin') || hasRole('designer');
  const options = useSupplierOptions();
  const [creating, setCreating] = useState(false);
  const list = options.data ?? [];
  const data = [
    ...list.map((o) => ({ value: o.id, label: o.status === 'unconfirmed' ? t('picker.unconfirmed', { name: o.name }) : o.name })),
    ...(initial && !list.some((o) => o.id === initial.id) ? [{ value: initial.id, label: t('picker.archived', { name: initial.name }) }] : []),
    ...(canCreate ? [{ value: NEW, label: t('picker.new') }] : []),
  ];
  return (
    <Stack gap={4}>
      <Select
        label={label ?? t('picker.label')}
        description={description ?? t('picker.hint')}
        placeholder={t('picker.none')}
        data={data}
        value={value}
        onChange={(v) => (v === NEW ? setCreating(true) : onChange(v))}
        searchable
        clearable
        nothingFoundMessage={t('picker.nothingFound')}
        data-testid={testId}
        filter={({ options: opts, search }) => {
          const needle = search.trim().toLowerCase();
          if (!needle) return opts;
          return opts.filter((o) => {
            if (!('value' in o)) return true;
            if (o.value === NEW) return true;
            const s = list.find((x) => x.id === o.value);
            return [o.label, ...(s?.aliases ?? [])].some((x) => x.toLowerCase().includes(needle));
          });
        }}
      />
      {value && (
        <Anchor component={Link} to={`/suppliers/${value}`} size="xs">
          {t('picker.open')}
        </Anchor>
      )}
      {!value && children}
      {creating && (
        <NewSupplierModal
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            onChange(s.id);
            setCreating(false);
          }}
        />
      )}
    </Stack>
  );
}

/** A new supplier from a form: name and type; the rest on its page. */
export function NewSupplierModal({
  onClose,
  onCreated,
  initialName = '',
}: {
  onClose: () => void;
  onCreated: (s: SupplierDetail) => void;
  initialName?: string;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const qc = useQueryClient();
  const [name, setName] = useState(initialName);
  const [type, setType] = useState<SupplierType>('saas');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const s = await post<SupplierDetail>('/suppliers', { name: name.trim(), type });
      void qc.invalidateQueries({ queryKey: supplierKeys.all });
      onCreated(s);
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('new')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }}
      >
        <Stack gap="sm">
          <TextInput
            label={t('fields.name')}
            required
            maxLength={SUPPLIER_LIMITS.name}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
          />
          <Select
            label={t('fields.type')}
            data={SUPPLIER_TYPES.map((x) => ({ value: x, label: t(`types.${x}`) }))}
            value={type}
            allowDeselect={false}
            onChange={(v) => v && setType(v as SupplierType)}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!name.trim()}>
              {t('actions.create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}

/**
 * A linked supplier as a link, else the free-text vendor. Underlined: it stands next to dimmed text (the contract), from
 * which colour alone does not tell it apart in the dark scheme (WCAG 1.4.1).
 */
export function SupplierText({ supplier, vendor }: { supplier: SupplierRef | null | undefined; vendor?: string }) {
  if (supplier)
    return (
      <Anchor component={Link} to={`/suppliers/${supplier.id}`} size="sm" underline="always" onClick={(e) => e.stopPropagation()}>
        {supplier.name}
      </Anchor>
    );
  return <>{vendor || '–'}</>;
}

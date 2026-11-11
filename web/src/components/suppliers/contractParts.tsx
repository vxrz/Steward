import { useState } from 'react';
import { Anchor, Badge, Button, Group, Modal, Select, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconExternalLink } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { SupplierContract, SupplierDetail } from '@sm/shared';
import { ApiError, del, notifyError, notifyOk } from '../../api';
import { fmtDay } from '../../format';
import { confirmDanger } from '../confirm';

/** A document link: the record when the reader may open it, else the URL (or the text as it is). */
export function DocLink({ link, record }: { link: string; record?: { id: string; number: string; title: string } | null }) {
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

/** The DPA state of a contract: missing in red where it processes personal data without an agreement. */
export function DpaState({ c }: { c: SupplierContract }) {
  const { t } = useTranslation('suppliers');
  const from = c.dpa.inheritedFrom === 'contract' ? '' : ` · ${t(`contract.dpaFrom.${c.dpa.inheritedFrom}`)}`;
  if (!c.dpa.personalData)
    return (
      <Text size="sm" component="span">
        {t('contract.noPersonalData')}
      </Text>
    );
  return c.dpa.missing ? (
    <Badge size="sm" color="red" variant="light" data-testid="contract-dpa-missing">
      {t('contract.dpaMissing')}
    </Badge>
  ) : (
    <Text size="sm" component="span">
      {t('dpa.inPlace')}
      {c.dpa.since ? ` · ${fmtDay(c.dpa.since)}` : ''}
      {from}
    </Text>
  );
}

/**
 * Remove a contract (ADR 0031): optionally _Replaced by…_ another contract of the supplier the person may change –
 * what names this one moves to it; a master asks before its order forms become standalone.
 */
export function RemoveContractModal({
  supplier,
  contract,
  onClose,
  onRemoved,
}: {
  supplier: SupplierDetail;
  contract: SupplierContract;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [replacedBy, setReplacedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const targets = supplier.contracts.filter((x) => x.id !== contract.id && x.canEdit);
  const remove = async (standalone = false) => {
    setBusy(true);
    const qs = new URLSearchParams();
    if (replacedBy) qs.set('replacedBy', replacedBy);
    if (standalone) qs.set('orderForms', 'standalone');
    try {
      await del(`/suppliers/${supplier.id}/contracts/${contract.id}${qs.size ? `?${qs}` : ''}`);
      notifyOk(t('contract.removed'));
      onRemoved();
    } catch (e) {
      setBusy(false);
      if (e instanceof ApiError && e.code === 'SUPPLIER_CONTRACT_HAS_ORDER_FORMS') {
        if (await confirmDanger({ action: 'remove', message: t('contract.removeMaster', { count: contract.orderForms.length }) })) void remove(true);
        return;
      }
      notifyError(e);
    }
  };
  return (
    <Modal opened onClose={onClose} title={t('contract.remove')}>
      <Stack gap="sm">
        <Text size="sm">{t('contracts.removeConfirm', { name: contract.title })}</Text>
        <Select
          label={t('contract.replacedBy')}
          description={t('contract.replacedByHint')}
          data={targets.map((x) => ({ value: x.id, label: x.reference ? `${x.title} · ${x.reference}` : x.title }))}
          value={replacedBy}
          onChange={setReplacedBy}
          clearable
          data-testid="contract-replaced-by"
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button color="red" loading={busy} onClick={() => void remove()} data-testid="contract-remove-confirm">
            {t('contract.remove')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

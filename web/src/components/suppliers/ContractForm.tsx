import { useState } from 'react';
import { Alert, Button, Group, MultiSelect, NumberInput, SegmentedControl, Select, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  SUPPLIER_LIMITS,
  SUPPLIER_RENEWALS,
  hasTeamOwner,
  type ServiceSummary,
  type SupplierContract,
  type SupplierDetail,
  type SupplierDpaStatus,
  type SupplierRenewal,
} from '@sm/shared';
import { ApiError, get, notifyError, post, put } from '../../api';
import { useFieldErrors } from '../common';
import { SubjectsInput } from '../SubjectsInput';
import { confirmDialog } from '../confirm';
import { FormModal, FormModalCancel } from '../FormModal';

const DOC_LINK = /^(https?:\/\/\S+|rec_[A-Za-z0-9_-]{4,40}|[A-Z][A-Z0-9]{0,9}-\d{4}-\d{4,6})$/i;
const numOrNull = (v: string | number) => (v === '' || v === null || v === undefined ? null : Number(v));
/** An own value: empty while it is inherited from the master agreement (ADR 0031). */
const own = <T,>(c: SupplierContract | undefined, f: SupplierContract['inherited'][number], v: T, empty: T): T => (c && !c.inherited.includes(f) ? v : empty);

type Tri = 'supplier' | 'yes' | 'no';

/**
 * Adds or changes a contract (ADR 0029, scope since ADR 0031): term and notice, the document, the SLA and RTO/RPO (an
 * order form shows its master's values as placeholders while its own are empty), owners, the master agreement,
 * personal data and the DPA ("as the supplier" by default), and – on create – the services it covers. A change that
 * leaves no team among the owners asks first.
 */
export function ContractModal({
  supplier,
  contract,
  serviceId,
  onClose,
  onSaved,
}: {
  supplier: Pick<SupplierDetail, 'id' | 'contracts'>;
  contract?: SupplierContract;
  /** A new contract from a service page: it covers this service */
  serviceId?: string;
  onClose: () => void;
  onSaved: (s: SupplierDetail) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  const c = contract;
  const [title, setTitle] = useState(c?.title ?? '');
  const [reference, setReference] = useState(c?.reference ?? '');
  const [startsOn, setStartsOn] = useState(c?.startsOn ?? '');
  const [endsOn, setEndsOn] = useState(c?.endsOn ?? '');
  const [noticeDays, setNoticeDays] = useState<string | number>(c?.noticeDays ?? '');
  const [renewal, setRenewal] = useState<SupplierRenewal>(c?.renewal ?? 'fixedEnd');
  const [renewalMonths, setRenewalMonths] = useState<string | number>(c?.renewalMonths ?? 12);
  const [link, setLink] = useState(c?.link ?? '');
  const [slaAvailability, setSlaAvailability] = useState<string | number>(own(c, 'slaAvailability', c?.slaAvailability ?? '', ''));
  const [slaSupportHours, setSlaSupportHours] = useState(own(c, 'slaSupportHours', c?.slaSupportHours ?? '', ''));
  const [slaResponse, setSlaResponse] = useState(own(c, 'slaResponse', c?.slaResponse ?? '', ''));
  const [rtoHours, setRtoHours] = useState<string | number>(own(c, 'rtoHours', c?.rtoHours ?? '', ''));
  const [rpoHours, setRpoHours] = useState<string | number>(own(c, 'rpoHours', c?.rpoHours ?? '', ''));
  const [note, setNote] = useState(c?.note ?? '');
  const [owners, setOwners] = useState<string[]>(c?.owners ?? []);
  const [parentId, setParentId] = useState<string | null>(c?.parentId ?? null);
  const [personalData, setPersonalData] = useState<Tri>(c?.personalData === null || c?.personalData === undefined ? 'supplier' : c.personalData ? 'yes' : 'no');
  const [dpaStatus, setDpaStatus] = useState<'inherited' | SupplierDpaStatus>(c?.dpaStatus ?? 'inherited');
  const [dpaSince, setDpaSince] = useState(c?.dpaSince ?? '');
  const [dpaLink, setDpaLink] = useState(c?.dpaLink ?? '');
  const [services, setServices] = useState<string[]>(serviceId ? [serviceId] : []);
  const svc = useQuery({ queryKey: ['services', false], queryFn: () => get<ServiceSummary[]>('/services'), enabled: !c });
  // a master: a contract of the supplier that is no order form itself (one level), not this one, and this one has no order forms
  const masters = supplier.contracts.filter((x) => !x.parentId && !x.parentHidden && x.id !== c?.id);
  const canHaveMaster = !c || c.orderForms.length === 0;
  const master = masters.find((m) => m.id === parentId);
  const placeholder = (f: SupplierContract['inherited'][number]) => {
    const v = master?.[f];
    return v === null || v === undefined || v === '' ? undefined : t('contractForm.inheritedPlaceholder', { value: String(v) });
  };
  const v = useFieldErrors({
    title: !title.trim() && t('common:validation.required'),
    endsOn: !!startsOn && !!endsOn && endsOn < startsOn && t('common:validation.invalid'),
    link: !!link.trim() && !DOC_LINK.test(link.trim()) && t('common:validation.invalid'),
    dpaLink: dpaStatus === 'inPlace' && !!dpaLink.trim() && !DOC_LINK.test(dpaLink.trim()) && t('common:validation.invalid'),
  });
  const [busy, setBusy] = useState(false);
  const body = (confirmOpen?: boolean) => ({
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
    // a new contract without owners named: the person and their teams (the server's default)
    ...(c || owners.length ? { owners: owners.map((o) => (/^(user|team):/i.test(o) ? o.toLowerCase() : `user:${o.toLowerCase()}`)) } : {}),
    ...(canHaveMaster ? { parentId } : {}),
    personalData: personalData === 'supplier' ? null : personalData === 'yes',
    dpaStatus: dpaStatus === 'inherited' ? null : dpaStatus,
    dpaSince: dpaStatus === 'inPlace' && dpaSince ? dpaSince : null,
    dpaLink: dpaStatus === 'inPlace' ? dpaLink.trim() : null,
    ...(!c && services.length ? { services: services.map((id) => ({ serviceId: id, purpose: '' })) } : {}),
    ...(confirmOpen ? { confirmOpen } : {}),
  });
  const save = async (confirmOpen?: boolean) => {
    setBusy(true);
    try {
      const d = c
        ? await put<SupplierDetail>(`/suppliers/${supplier.id}/contracts/${c.id}`, body(confirmOpen))
        : await post<SupplierDetail>(`/suppliers/${supplier.id}/contracts`, body(confirmOpen));
      onSaved(d);
      onClose();
    } catch (e) {
      setBusy(false);
      // no team among the owners any more: everyone who sees the supplier would see the contract – asked first
      if (e instanceof ApiError && e.code === 'SUPPLIER_CONTRACT_OPENS') {
        if (
          await confirmDialog({
            action: 'confirm',
            danger: false,
            title: t('contractForm.opensTitle'),
            confirmLabel: t('contractForm.opensConfirm'),
            message: t('contractForm.opens'),
          })
        )
          void save(true);
        return;
      }
      notifyError(e);
    }
  };
  const willOpen = !!c && c.teamOwned && !hasTeamOwner(owners);
  return (
    <FormModal onClose={onClose} size="lg" title={c ? t('contracts.edit') : t('contracts.add')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
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
          {!c && (
            <MultiSelect
              label={t('contractForm.services')}
              description={t('contractForm.servicesHint')}
              data={(svc.data ?? []).filter((s) => !s.archived).map((s) => ({ value: s.id, label: s.name }))}
              value={services}
              onChange={setServices}
              searchable
              maxValues={SUPPLIER_LIMITS.contractServices}
              data-testid="contract-services"
            />
          )}
          {canHaveMaster && (
            <Select
              label={t('contractForm.master')}
              description={t('contractForm.masterHint')}
              data={masters.map((m) => ({ value: m.id, label: m.reference ? `${m.title} · ${m.reference}` : m.title }))}
              value={parentId}
              onChange={setParentId}
              clearable
              placeholder={c?.parentHidden ? t('contract.hiddenMaster') : t('contractForm.noMaster')}
              data-testid="contract-master"
            />
          )}
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
          <SubjectsInput
            label={t('contractForm.owners')}
            description={c ? t('contractForm.ownersHint') : t('contractForm.ownersNewHint')}
            value={owners}
            onChange={setOwners}
            max={SUPPLIER_LIMITS.contractOwners}
          />
          {willOpen && (
            <Alert color="orange" variant="light" data-testid="contract-opens">
              {t('contractForm.opens')}
            </Alert>
          )}
          <Text fw={600} size="sm">
            {t('contracts.sla')}
          </Text>
          {master && (
            <Text size="xs" c="dimmed">
              {t('contractForm.inheritHint')}
            </Text>
          )}
          <Group grow align="flex-start">
            <NumberInput
              label={t('contracts.slaAvailability')}
              min={0}
              max={100}
              decimalScale={3}
              value={slaAvailability}
              onChange={setSlaAvailability}
              placeholder={placeholder('slaAvailability')}
            />
            <TextInput
              label={t('contracts.slaSupportHours')}
              maxLength={SUPPLIER_LIMITS.text}
              value={slaSupportHours}
              onChange={(e) => setSlaSupportHours(e.currentTarget.value)}
              placeholder={placeholder('slaSupportHours')}
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
            placeholder={placeholder('slaResponse')}
          />
          <Group grow align="flex-start">
            <NumberInput
              label={t('contracts.rtoHours')}
              min={0}
              max={SUPPLIER_LIMITS.hours}
              decimalScale={2}
              value={rtoHours}
              onChange={setRtoHours}
              placeholder={placeholder('rtoHours')}
            />
            <NumberInput
              label={t('contracts.rpoHours')}
              min={0}
              max={SUPPLIER_LIMITS.hours}
              decimalScale={2}
              value={rpoHours}
              onChange={setRpoHours}
              placeholder={placeholder('rpoHours')}
            />
          </Group>
          <Text fw={600} size="sm">
            {t('contract.dataProtection')}
          </Text>
          <Stack gap={4}>
            <Text size="sm">{t('contractForm.personalData')}</Text>
            <SegmentedControl
              size="xs"
              data={(['supplier', 'yes', 'no'] as const).map((k) => ({ value: k, label: t(`contractForm.personalDataChoices.${k}`) }))}
              value={personalData}
              onChange={(x) => setPersonalData(x as Tri)}
              data-testid="contract-personal-data"
            />
          </Stack>
          <Group grow align="flex-start">
            <Select
              label={t('fields.dpaStatus')}
              data={[
                { value: 'inherited', label: t('contractForm.dpaInherited') },
                { value: 'inPlace', label: t('dpa.inPlace') },
                { value: 'missing', label: t('dpa.missing') },
              ]}
              value={dpaStatus}
              allowDeselect={false}
              onChange={(x) => x && setDpaStatus(x as typeof dpaStatus)}
            />
            {dpaStatus === 'inPlace' && (
              <TextInput type="date" label={t('fields.dpaSince')} value={dpaSince} onChange={(e) => setDpaSince(e.currentTarget.value)} />
            )}
          </Group>
          {dpaStatus === 'inPlace' && (
            <TextInput
              label={t('fields.dpaLink')}
              description={t('fields.docLinkHint')}
              value={dpaLink}
              onChange={(e) => setDpaLink(e.currentTarget.value)}
              error={v.error('dpaLink')}
            />
          )}
          <Textarea
            label={t('contracts.note')}
            autosize
            minRows={1}
            maxRows={4}
            maxLength={SUPPLIER_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
          <Group justify="flex-end">
            <FormModalCancel />
            <Button type="submit" loading={busy} data-testid="contract-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

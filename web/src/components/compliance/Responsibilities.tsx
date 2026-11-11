import { useState } from 'react';
import { Anchor, Badge, Button, Group, Paper, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconEdit } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  RECOVERY_TEST_AREAS,
  RECOVERY_TEST_PARTIES,
  RESPONSIBILITY_PARTIES,
  SOA_LIMITS,
  type ResponsibilityParty,
  type ResponsibilityRow,
  type ServiceResponsibilities,
} from '@sm/shared';
import { get, notifyError, notifyOk, put } from '../../api';
import { QueryState, useFieldErrors } from '../common';
import { SupplierPicker, useSupplierOptions } from '../suppliers/SupplierPicker';
import { calDay } from './corrective';
import { fmtNumber, fmtRelative } from '../../format';
import { responsibilityKeys } from '../../queryKeys';
import { FormModal, FormModalCancel } from '../FormModal';

/**
 * The tab "Responsibilities" of a service (ADR 0029 part 2): who does backup, recovery and continuity, patching and
 * vulnerabilities, access management, logging and monitoring and security incidents – with the supplier's SLA,
 * contractual RTO/RPO and valid certificates read from the supplier record, the recovery-test duty where the team
 * does recovery itself, and links to the rows of the statement of applicability of the area's controls.
 */
export function ServiceResponsibilitiesPanel({ serviceId }: { serviceId: string }) {
  const { t } = useTranslation('soa');
  const q = useQuery({
    queryKey: responsibilityKeys.service(serviceId),
    queryFn: () => get<ServiceResponsibilities>(`/services/${serviceId}/responsibilities`),
  });
  const [editing, setEditing] = useState<ResponsibilityRow | null>(null);
  const m = q.data;
  if (!m) return <QueryState query={q} />;
  return (
    <Stack gap="sm" data-testid="responsibilities">
      <Text size="sm" c="dimmed">
        {t('matrix.intro')}
      </Text>
      {m.undecided > 0 && (
        <Text size="sm" c="orange">
          {t('matrix.undecided', { count: m.undecided })}
        </Text>
      )}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
        {m.rows.map((r) => (
          <AreaCard key={r.area} row={r} canEdit={m.canEdit} onEdit={() => setEditing(r)} />
        ))}
      </SimpleGrid>
      {editing && <AreaForm matrix={m} row={editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}

const PARTY_COLOR: Record<ResponsibilityParty, string> = { team: 'blue', supplier: 'grape', central: 'cyan', shared: 'yellow', notApplicable: 'gray' };

function AreaCard({ row: r, canEdit, onEdit }: { row: ResponsibilityRow; canEdit: boolean; onEdit: () => void }) {
  const { t } = useTranslation('soa');
  const hours = (n: number | null) => (n === null ? '–' : t('matrix.hours', { value: fmtNumber(n) }));
  return (
    <Paper withBorder p="sm" data-testid={`responsibility-${r.area}`}>
      <Group justify="space-between" wrap="nowrap" align="flex-start" mb={4}>
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>{t(`areas.${r.area}`)}</Text>
          {r.party ? (
            <Badge color={PARTY_COLOR[r.party]} variant="light" size="sm">
              {t(`matrixParties.${r.party}`)}
            </Badge>
          ) : (
            <Badge color="orange" variant="outline" size="sm">
              {t('matrix.notDecided')}
            </Badge>
          )}
        </div>
        {canEdit && (
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={<IconEdit size={12} />}
            onClick={onEdit}
            aria-label={t('matrix.editArea', { area: t(`areas.${r.area}`) })}
          >
            {t('matrix.edit')}
          </Button>
        )}
      </Group>
      <Stack gap={2}>
        {r.party === 'supplier' &&
          (r.supplier ? (
            <Anchor component={Link} to={`/suppliers/${r.supplier.id}`} size="sm">
              {r.supplier.name}
            </Anchor>
          ) : (
            <Text size="sm" c="dimmed">
              {r.supplierHidden ? t('notVisible') : t('matrix.noSupplier')}
            </Text>
          ))}
        {r.contract && (
          <Text size="xs" c="dimmed" data-testid={`responsibility-${r.area}-contract`}>
            {t('matrix.contract', {
              title: r.contract.title,
              sla: r.contract.slaAvailability === null ? '–' : `${fmtNumber(r.contract.slaAvailability)} %`,
              rto: hours(r.contract.rtoHours),
              rpo: hours(r.contract.rpoHours),
            })}
          </Text>
        )}
        {r.party === 'supplier' && r.supplier && (
          <Text size="xs" c={r.certificates.length ? 'dimmed' : 'orange'}>
            {r.certificates.length
              ? t('matrix.certificates', {
                  list: r.certificates
                    .map((c) => `${c.kind === 'other' && c.name ? c.name : t(`certificateKinds.${c.kind}`)}${c.validUntil ? ` (${calDay(c.validUntil)})` : ''}`)
                    .join(', '),
                })
              : t('matrix.noCertificate')}
          </Text>
        )}
        {r.party === 'central' && r.centralName && <Text size="sm">{r.centralName}</Text>}
        {r.note && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {r.note}
          </Text>
        )}
        {r.recoveryTest === 'missing' && (
          <Badge color="orange" variant="light" size="sm" data-testid={`responsibility-${r.area}-no-test`}>
            {t('matrix.noRecoveryTest')}
          </Badge>
        )}
        {r.recoveryTest === 'linked' && r.duty && (
          <Text size="xs">
            {t('matrix.recoveryTest')}{' '}
            <Anchor component={Link} to={`/duties/${r.duty.id}`} size="xs">
              {r.duty.name}
            </Anchor>
          </Text>
        )}
        {r.controls.length > 0 && (
          <Group gap={4} wrap="wrap" mt={2}>
            <Text size="xs" c="dimmed">
              {t('matrix.controls')}
            </Text>
            {r.controls.map((c) =>
              c.soa ? (
                <Anchor
                  key={`${c.catalogueKey}:${c.controlId}`}
                  component={Link}
                  to={`/compliance/soa/${encodeURIComponent(c.catalogueKey)}?control=${encodeURIComponent(c.controlId)}`}
                  size="xs"
                  title={c.title}
                >
                  {c.catalogueKey} {c.ref}
                </Anchor>
              ) : (
                <Text key={`${c.catalogueKey}:${c.controlId}`} size="xs" title={c.title}>
                  {c.catalogueKey} {c.ref}
                </Text>
              ),
            )}
          </Group>
        )}
        {r.updatedAt && (
          <Text size="xs" c="dimmed">
            {t('matrix.updated', { user: r.updatedBy ?? '', when: fmtRelative(r.updatedAt) })}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function AreaForm({ matrix, row, onClose }: { matrix: ServiceResponsibilities; row: ResponsibilityRow; onClose: () => void }) {
  const { t } = useTranslation(['soa', 'common']);
  const qc = useQueryClient();
  const options = useSupplierOptions();
  const [party, setParty] = useState<ResponsibilityParty | null>(row.party);
  const [supplierId, setSupplierId] = useState<string | null>(row.supplier?.id ?? null);
  const [touched, setTouched] = useState(false);
  const [contractId, setContractId] = useState<string | null>(row.contract?.id ?? null);
  const [centralName, setCentralName] = useState(row.centralName);
  const [note, setNote] = useState(row.note);
  const [dutyId, setDutyId] = useState<string | null>(row.duty?.id ?? null);
  const [busy, setBusy] = useState(false);
  const contracts = (options.data ?? []).find((o) => o.id === supplierId)?.contracts ?? (row.contract && supplierId === row.supplier?.id ? [row.contract] : []);
  const needsTest = !!party && RECOVERY_TEST_AREAS.includes(row.area) && RECOVERY_TEST_PARTIES.includes(party);
  const v = useFieldErrors({
    centralName: party === 'central' && !centralName.trim() && t('common:validation.required'),
    note: party === 'shared' && !note.trim() && t('matrix.noteRequired'),
  });
  const save = async () => {
    if (!v.validate()) return;
    setBusy(true);
    try {
      await put(`/services/${matrix.serviceId}/responsibilities`, {
        areas: [
          {
            area: row.area,
            party,
            ...(party === 'supplier' ? { ...(touched || !row.supplierHidden ? { supplierId } : {}), contractId } : {}),
            centralName: centralName.trim(),
            note: note.trim(),
            dutyId: needsTest ? dutyId : null,
          },
        ],
      });
      notifyOk(t('matrix.saved', { area: t(`areas.${row.area}`) }));
      void qc.invalidateQueries({ queryKey: responsibilityKeys.service(matrix.serviceId) });
      void qc.invalidateQueries({ queryKey: ['soa'] });
      onClose();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  return (
    <FormModal onClose={onClose} title={t('matrix.formTitle', { area: t(`areas.${row.area}`), service: matrix.serviceName })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm" data-testid="responsibility-form">
          <Select
            label={t('matrix.party')}
            data={RESPONSIBILITY_PARTIES.map((x) => ({ value: x, label: t(`matrixParties.${x}`) }))}
            value={party}
            onChange={(x) => setParty(x as ResponsibilityParty | null)}
            clearable
            placeholder={t('matrix.notDecided')}
            data-autofocus
            data-testid="responsibility-party"
          />
          {party === 'supplier' && (
            <>
              <SupplierPicker
                value={supplierId}
                onChange={(id) => {
                  setSupplierId(id);
                  setTouched(true);
                  setContractId(null);
                }}
                initial={row.supplier}
                testId="responsibility-supplier"
              />
              <Select
                label={t('matrix.contractLabel')}
                description={t('matrix.contractHint')}
                data={contracts.map((c) => ({ value: c.id, label: c.reference ? `${c.title} (${c.reference})` : c.title }))}
                value={contractId}
                onChange={setContractId}
                clearable
                disabled={!supplierId}
              />
            </>
          )}
          {party === 'central' && (
            <TextInput
              label={t('matrix.centralName')}
              required
              maxLength={SOA_LIMITS.centralName}
              value={centralName}
              onChange={(e) => setCentralName(e.currentTarget.value)}
              error={v.error('centralName')}
            />
          )}
          <Textarea
            label={t('matrix.note')}
            description={party === 'shared' ? t('matrix.noteShared') : undefined}
            required={party === 'shared'}
            autosize
            minRows={2}
            maxLength={SOA_LIMITS.note}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
            error={v.error('note')}
          />
          {needsTest && (
            <Select
              label={t('matrix.duty')}
              description={t('matrix.dutyHint')}
              data={matrix.duties.map((d) => ({ value: d.id, label: d.name }))}
              value={dutyId}
              onChange={setDutyId}
              clearable
              nothingFoundMessage={t('matrix.noDuties')}
            />
          )}
          <Group justify="flex-end" gap="xs">
            <FormModalCancel />
            <Button type="submit" loading={busy} data-testid="responsibility-save">
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </FormModal>
  );
}

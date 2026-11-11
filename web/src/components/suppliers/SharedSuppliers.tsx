import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, List, Paper, SegmentedControl, Stack, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconGitMerge } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { SupplierContactChoice, SupplierMergePreview, SupplierProposedServices, SupplierSharedSuggestion } from '@sm/shared';
import { del, get, notifyError, notifyOk, post } from '../../api';
import { useMe } from '../../auth';
import { subjectLabel } from '../common';
import { SubjectsInput } from '../SubjectsInput';
import { FormModal, FormModalCancel } from '../FormModal';
import { supplierKeys } from '../../queryKeys';

/** The administrators' one-time notice after the update to 0.18: contracts now seen only by their owners and services. */
export function ContractScopeNotice() {
  const { t } = useTranslation('suppliers');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...supplierKeys.all, 'scope-notice'],
    queryFn: () => get<{ notice: { narrowed: number } | null }>('/suppliers/scope-notice'),
  });
  if (!q.data?.notice) return null;
  const close = async () => {
    try {
      await del('/suppliers/scope-notice');
      void qc.invalidateQueries({ queryKey: [...supplierKeys.all, 'scope-notice'] });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Alert
      color="blue"
      variant="light"
      mb="md"
      withCloseButton
      onClose={() => void close()}
      closeButtonLabel={t('shared.noticeClose')}
      data-testid="contract-scope-notice"
    >
      <Text size="sm" fw={600}>
        {t('shared.noticeTitle')}
      </Text>
      <Text size="sm">{t('shared.noticeText', { count: q.data.notice.narrowed })}</Text>
    </Alert>
  );
}

/** "Contracts with services to confirm" (ADR 0031): services proposed by the update, for who may confirm them. */
export function ProposedServices() {
  const { t } = useTranslation('suppliers');
  const q = useQuery({ queryKey: [...supplierKeys.all, 'proposed-services'], queryFn: () => get<SupplierProposedServices[]>('/suppliers/proposed-services') });
  if (!q.data?.length) return null;
  return (
    <Stack gap="xs" mb="lg" data-testid="proposed-services">
      <Text fw={600}>{t('shared.proposedTitle')}</Text>
      <Text size="xs" c="dimmed">
        {t('shared.proposedIntro')}
      </Text>
      {q.data.map((x) => (
        <Group key={x.contract.id} gap="xs" wrap="wrap">
          <Anchor component={Link} to={`/suppliers/${x.supplier.id}/contracts/${x.contract.id}`} size="sm" fw={500}>
            {x.supplier.name} · {x.contract.title}
          </Anchor>
          {x.services.map((s) => (
            <Badge key={s.id} size="xs" color="yellow" variant="light" style={{ textTransform: 'none' }}>
              {s.name}
            </Badge>
          ))}
        </Group>
      ))}
    </Stack>
  );
}

/**
 * "Same supplier in several teams" (administrators, ADR 0031 part 8): the groups the 0.17 update left, each with its
 * proposed shared supplier – _Merge…_ opens the preview, _Keep separate_ dismisses the group until another joins.
 */
export function SharedSuppliers() {
  const { t } = useTranslation(['suppliers', 'common']);
  const { hasRole } = useMe();
  const admin = hasRole('admin');
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...supplierKeys.all, 'shared'],
    queryFn: () => get<SupplierSharedSuggestion[]>('/suppliers/shared-suggestions'),
    enabled: admin,
  });
  const [merging, setMerging] = useState<SupplierSharedSuggestion | null>(null);
  if (!admin || !q.data?.length) return null;
  const keep = async (g: SupplierSharedSuggestion) => {
    try {
      await post(`/suppliers/shared-suggestions/${encodeURIComponent(g.key)}/keep-separate`);
      notifyOk(t('shared.keptSeparate'));
      void qc.invalidateQueries({ queryKey: supplierKeys.all });
    } catch (e) {
      notifyError(e);
    }
  };
  return (
    <Stack gap="xs" mb="lg" data-testid="shared-suggestions">
      <Text fw={600}>{t('shared.title')}</Text>
      <Text size="xs" c="dimmed">
        {t('shared.intro')}
      </Text>
      {q.data.map((g) => (
        <Paper withBorder p="sm" key={g.key} data-testid="shared-group">
          <Group justify="space-between" wrap="wrap" align="flex-start">
            <Stack gap={2} style={{ minWidth: 0 }}>
              {g.suppliers.map((s) => (
                <Group key={s.id} gap="xs" wrap="wrap">
                  <Anchor component={Link} to={`/suppliers/${s.id}`} size="sm" fw={s.id === g.intoId ? 600 : 400}>
                    {s.name}
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {s.teams.length ? s.teams.join(', ') : t('shared.wholeInstance')} · {t('shared.counts', { contracts: s.contracts, contacts: s.contacts })}
                  </Text>
                  {s.id === g.intoId && (
                    <Badge size="xs" variant="light">
                      {t('shared.proposed')}
                    </Badge>
                  )}
                </Group>
              ))}
            </Stack>
            <Group gap={4}>
              <Button size="compact-xs" variant="light" leftSection={<IconGitMerge size={12} />} onClick={() => setMerging(g)} data-testid="shared-merge">
                {t('shared.merge')}
              </Button>
              <Button size="compact-xs" variant="default" onClick={() => void keep(g)} data-testid="shared-keep">
                {t('shared.keepSeparate')}
              </Button>
            </Group>
          </Group>
        </Paper>
      ))}
      {merging && (
        <MergePreviewModal
          intoId={merging.intoId}
          ids={merging.suppliers.map((s) => s.id).filter((id) => id !== merging.intoId)}
          onClose={() => setMerging(null)}
          onMerged={() => {
            setMerging(null);
            void qc.invalidateQueries({ queryKey: supplierKeys.all });
          }}
        />
      )}
    </Stack>
  );
}

/**
 * The preview of a merge into one shared supplier: who gains sight of the company record, the owners each contract
 * will have, the scope each company-wide contact will get (or the administrator's choice), the DPA written onto moved
 * contracts, what is combined, and the owners of the result. Nothing changes before _Merge_.
 */
export function MergePreviewModal({ intoId, ids, onClose, onMerged }: { intoId: string; ids: string[]; onClose: () => void; onMerged: () => void }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [choices, setChoices] = useState<Record<string, SupplierContactChoice>>({});
  const [owners, setOwners] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: [...supplierKeys.all, 'merge-preview', intoId, ...ids, JSON.stringify(choices)],
    queryFn: () => post<SupplierMergePreview>('/suppliers/merge/preview', { intoId, ids, contacts: choices }),
  });
  const p = q.data;
  const merge = async () => {
    setBusy(true);
    try {
      await post('/suppliers/merge', { intoId, ids, contacts: choices, owners: owners ?? p?.owners });
      notifyOk(t('actions.merged'));
      onMerged();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const pending = p?.contacts.filter((c) => c.action === 'choose' && !choices[c.id]) ?? [];
  return (
    <FormModal onClose={onClose} size="lg" title={t('shared.previewTitle')}>
      {!p ? (
        <Text size="sm" c="dimmed">
          {t('common:loading')}
        </Text>
      ) : (
        <Stack gap="sm" data-testid="merge-preview">
          <PreviewDetails p={p} choices={choices} setChoices={setChoices} />
          <SubjectsInput label={t('shared.owners')} value={owners ?? p.owners} onChange={setOwners} max={20} />
          <Text size="xs" c="dimmed">
            {t('shared.moves', { spellings: p.moves.spellings.length, schedules: p.moves.schedules })}
          </Text>
          <Group justify="flex-end">
            <FormModalCancel />
            <Button onClick={() => void merge()} loading={busy} disabled={pending.length > 0} data-testid="merge-confirm">
              {t('merge.submit')}
            </Button>
          </Group>
        </Stack>
      )}
    </FormModal>
  );
}

/**
 * What a merge or an opening changes (ADR 0031 part 8): who gains or loses sight, the owning teams of the result, the
 * owners each contract will have, the scope each company-wide contact will get (or the administrator's choice), what
 * is combined and the DPA written onto moved contracts. Only what the person may see (the server filters it).
 */
function PreviewDetails({
  p,
  choices,
  setChoices,
}: {
  p: SupplierMergePreview;
  choices: Record<string, SupplierContactChoice>;
  setChoices: (c: Record<string, SupplierContactChoice>) => void;
}) {
  const { t } = useTranslation(['suppliers', 'common']);
  return (
    <>
      {p.widens && (
        <Alert color="orange" variant="light">
          {p.gainers.length ? t('shared.gainers', { names: p.gainers.join(', ') }) : t('shared.widens')}
        </Alert>
      )}
      {p.narrows && (
        <Alert color="orange" variant="light" data-testid="merge-narrows">
          {p.losers.length ? t('shared.losers', { names: p.losers.join(', ') }) : t('shared.narrows')}
        </Alert>
      )}
      <Text size="sm">{t('shared.teams', { teams: p.teams.length ? p.teams.join(', ') : t('shared.wholeInstance') })}</Text>
      {p.contracts.length > 0 && (
        <Stack gap={2}>
          <Text fw={600} size="sm">
            {t('contracts.title')}
          </Text>
          <List size="sm" spacing={2}>
            {p.contracts.map((c) => (
              <List.Item key={c.id}>
                {c.title}
                {c.reference ? ` · ${c.reference}` : ''}: {c.ownersAfter.length ? c.ownersAfter.map(subjectLabel).join(', ') : t('shared.noOwners')}
                {c.sameReference && (
                  <Badge size="xs" color="yellow" variant="light" ml={4}>
                    {t('shared.sameReference')}
                  </Badge>
                )}
              </List.Item>
            ))}
          </List>
        </Stack>
      )}
      {p.contacts.length > 0 && (
        <Stack gap={4}>
          <Text fw={600} size="sm">
            {t('contacts.title')}
          </Text>
          {p.contacts.map((c) => (
            <Group key={c.id} gap="xs" wrap="wrap">
              <Text size="sm">{c.name}:</Text>
              {c.action === 'choose' || choices[c.id] ? (
                <SegmentedControl
                  size="xs"
                  data={[
                    { value: 'companyWide', label: t('shared.makeCompanyWide') },
                    { value: 'remove', label: t('shared.removeContact') },
                  ]}
                  value={choices[c.id] ?? ''}
                  onChange={(v) => setChoices({ ...choices, [c.id]: v as SupplierContactChoice })}
                />
              ) : (
                <Text size="sm" c="dimmed">
                  {t(`shared.contactActions.${c.action}`, { items: c.scope.map((x) => x.name).join(', ') })}
                </Text>
              )}
            </Group>
          ))}
        </Stack>
      )}
      {p.certificates.length > 0 && <Text size="sm">{t('shared.certificatesCombined', { count: p.certificates.length })}</Text>}
      {p.dpa.length > 0 && <Text size="sm">{t('shared.dpaWritten', { contracts: p.dpa.map((x) => x.title).join(', ') })}</Text>}
    </>
  );
}

/**
 * The preview of new owning teams for a supplier (the _Owning teams_ panel): what the opening protects and the choice
 * for company-wide contacts that cannot be scoped, then `POST /suppliers/:id/open` (confirmed with a step-up when it
 * grants access). Nothing changes before _Change owning teams_.
 */
export function OpenSupplierModal({ id, teamIds, onClose, onDone }: { id: string; teamIds: string[]; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(['suppliers', 'common']);
  const [choices, setChoices] = useState<Record<string, SupplierContactChoice>>({});
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: [...supplierKeys.all, 'open-preview', id, ...teamIds, JSON.stringify(choices)],
    queryFn: () => post<SupplierMergePreview>(`/suppliers/${id}/open/preview`, { teamIds, contacts: choices }),
  });
  const p = q.data;
  const open = async () => {
    setBusy(true);
    try {
      await post(`/suppliers/${id}/open`, { teamIds, contacts: choices });
      notifyOk(t('shared.opened'));
      onDone();
    } catch (e) {
      notifyError(e);
      setBusy(false);
    }
  };
  const pending = p?.contacts.filter((c) => c.action === 'choose' && !choices[c.id]) ?? [];
  return (
    <FormModal onClose={onClose} size="lg" title={t('shared.openTitle')}>
      {!p ? (
        <Text size="sm" c="dimmed">
          {t('common:loading')}
        </Text>
      ) : (
        <Stack gap="sm" data-testid="open-preview">
          <Text size="sm" c="dimmed">
            {t('shared.openIntro')}
          </Text>
          <PreviewDetails p={p} choices={choices} setChoices={setChoices} />
          <Group justify="flex-end">
            <FormModalCancel />
            <Button onClick={() => void open()} loading={busy} disabled={pending.length > 0} data-testid="open-confirm">
              {t('shared.openConfirm')}
            </Button>
          </Group>
        </Stack>
      )}
    </FormModal>
  );
}

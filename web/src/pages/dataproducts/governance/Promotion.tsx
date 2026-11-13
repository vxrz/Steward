import { useState } from 'react';
import { Alert, Badge, Button, Group, Select, SimpleGrid, Stack, Text, TextInput, Textarea } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_PROMOTION_EVIDENCE_KINDS,
  type DataMemberRole,
  type DataProduct,
  type DataPromotionElement,
  type DataPromotionEvidenceKind,
  type DataPromotionInput,
  type DataPromotionState,
} from '@sm/shared';
import { post } from '../../../api';
import { QueryState } from '../../../components/common';
import { FormModal, FormModalCancel } from '../../../components/FormModal';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDate } from '../../../format';
import { CardTable, useSortedEnvironments } from '../parts';
import { useInvalidateGovernance, usePromotionPreview, usePromotions } from './api';

const enc = encodeURIComponent;

function StateBadge({ state }: { state: DataPromotionState }) {
  const { t } = useTranslation('dataProductGovernance');
  const color = { found: 'green', missing: 'red', already: 'gray' }[state];
  return (
    <Badge size="sm" variant="light" color={color} tt="none">
      {t(`promotion.states.${state}`)}
    </Badge>
  );
}

function Rows({ rows, label }: { rows: (DataPromotionElement & { role?: DataMemberRole })[]; label: string }) {
  const { t } = useTranslation('dataProductGovernance');
  return (
    <CardTable
      ariaLabel={label}
      rows={rows}
      rowKey={(e) => e.sourceId}
      rowTestId={(e) => `promotion-row-${e.state}`}
      columns={[
        {
          key: 'source',
          header: t('promotion.source'),
          cell: (e) => (
            <>
              <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                {e.sourceName}
              </span>
              {e.role && (
                <Text size="xs" c="dimmed">
                  {t(`promotion.roles.${e.role}`)}
                </Text>
              )}
            </>
          ),
        },
        {
          key: 'target',
          header: t('promotion.target'),
          cell: (e) =>
            e.targetName ? (
              <span className="mono" style={{ overflowWrap: 'anywhere' }}>
                {e.targetName}
              </span>
            ) : (
              <Text size="xs" c="dimmed">
                {t('promotion.lookedFor', { names: e.candidates.join(', ') })}
              </Text>
            ),
        },
        { key: 'state', header: t('promotion.state'), cell: (e) => <StateBadge state={e.state} /> },
      ]}
    />
  );
}

/**
 * Promote a product to the next environment (ADR 0036 part 4): the preview – what the name rules find there and what is
 * missing – and the evidence (a change record, a ticket, a process run). Steward deploys nothing.
 */
export function PromotionForm({ p, onClose }: { p: DataProduct; onClose: () => void }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const invalidate = useInvalidateGovernance();
  // production last here: promotions go towards it
  const envs = [...useSortedEnvironments(p.environments)].reverse();
  const [from, setFrom] = useState<string | null>(envs[0] ?? null);
  const [to, setTo] = useState<string | null>(envs[1] ?? null);
  const [evidenceKind, setEvidenceKind] = useState<DataPromotionEvidenceKind | null>(null);
  const [evidenceRef, setEvidenceRef] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState(false);
  const preview = usePromotionPreview(p.id, from, to);
  const history = usePromotions(p.id);
  const [busy, run] = useBusy();
  const pv = preview.data;
  const save = () =>
    run(async () => {
      const body: DataPromotionInput = {
        from: from!,
        to: to!,
        fingerprint: pv?.fingerprint ?? null,
        evidence: evidenceKind && evidenceRef.trim() ? { kind: evidenceKind, ref: evidenceRef.trim() } : null,
        note: note.trim(),
      };
      await post(`/data-products/${enc(p.id)}/promotion`, body);
      setDone(true);
      invalidate();
    });
  const options = p.environments.map((e) => ({ value: e, label: e }));
  return (
    // promoted: nothing entered is lost any more – close without asking
    <FormModal onClose={onClose} dirty={done ? false : undefined} size="xl" title={t('promotion.title', { name: p.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (pv && pv.counts.found > 0) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('promotion.help')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select label={t('promotion.from')} data={options} value={from} onChange={setFrom} allowDeselect={false} data-testid="promotion-from" />
            <Select label={t('promotion.to')} data={options} value={to} onChange={setTo} allowDeselect={false} data-testid="promotion-to" />
          </SimpleGrid>
          {p.environments.length < 2 && (
            <Alert variant="light" color="yellow" p="xs">
              {t('promotion.oneEnvironment')}
            </Alert>
          )}
          <QueryState query={preview} />
          {pv && (
            <Stack gap="xs" data-testid="promotion-preview">
              <Group gap="xs">
                <Text size="sm" fw={600}>
                  {pv.from}
                </Text>
                <IconArrowRight size={14} aria-hidden />
                <Text size="sm" fw={600}>
                  {pv.to}
                </Text>
                <Text size="sm" data-testid="promotion-counts">
                  {t('promotion.counts', pv.counts)}
                </Text>
              </Group>
              {pv.rules.length > 0 ? (
                <Text size="xs" c="dimmed">
                  {t('promotion.rules', { rules: pv.rules.map((r) => `${t(`promotion.match.${r.match}`)} ${r.value} → ${r.environment}`).join('; ') })}
                </Text>
              ) : (
                <Text size="xs" c="dimmed">
                  {t('promotion.noRules')}
                </Text>
              )}
              {pv.hidden > 0 && (
                <Text size="xs" c="dimmed">
                  {t('promotion.hidden', { count: pv.hidden })}
                </Text>
              )}
              {pv.members.length > 0 && (
                <>
                  <Text size="sm" fw={600}>
                    {t('promotion.members')}
                  </Text>
                  <Rows rows={pv.members} label={t('promotion.members')} />
                </>
              )}
              {pv.bindings.map((b) => (
                <Stack key={b.portId} gap={4}>
                  <Text size="sm" fw={600}>
                    {t('promotion.binding', { port: `${b.portName}${b.version ? ` ${b.version}` : ''}` })}
                    {b.targetBound && ` – ${t('promotion.targetBound')}`}
                  </Text>
                  {b.contract && (
                    <Text size="xs" c="dimmed">
                      {t('promotion.contract', { name: b.contract.hidden ? t('promotion.hiddenContract') : b.contract.name })}
                    </Text>
                  )}
                  <Rows rows={b.elements} label={t('promotion.binding', { port: b.portName })} />
                </Stack>
              ))}
              {!pv.members.length && !pv.bindings.length && (
                <Text size="sm" c="dimmed">
                  {t('promotion.empty', { environment: pv.from })}
                </Text>
              )}
            </Stack>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('promotion.evidence')}
              description={t('promotion.evidenceHelp')}
              data={DATA_PROMOTION_EVIDENCE_KINDS.map((k) => ({ value: k, label: t(`promotion.evidenceKinds.${k}`) }))}
              value={evidenceKind}
              onChange={(v) => setEvidenceKind(v as DataPromotionEvidenceKind | null)}
              clearable
              data-testid="promotion-evidence-kind"
            />
            <TextInput
              label={t('promotion.evidenceRef')}
              value={evidenceRef}
              onChange={(e) => setEvidenceRef(e.currentTarget.value)}
              disabled={!evidenceKind}
              data-testid="promotion-evidence-ref"
            />
          </SimpleGrid>
          <Textarea label={t('promotion.note')} value={note} onChange={(e) => setNote(e.currentTarget.value)} autosize minRows={2} />
          {done && (
            <Alert variant="light" color="green" p="xs" data-testid="promotion-done">
              {t('promotion.done')}
            </Alert>
          )}
          {p.permissions.includes('edit') && !done && pv && pv.counts.found > 0 ? (
            <FormButtons busy={busy} submit={t('promotion.promote')} testId="promotion-save" />
          ) : (
            // nothing to promote, no right to, or done: a way out besides the ✕
            <Group justify="flex-end" mt="sm">
              {done ? (
                <Button variant="default" onClick={onClose} data-testid="promotion-close">
                  {t('common:close')}
                </Button>
              ) : (
                <FormModalCancel data-testid="promotion-close">{t('common:close')}</FormModalCancel>
              )}
            </Group>
          )}
          {(history.data ?? []).length > 0 && (
            <Stack gap={2}>
              <Text size="sm" fw={600}>
                {t('promotion.history')}
              </Text>
              {history.data!.map((h) => (
                <Text key={h.id} size="xs" c="dimmed" data-testid="promotion-history">
                  {t('promotion.historyLine', {
                    date: fmtDate(h.createdAt),
                    user: h.createdBy,
                    from: h.from,
                    to: h.to,
                    members: h.members,
                    bindings: h.bindings,
                    missing: h.missing,
                  })}
                  {h.evidence && ` · ${t(`promotion.evidenceKinds.${h.evidence.kind}`)}: ${h.evidence.ref}`}
                </Text>
              ))}
            </Stack>
          )}
        </Stack>
      </form>
    </FormModal>
  );
}

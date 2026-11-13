import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Modal, NumberInput, Radio, Select, Stack, Table, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconClipboardCheck, IconSettings, IconShieldCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataPortReview, DataPortReviewItem, DataProduct } from '@sm/shared';
import { get, getOptional, post, put } from '../../../api';
import { QueryState, useFieldErrors } from '../../../components/common';
import { FormModal } from '../../../components/FormModal';
import { useSubjectLabel } from '../../../components/SubjectsInput';
import { TableScroll } from '../../../components/TableScroll';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDate, fmtDay } from '../../../format';
import { CardTable, Section, useSortedEnvironments } from '../parts';
import { ProductRequests } from './AccessRequests';
import { useAccessSettings, useInvalidateGovernance, useProductReviews, useReview } from './api';

const enc = encodeURIComponent;

/**
 * Access of a product (ADR 0036 part 12 phase 2) on its Access tab: the access requests of its output ports, the
 * periodic port access reviews with when they are due, and the settings – the process a grant starts, the ticket
 * source, the review interval.
 */
export function GovernanceAccessSections({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProductGovernance');
  return (
    <>
      <Section title={t('requests.title')} testId="product-access-requests">
        <Text size="xs" c="dimmed" mb="xs">
          {t('requests.productHelp')}
        </Text>
        <ProductRequests p={p} />
      </Section>
      <PortReviews p={p} />
      <AccessSettingsSection p={p} />
    </>
  );
}

function PortReviews({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const q = useProductReviews(p.id);
  const invalidate = useInvalidateGovernance();
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const outputs = p.ports.filter((x) => x.direction === 'output');
  const canStart = p.permissions.includes('manage') || p.permissions.includes('edit');
  return (
    <Section
      title={t('reviews.title')}
      testId="product-port-reviews"
      actions={
        canStart &&
        outputs.length > 0 && (
          <Button size="xs" variant="default" leftSection={<IconClipboardCheck size={14} />} onClick={() => setStarting(true)} data-testid="review-start">
            {t('reviews.start')}
          </Button>
        )
      }
    >
      <Text size="xs" c="dimmed" mb="xs">
        {t('reviews.help')}
      </Text>
      <QueryState query={q} />
      {(q.data?.due ?? []).length > 0 && (
        <Stack gap={4} mb="xs">
          {q.data!.due.map((d) => (
            <Text key={`${d.portId}|${d.environment}`} size="sm" c={d.overdue ? 'red' : undefined} data-testid="review-due">
              {t(d.overdue ? 'reviews.overdue' : 'reviews.due', { port: d.portName, environment: d.environment, date: fmtDay(d.dueDate) })}
            </Text>
          ))}
        </Stack>
      )}
      {q.isSuccess && !q.data.items.length && (
        <Text size="sm" c="dimmed">
          {t('reviews.none')}
        </Text>
      )}
      {(q.data?.items ?? []).length > 0 && (
        <CardTable
          ariaLabel={t('reviews.title')}
          rows={q.data!.items}
          rowKey={(r) => r.id}
          rowTestId={() => 'review-row'}
          columns={[
            {
              key: 'port',
              header: t('reviews.port'),
              cell: (r) => (
                <span className="mono">
                  {r.portName} · {r.environment}
                </span>
              ),
            },
            {
              key: 'status',
              header: t('reviews.status'),
              cell: (r) => (
                <Badge size="sm" variant="light" tt="none" color={r.status === 'approved' ? 'green' : r.status === 'submitted' ? 'violet' : 'yellow'}>
                  {t(`reviews.statuses.${r.status}`)}
                </Badge>
              ),
            },
            { key: 'entries', header: t('reviews.entries'), nowrap: true, cell: (r) => t('reviews.entriesCount', { count: r.items, removals: r.removals }) },
            {
              key: 'started',
              header: t('reviews.started'),
              nowrap: true,
              cell: (r) => `${fmtDay(r.createdAt)} · ${r.createdBy}`,
            },
            {
              key: 'open',
              header: t('reviews.open'),
              actions: true,
              cell: (r) => (
                <Button
                  size="compact-xs"
                  variant="subtle"
                  onClick={() => setOpen(r.id)}
                  aria-label={t('reviews.openNamed', { port: r.portName, environment: r.environment })}
                  data-testid="review-open"
                >
                  {t('reviews.open')}
                </Button>
              ),
            },
          ]}
        />
      )}
      {starting && (
        <StartReviewForm
          p={p}
          onClose={() => setStarting(false)}
          onStarted={(id) => {
            setStarting(false);
            invalidate();
            setOpen(id);
          }}
        />
      )}
      {open && <ReviewModal id={open} onClose={() => setOpen(null)} />}
    </Section>
  );
}

function StartReviewForm({ p, onClose, onStarted }: { p: DataProduct; onClose: () => void; onStarted: (id: string) => void }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  // production first (the review that matters most is the default), as the environment switches order them
  const order = useSortedEnvironments(p.environments);
  const rank = (e: string) => (order.indexOf(e) < 0 ? order.length : order.indexOf(e));
  const options = p.ports
    .filter((x) => x.direction === 'output')
    .flatMap((x) =>
      x.bindings.map((b) => ({
        env: b.environment,
        value: `${x.id}|${b.environment}`,
        label: `${x.name}${x.version ? ` ${x.version}` : ''} · ${b.environment}`,
      })),
    )
    .sort((x, y) => rank(x.env) - rank(y.env))
    .map(({ value, label }) => ({ value, label }));
  const [which, setWhich] = useState<string | null>(options[0]?.value ?? null);
  const [checkId, setCheckId] = useState<string | null>(null);
  const [fourEyes, setFourEyes] = useState('yes');
  const [busy, run] = useBusy();
  const checks = useQuery({ queryKey: ['accessChecks'], queryFn: () => getOptional<{ id: string; name: string }[]>('/compliance/access-checks', []) });
  const v = useFieldErrors({ which: !which && t('common:validation.required') });
  const save = () =>
    run(async () => {
      const [portId, environment] = which!.split('|') as [string, string];
      const r = await post<DataPortReview>(`/data-products/${enc(p.id)}/ports/${enc(portId)}/reviews`, { environment, checkId, fourEyes: fourEyes === 'yes' });
      onStarted(r.id);
    });
  return (
    <FormModal onClose={onClose} title={t('reviews.startTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('reviews.portEnvironment')}
            data={options}
            value={which}
            onChange={setWhich}
            allowDeselect={false}
            required
            error={v.error('which')}
            data-testid="review-port"
          />
          <Select
            label={t('reviews.check')}
            description={t('reviews.checkHelp')}
            data={(checks.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
            value={checkId}
            onChange={setCheckId}
            clearable
            searchable
          />
          <Radio.Group label={t('reviews.fourEyes')} value={fourEyes} onChange={setFourEyes}>
            <Group mt={4}>
              <Radio value="yes" label={t('reviews.fourEyesYes')} />
              <Radio value="no" label={t('reviews.fourEyesNo')} />
            </Group>
          </Radio.Group>
          <FormButtons busy={busy} submit={t('reviews.start')} testId="review-start-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** A port access review: the frozen entries with keep or remove, submit, approve or send back, the seal. */
function ReviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const q = useReview(id);
  const invalidate = useInvalidateGovernance();
  const [busy, run] = useBusy();
  const [comment, setComment] = useState('');
  const [verified, setVerified] = useState<boolean | null>(null);
  const subject = useSubjectLabel();
  // a registration of a Steward user or team is frozen with its subject (team:…): its name, as everywhere else
  const entryLabel = (i: DataPortReviewItem) => (i.kind === 'registered' && /^(user|team):/.test(i.label) ? subject(i.label) : i.label);
  const r = q.data;
  const decide = (item: DataPortReviewItem, decision: 'keep' | 'remove' | null, note = item.comment) =>
    run(async () => {
      await put(`/data-products/port-reviews/${enc(id)}/decisions`, { decisions: [{ itemId: item.id, decision, comment: note }] });
      invalidate();
    });
  const step = (path: 'submit' | 'approval', body?: unknown) =>
    run(async () => {
      await post(`/data-products/port-reviews/${enc(id)}/${path}`, body);
      invalidate();
    });
  const verify = () =>
    run(async () => {
      const x = await get<{ ok: boolean }>(`/data-products/port-reviews/${enc(id)}/verify`);
      setVerified(x.ok);
    });
  return (
    <Modal opened onClose={onClose} size="xl" title={r ? t('reviews.modalTitle', { port: r.portName, environment: r.environment }) : t('reviews.title')}>
      <QueryState query={q} />
      {r && (
        <Stack gap="sm" data-testid="review-modal">
          <Group gap="xs">
            <Badge variant="light" tt="none">
              {t(`reviews.statuses.${r.status}`)}
            </Badge>
            {r.fourEyes && (
              <Badge variant="outline" tt="none">
                {t('reviews.fourEyesShort')}
              </Badge>
            )}
          </Group>
          {r.check && (
            <Text size="xs" c="dimmed">
              {t(r.check.origin === 'live' ? 'reviews.checkLive' : 'reviews.checkSnapshot', { name: r.check.name, date: fmtDate(r.check.takenAt) })}
            </Text>
          )}
          <TableScroll>
            <Table fz="sm" aria-label={t('reviews.entriesLabel')}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th scope="col">{t('reviews.entry')}</Table.Th>
                  <Table.Th scope="col">{t('reviews.finding')}</Table.Th>
                  <Table.Th scope="col">{t('reviews.decision')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {r.entries.map((i) => (
                  <Table.Tr key={i.id} data-testid="review-entry">
                    <Table.Td style={{ overflowWrap: 'anywhere' }}>
                      <Text size="sm" fw={500}>
                        {entryLabel(i)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {t(`reviews.kinds.${i.kind}`)}
                        {i.detail && ` · ${i.detail}`}
                      </Text>
                    </Table.Td>
                    <Table.Td style={{ overflowWrap: 'anywhere' }}>
                      {i.kind === 'grant' ? i.finding : t(`actual.states.${i.finding}`, { defaultValue: i.finding })}
                    </Table.Td>
                    <Table.Td>
                      {r.mayDecide ? (
                        <Stack gap={4}>
                          <Select
                            size="xs"
                            aria-label={t('reviews.decisionFor', { name: entryLabel(i) })}
                            data={[
                              { value: 'keep', label: t('reviews.keep') },
                              { value: 'remove', label: t('reviews.remove') },
                            ]}
                            value={i.decision}
                            placeholder={t('reviews.undecided')}
                            onChange={(d) => void decide(i, d as 'keep' | 'remove' | null, d === 'remove' ? i.comment || '' : i.comment)}
                            disabled={busy}
                            data-testid="review-decision"
                          />
                          {i.decision === 'remove' && (
                            <TextInput
                              size="xs"
                              aria-label={t('reviews.reasonFor', { name: entryLabel(i) })}
                              placeholder={t('reviews.reason')}
                              defaultValue={i.comment}
                              onBlur={(e) => e.currentTarget.value !== i.comment && void decide(i, 'remove', e.currentTarget.value)}
                              data-testid="review-reason"
                            />
                          )}
                        </Stack>
                      ) : (
                        <Text size="sm">
                          {i.decision ? t(`reviews.${i.decision}`) : t('reviews.undecided')}
                          {i.comment && ` – ${i.comment}`}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableScroll>
          {r.mayDecide && (
            <Group justify="flex-end">
              <Button onClick={() => void step('submit')} loading={busy} data-testid="review-submit">
                {t('reviews.submit')}
              </Button>
            </Group>
          )}
          {r.mayApprove && (
            <Stack gap="xs">
              <Textarea label={t('reviews.approvalComment')} value={comment} onChange={(e) => setComment(e.currentTarget.value)} autosize minRows={2} />
              <Group justify="flex-end">
                <Button variant="default" onClick={() => void step('approval', { approve: false, comment })} loading={busy} data-testid="review-return">
                  {t('reviews.sendBack')}
                </Button>
                <Button onClick={() => void step('approval', { approve: true, comment })} loading={busy} data-testid="review-approve">
                  {t('reviews.approve')}
                </Button>
              </Group>
            </Stack>
          )}
          {r.sealHash && (
            <Alert variant="light" color="green" icon={<IconShieldCheck size={16} />} p="xs">
              <Text size="sm">{t('reviews.sealed', { user: r.approvedBy ?? '', date: fmtDate(r.approvedAt) })}</Text>
              <Text size="xs" className="mono" style={{ overflowWrap: 'anywhere' }}>
                {r.sealHash}
              </Text>
              <Group gap="xs" mt={4}>
                <Button size="compact-xs" variant="subtle" onClick={() => void verify()} data-testid="review-verify">
                  {t('reviews.verify')}
                </Button>
                {verified !== null && (
                  <Text size="xs" c={verified ? 'green' : 'red'} data-testid="review-verified">
                    {verified ? t('reviews.verifyOk') : t('reviews.verifyBad')}
                  </Text>
                )}
              </Group>
            </Alert>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function AccessSettingsSection({ p }: { p: DataProduct }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const q = useAccessSettings(p.id);
  const [editing, setEditing] = useState(false);
  const s = q.data;
  return (
    <Section
      title={t('settings.title')}
      testId="product-access-settings"
      actions={
        p.permissions.includes('manage') && (
          <Button size="xs" variant="default" leftSection={<IconSettings size={14} />} onClick={() => setEditing(true)} data-testid="access-settings-edit">
            {t('common:edit')}
          </Button>
        )
      }
    >
      <QueryState query={q} />
      {s && (
        <Stack gap={4}>
          <Text size="sm">
            {t('settings.process')}:{' '}
            {s.process ? (
              s.process.name ? (
                <Anchor component={Link} to={`/processes/${enc(s.process.id)}`} size="sm">
                  {s.process.name}
                </Anchor>
              ) : (
                t('settings.hiddenProcess')
              )
            ) : (
              t('settings.none')
            )}
          </Text>
          <Text size="sm">
            {t('settings.ticketSource')}: {s.ticketSource ?? t('settings.none')}
          </Text>
          <Text size="sm" data-testid="access-settings-interval">
            {t('settings.reviewMonths')}: {s.reviewMonths ? t('settings.months', { count: s.reviewMonths }) : t('settings.noReview')}
          </Text>
          <Text size="xs" c="dimmed">
            {t('settings.help')}
          </Text>
        </Stack>
      )}
      {editing && s && <SettingsForm p={p} settings={s} onClose={() => setEditing(false)} />}
    </Section>
  );
}

function SettingsForm({ p, settings, onClose }: { p: DataProduct; settings: NonNullable<ReturnType<typeof useAccessSettings>['data']>; onClose: () => void }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const invalidate = useInvalidateGovernance();
  const [processId, setProcessId] = useState<string | null>(settings.process?.id ?? null);
  const [ticketSource, setTicketSource] = useState<string | null>(settings.ticketSource);
  const [months, setMonths] = useState<number | ''>(settings.reviewMonths ?? '');
  const [busy, run] = useBusy();
  const processes = useQuery({ queryKey: ['processes', 'options'], queryFn: () => getOptional<{ id: string; name: string }[]>('/processes', []) });
  const sources = useQuery({
    queryKey: ['tickets', 'settings'],
    queryFn: () => getOptional<{ sources: { key: string; label: string }[] }>('/ticket-references/settings', { sources: [] }),
  });
  const save = () =>
    run(async () => {
      await put(`/data-products/${enc(p.id)}/access-settings`, { processId, ticketSource, reviewMonths: months === '' ? null : months });
      invalidate();
      onClose();
    });
  return (
    <FormModal onClose={onClose} title={t('settings.editTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Stack gap="sm">
          <Select
            label={t('settings.process')}
            description={t('settings.processHelp')}
            data={(processes.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
            value={processId}
            onChange={setProcessId}
            clearable
            searchable
          />
          <Select
            label={t('settings.ticketSource')}
            description={t('settings.ticketSourceHelp')}
            data={(sources.data?.sources ?? []).map((x) => ({ value: x.key, label: x.label }))}
            value={ticketSource}
            onChange={setTicketSource}
            clearable
          />
          <NumberInput
            label={t('settings.reviewMonths')}
            description={t('settings.reviewMonthsHelp')}
            min={1}
            max={24}
            value={months}
            onChange={(v) => setMonths(typeof v === 'number' ? v : '')}
            data-testid="access-settings-months"
          />
          <FormButtons busy={busy} testId="access-settings-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

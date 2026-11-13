import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Paper, SegmentedControl, Select, SimpleGrid, Stack, TagsInput, Text, TextInput, Textarea } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCheck, IconKey, IconUsersGroup, IconX } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import {
  DATA_GOVERNANCE_LIMITS,
  DATA_IDENTITY_RE,
  type DataAccessRequest,
  type DataAccessRequestInput,
  type DataAccessRequestStatus,
  type DataPort,
  type DataProduct,
  type Subject,
} from '@sm/shared';
import { getOptional, post } from '../../../api';
import { useMe } from '../../../auth';
import { QueryState, useFieldErrors } from '../../../components/common';
import { DataTable } from '../../../components/DataTable';
import { FormModal } from '../../../components/FormModal';
import { ListPage } from '../../../components/page/ListPage';
import { useSubjectLabel } from '../../../components/SubjectsInput';
import { FormButtons, useBusy } from '../../../components/dataproducts/form';
import { fmtDate, fmtDay } from '../../../format';
import { RefLink } from '../parts';
import { useAccessRequests, useAccessSettings, useInvalidateGovernance, useProductRequests, type RequestScope } from './api';

const enc = encodeURIComponent;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

export function RequestStatusBadge({ r }: { r: Pick<DataAccessRequest, 'status' | 'fourEyes' | 'approvals'> }) {
  const { t } = useTranslation('dataProductGovernance');
  const color: Record<DataAccessRequestStatus, string> = { pending: 'yellow', approved: 'green', refused: 'red', withdrawn: 'gray' };
  return (
    <Badge size="sm" variant="light" color={color[r.status]} tt="none" data-testid={`request-status-${r.status}`}>
      {r.status === 'pending' && r.fourEyes && r.approvals.length ? t('requests.waitingSecond') : t(`requests.statuses.${r.status}`)}
    </Badge>
  );
}

/** Ask for access to an output port (who may see the product): who consumes, the purpose, until when, the identities. */
export function RequestAccessForm({
  p,
  port,
  environments,
  onClose,
  onSaved,
}: {
  p: DataProduct;
  port: DataPort;
  environments: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['dataProductGovernance', 'dataProducts', 'common']);
  const { username } = useMe();
  const [environment, setEnvironment] = useState<string | null>(environments[0] ?? null);
  const [kind, setKind] = useState<'user' | 'team' | 'text'>('user');
  const [subject, setSubject] = useState<string | null>(`user:${username.toLowerCase()}`);
  const [text, setText] = useState('');
  const [purpose, setPurpose] = useState('');
  const [until, setUntil] = useState('');
  const [agreement, setAgreement] = useState('');
  const [identities, setIdentities] = useState<string[]>([]);
  const [busy, run] = useBusy();
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => getOptional<Subject[]>('/subjects', []), enabled: kind === 'team', staleTime: 60_000 });
  const bad = identities.filter((x) => !DATA_IDENTITY_RE.test(x.trim()));
  const v = useFieldErrors({
    environment: !environment && t('common:validation.required'),
    who: ((kind !== 'text' && !subject) || (kind === 'text' && !text.trim())) && t('requests.whoRequired'),
    purpose: !purpose.trim() && t('requests.purposeRequired'),
    until: !!until && !isDate(until) && t('common:validation.invalid'),
    identities: bad.length > 0 && t('actual.identitiesInvalid', { list: bad.join(', ') }),
    agreement: !!agreement.trim() && !/^https?:\/\/\S+$/i.test(agreement.trim()) && t('requests.agreementInvalid'),
  });
  const save = () =>
    run(async () => {
      const body: DataAccessRequestInput = {
        environment: environment!,
        consumer: { kind, subject: kind === 'text' ? null : subject, text: kind === 'text' ? text.trim() : '', refId: null },
        purpose: purpose.trim(),
        until: until || null,
        agreement: agreement.trim() ? { kind: 'url', ref: agreement.trim(), label: '' } : null,
        identities: identities.map((x) => x.trim()),
      };
      await post(`/data-products/${enc(p.id)}/ports/${enc(port.id)}/access-requests`, body);
      onSaved();
    });
  return (
    <FormModal onClose={onClose} size="lg" title={t('requests.newTitle', { port: `${port.name}${port.version ? ` ${port.version}` : ''}`, product: p.name })}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t('requests.help')}
          </Text>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <Select
              label={t('requests.environment')}
              data={environments}
              value={environment}
              onChange={setEnvironment}
              allowDeselect={false}
              required
              error={v.error('environment')}
              data-testid="request-environment"
            />
            <Select
              label={t('requests.kind')}
              data={(['user', 'team', 'text'] as const).map((k) => ({ value: k, label: t(`dataProducts:consumers.kinds.${k}`) }))}
              value={kind}
              onChange={(k) => {
                if (!k) return;
                setKind(k as 'user' | 'team' | 'text');
                setSubject(k === 'user' ? `user:${username.toLowerCase()}` : null);
              }}
              allowDeselect={false}
              data-testid="request-kind"
            />
          </SimpleGrid>
          {kind === 'team' && (
            <Select
              label={t('requests.team')}
              data={(subjects.data ?? []).filter((s) => s.kind === 'team').map((s) => ({ value: s.value, label: s.label }))}
              value={subject}
              onChange={setSubject}
              searchable
              required
              error={v.error('who')}
              data-testid="request-team"
            />
          )}
          {kind === 'text' && (
            <TextInput
              label={t('requests.text')}
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
              required
              error={v.error('who')}
              data-testid="request-text"
            />
          )}
          <Textarea
            label={t('requests.purpose')}
            value={purpose}
            onChange={(e) => setPurpose(e.currentTarget.value)}
            autosize
            minRows={2}
            required
            error={v.error('purpose')}
            data-testid="request-purpose"
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput
              label={t('requests.until')}
              placeholder="2027-12-31"
              value={until}
              onChange={(e) => setUntil(e.currentTarget.value)}
              error={v.error('until')}
              data-testid="request-until"
            />
            <TextInput
              label={t('requests.agreement')}
              placeholder="https://"
              value={agreement}
              onChange={(e) => setAgreement(e.currentTarget.value)}
              error={v.error('agreement')}
            />
          </SimpleGrid>
          <TagsInput
            label={t('actual.identities')}
            description={t('actual.identitiesHelp')}
            value={identities}
            onChange={setIdentities}
            maxTags={DATA_GOVERNANCE_LIMITS.identitiesPerConsumer}
            error={v.error('identities')}
            data-testid="request-identities"
          />
          <FormButtons busy={busy} submit={t('requests.submit')} testId="request-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** Approve (with the platform ticket where the product names a ticket source) or refuse with a reason. */
function DecideForm({ r, approve, onClose, onSaved }: { r: DataAccessRequest; approve: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['dataProductGovernance', 'common']);
  const settings = useAccessSettings(r.product.id ?? '');
  const [comment, setComment] = useState('');
  const [ticket, setTicket] = useState('');
  const [busy, run] = useBusy();
  const v = useFieldErrors({ comment: !approve && !comment.trim() && t('requests.reasonRequired') });
  const save = () =>
    run(async () => {
      await post(`/data-products/access-requests/${enc(r.id)}/decision`, {
        decision: approve ? 'approve' : 'refuse',
        comment: comment.trim(),
        ticket: approve && ticket.trim() ? { externalNumber: ticket.trim() } : null,
      });
      onSaved();
    });
  const last = !r.fourEyes || r.approvals.length > 0;
  return (
    <FormModal onClose={onClose} title={approve ? t('requests.approveTitle') : t('requests.refuseTitle')}>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (v.validate()) void save();
        }}
      >
        <Stack gap="sm">
          {approve && (
            <Alert variant="light" color="blue" p="xs">
              {last ? t('requests.approveHint') : t('requests.approveFirstHint')}
            </Alert>
          )}
          {approve && last && settings.data?.process && <Text size="sm">{t('requests.processHint', { name: settings.data.process.name ?? '–' })}</Text>}
          {approve && last && settings.data?.ticketSource && (
            <TextInput
              label={t('requests.ticket')}
              description={t('requests.ticketHelp')}
              value={ticket}
              onChange={(e) => setTicket(e.currentTarget.value)}
              data-testid="decide-ticket"
            />
          )}
          <Textarea
            label={approve ? t('requests.comment') : t('requests.reason')}
            value={comment}
            onChange={(e) => setComment(e.currentTarget.value)}
            autosize
            minRows={2}
            required={!approve}
            error={v.error('comment')}
            data-testid="decide-comment"
          />
          <FormButtons busy={busy} submit={approve ? t('requests.approve') : t('requests.refuse')} testId="decide-save" />
        </Stack>
      </form>
    </FormModal>
  );
}

/** Requests as a table (cards on phones), with the decisions the reader may take. */
export function RequestList({ rows, showProduct, testId }: { rows: DataAccessRequest[]; showProduct: boolean; testId: string }) {
  const { t } = useTranslation(['dataProductGovernance', 'dataProducts', 'common']);
  const subject = useSubjectLabel();
  const invalidate = useInvalidateGovernance();
  const [deciding, setDeciding] = useState<{ r: DataAccessRequest; approve: boolean } | null>(null);
  const [busy, run] = useBusy();
  const who = (r: DataAccessRequest) =>
    r.consumer.label === null ? t('actual.hiddenConsumer') : r.consumer.subject ? subject(r.consumer.subject) : r.consumer.label;
  const actions = (r: DataAccessRequest) => (
    <Group gap={4} wrap="nowrap">
      {r.mayDecide && (
        <>
          <Button
            size="compact-xs"
            variant="light"
            color="green"
            leftSection={<IconCheck size={12} />}
            onClick={() => setDeciding({ r, approve: true })}
            data-testid="request-approve"
          >
            {t('requests.approve')}
          </Button>
          <Button
            size="compact-xs"
            variant="light"
            color="red"
            leftSection={<IconX size={12} />}
            onClick={() => setDeciding({ r, approve: false })}
            data-testid="request-refuse"
          >
            {t('requests.refuse')}
          </Button>
        </>
      )}
      {r.mayWithdraw && (
        <Button
          size="compact-xs"
          variant="subtle"
          loading={busy}
          onClick={() =>
            void run(async () => {
              await post(`/data-products/access-requests/${enc(r.id)}/withdraw`);
              invalidate();
            })
          }
          data-testid="request-withdraw"
        >
          {t('requests.withdraw')}
        </Button>
      )}
    </Group>
  );
  const portName = (r: DataAccessRequest) => `${r.portName}${r.portVersion ? ` ${r.portVersion}` : ''} · ${r.environment}`;
  return (
    <>
      <DataTable
        testId={testId}
        ariaLabel={t('requests.title')}
        rows={rows}
        rowKey={(r) => r.id}
        columns={[
          ...(showProduct
            ? [{ key: 'product', header: t('requests.product'), cell: (r: DataAccessRequest) => <RefLink r={r.product} base="/data-products" /> }]
            : []),
          { key: 'port', header: t('requests.port'), cell: (r) => <span className="mono">{portName(r)}</span>, sortValue: (r) => r.portName },
          {
            key: 'who',
            header: t('requests.who'),
            cell: (r) => (
              <>
                <Text size="sm">{who(r)}</Text>
                <Text size="xs" c="dimmed">
                  {t('requests.askedBy', { user: r.requester, date: fmtDate(r.createdAt) })}
                </Text>
              </>
            ),
            sortValue: (r) => r.createdAt,
          },
          {
            key: 'purpose',
            header: t('requests.purpose'),
            cell: (r) => (
              <>
                <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {r.purpose}
                </Text>
                {r.until && (
                  <Text size="xs" c="dimmed">
                    {t('actual.until', { date: fmtDay(r.until) })}
                  </Text>
                )}
              </>
            ),
          },
          {
            key: 'status',
            header: t('requests.status'),
            nowrap: true,
            cell: (r) => (
              <Stack gap={2}>
                <RequestStatusBadge r={r} />
                {r.fourEyes && (
                  <Group gap={2} wrap="nowrap">
                    <IconUsersGroup size={12} aria-hidden />
                    <Text size="xs" c="dimmed">
                      {t('requests.fourEyes')}
                    </Text>
                  </Group>
                )}
                {r.decidedBy && (
                  <Text size="xs" c="dimmed">
                    {t('requests.decidedBy', { user: r.decidedBy, date: fmtDate(r.decidedAt) })}
                  </Text>
                )}
                {r.runId && (
                  <Anchor component={Link} to={`/runs/${enc(r.runId)}`} size="xs">
                    {t('requests.run')}
                  </Anchor>
                )}
                {r.ticketId && (
                  <Anchor component={Link} to={`/tickets/${enc(r.ticketId)}`} size="xs">
                    {t('requests.ticketLink')}
                  </Anchor>
                )}
              </Stack>
            ),
            sortValue: (r) => r.status,
          },
          { key: 'actions', header: t('requests.actions'), cell: actions },
        ]}
        card={(r) => (
          <Paper withBorder p="sm" component="article" aria-label={t('requests.cardLabel', { who: who(r) })} data-testid="request-card">
            <Stack gap={6}>
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <Text fw={600} size="sm" style={{ overflowWrap: 'anywhere' }}>
                  {who(r)}
                </Text>
                <RequestStatusBadge r={r} />
              </Group>
              {showProduct && <RefLink r={r.product} base="/data-products" />}
              <Text size="xs" c="dimmed" className="mono">
                {portName(r)}
              </Text>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {r.purpose}
              </Text>
              <Text size="xs" c="dimmed">
                {t('requests.askedBy', { user: r.requester, date: fmtDate(r.createdAt) })}
              </Text>
              {actions(r)}
            </Stack>
          </Paper>
        )}
      />
      {deciding && (
        <DecideForm
          r={deciding.r}
          approve={deciding.approve}
          onClose={() => setDeciding(null)}
          onSaved={() => {
            setDeciding(null);
            invalidate();
          }}
        />
      )}
    </>
  );
}

/** The product's requests (its Access tab). */
export function ProductRequests({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProductGovernance');
  const q = useProductRequests(p.id);
  const rows = q.data?.items ?? [];
  return (
    <Stack gap="xs">
      <QueryState query={q} />
      {q.isSuccess && !rows.length && (
        <Text size="sm" c="dimmed">
          {t('requests.none')}
        </Text>
      )}
      {rows.length > 0 && <RequestList rows={rows} showProduct={false} testId="product-requests" />}
    </Stack>
  );
}

/** Data → Access requests: what waits for my decision, what I asked for, everything I may see. */
export function AccessRequestsPage() {
  const { t } = useTranslation('dataProductGovernance');
  const [scope, setScope] = useState<RequestScope>('decide');
  const q = useAccessRequests(scope, '');
  const rows = q.data?.items ?? [];
  return (
    <ListPage
      title={t('requests.pageTitle')}
      description={t('requests.pageHelp')}
      filters={
        <SegmentedControl
          size="xs"
          value={scope}
          onChange={(v) => setScope(v as RequestScope)}
          data={(['decide', 'mine', 'all'] as const).map((s) => ({ value: s, label: t(`requests.scopes.${s}`) }))}
          aria-label={t('requests.scopeLabel')}
          data-testid="requests-scope"
        />
      }
    >
      <QueryState query={q} />
      {q.isSuccess && !rows.length && (
        <Text size="sm" c="dimmed" data-testid="requests-empty">
          {t(`requests.empty.${scope}`)}
        </Text>
      )}
      {rows.length > 0 && <RequestList rows={rows} showProduct testId="requests-table" />}
    </ListPage>
  );
}

/** _Request access_ on an output port: anyone who may see the product, for an environment the port is bound in. */
export function RequestAccessButton({ p, port, onRequested }: { p: DataProduct; port: DataPort; onRequested?: () => void }) {
  const { t } = useTranslation('dataProductGovernance');
  const [open, setOpen] = useState(false);
  const invalidate = useInvalidateGovernance();
  const environments = port.bindings.map((b) => b.environment).filter(Boolean);
  if (port.direction !== 'output' || port.lifecycle === 'retired' || p.lifecycle === 'retired' || !environments.length) return null;
  return (
    <>
      <Button size="compact-sm" variant="subtle" leftSection={<IconKey size={14} />} onClick={() => setOpen(true)} data-testid="port-request-access">
        {t('requests.ask')}
      </Button>
      {open && (
        <RequestAccessForm
          p={p}
          port={port}
          environments={environments}
          onClose={() => setOpen(false)}
          onSaved={() => {
            setOpen(false);
            invalidate();
            onRequested?.();
          }}
        />
      )}
    </>
  );
}

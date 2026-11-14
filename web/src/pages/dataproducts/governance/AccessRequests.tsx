import { Anchor, Badge, Group, Paper, Stack, Text } from '@mantine/core';
import { Link } from 'react-router-dom';
import { IconUsersGroup } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { DataAccessRequest, DataAccessRequestStatus, DataProduct } from '@sm/shared';
import { QueryState } from '../../../components/common';
import { DataTable } from '../../../components/DataTable';
import { useSubjectLabel } from '../../../components/SubjectsInput';
import { fmtDate, fmtDay } from '../../../format';
import { RefLink, Section } from '../parts';
import { useProductRequests } from './api';

/**
 * Access requests (0.24.0) – retired in 0.25.1 (ADR 0038 part 3): Steward documents access that was decided elsewhere
 * on a consumer registration; it does not run requests and approvals. What was asked until then stays readable here.
 */

const enc = encodeURIComponent;

export function RequestStatusBadge({ r }: { r: Pick<DataAccessRequest, 'status' | 'fourEyes' | 'approvals'> }) {
  const { t } = useTranslation('dataProductGovernance');
  const color: Record<DataAccessRequestStatus, string> = { pending: 'yellow', approved: 'green', refused: 'red', withdrawn: 'gray', converted: 'blue' };
  return (
    <Badge size="sm" variant="light" color={color[r.status]} tt="none" data-testid={`request-status-${r.status}`}>
      {t(`requests.statuses.${r.status}`)}
    </Badge>
  );
}

export function RequestList({ rows, showProduct, testId }: { rows: DataAccessRequest[]; showProduct: boolean; testId: string }) {
  const { t } = useTranslation(['dataProductGovernance', 'dataProducts', 'common']);
  const subject = useSubjectLabel();
  const portName = (r: DataAccessRequest) => `${r.portName}${r.portVersion ? ` ${r.portVersion}` : ''} · ${r.environment}`;
  const who = (r: DataAccessRequest) =>
    r.consumer.label === null ? t('actual.hiddenConsumer') : r.consumer.subject ? subject(r.consumer.subject) : r.consumer.label;
  const decision = (r: DataAccessRequest) => (
    <>
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
      {r.status === 'converted' && (
        <Text size="xs" c="dimmed">
          {t('requests.convertedHint')}
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
    </>
  );
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
                {decision(r)}
              </Stack>
            ),
            sortValue: (r) => r.status,
          },
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
              {r.until && (
                <Text size="xs" c="dimmed">
                  {t('actual.until', { date: fmtDay(r.until) })}
                </Text>
              )}
              <Text size="xs" c="dimmed">
                {t('requests.askedBy', { user: r.requester, date: fmtDate(r.createdAt) })}
              </Text>
              {/* what the table's status column says: four eyes, who decided, the run and the ticket */}
              {decision(r)}
            </Stack>
          </Paper>
        )}
      />
    </>
  );
}

/** The newest page of requests is shown: say so when there are more (the list is not cut off silently). */
function ShownOf({ shown, total }: { shown: number; total: number }) {
  const { t } = useTranslation('common');
  if (total <= shown) return null;
  return (
    <Text size="xs" c="dimmed" mt="xs" data-testid="requests-shown-of">
      {t('table.showingOf', { shown, total })}
    </Text>
  );
}

/**
 * The product's access requests from before 0.25.1 (its Access tab): read-only history – Steward documents access
 * decided elsewhere on the consumer registrations now (ADR 0038 part 3). Shown only while there are some.
 */
export function ProductRequests({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProductGovernance');
  const q = useProductRequests(p.id);
  const rows = q.data?.items ?? [];
  if (!rows.length) return <QueryState query={q} />;
  return (
    <Section title={t('requests.historyTitle')} testId="product-access-requests">
      <Text size="xs" c="dimmed" mb="xs">
        {t('requests.historyHint')}
      </Text>
      <RequestList rows={rows} showProduct={false} testId="product-requests" />
      <ShownOf shown={rows.length} total={q.data?.total ?? 0} />
    </Section>
  );
}

import { Anchor, Group, Stack, Table, Text, Timeline } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconCircleDot } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { DATA_PRODUCT_LIFECYCLES, type AuditEntry, type Backlink, type DataProduct } from '@sm/shared';
import { get } from '../../api';
import { useMe } from '../../auth';
import { ErrorState, QueryState } from '../../components/common';
import { AccessTab } from '../../components/access/AccessTab';
import { TableScroll } from '../../components/TableScroll';
import { useSubjectLabel } from '../../components/SubjectsInput';
import { fmtDate, fmtDay } from '../../format';
import { dpKeys, qs } from './api';
import { Section } from './parts';

/**
 * Who may see and change a product (ADR 0036 part 12): its owning teams – the scope – with the explanation of anyone's
 * rights, Restricted and its shares (the Access tab of ADR 0033), and the product owners (responsibility; named from
 * outside the teams they see and change it). Module roles granted per team follow with ADR 0034 phase 2.
 */
export function ProductAccessTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProducts');
  const subject = useSubjectLabel();
  return (
    <Stack gap="md" maw={880}>
      {/* ADR 0033: owning teams with Why do I have access?, Restricted and the shares (View, Edit, Manage) */}
      <AccessTab kind="data_product" id={p.id} />
      <Section title={t('access.owners')}>
        <Text size="sm">{p.owners.length ? p.owners.map(subject).join(', ') : t('product.noOwner')}</Text>
        <Text size="xs" c="dimmed" mt="xs">
          {t('access.ownersHint')}
        </Text>
      </Section>
      <Section title={t('access.rules')}>
        <TableScroll>
          <Table fz="sm" aria-label={t('access.rules')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('access.who')}</Table.Th>
                <Table.Th scope="col">{t('access.what')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {(['everyone', 'designers', 'owners', 'teams', 'shares'] as const).map((k) => (
                <Table.Tr key={k}>
                  <Table.Td>{t(`access.rows.${k}.who`)}</Table.Td>
                  <Table.Td>{t(`access.rows.${k}.what`)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
        <Text size="xs" c="dimmed" mt="xs">
          {t('access.scopeHint')}
        </Text>
      </Section>
    </Stack>
  );
}

/**
 * Documents, records (change and incident records), ticket references and other entries that link a product or a data
 * object (the link kinds of ADR 0036 part 17). Links are made on those entries; only what the reader may see is listed.
 */
export function LinksTab({ kind, id }: { kind: 'data-product' | 'data-object'; id: string }) {
  const { t } = useTranslation(['dataProducts', 'records']);
  const q = useQuery({ queryKey: dpKeys.links(kind, id), queryFn: () => get<Backlink[]>(`/backlinks?${qs({ kind, id })}`) });
  const rows = q.data ?? [];
  return (
    <Section title={t('links.title')} testId="links">
      <Text size="sm" c="dimmed" mb="sm">
        {kind === 'data-product' ? t('links.helpProduct') : t('links.helpObject')}
      </Text>
      <QueryState query={q} />
      {q.isSuccess && !rows.length && (
        <Text size="sm" c="dimmed">
          {t('links.none')}
        </Text>
      )}
      {rows.length > 0 && (
        <TableScroll>
          <Table fz="sm" aria-label={t('links.title')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th scope="col">{t('links.kind')}</Table.Th>
                <Table.Th scope="col">{t('links.entry')}</Table.Th>
                <Table.Th scope="col">{t('links.note')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((b) => (
                <Table.Tr key={b.linkId}>
                  <Table.Td className="nowrap">{t(`links.kinds.${b.kind}`, { defaultValue: b.kind })}</Table.Td>
                  <Table.Td>
                    <Anchor component={Link} to={b.path} size="sm">
                      {b.label}
                    </Anchor>
                  </Table.Td>
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>{b.note || '–'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </TableScroll>
      )}
    </Section>
  );
}

/**
 * What happened to a product: the dates of its lifecycle, who made and last changed it, and – for who may read the
 * audit log – its entries there (every change of the product, its ports, members, steps and rating is audited).
 */
export function ProductHistoryTab({ p }: { p: DataProduct }) {
  const { t } = useTranslation('dataProducts');
  const { caps } = useMe();
  const audit = useQuery({
    queryKey: dpKeys.history(p.id),
    queryFn: () => get<AuditEntry[]>(`/audit?${qs({ entityType: 'data_product', entityId: p.id, limit: 100 })}`),
    enabled: !!caps.viewAudit,
  });
  const dates = DATA_PRODUCT_LIFECYCLES.filter((l) => p.lifecycleDates[l]);
  return (
    <Stack gap="md">
      <Section title={t('history.lifecycle')} testId="history-lifecycle">
        <Timeline bulletSize={18} lineWidth={2} active={dates.length - 1}>
          <Timeline.Item bullet={<IconCircleDot size={12} />} title={t('history.created')}>
            <Text size="sm" c="dimmed">
              {t('history.by', { user: p.createdBy, date: fmtDate(p.createdAt) })}
            </Text>
          </Timeline.Item>
          {dates.map((l) => (
            <Timeline.Item key={l} bullet={<IconCircleDot size={12} />} title={t(`lifecycle.${l}`)}>
              <Text size="sm" c="dimmed">
                {fmtDay(p.lifecycleDates[l]!)}
                {l === 'deprecated' && p.sunsetDate && ` · ${t('product.sunsetLine', { date: fmtDay(p.sunsetDate) })}`}
              </Text>
            </Timeline.Item>
          ))}
        </Timeline>
        <Text size="xs" c="dimmed" mt="sm">
          {t('history.updated', { user: p.updatedBy, date: fmtDate(p.updatedAt), revision: p.revision })}
        </Text>
      </Section>
      {caps.viewAudit ? (
        <Section
          title={t('history.audit')}
          testId="history-audit"
          actions={
            <Anchor component={Link} to={`/audit?${qs({ type: 'data_product', q: p.name })}`} size="sm">
              {t('history.openAudit')}
            </Anchor>
          }
        >
          {audit.error && <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />}
          {audit.data && !audit.data.length && (
            <Text size="sm" c="dimmed">
              {t('history.noEntries')}
            </Text>
          )}
          {audit.data && audit.data.length > 0 && (
            <TableScroll>
              <Table fz="sm" aria-label={t('history.audit')}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th scope="col">{t('history.when')}</Table.Th>
                    <Table.Th scope="col">{t('history.who')}</Table.Th>
                    <Table.Th scope="col">{t('history.what')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {audit.data.map((e) => (
                    <Table.Tr key={e.seq}>
                      <Table.Td className="nowrap">{fmtDate(e.ts)}</Table.Td>
                      <Table.Td>{e.actor}</Table.Td>
                      <Table.Td style={{ overflowWrap: 'anywhere' }}>
                        <Group gap={4} wrap="wrap">
                          <Text span size="xs" c="dimmed" className="mono">
                            {e.action}
                          </Text>
                          <Text span size="sm">
                            {e.summary}
                          </Text>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </TableScroll>
          )}
        </Section>
      ) : (
        <Text size="sm" c="dimmed">
          {t('history.auditOnlyAuditors')}
        </Text>
      )}
    </Stack>
  );
}

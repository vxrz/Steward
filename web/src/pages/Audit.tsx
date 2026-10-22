import { Fragment, useState } from 'react';
import { Alert, Anchor, Button, Collapse, Group, Menu, Select, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconDownload, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AuditEntry, AuditVerifyResult } from '@sm/shared';
import { get, notifyError } from '../api';
import { JsonView, PageHeader } from '../components/common';
import { fmtDate } from '../format';
import { VerifyReportButton } from '../components/reports/VerifyReportButton';

const CATEGORIES = ['run', 'api', 'task', 'check', 'platform', 'process', 'schedule', 'vault', 'report'] as const;

/** The audit log itself stays English: entries are evidence and must read the same for every auditor (see docs/I18N.md). */
export function AuditPage() {
  const { t } = useTranslation('audit');
  const [q, setQ] = useState('');
  const [debounced] = useDebouncedValue(q, 300);
  const [action, setAction] = useState<string | null>(null);
  const [verify, setVerify] = useState<AuditVerifyResult | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const entries = useInfiniteQuery({
    queryKey: ['audit', debounced, action],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '100' });
      if (debounced) p.set('q', debounced);
      if (action) p.set('action', action);
      if (pageParam) p.set('beforeSeq', String(pageParam));
      return get<AuditEntry[]>(`/audit?${p}`);
    },
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1]!.seq : undefined),
  });
  const rows = entries.data?.pages.flat() ?? [];

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <VerifyReportButton />
            <Button
              size="xs"
              variant="light"
              leftSection={<IconShieldCheck size={14} />}
              onClick={() =>
                get<AuditVerifyResult>('/audit/verify')
                  .then(setVerify)
                  .catch((e) => notifyError(e))
              }
            >
              {t('verify')}
            </Button>
            <Menu>
              <Menu.Target>
                <Button size="xs" variant="default" leftSection={<IconDownload size={14} />}>
                  {t('export')}
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item component="a" href="/api/audit/export?format=csv">
                  CSV
                </Menu.Item>
                <Menu.Item component="a" href="/api/audit/export?format=jsonl">
                  {t('jsonl')}
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />
      {verify && (
        <Alert color={verify.ok ? 'green' : 'red'} mb="md" withCloseButton onClose={() => setVerify(null)} title={verify.ok ? t('intact') : t('broken')}>
          {verify.ok ? t('intactText', { count: verify.checked }) : verify.firstBadSeq ? t('brokenText', { seq: verify.firstBadSeq, message: verify.message }) : verify.message}
        </Alert>
      )}
      <Group mb="md" gap="xs">
        <TextInput
          size="xs"
          placeholder={t('search')}
          aria-label={t('search')}
          leftSection={<IconSearch size={14} />}
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          w={240}
        />
        <Select
          size="xs"
          placeholder={t('allCategories')}
          aria-label={t('category')}
          clearable
          data={CATEGORIES.map((c) => ({ value: `${c}.`, label: t(`categories.${c}`) }))}
          value={action}
          onChange={setAction}
          w={190}
        />
      </Group>
      <div className="table-scroll">
        <Table fz="sm" striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>{t('table.time')}</Table.Th>
              <Table.Th>{t('table.actor')}</Table.Th>
              <Table.Th>{t('table.action')}</Table.Th>
              <Table.Th>{t('table.summary')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((a) => (
              <Fragment key={a.seq}>
                <Table.Tr className="clickable" onClick={() => setOpen(open === a.seq ? null : a.seq)}>
                  <Table.Td>{a.seq}</Table.Td>
                  <Table.Td className="nowrap">{fmtDate(a.ts)}</Table.Td>
                  <Table.Td>{a.actor}</Table.Td>
                  <Table.Td className="mono nowrap">{a.action}</Table.Td>
                  <Table.Td>
                    {a.summary}
                    {a.runId && (
                      <>
                        {' '}
                        <Anchor component={Link} to={`/runs/${a.runId}`} size="xs" onClick={(e) => e.stopPropagation()}>
                          {t('table.run')}
                        </Anchor>
                      </>
                    )}
                  </Table.Td>
                </Table.Tr>
                {open === a.seq && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Collapse in>
                        <Text size="xs" c="dimmed" className="mono" mb={4}>
                          {t('table.hash', { hash: a.hash })}
                        </Text>
                        {a.details != null && <JsonView value={a.details} maxHeight={240} />}
                      </Collapse>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {entries.hasNextPage && (
        <Group justify="center" mt="md">
          <Button variant="default" size="xs" loading={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>
            {t('loadOlder')}
          </Button>
        </Group>
      )}
    </>
  );
}

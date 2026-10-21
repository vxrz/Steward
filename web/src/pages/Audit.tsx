import { useState } from 'react';
import { Alert, Anchor, Button, Collapse, Group, Menu, Select, Table, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { IconDownload, IconSearch, IconShieldCheck } from '@tabler/icons-react';
import type { AuditEntry, AuditVerifyResult } from '@sm/shared';
import { get, notifyError } from '../api';
import { JsonView, PageHeader } from '../components/common';
import { fmtDate } from '../format';

const CATEGORIES = [
  { value: 'run.', label: 'Runs' },
  { value: 'api.', label: 'API calls' },
  { value: 'task.', label: 'Decisions' },
  { value: 'check.', label: 'Checks' },
  { value: 'platform.', label: 'Platforms' },
  { value: 'process.', label: 'Processes' },
  { value: 'schedule.', label: 'Schedules' },
  { value: 'vault.', label: 'Vault' },
];

export function AuditPage() {
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
        title="Audit log"
        description="Append-only record of everything done with this tool. Entries are chained and signed (HMAC) with a key derived from your master passphrase, so edits or deletions are detected."
        actions={
          <>
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
              Verify chain
            </Button>
            <Menu>
              <Menu.Target>
                <Button size="xs" variant="default" leftSection={<IconDownload size={14} />}>
                  Export
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item component="a" href="/api/audit/export?format=csv">
                  CSV
                </Menu.Item>
                <Menu.Item component="a" href="/api/audit/export?format=jsonl">
                  JSON lines (with hashes)
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </>
        }
      />
      {verify && (
        <Alert color={verify.ok ? 'green' : 'red'} mb="md" withCloseButton onClose={() => setVerify(null)} title={verify.ok ? 'Audit chain intact' : 'Audit chain broken'}>
          {verify.message}
        </Alert>
      )}
      <Group mb="md" gap="xs">
        <TextInput size="xs" placeholder="Search" leftSection={<IconSearch size={14} />} value={q} onChange={(e) => setQ(e.currentTarget.value)} w={240} />
        <Select size="xs" placeholder="All categories" clearable data={CATEGORIES} value={action} onChange={setAction} w={170} />
      </Group>
      <div className="table-scroll">
        <Table fz="sm" striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>#</Table.Th>
              <Table.Th>Time</Table.Th>
              <Table.Th>Actor</Table.Th>
              <Table.Th>Action</Table.Th>
              <Table.Th>Summary</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rows.map((a) => (
              <>
                <Table.Tr key={a.seq} className="clickable" onClick={() => setOpen(open === a.seq ? null : a.seq)}>
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
                          run
                        </Anchor>
                      </>
                    )}
                  </Table.Td>
                </Table.Tr>
                {open === a.seq && (
                  <Table.Tr key={`${a.seq}-d`}>
                    <Table.Td colSpan={5}>
                      <Collapse in>
                        <Text size="xs" c="dimmed" className="mono" mb={4}>
                          hash {a.hash}
                        </Text>
                        {a.details != null && <JsonView value={a.details} maxHeight={240} />}
                      </Collapse>
                    </Table.Td>
                  </Table.Tr>
                )}
              </>
            ))}
          </Table.Tbody>
        </Table>
      </div>
      {entries.hasNextPage && (
        <Group justify="center" mt="md">
          <Button variant="default" size="xs" loading={entries.isFetchingNextPage} onClick={() => entries.fetchNextPage()}>
            Load older entries
          </Button>
        </Group>
      )}
    </>
  );
}

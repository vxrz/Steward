import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Autocomplete, Badge, Button, Checkbox, Group, Paper, Select, Stack, Table, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-react';
import { PLATFORM_PERMISSIONS, PROCESS_PERMISSIONS, type AclEntry, type Subject } from '@sm/shared';
import { get } from '../api';

const PERMISSION_HELP: Record<string, string> = {
  view: 'See the process and its runs',
  run: 'Start and schedule runs, make selection decisions',
  edit: 'Change the flow (creates new versions)',
  approve: 'Decide approvals and user tasks',
  manage: 'Change access, archive (processes) · change configuration, credentials and access, write calls in the explorer (platforms)',
  use: 'Use the platform in runs and schedules, read-only explorer calls',
};

export interface AccessEditorProps {
  kind: 'process' | 'platform';
  acl: AclEntry[];
  /** Process owner (user name) – the owner always has all rights. */
  owner?: string | null;
  onSave: (acl: AclEntry[], owner?: string | null) => Promise<void> | void;
  readOnly?: boolean;
}

/** Edit an access list: subjects (users, teams, roles) with permissions. */
export function AccessEditor({ kind, acl, owner, onSave, readOnly }: AccessEditorProps) {
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => get<Subject[]>('/subjects') });
  const perms: readonly string[] = kind === 'process' ? PROCESS_PERMISSIONS : PLATFORM_PERMISSIONS;
  const [rows, setRows] = useState<AclEntry[]>(acl);
  const [own, setOwn] = useState<string | null>(owner ?? null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRows(acl);
    setOwn(owner ?? null);
  }, [acl, owner]);

  const labelOf = useMemo(() => new Map((subjects.data ?? []).map((s) => [s.value, s.label])), [subjects.data]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(acl) || (own ?? null) !== (owner ?? null);
  const kindColor = (s: string) => (s.startsWith('user:') ? 'blue' : s.startsWith('team:') ? 'grape' : 'gray');
  const users = (subjects.data ?? []).filter((s) => s.kind === 'user').map((s) => ({ value: s.value.slice(5), label: s.label }));

  const add = () => {
    const v = draft.trim().toLowerCase();
    if (!/^(user|team|role):.+/.test(v) || rows.some((r) => r.subject === v)) return;
    setRows([...rows, { subject: v, permissions: kind === 'process' ? ['view'] : ['use'] }]);
    setDraft('');
  };

  const toggle = (i: number, p: string, on: boolean) => {
    const copy = rows.map((r) => ({ ...r, permissions: [...r.permissions] }));
    const row = copy[i]!;
    row.permissions = on ? [...new Set([...row.permissions, p])] : row.permissions.filter((x) => x !== p);
    setRows(copy);
  };

  return (
    <Stack>
      <Alert variant="light" color={rows.length ? 'orange' : 'blue'} p="sm">
        <Text size="sm">
          {rows.length ? (
            <>
              <b>Restricted:</b> only the subjects below get the listed rights{kind === 'process' ? ', plus administrators and the owner' : ', plus administrators'}.
              Auditors can always read.
            </>
          ) : (
            <>
              <b>Default role rights apply</b> (e.g. {kind === 'process' ? 'designers edit & run, operators run, approvers decide, viewers read' : 'designers and operators may use it, only administrators manage it'}).
              Add entries to restrict access to specific users, teams or roles.
            </>
          )}
        </Text>
      </Alert>

      {kind === 'process' && (
        <Select
          label="Owner"
          description="The owner always has all rights on this process."
          data={users}
          value={own}
          onChange={setOwn}
          clearable
          searchable
          disabled={readOnly}
          maw={360}
        />
      )}

      <Paper withBorder p="sm">
        <div className="table-scroll">
          <Table fz="sm" verticalSpacing={6}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Who</Table.Th>
                {perms.map((p) => (
                  <Table.Th key={p} ta="center">
                    <Tooltip label={PERMISSION_HELP[p]} multiline w={240} withArrow>
                      <span style={{ cursor: 'help', borderBottom: '1px dotted' }}>{p}</span>
                    </Tooltip>
                  </Table.Th>
                ))}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={perms.length + 2}>
                    <Text size="sm" c="dimmed">
                      No entries – default role rights apply.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {rows.map((r, i) => (
                <Table.Tr key={r.subject}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Badge size="xs" variant="light" color={kindColor(r.subject)}>
                        {r.subject.split(':')[0]}
                      </Badge>
                      <Text size="sm">{labelOf.get(r.subject) ?? r.subject.split(':').slice(1).join(':')}</Text>
                    </Group>
                  </Table.Td>
                  {perms.map((p) => (
                    <Table.Td key={p} ta="center">
                      <Checkbox
                        size="xs"
                        style={{ display: 'inline-block' }}
                        checked={r.permissions.includes(p)}
                        disabled={readOnly}
                        onChange={(e) => toggle(i, p, e.currentTarget.checked)}
                        aria-label={`${r.subject} ${p}`}
                      />
                    </Table.Td>
                  ))}
                  <Table.Td w={40}>
                    {!readOnly && (
                      <ActionIcon variant="subtle" color="red" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">
                        <IconTrash size={14} />
                      </ActionIcon>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </div>
        {!readOnly && (
          <Group mt="sm" gap="xs" align="flex-end">
            <Autocomplete
              size="xs"
              label="Add user, team or role"
              placeholder="user:alice · team:service desk · role:operator"
              data={(subjects.data ?? []).filter((s) => !rows.some((r) => r.subject === s.value)).map((s) => ({ value: s.value, label: s.label }))}
              value={draft}
              onChange={setDraft}
              onOptionSubmit={(v) => setDraft(v)}
              style={{ flex: 1, minWidth: 220 }}
              limit={50}
            />
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={add} disabled={!/^(user|team|role):.+/i.test(draft.trim())}>
              Add
            </Button>
          </Group>
        )}
      </Paper>

      <Stack gap={2}>
        {perms.map((p) => (
          <Text key={p} size="xs" c="dimmed">
            <b>{p}</b> – {PERMISSION_HELP[p]}
          </Text>
        ))}
      </Stack>

      {!readOnly && (
        <Group justify="flex-end">
          {dirty && (
            <Button variant="default" onClick={() => (setRows(acl), setOwn(owner ?? null))}>
              Reset
            </Button>
          )}
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            disabled={!dirty}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(rows, kind === 'process' ? own : undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save access
          </Button>
        </Group>
      )}
    </Stack>
  );
}

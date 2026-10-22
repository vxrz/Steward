import { useEffect, useMemo, useState } from 'react';
import { ActionIcon, Alert, Autocomplete, Badge, Button, Checkbox, Group, Paper, Select, Stack, Table, Text, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { IconDeviceFloppy, IconPlus, IconTrash } from '@tabler/icons-react';
import { Trans, useTranslation } from 'react-i18next';
import { MONITOR_PERMISSIONS, PLATFORM_PERMISSIONS, PROCESS_PERMISSIONS, type AclEntry, type Subject } from '@sm/shared';
import { get } from '../api';
import i18n from '../i18n';

type Perm = 'view' | 'run' | 'edit' | 'approve' | 'manage' | 'use' | 'acknowledge';

/** Translated label of a subject from /subjects (users keep the server label "Name (login)"). */
export function subjectOptionLabel(s: Subject): string {
  if (s.kind === 'team') return i18n.t('common:subjects.team', { name: s.name ?? s.value.slice(5) });
  if (s.kind === 'role') {
    const role = s.name ?? s.value.slice(5);
    return i18n.t('access:everyoneWithRole', { role: i18n.t(`common:roles.${role}` as 'common:roles.admin', { defaultValue: role }) });
  }
  return s.label;
}

export interface AccessEditorProps {
  kind: 'process' | 'platform' | 'monitor';
  acl: AclEntry[];
  /** Process owner (user name) – the owner always has all rights. */
  owner?: string | null;
  onSave: (acl: AclEntry[], owner?: string | null) => Promise<void> | void;
  readOnly?: boolean;
}

/** Edit an access list: subjects (users, teams, roles) with permissions. */
export function AccessEditor({ kind, acl, owner, onSave, readOnly }: AccessEditorProps) {
  const { t } = useTranslation(['access', 'common']);
  const subjects = useQuery({ queryKey: ['subjects'], queryFn: () => get<Subject[]>('/subjects') });
  const perms: readonly string[] = kind === 'process' ? PROCESS_PERMISSIONS : kind === 'monitor' ? MONITOR_PERMISSIONS : PLATFORM_PERMISSIONS;
  const owned = kind !== 'platform';
  const [rows, setRows] = useState<AclEntry[]>(acl);
  const [own, setOwn] = useState<string | null>(owner ?? null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setRows(acl);
    setOwn(owner ?? null);
  }, [acl, owner]);

  // `t`: recompute when the language changes (subjectOptionLabel translates with the global i18n instance)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const labelOf = useMemo(() => new Map((subjects.data ?? []).map((s) => [s.value, subjectOptionLabel(s)])), [subjects.data, t]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(acl) || (own ?? null) !== (owner ?? null);
  const kindColor = (s: string) => (s.startsWith('user:') ? 'blue' : s.startsWith('team:') ? 'grape' : 'gray');
  const users = (subjects.data ?? []).filter((s) => s.kind === 'user').map((s) => ({ value: s.value.slice(5), label: s.label }));

  const add = () => {
    const v = draft.trim().toLowerCase();
    if (!/^(user|team|role):.+/.test(v) || rows.some((r) => r.subject === v)) return;
    setRows([...rows, { subject: v, permissions: kind === 'platform' ? ['use'] : ['view'] }]);
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
            <Trans t={t} i18nKey={kind === 'process' ? 'restrictedProcess' : kind === 'monitor' ? 'restrictedMonitor' : 'restrictedPlatform'} components={{ b: <b /> }} />
          ) : (
            <Trans t={t} i18nKey={kind === 'process' ? 'defaultsProcess' : kind === 'monitor' ? 'defaultsMonitor' : 'defaultsPlatform'} components={{ b: <b /> }} />
          )}
        </Text>
      </Alert>

      {owned && (
        <Select
          label={t('owner')}
          description={kind === 'monitor' ? t('ownerHintMonitor') : t('ownerHint')}
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
                <Table.Th>{t('who')}</Table.Th>
                {perms.map((p) => (
                  <Table.Th key={p} ta="center">
                    <Tooltip label={t(`help.${p as Perm}`)} multiline w={240} withArrow>
                      <span style={{ cursor: 'help', borderBottom: '1px dotted' }}>{t(`common:permissions.${p as Perm}`)}</span>
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
                      {t('noEntries')}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {rows.map((r, i) => (
                <Table.Tr key={r.subject}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Badge size="xs" variant="light" color={kindColor(r.subject)}>
                        {t(`kinds.${r.subject.split(':')[0] as 'user' | 'team' | 'role'}`, { defaultValue: r.subject.split(':')[0] })}
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
                        aria-label={`${labelOf.get(r.subject) ?? r.subject}: ${t(`common:permissions.${p as Perm}`)}`}
                      />
                    </Table.Td>
                  ))}
                  <Table.Td w={40}>
                    {!readOnly && (
                      <ActionIcon variant="subtle" color="red" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label={t('common:remove')}>
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
              label={t('addLabel')}
              placeholder={t('addPlaceholder')}
              data={(subjects.data ?? []).filter((s) => !rows.some((r) => r.subject === s.value)).map((s) => ({ value: s.value, label: subjectOptionLabel(s) }))}
              value={draft}
              onChange={setDraft}
              onOptionSubmit={(v) => setDraft(v)}
              style={{ flex: 1, minWidth: 220 }}
              limit={50}
            />
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={add} disabled={!/^(user|team|role):.+/i.test(draft.trim())}>
              {t('common:add')}
            </Button>
          </Group>
        )}
      </Paper>

      <Stack gap={2}>
        {perms.map((p) => (
          <Text key={p} size="xs" c="dimmed">
            <b>{t(`common:permissions.${p as Perm}`)}</b> – {t(`help.${p as Perm}`)}
          </Text>
        ))}
      </Stack>

      {!readOnly && (
        <Group justify="flex-end">
          {dirty && (
            <Button variant="default" onClick={() => (setRows(acl), setOwn(owner ?? null))}>
              {t('reset')}
            </Button>
          )}
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            disabled={!dirty}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(rows, owned ? own : undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('save')}
          </Button>
        </Group>
      )}
    </Stack>
  );
}

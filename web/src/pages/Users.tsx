import { useState } from 'react';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Code,
  CopyButton,
  Group,
  Modal,
  MultiSelect,
  PasswordInput,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
} from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconCheck, IconCopy, IconEdit, IconKey, IconPlus, IconTrash, IconUsersGroup } from '@tabler/icons-react';
import { ROLES, ROLE_INFO, type Role, type Team, type UserInfo } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { PageHeader } from '../components/common';
import { fmtRelative } from '../format';
import { useMe } from '../auth';
import { SsoSection, useSsoProviders } from '../components/sso/SsoSection';

const ROLE_COLORS: Record<Role, string> = {
  admin: 'red',
  designer: 'grape',
  operator: 'blue',
  approver: 'teal',
  auditor: 'orange',
  viewer: 'gray',
};

const roleOptions = ROLES.map((r) => ({ value: r, label: `${r} – ${ROLE_INFO[r]}` }));

export function RoleBadges({ roles }: { roles: Role[] }) {
  return (
    <Group gap={4}>
      {roles.length === 0 && (
        <Text size="xs" c="dimmed">
          no roles
        </Text>
      )}
      {roles.map((r) => (
        <Badge key={r} size="xs" variant="light" color={ROLE_COLORS[r]}>
          {r}
        </Badge>
      ))}
    </Group>
  );
}

function TempPassword({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  return (
    <Modal opened onClose={onClose} title="Temporary password">
      <Stack>
        <Text size="sm">
          Give this password to <b>{username}</b> through a secure channel. It is shown only once; the user has to choose a new password at
          the first sign-in.
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Code fz="md" style={{ flex: 1 }}>
            {password}
          </Code>
          <CopyButton value={password}>
            {({ copied, copy }) => (
              <ActionIcon variant="light" onClick={copy} aria-label="Copy">
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </ActionIcon>
            )}
          </CopyButton>
        </Group>
        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function UsersPage() {
  const qc = useQueryClient();
  const { username: myName } = useMe();
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<UserInfo[]>('/users') });
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams') });
  const [editing, setEditing] = useState<UserInfo | 'new' | null>(null);
  const [teamEdit, setTeamEdit] = useState<Team | 'new' | null>(null);
  const [temp, setTemp] = useState<{ username: string; password: string } | null>(null);
  const sso = useSsoProviders();
  const ssoName = (source: string) => sso.data?.find((p) => p.id === source)?.displayName ?? source;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['teams'] });
    qc.invalidateQueries({ queryKey: ['subjects'] });
  };

  const setActive = async (u: UserInfo, active: boolean) => {
    try {
      await put(`/users/${u.id}`, { active });
      refresh();
    } catch (e) {
      notifyError(e);
    }
  };

  const reset = async (u: UserInfo) => {
    if (!confirm(`Reset the password of ${u.username}? Their sessions are signed out.`)) return;
    try {
      const r = await post<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`);
      setTemp({ username: u.username, password: r.temporaryPassword });
    } catch (e) {
      notifyError(e);
    }
  };

  return (
    <>
      <PageHeader
        title="Users & teams"
        description="Who can sign in, their roles and teams. Roles give default rights everywhere; access lists on processes and platforms can narrow them down."
        actions={
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            Add user
          </Button>
        }
      />
      <Stack>
        <Card withBorder p={0}>
          <div className="table-scroll">
            <Table highlightOnHover fz="sm" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>User</Table.Th>
                  <Table.Th>Roles</Table.Th>
                  <Table.Th>Teams</Table.Th>
                  <Table.Th>Last sign-in</Table.Th>
                  <Table.Th>Active</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {users.data?.map((u) => (
                  <Table.Tr key={u.id} data-inactive={!u.active || undefined}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" fw={500}>
                          {u.displayName}
                        </Text>
                        {u.authSource && u.authSource !== 'local' && (
                          <Tooltip label={`Signs in with ${ssoName(u.authSource)}`}>
                            <Badge size="xs" variant="light" color="blue">
                              SSO · {ssoName(u.authSource)}
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        {u.username}
                        {u.email ? ` · ${u.email}` : ''}
                        {u.mustChangePassword ? ' · must change password' : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <RoleBadges roles={u.roles} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{u.teams.join(', ') || '–'}</Text>
                    </Table.Td>
                    <Table.Td className="nowrap">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : 'never'}</Table.Td>
                    <Table.Td>
                      <Switch
                        size="xs"
                        checked={u.active}
                        disabled={u.username === myName}
                        onChange={(e) => setActive(u, e.currentTarget.checked)}
                        aria-label="Active"
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap" justify="flex-end">
                        <Tooltip label="Edit">
                          <ActionIcon variant="subtle" onClick={() => setEditing(u)} aria-label="Edit">
                            <IconEdit size={16} />
                          </ActionIcon>
                        </Tooltip>
                        {(!u.authSource || u.authSource === 'local') && (
                          <Tooltip label="Reset password">
                            <ActionIcon variant="subtle" onClick={() => reset(u)} aria-label="Reset password">
                              <IconKey size={16} />
                            </ActionIcon>
                          </Tooltip>
                        )}
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </div>
        </Card>

        <Group justify="space-between" mt="md">
          <Title order={4}>Teams</Title>
          <Button size="xs" variant="light" leftSection={<IconUsersGroup size={14} />} onClick={() => setTeamEdit('new')}>
            New team
          </Button>
        </Group>
        {teams.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            No teams yet. Teams group users so that access lists and task assignments can refer to them (e.g. team:service desk).
          </Text>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {teams.data?.map((t) => (
            <Card key={t.id} withBorder padding="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600}>{t.name}</Text>
                  {t.description && (
                    <Text size="xs" c="dimmed">
                      {t.description}
                    </Text>
                  )}
                </div>
                <Group gap={2} wrap="nowrap">
                  <ActionIcon variant="subtle" onClick={() => setTeamEdit(t)} aria-label={`Edit team ${t.name}`}>
                    <IconEdit size={16} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={`Delete team ${t.name}`}
                    onClick={async () => {
                      if (!confirm(`Delete team "${t.name}"? Access entries that name it stop matching anyone.`)) return;
                      await del(`/teams/${t.id}`).catch(notifyError);
                      refresh();
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
              <Group gap={4} mt="xs">
                {t.members.length === 0 && (
                  <Text size="xs" c="dimmed">
                    no members
                  </Text>
                )}
                {t.members.map((m) => (
                  <Badge key={m} size="xs" variant="outline" color="gray">
                    {m}
                  </Badge>
                ))}
              </Group>
            </Card>
          ))}
        </SimpleGrid>

        <SsoSection />

        <Card withBorder mt="md">
          <Title order={5} mb="xs">
            Roles
          </Title>
          <Stack gap={4}>
            {ROLES.map((r) => (
              <Group key={r} gap="xs" wrap="nowrap" align="flex-start">
                <Badge size="sm" variant="light" color={ROLE_COLORS[r]} w={90}>
                  {r}
                </Badge>
                <Text size="sm">{ROLE_INFO[r]}</Text>
              </Group>
            ))}
          </Stack>
          <Text size="xs" c="dimmed" mt="sm">
            Roles are defaults. A process or platform with an access list only grants the rights listed there (plus administrators and,
            for processes, the owner). Approval steps can additionally be assigned to specific users, teams or roles and require a second
            person (four-eyes principle).
          </Text>
        </Card>
      </Stack>

      {editing && (
        <UserModal
          user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(tempPw, username) => {
            refresh();
            setEditing(null);
            if (tempPw) setTemp({ username, password: tempPw });
          }}
        />
      )}
      {teamEdit && (
        <TeamModal
          team={teamEdit === 'new' ? null : teamEdit}
          users={users.data ?? []}
          onClose={() => setTeamEdit(null)}
          onSaved={() => {
            refresh();
            setTeamEdit(null);
          }}
        />
      )}
      {temp && <TempPassword username={temp.username} password={temp.password} onClose={() => setTemp(null)} />}
    </>
  );
}

function UserModal({ user, onClose, onSaved }: { user: UserInfo | null; onClose: () => void; onSaved: (tempPw: string | undefined, username: string) => void }) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [roles, setRoles] = useState<string[]>(user?.roles ?? ['operator']);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      if (user) {
        await put(`/users/${user.id}`, { displayName, email: email || undefined, roles });
        notifyOk(`${user.username} updated`);
        onSaved(undefined, user.username);
      } else {
        const r = await post<{ user: UserInfo; temporaryPassword?: string }>('/users', {
          username: username.trim(),
          displayName: displayName.trim() || undefined,
          email: email.trim() || undefined,
          roles,
          password: password || undefined,
        });
        notifyOk(`${r.user.username} created`);
        onSaved(r.temporaryPassword, r.user.username);
      }
    } catch (e) {
      notifyError(e, 'Not saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={user ? `Edit ${user.username}` : 'Add user'}>
      <Stack>
        <TextInput label="User name" required disabled={!!user} value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        <TextInput label="Display name" value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
        <TextInput label="E-mail" value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        <MultiSelect label="Roles" data={roleOptions} value={roles} onChange={setRoles} comboboxProps={{ withinPortal: true }} />
        {!user && (
          <Text size="xs" c="dimmed">
            Single sign-on users are created automatically at their first sign-in (if the provider allows it). You can also create them here in
            advance with exactly their SSO user name (e.g. the e-mail / UPN) to assign roles – the account is linked at the first sign-in.
          </Text>
        )}
        {!user && (
          <PasswordInput
            label="Initial password (optional)"
            description="Leave empty to generate a temporary password. The user must change it at the first sign-in either way."
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="new-password"
          />
        )}
        {roles.includes('admin') && (
          <Alert color="red" variant="light" p="xs">
            Administrators can manage users, platforms and credentials and see everything.
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!username.trim()}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TeamModal({ team, users, onClose, onSaved }: { team: Team | null; users: UserInfo[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(team?.name ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [members, setMembers] = useState<string[]>(team?.members ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = { name: name.trim(), description, members };
      if (team) await put(`/teams/${team.id}`, body);
      else await post('/teams', body);
      notifyOk(`Team "${name}" saved`);
      onSaved();
    } catch (e) {
      notifyError(e, 'Team not saved');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={team ? `Edit team ${team.name}` : 'New team'}>
      <Stack>
        <TextInput label="Name" required value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Textarea label="Description" autosize minRows={1} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <MultiSelect
          label="Members"
          searchable
          data={users.map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))}
          value={members}
          onChange={setMembers}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={name.trim().length < 2}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

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
import { Trans, useTranslation } from 'react-i18next';
import { ROLES, ROLE_INFO, type Role, type Team, type UserInfo } from '@sm/shared';
import { del, get, notifyError, notifyOk, post, put } from '../api';
import { PageHeader } from '../components/common';
import { fmtRelative } from '../format';
import { useMe } from '../auth';
import { SsoSection, useSsoProviders } from '../components/sso/SsoSection';
import i18n from '../i18n';

const ROLE_COLORS: Record<Role, string> = {
  admin: 'red',
  designer: 'grape',
  operator: 'blue',
  approver: 'teal',
  auditor: 'orange',
  viewer: 'gray',
};

/** Role name and description in the UI language (descriptions default to the English text in shared/). */
export const roleLabel = (r: Role): string => i18n.t(`common:roles.${r}`);
export const roleInfo = (r: Role): string => i18n.t(`common:roleInfo.${r}`, { defaultValue: ROLE_INFO[r] });
const roleOptions = () => ROLES.map((r) => ({ value: r, label: `${roleLabel(r)} – ${roleInfo(r)}` }));

export function RoleBadges({ roles }: { roles: Role[] }) {
  const { t } = useTranslation('users');
  return (
    <Group gap={4}>
      {roles.length === 0 && (
        <Text size="xs" c="dimmed">
          {t('noRoles')}
        </Text>
      )}
      {roles.map((r) => (
        <Badge key={r} size="xs" variant="light" color={ROLE_COLORS[r]}>
          {roleLabel(r)}
        </Badge>
      ))}
    </Group>
  );
}

function TempPassword({ username, password, onClose }: { username: string; password: string; onClose: () => void }) {
  const { t } = useTranslation(['users', 'common']);
  return (
    <Modal opened onClose={onClose} title={t('temp.title')}>
      <Stack>
        <Text size="sm">
          <Trans t={t} i18nKey="temp.text" values={{ user: username }} components={{ b: <b /> }} />
        </Text>
        <Group gap="xs" wrap="nowrap">
          <Code fz="md" style={{ flex: 1 }}>
            {password}
          </Code>
          <CopyButton value={password}>
            {({ copied, copy }) => (
              <ActionIcon variant="light" onClick={copy} aria-label={t('common:copy')}>
                {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
              </ActionIcon>
            )}
          </CopyButton>
        </Group>
        <Group justify="flex-end">
          <Button onClick={onClose}>{t('temp.done')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function UsersPage() {
  const { t } = useTranslation(['users', 'common']);
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
    if (!confirm(t('resetConfirm', { user: u.username }))) return;
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
        title={t('title')}
        description={t('description')}
        actions={
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            {t('addUser')}
          </Button>
        }
      />
      <Stack>
        <Card withBorder p={0}>
          <div className="table-scroll">
            <Table highlightOnHover fz="sm" verticalSpacing={6}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('table.user')}</Table.Th>
                  <Table.Th>{t('table.roles')}</Table.Th>
                  <Table.Th>{t('table.teams')}</Table.Th>
                  <Table.Th>{t('table.lastSignIn')}</Table.Th>
                  <Table.Th>{t('table.active')}</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {users.data?.map((u) => (
                  <Table.Tr key={u.id} style={{ opacity: u.active ? 1 : 0.55 }}>
                    <Table.Td>
                      <Group gap={6} wrap="nowrap">
                        <Text size="sm" fw={500}>
                          {u.displayName}
                        </Text>
                        {u.authSource && u.authSource !== 'local' && (
                          <Tooltip label={t('table.signsInWith', { provider: ssoName(u.authSource) })}>
                            <Badge size="xs" variant="light" color="blue">
                              SSO · {ssoName(u.authSource)}
                            </Badge>
                          </Tooltip>
                        )}
                      </Group>
                      <Text size="xs" c="dimmed">
                        {u.username}
                        {u.email ? ` · ${u.email}` : ''}
                        {u.mustChangePassword ? ` · ${t('table.mustChange')}` : ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <RoleBadges roles={u.roles} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs">{u.teams.join(', ') || '–'}</Text>
                    </Table.Td>
                    <Table.Td className="nowrap">{u.lastLoginAt ? fmtRelative(u.lastLoginAt) : t('table.never')}</Table.Td>
                    <Table.Td>
                      <Switch
                        size="xs"
                        checked={u.active}
                        disabled={u.username === myName}
                        onChange={(e) => setActive(u, e.currentTarget.checked)}
                        aria-label={t('table.active')}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={2} wrap="nowrap" justify="flex-end">
                        <Tooltip label={t('common:edit')}>
                          <ActionIcon variant="subtle" onClick={() => setEditing(u)} aria-label={t('common:edit')}>
                            <IconEdit size={16} />
                          </ActionIcon>
                        </Tooltip>
                        {(!u.authSource || u.authSource === 'local') && (
                          <Tooltip label={t('table.resetPassword')}>
                            <ActionIcon variant="subtle" onClick={() => reset(u)} aria-label={t('table.resetPassword')}>
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
          <Title order={4}>{t('teams.title')}</Title>
          <Button size="xs" variant="light" leftSection={<IconUsersGroup size={14} />} onClick={() => setTeamEdit('new')}>
            {t('teams.new')}
          </Button>
        </Group>
        {teams.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            {t('teams.none')}
          </Text>
        )}
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }}>
          {teams.data?.map((team) => (
            <Card key={team.id} withBorder padding="sm">
              <Group justify="space-between" wrap="nowrap" align="flex-start">
                <div style={{ minWidth: 0 }}>
                  <Text fw={600}>{team.name}</Text>
                  {team.description && (
                    <Text size="xs" c="dimmed">
                      {team.description}
                    </Text>
                  )}
                </div>
                <Group gap={2} wrap="nowrap">
                  <ActionIcon variant="subtle" onClick={() => setTeamEdit(team)} aria-label={t('teams.edit')}>
                    <IconEdit size={16} />
                  </ActionIcon>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    aria-label={t('teams.delete')}
                    onClick={async () => {
                      if (!confirm(t('teams.deleteConfirm', { name: team.name }))) return;
                      await del(`/teams/${team.id}`).catch(notifyError);
                      refresh();
                    }}
                  >
                    <IconTrash size={16} />
                  </ActionIcon>
                </Group>
              </Group>
              <Group gap={4} mt="xs">
                {team.members.length === 0 && (
                  <Text size="xs" c="dimmed">
                    {t('teams.noMembers')}
                  </Text>
                )}
                {team.members.map((m) => (
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
            {t('roles.title')}
          </Title>
          <Stack gap={4}>
            {ROLES.map((r) => (
              <Group key={r} gap="xs" wrap="nowrap" align="flex-start">
                <Badge size="sm" variant="light" color={ROLE_COLORS[r]} w={110} style={{ flexShrink: 0 }}>
                  {roleLabel(r)}
                </Badge>
                <Text size="sm">{roleInfo(r)}</Text>
              </Group>
            ))}
          </Stack>
          <Text size="xs" c="dimmed" mt="sm">
            {t('roles.hint')}
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
  const { t } = useTranslation(['users', 'common']);
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
        notifyOk(t('userModal.updated', { user: user.username }));
        onSaved(undefined, user.username);
      } else {
        const r = await post<{ user: UserInfo; temporaryPassword?: string }>('/users', {
          username: username.trim(),
          displayName: displayName.trim() || undefined,
          email: email.trim() || undefined,
          roles,
          password: password || undefined,
        });
        notifyOk(t('userModal.created', { user: r.user.username }));
        onSaved(r.temporaryPassword, r.user.username);
      }
    } catch (e) {
      notifyError(e, t('userModal.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened onClose={onClose} title={user ? t('userModal.edit', { user: user.username }) : t('addUser')}>
      <Stack>
        <TextInput label={t('userModal.username')} required disabled={!!user} value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
        <TextInput label={t('userModal.displayName')} value={displayName} onChange={(e) => setDisplayName(e.currentTarget.value)} />
        <TextInput label={t('userModal.email')} value={email} onChange={(e) => setEmail(e.currentTarget.value)} />
        <MultiSelect label={t('table.roles')} data={roleOptions()} value={roles} onChange={setRoles} comboboxProps={{ withinPortal: true }} />
        {!user && (
          <Text size="xs" c="dimmed">
            {t('userModal.ssoHint')}
          </Text>
        )}
        {!user && (
          <PasswordInput
            label={t('userModal.initialPassword')}
            description={t('userModal.initialPasswordHint')}
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            autoComplete="new-password"
          />
        )}
        {roles.includes('admin') && (
          <Alert color="red" variant="light" p="xs">
            {t('userModal.adminWarning')}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={!username.trim()}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TeamModal({ team, users, onClose, onSaved }: { team: Team | null; users: UserInfo[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation(['users', 'common']);
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
      notifyOk(t('teamModal.saved', { name }));
      onSaved();
    } catch (e) {
      notifyError(e, t('teamModal.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened onClose={onClose} title={team ? t('teamModal.edit', { name: team.name }) : t('teams.new')}>
      <Stack>
        <TextInput label={t('common:name')} required value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <Textarea label={t('teamModal.description')} autosize minRows={1} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        <MultiSelect
          label={t('teamModal.members')}
          searchable
          data={users.map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))}
          value={members}
          onChange={setMembers}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button onClick={save} loading={busy} disabled={name.trim().length < 2}>
            {t('common:save')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

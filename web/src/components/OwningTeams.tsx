import { useEffect, useState } from 'react';
import { Badge, Button, Group, List, Modal, MultiSelect, Paper, SegmentedControl, Select, Stack, Table, Text } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { IconHelpCircle, IconUsersGroup } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import type { AccessExplanation, AccessReason, OwnedKind, Team, UserInfo } from '@sm/shared';
import { get, notifyError, notifyOk, post, put } from '../api';
import { useMe } from '../auth';

interface OwningTeamsResponse {
  teams: { id: string; name: string }[];
  canChange: boolean;
}

/**
 * Owning teams of a process or platform (#131): members of these teams have their roles in the team on it; everyone
 * else only what the access list below gives. Administrators change them; everybody can see why they have access.
 */
export function OwningTeams({ kind, id, mt }: { kind: OwnedKind; id: string; mt?: 'md' }) {
  const { t } = useTranslation(['access', 'common']);
  const qc = useQueryClient();
  const key = ['owning-teams', kind, id];
  const q = useQuery({ queryKey: key, queryFn: () => get<OwningTeamsResponse>(`/owning-teams/${kind}/${id}`) });
  const canChange = !!q.data?.canChange;
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams'), enabled: canChange });
  const [value, setValue] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState(false);
  useEffect(() => setValue((q.data?.teams ?? []).map((x) => x.id)), [q.data]);
  const current = (q.data?.teams ?? []).map((x) => x.id);
  const dirty = JSON.stringify([...value].sort()) !== JSON.stringify([...current].sort());

  const save = async () => {
    setBusy(true);
    try {
      const saved = await put<OwningTeamsResponse>(`/owning-teams/${kind}/${id}`, { teamIds: value });
      qc.setQueryData(key, saved);
      qc.invalidateQueries({ queryKey: [kind] });
      notifyOk(t('owning.saved'));
    } catch (e) {
      notifyError(e, t('owning.notSaved'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder p="md" mb="md" mt={mt}>
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Group gap={6}>
            <IconUsersGroup size={18} aria-hidden />
            <Text fw={600}>{t('owning.title')}</Text>
          </Group>
          <Button size="xs" variant="subtle" leftSection={<IconHelpCircle size={14} />} onClick={() => setExplain(true)}>
            {t('owning.why')}
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          {current.length ? t(`owning.hintOwned.${kind}`) : t(`owning.hintNone.${kind}`)}
        </Text>
        {canChange && kind === 'service' && <ServiceBulkTeams serviceId={id} onDone={() => qc.invalidateQueries({ queryKey: key })} />}
        {canChange ? (
          <Group align="flex-end" wrap="wrap">
            <MultiSelect
              label={t('owning.label')}
              placeholder={value.length ? undefined : t('owning.none')}
              data={(teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={value}
              onChange={setValue}
              searchable
              clearable
              style={{ flex: 1, minWidth: 220 }}
            />
            <Button onClick={save} loading={busy} disabled={!dirty} aria-label={t('owning.save')}>
              {t('common:save')}
            </Button>
          </Group>
        ) : (
          <Group gap={4}>
            {current.length ? (
              (q.data?.teams ?? []).map((x) => (
                <Badge key={x.id} color="grape" variant="light">
                  {x.name}
                </Badge>
              ))
            ) : (
              <Text size="sm">{t('owning.none')}</Text>
            )}
          </Group>
        )}
      </Stack>
      {explain && <ExplainModal kind={kind} id={id} onClose={() => setExplain(false)} />}
    </Paper>
  );
}

function ExplainModal({ kind, id, onClose }: { kind: OwnedKind; id: string; onClose: () => void }) {
  const { t } = useTranslation(['access', 'common']);
  const { username, isAdmin, caps } = useMe();
  // others' rights: administrators and auditors (the server checks it as well)
  const mayAskForOthers = isAdmin || caps.viewAudit;
  const [user, setUser] = useState(username);
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<UserInfo[]>('/users'), enabled: isAdmin });
  const q = useQuery({
    queryKey: ['access-explain', kind, id, user],
    queryFn: () => get<AccessExplanation>(`/access/explain?kind=${kind}&id=${encodeURIComponent(id)}&user=${encodeURIComponent(user)}`),
  });
  return (
    <Modal opened onClose={onClose} title={t('owning.whyTitle')}>
      <Stack gap="sm">
        {mayAskForOthers && isAdmin && (
          <Select
            label={t('owning.forUser')}
            searchable
            data={(users.data ?? []).map((u) => ({ value: u.username, label: `${u.displayName} (${u.username})` }))}
            value={user}
            onChange={(v) => v && setUser(v)}
            allowDeselect={false}
          />
        )}
        {q.data && (
          <>
            <Text size="sm">
              {q.data.permissions.length
                ? t('owning.rights', { user: q.data.user, rights: q.data.permissions.map((p) => t(`common:permissions.${p}`, { defaultValue: p })).join(', ') })
                : t('owning.noRights', { user: q.data.user })}
            </Text>
            {q.data.reasons.length > 0 && (
              <List size="sm" spacing={4}>
                {q.data.reasons.map((r, i) => (
                  <List.Item key={i}>{reasonText(t, r)}</List.Item>
                ))}
              </List>
            )}
          </>
        )}
        {q.error ? (
          <Text size="sm" c="red">
            {t('owning.explainFailed')}
          </Text>
        ) : null}
      </Stack>
    </Modal>
  );
}

function reasonText(t: ReturnType<typeof useTranslation<['access', 'common']>>['t'], r: AccessReason): string {
  const rights = r.permissions.map((p) => t(`common:permissions.${p}`, { defaultValue: p })).join(', ');
  const role = r.role ? t(`common:roles.${r.role}`, { defaultValue: r.role }) : '';
  switch (r.source) {
    case 'admin':
      return t('owning.reason.admin', { rights });
    case 'owner':
      return t('owning.reason.owner', { rights });
    case 'auditor':
      return t('owning.reason.auditor', { rights });
    case 'instanceRole':
      return t('owning.reason.instanceRole', { role, rights });
    case 'teamRole':
      return t('owning.reason.teamRole', { role, team: r.team, rights });
    default:
      return t('owning.reason.accessList', { subject: r.subject, rights });
  }
}

interface BulkResult {
  applied: boolean;
  changed: number;
  resources: { kind: OwnedKind; id: string; name: string; before: string[]; after: string[]; changed: boolean; gains: string[]; loses: string[] }[];
}

/** Owning teams for a service and everything that belongs to it, with a preview of who gains or loses visibility. */
function ServiceBulkTeams({ serviceId, onDone }: { serviceId: string; onDone: () => void }) {
  const { t } = useTranslation(['access', 'common']);
  const [open, setOpen] = useState(false);
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'set' | 'add' | 'remove'>('add');
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const teams = useQuery({ queryKey: ['teams'], queryFn: () => get<Team[]>('/teams'), enabled: open });
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<BulkResult>('/owning-teams/bulk', { service: serviceId, teamIds, mode, preview: dryRun });
      if (dryRun) setPreview(r);
      else {
        notifyOk(t('owning.bulk.applied', { count: r.changed }));
        setOpen(false);
        setPreview(null);
        onDone();
      }
    } catch (e) {
      notifyError(e, t('owning.notSaved'));
    } finally {
      setBusy(false);
    }
  };
  const names = (x: string[]) => (x.length ? x.join(', ') : t('owning.none'));
  return (
    <>
      <Group>
        <Button size="xs" variant="light" onClick={() => setOpen(true)}>
          {t('owning.bulk.open')}
        </Button>
      </Group>
      {open && (
        <Modal opened onClose={() => setOpen(false)} title={t('owning.bulk.title')} size="xl">
          <Stack gap="sm">
            <Text size="sm" c="dimmed">
              {t('owning.bulk.hint')}
            </Text>
            <SegmentedControl
              value={mode}
              onChange={(v) => (setMode(v as typeof mode), setPreview(null))}
              data={(['add', 'set', 'remove'] as const).map((m) => ({ value: m, label: t(`owning.bulk.mode.${m}`) }))}
            />
            <MultiSelect
              label={t('owning.label')}
              data={(teams.data ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={teamIds}
              onChange={(v) => (setTeamIds(v), setPreview(null))}
              searchable
            />
            <Group>
              <Button variant="default" onClick={() => run(true)} loading={busy && !preview}>
                {t('owning.bulk.preview')}
              </Button>
              <Button onClick={() => run(false)} loading={busy && !!preview} disabled={!preview || !preview.changed}>
                {t('owning.bulk.apply', { count: preview?.changed ?? 0 })}
              </Button>
            </Group>
            {preview && (
              <Table fz="sm" withTableBorder verticalSpacing={4}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('owning.bulk.resource')}</Table.Th>
                    <Table.Th>{t('owning.bulk.teams')}</Table.Th>
                    <Table.Th>{t('owning.bulk.gains')}</Table.Th>
                    <Table.Th>{t('owning.bulk.loses')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {preview.resources.map((r) => (
                    <Table.Tr key={`${r.kind}:${r.id}`} style={{ opacity: r.changed ? 1 : 0.6 }}>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {t(`owning.bulk.kinds.${r.kind}`)}
                        </Text>
                        {r.name}
                      </Table.Td>
                      <Table.Td>{r.changed ? `${names(r.before)} → ${names(r.after)}` : t('owning.bulk.unchanged')}</Table.Td>
                      <Table.Td>{r.gains.join(', ') || '–'}</Table.Td>
                      <Table.Td c={r.loses.length ? 'red' : undefined}>{r.loses.join(', ') || '–'}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Stack>
        </Modal>
      )}
    </>
  );
}
